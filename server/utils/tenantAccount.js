export const TENANT_EMAIL_DOMAIN = 'mim.local';

// Mot de passe initial des comptes créés automatiquement (locataires,
// employés) : temporaire uniquement, jamais stocké en clair — le compte
// est créé avec must_change_password = true.
export const INITIAL_PASSWORD = 'Mim@' + Math.random().toString(36).slice(2, 8) + '!';

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

function randomToken(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += USERNAME_TOKEN_CHARS[Math.floor(Math.random() * USERNAME_TOKEN_CHARS.length)];
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
