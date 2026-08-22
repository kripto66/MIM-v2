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

// Modes de retrait PayDunya (API Déboursement v2) : un moyen dont le
// type est mappé ici peut recevoir les versements automatiques
// directement sur le wallet du bénéficiaire. Les autres types
// (virement, espèces) retombent sur un compte PayDunya classique.
export const WITHDRAW_MODES = {
  wave: 'wave-senegal',
  orange_money: 'orange-money-senegal',
};

export function withdrawModeOf(type) {
  return WITHDRAW_MODES[type] || null;
}

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
  // Moyen choisi pour RECEVOIR les versements automatiques PayDunya
  // (un seul actif à la fois : l'exclusivité est appliquée par les routes).
  if (body?.pour_versement === false || body?.pour_versement === true) {
    clean.pour_versement = Boolean(body.pour_versement);
  }
  clean.updated_at = new Date().toISOString();
  return clean;
}

// Un moyen peut recevoir les versements automatiques si son type est
// décaissable directement (wallet) avec un numéro exploitable, ou s'il
// porte un alias de compte PayDunya. `clean` doit représenter l'état
// FINAL du moyen (champs existants fusionnés avec le corps reçu).
// Renvoie null si valide, sinon un message d'erreur destiné à la route.
export function pourVersementError(type, clean) {
  if (!clean || clean.pour_versement !== true) return null;
  const digits = String(clean.numero || '').replace(/\D+/g, '');
  if (withdrawModeOf(type) && digits.length >= 6) return null;
  const alias = String(clean.paydunya_alias || '').trim();
  if (alias) return null;
  return 'Renseignez un numéro valide (ou un alias PayDunya) : ce moyen ne peut pas recevoir de versements automatiques.';
}