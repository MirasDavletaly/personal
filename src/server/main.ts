import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildApp, createLimits } from './app.js';
import { heartbeatFile, pruneBackups } from './backup.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { migrate, openDb, SchemaTooNewError } from './db.js';
import { activeAdminCount } from './invites.js';
import { collectPhotoGarbage } from './photos.js';
import { pruneSessions } from './sessions.js';

function fatal(message: string, code: number): never {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: message })}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fatal(`configuration error: ${err.message}`, 2);
    throw err;
  }
  for (const dir of [config.dataDir, config.photosDir, config.backupsDir]) mkdirSync(dir, { recursive: true });

  const db = openDb(config.dbPath);
  try {
    const result = migrate(db, config.migrationsDir, (m) => process.stdout.write(`${JSON.stringify({ level: 'info', msg: m })}\n`));
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: `database schema version ${result.version}` })}\n`);
  } catch (err) {
    if (err instanceof SchemaTooNewError) fatal(err.message, 3);
    throw err;
  }

  const limits = createLimits();
  const app = await buildApp({ config, db, limits });
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ version: config.version, baseUrl: config.origin, trustProxy: config.trustProxy, secureCookies: config.cookieSecure }, 'Team Kazakhstan started');
  if (activeAdminCount(db) === 0) {
    app.log.warn('No administrator yet. Create the one-time set-up link: scripts/admin-link.sh on the NAS (or: node dist/server/cli.js setup-link)');
  }

  // Heartbeat: lets the restore command refuse to run while the app is up.
  const startedAt = new Date().toISOString();
  const beat = () => {
    try {
      writeFileSync(heartbeatFile(config), JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: new Date().toISOString() }));
    } catch (err) {
      app.log.warn({ err }, 'cannot write heartbeat');
    }
  };
  beat();
  const beatTimer = setInterval(beat, 30_000);

  const maintenance = () => {
    try {
      const sessions = pruneSessions(db, config);
      const photos = collectPhotoGarbage(db, config.photosDir, 2 * 3600_000);
      const backups = pruneBackups(config.backupsDir, config.backupRetentionDays);
      for (const l of Object.values(limits)) l.prune();
      if (sessions || photos || backups.length) app.log.info({ sessions, photos, backups: backups.length }, 'maintenance');
    } catch (err) {
      app.log.error({ err }, 'maintenance failed');
    }
  };
  maintenance();
  const maintenanceTimer = setInterval(maintenance, 3600_000);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(beatTimer);
    clearInterval(maintenanceTimer);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      db.close();
      rmSync(heartbeatFile(config), { force: true });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => fatal(`start-up failed: ${(err as Error)?.stack ?? String(err)}`, 1));
