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

/* Hôte de l'API. Mono-origin : quand les pages sont servies par le serveur MIM
 * (port dédié), l'API est sur la MÊME origine — exigé par la CSP connect-src
 * 'self'. Fallback : frontend servi par un serveur web par défaut (Apache :80)
 * → API dev sur :3000. */
MIM.apiHost = function () {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  if (isLocal) {
    const port = String(window.location.port || "");
    const defaultWebPort = port === "" || port === "80" || port === "443";
    if (!defaultWebPort) return origin;
    return "http://localhost:3000";
  }
  return origin;
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

MIM.resolveRedirect = function (redirect, accountType) {
  if (typeof redirect !== "string") return "";
  var value = redirect.trim();
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) || value.includes("\\")) return "";
  value = value.replace(/^(?:\.\.\/|\.\/)+/, "");
  if (!value.startsWith("/")) value = "/" + value;
  var url;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return "";
  }
  if (url.origin !== window.location.origin) return "";
  var type = accountType || MIM.accountType;
  if (type === "agence") {
    if (url.pathname === "/PartProprietaires/dashboard.html") {
      url.pathname = "/PartAgence/first_Mode/dashboard.html";
    } else if (url.pathname === "/PartProprietaires/abonnements.html") {
      url.pathname = "/PartAgence/first_Mode/abonnements.html";
    }
  }
  return url.pathname + url.search + url.hash;
};

MIM.accountHome = function (accountType) {
  var type = accountType || MIM.accountType;
  if (type === "agence") return "/PartAgence/first_Mode/dashboard.html";
  if (type === "locataire") return "/PartLocataires/LocaDash.html";
  if (type === "employe") return "/PartEmployes/employe.html";
  if (type === "admin") return "/PartAdmin/admin.html";
  if (type === "ultra_admin") return "/PartUltraAdmin/ultra.html";
  return "/PartProprietaires/dashboard.html";
};

MIM.httpsUrl = function (value) {
  try {
    var url = new URL(String(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
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
    // Abonnement expiré : le propriétaire doit renouveler en ligne,
    // pas se reconnecter (K1). Redirection vers la page d'abonnement.
    if (err.code === "SUBSCRIPTION_EXPIRED") {
      var agencePage = MIM.accountType === "agence" || window.location.pathname.indexOf("/PartAgence/") === 0;
      window.location.href = agencePage ? "/PartAgence/first_Mode/abonnements.html" : "/PartProprietaires/abonnements.html";
      return true;
    }
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

MIM._csrfToken = "";
MIM._csrfReady = fetch((MIM.apiHost ? MIM.apiHost() : window.location.origin) + "/api/csrf-token", {
  credentials: "include",
  headers: { "Accept": "application/json" }
}).then(async function (res) {
  if (!res.ok) return;
  const data = await res.json();
  MIM._csrfToken = typeof data.csrfToken === "string" ? data.csrfToken : "";
}).catch(function () {
  MIM._csrfToken = "";
});
MIM.csrfHeader = function () {
  return MIM._csrfToken ? { "X-CSRF-Token": MIM._csrfToken } : {};
};
