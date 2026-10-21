import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { CSRF_HEADER, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, type Role } from '../shared/constants.js';
import type { Actor } from './audit.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { RateLimiter } from './ratelimit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDirectoryRoutes } from './routes/directory.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import { registerInviteRoutes } from './routes/invites.js';
import { safeEqual } from './security.js';
import { cookieName, loadSession, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    /** 'public' = reachable without a session. Everything else requires one. */
    auth?: 'public';
    roles?: Role[];
  }
}

export interface AppContext {
  config: Config;
  db: DB;
  limits: {
    loginIp: RateLimiter;
    loginUser: RateLimiter;
    invite: RateLimiter;
    photo: RateLimiter;
  };
}

export function createLimits(): AppContext['limits'] {
  const m15 = 15 * 60_000;
  return {
    loginIp: new RateLimiter(30, m15),
    loginUser: new RateLimiter(8, m15),
    invite: new RateLimiter(40, m15),
    photo: new RateLimiter(20, 60 * 60_000),
  };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

export function actorOf(req: FastifyRequest): Actor {
  return req.user ? { id: req.user.id, label: `${req.user.displayName} (${req.user.username})` } : { id: null, label: 'anonymous' };
}

const pathOf = (url: string) => url.split('?')[0] ?? url;

const errorBody = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config, db } = ctx;
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
              censor: '[redacted]',
            },
            // Only method, path and status are logged: never bodies, cookies or query strings.
            serializers: {
              req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: pathOf(req.url ?? ''), ip: req.ip }),
              res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
            },
          },
    trustProxy: config.trustProxy === false ? false : config.trustProxy,
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
    requestIdHeader: false,
  });

  await app.register(cookie);
  app.decorateRequest('user', null);

  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: config.maxPhotoBytes }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    const p = pathOf(req.url);
    // Host check against DNS rebinding and wrong virtual hosts. The container
    // healthcheck calls /api/health on 127.0.0.1, so it is exempt.
    const host = (req.headers.host ?? '').toLowerCase();
    if (p !== '/api/health' && !config.allowedHosts.has(host)) {
      return reply.code(421).send(errorBody('wrong_host', 'Unknown host name'));
    }
    // No CORS: requests from any other origin are refused outright.
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.has(origin)) {
      return reply.code(403).send(errorBody('origin_not_allowed', 'Cross-origin requests are not allowed'));
    }
    if (p.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send(errorBody('origin_not_allowed', 'Cross-origin requests are not allowed'));
    }
    if (p.startsWith('/api/')) {
      req.user = loadSession(db, config, req.cookies[cookieName(config)]);
    }
  });

  // Secure by default: every /api route needs a session unless it is marked
  // public; state-changing requests need the per-session CSRF token.
  app.addHook('preHandler', async (req) => {
    if (!pathOf(req.url).startsWith('/api/')) return;
    const routeConfig = req.routeOptions.config;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (routeConfig.auth === 'public') {
      if (mutating && req.headers[REQUESTED_WITH_HEADER] !== REQUESTED_WITH_VALUE) {
        throw forbidden('csrf_failed', 'Missing request header');
      }
      return;
    }
    if (!req.user) throw unauthorized();
    if (mutating) {
      const token = req.headers[CSRF_HEADER];
      if (typeof token !== 'string' || !safeEqual(token, req.user.csrfToken)) {
        throw forbidden('csrf_failed', 'Security token missing or expired. Reload the page.');
      }
    }
    if (routeConfig.roles && !routeConfig.roles.includes(req.user.role)) throw forbidden();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('Content-Security-Policy', CSP);
    if (config.baseUrl.protocol === 'https:') reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (pathOf(req.url).startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      if (typeof err.extra.retryAfter === 'number') reply.header('Retry-After', String(err.extra.retryAfter));
      return reply.code(err.status).send(errorBody(err.code, err.message, err.extra));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send(
        errorBody('validation', 'Invalid input', { fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }),
      );
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code =
        status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : (err as FastifyError).code?.includes('JSON') ? 'invalid_json' : 'bad_request';
      return reply.code(status).send(errorBody(code, status === 413 ? 'Request is too large' : 'Bad request'));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('internal', 'Internal error'));
  });

  registerAuthRoutes(app, ctx);
  registerDirectoryRoutes(app, ctx);
  registerEmployeeRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  const hasWeb = existsSync(path.join(config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      index: false,
      wildcard: true,
      dotfiles: 'deny',
      cacheControl: false,
      setHeaders(res, filePath) {
        const immutable = filePath.split(/[\\/]/).includes('assets');
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  // The client app shell for "/" and every client-side route (/people/3, /me, ...).
  const sendShell = async (reply: FastifyReply) => {
    if (!hasWeb) return reply.code(503).type('text/plain; charset=utf-8').send('Web client is not built (npm run build).');
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  };
  app.get('/', async (_req, reply) => sendShell(reply));

  app.setNotFoundHandler(async (req, reply) => {
    const p = pathOf(req.url);
    if (p.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return reply.code(404).send(errorBody('not_found', 'Not found'));
    }
    return sendShell(reply);
  });

  return app;
}
