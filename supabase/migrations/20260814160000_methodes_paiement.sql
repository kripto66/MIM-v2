-- ============================================================
-- MIM - Méthodes de paiement (loyers + salaires employés)
--
-- Ajoute à chaque flux de paiement la méthode utilisée et une
-- référence (n° de transaction, chèque…). Méthodes unifiées :
--   especes | mobile_money | virement | carte
-- Les tables existantes ne sont jamais supprimées ni réécrites :
-- migration strictement additive.
-- ============================================================

ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS methode_paiement TEXT;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS reference TEXT;

ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS methode_paiement TEXT;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS reference TEXT;

-- Contraintes d'intégrité (aucune ligne existante ne viole : NULL autorisé).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiements_methode_check') THEN
        ALTER TABLE public.paiements
            ADD CONSTRAINT paiements_methode_check
            CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiements_employes_methode_check') THEN
        ALTER TABLE public.paiements_employes
            ADD CONSTRAINT paiements_employes_methode_check
            CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte'));
    END IF;
END $$;
