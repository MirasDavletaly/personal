import { COMPLETENESS_ITEMS, type Availability, type CompletenessItem } from '../shared/constants.js';
import type { CompanyDto, EmployeeDto, ManagedEmployeeDto, TeamDto } from '../shared/types.js';
import { all, one, type DB } from './db.js';

export interface EmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  company_id: number | null;
  company_name: string | null;
  team_id: number | null;
  team_name: string | null;
  official_title: string;
  profession: string;
  current_work: string;
  languages: string;
  work_email: string | null;
  phone: string | null;
  algoritmi_availability: Availability | null;
  photo_id: string | null;
  status: 'active' | 'inactive';
  is_demo: number;
  updated_at: string;
}

const EMPLOYEE_SELECT = `
  SELECT e.*, c.name AS company_name, t.name AS team_name
  FROM employees e
  LEFT JOIN companies c ON c.id = e.company_id
  LEFT JOIN teams t ON t.id = e.team_id`;

export function photoUrl(photoId: string | null): string | null {
  return photoId ? `/api/photos/${photoId}.jpg` : null;
}

export function parseLanguages(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function completenessOf(row: EmployeeRow): { completeness: number; missing: CompletenessItem[] } {
  const filled: Record<CompletenessItem, boolean> = {
    photo: !!row.photo_id,
    officialTitle: !!row.official_title.trim(),
    company: row.company_id != null,
    team: row.team_id != null,
    profession: !!row.profession.trim(),
    currentWork: !!row.current_work.trim(),
    languages: parseLanguages(row.languages).length > 0,
    availability: row.algoritmi_availability != null,
  };
  const missing = COMPLETENESS_ITEMS.filter((k) => !filled[k]);
  return { completeness: Math.round(((COMPLETENESS_ITEMS.length - missing.length) / COMPLETENESS_ITEMS.length) * 100), missing };
}

export function toEmployeeDto(row: EmployeeRow): EmployeeDto {
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    companyId: row.company_id == null ? null : Number(row.company_id),
    companyName: row.company_name,
    teamId: row.team_id == null ? null : Number(row.team_id),
    teamName: row.team_name,
    officialTitle: row.official_title,
    profession: row.profession,
    currentWork: row.current_work,
    languages: parseLanguages(row.languages),
    workEmail: row.work_email,
    phone: row.phone,
    algoritmiAvailability: row.algoritmi_availability,
    photoUrl: photoUrl(row.photo_id),
    status: row.status,
    isDemo: !!row.is_demo,
    updatedAt: row.updated_at,
    ...completenessOf(row),
  };
}

export function getEmployeeRow(db: DB, id: number): EmployeeRow | undefined {
  return one<EmployeeRow>(db, `${EMPLOYEE_SELECT} WHERE e.id = ?`, id);
}

export function listEmployeeRows(db: DB, opts: { includeInactive: boolean }): EmployeeRow[] {
  return all<EmployeeRow>(
    db,
    `${EMPLOYEE_SELECT} ${opts.includeInactive ? '' : "WHERE e.status = 'active'"} ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`,
  );
}

export function listManagedEmployees(db: DB): ManagedEmployeeDto[] {
  const rows = listEmployeeRows(db, { includeInactive: true });
  const users = all<{ id: number; username: string; status: string; employee_id: number; has_password: number }>(
    db,
    'SELECT id, username, status, employee_id, password_hash IS NOT NULL AS has_password FROM users WHERE employee_id IS NOT NULL',
  );
  const invites = all<{ id: number; employee_id: number; expires_at: string }>(
    db,
    `SELECT id, employee_id, expires_at FROM invites
     WHERE kind = 'invite' AND employee_id IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    new Date().toISOString(),
  );
  return rows.map((row) => {
    const user = users.find((u) => Number(u.employee_id) === Number(row.id));
    const invite = invites.find((i) => Number(i.employee_id) === Number(row.id));
    let account: ManagedEmployeeDto['account'] = 'none';
    if (user && user.status === 'disabled') account = 'disabled';
    else if (user && user.has_password) account = 'active';
    else if (invite) account = 'invited';
    return {
      ...toEmployeeDto(row),
      account,
      userId: user ? Number(user.id) : null,
      username: user?.username ?? null,
      invite: invite ? { id: Number(invite.id), expiresAt: invite.expires_at } : null,
    };
  });
}

interface CompanyRow {
  id: number;
  name: string;
  sort_order: number;
  active: number;
}
interface TeamRow extends CompanyRow {
  company_id: number;
}

export function listCompanies(db: DB): CompanyDto[] {
  return all<CompanyRow>(db, 'SELECT id, name, sort_order, active FROM companies ORDER BY sort_order, name COLLATE NOCASE').map((r) => ({
    id: Number(r.id),
    name: r.name,
    sortOrder: Number(r.sort_order),
    active: !!r.active,
  }));
}

export function listTeams(db: DB): TeamDto[] {
  return all<TeamRow>(db, 'SELECT id, company_id, name, sort_order, active FROM teams ORDER BY sort_order, name COLLATE NOCASE').map((r) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    name: r.name,
    sortOrder: Number(r.sort_order),
    active: !!r.active,
  }));
}

export function fullName(row: { first_name: string; last_name: string }): string {
  return `${row.first_name} ${row.last_name}`.trim();
}
