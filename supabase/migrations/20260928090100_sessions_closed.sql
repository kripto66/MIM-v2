-- ============================================================
-- MIM - Suite de l'audit (F3) : `sessions` se ferme explicitement
--
-- La politique `owner_all_sessions` a été supprimée par
-- 20260928090000_audit_followup.sql (F3) : elle ne pouvait jamais
-- s'appliquer, la table n'étant GRANTée qu'à service_role.
--
-- 1. On pose la même politique d'interdiction explicite que sur les
--    7 tables fermées (F6) : le comportement « deny-all » devient
--    intentionnel et lisible, au lieu d'être l'absence de politique.
-- 2. Le commentaire de la colonne user_id, qui invoquait
--    `owner_all_sessions` comme protection, est corrigé.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
         WHERE polrelid = 'public.sessions'::regclass
    ) THEN
        EXECUTE 'CREATE POLICY closed_deny_all ON public.sessions '
                || 'FOR ALL USING (false) WITH CHECK (false)';
    END IF;
END
$$;

COMMENT ON COLUMN public.sessions.user_id IS
    'Rétention : NULL lorsque le compte a été supprimé (ON DELETE SET NULL, migration audit_corrections 20260927). L''historique de session survit au compte. Table fermée côté client : aucun GRANT hors service_role, qui contourne la RLS, et politique closed_deny_all (USING false) pour tout autre rôle.';

COMMENT ON POLICY closed_deny_all ON public.sessions IS
    'Fermeture explicite (audit F3/F6) : seuls les rôles BYPASSRLS (service_role) lisent les sessions.';
