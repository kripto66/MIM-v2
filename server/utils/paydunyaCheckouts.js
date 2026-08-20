// ============================================================
// MIM - Initiation de facture PayDunya (partagé)
//
// Utilisé par :
//   - routes/paydunya.js (loyers côté locataire, salaires côté propriétaire)
//   - routes/admin.js    (abonnements MIM, côté admin)
//
// Le montant / destinataire / propriétaire sont TOUJOURS fournis par
// l'appelant APRÈS relecture en base : jamais de confiance au client.
// ============================================================

import { createPaydunyaInvoice } from './paydunya.js';
import { serviceClient } from '../app.js';

const sb = () => serviceClient();

// Redirections navigateur APRÈS paiement. La décision réelle (statut
// payé) vient uniquement de l'IPN vérifié (hash SHA-512) + confirmation
// de la facture auprès de l'API PayDunya.
//
// PayDunya exige des URL de callback publiques en HTTPS : en
// développement local (http://localhost), les callbacks sont omis et le
// statut final est confirmé par l'IPN (configuré côté tableau de bord
// marchand, ou via le callback_url).
function paydunyaUrls() {
  const base = process.env.APP_URL || '';
  let https = false;
  try {
    https = new URL(base).protocol === 'https:';
  } catch {
    https = false;
  }
  if (!https) return { returnUrl: '', cancelUrl: '', callbackUrl: '' };
  const root = base.replace(/\/+$/, '');
  return {
    returnUrl: `${root}/paiement-succes`,
    cancelUrl: `${root}/paiement-annule`,
    callbackUrl: `${root}/api/paydunya/webhook`,
  };
}

// Initie une facture PayDunya et l'enregistre en base.
//  opts.source : 'loyer' | 'salaire' | 'abonnement'
//  opts.customer : { name?, email?, phone? } (payeur)
//  opts.customData : données internes récupérées à la confirmation.
// Retourne la ligne paydunya_invoices insérée (status 'pending').
export async function initiatePaydunyaInvoice({
  source,
  userId,
  amount,
  description = '',
  items = [],
  customer = {},
  customData = {},
  paiementId = null,
  paiementEmployeId = null,
  abonnementPaiementId = null,
}) {
  const urls = paydunyaUrls();

  const created = await createPaydunyaInvoice({
    totalAmount: amount,
    description,
    items,
    customer,
    customData,
    returnUrl: urls.returnUrl,
    cancelUrl: urls.cancelUrl,
    callbackUrl: urls.callbackUrl,
  });

  const invoice = {
    user_id: userId,
    source,
    token: created.token,
    status: 'pending',
    amount: Number(amount),
    payment_url: created.invoiceUrl || null,
    description: description || null,
    custom_data: customData && Object.keys(customData).length ? customData : null,
    paiement_id: paiementId,
    paiement_employe_id: paiementEmployeId,
    abonnement_paiement_id: abonnementPaiementId,
  };

  const { data, error } = await sb().from('paydunya_invoices').insert(invoice).select('*').single();
  if (error) throw error;
  return data;
}

// Reprend une facture 'pending' existante pour la même cible (loyer /
// salaire / abonnement) : on réutilise le même lien de paiement au lieu
// d'en créer un nouveau à chaque clic.
export async function findPendingPaydunyaInvoice({ source, userId, paiementId = null, paiementEmployeId = null, abonnementPaiementId = null }) {
  let query = sb().from('paydunya_invoices').select('*').eq('source', source).eq('user_id', userId).eq('status', 'pending');
  if (paiementId) query = query.eq('paiement_id', paiementId);
  if (paiementEmployeId) query = query.eq('paiement_employe_id', paiementEmployeId);
  if (abonnementPaiementId) query = query.eq('abonnement_paiement_id', abonnementPaiementId);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}