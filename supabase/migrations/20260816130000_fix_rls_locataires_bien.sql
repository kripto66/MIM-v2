-- ============================================================
-- MIM - Correction RLS : cycle de récursion sur « logements »
--
-- Cause : la politique employé « employe_select_locataires_affectes »
-- lisait la table logements, or la politique locataire
-- « tenant_select_logement » lit déjà la table locataires :
-- les deux politiques se référencent mutuellement → infinite
-- recursion (Postgres interdit les politiques cycliques).
--
-- Solution : dénormaliser locataires.bien_id (rempli par le
-- backend à la création/liaison) et exprimer la politique employé
-- sur locataires uniquement via employes_biens + bien_id.
-- ============================================================

-- 1. Colonne dénormalisée sur la fiche locataire.
ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS bien_id BIGINT REFERENCES public.biens(id) ON DELETE SET NULL;

-- 2. Backfill des fiches existantes depuis leur logement.
UPDATE public.locataires l
SET bien_id = lg.bien_id
FROM public.logements lg
WHERE lg.id = l.logement_id
  AND l.bien_id IS NULL;

-- 3. Remplacement de la politique fautive (la version qui lisait logements).
DROP POLICY IF EXISTS "employe_select_locataires_affectes" ON public.locataires;

CREATE POLICY "employe_select_locataires_affectes" ON public.locataires
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.employes_biens eb JOIN public.employes e ON e.id = eb.employe_id
                WHERE e.account_uid = auth.uid() AND eb.bien_id = locataires.bien_id)
    );