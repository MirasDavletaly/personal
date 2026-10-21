import type { FastifyInstance, FastifyRequest } from 'fastify';
import { USERNAME_RE, type Role } from '../../shared/constants.js';
import type { InviteDto, InviteInspectDto, InviteLinkDto, SessionDto } from '../../shared/types.js';
import { actorOf, type AppContext } from '../app.js';
import { audit } from '../audit.js';
import { nowIso, one, run } from '../db.js';
import { badRequest, conflict, forbidden, gone, notFound, tooMany } from '../errors.js';
import { acceptInvite, createInvite, getInvite, inspectInvite, inviteLink, listActiveInvites, normalizeUsername, revokeInvite } from '../invites.js';
import { fullName, getEmployeeRow } from '../models.js';
import { checkPassword, hashPassword } from '../security.js';
import { cookieName, cookieOptions, createSession } from '../sessions.js';
import { getSettings } from '../settings.js';
import { acceptBody, adminInviteBody, parseId, tokenBody } from '../validation.js';
import { sessionUserDto } from './auth.js';

export function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, limits } = ctx;
  const ttlMs = () => getSettings(db, config).inviteTtlHours * 3600_000;

  function limitInvite(req: FastifyRequest): void {
    const key = `ip:${req.ip}`;
    const wait = limits.invite.retryAfter(key);
    if (wait) throw tooMany(wait);
    limits.invite.hit(key);
  }

  // Coordinator/admin: personal one-time link for an employee. Re-issuing
  // revokes the previous link. For an already activated account the new link
  // sets a new password.
  app.post('/api/employees/:id/invite', { config: { roles: ['admin', 'coordinator'] } }, async (req): Promise<InviteLinkDto> => {
    const id = parseId((req.params as { id: string }).id);
    const emp = getEmployeeRow(db, id);
    if (!emp) throw notFound();
    if (emp.status !== 'active') throw conflict('employee_inactive', 'The employee is deactivated');
    const linked = one<{ id: number; role: Role; status: string }>(db, 'SELECT id, role, status FROM users WHERE employee_id = ?', id);
    if (linked && linked.status !== 'active') throw conflict('user_disabled', 'The account is disabled; an administrator must enable it first');
    if (linked && linked.role !== 'employee' && req.user!.role !== 'admin') {
      throw forbidden('forbidden', 'Only an administrator can issue links for director or administrator accounts');
    }
    const invite = createInvite(db, { kind: 'invite', role: linked?.role ?? 'employee', employeeId: id, createdBy: req.user!.id, ttlMs: ttlMs() });
    audit(db, actorOf(req), 'invite.created', { type: 'invite', id: invite.id }, { employeeId: id, employee: fullName(emp), existingAccount: !!linked, expiresAt: invite.expiresAt }, req.ip);
    return { inviteId: invite.id, link: inviteLink(config, invite.token, 'invite'), expiresAt: invite.expiresAt };
  });

  // Administrator: access for guests (viewer), coordinators or administrators.
  app.post('/api/admin/invites', { config: { roles: ['admin'] } }, async (req): Promise<InviteLinkDto> => {
    const body = adminInviteBody.parse(req.body);
    let displayName = body.displayName?.trim() || null;
    const employeeId = body.employeeId ?? null;
    if (body.role === 'employee' && employeeId == null) throw badRequest('employee_required', 'An employee profile is required for the employee role');
    if (employeeId != null) {
      const emp = getEmployeeRow(db, employeeId);
      if (!emp || emp.status !== 'active') throw badRequest('employee_not_found', 'Employee not found or deactivated');
      if (one(db, 'SELECT 1 AS x FROM users WHERE employee_id = ?', employeeId)) throw conflict('employee_has_account', 'This employee already has an account');
      displayName = fullName(emp);
    }
    if (!displayName) throw badRequest('display_name_required', 'Enter the name of the person');
    const invite = createInvite(db, { kind: 'invite', role: body.role, employeeId, displayName: employeeId ? null : displayName, createdBy: req.user!.id, ttlMs: ttlMs() });
    audit(db, actorOf(req), 'invite.created', { type: 'invite', id: invite.id }, { role: body.role, displayName, employeeId, expiresAt: invite.expiresAt }, req.ip);
    return { inviteId: invite.id, link: inviteLink(config, invite.token, 'invite'), expiresAt: invite.expiresAt };
  });

  app.get('/api/invites', { config: { roles: ['admin', 'coordinator'] } }, async (req): Promise<InviteDto[]> => {
    const list = listActiveInvites(db);
    return req.user!.role === 'admin' ? list : list.filter((i) => i.kind === 'invite' && i.employeeId != null);
  });

  app.delete('/api/invites/:id', { config: { roles: ['admin', 'coordinator'] } }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const inv = getInvite(db, id);
    if (!inv) throw notFound();
    if (req.user!.role !== 'admin' && !(inv.kind === 'invite' && inv.employee_id != null && inv.role === 'employee')) throw forbidden();
    const revoked = revokeInvite(db, id, req.user!.id);
    if (revoked) audit(db, actorOf(req), 'invite.revoked', { type: 'invite', id }, { kind: inv.kind, employeeId: inv.employee_id, userId: inv.user_id }, req.ip);
    return { ok: true, revoked };
  });

  // Public: the link holder learns only whom the link is for.
  app.post('/api/invites/inspect', { config: { auth: 'public' } }, async (req): Promise<InviteInspectDto> => {
    limitInvite(req);
    const { token } = tokenBody.parse(req.body);
    return inspectInvite(db, token);
  });

  app.post('/api/invites/accept', { config: { auth: 'public' } }, async (req, reply): Promise<SessionDto> => {
    limitInvite(req);
    const body = acceptBody.parse(req.body);
    const info = inspectInvite(db, body.token);
    if (info.status !== 'valid') throw gone(`invite_${info.status}`, 'This link is no longer valid');
    const username = info.needsUsername ? normalizeUsername(body.username ?? '') : (info.username ?? '');
    if (info.needsUsername && !USERNAME_RE.test(username)) throw badRequest('username_invalid', 'Username: 3-40 characters a-z, 0-9, dot, dash, underscore');
    if (info.needsDisplayName && !body.displayName?.trim()) throw badRequest('display_name_invalid', 'Enter your name');
    const problem = checkPassword(body.password, username);
    if (problem) throw badRequest(problem, 'The password does not meet the requirements');
    const passwordHash = await hashPassword(body.password);
    const result = acceptInvite(db, body.token, { username, displayName: body.displayName, passwordHash });

    const user = one<{ id: number; username: string; display_name: string; role: Role; employee_id: number | null; locale: 'en' | 'ru' | null }>(
      db,
      'SELECT id, username, display_name, role, employee_id, locale FROM users WHERE id = ?',
      result.userId,
    )!;
    const actor = { id: Number(user.id), label: `${user.display_name} (${user.username})` };
    const action = result.kind === 'setup' ? 'setup.completed' : result.kind === 'reset' || !result.created ? 'password.reset_completed' : 'invite.accepted';
    audit(db, actor, action, { type: 'user', id: user.id }, { role: user.role, employeeId: user.employee_id }, req.ip);
    const session = createSession(db, config, Number(user.id), req.ip, req.headers['user-agent'] ?? null);
    run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    reply.setCookie(cookieName(config), session.token, cookieOptions(config));
    return {
      user: sessionUserDto({ id: Number(user.id), username: user.username, displayName: user.display_name, role: user.role, employeeId: user.employee_id == null ? null : Number(user.employee_id), locale: user.locale }),
      csrfToken: session.csrfToken,
      version: config.version,
    };
  });
}
