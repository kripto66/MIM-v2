-- ============================================================
-- MIM - Retour vers les paiements 100 % manuels
-- Suppression de l'intégration UnitechPay (reverse).
--
-- Contexte : MIM n'encaisse plus rien en ligne. UnitechPay est
-- un autre fournisseur de paiement retiré (aucune route active,
-- aucun enregistrement en base). On supprime les tables d'archive.
-- ============================================================

-- Tables déplacées vers le schéma `archive` plutôt que supprimées
-- (audit C1) : les sessions de paiement et le journal des webhooks
-- restent consultables (pg_dump --schema=archive) tout en sortant du
-- schéma public. `IF EXISTS` : no-op si la table n'existe plus.
CREATE SCHEMA IF NOT EXISTS archive;
REVOKE ALL ON SCHEMA archive FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
    t text;
    r record;
BEGIN
    FOREACH t IN ARRAY ARRAY['unitech_checkouts', 'unitech_webhooks'] LOOP
        IF to_regclass('public.' || t) IS NULL THEN
            CONTINUE;
        END IF;
        FOR r IN
            SELECT n.nspname AS schema_name, c.relname AS sequence_name
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_depend d ON d.objid = c.oid
                               AND d.classid = 'pg_class'::regclass
                               AND d.deptype = 'a'
             WHERE d.refobjid = to_regclass('public.' || t)
               AND c.relkind = 'S'
        LOOP
            EXECUTE format('ALTER SEQUENCE %I.%I SET SCHEMA archive', r.schema_name, r.sequence_name);
        END LOOP;
        EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', t);
    END LOOP;
END
$do$;