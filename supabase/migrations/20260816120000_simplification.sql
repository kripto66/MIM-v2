-- ============================================================
-- MIM - Simplification : photos de profil + affectation des
-- employés à des biens
--
--  * profiles.avatar_url : URL publique de la photo de profil
--    (bucket Supabase Storage « avatars », upload côté serveur).
--  * employes_biens : un employé est affecté à un ou plusieurs
--    biens ; il ne voit que les données (logements, locataires,
--    incidents, interventions) de ses biens.
--  * RLS : lecture réservée à l'employé via sa fiche, écriture
--    réservée au propriétaire (et au service_role via le serveur).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Photo de profil
-- ------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ------------------------------------------------------------
-- 2. Affectation des employés à des biens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employes_biens (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    employe_id BIGINT NOT NULL REFERENCES public.employes(id) ON DELETE CASCADE,
    bien_id BIGINT NOT NULL REFERENCES public.biens(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT employes_biens_unique UNIQUE (employe_id, bien_id)
);

ALTER TABLE public.employes_biens ENABLE ROW LEVEL SECURITY;

-- Propriétaire : gestion complète des affectations de SES employés.
CREATE POLICY "owner_all_employes_biens" ON public.employes_biens
    FOR ALL USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Employé : lecture de ses propres affectations.
CREATE POLICY "employe_select_own_employes_biens" ON public.employes_biens
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.employes e WHERE e.account_uid = auth.uid() AND e.id = employes_biens.employe_id)
    );

-- ------------------------------------------------------------
-- 3. RLS : un employé lit uniquement les données de SES biens
-- ------------------------------------------------------------
CREATE POLICY "employe_select_biens_affectes" ON public.biens
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.employes_biens eb JOIN public.employes e ON e.id = eb.employe_id
                WHERE e.account_uid = auth.uid() AND eb.bien_id = biens.id)
    );

CREATE POLICY "employe_select_logements_affectes" ON public.logements
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.employes_biens eb JOIN public.employes e ON e.id = eb.employe_id
                WHERE e.account_uid = auth.uid() AND eb.bien_id = logements.bien_id)
    );

CREATE POLICY "employe_select_locataires_affectes" ON public.locataires
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.logements lg
                JOIN public.employes_biens eb ON eb.bien_id = lg.bien_id
                JOIN public.employes e ON e.id = eb.employe_id
                WHERE lg.id = locataires.logement_id AND e.account_uid = auth.uid())
    );

CREATE POLICY "employe_select_incidents_affectes" ON public.incidents
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.logements lg
                JOIN public.employes_biens eb ON eb.bien_id = lg.bien_id
                JOIN public.employes e ON e.id = eb.employe_id
                WHERE lg.id = incidents.logement_id AND e.account_uid = auth.uid())
    );

CREATE POLICY "employe_select_interventions_affectes" ON public.interventions
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.logements lg
                JOIN public.employes_biens eb ON eb.bien_id = lg.bien_id
                JOIN public.employes e ON e.id = eb.employe_id
                WHERE lg.id = interventions.logement_id AND e.account_uid = auth.uid())
    );

-- ------------------------------------------------------------
-- 4. Privilèges
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employes_biens TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE employes_biens_id_seq TO authenticated;
GRANT ALL ON public.employes_biens TO service_role;
GRANT ALL ON SEQUENCE employes_biens_id_seq TO service_role;