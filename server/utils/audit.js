import { serviceClient } from '../app.js';

const AUDIT_TABLE = 'audit_logs';

const LEVELS = {
  INFO: 'info',
  WARN: 'warn',
  CRITICAL: 'critical',
};

/**
 * Enregistre une action sensible dans la table audit_logs.
 * @param {object} params
 * @param {string} params.userId - ID de l'utilisateur qui effectue l'action
 * @param {string} params.action - Type d'action (ex: 'account.create', 'suspension.toggle')
 * @param {string} params.target - ID de la ressource cible (optionnel)
 * @param {string} params.targetType - Type de ressource (ex: 'user', 'bien', 'paiement')
 * @param {string} params.level - Niveau de criticité (INFO, WARN, CRITICAL)
 * @param {object} params.meta - Données supplémentaires (optionnel)
 * @param {string} params.ip - Adresse IP (optionnel)
 */
export async function auditLog({ userId, action, target, targetType, level = LEVELS.INFO, meta, ip }) {
  try {
    const sb = serviceClient();
    const { error } = await sb.from(AUDIT_TABLE).insert({
      user_id: userId,
      action,
      target_id: target || null,
      target_type: targetType || null,
      level,
      meta: meta ? JSON.stringify(meta) : null,
      ip: ip || null,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.warn('[audit] insert échec :', error.message);
    }
  } catch (err) {
    console.warn('[audit] erreur :', err.message);
  }
}

export { LEVELS };
