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
// ============================================================

import { serviceClient } from '../app.js';

const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];

// Cache mémoire court : évite une requête Supabase à chaque requête
// protégée, sans jamais masquer une expiration plus de 2 s.
const CACHE_TTL_MS = 2000;
let subCache = new Map();

export function invalidateSubscriptionCache() {
  subCache.clear();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function computeStatus(sub) {
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

  const now = Date.now();
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

// Statut calculé d'un propriétaire (usage exposé au propriétaire).
export async function subscriptionOf(userId) {
  return computeStatus(await readSubscription(userId));
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
  return !Number.isNaN(exp) && exp <= Date.now();
}
