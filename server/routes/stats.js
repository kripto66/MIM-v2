import { Router } from 'express';
import { authedClient } from '../app.js';

const router = Router();

router.get('/dashboard', async (req, res) => {
  const userId = req.user.id;
  const sb = authedClient(req.user.supabase_token);

  try {
    const [{ data: logements }, { data: locataires }, { data: paiements }, { data: incidents }, { data: interventions }] =
      await Promise.all([
        sb.from('logements').select('id, statut, loyer_mensuel').eq('user_id', userId),
        sb.from('locataires').select('id').eq('user_id', userId),
        sb.from('paiements').select('id, montant, statut, mois').eq('user_id', userId),
        sb.from('incidents').select('id, statut').eq('user_id', userId),
        sb.from('interventions').select('id, statut').eq('user_id', userId),
      ]);

    const totalProperties = logements?.length ?? 0;
    const occupied = logements?.filter((l) => l.statut === 'occupe').length ?? 0;
    const available = logements?.filter((l) => l.statut === 'libre').length ?? 0;

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPayments = paiements?.filter((p) => p.mois === thisMonth) ?? [];

    // Loyer attendu = somme des loyers des logements occupés, pas la somme des
    // paiements déjà saisis (sinon le mois est affiché à 0 tant qu'aucun
    // paiement n'a été enregistré).
    const expectedRent = (logements ?? [])
      .filter((l) => l.statut === 'occupe')
      .reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0);

    const paidRent = monthPayments.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);
    const lateRent = monthPayments.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0);

    res.json({
      success: true,
      stats: {
        totalProperties,
        occupiedProperties: occupied,
        availableProperties: available,
        totalTenants: locataires?.length ?? 0,
        expectedRent,
        paidRent,
        lateRent,
        activeIncidents: incidents?.filter((i) => i.statut !== 'resolu').length ?? 0,
        activeInterventions: interventions?.filter((i) => i.statut !== 'termine').length ?? 0,
      },
    });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des statistiques.' });
  }
});

export default router;
