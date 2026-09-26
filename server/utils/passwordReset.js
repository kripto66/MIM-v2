// ============================================================
// MIM - Récupération de mot de passe (jetons sur mesure)
//
// Le jeton est :
//   * généré en clair AVEC crypto (randomBytes) ;
//   * transmis une seule fois à l'e-mail, jamais stocké en clair ;
//   * stocké UNIQUEMENT haché (SHA-256) dans password_reset_tokens ;
//   * à usage unique (consommation atomique via used_at) ;
//   * expiré après 30 minutes.
//
// La mise à jour du mot de passe passe par Supabase Auth
// (admin.updateUserById) : on réutilise EXACTEMENT le système de
// hash de MIM (bcrypt de GoTrue). Aucun second système créé.
// ============================================================

import crypto from 'node:crypto';
import { serviceClient } from '../app.js';
import { getNow } from './simulation.js';
import { sendMail } from './mailer.js';

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Générateur cryptographiquement sécurisé (32 octets, base64url). */
export function generateResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Hash de stockage du jeton (SHA-256 hex). Le jeton brut n'est jamais persisté. */
export function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function resetBaseUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Crée une ligne de récupération pour un utilisateur.
 * Retourne le jeton BRUT (destiné à l'e-mail uniquement).
 */
export async function issueResetToken(userId) {
  const sb = serviceClient();
  const now = await getNow();

  const { error: revokeError } = await sb
    .from('password_reset_tokens')
    .update({ status: 'revoked', revoked_at: new Date(now).toISOString() })
    .eq('user_id', userId)
    .in('status', ['pending', 'processing']);
  if (revokeError) {
    const err = new Error("Impossible de révoquer les demandes de récupération précédentes.");
    err.code = revokeError.code || 'DB_ERROR';
    throw err;
  }

  const raw = generateResetToken();
  const { error } = await sb.from('password_reset_tokens').insert({
    user_id: userId,
    token_hash: hashResetToken(raw),
    expires_at: new Date(now + RESET_TOKEN_TTL_MS).toISOString(),
  });

  if (error) {
    const err = new Error("Impossible d'enregistrer le jeton de récupération.");
    err.code = error.code || 'DB_ERROR';
    throw err;
  }

  return raw;
}

/**
 * Consomme un jeton de façon ATOMIQUE (usage unique même en cas de
 * requêtes concurrentes). Retourne le user_id si le jeton existe,
 * n'est PAS utilisé et n'est PAS expiré ; sinon null.
 */
export async function tryConsumeResetToken(rawToken) {
  if (!rawToken) return null;

  const sb = serviceClient();
  const now = await getNow();
  const tokenHash = hashResetToken(rawToken);

  let data = null;
  let error = null;
  const claim = await sb
    .from('password_reset_tokens')
    .update({ status: 'processing', last_attempt_at: new Date(now).toISOString() })
    .eq('token_hash', tokenHash)
    .eq('status', 'pending')
    .is('used_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date(now).toISOString())
    .select('user_id')
    .maybeSingle();
  data = claim.data;
  error = claim.error;

  if (!error && !data) {
    const stale = new Date(now - 5 * 60 * 1000).toISOString();
    const reclaimed = await sb
      .from('password_reset_tokens')
      .update({ status: 'processing', last_attempt_at: new Date(now).toISOString() })
      .eq('token_hash', tokenHash)
      .eq('status', 'processing')
      .lt('last_attempt_at', stale)
      .is('used_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date(now).toISOString())
      .select('user_id')
      .maybeSingle();
    data = reclaimed.data;
    error = reclaimed.error;
  }

  if (error || !data) return null;
  return { userId: data.user_id, tokenHash };
}

export async function finalizeResetToken(tokenHash) {
  const sb = serviceClient();
  const { error } = await sb
    .from('password_reset_tokens')
    .update({ status: 'used', used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .eq('status', 'processing');
  if (error) throw error;
}

export async function releaseResetToken(tokenHash) {
  const sb = serviceClient();
  const { error } = await sb
    .from('password_reset_tokens')
    .update({ status: 'pending', last_attempt_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .eq('status', 'processing');
  if (error) throw error;
}

/** Construit le lien de réinitialisation (frontend MIM : reset.html). */
export function buildResetLink(rawToken) {
  return `${resetBaseUrl()}/reset.html#token=${encodeURIComponent(rawToken)}`;
}

/**
 * Envoie l'e-mail de récupération (branding MIM).
 * Jamais de jeton en clair dans les logs (sendMail ne logue pas le HTML).
 */
export async function sendResetEmail({ email, rawToken }) {
  const link = buildResetLink(rawToken);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#12081f;color:#f3eefc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-flex;align-items:center;justify-content:center;gap:8px;">
        <span style="display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#d946ef);color:#fff;font-weight:800;">🏠</span>
        <span style="font-size:17px;font-weight:700;">MyImmo<strong style="color:#e5a017;">Management</strong></span>
      </div>
    </div>

    <div style="border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:28px 24px;background:rgba(255,255,255,.05);">
      <h1 style="margin:0 0 10px;font-size:20px;text-align:center;">Réinitialisation de votre mot de passe</h1>
      <p style="font-size:14px;line-height:1.7;color:#c9bfe0;">Bonjour,<br><br>
      Nous avons reçu une demande de réinitialisation du mot de passe de votre compte MyImmoManagement.</p>
      <p style="text-align:center;margin:26px 0;">
        <a href="${link}" style="display:inline-block;padding:13px 26px;border-radius:12px;background:linear-gradient(135deg,#e5a017,#f0b429);color:#221200;text-decoration:none;font-weight:700;font-size:15px;">Réinitialiser mon mot de passe</a>
      </p>
      <p style="font-size:13px;line-height:1.7;color:#998bb8;">
        Ce lien expire dans <strong style="color:#f3eefc;">30 minutes</strong> et ne peut être utilisé qu'une seule fois.<br><br>
        Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail : votre mot de passe reste inchangé.
      </p>
    </div>

    <p style="text-align:center;font-size:12px;color:#998bb8;margin-top:22px;">MIM — MyImmoManagement · Gestion immobilière simplifiée</p>
  </div>
</body>
</html>`;

  const text = [
    'Réinitialisation de votre mot de passe MIM',
    '',
    'Bonjour,',
    'Nous avons reçu une demande de réinitialisation du mot de passe de votre compte MyImmoManagement.',
    '',
    `Ouvrez ce lien dans les 30 minutes : ${link}`,
    '',
    'Ce lien ne peut être utilisé qu\'une seule fois. Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.',
    '',
    'MIM — MyImmoManagement',
  ].join('\n');

  return sendMail({
    to: email,
    subject: 'Réinitialisation de votre mot de passe MIM',
    html,
    text,
  });
}