// ============================================================
// MIM - Abonnement propriétaire
//
// L'état réel d'un abonnement est TOUJOURS dérivé de
// date_expiration côté serveur. Une valeur envoyée par le frontend
// n'est jamais utilisée : si date_expiration <= maintenant, le compte
// est considéré expiré, quelle que soit la colonne `statut`.
//
// Un compte sans abonnement enregistré conserve son accès (héritage) :
// l'expiration ne s'applique qu'aux abonnements réellement enregistrés.
//
// Paiement en ligne (Bictorys) : l'activation d'un abonnement n'est
// JAMAIS faite par le frontend ni par une simple redirection. Elle
// passe uniquement par le webhook Bictorys (statut `succeeded`),
// traité de façon idempotente (journal public.bictorys_webhooks).
// ============================================================

import { serviceClient } from '../app.js';
import { getNow } from './simulation.js';
import { planByCode, planForSubscription, planView, PLAN_CODES } from './plans.js';
import { isConfigured, isSimulate, newPaymentReference, createCharge, getTransaction, country } from '../providers/bictorys.js';
import { notify } from './notifications.js';

const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];
const DAY_MS = 24 * 60 * 60 * 1000;

const envBool = (v) => v === '1' || v === 'true' || v === 'TRUE';
// Démo locale : BICTORYS_AUTOCONFIRM=1 + simulation ⇒ le paiement simulé
// est confirmé via le même chemin que le webhook `succeeded`. En
// production (ou dans les tests E2E) ce flag est désactivé : seule la
// réception du webhook active l'abonnement.
const autoConfirmSim = () => isSimulate() && envBool(process.env.BICTORYS_AUTOCONFIRM);

// Statuts de paiement Bictorys retenus côté MIM.
const PAYMENT_OK = ['succeeded'];
const PAYMENT_FAILED = ['failed', 'cancelled', 'reversed', 'expired', 'timeout'];

// Cache mémoire court : évite une requête Supabase à chaque requête
// protégée, sans jamais masquer une expiration plus de 2 s.
const CACHE_TTL_MS = 2000;
let subCache = new Map();

export function invalidateSubscriptionCache() {
  subCache.clear();
}

async function computeStatus(sub) {
  if (!sub) {
    return {
      statut: 'aucun',
      expired: false,
      plan: null,
      date_debut: null,
      date_expiration: null,
      date_paiement: null,
      montant: null,
      methode_paiement: null,
      reference: null,
      joursRestants: null,
    };
  }

  const now = await getNow();
  const exp = new Date(sub.date_expiration).getTime();
  const expired = !Number.isNaN(exp) && exp <= now;

  return {
    statut: expired ? 'expire' : 'actif',
    expired,
    plan: sub.plan || 'standard',
    date_debut: sub.date_debut || null,
    date_expiration: sub.date_expiration || null,
    date_paiement: sub.date_paiement || null,
    montant: sub.montant == null ? null : Number(sub.montant),
    methode_paiement: sub.methode_paiement || null,
    reference: sub.reference || null,
    joursRestants: expired ? 0 : Math.max(0, Math.ceil((exp - now) / DAY_MS)),
  };
}

async function readSubscription(userId) {
  const cached = subCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const { data, error } = await serviceClient()
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[subscription]', error.message);
      return null;
    }

    subCache.set(userId, { at: Date.now(), data: data || null });
    return data || null;
  } catch (err) {
    console.warn('[subscription]', err.message);
    return null;
  }
}

// Dernier paiement d'abonnement d'un propriétaire (pour l'aperçu de
// statut en cours de traitement : pending / failed / cancelled).
async function latestPayment(userId) {
  try {
    const { data, error } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch (err) {
    return null;
  }
}

export async function countImmeubles(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('biens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) return 0;
    return count || 0;
  } catch (err) {
    return 0;
  }
}

export async function countLogements(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('logements')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) return 0;
    return count || 0;
  } catch (err) {
    return 0;
  }
}

export async function countLocataires(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('locataires')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) return 0;
    return count || 0;
  } catch (err) {
    return 0;
  }
}

async function augmentStatus(userId, sub, base) {
  const plan = sub ? await planForSubscription(sub) : null;
  const latest = await latestPayment(userId);
  const count = await countImmeubles(userId);
  const max = plan && plan.max_immeubles > 0 ? plan.max_immeubles : null;
  const logements = await countLogements(userId);
  const maxLogements = plan && plan.max_logements > 0 ? plan.max_logements : null;
  const locataires = await countLocataires(userId);
  const maxLocataires = plan && plan.max_locataires > 0 ? plan.max_locataires : null;

  const statut = base.statut === 'actif' ? 'actif' : (latest?.statut === 'pending' ? 'pending' : base.statut);

  return {
    ...base,
    statut,
    planNom: plan?.nom || null,
    planId: plan?.id || null,
    planCode: plan?.code || null,
    devise: plan?.devise || latest?.devise || 'XOF',
    max_immeubles: max,
    max_logements: maxLogements,
    max_locataires: maxLocataires,
    duree_abonnement: plan?.duree_abonnement ?? sub?.duree_abonnement ?? null,
    immeubles: {
      count,
      max,
      allowed: max == null ? true : count <= max,
    },
    logements: {
      count: logements,
      max: maxLogements,
      allowed: maxLogements == null ? true : logements <= maxLogements,
    },
    locataires: {
      count: locataires,
      max: maxLocataires,
      allowed: maxLocataires == null ? true : locataires <= maxLocataires,
    },
    paiement: latest
      ? {
          statut: latest.statut,
          provider: latest.provider || null,
          reference: latest.reference || null,
          transactionId: latest.transaction_id || null,
          montant: latest.montant == null ? null : Number(latest.montant),
          devise: latest.devise || 'XOF',
          date_paiement: latest.date_paiement || null,
          overlay: latest.statut !== 'paid',
        }
      : null,
  };
}

// Statut calculé d'un propriétaire (usage exposé au propriétaire).
export async function subscriptionOf(userId) {
  const sub = await readSubscription(userId);
  const base = await computeStatus(sub);

  // Sans abonnement ET sans paiement en ligne en cours → null (héritage).
  if (!sub) {
    const latest = await latestPayment(userId);
    if (!latest || latest.provider !== 'bictorys' || !['pending', 'failed', 'cancelled'].includes(latest.statut)) return null;
    return augmentStatus(userId, null, base);
  }

  return augmentStatus(userId, sub, base);
}

// Pour un compte donné (propriétaire, ou locataire/employé dépendant),
// détermine si le PROPRIÉTAIRE concerné est en expiration d'abonnement.
// La relation est toujours lue en base (account_uid -> user_id), jamais
// depuis une valeur fournie par le client.
export async function subscriptionExpiredFor(userId, accountType) {
  if (!OWNER_TYPES.includes(accountType)) {
    const table = accountType === 'locataire' ? 'locataires' : accountType === 'employe' ? 'employes' : null;
    if (!table) return false;

    try {
      const { data } = await serviceClient()
        .from(table)
        .select('user_id')
        .eq('account_uid', userId)
        .maybeSingle();
      if (!data?.user_id) return false;
      userId = data.user_id;
    } catch (err) {
      console.warn('[subscription]', err.message);
      return true;
    }
  }

  const sub = await readSubscription(userId);
  if (!sub) return false;

  const exp = new Date(sub.date_expiration).getTime();
  const now = await getNow();
  return !Number.isNaN(exp) && exp <= now;
}

// Limite d'immeubles appliquée côté serveur lors de la création d'un
// bien. Retourne null si aucun plafond (héritage), sinon une erreur
// métier structurée utilisable par la route CRUD.
export async function enforceImmeublesLimit(userId) {
  const sub = await readSubscription(userId);
  const plan = sub ? await planForSubscription(sub) : null;
  const max = plan && plan.max_immeubles > 0 ? plan.max_immeubles : null;
  if (max == null) return { allowed: true, count: 0, max: null };

  const count = await countImmeubles(userId);
  if (count >= max) {
    return {
      allowed: false,
      count,
      max,
      plan: plan.code,
      message: `Votre plan ${plan.nom} (${max} immeuble${max > 1 ? 's' : ''}) est atteint. Passez au plan supérieur pour ajouter d'autres immeubles.`,
      code: 'IMMEUBLES_LIMIT_REACHED',
    };
  }
  return { allowed: true, count, max, plan: plan.code };
}

// Limite de logements d'un propriétaire, appliquée à la création d'un
// logement. NULL (héritage/plan sans plafond) ⇒ aucune limite.
export async function enforceLogementsLimit(userId) {
  const sub = await readSubscription(userId);
  const plan = sub ? await planForSubscription(sub) : null;
  const max = plan && plan.max_logements > 0 ? plan.max_logements : null;
  if (max == null) return { allowed: true, count: 0, max: null };

  const count = await countLogements(userId);
  if (count >= max) {
    return {
      allowed: false,
      count,
      max,
      plan: plan.code,
      message: `Votre plan ${plan.nom} (${max} logement${max > 1 ? 's' : ''}) est atteint. Passez au plan supérieur pour ajouter d'autres logements.`,
      code: 'LOGEMENTS_LIMIT_REACHED',
    };
  }
  return { allowed: true, count, max, plan: plan.code };
}

// Limite de locataires d'un propriétaire, appliquée à la création d'un
// locataire. NULL (héritage/plan sans plafond) ⇒ aucune limite.
export async function enforceLocatairesLimit(userId) {
  const sub = await readSubscription(userId);
  const plan = sub ? await planForSubscription(sub) : null;
  const max = plan && plan.max_locataires > 0 ? plan.max_locataires : null;
  if (max == null) return { allowed: true, count: 0, max: null };

  const count = await countLocataires(userId);
  if (count >= max) {
    return {
      allowed: false,
      count,
      max,
      plan: plan.code,
      message: `Votre plan ${plan.nom} (${max} locataire${max > 1 ? 's' : ''}) est atteint. Passez au plan supérieur pour ajouter d'autres locataires.`,
      code: 'LOCATAIRES_LIMIT_REACHED',
    };
  }
  return { allowed: true, count, max, plan: plan.code };
}

// Nouvelle échéance : on prolonge à partir de l'échéance courante si
// elle est encore dans le futur (renouvellement), sinon depuis maintenant.
function addMonths(d, months) {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + months);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

function futureBaseDate(current) {
  const nowIso = new Date().toISOString();
  const curIso = new Date(current).toISOString();
  return curIso > nowIso ? new Date(current) : new Date();
}

// ─── CHECKOUT (Bictorys) ────────────────────────────────────────

// Crée la charge Bictorys pour le plan choisi et enregistre un
// paiement 'pending'. L'abonnement n'est PAS modifié ici : seule
// l'activation après webhook `succeeded` le fait.
export async function createCheckout(userId, planCode) {
  if (!PLAN_CODES.includes(String(planCode).trim().toLowerCase())) {
    const err = new Error('Plan inconnu.');
    err.code = 'PLAN_INVALID';
    throw err;
  }

  if (!isConfigured()) {
    const err = new Error("Le paiement en ligne est momentanément indisponible. Contactez l'administration.");
    err.code = 'PAYMENT_UNAVAILABLE';
    throw err;
  }

  const plan = await planByCode(planCode, true);
  if (!plan) {
    const err = new Error('Ce plan est inactif.');
    err.code = 'PLAN_UNAVAILABLE';
    throw err;
  }

  const sb = serviceClient();
  const sub = await readSubscription(userId);
  const currentExp = sub?.date_expiration || null;

  const paymentReference = newPaymentReference(userId);
  let transactionId = null;
  let link = null;
  let simulated = false;

  try {
    const charge = await createCharge({
      amount: Number(plan.prix),
      currency: plan.devise,
      paymentReference,
      merchantReference: `SUB-${paymentReference}`,
      successRedirectUrl: buildRedirectUrl('succes', paymentReference),
      errorRedirectUrl: buildRedirectUrl('echec', paymentReference),
      customerObject: { locale: 'fr-FR', country: country() },
    });
    transactionId = charge.transactionId;
    link = charge.link;
    simulated = Boolean(charge.simulated);
  } catch (err) {
    err.code = err.code || 'BICTORYS_ERROR';
    throw err;
  }

  const expectedExpiration = addMonths(futureBaseDate(currentExp), plan.duree_abonnement);

  const { data: payment, error } = await sb
    .from('abonnement_paiements')
    .insert({
      user_id: userId,
      plan: plan.code,
      montant: Number(plan.prix),
      devise: plan.devise,
      provider: 'bictorys',
      statut: 'pending',
      reference: paymentReference,
      transaction_id: transactionId,
      methode_paiement: 'bictorys',
      date_debut: new Date().toISOString(),
      date_expiration: expectedExpiration.toISOString(),
      raw_response: { link, simulated },
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) {
    const err = new Error("Erreur lors de l'enregistrement du paiement.");
    err.code = 'DB_ERROR';
    throw err;
  }

  // En mode simulation AUTOCONFIRM, aucun webhook Bictorys réel
  // n'arrivera jamais (le fournisseur n'appelle pas localhost). On
  // confirme donc le paiement immédiatement en empruntant le MÊME chemin
  // que le webhook `succeeded` (idempotent, journalisé). En production
  // ou dans les tests, rien ne change : seul le webhook active.
  if (simulated && autoConfirmSim()) {
    try {
      await processWebhook({
        id: `sim_confirm_${paymentReference}`,
        status: 'succeeded',
        amount: Number(plan.prix),
        currency: plan.devise,
        paymentReference,
        merchantReference: `SUB-${paymentReference}`,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[subscription] confirmation simulée :', e.message);
    }
  }

  return {
    plan: planView(plan),
    checkout: {
      paymentReference,
      transactionId,
      link,
      status: 'pending',
      montant: Number(plan.prix),
      devise: plan.devise,
      simulated,
    },
    payment,
  };
}

function buildRedirectUrl(result, paymentReference) {
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/PartProprietaires/abonnements.html?paiement=${result}&ref=${encodeURIComponent(paymentReference)}`;
}

// ─── WEBHOOK Bictorys ───────────────────────────────────────────

// Journalise le webhook reçu (idempotence par fingerprint UNIQUE).
async function recordWebhook(payload) {
  const fingerprint =
    String(payload?.id || '').trim() ||
    `evt-${String(payload?.paymentReference || '')}-${String(payload?.status || '')}-${String(payload?.timestamp || '')}`;
  const { data, error } = await serviceClient()
    .from('bictorys_webhooks')
    .insert({
      event_id: payload?.id || null,
      merchant_id: payload?.merchantId || null,
      type: payload?.type || 'payment',
      status: String(payload?.status || '').toLowerCase(),
      amount: payload?.amount != null ? Number(payload.amount) : null,
      currency: payload?.currency || null,
      payment_reference: payload?.paymentReference || null,
      merchant_reference: payload?.merchantReference || null,
      payload,
      fingerprint,
      handled: false,
    })
    .select('id, fingerprint')
    .single();

  if (error) {
    const duplicate = String(error.code) === '23505';
    return { duplicate };
  }
  return { id: data.id };
}

async function finalizeWebhook(id, { handledAt, error }) {
  try {
    await serviceClient()
      .from('bictorys_webhooks')
      .update({ handled: true, handled_at: handledAt || new Date().toISOString(), error: error || null })
      .eq('id', id);
  } catch (err) {
    console.warn('[bictorys/webhook] finalize :', err.message);
  }
}

// Trouve le paiement MIM rattaché à l'événement Bictorys
// (paymentReference = reference du paiement, ou id = transaction).
async function findPayment(payload) {
  if (payload?.paymentReference) {
    const { data } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('reference', String(payload.paymentReference))
      .eq('provider', 'bictorys')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { payment: data, match: 'reference' };
  }
  if (payload?.id) {
    const { data } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('transaction_id', String(payload.id))
      .eq('provider', 'bictorys')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { payment: data, match: 'transactionId' };
  }
  return { payment: null };
}

// Activation effective (webhook succeeded OU polling fallback).
// Idempotente : n'applique jamais deux fois le même paiement
// (garde-fou statut='pending' sur le paiement).
export async function applySucceededPayment(payment) {
  const sb = serviceClient();
  const plan = await planByCode(payment.plan, true);

  const { data: claimed, error: claimErr } = await sb
    .from('abonnement_paiements')
    .update({
      statut: 'paid',
      transaction_id: payment.transaction_id,
      date_paiement: payment.date_paiement || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .eq('statut', 'pending')
    .select('id')
    .single();

  // Déjà traité (relecture concurrente de webhook) → rien à faire.
  if (claimErr || !claimed) return { applied: false };

  const existing = await readSubscription(payment.user_id);
  const base = futureBaseDate(existing?.date_expiration || new Date());
  const duration = plan?.duree_abonnement || 1;
  const newExpiration = addMonths(base, duration);

  const { error: subErr } = await sb
    .from('subscriptions')
    .upsert(
      {
        user_id: payment.user_id,
        plan: plan?.code || payment.plan,
        plan_id: plan?.id || null,
        statut: 'actif',
        date_debut: existing?.date_debut || new Date().toISOString(),
        date_expiration: newExpiration.toISOString(),
        date_paiement: new Date().toISOString(),
        montant: Number(payment.montant),
        methode_paiement: 'bictorys',
        reference: payment.reference || null,
        bictorys_transaction_id: payment.transaction_id || null,
        bictorys_reference: payment.reference || null,
        duree_abonnement: duration,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  if (subErr) throw subErr;

  invalidateSubscriptionCache();
  try {
    await notify(payment.user_id, 'abonnement', `Votre abonnement MIM ${plan?.nom || payment.plan} est actif (${duration} mois). Merci !`);
  } catch (e) {
    console.warn('[bictorys] notification :', e.message);
  }
  return { applied: true, newExpiration: newExpiration.toISOString() };
}

// Point d'entrée des notifications Bictorys (route POST /api/webhooks/bictorys).
export async function processWebhook(payload) {
  const status = String(payload?.status || '').trim().toLowerCase();
  if (!status || !payload?.paymentReference && !payload?.id) {
    return { ok: false, code: 'MALFORMED_EVENT' };
  }

  const rec = await recordWebhook(payload);
  if (rec.duplicate) return { ok: true, duplicate: true };

  let result = { ok: true };
  try {
    const { payment } = await findPayment(payload);
    if (!payment) {
      result = { ok: true, unmatched: true };
      return result;
    }

    // Montant attendu : on refuse d'activer un paiement dont le montant
    // diffère de la charge, pour limiter les webhooks contrefaits valides.
    if (payload.amount != null && Number(payload.amount) !== Number(payment.montant)) {
      const e = new Error(`Montant inattendu : ${payload.amount} (attendu ${payment.montant}).`);
      throw Object.assign(e, { webhookResult: { ok: false, code: 'AMOUNT_MISMATCH', matchedPayment: payment.reference } });
    }

    if (PAYMENT_OK.includes(status)) {
      const applied = await applySucceededPayment({ ...payment, transaction_id: payload?.id || payment.transaction_id });
      result = { ok: true, ...applied };
      return result;
    }

    if (PAYMENT_FAILED.includes(status)) {
      if (payment.statut === 'pending') {
        await serviceClient()
          .from('abonnement_paiements')
          .update({
            statut: status === 'cancelled' ? 'cancelled' : 'failed',
            raw_response: payload,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payment.id);
        invalidateSubscriptionCache();
      }
      try {
        await notify(payment.user_id, 'abonnement', `Votre paiement d'abonnement a été ${status === 'cancelled' ? 'annulé' : 'refusé'}. Veuillez réessayer.`);
      } catch (e) {
        console.warn('[bictorys] notification echec :', e.message);
      }
      result = { ok: true, failed: status };
    } else if (status === 'authorized') {
      // Autorisation de carte : on note l'événement mais on n'active pas
      // (seul `succeeded` active l'abonnement).
      result = { ok: true, authorized: true };
    }
  } catch (err) {
    result = {
      ok: false,
      code: err.webhookResult?.code || (String(err.code || '') || 'WEBHOOK_PROCESSING_ERROR'),
      message: err.message,
      matchedPayment: err.webhookResult?.matchedPayment,
    };
  } finally {
    await finalizeWebhook(rec.id, { error: result.ok ? null : result.code || 'ERROR' });
  }
  return result;
}

// ─── POLLING FALLBACK ───────────────────────────────────────────
// Si le webhook n'est jamais arrivé, le propriétaire (ou un job)
// interroge Bictorys pour actualiser son paiement en attente.
export async function reconcilePendingPayment(userId) {
  const { data, error } = await serviceClient()
    .from('abonnement_paiements')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'bictorys')
    .eq('statut', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data || !data.transaction_id) {
    return { status: 'none' };
  }

  let txn;
  try {
    // En simulation AUTOCONFIRM, la transaction n'existe pas côté
    // Bictorys : on considère le paiement en attente comme confirmé
    // (miroir du webhook).
    if (autoConfirmSim()) {
      txn = { status: 'succeeded', id: data.transaction_id };
    } else {
      txn = await getTransaction(data.transaction_id);
    }
  } catch (err) {
    return { status: 'error', message: err.message };
  }

  if (PAYMENT_OK.includes(String(txn.status || '').toLowerCase())) {
    const applied = await applySucceededPayment({
      ...data,
      transaction_id: txn.id || data.transaction_id,
      date_paiement: new Date().toISOString(),
    });
    return { status: applied.applied ? 'paid' : 'already_paid' };
  }
  return { status: String(txn.status || 'pending').toLowerCase() };
}