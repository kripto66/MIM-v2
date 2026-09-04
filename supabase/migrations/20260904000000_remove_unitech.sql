-- ============================================================
-- MIM - Retour vers les paiements 100 % manuels
-- Suppression de l'intégration UnitechPay (reverse).
--
-- Contexte : MIM n'encaisse plus rien en ligne. UnitechPay est
-- un autre fournisseur de paiement retiré (aucune route active,
-- aucun enregistrement en base). On supprime les tables d'archive.
-- ============================================================

DROP TABLE IF EXISTS public.unitech_checkouts CASCADE;
DROP TABLE IF EXISTS public.unitech_webhooks CASCADE;