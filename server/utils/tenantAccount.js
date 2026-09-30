import crypto from 'node:crypto';

export const TENANT_EMAIL_DOMAIN = 'mim.local';

export function generateInitialPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  let value = '';
  for (let i = 0; i < 24; i += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `M!9${value}aA1`;
}

export async function provisionProfile(sb, userId, accountType, username, mustChangePassword = false, recoveryEmail = undefined) {
  const { error } = await sb.from('profiles').update({
    account_type: accountType,
    role: accountType,
    username: username || null,
    must_change_password: Boolean(mustChangePassword),
  }).eq('id', userId);
  if (error) throw new Error(error.message);

  if (recoveryEmail !== undefined) {
    const normalized = String(recoveryEmail || '').trim().toLowerCase();
    if (normalized) {
      const { error: recoveryError } = await sb.from('account_recovery_emails').upsert({
        user_id: userId,
        email: normalized,
        verified_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (recoveryError) throw new Error(recoveryError.message);
    } else {
      const { error: recoveryError } = await sb.from('account_recovery_emails').delete().eq('user_id', userId);
      if (recoveryError) throw new Error(recoveryError.message);
    }
  }
}

// ------------------------------------------------------------
// Tables dont la FK vers auth.users est ON DELETE RESTRICT.
// deleteUser() les prend en compte : sans purge prealable il echoue,
// le compte reste alors en place (profil + lien de gestion inclus) et
// l'invariant H-19 « aucun compte orphelin » est viole. C'est le cas
// depuis mim_trial_subscription_on_signup : toute inscription
// proprietaire/agence/entreprise recoit une souscription d'essai.
// Les colonnes sont toutes nommees user_id (meme nom partout).
// ------------------------------------------------------------
const AUTH_RESTRICT_TABLES = [
  'subscriptions',
  'abonnement_paiements',
  'paiements_employes',
  'paiements',
  'versements',
];

// Purge best-effort : une table vide ne doit jamais empecher la
// suppression du compte, mais un echec est signale pour diagnostic.
async function purgeAuthLinkedRows(sb, userId, contexte) {
  for (const table of AUTH_RESTRICT_TABLES) {
    const { error } = await sb.from(table).delete().eq('user_id', userId);
    if (error) console.warn(`[tenantAccount/${contexte}] purge ${table} : ${error.message}`);
  }
}

// Suppression complete d'un compte Auth + ses lignes RESTRICT.
// Ne leve jamais : l'appelant peut enchaîner (aucun double effet).
export async function deleteAuthAccount(sb, userId, contexte = 'account') {
  if (!userId) return { ok: true };
  try {
    await purgeAuthLinkedRows(sb, userId, contexte);
    const { error } = await sb.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (err) {
    console.error(`[tenantAccount/${contexte}] suppression du compte ${userId} :`, err.message);
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------------------
// Compensation de creation de compte (H-19).
// Un compte cree via l'API Admin Supabase n'appartient a aucune
// transaction : quand l'etape suivante (rattachement, lien de gestion)
// echoue, le compte est supprime immediatement. Le profil et les liens
// cascadeent depuis auth.users (ON DELETE CASCADE), les lignes
// RESTRICT (souscription d'essai notamment) sont purgees avant :
// jamais de compte orphelin dont les identifiants ne sont retournes
// a personne.
// Ne leve jamais — un rollback qui echoue est journalise, l'appelant
// repond quand meme (aucun double effet).
// ------------------------------------------------------------
export async function rollbackCreatedAccount(sb, userId, contexte = 'account') {
  if (!userId) return { ok: true };
  const result = await deleteAuthAccount(sb, userId, `rollback/${contexte}`);
  if (!result.ok) {
    console.error(`[tenantAccount/${contexte}] rollback du compte ${userId} :`, result.error);
  }
  return result;
}

export function usernameIsValid(username) {
  return /^[a-z0-9._-]{3,32}$/.test(String(username || '').trim().toLowerCase());
}

// Email interne utilisé pour l'authentification Supabase d'un locataire.
// L'email n'est jamais demandé au locataire : on en génère un depuis le username.
export function tenantEmailFor(username) {
  return `${String(username).trim().toLowerCase()}@${TENANT_EMAIL_DOMAIN}`;
}

// Tente de résoudre l'identifiant saisi (email ou username) en email d'authentification.
export function resolveLoginEmail(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  if (value.includes('@')) return value;
  return tenantEmailFor(value);
}

// ------------------------------------------------------------
// Génération des usernames (préfixe lisible + jeton aléatoire).
// Le username ne doit JAMAIS être prévisible (nom.nom, nom.nom2…) :
// comme le mot de passe initial, il est généré de façon aléatoire
// afin qu'on ne puisse pas deviner l'identifiant d'un compte.
// Utilisée par l'import CSV et par la création d'un locataire /
// employé depuis les formulaires uniques.
// ------------------------------------------------------------

// Alphabet sans caractères ambigus (pas de 0/O, 1/l) ni majuscules.
const USERNAME_TOKEN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const usernameLocks = new Map();

export async function withUsernameLock(username, operation) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return operation();
  const previous = usernameLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  usernameLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (usernameLocks.get(key) === current) usernameLocks.delete(key);
  }
}

// ------------------------------------------------------------
// Verrou de CHANGEMENT de username, par compte.
// La sequence profil → email Auth → fiche n'est pas transactionnelle
// (chaque appel PostgREST est sa propre transaction) : sans
// serialisation, deux changements concurrents du meme compte peuvent
// croiser leurs etapes et laisser l'email interne derive d'un autre
// username que celui du profil (M-02). Une seule requete "gagne" par
// compte a la fois, l'autre repart sur l'etat deja mis a jour.
// ------------------------------------------------------------
const accountChangeLocks = new Map();

export async function withUsernameChangeLock(userId, operation) {
  const key = String(userId || '');
  if (!key) return operation();
  const previous = accountChangeLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  accountChangeLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (accountChangeLocks.get(key) === current) accountChangeLocks.delete(key);
  }
}

// Middleware : verrouille le compte pendant toute la duree de la route,
// le verrou n'etant relache qu'a l'envoi de la reponse. A placer AVANT le
// handler : la lecture de l'ancien username (base du CAS) se fait alors
// sous verrou. next() est appele en microtache, Express le supporte.
export function lockAccountUsernameChange(req, res, next) {
  if (!req.user?.id) return next();
  withUsernameChangeLock(req.user.id, () => new Promise((resolve) => {
    const release = () => resolve();
    res.once('finish', release);
    res.once('close', release);
    next();
  })).catch(next);
}

function randomToken(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += USERNAME_TOKEN_CHARS[crypto.randomInt(0, USERNAME_TOKEN_CHARS.length)];
  }
  return out;
}

function slugBase(prenom, nom) {
  const strip = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  let base = `${strip(prenom)}.${strip(nom)}`
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
  if (base.length < 3) base = 'utilisateur';
  if (base.length > 30) base = base.slice(0, 30).replace(/\.+$/, '');
  return base;
}

async function usernameTaken(sb, username) {
  const { data } = await sb.from('profiles').select('id').ilike('username', username).maybeSingle();
  return Boolean(data);
}

export async function uniqueUsername(sb, prenom, nom) {
  // Préfixe limité pour laisser la place au jeton aléatoire
  // (le username complet doit rester ≤ 32 caractères).
  const prefix = slugBase(prenom, nom).slice(0, 18);

  for (let attempt = 0; attempt < 12; attempt++) {
    const tokenLength = 6 + (attempt % 3); // 6, 7 puis 8 caractères
    const candidate = `${prefix}.${randomToken(tokenLength)}`.slice(0, 32);
    if (usernameIsValid(candidate) && !(await usernameTaken(sb, candidate))) return candidate;
  }

  // Sécurité ultime : jeton aléatoire sans préfixe du nom.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `u.${randomToken(10)}`.slice(0, 32);
    if (usernameIsValid(candidate) && !(await usernameTaken(sb, candidate))) return candidate;
  }

  return null;
}

// Découpe un nom complet en { prenom, nom } : le premier mot est le
// prénom, le reste le nom de famille (utilisé pour générer le username).
export function splitFullName(nomComplet) {
  const parts = String(nomComplet || '').trim().split(/\s+/);
  if (!parts.length || !parts[0]) return { prenom: '', nom: '' };
  return { prenom: parts[0], nom: parts.slice(1).join(' ') || parts[0] };
}
