// ============================================================
// Politique de mot de passe MIM (backend)
// Algorithme miroir de PartPublic/password-strength.js (frontend)
// Le frontend indique le niveau ; le backend applique les règles
// minimales. Les mots de passe ne sont jamais stockés en clair.
// ============================================================

// Mots de passe trop courants (liste à maintenir)
const COMMON_PASSWORDS = new Set([
  '123456', '123456789', '12345678', 'password', 'motdepasse',
  'qwerty', 'azerty', 'abc123', '111111', '123123', 'admin',
  'admin123', 'locataire', 'locataire123', 'proprietaire', 'mim',
  'mim2024', 'mim2025', 'mim2026', 'letmein', 'welcome', 'monkey',
  'dragon', 'baseball', 'football', 'secret', 'changeme',
  '0123456789', '987654321', 'a1b2c3', 'password1', 'password123',
]);

// Score 0..6 (identique côté frontend)
export function scorePassword(pw) {
  const value = String(pw || '');
  if (!value) return 0;

  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value)) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;

  // Pénalités : répétitions évidentes
  if (/(.)\1{3,}/.test(value)) score = Math.max(1, score - 1);
  if (/(.)\1{4,}/.test(value)) score = Math.max(1, score - 1);

  // Mots de passe trop courants
  if (COMMON_PASSWORDS.has(value.toLowerCase())) score = 0;

  return Math.max(0, Math.min(6, score));
}

// Première erreur de règle minimale rencontrée (null si conforme).
export function passwordRuleError(pw) {
  const value = String(pw || '');

  if (value.length < 8) {
    return 'Le mot de passe doit contenir au moins 8 caractères.';
  }

  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (categories < 3) {
    return 'Le mot de passe doit contenir au moins 3 types de caractères (minuscules, majuscules, chiffres, symboles).';
  }

  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return 'Ce mot de passe est trop courant. Choisissez un mot de passe plus sûr.';
  }

  if (/(.)\1{4,}/.test(value)) {
    return 'Ce mot de passe contient trop de caractères identiques à la suite.';
  }

  return null;
}
