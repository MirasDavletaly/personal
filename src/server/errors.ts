/**
 * Errors with a stable machine-readable code. The web client translates the
 * code; the message is a short English fallback that never contains internals.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, extra?: Record<string, unknown>) => new AppError(400, code, message, extra);
export const unauthorized = (code = 'unauthorized', message = 'Sign-in required') => new AppError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'Not allowed', extra?: Record<string, unknown>) => new AppError(403, code, message, extra);
export const notFound = (code = 'not_found', message = 'Not found') => new AppError(404, code, message);
export const conflict = (code: string, message?: string) => new AppError(409, code, message);
export const gone = (code: string, message?: string) => new AppError(410, code, message);
export const tooMany = (retryAfter: number) => new AppError(429, 'rate_limited', 'Too many attempts, try again later', { retryAfter });
