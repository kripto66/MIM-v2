-- ===================================================================
-- MIM - Sections ajoutées APRÈS le sortie `pg_dump --schema-only`
--       de `server/supabase-schema.sql` par dump-schema.mjs.
--
-- Elles sont absentes du dump car elles n'appartiennent pas au schéma
-- `public` (déclencheurs sur auth.users) ou sont des données de
-- référence qui ne sortent pas en schema-only (catalogue plans).
-- Ne pas les supprimer de `supabase-schema.sql` : elles font partie du
-- contrat de reconstruction (audit H1 / M7).
-- ===================================================================


-- ------------------------------------------------------------------
-- Déclencheurs posés sur auth.users par les migrations
-- (20260924000000_security_integrity_hardening.sql et
--  20260925000000_security_blockers.sql) : le dump ne couvre que le
-- schéma public, sans eux la table profiles n'est jamais créée à
-- l'inscription et guard_public_auth_metadata disparaît (élévation de
-- privilège jusqu'à ultra_admin, audit H1).
-- ------------------------------------------------------------------
CREATE OR REPLACE TRIGGER "mim_guard_public_auth_metadata" BEFORE INSERT OR UPDATE OF "raw_user_meta_data" ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."guard_public_auth_metadata"();

CREATE OR REPLACE TRIGGER "mim_sync_profile_role" AFTER UPDATE OF "raw_app_meta_data" ON "auth"."users" FOR EACH ROW WHEN ((OLD."raw_app_meta_data" IS DISTINCT FROM NEW."raw_app_meta_data")) EXECUTE FUNCTION "public"."sync_profile_account_type"();

CREATE OR REPLACE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();


-- ------------------------------------------------------------------
-- Données de référence absentes du dump schema-only : catalogue
-- d'abonnements « audience = agence », créé par
-- 20260926000000_plan_audience.sql:35-50 (même syntaxe idempotente).
-- ------------------------------------------------------------------
INSERT INTO "public"."plans" ("code", "nom", "type", "prix", "devise", "max_immeubles", "max_logements", "max_locataires", "duree_abonnement", "audience", "actif", "description")
VALUES
  ('agence_starter', 'Agence Starter', 'agence', 15000, 'XOF', 10, 100, 100, 1, 'agence', true,
   'Pour une agence qui démarre : 10 biens, 100 logements et 100 locataires gérés.'),
  ('agence_pro', 'Agence Pro', 'agence', 25000, 'XOF', 30, 300, 300, 1, 'agence', true,
   'Pour une agence en croissance : 30 biens, 300 logements et 300 locataires gérés.'),
  ('agence_business', 'Agence Business', 'agence', 40000, 'XOF', 80, 800, 800, 1, 'agence', true,
   'Pour une agence structurée : 80 biens, 800 logements et 800 locataires gérés.')
ON CONFLICT ("code") DO UPDATE
  SET "nom" = EXCLUDED."nom",
      "type" = EXCLUDED."type",
      "prix" = EXCLUDED."prix",
      "devise" = EXCLUDED."devise",
      "audience" = EXCLUDED."audience",
      "duree_abonnement" = EXCLUDED."duree_abonnement",
      "description" = EXCLUDED."description";


-- ------------------------------------------------------------------
-- Audit M9 : révocations de privilèges PAR DÉFAUT.
--
-- 20260925000000_security_blockers.sql:181-183 pose ces trois
-- révocations, mais `pg_dump --schema=public` ne les émet JAMAIS : il
-- photographie l'état final des ACL (les GRANT restants), pas
-- l'historique des commandes exécutées. Le schéma de référence ne les
-- contenait donc pas.
--
-- Conséquence sur une reconstruction (run-schema.mjs, restore) : les
-- privilèges par défaut livrés par Supabase restaient en place, toute
-- table CRÉÉE après la restauration recevait ALL pour anon et
-- authenticated — la RLS devenait seule garde, la défense en
-- profondeur disparaissait (audit M9).
--
-- Repris à l'identique de la migration (même portée, rôle courant)
-- pour que supabase-schema.sql soit auto-suffisant.
-- ------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon,authenticated;

-- Même révocation pour le rôle supabase_admin : le corps du dump émet
-- ses propres `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ...
-- GRANT ALL ... TO anon, authenticated` (ACL relevées dans la base
-- source) — sans ces lignes, la restauration RECRÉE le privilège
-- qu'elle s'apprête à retirer. Exécuté sous un rôle qui n'est pas
-- membre de supabase_admin, l'instruction est refusée : on la saute
-- explicitement plutôt que de faire échouer toute la poussée.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
       AND pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
        ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
        ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon,authenticated;
        ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon,authenticated;
    END IF;
END $$;
