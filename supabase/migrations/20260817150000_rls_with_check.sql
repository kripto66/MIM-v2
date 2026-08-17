-- ============================================================
-- MIM - RLS : WITH CHECK explicites + colonnes protégées
-- (audit M7 / P1-6) et GRANT explicite des séquences UnitechPay
-- (audit m14).
--
-- 1. Chaque politique FOR ALL / FOR UPDATE reçoit un WITH CHECK
--    explicite. Sans WITH CHECK, PostgreSQL réutilise l'expression
--    USING, mais l'explicite fige la règle : un utilisateur ne peut
--    jamais créer/modifier une ligne dont le propriétaire
--    (user_id / employe_uid / id) n'est pas lui-même — y compris
--    si USING évolue plus tard.
-- 2. REVOKE UPDATE au niveau colonne (rôle authenticated) sur les
--    colonnes sensibles que l'application ne modifie JAMAIS avec
--    le token utilisateur (toutes les écritures métier passent par
--    service_role : auth.js, employe.js, validations.js,
--    moyensPaiement.js, locataire.js, upload.js). Un compte connecté
--    ne peut donc plus altérer account_type / role / email /
--    username / montant de salaire / user_id, etc., via l'API
--    PostgREST directe.
--    NOTA : locataires.account_uid reste modifiable par
--    authenticated (politique "tenant_link_locataire" : liaison
--    légitime du compte à sa fiche, bornée par son WITH CHECK).
-- 3. GRANT USAGE/SELECT explicites sur les séquences UnitechPay
--    (portabilité cloud ; fonctionne en local par privilèges par
--    défaut).
-- ============================================================

-- ---------- 1. WITH CHECK explicites ----------

ALTER POLICY "users_can_update_own" ON public.profiles
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

ALTER POLICY "owner_all_biens" ON public.biens
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_logements" ON public.logements
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_locataires" ON public.locataires
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_paiements" ON public.paiements
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_incidents" ON public.incidents
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_prestataires" ON public.prestataires
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_interventions" ON public.interventions
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_notifications" ON public.notifications
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_sessions" ON public.sessions
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_employes" ON public.employes
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_tasks" ON public.tasks
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_paiements_employes" ON public.paiements_employes
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "owner_all_unitech_checkouts" ON public.unitech_checkouts
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER POLICY "employe_update_own_paiements" ON public.paiements_employes
    USING (employe_uid = auth.uid())
    WITH CHECK (employe_uid = auth.uid());

-- 2. Les colonnes sensibles sont protégées dans la migration
--    20260817160000_rls_column_privileges.sql : les grants étant au
--    niveau TABLE (GRANT UPDATE ON ALL TABLES… TO authenticated,
--    20260813090000), on y révoque le UPDATE de table et on le
--    regrante colonne par colonne (liste blanche).

-- ---------- 3. Séquences UnitechPay (portabilité cloud) ----------

GRANT USAGE, SELECT ON SEQUENCE public.unitech_checkouts_id_seq, public.unitech_webhooks_id_seq
    TO anon, authenticated, service_role;