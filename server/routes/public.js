// ============================================================
// MIM - Routes PUBLIQUES (sans authentification)
//
// Servent les pages marketing de PartPublic. Le catalogue
// d'abonnement est lu EN BASE à chaque appel pour que la page
// publique ne puisse plus dériver des prix réels.
//
// Constat à l'origine de cette route : la page d'accueil affichait
//   Standard 3 000 · Premium 4 500 · Pro 6 000 · Ultra 10 000
// alors que la base contient
//   Standard 3 000 · Premium 15 000 · Pro 30 000 · Agence 50 000
// + les plans d'agence (15 000 / 25 000 / 40 000), et que le plan
// « Ultra » est ARCHIVÉ (actif = false). Des prix écrits en dur
// dans le HTML finissent toujours par se périmier.
//
// Sécurité :
//   * planView ne renvoie que le catalogue (aucun utilisateur,
//     aucune donnée de compte) ;
//   * monté APRÈS csrfOriginGuard — les GET sont des SAFE_METHODS
//     et passent, mais un POST rejeté reste rejeté ;
//   * couvert par globalIpRateLimit (monté avant sur /api).
// ============================================================

import { Router } from 'express';
import { listPlans, planView } from '../utils/plans.js';

const router = Router();

// Catalogue actif, TOUTES audiences : la page publique présente les
// grilles propriétaire et agence côte à côte, donc audience = null
// (listPlans ne filtre que si audience est fournie et reconnue).
router.get('/plans', async (req, res) => {
  try {
    const plans = await listPlans(true, null);
    res.json({ success: true, plans: plans.map(planView) });
  } catch (err) {
    // Jamais de détail technique au client : la page a un repli statique.
    console.error('[public/plans]', err.message);
    res.status(500).json({ success: false, code: 'PLANS_UNAVAILABLE', message: 'Catalogue indisponible.' });
  }
});

export default router;
