import { EMPLOYEE_FIELDS, SELF_FIELDS, type EmployeeField, type Role } from '../shared/constants.js';

export interface Principal {
  id: number;
  role: Role;
  employeeId: number | null;
}

export const canManageEmployees = (p: Principal): boolean => p.role === 'admin' || p.role === 'coordinator';
export const isAdmin = (p: Principal): boolean => p.role === 'admin';

/**
 * Which employee fields this principal may change on this employee record.
 * - administrators and coordinators: every field of every employee;
 * - anyone linked to the record (their own profile): profession, current
 *   work, languages and contacts only — never official fields or the name;
 * - everyone else (viewers, other employees): nothing.
 */
export function editableFields(p: Principal, employeeId: number): EmployeeField[] {
  if (canManageEmployees(p)) return [...EMPLOYEE_FIELDS];
  if (p.employeeId != null && p.employeeId === employeeId) return [...SELF_FIELDS];
  return [];
}

export const canSeeInactive = canManageEmployees;

/** Only the person themself takes or replaces their photo (camera only). */
export const canUploadPhoto = (p: Principal, employeeId: number): boolean => p.employeeId === employeeId;

export const canRemovePhoto = (p: Principal, employeeId: number): boolean => canManageEmployees(p) || p.employeeId === employeeId;
