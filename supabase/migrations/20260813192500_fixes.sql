-- ============================================================
-- MIM - Correctifs de sécurité et politiques RLS
-- ============================================================

-- 1. Correction de la politique de sélection pour permettre aux nouveaux comptes locataires
-- de trouver leur fiche locataire à partir du préfixe username de leur email Supabase.
DROP POLICY IF EXISTS "tenant_select_by_email" ON public.locataires;
CREATE POLICY "tenant_select_by_email" ON public.locataires
    FOR SELECT
    USING (
        lower(email) = lower(auth.jwt() ->> 'email')
        OR split_part(lower(auth.jwt() ->> 'email'), '@', 1) = lower(username)
    );

-- 2. Correction de la politique de liaison pour permettre aux locataires de lier
-- leur account_uid en se basant sur le username.
DROP POLICY IF EXISTS "tenant_link_locataire" ON public.locataires;
CREATE POLICY "tenant_link_locataire" ON public.locataires
    FOR UPDATE
    USING (
        (lower(email) = lower(auth.jwt() ->> 'email')
         OR split_part(lower(auth.jwt() ->> 'email'), '@', 1) = lower(username))
        AND account_uid IS NULL
    )
    WITH CHECK (account_uid = auth.uid());
