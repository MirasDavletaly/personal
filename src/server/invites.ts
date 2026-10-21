import { USERNAME_RE, type Role } from '../shared/constants.js';
import type { InviteDto, InviteInspectDto, InviteStatus } from '../shared/types.js';
import type { Config } from './config.js';
import { all, nowIso, one, run, tx, type DB } from './db.js';
import { badRequest, conflict, gone } from './errors.js';
import { fullName } from './models.js';
import { randomToken, sha256 } from './security.js';
import { revokeUserSessions } from './sessions.js';

export type InviteKind = 'invite' | 'reset' | 'setup';

interface InviteRow {
  id: number;
  kind: InviteKind;
  role: Role;
  employee_id: number | null;
  user_id: number | null;
  display_name: string | null;
  created_by: number | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  status: string;
  employee_id: number | null;
}

/** Link with the token in the URL fragment: browsers never send the fragment
 * to the server, so it does not end up in access logs, proxies or Referer. */
export function inviteLink(config: Config, token: string, kind: InviteKind): string {
  return `${config.origin}/${kind === 'setup' ? 'setup' : 'invite'}#token=${token}`;
}

const ACTIVE = 'used_at IS NULL AND revoked_at IS NULL AND expires_at > ?';

export function createInvite(
  db: DB,
  input: {
    kind: InviteKind;
    role: Role;
    employeeId?: number | null;
    userId?: number | null;
    displayName?: string | null;
    createdBy: number | null;
    ttlMs: number;
  },
): { id: number; token: string; expiresAt: string } {
  const now = nowIso();
  // Re-issuing replaces the previous active link for the same person.
  if (input.kind === 'invite' && input.employeeId != null) {
    run(db, `UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE kind = 'invite' AND employee_id = ? AND ${ACTIVE}`, now, input.createdBy, input.employeeId, now);
  } else if (input.kind === 'reset' && input.userId != null) {
    run(db, `UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE kind = 'reset' AND user_id = ? AND ${ACTIVE}`, now, input.createdBy, input.userId, now);
  } else if (input.kind === 'setup') {
    run(db, `UPDATE invites SET revoked_at = ? WHERE kind = 'setup' AND ${ACTIVE}`, now, now);
  }
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const r = run(
    db,
    `INSERT INTO invites (token_hash, kind, role, employee_id, user_id, display_name, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    input.kind,
    input.role,
    input.employeeId ?? null,
    input.userId ?? null,
    input.displayName ?? null,
    input.createdBy,
    now,
    expiresAt,
  );
  return { id: r.lastInsertRowid, token, expiresAt };
}

export function getInvite(db: DB, id: number): InviteRow | undefined {
  return one<InviteRow>(db, 'SELECT * FROM invites WHERE id = ?', id);
}

export function revokeInvite(db: DB, id: number, by: number | null): boolean {
  const now = nowIso();
  return run(db, `UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE id = ? AND ${ACTIVE}`, now, by, id, now).changes > 0;
}

/** Revokes every active link that could give access as this employee or user. */
export function revokeInvitesFor(db: DB, target: { employeeId?: number | null; userId?: number | null }, by: number | null): number {
  const now = nowIso();
  let n = 0;
  if (target.employeeId != null) {
    n += run(db, `UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE employee_id = ? AND ${ACTIVE}`, now, by, target.employeeId, now).changes;
  }
  if (target.userId != null) {
    n += run(db, `UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND ${ACTIVE}`, now, by, target.userId, now).changes;
  }
  return n;
}

function findByToken(db: DB, token: string): InviteRow | undefined {
  if (!token || token.length < 20 || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  return one<InviteRow>(db, 'SELECT * FROM invites WHERE token_hash = ?', sha256(token));
}

function statusOf(row: InviteRow | undefined): InviteStatus {
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'valid';
}

function userForInvite(db: DB, row: InviteRow): UserRow | undefined {
  if (row.kind === 'reset' && row.user_id != null) return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id);
  if (row.kind === 'invite' && row.employee_id != null) return one<UserRow>(db, 'SELECT * FROM users WHERE employee_id = ?', row.employee_id);
  return undefined;
}

/** What the holder of a link may see before activation: only who the link is for. */
export function inspectInvite(db: DB, token: string): InviteInspectDto {
  const row = findByToken(db, token);
  const status = statusOf(row);
  if (!row || status !== 'valid') return { status };
  const user = userForInvite(db, row);
  if (row.kind === 'reset') {
    if (!user || user.status !== 'active') return { status: 'invalid' };
    return { status, kind: row.kind, role: user.role, name: user.display_name, username: user.username, needsUsername: false, needsDisplayName: false, expiresAt: row.expires_at };
  }
  if (row.kind === 'invite' && row.employee_id != null) {
    const emp = one<{ first_name: string; last_name: string; status: string }>(db, 'SELECT first_name, last_name, status FROM employees WHERE id = ?', row.employee_id);
    if (!emp || emp.status !== 'active' || (user && user.status !== 'active')) return { status: 'invalid' };
    return {
      status,
      kind: row.kind,
      role: user?.role ?? row.role,
      name: fullName(emp),
      username: user?.username ?? null,
      needsUsername: !user,
      needsDisplayName: false,
      expiresAt: row.expires_at,
    };
  }
  return {
    status,
    kind: row.kind,
    role: row.role,
    name: row.display_name,
    username: null,
    needsUsername: true,
    needsDisplayName: !row.display_name,
    expiresAt: row.expires_at,
  };
}

/** Username for the password policy check before hashing (reset/re-invite). */
export function existingUsernameFor(db: DB, token: string): string | null {
  const row = findByToken(db, token);
  if (!row) return null;
  return userForInvite(db, row)?.username ?? null;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

function assertUsername(db: DB, username: string | undefined): string {
  const u = normalizeUsername(username ?? '');
  if (!USERNAME_RE.test(u)) throw badRequest('username_invalid', 'Username: 3-40 characters a-z, 0-9, dot, dash, underscore');
  if (one(db, 'SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', u)) throw conflict('username_taken', 'This username is already taken');
  return u;
}

export interface AcceptResult {
  userId: number;
  kind: InviteKind;
  created: boolean;
}

/**
 * Activates a link in one transaction: re-checks it is still valid, creates or
 * updates the account, marks the link used. The password hash is computed by
 * the caller beforehand (scrypt is async and must not run inside the transaction).
 */
export function acceptInvite(
  db: DB,
  token: string,
  input: { username?: string; displayName?: string; passwordHash: string },
): AcceptResult {
  return tx(db, () => {
    const row = findByToken(db, token);
    const status = statusOf(row);
    if (!row || status !== 'valid') throw gone(`invite_${status}`, 'This link is no longer valid');
    const now = nowIso();
    let result: AcceptResult;

    const existing = userForInvite(db, row);
    if (row.kind === 'reset' || (row.kind === 'invite' && existing)) {
      if (!existing || existing.status !== 'active') throw gone('invite_invalid', 'This link is no longer valid');
      run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', input.passwordHash, now, existing.id);
      revokeUserSessions(db, Number(existing.id));
      result = { userId: Number(existing.id), kind: row.kind, created: false };
    } else {
      let displayName = (input.displayName ?? '').trim() || row.display_name || '';
      let employeeId: number | null = null;
      if (row.kind === 'invite' && row.employee_id != null) {
        const emp = one<{ id: number; first_name: string; last_name: string; status: string }>(db, 'SELECT id, first_name, last_name, status FROM employees WHERE id = ?', row.employee_id);
        if (!emp || emp.status !== 'active') throw gone('invite_invalid', 'This link is no longer valid');
        employeeId = Number(emp.id);
        displayName = fullName(emp);
      }
      if (!displayName || displayName.length > 80) throw badRequest('display_name_invalid', 'Enter your name (up to 80 characters)');
      const username = assertUsername(db, input.username);
      const role: Role = row.kind === 'setup' ? 'admin' : row.role;
      const r = run(
        db,
        `INSERT INTO users (username, display_name, role, employee_id, password_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        username,
        displayName,
        role,
        employeeId,
        input.passwordHash,
        now,
        now,
      );
      result = { userId: r.lastInsertRowid, kind: row.kind, created: true };
    }
    run(db, 'UPDATE invites SET used_at = ?, used_by_user_id = ? WHERE id = ?', now, result.userId, row.id);
    return result;
  });
}

export function listActiveInvites(db: DB): InviteDto[] {
  const now = nowIso();
  return all<Record<string, unknown>>(
    db,
    `SELECT i.*, e.first_name, e.last_name, cb.display_name AS created_by_name, u.display_name AS user_name
     FROM invites i
     LEFT JOIN employees e ON e.id = i.employee_id
     LEFT JOIN users cb ON cb.id = i.created_by
     LEFT JOIN users u ON u.id = i.user_id
     WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
     ORDER BY i.created_at DESC`,
    now,
  ).map((r) => ({
    id: Number(r.id),
    kind: r.kind as InviteKind,
    role: r.role as Role,
    employeeId: r.employee_id == null ? null : Number(r.employee_id),
    employeeName: r.first_name ? `${String(r.first_name)} ${String(r.last_name)}` : null,
    userId: r.user_id == null ? null : Number(r.user_id),
    displayName: (r.display_name as string | null) ?? (r.user_name as string | null) ?? null,
    createdAt: String(r.created_at),
    createdBy: (r.created_by_name as string | null) ?? null,
    expiresAt: String(r.expires_at),
  }));
}

export function activeAdminCount(db: DB): number {
  return Number(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL")?.n ?? 0);
}
