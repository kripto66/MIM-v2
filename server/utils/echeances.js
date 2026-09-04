// ============================================================
// MIM - Échéances (logique serveur partagée)
//
// Une échéance n'existe que pour un mois DÉJÀ COMMENCÉ : on ne crée
// jamais d'échéance pour un mois strictement futur (sinon le locataire
// devrait payer en avance et les échéances ne correspondraient pas au
// mois affiché). Le mois courant — ou le mois d'entrée si celui-ci est
// futur — est assuré par creerEcheanceInitiale (création locataire +
// auto-assurance au chargement du dashboard locataire) et par le cron
// checkLoyers.js. La validation d'un paiement ne crée le mois suivant
// que si ce mois a commencé (mois payé + 1) ; sinon le locataire reste
// « à jour » jusqu'au mois suivant.
// ============================================================

// Mois suivant au format AAAA-MM (gère mois courts, changement d'année).
export function nextMois(mois) {
  if (!/^\d{4}-\d{2}$/.test(String(mois || ''))) return null;
  const [y, m] = String(mois).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Mois courant au format AAAA-MM (fuseau serveur).
export function currentMois() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Crée l'échéance du mois courant pour un locataire venant d'être créé
// (formulaire unique « Ajouter un locataire »). Si la date d'entrée est
// dans le futur, l'échéance est créée pour le mois de la date d'entrée.
// Anti-doublon : rien n'est créé si une échéance existe déjà pour ce mois.
export async function creerEcheanceInitiale(sb, { userId, locataireId, logementId, montant, dateEntree }) {
  let mois = currentMois();
  if (dateEntree) {
    const m = String(dateEntree).slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m) && m > mois) mois = m;
  }

  const { data: existing } = await sb
    .from('paiements')
    .select('id')
    .eq('locataire_id', locataireId)
    .eq('mois', mois)
    .limit(1);
  if (existing?.length) return { created: false, mois, error: null, existing: true };

  const { data, error } = await sb
    .from('paiements')
    .insert({
      user_id: userId,
      locataire_id: locataireId,
      logement_id: logementId,
      montant: Number(montant),
      mois,
      statut: 'attente',
    })
    .select()
    .single();

  if (error) return { created: false, mois, error: error.message };
  return { created: true, mois, paiement: data };
}

// Crée l'échéance du mois suivant pour un paiement de loyer VALIDÉ.
// Montant relu en base (loyer_mensuel du logement) : jamais le client.
// Ne crée rien si une échéance existe déjà pour ce mois (anti-doublon).
export async function creerEcheanceSuivante(sb, paiement) {
  const moisSuivant = nextMois(paiement.mois);
  if (!moisSuivant) return { created: false, mois: null, error: 'mois invalide' };

  // L'échéance du mois suivant n'est créée que lorsque ce mois a commencé :
  // valider le loyer de septembre le 4 septembre ne doit PAS faire « payer
  // octobre » aussitôt. Le mois suivant, l'échéance sera assurée par le
  // dashboard locataire et/ou le cron checkLoyers.
  if (moisSuivant > currentMois()) {
    return { created: false, mois: moisSuivant, error: null, future: true };
  }

  const { data: logement } = await sb
    .from('logements')
    .select('user_id, loyer_mensuel')
    .eq('id', paiement.logement_id)
    .maybeSingle();
  if (!logement) return { created: false, mois: moisSuivant, error: 'logement introuvable' };

  // Anti-doublon robuste : limit(1) ne renvoie JAMAIS d'erreur quand
  // plusieurs échéances existent pour ce mois (maybeSingle échouerait
  // avec PGRST116 et laisserait passer un doublon).
  const { data: existing } = await sb
    .from('paiements')
    .select('id')
    .eq('locataire_id', paiement.locataire_id)
    .eq('mois', moisSuivant)
    .limit(1);
  if (existing?.length) return { created: false, mois: moisSuivant, error: null, existing: true };

  const { data, error } = await sb
    .from('paiements')
    .insert({
      user_id: logement.user_id,
      locataire_id: paiement.locataire_id,
      logement_id: paiement.logement_id,
      montant: Number(logement.loyer_mensuel),
      mois: moisSuivant,
      statut: 'attente',
    })
    .select()
    .single();

  if (error) return { created: false, mois: moisSuivant, error: error.message };
  return { created: true, mois: moisSuivant, paiement: data };
}

// Répercute un changement de loyer_mensuel sur les échéances OUVERTES
// (« attente » / « retard ») du logement : sans cela, le locataire
// continuerait de devoir l'ancien montant jusqu'à l'échéance suivante.
// Les échéances déjà réglées (« paye ») ou déclarées par le locataire
// (« a_confirmer ») conservent leur montant d'origine (historique).
export async function syncMontantEcheancesOuvertes(sb, { logementId, montant }) {
  const value = Number(montant);
  if (!logementId || !Number.isFinite(value)) {
    return { updated: 0, error: 'Paramètres invalides.' };
  }

  const { data, error } = await sb
    .from('paiements')
    .update({ montant: value })
    .eq('logement_id', logementId)
    .in('statut', ['attente', 'retard'])
    .select('id');

  if (error) return { updated: 0, error: error.message };
  return { updated: data?.length || 0, error: null };
}