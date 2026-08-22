// ============================================================
// MIM - Réconciliation PayDunya (source de vérité serveur)
//
// Point unique où l'état d'une session d'encaissement est confirmé
// auprès de l'API PayDunya puis répercuté sur les données MIM
// (paiement, salaire, abonnement, échéance suivante, redistribution,
// notifications). Utilisé par :
//   - le webhook IPN (routes/paydunya.js) ;
//   - la consultation de statut GET /api/paydunya/status/:token
//     (rattrapage automatique si une notification est perdue) ;
//   - les outils admin.
//
// Idempotence : chaque étape est protégée par une écriture
// conditionnelle (statut attendu) ou un dédoublonnage en base. Un
// même traitement rejoué (IPN répété, rattrapage, crash entre deux
// étapes) ne produit JAMAIS deux opérations financières ni deux
// notifications.
// ============================================================

import { confirmPaydunyaInvoice } from './paydunya.js';
import {
  createAndAttemptRedistribution,
  retryRedistribution,
  findRedistributionForTarget,
  recipientTargetOfOwner,
  recipientTargetOfEmploye,
} from './paydunyaRedistributions.js';
import { creerEcheanceSuivante } from './echeances.js';
import { serviceClient } from '../app.js';

const sb = () => serviceClient();

const PAYABLE_STATUS = ['attente', 'retard', 'refuse', 'a_confirmer', 'en_validation'];

// ------------------------------------------------------------
// Confirme la facture auprès de l'API PayDunya et applique les
// effets métier. Ne lève que si la CONFIRMATION est indisponible :
// les erreurs métier sont reflétées dans le résultat.
//
// invoice : ligne paydunya_invoices relue en base.
// opts.ipnData : payload IPN brut (archivé sur la session si fourni).
// Retour : { status, result }
//   status : état final de la session ('completed' | 'pending' | ...)
//   result : completed | already_completed | amount_mismatch |
//            pending | cancelled | unchanged
// ------------------------------------------------------------
export async function reconcilePaydunyaInvoice(invoice, { ipnData = null } = {}) {
  // 1) Confirmation auprès de l'API : le statut annoncé (IPN ou URL de
  //    retour) n'est jamais pris au pied de la lettre.
  const confirmed = await confirmPaydunyaInvoice(invoice.token);

  // 2) Cohérence du montant pour un paiement prétendu complété.
  if (confirmed.status === 'completed') {
    const confirmedAmount = confirmed.totalAmount;
    if (!(confirmedAmount > 0 && confirmedAmount === Number(invoice.amount))) {
      console.error(
        `[paydunya/reconcile] montant incohérent: confirmé=${confirmedAmount} attendu=${invoice.amount} (token=${invoice.token})`
      );
      await sb()
        .from('paydunya_invoices')
        .update({ status: 'failed', last_ipn: ipnData || invoice.last_ipn })
        .eq('id', invoice.id);
      return { status: 'failed', result: 'amount_mismatch' };
    }
  }

  // 3) On n'abaisse jamais une session déjà complétée.
  if (invoice.status === 'completed' && confirmed.status !== 'completed') {
    return { status: 'completed', result: 'already_completed' };
  }

  // Replay d'une session déjà complétée : les effets métier sont
  // réappliqués sans risque (idempotence) mais signalés comme redondants.
  const isReplay = invoice.status === 'completed';

  // 4) Mise à jour de la session.
  const nextStatus = ['completed', 'pending', 'cancelled'].includes(confirmed.status)
    ? confirmed.status
    : invoice.status;
  await sb()
    .from('paydunya_invoices')
    .update({
      status: nextStatus,
      receipt_url: confirmed.receiptUrl || invoice.receipt_url,
      last_ipn: ipnData || invoice.last_ipn,
    })
    .eq('id', invoice.id);

  // 5) Succès : application des effets métier selon la source.
  if (nextStatus === 'completed') {
    if (invoice.source === 'salaire') {
      await applySalaireCompleted(invoice, invoice.token);
    } else if (invoice.source === 'abonnement') {
      await applyAbonnementCompleted(invoice, invoice.token);
    } else {
      await applyLoyerCompleted(invoice, invoice.token);
    }
  }

  const result = isReplay
    ? 'already_completed'
    : nextStatus === invoice.status && nextStatus !== 'completed'
      ? 'unchanged'
      : nextStatus;
  return { status: nextStatus, result };
}

// ------------------------------------------------------------
// LOYER confirmé : paiement « paye », échéance suivante,
// redistribution au propriétaire, notifications.
// ------------------------------------------------------------
export async function applyLoyerCompleted(invoice, token) {
  const { data: paiement } = await sb()
    .from('paiements')
    .select('id, user_id, locataire_id, logement_id, mois, montant, statut, reference')
    .eq('id', invoice.paiement_id)
    .maybeSingle();
  if (!paiement) return;

  // Transition unique : en cas de course / re-traitement, un seul appel
  // gagne et devient responsable des notifications.
  const { data: updated, error: payErr } = await sb()
    .from('paiements')
    .update({
      statut: 'paye',
      date_paiement: new Date().toISOString().slice(0, 10),
      methode_paiement: 'paydunya',
      reference: paiement.reference || token,
    })
    .eq('id', paiement.id)
    .in('statut', PAYABLE_STATUS)
    .select()
    .maybeSingle();
  if (payErr) throw payErr;
  const isFirstTransition = Boolean(updated);

  // Échéance du mois suivant : anti-doublon en base, rejouable sans risque
  // (exécutable même hors transition initiale : répare un crash antérieur).
  try {
    await creerEcheanceSuivante(sb(), paiement);
  } catch (e) {
    console.warn('[paydunya/reconcile] échéance suivante :', e.message);
  }

  // Redistribution au propriétaire : dédoublonnée par cible ; une
  // redistribution existante non aboutie est relancée au lieu d'être dupliquée.
  try {
    const target = await recipientTargetOfOwner(paiement.user_id);
    if (target?.alias) {
      await ensureRedistribution({
        source: 'loyer',
        userId: paiement.user_id,
        paiementId: paiement.id,
        recipientAlias: target.alias,
        recipientWithdrawMode: target.withdrawMode,
        recipientLabel: `Loyer ${paiement.mois}`,
        amount: Number(paiement.montant),
      });
    }
  } catch (e) {
    console.warn('[paydunya/reconcile] redistribution loyer :', e.message);
  }

  // Notifications : uniquement lors de la transition (jamais deux fois).
  if (isFirstTransition) {
    try {
      const { notify, tenantUidOfLocataire } = await import('./notifications.js');
      await notify(
        paiement.user_id,
        'success',
        `Loyer ${paiement.mois} encaissé via PayDunya (${Number(paiement.montant).toLocaleString('fr-FR')} FCFA). Redistribution au propriétaire en cours.`
      );
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        await notify(tenantUid, 'paiement', `Votre loyer de ${paiement.mois} a été réglé avec succès via PayDunya.`);
      }
    } catch (e) {
      console.warn('[paydunya/reconcile] notification loyer :', e.message);
    }
  }
}

// ------------------------------------------------------------
// SALAIRE confirmé : paiement « paye », redistribution à l'employé,
// notifications.
// ------------------------------------------------------------
export async function applySalaireCompleted(invoice, token) {
  const { data: pay } = await sb()
    .from('paiements_employes')
    .select('id, user_id, employe_id, employe_uid, mois, montant, statut, reference')
    .eq('id', invoice.paiement_employe_id)
    .maybeSingle();
  if (!pay) return;

  const { data: updated, error: payErr } = await sb()
    .from('paiements_employes')
    .update({
      statut: 'paye',
      date_paiement: new Date().toISOString().slice(0, 10),
      methode_paiement: 'paydunya',
      reference: pay.reference || token,
    })
    .eq('id', pay.id)
    .neq('statut', 'paye')
    .select()
    .maybeSingle();
  if (payErr) throw payErr;
  const isFirstTransition = Boolean(updated);

  // Redistribution à l'employé (dédoublonnée, relancée si nécessaire).
  try {
    const target = await recipientTargetOfEmploye(pay.employe_id);
    if (target?.alias) {
      await ensureRedistribution({
        source: 'salaire',
        userId: pay.user_id,
        paiementEmployeId: pay.id,
        recipientAlias: target.alias,
        recipientWithdrawMode: target.withdrawMode,
        recipientLabel: `Salaire ${pay.mois}`,
        amount: Number(pay.montant),
      });
    }
  } catch (e) {
    console.warn('[paydunya/reconcile] redistribution salaire :', e.message);
  }

  if (isFirstTransition) {
    try {
      const { notify } = await import('./notifications.js');
      await notify(
        pay.user_id,
        'success',
        `Salaire ${pay.mois} encaissé via PayDunya (${Number(pay.montant).toLocaleString('fr-FR')} FCFA). Redistribution à l'employé en cours.`
      );
      if (pay.employe_uid) {
        await notify(pay.employe_uid, 'salaire', `Votre salaire de ${pay.mois} a été payé via PayDunya. Vérifiez votre compte PayDunya.`);
      }
    } catch (e) {
      console.warn('[paydunya/reconcile] notification salaire :', e.message);
    }
  }
}

// ------------------------------------------------------------
// ABONNEMENT confirmé : activation / renouvellement.
// L'upsert de la souscription reste idempotent et est donc rejoué
// même hors première transition (répare un crash antérieur) ; la
// notification n'est envoyée qu'une seule fois.
// ------------------------------------------------------------
export async function applyAbonnementCompleted(invoice, token) {
  const { data: paiementAbonnement, error: apErr } = await sb()
    .from('abonnement_paiements')
    .select('*')
    .eq('id', invoice.abonnement_paiement_id)
    .maybeSingle();
  if (apErr) throw apErr;
  if (!paiementAbonnement) return;

  const now = new Date();
  const updateHist = {
    date_paiement: now.toISOString(),
    methode_paiement: 'paydunya',
  };
  if (!paiementAbonnement.reference) updateHist.reference = token;

  // Transition unique : date_paiement passe de NULL à une date une seule fois.
  const { data: histUpdated, error: updErr } = await sb()
    .from('abonnement_paiements')
    .update(updateHist)
    .eq('id', paiementAbonnement.id)
    .is('date_paiement', null)
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  const isFirstTransition = Boolean(histUpdated);

  // Activation / renouvellement de l'abonnement : l'échéance (date_debut,
  // date_expiration) a été calculée côté serveur lors de l'initiation.
  // Upsert rejouable sans effet de bord (mêmes valeurs).
  await sb()
    .from('subscriptions')
    .upsert(
      {
        user_id: paiementAbonnement.user_id,
        plan: paiementAbonnement.plan,
        statut: 'actif',
        date_debut: paiementAbonnement.date_debut,
        date_expiration: paiementAbonnement.date_expiration,
        date_paiement: now.toISOString(),
        montant: Number(paiementAbonnement.montant),
        methode_paiement: 'paydunya',
        reference: updateHist.reference,
        updated_at: now.toISOString(),
      },
      { onConflict: 'user_id' }
    );

  const { invalidateSubscriptionCache } = await import('./subscription.js');
  invalidateSubscriptionCache();
  const { invalidatePlatformCache } = await import('../routes/admin.js');
  invalidatePlatformCache();

  if (isFirstTransition) {
    try {
      const { notify } = await import('./notifications.js');
      await notify(paiementAbonnement.user_id, 'abonnement', `Votre abonnement MIM est actif. Merci pour votre paiement PayDunya.`);
    } catch (e) {
      console.warn('[paydunya/reconcile] notification abonnement :', e.message);
    }
  }
}

// ------------------------------------------------------------
// Redistribution dédoublonnée : crée la redistribution si aucune
// n'existe pour la cible, relance la dernière si elle n'est pas
// aboutie, ne fait rien si elle est déjà réussie.
// (Les notifications destinataire — versement bloqué / abouti après
// relance — sont émises par createAndAttemptRedistribution et
// retryRedistribution dans paydunyaRedistributions.js.)
// ------------------------------------------------------------
export async function ensureRedistribution(opts) {
  const existing = await findRedistributionForTarget({
    source: opts.source,
    paiementId: opts.paiementId ?? null,
    paiementEmployeId: opts.paiementEmployeId ?? null,
  });

  if (existing?.status === 'success') return existing;
  if (existing) return retryRedistribution(existing.id);
  return createAndAttemptRedistribution(opts);
}
