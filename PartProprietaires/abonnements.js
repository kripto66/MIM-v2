// API, apiRequest, showToast, escapeHtml sont fournis par api.js/mim-errors.js.

function fmtDateFR(value) {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

function fmtFCFA(n) {
  if (n == null || isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("fr-FR") + " FCFA";
}

function parseResult() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("paiement");
  if (code === "succes") {
    showToast("Paiement reçu. Votre abonnement sera activé dans quelques instants.", "success");
    setTimeout(loadAll, 2500);
  } else if (code === "simule") {
    showToast("Paiement simulé enregistré. L'abonnement sera activé après confirmation du webhook.", "info");
    setTimeout(loadAll, 1200);
  } else if (code === "echec") {
    showToast("Le paiement n'a pas été validé. Vous pouvez réessayer.", "error");
    setTimeout(loadAll, 1500);
  }
}

async function loadSubscription() {
  const el = document.getElementById("subStatus");
  const pendingSection = document.getElementById("pendingSection");
  const pendingPanel = document.getElementById("pendingPanel");
  try {
    const { subscription } = await apiRequest("/subscription/me");
    if (!subscription) {
      el.innerHTML =
        '<p class="muted">Aucun abonnement actif enregistré pour ce compte. Choisissez un plan ci-dessous pour souscrire en ligne.</p>';
      pendingSection.hidden = true;
      return null;
    }

    const pay = subscription.paiement;
    const pending = pay && pay.overlay;
    pendingSection.hidden = !pending;
    if (pending) {
      pendingPanel.innerHTML =
        "Paiement <strong>" + escapeHtml(pay.statut) + "</strong>" +
        (pay.reference ? " — référence : " + escapeHtml(pay.reference) : "") +
        (pay.provider === "bictorys" ? " (Bictorys)" : "") +
        ". Dès confirmation du webhook, votre abonnement passe automatiquement à « actif ». " +
        '<button type="button" class="btn btn-secondary" id="refreshPendingBtn">Actualiser</button>';
      const btn = document.getElementById("refreshPendingBtn");
      if (btn) {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await apiRequest("/subscription/checkout/refresh", { method: "POST" });
          } catch (e) {
            showToast(e.message || "Vérification impossible.", "error");
          }
          loadAll();
        });
      }
    }

    const badge =
      subscription.trial && subscription.trial.windowActive
        ? '<span class="sub-badge sub-ok">Essai gratuit actif</span>'
        : subscription.statut === "actif"
          ? '<span class="sub-badge sub-ok">Abonnement actif</span>'
          : '<span class="sub-badge sub-exp">Abonnement expiré</span>';
    const immeubles =
      subscription.immeubles && subscription.immeubles.max != null
        ? subscription.immeubles.count + " / " + subscription.immeubles.max
        : subscription.immeubles
          ? subscription.immeubles.count + " (sans plafond)"
          : "—";

    el.innerHTML =
      '<div class="sub-card">' +
      '<div class="sub-head">' + badge +
      "<span>Plan : <strong>" + escapeHtml(subscription.planNom || subscription.plan || "standard") + "</strong></span>" +
      "<span>Jours restants : <strong>" + subscription.joursRestants + "</strong></span>" +
      "</div>" +
      "<ul class='sub-list'>" +
      "<li>Limite d'immeubles : <strong>" + escapeHtml(immeubles) + "</strong></li>" +
      "<li>Début : " + fmtDateFR(subscription.date_debut) + "</li>" +
      "<li>Expiration : " + fmtDateFR(subscription.date_expiration) + "</li>" +
      "<li>Dernier paiement : " + fmtDateFR(subscription.date_paiement) + "</li>" +
      "<li>Montant : " + (subscription.montant != null ? fmtFCFA(subscription.montant) : "—") + "</li>" +
      "<li>Méthode : " + escapeHtml(subscription.methode_paiement || "—") + "</li>" +
      "<li>Référence : " + escapeHtml(subscription.reference || "—") + "</li>" +
      "</ul></div>";

    return subscription;
  } catch (err) {
    el.innerHTML = "<p class='muted'>Impossible de charger l'abonnement : " + escapeHtml(err.message) + "</p>";
    pendingSection.hidden = true;
    return null;
  }
}

// Vitrine propriétaire publiée : seules ces trois formules sont
// proposées à la souscription. Le plan « essai » n'est jamais
// achetable (PLAN_CODES ne le contient pas) et le plan « agence »
// propriétaire (50 000 XOF) est retiré de la vitrine tout en restant
// actif en base : les abonnements en cours continuent de le resolver.
const PLANS_VITRINE = ["standard", "premium", "pro"];

// État du mode essai 30 jours, renvoyé par GET /subscription/plans.
// Quand le compte est éligible (ou déjà en essai), les boutons de la
// vitrine deviennent « Essai gratuit 30j » et le checkout est en pause.
let TRIAL_INFO = null;

function trialOn() {
  return Boolean(TRIAL_INFO && TRIAL_INFO.enabled && (TRIAL_INFO.windowActive || TRIAL_INFO.eligible));
}

// Argumentaire commercial par formule (contenu de la carte).
// Les capacités (biens, logements, locataires, employés,
// prestataires) viennent TOUJOURS de l'API, jamais d'ici.
const PLAN_PITCH = {
  standard: {
    tagline: "Pour démarrer avec un bien",
    features: [
      "Gestion locataires, baux & paiements",
      "Incidents, prestataires & interventions",
    ],
  },
  premium: {
    tagline: "Pour plusieurs immeubles",
    features: [
      "Gestion locataires, baux & paiements",
      "Tableaux de bord & statistiques",
    ],
  },
  pro: {
    tagline: "Pour un parc conséquent",
    features: ["Accès multi-utilisateurs", "Rapports détaillés & suivi complet"],
  },
};

// Fonctionnalités communes si le catalogue fait apparaître une
// formule inconnue de PLAN_PITCH : la carte reste affichable.
const BASE_FEATURES = [
  "Gestion des locataires",
  "Paiements & échéances",
  "Signalements & incidents",
  "Gestion des employés",
  "Gestion des prestataires",
];

function qty(n, singulier) {
  return Number(n).toLocaleString("fr-FR") + " " + singulier + (Number(n) > 1 ? "s" : "");
}

// Une capacité à NULL en base signifie « illimitée »
// (check_quota_for_plan saute le test quand la colonne est NULL).
function capPart(max, singulier) {
  if (max === null || max === undefined) {
    return singulier.charAt(0).toUpperCase() + singulier.slice(1) + "s illimités";
  }
  if (!(Number(max) > 0)) return null;
  return qty(max, singulier);
}

// « 1 bien · 20 logements · 20 locataires » — un bien peut être un
// hôtel, un immeuble, une villa, une résidence…
function capacityLine(plan) {
  return [
    capPart(plan.max_immeubles, "bien"),
    capPart(plan.max_logements, "logement"),
    capPart(plan.max_locataires, "locataire"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function teamLine(max, singulier) {
  if (max === null || max === undefined) {
    return singulier.charAt(0).toUpperCase() + singulier.slice(1) + "s illimités";
  }
  return qty(max, singulier);
}

function renderPlans(plans, current) {
  const grid = document.getElementById("plansGrid");
  const vitrine = (plans || []).filter((p) => p && PLANS_VITRINE.includes(p.code));
  if (!vitrine.length) {
    grid.innerHTML = '<p class="muted">Aucun plan disponible pour le moment.</p>';
    return;
  }
  const currentCode = current ? current.planCode : null;
  const useTrial = trialOn();
  const hasPremium = vitrine.some((p) => p.code === "premium");
  const popularCode = hasPremium ? "premium" : (vitrine[Math.floor(vitrine.length / 2)] || {}).code;

  grid.innerHTML = vitrine
    .map((p) => {
      const isCurrent = currentCode && currentCode === p.code;
      const isPopular = p.code === popularCode;
      const pitch = PLAN_PITCH[p.code] || { tagline: "", features: BASE_FEATURES };
      const lines = [];
      const capacity = capacityLine(p);
      if (capacity) lines.push(capacity);
      pitch.features.forEach((label) => lines.push(label));
      // Plafonds d'équipe : renseignés seulement si le catalogue les
      // renvoie, sinon la carte garde ses lignes sans inventer « illimité ».
      if ("max_employes" in p) {
        lines.push(teamLine(p.max_employes, "employé") + " · tableau de bord");
      }
      if ("max_prestataires" in p) {
        lines.push(teamLine(p.max_prestataires, "prestataire"));
      }
      const included = lines.map((label) => "<li>" + escapeHtml(label) + "</li>").join("");
      const name = String(p.nom || "") || p.code;
      const period = p.duree_abonnement === 1 ? "/mois" : "/" + p.duree_abonnement + " mois";
      return (
        '<div class="plan-card plan-accent-' + escapeHtml(p.audience || "proprietaire") + (isCurrent ? " plan-active" : "") + (isPopular ? " plan-popular" : "") + '">' +
        '<div class="plan-top">' +
        (isPopular ? '<span class="plan-badge">Le plus populaire</span>' : "") +
        (pitch.tagline ? '<p class="plan-for">' + escapeHtml(pitch.tagline) + "</p>" : "") +
        '<h3 class="plan-name">' + escapeHtml(name) + "</h3>" +
        '<div class="plan-price">' + Number(p.prix).toLocaleString("fr-FR") +
        ' <span class="plan-period">' + escapeHtml(p.devise || "XOF") + escapeHtml(period) + "</span></div>" +
        "</div>" +
        '<ul class="plan-features">' + included + "</ul>" +
        '<div class="plan-actions">' +
        (isCurrent
          ? '<button type="button" class="btn-plan" disabled>Plan actuel</button>'
          : useTrial
            ? '<button type="button" class="btn-plan" data-trial-plan="' + escapeHtml(p.code) + '">Essai gratuit 30j</button>'
            : '<button type="button" class="btn-plan" data-pay-plan="' + escapeHtml(p.code) + '">Choisir ce plan</button>') +
        (isCurrent || !useTrial ? "" : '<p class="plan-trial">Essai gratuit pendant 30 jours</p>') +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

async function loadPlans(current) {
  const grid = document.getElementById("plansGrid");
  try {
    const res = await apiRequest("/subscription/plans");
    TRIAL_INFO = res.trial || null;
    renderPlans(res.plans || [], current);
    const note = document.getElementById("paymentNote");
    if (note) {
      note.textContent = trialOn()
        ? "Essai gratuit de 30 jours — changez de plan à tout moment, sans paiement."
        : "Paiement traité par Bictorys — activation dès sa confirmation.";
    }
  } catch (err) {
    grid.innerHTML = '<p class="muted">Impossible de charger les plans : ' + escapeHtml(err.message) + "</p>";
  }
}

function securePaymentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function payPlan(code) {
  const btns = document.querySelectorAll("[data-pay-plan]");
  const clicked = Array.from(btns).find((b) => b.dataset.payPlan === code);
  if (clicked) {
    clicked.disabled = true;
    clicked.textContent = "Redirection…";
  }
  try {
    showToast("Création de la charge de paiement…", "success");
    const res = await apiRequest("/subscription/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `checkout-${Date.now()}-${Math.random()}` },
      body: JSON.stringify({ plan: code }),
    });
    const link = res && res.checkout ? res.checkout.link : null;
    const secureLink = securePaymentUrl(link);
    if (secureLink) {
      window.location.href = secureLink;
    } else {
      if (clicked) {
        clicked.disabled = false;
        clicked.textContent = "Choisir ce plan";
      }
      showToast("Lien de paiement invalide.", "error");
      loadAll();
    }
  } catch (err) {
    if (clicked) {
      clicked.disabled = false;
      clicked.textContent = "Choisir ce plan";
    }
    showToast(err.message || "Impossible de lancer le paiement.", "error");
  }
}

// Démarre (ou change vers) un plan pendant l'essai gratuit de 30 j.
async function trialPlan(code) {
  const btns = document.querySelectorAll("[data-trial-plan]");
  const clicked = Array.from(btns).find((b) => b.dataset.trialPlan === code);
  if (clicked) {
    clicked.disabled = true;
    clicked.textContent = "Activation…";
  }
  try {
    const res = await apiRequest("/subscription/trial", {
      method: "POST",
      body: JSON.stringify({ plan: code }),
    });
    showToast(res && res.message ? res.message : "Essai gratuit activé.", "success");
    await loadAll();
  } catch (err) {
    if (clicked) {
      clicked.disabled = false;
      clicked.textContent = "Essai gratuit 30j";
    }
    showToast(err.message || "Impossible de démarrer l'essai.", "error");
    loadAll();
  }
}

function renderPayments(data) {
  const el = document.getElementById("paymentsHistory");
  if (!data || !data.length) {
    el.innerHTML = '<p class="muted">Aucun paiement d\'abonnement pour le moment.</p>';
    return;
  }
  const pills = {
    paid: '<span class="status-pill ok">Payé</span>',
    pending: '<span class="status-pill pending">En attente</span>',
    failed: '<span class="status-pill failed">Échoué</span>',
    cancelled: '<span class="status-pill failed">Annulé</span>',
  };
  el.innerHTML =
    '<div class="table-wrap" style="overflow-x:auto;">' +
    '<table class="payments-table">' +
    "<thead><tr><th>Plan</th><th>Montant</th><th>Méthode</th><th>Référence</th><th>Statut</th><th>Payé le</th><th>Expiration</th></tr></thead>" +
    "<tbody>" +
    data
      .map(
        (p) =>
          "<tr>" +
          "<td>" + escapeHtml(p.plan || "—") + "</td>" +
          "<td>" + fmtFCFA(p.montant) + "</td>" +
          "<td>" + escapeHtml(p.provider === "bictorys" ? "Bictorys" : p.methode_paiement || p.provider || "—") + "</td>" +
          "<td>" + escapeHtml(p.reference || p.transactionId || "—") + "</td>" +
          "<td>" + (pills[p.statut] || escapeHtml(p.statut || "—")) + "</td>" +
          "<td>" + fmtDateFR(p.date_paiement) + "</td>" +
          "<td>" + fmtDateFR(p.date_expiration) + "</td>" +
          "</tr>"
      )
      .join("") +
    "</tbody></table></div>";
}

async function loadPayments() {
  const el = document.getElementById("paymentsHistory");
  try {
    const res = await apiRequest("/subscription/payments");
    renderPayments(res.payments || []);
  } catch (err) {
    el.innerHTML = '<p class="muted">Impossible de charger l\'historique : ' + escapeHtml(err.message) + "</p>";
  }
}

async function loadAll() {
  const current = await loadSubscription();
  await loadPlans(current);
  await loadPayments();
}

async function redirectAgenceReturn() {
  if (window.location.pathname.indexOf("/PartProprietaires/") !== 0) return false;
  try {
    const { user } = await apiRequest("/auth/me");
    if (user && user.account_type) MIM.accountType = user.account_type;
    if (!user || user.account_type !== "agence") return false;
    window.location.replace("/PartAgence/first_Mode/abonnements.html" + window.location.search);
    return true;
  } catch {
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  if (await redirectAgenceReturn()) return;
  const grid = document.getElementById("plansGrid");
  if (grid) {
    grid.addEventListener("click", (ev) => {
      const trialBtn = ev.target.closest("[data-trial-plan]");
      if (trialBtn) {
        trialPlan(trialBtn.dataset.trialPlan);
        return;
      }
      const btn = ev.target.closest("[data-pay-plan]");
      if (btn) payPlan(btn.dataset.payPlan);
    });
  }
  parseResult();
  loadAll();
});