/* MIM — système unifié de messages d'erreur (toutes zones).
 * Chargé avant les helpers de requêtes : /mim-errors.js
 * API : MIM.parse(res), MIM.userMessage(err), MIM.handleAuthError(err),
 *       MIM.showError(msg), MIM.showSuccess(msg), escapeHtml(str). */
window.MIM = window.MIM || {};

/* Échappement HTML (défini une seule fois, disponible dans toutes les
 * zones). Préserve null/undefined en chaîne vide. */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

MIM.MESSAGES = {
  ACCOUNT_SUSPENDED: "Votre compte a été suspendu.",
  ACCOUNT_NOT_FOUND: "Aucun compte associé à cet identifiant.",
  INVALID_CREDENTIALS: "Email ou mot de passe incorrect.",
  USERNAME_ALREADY_EXISTS: "Ce nom d'utilisateur est déjà utilisé.",
  EMAIL_ALREADY_EXISTS: "Cette adresse email est déjà utilisée.",
  FORBIDDEN: "Accès non autorisé.",
  UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
  RATE_LIMIT: "Trop de tentatives. Réessayez dans un instant.",
  SERVICE_UNAVAILABLE: "Service temporairement indisponible. Réessayez dans un instant.",
  VALIDATION: "Veuillez vérifier les informations saisies.",
  SAAS_SUSPENDED: "Le service est temporairement indisponible. Veuillez réessayer plus tard."
};

MIM.httpFallback = {
  400: "Veuillez vérifier les informations saisies.",
  401: "Votre session a expiré. Reconnectez-vous.",
  403: "Accès non autorisé.",
  404: "Introuvable.",
  409: "Ce nom est déjà utilisé.",
  429: "Trop de tentatives. Réessayez dans un instant.",
  500: "Une erreur inattendue est survenue. Réessayez dans un instant.",
  502: "Service temporairement indisponible. Réessayez dans un instant.",
  503: "Service temporairement indisponible. Réessayez dans un instant.",
  504: "Le serveur met trop de temps à répondre. Réessayez dans un instant."
};

/* Normalise la réponse d'un fetch. Retourne { ok, data } ou { ok:false, error }.
 * L'erreur porte status, code (ex. ACCOUNT_SUSPENDED) et errors (par champ). */
MIM.parse = async function (res) {
  let body = {};
  try { body = await res.json(); } catch (err) { body = {}; }

  if (res.ok && body && body.success !== false) {
    return { ok: true, data: body };
  }

  const code = body && body.code ? body.code : null;
  const message =
    (body && body.message) ||
    (code && MIM.MESSAGES[code]) ||
    MIM.httpFallback[res.status] ||
    "Une erreur inattendue est survenue.";

  const error = new Error(message);
  error.status = res.status;
  error.code = code;
  error.errors = (body && body.errors) || null;
  return { ok: false, error, data: body };
};

MIM.userMessage = function (err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  if (err && err.status && MIM.httpFallback[err.status]) return MIM.httpFallback[err.status];
  return "Une erreur inattendue est survenue.";
};

MIM.redirectToLogin = function (reason) {
  const qs = reason ? "?error=" + encodeURIComponent(reason) : "";
  window.location.href = "/PartPublic/connexion.html" + qs;
};

/* Gère les erreurs de session/suspension des requêtes API métier :
 * redirection vers la connexion (avec motif ACCOUNT_SUSPENDED si suspendu). */
MIM.handleAuthError = function (err) {
  if (!err || !err.status) return false;
  if (err.status === 401 || err.status === 403) {
    const reason = err.code === "ACCOUNT_SUSPENDED" ? "ACCOUNT_SUSPENDED" : "";
    MIM.redirectToLogin(reason);
    return true;
  }
  return false;
};

/* Affiche un message global. Réutilise le conteneur de la zone quand il
 * existe, sinon crée un toast flottant stylé par mim-errors.css. */
MIM.showError = function (msg) { MIM._notify(msg, "error"); };
MIM.showSuccess = function (msg) { MIM._notify(msg, "success"); };

MIM._notify = function (msg, type) {
  const el =
    document.getElementById("toast") ||
    document.getElementById("tenantError") ||
    document.getElementById("loginMessage") ||
    document.getElementById("formMessage") ||
    MIM._createToast();

  if (el.classList.contains("tenant-message")) {
    el.textContent = msg;
    el.className = "tenant-message " + (type === "error" ? "danger" : "success");
    el.style.display = "block";
    return;
  }
  if (el.id === "loginMessage" || el.id === "formMessage") {
    el.textContent = msg;
    el.className = type === "error" ? "error" : "success";
    return;
  }

  el.textContent = msg;
  el.className = "toast show " + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = "toast"; }, 3500);
};

MIM._createToast = function () {
  const t = document.createElement("div");
  t.id = "toast";
  document.body.appendChild(t);
  return t;
};

/* ============================================================
   CSRF : supprimé. Le cookie mim_token utilise SameSite=Lax,
   ce qui protège contre les attaques CSRF sans token côté client.
   ============================================================ */
MIM.csrfHeader = function () { return {};
};
