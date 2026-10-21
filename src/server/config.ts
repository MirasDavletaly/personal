import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Project root: dist/server/.. /.. in the build, src/server/../.. when type-checking. */
export const APP_ROOT = path.resolve(here, '..', '..');

export interface Config {
  env: 'production' | 'development' | 'test';
  version: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  photosDir: string;
  backupsDir: string;
  webDir: string;
  migrationsDir: string;
  baseUrl: URL;
  origin: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  trustProxy: string[] | false;
  cookieSecure: boolean;
  sessionTtlMs: number;
  sessionIdleMs: number;
  inviteTtlHoursDefault: number;
  setupTtlMinutes: number;
  maxPhotoBytes: number;
  backupRetentionDays: number;
  logLevel: string;
}

export class ConfigError extends Error {}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * TRUST_PROXY: empty/false = trust no forwarded headers (the TCP peer is the
 * client); "loopback" = only a proxy on 127.0.0.1/::1 (Tailscale sidecar
 * sharing the network namespace); otherwise a comma-separated list of IPs or
 * CIDRs of the reverse proxies. "true"/"*" is refused on purpose.
 */
function parseTrustProxy(raw: string | undefined): string[] | false {
  const value = (raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false' || value.toLowerCase() === 'none') return false;
  if (['true', '*', '0.0.0.0/0', '::/0'].includes(value.toLowerCase())) {
    throw new ConfigError('TRUST_PROXY must list specific proxy addresses, not trust everyone');
  }
  const items = list(value).map((v) => (v.toLowerCase() === 'loopback' ? ['127.0.0.1', '::1'] : [v])).flat();
  for (const item of items) {
    if (!/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(item)) throw new ConfigError(`TRUST_PROXY: bad address "${item}"`);
  }
  return items;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const port = int(env, 'PORT', 8080, 1, 65535);
  const dataDir = path.resolve(env.DATA_DIR?.trim() || (nodeEnv === 'production' ? '/data' : path.join(APP_ROOT, 'data')));

  const rawBase = env.APP_BASE_URL?.trim();
  if (!rawBase && nodeEnv === 'production') {
    throw new ConfigError('APP_BASE_URL is required (for example https://team.example.ts.net)');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBase || `http://localhost:${port}`);
  } catch {
    throw new ConfigError('APP_BASE_URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new ConfigError('APP_BASE_URL must look like https://host[:port] without a path');
  }
  const allowInsecure = bool(env, 'ALLOW_INSECURE_HTTP', false);
  if (nodeEnv === 'production' && baseUrl.protocol !== 'https:' && !allowInsecure) {
    throw new ConfigError(
      'APP_BASE_URL must use https in production (the camera and Secure cookies need HTTPS). ' +
        'For a temporary test without HTTPS set ALLOW_INSECURE_HTTP=true.',
    );
  }

  const allowedHosts = new Set<string>([baseUrl.host.toLowerCase()]);
  const allowedOrigins = new Set<string>([baseUrl.origin]);
  const extraHosts = list(env.EXTRA_ALLOWED_HOSTS);
  if (nodeEnv !== 'production') extraHosts.push(`localhost:${port}`, `127.0.0.1:${port}`, 'localhost:5173', '127.0.0.1:5173');
  for (const h of extraHosts) {
    const host = h.toLowerCase();
    if (!/^[a-z0-9.\-[\]:]+$/.test(host)) throw new ConfigError(`EXTRA_ALLOWED_HOSTS: bad host "${h}"`);
    allowedHosts.add(host);
    allowedOrigins.add(`http://${host}`);
    allowedOrigins.add(`https://${host}`);
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  // Behind a proxy in the same network namespace (Tailscale Serve) only that
  // proxy can connect via loopback; accept its Host in case it rewrites it.
  if (trustProxy && trustProxy.includes('127.0.0.1')) {
    allowedHosts.add(`127.0.0.1:${port}`);
    allowedHosts.add(`localhost:${port}`);
  }

  const cookieMode = (env.COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  const cookieSecure = cookieMode === 'auto' ? baseUrl.protocol === 'https:' : bool(env, 'COOKIE_SECURE', true);
  if (nodeEnv === 'production' && !cookieSecure && !allowInsecure) {
    throw new ConfigError('COOKIE_SECURE=false is only allowed together with ALLOW_INSECURE_HTTP=true');
  }

  return {
    env: nodeEnv,
    version: readVersion(),
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    dataDir,
    dbPath: path.join(dataDir, 'team-kz.sqlite'),
    photosDir: path.join(dataDir, 'photos'),
    backupsDir: path.join(dataDir, 'backups'),
    webDir: path.join(APP_ROOT, 'dist', 'web'),
    migrationsDir: path.join(APP_ROOT, 'migrations'),
    baseUrl,
    origin: baseUrl.origin,
    allowedHosts,
    allowedOrigins,
    trustProxy,
    cookieSecure,
    sessionTtlMs: int(env, 'SESSION_TTL_HOURS', 168, 1, 24 * 90) * 3600_000,
    sessionIdleMs: int(env, 'SESSION_IDLE_HOURS', 48, 1, 24 * 90) * 3600_000,
    inviteTtlHoursDefault: int(env, 'INVITE_TTL_HOURS', 72, 1, 24 * 14),
    setupTtlMinutes: int(env, 'SETUP_LINK_TTL_MINUTES', 60, 5, 24 * 60),
    maxPhotoBytes: int(env, 'MAX_PHOTO_KB', 3072, 200, 10240) * 1024,
    backupRetentionDays: int(env, 'APP_BACKUP_RETENTION_DAYS', 14, 1, 3650),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  };
}
