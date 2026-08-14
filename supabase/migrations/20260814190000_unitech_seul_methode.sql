-- ============================================================
-- MIM - UnitechPay seule méthode de paiement + 3 sources
--
-- 1) unitech_checkouts : le même flux UnitechPay dessert désormais
--    les loyers, les salaires et les abonnements MIM. On rend
--    paiement_id facultatif et on ajoute les liens aux autres
--    sources (migration additive : aucune table supprimée).
-- 2) Les contraintes CHECK de méthode sont resserrées sur
--    'mobile_money' (NOT VALID : les lignes existantes restent
--    valides, seules les nouvelles écritures sont restreintes).
-- ============================================================

-- ------------------------------------------------------------
-- 1) unitech_checkouts multi-source
-- ------------------------------------------------------------
ALTER TABLE public.unitech_checkouts ALTER COLUMN paiement_id DROP NOT NULL;

ALTER TABLE public.unitech_checkouts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'loyer'
    CHECK (source IN ('loyer', 'salaire', 'abonnement'));

ALTER TABLE public.unitech_checkouts ADD COLUMN IF NOT EXISTS paiement_employe_id BIGINT
    REFERENCES public.paiements_employes(id) ON DELETE CASCADE;

ALTER TABLE public.unitech_checkouts ADD COLUMN IF NOT EXISTS abonnement_paiement_id BIGINT
    REFERENCES public.abonnement_paiements(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS unitech_checkouts_source_idx ON public.unitech_checkouts (source);
CREATE INDEX IF NOT EXISTS unitech_checkouts_paiement_employe_idx ON public.unitech_checkouts (paiement_employe_id);
CREATE INDEX IF NOT EXISTS unitech_checkouts_abonnement_idx ON public.unitech_checkouts (abonnement_paiement_id);

-- ------------------------------------------------------------
-- 2) Une seule méthode de paiement : Mobile Money (UnitechPay)
-- ------------------------------------------------------------
ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements
    ADD CONSTRAINT paiements_methode_check
    CHECK (methode_paiement IS NULL OR methode_paiement = 'mobile_money') NOT VALID;

ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes
    ADD CONSTRAINT paiements_employes_methode_check
    CHECK (methode_paiement IS NULL OR methode_paiement = 'mobile_money') NOT VALID;
