export const TENANT_EMAIL_DOMAIN = 'mim.local';

// Mot de passe initial des comptes créés automatiquement (locataires,
// employés) : temporaire uniquement, jamais stocké en clair — le compte
// est créé avec must_change_password = true.
export const INITIAL_PASSWORD = '1234';

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
// Génération des usernames (convention : prenom.nom, puis 2, 3, …)
// Utilisée par l'import CSV et par la création d'un locataire
// depuis le formulaire unique.
// ------------------------------------------------------------

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
  const base = slugBase(prenom, nom);
  if (!(await usernameTaken(sb, base))) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}${i}`.slice(0, 32);
    if (usernameIsValid(candidate) && !(await usernameTaken(sb, candidate))) return candidate;
  }
  const fallback = `${base}${Date.now() % 10000}`.slice(0, 32);
  return usernameIsValid(fallback) ? fallback : `utilisateur${Date.now() % 100000}`;
}

// Découpe un nom complet en { prenom, nom } : le premier mot est le
// prénom, le reste le nom de famille (utilisé pour générer le username).
export function splitFullName(nomComplet) {
  const parts = String(nomComplet || '').trim().split(/\s+/);
  if (!parts.length || !parts[0]) return { prenom: '', nom: '' };
  return { prenom: parts[0], nom: parts.slice(1).join(' ') || parts[0] };
}
