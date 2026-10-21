// Black-box tests of the built server (npm run build first): a real process,
// a fresh data directory, HTTP requests and the CLI, as on the NAS.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import jpeg from 'jpeg-js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 18100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'tkz-test-'));
const baseEnv = {
  ...process.env,
  NODE_ENV: 'production',
  ALLOW_INSECURE_HTTP: 'true',
  APP_BASE_URL: BASE,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  TRUST_PROXY: '',
};
const env = { ...baseEnv, DATA_DIR: DATA };
const STRONG = 'correct horse battery staple';
const secrets = []; // every token and password used: none may appear in the audit log

let server = null;
let serverOutput = '';

async function startServer(customEnv = env) {
  serverOutput = '';
  server = spawn(process.execPath, ['dist/server/main.js'], { cwd: ROOT, env: customEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (serverOutput += d));
  server.stderr.on('data', (d) => (serverOutput += d));
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited: ${serverOutput}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
  // Windows has no SIGTERM handler: the process is killed without the shutdown
  // that removes the heartbeat file. In the container (Linux) this is graceful.
  if (process.platform === 'win32') rmSync(path.join(DATA, '.app-running'), { force: true });
  server = null;
}

function cli(args, customEnv = env) {
  return execFileSync(process.execPath, ['dist/server/cli.js', ...args], { cwd: ROOT, env: customEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cliFails(args, customEnv = env) {
  try {
    cli(args, customEnv);
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  throw new Error(`cli ${args.join(' ')} should have failed`);
}

function tokenOf(link) {
  const m = /#token=([A-Za-z0-9_-]+)$/.exec(link.trim());
  assert.ok(m, `no token in link ${link}`);
  secrets.push(m[1]);
  return m[1];
}

function db() {
  return new DatabaseSync(path.join(DATA, 'team-kz.sqlite'));
}

// Open, query, close: an open handle would block renaming the file on Windows.
function dbGet(sql, ...params) {
  const d = db();
  try {
    return d.prepare(sql).get(...params);
  } finally {
    d.close();
  }
}

function dbAll(sql, ...params) {
  const d = db();
  try {
    return d.prepare(sql).all(...params);
  } finally {
    d.close();
  }
}

class Client {
  cookie = '';
  csrf = '';

  async req(method, url, body, { headers = {}, raw, noCsrf = false, noXrw = false } = {}) {
    const h = { ...headers };
    if (!noXrw) h['x-requested-with'] = 'team-kz';
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET' && !noCsrf) h['x-csrf-token'] = this.csrf;
    let payload;
    if (raw) {
      payload = raw.data;
      h['content-type'] = raw.type;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(0, i) === 'tkz_session') this.cookie = kv.slice(i + 1) ? kv : '';
    }
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (data && typeof data === 'object' && 'csrfToken' in data && data.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }

  get = (url, o) => this.req('GET', url, undefined, o);
  post = (url, body = {}, o) => this.req('POST', url, body, o);
  patch = (url, body, o) => this.req('PATCH', url, body, o);
  put = (url, body, o) => this.req('PUT', url, body, o);
  del = (url, o) => this.req('DELETE', url, undefined, o);

  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.data)}`);
    return r;
  }

  async accept(link, fields) {
    const token = tokenOf(link);
    secrets.push(fields.password);
    return this.post('/api/invites/accept', { token, ...fields });
  }
}

function makeJpeg(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 255) / w;
      data[i + 1] = (y * 255) / h;
      data[i + 2] = 160;
      data[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

function withExif(buf) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from('GPS-SECRET-LOCATION 43.2389N 76.8897E'.padEnd(96, '.'))]);
  const seg = Buffer.from([0xff, 0xe1, 0, 0]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([buf.subarray(0, 2), seg, payload, buf.subarray(2)]);
}

function rawRequest(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/auth/session', method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

// Shared state of the scenario
const admin = new Client();
const coord = new Client();
const emp = new Client();
const viewer = new Client();
const ids = {};

before(async () => {
  assert.ok(existsSync(path.join(ROOT, 'dist', 'server', 'main.js')), 'run npm run build first');
  await startServer();
});

after(async () => {
  await stopServer();
  rmSync(DATA, { recursive: true, force: true });
});

test('fresh database: migrations applied, only /api/health is public', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/health')).status, 200);
  for (const url of ['/api/directory', '/api/me', '/api/employees/1', '/api/manage/employees', '/api/admin/users', `/api/photos/${'a'.repeat(32)}.jpg`, '/api/admin/export.json']) {
    assert.equal((await anon.get(url)).status, 401, url);
  }
  const s = await anon.get('/api/auth/session');
  assert.deepEqual(s.data, { user: null });
  const d = db();
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  assert.deepEqual(d.prepare('SELECT name FROM companies ORDER BY sort_order').all().map((r) => r.name), ['Algoritmi', 'Green Spark']);
  assert.equal(d.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  d.close();
  assert.match(cli(['status']), /schema version:\s+2/);
});

test('first administrator: one-time set-up link, no default password', async () => {
  assert.equal(dbGet('SELECT COUNT(*) AS n FROM users').n, 0, 'no user exists before set-up');
  const out = cli(['setup-link']);
  const link = out.trim().split('\n').at(-1);
  assert.match(link, new RegExp(`^${BASE}/setup#token=`));
  const token = tokenOf(link);
  const insp = await new Client().post('/api/invites/inspect', { token });
  assert.equal(insp.data.status, 'valid');
  assert.equal(insp.data.kind, 'setup');

  const weak = await admin.post('/api/invites/accept', { token, username: 'miras', displayName: 'Miras', password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.error.code, 'password_too_short');

  secrets.push(STRONG);
  const ok = await admin.post('/api/invites/accept', { token, username: 'miras', displayName: 'Miras', password: STRONG });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.role, 'admin');
  assert.ok(admin.cookie, 'session cookie set');

  const again = await new Client().post('/api/invites/accept', { token, username: 'miras2', displayName: 'X', password: STRONG });
  assert.equal(again.status, 410);
  assert.equal(again.data.error.code, 'invite_used');
  assert.match(cliFails(['setup-link']), /administrator already exists/);

  const hash = dbGet("SELECT password_hash FROM users WHERE username = 'miras'").password_hash;
  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(dbGet('SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?', token).n, 0, 'token stored only as a hash');
});

test('sign-in, sign-out and session cookie', async () => {
  const c = new Client();
  const bad = await c.post('/api/auth/login', { username: 'miras', password: 'wrong password!!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.code, 'invalid_credentials');
  const unknown = await c.post('/api/auth/login', { username: 'nobody', password: 'wrong password!!' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error.code, 'invalid_credentials', 'same answer for unknown users');

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'team-kz' },
    body: JSON.stringify({ username: 'MIRAS', password: STRONG }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=604800/);

  // No proxy is trusted here: a client-supplied X-Forwarded-For is ignored.
  const spoof = await c.post('/api/auth/login', { username: 'miras', password: STRONG }, { headers: { 'x-forwarded-for': '6.6.6.6' } });
  assert.equal(spoof.status, 200);
  const last = dbGet("SELECT ip FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1");
  assert.equal(last.ip, '127.0.0.1');
  assert.equal((await c.get('/api/directory')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal(c.cookie, '');
  assert.equal((await c.get('/api/directory')).status, 401);
});

test('CSRF, foreign origins, CORS, Host header and security headers', async () => {
  const noToken = await admin.post('/api/admin/companies', { name: 'Evil Co' }, { noCsrf: true });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.data.error.code, 'csrf_failed');

  const evil = await admin.post('/api/admin/companies', { name: 'Evil Co' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.error.code, 'origin_not_allowed');
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const crossSite = await admin.get('/api/directory', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);

  const loginNoHeader = await new Client().post('/api/auth/login', { username: 'miras', password: STRONG }, { noXrw: true });
  assert.equal(loginNoHeader.status, 403);

  const preflight = await fetch(`${BASE}/api/admin/companies`, { method: 'OPTIONS', headers: { origin: BASE, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  assert.equal(await rawRequest({ host: 'attacker.example' }), 421);
  assert.equal(await rawRequest({ host: `127.0.0.1:${PORT}` }), 200);

  const r = await admin.get('/api/directory');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);

  for (const page of ['/', '/people/1', '/invite']) {
    const html = await fetch(`${BASE}${page}`);
    assert.equal(html.status, 200, page);
    assert.match(await html.text(), /<div id="root">/);
    assert.equal(html.headers.get('cache-control'), 'no-cache');
  }
  const asset = await fetch(`${BASE}/favicon.svg`);
  assert.equal(asset.status, 200);

  const tooBig = await admin.post('/api/admin/companies', { name: 'x'.repeat(100_000) });
  assert.equal(tooBig.status, 413);
  const badJson = await admin.req('POST', '/api/admin/companies', undefined, { raw: { type: 'application/json', data: '{"name":' } });
  assert.equal(badJson.status, 400);
});

test('administrator: companies, teams and a coordinator invitation', async () => {
  const companies = (await admin.get('/api/directory')).data.companies;
  ids.algoritmi = companies.find((c) => c.name === 'Algoritmi').id;
  ids.greenSpark = companies.find((c) => c.name === 'Green Spark').id;
  const t1 = await admin.post('/api/admin/teams', { companyId: ids.algoritmi, name: 'Architecture' });
  assert.equal(t1.status, 201);
  ids.teamArch = t1.data.id;
  ids.teamFin = (await admin.post('/api/admin/teams', { companyId: ids.greenSpark, name: 'Finance' })).data.id;
  assert.equal((await admin.post('/api/admin/teams', { companyId: ids.algoritmi, name: 'architecture' })).status, 409, 'duplicate team name');
  const sql = await admin.post('/api/admin/companies', { name: "Robert'); DROP TABLE employees;--" });
  assert.equal(sql.status, 201, 'stored as plain text');
  assert.equal(dbGet('SELECT COUNT(*) AS n FROM employees').n, 0, 'employees table intact');
  assert.equal((await admin.del(`/api/admin/companies/${sql.data.id}`)).status, 200);

  const inv = await admin.post('/api/admin/invites', { role: 'coordinator', displayName: 'Dinara Test' });
  assert.equal(inv.status, 200);
  const acc = await coord.accept(inv.data.link, { username: 'dinara', password: 'she coordinates the whole team' });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.user.role, 'coordinator');
});

test('coordinator: employees, one-time invitations, re-issue, revoke, expiry', async () => {
  assert.equal((await coord.get('/api/admin/users')).status, 403);
  assert.equal((await coord.post('/api/admin/invites', { role: 'viewer', displayName: 'Guest' })).status, 403);
  // Only existing administrators create administrators through the web interface.
  assert.equal((await coord.post('/api/admin/invites', { role: 'admin', displayName: 'Shadow admin' })).status, 403);
  assert.equal((await coord.patch('/api/admin/users/1', { role: 'coordinator' })).status, 403);

  const create = (body) => coord.post('/api/employees', body);
  const a = await create({ firstName: 'Aidar', lastName: 'Testov', companyId: ids.algoritmi, teamId: ids.teamArch, officialTitle: 'Lead architect', algoritmiAvailability: 'yes' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  ids.a = a.data.id;
  ids.b = (await create({ firstName: 'Bota', lastName: 'Example', companyId: ids.greenSpark, teamId: ids.teamFin, officialTitle: 'CFO', algoritmiAvailability: 'partial' })).data.id;
  ids.c = (await create({ firstName: 'Chingiz', lastName: 'Sample' })).data.id;
  ids.d = (await create({ firstName: 'Dana', lastName: 'Probe', companyId: ids.algoritmi })).data.id;
  const mismatch = await create({ firstName: 'X', lastName: 'Y', companyId: ids.algoritmi, teamId: ids.teamFin });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.error.code, 'team_company_mismatch');
  const noPhone = (await coord.get(`/api/employees/${ids.c}`)).data;
  assert.equal(noPhone.phone, null);
  assert.equal(noPhone.workEmail, null);

  // A: invitation, activation, reuse refused
  const invA = await coord.post(`/api/employees/${ids.a}/invite`);
  assert.equal(invA.status, 200);
  assert.match(invA.data.link, new RegExp(`^${BASE}/invite#token=[A-Za-z0-9_-]{43}$`));
  const tokenA = tokenOf(invA.data.link);
  const insp = await new Client().post('/api/invites/inspect', { token: tokenA });
  assert.deepEqual(Object.keys(insp.data).sort(), ['expiresAt', 'kind', 'name', 'needsDisplayName', 'needsUsername', 'role', 'status', 'username']);
  assert.equal(insp.data.name, 'Aidar Testov');
  const pending = new Client();
  await pending.post('/api/invites/inspect', { token: tokenA });
  assert.equal((await pending.get('/api/directory')).status, 401, 'an unused invitation gives no access');

  const accA = await emp.accept(invA.data.link, { username: 'aidar', password: 'draws buildings all day long' });
  assert.equal(accA.status, 200, JSON.stringify(accA.data));
  assert.equal(accA.data.user.employeeId, ids.a);
  const reuse = await new Client().post('/api/invites/accept', { token: tokenA, username: 'other', password: 'another long password' });
  assert.equal(reuse.status, 410);
  assert.equal(reuse.data.error.code, 'invite_used');

  // B: re-issue revokes the previous link; the new one is revoked explicitly
  const invB1 = await coord.post(`/api/employees/${ids.b}/invite`);
  const invB2 = await coord.post(`/api/employees/${ids.b}/invite`);
  const old = await new Client().accept(invB1.data.link, { username: 'bota', password: 'bota counts the money' });
  assert.equal(old.status, 410);
  assert.equal(old.data.error.code, 'invite_revoked');
  assert.equal((await coord.del(`/api/invites/${invB2.data.inviteId}`)).status, 200);
  const revoked = await new Client().accept(invB2.data.link, { username: 'bota', password: 'bota counts the money' });
  assert.equal(revoked.status, 410);
  assert.equal(revoked.data.error.code, 'invite_revoked');

  // C: expired link
  const invC = await coord.post(`/api/employees/${ids.c}/invite`);
  const d = db();
  d.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', invC.data.inviteId);
  d.close();
  const tokenC = tokenOf(invC.data.link);
  assert.equal((await new Client().post('/api/invites/inspect', { token: tokenC })).data.status, 'expired');
  const exp = await new Client().post('/api/invites/accept', { token: tokenC, username: 'chingiz', password: 'chingiz is a bit late' });
  assert.equal(exp.status, 410);
  assert.equal(exp.data.error.code, 'invite_expired');

  const guess = await new Client().post('/api/invites/inspect', { token: 'A'.repeat(43) });
  assert.equal(guess.data.status, 'invalid');
  const list = (await coord.get('/api/manage/employees')).data;
  assert.equal(list.find((e) => e.id === ids.a).account, 'active');
  assert.equal(list.find((e) => e.id === ids.b).account, 'none');
  assert.ok(list.find((e) => e.id === ids.c).completeness < 100);
});

test('employee: own profile only, never official fields, no access by changing the id', async () => {
  const me = await emp.get('/api/me');
  assert.equal(me.data.employee.id, ids.a);
  assert.deepEqual(me.data.editableFields.sort(), ['currentWork', 'languages', 'phone', 'profession', 'workEmail']);

  const ok = await emp.patch('/api/me/profile', { profession: 'Architect', currentWork: 'Visitor centre <script>alert(1)</script>', languages: ['ru', 'en', 'kk', 'en'], workEmail: '', phone: '' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.languages, ['ru', 'en', 'kk']);
  assert.equal(ok.data.workEmail, null);
  assert.equal(ok.data.phone, null);
  assert.equal(ok.data.currentWork, 'Visitor centre <script>alert(1)</script>', 'stored as text, escaped by React when shown');
  assert.equal((await emp.patch('/api/me/profile', { workEmail: 'not-an-email' })).status, 400);
  assert.equal((await emp.patch('/api/me/profile', { languages: ['xx'] })).status, 400);

  for (const body of [{ officialTitle: 'CEO' }, { companyId: ids.greenSpark }, { teamId: ids.teamFin }, { algoritmiAvailability: 'no' }, { firstName: 'Changed' }, { profession: 'x', officialTitle: 'CEO' }]) {
    const r = await emp.patch(`/api/employees/${ids.a}`, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.data.error.code, 'forbidden_fields');
    assert.equal((await emp.patch('/api/me/profile', body)).status, 403);
  }
  assert.equal((await emp.patch(`/api/employees/${ids.a}`, { isAdmin: true })).status, 400, 'unknown fields refused');
  const row = dbGet('SELECT official_title, company_id, team_id, algoritmi_availability, first_name FROM employees WHERE id = ?', ids.a);
  assert.deepEqual({ ...row }, { official_title: 'Lead architect', company_id: ids.algoritmi, team_id: ids.teamArch, algoritmi_availability: 'yes', first_name: 'Aidar' });

  // someone else's profile: readable in the directory, never writable
  assert.equal((await emp.get(`/api/employees/${ids.b}`)).status, 200);
  assert.equal((await emp.patch(`/api/employees/${ids.b}`, { profession: 'Hacker' })).status, 403);
  assert.equal((await emp.patch(`/api/employees/${ids.b}`, { phone: '+7 700 111 2233' })).status, 403);
  assert.equal((await emp.del(`/api/employees/${ids.b}/photo`)).status, 403);
  assert.equal((await emp.post(`/api/employees/${ids.b}/invite`)).status, 403);
  assert.equal((await emp.post('/api/employees', { firstName: 'X', lastName: 'Y' })).status, 403);
  assert.equal((await emp.post('/api/admin/invites', { role: 'admin', displayName: 'Me again' })).status, 403);
  assert.equal((await emp.get('/api/manage/employees')).status, 403);
  assert.equal((await emp.get('/api/admin/audit')).status, 403);
  assert.equal((await emp.post(`/api/employees/${ids.b}/deactivate`)).status, 403);
  assert.equal(dbGet('SELECT profession FROM employees WHERE id = ?', ids.b).profession, '');
});

test('visitor: read-only', async () => {
  const inv = await admin.post('/api/admin/invites', { role: 'viewer', displayName: 'Guest from Italy' });
  const acc = await viewer.accept(inv.data.link, { username: 'guest.it', password: 'ciao kazakhstan 2026' });
  assert.equal(acc.status, 200);
  const dir = await viewer.get('/api/directory');
  assert.equal(dir.status, 200);
  assert.equal(dir.data.employees.length, 4);
  assert.equal((await viewer.patch(`/api/employees/${ids.a}`, { profession: 'x' })).status, 403);
  assert.equal((await viewer.patch('/api/me/profile', { profession: 'x' })).status, 404);
  assert.equal((await viewer.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: makeJpeg(400, 400) } })).status, 404);
  assert.equal((await viewer.post('/api/employees', { firstName: 'X', lastName: 'Y' })).status, 403);
  assert.equal((await viewer.get('/api/manage/employees')).status, 403);
});

test('photos: camera upload re-encoded to 512×512 without metadata, served only to signed-in users', async () => {
  const upload = withExif(makeJpeg(720, 720));
  assert.ok(upload.includes(Buffer.from('GPS-SECRET')));
  const r = await emp.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: upload } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.photoUrl, /^\/api\/photos\/[a-f0-9]{32}\.jpg$/);
  ids.photoUrl = r.data.photoUrl;

  const got = await viewer.get(ids.photoUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.match(got.headers.get('cache-control'), /private/);
  assert.ok(!got.data.includes(Buffer.from('GPS-SECRET')), 'metadata removed');
  assert.ok(!got.data.includes(Buffer.from('Exif')), 'no EXIF segment');
  const decoded = jpeg.decode(got.data, { useTArray: true });
  assert.equal(decoded.width, 512);
  assert.equal(decoded.height, 512);

  assert.equal((await new Client().get(ids.photoUrl)).status, 401, 'no photo without a session');
  assert.equal((await fetch(`${BASE}/photos/${ids.photoUrl.split('/').pop()}`)).headers.get('content-type')?.includes('image'), false, 'not a static file');
  const files = readdirSync(path.join(DATA, 'photos'));
  assert.equal(files.length, 1);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500)]);
  const notJpeg = await emp.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: png } });
  assert.equal(notJpeg.status, 400);
  assert.equal(notJpeg.data.error.code, 'photo_not_jpeg');
  const broken = Buffer.concat([upload.subarray(0, 600), Buffer.alloc(600, 7)]);
  assert.equal((await emp.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: broken } })).status, 400);
  assert.equal((await emp.put('/api/me/photo', undefined, { raw: { type: 'image/png', data: png } })).status, 415);
  assert.equal((await emp.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: Buffer.alloc(4 * 1024 * 1024, 1) } })).status, 413);
  assert.equal((await emp.put('/api/me/photo', undefined, { raw: { type: 'image/jpeg', data: makeJpeg(200, 200) } })).data.error.code, 'photo_too_small');
  assert.equal((await emp.put(`/api/employees/${ids.b}/photo`, undefined, { raw: { type: 'image/jpeg', data: upload } })).status, 404, 'no upload route for other people');
});

test('audit log: official fields, roles, invitations; no secrets', async () => {
  assert.equal((await coord.patch(`/api/employees/${ids.a}`, { officialTitle: 'Chief architect', algoritmiAvailability: 'partial' })).status, 200);
  const coordUser = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'dinara');
  assert.equal((await admin.patch(`/api/admin/users/${coordUser.id}`, { role: 'viewer' })).status, 200);
  assert.equal((await coord.get('/api/manage/employees')).status, 403, 'role change applies immediately');
  assert.equal((await admin.patch(`/api/admin/users/${coordUser.id}`, { role: 'coordinator' })).status, 200);
  const me = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'miras');
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'viewer' })).data.error.code, 'cannot_change_self');

  const log = (await admin.get('/api/admin/audit?limit=200')).data;
  const actions = new Set(log.map((e) => e.action));
  for (const a of ['setup.completed', 'auth.login', 'auth.login_failed', 'invite.created', 'invite.revoked', 'invite.accepted', 'employee.created', 'employee.official_changed', 'employee.profile_updated', 'employee.change_denied', 'employee.photo_updated', 'user.role_changed']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  const change = log.find((e) => e.action === 'employee.official_changed');
  assert.deepEqual(change.details.changes.officialTitle, { from: 'Lead architect', to: 'Chief architect' });
  const profile = log.find((e) => e.action === 'employee.profile_updated');
  assert.ok(Array.isArray(profile.details.fields), 'personal fields: only names');
  assert.ok(!JSON.stringify(profile).includes('Visitor centre'));
  const all = JSON.stringify(dbAll('SELECT * FROM audit_log'));
  for (const s of secrets) assert.ok(!all.includes(s), 'no token or password in the audit log');
  for (const s of secrets) assert.ok(!serverOutput.includes(s), 'no token or password in the server log');
  assert.equal((await admin.get('/api/admin/audit?action=user.')).data.every((e) => e.action.startsWith('user.')), true);
});

test('exports and admin backups contain no password hashes', async () => {
  const json = await admin.get('/api/admin/export.json');
  assert.equal(json.status, 200);
  const text = JSON.stringify(json.data);
  assert.ok(!text.includes('scrypt$') && !text.includes('password'), 'no hashes');
  const csv = await admin.get('/api/admin/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.ok(csv.data.toString('utf8').includes('Aidar'));
  const b = await admin.post('/api/admin/backups');
  assert.equal(b.status, 200);
  const dl = await admin.get(`/api/admin/backups/${b.data.name}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  assert.equal((await coord.get(`/api/admin/backups/${b.data.name}`)).status, 403);
  assert.equal((await admin.get('/api/admin/backups/..%2F..%2Fteam-kz.sqlite')).status, 404);
});

test('deactivation disables the account, ends sessions and revokes links', async () => {
  const link = await coord.post(`/api/employees/${ids.a}/invite`); // re-invite = password reset link
  assert.equal(link.status, 200);
  const r = await admin.post(`/api/employees/${ids.a}/deactivate`);
  assert.equal(r.status, 200);
  assert.ok(r.data.sessions >= 1);
  assert.ok(r.data.invites >= 1);
  assert.equal((await emp.get('/api/me')).status, 401, 'session revoked');
  assert.equal((await new Client().post('/api/auth/login', { username: 'aidar', password: 'draws buildings all day long' })).status, 401);
  assert.equal((await new Client().post('/api/invites/inspect', { token: tokenOf(link.data.link) })).data.status, 'revoked');
  assert.ok(!(await viewer.get('/api/directory')).data.employees.some((e) => e.id === ids.a), 'hidden from the directory');
  assert.equal((await viewer.get(ids.photoUrl)).status, 404, 'photo of a deactivated person is not served to visitors');
  assert.equal((await coord.get(`/api/employees/${ids.a}`)).status, 200, 'coordinators still see it');
  assert.equal((await admin.post(`/api/employees/${ids.a}/activate`)).status, 200);
  await emp.login('aidar', 'draws buildings all day long');

  const viewerUser = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'guest.it');
  assert.equal((await admin.patch(`/api/admin/users/${viewerUser.id}`, { status: 'disabled' })).status, 200);
  assert.equal((await viewer.get('/api/directory')).status, 401);
});

test('password reset by an administrator, without email', async () => {
  const user = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'dinara');
  const link = await admin.post(`/api/admin/users/${user.id}/reset-link`);
  assert.equal(link.status, 200);
  assert.match(link.data.link, /\/invite#token=/);
  const c = new Client();
  const res = await c.accept(link.data.link, { password: 'coordinator got a new secret' });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.username, 'dinara');
  assert.equal((await coord.get('/api/manage/employees')).status, 401, 'old sessions ended');
  await coord.login('dinara', 'coordinator got a new secret');
});

test('expired sessions are refused', async () => {
  const c = new Client();
  await c.login('miras', STRONG);
  const d = db();
  d.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)").run();
  d.close();
  assert.equal((await c.get('/api/directory')).status, 401);
});

test('backup, data kept after restart, restore with overwrite protection', async () => {
  const out = cli(['backup', '--reason', 'test']);
  const file = /BACKUP_FILE=(.+)/.exec(out)[1].trim();
  assert.ok(existsSync(file));
  assert.match(cli(['verify-backup', file]), /OK: [\s\S]* 4 employees, 4 users, 1 photos/);
  // Standard archive: the system tar (GNU tar on the NAS) lists it.
  const listing = execFileSync('tar', ['-tzf', path.basename(file)], { cwd: path.dirname(file), encoding: 'utf8' });
  assert.match(listing, /manifest\.json/);
  assert.match(listing, /team-kz\.sqlite/);
  assert.match(listing, /photos\/[a-f0-9]{32}\.jpg/);

  assert.equal((await admin.post('/api/admin/companies', { name: 'Created after backup' })).status, 201);
  await stopServer();
  await startServer();
  const persisted = new Client();
  await persisted.login('miras', STRONG);
  assert.ok((await persisted.get('/api/directory')).data.companies.some((c) => c.name === 'Created after backup'), 'data survives a restart');

  assert.match(cliFails(['restore', file]), /application is running/);
  await stopServer();
  assert.match(cliFails(['restore', file]), /already contains data/);
  const restored = cli(['restore', file, '--force']);
  assert.match(restored, /restored backup/);
  assert.match(restored, /previous data moved to/);
  await startServer();
  const after = new Client();
  await after.login('miras', STRONG);
  const dir = (await after.get('/api/directory')).data;
  assert.ok(!dir.companies.some((c) => c.name === 'Created after backup'), 'state of the backup');
  const a = dir.employees.find((e) => e.id === ids.a);
  assert.equal((await after.get(a.photoUrl)).status, 200, 'photo restored');

  const damaged = path.join(DATA, 'damaged.tar.gz');
  cpSync(file, damaged);
  const fd = await import('node:fs');
  const buf = fd.readFileSync(damaged);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fd.writeFileSync(damaged, buf);
  assert.match(cliFails(['verify-backup', damaged]), /error/);
});

test('a database newer than the application is refused at start-up', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tkz-new-'));
  const d = new DatabaseSync(path.join(dir, 'team-kz.sqlite'));
  d.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (999, '999_future.sql', 'x', '2030-01-01');");
  d.close();
  const p = spawn(process.execPath, ['dist/server/main.js'], { cwd: ROOT, env: { ...baseEnv, DATA_DIR: dir, PORT: String(PORT + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  p.stderr.on('data', (c) => (text += c));
  const [code] = await once(p, 'exit');
  assert.equal(code, 3);
  assert.match(text, /newer than this application supports/);
  rmSync(dir, { recursive: true, force: true });
});

test('two processes starting at once apply the migrations exactly once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tkz-race-'));
  const run = () =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, ['dist/server/cli.js', 'migrate'], { cwd: ROOT, env: { ...baseEnv, DATA_DIR: dir } }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
  const outs = await Promise.all([run(), run(), run()]);
  assert.equal(outs.filter((o) => /\(2 applied\)/.test(o)).length, 1, outs.join('\n'));
  const d = new DatabaseSync(path.join(dir, 'team-kz.sqlite'));
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 2);
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('demo data only on explicit request and removable', async () => {
  assert.match(cliFails(['demo-data']), /only on request/);
  assert.match(cli(['demo-data', '--yes']), /demo data loaded: 8 employees/);
  const c = new Client();
  await c.login('miras', STRONG);
  const demo = (await c.get('/api/directory')).data.employees.filter((e) => e.isDemo);
  assert.equal(demo.length, 8);
  assert.ok(demo.every((e) => !e.workEmail || e.workEmail.endsWith('@example.com')));
  assert.equal((await c.post('/api/admin/demo/remove')).data.removed, 8);
});

test('sign-in attempts are rate limited', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await new Client().post('/api/auth/login', { username: 'dinara', password: `wrong guess ${i}` });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  const right = await new Client().post('/api/auth/login', { username: 'dinara', password: 'coordinator got a new secret' });
  assert.equal(right.status, 429, 'locked even with the right password until the window passes');
});

test('moderation: coordinators and admins remove photos; admins link accounts to profiles', async () => {
  const c = new Client();
  await c.login('miras', STRONG);
  const a = (await c.get('/api/directory')).data.employees.find((e) => e.id === ids.a);
  assert.ok(a.photoUrl, 'employee A has the photo from the backup');
  const r = await c.del(`/api/employees/${ids.a}/photo`);
  assert.equal(r.status, 200);
  assert.equal(r.data.photoUrl, null);
  assert.equal((await c.get(a.photoUrl)).status, 404, 'the removed photo is no longer served');
  assert.ok((await c.get('/api/admin/audit?action=employee.')).data.some((e) => e.action === 'employee.photo_removed'));

  const users = (await c.get('/api/admin/users')).data;
  const aidar = users.find((u) => u.username === 'aidar');
  const dinara = users.find((u) => u.username === 'dinara');
  const taken = await c.patch(`/api/admin/users/${dinara.id}`, { employeeId: ids.a });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error.code, 'employee_has_account');
  assert.equal((await c.patch(`/api/admin/users/${dinara.id}`, { employeeId: ids.d })).status, 200);
  assert.equal((await c.get('/api/admin/users')).data.find((u) => u.username === 'dinara').employeeName, 'Dana Probe');
  const unlink = await c.patch(`/api/admin/users/${aidar.id}`, { employeeId: null });
  assert.equal(unlink.status, 400);
  assert.equal(unlink.data.error.code, 'employee_required', 'an employee account needs its profile');
});

test('first administrator without a terminal (setup.sh with INITIAL_ADMIN_*): stdin password, 8 characters', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tkz-admin-'));
  const e2 = { ...baseEnv, DATA_DIR: dir, PORT: String(PORT + 2) };
  const create = (input, extra = []) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ['dist/server/cli.js', 'create-admin', '--if-none', '--password-stdin', '--username', 'Miras', '--display-name', 'Miras', ...extra], { cwd: ROOT, env: e2 });
      let text = '';
      p.stdout.on('data', (c) => (text += c));
      p.stderr.on('data', (c) => (text += c));
      p.on('exit', (code) => resolve({ code, text }));
      p.stdin.end(input);
    });
  const short = await create('Short7!');
  assert.notEqual(short.code, 0);
  assert.match(short.text, /password too short/);
  cli(['setup-link'], e2);
  const ok = await create('Probe8ch\n');
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /administrator "miras" created/);
  assert.ok(!ok.text.includes('Probe8ch'), 'the password is not echoed');
  const again = await create('Probe8ch');
  assert.match(again.text, /already exists: nothing to do/);
  const d = new DatabaseSync(path.join(dir, 'team-kz.sqlite'));
  const u = d.prepare("SELECT username, display_name, role FROM users").all();
  assert.deepEqual(u.map((r) => ({ ...r })), [{ username: 'miras', display_name: 'Miras', role: 'admin' }]);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM invites WHERE kind = 'setup' AND revoked_at IS NULL").get().n, 0, 'open set-up link revoked');
  d.close();
  rmSync(dir, { recursive: true, force: true });
});
