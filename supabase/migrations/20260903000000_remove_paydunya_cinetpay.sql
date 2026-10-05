-- ============================================================
-- MIM - Retour vers les paiements 100 % manuels
-- Suppression de l'intégration PayDunya et CinetPay (reverse).
--
-- Contexte : MIM n'encaisse plus rien en ligne. Le locataire /
-- l'employé / le propriétaire paie DIRECTEMENT au destinataire avec
-- les moyens configurés (wave, orange_money, virement, especes...)
-- puis déclare ; le destinataire valide.
--
-- Cette migration :
--   1) supprime les tables de données des fournisseurs (archives) ;
--   2) retire les colonnes ajoutées par PayDunya aux moyens ;
--   3) ramène les CHECK de méthode aux seules méthodes manuelles,
--      en remappant d'abord les rares lignes legacy paydunya/cinetpay.
-- ============================================================

-- 1) Tables fournisseurs : DÉPLACÉES vers le schéma `archive`, jamais
--    supprimées (audit C1) : factures, encaissements et déboursements
--    sont des données comptables. `archive` n'est pas exposé par
--    PostgREST (voir db-schemas de supabase/config.toml), donc il
--    n'apparaît ni dans l'API ni dans le schéma public. Export
--    possible à tout moment : pg_dump --schema=archive.
--    `IF EXISTS` : sur une base déjà passée par l'ancienne version de
--    cette migration (DROP TABLE), la boucle ne fait rien.
CREATE SCHEMA IF NOT EXISTS archive;
REVOKE ALL ON SCHEMA archive FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
    t text;
    r record;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'paydunya_invoices', 'paydunya_webhooks', 'paydunya_redistributions',
        'cinetpay_payments', 'cinetpay_webhooks', 'cinetpay_payouts'
    ] LOOP
        IF to_regclass('public.' || t) IS NULL THEN
            CONTINUE;
        END IF;
        -- D'abord déplacer la table : ses sequences owned la suivent
        -- automatiquement. Placer les ALTER SEQUENCE AVANT ce déplacement
        -- echouait ("cannot move an owned sequence into another schema").
        EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', t);
        -- Puis déplacer tout séquence propriétaire resté hors de `archive`
        -- (cas où Postgres ne les aurait pas suivies automatiquement).
        FOR r IN
            SELECT n.nspname AS schema_name, c.relname AS sequence_name
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_depend d ON d.objid = c.oid
                               AND d.classid = 'pg_class'::regclass
                               AND d.deptype = 'a'
             WHERE d.refobjid = to_regclass('archive.' || t)
               AND c.relkind = 'S'
               AND n.nspname <> 'archive'
        LOOP
            EXECUTE format('ALTER SEQUENCE %I.%I SET SCHEMA archive', r.schema_name, r.sequence_name);
        END LOOP;
    END LOOP;
END
$do$;

-- 2) Colonnes PayDunya sur les moyens de paiement.
ALTER TABLE public.moyens_paiement         DROP COLUMN IF EXISTS paydunya_alias;
ALTER TABLE public.moyens_paiement         DROP COLUMN IF EXISTS pour_versement;
ALTER TABLE public.moyens_paiement_employes DROP COLUMN IF EXISTS paydunya_alias;
ALTER TABLE public.moyens_paiement_employes DROP COLUMN IF EXISTS pour_versement;

-- 3) Remap des lignes legacy (aucune dépendance métier dessus) puis
--    réduction des CHECK aux méthodes manuelles.
UPDATE public.paiements          SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');
UPDATE public.paiements_employes SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');
UPDATE public.abonnement_paiements SET methode_paiement = 'especes' WHERE methode_paiement IN ('paydunya', 'cinetpay');

ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);

ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);

ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;
ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
);
