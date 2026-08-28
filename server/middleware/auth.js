import jwt from 'jsonwebtoken';
import { supabase, serviceClient } from '../app.js';
import { subscriptionExpiredFor } from '../utils/subscription.js';

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

// Interprète banned_until de GoTrue (timestamp ISO ou secondes epoch).
export function isBannedValue(value) {
  if (!value) return false;
  let ts = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

// Statut du compte auth GoTrue : 'active' | 'suspended' | 'deleted'.
export async function banStatusOf(userId) {
  try {
    const { data } = await serviceClient().auth.admin.getUserById(userId);
    if (!data?.user) return 'deleted';
    return isBannedValue(data.user.banned_until) ? 'suspended' : 'active';
  } catch (err) {
    console.warn('[auth] banStatusOf :', err.message);
    return 'suspended';
  }
}

// Un locataire ou employé dépend de son propriétaire (fiche locataires /
// employes, lien account_uid -> user_id). Aucune confiance en un owner_id
// envoyé par le frontend : la relation est lue en base.
export async function ownerSuspendedFor(userId, accountType) {
  if (accountType !== 'locataire' && accountType !== 'employe') return false;

  const table = accountType === 'locataire' ? 'locataires' : 'employes';
  try {
    const { data } = await serviceClient()
      .from(table)
      .select('user_id')
      .eq('account_uid', userId)
      .maybeSingle();
    return data?.user_id ? (await banStatusOf(data.user_id)) === 'suspended' : false;
  } catch (err) {
    console.warn('[auth] ownerSuspendedFor :', err.message);
    return true;
  }
}

// Vérifie le jeton mim_token, rafraîchit la session Supabase si nécessaire,
// puis REVALIDE côté serveur à chaque requête :
//   * le rôle (profiles.account_type) ;
//   * le statut du compte (banned_until) ;
//   * la suspension du propriétaire pour un locataire/employé.
// Retourne { user, suspended } (payload avec rôle à jour) ou null si la
// session est invalide (jeton invalide, profil ou compte supprimé).
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

  // Revalidation serveur (rôle + ban + propriétaire). Fail-closed :
  // profil absent ou erreur de lecture => session refusée.
  try {
    const { data: profile, error: profileError } = await serviceClient()
      .from('profiles')
      .select('account_type')
      .eq('id', decoded.id)
      .maybeSingle();

    if (profileError || !profile) return null;

    const ownStatus = await banStatusOf(decoded.id);
    if (ownStatus === 'deleted') return null;

    decoded.account_type = profile.account_type;
    const suspended =
      ownStatus === 'suspended' ||
      (await ownerSuspendedFor(decoded.id, profile.account_type)) ||
      (await subscriptionExpiredFor(decoded.id, profile.account_type));

    return { user: decoded, suspended };
  } catch (err) {
    console.warn('[auth] revalidation échec :', err.message);
    return null;
  }
}

// Restreint une route aux comptes ACTIFS. La suspension (compte suspendu,
// ou propriétaire suspendu pour un locataire/employé) rend la session
// invalide pour toute fonctionnalité métier : réponse 401 avec un code
// identifiable par le frontend, qui affiche un message clair.
export function requireActive(req, res, next) {
  if (req.user?.suspended) {
    return res.status(401).json({
      success: false,
      code: 'ACCOUNT_SUSPENDED',
      message: 'Votre compte a été suspendu.',
    });
  }
  next();
}

// Authentification API. Ne rejette PAS les comptes suspendus : les routes
// d'auto-service (profil, mot de passe) restent accessibles. La suspension
// est appliquée métier par requireActive.
export async function authenticate(req, res, next) {
  const result = await verifyToken(req);

  if (!result) {
    return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' });
  }

  req.user = result.user;
  req.user.suspended = result.suspended;
  setAuthCookie(res, signToken(result.user));
  next();
}

// Garde des pages statiques : redirige vers la page de connexion quand le
// visiteur n'est pas authentifié (un 401 JSON serait inadapté au HTML).
export function authenticatePage(redirectTo = PAGE_LOGIN_REDIRECT) {
  return async (req, res, next) => {
    const result = await verifyToken(req);

    if (!result) {
      return res.redirect(redirectTo);
    }

    req.user = result.user;
    req.user.suspended = result.suspended;
    setAuthCookie(res, signToken(result.user));
    next();
  };
}

export function signToken(payload, expiresIn = '7d') {
  const clean = {
    id: payload.id,
    account_type: payload.account_type,
    supabase_token: payload.supabase_token,
    refresh_token: payload.refresh_token,
    supabase_expires_at: payload.supabase_expires_at,
  };
  if (payload.mfa_pending) clean.mfa_pending = true;
  if (payload.factorId) clean.factorId = payload.factorId;
  return jwt.sign(clean, process.env.JWT_SECRET, { expiresIn });
}

export function requireAdmin(req, res, next) {
  if (req.user?.account_type !== 'admin' && req.user?.account_type !== 'ultra_admin') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Accès réservé à l'administration." });
  }
  next();
}

export function requireUltraAdmin(req, res, next) {
  if (req.user?.account_type !== 'ultra_admin') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Accès réservé au Super Admin.' });
  }
  next();
}

// Restriction par rôle pour les endpoints API (403 JSON).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.account_type)) return next();
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Accès non autorisé.' });
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
