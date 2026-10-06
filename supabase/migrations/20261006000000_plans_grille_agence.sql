-- ============================================================
-- MIM - Grille agence : 3 formules mensuelles
--
--   Starter  12 000 XOF/mois : 10 biens  / 400 logements  / 400 locataires
--                              30 employés (tableau de bord) · 40 prestataires
--   Pro      25 000 XOF/mois : 20 biens  / 700 logements  / 700 locataires
--                              70 employés (tableau de bord) · 90 prestataires
--   Ultra    60 000 XOF/mois : 120 biens / 3 700 logements / 3 700 locataires
--                              employés et prestataires illimités
--
-- « Bien » = l'actif géré, quelle que soit sa nature : la colonne
-- s'appelle max_immeubles (nom historique), seul son AFFICHAGE
-- change — « bien(s) » sur la page publique et sur l'abonnement.
--
-- Renommage : le 3e palier s'affiche « Agence Ultra ». Le CODE
-- reste 'agence_business' : le changer casserait les abonnements
-- en cours et les factures déjà émises (subscriptions.plan est
-- indexé par code), sans aucun gain fonctionnel. PLAN_CODES
-- (server/utils/plans.js:78) est donc inchangé.
--
-- NULL = illimité (check_quota_for_plan saute le test, fail open
-- sur ces deux seules ressources) : c'est le cas d'Ultra pour les
-- employés ET les prestataires.
--
-- Inchangé :
--   * plan « essai » (0 XOF, 14 jours) : il reste l'essai
--     automatique accordé à l'INSCRIPTION (20260927100000_
--     quota_essai.sql (c)), y compris pour un compte agence
--     (account_type 'agence' y est éligible) — c'est cet essai
--     que les boutons « Essai gratuit pendant 14 jours » vendent,
--     pas une formule du catalogue ;
--   * plan « agence » propriétaire (50 000 XOF) : toujours hors
--     des deux grilles publiées.
--
-- Effet sur les abonnements en cours : les quotas ne sont
-- vérifiés qu'à la CRÉATION (IF v_limit IS NOT NULL AND count +
-- qty > v_limit) — un parc déjà plus grand que le nouveau
-- plafond n'est pas tronqué, il ne peut simplement pas grossir
-- jusqu'au renouvellement d'une formule supérieure.
--
-- Idempotente : UPDATE ciblé par code, réapplicable à l'identique.
-- ============================================================

UPDATE public.plans
SET prix = 12000,
    devise = 'XOF',
    max_immeubles = 10,
    max_logements = 400,
    max_locataires = 400,
    max_employes = 30,
    max_prestataires = 40,
    duree_abonnement = 1,
    description = '10 biens — 400 logements — 400 locataires — 30 employés — 40 prestataires',
    updated_at = now()
WHERE code = 'agence_starter';

UPDATE public.plans
SET prix = 25000,
    devise = 'XOF',
    max_immeubles = 20,
    max_logements = 700,
    max_locataires = 700,
    max_employes = 70,
    max_prestataires = 90,
    duree_abonnement = 1,
    description = '20 biens — 700 logements — 700 locataires — 70 employés — 90 prestataires',
    updated_at = now()
WHERE code = 'agence_pro';

-- Prestataires ET employés illimités : NULL = aucune limite.
UPDATE public.plans
SET nom = 'Agence Ultra',
    prix = 60000,
    devise = 'XOF',
    max_immeubles = 120,
    max_logements = 3700,
    max_locataires = 3700,
    max_employes = NULL,
    max_prestataires = NULL,
    duree_abonnement = 1,
    description = '120 biens — 3 700 logements — 3 700 locataires — employés et prestataires illimités',
    updated_at = now()
WHERE code = 'agence_business';