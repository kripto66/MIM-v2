import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE = 'mim_csrf';
const CSRF_HEADER = 'x-csrf-token';

function configuredOrigins() {
  return String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return null;
  return `${req.protocol}://${host}`;
}

function originAllowed(req, value) {
  if (!value) return false;
  const origins = new Set(configuredOrigins());
  const current = requestOrigin(req);
  if (current) origins.add(current);
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try { origins.add(new URL(appUrl).origin); } catch {}
  }
  return origins.has(value);
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function ensureToken(req, res) {
  const current = req.cookies?.[CSRF_COOKIE];
  if (validToken(current)) return current;
  const token = generateCsrfToken();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

function equalToken(left, right) {
  if (!validToken(left) || !validToken(right)) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function csrfOriginGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    ensureToken(req, res);
    return next();
  }

  const hasAuthCookie = Boolean(req.cookies?.mim_token);
  const origin = req.get('origin');
  const referer = req.get('referer');
  const refererOrigin = referer ? (() => { try { return new URL(referer).origin; } catch { return null; } })() : null;

  if (origin && !originAllowed(req, origin)) {
    return res.status(403).json({ success: false, code: 'CSRF_REJECTED', message: 'Origine de requête refusée.' });
  }
  if (!origin && refererOrigin && !originAllowed(req, refererOrigin)) {
    return res.status(403).json({ success: false, code: 'CSRF_REJECTED', message: 'Origine de requête refusée.' });
  }

  if (hasAuthCookie) {
    if (!origin && !refererOrigin) {
      return res.status(403).json({ success: false, code: 'CSRF_REJECTED', message: 'Origine de requête refusée.' });
    }
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.get(CSRF_HEADER);
    if (!equalToken(cookieToken, headerToken)) {
      return res.status(403).json({ success: false, code: 'CSRF_REJECTED', message: 'Jeton CSRF invalide.' });
    }
  }

  ensureToken(req, res);
  return next();
}

export function validateCsrfToken(req, res, next) {
  return csrfOriginGuard(req, res, next);
}

export function csrfInitRoute(req, res) {
  const token = ensureToken(req, res);
  res.json({ success: true, csrfToken: token });
}
