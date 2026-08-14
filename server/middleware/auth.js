import jwt from 'jsonwebtoken';
import { supabase, serviceClient } from '../app.js';

const SLIDING_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PAGE_LOGIN_REDIRECT = '/PartPublic/connexion.html';

function setAuthCookie(res, token) {
  res.cookie('mim_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SLIDING_MAX_AGE,
  });
}

// Vérifie le jeton mim_token, rafraîchit la session Supabase si nécessaire,
// puis REVALIDE côté serveur à chaque requête :
//   * le rôle (profiles.account_type) : un changement de rôle prend effet
//     immédiatement, sans attendre l'expiration du cookie ;
//   * le statut du compte (GoTrue banned_until) : un compte suspendu,
//     banni ou supprimé perd aussitôt son accès.
// Retourne le payload décodé avec le rôle à jour, ou null.
async function verifyToken(req) {
  const token = req.cookies?.mim_token || req.headers?.authorization?.replace('Bearer ', '');

  if (!token) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
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
  } catch (err) {
    console.warn('[auth] refresh session échec :', err.message);
  }

  // Revalidation serveur (rôle + ban). En cas d'échec (compte supprimé,
  // profil absent, erreur) on refuse l'accès : comportement fail-closed.
  try {
    const sb = serviceClient();

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('account_type')
      .eq('id', decoded.id)
      .maybeSingle();

    if (profileError || !profile) return null;

    const { data: authUser } = await sb.auth.admin.getUserById(decoded.id).catch(() => ({ data: null }));
    if (!authUser?.user) return null;

    if (authUser.user.banned_until) {
      const bannedTs = new Date(authUser.user.banned_until).getTime();
      if (!Number.isNaN(bannedTs) && bannedTs > Date.now()) return null;
    }

    decoded.account_type = profile.account_type;
  } catch (err) {
    console.warn('[auth] revalidation échec :', err.message);
    return null;
  }

  return decoded;
}

export async function authenticate(req, res, next) {
  const decoded = await verifyToken(req);

  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Non authentifié.' });
  }

  req.user = decoded;
  setAuthCookie(res, signToken(decoded));
  next();
}

// Garde des pages statiques : redirige vers la page de connexion quand le
// visiteur n'est pas authentifié (un 401 JSON serait inadapté au HTML).
export function authenticatePage(redirectTo = PAGE_LOGIN_REDIRECT) {
  return async (req, res, next) => {
    const decoded = await verifyToken(req);

    if (!decoded) {
      return res.redirect(redirectTo);
    }

    req.user = decoded;
    setAuthCookie(res, signToken(decoded));
    next();
  };
}

export function signToken(payload, expiresIn = '7d') {
  const clean = { ...payload };
  delete clean.iat;
  delete clean.exp;
  delete clean.nbf;
  delete clean.jti;
  return jwt.sign(clean, process.env.JWT_SECRET, { expiresIn });
}

export function requireAdmin(req, res, next) {
  if (req.user?.account_type !== 'admin') {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
  }
  next();
}

// Restriction par rôle pour les endpoints API (403 JSON).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.account_type)) return next();
    return res.status(403).json({ success: false, message: 'Accès non autorisé.' });
  };
}

// Restriction par rôle pour les zones de pages (redirection vers la
// connexion pour un rôle inadapté).
export function requireZone(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.account_type)) return next();
    return res.redirect(PAGE_LOGIN_REDIRECT);
  };
}
