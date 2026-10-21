import type { AuditEntryDto } from '../shared/types.js';
import { all, nowIso, run, type DB } from './db.js';

export interface Actor {
  id: number | null;
  label: string;
}

export const SYSTEM_ACTOR: Actor = { id: null, label: 'system' };
export const CLI_ACTOR: Actor = { id: null, label: 'cli (NAS administrator)' };

/**
 * Writes one audit entry. details must never contain passwords, tokens or
 * links; for personal fields only the field names are recorded.
 */
export function audit(
  db: DB,
  actor: Actor,
  action: string,
  entity: { type?: string; id?: number | string | null } = {},
  details: Record<string, unknown> = {},
  ip: string | null = null,
): void {
  run(
    db,
    'INSERT INTO audit_log (at, actor_user_id, actor_label, action, entity_type, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    nowIso(),
    actor.id,
    actor.label,
    action,
    entity.type ?? null,
    entity.id == null ? null : String(entity.id),
    JSON.stringify(details),
    ip,
  );
}

export function listAudit(db: DB, opts: { before?: number; action?: string; limit: number }): AuditEntryDto[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.before) {
    where.push('id < ?');
    params.push(opts.before);
  }
  if (opts.action) {
    where.push("action LIKE ? ESCAPE '\\'");
    params.push(`${opts.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  params.push(opts.limit);
  return all<Record<string, unknown>>(db, sql, ...params).map((r) => ({
    id: Number(r.id),
    at: String(r.at),
    actor: String(r.actor_label),
    action: String(r.action),
    entityType: (r.entity_type as string | null) ?? null,
    entityId: (r.entity_id as string | null) ?? null,
    details: safeJson(String(r.details)),
    ip: (r.ip as string | null) ?? null,
  }));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
