// Constants shared by the server and the web client. No Node or DOM APIs here.

export const ROLES = ['admin', 'coordinator', 'employee', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const AVAILABILITY = ['yes', 'partial', 'no'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/** ISO 639-1 codes offered in the language picker and the directory filter. */
export const LANGUAGE_CODES = [
  'en', 'ru', 'kk', 'it', 'de', 'fr', 'rm', 'es', 'pt', 'tr',
  'uz', 'ky', 'zh', 'ar', 'uk', 'pl', 'ja', 'ko',
] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

/** Fields an employee may change in their own profile. */
export const SELF_FIELDS = ['profession', 'currentWork', 'languages', 'workEmail', 'phone'] as const;
/** Official fields: coordinators and administrators only. */
export const OFFICIAL_FIELDS = ['companyId', 'teamId', 'officialTitle', 'algoritmiAvailability'] as const;
/** Name fields: set by coordinators and administrators. */
export const IDENTITY_FIELDS = ['firstName', 'lastName'] as const;
export const EMPLOYEE_FIELDS = [...IDENTITY_FIELDS, ...OFFICIAL_FIELDS, ...SELF_FIELDS] as const;
export type EmployeeField = (typeof EMPLOYEE_FIELDS)[number];

/** What counts towards the profile completeness indicator. Contacts are optional. */
export const COMPLETENESS_ITEMS = [
  'photo', 'officialTitle', 'company', 'team', 'profession', 'currentWork', 'languages', 'availability',
] as const;
export type CompletenessItem = (typeof COMPLETENESS_ITEMS)[number];

export const LIMITS = {
  name: 80,
  title: 120,
  profession: 120,
  currentWork: 1000,
  email: 254,
  phone: 40,
  languages: 12,
  companyName: 80,
  teamName: 80,
  username: 40,
  displayName: 80,
  passwordMin: 8,
  passwordMax: 256,
  siteTitle: 60,
  privacyContact: 200,
} as const;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** Header that unauthenticated state-changing requests must carry (CSRF defence). */
export const REQUESTED_WITH_HEADER = 'x-requested-with';
export const REQUESTED_WITH_VALUE = 'team-kz';
export const CSRF_HEADER = 'x-csrf-token';
