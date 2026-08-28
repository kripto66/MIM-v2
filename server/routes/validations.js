// ============================================================
// MIM - Validation métier des paiements déclarés par les locataires
//
// Le locataire paie DIRECTEMENT le propriétaire (hors MIM) puis
// déclare avoir payé (statut « en_validation »). Le propriétaire
// vérifie RÉELLEMENT son compte puis :
//   - VALIDE  -> statut « paye » + validated_at + validated_by
//                + création de l'échéance du mois suivant ;
//   - REFUSE  -> statut « refuse » + rejection_reason
//                (l'échéance n'est PAS avancée).
//
// Sécurité :
//   - le paiement est relu en base, filtré par le propriétaire
//     connecté (req.user.id) ;
//   - mise à jour conditionnelle (statut attendu) : une seule
//     écriture gagne en cas de double requête simultanée ;
//   - montant / mois / échéance suivante : relus en base.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { notify, logementNomOf } from '../utils/notifications.js';
import { creerEcheanceSuivante, nextMois } from '../utils/echeances.js';
import { TYPE_MOYEN_LABELS } from '../utils/paiementMethodes.js';
import { formatMois } from '../utils/mois.js';

const router = Router();
const sb = () => serviceClient();

const REJECTION_MOTIFS = ['Paiement non reçu', 'Montant incorrect', 'Mauvais compte', 'Autre'];

// ============================================================
// Paiements en attente de validation du propriétaire connecté.
// ============================================================
router.get('/en-attente', async (req, res) => {
  try {
    const { data: paiements = [], error } = await sb()
      .from('paiements')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('statut', 'en_validation')
      .order('validation_requested_at', { ascending: false });

    if (error) throw error;

    const locatairesIds = [...new Set(paiements.map((p) => p.locataire_id))];
    const logementsIds = [...new Set(paiements.map((p) => p.logement_id).filter(Boolean))];

    const [locataires, logements] = await Promise.all([
      locatairesIds.length
        ? sb().from('locataires').select('id, nom').in('id', locatairesIds).eq('user_id', req.user.id)
        : Promise.resolve({ data: [] }),
      logementsIds.length
        ? sb().from('logements').select('id, nom').in('id', logementsIds).eq('user_id', req.user.id)
        : Promise.resolve({ data: [] }),
    ]);

    const locBy = new Map((locataires.data || []).map((l) => [String(l.id), l]));
    const lgBy = new Map((logements.data || []).map((l) => [String(l.id), l]));

    res.json({
      success: true,
      data: paiements.map((p) => ({
        ...p,
        locataire_nom: locBy.get(String(p.locataire_id))?.nom || null,
        logement_nom: lgBy.get(String(p.logement_id))?.nom || null,
      })),
    });
  } catch (err) {
    console.error('[validations/en-attente]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

// ============================================================
// Valider un paiement déclaré (paye + échéance suivante).
// ============================================================
router.post('/:id/valider', async (req, res) => {
  try {
    const { data: paiement } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut, validated_at, reference')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (paiement.statut !== 'en_validation') {
      const message = paiement.statut === 'paye' ? 'Ce paiement est déjà validé.' : 'Ce paiement ne peut pas être validé.';
      return res.status(400).json({ success: false, message });
    }

    // Mise à jour conditionnelle : une seule validation gagne en cas
    // de double requête simultanée.
    const { data: updated, error } = await sb()
      .from('paiements')
      .update({
        statut: 'paye',
        validated_at: new Date().toISOString(),
        validated_by: req.user.id,
      })
      .eq('id', paiement.id)
      .eq('statut', 'en_validation')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    // Nouvelle échéance (mois suivant) : montant relu en base, jamais
    // de doublon. La validation et la création de l'échéance sont
    // cohérentes : si l'échéance ne peut pas être créée, le paiement
    // reste validé (l'échéance sera créée par le cron) et on le signale.
    const echeance = await creerEcheanceSuivante(sb(), paiement);

    // Notification au locataire.
    try {
      const { tenantUidOfLocataire } = await import('../utils/notifications.js');
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        const nomLogement = await logementNomOf(paiement.logement_id);
        await notify(
          tenantUid,
          'paiement',
          `Paiement validé — votre propriétaire a confirmé votre paiement de ` +
            `${Number(paiement.montant).toLocaleString('fr-FR')} FCFA (${formatMois(paiement.mois)}).` +
            (echeance.created ? ` Prochaine échéance : ${formatMois(echeance.mois)}.` : '')
        );
      }
    } catch (e) {
      console.warn('[validations/valider] notification :', e.message);
    }

    res.json({
      success: true,
      data: updated,
      echeance: echeance.created ? { mois: echeance.mois } : null,
      message: echeance.created
        ? `Paiement validé. Nouvelle échéance créée (${formatMois(echeance.mois)}).`
        : echeance.error
          ? `Paiement validé, mais l'échéance suivante n'a pas pu être créée : ${echeance.error}`
          : 'Paiement validé.',
    });
  } catch (err) {
    console.error('[validations/valider]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la validation.' });
  }
});

// ============================================================
// Refuser une déclaration (motif demandé).
// ============================================================
router.post('/:id/refuser', async (req, res) => {
  try {
    const motif = String((req.body || {}).motif || '').trim();
    if (!motif || motif.length > 200) {
      return res.status(400).json({ success: false, message: 'Un motif de refus est requis (200 caractères max).' });
    }

    const { data: paiement } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (paiement.statut !== 'en_validation') {
      const message = paiement.statut === 'paye' ? 'Ce paiement est déjà validé.' : 'Ce paiement ne peut pas être refusé.';
      return res.status(400).json({ success: false, message });
    }

    const { data: updated, error } = await sb()
      .from('paiements')
      .update({
        statut: 'refuse',
        rejection_reason: motif,
      })
      .eq('id', paiement.id)
      .eq('statut', 'en_validation')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    // L'échéance n'est PAS avancée en cas de refus.
    try {
      const { tenantUidOfLocataire } = await import('../utils/notifications.js');
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        await notify(
          tenantUid,
          'paiement',
          `Paiement non validé — votre demande pour ${formatMois(paiement.mois)} (${Number(paiement.montant).toLocaleString('fr-FR')} FCFA) ` +
            `n'a pas été confirmée par votre propriétaire. Motif : ${motif}. Contactez-le pour régulariser.`
        );
      }
    } catch (e) {
      console.warn('[validations/refuser] notification :', e.message);
    }

    res.json({ success: true, data: updated, message: 'Déclaration refusée. Le locataire en a été informé.' });
  } catch (err) {
    console.error('[validations/refuser]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du refus.' });
  }
});

export default router;
export { REJECTION_MOTIFS, nextMois };