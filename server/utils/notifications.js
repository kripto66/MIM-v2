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
      console.warn(`[notify] ${type} -> ${userId} :`, error.message);
    }
  } catch (err) {
    console.warn('[notify]', err.message);
  }
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
