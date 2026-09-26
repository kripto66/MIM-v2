function mode2ScopeMissing() {
  const mim = window.MIM;
  return Boolean(
    mim && mim.agenceMode2 && (
      mim.mode2Blocked ||
      !mim.agenceBien ||
      !mim.agenceBien.id ||
      !mim.apiBase ||
      !mim.mode2ContextPromise ||
      (mim.apiBase === "/api" && !mim.mode2Global)
    )
  );
}

const API = (() => {
  if (mode2ScopeMissing()) return "";
  const host = (window.MIM && MIM.apiHost) ? MIM.apiHost() : window.location.origin || "http://localhost:3000";
  const base = window.MIM && MIM.agenceMode2 ? MIM.apiBase : "/api";
  return host + base;
})();

async function apiRequest(path, options = {}) {
  if (mode2ScopeMissing()) {
    if (window.MIM && typeof MIM.redirectToAgenceFirstMode === "function") {
      MIM.redirectToAgenceFirstMode();
    }
    const error = new Error("Aucun bien sélectionné.");
    error.code = "MODE2_SCOPE_MISSING";
    throw error;
  }
  if (window.MIM && MIM.agenceMode2 && MIM.mode2ContextPromise) {
    try {
      await MIM.mode2ContextPromise;
    } catch (err) {
      if (err && err.status === 401 && typeof MIM.handleAuthError === "function") {
        MIM.handleAuthError(err);
      } else if (typeof MIM.redirectToAgenceFirstMode === "function") {
        MIM.redirectToAgenceFirstMode();
      }
      throw err;
    }
  }
  const { headers: userHeaders, ...rest } = options;
  if (window.MIM && MIM._csrfReady) await MIM._csrfReady;
  const csrfHeaders = window.MIM && typeof MIM.csrfHeader === "function" ? MIM.csrfHeader() : {};
  const res = await fetch(`${API}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...userHeaders,
      ...csrfHeaders,
    },
  });

  const { ok, error, data } = await MIM.parse(res);
  if (data && data.user && data.user.account_type) MIM.accountType = data.user.account_type;

  if (!ok) {
    MIM.handleAuthError(error);
    throw error;
  }

  return data;
}

function showToast(message, type = "success") {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (toast.className = "toast"), 3000);
}

const MOIS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function formatMois(mois) {
  if (!mois) return "";
  const [y, m] = mois.split("-");
  return `${MOIS_FR[Number(m) - 1]} ${y}`;
}
