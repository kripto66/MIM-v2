import jwt from 'jsonwebtoken';
import { supabase } from '../app.js';

const SLIDING_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function setAuthCookie(res, token) {
  res.cookie('mim_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SLIDING_MAX_AGE,
  });
}

export async function authenticate(req, res, next) {
  const token =
    req.cookies?.mim_token || req.headers?.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, message: 'Non authentifié.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session expirée.' });
  }

  // Session glissante : renouvelle le cookie et rafraîchit le jeton
  // Supabase avant son expiration, pour ne jamais déconnecter un
  // utilisateur actif tant qu'il ne se déconnecte pas explicitement.
  try {
    const now = Math.floor(Date.now() / 1000);
    const nearExpiry = decoded.supabase_expires_at && decoded.supabase_expires_at < now + 300;

    if (nearExpiry && decoded.refresh_token) {
      const { data, error } = await supabase.auth.refreshSession({
        refresh_token: decoded.refresh_token,
      });

      if (!error && data?.session) {
        decoded = {
          ...decoded,
          supabase_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          supabase_expires_at: data.session.expires_at,
        };
      } else {
        console.warn('[auth] refresh jeton Supabase échec :', error?.message);
      }
    }

    setAuthCookie(res, signToken(decoded));
  } catch (err) {
    console.warn('[auth] refresh session échec :', err.message);
  }

  req.user = decoded;
  next();
}

export function signToken(payload, expiresIn = '7d') {
  const clean = { ...payload };
  delete clean.iat;
  delete clean.exp;
  delete clean.nbf;
  delete clean.jti;
  return jwt.sign(clean, process.env.JWT_SECRET, { expiresIn });
}
