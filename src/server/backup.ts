import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BackupFileDto } from '../shared/types.js';
import type { Config } from './config.js';
import { all, currentSchemaVersion, latestSchemaVersion, one, openDb, type DB } from './db.js';
import { isPhotoId } from './photos.js';
import { createTar, readTar, type TarFile } from './tar.js';

export const BACKUP_NAME_RE = /^team-kz-backup-(\d{8})-(\d{6})-([a-z0-9-]{1,30})\.tar\.gz$/;
const DB_ENTRY = 'team-kz.sqlite';
const MAX_UNPACKED = 2 * 1024 ** 3;

export interface BackupManifest {
  format: 'team-kz-backup';
  formatVersion: 1;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  reason: string;
  counts: { employees: number; users: number; photos: number };
  missingPhotos: string[];
  files: { name: string; size: number; sha256: string }[];
}

export class BackupError extends Error {}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function removeDbFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      /* not there */
    }
  }
}

/**
 * Consistent online backup: VACUUM INTO writes a transactionally consistent
 * copy of the live WAL database (no need to stop the app); then exactly the
 * photos referenced by that snapshot are added. Photos replaced in the
 * meantime are still on disk (see collectPhotoGarbage), so none is missing.
 */
export function createBackup(db: DB, config: Config, opts: { outDir?: string; reason?: string } = {}): { file: string; manifest: BackupManifest } {
  const outDir = opts.outDir ?? config.backupsDir;
  mkdirSync(outDir, { recursive: true });
  const reason = (opts.reason ?? 'manual').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'manual';
  const created = new Date();
  const name = `team-kz-backup-${stamp(created)}-${reason}.tar.gz`;
  const snapFile = path.join(outDir, `.snapshot-${randomBytes(6).toString('hex')}.sqlite`);
  try {
    db.prepare('VACUUM INTO ?').run(snapFile);
    const snap = openDb(snapFile);
    let photoIds: string[];
    let counts: BackupManifest['counts'];
    let schemaVersion: number;
    try {
      snap.exec('PRAGMA journal_mode = DELETE');
      const check = one<{ integrity_check: string }>(snap, 'PRAGMA integrity_check');
      if (check?.integrity_check !== 'ok') throw new BackupError('database integrity check failed');
      schemaVersion = currentSchemaVersion(snap);
      photoIds = all<{ photo_id: string }>(snap, 'SELECT photo_id FROM employees WHERE photo_id IS NOT NULL').map((r) => r.photo_id);
      counts = {
        employees: Number(one<{ n: number }>(snap, 'SELECT COUNT(*) AS n FROM employees')?.n ?? 0),
        users: Number(one<{ n: number }>(snap, 'SELECT COUNT(*) AS n FROM users')?.n ?? 0),
        photos: 0,
      };
    } finally {
      snap.close();
    }

    const files: TarFile[] = [{ name: DB_ENTRY, data: readFileSync(snapFile), mtime: created }];
    const missingPhotos: string[] = [];
    for (const id of photoIds) {
      const file = path.join(config.photosDir, `${id}.jpg`);
      if (isPhotoId(id) && existsSync(file)) files.push({ name: `photos/${id}.jpg`, data: readFileSync(file), mtime: statSync(file).mtime });
      else missingPhotos.push(id);
    }
    counts.photos = files.length - 1;
    const manifest: BackupManifest = {
      format: 'team-kz-backup',
      formatVersion: 1,
      appVersion: config.version,
      schemaVersion,
      createdAt: created.toISOString(),
      reason,
      counts,
      missingPhotos,
      files: files.map((f) => ({ name: f.name, size: f.data.length, sha256: sha256(f.data) })),
    };
    files.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: created });

    const target = path.join(outDir, name);
    const partial = path.join(outDir, `.${name}.partial`);
    writeFileSync(partial, gzipSync(createTar(files), { level: 6 }), { mode: 0o640 });
    renameSync(partial, target);
    return { file: target, manifest };
  } finally {
    removeDbFiles(snapFile);
  }
}

export interface VerifiedBackup {
  manifest: BackupManifest;
  db: Buffer;
  photos: { id: string; data: Buffer }[];
}

/** Full check: gzip, tar, manifest, SHA-256 of every file, SQLite integrity, schema version. */
export function verifyBackup(file: string, config: Pick<Config, 'migrationsDir'>, tmpDir: string): VerifiedBackup {
  let entries: TarFile[];
  try {
    entries = readTar(gunzipSync(readFileSync(file), { maxOutputLength: MAX_UNPACKED }));
  } catch (err) {
    throw new BackupError(`cannot read archive: ${(err as Error).message}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const rawManifest = byName.get('manifest.json');
  if (!rawManifest) throw new BackupError('manifest.json is missing: this is not a Team Kazakhstan backup');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(rawManifest.toString('utf8')) as BackupManifest;
  } catch {
    throw new BackupError('manifest.json is damaged');
  }
  if (manifest.format !== 'team-kz-backup' || manifest.formatVersion !== 1) throw new BackupError('unknown backup format');
  const latest = latestSchemaVersion(config.migrationsDir);
  if (manifest.schemaVersion > latest) {
    throw new BackupError(`backup schema version ${manifest.schemaVersion} is newer than this application (${latest}); use the newer application version`);
  }
  const listed = new Set(manifest.files.map((f) => f.name));
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    if (!listed.has(e.name)) throw new BackupError(`unexpected file in archive: ${e.name}`);
  }
  const photos: { id: string; data: Buffer }[] = [];
  let dbData: Buffer | undefined;
  for (const f of manifest.files) {
    const data = byName.get(f.name);
    if (!data) throw new BackupError(`file listed in manifest is missing: ${f.name}`);
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new BackupError(`checksum mismatch: ${f.name}`);
    if (f.name === DB_ENTRY) {
      dbData = data;
      continue;
    }
    const m = /^photos\/([a-f0-9]{32})\.jpg$/.exec(f.name);
    if (!m) throw new BackupError(`unexpected file name: ${f.name}`);
    photos.push({ id: m[1]!, data });
  }
  if (!dbData) throw new BackupError('database file is missing in the archive');

  mkdirSync(tmpDir, { recursive: true });
  const probe = path.join(tmpDir, `.verify-${randomBytes(6).toString('hex')}.sqlite`);
  writeFileSync(probe, dbData);
  try {
    const db = openDb(probe);
    try {
      const check = one<{ integrity_check: string }>(db, 'PRAGMA integrity_check');
      if (check?.integrity_check !== 'ok') throw new BackupError('database in the archive failed the integrity check');
      if (currentSchemaVersion(db) !== manifest.schemaVersion) throw new BackupError('database schema version does not match the manifest');
    } finally {
      db.close();
    }
  } finally {
    removeDbFiles(probe);
  }
  return { manifest, db: dbData, photos };
}

export function heartbeatFile(config: Pick<Config, 'dataDir'>): string {
  return path.join(config.dataDir, '.app-running');
}

export function appSeemsRunning(config: Pick<Config, 'dataDir'>): boolean {
  try {
    const beat = JSON.parse(readFileSync(heartbeatFile(config), 'utf8')) as { heartbeatAt?: string };
    return !!beat.heartbeatAt && Date.now() - Date.parse(beat.heartbeatAt) < 90_000;
  } catch {
    return false;
  }
}

export function dataExists(config: Pick<Config, 'dbPath'>): boolean {
  if (!existsSync(config.dbPath)) return false;
  const db = openDb(config.dbPath);
  try {
    const hasTable = one(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!hasTable) return false;
    const n = one<{ n: number }>(db, 'SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM employees) AS n');
    return Number(n?.n ?? 0) > 0;
  } finally {
    db.close();
  }
}

/**
 * Replaces the database and photos with the archive contents. The application
 * must be stopped. Current files are first moved to pre-restore-<time>/.
 */
export function restoreBackup(
  file: string,
  config: Config,
  opts: { force: boolean },
): { manifest: BackupManifest; safetyDir: string | null } {
  if (appSeemsRunning(config)) throw new BackupError('the application is running; stop it first (scripts/restore.sh does this)');
  const verified = verifyBackup(file, config, config.dataDir);
  if (dataExists(config) && !opts.force) {
    throw new BackupError('the data directory already contains data; repeat with --force to replace it (a safety copy is kept)');
  }
  let safetyDir: string | null = null;
  const toMove = [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, config.photosDir].filter((f) => existsSync(f));
  if (toMove.length) {
    safetyDir = path.join(config.dataDir, `pre-restore-${stamp(new Date())}`);
    mkdirSync(safetyDir, { recursive: true });
    for (const f of toMove) renameSync(f, path.join(safetyDir, path.basename(f)));
  }
  mkdirSync(config.photosDir, { recursive: true });
  for (const p of verified.photos) writeFileSync(path.join(config.photosDir, `${p.id}.jpg`), p.data, { mode: 0o640 });
  const tmpDb = `${config.dbPath}.restore-tmp`;
  writeFileSync(tmpDb, verified.db, { mode: 0o640 });
  renameSync(tmpDb, config.dbPath);
  return { manifest: verified.manifest, safetyDir };
}

export function listBackups(dir: string): BackupFileDto[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => BACKUP_NAME_RE.test(n))
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Deletes backups older than `days`, always keeping the `minKeep` newest. */
export function pruneBackups(dir: string, days: number, minKeep = 3): string[] {
  const cutoff = Date.now() - days * 86400_000;
  const removed: string[] = [];
  listBackups(dir)
    .slice(minKeep)
    .forEach((b) => {
      if (Date.parse(b.createdAt) < cutoff) {
        rmSync(path.join(dir, b.name), { force: true });
        removed.push(b.name);
      }
    });
  return removed;
}
