// Command-line tool for the NAS scripts (run inside the container):
//   docker exec teamkz-app node dist/server/cli.js <command>
// One-time links are printed to stdout only (never written to the app log).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { USERNAME_RE } from '../shared/constants.js';
import { audit, CLI_ACTOR } from './audit.js';
import { BackupError, createBackup, pruneBackups, restoreBackup, verifyBackup } from './backup.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { currentSchemaVersion, latestSchemaVersion, migrate, nowIso, one, openDb, run, SchemaTooNewError, type DB } from './db.js';
import { demoCount, loadDemoData, removeDemoData } from './demo.js';
import { activeAdminCount, createInvite, inviteLink, normalizeUsername } from './invites.js';
import { checkPassword, hashPassword } from './security.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => {
  process.stderr.write(`error: ${s}\n`);
  process.exit(code);
};

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function withDb<T>(config: Config, fn: (db: DB) => T, opts: { migrate?: boolean } = {}): T {
  const db = openDb(config.dbPath);
  try {
    if (opts.migrate) migrate(db, config.migrationsDir);
    return fn(db);
  } finally {
    db.close();
  }
}

const HELP = `Team Kazakhstan CLI

  status                         schema version, counts, administrator present
  migrate                        apply pending database migrations
  setup-link [--force]           one-time link to create the first administrator
  reset-link <username>          one-time password reset link for an account
  create-admin                   create an administrator interactively (needs a terminal)
  backup [--out DIR] [--reason R]  consistent backup archive; prints BACKUP_FILE=<path>
  verify-backup <file>           check an archive (checksums, SQLite integrity, schema)
  restore <file> [--force]       restore an archive into the data directory (app stopped)
  prune-backups --dir DIR --days N [--min-keep N]
  demo-data --yes | --remove     load or remove the demonstration data
`;

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => write(s.startsWith(question) ? s : '');
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) out();
  return answer;
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    out(HELP);
    return;
  }
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(`configuration: ${err.message}`, 2);
    throw err;
  }

  switch (command) {
    case 'migrate': {
      const r = withDb(config, (db) => migrate(db, config.migrationsDir, out));
      out(`schema version ${r.version} (${r.applied.length} applied)`);
      return;
    }
    case 'status': {
      withDb(config, (db) => {
        const v = currentSchemaVersion(db);
        const n = (sql: string) => (v ? Number(one<{ n: number }>(db, sql)?.n ?? 0) : 0);
        out(`app version:      ${config.version}`);
        out(`schema version:   ${v} (application supports ${latestSchemaVersion(config.migrationsDir)})`);
        out(`address:          ${config.origin}`);
        out(`employees:        ${n("SELECT COUNT(*) AS n FROM employees WHERE status = 'active'")} active`);
        out(`users:            ${n("SELECT COUNT(*) AS n FROM users WHERE status = 'active'")} active`);
        out(`administrators:   ${v ? activeAdminCount(db) : 0}`);
        out(`demo employees:   ${v ? demoCount(db) : 0}`);
      });
      return;
    }
    case 'setup-link': {
      withDb(
        config,
        (db) => {
          if (activeAdminCount(db) > 0 && !args.includes('--force')) {
            fail('an administrator already exists. Use reset-link <username> to regain access, or --force to add another administrator.');
          }
          const inv = createInvite(db, { kind: 'setup', role: 'admin', createdBy: null, ttlMs: config.setupTtlMinutes * 60_000 });
          audit(db, CLI_ACTOR, 'setup.link_created', { type: 'invite', id: inv.id }, { expiresAt: inv.expiresAt });
          out(`One-time administrator set-up link (single use, valid until ${inv.expiresAt} UTC):`);
          out(inviteLink(config, inv.token, 'setup'));
        },
        { migrate: true },
      );
      return;
    }
    case 'reset-link': {
      const username = normalizeUsername(args[0] ?? '');
      if (!username) fail('usage: reset-link <username>');
      withDb(
        config,
        (db) => {
          const user = one<{ id: number; role: 'admin' | 'coordinator' | 'employee' | 'viewer'; status: string }>(db, 'SELECT id, role, status FROM users WHERE username = ? COLLATE NOCASE', username);
          if (!user) fail(`no account "${username}"`);
          if (user!.status !== 'active') {
            run(db, "UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), user!.id);
            out(`account "${username}" was disabled and has been enabled again`);
          }
          const inv = createInvite(db, { kind: 'reset', role: user!.role, userId: Number(user!.id), createdBy: null, ttlMs: config.setupTtlMinutes * 60_000 });
          audit(db, CLI_ACTOR, 'password.reset_link_created', { type: 'user', id: user!.id }, { expiresAt: inv.expiresAt });
          out(`One-time password reset link for "${username}" (single use, valid until ${inv.expiresAt} UTC):`);
          out(inviteLink(config, inv.token, 'reset'));
        },
        { migrate: true },
      );
      return;
    }
    case 'create-admin': {
      // Interactive (docker exec -it ... create-admin) or, for setup.sh with
      // INITIAL_ADMIN_* from .env: --username U --display-name N --password-stdin
      // (the password comes through stdin, never through arguments or logs).
      // --if-none: do nothing when an active administrator already exists.
      const nonInteractive = args.includes('--password-stdin');
      if (!nonInteractive && !process.stdin.isTTY) fail('create-admin needs an interactive terminal (docker exec -it ...) or --password-stdin');
      if (args.includes('--if-none') && withDb(config, (db) => activeAdminCount(db), { migrate: true }) > 0) {
        out('an administrator already exists: nothing to do');
        return;
      }
      const username = normalizeUsername(nonInteractive ? (arg(args, '--username') ?? '') : await prompt('Username (a-z, 0-9, . _ -): '));
      if (!USERNAME_RE.test(username)) fail('invalid username (3-40 characters: a-z, 0-9, dot, dash, underscore)');
      const displayName = (nonInteractive ? (arg(args, '--display-name') ?? username) : await prompt('Display name: ')).trim();
      if (!displayName || displayName.length > 80) fail('invalid display name');
      let password: string;
      if (nonInteractive) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      } else {
        password = await prompt('Password (min. 8 characters): ', true);
        if ((await prompt('Repeat password: ', true)) !== password) fail('passwords do not match');
      }
      const problem = checkPassword(password, username);
      if (problem) fail(problem.replace(/_/g, ' '));
      const hash = await hashPassword(password);
      withDb(
        config,
        (db) => {
          if (one(db, 'SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', username)) fail('this username is taken');
          const now = nowIso();
          const r = run(
            db,
            "INSERT INTO users (username, display_name, role, password_hash, status, created_at, updated_at) VALUES (?, ?, 'admin', ?, 'active', ?, ?)",
            username,
            displayName,
            hash,
            now,
            now,
          );
          // An unused set-up link is no longer needed once an administrator exists.
          run(db, "UPDATE invites SET revoked_at = ? WHERE kind = 'setup' AND used_at IS NULL AND revoked_at IS NULL", now);
          audit(db, CLI_ACTOR, 'user.admin_created', { type: 'user', id: r.lastInsertRowid }, { username });
        },
        { migrate: true },
      );
      out(`administrator "${username}" created (sign in as ${username}, the name is not case-sensitive)`);
      return;
    }
    case 'backup': {
      const outDir = arg(args, '--out') ? path.resolve(arg(args, '--out')!) : config.backupsDir;
      const reason = arg(args, '--reason') ?? 'manual';
      if (!existsSync(config.dbPath)) fail(`no database at ${config.dbPath}`);
      const result = withDb(config, (db) => {
        const r = createBackup(db, config, { outDir, reason });
        audit(db, CLI_ACTOR, 'backup.created', { type: 'backup' }, { file: path.basename(r.file), counts: r.manifest.counts, reason });
        return r;
      });
      out(`backup created: ${result.manifest.counts.employees} employees, ${result.manifest.counts.users} users, ${result.manifest.counts.photos} photos, schema ${result.manifest.schemaVersion}`);
      if (result.manifest.missingPhotos.length) out(`warning: ${result.manifest.missingPhotos.length} referenced photo file(s) were missing`);
      out(`BACKUP_FILE=${result.file}`);
      return;
    }
    case 'verify-backup': {
      const file = args[0];
      if (!file || !existsSync(file)) fail('usage: verify-backup <file>');
      const v = verifyBackup(file!, config, path.join(config.dataDir, '.tmp'));
      out(`OK: created ${v.manifest.createdAt} by version ${v.manifest.appVersion}, schema ${v.manifest.schemaVersion}`);
      out(`    ${v.manifest.counts.employees} employees, ${v.manifest.counts.users} users, ${v.photos.length} photos`);
      return;
    }
    case 'restore': {
      const file = args[0];
      if (!file || !existsSync(file)) fail('usage: restore <file> [--force]');
      const r = restoreBackup(file!, config, { force: args.includes('--force') });
      out(`restored backup of ${r.manifest.createdAt} (schema ${r.manifest.schemaVersion}, ${r.manifest.counts.employees} employees, ${r.manifest.counts.photos} photos)`);
      if (r.safetyDir) out(`previous data moved to ${r.safetyDir}`);
      withDb(config, (db) => {
        const m = migrate(db, config.migrationsDir, out);
        audit(db, CLI_ACTOR, 'backup.restored', { type: 'backup' }, { file: path.basename(file!), createdAt: r.manifest.createdAt, migrationsApplied: m.applied });
      });
      return;
    }
    case 'prune-backups': {
      const dir = arg(args, '--dir');
      const days = Number(arg(args, '--days'));
      const minKeep = Number(arg(args, '--min-keep') ?? 3);
      if (!dir || !Number.isInteger(days) || days < 1) fail('usage: prune-backups --dir DIR --days N [--min-keep N]');
      for (const name of pruneBackups(dir!, days, minKeep)) out(`removed ${name}`);
      return;
    }
    case 'demo-data': {
      if (args.includes('--remove')) {
        const n = withDb(config, (db) => {
          const removed = removeDemoData(db);
          audit(db, CLI_ACTOR, 'demo.removed', { type: 'employee' }, { removed });
          return removed;
        });
        out(`demo data removed: ${n} employees`);
        return;
      }
      if (!args.includes('--yes')) fail('demonstration data is loaded only on request: demo-data --yes');
      const r = withDb(
        config,
        (db) => {
          const res = loadDemoData(db);
          audit(db, CLI_ACTOR, 'demo.loaded', { type: 'employee' }, res);
          return res;
        },
        { migrate: true },
      );
      out(`demo data loaded: ${r.employees} employees, ${r.teams} teams (remove with: demo-data --remove)`);
      return;
    }
    default:
      out(HELP);
      fail(`unknown command "${command}"`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof BackupError) fail(err.message, 4);
  if (err instanceof SchemaTooNewError) fail(err.message, 3);
  fail((err as Error)?.message ?? String(err));
});
