// ============================================================
// MIM - Méthodes de paiement (référentiel unifié)
// Utilisé par : loyers (paiements), salaires (paiements_employes),
// abonnement MIM (abonnement_paiements).
// ============================================================

export const METHODES_PAIEMENT = ['especes', 'mobile_money', 'virement', 'carte'];

export const METHODE_LABELS = {
  especes: 'Espèces',
  mobile_money: 'Mobile Money',
  virement: 'Virement bancaire',
  carte: 'Carte bancaire',
};

// Renvoie null si valide (ou vide), sinon un message d'erreur.
export function methodePaiementError(value) {
  if (value == null || value === '') return null;
  return METHODES_PAIEMENT.includes(value) ? null : 'Méthode de paiement invalide.';
}

export function methodeLabel(value) {
  return METHODE_LABELS[value] || value || '—';
}
