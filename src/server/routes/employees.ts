import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EMPLOYEE_FIELDS, OFFICIAL_FIELDS, IDENTITY_FIELDS, type EmployeeField } from '../../shared/constants.js';
import type { EmployeeDto, ManagedEmployeeDto } from '../../shared/types.js';
import { actorOf, type AppContext } from '../app.js';
import { audit } from '../audit.js';
import { nowIso, one, run, tx, type DB } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { revokeInvitesFor } from '../invites.js';
import { fullName, getEmployeeRow, listManagedEmployees, toEmployeeDto, type EmployeeRow } from '../models.js';
import { canRemovePhoto, canSeeInactive, canUploadPhoto, editableFields } from '../permissions.js';
import { processPhoto, storePhoto } from '../photos.js';
import { revokeUserSessions } from '../sessions.js';
import { employeeCreate, employeePatch, parseId, plainObject, type EmployeePatch } from '../validation.js';

const COLUMN: Record<EmployeeField, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  companyId: 'company_id',
  teamId: 'team_id',
  officialTitle: 'official_title',
  profession: 'profession',
  currentWork: 'current_work',
  languages: 'languages',
  workEmail: 'work_email',
  phone: 'phone',
  algoritmiAvailability: 'algoritmi_availability',
};

const ROW_VALUE: Record<EmployeeField, (r: EmployeeRow) => unknown> = {
  firstName: (r) => r.first_name,
  lastName: (r) => r.last_name,
  companyId: (r) => (r.company_id == null ? null : Number(r.company_id)),
  teamId: (r) => (r.team_id == null ? null : Number(r.team_id)),
  officialTitle: (r) => r.official_title,
  profession: (r) => r.profession,
  currentWork: (r) => r.current_work,
  languages: (r) => r.languages,
  workEmail: (r) => r.work_email,
  phone: (r) => r.phone,
  algoritmiAvailability: (r) => r.algoritmi_availability,
};

/** Company and team must exist, be active when newly assigned, and match each other. */
function checkCompanyTeam(db: DB, before: EmployeeRow | null, companyId: number | null, teamId: number | null): void {
  if (companyId != null) {
    const c = one<{ active: number }>(db, 'SELECT active FROM companies WHERE id = ?', companyId);
    if (!c) throw badRequest('company_not_found', 'Company not found');
    if (!c.active && Number(before?.company_id) !== companyId) throw badRequest('company_inactive', 'This company is deactivated');
  }
  if (teamId != null) {
    const t = one<{ company_id: number; active: number }>(db, 'SELECT company_id, active FROM teams WHERE id = ?', teamId);
    if (!t) throw badRequest('team_not_found', 'Team not found');
    if (!t.active && Number(before?.team_id) !== teamId) throw badRequest('team_inactive', 'This team is deactivated');
    if (companyId == null || Number(t.company_id) !== companyId) throw badRequest('team_company_mismatch', 'The team belongs to another company');
  }
}

function toDbValue(field: EmployeeField, value: unknown): string | number | null {
  if (field === 'languages') return JSON.stringify(value ?? []);
  if (value === undefined || value === null) return field === 'officialTitle' || field === 'profession' || field === 'currentWork' ? '' : null;
  return value as string | number;
}

export function registerEmployeeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, limits } = ctx;

  /** Shared by PATCH /api/employees/:id and PATCH /api/me/profile. */
  function updateEmployee(req: FastifyRequest, id: number): EmployeeDto {
    const user = req.user!;
    const before = getEmployeeRow(db, id);
    if (!before || (before.status !== 'active' && !canSeeInactive(user))) throw notFound();
    const body = plainObject(req.body);
    const keys = Object.keys(body);
    const unknown = keys.filter((k) => !(EMPLOYEE_FIELDS as readonly string[]).includes(k));
    if (unknown.length) throw badRequest('unknown_fields', 'Unknown fields', { fields: unknown });
    const allowed = editableFields(user, id);
    const denied = keys.filter((k) => !(allowed as string[]).includes(k));
    if (denied.length) {
      audit(db, actorOf(req), 'employee.change_denied', { type: 'employee', id }, { fields: denied }, req.ip);
      throw forbidden('forbidden_fields', 'You are not allowed to change these fields', { forbiddenFields: denied });
    }
    const patch: EmployeePatch = employeePatch.parse(body);
    const fields = Object.keys(patch) as EmployeeField[];
    if (!fields.length) return toEmployeeDto(before);

    tx(db, () => {
      const companyId = 'companyId' in patch ? (patch.companyId ?? null) : before.company_id == null ? null : Number(before.company_id);
      let teamId = 'teamId' in patch ? (patch.teamId ?? null) : before.team_id == null ? null : Number(before.team_id);
      // Moving someone to another company without naming a team clears the old team.
      if ('companyId' in patch && !('teamId' in patch) && teamId != null) {
        const t = one<{ company_id: number }>(db, 'SELECT company_id FROM teams WHERE id = ?', teamId);
        if (!t || Number(t.company_id) !== companyId) {
          teamId = null;
          (patch as Record<string, unknown>).teamId = null;
          if (!fields.includes('teamId')) fields.push('teamId');
        }
      }
      if (fields.some((f) => f === 'companyId' || f === 'teamId')) checkCompanyTeam(db, before, companyId, teamId);
      const sets = fields.map((f) => `${COLUMN[f]} = ?`);
      const values = fields.map((f) => toDbValue(f, (patch as Record<string, unknown>)[f]));
      run(db, `UPDATE employees SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`, ...values, nowIso(), user.id, id);

      const after = getEmployeeRow(db, id)!;
      const official: Record<string, { from: unknown; to: unknown }> = {};
      const personal: string[] = [];
      for (const f of fields) {
        const from = ROW_VALUE[f](before);
        const to = ROW_VALUE[f](after);
        if (JSON.stringify(from) === JSON.stringify(to)) continue;
        if ((OFFICIAL_FIELDS as readonly string[]).includes(f) || (IDENTITY_FIELDS as readonly string[]).includes(f)) official[f] = { from, to };
        else personal.push(f);
      }
      if (official.companyId) official.companyId = { from: before.company_name, to: after.company_name };
      if (official.teamId) official.teamId = { from: before.team_name, to: after.team_name };
      if (Object.keys(official).length) audit(db, actorOf(req), 'employee.official_changed', { type: 'employee', id }, { changes: official }, req.ip);
      // Personal fields: only which fields changed, not their contents.
      if (personal.length) audit(db, actorOf(req), 'employee.profile_updated', { type: 'employee', id }, { fields: personal }, req.ip);
    });
    return toEmployeeDto(getEmployeeRow(db, id)!);
  }

  app.patch('/api/employees/:id', async (req) => updateEmployee(req, parseId((req.params as { id: string }).id)));

  app.patch('/api/me/profile', async (req) => {
    if (req.user!.employeeId == null) throw notFound('no_profile', 'Your account has no employee profile');
    return updateEmployee(req, req.user!.employeeId);
  });

  app.post('/api/employees', { config: { roles: ['admin', 'coordinator'] } }, async (req, reply) => {
    const data = employeeCreate.parse(req.body);
    const id = tx(db, () => {
      const companyId = data.companyId ?? null;
      const teamId = data.teamId ?? null;
      checkCompanyTeam(db, null, companyId, teamId);
      const now = nowIso();
      const r = run(
        db,
        `INSERT INTO employees (first_name, last_name, company_id, team_id, official_title, profession, current_work, languages,
                                work_email, phone, algoritmi_availability, status, is_demo, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
        data.firstName,
        data.lastName,
        companyId,
        teamId,
        data.officialTitle ?? '',
        data.profession ?? '',
        data.currentWork ?? '',
        JSON.stringify(data.languages ?? []),
        data.workEmail ?? null,
        data.phone ?? null,
        data.algoritmiAvailability ?? null,
        now,
        now,
        req.user!.id,
      );
      const row = getEmployeeRow(db, r.lastInsertRowid)!;
      audit(
        db,
        actorOf(req),
        'employee.created',
        { type: 'employee', id: r.lastInsertRowid },
        { name: fullName(row), company: row.company_name, team: row.team_name, officialTitle: row.official_title, algoritmiAvailability: row.algoritmi_availability },
        req.ip,
      );
      return r.lastInsertRowid;
    });
    reply.code(201);
    return toEmployeeDto(getEmployeeRow(db, id)!);
  });

  app.get('/api/manage/employees', { config: { roles: ['admin', 'coordinator'] } }, async (): Promise<ManagedEmployeeDto[]> => listManagedEmployees(db));

  // Camera selfie of the signed-in person. There is deliberately no route that
  // accepts a photo for somebody else.
  app.put('/api/me/photo', { bodyLimit: config.maxPhotoBytes }, async (req) => {
    const user = req.user!;
    if (user.employeeId == null) throw notFound('no_profile', 'Your account has no employee profile');
    if (!canUploadPhoto(user, user.employeeId)) throw forbidden();
    if (!Buffer.isBuffer(req.body)) throw badRequest('photo_not_jpeg', 'The photo must be sent as image/jpeg');
    const key = `user:${user.id}`;
    const wait = limits.photo.retryAfter(key);
    if (wait) throw tooMany(wait);
    limits.photo.hit(key);
    const row = getEmployeeRow(db, user.employeeId);
    if (!row || row.status !== 'active') throw notFound();
    const jpegData = processPhoto(req.body);
    const photoId = storePhoto(config.photosDir, jpegData);
    const now = nowIso();
    run(db, 'UPDATE employees SET photo_id = ?, photo_updated_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', photoId, now, now, user.id, user.employeeId);
    audit(db, actorOf(req), 'employee.photo_updated', { type: 'employee', id: user.employeeId }, { replaced: !!row.photo_id }, req.ip);
    return toEmployeeDto(getEmployeeRow(db, user.employeeId)!);
  });

  app.delete('/api/employees/:id/photo', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = getEmployeeRow(db, id);
    if (!row || (row.status !== 'active' && !canSeeInactive(req.user!))) throw notFound();
    if (!canRemovePhoto(req.user!, id)) throw forbidden();
    if (row.photo_id) {
      const now = nowIso();
      run(db, 'UPDATE employees SET photo_id = NULL, photo_updated_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', now, now, req.user!.id, id);
      audit(db, actorOf(req), 'employee.photo_removed', { type: 'employee', id }, {}, req.ip);
    }
    return toEmployeeDto(getEmployeeRow(db, id)!);
  });

  app.post('/api/employees/:id/deactivate', { config: { roles: ['admin'] } }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    if (req.user!.employeeId === id) throw conflict('cannot_deactivate_self', 'You cannot deactivate your own profile');
    const row = getEmployeeRow(db, id);
    if (!row) throw notFound();
    const result = tx(db, () => {
      run(db, "UPDATE employees SET status = 'inactive', updated_at = ?, updated_by = ? WHERE id = ?", nowIso(), req.user!.id, id);
      const linked = one<{ id: number; role: string }>(db, 'SELECT id, role FROM users WHERE employee_id = ?', id);
      let sessions = 0;
      if (linked) {
        if (linked.role === 'admin' && Number(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?", linked.id)?.n ?? 0) === 0) {
          throw conflict('last_admin', 'This would disable the last administrator');
        }
        run(db, "UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", nowIso(), linked.id);
        sessions = revokeUserSessions(db, Number(linked.id));
      }
      const invites = revokeInvitesFor(db, { employeeId: id, userId: linked ? Number(linked.id) : null }, req.user!.id);
      audit(db, actorOf(req), 'employee.deactivated', { type: 'employee', id }, { name: fullName(row), userDisabled: !!linked, sessionsRevoked: sessions, invitesRevoked: invites }, req.ip);
      return { sessions, invites };
    });
    return { ok: true, ...result };
  });

  app.post('/api/employees/:id/activate', { config: { roles: ['admin'] } }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = getEmployeeRow(db, id);
    if (!row) throw notFound();
    tx(db, () => {
      run(db, "UPDATE employees SET status = 'active', updated_at = ?, updated_by = ? WHERE id = ?", nowIso(), req.user!.id, id);
      run(db, "UPDATE users SET status = 'active', updated_at = ? WHERE employee_id = ? AND role = 'employee'", nowIso(), id);
      audit(db, actorOf(req), 'employee.activated', { type: 'employee', id }, { name: fullName(row) }, req.ip);
    });
    return toEmployeeDto(getEmployeeRow(db, id)!);
  });

  // Permanent removal (e.g. on request of the person). The linked account is
  // disabled and unlinked; the photo file is removed by the hourly clean-up.
  app.delete('/api/employees/:id', { config: { roles: ['admin'] } }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    if (req.user!.employeeId === id) throw conflict('cannot_delete_self', 'You cannot delete your own profile');
    const row = getEmployeeRow(db, id);
    if (!row) throw notFound();
    tx(db, () => {
      const linked = one<{ id: number; role: string }>(db, 'SELECT id, role FROM users WHERE employee_id = ?', id);
      if (linked) {
        if (linked.role === 'admin') throw conflict('linked_admin', 'Change the role of the linked administrator account first');
        run(db, "UPDATE users SET status = 'disabled', employee_id = NULL, updated_at = ? WHERE id = ?", nowIso(), linked.id);
        revokeUserSessions(db, Number(linked.id));
        revokeInvitesFor(db, { userId: Number(linked.id) }, req.user!.id);
      }
      run(db, 'DELETE FROM employees WHERE id = ?', id);
      audit(db, actorOf(req), 'employee.deleted', { type: 'employee', id }, { linkedUserDisabled: !!linked }, req.ip);
    });
    return { ok: true };
  });
}
