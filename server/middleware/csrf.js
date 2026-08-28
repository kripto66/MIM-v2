import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const CSRF_SECRET = process.env.CSRF_SECRET || crypto.randomBytes(32).toString('base64');
const CSRF_EXPIRY = 15 * 60 * 1000; // 15 minutes

// Génère un token CSRF signé et le place dans un cookie.
export function generateCsrfToken(req, res) {
  const token = jwt.sign(
    { jti: crypto.randomBytes(8).toString('hex'), ts: Date.now() },
    CSRF_SECRET,
    { expiresIn: '15m' }
  );
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false, // accessible via document.cookie côté JS
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CSRF_EXPIRY / 1000,
  });
  return token;
}

// Valide le token CSRF envoyé via header ou champ de formulaire.
export function validateCsrfToken(req, res, next) {
  // Skip les requêtes de lecture (GET, HEAD, OPTIONS) — le SameSite
  // des cookies protège déjà ces cas. Le CSRF ne concerne que les mutations.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const cookieToken = req.cookies?.['XSRF-TOKEN'];
  const headerToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];
  const bodyToken = req.body?._csrf;

  const sent = headerToken || bodyToken;

  if (!cookieToken || !sent) {
    return res.status(403).json({ success: false, message: 'Token CSRF manquant.' });
  }

  try {
    const decoded = jwt.verify(sent, CSRF_SECRET);
    const cookieDecoded = jwt.verify(cookieToken, CSRF_SECRET);

    // Les deux tokens doivent être le même (pas de mélange cookies/headers)
    if (decoded.jti !== cookieDecoded.jti) {
      return res.status(403).json({ success: false, message: 'Token CSRF invalide.' });
    }

    // Vérifie l'ancienneté (double check : le JWT a déjà expiresIn)
    if (Date.now() - decoded.ts > CSRF_EXPIRY) {
      return res.status(403).json({ success: false, message: 'Token CSRF expiré.' });
    }
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token CSRF invalide.' });
  }

  next();
}

// Route GET pour initialiser le token CSRF (à appeler au chargement des pages).
export function csrfInitRoute(req, res) {
  const token = generateCsrfToken(req, res);
  res.json({ success: true, csrfToken: token });
}
