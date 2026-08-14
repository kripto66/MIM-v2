// ============================================================
// MIM - Méthodes de paiement (référentiel unifié)
// Utilisé par : loyers (paiements), salaires (paiements_employes),
// abonnement MIM (abonnement_paiements).
//
// Depuis l'intégration UnitechPay, la SEULE méthode de paiement est
// le Mobile Money (Wave / Orange Money via UnitechPay).
// ============================================================

export const METHODES_PAIEMENT = ['mobile_money'];

export const METHODE_LABELS = {
  mobile_money: 'Mobile Money (UnitechPay)',
};

// Renvoie null si valide (ou vide), sinon un message d'erreur.
export function methodePaiementError(value) {
  if (value == null || value === '') return null;
  return METHODES_PAIEMENT.includes(value) ? null : 'Méthode de paiement invalide.';
}

export function methodeLabel(value) {
  return METHODE_LABELS[value] || value || '—';
}
