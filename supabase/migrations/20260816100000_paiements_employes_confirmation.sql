-- ============================================================
-- MIM - Paiements de salaire : confirmation par l'employé
--
-- Flux (différent du loyer, volontairement inversé) :
--   Propriétaire -> « Paiement versé » (statut « attente »)
--   Employé      -> « Confirmer la réception » (statut « paye »)
--   Employé      -> « Je n'ai pas reçu » (statut « non_recu »)
--
-- Le propriétaire n'affirme JAMAIS seul la réception : le statut
-- reste « attente » tant que l'employé n'a pas confirmé.
--
-- MIGRATION STRICTEMENT ADDITIVE :
--   * aucune table supprimée, aucune colonne supprimée,
--   * valeurs existantes conservées (paye = confirmé, attente =
--     en attente de confirmation),
--   * contraintes élargies uniquement.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Moyens de paiement de l'EMPLOYÉ (configurés par lui-même)
--    Table séparée de moyens_paiement (moyens du propriétaire) :
--    les RLS de moyens_paiement servent au flux locataire et ne
--    doivent pas mélanger les deux univers.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.moyens_paiement_employes (
    id BIGSERIAL PRIMARY KEY,
    employe_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('wave', 'orange_money', 'virement', 'especes')),
    nom_titulaire TEXT,
    numero TEXT,
    lien_paiement TEXT,
    banque TEXT,
    num_compte TEXT,
    iban TEXT,
    bic TEXT,
    instructions TEXT,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moyens_paiement_employes_uid
    ON public.moyens_paiement_employes (employe_uid);

ALTER TABLE public.moyens_paiement_employes ENABLE ROW LEVEL SECURITY;

-- L'employé gère SES moyens de paiement.
CREATE POLICY "employe_all_own_moyens" ON public.moyens_paiement_employes
    FOR ALL USING (employe_uid = auth.uid())
    WITH CHECK (employe_uid = auth.uid());

-- Le propriétaire consulte les moyens de SES employés (via la fiche).
CREATE POLICY "owner_select_employe_moyens" ON public.moyens_paiement_employes
    FOR SELECT USING (
        EXISTS (
            SELECT 1
            FROM public.employes e
            WHERE e.account_uid = moyens_paiement_employes.employe_uid
              AND e.user_id = auth.uid()
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moyens_paiement_employes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE moyens_paiement_employes_id_seq TO authenticated;
GRANT ALL ON public.moyens_paiement_employes TO service_role;
GRANT ALL ON SEQUENCE moyens_paiement_employes_id_seq TO service_role;

-- ------------------------------------------------------------
-- 2. Paiements de salaire : traçabilité de la confirmation
-- ------------------------------------------------------------
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS moyen_employe_id BIGINT
    REFERENCES public.moyens_paiement_employes(id) ON DELETE SET NULL;

-- Statuts élargis : paye (confirmé), attente (déclaré, à confirmer),
-- non_recu (l'employé affirme ne pas avoir reçu).
ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_statut_check;
ALTER TABLE public.paiements_employes
    ADD CONSTRAINT paiements_employes_statut_check
    CHECK (statut IN ('paye', 'attente', 'non_recu'));

-- L'employé ne confirme que SES paiements (statut et colonnes
-- vérifiés côté backend ; la RLS borne l'ensemble de ses lignes).
CREATE POLICY "employe_update_own_paiements" ON public.paiements_employes
    FOR UPDATE USING (employe_uid = auth.uid());