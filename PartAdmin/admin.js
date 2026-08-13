const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

async function apiRequest(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (res.status === 401) {
    window.location.href = "../PartPublic/connexion.html";
    throw new Error("Non authentifié.");
  }
  if (res.status === 403) {
    window.location.href = "../PartPublic/connexion.html";
    throw new Error("Accès réservé à l'administration.");
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.success === false) {
    const err = new Error(data.message || "Une erreur est survenue.");
    err.status = res.status;
    throw err;
  }

  return data;
}

const app = document.getElementById("app");

const sections = {
  dashboard: ["Dashboard", "Vue globale de la plateforme."],
  proprietaires: ["Propriétaires", "Gestion des comptes propriétaires."],
  locataires: ["Locataires", "Vue globale des locataires de MIM."],
  biens: ["Biens & logements", "Suivi du parc immobilier."],
  paiements: ["Paiements", "Suivi global des paiements."],
  incidents: ["Incidents", "Incidents et interventions."],
  activite: ["Activité", "Historique des événements de la plateforme."],
  parametres: ["Paramètres", "Configuration de l'administration."],
};

const LABELS = {
  paye: "Payé",
  attente: "En attente",
  retard: "En retard",
  nouveau: "Nouveau",
  en_cours: "En cours",
  resolu: "Résolu",
  actif: "Actif",
  inactif: "Inactif",
  libre: "Libre",
  occupe: "Occupé",
  maintenance: "Maintenance",
  planifie: "Planifiée",
  termine: "Terminée",
  suspendu: "Suspendu",
};

function label(value) {
  return LABELS[value] || value;
}

function badge(value) {
  const v = label(value).toLowerCase();
  let cls = v.includes("payé") || v.includes("actif") || v.includes("jour") || v.includes("résolu") || v.includes("terminée") ? "success"
          : v.includes("retard") || v.includes("suspend") || v.includes("attente") || v.includes("maintenance") || v.includes("planifiée") ? "warning"
          : v.includes("incident") || v.includes("nouveau") || v.includes("en cours") || v.includes("inactif") ? "danger" : "info";
  return `<span class="badge ${cls}">${label(value)}</span>`;
}

function money(n) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(n || 0)) + " FCFA";
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR");
}

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR") + ", " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2500);
}

const MONTH_LETTERS = ["S", "O", "N", "D", "J", "F", "M", "A", "M", "J", "J", "A"];
function monthLetter(ym) {
  const [y, m] = ym.split("-").map(Number);
  return MONTH_LETTERS[m - 1] || "?";
}

function statCard(label, value, trend, arrow, icon) {
  return `<div class="stat-card"><div class="stat-head"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div>${trend ? `<span class="trend ${arrow === "↘" ? "down" : "up"}">${arrow} ${trend}</span>` : ""}</div>`;
}

function activity(title, text, time) {
  return `<div class="activity-row"><i class="dot"></i><div><strong>${title}</strong><small>${text}</small><small>${time}</small></div></div>`;
}

function tablePage(title, data, columns, headers, actions, onAction) {
  return `<div class="panel">
    <div class="toolbar">
      <input class="search" id="tableSearch" placeholder="Rechercher dans ${title.toLowerCase()}...">
      <button class="btn" onclick="showToast('Création côté administration non disponible dans cette version.')">+ Ajouter</button>
      <button class="btn secondary" onclick="exportCSV()">Exporter CSV</button>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}${actions ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody id="tableBody">${rows(data, columns, actions, onAction)}</tbody></table></div>
  </div>`;
}

function rows(data, columns, actions, onAction) {
  if (!data || !data.length) return `<tr><td colspan="99" class="empty">Aucune donnée.</td></tr>`;
  const badgeCells = new Set(["statut", "status"]);
  return data.map((r) => `<tr>${columns.map((k) => `<td>${badgeCells.has(k) ? badge(r[k]) : (r[k] ?? "—")}</td>`).join("")}${actions && onAction ? `<td>${onAction(r)}</td>` : ""}</tr>`).join("");
}

function bindSearch() {
  const search = document.getElementById("tableSearch");
  if (!search) return;
  search.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll("#tableBody tr").forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });
}

function exportCSV() {
  const table = document.querySelector(".table");
  if (!table) return showToast("Aucune donnée à exporter.");
  const text = [...table.querySelectorAll("tr")]
    .map((tr) =>
      [...tr.querySelectorAll("th, td")]
        .filter((td) => td.textContent)
        .map((td) => `"${td.textContent.replace(/"/g, '""')}"`)
        .join(";")
    )
    .join("\r\n");
  const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mim-admin-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Export CSV téléchargé.");
}

// ============================================================
// Sections
// ============================================================

async function dashboard() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { stats } = await apiRequest("/admin/stats");

  const notif = document.getElementById("notificationCount");
  if (notif) notif.textContent = stats.paiementsEnRetard + stats.incidentsActifs;

  const maxRev = Math.max(...stats.revenue12.map((r) => r.total), 1);
  const chart = stats.revenue12.map((r) => {
    const pct = Math.max(4, Math.round((r.total / maxRev) * 100));
    const value = r.total >= 1_000_000 ? `${(r.total / 1_000_000).toFixed(1)}M` : `${Math.round(r.total / 1000)}k`;
    return `<div class="bar-wrap"><span class="bar-value">${value}</span><div class="bar" style="height:${pct}%"></div><span class="bar-label">${monthLetter(r.mois)}</span></div>`;
  }).join("");

  const paiements = await apiRequest("/admin/paiements");
  const incidents = await apiRequest("/admin/incidents");
  const recentPayments = (paiements.data || []).slice(0, 5);
  const recentIncidents = (incidents.data || []).slice(0, 4);

  app.innerHTML = `
  <div class="cards">
    ${statCard("Propriétaires", stats.proprietaires, null, null, "◉")}
    ${statCard("Locataires", stats.locataires, null, null, "◎")}
    ${statCard("Biens", stats.biens, null, null, "▣")}
    ${statCard("Revenus du mois", money(stats.revenusMois), null, null, "₣")}
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-header"><h2>Revenus — 12 derniers mois</h2><small>FCFA</small></div>
      <div class="chart">${chart}</div>
    </div>
    <div class="panel"><div class="panel-header"><h2>Activité récente</h2><small>plateforme</small></div>
      <div class="activity">
        ${(stats.activiteRecent || []).map((a) => activity(a.title, a.detail, fmtDateTime(a.time))).join("") || `<div class="empty">Aucune activité.</div>`}
      </div>
    </div>
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-header"><h2>Paiements récents</h2><button class="btn secondary" onclick="navigate('paiements')">Voir tout</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Locataire</th><th>Période</th><th>Montant</th><th>Statut</th></tr></thead>
      <tbody>${recentPayments.map((r) => `<tr><td>${r.locataire}</td><td>${r.periode}</td><td>${money(r.montant)}</td><td>${badge(r.statut)}</td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="panel"><div class="panel-header"><h2>Incidents</h2><button class="btn secondary" onclick="navigate('incidents')">Voir tout</button></div>
      <div class="activity">${recentIncidents.map((r) => activity(r.titre, `${r.logement} — ${r.locataire}`, badge(r.statut))).join("") || `<div class="empty">Aucun incident.</div>`}</div>
    </div>
  </div>`;
}

async function proprietaires() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/proprietaires");
  const rows = (data || []).map((r) => ({ ...r, last_login: fmtDateTime(r.last_login) }));
  app.innerHTML = tablePage(
    "propriétaires",
    rows,
    ["id", "nom", "email", "biens", "statut", "last_login"],
    ["ID", "Nom", "Email", "Biens", "Statut", "Dernière connexion"],
    true,
    (r) =>
      `<button class="btn secondary" onclick="showToast('${r.nom} — ${r.biens} biens')">Voir</button>
       <button class="btn ${r.statut === "suspendu" ? "secondary" : "danger"}" onclick="setStatut('${r.id}','${r.statut}')">${r.statut === "suspendu" ? "Réactiver" : "Suspendre"}</button>`
  );
  bindSearch();
}

async function locataires() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/locataires");
  app.innerHTML = tablePage("locataires", data, ["id", "nom", "proprietaire", "logement", "statut"], ["ID", "Nom", "Propriétaire", "Logement", "Statut"], true, (r) => `<button class="btn secondary" onclick="showToast('${r.nom}')">Voir</button>`);
  bindSearch();
}

async function biens() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/biens");
  app.innerHTML = tablePage("biens", data, ["id", "nom", "logements", "occupes", "proprietaire"], ["ID", "Bien", "Logements", "Occupés", "Propriétaire"], true, (r) => `<button class="btn secondary" onclick="showToast('${r.nom}')">Voir</button>`);
  bindSearch();
}

async function paiements() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/paiements");
  const rows = (data || []).map((r) => ({
    id: r.id,
    locataire: r.locataire,
    periode: r.periode,
    montant: money(r.montant),
    statut: r.statut,
    _amount: r.montant,
  }));
  app.innerHTML = tablePage("paiements", rows, ["id", "locataire", "periode", "montant", "statut"], ["ID", "Locataire", "Période", "Montant", "Statut"], true, (r) => `<button class="btn secondary" onclick="showToast('${r.locataire} — ${money(r._amount)}')">Voir</button>`);
  bindSearch();
}

async function incidents() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/incidents");
  const rows = (data || []).map((r) => ({ ...r, date: fmtDate(r.date) }));
  app.innerHTML = tablePage("incidents", rows, ["id", "titre", "locataire", "statut", "date"], ["ID", "Incident", "Locataire", "Statut", "Date"], true, (r) => `<button class="btn secondary" onclick="showToast('${r.titre}')">Voir</button>`);
  bindSearch();
}

async function activite() {
  app.innerHTML = `<div class="empty">Chargement…</div>`;
  const { data } = await apiRequest("/admin/activite");
  app.innerHTML = `<div class="panel"><div class="panel-header"><h2>Journal d'activité</h2><small>100 derniers événements</small></div>
    <div class="activity">${(data || []).map((a) => activity(a.action, `${a.user} — ${a.detail}`, a.date)).join("") || `<div class="empty">Aucune activité.</div>`}</div></div>`;
}

async function parametres() {
  app.innerHTML = `<div class="panel"><div class="panel-header"><h2>Configuration</h2></div><div class="settings">
    <div class="field"><label>Nom de la plateforme</label><input value="MyImmoManagement"></div>
    <div class="field"><label>Email administrateur</label><input type="email" value="admin@mim.local"></div>
    <div class="switch-row"><span><strong>Notifications système</strong><small>Recevoir les alertes importantes.</small></span><div class="switch on"><i></i></div></div>
    <div class="switch-row"><span><strong>Mode maintenance</strong><small>Bloquer temporairement les nouveaux accès.</small></span><div class="switch"><i></i></div></div>
    <button class="btn" onclick="showToast('Configuration de la plateforme non disponible dans cette version.')">Enregistrer</button>
  </div></div>`;
  document.querySelectorAll(".switch").forEach((s) => s.addEventListener("click", () => s.classList.toggle("on")));
}

const RENDERERS = { dashboard, proprietaires, locataires, biens, paiements, incidents, activite, parametres };

// ============================================================
// Navigation & actions
// ============================================================

async function navigate(section) {
  if (!RENDERERS[section]) return;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
  document.getElementById("pageTitle").textContent = sections[section][0];
  document.getElementById("pageSubtitle").textContent = sections[section][1];
  document.getElementById("sidebar").classList.remove("open");
  try {
    await RENDERERS[section]();
  } catch (err) {
    app.innerHTML = `<div class="empty">Erreur : ${err.message}</div>`;
  }
}

async function setStatut(id, statut) {
  const next = statut === "suspendu" ? "actif" : "suspendu";
  try {
    const r = await apiRequest(`/admin/proprietaires/${id}`, { method: "PATCH", body: JSON.stringify({ statut: next }) });
    showToast(r.message);
    navigate("proprietaires");
  } catch (err) {
    showToast(err.message);
  }
}

// ============================================================
// Init
// ============================================================

async function init() {
  try {
    const { user } = await apiRequest("/auth/me");
    if (user.account_type !== "admin") {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }
    document.querySelector(".admin-mini strong").textContent = user.name || "Admin MIM";
  } catch {
    return;
  }

  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.section)));
  document.getElementById("refreshBtn").addEventListener("click", () => {
    const active = document.querySelector(".nav-item.active").dataset.section;
    navigate(active);
    showToast("Actualisé");
  });
  document.getElementById("menuBtn").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "../PartPublic/connexion.html";
  });

  navigate("dashboard");
}

init();
