import { z } from 'zod';
import { AVAILABILITY, LANGUAGE_CODES, LIMITS, LOCALES, ROLES } from '../shared/constants.js';
import { badRequest } from './errors.js';

// Control characters are removed from all text; only multi-line fields keep \n.
const stripControls = (s: string, multiline: boolean) =>
  s.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n');

export const text = (max: number, opts: { multiline?: boolean; min?: number } = {}) =>
  z
    .string()
    .transform((s) => stripControls(s, !!opts.multiline).trim())
    .pipe(z.string().min(opts.min ?? 0).max(max));

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()./-]{5,40}$/;

/** Optional contact: empty string or null are stored as NULL. */
const optional = (inner: z.ZodType<string, string>) =>
  z
    .union([z.string(), z.null()])
    .transform((v) => (v == null ? '' : v.trim()))
    .pipe(z.union([z.literal(''), inner]))
    .transform((v) => (v === '' ? null : v));

export const emailField = optional(
  z
    .string()
    .max(LIMITS.email)
    .regex(EMAIL_RE, 'Invalid email')
    .transform((v) => v.toLowerCase()),
);
export const phoneField = optional(
  z
    .string()
    .max(LIMITS.phone)
    .regex(PHONE_RE, 'Invalid phone number')
    .transform((v) => v.replace(/\s+/g, ' ')),
);

export const employeeFields = z
  .object({
    firstName: text(LIMITS.name, { min: 1 }),
    lastName: text(LIMITS.name, { min: 1 }),
    companyId: z.number().int().positive().nullable(),
    teamId: z.number().int().positive().nullable(),
    officialTitle: text(LIMITS.title),
    profession: text(LIMITS.profession),
    currentWork: text(LIMITS.currentWork, { multiline: true }),
    languages: z
      .array(z.enum(LANGUAGE_CODES))
      .max(LIMITS.languages)
      .transform((l) => [...new Set(l)]),
    workEmail: emailField,
    phone: phoneField,
    algoritmiAvailability: z.enum(AVAILABILITY).nullable(),
  })
  .strict();

export const employeePatch = employeeFields.partial().strict();
export const employeeCreate = employeeFields.partial().required({ firstName: true, lastName: true }).strict();
export type EmployeePatch = z.infer<typeof employeePatch>;

export const loginBody = z.object({ username: z.string().max(200), password: z.string().max(1000) }).strict();
export const tokenBody = z.object({ token: z.string().min(1).max(200) }).strict();
export const acceptBody = z
  .object({
    token: z.string().min(1).max(200),
    username: z.string().max(100).optional(),
    displayName: text(LIMITS.displayName).optional(),
    password: z.string().max(1000),
  })
  .strict();
export const passwordChangeBody = z.object({ currentPassword: z.string().max(1000), newPassword: z.string().max(1000) }).strict();
export const localeBody = z.object({ locale: z.enum(LOCALES) }).strict();

export const companyCreate = z.object({ name: text(LIMITS.companyName, { min: 1 }), sortOrder: z.number().int().min(0).max(10000).optional() }).strict();
export const companyPatch = z
  .object({ name: text(LIMITS.companyName, { min: 1 }), sortOrder: z.number().int().min(0).max(10000), active: z.boolean() })
  .partial()
  .strict();
export const teamCreate = z
  .object({ companyId: z.number().int().positive(), name: text(LIMITS.teamName, { min: 1 }), sortOrder: z.number().int().min(0).max(10000).optional() })
  .strict();
export const teamPatch = z
  .object({ name: text(LIMITS.teamName, { min: 1 }), sortOrder: z.number().int().min(0).max(10000), active: z.boolean() })
  .partial()
  .strict();

export const adminInviteBody = z
  .object({
    role: z.enum(ROLES),
    displayName: text(LIMITS.displayName).optional(),
    employeeId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const userPatch = z
  .object({
    role: z.enum(ROLES),
    status: z.enum(['active', 'disabled']),
    displayName: text(LIMITS.displayName, { min: 1 }),
    employeeId: z.number().int().positive().nullable(),
  })
  .partial()
  .strict();

export function parseId(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest('invalid_id', 'Invalid id');
  return n;
}

export function plainObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('invalid_body', 'A JSON object is expected');
  return body as Record<string, unknown>;
}
