// ============================================================
// MIM - Échéances (logique serveur partagée)
//
// La nouvelle échéance est créée UNIQUEMENT après validation du
// propriétaire (le locataire a réellement payé). La logique de
// mois suivant est centralisée ici pour éviter toute duplication
// (checkLoyers.js crée l'échéance du mois courant ; la validation
// crée celle du mois suivant).
// ============================================================

// Mois suivant au format AAAA-MM (gère mois courts, changement d'année).
export function nextMois(mois) {
  if (!/^\d{4}-\d{2}$/.test(String(mois || ''))) return null;
  const [y, m] = String(mois).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Crée l'échéance du mois suivant pour un paiement de loyer VALIDÉ.
// Montant relu en base (loyer_mensuel du logement) : jamais le client.
// Ne crée rien si une échéance existe déjà pour ce mois (anti-doublon).
export async function creerEcheanceSuivante(sb, paiement) {
  const moisSuivant = nextMois(paiement.mois);
  if (!moisSuivant) return { created: false, mois: null, error: 'mois invalide' };

  const { data: logement } = await sb
    .from('logements')
    .select('user_id, loyer_mensuel')
    .eq('id', paiement.logement_id)
    .maybeSingle();
  if (!logement) return { created: false, mois: moisSuivant, error: 'logement introuvable' };

  const { data: existing } = await sb
    .from('paiements')
    .select('id')
    .eq('locataire_id', paiement.locataire_id)
    .eq('mois', moisSuivant)
    .maybeSingle();
  if (existing) return { created: false, mois: moisSuivant, error: null, existing: true };

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