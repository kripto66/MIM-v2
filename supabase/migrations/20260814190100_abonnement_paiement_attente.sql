-- ============================================================
-- MIM - UnitechPay : paiement d'abonnement en attente
--
-- Depuis le passage au flux UnitechPay, le paiement d'abonnement
-- est créé en ATTENTE (date_paiement NULL, référence remplie par
-- le webhook vérifié, activation de l'abonnement à la
-- confirmation). date_debut/date_expiration restent calculées
-- côté serveur dès l'initiation. Migration additive.
-- ============================================================

ALTER TABLE public.abonnement_paiements ALTER COLUMN date_paiement DROP NOT NULL;

-- Reserrement du CHECK méthode sur mobile_money uniquement
-- (NOT VALID : les lignes existantes restent valides).
ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;
ALTER TABLE public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_methode_check
    CHECK (methode_paiement IS NULL OR methode_paiement = 'mobile_money') NOT VALID;
