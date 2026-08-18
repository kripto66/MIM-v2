// API, apiRequest, showToast et escapeHtml sont fournis par api.js / crud.js
// (chargés par dashboard.html avant ce fichier).

function fmtFCFA(n) {
  return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const MOIS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function formatMois(mois) {
  if (!mois) return "";
  const [y, m] = mois.split("-");
  return `${MOIS_FR[Number(m) - 1]} ${y}`;
}

const STATUS = {
  logement: {
    libre: ["Libre", "status-info"],
    occupe: ["Occupé", "status-success"],
    maintenance: ["Maintenance", "status-warning"],
  },
  locataire: {
    actif: ["Actif", "status-success"],
    inactif: ["Inactif", "status-danger"],
  },
  paiement: {
    paye: ["Payé", "status-success"],
    attente: ["En attente", "status-warning"],
    retard: ["En retard", "status-danger"],
    a_confirmer: ["À confirmer", "status-info"],
    en_validation: ["En validation", "status-warning"],
    refuse: ["Refusé", "status-danger"],
  },
  incident: {
    nouveau: ["Nouveau", "status-danger"],
    en_cours: ["En cours", "status-warning"],
    intervention: ["Intervention", "status-info"],
    resolu: ["Résolu", "status-success"],
  },
  intervention: {
    planifie: ["Planifiée", "status-info"],
    en_cours: ["En cours", "status-warning"],
    termine: ["Terminée", "status-success"],
  },
};

function badge(statut, type) {
  const [label, cls] = STATUS[type][statut] || [statut, "status-info"];
  return `<span class="status ${cls}">${escapeHtml(label)}</span>`;
}

function displayMessage(text, type = "error") {
  const el = document.getElementById("apiMessage");
  if (!el) return;
  el.textContent = text;
  el.className = type;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}

function listItem(html) {
  return `<div class="list-item"><div class="list-item-info">${html}</div></div>`;
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats/dashboard`, {
      credentials: "include",
    });

    const { ok, error, data } = await MIM.parse(res);

    if (!ok) {
      if (!MIM.handleAuthError(error)) displayMessage(MIM.userMessage(error));
      return;
    }

    if (!data.success) {
      displayMessage(data.message || "Erreur de chargement.");
      return;
    }

    const s = data.stats;

    const map = {
      totalProperties: s.totalProperties,
      occupiedProperties: s.occupiedProperties,
      availableProperties: s.availableProperties,
      totalEmployees: s.totalEmployees ?? 0,
      expectedRent: fmtFCFA(s.expectedRent),
      paidRent: fmtFCFA(s.paidRent),
      lateRent: fmtFCFA(s.lateRent),
      activeIncidents: s.activeIncidents,
      activeInterventions: s.activeInterventions,
    };

    for (const [id, value] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    const actions = [
      ["actValidations", s.paiementsEnValidation ?? 0],
      ["actSalaires", s.salairesAttente ?? 0],
      ["actRetards", s.lateCount ?? 0],
      ["actIncidents", s.activeIncidents ?? 0],
    ];
    let total = 0;
    for (const [id, value] of actions) {
      const card = document.getElementById(id);
      if (!card) continue;
      const strong = card.querySelector("strong");
      if (strong) strong.textContent = value;
      card.classList.toggle("warn", value > 0);
      total += value;
    }
    const grid = document.getElementById("actionsGrid");
    const allDone = document.getElementById("actionsAllDone");
    if (grid && allDone) {
      grid.style.display = total === 0 ? "none" : "";
      allDone.style.display = total === 0 ? "" : "none";
    }
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
    console.error(error);
  }
}

async function loadUserName() {
  try {
    const res = await fetch(`${API}/auth/me`, { credentials: "include" });
    const { ok, error, data } = await MIM.parse(res);
    if (!ok) {
      if (!MIM.handleAuthError(error)) console.error(error);
      return;
    }
    const el = document.getElementById("ownerName");
    if (el) el.textContent = data.user.name;
  } catch (error) {
    console.error(error);
  }
}

function renderProperties(biens) {
  const el = document.getElementById("propertiesList");
  if (!el) return;
  if (!biens.length) {
    el.innerHTML = '<div class="empty-state">Aucun bien pour le moment.</div>';
    return;
  }
  el.innerHTML = `<div class="property-list">${biens.slice(0, 6).map((b) => `
      <div class="property-card">
        <h3>${escapeHtml(b.nom)}</h3>
        <p>${escapeHtml(b.type || "")}${b.ville ? " — " + escapeHtml(b.ville) : ""}</p>
      </div>`).join("")}</div>`;
}

function renderTenants(locataires, logements) {
  const el = document.getElementById("tenantsList");
  if (!el) return;
  if (!locataires.length) {
    el.innerHTML = '<div class="empty-state">Aucun locataire.</div>';
    return;
  }
  el.innerHTML = locataires.slice(0, 5).map((t) => {
    const logement = logements.find((l) => String(l.id) === String(t.logement_id));
    return listItem(`
      <h3>${escapeHtml(t.nom)}</h3>
      <p>${logement ? escapeHtml(logement.nom) : "Aucun logement"}</p>
      ${badge(t.statut, "locataire")}`);
  }).join("");
}

function renderPayments(paiements, locataires, logements) {
  const summaryEl = document.getElementById("paymentsSummary");
  if (summaryEl) {
    const byStatut = (s) => paiements.filter((p) => p.statut === s);
    const rows = [
      ["Payés", byStatut("paye"), "status-success"],
      ["En attente", byStatut("attente"), "status-warning"],
      ["En retard", byStatut("retard"), "status-danger"],
    ];
    summaryEl.innerHTML = rows.map(([label, list, cls]) => `
      <div class="list-item">
        <div class="list-item-info"><h3>${label}</h3><p>${list.length} paiement(s)</p></div>
        <span class="status ${cls}">${fmtFCFA(list.reduce((s, p) => s + Number(p.montant || 0), 0))}</span>
      </div>`).join("");
  }

  const recentEl = document.getElementById("recentPayments");
  if (!recentEl) return;
  if (!paiements.length) {
    recentEl.innerHTML = '<div class="empty-state">Aucun paiement.</div>';
    return;
  }
  recentEl.innerHTML = paiements.slice(0, 5).map((p) => {
    const locataire = locataires.find((t) => String(t.id) === String(p.locataire_id));
    const logement = logements.find((l) => String(l.id) === String(p.logement_id));
    return listItem(`
      <h3>${locataire ? escapeHtml(locataire.nom) : "Locataire inconnu"} — ${fmtFCFA(p.montant)}</h3>
      <p>${formatMois(p.mois)}${logement ? " · " + escapeHtml(logement.nom) : ""}</p>
      ${badge(p.statut, "paiement")}`);
  }).join("");
}

function renderIncidents(incidents, logements) {
  const el = document.getElementById("recentIncidents");
  if (!el) return;
  if (!incidents.length) {
    el.innerHTML = '<div class="empty-state">Aucun incident.</div>';
    return;
  }
  el.innerHTML = incidents.slice(0, 5).map((i) => {
    const logement = logements.find((l) => String(l.id) === String(i.logement_id));
    return listItem(`
      <h3>${escapeHtml(i.titre)}</h3>
      <p>${logement ? escapeHtml(logement.nom) : "Aucun logement"} · ${formatDate(i.created_at)}</p>
      ${badge(i.statut, "incident")}`);
  }).join("");
}

function renderInterventions(interventions, prestataires, logements) {
  const el = document.getElementById("activeInterventionsList");
  if (!el) return;
  const active = interventions.filter((i) => i.statut !== "termine");
  if (!active.length) {
    el.innerHTML = '<div class="empty-state">Aucune intervention en cours.</div>';
    return;
  }
  el.innerHTML = active.slice(0, 5).map((i) => {
    const prestataire = prestataires.find((p) => String(p.id) === String(i.prestataire_id));
    const logement = logements.find((l) => String(l.id) === String(i.logement_id));
    return listItem(`
      <h3>${escapeHtml(i.titre)}</h3>
      <p>${prestataire ? "Prestataire : " + escapeHtml(prestataire.nom) : ""}${logement ? " · " + escapeHtml(logement.nom) : ""}</p>
      ${badge(i.statut, "intervention")}`);
  }).join("");
}

function renderNotifications(notifications) {
  const el = document.getElementById("recentNotifications");
  if (!el) return;
  if (!notifications.length) {
    el.innerHTML = '<div class="empty-state">Aucune notification.</div>';
    return;
  }
  el.innerHTML = notifications.slice(0, 5).map((n) => `
    <div class="list-item">
      <div class="list-item-info">
        <h3>${escapeHtml(n.message)}</h3>
        <p>${formatDate(n.created_at)}</p>
      </div>
      ${n.lu ? "" : `<span class="status status-warning">Non lue</span>`}
    </div>`).join("");
}

async function loadOverview() {
  try {
    const responses = await Promise.all([
      fetch(`${API}/biens`, { credentials: "include" }),
      fetch(`${API}/logements`, { credentials: "include" }),
      fetch(`${API}/locataires`, { credentials: "include" }),
      fetch(`${API}/paiements`, { credentials: "include" }),
      fetch(`${API}/incidents`, { credentials: "include" }),
      fetch(`${API}/prestataires`, { credentials: "include" }),
      fetch(`${API}/interventions`, { credentials: "include" }),
      fetch(`${API}/notifications`, { credentials: "include" }),
    ]);

    const notOk = responses.find((res) => !res.ok);
    if (notOk) {
      const { ok: parsedOk, error } = await MIM.parse(notOk);
      if (parsedOk || !MIM.handleAuthError(error)) throw new Error(MIM.userMessage(error) || "Erreur de chargement des données.");
    }

    const parse = async (res) => (await res.json()).data || [];
    const data = await Promise.all(responses.map(parse));

    renderProperties(data[0]);
    renderTenants(data[2], data[1]);
    renderPayments(data[3], data[2], data[1]);
    renderIncidents(data[4], data[1]);
    renderInterventions(data[6], data[5], data[1]);
    renderNotifications(data[7]);
  } catch (error) {
    console.error(error);
    const sections = [
      "propertiesList",
      "tenantsList",
      "paymentsSummary",
      "recentPayments",
      "recentIncidents",
      "activeInterventionsList",
      "recentNotifications",
    ];
    for (const id of sections) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="empty-state">Impossible de charger les données.</div>';
    }
  }
}

async function loadSubscriptionBanner() {
  const el = document.getElementById("subBanner");
  if (!el) return;
  let subscription = null;
  try {
    const res = await fetch(`${API}/subscription/me`, { credentials: "include" });
    const parsed = await MIM.parse(res);
    if (parsed.ok && parsed.data) subscription = parsed.data.subscription;
  } catch (error) {
    el.hidden = true;
    return;
  }

  if (!subscription) {
    el.className = "sub-banner sub-banner-info";
    el.innerHTML = "Aucun abonnement MIM enregistré. Contactez l'administration pour souscrire.";
    el.hidden = false;
    return;
  }

  const days = subscription.joursRestants;

  if (subscription.statut === "expire" || days <= 0) {
    el.className = "sub-banner sub-banner-danger";
    el.innerHTML = `Votre abonnement MIM est <strong>expiré</strong> (le ${formatDate(subscription.date_expiration)}). Veuillez contacter l'administration pour le renouveler.`;
    el.hidden = false;
    return;
  }

  if (days <= 7) {
    el.className = "sub-banner sub-banner-warning";
    el.innerHTML = `Votre abonnement MIM expire dans <strong>${days} jour${days > 1 ? "s" : ""}</strong> (le ${formatDate(subscription.date_expiration)}). Pensez à le renouveler.`;
    el.hidden = false;
    return;
  }

  el.hidden = true;
}

async function logout() {
  try {
    await fetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch (error) {
    console.error(error);
  }
  window.location.href = "../PartPublic/connexion.html";
}

document.addEventListener("DOMContentLoaded", () => {
  loadUserName();
  loadStats();
  loadOverview();
  loadSubscriptionBanner();
  loadOnboarding();

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
});

// Assistant de première configuration : modal d'accueil si l'espace
// est vide, lien permanent « Importer / Configurer » sinon masqué.
async function loadOnboarding() {
  const link = document.getElementById("setupLink");

  const showModal = await Onboarding.maybeShow();
  if (showModal) {
    // L'espace est vide : le lien de configuration est utile.
    if (link) link.style.display = "";
    return;
  }

  const needsSetup = await Onboarding.needsSetup().catch(() => false);
  if (link) link.style.display = needsSetup ? "" : "none";
}
