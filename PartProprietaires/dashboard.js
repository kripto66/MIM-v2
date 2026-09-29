// API, apiRequest, showToast, escapeHtml et formatMois sont fournis
// par api.js / crud.js / mim-errors.js (chargés avant ce fichier).

function fmtFCFA(n) {
  return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
}

function fmtShortFCFA(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M FCFA`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} k FCFA`;
  return `${v} FCFA`;
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function listItem(html, extraClass = "") {
  return `<div class="list-item ${extraClass}"><div class="list-item-info">${html}</div></div>`;
}

/* ------------------------------------------------------------------
   Squelettes de chargement
------------------------------------------------------------------- */

const SKELETON_ITEM = `
  <div class="skel-item">
    <div style="flex:1;min-width:0;">
      <div class="skeleton skel-line"></div>
      <div class="skeleton skel-line dim"></div>
    </div>
    <div class="skeleton" style="width:64px;height:22px;border-radius:999px;flex-shrink:0;"></div>
  </div>`;

function initSkeletons() {
  const ids = [
    "recentPayments",
    "recentIncidents",
    "activeInterventionsList",
    "recentNotifications",
    "tenantsList",
    "propertiesList",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && !el.querySelector(".skel-item, .list-item, .property-card, .pay-line")) {
      el.innerHTML = SKELETON_ITEM.repeat(4);
    }
  }
}

/* ------------------------------------------------------------------
   Rafraîchissement global (bouton + auto)
------------------------------------------------------------------- */

let pending = 0;
const refreshBtn = document.getElementById("refreshBtn");

function track(promise) {
  pending++;
  if (refreshBtn) refreshBtn.classList.add("spinning");
  return Promise.resolve(promise).finally(() => {
    pending--;
    if (pending <= 0 && refreshBtn) refreshBtn.classList.remove("spinning");
  });
}

function setLiveLabel(text) {
  const el = document.getElementById("liveLabel");
  if (el) el.textContent = text;
}

function liveTime() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function refreshAll() {
  const user = await loadUserName();
  if (user && user.account_type === "agence") return;
  return Promise.all([
    loadStats(),
    loadOverview(),
    loadSubscriptionBanner(),
  ]).catch(() => {});
}

/* ------------------------------------------------------------------
   Salutation + date du jour
------------------------------------------------------------------- */

function setGreeting() {
  const now = new Date();
  const h = now.getHours();
  const wordEl = document.getElementById("greetingWord");
  const subEl = document.getElementById("greetingSub");

  if (wordEl) {
    wordEl.textContent =
      h >= 6 && h < 12 ? "Bonjour" :
      h >= 12 && h < 18 ? "Bon après-midi" :
      "Bonsoir";
  }
  if (subEl) {
    subEl.textContent = now.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
}

/* ------------------------------------------------------------------
   Statistiques (KPI + actions)
------------------------------------------------------------------- */

function paintStats(s) {
    const map = {
      totalProperties: s.totalProperties,
      totalTenants: s.totalTenants ?? 0,
      totalEmployees: s.totalEmployees ?? 0,
      paidRent: fmtShortFCFA(s.paidRent),
      lateRent: fmtShortFCFA(s.lateRent),
      activeIncidents: s.activeIncidents,
      activeInterventions: s.activeInterventions,
    };
    for (const [id, value] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    const tenantSub = document.getElementById("tenantSub");
    if (tenantSub) {
      const actifs = s.activeTenants ?? s.totalTenants ?? 0;
      tenantSub.textContent = `${actifs} actif(s) · ${s.totalProperties ?? 0} bien(s)`;
    }

    const employeeSub = document.getElementById("employeeSub");
    if (employeeSub) {
      const actifs = s.activeEmployees ?? 0;
      employeeSub.textContent = `${actifs} actif(s) sur ${s.totalEmployees ?? 0}`;
    }

    const incidentSub = document.getElementById("incidentSub");
    if (incidentSub) {
      incidentSub.textContent = s.activeIncidents > 0 ? `${s.activeIncidents} à traiter` : "Aucun incident en cours";
    }

    const interventionSub = document.getElementById("interventionSub");
    if (interventionSub) {
      interventionSub.textContent = s.activeInterventions > 0 ? `${s.activeInterventions} en cours` : "Aucune intervention en cours";
    }

    const propertySub = document.getElementById("propertySub");
    if (propertySub) {
      propertySub.textContent = `${s.occupiedProperties} occupé(s) · ${s.availableProperties} libre(s)`;
    }

    const rentPaidSub = document.getElementById("rentPaidSub");
    if (rentPaidSub) {
      rentPaidSub.textContent = `sur ${fmtFCFA(s.expectedRent)} attendus ce mois`;
    }

    const progress = document.getElementById("rentProgress");
    if (progress) {
      const pct = s.expectedRent > 0 ? Math.min(100, Math.round((s.paidRent / s.expectedRent) * 100)) : 0;
      progress.style.width = `${pct}%`;
    }

    const lateSub = document.getElementById("lateSub");
    if (lateSub) lateSub.textContent = s.lateCount > 0 ? `${s.lateCount} loyer(s) en retard` : "Aucun loyer en retard";

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

    setLiveLabel(`à jour · ${liveTime()}`);
}

async function fetchStats() {
  const res = await fetch(`${API}/stats/dashboard`, { credentials: "include" });
  const { ok, error, data } = await MIM.parse(res);
  if (!ok) {
    if (!MIM.handleAuthError(error)) displayMessage(MIM.userMessage(error));
    return null;
  }
  if (!data.success) {
    displayMessage(data.message || "Erreur de chargement.");
    return null;
  }
  return data.stats;
}

// Les KPI sont affichés depuis le cache de l'onglet dès l'ouverture de la
// page (MIM.swr), puis rafraîchis en arrière-plan : le dashboard ne monte
// plus en blanc à chaque changement de page.
async function loadStats() {
  try {
    await MIM.swr("prop:stats", fetchStats, paintStats).revalidate();
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
      return null;
    }
    if (data.user && data.user.account_type === "agence") {
      MIM.accountType = data.user.account_type;
      window.location.replace("/PartAgence/first_Mode/dashboard.html");
      return data.user;
    }
    const el = document.getElementById("ownerName");
    if (el) el.textContent = data.user && data.user.name;
    return data.user || null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/* ------------------------------------------------------------------
   Rendu des sections
------------------------------------------------------------------- */

function renderProperties(biens, logements) {
  const el = document.getElementById("propertiesList");
  if (!el) return;
  if (!biens.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">▤</span>Aucun bien pour le moment.</div>';
    return;
  }
  el.innerHTML = `<div class="property-list">${biens.slice(0, 6).map((b) => {
    const nb = logements.filter((l) => String(l.biens_id || l.bien_id) === String(b.id)).length;
    return `
      <div class="property-card">
        <h3>${escapeHtml(b.nom)}</h3>
        <p>${escapeHtml(b.type || "")}${b.ville ? " — " + escapeHtml(b.ville) : ""}</p>
        <p>${nb} logement${nb > 1 ? "s" : ""}</p>
      </div>`;
  }).join("")}</div>`;
}

function renderTenants(locataires, logements) {
  const el = document.getElementById("tenantsList");
  if (!el) return;
  if (!locataires.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">◉</span>Aucun locataire.</div>';
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

function renderPayments(paiements) {
  const summaryEl = document.getElementById("paymentsSummary");
  if (summaryEl) {
    const byStatut = (st) => paiements.filter((p) => p.statut === st);
    const rows = [
      ["ok", byStatut("paye")],
      ["pending", byStatut("attente")],
      ["danger", byStatut("retard")],
    ];
    summaryEl.querySelectorAll(".mini-stat").forEach((chip, i) => {
      const val = chip.querySelector(".mini-val");
      if (val && rows[i]) {
        val.textContent = fmtShortFCFA(rows[i][1].reduce((s, p) => s + Number(p.montant || 0), 0));
      }
    });
  }

  const recentEl = document.getElementById("recentPayments");
  if (!recentEl) return;
  if (!paiements.length) {
    recentEl.innerHTML = '<div class="empty-state"><span class="empty-ico">◈</span>Aucun paiement.</div>';
    return;
  }
  const sorted = [...paiements].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  recentEl.innerHTML = sorted.slice(0, 5).map((p) => {
    const locataire = paiementsLocataires.find((t) => String(t.id) === String(p.locataire_id));
    const logement = paiementsLogements.find((l) => String(l.id) === String(p.logement_id));
    const statusClass = p.statut === "paye" ? "ok" : p.statut === "retard" ? "impaye" : "pending";
    return `
      <div class="pay-line">
        <span class="pay-line-ico">◈</span>
        <div class="pay-line-body">
          <strong>${locataire ? escapeHtml(locataire.nom) : "Locataire inconnu"}</strong>
          <span>${escapeHtml(formatMois(p.mois))}${logement ? " · " + escapeHtml(logement.nom) : ""}</span>
        </div>
        <span class="pay-line-sum ${statusClass}">${fmtShortFCFA(p.montant)}</span>
      </div>`;
  }).join("");
}

function renderIncidents(incidents, logements) {
  const el = document.getElementById("recentIncidents");
  if (!el) return;
  if (!incidents.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">●</span>Aucun incident.</div>';
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
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">◆</span>Aucune intervention en cours.</div>';
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
  const unread = notifications.filter((n) => !n.lu).length;

  const badgeEl = document.getElementById("notifBadge");
  if (badgeEl) {
    badgeEl.textContent = unread;
    badgeEl.classList.toggle("show", unread > 0);
  }

  if (!el) return;
  if (!notifications.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">◉</span>Aucune notification.</div>';
    return;
  }
  el.innerHTML = `
    <div class="dash-notif-head ${unread ? "has-unread" : ""}">
      <span id="unreadCount">${unread} non lue${unread > 1 ? "s" : ""}</span>
      ${unread ? `<button class="btn btn-edit btn-sm" id="markAllBtn" type="button">Tout marquer lu</button>` : ""}
    </div>`
    + notifications.slice(0, 5).map((n) => `
    <div class="list-item ${n.lu ? "" : "unread"}">
      <div class="list-item-info">
                  <h3>${MIM.linkify(n.message)}</h3>
        <p>${formatDateTime(n.created_at)}</p>
      </div>
      <div class="card-actions">
        ${n.lu ? "" : `<button class="btn btn-edit btn-sm" data-mark-notif="${n.id}" title="Marquer comme lue">✓</button>`}
        <button class="btn btn-delete btn-sm" data-del-notif="${n.id}" title="Supprimer">✕</button>
      </div>
    </div>`).join("");
}

/* ------------------------------------------------------------------
   Graphiques CSS (donut occupation + barres loyers)
------------------------------------------------------------------- */

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function renderDonut(logements) {
  const donut = document.getElementById("occupancyDonut");
  const pctEl = document.getElementById("occupancyPct");
  const subEl = document.getElementById("occupancySub");
  const legendEl = document.getElementById("occupancyLegend");

  if (!donut || !legendEl) return;
  const total = logements.length;
  const occ = logements.filter((l) => l.statut === "occupe").length;
  const libre = logements.filter((l) => l.statut === "libre").length;
  const maint = logements.filter((l) => l.statut === "maintenance").length;
  const pct = total ? Math.round((occ / total) * 100) : 0;

  donut.style.setProperty("--val", pct);
  if (pctEl) pctEl.textContent = total ? `${pct}%` : "—";
  if (subEl) subEl.textContent = total ? `${total} logement(s) au total` : "Aucun logement enregistré";

  const items = [
    ["Occupés", occ, "#8b5cf6"],
    ["Libres", libre, "#60a5fa"],
    ["Maintenance", maint, "#e5a017"],
  ];
  legendEl.innerHTML = items
    .filter(([, c]) => total ? true : c > 0)
    .map(([label, count, color]) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${color};"></span>
        <span>${label}</span>
        <b>${count}</b>
      </div>`).join("") || '<div class="legend-item"><span class="legend-dot" style="background:#998bb8;"></span><span>Aucune donnée</span></div>';
}

function renderRentBars(paiements, expectedRent) {
  const barsEl = document.getElementById("rentBars");
  const subEl = document.getElementById("rentChartSub");
  if (!barsEl) return;

  const month = currentMonth();
  const monthPayments = paiements.filter((p) => p.mois === month);
  const byStatut = (st) => monthPayments.filter((p) => p.statut === st).reduce((s, p) => s + Number(p.montant || 0), 0);

  const rows = [
    ["Payé", byStatut("paye"), "green"],
    ["En attente", byStatut("attente"), "gold"],
    ["En retard", byStatut("retard"), "red"],
    ["À valider", byStatut("en_validation"), ""],
  ];

  if (subEl) subEl.textContent = rowLabel(expectedRent);

  barsEl.innerHTML = rows.map(([label, amount, cls]) => {
    const fill = expectedRent > 0 ? Math.min(100, Math.round((amount / expectedRent) * 100)) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${label}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="--fill:${fill};"></div></div>
        <span class="bar-value">${fmtShortFCFA(amount)}</span>
      </div>`;
  }).join("");
}

function rowLabel(expectedRent) {
  return `Attendu ce mois : ${fmtFCFA(expectedRent)}`;
}

/* ------------------------------------------------------------------
   Charges des listes (une passe = toutes les sections)
------------------------------------------------------------------- */

const paiementsLocataires = [];
const paiementsLogements = [];

async function fetchOverview() {
  const responsesData = await Promise.all([
    fetch(`${API}/biens`, { credentials: "include" }),
    fetch(`${API}/logements`, { credentials: "include" }),
    fetch(`${API}/locataires`, { credentials: "include" }),
    fetch(`${API}/paiements`, { credentials: "include" }),
    fetch(`${API}/incidents`, { credentials: "include" }),
    fetch(`${API}/prestataires`, { credentials: "include" }),
    fetch(`${API}/interventions`, { credentials: "include" }),
    fetch(`${API}/notifications`, { credentials: "include" }),
  ]);

  const notOk = responsesData.find((res) => !res.ok);
  if (notOk) {
    const { ok: parsedOk, error } = await MIM.parse(notOk);
    if (parsedOk || !MIM.handleAuthError(error)) throw new Error(MIM.userMessage(error) || "Erreur de chargement des données.");
  }

  const parse = async (res) => ((await res.json()).data || []);
  const data = await Promise.all(responsesData.map(parse));

  return {
    biens: data[0],
    logements: data[1],
    locataires: data[2],
    paiements: data[3],
    incidents: data[4],
    prestataires: data[5],
    interventions: data[6],
    notifications: data[7],
  };
}

function paintOverview(d) {
    const biens = d.biens;
    const logements = d.logements;
    const locataires = d.locataires;
    const paiements = d.paiements;
    const incidents = d.incidents;
    const prestataires = d.prestataires;
    const interventions = d.interventions;
    const notifications = d.notifications;

    paiementsLocataires.length = 0;
    paiementsLogements.length = 0;
    paiementsLocataires.push(...locataires);
    paiementsLogements.push(...logements);

    renderProperties(biens, logements);
    renderTenants(locataires, logements);
    renderPayments(paiements);
    renderIncidents(incidents, logements);
    renderInterventions(interventions, prestataires, logements);
    renderNotifications(notifications);
    renderDonut(logements);

    const expectedRent = logements
      .filter((l) => l.statut === "occupe")
      .reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0);
    renderRentBars(paiements, expectedRent);
}

// Listes du dashboard : affichage immédiat depuis le cache de l'onglet,
// puis revalidation en arrière-plan (voir MIM.swr dans mim-errors.js).
async function loadOverview() {
  try {
    await MIM.swr("prop:overview", fetchOverview, paintOverview).revalidate();
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

/* ------------------------------------------------------------------
   Bandeau abonnement
------------------------------------------------------------------- */

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
    el.innerHTML = "Aucun abonnement MIM enregistré. <a class='sub-link' href='abonnements.html'>Souscrire en ligne</a>.";
    el.hidden = false;
    return;
  }

  const days = subscription.joursRestants;

  if (subscription.statut === "expire" || days <= 0) {
    el.className = "sub-banner sub-banner-danger";
    el.innerHTML = `Votre abonnement MIM est <strong>expiré</strong> (le ${formatDate(subscription.date_expiration)}). <a class='sub-link' href='abonnements.html'>Renouveler en ligne</a>.`;
    el.hidden = false;
    return;
  }

  if (days <= 7) {
    el.className = "sub-banner sub-banner-warning";
    el.innerHTML = `Votre abonnement MIM expire dans <strong>${days} jour${days > 1 ? "s" : ""}</strong> (le ${formatDate(subscription.date_expiration)}). <a class='sub-link' href='abonnements.html'>Renouveler en ligne</a>.`;
    el.hidden = false;
    return;
  }

  el.hidden = true;
}

/* ------------------------------------------------------------------
   Actions inline (notifications)
------------------------------------------------------------------- */

async function deleteNotif(id) {
  try {
    await apiRequest(`/notifications/${id}`, { method: "DELETE" });
    showToast("Notification supprimée.");
    track(loadOverview());
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function markNotifRead(id) {
  try {
    await apiRequest(`/notifications/${id}`, {
      method: "PUT",
      body: JSON.stringify({ lu: true }),
    });
    track(loadOverview());
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function markAllNotifsRead() {
  const res = await fetch(`${API}/notifications`, { credentials: "include" });
  const { ok, data } = await MIM.parse(res);
  if (!ok || !data) return;

  const ids = (data.data || []).filter((n) => !n.lu).map((n) => n.id);
  try {
    await Promise.all(ids.map((id) =>
      apiRequest(`/notifications/${id}`, { method: "PUT", body: JSON.stringify({ lu: true }) })
    ));
    showToast("Toutes les notifications ont été marquées comme lues.");
  } catch (err) {
    showToast(err.message, "error");
  }
  track(loadOverview());
}

/* ------------------------------------------------------------------
   Initialisation + actualisation automatique
------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  setGreeting();
  initSkeletons();

  track(refreshAll());

  const refreshBtnEl = document.getElementById("refreshBtn");
  if (refreshBtnEl) refreshBtnEl.addEventListener("click", () => track(refreshAll()));

  const notifFeed = document.getElementById("recentNotifications");
  if (notifFeed) {
    notifFeed.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del-notif]");
      if (del) return deleteNotif(del.dataset.delNotif);
      const mark = e.target.closest("[data-mark-notif]");
      if (mark) return markNotifRead(mark.dataset.markNotif);
      const all = e.target.closest("#markAllBtn");
      if (all) return markAllNotifsRead();
    });
  }

  // Actualisation automatique : KPI + abonnement chaque minute,
  // listes complètes toutes les 3 minutes.
  setInterval(() => {
    if (!document.hidden) {
      track(loadStats());
      track(loadSubscriptionBanner());
    }
  }, 60_000);

  setInterval(() => {
    if (!document.hidden) track(loadOverview());
  }, 180_000);

  // Relance immédiate au retour sur l'onglet.
  document.addEventListener("visibilitychange", () => {
    const live = document.getElementById("liveIndicator");
    if (document.hidden) {
      live && live.classList.add("paused");
      setLiveLabel("en pause");
    } else {
      live && live.classList.remove("paused");
      track(refreshAll());
    }
  });

  Onboarding.maybeShow().catch(function () { /* assistant facultatif */ });
});