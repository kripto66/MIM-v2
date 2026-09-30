// ============================================================
// MIM - Transition de statut d'un mandat de gestion (audit H-18)
//
// Une liaison agences_proprietaires peut être suspendue (statut ->
// 'inactif') puis réactivée, côté agence ou côté propriétaire :
//   * le motif est OBLIGATOIRE et conservé sur la ligne ;
//   * updated_at horodate la transition ;
//   * revoque_par mémorise l'acteur : seul LE MÊME compte peut
//     réactiver (la révocation du propriétaire ne peut pas être
//     annulée par l'agence, ni l'inverse) ;
//   * chaque transition est écrite dans audit_logs (niveau warn
//     pour une révocation) et notifie l'autre partie.
// ============================================================

import { serviceClient } from '../app.js';
import { auditLog, LEVELS } from './audit.js';
import { notify } from './notifications.js';

export const MANDAT_STATUTS = new Set(['actif', 'inactif']);

// Contrôle du motif saisi (obligatoire pour toute transition).
export function mandatMotifError(motif) {
  if (!motif) return 'Le motif est obligatoire.';
  if (motif.length < 3) return 'Le motif doit contenir au moins 3 caractères.';
  if (motif.length > 200) return 'Le motif ne peut pas dépasser 200 caractères.';
  return null;
}

// Règle de gouvernance : la réactivation n'appartient qu'au compte
// qui a prononcé la suspension (revoque_par vide = liaison héritée,
// les deux parties peuvent la réactiver).
export function mandatReactivateError(liaison, statut, actorId) {
  if (statut !== 'actif' || liaison.statut !== 'inactif') return null;
  if (liaison.revoque_par && String(liaison.revoque_par) !== String(actorId)) {
    return {
      status: 403,
      code: 'MANDAT_REVOKED_BY_OTHER',
      message: 'La réactivation ne peut être demandée que par le compte qui a prononcé la suspension.',
    };
  }
  return null;
}

// Message de notification adressé à L'AUTRE partie de la liaison.
function notificationFor(actorRole, statut, liaison) {
  if (actorRole === 'agence') {
    return [
      liaison.proprietaire_id,
      statut === 'inactif'
        ? 'Votre agence a suspendu la gestion de vos biens. Vous reprenez la main sur votre espace.'
        : 'Votre agence a repris la gestion de vos biens.',
    ];
  }
  return [
    liaison.agence_id,
    statut === 'inactif'
      ? 'Le propriétaire a révoqué le mandat : vos accès à ses biens sont coupés.'
      : 'Le propriétaire a rétabli le mandat : vos accès sont de nouveau ouverts.',
  ];
}

/**
 * Applique la transition : mise à jour optimiste (CAS sur le statut
 * lu, échec 409 si un tiers a basculé entre lecture et écriture),
 * puis audit et notification de l'autre partie.
 *
 * @param {object} params
 * @param {object} params.liaison - ligne lue (id, agence_id, proprietaire_id, statut, revoque_par)
 * @param {object} params.scope - condition de portée supplémentaire ({ agence_id } ou { proprietaire_id })
 * @param {'actif'|'inactif'} params.statut - nouveau statut
 * @param {string} params.motif - motif saisi (déjà validé)
 * @param {string} params.actorId - compte qui agit
 * @param {'agence'|'proprietaire'} params.actorRole - rôle du compte qui agit
 * @param {string} [params.ip] - adresse IP pour l'audit
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, message: string}>}
 */
export async function applyMandatStatut({ liaison, scope, statut, motif, actorId, actorRole, ip }) {
  let query = serviceClient()
    .from('agences_proprietaires')
    .update({
      statut,
      motif,
      updated_at: new Date().toISOString(),
      revoque_par: statut === 'inactif' ? actorId : null,
    })
    .eq('id', liaison.id)
    .eq('statut', liaison.statut);
  for (const [key, value] of Object.entries(scope)) {
    query = query.eq(key, value);
  }
  const { data, error } = await query.select('id');
  if (error) throw new Error(error.message);
  if (!data || !data.length) {
    return {
      ok: false,
      status: 409,
      code: 'MANDAT_STATUT_CONFLICT',
      message: 'Le mandat a changé de statut entre-temps : rechargez et réessayez.',
    };
  }

  await auditLog({
    userId: actorId,
    action: `${actorRole}.mandat.${statut === 'inactif' ? 'revoke' : 'resume'}`,
    target: String(liaison.id),
    targetType: 'agence_mandat',
    level: statut === 'inactif' ? LEVELS.WARN : LEVELS.INFO,
    meta: {
      agence_id: liaison.agence_id,
      proprietaire_id: liaison.proprietaire_id,
      ancien_statut: liaison.statut,
      nouveau_statut: statut,
      motif,
    },
    ip,
  });

  const [destinataire, message] = notificationFor(actorRole, statut, liaison);
  await notify(destinataire, 'info', message);

  return { ok: true };
}
