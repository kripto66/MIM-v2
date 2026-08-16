// ============================================================
// MIM - Méthodes de paiement (référentiel unifié)
// Utilisé par : loyers (paiements), salaires (paiements_employes),
// abonnement MIM (abonnement_paiements).
//
// Depuis le système « Déclaration + validation propriétaire », le
// propriétaire configure ses propres moyens de paiement (table
// moyens_paiement) et le locataire paie DIRECTEMENT le propriétaire.
// MIM n'encaisse rien : il enregistre la déclaration et la
// validation métier du propriétaire.
//
// Référentiel :
//   especes | mobile_money | virement | carte   (historique, conservé)
//   wave    | orange_money                     (moyens configurés)
// ============================================================

export const METHODES_PAIEMENT = ['especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money'];

export const METHODE_LABELS = {
  especes: 'Espèces',
  mobile_money: 'Mobile Money',
  virement: 'Virement bancaire',
  carte: 'Carte bancaire',
  wave: 'Wave',
  orange_money: 'Orange Money',
};

// Renvoie null si valide (ou vide), sinon un message d'erreur.
export function methodePaiementError(value) {
  if (value == null || value === '') return null;
  return METHODES_PAIEMENT.includes(value) ? null : 'Méthode de paiement invalide.';
}

export function methodeLabel(value) {
  return METHODE_LABELS[value] || value || '—';
}

// Types de moyens de paiement configurables par le propriétaire.
export const TYPES_MOYENS_PAIEMENT = ['wave', 'orange_money', 'virement', 'especes'];

export const TYPE_MOYEN_LABELS = {
  wave: 'Wave',
  orange_money: 'Orange Money',
  virement: 'Virement bancaire',
  especes: 'Espèces',
};

export const TYPE_MOYEN_ICONS = {
  wave: '🟣',
  orange_money: '🟠',
  virement: '🏦',
  especes: '💵',
};

// Champs admis par type de moyen de paiement (propriétaire ET employé).
export const CHAMPS_MOYEN = {
  wave: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  orange_money: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  virement: ['banque', 'nom_titulaire', 'num_compte', 'iban', 'bic', 'instructions'],
  especes: ['instructions'],
};

// Nettoie un corps de moyen de paiement selon son type (champs admis,
// chaînes tronquées à 200 caractères, valeurs vides ignorées).
export function sanitizeMoyenBody(type, body) {
  const clean = {};
  for (const field of CHAMPS_MOYEN[type] || []) {
    const v = body?.[field];
    if (v != null && String(v).trim() !== '') clean[field] = String(v).trim().slice(0, 200);
  }
  if (body?.actif === false || body?.actif === true) clean.actif = Boolean(body.actif);
  clean.updated_at = new Date().toISOString();
  return clean;
}