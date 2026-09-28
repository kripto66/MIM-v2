// PHASE 6 — Lobby du bien géré (MODE 2).
// API (préfixée `/api/agence/bien/<id>` par scope.js) fournissent
// `/contexte` et `/stats/dashboard` au même chemin relatif.

function fmtFCFA(n) {
  return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
}

function fmtShortFCFA(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M FCFA`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} k FCFA`;
  return `${v} FCFA`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function displayMessage(text, type = "error") {
  const el = document.getElementById("apiMessage");
  if (!el) return;
  el.textContent = text;
  el.className = type;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 5000);
}

function redirectFirstMode() {
  location.href = "/PartAgence/first_Mode/dashboard.html";
}

function hasMode2Scope() {
  return Boolean(
    window.MIM &&
    MIM.agenceMode2 &&
    !MIM.mode2Blocked &&
    MIM.agenceBien &&
    MIM.agenceBien.id &&
    MIM.apiBase &&
    MIM.mode2ContextPromise
  );
}

// Ajoute ?bien=<id> sur chaque lien de sous-page du MODE 2,
// afin que scope.js retrouve le scope lors du changement de page.
function exposeMode2Links() {
  const bien = window.MIM && window.MIM.agenceBien;
  if (!hasMode2Scope() || !bien || !bien.id) return;
  document.querySelectorAll("#shortcutGrid a[href], #sidebar a[href*='.html']").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch (e) {
      return;
    }
    if (url.origin !== window.location.origin || url.pathname.indexOf("/PartAgence/second_Mode/") !== 0) return;
    if (!url.searchParams.has("bien")) url.searchParams.set("bien", bien.id);
    a.setAttribute("href", url.pathname + url.search + url.hash);
  });
}

async function load() {
  const bien = window.MIM && window.MIM.agenceBien;
  if (!hasMode2Scope() || !bien || !bien.id) {
    displayMessage("Aucun bien sélectionné. Retour au portefeuille…");
    setTimeout(redirectFirstMode, 900);
    return;
  }

  if (window.MIM && MIM.mode2ContextPromise) {
    try {
      await MIM.mode2ContextPromise;
    } catch (err) {
      if (err && err.status === 401 && typeof MIM.handleAuthError === "function") {
        MIM.handleAuthError(err);
      } else {
        redirectFirstMode();
      }
      return;
    }
  }

  try {
    const [ctxRes, statsRes] = await Promise.all([
      fetch(`${API}/contexte`, { credentials: "include" }),
      fetch(`${API}/stats/dashboard`, { credentials: "include" }),
    ]);

    for (const res of [ctxRes, statsRes]) {
      if (!res.ok) {
        const { ok, error } = await MIM.parse(res);
        if (ok || !MIM.handleAuthError(error)) {
          throw new Error(MIM.userMessage(error) || "Erreur de chargement du bien.");
        }
        return;
      }
    }

    const ctx = await ctxRes.json();
    const st = await statsRes.json();

    if (!ctx.success || !ctx.data) {
      throw new Error(ctx.message || "Contexte indisponible.");
    }

    const { bien: bienInfo, proprietaire, stats } = ctx.data;
    const s = st.stats || {};

    bien.nom = bienInfo && bienInfo.nom ? bienInfo.nom : "Bien #" + bien.id;
    bien.proprietaireNom = proprietaire ? proprietaire.name : null;
    try {
      sessionStorage.setItem("mim_agence_bien_v1", JSON.stringify(bien));
    } catch (e) {
      console.warn("[MIM] sessionStorage: contexte de bien non sauvegarde", e);
    }

    // En-tête.
    document.title = `MIM — ${bien.nom}`;
    setText("bienTitle", `${bien.nom}${bienInfo && bienInfo.ville ? " — " + bienInfo.ville : ""}.`);
    setText("bienSub", `${bienInfo ? bienInfo.type || "" : ""}${proprietaire ? " · géré pour " + proprietaire.name : ""}${bienInfo && bienInfo.adresse ? " · " + bienInfo.adresse : ""}`);

    const banner = document.getElementById("bienBanner");
    if (banner) {
      banner.textContent = `Propriétaire : ${proprietaire ? proprietaire.name + " (" + (proprietaire.email || "—") + ")" : "—"} · bien géré par votre agence.`;
      banner.hidden = false;
    }

    // KPI (données réelles du bien, jamais de valeurs figées).
    setText("kpiLogements", s.totalProperties ?? stats.logements ?? 0);
    setText("kpiLogementsSub", `${s.occupiedProperties ?? stats.logementsOccupes ?? 0} occupé(s) · ${s.availableProperties ?? stats.logementsLibres ?? 0} libre(s)`);
    setText("kpiLocataires", s.totalTenants ?? stats.locataires ?? 0);
    setText("kpiLocatairesSub", `${stats.locatairesOccupes ?? 0} logement(s) occupé(s)`);
    setText("kpiPaidRent", fmtShortFCFA(s.paidRent));
    setText("kpiPaidRentSub", `sur ${fmtFCFA(s.expectedRent)} attendus ce mois`);
    const progress = document.getElementById("kpiRentProgress");
    if (progress) {
      const pct = s.expectedRent > 0 ? Math.min(100, Math.round((s.paidRent / s.expectedRent) * 100)) : 0;
      progress.style.width = `${pct}%`;
    }
    setText("kpiLateRent", fmtShortFCFA(s.lateRent));
    setText("kpiLateSub", s.lateCount > 0 ? `${s.lateCount} loyer(s) en retard` : "Aucun loyer en retard");
    setText("kpiIncidents", s.activeIncidents ?? stats.incidentsActifs ?? 0);
    setText("kpiIncidentsSub", (s.activeIncidents ?? 0) > 0 ? "à traiter" : "aucun incident ouvert");
    setText("kpiInterventions", s.activeInterventions ?? 0);
    setText("kpiInterventionsSub", (s.activeInterventions ?? 0) > 0 ? "en cours" : "aucune intervention");

    // Raccourcis : compteurs réels + désactivation quand la section est vide.
    const compteurs = {
      "shortcut-logements": s.totalProperties ?? stats.logements ?? 0,
      "shortcut-locataires": s.totalTenants ?? stats.locataires ?? 0,
      "shortcut-paiements": s.lateCount ?? 0,
      "shortcut-incidents": s.activeIncidents ?? 0,
      "shortcut-prestataires": stats.prestataires ?? 0,
      "shortcut-interventions": s.activeInterventions ?? 0,
    };
    Object.entries(compteurs).forEach(([id, valeur]) => {
      const badge = document.getElementById(id);
      if (badge) badge.textContent = String(valeur);
    });

    renderShortcutHint(s, stats);

    const live = document.getElementById("liveLabel");
    if (live) live.textContent = `à jour · ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;

    // Rafraîchissement automatique du lobby (comme les autres dashboards).
    if (!bien._live) {
      bien._live = setInterval(load, 180000);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) clearInterval(bien._live);
        else {
          load();
          bien._live = setInterval(load, 180000);
        }
      });
    }
  } catch (err) {
    console.error(err);
    displayMessage(err.message || "Impossible de charger le bien.");
  }
}

function renderShortcutHint(s, stats) {
  const hint = document.getElementById("shortcutHint");
  if (!hint) return;
  const paye = Number(s.paidRent || 0);
  const attendu = Number(s.expectedRent || 0);
  const taux = attendu > 0 ? Math.round((paye / attendu) * 100) : 0;

  if (attendu > 0 && taux < 100) {
    hint.textContent = `Encaissement du mois : ${taux} %. Il reste ${fmtFCFA(attendu - paye)} à encaisser sur ce bien.`;
  } else if (stats.paiementsEnValidation) {
    hint.textContent = `${stats.paiementsEnValidation} paiement(s) attendent votre validation.`;
  } else if (attendu > 0) {
    hint.textContent = "Tous les loyers attendus ce mois sont encaissés.";
  } else {
    hint.textContent = "Aucun loyer attendu ce mois sur ce bien.";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  exposeMode2Links();
  load();
});