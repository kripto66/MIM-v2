import { serviceClient } from '../app.js';

// ============================================================
// Notifications MIM
// Crée une notification liée au bon utilisateur (user_id).
// L'insertion se fait avec le rôle service (contourne la RLS) ;
// les lectures sont ensuite filtrées par RLS (user_id = auth.uid()).
// ============================================================

export async function notify(userId, type, message) {
  if (!userId || !message) return;

  try {
    const { error } = await serviceClient()
      .from('notifications')
      .insert({ user_id: userId, type, message });

    if (error) {
      await outboxSave(userId, type, message, error.message);
    }
  } catch (err) {
    await outboxSave(userId, type, message, err.message);
  }
}

// M-01 : repli en file de rejeu. L'insertion nominale a échoué (panne
// transitoire, contrainte) — on journalise la notification pour que le
// balayeur périodique la reprenne avec backoff au lieu de la perdre en
// silence. Dernier recours : si l'outbox est lui-même injoignable, le
// signal reste en console (notify ne lève jamais, contrat inchangé).
async function outboxSave(userId, type, message, reason) {
  try {
    const { error } = await serviceClient()
      .from('notifications_outbox')
      .insert({ user_id: userId, type, message, attempts: 0, last_error: reason });

    if (error) {
      console.error(`[notify/outbox] ${type} -> ${userId} : ${reason} | outbox : ${error.message}`);
    } else {
      console.warn(`[notify] ${type} -> ${userId} : échec journalisé pour rejeu (${reason})`);
    }
  } catch (err) {
    console.error(`[notify/outbox] ${type} -> ${userId} : ${reason} | ${err.message}`);
  }
}

// Rejeu d'une passe de l'outbox (RPC notifications_outbox_flush) :
// purge les lignes expirées et remet en circulation les pending.
// Retourne le nombre de notifications délivrées, jamais d'exception.
export async function flushNotificationsOutbox(limit = 50) {
  try {
    const { data, error } = await serviceClient().rpc('notifications_outbox_flush', { p_limit: limit });
    if (error) {
      console.warn('[notify/flush]', error.message);
      return 0;
    }
    return Number(data || 0);
  } catch (err) {
    console.warn('[notify/flush]', err.message);
    return 0;
  }
}

// Balayeur périodique démarré par server.js (M-01). Timer non
// bloquant : la fin du processus n'attend jamais un rejeu.
export function startNotificationsOutboxSweep(intervalMs = 60000) {
  const run = () => {
    void flushNotificationsOutbox();
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// Retourne l'uid du locataire lié à un logement (ou null).
export async function tenantUidOfLogement(logementId) {
  if (!logementId) return null;

  try {
    const { data } = await serviceClient()
      .from('locataires')
      .select('account_uid')
      .eq('logement_id', logementId)
      .not('account_uid', 'is', null)
      .maybeSingle();

    return data?.account_uid || null;
  } catch (err) {
    console.warn('[tenantUidOfLogement]', err.message);
    return null;
  }
}

// Retourne l'uid du locataire lié à une fiche locataire (ou null).
export async function tenantUidOfLocataire(locataireId) {
  if (!locataireId) return null;

  try {
    const { data } = await serviceClient()
      .from('locataires')
      .select('account_uid')
      .eq('id', locataireId)
      .not('account_uid', 'is', null)
      .maybeSingle();

    return data?.account_uid || null;
  } catch (err) {
    console.warn('[tenantUidOfLocataire]', err.message);
    return null;
  }
}

// Loyer du logement (utilisé par les messages de notification).
export async function logementNomOf(logementId) {
  if (!logementId) return '';

  try {
    const { data } = await serviceClient()
      .from('logements')
      .select('nom')
      .eq('id', logementId)
      .maybeSingle();

    return data?.nom || '';
  } catch (err) {
    console.warn('[logementNomOf]', err.message);
    return '';
  }
}
