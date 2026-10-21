import type { Locale, Role } from '../shared/constants.js';
import type { Config } from './config.js';
import { all, nowIso, one, run, type DB } from './db.js';
import { randomToken, sha256 } from './security.js';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  employeeId: number | null;
  locale: Locale | null;
  sessionId: string;
  csrfToken: string;
}

export function cookieName(config: Config): string {
  // __Host- prefix: Secure, Path=/, no Domain; the browser refuses to let
  // another (sub)domain overwrite the cookie.
  return config.cookieSecure ? '__Host-tkz_session' : 'tkz_session';
}

export function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}

export function createSession(db: DB, config: Config, userId: number, ip: string | null, userAgent: string | null) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Date.now();
  run(
    db,
    'INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    csrfToken,
    new Date(now).toISOString(),
    new Date(now + config.sessionTtlMs).toISOString(),
    new Date(now).toISOString(),
    ip,
    userAgent ? userAgent.slice(0, 200) : null,
  );
  return { token, csrfToken };
}

interface SessionJoinRow {
  sid: string;
  csrf_token: string;
  expires_at: string;
  last_seen_at: string;
  id: number;
  username: string;
  display_name: string;
  role: Role;
  employee_id: number | null;
  locale: Locale | null;
  status: string;
  employee_status: string | null;
}

export function loadSession(db: DB, config: Config, token: string | undefined): SessionUser | null {
  if (!token || token.length > 100) return null;
  const sid = sha256(token);
  const row = one<SessionJoinRow>(
    db,
    `SELECT s.id AS sid, s.csrf_token, s.expires_at, s.last_seen_at,
            u.id, u.username, u.display_name, u.role, u.employee_id, u.locale, u.status,
            e.status AS employee_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE s.id = ?`,
    sid,
  );
  if (!row) return null;
  const now = Date.now();
  const expired = Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + config.sessionIdleMs <= now;
  const blocked = row.status !== 'active' || (row.role === 'employee' && row.employee_status !== 'active');
  if (expired || blocked) {
    run(db, 'DELETE FROM sessions WHERE id = ?', sid);
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > 60_000) {
    run(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(now).toISOString(), sid);
  }
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    employeeId: row.employee_id == null ? null : Number(row.employee_id),
    locale: row.locale,
    sessionId: sid,
    csrfToken: row.csrf_token,
  };
}

export function destroySession(db: DB, sessionId: string): void {
  run(db, 'DELETE FROM sessions WHERE id = ?', sessionId);
}

export function revokeUserSessions(db: DB, userId: number, exceptSessionId?: string): number {
  return exceptSessionId
    ? run(db, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId).changes
    : run(db, 'DELETE FROM sessions WHERE user_id = ?', userId).changes;
}

export function countSessions(db: DB): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of all<{ user_id: number; n: number }>(
    db,
    'SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id',
    nowIso(),
  )) {
    map.set(Number(r.user_id), Number(r.n));
  }
  return map;
}

export function pruneSessions(db: DB, config: Config): number {
  const idleCutoff = new Date(Date.now() - config.sessionIdleMs).toISOString();
  return run(db, 'DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?', nowIso(), idleCutoff).changes;
}
