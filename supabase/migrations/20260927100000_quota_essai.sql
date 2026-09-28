-- ============================================================
-- MIM - Quotas fail-open : plan « essai », capacités
--        employés / prestataires, essai automatique à
--        l'inscription
--
-- Constat (audit du 2026-09-27) :
--   * public.reserve_quota() affecte v_limit := NULL quand la
--     souscription est absente (héritage) et quand la capacité de
--     la colonne est NULL ; le test `IF v_limit IS NOT NULL` saute
--     alors entièrement : quota ILLIMITÉ (fail-open) ;
--   * plans.max_employes / plans.max_prestataires n'existaient
--     pas : le CASE de reserve_quota ne connaît ni 'employes' ni
--     'prestataires' -> v_limit NULL -> illimité (alors que
--     20260922000000_plan_packs.sql:9-10 l'affiche volontairement
--     comme argument commercial) ;
--   * aucun compte ne reçoit de souscription à l'inscription :
--     server/routes/auth.js n'écrit jamais public.subscriptions,
--     seul handle_new_user (server/supabase-schema.sql:176-207)
--     crée public.profiles -> les nouveaux comptes sont en
--     héritage fail-open d'office.
--
-- Corrections (5 sections, SQL seul, 100 % idempotent) :
--   (a) plans.max_employes / plans.max_prestataires + CHECK ;
--   (b) plan « essai » (0 XOF, 14 jours) + capacités initiales ;
--   (c) abonnement d'essai automatique à l'inscription ;
--   (d) reserve_quota : capacités réelles + plafond plancher ;
--   (e) idempotence / opt-out.
--
-- Contraintes respectées : aucun fichier JS/HTML modifié, aucune
-- commande SQL exécutée (supabase db push / psql), aucune
-- modification de 20260927000000_audit_corrections.sql,
-- date_expiration / computeStatus / activate_subscription_payment
-- et consume_quota() / release_quota() inchangés, aucun plan
-- payant ajouté, aucun prix modifié.
-- ============================================================


-- ============================================================
-- (a) public.plans : max_employes / max_prestataires
--
-- Même vocabulaire que les capacités sœurs posées par
-- 20260922000000_plan_packs.sql:19-20 (max_logements,
-- max_locataires) : entier nullable, NULL = « le plan ne plafonne
-- pas », et une valeur non nulle doit être strictement positive
-- (plans_max_logements_ck / plans_max_locataires_ck,
-- server/supabase-schema.sql:1166-1169) — 0 n'a jamais de sens
-- ici, contrairement à un plan « sans employés » qui se
-- contredirait.
-- ============================================================

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_employes integer;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_prestataires integer;

-- Garde pg_constraint + NOT VALID (convention de 20260927000000_
-- audit_corrections.sql:8-21 et 20260924020000_plan_constraints.sql) :
-- si des lignes existantes violent la contrainte, celle-ci s'applique
-- déjà aux nouvelles lignes et la migration CONTINUE en WARNING.
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass
          AND conname = 'plans_max_employes_ck'
    ) THEN
        ALTER TABLE public.plans
            ADD CONSTRAINT plans_max_employes_ck
            CHECK (max_employes IS NULL OR max_employes > 0)
            NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass
          AND conname = 'plans_max_prestataires_ck'
    ) THEN
        ALTER TABLE public.plans
            ADD CONSTRAINT plans_max_prestataires_ck
            CHECK (max_prestataires IS NULL OR max_prestataires > 0)
            NOT VALID;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'plans_max_employes_ck / plans_max_prestataires_ck NON creees - %', SQLERRM;
END $do$;

DO $do$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass
          AND conname = 'plans_max_employes_ck'
          AND NOT convalidated
    ) THEN
        ALTER TABLE public.plans VALIDATE CONSTRAINT plans_max_employes_ck;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass
          AND conname = 'plans_max_prestataires_ck'
          AND NOT convalidated
    ) THEN
        ALTER TABLE public.plans VALIDATE CONSTRAINT plans_max_prestataires_ck;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'plans_max_employes_ck / plans_max_prestataires_ck : VALIDATION REPORTEE. Corriger les lignes a capacite <= 0 puis executer : ALTER TABLE public.plans VALIDATE CONSTRAINT plans_max_employes_ck (idem plans_max_prestataires_ck). ERREUR -> %', SQLERRM;
END $do$;

COMMENT ON COLUMN public.plans.max_employes IS
    'Capacité maximale d''employés du plan (NULL = non plafonné historiquement ; reserve_quota() applique alors son plafond plancher).';
COMMENT ON COLUMN public.plans.max_prestataires IS
    'Capacité maximale de prestataires du plan (NULL = non plafonné historiquement ; reserve_quota() applique alors son plafond plancher).';


-- ============================================================
-- (b) Plan « essai » + capacités initiales des packs existants
--
-- Le plan est OBLIGATOIREMENT actif = true : reserve_quota()
-- (server/supabase-schema.sql:277) refuse un plan inactif avec
-- « Plan inactif ou expire. » et server/utils/subscription.js
-- refuse les capacités d'un plan introuvable (PLAN_UNAVAILABLE) :
-- un essai inactif bloquerait TOUTES les inscriptions.
--
-- audience = 'proprietaire' et NON 'agence' : la grille agence
-- doit rester à 3 formules (server/scripts/tests/bictorys.test.js:249
-- impose codes.length === 3).
--
-- prix = 0 (plans_prix_positive : prix >= 0, server/supabase-schema.sql
-- :1170) et jamais achetable : PLAN_CODES
-- (server/utils/plans.js:76) ne contient pas 'essai'.
--
-- Capacités volontairement larges (10 / 100 / 100) : elles
-- remplacent le « illimité » hérité des comptes sans souscription,
-- sans relever le seuil sous lequel un propriétaire testé pourrait
-- se voir refuser une création.
--
-- ON CONFLICT DO UPDATE ne réécrit PAS max_* : les capacités
-- restent modifiables depuis l'interface Ultra Admin (même parti
-- pris que 20260926000000_plan_audience.sql:43-50).
-- ============================================================

INSERT INTO public.plans
    (code, nom, type, prix, devise, max_immeubles, max_logements, max_locataires,
     max_employes, max_prestataires, duree_abonnement, audience, actif, description)
VALUES
    ('essai', 'Essai gratuit', 'proprietaire', 0, 'XOF', 10, 100, 100, 10, 10, 1, 'proprietaire', true,
     'Essai automatique de 14 jours — 10 immeubles — 100 logements — 100 locataires — 10 employés — 10 prestataires.')
ON CONFLICT (code) DO UPDATE
  SET nom = EXCLUDED.nom,
      type = EXCLUDED.type,
      prix = EXCLUDED.prix,
      devise = EXCLUDED.devise,
      duree_abonnement = EXCLUDED.duree_abonnement,
      audience = EXCLUDED.audience,
      actif = EXCLUDED.actif,
      description = EXCLUDED.description,
      updated_at = now();

-- Capacités initiales des packs déjà en place (valeurs NULL
-- uniquement : une capacité déjà renseignée — y compris par Ultra
-- Admin — est conservée). Échelles calquées sur la grille de
-- 20260922000000_plan_packs.sql et 20260926000000_plan_audience.sql.
UPDATE public.plans
SET max_employes = CASE lower(btrim(code))
        WHEN 'standard'         THEN 5
        WHEN 'premium'          THEN 15
        WHEN 'pro'              THEN 50
        WHEN 'agence'           THEN 100
        WHEN 'agence_starter'   THEN 10
        WHEN 'agence_pro'       THEN 30
        WHEN 'agence_business'  THEN 80
        WHEN 'essai'            THEN 10
        ELSE max_employes
    END,
    updated_at = now()
WHERE max_employes IS NULL;

UPDATE public.plans
SET max_prestataires = CASE lower(btrim(code))
        WHEN 'standard'         THEN 5
        WHEN 'premium'          THEN 15
        WHEN 'pro'              THEN 50
        WHEN 'agence'           THEN 100
        WHEN 'agence_starter'   THEN 10
        WHEN 'agence_pro'       THEN 30
        WHEN 'agence_business'  THEN 80
        WHEN 'essai'            THEN 10
        ELSE max_prestataires
    END,
    updated_at = now()
WHERE max_prestataires IS NULL;

-- L'ancien pack Ultra est archivé (actif = false depuis
-- 20260922000000:42-46) : il reste sans capacité employés/
-- prestataires (NULL -> plafond plancher) et il est déjà refusé
-- par reserve_quota() / planByCode(onlyActive = true).


-- ============================================================
-- (c) Abonnement d'essai automatique à l'inscription
--
-- Déclencheur AFTER INSERT sur public.profiles, donc APRÈS
-- handle_new_user (trigger on_auth_user_created,
-- server/supabase-schema.sql:1994) : le compte est déjà créé,
-- l'abonnement est une écriture annexe.
--
--   * SECURITY DEFINER (propriétaire postgres) : subscriptions a
--     ENABLE ROW LEVEL SECURITY sans FORCE
--     (server/supabase-schema.sql:2687) -> un INSERT «authenticated »
--     serait refusé, la définition de fonction contourne RLS ;
--   * SET search_path = '' : tout est qualifié, pg_catalog inclus ;
--   * types éligibles : proprietaire / agence / entreprise — les
--     seuls traités comme audience propriétaire par
--     audienceForAccount() (server/utils/plans.js:20-22) et donc
--     les seuls soumis aux quotas. Les comptes admin/locataire/
--     employe ne reçoivent rien ;
--   * ON CONFLICT (user_id) DO NOTHING (contrainte
--     subscriptions_user_unique, server/supabase-schema.sql:1785) :
--     idempotent, et surtout il ne remplace JAMAIS un abonnement
--     payant déjà en place si le profil est recréé ;
--   * le tout est entouré d'un bloc EXCEPTION : une écriture
--     d'échec ne doit JAMAIS faire échouer une inscription
--     (le compte retomberait alors sur l'héritage actuel).
--
-- Retrait possible sans toucher au reste de la migration :
--   DROP TRIGGER IF EXISTS mim_trial_subscription_on_signup ON public.profiles;
-- ============================================================

CREATE OR REPLACE FUNCTION public.mim_trial_subscription_on_signup()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $fn$
DECLARE
    v_type text;
    v_plan_id uuid;
    v_now timestamptz;
BEGIN
    v_type := lower(pg_catalog.btrim(COALESCE(NEW.account_type, '')));
    IF v_type NOT IN ('proprietaire', 'agence', 'entreprise') THEN
        RETURN NEW;
    END IF;

    SELECT id INTO v_plan_id FROM public.plans WHERE code = 'essai' AND actif = true;
    IF v_plan_id IS NULL THEN
        -- Plan absent / désactivé : on ne crée surtout pas une
        -- souscription pointant vers un plan inconnu (elle bloquerait
        -- toutes les capacités). Le compte garde le comportement actuel.
        RAISE WARNING 'abonnement d''essai ignore : plan « essai » introuvable ou inactif (profil %)', NEW.id;
        RETURN NEW;
    END IF;

    v_now := clock_timestamp();
    BEGIN
        INSERT INTO public.subscriptions
            (user_id, plan, plan_id, statut, date_debut, date_expiration,
             montant, methode_paiement, reference, duree_abonnement, updated_at)
        VALUES
            (NEW.id, 'essai', v_plan_id, 'actif', v_now, v_now + interval '14 days',
             0, NULL, 'essai-automatique', NULL, v_now)
        ON CONFLICT (user_id) DO NOTHING;
    EXCEPTION WHEN others THEN
        RAISE WARNING 'abonnement d''essai non cree pour le profil % - %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS mim_trial_subscription_on_signup ON public.profiles;
CREATE OR REPLACE TRIGGER mim_trial_subscription_on_signup
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.mim_trial_subscription_on_signup();

COMMENT ON FUNCTION public.mim_trial_subscription_on_signup() IS
    'Crée un abonnement d''essai de 14 jours (plan « essai ») à l''inscription d''un compte propriétaire / agence / entreprise. Jamais bloquant : toute erreur est remontée en WARNING.';


-- ============================================================
-- (d) public.reserve_quota() : capacités réelles + plafond
--     plancher
--
-- Remplace 20260924030000_quota_counts.sql (dernière définition
-- connue, = server/supabase-schema.sql:256-289). Signature,
-- verrou d'advisory, idempotence p_idempotency_key, expiration des
-- réservations, message d'erreur « Quota de plan atteint pour % »
-- et comportement de retour sont INTACTS.
--
-- Trois changements uniquement :
--   1. le CASE de v_limit connaît 'employes' et 'prestataires'
--      (nouvelles colonnes de (a)) ;
--   2. les compteurs de v_current couvrent employes (filtre
--      superseded_at IS NULL, même convention que locataires à la
--      ligne 282) et prestataires (aucune colonne superseded_at) ;
--   3. plafond plancher : COALESCE(v_limit, plancher) s'applique
--      (i) sans ligne subscriptions et (ii) quand la capacité du
--      plan est NULL. L'accès n'est JAMAIS refusé d'office
--      (pas de RAISE EXCEPTION ici : héritage préservé, la route
--      métier reste ouverte) — seule la réservation de quota est
--      bornée. C'est la même famille de défense que
--      enforceImmeublesLimit (server/utils/subscription.js:275+),
--      côté SQL cette fois.
--
-- Les planchers (biens 5 / logements 50 / locataires 100 /
-- employes 2 / prestataires 2) sont volontairement supérieurs aux
-- volumes de création rencontrés : ils ne déclenchent que si le
-- RPC est appelé, or server/utils/quota.js:3-4 n'appelle le RPC
-- qu'avec une limite non nulle (donc avec une ligne subscriptions
-- et une capacité de plan non NULL). Ils servent d'arrêt d'urgence
-- contre un compte sans souscription ou un plan édité en NULL.
--
-- Invariants NON modifiés (à relire avant toute régression) :
--   * consume_quota() (server/supabase-schema.sql:66-80) et
--     release_quota() (:238) ne sont pas touchés ;
--   * computeStatus / date_expiration et
--     activate_subscription_payment (:26-63) ne sont pas touchés :
--     un achat après l'essai prolonge toujours depuis
--     v_sub.date_expiration (ligne 50), y compris l'essai de 14 j ;
--   * « Plan inactif ou expire. » reste levé (ligne 277).
-- ============================================================

CREATE OR REPLACE FUNCTION "public"."reserve_quota"("p_user_id" "uuid", "p_resource" "text", "p_quantity" integer DEFAULT 1, "p_idempotency_key" "text" DEFAULT NULL::"text", "p_ttl" interval DEFAULT '00:15:00'::interval, "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_resource text; v_key text; v_now timestamptz := clock_timestamp(); v_plan public.plans%ROWTYPE; v_sub public.subscriptions%ROWTYPE; v_limit integer; v_current bigint := 0; v_reserved bigint := 0; v_id uuid; v_status text;
BEGIN
    IF p_user_id IS NULL OR p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 10000 THEN RAISE EXCEPTION 'Quota invalide.'; END IF;
    v_resource := lower(btrim(COALESCE(p_resource,'')));
    v_resource := CASE v_resource WHEN 'bien' THEN 'biens' WHEN 'immeuble' THEN 'biens' WHEN 'immeubles' THEN 'biens' WHEN 'logement' THEN 'logements' WHEN 'locataire' THEN 'locataires' WHEN 'employe' THEN 'employes' WHEN 'prestataire' THEN 'prestataires' ELSE v_resource END;
    IF v_resource NOT IN ('biens','logements','locataires','employes','prestataires') THEN RAISE EXCEPTION 'Ressource invalide.'; END IF;
    IF p_ttl IS NULL OR p_ttl <= interval '0 seconds' OR p_ttl > interval '24 hours' THEN RAISE EXCEPTION 'Expiration invalide.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_resource,0));
    UPDATE public.quota_reservations SET status = 'expired',updated_at = v_now WHERE user_id = p_user_id AND resource = v_resource AND status = 'reserved' AND expires_at <= v_now;
    v_key := NULLIF(btrim(COALESCE(p_idempotency_key,'')),'');
    IF v_key IS NOT NULL THEN
        SELECT id,status INTO v_id,v_status FROM public.quota_reservations WHERE user_id = p_user_id AND resource = v_resource AND idempotency_key = v_key;
        IF FOUND THEN IF v_status IN ('reserved','consumed') THEN RETURN v_id; END IF; RAISE EXCEPTION 'Cle quota deja terminale.'; END IF;
    END IF;
    SELECT * INTO v_sub FROM public.subscriptions WHERE user_id = p_user_id FOR UPDATE;
    IF FOUND THEN
        IF v_sub.plan_id IS NOT NULL THEN SELECT * INTO v_plan FROM public.plans WHERE id = v_sub.plan_id AND actif = true; ELSE SELECT * INTO v_plan FROM public.plans WHERE code = v_sub.plan AND actif = true; END IF;
        IF NOT FOUND OR v_sub.date_expiration <= v_now THEN RAISE EXCEPTION 'Plan inactif ou expire.'; END IF;
        v_limit := CASE v_resource WHEN 'biens' THEN v_plan.max_immeubles WHEN 'logements' THEN v_plan.max_logements WHEN 'locataires' THEN v_plan.max_locataires WHEN 'employes' THEN v_plan.max_employes WHEN 'prestataires' THEN v_plan.max_prestataires ELSE NULL END;
    ELSE v_limit := NULL; END IF;
    -- (d) Plancher : s'applique sans souscription et pour une
    -- capacité de plan NULL. Aucun refus d'accès ici (héritage),
    -- uniquement une borne sur la réservation de quota.
    v_limit := COALESCE(v_limit, CASE v_resource WHEN 'biens' THEN 5 WHEN 'logements' THEN 50 WHEN 'locataires' THEN 100 WHEN 'employes' THEN 2 WHEN 'prestataires' THEN 2 END);
    IF v_resource = 'biens' THEN SELECT count(*) INTO v_current FROM public.biens WHERE user_id = p_user_id;
    ELSIF v_resource = 'logements' THEN SELECT count(*) INTO v_current FROM public.logements WHERE user_id = p_user_id;
    ELSIF v_resource = 'locataires' THEN SELECT count(*) INTO v_current FROM public.locataires WHERE user_id = p_user_id AND superseded_at IS NULL;
    ELSIF v_resource = 'employes' THEN SELECT count(*) INTO v_current FROM public.employes WHERE user_id = p_user_id AND superseded_at IS NULL;
    ELSIF v_resource = 'prestataires' THEN SELECT count(*) INTO v_current FROM public.prestataires WHERE user_id = p_user_id;
    ELSE v_current := 0; END IF;
    SELECT COALESCE(sum(quantity),0) INTO v_reserved FROM public.quota_reservations WHERE user_id = p_user_id AND resource = v_resource AND status = 'reserved' AND expires_at > v_now;
    IF v_limit IS NOT NULL AND v_current + v_reserved + p_quantity > v_limit THEN RAISE EXCEPTION 'Quota de plan atteint pour %',v_resource; END IF;
    INSERT INTO public.quota_reservations(user_id,resource,quantity,idempotency_key,expires_at,metadata) VALUES(p_user_id,v_resource,p_quantity,v_key,v_now + p_ttl,COALESCE(p_metadata,'{}'::jsonb)) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

ALTER FUNCTION "public"."reserve_quota"("p_user_id" "uuid", "p_resource" "text", "p_quantity" integer, "p_idempotency_key" "text", "p_ttl" interval, "p_metadata" "jsonb") OWNER TO "postgres";


-- ============================================================
-- (e) Idempotence / opt-out
--
-- Relire ce fichier une seconde fois ne change rien :
--   * ADD COLUMN IF NOT EXISTS                    (a)
--   * garde pg_constraint avant ADD CONSTRAINT    (a)
--   * VALIDATE CONDITIONNEL (convalidated = false)(a)
--   * INSERT ... ON CONFLICT (code) DO UPDATE     (b)
--   * UPDATE ... WHERE <colonne> IS NULL          (b)
--   * CREATE OR REPLACE FUNCTION                 (c, d)
--   * DROP TRIGGER IF EXISTS + CREATE OR REPLACE
--     TRIGGER                                    (c)
--   * ALTER ... OWNER TO postgres                (d)
--
-- Aucune ligne existante n'est supprimée : aucune écriture n'est
-- exécutée contre une base (aucun supabase db push / psql), aucun
-- fichier JS/HTML n'est modifié, aucun test n'est adapté ici.
--
-- Opt-out du seul essai (si l'équipe préfère repasser la campagne
-- de tests au vert avant tout) :
--   DROP TRIGGER IF EXISTS mim_trial_subscription_on_signup ON public.profiles;
-- Les sections (a), (b) et (d) restent alors en place.
-- ============================================================
