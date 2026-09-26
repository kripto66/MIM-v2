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

import crypto from 'node:crypto';
import { serviceClient } from '../app.js';
import { getNow } from './simulation.js';
import { planByCode, planForSubscription, planView, PLAN_CODES, audienceForAccount } from './plans.js';
import { isConfigured, isSimulate, newPaymentReference, createCharge, getTransaction, country } from '../providers/bictorys.js';
import { paymentLinkError } from './paiementMethodes.js';
import { notify } from './notifications.js';
import { parseMoney } from './inputValidation.js';

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
const PERMANENT_WEBHOOK_CODES = new Set([
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'MERCHANT_REFERENCE_MISMATCH',
  'TRANSACTION_MISMATCH',
  'TRANSACTION_MISSING',
  'PLAN_UNAVAILABLE',
  'UNSUPPORTED_STATUS',
]);

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

    if (error) throw new Error(error.message);

    subCache.set(userId, { at: Date.now(), data: data || null });
    return data || null;
  } catch (err) {
    console.warn('[subscription]', err.message);
    throw new Error(`Lecture abonnement indisponible: ${err.message}`);
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
    if (error) throw new Error(error.message);
    return data || null;
  } catch (err) {
    throw new Error(`Lecture du dernier paiement indisponible: ${err.message}`);
  }
}

export async function countImmeubles(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('biens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (err) {
    throw new Error(`Compteur d'immeubles indisponible: ${err.message}`);
  }
}

export async function countLogements(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('logements')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (err) {
    throw new Error(`Compteur de logements indisponible: ${err.message}`);
  }
}

export async function countLocataires(userId) {
  try {
    const { count, error } = await serviceClient()
      .from('locataires')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('superseded_at', null);
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (err) {
    throw new Error(`Compteur de locataires indisponible: ${err.message}`);
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
      const { data, error } = await serviceClient()
        .from(table)
        .select('user_id')
        .eq('account_uid', userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
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
  if (sub && !plan) return { allowed: false, code: 'PLAN_UNAVAILABLE', message: 'Le plan d\'abonnement est indisponible.', count: 0, max: null };
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
  if (sub && !plan) return { allowed: false, code: 'PLAN_UNAVAILABLE', message: 'Le plan d\'abonnement est indisponible.', count: 0, max: null };
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
  if (sub && !plan) return { allowed: false, code: 'PLAN_UNAVAILABLE', message: 'Le plan d\'abonnement est indisponible.', count: 0, max: null };
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
export async function createCheckout(userId, planCode, idempotencyKey = null, accountType = null) {
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

  // Un compte ne peut acheter que les plans de SA audience : un
  // propriétaire ne peut pas acheter un palier agence (et inversement).
  const { data: profile } = await serviceClient()
    .from('profiles')
    .select('account_type')
    .eq('id', userId)
    .maybeSingle();
  const expectedAudience = audienceForAccount(profile?.account_type);
  if ((plan.audience || 'proprietaire') !== expectedAudience) {
    const err = new Error("Ce plan n'est pas disponible pour ce type de compte.");
    err.code = 'PLAN_INVALID';
    throw err;
  }

  const sb = serviceClient();
  const key = String(idempotencyKey || crypto.randomUUID()).trim().slice(0, 120);
  const { data: existing, error: existingError } = await sb
    .from('abonnement_paiements')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'bictorys')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (existingError) {
    const err = new Error("Erreur lors de la lecture du paiement existant.");
    err.code = 'DB_ERROR';
    throw err;
  }
  if (existing) {
    return {
      plan: planView(plan),
      checkout: {
        paymentReference: existing.reference,
        transactionId: existing.transaction_id,
        link: existing.raw_response?.link || null,
        status: existing.statut,
        montant: Number(existing.montant),
        devise: existing.devise,
        simulated: Boolean(existing.raw_response?.simulated),
      },
      payment: existing,
      idempotent: true,
    };
  }

  const sub = await readSubscription(userId);
  const currentExp = sub?.date_expiration || null;
  const paymentReference = newPaymentReference(userId);
  const expectedExpiration = addMonths(futureBaseDate(currentExp), plan.duree_abonnement);
  const { data: payment, error: insertError } = await sb
    .from('abonnement_paiements')
    .insert({
      user_id: userId,
      plan: plan.code,
      montant: Number(plan.prix),
      devise: plan.devise,
      provider: 'bictorys',
      statut: 'pending',
      reference: paymentReference,
      idempotency_key: key,
      methode_paiement: 'bictorys',
      date_debut: new Date().toISOString(),
      date_expiration: expectedExpiration.toISOString(),
      raw_response: { state: 'creating' },
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (insertError || !payment) {
    const err = new Error("Erreur lors de l'enregistrement du paiement.");
    err.code = 'DB_ERROR';
    throw err;
  }

  let charge;
  try {
    charge = await createCharge({
      amount: Number(plan.prix),
      currency: plan.devise,
      paymentReference,
      merchantReference: `SUB-${paymentReference}`,
      successRedirectUrl: buildRedirectUrl('succes', paymentReference, accountType),
      errorRedirectUrl: buildRedirectUrl('echec', paymentReference, accountType),
      customerObject: { locale: 'fr-FR', country: country() },
    });
  } catch (err) {
    await sb.from('abonnement_paiements').update({ statut: 'failed', raw_response: { state: 'charge_failed', error: err.message }, updated_at: new Date().toISOString() }).eq('id', payment.id).eq('statut', 'pending');
    err.code = err.code || 'BICTORYS_ERROR';
    throw err;
  }

  if (!charge.simulated && paymentLinkError(charge.link)) {
    await sb.from('abonnement_paiements').update({ statut: 'failed', raw_response: { state: 'invalid_checkout_link' }, updated_at: new Date().toISOString() }).eq('id', payment.id).eq('statut', 'pending');
    const err = new Error('Lien de paiement Bictorys invalide.');
    err.code = 'BICTORYS_INVALID_LINK';
    throw err;
  }

  const { data: updatedPayment, error: updateError } = await sb
    .from('abonnement_paiements')
    .update({
      transaction_id: charge.transactionId,
      raw_response: { state: 'checkout_created', link: charge.link, simulated: Boolean(charge.simulated) },
      updated_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .eq('statut', 'pending')
    .select('*')
    .single();
  if (updateError) throw new Error(updateError.message);

  if (charge.simulated && autoConfirmSim()) {
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

  const currentPayment = updatedPayment || payment;
  return {
    plan: planView(plan),
    checkout: {
      paymentReference,
      transactionId: charge.transactionId,
      link: charge.link,
      status: currentPayment.statut,
      montant: Number(plan.prix),
      devise: plan.devise,
      simulated: Boolean(charge.simulated),
    },
    payment: currentPayment,
  };
}

function buildRedirectUrl(result, paymentReference, accountType) {
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const page = accountType === 'agence' ? '/PartAgence/first_Mode/abonnements.html' : '/PartProprietaires/abonnements.html';
  return `${base}${page}?paiement=${result}&ref=${encodeURIComponent(paymentReference)}`;
}

// ─── WEBHOOK Bictorys ───────────────────────────────────────────

// Journalise le webhook reçu (idempotence par fingerprint UNIQUE).
function webhookIdentity(payload) {
  const separateEventId = String(payload?.eventId || payload?.event_id || '').trim();
  const explicitTransactionId = String(payload?.transactionId || payload?.transaction_id || '').trim();
  const legacyId = String(payload?.id || '').trim();
  const eventId = separateEventId || legacyId || explicitTransactionId;
  const transactionId = explicitTransactionId || (separateEventId ? '' : legacyId);
  return { eventId, transactionId };
}

async function recordWebhook(payload) {
  const identity = webhookIdentity(payload);
  const fingerprint =
    identity.eventId ||
    `evt-${String(payload?.paymentReference || '')}-${String(payload?.status || '')}-${String(payload?.timestamp || '')}`;
  const { data, error } = await serviceClient()
    .from('bictorys_webhooks')
    .insert({
      event_id: identity.eventId || null,
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
    .select('id, fingerprint, handled')
    .single();

  if (error) {
    if (String(error.code) !== '23505') throw error;
    const { data: existing, error: lookupError } = await serviceClient()
      .from('bictorys_webhooks')
      .select('id, fingerprint, handled')
      .eq('fingerprint', fingerprint)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) throw error;
    return { duplicate: true, id: existing.id, handled: existing.handled };
  }
  return { id: data.id, handled: false };
}

async function finalizeWebhook(id, { handledAt, error, handled = true }) {
  const { error: updateError } = await serviceClient()
    .from('bictorys_webhooks')
    .update({ handled, handled_at: handled ? (handledAt || new Date().toISOString()) : null, error: error || null })
    .eq('id', id);
  if (updateError) console.warn('[bictorys/webhook] finalize :', updateError.message);
}

// Trouve le paiement MIM rattaché à l'événement Bictorys
// (paymentReference = reference du paiement, ou id = transaction).
async function findPayment(payload) {
  const identity = webhookIdentity(payload);
  if (payload?.paymentReference) {
    const { data, error } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('reference', String(payload.paymentReference))
      .eq('provider', 'bictorys')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return { payment: data, match: 'reference' };
  }
  if (identity.transactionId) {
    const { data, error } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('transaction_id', identity.transactionId)
      .eq('provider', 'bictorys')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return { payment: data, match: 'transactionId' };
  }
  return { payment: null };
}

// Activation effective (webhook succeeded OU polling fallback).
// Idempotente : n'applique jamais deux fois le même paiement
// (garde-fou statut='pending' sur le paiement).
export async function applySucceededPayment(payment) {
  const plan = await planByCode(payment.plan, true);
  if (!plan) throw Object.assign(new Error('Plan de paiement inactif.'), { code: 'PLAN_UNAVAILABLE' });

  const { data, error } = await serviceClient().rpc('activate_subscription_payment', {
    p_payment_id: payment.id,
    p_transaction_id: payment.transaction_id || null,
    p_paid_at: payment.date_paiement || new Date().toISOString(),
    p_expected_amount: Number(payment.montant),
    p_currency: payment.devise || plan.devise,
  });
  if (error) throw error;

  invalidateSubscriptionCache();
  try {
    await notify(payment.user_id, 'abonnement', `Votre abonnement MIM ${plan.nom} est actif (${plan.duree_abonnement} mois). Merci !`);
  } catch (e) {
    console.warn('[bictorys] notification :', e.message);
  }
  return { applied: true, subscriptionId: data };
}

// Point d'entrée des notifications Bictorys (route POST /api/webhooks/bictorys).
export async function processWebhook(payload) {
  const status = String(payload?.status || '').trim().toLowerCase();
  const amount = parseMoney(payload?.amount);
  const currency = String(payload?.currency || '').trim().toUpperCase();
  const paymentReference = String(payload?.paymentReference || '').trim();
  const merchantReference = String(payload?.merchantReference || '').trim();
  const identity = webhookIdentity(payload);
  if (!status || !paymentReference || !identity.eventId || payload?.amount == null || !currency || amount === null) {
    return { ok: false, code: 'MALFORMED_EVENT' };
  }

  const rec = await recordWebhook(payload);
  if (rec.duplicate && rec.handled) return { ok: true, duplicate: true };

  let result = { ok: true };
  try {
    if (!merchantReference) {
      throw Object.assign(new Error('Référence marchande absente.'), { code: 'MALFORMED_EVENT' });
    }
    const { payment } = await findPayment(payload);
    if (!payment) {
      throw Object.assign(new Error('Paiement MIM introuvable pour cet événement.'), { code: 'PAYMENT_NOT_FOUND' });
    }
    if (Number(payment.montant) !== amount) {
      throw Object.assign(new Error(`Montant inattendu : ${payload.amount} (attendu ${payment.montant}).`), { code: 'AMOUNT_MISMATCH', matchedPayment: payment.reference });
    }
    if (String(payment.devise || '').toUpperCase() !== currency) {
      throw Object.assign(new Error('Devise inattendue.'), { code: 'CURRENCY_MISMATCH', matchedPayment: payment.reference });
    }
    if (merchantReference !== `SUB-${payment.reference}`) {
      throw Object.assign(new Error('Référence marchande invalide.'), { code: 'MERCHANT_REFERENCE_MISMATCH', matchedPayment: payment.reference });
    }
    const effectiveTransactionId = identity.transactionId || payment.transaction_id;
    if (!effectiveTransactionId) {
      throw Object.assign(new Error('Transaction absente.'), { code: 'TRANSACTION_MISSING', matchedPayment: payment.reference });
    }
    if (payment.transaction_id && payment.transaction_id !== effectiveTransactionId) {
      throw Object.assign(new Error('Transaction mismatch.'), { code: 'TRANSACTION_MISMATCH', matchedPayment: payment.reference });
    }

    if (PAYMENT_OK.includes(status)) {
      const applied = await applySucceededPayment({ ...payment, transaction_id: effectiveTransactionId });
      result = { ok: true, ...applied };
      return result;
    }

    if (PAYMENT_FAILED.includes(status)) {
      if (payment.statut === 'pending') {
        const { error } = await serviceClient()
          .from('abonnement_paiements')
          .update({
            statut: status === 'cancelled' ? 'cancelled' : 'failed',
            raw_response: payload,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payment.id)
          .eq('statut', 'pending');
        if (error) throw error;
        invalidateSubscriptionCache();
      }
      try {
        await notify(payment.user_id, 'abonnement', `Votre paiement d'abonnement a été ${status === 'cancelled' ? 'annulé' : 'refusé'}. Veuillez réessayer.`);
      } catch (e) {
        console.warn('[bictorys] notification echec :', e.message);
      }
      result = { ok: true, failed: status };
    } else if (status === 'authorized') {
      result = { ok: true, authorized: true };
    } else {
      throw Object.assign(new Error('Statut de webhook non traité.'), { code: 'UNSUPPORTED_STATUS' });
    }
  } catch (err) {
    result = {
      ok: false,
      code: err.code || 'WEBHOOK_PROCESSING_ERROR',
      message: err.message,
      matchedPayment: err.matchedPayment,
    };
  } finally {
    const handled = result.ok || PERMANENT_WEBHOOK_CODES.has(result.code);
    await finalizeWebhook(rec.id, { handled, error: result.ok ? null : result.code || 'ERROR' });
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
  if (error) {
    const err = new Error('Impossible de lire le paiement en attente.');
    err.code = 'PAYMENT_LOOKUP_FAILED';
    throw err;
  }
  if (!data) return { status: 'none' };
  if (!data.transaction_id) return { status: 'pending', reason: 'TRANSACTION_PENDING' };

  let txn;
  try {
    if (isSimulate()) return { status: 'pending', reason: 'SIMULATION_REQUIRES_WEBHOOK' };
    txn = await getTransaction(data.transaction_id);
  } catch (err) {
    return { status: 'error', message: err.message };
  }

  if (txn.paymentReference && txn.paymentReference !== data.reference) {
    return { status: 'error', code: 'REFERENCE_MISMATCH' };
  }
  if (txn.merchantReference && txn.merchantReference !== `SUB-${data.reference}`) {
    return { status: 'error', code: 'MERCHANT_REFERENCE_MISMATCH' };
  }
  const transactionAmount = parseMoney(txn.amount);
  if (transactionAmount === null || !txn.currency) {
    return { status: 'error', code: 'TRANSACTION_DETAILS_INCOMPLETE' };
  }
  if (transactionAmount !== parseMoney(data.montant)) {
    return { status: 'error', code: 'AMOUNT_MISMATCH' };
  }
  if (String(txn.currency).toUpperCase() !== String(data.devise || '').toUpperCase()) {
    return { status: 'error', code: 'CURRENCY_MISMATCH' };
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