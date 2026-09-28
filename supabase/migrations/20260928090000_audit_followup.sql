-- ============================================================
-- MIM - Suite de l'audit : RAPPORT-AUDIT-BDD.md (F1, F3, F4, F5,
--       F6, F7, F9, M5)
--
-- Vérifications préalables faites sur la base locale :
--   * `postgres` et `service_role` possèdent BYPASSRLS : un INSERT
--     sous FORCE ROW LEVEL SECURITY avec une politique deny-all
--     réussit pour ces rôles. FORCE ne change donc rien pour eux, il
--     ne s'applique qu'à un éventuel propriétaire sans BYPASSRLS.
--   * Aucune clé étrangère ne référence public.profiles : la contrainte
--     UNIQUE (email) peut être remplacée sans risque.
--   * Aucun `ON CONFLICT (email)` dans le code : le remplacement par un
--     index partiel est sans effet sur les requêtes.
-- ============================================================


-- ------------------------------------------------------------------
-- F1 — Contraintes CHECK strictement dupliquées sur `plans` :
--      plans_max_locataires_ck et plans_max_logements_ck expriment
--      exactement la même règle que leurs homologues *_positive.
--      On conserve les *_positive (présentes aussi côté migrations).
-- ------------------------------------------------------------------
ALTER TABLE public.plans DROP CONSTRAINT IF EXISTS plans_max_locataires_ck;
ALTER TABLE public.plans DROP CONSTRAINT IF EXISTS plans_max_logements_ck;


-- ------------------------------------------------------------------
-- F3 — Politique morte sur `sessions` : la table n'est GRANTée qu'à
--      service_role (qui contourne la RLS) : `owner_all_sessions` ne
--      peut jamais s'appliquer et suggère à tort un accès "propre".
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS owner_all_sessions ON public.sessions;


-- ------------------------------------------------------------------
-- F4 — Politiques sans clause de rôle (elles s'appliquaient donc aussi
--      à `anon`) : recréées avec `TO authenticated`.
--      PostgreSQL ne permet pas de modifier les rôles d'une politique :
--      on lit la définition courante (pg_policies), on DROP, on
--      CREATE à l'identique avec la clause de rôle.
-- ------------------------------------------------------------------
DO $f4$
DECLARE
    r  record;
    ddl text;
BEGIN
    FOR r IN
        SELECT policyname, tablename, permissive, cmd, qual, with_check
          FROM pg_policies
         WHERE schemaname = 'public'
           AND roles = '{public}'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);

        ddl := format('CREATE POLICY %I ON public.%I', r.policyname, r.tablename);
        IF r.permissive = 'RESTRICTIVE' THEN
            ddl := ddl || ' AS RESTRICTIVE';
        END IF;
        ddl := ddl || format(' FOR %s', r.cmd);
        ddl := ddl || ' TO authenticated';
        IF r.qual IS NOT NULL THEN
            ddl := ddl || format(' USING (%s)', r.qual);
        END IF;
        IF r.with_check IS NOT NULL THEN
            ddl := ddl || format(' WITH CHECK (%s)', r.with_check);
        END IF;

        EXECUTE ddl;
    END LOOP;
END
$f4$;


-- ------------------------------------------------------------------
-- F5 — FORCE ROW LEVEL SECURITY.
--      On le pose sur les tables qui ne sont JAMAIS écrites par une
--      fonction SECURITY DEFINER (recherche sur pg_proc.prosecdef) :
--      un propriétaire sans BYPASSRLS serait en effet soumis à la RLS
--      dans ces fonctions, ce que la table évite ici.
--      Les tables écrites par une fonction SECURITY DEFINER restent en
--      non-FORCE et sont listées en fin de fichier (documenté).
-- ------------------------------------------------------------------
DO $f5$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relrowsecurity
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_proc p
                 JOIN pg_namespace pn ON pn.oid = p.pronamespace
                WHERE pn.nspname = 'public'
                  AND p.prosecdef
                  AND p.prosrc ILIKE '%' || c.relname || '%'
           )
    LOOP
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END LOOP;
END
$f5$;


-- ------------------------------------------------------------------
-- F6 — 7 tables en RLS sans aucune politique : comportement deny-all
--      mais non explicite. On pose une politique d'interdiction
--      intentionnelle, appliquée à tous les rôles (c'est une
--      fermeture : aucune clause de rôle ne peut la rendre « plus
--      permissive »). L'accès réel passe par service_role, qui
--      contourne la RLS.
-- ------------------------------------------------------------------
DO $f6$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'account_recovery_emails', 'bictorys_webhooks', 'import_runs',
        'import_run_rows', 'password_reset_tokens', 'quota_reservations',
        'tenant_invitations'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass
        ) THEN
            EXECUTE format(
                'CREATE POLICY closed_deny_all ON public.%I FOR ALL USING (false) WITH CHECK (false)',
                t
            );
        END IF;
    END LOOP;
END
$f6$;


-- ------------------------------------------------------------------
-- F7 — `handle_new_user` écrit '' quand l'inscription n'a pas d'e-mail
--      (20260925000000_security_blockers.sql:40) : deux comptes sans
--      e-mail violaient UNIQUE (email) et l'inscription échouait
--      silencieusement.
--      Correction retenue : colonne nullable + unicités partielles
--      excluant NULL et '' (l'index sur lower(email) était global et
--      aurait continué à provoquer la collision).
-- ------------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN email DROP NOT NULL;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_key;
DROP INDEX IF EXISTS profiles_email_lower_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_uidx
    ON public.profiles (email)
    WHERE email IS NOT NULL AND email <> '';

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_uidx
    ON public.profiles (lower(email))
    WHERE email IS NOT NULL AND email <> '';

COMMENT ON INDEX public.profiles_email_uidx IS
    'E-mails renseignés uniquement : un profil sans e-mail (inscription sans adresse) ne collisionne pas. Audit F7.';


-- ------------------------------------------------------------------
-- M5 — `locataires.bien_id` est dénormalisé et porteur de la politique
--      `employe_select_locataires_affectes` : sans garantie de
--      cohérence, un locataire devient invisible pour l'employé
--      affecté. Le déclencheur recopie toujours la valeur de
--      `logements.bien_id` lorsque le logement est renseigné.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_locataire_bien_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_bien bigint;
BEGIN
    IF NEW.logement_id IS NULL THEN
        RETURN NEW; -- pas de logement : on laisse la valeur fournie
    END IF;

    SELECT bien_id INTO v_bien FROM logements WHERE id = NEW.logement_id;
    IF FOUND AND v_bien IS NOT NULL THEN
        NEW.bien_id := v_bien;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS locataires_bien_sync ON public.locataires;
CREATE TRIGGER locataires_bien_sync
    BEFORE INSERT OR UPDATE OF logement_id, bien_id
    ON public.locataires
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_locataire_bien_id();


-- ------------------------------------------------------------------
-- F9 — Seule clé étrangère des 80 sans ON DELETE : comportement par
--      défaut NO ACTION, on l'explicite.
-- ------------------------------------------------------------------
ALTER TABLE public.abonnement_paiements
    DROP CONSTRAINT IF EXISTS abonnement_paiements_plan_fkey;

ALTER TABLE public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_plan_fkey
    FOREIGN KEY (plan) REFERENCES public.plans (code)
    ON UPDATE CASCADE ON DELETE RESTRICT;


-- ------------------------------------------------------------------
-- Tables volontairement laissées en non-FORCE (F5) : elles sont
-- référencées par au moins une fonction SECURITY DEFINER (quota,
-- abonnements, profils, invitations), qui s'exécute comme propriétaire.
-- La liste est calculée : SELECT c.relname ... WHERE relrowsecurity AND
-- EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.prosrc ILIKE
-- '%'||c.relname||'%').
-- ------------------------------------------------------------------
