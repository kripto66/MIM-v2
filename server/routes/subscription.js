// ============================================================
// MIM - Abonnement du propriétaire (lecture par le propriétaire)
// ============================================================

import { Router } from 'express';
import { subscriptionOf } from '../utils/subscription.js';

const router = Router();

// L'état est calculé côté serveur (date_expiration), jamais fourni par
// le client. Cette route est volontairement accessible aux comptes dont
// l'abonnement est expiré (pas de requireActive) pour afficher le
// message « abonnement expiré » ; elle reste réservée aux propriétaires.
router.get('/me', async (req, res) => {
  try {
    const subscription = await subscriptionOf(req.user.id);

    if (subscription.statut === 'aucun') {
      return res.json({
        success: true,
        subscription: null,
        message: 'Aucun abonnement enregistré.',
      });
    }

    res.json({ success: true, subscription });
  } catch (err) {
    console.error('[subscription/me]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement de l\'abonnement.' });
  }
});

export default router;
