import { CSRF_HEADER, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '../../shared/constants.js';
import type { ApiErrorBody } from '../../shared/types.js';
import type { T } from './i18n';
import type { StringKey } from './strings';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: ApiErrorBody['error'] | null,
  ) {
    super(code);
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token ?? '';
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<R>(method: Method, url: string, body?: unknown, opts: { blob?: Blob; quiet401?: boolean } = {}): Promise<R> {
  const headers: Record<string, string> = { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE, Accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  let payload: BodyInit | undefined;
  if (opts.blob) {
    headers['Content-Type'] = opts.blob.type || 'application/octet-stream';
    payload = opts.blob;
  } else if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', null);
  }
  if (res.status === 401 && !opts.quiet401) onUnauthorized?.();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? ((await res.json().catch(() => null)) as unknown) : null;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error ?? null;
    throw new ApiError(res.status, err?.code ?? (res.status >= 500 ? 'internal' : 'generic'), err);
  }
  return data as R;
}

/** Human-readable, translated message for any error. */
export function errorText(t: T, err: unknown, fieldLabel?: (f: string) => string): string {
  if (!(err instanceof ApiError)) return t('err.generic');
  const key = `err.${err.code}` as StringKey;
  if (err.code === 'rate_limited') return t('err.rate_limited', { minutes: Math.max(1, Math.ceil((err.body?.retryAfter ?? 60) / 60)) });
  if (err.code === 'forbidden_fields') {
    const fields = (err.body?.forbiddenFields ?? []).map((f) => (fieldLabel ? fieldLabel(f) : f)).join(', ');
    return t('err.forbidden_fields', { fields });
  }
  const text = t(key);
  return text === key ? t(err.status >= 500 ? 'err.internal' : 'err.generic') : text;
}

/** Field name -> first validation message from a 400 'validation' error. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'validation') return {};
  const map: Record<string, string> = {};
  for (const f of err.body?.fields ?? []) {
    const name = f.path.split('.')[0] ?? '';
    if (name && !map[name]) map[name] = f.message;
  }
  return map;
}
