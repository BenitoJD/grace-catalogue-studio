// HTTP plumbing shared by every route: request ids, access logs, security
// headers, CORS allowlisting, body limits, rate limiting and the one error
// handler. Keeping it in one place means every response (success, error, 404,
// preflight, 413, 429) gets the same headers and one log line.

import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';

import { createLogger } from './logger.mjs';
import { RenderError } from './render.mjs';

export const BODY_LIMIT_BYTES = 64 * 1024;
// Image uploads are the one route that legitimately carries a large body.
export const UPLOAD_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const uploadBodyLimit = bodyLimit({
  maxSize: UPLOAD_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `The image is too large. The limit is ${UPLOAD_BODY_LIMIT_BYTES / (1024 * 1024)} MB.`,
        requestId: c.get('requestId'),
      },
      413,
    ),
});
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RENDER_ROUTE_PATTERN = /^\/api\/(?:orders\/[^/]+|catalogue)\/render\/?$/;
// Note and brochure copy drafting call a paid model, so they get their own
// generous limit instead of eating the much smaller render budget.
export const NOTE_ROUTE_PATTERN = /^\/api\/orders\/[^/]+\/note\/?$/;
export const COPY_ROUTE_PATTERN = /^\/api\/orders\/[^/]+\/copy\/?$/;

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const CORS_ALLOW_METHODS = 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS';
const CORS_DEFAULT_ALLOW_HEADERS = 'Content-Type,X-Request-Id';
const CORS_MAX_AGE_SECONDS = '86400';

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

// The first X-Forwarded-For entry is the original client when a reverse proxy
// sits in front; the socket peer is the fallback for direct access. A caller
// that can reach the API directly can spoof the header, so the API should be
// deployed behind a proxy that overwrites it.
export function clientIp(c) {
  const forwarded = c.req.header('x-forwarded-for');
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    const info = getConnInfo(c);
    const address = info?.remote?.address;
    if (address) return address;
  } catch {
    // Adapters without connection info (for example app.request in tests).
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Fixed window rate limiter
// ---------------------------------------------------------------------------

/**
 * In memory fixed window limiter. One bucket per key (client IP), reset every
 * `windowMs`. Small internal tool: no shared store is needed.
 */
export function createFixedWindowLimiter({
  limit,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now = Date.now,
} = {}) {
  const buckets = new Map();

  function prune(currentTime) {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.start >= windowMs) buckets.delete(key);
    }
  }

  return {
    limit,
    hit(key) {
      const currentTime = now();
      let bucket = buckets.get(key);
      if (!bucket || currentTime - bucket.start >= windowMs) {
        bucket = { start: currentTime, count: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count <= limit) {
        return { allowed: true, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: 0 };
      }
      prune(currentTime);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + windowMs - currentTime) / 1000)),
      };
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export function isOriginAllowed(origins, origin) {
  if (typeof origin !== 'string' || origin === '') return false;
  if (origins.includes('*')) return true;
  return origins.includes(origin);
}

function appendVary(headers, value) {
  const current = headers.get('Vary');
  if (!current) {
    headers.set('Vary', value);
    return;
  }
  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) headers.set('Vary', `${current}, ${value}`);
}

function applyCorsHeaders(c, headers, corsOrigins) {
  const allowAll = corsOrigins.includes('*');
  const origin = c.req.header('origin');
  const allowed = isOriginAllowed(corsOrigins, origin);

  if (allowed) {
    headers.set('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    headers.set('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
    if (c.req.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
      const requested = c.req.header('access-control-request-headers');
      headers.set(
        'Access-Control-Allow-Headers',
        requested && requested.trim() ? requested.trim() : CORS_DEFAULT_ALLOW_HEADERS,
      );
      headers.set('Access-Control-Max-Age', CORS_MAX_AGE_SECONDS);
      appendVary(headers, 'Access-Control-Request-Headers');
    }
  }

  // A cache must not serve an allowlisted origin's response to another origin.
  if (!allowAll) appendVary(headers, 'Origin');
}

// ---------------------------------------------------------------------------
// Executable check used by GET /ready
// ---------------------------------------------------------------------------

export function isExecutable(bin) {
  if (typeof bin !== 'string' || bin.trim() === '') return false;
  const candidates = [];
  if (bin.includes('/') || bin.includes('\\')) {
    candidates.push(bin);
  } else {
    for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, bin));
    }
  }
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function statusForError(error) {
  if (error instanceof RenderError && Number.isInteger(error.status)) return error.status;
  if (error instanceof HTTPException && Number.isInteger(error.status)) return error.status;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  return 500;
}

/**
 * The single place that turns a thrown error into a client response. Never
 * leaks a stack trace; the stack is logged together with the request id.
 */
export function errorResponse(c, error, logger) {
  const requestId = c.get('requestId') ?? randomUUID();
  const status = statusForError(error);
  const method = c.req.method;
  const requestPath = c.req.path;

  let message;
  if (error instanceof RenderError) {
    message = error.message;
  } else if (error instanceof HTTPException) {
    message = error.message || 'Request failed.';
  } else if (status < 500 && typeof error?.message === 'string' && error.message.trim() !== '') {
    message = error.message;
  } else {
    message = 'The server hit an unexpected error.';
  }

  if (status >= 500) {
    logger.error('Request failed', {
      requestId,
      method,
      path: requestPath,
      status,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  const response = c.json({ error: message, requestId }, status);
  response.headers.set('X-Request-Id', requestId);
  return response;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Register the cross cutting middleware on a Hono app. Call before routes.
 *
 * Options:
 * - logger: logger from ./logger.mjs
 * - corsOrigins: array of allowed origins, or ["*"]
 * - rateLimitPerMin: general requests per minute per IP
 * - renderLimitPerMin: render requests per minute per IP
 * - noteLimitPerMin: note and copy drafting requests per minute per IP
 * - isShuttingDown(): while true, new work gets a 503
 */
export function installHttpHardening(app, options = {}) {
  const logger = options.logger ?? createLogger();
  const corsOrigins =
    Array.isArray(options.corsOrigins) && options.corsOrigins.length > 0
      ? options.corsOrigins
      : ['*'];
  const generalLimiter = createFixedWindowLimiter({ limit: options.rateLimitPerMin ?? 120 });
  const renderLimiter = createFixedWindowLimiter({ limit: options.renderLimitPerMin ?? 12 });
  // Mirrors the default in config.mjs; callers normally pass the parsed value.
  const noteLimiter = createFixedWindowLimiter({ limit: options.noteLimitPerMin ?? 30 });
  const isShuttingDown =
    typeof options.isShuttingDown === 'function' ? options.isShuttingDown : () => false;

  const lifecycle = async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    const startedAt = performance.now();

    try {
      if (c.req.method === 'OPTIONS') {
        // CORS preflight never reaches a route handler, even for unknown paths.
        c.res = new Response(null, { status: 204 });
      } else if (isShuttingDown()) {
        c.res = c.json({ error: 'The server is shutting down.', requestId }, 503);
      } else {
        await next();
      }
    } catch (error) {
      c.res = errorResponse(c, error, logger);
    }

    try {
      const response = c.res;
      const headers = response.headers;
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      headers.set('X-Request-Id', requestId);
      applyCorsHeaders(c, headers, corsOrigins);
      logger.request({
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
    } catch (finaliseError) {
      logger.error('Could not finalise the response', {
        requestId,
        error: finaliseError instanceof Error ? finaliseError.message : String(finaliseError),
      });
    }
  };

  app.use('*', lifecycle);

  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const ip = clientIp(c);
    const general = generalLimiter.hit(ip);
    if (!general.allowed) {
      return c.json(
        {
          error: `Too many requests. Try again in ${general.retryAfterSeconds} seconds.`,
          requestId: c.get('requestId'),
        },
        429,
        { 'Retry-After': String(general.retryAfterSeconds) },
      );
    }
    if (c.req.method === 'POST' && RENDER_ROUTE_PATTERN.test(c.req.path)) {
      const render = renderLimiter.hit(ip);
      if (!render.allowed) {
        return c.json(
          {
            error: `Too many render requests. Try again in ${render.retryAfterSeconds} seconds.`,
            requestId: c.get('requestId'),
          },
          429,
          { 'Retry-After': String(render.retryAfterSeconds) },
        );
      }
    }
    if (c.req.method === 'POST' && NOTE_ROUTE_PATTERN.test(c.req.path)) {
      const note = noteLimiter.hit(ip);
      if (!note.allowed) {
        return c.json(
          {
            error: `Too many note requests. Try again in ${note.retryAfterSeconds} seconds.`,
            requestId: c.get('requestId'),
          },
          429,
          { 'Retry-After': String(note.retryAfterSeconds) },
        );
      }
    }
    if (c.req.method === 'POST' && COPY_ROUTE_PATTERN.test(c.req.path)) {
      const copy = noteLimiter.hit(ip);
      if (!copy.allowed) {
        return c.json(
          {
            error: `Too many copy requests. Try again in ${copy.retryAfterSeconds} seconds.`,
            requestId: c.get('requestId'),
          },
          429,
          { 'Retry-After': String(copy.retryAfterSeconds) },
        );
      }
    }
    return next();
  });

  const defaultBodyLimit = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(
        {
          error: `Request body is too large. The limit is ${BODY_LIMIT_BYTES / 1024} KB.`,
          requestId: c.get('requestId'),
        },
        413,
      ),
  });
  // The upload route has its own larger cap and registers the middleware on the
  // route itself, so the default limit skips it.
  app.use('*', (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/media') return next();
    return defaultBodyLimit(c, next);
  });


  app.notFound((c) => c.json({ error: 'Not found.', requestId: c.get('requestId') ?? null }, 404));

  app.onError((error, c) => errorResponse(c, error, logger));

  return { logger, generalLimiter, renderLimiter, noteLimiter };
}
