-- ============================================================
-- MIM - Flux « Confirmer mon paiement » (validation propriétaire)
--
-- Extension de la machine d'état des loyers (aucune donnée supprimée) :
--   attente -> a_confirmer    (webhook UnitechPay reçu : paiement
--                               techniquement confirmé)
--   a_confirmer -> en_validation  (le locataire confirme son paiement)
--   a_confirmer | en_validation -> paye    (le propriétaire valide)
--   a_confirmer | en_validation -> refuse  (le propriétaire refuse)
--
-- La contrainte CHECK est étendue pour admettre les nouveaux statuts ;
-- les lignes existantes restent inchangées.
-- ============================================================

ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_statut_check;
ALTER TABLE public.paiements
    ADD CONSTRAINT paiements_statut_check
    CHECK (statut IN ('attente', 'paye', 'retard', 'a_confirmer', 'en_validation', 'refuse'));
