import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Role } from '../../shared/constants.js';
import type { AuditEntryDto, BackupFileDto, InviteLinkDto, SettingsDto, UserDto } from '../../shared/types.js';
import { actorOf, type AppContext } from '../app.js';
import { audit, listAudit } from '../audit.js';
import { BACKUP_NAME_RE, createBackup, listBackups } from '../backup.js';
import { all, currentSchemaVersion, nowIso, one, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { createInvite, inviteLink, listActiveInvites, revokeInvitesFor } from '../invites.js';
import { demoCount, removeDemoData } from '../demo.js';
import { listCompanies, listEmployeeRows, listTeams, toEmployeeDto } from '../models.js';
import { countSessions, revokeUserSessions } from '../sessions.js';
import { getSettings, saveSettings, settingsSchema } from '../settings.js';
import { companyCreate, companyPatch, parseId, teamCreate, teamPatch, userPatch } from '../validation.js';

const ADMIN = { config: { roles: ['admin'] as Role[] } };

/** CSV cell for Excel: quoted, and formula-like values neutralised (CSV injection). */
function csvCell(v: unknown): string {
  let s = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  // ---------------------------------------------------------------- users
  app.get('/api/admin/users', ADMIN, async (): Promise<UserDto[]> => {
    const sessions = countSessions(db);
    return all<Record<string, unknown>>(
      db,
      `SELECT u.*, e.first_name, e.last_name FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.display_name COLLATE NOCASE`,
    ).map((r) => ({
      id: Number(r.id),
      username: String(r.username),
      displayName: String(r.display_name),
      role: r.role as Role,
      status: r.status as 'active' | 'disabled',
      employeeId: r.employee_id == null ? null : Number(r.employee_id),
      employeeName: r.first_name ? `${String(r.first_name)} ${String(r.last_name)}` : null,
      hasPassword: r.password_hash != null,
      activeSessions: sessions.get(Number(r.id)) ?? 0,
      createdAt: String(r.created_at),
      lastLoginAt: (r.last_login_at as string | null) ?? null,
    }));
  });

  app.patch('/api/admin/users/:id', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const patch = userPatch.parse(req.body);
    const me = req.user!;
    const user = one<{ id: number; role: Role; status: string; employee_id: number | null; display_name: string }>(db, 'SELECT * FROM users WHERE id = ?', id);
    if (!user) throw notFound();
    if (id === me.id && ((patch.role && patch.role !== user.role) || (patch.status && patch.status !== user.status))) {
      throw conflict('cannot_change_self', 'You cannot change your own role or status');
    }
    tx(db, () => {
      const role = patch.role ?? user.role;
      const status = patch.status ?? user.status;
      const employeeId = 'employeeId' in patch ? (patch.employeeId ?? null) : user.employee_id == null ? null : Number(user.employee_id);
      if (role === 'employee' && employeeId == null) throw badRequest('employee_required', 'The employee role needs a linked employee profile');
      if (employeeId != null && employeeId !== Number(user.employee_id)) {
        const emp = one<{ status: string }>(db, 'SELECT status FROM employees WHERE id = ?', employeeId);
        if (!emp || emp.status !== 'active') throw badRequest('employee_not_found', 'Employee not found or deactivated');
        if (one(db, 'SELECT 1 AS x FROM users WHERE employee_id = ? AND id <> ?', employeeId, id)) throw conflict('employee_has_account', 'This employee already has an account');
      }
      if (user.role === 'admin' && (role !== 'admin' || status !== 'active')) {
        const others = Number(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?", id)?.n ?? 0);
        if (others === 0) throw conflict('last_admin', 'At least one active administrator is required');
      }
      run(
        db,
        'UPDATE users SET role = ?, status = ?, employee_id = ?, display_name = ?, updated_at = ? WHERE id = ?',
        role,
        status,
        employeeId,
        patch.displayName ?? user.display_name,
        nowIso(),
        id,
      );
      if (role !== user.role) audit(db, actorOf(req), 'user.role_changed', { type: 'user', id }, { from: user.role, to: role }, req.ip);
      if (status !== user.status) {
        let sessions = 0;
        let invites = 0;
        if (status === 'disabled') {
          sessions = revokeUserSessions(db, id);
          invites = revokeInvitesFor(db, { userId: id, employeeId }, me.id);
        }
        audit(db, actorOf(req), status === 'disabled' ? 'user.disabled' : 'user.enabled', { type: 'user', id }, { sessionsRevoked: sessions, invitesRevoked: invites }, req.ip);
      }
      if (employeeId !== (user.employee_id == null ? null : Number(user.employee_id))) {
        audit(db, actorOf(req), 'user.employee_linked', { type: 'user', id }, { from: user.employee_id, to: employeeId }, req.ip);
      }
      if (patch.displayName && patch.displayName !== user.display_name) audit(db, actorOf(req), 'user.renamed', { type: 'user', id }, {}, req.ip);
    });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-link', ADMIN, async (req): Promise<InviteLinkDto> => {
    const id = parseId((req.params as { id: string }).id);
    const user = one<{ id: number; role: Role; status: string }>(db, 'SELECT id, role, status FROM users WHERE id = ?', id);
    if (!user) throw notFound();
    if (user.status !== 'active') throw conflict('user_disabled', 'Enable the account first');
    const invite = createInvite(db, { kind: 'reset', role: user.role, userId: id, createdBy: req.user!.id, ttlMs: getSettings(db, config).inviteTtlHours * 3600_000 });
    audit(db, actorOf(req), 'password.reset_link_created', { type: 'user', id }, { expiresAt: invite.expiresAt }, req.ip);
    return { inviteId: invite.id, link: inviteLink(config, invite.token, 'reset'), expiresAt: invite.expiresAt };
  });

  app.post('/api/admin/users/:id/revoke-sessions', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const n = id === req.user!.id ? revokeUserSessions(db, id, req.user!.sessionId) : revokeUserSessions(db, id);
    audit(db, actorOf(req), 'user.sessions_revoked', { type: 'user', id }, { count: n }, req.ip);
    return { ok: true, revoked: n };
  });

  // -------------------------------------------------------- companies/teams
  app.post('/api/admin/companies', ADMIN, async (req, reply) => {
    const body = companyCreate.parse(req.body);
    if (one(db, 'SELECT 1 AS x FROM companies WHERE name = ? COLLATE NOCASE', body.name)) throw conflict('name_taken', 'A company with this name exists');
    const now = nowIso();
    const r = run(db, 'INSERT INTO companies (name, sort_order, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', body.name, body.sortOrder ?? 100, now, now);
    audit(db, actorOf(req), 'company.created', { type: 'company', id: r.lastInsertRowid }, { name: body.name }, req.ip);
    reply.code(201);
    return { id: r.lastInsertRowid };
  });

  app.patch('/api/admin/companies/:id', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const body = companyPatch.parse(req.body);
    const c = one<{ name: string; sort_order: number; active: number }>(db, 'SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw notFound();
    if (body.name && one(db, 'SELECT 1 AS x FROM companies WHERE name = ? COLLATE NOCASE AND id <> ?', body.name, id)) throw conflict('name_taken', 'A company with this name exists');
    run(
      db,
      'UPDATE companies SET name = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?',
      body.name ?? c.name,
      body.sortOrder ?? c.sort_order,
      body.active === undefined ? c.active : body.active ? 1 : 0,
      nowIso(),
      id,
    );
    audit(db, actorOf(req), 'company.updated', { type: 'company', id }, { before: { name: c.name, sortOrder: c.sort_order, active: !!c.active }, changes: body }, req.ip);
    return { ok: true };
  });

  app.delete('/api/admin/companies/:id', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const c = one<{ name: string }>(db, 'SELECT name FROM companies WHERE id = ?', id);
    if (!c) throw notFound();
    if (one(db, 'SELECT 1 AS x FROM employees WHERE company_id = ? UNION SELECT 1 FROM teams WHERE company_id = ?', id, id)) {
      throw conflict('in_use', 'The company still has teams or employees; deactivate it instead');
    }
    run(db, 'DELETE FROM companies WHERE id = ?', id);
    audit(db, actorOf(req), 'company.deleted', { type: 'company', id }, { name: c.name }, req.ip);
    return { ok: true };
  });

  app.post('/api/admin/teams', ADMIN, async (req, reply) => {
    const body = teamCreate.parse(req.body);
    if (!one(db, 'SELECT 1 AS x FROM companies WHERE id = ?', body.companyId)) throw badRequest('company_not_found', 'Company not found');
    if (one(db, 'SELECT 1 AS x FROM teams WHERE company_id = ? AND name = ? COLLATE NOCASE', body.companyId, body.name)) throw conflict('name_taken', 'A team with this name exists');
    const now = nowIso();
    const r = run(db, 'INSERT INTO teams (company_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', body.companyId, body.name, body.sortOrder ?? 100, now, now);
    audit(db, actorOf(req), 'team.created', { type: 'team', id: r.lastInsertRowid }, { name: body.name, companyId: body.companyId }, req.ip);
    reply.code(201);
    return { id: r.lastInsertRowid };
  });

  app.patch('/api/admin/teams/:id', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const body = teamPatch.parse(req.body);
    const t = one<{ name: string; sort_order: number; active: number; company_id: number }>(db, 'SELECT * FROM teams WHERE id = ?', id);
    if (!t) throw notFound();
    if (body.name && one(db, 'SELECT 1 AS x FROM teams WHERE company_id = ? AND name = ? COLLATE NOCASE AND id <> ?', t.company_id, body.name, id)) {
      throw conflict('name_taken', 'A team with this name exists');
    }
    run(
      db,
      'UPDATE teams SET name = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?',
      body.name ?? t.name,
      body.sortOrder ?? t.sort_order,
      body.active === undefined ? t.active : body.active ? 1 : 0,
      nowIso(),
      id,
    );
    audit(db, actorOf(req), 'team.updated', { type: 'team', id }, { before: { name: t.name, sortOrder: t.sort_order, active: !!t.active }, changes: body }, req.ip);
    return { ok: true };
  });

  app.delete('/api/admin/teams/:id', ADMIN, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const t = one<{ name: string }>(db, 'SELECT name FROM teams WHERE id = ?', id);
    if (!t) throw notFound();
    if (one(db, 'SELECT 1 AS x FROM employees WHERE team_id = ?', id)) throw conflict('in_use', 'The team still has employees; deactivate it instead');
    run(db, 'DELETE FROM teams WHERE id = ?', id);
    audit(db, actorOf(req), 'team.deleted', { type: 'team', id }, { name: t.name }, req.ip);
    return { ok: true };
  });

  // ------------------------------------------------------------- audit log
  app.get('/api/admin/audit', ADMIN, async (req): Promise<AuditEntryDto[]> => {
    const q = req.query as { before?: string; action?: string; limit?: string };
    const before = q.before && /^\d+$/.test(q.before) ? Number(q.before) : undefined;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const action = q.action && /^[a-z_.]{1,40}$/.test(q.action) ? q.action : undefined;
    return listAudit(db, { before, action, limit });
  });

  // -------------------------------------------------------------- settings
  app.get('/api/admin/settings', ADMIN, async (): Promise<SettingsDto> => getSettings(db, config));

  app.put('/api/admin/settings', ADMIN, async (req): Promise<SettingsDto> => {
    const values = settingsSchema.parse(req.body);
    const before = getSettings(db, config);
    saveSettings(db, values);
    const changed = Object.keys(values).filter((k) => JSON.stringify(values[k as keyof SettingsDto]) !== JSON.stringify(before[k as keyof SettingsDto]));
    audit(db, actorOf(req), 'settings.updated', { type: 'settings' }, { changed }, req.ip);
    return getSettings(db, config);
  });

  // ---------------------------------------------------------------- status
  app.get('/api/admin/status', ADMIN, async () => {
    const count = (sql: string) => Number(one<{ n: number }>(db, sql)?.n ?? 0);
    let hostBackup: unknown = null;
    const statusFile = path.join(config.dataDir, '.last-host-backup.json');
    if (existsSync(statusFile)) {
      try {
        hostBackup = JSON.parse(readFileSync(statusFile, 'utf8'));
      } catch {
        hostBackup = null;
      }
    }
    return {
      version: config.version,
      schemaVersion: currentSchemaVersion(db),
      baseUrl: config.origin,
      employees: count("SELECT COUNT(*) AS n FROM employees WHERE status = 'active'"),
      inactiveEmployees: count("SELECT COUNT(*) AS n FROM employees WHERE status <> 'active'"),
      withPhoto: count("SELECT COUNT(*) AS n FROM employees WHERE status = 'active' AND photo_id IS NOT NULL"),
      users: count("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
      activeInvites: listActiveInvites(db).length,
      demoEmployees: demoCount(db),
      lastHostBackup: hostBackup,
      appBackups: listBackups(config.backupsDir).slice(0, 1),
    };
  });

  // ---------------------------------------------------------------- export
  app.get('/api/admin/export.json', ADMIN, async (req, reply) => {
    const data = {
      exportedAt: nowIso(),
      app: 'team-kazakhstan',
      version: config.version,
      companies: listCompanies(db),
      teams: listTeams(db),
      employees: listEmployeeRows(db, { includeInactive: true }).map(toEmployeeDto),
      users: all(db, 'SELECT id, username, display_name, role, status, employee_id, created_at, last_login_at FROM users ORDER BY id'),
      settings: getSettings(db, config),
    };
    audit(db, actorOf(req), 'export.json', { type: 'export' }, { employees: data.employees.length }, req.ip);
    reply.header('Content-Disposition', `attachment; filename="team-kz-export-${nowIso().slice(0, 10)}.json"`);
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(data, null, 2));
  });

  app.get('/api/admin/export.csv', ADMIN, async (req, reply) => {
    const header = ['id', 'first_name', 'last_name', 'company', 'team', 'official_title', 'profession', 'current_work', 'languages', 'work_email', 'phone', 'algoritmi_availability', 'status', 'updated_at'];
    const rows = listEmployeeRows(db, { includeInactive: true }).map(toEmployeeDto).map((e) =>
      [e.id, e.firstName, e.lastName, e.companyName, e.teamName, e.officialTitle, e.profession, e.currentWork, e.languages, e.workEmail, e.phone, e.algoritmiAvailability, e.status, e.updatedAt]
        .map(csvCell)
        .join(';'),
    );
    audit(db, actorOf(req), 'export.csv', { type: 'export' }, { employees: rows.length }, req.ip);
    reply.header('Content-Disposition', `attachment; filename="team-kz-employees-${nowIso().slice(0, 10)}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(`﻿${header.map(csvCell).join(';')}\r\n${rows.join('\r\n')}\r\n`);
  });

  // --------------------------------------------------------------- backups
  app.get('/api/admin/backups', ADMIN, async (): Promise<BackupFileDto[]> => listBackups(config.backupsDir));

  app.post('/api/admin/backups', ADMIN, async (req): Promise<BackupFileDto> => {
    const { file, manifest } = createBackup(db, config, { reason: 'admin-panel' });
    audit(db, actorOf(req), 'backup.created', { type: 'backup' }, { file: path.basename(file), counts: manifest.counts }, req.ip);
    return listBackups(config.backupsDir).find((b) => b.name === path.basename(file))!;
  });

  app.get('/api/admin/backups/:name', ADMIN, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!BACKUP_NAME_RE.test(name)) throw notFound();
    const file = path.join(config.backupsDir, name);
    if (!existsSync(file)) throw notFound();
    audit(db, actorOf(req), 'backup.downloaded', { type: 'backup' }, { file: name }, req.ip);
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.type('application/gzip').send(createReadStream(file));
  });

  app.post('/api/admin/demo/remove', ADMIN, async (req) => {
    const removed = removeDemoData(db);
    audit(db, actorOf(req), 'demo.removed', { type: 'employee' }, { removed }, req.ip);
    return { ok: true, removed };
  });
}
