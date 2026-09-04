-- ============================================================
-- MIM - Retour vers les paiements 100 % manuels
-- Suppression de l'intégration PayDunya et CinetPay (reverse).
--
-- Contexte : MIM n'encaisse plus rien en ligne. Le locataire /
-- l'employé / le propriétaire paie DIRECTEMENT au destinataire avec
-- les moyens configurés (wave, orange_money, virement, especes...)
-- puis déclare ; le destinataire valide.
--
-- Cette migration :
--   1) supprime les tables de données des fournisseurs (archives) ;
--   2) retire les colonnes ajoutées par PayDunya aux moyens ;
--   3) ramène les CHECK de méthode aux seules méthodes manuelles,
--      en remappant d'abord les rares lignes legacy paydunya/cinetpay.
-- ============================================================

-- 1) Tables fournisseurs (avec leurs indexes/policies/sequences).
DROP TABLE IF EXISTS public.paydunya_invoices CASCADE;
DROP TABLE IF EXISTS public.paydunya_webhooks CASCADE;
DROP TABLE IF EXISTS public.paydunya_redistributions CASCADE;
DROP TABLE IF EXISTS public.cinetpay_payments CASCADE;
DROP TABLE IF EXISTS public.cinetpay_webhooks CASCADE;
DROP TABLE IF EXISTS public.cinetpay_payouts CASCADE;

-- 2) Colonnes PayDunya sur les moyens de paiement.
ALTER TABLE public.moyens_paiement         DROP COLUMN IF EXISTS paydunya_alias;
ALTER TABLE public.moyens_paiement         DROP COLUMN IF EXISTS pour_versement;
ALTER TABLE public.moyens_paiement_employes DROP COLUMN IF EXISTS paydunya_alias;
ALTER TABLE public.moyens_paiement_employes DROP COLUMN IF EXISTS pour_versement;

-- 3) Remap des lignes legacy (aucune dépendance métier dessus) puis
--    réduction des CHECK aux méthodes manuelles.
UPDATE public.paiements          SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');
UPDATE public.paiements_employes SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');
UPDATE public.abonnement_paiements SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');

ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);

ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);

ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;
ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);
