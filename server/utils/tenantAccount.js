export const TENANT_EMAIL_DOMAIN = 'mim.local';

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
