-- ============================================================
-- MIM - Corrections d'audit (index, unicités, contraintes, rétention)
--
-- Audit : server/supabase-schema.sql (dump de référence), les variantes
-- manuelles server/schema-tenant.sql / server/schema-admin.sql et les 44
-- migrations de supabase/migrations/ (dernière : 20260926001000).
--
-- Convention de sûreté, identique à 20260924020000_plan_constraints.sql,
-- 20260925010000_security_followup.sql et 20260925020000_validate_mfa_status.sql :
--   * CREATE INDEX IF NOT EXISTS / ALTER COLUMN ... SET DEFAULT /
--     CREATE OR REPLACE TRIGGER : naturellement idempotents ;
--   * ADD CONSTRAINT entouré d'une garde pg_constraint ;
--   * VALIDATE CONSTRAINT dans un bloc DO $$ ... EXCEPTION WHEN others
--     THEN RAISE WARNING : si des lignes existantes violent la contrainte,
--     celle-ci reste NOT VALID (elle s'applique déjà aux nouvelles lignes et
--     aux mises à jour) et la migration CONTINUE au lieu d'échouer. Une fois
--     les données corrigées, relancer le VALIDATE à la main ;
--   * les index UNIQUE sont protégés de la même façon : aucune commande SQL
--     n'ayant été exécutée contre la base, on ne peut pas garantir
--     l'absence de doublons préexistants — un échec est remonté en WARNING
--     plutôt que de casser la migration (voir chaque bloc).
--
-- Aucun fichier JS/HTML n'est modifié, aucune commande n'est exécutée
-- contre une base de données.
-- ============================================================


-- ============================================================
-- a) Index manquants (performance des policies RLS)
--
-- Vérification faite sur server/supabase-schema.sql (section des index,
-- lignes ~1814-1978) : AUCUNE des tables listées n'a déjà d'index dont
-- user_id soit la PREMIÈRE colonne. Les contraintes UNIQUE (id, user_id)
-- posées par 20260924000000_security_integrity_hardening.sql:193-201
-- (biens_id_user_id_key :1605, logements_id_user_id_key :1680,
-- locataires_id_user_id_key :1670, employes_id_user_id_key :1625,
-- incidents_id_user_id_key :1650, interventions_id_user_id_key :1660,
-- prestataires_id_user_id_key :1750, paiements_id_user_id_key :1715)
-- ont id en tête et ne servent donc PAS les filtres
-- `WHERE user_id = auth.uid()` des policies owner_*.
-- Tables contrôlées présentes dans le dump et porteuses d'une colonne
-- user_id (contraintes *_user_id_fkey ~:2003-2398) : biens, logements,
-- locataires, prestataires, incidents, interventions, employes, tasks,
-- notifications, moyens_paiement, versements, messages, sessions.
-- Déjà indexées (donc NON listées) : paiements
-- (paiements_locataire_mois_uidx :1934), paiements_employes
-- (paiements_employes_employe_mois_uidx :1926),
-- abonnement_paiements (abonnement_paiements_user_statut_idx :1822),
-- audit_logs (idx_audit_logs_user_id :1878), password_reset_tokens
-- (password_reset_tokens_user_id_idx :1942), quota_reservations
-- (quota_reservations_idempotency_uidx :1954), tenant_invitations
-- (tenant_invitations_active_tenant_uidx :1966), employes_biens
-- (employes_biens_owner_employee_bien_uidx :1854).
-- ============================================================

CREATE INDEX IF NOT EXISTS biens_user_id_idx         ON public.biens         (user_id);
CREATE INDEX IF NOT EXISTS logements_user_id_idx     ON public.logements     (user_id);
CREATE INDEX IF NOT EXISTS logements_bien_id_idx     ON public.logements     (bien_id);
CREATE INDEX IF NOT EXISTS locataires_user_id_idx    ON public.locataires    (user_id);
CREATE INDEX IF NOT EXISTS prestataires_user_id_idx  ON public.prestataires  (user_id);
CREATE INDEX IF NOT EXISTS incidents_user_id_idx     ON public.incidents     (user_id);
CREATE INDEX IF NOT EXISTS interventions_user_id_idx ON public.interventions (user_id);
CREATE INDEX IF NOT EXISTS employes_user_id_idx      ON public.employes      (user_id);
CREATE INDEX IF NOT EXISTS tasks_user_id_idx         ON public.tasks         (user_id);
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON public.notifications (user_id);
CREATE INDEX IF NOT EXISTS moyens_paiement_user_id_idx ON public.moyens_paiement (user_id);
CREATE INDEX IF NOT EXISTS versements_user_id_idx    ON public.versements    (user_id);
CREATE INDEX IF NOT EXISTS messages_user_id_idx      ON public.messages      (user_id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx      ON public.sessions      (user_id);


-- ============================================================
-- b) Unicités manquantes
-- ============================================================

-- b1) versements : un seul versement par (propriétaire, agence, bien, période).
--     État des colonnes (server/supabase-schema.sql:1411-1429) :
--       user_id UUID NOT NULL (compte qui crée la ligne),
--       agence_id UUID NOT NULL et proprietaire_id UUID NOT NULL (contrôlés),
--       bien_id BIGINT NULLABLE, periode TEXT NULLABLE.
--     Le SEUL INSERT applicatif (server/routes/agence.js:251) écrit
--       user_id = agenceId, agence_id = agenceId, proprietaire_id = proprietaireId,
--     et server/routes/mandat.js ne fait que UPDATE/SELECT (par
--     proprietaire_id). C'est donc (proprietaire_id, agence_id, bien_id,
--     periode) qui est la clé métier : deux « versements globaux »
--     (bien_id NULL) pour DEUX propriétaires différents doivent rester
--     possibles pour la même agence et la même période — clé
--     (user_id, agence_id, bien_id, periode) les aurait rejetés car
--     user_id = agence_id dans les deux cas.
--     Un UNIQUE classique ignore par ailleurs les lignes comportant un
--     NULL : deux versements globaux du MÊME propriétaire passeraient. On
--     utilise donc NULLS NOT DISTINCT (PostgreSQL >= 15 ; le projet est en
--     major_version = 17 — supabase/config.toml). Le repli PostgreSQL < 15
--     reproduit exactement la même sémantique par index partiels.
--     Risque de doublons préexistants -> protégé (WARNING au lieu d'échec).
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'versements'
          AND indexname = 'versements_proprietaire_periode_uidx'
    ) THEN
        IF current_setting('server_version_num')::int >= 150000 THEN
            EXECUTE 'CREATE UNIQUE INDEX versements_proprietaire_periode_uidx
                     ON public.versements (proprietaire_id, agence_id, bien_id, periode)
                     NULLS NOT DISTINCT';
        ELSE
            -- Repli < 15 : (proprietaire_id, agence_id) NOT NULL permet
            -- d'émuler NULLS NOT DISTINCT avec 1 index plein + 3 index
            -- partiels, un par motif de NULL.
            EXECUTE 'CREATE UNIQUE INDEX versements_proprietaire_periode_uidx
                     ON public.versements (proprietaire_id, agence_id, bien_id, periode)';
            EXECUTE 'CREATE UNIQUE INDEX versements_proprietaire_bien_null_uidx
                     ON public.versements (proprietaire_id, agence_id, periode)
                     WHERE bien_id IS NULL';
            EXECUTE 'CREATE UNIQUE INDEX versements_proprietaire_periode_null_uidx
                     ON public.versements (proprietaire_id, agence_id, bien_id)
                     WHERE bien_id IS NOT NULL AND periode IS NULL';
            EXECUTE 'CREATE UNIQUE INDEX versements_proprietaire_both_null_uidx
                     ON public.versements (proprietaire_id, agence_id)
                     WHERE bien_id IS NULL AND periode IS NULL';
        END IF;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'versements : unicite (proprietaire_id, agence_id, bien_id, periode) NON creee. Des doublons existent peut-etre : les corriger puis relancer. ERREUR -> %', SQLERRM;
END $$;

-- b2) paiements : un seul paiement DÉCLARÉ SANS LOCATAIRE par propriétaire
--     et par mois. (Les paiements rattachés à un locataire sont déjà couverts
--     par paiements_locataire_mois_uidx — dump :1934, créé par
--     20260924000000:207 et 20260925000000:9 — qui ajoute
--     superseded_at IS NULL ; on ne touche pas à cet index.)
--     paiements n'a PAS de colonne proprietaire_id (dump :1034-1056) :
--     le propriétaire, c'est user_id, exactement comme dans
--     paiements_locataire_mois_uidx. mois est NOT NULL (:1040) ; seul
--     locataire_id est NULLable (:1037) et superseded_at (:1050).
--     Le filtre superseded_at IS NULL suit la convention de TOUS les
--     index uniques du dépôt (dump :1814-1934) et évite de bloquer une
--     re-déclaration après archivage d'une ligne.
--     Attention : 20260924000000:174-177 n'a dédupliqué que les lignes avec
--     locataire_id NOT NULL -> des doublons (user_id, mois) sans locataire
--     peuvent exister. Protégé.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'paiements'
          AND indexname = 'paiements_owner_mois_uidx'
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX paiements_owner_mois_uidx
                 ON public.paiements (user_id, mois)
                 WHERE locataire_id IS NULL AND superseded_at IS NULL';
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'paiements : unicite partielle (user_id, mois) WHERE locataire_id IS NULL AND superseded_at IS NULL NON creee. Des doublons existent peut-etre : les corriger puis relancer. ERREUR -> %', SQLERRM;
END $$;

-- b3) profiles.email : unicité insensible à la casse sur l'e-mail.
--     L'index exact profiles_email_key (dump :1760, UNIQUE (email)) est
--     CONSERVÉ tel quel — on ne le supprime pas, on en ajoute un seul.
--     Même motif que account_recovery_emails_email_uidx
--     (20260925010000_security_followup.sql:9-10).
--     Risque : deux profils 'A@x.fr' / 'a@x.fr' bloqueraient la création ->
--     protégé (WARNING), et l'index reste documenté comme non créé en cas
--     de doublons.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'profiles'
          AND indexname = 'profiles_email_lower_uidx'
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX profiles_email_lower_uidx
                 ON public.profiles (lower(email))';
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'profiles : unicite case-insensitive sur lower(email) NON creee. Des e-mails en double (hors casse) existent peut-etre : les corriger puis relancer. ERREUR -> %', SQLERRM;
END $$;


-- ============================================================
-- c) versements.periode : contrôle de format AAAA-MM
--
-- Aligné sur paiements_mois_ck / paiements_mois_valid_ck
-- (20260924000000:225, 20260925010000:37). periode est NULLable -> le
-- CHECK autorise explicitement NULL (sinon toute insertion sans période
-- échouerait). Le format est validé côté serveur également
-- (server/routes/agence.js:229, isValidMonth + slice(0,7)).
--
-- Ajout NOT VALID puis VALIDATE protégé : si des lignes hors format
-- existent déjà, la contrainte reste NOT VALID (elle s'applique aux
-- nouvelles lignes et aux UPDATE) et la migration n'échoue pas.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.versements'::regclass
          AND conname = 'versements_periode_mois_ck'
    ) THEN
        ALTER TABLE public.versements
            ADD CONSTRAINT versements_periode_mois_ck
            CHECK (periode IS NULL OR periode ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
            NOT VALID;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'versements_periode_mois_ck NON creee - %', SQLERRM;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.versements'::regclass
          AND conname = 'versements_periode_mois_ck'
          AND NOT convalidated
    ) THEN
        ALTER TABLE public.versements VALIDATE CONSTRAINT versements_periode_mois_ck;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'versements_periode_mois_ck : VALIDATION REPORTEE. Corriger les lignes hors format AAAA-MM puis executer : ALTER TABLE public.versements VALIDATE CONSTRAINT versements_periode_mois_ck. ERREUR -> %', SQLERRM;
END $$;


-- ============================================================
-- d) abonnement_paiements.statut : DEFAULT 'paid' -> 'pending'
--
-- 20260921000000_bictorys.sql:70 a posé DEFAULT 'paid'. C'est dangereux :
-- un INSERT serveur qui omet statut crée un paiement déjà 'paid', alors que
-- public.activate_subscription_payment() exige statut = 'pending'
-- (20260924000000:385) pour activer l'abonnement. Le vrai flux écrit déjà
-- 'pending' explicitement (record_manual_subscription_payment, :423).
-- Seul le DEFAULT change : les lignes existantes ne sont pas modifiées.
-- ALTER COLUMN ... SET DEFAULT est idempotent.
-- ============================================================
ALTER TABLE public.abonnement_paiements ALTER COLUMN statut SET DEFAULT 'pending';


-- ============================================================
-- e) subscriptions.montant : CHECK (montant >= 0)
--
-- Même pattern NOT VALID + VALIDATE protégé qu'en (c).
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.subscriptions'::regclass
          AND conname = 'subscriptions_montant_ck'
    ) THEN
        ALTER TABLE public.subscriptions
            ADD CONSTRAINT subscriptions_montant_ck
            CHECK (montant IS NULL OR montant >= 0)
            NOT VALID;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'subscriptions_montant_ck NON creee - %', SQLERRM;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.subscriptions'::regclass
          AND conname = 'subscriptions_montant_ck'
          AND NOT convalidated
    ) THEN
        ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_montant_ck;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'subscriptions_montant_ck : VALIDATION REPORTEE. Corriger les montants negatifs puis executer : ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_montant_ck. ERREUR -> %', SQLERRM;
END $$;


-- ============================================================
-- f) Rétention : audit_logs et sessions ne doivent pas disparaître
--    avec le compte supprimé.
--
--    - audit_logs : user_id NOT NULL (dump :501) + ON DELETE CASCADE
--      (dump :2058) -> la suppression d'un compte détruisait son journal.
--      On rend la colonne nullable PUIS on remplace CASCADE par SET NULL :
--      la ligne de journal est conservée, le lien devient NULL.
--      La seule policy de la table est admin_read_audit_logs (dump :2414,
--      TO authenticated, account_type IN ('admin','ultra_admin')) ; le
--      privilège SELECT n'est accordé qu'à service_role (dump :2877), donc
--      en l'état aucun utilisateur final ne lit le journal d'un autre
--      compte, même après NULLage du user_id.
--    - sessions : idem. user_id NOT NULL (dump :1283) + ON DELETE CASCADE
--      (dump :2338). Seul service_role a le privilège SELECT (dump :3077) ;
--      la policy unique owner_all_sessions (dump :2618, auth.uid() =
--      user_id) ne retournerait jamais une ligne à user_id NULL. Rien ne
--      devient lisible qui ne l'était pas avant.
-- ============================================================

-- f1) audit_logs ------------------------------------------------------
ALTER TABLE public.audit_logs ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.audit_logs'::regclass
          AND conname = 'audit_logs_user_id_fkey'
          AND confdeltype <> 'a'          -- 'a' = ON DELETE SET NULL
    ) THEN
        ALTER TABLE public.audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.audit_logs'::regclass
          AND conname = 'audit_logs_user_id_fkey'
    ) THEN
        ALTER TABLE public.audit_logs
            ADD CONSTRAINT audit_logs_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'audit_logs_user_id_fkey : passage en ON DELETE SET NULL NON effectue - %', SQLERRM;
END $$;

COMMENT ON COLUMN public.audit_logs.user_id IS
    'Rétention : NULL lorsque le compte source a été supprimé (ON DELETE SET NULL, migration audit_corrections 20260927). La ligne de journal est conservée ; seul service_role en a le privilège SELECT (RLS admin_read_audit_logs limite en plus la lecture à admin/ultra_admin).';

-- f2) sessions --------------------------------------------------------
ALTER TABLE public.sessions ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.sessions'::regclass
          AND conname = 'sessions_user_id_fkey'
          AND confdeltype <> 'a'
    ) THEN
        ALTER TABLE public.sessions DROP CONSTRAINT sessions_user_id_fkey;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.sessions'::regclass
          AND conname = 'sessions_user_id_fkey'
    ) THEN
        ALTER TABLE public.sessions
            ADD CONSTRAINT sessions_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'sessions_user_id_fkey : passage en ON DELETE SET NULL NON effectue - %', SQLERRM;
END $$;

COMMENT ON COLUMN public.sessions.user_id IS
    'Rétention : NULL lorsque le compte a été supprimé (ON DELETE SET NULL, migration audit_corrections 20260927). L''historique de session survit au compte ; seul service_role en a le privilège SELECT et, sous RLS, owner_all_sessions exige auth.uid() = user_id : une ligne à user_id NULL n''est donc jamais rendue à un autre compte.';


-- ============================================================
-- g) RLS : périmètre de lecture d'un compte LOCATAIRE
--
-- g1) tenant_select_moyens_paiement (dump :2723) : VOLONTÉ PRODUIT.
--     Un locataire lit les coordonnées de PAIEMENT du propriétaire de son
--     logement afin de pouvoir payer (numéro, IBAN, BIC, num_compte,
--     instructions, nom_titulaire, type, lien_paiement). On NE RESTREINT
--     PAS ces champs : c'est le produit.
--     Aucune donnée de paie (employes.salaire, moyens_paiement_employes,
--     paiements_employes) ne transite par cette policy.
--
-- g2) Vérification faite sur l'ensemble des policies du dump (RLS bien
--     activé sur les 3 tables : dump :2527, :2560, :2643) :
--       employes ............... owner_all_employes :2582,
--                                employe_select_own_employe :2505
--       moyens_paiement_employes  employe_all_own_moyens :2464,
--                                owner_select_employe_moyens :2626
--       paiements_employes ..... owner_all_paiements_employes :2610,
--                                employe_select_own_paiements :2515,
--                                employe_update_own_paiements :2523
--     AUCUNE policy 'tenant_*' et aucun USING 'locataire' ne cible ces
--     trois tables : un locataire ne lit déjà ni salaire ni coordonnées
--     bancaires de salarié. On ajoute néanmoins une politique RESTRICTIVE
--     de garde-fou (fail-closed) : même si une policy permissive y était
--     ajoutée plus tard, un compte de type 'locataire' resterait bloqué.
--     Même effet de bord assumé : si la ligne profiles de l'appelant
--     venait à manquer, COALESCE(...) = '' et la lecture est bloquée —
--     c'est le comportement voulu (on ferme plutôt que d'ouvrir).
--     Les comptes proprietaire/agence/entreprise/employe sont les seuls
--     concernés (les admins n'ont aucune policy permissive sur ces tables
--     aujourd'hui). service_role est BYPASSRLS : non impacté.
-- ============================================================

COMMENT ON POLICY tenant_select_moyens_paiement ON public.moyens_paiement IS
    'Volonte produit : le locataire lit les moyens de paiement ACTIFS de son proprietaire de logement (type, numero, iban, bic, num_compte, instructions, nom_titulaire, lien_paiement) pour payer manuellement. Ne concerne PAS les moyens des salaries (moyens_paiement_employes) ni les salaires (employes.salaire).';

COMMENT ON COLUMN public.employes.salaire IS
    'Paie : lisible uniquement par le propriétaire/agence/entreprise qui possède la fiche (owner_all_employes) et par l''employé concerné (employe_select_own_employe) ; jamais par un compte locataire (policy restrictive restrict_no_locataire_employes).';

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['employes', 'moyens_paiement_employes', 'paiements_employes'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = t
              AND policyname = 'restrict_no_locataire_' || t
        ) THEN
            EXECUTE format(
                $f$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT USING (
                        COALESCE((SELECT p.account_type FROM public.profiles p WHERE p.id = auth.uid()), '')
                        IN ('proprietaire','agence','entreprise','employe')
                    )$f$,
                'restrict_no_locataire_' || t,
                t
            );
        END IF;
    END LOOP;
EXCEPTION WHEN others THEN
    RAISE WARNING 'gardiens restrict_no_locataire_* NON crees - %', SQLERRM;
END $$;


-- ============================================================
-- h) Triggers sur auth.users : garde-fous de creation/mauvais role
--
-- Les fonctions sont declarees dans le dump (guard_public_auth_metadata
-- ~:154, handle_new_user ~:176) mais aucun CREATE TRIGGER ON "auth"."users"
-- n'y figure : une reconstruction depuis server/supabase-schema.sql
-- perdait les deux garde-fous (crees par 20260924000000:141-142 et :159-160,
-- repris par 20260925000000:66-69).
-- CREATE OR REPLACE TRIGGER (PG >= 14 ; projet en PG17) cree le trigger
-- s'il n'existe pas et le remplace sinon : idempotent, pas de DROP préalable.
-- ============================================================

CREATE OR REPLACE TRIGGER "on_auth_user_created"
    AFTER INSERT ON "auth"."users"
    FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();

CREATE OR REPLACE TRIGGER "mim_guard_public_auth_metadata"
    BEFORE INSERT OR UPDATE OF "raw_user_meta_data" ON "auth"."users"
    FOR EACH ROW EXECUTE FUNCTION "public"."guard_public_auth_metadata"();

-- mim_sync_profile_role (20260926001000:48-53) : garde si la fonction
-- existe déjà, avertissement sinon (migration appliquée hors chaîne).
DO $$
BEGIN
    IF to_regprocedure('public.sync_profile_account_type()') IS NOT NULL THEN
        EXECUTE $t$CREATE OR REPLACE TRIGGER "mim_sync_profile_role"
            AFTER UPDATE OF "raw_app_meta_data" ON "auth"."users"
            FOR EACH ROW
            WHEN ((OLD."raw_app_meta_data" IS DISTINCT FROM NEW."raw_app_meta_data"))
            EXECUTE FUNCTION "public"."sync_profile_account_type"()$t$;
    ELSE
        RAISE WARNING 'public.sync_profile_account_type() introuvable : trigger mim_sync_profile_role non (re)créé (attendu via 20260926001000).';
    END IF;
END $$;


-- ============================================================
-- i) Re-sécurisation des régressions ouvertes par server/schema-tenant.sql
--
-- Ce fichier variant (appliqué à la main via server/run-tenant-schema.mjs)
-- réouvrait deux failles close par le durcissement :
--   * GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated sur
--     employes/tasks/paiements_employes -> un employé pouvait modifier son
--     propre bulletin (montant, mois, statut) via PostgREST
--     (close par 20260924000000:448-451 et 20260925000000:155-161) ;
--   * policy tenant_link_locataire (UPDATE auto-liaison par simple
--     égalité d'e-mail dans le JWT), close par 20260924000000:435 et
--     20260925000000:149.
-- Le fichier a été corrigé, mais s'il avait déjà été rejoué sur la base,
-- l'état durci devait être réappliqué ici. Toutes les écritures de ces
-- tables passent par service_role (server/routes/*) : rien n'est cassé.
-- ============================================================

DROP POLICY IF EXISTS "tenant_link_locataire" ON public.locataires;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.employes, public.tasks, public.paiements_employes
    FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- État final explicite (sous-ensemble de 20260925000000:158, :160-161) :
GRANT SELECT ON public.employes, public.tasks, public.paiements_employes TO authenticated;
GRANT UPDATE (lu) ON public.notifications TO authenticated;
GRANT DELETE ON public.notifications TO authenticated;
