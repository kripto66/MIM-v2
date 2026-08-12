// ============================================================
// MIM - Indicateur de force du mot de passe (partagé)
// Algorithme miroir de server/utils/passwordPolicy.js (backend).
// Couleurs : FAIBLE = rouge, MOYEN = orange, FORT = vert.
// Le champ est marqué via les classes pw-weak / pw-medium / pw-strong.
// ============================================================

const MIM_COMMON_PASSWORDS = new Set([
  '123456', '123456789', '12345678', 'password', 'motdepasse',
  'qwerty', 'azerty', 'abc123', '111111', '123123', 'admin',
  'admin123', 'locataire', 'locataire123', 'proprietaire', 'mim',
  'mim2024', 'mim2025', 'mim2026', 'letmein', 'welcome', 'monkey',
  'dragon', 'baseball', 'football', 'secret', 'changeme',
  '0123456789', '987654321', 'a1b2c3', 'password1', 'password123',
]);

function mimScorePassword(pw) {
  const value = String(pw || '');
  if (!value) return 0;

  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value)) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;

  if (/(.)\1{3,}/.test(value)) score = Math.max(1, score - 1);
  if (/(.)\1{4,}/.test(value)) score = Math.max(1, score - 1);

  if (MIM_COMMON_PASSWORDS.has(value.toLowerCase())) score = 0;

  return Math.max(0, Math.min(6, score));
}

// niveau : faible | moyen | fort
function mimPasswordStrength(pw) {
  const score = mimScorePassword(pw);
  let level = 'faible';
  if (score >= 5) level = 'fort';
  else if (score >= 3) level = 'moyen';
  return { score, level };
}

// Message de la première règle minimale non respectée (null si OK).
function mimPasswordRuleMessage(pw) {
  const value = String(pw || '');

  if (value.length < 8) {
    return 'Le mot de passe doit contenir au moins 8 caractères.';
  }

  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (categories < 3) {
    return 'Le mot de passe doit contenir au moins 3 types de caractères (minuscules, majuscules, chiffres, symboles).';
  }

  if (MIM_COMMON_PASSWORDS.has(value.toLowerCase())) {
    return 'Ce mot de passe est trop courant. Choisissez un mot de passe plus sûr.';
  }

  if (/(.)\1{4,}/.test(value)) {
    return 'Ce mot de passe contient trop de caractères identiques à la suite.';
  }

  return null;
}

const MIM_LEVEL_META = {
  vide: { bars: 0, label: '', cls: '' },
  faible: { bars: 1, label: 'FAIBLE', cls: 'pw-weak' },
  moyen: { bars: 2, label: 'MOYEN', cls: 'pw-medium' },
  fort: { bars: 3, label: 'FORT', cls: 'pw-strong' },
};

function attachPasswordStrength(input) {
  if (!input || input.dataset.strengthAttached) return;
  input.dataset.strengthAttached = '1';

  const meter = document.createElement('div');
  meter.className = 'password-meter';
  meter.innerHTML =
    '<span class="meter-bar"></span><span class="meter-bar"></span><span class="meter-bar"></span><span class="meter-label"></span>';
  input.insertAdjacentElement('afterend', meter);

  const bars = meter.querySelectorAll('.meter-bar');
  const label = meter.querySelector('.meter-label');

  const update = () => {
    const value = input.value || '';
    input.classList.remove('pw-empty', 'pw-weak', 'pw-medium', 'pw-strong');

    if (!value) {
      bars.forEach((b) => b.classList.remove('active', 'weak', 'medium', 'strong'));
      label.textContent = '';
      input.classList.add('pw-empty');
      return;
    }

    const { level } = mimPasswordStrength(value);
    const meta = MIM_LEVEL_META[level];

    bars.forEach((b, i) => {
      b.classList.toggle('active', i < meta.bars);
      b.classList.remove('weak', 'medium', 'strong');
      if (i < meta.bars) b.classList.add(meta.cls);
    });

    label.textContent = meta.label;
    label.className = 'meter-label ' + meta.cls;
    input.classList.add(meta.cls);
  };

  input.addEventListener('input', update);
  input.addEventListener('blur', update);
  update();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="password"][data-strength]').forEach(attachPasswordStrength);
});
