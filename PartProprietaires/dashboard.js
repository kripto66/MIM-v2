const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

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
  },
  incident: {
    nouveau: ["Nouveau", "status-danger"],
    en_cours: ["En cours", "status-warning"],
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

const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";

const DEMO = {
  user: { name: "Ahmadou Diop", email: "amathd988@gmail.com" },
  stats: {
    totalProperties: 12,
    occupiedProperties: 8,
    availableProperties: 3,
    expectedRent: 1450000,
    paidRent: 980000,
    lateRent: 250000,
    activeIncidents: 4,
    activeInterventions: 2,
  },
  biens: [
    { id: 1, nom: "Immeuble Amadou", type: "immeuble", adresse: "Rue 12", ville: "Dakar", pays: "Sénégal", description: "Immeuble de 8 logements" },
    { id: 2, nom: "Villa Almadies", type: "villa", adresse: "Route des Almadies", ville: "Dakar", pays: "Sénégal", description: "" },
    { id: 3, nom: "Résidence Mermoz", type: "appartement", adresse: "Avenue Bourguiba", ville: "Dakar", pays: "Sénégal", description: "" },
  ],
  logements: [
    { id: 1, bien_id: 1, nom: "Appartement A1", loyer_mensuel: 150000, statut: "occupe", description: "" },
    { id: 2, bien_id: 1, nom: "Appartement A2", loyer_mensuel: 150000, statut: "libre", description: "" },
    { id: 3, bien_id: 2, nom: "Villa complète", loyer_mensuel: 400000, statut: "occupe", description: "" },
    { id: 4, bien_id: 3, nom: "Studio B1", loyer_mensuel: 90000, statut: "maintenance", description: "" },
  ],
  locataires: [
    { id: 1, logement_id: 1, nom: "Moussa Fall", email: "moussa@mail.com", phone: "+221770000001", date_entree: "2025-01-15", statut: "actif" },
    { id: 2, logement_id: 3, nom: "Aïssatou Ndiaye", email: "aissa@mail.com", phone: "+221770000002", date_entree: "2025-03-01", statut: "actif" },
    { id: 3, logement_id: null, nom: "Ousmane Sarr", email: "ouss@mail.com", phone: "+221770000003", date_entree: null, statut: "inactif" },
  ],
  paiements: [
    { id: 1, locataire_id: 1, logement_id: 1, montant: 150000, mois: "2026-08", statut: "paye", date_paiement: "2026-08-02" },
    { id: 2, locataire_id: 2, logement_id: 3, montant: 400000, mois: "2026-08", statut: "attente", date_paiement: null },
    { id: 3, locataire_id: 1, logement_id: 1, montant: 150000, mois: "2026-07", statut: "retard", date_paiement: null },
  ],
  incidents: [
    { id: 1, logement_id: 4, titre: "Fuite d'eau", description: "Fuite sous l'évier", statut: "en_cours", created_at: "2026-08-10T10:00:00Z" },
    { id: 2, logement_id: 1, titre: "Climatisation en panne", description: "", statut: "nouveau", created_at: "2026-08-11T09:30:00Z" },
  ],
  prestataires: [
    { id: 1, nom: "Plomberie Diop", specialite: "Plomberie", phone: "+221770000010", email: "diop@mail.com" },
    { id: 2, nom: "Élec Services", specialite: "Électricité", phone: "+221770000011", email: "" },
  ],
  interventions: [
    { id: 1, incident_id: 1, prestataire_id: 1, logement_id: 4, titre: "Réparation fuite d'eau", description: "", statut: "en_cours", date_prevue: "2026-08-13" },
    { id: 2, incident_id: 2, prestataire_id: 2, logement_id: 1, titre: "Remplacement climatiseur", description: "", statut: "planifie", date_prevue: "2026-08-15" },
  ],
  notifications: [
    { id: 1, type: "paiement", message: "Paiement de 400 000 FCFA en attente (Aïssatou Ndiaye)", lu: false, created_at: "2026-08-11T08:00:00Z" },
    { id: 2, type: "incident", message: "Nouvel incident : Climatisation en panne", lu: false, created_at: "2026-08-11T09:30:00Z" },
    { id: 3, type: "info", message: "Bienvenue sur MIM !", lu: true, created_at: "2026-08-01T10:00:00Z" },
  ],
};

async function loadStats() {
  try {
    if (DEMO_MODE) {
      const s = DEMO.stats;
      const map = {
        totalProperties: s.totalProperties,
        occupiedProperties: s.occupiedProperties,
        availableProperties: s.availableProperties,
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
      return;
    }

    const res = await fetch(`${API}/stats/dashboard`, {
      credentials: "include",
    });

    if (res.status === 401) {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }

    const data = await res.json();

    if (!data.success) {
      displayMessage(data.message || "Erreur de chargement.");
      return;
    }

    const s = data.stats;

    const map = {
      totalProperties: s.totalProperties,
      occupiedProperties: s.occupiedProperties,
      availableProperties: s.availableProperties,
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
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
    console.error(error);
  }
}

async function loadUserName() {
  if (DEMO_MODE) {
    const el = document.getElementById("ownerName");
    if (el) el.textContent = DEMO.user.name;
    return;
  }

  try {
    const res = await fetch(`${API}/auth/me`, { credentials: "include" });
    const data = await res.json();
    if (data.success) {
      const el = document.getElementById("ownerName");
      if (el) el.textContent = data.user.name;
    }
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

function renderHousing(logements) {
  const el = document.getElementById("housingSummary");
  if (!el) return;
  const count = (s) => logements.filter((l) => l.statut === s).length;
  const rows = [
    ["Total logements", logements.length, "status-info"],
    ["Occupés", count("occupe"), "status-success"],
    ["Libres", count("libre"), "status-info"],
    ["En maintenance", count("maintenance"), "status-warning"],
  ];
  el.innerHTML = rows.map(([label, value, cls]) => `
      <div class="list-item">
        <div class="list-item-info"><h3>${label}</h3></div>
        <span class="status ${cls}">${value}</span>
      </div>`).join("");
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
  if (DEMO_MODE) {
    renderProperties(DEMO.biens);
    renderHousing(DEMO.logements);
    renderTenants(DEMO.locataires, DEMO.logements);
    renderPayments(DEMO.paiements, DEMO.locataires, DEMO.logements);
    renderIncidents(DEMO.incidents, DEMO.logements);
    renderInterventions(DEMO.interventions, DEMO.prestataires, DEMO.logements);
    renderNotifications(DEMO.notifications);
    return;
  }

  try {
    const [biens, logements, locataires, paiements, incidents, prestataires, interventions, notifications] =
      await Promise.all([
        fetch(`${API}/biens`, { credentials: "include" }),
        fetch(`${API}/logements`, { credentials: "include" }),
        fetch(`${API}/locataires`, { credentials: "include" }),
        fetch(`${API}/paiements`, { credentials: "include" }),
        fetch(`${API}/incidents`, { credentials: "include" }),
        fetch(`${API}/prestataires`, { credentials: "include" }),
        fetch(`${API}/interventions`, { credentials: "include" }),
        fetch(`${API}/notifications`, { credentials: "include" }),
      ]);

    if (biens.status === 401) {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }

    const responses = [biens, logements, locataires, paiements, incidents, prestataires, interventions, notifications];
    const parse = async (res) => (res.ok ? (await res.json()).data || [] : []);
    const data = await Promise.all(responses.map(parse));

    renderProperties(data[0]);
    renderHousing(data[1]);
    renderTenants(data[2], data[1]);
    renderPayments(data[3], data[2], data[1]);
    renderIncidents(data[4], data[1]);
    renderInterventions(data[6], data[5], data[1]);
    renderNotifications(data[7]);
  } catch (error) {
    console.error(error);
  }
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

async function manualBackup() {
  try {
    const res = await fetch(`${API}/git/backup`, {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json();
    displayMessage(data.message, data.success ? "success" : "error");
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadUserName();
  loadStats();
  loadOverview();

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  const backupBtn = document.getElementById("backupBtn");
  if (backupBtn) backupBtn.addEventListener("click", manualBackup);
});
