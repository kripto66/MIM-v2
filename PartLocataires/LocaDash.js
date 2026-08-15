const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

async function tenantRequest(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const { ok, error, data } = await MIM.parse(res);

  if (!ok) {
    MIM.handleAuthError(error);
    throw error;
  }

  return data;
}

function fmtFCFA(n) {
  return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
}

const MOIS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function formatMois(mois) {
  if (!mois) return "";
  const [y, m] = String(mois).split("-");
  return `${MOIS_FR[Number(m) - 1] || ""} ${y}`.trim();
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const PAIEMENT_LABEL = {
  paye: ["Payé", "success"],
  attente: ["En attente", "warning"],
  retard: ["En retard", "danger"],
  a_confirmer: ["À confirmer", "info"],
  en_validation: ["En validation", "warning"],
  refuse: ["Refusé", "danger"],
};

const INCIDENT_LABEL = {
  nouveau: ["Nouveau", "danger"],
  en_cours: ["En cours", "warning"],
  intervention: ["Intervention", "warning"],
  resolu: ["Résolu", "success"],
};

function badgeStatut(statut, type) {
  const map = type === "incident" ? INCIDENT_LABEL : PAIEMENT_LABEL;
  const [label, cls] = map[statut] || [statut, "warning"];
  return `<span class="status ${cls}">${escapeHtml(label)}</span>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function initTenantShell() {
  const logoutButton = document.getElementById("logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" })
        .catch(() => {})
        .finally(() => {
          window.location.href = "../PartPublic/connexion.html";
        });
    });
  }

  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const closeMenu = document.getElementById("closeMenu");

  // Le bouton hamburger (#menuButton, data-sidebar-toggle) est déjà câblé
  // par PartPublic/sidebar.js (toggle + aria). L'ajouter ici DOUBLERAIT le
  // listener : un clic fermerait puis rouvrirait le menu (impossible de le
  // fermer). On ne gère ici que la fermeture (bouton × et overlay).

  const close = () => {
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
  };

  if (closeMenu) closeMenu.addEventListener("click", close);
  if (overlay) overlay.addEventListener("click", close);
}

async function loadTenantIdentity() {
  try {
    const { user } = await tenantRequest("/auth/me");
    const name = user.name || "Locataire";
    for (const id of ["userName", "welcomeName", "profileName", "profilePhone"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (id === "profilePhone") {
        el.value = user.phone || "";
      } else {
        el.textContent = name;
      }
    }
    const unlinkedEmail = document.getElementById("unlinkedEmail");
    if (unlinkedEmail && user.email) unlinkedEmail.textContent = user.email;
    return user;
  } catch (err) {
    return null;
  }
}

function nextMonthOf(mois) {
  if (!mois) return "";
  const [y, m] = String(mois).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function computeNextPaiement(paiements, loyer) {
  const unpaid = (paiements || [])
    .filter((p) => p.statut !== "paye")
    .sort((a, b) => String(a.mois || "").localeCompare(String(b.mois || "")));

  if (unpaid.length) {
    return {
      montant: fmtFCFA(unpaid[0].montant),
      echeance: `${formatMois(unpaid[0].mois)} · ${badgeStatut(unpaid[0].statut, "paiement")}`,
      statut: unpaid[0].statut,
    };
  }

  if (paiements && paiements.length) {
    const last = [...paiements].sort((a, b) =>
      String(b.mois || "").localeCompare(String(a.mois || ""))
    )[0];
    return {
      montant: loyer != null ? fmtFCFA(loyer) : fmtFCFA(last.montant),
      echeance: `${formatMois(nextMonthOf(last.mois))} · à venir`,
      statut: "paye",
    };
  }

  return {
    montant: loyer != null ? fmtFCFA(loyer) : "—",
    echeance: "Aucun paiement enregistré",
    statut: null,
  };
}

function showTenantError(message, isSuccess = false) {
  const box = document.getElementById("tenantError");
  if (!box) return;
  box.textContent = message;
  box.className = `tenant-message ${isSuccess ? "success" : "danger"}`;
  box.style.display = "block";
}

document.addEventListener("DOMContentLoaded", () => {
  initTenantShell();
  loadTenantIdentity();

  const dashboardContentEl = document.getElementById("dashboardContent");
  if (!dashboardContentEl) return;

  (async () => {
    try {
      const data = await tenantRequest("/locataire/dashboard");
      renderDashboard(data);
    } catch (err) {
      showTenantError(err.message);
      const content = document.getElementById("dashboardContent");
      if (content) content.style.display = "none";
    }
  })();
});

function renderDashboard(data) {
  const unlinked = document.getElementById("unlinkedMessage");
  const content = document.getElementById("dashboardContent");

  if (!data.linked) {
    if (unlinked) unlinked.style.display = "block";
    if (content) content.style.display = "none";
    return;
  }

  if (unlinked) unlinked.style.display = "none";
  if (content) content.style.display = "";

  const s = data.stats || {};

  setText("loyerMensuel", s.loyer != null ? fmtFCFA(s.loyer) : "—");

  const statutEl = document.getElementById("paiementStatut");
  if (statutEl) {
    const map = { paye: ["À jour", "success"], attente: ["En attente", "warning"], retard: ["En retard", "danger"], a_confirmer: ["À confirmer", "info"], en_validation: ["En validation", "warning"], refuse: ["Refusé", "danger"] };
    const [label, cls] = map[s.paiementStatut] || ["Aucun paiement", "warning"];
    statutEl.textContent = label;
    statutEl.className = `status ${cls}`;
  }

  const prochain = computeNextPaiement(data.paiements, s.loyer);
  setText("prochainMontant", prochain.montant);
  setText("incidentsOuverts", s.incidentsOuverts);

  if (data.logement) {
    setText("logementNom", data.logement.nom);
    setText("logementBien", data.bien ? data.bien.nom : "Bien immobilier");
    const lieu = [data.bien?.ville, data.bien?.pays].filter(Boolean).join(", ");
    setText("logementAdresse", lieu || data.logement.description || "");
  } else {
    const card = document.getElementById("logementCard");
    if (card) card.style.display = "none";
  }

  const paiementCardMontant = document.getElementById("paiementCardMontant");
  const paiementCardEcheance = document.getElementById("paiementCardEcheance");
  const paiementCardStatut = document.getElementById("paiementCardStatut");
  if (paiementCardMontant) paiementCardMontant.textContent = prochain.montant;
  if (paiementCardEcheance) paiementCardEcheance.innerHTML = prochain.echeance;
  if (paiementCardStatut && prochain.statut) {
    const map = { paye: ["À jour", "success"], attente: ["En attente", "warning"], retard: ["En retard", "danger"], a_confirmer: ["À confirmer", "info"], en_validation: ["En validation", "warning"], refuse: ["Refusé", "danger"] };
    const [label, cls] = map[prochain.statut];
    paiementCardStatut.textContent = label;
    paiementCardStatut.className = `status ${cls}`;
  }

  renderConfirmPayment(data);

  renderIncidentPreview(data.incidents);
  renderNotifications(data.notifications);
}

function renderConfirmPayment(data) {
  const zone = document.getElementById("confirmPaymentZone");
  if (!zone) return;

  const paiements = (data.paiements || [])
    .filter((p) => p.statut === "a_confirmer" || p.statut === "en_validation")
    .sort((a, b) => String(a.mois || "").localeCompare(String(b.mois || "")));

  const pending = paiements[0];

  if (!pending) {
    zone.innerHTML = "";
    return;
  }

  if (pending.statut === "en_validation") {
    zone.innerHTML = `
      <div class="confirm-payment-info">
        <strong>Paiement confirmé</strong>
        <p>Votre paiement de ${formatMois(pending.mois)} attend la validation du propriétaire.</p>
      </div>`;
    return;
  }

  zone.innerHTML = `
    <button class="primary-button" type="button" id="confirmPaymentBtn" data-id="${pending.id}">
      Confirmer mon paiement (${formatMois(pending.mois)})
    </button>`;

  document.getElementById("confirmPaymentBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      const res = await tenantRequest(`/locataire/paiements/${id}/confirmer`, { method: "POST" });
      showTenantError(res.message || "Paiement confirmé.", true);
      renderConfirmPayment(data);
    } catch (err) {
      btn.disabled = false;
      showTenantError(err.message);
    }
  });
}

function renderIncidentPreview(incidents) {
  const el = document.getElementById("incidentPreview");
  if (!el) return;

  const open = (incidents || []).find((i) => i.statut !== "resolu");

  if (!open) {
    el.innerHTML = `
      <div class="incident-preview">
        <strong>Aucun incident en cours</strong>
        <p>Tout est en ordre sur votre logement.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="incident-preview">
      <strong>${escapeHtml(open.titre)}</strong>
      <p>${badgeStatut(open.statut, "incident")} · Signalé le ${formatDate(open.created_at)}</p>
    </div>`;
}

function renderNotifications(notifications) {
  const el = document.getElementById("notificationsFeed");
  if (!el) return;

  const items = (notifications || []).slice(0, 3);

  if (!items.length) {
    el.innerHTML = '<div class="notification-item"><span>🔔</span><div><strong>Aucune notification</strong></div></div>';
    return;
  }

  el.innerHTML = items
    .map((n) => {
      const icon = n.type === "paiement" ? "💰" : n.type === "incident" ? "🛠️" : "🔔";
      return `
        <div class="notification-item">
          <span>${icon}</span>
          <div>
            <strong>${escapeHtml(n.message)}</strong>
            ${n.date ? `<p>${formatDate(n.date)}</p>` : ""}
          </div>
        </div>`;
    })
    .join("");
}
