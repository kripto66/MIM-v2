const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

async function apiRequest(path, options = {}) {
  const xsrf = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
  const csrfToken = xsrf ? decodeURIComponent(xsrf[1]) : '';

  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    ...options,
  });

  const { ok, error, data } = await MIM.parse(res);

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
