import { z } from 'zod';
import { LIMITS, LOCALES } from '../shared/constants.js';
import type { SettingsDto } from '../shared/types.js';
import type { Config } from './config.js';
import { all, nowIso, run, type DB } from './db.js';

export const settingsSchema = z
  .object({
    siteTitle: z.string().trim().min(1).max(LIMITS.siteTitle),
    inviteTtlHours: z.number().int().min(1).max(24 * 14),
    privacyContact: z.string().trim().max(LIMITS.privacyContact),
    defaultLocale: z.enum(LOCALES),
  })
  .strict();

export function getSettings(db: DB, config: Config): SettingsDto {
  const defaults: SettingsDto = {
    siteTitle: 'Team Kazakhstan',
    inviteTtlHours: config.inviteTtlHoursDefault,
    privacyContact: '',
    defaultLocale: 'en',
  };
  const stored: Record<string, unknown> = {};
  for (const row of all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings')) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore broken value, fall back to default */
    }
  }
  const merged = { ...defaults, ...stored };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

export function saveSettings(db: DB, values: SettingsDto): void {
  const now = nowIso();
  for (const [key, value] of Object.entries(values)) {
    run(
      db,
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      JSON.stringify(value),
      now,
    );
  }
}
