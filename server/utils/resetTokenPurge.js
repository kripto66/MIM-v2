// ============================================================
// MIM - Purge des jetons de récupération expirés (audit L-02)
//
// Les lignes dont expires_at est dépassé sont définitivement
// inconsommables (tryConsumeResetToken exige expires_at > now) :
// elles s'accumulaient indéfiniment, seul un ré-emplacement les
// révoquait sans jamais les supprimer. La purge tourne par lots
// journalisés et est déclenchée par le cron checkLoyers ainsi que
// par les opérations de récupération (émission et consommation).
// Best-effort : un échec de ménage ne fait JAMAIS échouer une
// récupération de mot de passe.
// ============================================================

import { getNow } from './simulation.js';

const PURGE_BATCH_SIZE = 1000;
const PURGE_MAX_BATCHES = 50;

/**
 * Supprime les jetons de récupération expirés, par lots.
 *
 * @param {object} sb - client supabase (service_role)
 * @returns {Promise<number>} nombre de lignes purgées (0 en cas d'échec)
 */
export async function purgeResetTokens(sb) {
  try {
    const now = new Date(await getNow()).toISOString();
    let total = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const { data, error } = await sb
        .from('password_reset_tokens')
        .delete()
        .lt('expires_at', now)
        .select('id')
        .limit(PURGE_BATCH_SIZE);
      if (error) {
        console.warn('[reset/purge]', error.message);
        break;
      }
      const count = data?.length || 0;
      total += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    if (total > 0) console.log(`[reset/purge] jetons de récupération expirés purgés : ${total}`);
    return total;
  } catch (err) {
    console.warn('[reset/purge]', err.message);
    return 0;
  }
}
