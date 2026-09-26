function fmtShortFCFA(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M FCFA`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} k FCFA`;
  return `${v} FCFA`;
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function badge(statut) {
  const cls = statut === "actif" ? "status-success" : "status-info";
  return `<span class="status ${cls}">${escapeHtml(statut)}</span>`;
}

function render(portfolio) {
  const el = document.getElementById("portfolioList");
  if (!el) return;

  if (!portfolio.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">▤</span>Aucun bien dans le portefeuille de votre agence.</div>';
    return;
  }

  el.innerHTML = portfolio.map((p) => {
    const b = p.bien || {};
    const owner = p.proprietaire || {};
    return `
      <div class="crud-card">
        <div>
          <h3>${escapeHtml(b.nom || `Bien #${p.bien_id}`)}</h3>
          <p class="muted">
            ${escapeHtml(b.type || "")}${b.ville ? " — " + escapeHtml(b.ville) : ""}
            ${b.adresse ? " · " + escapeHtml(b.adresse) : ""}
          </p>
          <p class="muted">
            ${b.logements_count ?? 0} logement(s) · ${b.logements_occupes ?? 0} occupé(s) ·
            ${fmtShortFCFA(b.loyer_total)} de loyers cumulés
          </p>
          <p class="muted">
            Propriétaire : ${owner.name ? escapeHtml(owner.name) : (owner.email ? escapeHtml(owner.email) : "—")}
            ${owner.email ? " (" + escapeHtml(owner.email) + ")" : ""}
          </p>
          <p class="muted">Rattaché le ${formatDate(p.created_at)} ${badge(p.statut)}</p>
        </div>
        <div class="crud-actions">
          <a class="btn btn-edit" href="/PartAgence/second_Mode/bien.html?bien=${p.bien_id}">
            Gérer ce bien
          </a>
        </div>
      </div>`;
  }).join("");
}

async function loadNotificationsBadge() {
  try {
    const { data } = await apiRequest("/notifications");
    const unread = (data || []).filter((n) => !n.lu).length;
    const badgeEl = document.getElementById("notifBadge");
    if (badgeEl) {
      badgeEl.textContent = unread;
      badgeEl.classList.toggle("show", unread > 0);
    }
  } catch (err) {
    console.error(err);
  }
}

async function load() {
  try {
    const res = await fetch(`${API}/agence/portefeuille`, { credentials: "include" });
    const { ok, error, data } = await MIM.parse(res);
    if (!ok) {
      if (!MIM.handleAuthError(error)) {
        const msg = document.getElementById("portfolioList");
        if (msg) msg.innerHTML = `<div class="empty-state">${escapeHtml(MIM.userMessage(error))}</div>`;
      }
      return;
    }
    render(data.data || []);
    const live = document.getElementById("liveLabel");
    if (live) live.textContent = `à jour · ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (err) {
    const el = document.getElementById("portfolioList");
    if (el) el.innerHTML = `<div class="empty-state">Impossible de charger le portefeuille.</div>`;
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  loadNotificationsBadge();

  const refreshBtnEl = document.getElementById("refreshBtn");
  if (refreshBtnEl) refreshBtnEl.addEventListener("click", () => {
    load();
    loadNotificationsBadge();
  });
});