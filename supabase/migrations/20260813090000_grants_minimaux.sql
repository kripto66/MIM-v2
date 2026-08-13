-- ============================================================
-- MIM - Privilèges minimaux
--
-- On retire à « anon » l'accès direct aux tables public : le rôle
-- anon n'a besoin que des endpoints GoTrue (auth.*) et n'accède
-- jamais aux tables. L'accès aux données se fait via :
--   * authenticated  -> CRUD filtré par la RLS (authedClient)
--   * service_role   -> bypass RLS (création de comptes, notifications, cron)
-- ============================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- anon : plus aucun privilège sur tables / séquences / fonctions public
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- authenticated : CRUD complet filtré par la RLS (user_id / account_uid)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- service_role : bypass RLS
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
