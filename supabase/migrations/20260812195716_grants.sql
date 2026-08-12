-- ============================================================
-- MIM - Privilèges des rôles API
-- Supabase local n'expose plus les entités public par défaut.
-- On restaure les privilèges équivalents au projet Cloud :
-- les rôles API (anon/authenticated/service_role) accèdent aux
-- tables, séquences et fonctions public ; la RLS filtre les lignes.
-- ============================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
