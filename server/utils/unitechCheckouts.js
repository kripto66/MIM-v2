// ============================================================
// MIM - Initiation de session UnitechPay (partagé)
//
// Utilisé par :
//   - routes/unitech.js (loyers + salaires, côté propriétaire)
//   - routes/admin.js    (abonnements MIM, côté admin)
//
// Le montant / destinataire / propriétaire sont TOUJOURS fournis par
// l'appelant APRÈS relecture en base : jamais de confiance au client.
// ============================================================

import { createWavePayment, createOrangePayment, withdrawFunds } from './unitech.js';
import { serviceClient } from '../app.js';

const sb = () => serviceClient();

// Redirections navigateur APRÈS paiement. La décision réelle (statut
// payé) vient uniquement du webhook vérifié.
//
// L'API Wave exige des URL de callback publiques en HTTPS : une URL
// http:// (développement local) est rejetée avec une erreur HTTP 400
// (« Erreur Wave API: HTTP 400 ») à la création du paiement. Lorsque
// APP_URL n'est pas un URL HTTPS, les callbacks sont omis : le paiement
// est tout de même créé et le statut final est confirmé par le webhook
// UnitechPay (configuré côté tableau de bord marchand).
function callbackUrls() {
  const base = process.env.APP_URL || '';
  try {
    if (new URL(base).protocol !== 'https:') return { success: '', cancel: '' };
  } catch {
    return { success: '', cancel: '' };
  }
  const root = base.replace(/\/+$/, '');
  return {
    success: `${root}/paiement-succes`,
    cancel: `${root}/paiement-annule`,
  };
}

const METHODS = {
  wave: 'wave',
  orange_qr: 'orange_qr',
  orange_maxit: 'orange_maxit',
  orange_om: 'orange_om',
};

// Initie une session UnitechPay et l'enregistre en base.
//  opts.source : 'loyer' | 'salaire' | 'abonnement'
//  opts.operator : 'wave' | 'orange' (orangeMode : 'qr'|'maxit'|'om')
//  opts.payout : true -> versement (withdraw_funds), sinon encaissement.
// Retourne la ligne unitech_checkouts insérée (status 'pending').
export async function initiateUnitechCheckout({
  source,
  userId,
  amount,
  description = '',
  operator = 'wave',
  orangeMode = 'om',
  customerNumber = '',
  payout = false,
  paiementId = null,
  paiementEmployeId = null,
  abonnementPaiementId = null,
}) {
  const cb = callbackUrls();

  let result;
  if (payout) {
    result = await withdrawFunds({
      amount,
      customerNumber,
      operator,
      description,
    });
  } else if (operator === 'orange') {
    result = await createOrangePayment({
      type: orangeMode,
      amount,
      customerNumber,
      description,
      callbackSuccess: cb.success,
      callbackCancel: cb.cancel,
    });
  } else {
    result = await createWavePayment({
      amount,
      customerNumber,
      description,
      callbackSuccess: cb.success,
      callbackCancel: cb.cancel,
    });
  }

  const method =
    payout ? METHODS.wave
    : operator === 'orange' ? (METHODS[`orange_${orangeMode}`] || 'orange_om')
    : METHODS.wave;

  // unitechRequest renvoie { success, data: {...} } : les informations de
  // transaction sont sous result.data.
  const info = result?.data || result || {};

  const checkout = {
    user_id: userId,
    source,
    paiement_id: paiementId,
    paiement_employe_id: paiementEmployeId,
    abonnement_paiement_id: abonnementPaiementId,
    unitech_reference: String(info.reference || ''),
    unitech_transaction_id: info.transaction_id != null ? String(info.transaction_id) : null,
    method,
    amount: Number(amount),
    status: 'pending',
    payment_url: info.payment_url || info.qr_code || null,
    description: description || null,
  };

  if (!checkout.unitech_reference) {
    throw new Error('UnitechPay n\'a pas retourné de référence.');
  }

  const { data, error } = await sb().from('unitech_checkouts').insert(checkout).select('*').single();
  if (error) throw error;
  return data;
}
