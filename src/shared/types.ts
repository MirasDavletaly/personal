// JSON shapes of the HTTP API, shared by the server and the web client.
import type { Availability, CompletenessItem, EmployeeField, Locale, Role } from './constants.js';

export interface SessionUserDto {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  employeeId: number | null;
  locale: Locale | null;
}

export interface SessionDto {
  user: SessionUserDto | null;
  csrfToken?: string;
  version?: string;
}

export interface MetaDto {
  siteTitle: string;
  defaultLocale: Locale;
  privacyContact: string;
}

export interface CompanyDto {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface TeamDto {
  id: number;
  companyId: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface EmployeeDto {
  id: number;
  firstName: string;
  lastName: string;
  companyId: number | null;
  companyName: string | null;
  teamId: number | null;
  teamName: string | null;
  officialTitle: string;
  profession: string;
  currentWork: string;
  languages: string[];
  workEmail: string | null;
  phone: string | null;
  algoritmiAvailability: Availability | null;
  photoUrl: string | null;
  status: 'active' | 'inactive';
  isDemo: boolean;
  updatedAt: string;
  completeness: number;
  missing: CompletenessItem[];
}

export interface DirectoryDto {
  companies: CompanyDto[];
  teams: TeamDto[];
  employees: EmployeeDto[];
}

export interface MeDto {
  user: SessionUserDto;
  employee: EmployeeDto | null;
  editableFields: EmployeeField[];
}

export type AccountState = 'active' | 'invited' | 'disabled' | 'none';

export interface ManagedEmployeeDto extends EmployeeDto {
  account: AccountState;
  userId: number | null;
  username: string | null;
  invite: { id: number; expiresAt: string } | null;
}

export interface InviteLinkDto {
  inviteId: number;
  link: string;
  expiresAt: string;
}

export interface InviteDto {
  id: number;
  kind: 'invite' | 'reset' | 'setup';
  role: Role;
  employeeId: number | null;
  employeeName: string | null;
  userId: number | null;
  displayName: string | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string;
}

export type InviteStatus = 'valid' | 'invalid' | 'expired' | 'used' | 'revoked';

export interface InviteInspectDto {
  status: InviteStatus;
  kind?: 'invite' | 'reset' | 'setup';
  role?: Role;
  name?: string | null;
  username?: string | null;
  needsUsername?: boolean;
  needsDisplayName?: boolean;
  expiresAt?: string;
}

export interface UserDto {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  employeeId: number | null;
  employeeName: string | null;
  hasPassword: boolean;
  activeSessions: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntryDto {
  id: number;
  at: string;
  actor: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}

export interface SettingsDto {
  siteTitle: string;
  inviteTtlHours: number;
  privacyContact: string;
  defaultLocale: Locale;
}

export interface BackupFileDto {
  name: string;
  size: number;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: { path: string; message: string }[];
    forbiddenFields?: string[];
    retryAfter?: number;
  };
}
