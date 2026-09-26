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
    showToast("Paiement simulé accepté. Votre abonnement est activé.", "success");
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
      subscription.statut === "actif"
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

function dureeLabel(n) { return n === 1 ? "mensuel" : n + " mois"; }

// Fonctionnalités communes : ce que le produit apporte, quelle que
// soit la formule. Les PALIERS (immeubles / logements / locataires)
// viennent de l'API, jamais d'une liste de codes en dur.
const BASE_FEATURES = [
  "Gestion des locataires",
  "Paiements & échéances",
  "Signalements & incidents",
  "Gestion des employés",
  "Gestion des prestataires",
];

function capLine(max, nounPlural) {
  return typeof max === "number" && max > 0 ? max + " " + nounPlural : nounPlural + " illimités";
}

function renderPlans(plans, current) {
  const grid = document.getElementById("plansGrid");
  if (!plans || !plans.length) {
    grid.innerHTML = '<p class="muted">Aucun plan disponible pour le moment.</p>';
    return;
  }
  const currentCode = current ? current.planCode : null;
  const popular = plans[Math.floor(plans.length / 2)];
  grid.innerHTML = plans
    .map((p, index) => {
      const isCurrent = currentCode && currentCode === p.code;
      const isPopular = popular && popular.code === p.code && index === Math.floor(plans.length / 2);
      const included =
        "<li>" + escapeHtml(capLine(p.max_immeubles, "immeuble(s)")) + "</li>" +
        "<li>" + escapeHtml(capLine(p.max_logements, "logement(s)")) + "</li>" +
        "<li>" + escapeHtml(capLine(p.max_locataires, "locataire(s)")) + "</li>" +
        "<li>Employés illimités</li>" +
        "<li>Prestataires illimités</li>";
      const mx = BASE_FEATURES.map((label) => "<li>" + escapeHtml(label) + "</li>").join("");
      const name = String(p.nom || "") || p.code;
      const period = p.duree_abonnement === 1 ? "/mois" : "/" + p.duree_abonnement + " mois";
      return (
        '<div class="plan-card plan-accent-' + escapeHtml(p.audience || "proprietaire") + (isCurrent ? " plan-active" : "") + (isPopular ? " plan-popular" : "") + '">' +
        '<div class="plan-top">' +
        (isPopular ? '<span class="plan-badge">Le plus choisi</span>' : "") +
        '<h3 class="plan-name">' + escapeHtml(name) + "</h3>" +
        '<div class="plan-price">' + Number(p.prix).toLocaleString("fr-FR") +
        ' <span class="plan-period">' + escapeHtml(p.devise || "XOF") + escapeHtml(period) + "</span></div>" +
        '<div class="plan-desc">' + escapeHtml(p.description || (p.devise + " · " + dureeLabel(p.duree_abonnement) + " · paiement sécurisé")) + "</div>" +
        "</div>" +
        '<ul class="plan-features">' + included + mx + "</ul>" +
        '<div class="plan-actions">' +
        (isCurrent
          ? '<button type="button" class="btn-plan" disabled>Plan actuel</button>'
          : '<button type="button" class="btn-plan" data-pay-plan="' + escapeHtml(p.code) + '">Choisir ce plan</button>') +
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
    renderPlans(res.plans || [], current);
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
  btns.forEach((b) => (b.disabled = true));
  try {
    showToast("Création de la charge de paiement…", "info");
    const res = await apiRequest("/subscription/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ plan: code }),
    });
    const link = res && res.checkout ? res.checkout.link : null;
    const secureLink = securePaymentUrl(link);
    if (secureLink) {
      window.location.href = secureLink;
    } else {
      btns.forEach((b) => (b.disabled = false));
      showToast("Lien de paiement invalide.", "error");
      loadAll();
    }
  } catch (err) {
    btns.forEach((b) => (b.disabled = false));
    showToast(err.message || "Impossible de lancer le paiement.", "error");
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

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("plansGrid");
  if (grid) {
    grid.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-pay-plan]");
      if (btn) payPlan(btn.dataset.payPlan);
    });
  }
  parseResult();
  loadAll();
});