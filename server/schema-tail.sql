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
--
-- Catalogue à jour (grille publiée) : 20261006000000_plans_grille_agence.sql.
-- Les plafonds employés / prestataires ne sont PAS posés ici : les
-- colonnes sont créées par 20260927100000_quota_essai.sql (a), qui
-- s'exécute après ce fichier sur une reconstruction. Cette insertion
-- sert de repli (NULL = fail open) si elle seule est rejouée.
-- ------------------------------------------------------------------
INSERT INTO "public"."plans" ("code", "nom", "type", "prix", "devise", "max_immeubles", "max_logements", "max_locataires", "duree_abonnement", "audience", "actif", "description")
VALUES
  ('agence_starter', 'Agence Starter', 'agence', 12000, 'XOF', 10, 400, 400, 1, 'agence', true,
   '10 biens — 400 logements — 400 locataires — 30 employés — 40 prestataires'),
  ('agence_pro', 'Agence Pro', 'agence', 25000, 'XOF', 20, 700, 700, 1, 'agence', true,
   '20 biens — 700 logements — 700 locataires — 70 employés — 90 prestataires'),
  ('agence_business', 'Agence Ultra', 'agence', 60000, 'XOF', 120, 3700, 3700, 1, 'agence', true,
   '120 biens — 3 700 logements — 3 700 locataires — employés et prestataires illimités')
ON CONFLICT ("code") DO UPDATE
  SET "nom" = EXCLUDED."nom",
      "type" = EXCLUDED."type",
      "prix" = EXCLUDED."prix",
      "devise" = EXCLUDED."devise",
      "max_immeubles" = EXCLUDED."max_immeubles",
      "max_logements" = EXCLUDED."max_logements",
      "max_locataires" = EXCLUDED."max_locataires",
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
