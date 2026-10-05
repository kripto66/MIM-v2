-- ============================================================
-- MIM - Grille propriétaire mensuelle : 3 formules
--
--   Standard  3 000 XOF/mois : 1 bien   / 20 logements  / 20 locataires
--                               5 employés (tableau de bord) · 30 prestataires
--   Premium   6 000 XOF/mois : 2 biens  / 75 logements  / 75 locataires
--                               15 employés (tableau de bord) · 60 prestataires
--   Pro       9 000 XOF/mois : 3 biens  / 300 logements / 150 locataires
--                               50 employés (tableau de bord) · prestataires illimités
--
-- « Bien » = l'actif géré, quelle que soit sa nature : hôtel,
-- immeuble, villa, résidence… La colonne s'appelle encore
-- max_immeubles (nom historique) : seul son AFFICHAGE change
-- (pages publique et abonnement disent « bien(s) »).
--
-- Emplois / prestataires sont plafonnés par plan depuis la migration
-- 20260927100000_quota_essai.sql : max_employes / max_prestataires,
-- NULL = illimité (check_quota_for_plan saute le test quand la
-- colonne est NULL). Cette migration aligne les plafonds du
-- catalogue sur la grille publiée.
--
-- Inchangé :
--   * plan « agence » propriétaire (50 000 XOF) : toujours actif en
--     base (les abonnements existants continuent de le resolver),
--     mais retiré de la vitrine des deux pages ;
--   * plan « essai » (0 XOF, 14 jours) : jamais achetable.
--
-- Effet sur les abonnements en cours : les quotas ne sont vérifiés
-- qu'à la CRÉATION (IF v_limit IS NOT NULL AND count + qty >
-- v_limit) — un parc déjà plus grand que le nouveau plafond n'est
-- pas tronqué, il ne peut simplement pas grossir jusqu'au
-- renouvellement d'une formule supérieure.
--
-- Idempotente : UPDATE ciblé par code, réapplicable à l'identique.
-- ============================================================

UPDATE public.plans
SET prix = 3000,
    devise = 'XOF',
    max_immeubles = 1,
    max_logements = 20,
    max_locataires = 20,
    max_employes = 5,
    max_prestataires = 30,
    duree_abonnement = 1,
    description = '1 bien — 20 logements — 20 locataires — 5 employés — 30 prestataires',
    updated_at = now()
WHERE code = 'standard';

UPDATE public.plans
SET prix = 6000,
    devise = 'XOF',
    max_immeubles = 2,
    max_logements = 75,
    max_locataires = 75,
    max_employes = 15,
    max_prestataires = 60,
    duree_abonnement = 1,
    description = '2 biens — 75 logements — 75 locataires — 15 employés — 60 prestataires',
    updated_at = now()
WHERE code = 'premium';

-- Prestataires illimités : NULL = aucune limite (fail open).
UPDATE public.plans
SET prix = 9000,
    devise = 'XOF',
    max_immeubles = 3,
    max_logements = 300,
    max_locataires = 150,
    max_employes = 50,
    max_prestataires = NULL,
    duree_abonnement = 1,
    description = '3 biens — 300 logements — 150 locataires — 50 employés — prestataires illimités',
    updated_at = now()
WHERE code = 'pro';
