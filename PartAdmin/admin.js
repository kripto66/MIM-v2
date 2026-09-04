const API = (() => {
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

// ============================================================
// Progress Bar System (actions longues)
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

// Event delegation sécurisée — remplace les onclick inline.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'setStatut') setStatut(btn.dataset.id, btn.dataset.statut);
  else if (action === 'openSubModal') openSubModal(btn.dataset.userId);
  else if (action === 'ultraDeleteAll') ultraDeleteAll();
  else if (action === 'ultraSuspendSaas') ultraSuspendSaas();
  else if (action === 'ultraReactivateSaas') ultraReactivateSaas();
});

// ============================================================
// Ultra-Admin : mode et vérification
// ============================================================

let ultraMode = false;
let ultraPassword = null;

function setUltraMode(active) {
  ultraMode = active;
  const badge = document.getElementById("ultraBadge");
  const toggle = document.getElementById("ultraToggle");
  if (badge) badge.textContent = active ? "ON" : "OFF";
  if (toggle) toggle.classList.toggle("active", active);
  document.querySelectorAll(".ultra-only").forEach((el) => {
    el.classList.toggle("visible", active);
  });
  if (active) {
    const navLabel = document.querySelector(".nav-section-label");
    if (navLabel) navLabel.style.color = "#fbbf24";
  }
}

function openUltraModal() {
  const modal = document.getElementById("ultraModal");
  const errEl = document.getElementById("ultraVerifyError");
  if (errEl) errEl.textContent = "";
  if (modal) modal.hidden = false;
  const input = document.getElementById("ultraPassword");
  if (input) { input.value = ""; input.focus(); }
}

function closeUltraModal() {
  const modal = document.getElementById("ultraModal");
  if (modal) modal.hidden = true;
}

async function ultraVerify(password) {
  showProgress("Vérification ultra-admin…", "warning");
  try {
    const r = await fetch(`${API}/admin/ultra-verify`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => r.json());
    hideProgress();
    if (!r.success) {
      document.getElementById("ultraVerifyError").textContent = r.message || "Mot de passe incorrect.";
      return false;
    }
    ultraPassword = password;
    setUltraMode(true);
    closeUltraModal();
    showToast("Mode Ultra-Admin activé");
    await navigate("ultra-system");
    return true;
  } catch {
    hideProgress();
    document.getElementById("ultraVerifyError").textContent = "Erreur de connexion.";
    return false;
  }
}

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M9 7h1"/><path d="M14 7h1"/><path d="M9 11h1"/><path d="M14 11h1"/><path d="M10 21v-3h4v3"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function svg(name) {
  return ICONS[name] || "";
}

async function apiRequest(path, options = {}) {
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

const app = document.getElementById("app");

const sections = {
  dashboard: ["Dashboard", "Vue globale de la plateforme."],
  proprietaires: ["Propriétaires", "Gestion des comptes propriétaires."],
  locataires: ["Locataires", "Vue globale des locataires de MIM."],
  biens: ["Biens & logements", "Suivi du parc immobilier."],
  paiements: ["Paiements", "Suivi global des paiements."],
  abonnements: ["Abonnements", "Suivi des abonnements MIM des propriétaires."],
  incidents: ["Incidents", "Incidents et interventions."],
  activite: ["Activité", "Historique des événements de la plateforme."],
};

const LABELS = {
  paye: "Payé",
  attente: "En attente",
  retard: "En retard",
  a_confirmer: "À confirmer",
  en_validation: "En validation",
  refuse: "Refusé",
  expire: "Expiré",
  nouveau: "Nouveau",
  en_cours: "En cours",
  resolu: "Résolu",
  intervention: "Intervention",
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
          : v.includes("retard") || v.includes("suspend") || v.includes("attente") || v.includes("validation") || v.includes("maintenance") || v.includes("planifiée") || v.includes("expiré") ? "warning"
          : v.includes("incident") || v.includes("nouveau") || v.includes("en cours") || v.includes("inactif") || v.includes("refusé") ? "danger"
          : v.includes("confirmer") ? "info" : "info";
  return `<span class="badge ${cls}">${escapeHtml(label(value))}</span>`;
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
  t.className = "toast show";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), 2500);
}

const MONTH_LETTERS = ["S", "O", "N", "D", "J", "F", "M", "A", "M", "J", "J", "A"];
function monthLetter(ym) {
  const [y, m] = (ym || "").split("-").map(Number);
  return MONTH_LETTERS[m - 1] || "?";
}

// ============================================================
// Composants néon (données réelles uniquement)
// ============================================================

function statCard(cfg) {
  const value = cfg.money ? money(cfg.raw) : Number(cfg.raw || 0).toLocaleString("fr-FR");
  return `<div class="stat-card" data-tilt style="--d:${cfg.d || 0}s">
    <div class="stat-head"><span>${cfg.label}</span><span class="stat-icon">${svg(cfg.icon)}</span></div>
    <div class="stat-value">${value}</div>
    <div class="stat-sub">${cfg.sub || ""}</div>
  </div>`;
}

// Aucune animation décorative : les compteurs affichent directement les
// valeurs réelles renvoyées par l'API (pas de nombre intermédiaire fictif).
function animateCounts() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count || "0");
    const isMoney = el.dataset.fmt === "money";
    el.textContent = isMoney ? money(target) : target.toLocaleString("fr-FR");
  });
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  let m;
  if (n <= 1) m = 1;
  else if (n <= 2) m = 2;
  else if (n <= 2.5) m = 2.5;
  else if (n <= 5) m = 5;
  else m = 10;
  return m * mag;
}

function revenueChart(revenue12) {
  const data = (revenue12 || []).map((r) => ({ label: monthLetter(r.mois), value: Number(r.total) || 0 }));
  const W = 600;
  const H = 250;
  const PAD = 10;
  const sum = data.reduce((s, d) => s + d.value, 0);

  if (!data.length || sum === 0) {
    return `<div class="chart chart-empty"><div class="empty">Aucune donnée disponible</div></div>`;
  }

  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const X = (i) => PAD + (i * (W - PAD * 2)) / (data.length - 1);
  const Y = (v) => H - PAD - (v / max) * (H - PAD * 2);
  const pts = data.map((d, i) => [X(i), Y(d.value)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = `${line} L ${X(data.length - 1).toFixed(1)} ${H - PAD} L ${X(0).toFixed(1)} ${H - PAD} Z`;

  const grid = [0, 1, 2, 3, 4]
    .map((i) => {
      const y = (PAD + (i * (H - PAD * 2)) / 4).toFixed(1);
      return `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    })
    .join("");

  const dots = data
    .map((d, i) => {
      const tip = `${d.label} — ${money(d.value)}`;
      const left = ((X(i) / W) * 100).toFixed(2);
      const bottom = ((Y(d.value) / H) * 100).toFixed(2);
      return `<button type="button" class="chart-dot" aria-label="${tip}" data-tip="${tip}" style="left:${left}%;bottom:${bottom}%"></button>`;
    })
    .join("");

  return `<div class="chart" id="revenueChart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" aria-hidden="true">
      <defs>
        <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a855f7" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="revStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#22d3ee"/>
          <stop offset="100%" stop-color="#a855f7"/>
        </linearGradient>
      </defs>
      <g class="chart-grid">${grid}</g>
      <path class="chart-area" d="${area}" fill="url(#revFill)"/>
      <path class="chart-line" d="${line}" fill="none" stroke="url(#revStroke)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="chart-dots">${dots}</div>
    <div class="chart-tip" hidden></div>
  </div>`;
}

function wireChart() {
  const chart = document.getElementById("revenueChart");
  if (!chart) return;
  const tip = chart.querySelector(".chart-tip");
  const dots = chart.querySelectorAll(".chart-dot");
  if (!dots.length) return;

  const place = (dot) => {
    const c = chart.getBoundingClientRect();
    const d = dot.getBoundingClientRect();
    const left = Math.max(0, Math.min(d.left - c.left + d.width / 2 - tip.offsetWidth / 2, c.width - tip.offsetWidth));
    tip.style.left = left + "px";
    tip.style.top = Math.max(0, d.top - c.top - tip.offsetHeight - 10) + "px";
  };

  dots.forEach((dot) => {
    dot.addEventListener("mouseenter", () => {
      tip.textContent = dot.dataset.tip;
      tip.hidden = false;
      place(dot);
    });
    dot.addEventListener("mouseleave", () => (tip.hidden = true));
    dot.addEventListener("focus", () => {
      tip.textContent = dot.dataset.tip;
      tip.hidden = false;
      place(dot);
    });
    dot.addEventListener("blur", () => (tip.hidden = true));
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

function skeleton() {
  const cards = Array(8).fill('<div class="sk-card"></div>').join("");
  return `<div class="sk-cards">${cards}</div>
    <div class="sk-panels"><div class="sk-panel"></div><div class="sk-panel"></div></div>
    <div class="sk-panels"><div class="sk-panel"></div><div class="sk-panel"></div></div>`;
}

// ============================================================
// Fond animé (particules légères, respecte reduced-motion)
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
      if (p.y < -4) {
        p.y = h + 4;
        p.x = Math.random() * w;
      }
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

  function stop() {
    cancelAnimationFrame(raf);
  }

  window.addEventListener("resize", () => {
    size();
    spawn();
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  size();
  spawn();
  start();
}

// ============================================================
// Statut système (vérification réelle du backend)
// ============================================================

async function initSystemStatus() {
  const el = document.getElementById("sysStatus");
  if (!el) return;
  const text = document.getElementById("sysStatusText");
  const set = (state, msg) => {
    el.dataset.state = state;
    text.textContent = msg;
  };
  set("checking", "CONNEXION AU SERVEUR…");
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
// Table / Navigation
// ============================================================

function activity(title, text, time) {
  const safeTitle = typeof title === "string" ? escapeHtml(title) : (title ?? "");
  const safeText = typeof text === "string" ? escapeHtml(text) : (text ?? "");
  const safeTime = typeof time === "string" ? escapeHtml(time) : (time ?? "");
  return `<div class="activity-row"><i class="dot"></i><div><strong>${safeTitle}</strong>${safeText ? `<small>${safeText}</small>` : ""}${safeTime ? `<small>${safeTime}</small>` : ""}</div></div>`;
}

function tablePage(title, data, columns, headers, actions, onAction) {
  return `<div class="panel">
    <div class="toolbar">
      <input class="search" id="tableSearch" placeholder="Rechercher dans ${title.toLowerCase()}..." aria-label="Rechercher dans ${title.toLowerCase()}">
      <button class="btn secondary" onclick="exportCSV()">Exporter CSV</button>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}${actions ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody id="tableBody">${rows(data, columns, actions, onAction)}</tbody></table></div>
  </div>`;
}

function rows(data, columns, actions, onAction) {
  if (!data || !data.length) return `<tr><td colspan="99" class="empty">Aucune donnée.</td></tr>`;
  const badgeCells = new Set(["statut", "status"]);
  return data.map((r) => `<tr>${columns.map((k) => {
    if (badgeCells.has(k)) return `<td>${badge(r[k])}</td>`;
    if (k === "montant") return `<td class="num">${money(r[k])}</td>`;
    const val = r[k];
    return `<td>${val != null ? escapeHtml(String(val)) : "—"}</td>`;
  }).join("")}${actions && onAction ? `<td>${onAction(r)}</td>` : ""}</tr>`).join("");
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
  app.innerHTML = skeleton();
  const { stats } = await apiRequest("/admin/stats");
  const recentPayments = stats.recentPayments || [];
  const recentIncidents = stats.recentIncidents || [];

  app.innerHTML = `
  <div class="cards">
    ${statCard({ label: "Propriétaires", icon: "users", raw: stats.proprietaires, sub: `${stats.biens} biens enregistrés`, d: 0 })}
    ${statCard({ label: "Locataires", icon: "user", raw: stats.locataires, sub: `${stats.logementsOccupes} logements occupés`, d: 0.04 })}
    ${statCard({ label: "Biens", icon: "building", raw: stats.biens, sub: `${stats.logements} logements au total`, d: 0.08 })}
    ${statCard({ label: "Revenus du mois", icon: "wallet", raw: stats.revenusMois, money: 1, sub: `${money(stats.lateRent)} en retard`, d: 0.12 })}
    ${statCard({ label: "Paiements", icon: "card", raw: stats.paiements, sub: `${stats.paiementsEnAttente} en attente`, d: 0.16 })}
    ${statCard({ label: "Logements", icon: "home", raw: stats.logements, sub: `${stats.logementsLibres} libres`, d: 0.2 })}
    ${statCard({ label: "Incidents actifs", icon: "alert", raw: stats.incidentsActifs, sub: `${stats.interventionsActives} interventions en cours`, d: 0.24 })}
    ${statCard({ label: "Interventions", icon: "tool", raw: stats.interventionsActives, sub: "", d: 0.28 })}
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-header"><h2>Revenus — 12 derniers mois</h2><span class="panel-tag">FCFA</span></div>
      ${revenueChart(stats.revenue12)}
    </div>
    <div class="panel"><div class="panel-header"><h2>Activité récente</h2><span class="panel-tag">plateforme</span></div>
      <div class="activity">
        ${(stats.activiteRecent || []).map((a) => activity(a.title, a.detail, fmtDateTime(a.time))).join("") || `<div class="empty">Aucune activité.</div>`}
      </div>
    </div>
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-header"><h2>Paiements récents</h2><button class="btn secondary" onclick="navigate('paiements')">Voir tout</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Locataire</th><th>Période</th><th>Montant</th><th>Statut</th></tr></thead>
      <tbody>${recentPayments.map((r) => `<tr><td>${escapeHtml(r.locataire)}</td><td>${escapeHtml(r.periode)}</td><td class="num">${money(r.montant)}</td><td>${badge(r.statut)}</td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="panel"><div class="panel-header"><h2>Incidents</h2><button class="btn secondary" onclick="navigate('incidents')">Voir tout</button></div>
      <div class="activity">${recentIncidents.map((r) => activity(r.titre, `${r.logement} — ${r.locataire}`, badge(r.statut))).join("") || `<div class="empty">Aucun incident.</div>`}</div>
    </div>
  </div>`;

  animateCounts();
  wireChart();
  enableTilt();
}

function subBadge(subscription) {
  if (!subscription) return `<span class="badge info">Aucun</span>`;
  return subscription.statut === "actif"
    ? `<span class="badge success" title="Expire le ${fmtDate(subscription.date_expiration)}">Abonné · ${subscription.joursRestants} j</span>`
    : `<span class="badge warning" title="Expiré le ${fmtDate(subscription.date_expiration)}">Expiré</span>`;
}

async function proprietaires() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/proprietaires");
  const rowsData = (data || []).map((r) => ({
    ...r,
    last_login: fmtDateTime(r.last_login),
    sub: subBadge(r.subscription),
  }));
  app.innerHTML = tablePage(
    "propriétaires",
    rowsData,
    ["id", "nom", "email", "biens", "statut", "sub", "last_login"],
    ["ID", "Nom", "Email", "Biens", "Statut", "Abonnement", "Dernière connexion"],
    true,
    (r) =>
      `<button class="btn ${r.statut === "suspendu" ? "secondary" : "danger"}" data-action="setStatut" data-id="${escapeHtml(r.id)}" data-statut="${escapeHtml(r.statut)}">${r.statut === "suspendu" ? "Réactiver" : "Suspendre"}</button>`
  );
  bindSearch();
}

function rowCells(r, columns) {
  return columns
    .map((k) => {
      if (k === "statut") return `<td>${badge(r[k])}</td>`;
      if (k === "montant") return `<td class="num">${money(r[k])}</td>`;
      const val = r[k];
      return `<td>${val != null ? escapeHtml(String(val)) : "—"}</td>`;
    })
    .join("");
}

async function abonnements() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/subscriptions");
  const rowsData = (data || []).map((r) => ({
    ...r,
    date_paiement: r.date_paiement ? fmtDate(r.date_paiement) : "—",
    date_debut: r.date_debut ? fmtDate(r.date_debut) : "—",
    date_expiration: r.date_expiration ? fmtDate(r.date_expiration) : "—",
    joursRestants: r.joursRestants,
  }));
  app.innerHTML = `<div class="panel">
    <div class="toolbar">
      <input class="search" id="tableSearch" placeholder="Rechercher un abonnement..." aria-label="Rechercher un abonnement">
      <button class="btn secondary" onclick="exportCSV()">Exporter CSV</button>
      <button class="btn primary" onclick="openSubModal()">+ Enregistrer un paiement</button>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr>
      <th>Propriétaire</th><th>Plan</th><th>Montant</th><th>Paiement</th><th>Début</th><th>Expiration</th><th>Jours restants</th><th>Statut</th><th>Actions</th>
    </tr></thead>
    <tbody id="tableBody">${
      rowsData.length
        ? rowsData.map((r) => `<tr>${rowCells(r, ["proprietaire", "plan", "montant", "date_paiement", "date_debut", "date_expiration", "joursRestants", "statut"])}<td><button class="btn primary" data-action="openSubModal" data-user-id="${escapeHtml(r.user_id)}">Encaisser</button></td></tr>`).join("")
        : `<tr><td colspan="99" class="empty">Aucun abonnement enregistré.</td></tr>`
    }</tbody></table></div>
  </div>`;
  bindSearch();
}

function openSubModal(userId) {
  const modal = document.getElementById("subModal");
  const select = document.getElementById("subOwner");
  select.innerHTML = "";
  select.appendChild(new Option("Chargement…", ""));
  apiRequest("/admin/proprietaires")
    .then(({ data }) => {
      select.innerHTML = "";
      (data || []).forEach((p) => {
        select.appendChild(new Option(`${p.nom} (${p.email})`, p.id));
      });
      if (userId) select.value = userId;
    })
    .catch((err) => {
      select.innerHTML = "";
      select.appendChild(new Option("Erreur de chargement", ""));
      MIM.showError(MIM.userMessage(err));
    });
  modal.hidden = false;
  document.getElementById("subMontant").focus();
}

function closeSubModal() {
  document.getElementById("subModal").hidden = true;
}

async function locataires() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/locataires");
  app.innerHTML = tablePage("locataires", data, ["id", "nom", "proprietaire", "logement", "statut"], ["ID", "Nom", "Propriétaire", "Logement", "Statut"]);
  bindSearch();
}

async function biens() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/biens");
  app.innerHTML = tablePage("biens", data, ["id", "nom", "logements", "occupes", "proprietaire"], ["ID", "Bien", "Logements", "Occupés", "Propriétaire"]);
  bindSearch();
}

async function paiements() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/paiements");
  const rowsData = (data || []).map((r) => ({
    id: r.id,
    locataire: r.locataire,
    logement: r.logement,
    periode: r.periode,
    montant: money(r.montant),
    statut: r.statut,
    methode: r.methode,
    reference: r.reference || "—",
  }));
  app.innerHTML = tablePage("paiements", rowsData, ["id", "locataire", "logement", "periode", "montant", "statut", "methode", "reference"], ["ID", "Locataire", "Logement", "Période", "Montant", "Statut", "Méthode", "Référence"]);
  bindSearch();
}

async function incidents() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/incidents");
  const rowsData = (data || []).map((r) => ({ ...r, date: fmtDate(r.date) }));
  app.innerHTML = tablePage("incidents", rowsData, ["id", "titre", "locataire", "logement", "statut", "date"], ["ID", "Incident", "Locataire", "Logement", "Statut", "Date"]);
  bindSearch();
}

async function activite() {
  app.innerHTML = skeleton();
  const { data } = await apiRequest("/admin/activite");
  app.innerHTML = `<div class="panel"><div class="panel-header"><h2>Journal d'activité</h2><span class="panel-tag">100 derniers événements</span></div>
    <div class="activity">${(data || []).map((a) => activity(a.action, `${a.user} — ${a.detail}`, a.date)).join("") || `<div class="empty">Aucune activité.</div>`}</div></div>`;
}

// ============================================================
// Ultra-Admin : Sections
// ============================================================

const ultraSections = {
  "ultra-system": ["Système", "Contrôle avancé de la plateforme MIM."],
  "ultra-danger": ["Zone dangereuse", "Actions irréversibles sur la base de données."],
};

Object.assign(sections, ultraSections);

function ultraSuspendIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
}

function ultraTrashIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
}

function ultraKeyIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;
}

async function ultraSystem() {
  if (!ultraMode) { navigate("dashboard"); return; }
  app.innerHTML = `<div class="ultra-grid">
    <div class="ultra-card">
      <div class="ultra-card-icon">${ultraSuspendIcon()}</div>
      <h3>Suspendre le SaaS</h3>
      <p>Désactive temporairement l'accès à la plateforme pour tous les utilisateurs. Les propriétaires et locataires ne pourront plus se connecter.</p>
      <button class="btn danger" data-action="ultraSuspendSaas">Suspendre le SaaS</button>
    </div>
    <div class="ultra-card">
      <div class="ultra-card-icon" style="color:var(--success);border-color:rgba(52,211,153,0.25);background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(34,211,238,0.15))">${ultraKeyIcon()}</div>
      <h3>Réactiver le SaaS</h3>
      <p>Restaure l'accès à la plateforme pour tous les utilisateurs après une suspension.</p>
      <button class="btn primary" data-action="ultraReactivateSaas">Réactiver le SaaS</button>
    </div>
  </div>
  <div class="panel">
    <div class="panel-header"><h2>Statut du SaaS</h2><span class="panel-tag">système</span></div>
    <div id="saasStatusBanner" class="saas-status-banner active">
      <div class="saas-status-dot"></div>
      <div><h3>SaaS Actif</h3><p>La plateforme fonctionne normalement pour tous les utilisateurs.</p></div>
    </div>
  </div>`;
  try {
    const r = await fetch(`${API}/health`, { credentials: "include" }).then((r) => r.json()).catch(() => null);
    const banner = document.getElementById("saasStatusBanner");
    if (banner && r && !r.success) {
      banner.className = "saas-status-banner suspended";
      banner.querySelector("h3").textContent = "SaaS Hors Ligne";
      banner.querySelector("p").textContent = "Le serveur ne répond pas.";
    }
  } catch {}
}

async function ultraDeleteAll() {
  if (!ultraMode || !ultraPassword) { showToast("Ultra-admin requis."); return; }
  const card = document.querySelector(".ultra-card:last-child .confirm-danger-zone");
  if (!card) return;
  if (!card.classList.contains("visible")) {
    card.classList.add("visible");
    const inp = card.querySelector("input");
    if (inp) inp.focus();
    return;
  }
  const input = card.querySelector("input");
  if (!input || input.value !== "SUPPRIMER TOUT") {
    const errEl = card.querySelector(".err");
    if (errEl) errEl.textContent = 'Tapez exactement "SUPPRIMER TOUT" pour confirmer.';
    return;
  }
  showProgress("Suppression de toutes les données…", "danger");
  try {
    const r = await fetch(`${API}/admin/ultra/delete-all`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ultraPassword, confirm: input.value }),
    }).then((r) => r.json());
    hideProgress();
    if (!r.success) {
      MIM.showError(r.message || "Erreur lors de la suppression.");
      return;
    }
    showToast("Toutes les données ont été supprimées.");
    navigate("dashboard");
  } catch (err) {
    hideProgress();
    MIM.showError(MIM.userMessage(err));
  }
}

async function ultraSuspendSaas() {
  if (!ultraMode || !ultraPassword) { showToast("Ultra-admin requis."); return; }
  showProgress("Suspension du SaaS…", "danger");
  try {
    const r = await fetch(`${API}/admin/ultra/suspend-saas`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ultraPassword }),
    }).then((r) => r.json());
    hideProgress();
    if (!r.success) { MIM.showError(r.message || "Erreur."); return; }
    showToast(r.message);
    ultraSystem();
  } catch (err) {
    hideProgress();
    MIM.showError(MIM.userMessage(err));
  }
}

async function ultraReactivateSaas() {
  if (!ultraMode || !ultraPassword) { showToast("Ultra-admin requis."); return; }
  showProgress("Réactivation du SaaS…", "success");
  try {
    const r = await fetch(`${API}/admin/ultra/reactivate-saas`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ultraPassword }),
    }).then((r) => r.json());
    hideProgress();
    if (!r.success) { MIM.showError(r.message || "Erreur."); return; }
    showToast(r.message);
    ultraSystem();
  } catch (err) {
    hideProgress();
    MIM.showError(MIM.userMessage(err));
  }
}

async function ultraDanger() {
  if (!ultraMode) { navigate("dashboard"); return; }
  app.innerHTML = `<div class="ultra-grid">
    <div class="ultra-card" style="border-color:rgba(251,113,133,0.35)">
      <div class="ultra-card-icon" style="color:var(--danger);border-color:rgba(251,113,133,0.3);background:linear-gradient(135deg,rgba(251,113,133,0.2),rgba(244,63,94,0.15))">${ultraTrashIcon()}</div>
      <h3>Supprimer toutes les données</h3>
      <p>Supprime définitivement TOUS les comptes utilisateurs, biens, logements, locataires, paiements, incidents, interventions, sessions et abonnements. Cette action est IRRÉVERSIBLE.</p>
      <button class="btn danger" data-action="ultraDeleteAll">Supprimer tout</button>
      <div class="confirm-danger-zone" id="deleteConfirm">
        <label>⚠ Tapez "SUPPRIMER TOUT" pour confirmer :</label>
        <input type="text" placeholder="SUPPRIMER TOUT" autocomplete="off">
        <div class="err" style="color:#fda4af;font-size:12px;margin-top:4px"></div>
        <div class="btn-row">
          <button class="btn secondary" onclick="document.getElementById('deleteConfirm').classList.remove('visible')">Annuler</button>
        </div>
      </div>
    </div>
  </div>`;
}

const RENDERERS = { dashboard, proprietaires, locataires, biens, paiements, abonnements, incidents, activite, "ultra-system": ultraSystem, "ultra-danger": ultraDanger };

// ============================================================
// Navigation & actions
// ============================================================

async function navigate(section) {
  if (!RENDERERS[section]) return;
  document.querySelectorAll(".nav-item").forEach((b) => {
    const active = b.dataset.section === section;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const title = sections[section] ? sections[section][0] : section;
  const subtitle = sections[section] ? sections[section][1] : "";
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageSubtitle").textContent = subtitle;
  document.getElementById("sidebar").classList.remove("open");
  showProgress(`Chargement ${title.toLowerCase()}…`);
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

async function setStatut(id, statut) {
  const next = statut === "suspendu" ? "actif" : "suspendu";
  showProgress(statut === "suspendu" ? "Réactivation du compte…" : "Suspension du compte…", statut === "suspendu" ? "success" : "danger");
  try {
    const r = await apiRequest(`/admin/proprietaires/${id}`, { method: "PATCH", body: JSON.stringify({ statut: next }) });
    showToast(r.message);
    navigate("proprietaires");
  } catch (err) {
    hideProgress();
    MIM.showError(MIM.userMessage(err));
  }
}

// ============================================================
// Init
// ============================================================

function setAdminIdentity(user) {
  const name = user.name || "Admin MIM";
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const avatars = document.querySelectorAll("#adminAvatar, #topAvatar");
  avatars.forEach((a) => (a.textContent = initials || "AD"));
  const n1 = document.getElementById("adminName");
  const n2 = document.getElementById("topName");
  if (n1) n1.textContent = name;
  if (n2) n2.textContent = name.split(" ")[0];
}

async function init() {
  try {
    const { user } = await apiRequest("/auth/me");
    if (user.account_type !== "admin") {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }
    setAdminIdentity(user);
  } catch {
    return;
  }

  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.section)));

  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      const active = document.querySelector(".nav-item.active");
      if (active) navigate(active.dataset.section);
      showToast("Actualisé");
    });
  }

  // Ultra-admin toggle
  const ultraToggle = document.getElementById("ultraToggle");
  if (ultraToggle) {
    ultraToggle.addEventListener("click", () => {
      if (ultraMode) {
        setUltraMode(false);
        ultraPassword = null;
        showToast("Mode Ultra-Admin désactivé");
        navigate("dashboard");
      } else {
        openUltraModal();
      }
    });
  }

  // Ultra-admin modal
  document.querySelectorAll("[data-ultra-close]").forEach((el) =>
    el.addEventListener("click", closeUltraModal)
  );
  const ultraForm = document.getElementById("ultraForm");
  if (ultraForm) {
    ultraForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwd = document.getElementById("ultraPassword").value;
      await ultraVerify(pwd);
    });
  }

  const subModal = document.getElementById("subModal");
  if (subModal) {
    document.querySelectorAll("[data-sub-close]").forEach((el) =>
      el.addEventListener("click", closeSubModal)
    );
    document.getElementById("subForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = e.target.querySelector("button[type=submit]");
      const resultEl = document.getElementById("subResult");
      if (resultEl) resultEl.innerHTML = "";
      submit.disabled = true;
      const original = submit.textContent;
      showProgress("Enregistrement du paiement…");
      try {
        const r = await apiRequest("/admin/subscriptions/register", {
          method: "POST",
          body: JSON.stringify({
            userId: document.getElementById("subOwner").value,
            plan: document.getElementById("subPlan").value,
            montant: document.getElementById("subMontant").value,
            dureeMois: document.getElementById("subDuree").value,
          }),
        });
        showToast(r.message);
        if (resultEl) resultEl.innerHTML = `<p class="ok">${escapeHtml(r.message)}</p>`;
        closeSubModal();
        navigate("abonnements");
      } catch (err) {
        if (resultEl) resultEl.innerHTML = `<p class="err">${escapeHtml(MIM.userMessage(err))}</p>`;
        MIM.showError(MIM.userMessage(err));
      } finally {
        submit.disabled = false;
        submit.textContent = original;
        hideProgress();
      }
    });
  }

  initBackground();
  initSystemStatus();
  navigate("dashboard");
}

init();
