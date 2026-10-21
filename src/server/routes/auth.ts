import type { FastifyInstance } from 'fastify';
import type { Locale, Role } from '../../shared/constants.js';
import type { MetaDto, SessionDto, SessionUserDto } from '../../shared/types.js';
import { actorOf, type AppContext } from '../app.js';
import { audit } from '../audit.js';
import { nowIso, one, run } from '../db.js';
import { badRequest, tooMany, unauthorized } from '../errors.js';
import { normalizeUsername } from '../invites.js';
import { checkPassword, hashPassword, verifyPassword } from '../security.js';
import { cookieName, cookieOptions, createSession, destroySession, revokeUserSessions, type SessionUser } from '../sessions.js';
import { getSettings } from '../settings.js';
import { localeBody, loginBody, passwordChangeBody } from '../validation.js';

export function sessionUserDto(u: Pick<SessionUser, 'id' | 'username' | 'displayName' | 'role' | 'employeeId' | 'locale'>): SessionUserDto {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, employeeId: u.employeeId, locale: u.locale };
}

interface LoginUserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  employee_id: number | null;
  locale: Locale | null;
  password_hash: string | null;
  status: string;
  employee_status: string | null;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, limits } = ctx;

  app.get('/api/health', { config: { auth: 'public' } }, async () => {
    one(db, 'SELECT 1 AS ok');
    return { status: 'ok' };
  });

  app.get('/api/meta', { config: { auth: 'public' } }, async (): Promise<MetaDto> => {
    const s = getSettings(db, config);
    return { siteTitle: s.siteTitle, defaultLocale: s.defaultLocale, privacyContact: s.privacyContact };
  });

  app.get('/api/auth/session', { config: { auth: 'public' } }, async (req): Promise<SessionDto> => {
    if (!req.user) return { user: null };
    return { user: sessionUserDto(req.user), csrfToken: req.user.csrfToken, version: config.version };
  });

  app.post('/api/auth/login', { config: { auth: 'public' } }, async (req, reply): Promise<SessionDto> => {
    const body = loginBody.parse(req.body);
    const username = normalizeUsername(body.username);
    const ipKey = `ip:${req.ip}`;
    const userKey = `user:${username}`;
    const wait = Math.max(limits.loginIp.retryAfter(ipKey), limits.loginUser.retryAfter(userKey));
    if (wait) throw tooMany(wait);
    limits.loginIp.hit(ipKey);

    const user = one<LoginUserRow>(
      db,
      `SELECT u.*, e.status AS employee_status FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.username = ? COLLATE NOCASE`,
      username,
    );
    // verifyPassword always runs scrypt (with a dummy hash for unknown users),
    // so the response time does not reveal whether the username exists.
    const passwordOk = await verifyPassword(body.password, user?.password_hash ?? null);
    const allowed = !!user && passwordOk && user.status === 'active' && !(user.role === 'employee' && user.employee_status !== 'active');
    if (!user || !allowed) {
      limits.loginUser.hit(userKey);
      // The typed username is recorded only if it exists (people sometimes type the password into it).
      audit(db, { id: null, label: 'anonymous' }, 'auth.login_failed', { type: 'user', id: user?.id ?? null }, user ? { username: user.username } : { unknownUser: true }, req.ip);
      throw unauthorized('invalid_credentials', 'Invalid username or password');
    }
    limits.loginUser.reset(userKey);
    const session = createSession(db, config, Number(user.id), req.ip, req.headers['user-agent'] ?? null);
    run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    audit(db, { id: Number(user.id), label: `${user.display_name} (${user.username})` }, 'auth.login', { type: 'user', id: user.id }, {}, req.ip);
    reply.setCookie(cookieName(config), session.token, cookieOptions(config));
    return {
      user: sessionUserDto({ id: Number(user.id), username: user.username, displayName: user.display_name, role: user.role, employeeId: user.employee_id == null ? null : Number(user.employee_id), locale: user.locale }),
      csrfToken: session.csrfToken,
      version: config.version,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.user!.sessionId);
    audit(db, actorOf(req), 'auth.logout', { type: 'user', id: req.user!.id }, {}, req.ip);
    reply.clearCookie(cookieName(config), { path: '/', secure: config.cookieSecure, httpOnly: true, sameSite: 'lax' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const body = passwordChangeBody.parse(req.body);
    const user = req.user!;
    const row = one<{ password_hash: string | null }>(db, 'SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) {
      throw badRequest('wrong_current_password', 'The current password is wrong');
    }
    const problem = checkPassword(body.newPassword, user.username);
    if (problem) throw badRequest(problem, 'The new password does not meet the requirements');
    const hash = await hashPassword(body.newPassword);
    run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), user.id);
    const revoked = revokeUserSessions(db, user.id, user.sessionId);
    audit(db, actorOf(req), 'auth.password_changed', { type: 'user', id: user.id }, { otherSessionsRevoked: revoked }, req.ip);
    return { ok: true };
  });

  app.put('/api/auth/locale', async (req) => {
    const { locale } = localeBody.parse(req.body);
    run(db, 'UPDATE users SET locale = ?, updated_at = ? WHERE id = ?', locale, nowIso(), req.user!.id);
    return { ok: true };
  });
}
