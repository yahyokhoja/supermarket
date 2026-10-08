import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  message: string;
  keyPrefix?: string;
  skip?: (req: Request) => boolean;
};

type SecurityCorsOptions = {
  allowlist: string[];
};

type CounterEntry = {
  count: number;
  resetAt: number;
};

function normalizeOrigin(origin: string) {
  return origin.trim().toLowerCase().replace(/\/$/, '');
}

function parseAllowlist(allowlist: string[]) {
  const defaults = [
    'http://localhost:5173',
    'https://localhost:5173',
    'http://127.0.0.1:5173',
    'https://127.0.0.1:5173'
  ];

  const source = allowlist.length ? allowlist : defaults;
  return new Set(source.map(normalizeOrigin));
}

export function createCorsMiddleware(options: SecurityCorsOptions) {
  const allowedOrigins = parseAllowlist(options.allowlist);

  return cors({
    origin: (origin, callback) => {
      // Non-browser clients may not send origin (curl/mobile apps).
      if (!origin) return callback(null, true);

      const normalized = normalizeOrigin(origin);
      if (allowedOrigins.has(normalized)) {
        return callback(null, true);
      }

      return callback(new Error('CORS origin is not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Webhook-Signature', 'X-Idempotency-Key'],
    maxAge: 600
  });
}

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader('X-XSS-Protection', '0');

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (req.secure || forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

export function createIpRateLimiter(options: RateLimitOptions) {
  const keyPrefix = options.keyPrefix || 'global';
  const counters = new Map<string, CounterEntry>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (options.skip?.(req)) {
      return next();
    }

    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = `${keyPrefix}:${ip}`;

    const previous = counters.get(key);
    if (!previous || previous.resetAt <= now) {
      counters.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    previous.count += 1;
    if (previous.count <= options.max) {
      return next();
    }

    const retryAfterSec = Math.max(1, Math.ceil((previous.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      message: options.message,
      retryAfterSec
    });
  };
}

export function parseCorsAllowlist(value: string | undefined) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
