// What can a browser (F12) or an outsider get from a running installation?
//   node tools/check-exposure.mjs [base-url]                (default http://localhost:8080)
//   CHECK_USER=miras CHECK_PASSWORD=... node tools/check-exposure.mjs https://team.<tailnet>.ts.net
// Checks: the page code contains no data or secrets and no source maps;
// the database, .env, sources, migrations and backups cannot be downloaded;
// the API answers nothing without a session; signed-in API answers contain
// no password hashes, token hashes or session ids. Exit code 1 on a finding.

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const findings = [];
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  findings.push(msg);
  console.log(`  FOUND ${msg}`);
};

const SECRET_PATTERNS = [/password_hash/i, /passwordHash/, /token_hash/i, /tokenHash/, /scrypt\$/, /tskey-/, /TS_AUTHKEY/, /INITIAL_ADMIN_PASSWORD/, /\bSELECT\b[^`'"]{0,80}\bFROM\b/, /CREATE TABLE/i, /team-kz\.sqlite/];

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') ?? '', body };
}

console.log(`Checking ${base}\n\n1. Code the browser downloads (visible in F12 → Sources)`);
const index = await get('/');
const assets = [...index.body.toString('utf8').matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
for (const a of assets) {
  const r = await get(a);
  const text = r.body.toString('utf8');
  const hit = SECRET_PATTERNS.find((p) => p.test(text));
  if (hit) bad(`${a} contains ${hit}`);
  else ok(`${a} (${r.body.length} bytes): no data, no secrets`);
  if (/sourceMappingURL/.test(text)) bad(`${a} references a source map`);
  const map = await get(`${a}.map`);
  if (map.status === 200 && map.type.includes('json')) bad(`${a}.map is served`);
}

console.log('\n2. Server files must not be downloadable');
const probes = [
  '/team-kz.sqlite', '/data/team-kz.sqlite', '/data/', '/.env', '/.env.example', '/package.json', '/package-lock.json',
  '/dist/server/app.js', '/server/app.js', '/src/server/app.ts', '/migrations/001_initial.sql', '/backups/', '/photos/',
  '/..%2f..%2fteam-kz.sqlite', '/%2e%2e/%2e%2e/data/team-kz.sqlite', '/assets/../../server/app.js', '/.app-running',
  '/api/admin/backups/team-kz-backup-20260101-000000-x.tar.gz', '/api/photos/00000000000000000000000000000000.jpg',
];
for (const p of probes) {
  const r = await get(p);
  const text = r.body.toString('utf8');
  const isShell = text.includes('<div id="root">');
  const leaked = r.body.subarray(0, 16).toString('latin1').startsWith('SQLite format') || SECRET_PATTERNS.some((x) => x.test(text)) || /"version":\s*"1\./.test(text) && p.includes('package');
  if (leaked) bad(`${p} → ${r.status}: server content is served`);
  else ok(`${p} → ${r.status}${isShell ? ' (only the empty app page)' : ''}`);
}

console.log('\n3. API without a session');
for (const p of ['/api/directory', '/api/me', '/api/employees/1', '/api/manage/employees', '/api/admin/users', '/api/admin/audit', '/api/admin/export.json', '/api/admin/export.csv', '/api/admin/backups', '/api/invites']) {
  const r = await get(p);
  if (r.status === 401) ok(`${p} → 401`);
  else bad(`${p} → ${r.status} without a session`);
}

const user = process.env.CHECK_USER;
const password = process.env.CHECK_PASSWORD;
if (user && password) {
  console.log(`\n4. API answers for a signed-in user (${user}): only displayed data, no secrets`);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'team-kz' },
    body: JSON.stringify({ username: user, password }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const setCookie = login.headers.getSetCookie().join(' ');
  if (login.status !== 200) bad(`sign-in failed (${login.status})`);
  else ok(`session cookie flags: ${['HttpOnly', 'SameSite=Lax', 'Secure'].filter((f) => new RegExp(f, 'i').test(setCookie)).join(', ')}`);
  for (const p of ['/api/auth/session', '/api/directory', '/api/me', '/api/manage/employees', '/api/admin/users', '/api/admin/audit?limit=200', '/api/admin/export.json', '/api/admin/status']) {
    const r = await get(p, { cookie });
    if (r.status === 403) {
      ok(`${p} → 403 for this role`);
      continue;
    }
    const text = r.body.toString('utf8');
    const hit = [/password_hash/i, /passwordHash/, /token_hash/i, /tokenHash/, /scrypt\$/, /"sessionId"/, /"id":"[a-f0-9]{64}"/].find((x) => x.test(text));
    if (hit) bad(`${p} contains ${hit}`);
    else ok(`${p} → ${r.status}, ${r.body.length} bytes, no hashes/tokens/session ids`);
  }
} else {
  console.log('\n4. (skipped: set CHECK_USER and CHECK_PASSWORD to check signed-in answers)');
}

console.log(findings.length ? `\n${findings.length} finding(s)` : '\nNothing exposed.');
process.exitCode = findings.length ? 1 : 0;
