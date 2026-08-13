// ============================================================
// MIM - Utilitaires de validation des formulaires (partagés)
// Erreur : bordure rouge sur le champ + message sous le champ.
// ============================================================

function mimApiBase() {
  // try/catch : évite la ReferenceError « API is not defined » quand la page
  // fait `const API = mimApiBase()` (API est alors en zone morte temporelle
  // pendant l'appel) — sinon le listener submit ne s'attache jamais et le
  // formulaire recharge la page au lieu d'appeler l'API.
  try {
    if (typeof API !== 'undefined') return API;
  } catch {
    /* API en TDZ : on calcule la base ci-dessous */
  }
  const origin = window.location.origin || 'http://localhost:3000';
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');
  return (isLocal ? 'http://localhost:3000' : origin) + '/api';
}

function mimFieldEl(form, name) {
  return form.querySelector(`[name="${name}"], #${name}`);
}

function formFieldError(form, name, message) {
  const input = mimFieldEl(form, name);
  if (!input) return;
  const wrapper = input.closest('.form-group') || input.parentElement;
  const insertAfterInput = !input.closest('.form-group') || input.parentElement === form;

  wrapper.classList.add('has-error');
  input.classList.add('input-error');

  let msg = wrapper.querySelector('.field-error-msg');
  if (!msg) {
    msg = document.createElement('small');
    msg.className = 'field-error-msg';
    if (insertAfterInput) input.insertAdjacentElement('afterend', msg);
    else wrapper.appendChild(msg);
  }
  msg.textContent = message;
}

function clearFieldError(form, name) {
  const input = mimFieldEl(form, name);
  if (!input) return;
  const wrapper = input.closest('.form-group') || input.parentElement;
  wrapper.classList.remove('has-error');
  input.classList.remove('input-error');
  const msg = wrapper.querySelector('.field-error-msg');
  if (msg) msg.remove();
}

function clearFormErrors(form) {
  form.querySelectorAll('.has-error').forEach((w) => w.classList.remove('has-error'));
  form.querySelectorAll('.input-error').forEach((i) => i.classList.remove('input-error'));
  form.querySelectorAll('.field-error-msg').forEach((m) => m.remove());
}

// Applique les erreurs renvoyées par le backend : { champ: message }
function applyServerErrors(form, errors) {
  if (!errors || typeof errors !== 'object') return;
  for (const [field, message] of Object.entries(errors)) {
    if (message) formFieldError(form, field, message);
  }
}

// Efface l'erreur d'un champ dès que l'utilisateur ressaisit une valeur.
function bindAutoClear(form, names) {
  (names || []).forEach((name) => {
    const input = mimFieldEl(form, name);
    if (input) input.addEventListener('input', () => clearFieldError(form, name));
  });
}

// Vérifie la disponibilité d'un username côté frontend (le backend vérifie aussi).
async function checkUsernameAvailability(form, fieldName, { onTaken } = {}) {
  const input = mimFieldEl(form, fieldName);
  if (!input) return true;

  const username = String(input.value || '').trim().toLowerCase();
  if (!username) return true;

  try {
    const res = await fetch(`${mimApiBase()}/auth/username-available?username=${encodeURIComponent(username)}`, {
      credentials: 'include',
    });
    const data = await res.json();

    if (data && data.available === false) {
      formFieldError(form, fieldName, 'Ce nom d\'utilisateur est déjà utilisé.');
      if (typeof onTaken === 'function') onTaken();
      return false;
    }
    clearFieldError(form, fieldName);
    return true;
  } catch (err) {
    return true;
  }
}
