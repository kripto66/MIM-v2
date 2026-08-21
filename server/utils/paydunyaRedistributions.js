// ============================================================
// MIM - Redistribution PayDunya (PER / Déboursement)
//
// Après un encaissement PayDunya (loyer ou salaire), MIM verse au
// destinataire (propriétaire / employé) via l'API « Payment ET
// Redistribution » : POST /direct-pay/credit-account.
//
// Le destinataire doit avoir un compte PayDunya ; son alias est :
//   1. paydunya_alias du moyen de réception (si renseigné) ;
//   2. le téléphone du profil (sinon) ;
//   3. l'email du compte auth (en dernier recours).
//
// Une redistribution est UNIQUE par cible (paiement de loyer ou de
// salaire) : findRedistributionForTarget permet le dédoublonnage avant
// création. Un échec laisse la redistribution en 'pending'
// (relançable depuis l'admin : POST /api/paydunya/redistributions/:id/retry,
// ou automatiquement au re-traitement du paiement).
//
// Le destinataire est notifié lorsqu'un versement reste bloqué et
// lorsqu'il aboutit après une relance.
// ============================================================

import { creditPaydunyaAccount } from './paydunya.js';
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

// Alias PayDunya du propriétaire (destinataire d'un loyer).
export async function recipientAliasOfOwner(userId) {
  const { data: moyen } = await sb()
    .from('moyens_paiement')
    .select('paydunya_alias')
    .eq('user_id', userId)
    .eq('actif', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromMoyen = normalizeAlias(moyen?.paydunya_alias);
  if (fromMoyen) return fromMoyen;

  const { data: profile } = await sb().from('profiles').select('phone').eq('id', userId).maybeSingle();
  const phone = normalizeAlias(profile?.phone);
  if (phone) return phone;

  const { data: authUser } = await sb().auth.admin.getUserById(userId);
  const email = normalizeAlias(authUser?.user?.email);
  if (email) return email;

  return null;
}

// Alias PayDunya de l'employé (destinataire d'un salaire).
export async function recipientAliasOfEmploye(employeId) {
  const { data: employe } = await sb().from('employes').select('nom, phone, account_uid').eq('id', employeId).maybeSingle();
  if (!employe) return null;

  const { data: moyen } = await sb()
    .from('moyens_paiement_employes')
    .select('paydunya_alias')
    .eq('employe_uid', employe.account_uid)
    .eq('actif', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromMoyen = normalizeAlias(moyen?.paydunya_alias);
  if (fromMoyen) return fromMoyen;

  const phone = normalizeAlias(employe.phone);
  if (phone) return phone;

  if (employe.account_uid) {
    const { data: authUser } = await sb().auth.admin.getUserById(employe.account_uid);
    const email = normalizeAlias(authUser?.user?.email);
    if (email) return email;
  }

  return null;
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

// Crée la redistribution et tente immédiatement le versement.
//  opts : { source: 'loyer'|'salaire', userId, paiementId?, paiementEmployeId?,
//           recipientAlias, recipientLabel?, amount }
// Retourne la ligne paydunya_redistributions (status 'success' ou 'pending').
export async function createAndAttemptRedistribution({ source, userId, paiementId = null, paiementEmployeId = null, recipientAlias, recipientLabel = '', amount }) {
  const row = {
    user_id: userId,
    source,
    paiement_id: paiementId,
    paiement_employe_id: paiementEmployeId,
    recipient_alias: String(recipientAlias),
    recipient_label: recipientLabel ? String(recipientLabel) : null,
    amount: Number(amount),
    status: 'pending',
    attempt_count: 0,
  };

  let redistribution;
  try {
    const transfer = await creditPaydunyaAccount(recipientAlias, amount);
    row.status = 'success';
    row.transaction_id = transfer.transactionId || null;
    row.response = { ...transfer, ok: true };
  } catch (err) {
    row.response = { ok: false, message: err.message || 'Erreur PayDunya', code: err.code || null };
  }
  row.attempt_count = 1;
  row.last_attempt_at = new Date().toISOString();
  row.updated_at = row.last_attempt_at;

  const { data, error } = await sb().from('paydunya_redistributions').insert(row).select('*').single();
  if (error) throw error;
  redistribution = data;

  // Si le premier essai a échoué, on relance une fois automatiquement.
  if (redistribution.status === 'pending') {
    redistribution = await retryRedistribution(redistribution.id);
  }

  // Le versement reste bloqué après deux tentatives : le destinataire
  // doit corriger son alias (le paiement principal reste valide).
  if (redistribution.status !== 'success') {
    const raison = redistribution.response?.message || 'versement refusé';
    await notifyOwner(
      redistribution.user_id,
      'warning',
      `Versement PayDunya en attente (${redistribution.recipient_label || redistribution.source}, ` +
        `${Number(redistribution.amount).toLocaleString('fr-FR')} FCFA) : ${raison}. ` +
        `Vérifiez l'alias « ${redistribution.recipient_alias} » ; l'administration peut relancer l'opération.`
    );
  }

  return redistribution;
}

// Relance un versement échoué (idempotent : ignore les 'success').
// L'alias ACTUEL du destinataire est relu : s'il a corrigé son compte
// PayDunya depuis l'échec, la relance part automatiquement sur le
// nouvel alias. Notifie le destinataire lorsqu'une relance aboutit.
export async function retryRedistribution(id) {
  const { data: existing } = await sb().from('paydunya_redistributions').select('*').eq('id', id).maybeSingle();
  if (!existing) throw new Error('Redistribution introuvable.');
  if (existing.status === 'success') return existing;

  // Résolution de l'alias à jour du destinataire (fallback : alias figé).
  let alias = existing.recipient_alias;
  try {
    if (existing.source === 'loyer' && existing.user_id) {
      alias = (await recipientAliasOfOwner(existing.user_id)) || alias;
    } else if (existing.source === 'salaire' && existing.paiement_employe_id) {
      const { data: pe } = await sb()
        .from('paiements_employes')
        .select('employe_id')
        .eq('id', existing.paiement_employe_id)
        .maybeSingle();
      if (pe?.employe_id) alias = (await recipientAliasOfEmploye(pe.employe_id)) || alias;
    }
  } catch {
    /* résolution impossible : on retente avec l'alias connu */
  }

  try {
    const transfer = await creditPaydunyaAccount(alias, Number(existing.amount));
    const { data, error } = await sb()
      .from('paydunya_redistributions')
      .update({
        status: 'success',
        recipient_alias: alias,
        transaction_id: transfer.transactionId || null,
        response: { ...transfer, ok: true },
        attempt_count: (existing.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;

    await notifyOwner(
      data.user_id,
      'success',
      `Versement PayDunya effectué (${data.recipient_label || data.source}, ` +
        `${Number(data.amount).toLocaleString('fr-FR')} FCFA) vers ${data.recipient_alias}.`
    );
    return data;
  } catch (err) {
    const { data, error } = await sb()
      .from('paydunya_redistributions')
      .update({
        recipient_alias: alias,
        response: { ok: false, message: err.message || 'Erreur PayDunya', code: err.code || null },
        attempt_count: (existing.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}