// ============================================================
// MIM - Abonnement du propriétaire : lecture, catalogue, paiement
// en ligne Bictorys, historique.
//
// Ces routes sont volontairement accessibles aux comptes dont
// l'abonnement est expiré (pas de requireActive au montage) pour
// permettre le renouvellement en ligne. Un compte banni ou un
// locataire/employé dépendant d'un propriétaire suspendu reste
// refusé (401 ACCOUNT_SUSPENDED) — seules les expirations
// d'abonnement sont tolérées ici.
// ============================================================

import { Router } from 'express';
import { subscriptionOf, createCheckout, reconcilePendingPayment } from '../utils/subscription.js';
import { listPlans, planView, audienceForAccount } from '../utils/plans.js';
import { serviceClient } from '../app.js';

const router = Router();

// Les comptes BANNIS ou dépendant d'un propriétaire suspendu n'accèdent
// PAS à l'auto-service : seule l'expiration d'abonnement est tolérée.
function allowForSelfService(req, res, next) {
  const reasons = req.user?.suspendedReasons || [];
  if (reasons.includes('banned') || reasons.includes('owner_suspended')) {
    return res.status(401).json({
      success: false,
      code: 'ACCOUNT_SUSPENDED',
      message: 'Votre compte a été suspendu.',
    });
  }
  next();
}

router.use(allowForSelfService);

router.get('/me', async (req, res) => {
  try {
    const subscription = await subscriptionOf(req.user.id);

    if (subscription === null) {
      return res.json({
        success: true,
        subscription: null,
        message: 'Aucun abonnement enregistré.',
      });
    }

    res.json({ success: true, subscription });
  } catch (err) {
    console.error('[subscription/me]', err.message);
    res.status(500).json({ success: false, message: "Erreur lors du chargement de l'abonnement." });
  }
});

// Catalogue : chaque compte ne voit que les plans de son audience.
router.get('/plans', async (req, res) => {
  try {
    const plans = await listPlans(true, audienceForAccount(req.user.account_type));
    res.json({ success: true, plans: plans.map(planView) });
  } catch (err) {
    console.error('[subscription/plans]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des plans.' });
  }
});

// Lancement d'un paiement en ligne Bictorys pour le plan choisi.
// N'active RIEN : l'activation arrive uniquement par webhook.
router.post('/checkout', async (req, res) => {
  const { plan } = req.body || {};
  if (!plan) {
    return res.status(400).json({ success: false, message: 'Plan requis.', errors: { plan: 'Choisissez un plan.' } });
  }

  try {
    const result = await createCheckout(req.user.id, plan, req.get('Idempotency-Key'), req.user.account_type);
    return res.status(201).json({ success: true, message: 'Paiement lancé. Finalisez le règlement sur la page Bictorys.', ...result });
  } catch (err) {
    const status = err.code === 'PLAN_INVALID' || err.code === 'PLAN_UNAVAILABLE' ? 400 : err.code === 'PAYMENT_UNAVAILABLE' ? 503 : 502;
    return res.status(status).json({ success: false, code: err.code, message: err.message });
  }
});

// Fallback polling : si le webhook n'est pas arrivé, interroge Bictorys
// pour actualiser le paiement en attente du propriétaire.
router.post('/checkout/refresh', async (req, res) => {
  try {
    const result = await reconcilePendingPayment(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[subscription/checkout/refresh]', err.message);
    res.status(502).json({ success: false, message: err.message || 'Impossible de vérifier le paiement.' });
  }
});

// Historique des paiements d'abonnement du propriétaire (toutes méthodes).
router.get('/payments', async (req, res) => {
  try {
    const { data, error } = await serviceClient()
      .from('abonnement_paiements')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    res.json({
      success: true,
      payments: (data || []).map((p) => ({
        id: p.id,
        plan: p.plan,
        montant: Number(p.montant),
        devise: p.devise || 'XOF',
        statut: p.statut,
        provider: p.provider || 'manuel',
        methode_paiement: p.methode_paiement || null,
        reference: p.reference || null,
        transactionId: p.transaction_id || null,
        date_paiement: p.date_paiement || null,
        date_debut: p.date_debut || null,
        date_expiration: p.date_expiration || null,
        created_at: p.created_at || null,
      })),
    });
  } catch (err) {
    console.error('[subscription/payments]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
  }
});

export default router;