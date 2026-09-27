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

const badgify = (text, cls) => `<span class="status ${cls}">${escapeHtml(text)}</span>`;

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
  const ids = ["recentNotifications", "portfolioList", "ownersList"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && !el.querySelector(".skel-item, .list-item, .property-card")) {
      el.innerHTML = SKELETON_ITEM.repeat(3);
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

function refreshAll() {
  return Promise.all([
    loadUserName(),
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
   Statistiques (KPI + actions) — /agence/stats
------------------------------------------------------------------- */

async function loadStats() {
  try {
    const res = await fetch(`${API}/agence/stats`, { credentials: "include" });
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
      totalBiens: s.totalBiens,
      totalLogements: s.totalLogements,
      totalLocataires: s.totalLocataires,
      paidRent: fmtShortFCFA(s.paidRent),
      lateRent: fmtShortFCFA(s.lateRent),
      versementsAttente: fmtShortFCFA(s.versementsAttente),
    };
    for (const [id, value] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    const proprietairesSub = document.getElementById("proprietairesSub");
    if (proprietairesSub) proprietairesSub.textContent = `${s.totalProprietaires} propriétaire(s) géré(s)`;

    const logementsSub = document.getElementById("logementsSub");
    if (logementsSub) {
      logementsSub.textContent = `${s.logementsOccupes} occupé(s) · ${s.logementsLibres} libre(s)`;
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

    const versementsSub = document.getElementById("versementsSub");
    if (versementsSub) {
      versementsSub.textContent = s.versementsAttenteCount > 0
        ? `${s.versementsAttenteCount} versement(s) en attente`
        : "Aucun versement en attente";
    }

    const locatairesSub = document.getElementById("locatairesSub");
    if (locatairesSub) {
      locatairesSub.textContent = `${s.locatairesActifs ?? s.totalLocataires} actif(s) · ${s.incidentsOuverts ?? 0} incident(s) ouvert(s)`;
    }

    renderDonut(s);
    renderRentBars(s);

    const actions = [
      ["actionVersements", s.versementsAttenteCount ?? 0],
      ["actionMessages", s.messagesNonLus ?? 0],
      ["actionRetards", s.lateCount ?? 0],
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
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
    console.error(error);
  }
}

/* ------------------------------------------------------------------
   Graphiques : occupation + loyers encaissés
   ------------------------------------------------------------------- */

function renderDonut(s) {
  const donut = document.getElementById("occupancyDonut");
  const pctEl = document.getElementById("occupancyPct");
  const subEl = document.getElementById("occupancySub");
  const legendEl = document.getElementById("occupancyLegend");
  if (!donut || !legendEl) return;

  const total = s.totalLogements || 0;
  const occ = s.logementsOccupes || 0;
  const libre = s.logementsLibres || 0;
  const maint = Math.max(0, total - occ - libre);
  const pct = total ? Math.round((occ / total) * 100) : 0;

  donut.style.setProperty("--val", pct);
  if (pctEl) pctEl.textContent = total ? pct + "%" : "—";
  if (subEl) subEl.textContent = total ? total + " logement(s) au total" : "Aucun logement géré";

  const items = [
    ["Occupés", occ, "#f59e0b"],
    ["Libres", libre, "#60a5fa"],
    ["Maintenance", maint, "#e5a017"],
  ];
  legendEl.innerHTML =
    items
      .map(
        ([label, count, color]) =>
          '<div class="legend-item"><span class="legend-dot" style="background:' +
          color +
          ';"></span><span>' +
          label +
          "</span><b>" +
          count +
          "</b></div>"
      )
      .join("") || '<div class="legend-item"><span>Aucune donnée</span></div>';
}

function renderRentBars(s) {
  const barsEl = document.getElementById("rentBars");
  const subEl = document.getElementById("rentChartSub");
  if (!barsEl) return;

  const series = Array.isArray(s.rentSeries) && s.rentSeries.length ? s.rentSeries : [{ mois: "", paye: 0 }];
  const max = Math.max(1, ...series.map((m) => Number(m.paye || 0)));
  if (subEl) subEl.textContent = "Encaissé sur les 6 derniers mois";

  barsEl.innerHTML = series
    .map((m) => {
      const fill = Math.round((Number(m.paye || 0) / max) * 100);
      return (
        '<div class="bar-row">' +
        '<span class="bar-label">' +
        escapeHtml(m.mois ? m.mois.slice(5) + "/" + m.mois.slice(2, 4) : "—") +
        '</span><div class="bar-track"><div class="bar-fill" style="--fill:' +
        fill +
        ';"></div></div>' +
        '<span class="bar-value">' +
        escapeHtml(fmtShortFCFA(m.paye)) +
        "</span></div>"
      );
    })
    .join("");
}

/* ------------------------------------------------------------------
   Identité (profil agence)
   ------------------------------------------------------------------- */

async function loadUserName() {
  try {
    const res = await fetch(`${API}/auth/me`, { credentials: "include" });
    const { ok, error, data } = await MIM.parse(res);
    if (!ok) {
      if (!MIM.handleAuthError(error)) console.error(error);
      return;
    }
    const el = document.getElementById("ownerName");
    if (el) el.textContent = data.user && data.user.name;
  } catch (error) {
    console.error(error);
  }
}

/* ------------------------------------------------------------------
   Rendu des sections
------------------------------------------------------------------- */

function renderPortfolio(portfolio) {
  const el = document.getElementById("portfolioList");
  if (!el) return;
  if (!portfolio.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">▤</span>Aucun bien dans le portefeuille.</div>';
    return;
  }
  el.innerHTML = portfolio.slice(0, 5).map((p) => {
    const b = p.bien || {};
    const owner = p.proprietaire;
    const lines = [
      `${b.logements_count ?? 0} logement(s) · ${b.logements_occupes ?? 0} occupé(s)`,
      owner ? `Géré pour ${escapeHtml(owner.name)}` : "",
    ].filter(Boolean);
    return listItem(`
      <h3>${escapeHtml(b.nom || `Bien #${p.bien_id}`)}</h3>
      <p>${escapeHtml(b.type || "")}${b.ville ? " — " + escapeHtml(b.ville) : ""}</p>
      <p>${escapeHtml(lines.join(" · "))}</p>
      ${b.loyer_total ? `<p><strong>${fmtShortFCFA(b.loyer_total)}</strong> de loyers cumulés</p>` : ""}
      <a class="btn btn-edit btn-sm" href="/PartAgence/second_Mode/bien.html?bien=${p.bien_id}">Gérer ce bien</a>`);
  }).join("");
}

function renderOwners(owners) {
  const el = document.getElementById("ownersList");
  if (!el) return;
  if (!owners.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">◉</span>Aucun propriétaire géré.</div>';
    return;
  }
  el.innerHTML = owners.slice(0, 5).map((o) => {
    return listItem(`
      <h3>${escapeHtml(o.nom || "Propriétaire")}</h3>
      <p>${escapeHtml(o.email || o.phone || o.username || "")} · ${o.biens_count} bien(s) géré(s)</p>
      <a class="btn btn-edit btn-sm" href="proprietaires.html?proprietaire=${o.proprietaire_id}">Voir</a>`);
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
        <h3>${escapeHtml(n.message)}</h3>
        <p>${formatDateTime(n.created_at)}</p>
      </div>
      <div class="card-actions">
        ${n.lu ? "" : `<button class="btn btn-edit btn-sm" data-mark-notif="${n.id}" title="Marquer comme lue">✓</button>`}
        <button class="btn btn-delete btn-sm" data-del-notif="${n.id}" title="Supprimer">✕</button>
      </div>
    </div>`).join("");
}

/* ------------------------------------------------------------------
   Charges des listes (une passe = toutes les sections)
------------------------------------------------------------------- */

async function loadOverview() {
  try {
    const responsesData = await Promise.all([
      fetch(`${API}/agence/portefeuille`, { credentials: "include" }),
      fetch(`${API}/agence/proprietaires`, { credentials: "include" }),
      fetch(`${API}/notifications`, { credentials: "include" }),
    ]);

    const notOk = responsesData.find((res) => !res.ok);
    if (notOk) {
      const { ok: parsedOk, error } = await MIM.parse(notOk);
      if (parsedOk || !MIM.handleAuthError(error)) throw new Error(MIM.userMessage(error) || "Erreur de chargement des données.");
    }

    const parse = async (res) => {
      const json = await res.json();
      return json.data || [];
    };
    const data = await Promise.all(responsesData.map(parse));

    renderPortfolio(data[0]);
    renderOwners(data[1]);
    renderNotifications(data[2]);
  } catch (error) {
    console.error(error);
    for (const id of ["portfolioList", "ownersList", "recentNotifications"]) {
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
    showToast("Notification marquée comme lue.");
    track(loadStats());
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

  setInterval(() => {
    if (!document.hidden) {
      track(loadStats());
      track(loadSubscriptionBanner());
    }
  }, 60_000);

  setInterval(() => {
    if (!document.hidden) track(loadOverview());
  }, 180_000);

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
});