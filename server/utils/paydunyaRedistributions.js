// ============================================================
// MIM - Redistribution PayDunya (décaissement au destinataire)
//
// Après un encaissement PayDunya (loyer ou salaire), MIM verse au
// destinataire (propriétaire / employé). Deux mécanismes officiels :
//
//   A. API Déboursement (PUSH v2) — versement DIRECT sur le wallet
//      mobile money choisi par le destinataire (Wave, Orange Money)
//      via son numéro : get-invoice -> submit-invoice -> statut
//      success | pending | failed (check-status / callback pour les
//      'pending').
//   B. API PER v1 (/direct-pay/credit-account) — crédit d'un compte
//      PayDunya à compte PayDunya, réponse immédiate.
//
// Choix du destinataire (recipientTargetOf*) :
//   1. le moyen marqué « pour_versement » (choix explicite) : wallet
//      direct si le type est décaissable + numéro exploitable, sinon
//      son alias PayDunya ;
//   2. à défaut, l'ancienne chaîne : alias PayDunya du moyen le plus
//      récent, puis téléphone du profil, puis email du compte.
//
// Une redistribution est UNIQUE par cible (paiement de loyer ou de
// salaire) : findRedistributionForTarget permet le dédoublonnage avant
// création. Un échec laisse la redistribution en 'pending'
// (relançable depuis l'admin : POST /api/paydunya/redistributions/:id/retry,
// ou automatiquement au re-traitement du paiement).
// Un décaissement 'pending' chez l'opérateur n'est JAMAIS rejoué
// aveuglément (risque de double paiement) : son statut est revérifié
// (check-status / callback signé) avant toute nouvelle tentative.
//
// Le destinataire est notifié lorsqu'un versement reste bloqué et
// lorsqu'il aboutit après une relance.
// ============================================================

import {
  creditPaydunyaAccount,
  createDisburseInvoice,
  submitDisburseInvoice,
  checkDisburseStatus,
  paydunyaDisburseCallbackUrl,
} from './paydunya.js';
import { withdrawModeOf, TYPE_MOYEN_LABELS } from './paiementMethodes.js';
import { serviceClient } from '../app.js';

const sb = () => serviceClient();

// Notification tolérante aux pannes (jamais bloquante pour le versement).
async function notifyOwner(userId, type, message) {
  try {
    const { notify } = await import('./notifications.js');
    await notify(userId, type, message);
  } catch (e) {
    console.warn('[paydunya/redistributions] notification :', e.message);
  }
}

function normalizeAlias(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

// Numéro exploitable par l'API Déboursement : chiffres uniquement,
// indicatif Sénégal retiré (PayDunya exige le numéro SANS indicatif).
function disburseAliasFromNumero(numero) {
  let digits = String(numero || '').replace(/\D+/g, '');
  if (digits.length > 9 && digits.startsWith('221')) digits = digits.slice(3);
  return digits || null;
}

// ------------------------------------------------------------
// Résolution du destinataire (propriétaire d'un loyer).
// Retour : { alias, withdrawMode, label } | null
// ------------------------------------------------------------
export async function recipientTargetOfOwner(userId) {
  const { data: moyens } = await sb()
    .from('moyens_paiement')
    .select('type, numero, paydunya_alias, pour_versement')
    .eq('user_id', userId)
    .eq('actif', true)
    .order('updated_at', { ascending: false });

  const list = moyens || [];

  // 1) Moyen explicitement choisi pour recevoir les versements.
  const chosen = list.find((m) => m.pour_versement === true);
  if (chosen) {
    const mode = withdrawModeOf(chosen.type);
    const numero = disburseAliasFromNumero(chosen.numero);
    if (mode && numero) {
      return { alias: numero, withdrawMode: mode, label: TYPE_MOYEN_LABELS[chosen.type] || chosen.type };
    }
    const alias = normalizeAlias(chosen.paydunya_alias);
    if (alias) {
      return { alias, withdrawMode: 'paydunya', label: 'Compte PayDunya' };
    }
  }

  // 2) Chaîne historique : alias PayDunya du moyen actif le plus récent.
  const withAlias = list.find((m) => normalizeAlias(m.paydunya_alias));
  if (withAlias) {
    return { alias: normalizeAlias(withAlias.paydunya_alias), withdrawMode: 'paydunya', label: 'Compte PayDunya' };
  }

  // 3) Téléphone du profil (compte PayDunya de secours).
  const { data: profile } = await sb().from('profiles').select('phone').eq('id', userId).maybeSingle();
  const phone = normalizeAlias(profile?.phone);
  if (phone) return { alias: phone, withdrawMode: 'paydunya', label: 'Compte PayDunya' };

  // 4) Email du compte auth (dernier recours).
  const { data: authUser } = await sb().auth.admin.getUserById(userId);
  const email = normalizeAlias(authUser?.user?.email);
  if (email) return { alias: email, withdrawMode: 'paydunya', label: 'Compte PayDunya' };

  return null;
}

// Alias seul (compatibilité des appelants historiques).
export async function recipientAliasOfOwner(userId) {
  const target = await recipientTargetOfOwner(userId);
  return target?.alias || null;
}

// ------------------------------------------------------------
// Résolution du destinataire (employé d'un salaire).
// ------------------------------------------------------------
export async function recipientTargetOfEmploye(employeId) {
  const { data: employe } = await sb()
    .from('employes')
    .select('nom, phone, account_uid')
    .eq('id', employeId)
    .maybeSingle();
  if (!employe) return null;

  const { data: moyens } = await sb()
    .from('moyens_paiement_employes')
    .select('type, numero, paydunya_alias, pour_versement')
    .eq('employe_uid', employe.account_uid)
    .eq('actif', true)
    .order('updated_at', { ascending: false });

  const list = moyens || [];

  const chosen = list.find((m) => m.pour_versement === true);
  if (chosen) {
    const mode = withdrawModeOf(chosen.type);
    const numero = disburseAliasFromNumero(chosen.numero);
    if (mode && numero) {
      return { alias: numero, withdrawMode: mode, label: TYPE_MOYEN_LABELS[chosen.type] || chosen.type };
    }
    const alias = normalizeAlias(chosen.paydunya_alias);
    if (alias) {
      return { alias, withdrawMode: 'paydunya', label: 'Compte PayDunya' };
    }
  }

  const withAlias = list.find((m) => normalizeAlias(m.paydunya_alias));
  if (withAlias) {
    return { alias: normalizeAlias(withAlias.paydunya_alias), withdrawMode: 'paydunya', label: 'Compte PayDunya' };
  }

  const phone = normalizeAlias(employe.phone);
  if (phone) return { alias: phone, withdrawMode: 'paydunya', label: 'Compte PayDunya' };

  if (employe.account_uid) {
    const { data: authUser } = await sb().auth.admin.getUserById(employe.account_uid);
    const email = normalizeAlias(authUser?.user?.email);
    if (email) return { alias: email, withdrawMode: 'paydunya', label: 'Compte PayDunya' };
  }

  return null;
}

// Alias seul (compatibilité des appelants historiques).
export async function recipientAliasOfEmploye(employeId) {
  const target = await recipientTargetOfEmploye(employeId);
  return target?.alias || null;
}

// Dernière redistribution connue pour une cible (paiement de loyer ou
// de salaire). Sert de dédoublonnage : une seule opération financière
// par paiement, quel que soit le nombre de re-traitements.
export async function findRedistributionForTarget({ source, paiementId = null, paiementEmployeId = null }) {
  if (paiementId == null && paiementEmployeId == null) return null;
  let query = sb()
    .from('paydunya_redistributions')
    .select('*')
    .eq('source', source);
  if (paiementId != null) query = query.eq('paiement_id', paiementId);
  else query = query.eq('paiement_employe_id', paiementEmployeId);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

// ------------------------------------------------------------
// Tentative de versement uniformisée (ne lève jamais).
//  opts : { alias, withdrawMode, amount }
// Retour : { ok, pending, providerToken, transactionId, providerRef,
//            description, response }
//   ok=true                -> succès définitif
//   pending=true           -> décaissement soumis, statut final à venir
//                             (check-status / callback signé)
//   ok=false, pending=false-> échec définitif (relançable)
// ------------------------------------------------------------
async function attemptTransfer({ alias, withdrawMode, amount }) {
  const walletMode = withdrawMode && withdrawMode !== 'paydunya';

  if (!walletMode) {
    // Compte PayDunya -> compte PayDunya (v1, réponse immédiate).
    try {
      const transfer = await creditPaydunyaAccount(alias, amount);
      return {
        ok: true,
        pending: false,
        providerToken: null,
        transactionId: transfer.transactionId || null,
        providerRef: null,
        description: transfer.description || '',
        response: { ...transfer, ok: true },
      };
    } catch (err) {
      return {
        ok: false,
        pending: false,
        providerToken: null,
        transactionId: null,
        providerRef: null,
        description: err.message || 'Erreur PayDunya',
        response: { ok: false, message: err.message || 'Erreur PayDunya', code: err.code ?? null },
      };
    }
  }

  // Wallet mobile money : flux officiel get-invoice -> submit-invoice.
  try {
    const created = await createDisburseInvoice({
      accountAlias: alias,
      amount,
      withdrawMode,
      callbackUrl: paydunyaDisburseCallbackUrl(),
    });
    const submitted = await submitDisburseInvoice({ token: created.token });

    if (submitted.status === 'success') {
      return {
        ok: true,
        pending: false,
        providerToken: created.token,
        transactionId: submitted.transactionId,
        providerRef: submitted.providerRef,
        description: submitted.description,
        response: { ok: true, status: 'success', ...submitted },
      };
    }
    const pending = submitted.status === 'pending';
    return {
      ok: false,
      pending,
      providerToken: created.token,
      transactionId: submitted.transactionId,
      providerRef: submitted.providerRef,
      description: submitted.description || (pending ? 'Versement en attente chez l’opérateur' : 'Versement refusé'),
      response: {
        ok: false,
        pending,
        status: submitted.status,
        message: pending
          ? 'Versement en attente chez l’opérateur'
          : submitted.description || 'Versement refusé',
        code: submitted.status,
      },
    };
  } catch (err) {
    return {
      ok: false,
      pending: false,
      providerToken: null,
      transactionId: null,
      providerRef: null,
      description: err.message || 'Erreur PayDunya',
      response: { ok: false, message: err.message || 'Erreur PayDunya', code: err.code ?? null },
    };
  }
}

function libelleDestination(row) {
  const mode = row.withdraw_mode;
  if (mode && mode !== 'paydunya') {
    // Libellé humain du mode PayDunya (wave-senegal -> Wave).
    if (mode.startsWith('wave')) return 'Wave';
    if (mode.includes('orange-money')) return 'Orange Money';
    if (mode.includes('free-money')) return 'Free Money';
    if (mode.includes('expresso') || mode.includes('e-money')) return 'E Money';
    if (mode.includes('celtiis')) return 'Celtiis Cash';
    if (mode.includes('mtn')) return 'MTN MoMo';
    if (mode.includes('moov')) return 'Moov Money';
    if (mode.includes('t-money')) return 'T-Money';
    if (mode.includes('djamo')) return 'Djamo';
    return mode;
  }
  return 'compte PayDunya';
}

async function markSuccess(existing, attempt) {
  const now = new Date().toISOString();
  const { data, error } = await sb()
    .from('paydunya_redistributions')
    .update({
      status: 'success',
      recipient_alias: attempt.alias ?? existing.recipient_alias,
      withdraw_mode: attempt.withdrawMode ?? existing.withdraw_mode,
      transaction_id: attempt.transactionId || existing.transaction_id || null,
      provider_token: attempt.providerToken || null,
      provider_ref: attempt.providerRef || null,
      response: attempt.response,
      attempt_count: (existing.attempt_count || 0) + 1,
      last_attempt_at: now,
      updated_at: now,
    })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;

  await notifyOwner(
    data.user_id,
    'success',
    `Versement PayDunya effectué (${data.recipient_label || data.source}, ` +
      `${Number(data.amount).toLocaleString('fr-FR')} FCFA) sur ${libelleDestination(data)} ${data.recipient_alias}.`
  );
  return data;
}

async function markFailure(existing, attempt) {
  const now = new Date().toISOString();
  const { data, error } = await sb()
    .from('paydunya_redistributions')
    .update({
      recipient_alias: attempt.alias ?? existing.recipient_alias,
      withdraw_mode: attempt.withdrawMode ?? existing.withdraw_mode,
      provider_token: attempt.providerToken || null,
      provider_ref: attempt.providerRef || null,
      transaction_id: attempt.transactionId || existing.transaction_id || null,
      response: attempt.response,
      attempt_count: (existing.attempt_count || 0) + 1,
      last_attempt_at: now,
      updated_at: now,
    })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Relance une redistribution non aboutie (idempotent : ignore les
// 'success'). Le destinataire ACTUEL est relu : s'il a changé de moyen
// ou corrigé son compte, la relance part automatiquement dessus.
//
// Sécurité double-paiement : si un décaissement wallet est déjà soumis
// (provider_token), son statut est d'abord revérifié auprès de PayDunya ;
// un versement 'pending' n'est jamais rejoué.
export async function retryRedistribution(id) {
  const { data: existing } = await sb().from('paydunya_redistributions').select('*').eq('id', id).maybeSingle();
  if (!existing) throw new Error('Redistribution introuvable.');
  if (existing.status === 'success') return existing;

  // --- 1) Décaissement wallet déjà soumis : vérifier son statut d'abord.
  if (existing.provider_token && existing.withdraw_mode && existing.withdraw_mode !== 'paydunya') {
    let checked = null;
    try {
      checked = await checkDisburseStatus(existing.provider_token);
    } catch (err) {
      checked = { status: '', error: err.message || 'Erreur PayDunya' };
    }

    if (checked.status === 'success') {
      return await markSuccess(existing, {
        alias: existing.recipient_alias,
        withdrawMode: existing.withdraw_mode,
        providerToken: existing.provider_token,
        transactionId: checked.transactionId,
        providerRef: checked.providerRef,
        response: { ok: true, status: 'success', source: 'check-status', ...checked },
      });
    }

    if (checked.status === 'pending') {
      const now = new Date().toISOString();
      const { data, error } = await sb()
        .from('paydunya_redistributions')
        .update({
          response: { ok: false, pending: true, message: 'Versement toujours en attente chez l’opérateur' },
          last_attempt_at: now,
          updated_at: now,
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    if (checked.status === 'created') {
      // Jamais soumis (crash entre get et submit) : soumission du MÊME token.
      try {
        const submitted = await submitDisburseInvoice({ token: existing.provider_token });
        if (submitted.status === 'success') {
          return await markSuccess(existing, {
            alias: existing.recipient_alias,
            withdrawMode: existing.withdraw_mode,
            providerToken: existing.provider_token,
            transactionId: submitted.transactionId,
            providerRef: submitted.providerRef,
            response: { ok: true, status: 'success', ...submitted },
          });
        }
        if (submitted.status === 'pending') {
          const now = new Date().toISOString();
          const { data, error } = await sb()
            .from('paydunya_redistributions')
            .update({
              response: { ok: false, pending: true, message: 'Versement en attente chez l’opérateur' },
              last_attempt_at: now,
              updated_at: now,
            })
            .eq('id', existing.id)
            .select()
            .single();
          if (error) throw error;
          return data;
        }
        // 'failed' définitif : nouvelle tentative complète ci-dessous.
      } catch (submitErr) {
        console.warn('[redistribution] soumission impossible, nouvelle tentative :', submitErr.message);
      }
    }
    // 'failed', statut inconnu ou erreur API : on retente proprement
    // (nouveau token) ci-dessous — l'ancien token est abandonné.
  }

  // --- 2) Résolution À JOUR du destinataire.
  let target = {
    alias: existing.recipient_alias,
    withdrawMode: existing.withdraw_mode || 'paydunya',
  };
  try {
    let resolved = null;
    if (existing.source === 'loyer' && existing.user_id) {
      resolved = await recipientTargetOfOwner(existing.user_id);
    } else if (existing.source === 'salaire' && existing.paiement_employe_id) {
      const { data: pe } = await sb()
        .from('paiements_employes')
        .select('employe_id')
        .eq('id', existing.paiement_employe_id)
        .maybeSingle();
      if (pe?.employe_id) resolved = await recipientTargetOfEmploye(pe.employe_id);
    }
    if (resolved?.alias) target = resolved;
  } catch (resolveErr) {
    console.warn('[redistribution] résolution destinataire impossible :', resolveErr.message);
  }

  // --- 3) Nouvelle tentative de versement.
  const attempt = await attemptTransfer({
    alias: target.alias,
    withdrawMode: target.withdrawMode,
    amount: Number(existing.amount),
  });

  if (attempt.ok) {
    return await markSuccess(existing, {
      alias: target.alias,
      withdrawMode: target.withdrawMode,
      providerToken: attempt.providerToken,
      transactionId: attempt.transactionId,
      providerRef: attempt.providerRef,
      response: attempt.response,
    });
  }

  const updated = await markFailure(existing, {
    alias: target.alias,
    withdrawMode: target.withdrawMode,
    providerToken: attempt.providerToken,
    transactionId: attempt.transactionId,
    providerRef: attempt.providerRef,
    response: attempt.response,
  });
  // Un versement 'pending' chez l'opérateur reste en l'état : il sera
  // confirmé par le callback signé ou une prochaine vérification.
  return updated;
}

// Crée la redistribution et tente immédiatement le versement.
//  opts : { source: 'loyer'|'salaire', userId, paiementId?, paiementEmployeId?,
//           recipientAlias, recipientWithdrawMode?, recipientLabel?, amount }
// Retourne la ligne paydunya_redistributions ('success' ou 'pending').
export async function createAndAttemptRedistribution({
  source,
  userId,
  paiementId = null,
  paiementEmployeId = null,
  recipientAlias,
  recipientWithdrawMode = 'paydunya',
  recipientLabel = '',
  amount,
}) {
  const attempt = await attemptTransfer({
    alias: String(recipientAlias),
    withdrawMode: recipientWithdrawMode || 'paydunya',
    amount: Number(amount),
  });

  const now = new Date().toISOString();
  const row = {
    user_id: userId,
    source,
    paiement_id: paiementId,
    paiement_employe_id: paiementEmployeId,
    recipient_alias: String(recipientAlias),
    recipient_label: recipientLabel ? String(recipientLabel) : null,
    withdraw_mode: recipientWithdrawMode || 'paydunya',
    provider_token: attempt.providerToken,
    provider_ref: attempt.providerRef,
    amount: Number(amount),
    status: attempt.ok ? 'success' : 'pending',
    transaction_id: attempt.transactionId,
    response: attempt.response,
    attempt_count: 1,
    last_attempt_at: now,
    updated_at: now,
  };

  const { data: redistribution, error } = await sb()
    .from('paydunya_redistributions')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;

  // En cas d'échec DÉFINITIF du premier essai, une seule relance auto
  // (un décaissement 'pending' ne doit jamais être rejoué ici).
  let finalRow = redistribution;
  if (!attempt.ok && !attempt.pending) {
    finalRow = await retryRedistribution(redistribution.id);
  }

  // Versement toujours bloqué après deux tentatives (échecs définitifs
  // uniquement) : le destinataire doit corriger son moyen / alias.
  if (finalRow.status !== 'success' && finalRow.response?.pending !== true) {
    const raison = finalRow.response?.message || 'versement refusé';
    await notifyOwner(
      finalRow.user_id,
      'warning',
      `Versement PayDunya en attente (${finalRow.recipient_label || finalRow.source}, ` +
        `${Number(finalRow.amount).toLocaleString('fr-FR')} FCFA) : ${raison}. ` +
        `Vérifiez le moyen de réception « ${libelleDestination(finalRow)} · ${finalRow.recipient_alias} » ; ` +
        `l'administration peut relancer l'opération.`
    );
  }

  return finalRow;
}

// ------------------------------------------------------------
// Finalisation d'un décaissement wallet signalé par PayDunya
// (callback signé POST /api/paydunya/disburse-callback, hash
// SHA-512 du Master Key vérifié par la route).
// Idempotent : seules les redistributions encore 'pending' sont
// mises à jour, et chaque transition notifie une seule fois.
// ------------------------------------------------------------
export async function finalizeDisbursementByProviderToken(providerToken, status, extras = {}) {
  const { data: row } = await sb()
    .from('paydunya_redistributions')
    .select('*')
    .eq('provider_token', String(providerToken))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return null;

  const now = new Date().toISOString();

  if (status === 'success') {
    const { data: updated, error } = await sb()
      .from('paydunya_redistributions')
      .update({
        status: 'success',
        transaction_id: extras.transactionId || row.transaction_id || null,
        provider_ref: extras.providerRef || extras.disburseTxId || row.provider_ref || null,
        response: { ok: true, status: 'success', source: 'callback', ...extras },
        last_attempt_at: now,
        updated_at: now,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (updated) {
      await notifyOwner(
        updated.user_id,
        'success',
        `Versement PayDunya confirmé (${updated.recipient_label || updated.source}, ` +
          `${Number(updated.amount).toLocaleString('fr-FR')} FCFA) sur ${libelleDestination(updated)} ${updated.recipient_alias}.`
      );
    }
    return updated || row;
  }

  if (status === 'failed') {
    const { data: updated, error } = await sb()
      .from('paydunya_redistributions')
      .update({
        response: {
          ok: false,
          message: extras.description || 'Versement refusé par l’opérateur (confirmé par PayDunya)',
          source: 'callback',
          ...extras,
        },
        last_attempt_at: now,
        updated_at: now,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (updated) {
      await notifyOwner(
        updated.user_id,
        'warning',
        `Versement PayDunya refusé (${updated.recipient_label || updated.source}, ` +
          `${Number(updated.amount).toLocaleString('fr-FR')} FCFA) vers ${updated.recipient_alias}. ` +
          `Vérifiez votre moyen de réception ; l'administration peut relancer l'opération.`
      );
    }
    return updated || row;
  }

  return row;
}
