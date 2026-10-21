import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

export function openDb(file: string, opts: { readOnly?: boolean } = {}): DB {
  if (!opts.readOnly) mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: opts.readOnly ?? false, enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout = 15000');
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Runs fn inside BEGIN IMMEDIATE ... COMMIT. fn must be synchronous: node:sqlite
 * is synchronous, so nothing else can run on this connection in between.
 */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

export function one<T = Row>(db: DB, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Row>(db: DB, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: DB, sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export type SqlParam = string | number | bigint | null | Uint8Array | Record<string, string | number | bigint | null | Uint8Array>;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export class SchemaTooNewError extends Error {
  constructor(
    public readonly dbVersion: number,
    public readonly appVersion: number,
  ) {
    super(
      `The database schema (version ${dbVersion}) is newer than this application supports (version ${appVersion}). ` +
        'Start the newer application version again, or restore a backup made with this version (see README, "Rollback").',
    );
  }
}

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3,}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8');
      return {
        version: Number.parseInt(name, 10),
        name,
        sql,
        checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
      };
    });
}

export function latestSchemaVersion(dir: string): number {
  return loadMigrations(dir).at(-1)?.version ?? 0;
}

export function currentSchemaVersion(db: DB): number {
  const exists = one(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (!exists) return 0;
  return Number(one<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0);
}

/**
 * Applies pending migrations. BEGIN IMMEDIATE takes SQLite's write lock, so two
 * processes starting at the same time cannot both migrate: the second waits
 * (busy_timeout) and then sees the migrations already applied.
 */
export function migrate(db: DB, dir: string, log: (msg: string) => void = () => {}): { applied: string[]; version: number } {
  const migrations = loadMigrations(dir);
  const latest = migrations.at(-1)?.version ?? 0;
  const applied: string[] = [];
  tx(db, () => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const done = all<{ version: number; name: string; checksum: string }>(db, 'SELECT version, name, checksum FROM schema_migrations');
    const maxDone = done.reduce((m, r) => Math.max(m, Number(r.version)), 0);
    if (maxDone > latest) throw new SchemaTooNewError(maxDone, latest);
    for (const row of done) {
      const known = migrations.find((m) => m.version === Number(row.version));
      if (known && known.checksum !== row.checksum) log(`warning: migration ${known.name} differs from the applied version`);
    }
    for (const m of migrations) {
      if (done.some((r) => Number(r.version) === m.version)) continue;
      db.exec(m.sql);
      run(db, 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', m.version, m.name, m.checksum, nowIso());
      applied.push(m.name);
    }
    db.exec(`PRAGMA user_version = ${latest}`);
  });
  for (const name of applied) log(`migration applied: ${name}`);
  return { applied, version: latest };
}
