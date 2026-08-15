-- ============================================================
-- MIM - Système « Déclaration + validation propriétaire »
--
-- Remplace le Mobile Money automatique (loyers/salaires) par un
-- flux classique : le locataire paie directement le propriétaire
-- avec le moyen de paiement indiqué par celui-ci, puis DÉCLARE
-- avoir payé ; le propriétaire vérifie réellement son compte puis
-- VALIDE ou REFUSE la déclaration.
--
-- MIGRATION STRICTEMENT ADDITIVE :
--   * aucune table supprimée, aucune colonne supprimée,
--   * aucune donnée existante modifiée,
--   * contraintes élargies uniquement (valeurs existantes conservées).
--
-- Machine d'état des loyers :
--   attente | retard  -> en_validation  (le locataire déclare)
--   en_validation     -> paye           (le propriétaire valide)
--   en_validation     -> refuse         (le propriétaire refuse)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Colonnes de traçabilité de la déclaration (paiements)
-- ------------------------------------------------------------
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS validation_requested_at TIMESTAMPTZ;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS validated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ------------------------------------------------------------
-- 2. Référentiel des méthodes élargi (loyers + salaires)
--    Anciennes valeurs conservées (especes, mobile_money,
--    virement, carte) + nouvelles (wave, orange_money).
-- ------------------------------------------------------------
ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements
    ADD CONSTRAINT paiements_methode_check
    CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money'));

ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes
    ADD CONSTRAINT paiements_employes_methode_check
    CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money'));

-- ------------------------------------------------------------
-- 3. Moyens de paiement configurés par le propriétaire
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.moyens_paiement (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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

ALTER TABLE public.moyens_paiement ENABLE ROW LEVEL SECURITY;

-- Propriétaire : gestion complète de SES moyens de paiement.
CREATE POLICY "owner_all_moyens_paiement" ON public.moyens_paiement
    FOR ALL USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Locataire : lecture seule des moyens ACTIFS du propriétaire de
-- SON logement (déduit via sa fiche locataire, jamais fourni par
-- le client).
CREATE POLICY "tenant_select_moyens_paiement" ON public.moyens_paiement
    FOR SELECT USING (
        actif = TRUE
        AND EXISTS (
            SELECT 1
            FROM public.locataires l
            JOIN public.logements lg ON lg.id = l.logement_id
            WHERE l.account_uid = auth.uid()
              AND lg.user_id = moyens_paiement.user_id
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moyens_paiement TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE moyens_paiement_id_seq TO authenticated;
GRANT ALL ON public.moyens_paiement TO service_role;
GRANT ALL ON SEQUENCE moyens_paiement_id_seq TO service_role;