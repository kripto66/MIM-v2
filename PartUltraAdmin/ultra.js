const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

let currentSection = "dashboard";

// ============================================================
// Progress Bar
// ============================================================

let progressActive = false;
let progressTimer = null;

function showProgress(label, color) {
  const container = document.getElementById("progressContainer");
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  if (!container || !bar || !lbl) return;
  progressActive = true;
  bar.style.width = "0%";
  bar.removeAttribute("data-color");
  if (color) bar.setAttribute("data-color", color);
  container.classList.add("active");
  lbl.textContent = label || "Chargement…";
  lbl.classList.add("active");
  let progress = 0;
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!progressActive) return;
    progress += Math.random() * 12 + 3;
    if (progress >= 90) progress = 90;
    bar.style.width = progress + "%";
  }, 200);
}

function updateProgress(pct, label) {
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  if (bar) bar.style.width = Math.min(pct, 99) + "%";
  if (lbl && label) lbl.textContent = label;
}

function hideProgress() {
  const container = document.getElementById("progressContainer");
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  progressActive = false;
  clearInterval(progressTimer);
  if (bar) bar.style.width = "100%";
  setTimeout(() => {
    if (container) container.classList.remove("active");
    if (lbl) lbl.classList.remove("active");
    if (bar) bar.style.width = "0%";
  }, 400);
}

// ============================================================
// Helpers
// ============================================================

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function skeleton() {
  const cards = Array(8).fill('<div class="skeleton-card"></div>').join("");
  return `<div class="skeleton-grid">${cards}</div>
    <div class="skeleton-panel"></div>
    <div class="skeleton-panel"></div>`;
}

function badge(value) {
  const v = String(value || "").toLowerCase();
  let cls = "info";
  if (v.includes("actif") || v.includes("actifs") || v.includes("published") || v.includes("publishé") || v.includes("versé") || v.includes("success") || v.includes("online")) cls = "success";
  else if (v.includes("suspend") || v.includes("retard") || v.includes("critical") || v.includes("critique") || v.includes("offline") || v.includes("hors")) cls = "danger";
  else if (v.includes("attente") || v.includes("pending") || v.includes("brouillon") || v.includes("draft") || v.includes("archivé") || v.includes("archived") || v.includes("cancelled") || v.includes("annulé") || v.includes("expired") || v.includes("expiré") || v.includes("warn") || v.includes("avertissement")) cls = "warning";
  return `<span class="badge ${cls}">${escapeHtml(value || "—")}</span>`;
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
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), 2500);
}

function statCard(cfg) {
  const value = cfg.money ? money(cfg.raw) : Number(cfg.raw || 0).toLocaleString("fr-FR");
  return `<div class="stat-card" data-tilt style="--d:${cfg.d || 0}s">
    <div class="stat-head"><span>${escapeHtml(cfg.label)}</span><span class="stat-icon">${cfg.icon || ""}</span></div>
    <div class="stat-value">${value}</div>
    <div class="stat-sub">${escapeHtml(cfg.sub || "")}</div>
  </div>`;
}

function activity(title, text, time) {
  const safeTitle = typeof title === "string" ? escapeHtml(title) : (title ?? "");
  const safeText = typeof text === "string" ? escapeHtml(text) : (text ?? "");
  const safeTime = typeof time === "string" ? escapeHtml(time) : (time ?? "");
  return `<div class="activity-row"><i class="dot"></i><div><strong>${safeTitle}</strong>${safeText ? `<small>${safeText}</small>` : ""}${safeTime ? `<small>${safeTime}</small>` : ""}</div></div>`;
}

function tablePage(title, data, columns, headers, actions, onAction) {
  return `<div class="panel">
    <div class="toolbar">
      <input class="search" id="tableSearch" placeholder="Rechercher dans ${escapeHtml(title.toLowerCase())}..." aria-label="Rechercher dans ${escapeHtml(title.toLowerCase())}">
      <button class="btn secondary" onclick="exportCSV()">Exporter CSV</button>
      ${typeof actions === "string" ? actions : ""}
    </div>
    <div class="table-wrap"><table class="table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}${onAction ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody id="tableBody">${buildRows(data, columns, onAction)}</tbody></table></div>
  </div>`;
}

function buildRows(data, columns, onAction) {
  if (!data || !data.length) return `<tr><td colspan="99" class="empty">Aucune donnée.</td></tr>`;
  const badgeCells = new Set(["statut", "status", "level", "role"]);
  return data.map((r) => `<tr>${columns.map((k) => {
    if (badgeCells.has(k)) return `<td>${badge(r[k])}</td>`;
    if (k === "montant") return `<td class="num">${money(r[k])}</td>`;
    const val = r[k];
    return `<td>${val != null ? escapeHtml(String(val)) : "—"}</td>`;
  }).join("")}${onAction ? `<td>${onAction(r)}</td>` : ""}</tr>`).join("");
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
  a.download = `mim-ultra-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Export CSV téléchargé.");
}

function animateCounts() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count || "0");
    const isMoney = el.dataset.fmt === "money";
    el.textContent = isMoney ? money(target) : target.toLocaleString("fr-FR");
  });
}

function enableTilt() {
  if (reducedMotion) return;
  if (!window.matchMedia("(pointer: fine)").matches) return;
  document.querySelectorAll("[data-tilt]").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty("--rx", (py * -6).toFixed(2) + "deg");
      card.style.setProperty("--ry", (px * 8).toFixed(2) + "deg");
      card.style.setProperty("--mx", (px * 100 + 50).toFixed(2) + "%");
      card.style.setProperty("--my", (py * 100 + 50).toFixed(2) + "%");
    });
    card.addEventListener("mouseleave", () => {
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    });
  });
}

// ============================================================
// API helper
// ============================================================

async function apiRequest(path, options = {}) {
  await MIM._csrfReady;
  const csrf = MIM.csrfHeader();
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...csrf, ...(options.headers || {}) },
    ...options,
  });
  const { ok, error, data } = await MIM.parse(res);
  if (!ok) {
    MIM.handleAuthError(error);
    throw error;
  }
  return data;
}

// ============================================================
// Confirmation modal
// ============================================================

let confirmResolve = null;

function confirmAction(title, message, opts = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmMessage").textContent = message;
    const inputGroup = document.getElementById("confirmInputGroup");
    const inputEl = document.getElementById("confirmInput");
    const inputLabel = document.getElementById("confirmInputLabel");
    if (opts.input) {
      inputGroup.style.display = "";
      inputLabel.textContent = opts.inputLabel || "";
      inputEl.value = "";
      inputEl.placeholder = opts.inputPlaceholder || "";
    } else {
      inputGroup.style.display = "none";
    }
    document.getElementById("confirmModal").classList.add("active");
    const confirmBtn = document.getElementById("confirmBtn");
    confirmBtn.textContent = opts.confirmText || "Confirmer";
    confirmBtn.className = opts.btnClass || "btn danger";
    if (opts.input) {
      setTimeout(() => inputEl.focus(), 100);
    }
  });
}

function resolveConfirm(value) {
  document.getElementById("confirmModal").classList.remove("active");
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
}

// ============================================================
// Canvas particles
// ============================================================

function initBackground() {
  const canvas = document.getElementById("bgCanvas");
  if (!canvas || reducedMotion) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let w = 0;
  let h = 0;
  let particles = [];
  let raf = null;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  function size() {
    w = canvas.offsetWidth;
    h = canvas.offsetHeight;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function spawn() {
    const count = w < 600 ? 26 : 64;
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.6 + 0.5,
      vx: (Math.random() - 0.5) * 0.18,
      vy: -(Math.random() * 0.22 + 0.04),
      a: Math.random() * 0.4 + 0.12,
      c: ["168,85,247", "217,70,239", "34,211,238"][Math.floor(Math.random() * 3)],
    }));
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      if (p.x < -4) p.x = w + 4;
      if (p.x > w + 4) p.x = -4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},${p.a})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (document.hidden) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function stop() { cancelAnimationFrame(raf); }

  window.addEventListener("resize", () => { size(); spawn(); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  size();
  spawn();
  start();
}

// ============================================================
// System status
// ============================================================

async function initSystemStatus() {
  const el = document.getElementById("sysStatus");
  if (!el) return;
  const text = el.querySelector(".sys-text");
  const set = (state, msg) => {
    el.dataset.state = state;
    if (text) text.textContent = msg;
  };
  set("checking", "VÉRIFICATION...");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${API}/health`, { credentials: "include", signal: ctrl.signal });
    clearTimeout(timer);
    set(res.ok ? "online" : "offline", res.ok ? "SYSTEM ONLINE" : "SYSTEM OFFLINE");
  } catch {
    clearTimeout(timer);
    set("offline", "SYSTEM OFFLINE");
  }
}

// ============================================================
// Sections metadata
// ============================================================

const sections = {
  dashboard: ["Vue globale", "Tableau de bord Super Admin."],
  admins: ["Administrateurs", "Gestion des comptes administrateurs et ultra-admins."],
  users: ["Utilisateurs", "Vue globale de tous les utilisateurs de la plateforme."],
  saas: ["Gestion SaaS", "Contrôle de l'état de la plateforme SaaS."],
  announcements: ["Annonces", "Gestion des annonces publiées sur la plateforme."],
  events: ["Événements", "Gestion des événements de la plateforme."],
  featured: ["Mise en avant", "Éléments mis en avant sur la plateforme."],
  audit: ["Journal d'audit", "Historique des actions critiques de la plateforme."],
};

const LABELS = {
  actif: "Actif",
  inactif: "Inactif",
  suspendu: "Suspendu",
  admin: "Admin",
  ultra_admin: "Ultra Admin",
  proprietaire: "Propriétaire",
  locataire: "Locataire",
  published: "Publié",
  draft: "Brouillon",
  archived: "Archivé",
  cancelled: "Annulé",
  info: "Info",
  warn: "Avertissement",
  critical: "Critique",
  active: "Actif",
  suspended: "Suspendu",
};

function label(value) {
  return LABELS[value] || value;
}

// ============================================================
// Section: Dashboard
// ============================================================

async function dashboard() {
  app.innerHTML = skeleton();
  const [statsData, auditData] = await Promise.all([
    apiRequest("/ultra-admin/stats"),
    apiRequest("/ultra-admin/audit?limit=10"),
  ]);
  const stats = statsData.data || statsData;
  const auditLogs = (auditData.data || auditData || []);

  const saasActive = !stats.saasSuspended;

  app.innerHTML = `
  <div class="stat-grid">
    ${statCard({ label: "Propriétaires", icon: "👥", raw: stats.proprietaires || 0, sub: "Comptes propriétaires", d: 0 })}
    ${statCard({ label: "Locataires", icon: "👤", raw: stats.locataires || 0, sub: "Comptes locataires", d: 0.04 })}
    ${statCard({ label: "Biens", icon: "🏢", raw: stats.biens || 0, sub: "Biens enregistrés", d: 0.08 })}
    ${statCard({ label: "Admins", icon: "🛡️", raw: stats.admins || 0, sub: `${stats.ultra_admins || 0} ultra-admins`, d: 0.12 })}
    ${statCard({ label: "Paiements", icon: "💳", raw: stats.paiements || 0, sub: "Transactions totales", d: 0.16 })}
    ${statCard({ label: "Incidents critiques (semaine)", icon: "⚠️", raw: stats.criticalAuditWeek || 0, sub: "7 derniers jours", d: 0.2 })}
  </div>

  <div class="panel" style="margin-top:1rem">
    <div class="saas-banner ${saasActive ? "active" : "suspended"}">
      <div class="saas-dot"></div>
      <div>
        <h3>SaaS ${saasActive ? "Actif" : "Suspendu"}</h3>
        <p>${saasActive ? "La plateforme fonctionne normalement pour tous les utilisateurs." : "La plateforme est en mode suspension. Les utilisateurs ne peuvent pas se connecter."}</p>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:1rem">
    <div class="panel-header"><h2>Journal d'audit récent</h2><span class="panel-tag">10 dernières entrées</span></div>
    <div class="table-wrap"><table class="table"><thead><tr>
      <th>Utilisateur</th><th>Action</th><th>Cible</th><th>Niveau</th><th>Date</th>
    </tr></thead><tbody>${auditLogs.length ? auditLogs.map((l) => `<tr>
      <td>${escapeHtml(l.user_name || "—")}</td>
      <td>${escapeHtml(l.action || "—")}</td>
      <td>${escapeHtml((l.target_type || "—") + (l.target_id ? "#" + l.target_id : ""))}</td>
      <td>${badge(l.level || "info")}</td>
      <td>${fmtDateTime(l.created_at)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty">Aucune entrée d'audit.</td></tr>`}</tbody></table></div>
  </div>`;

  enableTilt();
  animateCounts();
}

// ============================================================
// Section: Admins
// ============================================================

async function admins() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/admins");
  const rows = (data || []).map((r) => ({
    ...r,
    created_at: fmtDateTime(r.created_at),
    last_login: r.last_login ? fmtDateTime(r.last_login) : "Jamais",
  }));

  const createBtn = `<button class="btn primary" id="openCreateAdminModal">+ Créer un Admin</button>`;

  app.innerHTML = tablePage(
    "administrateurs",
    rows,
    ["name", "email", "username", "role", "statut", "created_at", "last_login"],
    ["Nom", "Email", "Username", "Rôle", "Statut", "Créé le", "Dernière connexion"],
    createBtn,
    (r) => {
      const btns = [];
      if (r.statut === "suspendu") {
        btns.push(`<button class="btn primary" data-action="reactivateAdmin" data-id="${escapeHtml(r.id)}">Réactiver</button>`);
      } else {
        btns.push(`<button class="btn danger" data-action="suspendAdmin" data-id="${escapeHtml(r.id)}">Suspendre</button>`);
      }
      if (r.role === "admin") {
        btns.push(`<button class="btn secondary" data-action="removeAdminRole" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.name)}">Retirer le rôle</button>`);
      }
      return btns.join(" ");
    }
  );
  bindSearch();

  document.getElementById("openCreateAdminModal")?.addEventListener("click", () => {
    document.getElementById("createAdminModal").classList.add("active");
  });
}

// ============================================================
// Section: Users
// ============================================================

let usersData = [];

async function users() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/users");
  usersData = data || [];

  renderUsersTable(usersData);
}

function renderUsersTable(list) {
  const rows = list.map((r) => ({
    ...r,
    created_at: fmtDateTime(r.created_at),
  }));

  const filterHtml = `<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
    <input class="search" id="userSearch" placeholder="Rechercher un utilisateur..." aria-label="Rechercher">
    <select class="search" id="userTypeFilter" aria-label="Filtrer par type">
      <option value="">Tous les types</option>
      <option value="proprietaire">Propriétaire</option>
      <option value="locataire">Locataire</option>
    </select>
  </div>`;

  app.innerHTML = tablePage(
    "utilisateurs",
    rows,
    ["name", "email", "username", "account_type", "statut", "created_at"],
    ["Nom", "Email", "Username", "Type", "Statut", "Créé le"],
    filterHtml,
    (r) => {
      if (r.account_type === "proprietaire") {
        return r.statut === "suspendu"
          ? `<button class="btn primary" data-action="reactivateUser" data-id="${escapeHtml(r.id)}">Réactiver</button>`
          : `<button class="btn danger" data-action="suspendUser" data-id="${escapeHtml(r.id)}">Suspendre</button>`;
      }
      return "—";
    }
  );

  const searchEl = document.getElementById("userSearch");
  const filterEl = document.getElementById("userTypeFilter");

  function applyFilters() {
    const q = (searchEl?.value || "").toLowerCase();
    const type = filterEl?.value || "";
    const filtered = usersData.filter((r) => {
      const matchSearch = !q || (r.name || "").toLowerCase().includes(q) || (r.email || "").toLowerCase().includes(q) || (r.username || "").toLowerCase().includes(q);
      const matchType = !type || r.account_type === type;
      return matchSearch && matchType;
    });
    renderUsersTableInner(filtered);
  }

  searchEl?.addEventListener("input", applyFilters);
  filterEl?.addEventListener("change", applyFilters);
}

function renderUsersTableInner(list) {
  const tbody = document.getElementById("tableBody");
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">Aucune donnée.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((r) => `<tr>
    <td>${escapeHtml(r.name || "—")}</td>
    <td>${escapeHtml(r.email || "—")}</td>
    <td>${escapeHtml(r.username || "—")}</td>
    <td>${badge(r.account_type || "—")}</td>
    <td>${badge(r.statut || "—")}</td>
    <td>${fmtDateTime(r.created_at)}</td>
    <td>${r.account_type === "proprietaire"
      ? (r.statut === "suspendu"
        ? `<button class="btn primary" data-action="reactivateUser" data-id="${escapeHtml(r.id)}">Réactiver</button>`
        : `<button class="btn danger" data-action="suspendUser" data-id="${escapeHtml(r.id)}">Suspendre</button>`)
      : "—"}</td>
  </tr>`).join("");
}

// ============================================================
// Section: SaaS
// ============================================================

async function saas() {
  app.innerHTML = skeleton();
  const { stats } = await apiRequest("/ultra-admin/stats").catch(() => ({}));
  let isActive = true;
  try {
    const { suspended } = await apiRequest("/ultra-admin/saas/status");
    isActive = !suspended;
  } catch {}

  app.innerHTML = `
  <div class="panel" style="margin-bottom:1.5rem">
    <div class="saas-banner ${isActive ? "active" : "suspended"}">
      <div class="saas-dot"></div>
      <div>
        <h3 style="margin:0 0 4px">SaaS ${isActive ? "Actif" : "Suspendu"}</h3>
        <p style="margin:0;font-size:13px">${isActive
          ? "La plateforme fonctionne normalement. Tous les utilisateurs ont accès."
          : "La plateforme est en mode suspension. Les utilisateurs ne peuvent pas se connecter."}</p>
      </div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
    <div class="stat-card" style="flex-direction:column;align-items:flex-start;gap:10px">
      <div class="stat-head"><span>Suspendre le SaaS</span><span class="stat-icon red">⏸️</span></div>
      <p style="margin:0;font-size:13px;color:var(--dim);line-height:1.5">Désactive l'accès à la plateforme pour tous les utilisateurs non-admin.</p>
      <button class="btn danger" data-action="ultraSuspendSaas" ${!isActive ? "disabled" : ""}>Suspendre le SaaS</button>
    </div>
    <div class="stat-card" style="flex-direction:column;align-items:flex-start;gap:10px">
      <div class="stat-head"><span>Réactiver le SaaS</span><span class="stat-icon green">▶️</span></div>
      <p style="margin:0;font-size:13px;color:var(--dim);line-height:1.5">Restaure l'accès à la plateforme pour tous les utilisateurs après une suspension.</p>
      <button class="btn primary" data-action="ultraReactivateSaas" ${isActive ? "disabled" : ""}>Réactiver le SaaS</button>
    </div>
  </div>`;

  enableTilt();
}

// ============================================================
// Section: Announcements
// ============================================================

async function announcements() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/announcements");
  const rows = (data || []).map((r) => ({
    ...r,
    published_at: r.published_at ? fmtDateTime(r.published_at) : "—",
    created_at: fmtDateTime(r.created_at),
  }));

  const createBtn = `<button class="btn primary" id="openCreateAnnouncementModal">+ Créer une Annonce</button>`;

  app.innerHTML = tablePage(
    "annonces",
    rows,
    ["title", "audience", "status", "published_at", "created_at"],
    ["Titre", "Audience", "Statut", "Publiée le", "Créée le"],
    createBtn,
    (r) => {
      const btns = [];
      if (r.status === "draft" || r.status === "archived") {
        btns.push(`<button class="btn primary" data-action="publishAnnouncement" data-id="${escapeHtml(r.id)}">Publier</button>`);
      }
      if (r.status === "published") {
        btns.push(`<button class="btn secondary" data-action="archiveAnnouncement" data-id="${escapeHtml(r.id)}">Archiver</button>`);
      }
      btns.push(`<button class="btn danger" data-action="deleteAnnouncement" data-id="${escapeHtml(r.id)}" data-title="${escapeHtml(r.title)}">Supprimer</button>`);
      return btns.join(" ");
    }
  );
  bindSearch();

  document.getElementById("openCreateAnnouncementModal")?.addEventListener("click", () => {
    openAnnouncementModal();
  });
}

function openAnnouncementModal(announcement) {
  const modal = document.getElementById("createAnnouncementModal");
  if (!modal) return;
  const form = document.getElementById("createAnnouncementForm");
  if (form) form.reset();
  document.getElementById("announcementFormTitle").textContent = announcement ? "Modifier l'Annonce" : "Créer une Annonce";
  if (announcement) {
    document.getElementById("announcementTitle").value = announcement.title || "";
    document.getElementById("announcementBody").value = announcement.body || "";
    document.getElementById("announcementAudience").value = announcement.audience || "all";
    form.dataset.editId = announcement.id;
  } else {
    delete form.dataset.editId;
  }
  modal.classList.add("active");
}

// ============================================================
// Section: Events
// ============================================================

async function events() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/events");
  const rows = (data || []).map((r) => ({
    ...r,
    event_date: r.event_date ? fmtDateTime(r.event_date) : "—",
    created_at: fmtDateTime(r.created_at),
  }));

  const createBtn = `<button class="btn primary" id="openCreateEventModal">+ Créer un Événement</button>`;

  app.innerHTML = tablePage(
    "événements",
    rows,
    ["title", "event_date", "audience", "status", "created_at"],
    ["Titre", "Date", "Audience", "Statut", "Créé le"],
    createBtn,
    (r) => {
      const btns = [];
      if (r.status === "draft" || r.status === "cancelled") {
        btns.push(`<button class="btn primary" data-action="publishEvent" data-id="${escapeHtml(r.id)}">Publier</button>`);
      }
      if (r.status === "published") {
        btns.push(`<button class="btn secondary" data-action="cancelEvent" data-id="${escapeHtml(r.id)}">Annuler</button>`);
      }
      btns.push(`<button class="btn danger" data-action="deleteEvent" data-id="${escapeHtml(r.id)}" data-title="${escapeHtml(r.title)}">Supprimer</button>`);
      return btns.join(" ");
    }
  );
  bindSearch();

  document.getElementById("openCreateEventModal")?.addEventListener("click", () => {
    openEventModal();
  });
}

function openEventModal(eventData) {
  const modal = document.getElementById("createEventModal");
  if (!modal) return;
  const form = document.getElementById("createEventForm");
  if (form) form.reset();
  document.getElementById("eventFormTitle").textContent = eventData ? "Modifier l'Événement" : "Créer un Événement";
  if (eventData) {
    document.getElementById("eventTitle").value = eventData.title || "";
    document.getElementById("eventDescription").value = eventData.description || "";
    if (eventData.event_date) {
      const d = new Date(eventData.event_date);
      if (!Number.isNaN(d.getTime())) {
        document.getElementById("eventDate").value = d.toISOString().slice(0, 16);
      }
    }
    document.getElementById("eventAudience").value = eventData.audience || "all";
    form.dataset.editId = eventData.id;
  } else {
    delete form.dataset.editId;
  }
  modal.classList.add("active");
}

// ============================================================
// Section: Featured
// ============================================================

async function featured() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/featured");
  const items = data || [];

  const createBtn = `<button class="btn primary" id="openCreateFeaturedModal">+ Ajouter en Avant</button>`;

  let html = `<div class="panel">
    <div class="toolbar">
      <input class="search" id="tableSearch" placeholder="Rechercher..." aria-label="Rechercher">
      <button class="btn secondary" onclick="exportCSV()">Exporter CSV</button>
      ${createBtn}
    </div>`;

  if (!items.length) {
    html += `<div class="empty" style="padding:2rem">Aucun élément mis en avant.</div>`;
  } else {
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem;padding:1rem">`;
    items.forEach((r) => {
      html += `<div class="stat-card" data-tilt style="--d:0s">
        <div class="stat-head"><span>${escapeHtml(r.target_type || "—")}</span><span class="badge info">Priorité ${Number(r.priority || 0)}</span></div>
        <div class="stat-sub" style="margin:0.5rem 0">
          <div><strong>ID cible :</strong> ${escapeHtml(String(r.target_id || "—"))}</div>
          <div><strong>Badge :</strong> ${escapeHtml(r.badge || "—")}</div>
          <div><strong>Jusqu'au :</strong> ${fmtDate(r.featured_until)}</div>
        </div>
        <button class="btn danger" data-action="deleteFeatured" data-id="${escapeHtml(r.id)}">Supprimer</button>
      </div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  app.innerHTML = html;
  bindSearch();
  enableTilt();
}

// ============================================================
// Section: Audit
// ============================================================

let auditData = [];

async function audit() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/ultra-admin/audit?limit=100");
  auditData = data || [];

  renderAuditTable(auditData);
}

function renderAuditTable(list) {
  const rows = list.map((r) => ({
    ...r,
    created_at: fmtDateTime(r.created_at),
  }));

  const filterHtml = `<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
    <input class="search" id="auditSearch" placeholder="Rechercher dans le journal..." aria-label="Rechercher">
    <select class="search" id="auditLevelFilter" aria-label="Filtrer par niveau">
      <option value="">Tous les niveaux</option>
      <option value="info">Info</option>
      <option value="warn">Avertissement</option>
      <option value="critical">Critique</option>
    </select>
    <select class="search" id="auditActionFilter" aria-label="Filtrer par action">
      <option value="">Toutes les actions</option>
    </select>
  </div>`;

  const allActions = [...new Set(auditData.map((l) => l.action).filter(Boolean))];
  const actionOptions = allActions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  const fullFilterHtml = filterHtml.replace('<!-- ACTIONS_PLACEHOLDER -->', "").replace(
    `<option value="">Toutes les actions</option>`,
    `<option value="">Toutes les actions</option>${actionOptions}`
  );

  app.innerHTML = tablePage(
    "journal d'audit",
    rows,
    ["user_name", "action", "target_type", "target_id", "level", "created_at"],
    ["Utilisateur", "Action", "Type cible", "ID cible", "Niveau", "Date"],
    fullFilterHtml,
    (r) => {
      let metaStr = "—";
      if (r.meta && typeof r.meta === "object") {
        try { metaStr = JSON.stringify(r.meta).slice(0, 80); } catch { metaStr = "—"; }
      } else if (r.meta) {
        metaStr = String(r.meta).slice(0, 80);
      }
      return `<span title="${escapeHtml(metaStr)}" style="cursor:help;color:var(--muted,#94a3b8)">ℹ️</span>`;
    }
  );

  const searchEl = document.getElementById("auditSearch");
  const levelEl = document.getElementById("auditLevelFilter");
  const actionEl = document.getElementById("auditActionFilter");

  function applyFilters() {
    const q = (searchEl?.value || "").toLowerCase();
    const level = levelEl?.value || "";
    const action = actionEl?.value || "";
    const filtered = auditData.filter((r) => {
      const matchSearch = !q
        || (r.user_name || "").toLowerCase().includes(q)
        || (r.action || "").toLowerCase().includes(q)
        || (r.target_type || "").toLowerCase().includes(q)
        || String(r.target_id || "").includes(q);
      const matchLevel = !level || r.level === level;
      const matchAction = !action || r.action === action;
      return matchSearch && matchLevel && matchAction;
    });
    renderAuditTableInner(filtered);
  }

  searchEl?.addEventListener("input", applyFilters);
  levelEl?.addEventListener("change", applyFilters);
  actionEl?.addEventListener("change", applyFilters);
}

function renderAuditTableInner(list) {
  const tbody = document.getElementById("tableBody");
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">Aucune entrée.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((r) => {
    let metaStr = "—";
    if (r.meta && typeof r.meta === "object") {
      try { metaStr = JSON.stringify(r.meta).slice(0, 80); } catch { metaStr = "—"; }
    } else if (r.meta) {
      metaStr = String(r.meta).slice(0, 80);
    }
    return `<tr>
      <td>${escapeHtml(r.user_name || "—")}</td>
      <td>${escapeHtml(r.action || "—")}</td>
      <td>${escapeHtml(r.target_type || "—")}</td>
      <td>${escapeHtml(String(r.target_id ?? "—"))}</td>
      <td>${badge(r.level || "info")}</td>
      <td>${fmtDateTime(r.created_at)}</td>
      <td><span title="${escapeHtml(metaStr)}" style="cursor:help;color:var(--muted,#94a3b8)">ℹ️</span></td>
    </tr>`;
  }).join("");
}

// ============================================================
// Renderers map
// ============================================================

const app = document.getElementById("app");

const RENDERERS = {
  dashboard,
  admins,
  users,
  saas,
  announcements,
  events,
  featured,
  audit,
};

// ============================================================
// Navigation
// ============================================================

async function navigate(section) {
  if (!RENDERERS[section]) return;
  currentSection = section;

  document.querySelectorAll(".nav-item[data-section]").forEach((b) => {
    const active = b.dataset.section === section;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });

  const meta = sections[section] || [section, ""];
  document.getElementById("pageTitle").textContent = meta[0];
  document.getElementById("pageSubtitle").textContent = meta[1];
  document.getElementById("sidebar")?.classList.remove("open");

  showProgress(`Chargement ${meta[0].toLowerCase()}…`);
  try {
    await RENDERERS[section]();
  } catch (err) {
    const msg = MIM.userMessage(err);
    MIM.showError(msg);
    app.innerHTML = `<div class="panel" role="alert"><div class="empty" style="color:#fda4af">${escapeHtml(msg)}</div></div>`;
  } finally {
    hideProgress();
  }
}

// ============================================================
// Event Delegation
// ============================================================

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.disabled) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  // --- Users ---
  if (action === "suspendUser") {
    const ok = await confirmAction("Suspendre l'utilisateur", "Voulez-vous vraiment suspendre cet utilisateur ?");
    if (!ok) return;
    showProgress("Suspension de l'utilisateur…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ statut: "suspendu" }) });
      showToast(r.message || "Utilisateur suspendu.");
      users();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "reactivateUser") {
    showProgress("Réactivation de l'utilisateur…", "success");
    try {
      const r = await apiRequest(`/ultra-admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ statut: "actif" }) });
      showToast(r.message || "Utilisateur réactivé.");
      users();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  // --- Admins ---
  if (action === "suspendAdmin") {
    const ok = await confirmAction("Suspendre l'administrateur", "Voulez-vous vraiment suspendre cet administrateur ?");
    if (!ok) return;
    showProgress("Suspension de l'administrateur…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/admins/${id}`, { method: "PATCH", body: JSON.stringify({ statut: "suspendu" }) });
      showToast(r.message || "Administrateur suspendu.");
      admins();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "reactivateAdmin") {
    showProgress("Réactivation de l'administrateur…", "success");
    try {
      const r = await apiRequest(`/ultra-admin/admins/${id}`, { method: "PATCH", body: JSON.stringify({ statut: "actif" }) });
      showToast(r.message || "Administrateur réactivé.");
      admins();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "removeAdminRole") {
    const name = btn.dataset.name || "";
    const ok = await confirmAction(
      "Retirer le rôle admin",
      `Voulez-vous vraiment retirer le rôle admin à ${name} ?`,
      { input: true, inputLabel: 'Tapez "CONFIRMER" pour valider', inputPlaceholder: "CONFIRMER", confirmText: "Retirer le rôle" }
    );
    if (!ok || ok !== true) return;
    showProgress("Retrait du rôle admin…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/admins/${id}`, { method: "DELETE" });
      showToast(r.message || "Rôle admin retiré.");
      admins();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  // --- Announcements ---
  if (action === "publishAnnouncement") {
    showProgress("Publication de l'annonce…", "success");
    try {
      const r = await apiRequest(`/ultra-admin/announcements/${id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      showToast(r.message || "Annonce publiée.");
      announcements();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "archiveAnnouncement") {
    showProgress("Archivage de l'annonce…");
    try {
      const r = await apiRequest(`/ultra-admin/announcements/${id}`, { method: "PATCH", body: JSON.stringify({ status: "archived" }) });
      showToast(r.message || "Annonce archivée.");
      announcements();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "deleteAnnouncement") {
    const title = btn.dataset.title || "";
    const ok = await confirmAction(
      "Supprimer l'annonce",
      `Voulez-vous vraiment supprimer l'annonce "${title}" ? Cette action est irréversible.`,
      { input: true, inputLabel: 'Tapez "SUPPRIMER" pour confirmer', inputPlaceholder: "SUPPRIMER", confirmText: "Supprimer" }
    );
    if (!ok || ok !== true) return;
    showProgress("Suppression de l'annonce…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/announcements/${id}`, { method: "DELETE" });
      showToast(r.message || "Annonce supprimée.");
      announcements();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  // --- Events ---
  if (action === "publishEvent") {
    showProgress("Publication de l'événement…", "success");
    try {
      const r = await apiRequest(`/ultra-admin/events/${id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      showToast(r.message || "Événement publié.");
      events();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "cancelEvent") {
    const ok = await confirmAction("Annuler l'événement", "Voulez-vous vraiment annuler cet événement ?");
    if (!ok) return;
    showProgress("Annulation de l'événement…");
    try {
      const r = await apiRequest(`/ultra-admin/events/${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
      showToast(r.message || "Événement annulé.");
      events();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "deleteEvent") {
    const title = btn.dataset.title || "";
    const ok = await confirmAction(
      "Supprimer l'événement",
      `Voulez-vous vraiment supprimer l'événement "${title}" ? Cette action est irréversible.`,
      { input: true, inputLabel: 'Tapez "SUPPRIMER" pour confirmer', inputPlaceholder: "SUPPRIMER", confirmText: "Supprimer" }
    );
    if (!ok || ok !== true) return;
    showProgress("Suppression de l'événement…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/events/${id}`, { method: "DELETE" });
      showToast(r.message || "Événement supprimé.");
      events();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  // --- Featured ---
  if (action === "deleteFeatured") {
    const ok = await confirmAction(
      "Supprimer la mise en avant",
      "Voulez-vous vraiment supprimer cet élément mis en avant ?",
      { input: true, inputLabel: 'Tapez "SUPPRIMER" pour confirmer', inputPlaceholder: "SUPPRIMER", confirmText: "Supprimer" }
    );
    if (!ok || ok !== true) return;
    showProgress("Suppression…", "danger");
    try {
      const r = await apiRequest(`/ultra-admin/featured/${id}`, { method: "DELETE" });
      showToast(r.message || "Élément supprimé.");
      featured();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  // --- SaaS ---
  if (action === "ultraSuspendSaas") {
    const ok = await confirmAction(
      "Suspendre le SaaS",
      "Voulez-vous vraiment suspendre la plateforme ? Tous les utilisateurs seront déconnectés.",
      { input: true, inputLabel: 'Tapez "SUSPENDRE" pour confirmer', inputPlaceholder: "SUSPENDRE", confirmText: "Suspendre le SaaS", btnClass: "btn danger" }
    );
    if (!ok || ok !== true) return;
    showProgress("Suspension du SaaS…", "danger");
    try {
      const r = await apiRequest("/ultra-admin/saas/suspend", { method: "POST" });
      showToast(r.message || "SaaS suspendu.");
      saas();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }

  if (action === "ultraReactivateSaas") {
    const ok = await confirmAction("Réactiver le SaaS", "Voulez-vous vraiment réactiver la plateforme ?");
    if (!ok) return;
    showProgress("Réactivation du SaaS…", "success");
    try {
      const r = await apiRequest("/ultra-admin/saas/reactivate", { method: "POST" });
      showToast(r.message || "SaaS réactivé.");
      saas();
    } catch (err) { MIM.showError(MIM.userMessage(err)); }
    finally { hideProgress(); }
  }
});

// ============================================================
// Confirm modal wiring
// ============================================================

document.getElementById("confirmBtn")?.addEventListener("click", () => {
  const inputGroup = document.getElementById("confirmInputGroup");
  if (inputGroup && inputGroup.style.display !== "none") {
    const input = document.getElementById("confirmInput");
    const val = (input?.value || "").trim();
    if (!val) return;
    resolveConfirm(true);
  } else {
    resolveConfirm(true);
  }
});

document.getElementById("confirmModal")?.addEventListener("click", (e) => {
  if (e.target.id === "confirmModal") resolveConfirm(false);
});

// ============================================================
// Modal: Create Admin
// ============================================================

document.getElementById("createAdminForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  const original = submit.textContent;
  submit.textContent = "Création…";
  showProgress("Création de l'administrateur…", "success");
  try {
    const r = await apiRequest("/ultra-admin/admins", {
      method: "POST",
      body: JSON.stringify({
        name: form.adminName.value.trim(),
        email: form.adminEmail.value.trim(),
        username: form.adminUsername.value.trim(),
        password: form.adminPassword.value || undefined,
      }),
    });
    showToast(r.message || "Administrateur créé.");
    document.getElementById("createAdminModal").classList.remove("active");
    form.reset();
    admins();
  } catch (err) {
    MIM.showError(MIM.userMessage(err));
  } finally {
    submit.disabled = false;
    submit.textContent = original;
    hideProgress();
  }
});

// ============================================================
// Modal: Create Announcement
// ============================================================

function wireAnnouncementModal() {
  let modal = document.getElementById("createAnnouncementModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "createAnnouncementModal";
    modal.innerHTML = `<div class="modal-panel">
      <div class="modal-header">
        <h2 id="announcementFormTitle">Créer une Annonce</h2>
        <button class="modal-close" data-close-announcement>&times;</button>
      </div>
      <form id="createAnnouncementForm">
        <div class="form-group">
          <label for="announcementTitle">Titre</label>
          <input type="text" id="announcementTitle" placeholder="Titre de l'annonce" required>
        </div>
        <div class="form-group">
          <label for="announcementBody">Contenu</label>
          <textarea id="announcementBody" rows="4" placeholder="Contenu de l'annonce" required></textarea>
        </div>
        <div class="form-group">
          <label for="announcementAudience">Audience</label>
          <select id="announcementAudience">
            <option value="all">Tous</option>
            <option value="proprietaires">Propriétaires</option>
            <option value="locataires">Locataires</option>
            <option value="admins">Admins</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn secondary" data-close-announcement>Annuler</button>
          <button type="submit" class="btn primary">Publier</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(modal);
  }

  modal.querySelectorAll("[data-close-announcement]").forEach((el) => {
    el.addEventListener("click", () => modal.classList.remove("active"));
  });

  const form = document.getElementById("createAnnouncementForm");
  if (form && !form._wired) {
    form._wired = true;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const original = submit.textContent;
      showProgress("Envoi de l'annonce…", "success");
      try {
        const editId = form.dataset.editId;
        const body = {
          title: document.getElementById("announcementTitle").value.trim(),
          body: document.getElementById("announcementBody").value.trim(),
          audience: document.getElementById("announcementAudience").value,
        };
        let r;
        if (editId) {
          r = await apiRequest(`/ultra-admin/announcements/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
        } else {
          r = await apiRequest("/ultra-admin/announcements", { method: "POST", body: JSON.stringify(body) });
        }
        showToast(r.message || (editId ? "Annonce modifiée." : "Annonce créée."));
        modal.classList.remove("active");
        form.reset();
        delete form.dataset.editId;
        announcements();
      } catch (err) {
        MIM.showError(MIM.userMessage(err));
      } finally {
        submit.disabled = false;
        submit.textContent = original;
        hideProgress();
      }
    });
  }
}

// ============================================================
// Modal: Create Event
// ============================================================

function wireEventModal() {
  let modal = document.getElementById("createEventModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "createEventModal";
    modal.innerHTML = `<div class="modal-panel">
      <div class="modal-header">
        <h2 id="eventFormTitle">Créer un Événement</h2>
        <button class="modal-close" data-close-event>&times;</button>
      </div>
      <form id="createEventForm">
        <div class="form-group">
          <label for="eventTitle">Titre</label>
          <input type="text" id="eventTitle" placeholder="Titre de l'événement" required>
        </div>
        <div class="form-group">
          <label for="eventDescription">Description</label>
          <textarea id="eventDescription" rows="3" placeholder="Description de l'événement"></textarea>
        </div>
        <div class="form-group">
          <label for="eventDate">Date et heure</label>
          <input type="datetime-local" id="eventDate" required>
        </div>
        <div class="form-group">
          <label for="eventAudience">Audience</label>
          <select id="eventAudience">
            <option value="all">Tous</option>
            <option value="proprietaires">Propriétaires</option>
            <option value="locataires">Locataires</option>
            <option value="admins">Admins</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn secondary" data-close-event>Annuler</button>
          <button type="submit" class="btn primary">Créer</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(modal);
  }

  modal.querySelectorAll("[data-close-event]").forEach((el) => {
    el.addEventListener("click", () => modal.classList.remove("active"));
  });

  const form = document.getElementById("createEventForm");
  if (form && !form._wired) {
    form._wired = true;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const original = submit.textContent;
      showProgress("Envoi de l'événement…", "success");
      try {
        const editId = form.dataset.editId;
        const body = {
          title: document.getElementById("eventTitle").value.trim(),
          description: document.getElementById("eventDescription").value.trim(),
          event_date: document.getElementById("eventDate").value,
          audience: document.getElementById("eventAudience").value,
        };
        let r;
        if (editId) {
          r = await apiRequest(`/ultra-admin/events/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
        } else {
          r = await apiRequest("/ultra-admin/events", { method: "POST", body: JSON.stringify(body) });
        }
        showToast(r.message || (editId ? "Événement modifié." : "Événement créé."));
        modal.classList.remove("active");
        form.reset();
        delete form.dataset.editId;
        events();
      } catch (err) {
        MIM.showError(MIM.userMessage(err));
      } finally {
        submit.disabled = false;
        submit.textContent = original;
        hideProgress();
      }
    });
  }
}

// ============================================================
// Modal: Create Featured
// ============================================================

function wireFeaturedModal() {
  let modal = document.getElementById("createFeaturedModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "createFeaturedModal";
    modal.innerHTML = `<div class="modal-panel">
      <div class="modal-header">
        <h2>Ajouter en Avant</h2>
        <button class="modal-close" data-close-featured>&times;</button>
      </div>
      <form id="createFeaturedForm">
        <div class="form-group">
          <label for="featuredTargetType">Type de cible</label>
          <select id="featuredTargetType" required>
            <option value="annonce">Annonce</option>
            <option value="evenement">Événement</option>
            <option value="bien">Bien</option>
            <option value="utilisateur">Utilisateur</option>
          </select>
        </div>
        <div class="form-group">
          <label for="featuredTargetId">ID de la cible</label>
          <input type="number" id="featuredTargetId" placeholder="ID" required>
        </div>
        <div class="form-group">
          <label for="featuredBadge">Badge</label>
          <input type="text" id="featuredBadge" placeholder="Ex: Nouveau, Populaire">
        </div>
        <div class="form-group">
          <label for="featuredPriority">Priorité</label>
          <input type="number" id="featuredPriority" value="0" min="0" max="999">
        </div>
        <div class="form-group">
          <label for="featuredUntil">Jusqu'au</label>
          <input type="datetime-local" id="featuredUntil">
        </div>
        <div class="form-actions">
          <button type="button" class="btn secondary" data-close-featured>Annuler</button>
          <button type="submit" class="btn primary">Ajouter</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(modal);
  }

  modal.querySelectorAll("[data-close-featured]").forEach((el) => {
    el.addEventListener("click", () => modal.classList.remove("active"));
  });

  const form = document.getElementById("createFeaturedForm");
  if (form && !form._wired) {
    form._wired = true;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const original = submit.textContent;
      showProgress("Ajout en avant…", "success");
      try {
        const body = {
          target_type: document.getElementById("featuredTargetType").value,
          target_id: document.getElementById("featuredTargetId").value,
          badge: document.getElementById("featuredBadge").value.trim() || undefined,
          priority: document.getElementById("featuredPriority").value || 0,
          featured_until: document.getElementById("featuredUntil").value || undefined,
        };
        const r = await apiRequest("/ultra-admin/featured", { method: "POST", body: JSON.stringify(body) });
        showToast(r.message || "Élément ajouté en avant.");
        modal.classList.remove("active");
        form.reset();
        featured();
      } catch (err) {
        MIM.showError(MIM.userMessage(err));
      } finally {
        submit.disabled = false;
        submit.textContent = original;
        hideProgress();
      }
    });
  }
}

// ============================================================
// Init
// ============================================================

function setAdminIdentity(user) {
  const name = user.name || "Super Admin";
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const avatars = document.querySelectorAll("#adminAvatar, #topAvatar");
  avatars.forEach((a) => (a.textContent = initials || "SA"));
  const n1 = document.getElementById("adminName");
  const n2 = document.getElementById("topName");
  if (n1) n1.textContent = name;
  if (n2) n2.textContent = name.split(" ")[0];
}

async function init() {
  try {
    const { user } = await apiRequest("/auth/me");
    if (user.account_type !== "ultra_admin") {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }
    setAdminIdentity(user);
  } catch {
    return;
  }

  document.querySelectorAll(".nav-item[data-section]").forEach((b) => {
    b.addEventListener("click", () => navigate(b.dataset.section));
  });

  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      navigate(currentSection);
      showToast("Actualisé");
    });
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await apiRequest("/auth/logout", { method: "POST" });
      } catch {}
      window.location.href = "../PartPublic/connexion.html";
    });
  }

  const hamburger = document.getElementById("hamburgerBtn");
  if (hamburger) {
    hamburger.addEventListener("click", () => {
      document.getElementById("sidebar")?.classList.toggle("open");
    });
  }

  const overlay = document.getElementById("sidebarOverlay");
  if (overlay) {
    overlay.addEventListener("click", () => {
      document.getElementById("sidebar")?.classList.remove("open");
    });
  }

  wireAnnouncementModal();
  wireEventModal();
  wireFeaturedModal();

  initBackground();
  initSystemStatus();
  navigate("dashboard");
}

init();
