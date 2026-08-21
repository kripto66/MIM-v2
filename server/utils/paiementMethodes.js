// ============================================================
// MIM - Méthodes de paiement (référentiel unifié)
// Utilisé par : loyers (paiements), salaires (paiements_employes),
// abonnement MIM (abonnement_paiements).
//
// Deux systèmes coexistent :
//   - « Déclaration + validation propriétaire » : le propriétaire
//     configure ses propres moyens de paiement (table moyens_paiement)
//     et le locataire paie DIRECTEMENT le propriétaire. MIM n'encaisse
//     rien : il enregistre la déclaration et la validation.
//   - « PayDunya (encaissement MIM) » : le locataire / propriétaire /
//     admin paie via une facture PayDunya, MIM encaisse puis
//     redistribue (méthode 'paydunya').
//
// Référentiel :
//   especes | mobile_money | virement | carte   (historique, conservé)
//   wave    | orange_money                     (moyens configurés)
//   paydunya                                    (paiement en ligne MIM)
// ============================================================

export const METHODES_PAIEMENT = ['especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'paydunya'];

export const METHODE_LABELS = {
  especes: 'Espèces',
  mobile_money: 'Mobile Money',
  virement: 'Virement bancaire',
  carte: 'Carte bancaire',
  wave: 'Wave',
  orange_money: 'Orange Money',
  paydunya: 'PayDunya',
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

// Champs admis par type de moyen de paiement (propriétaire ET employé).
export const CHAMPS_MOYEN = {
  wave: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  orange_money: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  virement: ['banque', 'nom_titulaire', 'num_compte', 'iban', 'bic', 'instructions'],
  especes: ['instructions'],
};

// Alias PayDunya (compte de réception des redistributions) :
// vide = autorisé (retour au téléphone/email de secours) ; sinon doit
// ressembler à un email ou à un numéro de téléphone (>= 6 chiffres,
// séparateurs/indicatifs tolérés). Évite les alias aberrants qui
// feraient échouer silencieusement chaque versement.
export function paydunyaAliasError(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.length > 200) return "L'alias PayDunya ne doit pas dépasser 200 caractères.";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null; // email
  if ((v.match(/\d/g) || []).length >= 6) return null; // téléphone (+221 77 123 45 67, etc.)
  return "L'alias PayDunya doit être un email ou un numéro de téléphone valides.";
}

// Nettoie un corps de moyen de paiement selon son type (champs admis,
// chaînes tronquées à 200 caractères).
// Règle : un champ ABSENT (clé non fournie) n'est pas modifié ; un champ
// présent mais vide ('' ou null) est converti en null (permet d'effacer le
// lien en édition).
export function sanitizeMoyenBody(type, body) {
  const clean = {};
  for (const field of CHAMPS_MOYEN[type] || []) {
    if (!body || !(field in body)) continue;
    const v = body[field];
    const s = v == null ? '' : String(v).trim();
    clean[field] = s === '' ? null : s.slice(0, 200);
  }
  // Alias PayDunya (compte de réception des redistributions) : accepté
  // quel que soit le type de moyen ; la validité du FORMAT est contrôlée
  // par paydunyaAliasError (appelée par les routes).
  if (body && 'paydunya_alias' in body) {
    const v = body.paydunya_alias;
    const s = v == null ? '' : String(v).trim();
    clean.paydunya_alias = s === '' ? null : s.slice(0, 200);
  }
  if (body?.actif === false || body?.actif === true) clean.actif = Boolean(body.actif);
  clean.updated_at = new Date().toISOString();
  return clean;
}