-- ===================================================================
-- MIM - Schéma de référence (dump schema-only du schéma public).
--
-- FICHIER GÉNÉRÉ : ne pas l'éditer à la main.
-- Régénération après toute migration :
--     node server/scripts/dump-schema.mjs
--
-- Source      : base locale (supabase_db_MIM, base postgres)
-- Étendue     : schéma public uniquement (+ server/schema-tail.sql)
-- Usage       : server/run-schema.mjs (poussée explicite, verrouillée)
-- Contrôles   : server/scripts/quality.mjs (mode lint)
-- ===================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
-- (audit F8) « SET row_security = off » volontairement absent : le
-- reste du fichier est du DDL pur, exécuté par un rôle BYPASSRLS.
--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: activate_subscription_payment(bigint, text, timestamp with time zone, numeric, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.activate_subscription_payment(p_payment_id bigint, p_transaction_id text DEFAULT NULL::text, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_expected_amount numeric DEFAULT NULL::numeric, p_currency text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_payment public.abonnement_paiements%ROWTYPE; v_plan public.plans%ROWTYPE; v_sub public.subscriptions%ROWTYPE; v_now timestamptz := clock_timestamp(); v_paid timestamptz; v_start timestamptz; v_expiry timestamptz; v_duration integer; v_id uuid; v_tx text; v_cur text;
BEGIN
    SELECT * INTO v_payment FROM public.abonnement_paiements WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Paiement introuvable.'; END IF;
    IF v_payment.statut = 'paid' THEN SELECT id INTO v_id FROM public.subscriptions WHERE user_id = v_payment.user_id; IF NOT FOUND THEN RAISE EXCEPTION 'Abonnement manquant.'; END IF; RETURN v_id; END IF;
    IF v_payment.statut <> 'pending' THEN RAISE EXCEPTION 'Paiement non pending.'; END IF;
    SELECT * INTO v_plan FROM public.plans WHERE code = lower(btrim(v_payment.plan)) AND actif = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan inactif.'; END IF;
    IF p_expected_amount IS NOT NULL AND v_payment.montant IS DISTINCT FROM p_expected_amount THEN RAISE EXCEPTION 'Montant invalide.'; END IF;
    -- Prix figé à la commande (prix_plan) : un changement de catalogue
    -- entre le checkout et l'encaissement ne doit pas bloquer un
    -- paiement légitime. À défaut de prix figé (lignes antérieures),
    -- on retombe sur l'ancienne comparaison au catalogue courant.
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' THEN
        IF v_payment.prix_plan IS NOT NULL THEN
            IF v_payment.montant IS DISTINCT FROM v_payment.prix_plan THEN RAISE EXCEPTION 'Montant plan invalide.'; END IF;
        ELSIF v_payment.montant IS DISTINCT FROM v_plan.prix THEN
            RAISE EXCEPTION 'Montant plan invalide.';
        END IF;
    END IF;
    v_cur := upper(COALESCE(NULLIF(btrim(p_currency),''),upper(btrim(v_payment.devise)),upper(btrim(v_plan.devise))));
    IF upper(btrim(v_payment.devise)) <> v_cur OR upper(btrim(v_plan.devise)) <> v_cur THEN RAISE EXCEPTION 'Devise invalide.'; END IF;
    v_duration := COALESCE(v_payment.duree_abonnement,v_plan.duree_abonnement);
    IF v_duration < 1 OR v_duration > 36 THEN RAISE EXCEPTION 'Duree invalide.'; END IF;
    v_tx := COALESCE(NULLIF(btrim(p_transaction_id),''),NULLIF(btrim(v_payment.transaction_id),''));
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' AND v_tx IS NULL THEN RAISE EXCEPTION 'Transaction absente.'; END IF;
    IF v_payment.transaction_id IS NOT NULL AND v_payment.transaction_id <> v_tx THEN RAISE EXCEPTION 'Transaction incoherente.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_payment.user_id::text || ':subscription',0));
    SELECT * INTO v_sub FROM public.subscriptions WHERE user_id = v_payment.user_id FOR UPDATE;
    v_paid := COALESCE(p_paid_at,v_now);
    v_start := CASE WHEN v_sub.id IS NOT NULL AND v_sub.date_expiration > v_now THEN v_sub.date_expiration ELSE v_now END;
    v_expiry := v_start + make_interval(months => v_duration);
    INSERT INTO public.subscriptions(user_id,plan,plan_id,statut,date_debut,date_expiration,date_paiement,montant,methode_paiement,reference,bictorys_transaction_id,bictorys_reference,duree_abonnement,updated_at)
    VALUES(v_payment.user_id,v_plan.code,v_plan.id,'actif',COALESCE(v_sub.date_debut,v_start),v_expiry,v_paid,v_payment.montant,v_payment.methode_paiement,v_payment.reference,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_tx ELSE NULL END,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_payment.reference ELSE NULL END,v_duration,v_now)
    ON CONFLICT (user_id) DO UPDATE SET plan=EXCLUDED.plan,plan_id=EXCLUDED.plan_id,statut='actif',date_expiration=EXCLUDED.date_expiration,date_paiement=EXCLUDED.date_paiement,montant=EXCLUDED.montant,methode_paiement=EXCLUDED.methode_paiement,reference=EXCLUDED.reference,bictorys_transaction_id=EXCLUDED.bictorys_transaction_id,bictorys_reference=EXCLUDED.bictorys_reference,duree_abonnement=EXCLUDED.duree_abonnement,updated_at=EXCLUDED.updated_at
    RETURNING id INTO v_id;
    UPDATE public.abonnement_paiements SET statut='paid',transaction_id=COALESCE(v_tx,transaction_id),date_paiement=v_paid,updated_at=v_now WHERE id=p_payment_id AND statut='pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Conflit de paiement.'; END IF;
    RETURN v_id;
END;
$$;


ALTER FUNCTION public.activate_subscription_payment(p_payment_id bigint, p_transaction_id text, p_paid_at timestamp with time zone, p_expected_amount numeric, p_currency text) OWNER TO postgres;

--
-- Name: consume_quota(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.consume_quota(p_reservation_id uuid, p_user_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_user uuid; v_resource text; v_status text; v_expiry timestamptz; v_now timestamptz := clock_timestamp();
BEGIN
    SELECT user_id,resource,status,expires_at INTO v_user,v_resource,v_status,v_expiry FROM public.quota_reservations WHERE id = p_reservation_id; IF NOT FOUND THEN RAISE EXCEPTION 'Reservation introuvable.'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_user THEN RAISE EXCEPTION 'Reservation invalide.'; END IF;
    IF v_status = 'consumed' THEN RETURN true; END IF;
    IF v_status <> 'reserved' OR v_expiry <= v_now THEN RAISE EXCEPTION 'Reservation expiree.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_resource,0));
    UPDATE public.quota_reservations SET status = 'consumed',consumed_at = v_now,updated_at = v_now WHERE id = p_reservation_id AND status = 'reserved';
    RETURN true;
END;
$$;


ALTER FUNCTION public.consume_quota(p_reservation_id uuid, p_user_id uuid) OWNER TO postgres;

--
-- Name: consume_tenant_invitation(text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.consume_tenant_invitation(p_token_hash text, p_account_uid uuid) RETURNS TABLE(invitation_id uuid, owner_id uuid, tenant_id bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_inv public.tenant_invitations%ROWTYPE;
    v_tenant public.locataires%ROWTYPE;
    v_now timestamptz := clock_timestamp();
BEGIN
    SELECT * INTO v_inv FROM public.tenant_invitations WHERE token_hash = btrim(p_token_hash) AND revoked_at IS NULL AND expires_at > v_now AND usage_count < max_uses FOR UPDATE;
    IF NOT FOUND OR p_account_uid IS NULL THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    SELECT * INTO v_tenant FROM public.locataires WHERE id = v_inv.locataire_id AND superseded_at IS NULL FOR UPDATE;
    IF NOT FOUND OR (v_tenant.account_uid IS NOT NULL AND v_tenant.account_uid <> p_account_uid) THEN RAISE EXCEPTION 'Fiche indisponible.'; END IF;
    UPDATE public.tenant_invitations SET usage_count = usage_count + 1, used_at = CASE WHEN usage_count + 1 >= max_uses THEN v_now ELSE used_at END, last_used_at = v_now, account_uid = COALESCE(account_uid,p_account_uid), updated_at = v_now WHERE id = v_inv.id;
    UPDATE public.locataires SET account_uid = p_account_uid WHERE id = v_tenant.id AND (account_uid IS NULL OR account_uid = p_account_uid);
    IF NOT FOUND THEN RAISE EXCEPTION 'Liaison impossible.'; END IF;
    RETURN QUERY SELECT v_inv.id,v_inv.user_id,v_inv.locataire_id;
END;
$$;


ALTER FUNCTION public.consume_tenant_invitation(p_token_hash text, p_account_uid uuid) OWNER TO postgres;

--
-- Name: create_tenant_invitation(uuid, bigint, text, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.create_tenant_invitation(p_user_id uuid, p_locataire_id bigint, p_token_hash text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_max_uses integer DEFAULT 1) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_id uuid;
    v_now timestamptz := clock_timestamp();
    v_expiry timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_locataire_id IS NULL OR length(btrim(COALESCE(p_token_hash,''))) < 32 OR p_max_uses < 1 OR p_max_uses > 10 THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    v_expiry := COALESCE(p_expires_at,v_now + interval '7 days');
    IF v_expiry <= v_now OR v_expiry > v_now + interval '30 days' THEN RAISE EXCEPTION 'Expiration invalide.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.locataires l WHERE l.id = p_locataire_id AND l.user_id = p_user_id AND l.superseded_at IS NULL) THEN RAISE EXCEPTION 'Fiche locataire invalide.'; END IF;
    UPDATE public.tenant_invitations SET revoked_at = v_now, updated_at = v_now WHERE user_id = p_user_id AND locataire_id = p_locataire_id AND revoked_at IS NULL AND usage_count < max_uses;
    INSERT INTO public.tenant_invitations (token_hash,user_id,locataire_id,expires_at,max_uses) VALUES (btrim(p_token_hash),p_user_id,p_locataire_id,v_expiry,p_max_uses) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;


ALTER FUNCTION public.create_tenant_invitation(p_user_id uuid, p_locataire_id bigint, p_token_hash text, p_expires_at timestamp with time zone, p_max_uses integer) OWNER TO postgres;

--
-- Name: employes_biens_owner_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.employes_biens_owner_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_employee_owner uuid;
    v_bien_owner uuid;
BEGIN
    SELECT user_id INTO v_employee_owner FROM public.employes WHERE id = NEW.employe_id;
    SELECT user_id INTO v_bien_owner FROM public.biens WHERE id = NEW.bien_id;
    IF v_employee_owner IS NULL OR v_bien_owner IS NULL OR v_employee_owner IS DISTINCT FROM NEW.user_id OR v_bien_owner IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'Employe et bien doivent avoir le meme proprietaire.';
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.employes_biens_owner_guard() OWNER TO postgres;

--
-- Name: guard_public_auth_metadata(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.guard_public_auth_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_role text;
    v_type text;
BEGIN
    v_role := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'role','')));
    v_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'account_type','')));
    IF v_role IN ('admin','ultra_admin','employe','locataire','entreprise')
       OR (v_type <> '' AND v_type NOT IN ('proprietaire','agence')) THEN
        RAISE EXCEPTION 'Les rôles privilégiés doivent être fournis par le serveur.';
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_public_auth_metadata() OWNER TO postgres;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_public_role text;
    v_public_type text;
    v_app_type text;
    v_account_type text;
    v_must_change text;
BEGIN
    v_public_role := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'role', '')));
    v_public_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'account_type', '')));
    IF v_public_role IN ('admin','ultra_admin','employe','locataire','entreprise')
       OR (v_public_type <> '' AND v_public_type NOT IN ('proprietaire','agence')) THEN
        RAISE EXCEPTION 'Type de compte public invalide.';
    END IF;
    v_app_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_account_type', '')));
    v_account_type := COALESCE(NULLIF(v_app_type, ''), NULLIF(v_public_type, ''), 'proprietaire');
    IF v_account_type NOT IN ('proprietaire','agence','entreprise','locataire','employe','admin','ultra_admin') THEN
        RAISE EXCEPTION 'Type de compte invalide.';
    END IF;
    v_must_change := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_must_change_password','')));
    IF v_must_change NOT IN ('','true','false','1','0') THEN
        RAISE EXCEPTION 'Valeur de rotation invalide.';
    END IF;
    INSERT INTO public.profiles (id,account_type,name,email,phone,role,username,must_change_password)
    VALUES (NEW.id,v_account_type,COALESCE(NEW.raw_user_meta_data ->> 'name',''),COALESCE(NEW.email,''),COALESCE(NEW.raw_user_meta_data ->> 'phone',''),v_account_type,NULLIF(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'username','')),''),COALESCE(v_must_change IN ('true','1'),false))
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

--
-- Name: mim_trial_subscription_on_signup(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.mim_trial_subscription_on_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_type text;
    v_plan_id uuid;
    v_now timestamptz;
BEGIN
    v_type := pg_catalog.lower(pg_catalog.btrim(COALESCE(NEW.account_type, '')));

    IF v_type IN ('proprietaire', 'agence', 'entreprise') THEN
        SELECT id INTO v_plan_id FROM public.plans WHERE code = 'essai' AND actif = true;
        IF v_plan_id IS NULL THEN
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
    END IF;

    -- Type non éligible (locataire, employe, admin, ultra_admin ou
    -- type invalide corrigé plus tard) : on efface l'essai créé
    -- pendant la fenêtre où account_type valait encore le défaut.
    BEGIN
        DELETE FROM public.subscriptions
         WHERE user_id = NEW.id
           AND reference = 'essai-automatique';
    EXCEPTION WHEN others THEN
        RAISE WARNING 'nettoyage de l''essai automatique impossible pour le profil % - %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.mim_trial_subscription_on_signup() OWNER TO postgres;

--
-- Name: FUNCTION mim_trial_subscription_on_signup(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.mim_trial_subscription_on_signup() IS 'Essai gratuit de 14 jours (plan « essai ») pour un compte propriétaire / agence / entreprise, créé dès que account_type est fiable (INSERT ou UPDATE). Pour tout autre type, retire un essai automatique résiduel. Jamais bloquant : chaque erreur est un WARNING.';


--
-- Name: notifications_outbox_flush(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.notifications_outbox_flush(p_limit integer DEFAULT 50) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    r RECORD;
    v_n INTEGER := 0;
    v_limit INTEGER := 50;
BEGIN
    IF p_limit IS NOT NULL AND p_limit >= 1 AND p_limit <= 500 THEN
        v_limit := p_limit;
    END IF;

    DELETE FROM public.notifications_outbox
     WHERE (delivered_at IS NOT NULL AND delivered_at < clock_timestamp() - interval '7 days')
        OR (attempts >= 8 AND created_at < clock_timestamp() - interval '7 days');

    FOR r IN
        SELECT id, user_id, type, message, attempts
        FROM public.notifications_outbox
        WHERE delivered_at IS NULL
          AND next_attempt_at <= clock_timestamp()
          AND attempts < 8
        ORDER BY created_at
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            INSERT INTO public.notifications (user_id, type, message)
            VALUES (r.user_id, r.type, r.message);
            UPDATE public.notifications_outbox
               SET delivered_at = clock_timestamp()
             WHERE id = r.id;
            v_n := v_n + 1;
        EXCEPTION WHEN OTHERS THEN
            UPDATE public.notifications_outbox
               SET attempts = attempts + 1,
                   last_error = SQLERRM,
                   next_attempt_at = clock_timestamp()
                       + (interval '30 seconds' * power(2, LEAST(r.attempts, 6)))
             WHERE id = r.id;
        END;
    END LOOP;

    RETURN v_n;
END;
$$;


ALTER FUNCTION public.notifications_outbox_flush(p_limit integer) OWNER TO postgres;

--
-- Name: rate_limit_bump(text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.rate_limit_bump(p_key text, p_window_ms integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_window INTERVAL;
    v_count INTEGER;
    v_start TIMESTAMPTZ;
BEGIN
    IF p_key IS NULL OR length(p_key) < 1 OR length(p_key) > 200 THEN
        RAISE EXCEPTION 'Cle de rate limit invalide.';
    END IF;
    IF p_window_ms IS NULL OR p_window_ms < 1000 OR p_window_ms > 3600000 THEN
        RAISE EXCEPTION 'Fen??tre de rate limit invalide.';
    END IF;

    v_window := make_interval(secs => p_window_ms / 1000.0);

    INSERT INTO public.rate_limit_buckets AS b (key, window_start, count)
    VALUES (p_key, v_now, 1)
    ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN v_now - b.window_start >= v_window THEN 1 ELSE b.count + 1 END,
            window_start = CASE WHEN v_now - b.window_start >= v_window THEN v_now ELSE b.window_start END
    RETURNING b.count, b.window_start
    INTO v_count, v_start;

    RETURN jsonb_build_object('count', v_count, 'window_start', v_start);
END;
$$;


ALTER FUNCTION public.rate_limit_bump(p_key text, p_window_ms integer) OWNER TO postgres;

--
-- Name: record_manual_subscription_payment(uuid, text, numeric, text, text, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.record_manual_subscription_payment(p_user_id uuid, p_plan_code text, p_amount numeric, p_reference text, p_method text DEFAULT 'especes'::text, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_duration integer DEFAULT NULL::integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_plan public.plans%ROWTYPE; v_now timestamptz := clock_timestamp(); v_ref text; v_id bigint; v_duration integer; v_paid timestamptz := COALESCE(p_paid_at,clock_timestamp());
BEGIN
    IF p_user_id IS NULL OR p_plan_code IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 999999999999.99 THEN RAISE EXCEPTION 'Paiement invalide.'; END IF;
    v_ref := btrim(COALESCE(p_reference,'')); IF length(v_ref) < 3 OR length(v_ref) > 200 THEN RAISE EXCEPTION 'Reference invalide.'; END IF;
    IF COALESCE(p_method,'') NOT IN ('especes','mobile_money','virement','carte','wave','orange_money') THEN RAISE EXCEPTION 'Methode invalide.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':manual-subscription',0));
    SELECT * INTO v_plan FROM public.plans WHERE code = lower(btrim(p_plan_code)) AND actif = true; IF NOT FOUND THEN RAISE EXCEPTION 'Plan inactif.'; END IF;
    v_duration := COALESCE(p_duration,v_plan.duree_abonnement); IF v_duration < 1 OR v_duration > 36 THEN RAISE EXCEPTION 'Duree invalide.'; END IF;
    SELECT id INTO v_id FROM public.abonnement_paiements WHERE user_id=p_user_id AND provider='manuel' AND superseded_at IS NULL AND (reference=v_ref OR idempotency_key=v_ref) ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN IF EXISTS (SELECT 1 FROM public.abonnement_paiements WHERE id=v_id AND plan=v_plan.code AND montant=p_amount) THEN PERFORM public.activate_subscription_payment(v_id,NULL,v_paid,p_amount,v_plan.devise); RETURN v_id; END IF; RAISE EXCEPTION 'Reference deja utilisee.'; END IF;
    INSERT INTO public.abonnement_paiements(user_id,plan,montant,date_paiement,date_debut,date_expiration,methode_paiement,reference,devise,provider,statut,idempotency_key,duree_abonnement,updated_at)
    VALUES(p_user_id,v_plan.code,p_amount,v_paid,v_paid,v_paid + make_interval(months=>v_duration),p_method,v_ref,v_plan.devise,'manuel','pending',v_ref,v_duration,v_now) RETURNING id INTO v_id;
    PERFORM public.activate_subscription_payment(v_id,NULL,v_paid,p_amount,v_plan.devise);
    RETURN v_id;
END;
$$;


ALTER FUNCTION public.record_manual_subscription_payment(p_user_id uuid, p_plan_code text, p_amount numeric, p_reference text, p_method text, p_paid_at timestamp with time zone, p_duration integer) OWNER TO postgres;

--
-- Name: release_quota(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.release_quota(p_reservation_id uuid, p_user_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_user uuid; v_resource text; v_now timestamptz := clock_timestamp();
BEGIN
    SELECT user_id,resource INTO v_user,v_resource FROM public.quota_reservations WHERE id = p_reservation_id; IF NOT FOUND THEN RETURN false; END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_user THEN RAISE EXCEPTION 'Reservation invalide.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_resource,0));
    UPDATE public.quota_reservations SET status = CASE WHEN status = 'consumed' THEN status ELSE 'released' END,released_at = CASE WHEN status = 'consumed' THEN released_at ELSE v_now END,updated_at = v_now WHERE id = p_reservation_id;
    RETURN true;
END;
$$;


ALTER FUNCTION public.release_quota(p_reservation_id uuid, p_user_id uuid) OWNER TO postgres;

--
-- Name: reserve_quota(uuid, text, integer, text, interval, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.reserve_quota(p_user_id uuid, p_resource text, p_quantity integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_ttl interval DEFAULT '00:15:00'::interval, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.reserve_quota(p_user_id uuid, p_resource text, p_quantity integer, p_idempotency_key text, p_ttl interval, p_metadata jsonb) OWNER TO postgres;

--
-- Name: sync_locataire_bien_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.sync_locataire_bien_id() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


ALTER FUNCTION public.sync_locataire_bien_id() OWNER TO postgres;

--
-- Name: sync_profile_account_type(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.sync_profile_account_type() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_type text;
    v_must text;
BEGIN
    v_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_account_type', '')));
    IF v_type NOT IN ('proprietaire','agence','entreprise','locataire','employe','admin','ultra_admin') THEN
        RETURN NEW;
    END IF;

    v_must := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_must_change_password', '')));

    UPDATE public.profiles
       SET account_type = v_type,
           role = v_type,
           must_change_password = CASE
               WHEN v_must IN ('true','1') THEN true
               WHEN v_must IN ('false','0') THEN false
               ELSE public.profiles.must_change_password
           END
     WHERE id = NEW.id
       AND public.profiles.account_type IS DISTINCT FROM v_type;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.sync_profile_account_type() OWNER TO postgres;

--
-- Name: tenant_invitations_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION public.tenant_invitations_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.locataires l WHERE l.id = NEW.locataire_id AND l.user_id = NEW.user_id AND l.superseded_at IS NULL) THEN RAISE EXCEPTION 'Fiche locataire invalide.'; END IF;
    IF length(pg_catalog.btrim(NEW.token_hash)) < 32 OR NEW.expires_at <= pg_catalog.clock_timestamp() OR NEW.max_uses < 1 OR NEW.usage_count < 0 OR NEW.usage_count > NEW.max_uses THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.tenant_invitations_guard() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abonnement_paiements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.abonnement_paiements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    plan text NOT NULL,
    montant numeric(12,2) NOT NULL,
    date_paiement timestamp with time zone DEFAULT now(),
    methode_paiement text,
    reference text,
    date_debut timestamp with time zone DEFAULT now() NOT NULL,
    date_expiration timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    devise text DEFAULT 'XOF'::text NOT NULL,
    provider text DEFAULT 'manuel'::text,
    transaction_id text,
    statut text DEFAULT 'pending'::text NOT NULL,
    raw_response jsonb,
    updated_at timestamp with time zone,
    idempotency_key text,
    duree_abonnement integer,
    superseded_at timestamp with time zone,
    prix_plan numeric,
    CONSTRAINT abonnement_paiements_duration_ck CHECK (((duree_abonnement IS NULL) OR ((duree_abonnement >= 1) AND (duree_abonnement <= 36)))),
    CONSTRAINT abonnement_paiements_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text, 'bictorys'::text])))),
    CONSTRAINT abonnement_paiements_montant_ck CHECK ((montant > (0)::numeric)),
    CONSTRAINT abonnement_paiements_prix_plan_ck CHECK (((prix_plan IS NULL) OR (prix_plan >= (0)::numeric))),
    CONSTRAINT abonnement_paiements_statut_check CHECK ((statut = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'cancelled'::text])))
);


ALTER TABLE public.abonnement_paiements OWNER TO postgres;

--
-- Name: COLUMN abonnement_paiements.prix_plan; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.abonnement_paiements.prix_plan IS 'Prix du plan au moment de la création du checkout (écrit par le serveur). Permet d''activer un paiement engagé à l''ancien prix après un changement de catalogue. NULL = ligne antérieure à la migration (comparaison au catalogue courant).';


--
-- Name: abonnement_paiements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.abonnement_paiements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.abonnement_paiements_id_seq OWNER TO postgres;

--
-- Name: abonnement_paiements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.abonnement_paiements_id_seq OWNED BY public.abonnement_paiements.id;


--
-- Name: account_recovery_emails; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.account_recovery_emails (
    user_id uuid NOT NULL,
    email text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.account_recovery_emails FORCE ROW LEVEL SECURITY;


ALTER TABLE public.account_recovery_emails OWNER TO postgres;

--
-- Name: agences_biens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agences_biens (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    agence_id uuid NOT NULL,
    proprietaire_id uuid NOT NULL,
    bien_id bigint NOT NULL,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agences_biens_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'retire'::text])))
);

ALTER TABLE ONLY public.agences_biens FORCE ROW LEVEL SECURITY;


ALTER TABLE public.agences_biens OWNER TO postgres;

--
-- Name: agences_biens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.agences_biens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.agences_biens_id_seq OWNER TO postgres;

--
-- Name: agences_biens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.agences_biens_id_seq OWNED BY public.agences_biens.id;


--
-- Name: agences_proprietaires; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agences_proprietaires (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    agence_id uuid NOT NULL,
    proprietaire_id uuid NOT NULL,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoque_par uuid,
    motif text,
    updated_at timestamp with time zone,
    CONSTRAINT agences_proprietaires_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'inactif'::text])))
);

ALTER TABLE ONLY public.agences_proprietaires FORCE ROW LEVEL SECURITY;


ALTER TABLE public.agences_proprietaires OWNER TO postgres;

--
-- Name: COLUMN agences_proprietaires.revoque_par; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agences_proprietaires.revoque_par IS 'Compte (agence ou proprietaire) a l''origine de la derniere suspension : seul ce compte peut reactiver.';


--
-- Name: COLUMN agences_proprietaires.motif; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agences_proprietaires.motif IS 'Motif saisi lors de la derniere transition de statut (obligatoire).';


--
-- Name: COLUMN agences_proprietaires.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agences_proprietaires.updated_at IS 'Horodatage de la derniere transition de statut.';


--
-- Name: agences_proprietaires_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.agences_proprietaires_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.agences_proprietaires_id_seq OWNER TO postgres;

--
-- Name: agences_proprietaires_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.agences_proprietaires_id_seq OWNED BY public.agences_proprietaires.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.announcements (
    id bigint NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcements_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'owners'::text, 'tenants'::text, 'employees'::text, 'admins'::text]))),
    CONSTRAINT announcements_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.announcements FORCE ROW LEVEL SECURITY;


ALTER TABLE public.announcements OWNER TO postgres;

--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.announcements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.announcements_id_seq OWNER TO postgres;

--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    user_id uuid,
    action text NOT NULL,
    target_id text,
    target_type text,
    level text DEFAULT 'info'::text NOT NULL,
    meta jsonb,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_logs_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warn'::text, 'critical'::text])))
);

ALTER TABLE ONLY public.audit_logs FORCE ROW LEVEL SECURITY;


ALTER TABLE public.audit_logs OWNER TO postgres;

--
-- Name: COLUMN audit_logs.user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.audit_logs.user_id IS 'Rétention : NULL lorsque le compte source a été supprimé (ON DELETE SET NULL, migration audit_corrections 20260927). La ligne de journal est conservée ; seul service_role en a le privilège SELECT (RLS admin_read_audit_logs limite en plus la lecture à admin/ultra_admin).';


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_logs_id_seq OWNER TO postgres;

--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: bictorys_webhooks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bictorys_webhooks (
    id bigint NOT NULL,
    event_id text,
    merchant_id text,
    type text,
    status text,
    amount numeric(12,2),
    currency text,
    payment_reference text,
    merchant_reference text,
    payload jsonb NOT NULL,
    fingerprint text NOT NULL,
    handled boolean DEFAULT false NOT NULL,
    handled_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.bictorys_webhooks FORCE ROW LEVEL SECURITY;


ALTER TABLE public.bictorys_webhooks OWNER TO postgres;

--
-- Name: bictorys_webhooks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.bictorys_webhooks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bictorys_webhooks_id_seq OWNER TO postgres;

--
-- Name: bictorys_webhooks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.bictorys_webhooks_id_seq OWNED BY public.bictorys_webhooks.id;


--
-- Name: biens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.biens (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    nom text NOT NULL,
    type text NOT NULL,
    adresse text,
    ville text,
    pays text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.biens REPLICA IDENTITY FULL;


ALTER TABLE public.biens OWNER TO postgres;

--
-- Name: biens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.biens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.biens_id_seq OWNER TO postgres;

--
-- Name: biens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.biens_id_seq OWNED BY public.biens.id;


--
-- Name: depenses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.depenses (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    bien_id bigint NOT NULL,
    logement_id bigint,
    libelle text NOT NULL,
    montant numeric(12,2) NOT NULL,
    categorie text DEFAULT 'autre'::text NOT NULL,
    date_depense date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT depenses_categorie_check CHECK ((categorie = ANY (ARRAY['entretien'::text, 'travaux'::text, 'assurance'::text, 'charges'::text, 'taxe'::text, 'autre'::text]))),
    CONSTRAINT depenses_montant_check CHECK ((montant >= (0)::numeric))
);


ALTER TABLE public.depenses OWNER TO postgres;

--
-- Name: depenses_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.depenses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.depenses_id_seq OWNER TO postgres;

--
-- Name: depenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.depenses_id_seq OWNED BY public.depenses.id;


--
-- Name: employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    account_uid uuid,
    username text,
    nom text NOT NULL,
    poste text,
    salaire numeric(12,2) DEFAULT 0 NOT NULL,
    email text,
    phone text,
    date_embauche date,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT employes_salaire_nonnegative_ck CHECK ((salaire >= (0)::numeric)),
    CONSTRAINT employes_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'inactif'::text])))
);

ALTER TABLE ONLY public.employes REPLICA IDENTITY FULL;


ALTER TABLE public.employes OWNER TO postgres;

--
-- Name: COLUMN employes.salaire; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.employes.salaire IS 'Paie : lisible uniquement par le propriétaire/agence/entreprise qui possède la fiche (owner_all_employes) et par l''employé concerné (employe_select_own_employe) ; jamais par un compte locataire (policy restrictive restrict_no_locataire_employes).';


--
-- Name: employes_biens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employes_biens (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_id bigint NOT NULL,
    bien_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.employes_biens FORCE ROW LEVEL SECURITY;


ALTER TABLE public.employes_biens OWNER TO postgres;

--
-- Name: employes_biens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.employes_biens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.employes_biens_id_seq OWNER TO postgres;

--
-- Name: employes_biens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.employes_biens_id_seq OWNED BY public.employes_biens.id;


--
-- Name: employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.employes_id_seq OWNER TO postgres;

--
-- Name: employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.employes_id_seq OWNED BY public.employes.id;


--
-- Name: featured_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.featured_items (
    id bigint NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    badge text,
    priority integer DEFAULT 0 NOT NULL,
    featured_until timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT featured_items_target_type_check CHECK ((target_type = ANY (ARRAY['user'::text, 'bien'::text, 'logement'::text, 'announcement'::text, 'event'::text])))
);

ALTER TABLE ONLY public.featured_items FORCE ROW LEVEL SECURITY;


ALTER TABLE public.featured_items OWNER TO postgres;

--
-- Name: featured_items_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.featured_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.featured_items_id_seq OWNER TO postgres;

--
-- Name: featured_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.featured_items_id_seq OWNED BY public.featured_items.id;


--
-- Name: import_drafts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.import_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_checksum text NOT NULL,
    usernames jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.import_drafts OWNER TO postgres;

--
-- Name: import_run_rows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.import_run_rows (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    row_number integer NOT NULL,
    source_row_hash text NOT NULL,
    entity_type text,
    entity_id bigint,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb,
    error_message text,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT import_run_rows_number_ck CHECK ((row_number > 0)),
    CONSTRAINT import_run_rows_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'created'::text, 'updated'::text, 'skipped'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.import_run_rows FORCE ROW LEVEL SECURITY;


ALTER TABLE public.import_run_rows OWNER TO postgres;

--
-- Name: import_run_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.import_run_rows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.import_run_rows_id_seq OWNER TO postgres;

--
-- Name: import_run_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.import_run_rows_id_seq OWNED BY public.import_run_rows.id;


--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    idempotency_key text,
    source_filename text,
    source_checksum text,
    status text DEFAULT 'running'::text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    created_rows integer DEFAULT 0 NOT NULL,
    updated_rows integer DEFAULT 0 NOT NULL,
    skipped_rows integer DEFAULT 0 NOT NULL,
    error_message text,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT import_runs_counters_ck CHECK (((total_rows >= 0) AND (processed_rows >= 0) AND (created_rows >= 0) AND (updated_rows >= 0) AND (skipped_rows >= 0))),
    CONSTRAINT import_runs_status_ck CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'aborted'::text])))
);

ALTER TABLE ONLY public.import_runs FORCE ROW LEVEL SECURITY;


ALTER TABLE public.import_runs OWNER TO postgres;

--
-- Name: incidents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.incidents (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    logement_id bigint,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'nouveau'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    photo text,
    resolved_by bigint,
    resolved_at timestamp with time zone,
    CONSTRAINT incidents_statut_check CHECK ((statut = ANY (ARRAY['nouveau'::text, 'en_cours'::text, 'intervention'::text, 'resolu'::text])))
);

ALTER TABLE ONLY public.incidents REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.incidents FORCE ROW LEVEL SECURITY;


ALTER TABLE public.incidents OWNER TO postgres;

--
-- Name: incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.incidents_id_seq OWNER TO postgres;

--
-- Name: incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.incidents_id_seq OWNED BY public.incidents.id;


--
-- Name: interventions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.interventions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    incident_id bigint,
    prestataire_id bigint,
    logement_id bigint,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'planifie'::text NOT NULL,
    date_prevue date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interventions_statut_check CHECK ((statut = ANY (ARRAY['planifie'::text, 'en_cours'::text, 'termine'::text])))
);

ALTER TABLE ONLY public.interventions REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.interventions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.interventions OWNER TO postgres;

--
-- Name: interventions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.interventions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.interventions_id_seq OWNER TO postgres;

--
-- Name: interventions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.interventions_id_seq OWNED BY public.interventions.id;


--
-- Name: locataires; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.locataires (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    account_uid uuid,
    logement_id bigint,
    nom text NOT NULL,
    email text,
    phone text,
    date_entree date,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    jour_echeance integer DEFAULT 1,
    bien_id bigint,
    superseded_at timestamp with time zone,
    CONSTRAINT locataires_jour_ck CHECK (((jour_echeance IS NULL) OR ((jour_echeance >= 1) AND (jour_echeance <= 31)))),
    CONSTRAINT locataires_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'inactif'::text])))
);

ALTER TABLE ONLY public.locataires REPLICA IDENTITY FULL;


ALTER TABLE public.locataires OWNER TO postgres;

--
-- Name: locataires_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.locataires_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.locataires_id_seq OWNER TO postgres;

--
-- Name: locataires_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.locataires_id_seq OWNED BY public.locataires.id;


--
-- Name: logements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.logements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    bien_id bigint,
    nom text NOT NULL,
    loyer_mensuel numeric(12,2) DEFAULT 0 NOT NULL,
    statut text DEFAULT 'libre'::text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type text,
    nombre_chambres integer,
    adresse text,
    CONSTRAINT logements_chambres_positive_ck CHECK (((nombre_chambres IS NULL) OR (nombre_chambres > 0))),
    CONSTRAINT logements_loyer_positive_ck CHECK (((loyer_mensuel IS NULL) OR (loyer_mensuel > (0)::numeric))),
    CONSTRAINT logements_statut_check CHECK ((statut = ANY (ARRAY['libre'::text, 'occupe'::text, 'maintenance'::text]))),
    CONSTRAINT logements_type_check CHECK (((type IS NULL) OR (type = ANY (ARRAY['appartement'::text, 'chambre'::text]))))
);

ALTER TABLE ONLY public.logements REPLICA IDENTITY FULL;


ALTER TABLE public.logements OWNER TO postgres;

--
-- Name: logements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.logements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.logements_id_seq OWNER TO postgres;

--
-- Name: logements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.logements_id_seq OWNED BY public.logements.id;


--
-- Name: messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.messages (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    agence_id uuid NOT NULL,
    proprietaire_id uuid NOT NULL,
    auteur_id uuid,
    lu_par_destinataire boolean DEFAULT false NOT NULL,
    objet text,
    corps text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.messages REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.messages FORCE ROW LEVEL SECURITY;


ALTER TABLE public.messages OWNER TO postgres;

--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.messages_id_seq OWNER TO postgres;

--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: moyens_paiement; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.moyens_paiement (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    nom_titulaire text,
    numero text,
    lien_paiement text,
    banque text,
    num_compte text,
    iban text,
    bic text,
    instructions text,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT moyens_paiement_lien_https_ck CHECK (((lien_paiement IS NULL) OR (btrim(lien_paiement) = ''::text) OR (lien_paiement ~ '^https://[^[:space:]]+$'::text))),
    CONSTRAINT moyens_paiement_type_check CHECK ((type = ANY (ARRAY['wave'::text, 'orange_money'::text, 'virement'::text, 'especes'::text])))
);

ALTER TABLE ONLY public.moyens_paiement FORCE ROW LEVEL SECURITY;


ALTER TABLE public.moyens_paiement OWNER TO postgres;

--
-- Name: moyens_paiement_employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.moyens_paiement_employes (
    id bigint NOT NULL,
    employe_uid uuid NOT NULL,
    type text NOT NULL,
    nom_titulaire text,
    numero text,
    lien_paiement text,
    banque text,
    num_compte text,
    iban text,
    bic text,
    instructions text,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT moyens_paiement_employes_lien_https_ck CHECK (((lien_paiement IS NULL) OR (btrim(lien_paiement) = ''::text) OR (lien_paiement ~ '^https://[^[:space:]]+$'::text))),
    CONSTRAINT moyens_paiement_employes_type_check CHECK ((type = ANY (ARRAY['wave'::text, 'orange_money'::text, 'virement'::text, 'especes'::text])))
);

ALTER TABLE ONLY public.moyens_paiement_employes FORCE ROW LEVEL SECURITY;


ALTER TABLE public.moyens_paiement_employes OWNER TO postgres;

--
-- Name: moyens_paiement_employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.moyens_paiement_employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.moyens_paiement_employes_id_seq OWNER TO postgres;

--
-- Name: moyens_paiement_employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.moyens_paiement_employes_id_seq OWNED BY public.moyens_paiement_employes.id;


--
-- Name: moyens_paiement_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.moyens_paiement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.moyens_paiement_id_seq OWNER TO postgres;

--
-- Name: moyens_paiement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.moyens_paiement_id_seq OWNED BY public.moyens_paiement.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    lu boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notifications REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


ALTER TABLE public.notifications OWNER TO postgres;

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_id_seq OWNER TO postgres;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: notifications_outbox; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications_outbox (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE public.notifications_outbox OWNER TO postgres;

--
-- Name: notifications_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.notifications_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_outbox_id_seq OWNER TO postgres;

--
-- Name: notifications_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.notifications_outbox_id_seq OWNED BY public.notifications_outbox.id;


--
-- Name: paiements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paiements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    locataire_id bigint,
    logement_id bigint,
    montant numeric(12,2) NOT NULL,
    mois text NOT NULL,
    statut text DEFAULT 'attente'::text NOT NULL,
    date_paiement date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    methode_paiement text,
    reference text,
    validation_requested_at timestamp with time zone,
    validated_at timestamp with time zone,
    validated_by uuid,
    rejection_reason text,
    superseded_at timestamp with time zone,
    CONSTRAINT paiements_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text])))),
    CONSTRAINT paiements_mois_ck CHECK ((mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT paiements_mois_valid_ck CHECK (((mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text) AND ("substring"(mois, 1, 4) <> '0000'::text))),
    CONSTRAINT paiements_montant_ck CHECK ((montant > (0)::numeric)),
    CONSTRAINT paiements_statut_check CHECK ((statut = ANY (ARRAY['attente'::text, 'paye'::text, 'retard'::text, 'a_confirmer'::text, 'en_validation'::text, 'refuse'::text])))
);

ALTER TABLE ONLY public.paiements REPLICA IDENTITY FULL;


ALTER TABLE public.paiements OWNER TO postgres;

--
-- Name: paiements_employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paiements_employes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_id bigint,
    employe_uid uuid,
    montant numeric(12,2) NOT NULL,
    mois text NOT NULL,
    statut text DEFAULT 'attente'::text NOT NULL,
    date_paiement date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    methode_paiement text,
    reference text,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    rejected_at timestamp with time zone,
    rejection_reason text,
    moyen_employe_id bigint,
    superseded_at timestamp with time zone,
    CONSTRAINT paiements_employes_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text])))),
    CONSTRAINT paiements_employes_mois_ck CHECK ((mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT paiements_employes_mois_valid_ck CHECK (((mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text) AND ("substring"(mois, 1, 4) <> '0000'::text))),
    CONSTRAINT paiements_employes_montant_ck CHECK ((montant > (0)::numeric)),
    CONSTRAINT paiements_employes_statut_check CHECK ((statut = ANY (ARRAY['paye'::text, 'attente'::text, 'non_recu'::text])))
);

ALTER TABLE ONLY public.paiements_employes REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.paiements_employes FORCE ROW LEVEL SECURITY;


ALTER TABLE public.paiements_employes OWNER TO postgres;

--
-- Name: paiements_employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paiements_employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.paiements_employes_id_seq OWNER TO postgres;

--
-- Name: paiements_employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paiements_employes_id_seq OWNED BY public.paiements_employes.id;


--
-- Name: paiements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paiements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.paiements_id_seq OWNER TO postgres;

--
-- Name: paiements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paiements_id_seq OWNED BY public.paiements.id;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT password_reset_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'used'::text, 'expired'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.password_reset_tokens FORCE ROW LEVEL SECURITY;


ALTER TABLE public.password_reset_tokens OWNER TO postgres;

--
-- Name: TABLE password_reset_tokens; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.password_reset_tokens IS 'Jetons de récupération de mot de passe (hachés, un usage, 30 min).';


--
-- Name: COLUMN password_reset_tokens.token_hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.password_reset_tokens.token_hash IS 'SHA-256 du jeton brut : le jeton en clair n''est jamais stocké.';


--
-- Name: plans; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    nom text NOT NULL,
    type text DEFAULT 'proprietaire'::text NOT NULL,
    prix numeric(12,2) NOT NULL,
    devise text DEFAULT 'XOF'::text NOT NULL,
    max_immeubles integer NOT NULL,
    duree_abonnement integer DEFAULT 12 NOT NULL,
    description text,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    max_logements integer,
    max_locataires integer,
    audience text DEFAULT 'proprietaire'::text NOT NULL,
    max_employes integer,
    max_prestataires integer,
    CONSTRAINT plans_audience_ck CHECK ((audience = ANY (ARRAY['proprietaire'::text, 'agence'::text]))),
    CONSTRAINT plans_duree_positive CHECK ((duree_abonnement > 0)),
    CONSTRAINT plans_max_employes_ck CHECK (((max_employes IS NULL) OR (max_employes > 0))),
    CONSTRAINT plans_max_immeubles_positive CHECK ((max_immeubles > 0)),
    CONSTRAINT plans_max_locataires_positive CHECK (((max_locataires IS NULL) OR (max_locataires > 0))),
    CONSTRAINT plans_max_logements_positive CHECK (((max_logements IS NULL) OR (max_logements > 0))),
    CONSTRAINT plans_max_prestataires_ck CHECK (((max_prestataires IS NULL) OR (max_prestataires > 0))),
    CONSTRAINT plans_prix_positive CHECK ((prix >= (0)::numeric))
);


ALTER TABLE public.plans OWNER TO postgres;

--
-- Name: COLUMN plans.max_employes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.plans.max_employes IS 'Capacité maximale d''employés du plan (NULL = non plafonné historiquement ; reserve_quota() applique alors son plafond plancher).';


--
-- Name: COLUMN plans.max_prestataires; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.plans.max_prestataires IS 'Capacité maximale de prestataires du plan (NULL = non plafonné historiquement ; reserve_quota() applique alors son plafond plancher).';


--
-- Name: platform_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.platform_events (
    id bigint NOT NULL,
    title text NOT NULL,
    description text,
    event_date timestamp with time zone NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_events_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'owners'::text, 'tenants'::text, 'employees'::text, 'admins'::text]))),
    CONSTRAINT platform_events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.platform_events FORCE ROW LEVEL SECURITY;


ALTER TABLE public.platform_events OWNER TO postgres;

--
-- Name: platform_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.platform_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.platform_events_id_seq OWNER TO postgres;

--
-- Name: platform_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.platform_events_id_seq OWNED BY public.platform_events.id;


--
-- Name: prestataires; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.prestataires (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    nom text NOT NULL,
    specialite text,
    phone text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.prestataires OWNER TO postgres;

--
-- Name: prestataires_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.prestataires_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.prestataires_id_seq OWNER TO postgres;

--
-- Name: prestataires_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.prestataires_id_seq OWNED BY public.prestataires.id;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    account_type text NOT NULL,
    name text NOT NULL,
    email text,
    phone text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    must_change_password boolean DEFAULT false NOT NULL,
    avatar_url text,
    CONSTRAINT profiles_account_type_check CHECK ((account_type = ANY (ARRAY['proprietaire'::text, 'agence'::text, 'entreprise'::text, 'locataire'::text, 'admin'::text, 'employe'::text, 'ultra_admin'::text]))),
    CONSTRAINT profiles_role_account_type_ck CHECK ((role = account_type))
);


ALTER TABLE public.profiles OWNER TO postgres;

--
-- Name: quota_reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quota_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    resource text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    idempotency_key text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    released_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT quota_reservations_expiration_ck CHECK ((expires_at > created_at)),
    CONSTRAINT quota_reservations_quantity_ck CHECK ((quantity > 0)),
    CONSTRAINT quota_reservations_resource_ck CHECK ((resource = ANY (ARRAY['biens'::text, 'logements'::text, 'locataires'::text, 'employes'::text, 'prestataires'::text]))),
    CONSTRAINT quota_reservations_status_ck CHECK ((status = ANY (ARRAY['reserved'::text, 'consumed'::text, 'released'::text, 'expired'::text])))
);


ALTER TABLE public.quota_reservations OWNER TO postgres;

--
-- Name: rate_limit_buckets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rate_limit_buckets (
    key text NOT NULL,
    window_start timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.rate_limit_buckets OWNER TO postgres;

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sessions (
    id bigint NOT NULL,
    user_id uuid,
    action text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    logout_at timestamp with time zone,
    token_hash text,
    absolute_expires_at timestamp with time zone DEFAULT (clock_timestamp() + '7 days'::interval),
    revoked_at timestamp with time zone,
    revoked_reason text,
    supabase_access_token text,
    supabase_refresh_token text,
    supabase_expires_at timestamp with time zone,
    updated_at timestamp with time zone,
    mfa_factor_id text,
    mfa_status text DEFAULT 'pending'::text NOT NULL,
    mfa_attempts integer DEFAULT 0 NOT NULL,
    mfa_processing_at timestamp with time zone,
    CONSTRAINT sessions_mfa_status_ck CHECK ((mfa_status = ANY (ARRAY['pending'::text, 'processing'::text, 'consumed'::text])))
);

ALTER TABLE ONLY public.sessions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.sessions OWNER TO postgres;

--
-- Name: COLUMN sessions.user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.sessions.user_id IS 'Rétention : NULL lorsque le compte a été supprimé (ON DELETE SET NULL, migration audit_corrections 20260927). L''historique de session survit au compte. Table fermée côté client : aucun GRANT hors service_role, qui contourne la RLS, et politique closed_deny_all (USING false) pour tout autre rôle.';


--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.sessions_id_seq OWNER TO postgres;

--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan text DEFAULT 'standard'::text NOT NULL,
    statut text DEFAULT 'actif'::text NOT NULL,
    date_debut timestamp with time zone DEFAULT now() NOT NULL,
    date_expiration timestamp with time zone NOT NULL,
    date_paiement timestamp with time zone,
    montant numeric(12,2),
    methode_paiement text,
    reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_id uuid,
    bictorys_transaction_id text,
    bictorys_reference text,
    duree_abonnement integer,
    CONSTRAINT subscriptions_montant_ck CHECK (((montant IS NULL) OR (montant >= (0)::numeric))),
    CONSTRAINT subscriptions_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'expire'::text, 'pending'::text, 'cancelled'::text, 'failed'::text])))
);


ALTER TABLE public.subscriptions OWNER TO postgres;

--
-- Name: system_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.system_config (
    key text NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.system_config FORCE ROW LEVEL SECURITY;


ALTER TABLE public.system_config OWNER TO postgres;

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_uid uuid,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'a_faire'::text NOT NULL,
    echeance date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasks_statut_check CHECK ((statut = ANY (ARRAY['a_faire'::text, 'en_cours'::text, 'termine'::text])))
);

ALTER TABLE ONLY public.tasks REPLICA IDENTITY FULL;

ALTER TABLE ONLY public.tasks FORCE ROW LEVEL SECURITY;


ALTER TABLE public.tasks OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tasks_id_seq OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: tenant_invitations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tenant_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    locataire_id bigint NOT NULL,
    account_uid uuid,
    expires_at timestamp with time zone NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    max_uses integer DEFAULT 1 NOT NULL,
    used_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT tenant_invitations_expiration_ck CHECK ((expires_at > created_at)),
    CONSTRAINT tenant_invitations_hash_ck CHECK ((length(btrim(token_hash)) >= 32)),
    CONSTRAINT tenant_invitations_usage_ck CHECK (((max_uses > 0) AND (usage_count >= 0) AND (usage_count <= max_uses)))
);


ALTER TABLE public.tenant_invitations OWNER TO postgres;

--
-- Name: versements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.versements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    agence_id uuid NOT NULL,
    proprietaire_id uuid NOT NULL,
    bien_id bigint,
    montant numeric(12,2) NOT NULL,
    periode text,
    statut text DEFAULT 'attente'::text NOT NULL,
    methode_paiement text,
    reference text,
    note text,
    effectue_a timestamp with time zone,
    effectue_par uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT versements_methode_paiement_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text])))),
    CONSTRAINT versements_montant_check CHECK ((montant > (0)::numeric)),
    CONSTRAINT versements_periode_mois_ck CHECK (((periode IS NULL) OR (periode ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))),
    CONSTRAINT versements_statut_check CHECK ((statut = ANY (ARRAY['attente'::text, 'en_cours'::text, 'effectue'::text, 'annule'::text])))
);

ALTER TABLE ONLY public.versements FORCE ROW LEVEL SECURITY;


ALTER TABLE public.versements OWNER TO postgres;

--
-- Name: versements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.versements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.versements_id_seq OWNER TO postgres;

--
-- Name: versements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.versements_id_seq OWNED BY public.versements.id;


--
-- Name: abonnement_paiements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements ALTER COLUMN id SET DEFAULT nextval('public.abonnement_paiements_id_seq'::regclass);


--
-- Name: agences_biens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens ALTER COLUMN id SET DEFAULT nextval('public.agences_biens_id_seq'::regclass);


--
-- Name: agences_proprietaires id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires ALTER COLUMN id SET DEFAULT nextval('public.agences_proprietaires_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: bictorys_webhooks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bictorys_webhooks ALTER COLUMN id SET DEFAULT nextval('public.bictorys_webhooks_id_seq'::regclass);


--
-- Name: biens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens ALTER COLUMN id SET DEFAULT nextval('public.biens_id_seq'::regclass);


--
-- Name: depenses id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.depenses ALTER COLUMN id SET DEFAULT nextval('public.depenses_id_seq'::regclass);


--
-- Name: employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes ALTER COLUMN id SET DEFAULT nextval('public.employes_id_seq'::regclass);


--
-- Name: employes_biens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens ALTER COLUMN id SET DEFAULT nextval('public.employes_biens_id_seq'::regclass);


--
-- Name: featured_items id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items ALTER COLUMN id SET DEFAULT nextval('public.featured_items_id_seq'::regclass);


--
-- Name: import_run_rows id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_run_rows ALTER COLUMN id SET DEFAULT nextval('public.import_run_rows_id_seq'::regclass);


--
-- Name: incidents id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents ALTER COLUMN id SET DEFAULT nextval('public.incidents_id_seq'::regclass);


--
-- Name: interventions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions ALTER COLUMN id SET DEFAULT nextval('public.interventions_id_seq'::regclass);


--
-- Name: locataires id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires ALTER COLUMN id SET DEFAULT nextval('public.locataires_id_seq'::regclass);


--
-- Name: logements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements ALTER COLUMN id SET DEFAULT nextval('public.logements_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: moyens_paiement id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement ALTER COLUMN id SET DEFAULT nextval('public.moyens_paiement_id_seq'::regclass);


--
-- Name: moyens_paiement_employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes ALTER COLUMN id SET DEFAULT nextval('public.moyens_paiement_employes_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: notifications_outbox id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications_outbox ALTER COLUMN id SET DEFAULT nextval('public.notifications_outbox_id_seq'::regclass);


--
-- Name: paiements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements ALTER COLUMN id SET DEFAULT nextval('public.paiements_id_seq'::regclass);


--
-- Name: paiements_employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes ALTER COLUMN id SET DEFAULT nextval('public.paiements_employes_id_seq'::regclass);


--
-- Name: platform_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events ALTER COLUMN id SET DEFAULT nextval('public.platform_events_id_seq'::regclass);


--
-- Name: prestataires id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires ALTER COLUMN id SET DEFAULT nextval('public.prestataires_id_seq'::regclass);


--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: versements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements ALTER COLUMN id SET DEFAULT nextval('public.versements_id_seq'::regclass);


--
-- Name: abonnement_paiements abonnement_paiements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_pkey PRIMARY KEY (id);


--
-- Name: account_recovery_emails account_recovery_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.account_recovery_emails
    ADD CONSTRAINT account_recovery_emails_pkey PRIMARY KEY (user_id);


--
-- Name: agences_biens agences_biens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_pkey PRIMARY KEY (id);


--
-- Name: agences_biens agences_biens_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_unique UNIQUE (agence_id, bien_id);


--
-- Name: agences_proprietaires agences_proprietaires_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_pkey PRIMARY KEY (id);


--
-- Name: agences_proprietaires agences_proprietaires_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_unique UNIQUE (agence_id, proprietaire_id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: bictorys_webhooks bictorys_webhooks_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bictorys_webhooks
    ADD CONSTRAINT bictorys_webhooks_fingerprint_key UNIQUE (fingerprint);


--
-- Name: bictorys_webhooks bictorys_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bictorys_webhooks
    ADD CONSTRAINT bictorys_webhooks_pkey PRIMARY KEY (id);


--
-- Name: biens biens_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens
    ADD CONSTRAINT biens_id_user_id_key UNIQUE (id, user_id);


--
-- Name: biens biens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens
    ADD CONSTRAINT biens_pkey PRIMARY KEY (id);


--
-- Name: depenses depenses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.depenses
    ADD CONSTRAINT depenses_pkey PRIMARY KEY (id);


--
-- Name: employes_biens employes_biens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_pkey PRIMARY KEY (id);


--
-- Name: employes_biens employes_biens_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_unique UNIQUE (employe_id, bien_id);


--
-- Name: employes employes_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_id_user_id_key UNIQUE (id, user_id);


--
-- Name: employes employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_pkey PRIMARY KEY (id);


--
-- Name: featured_items featured_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items
    ADD CONSTRAINT featured_items_pkey PRIMARY KEY (id);


--
-- Name: import_drafts import_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_drafts
    ADD CONSTRAINT import_drafts_pkey PRIMARY KEY (id);


--
-- Name: import_drafts import_drafts_user_checksum_uq; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_drafts
    ADD CONSTRAINT import_drafts_user_checksum_uq UNIQUE (user_id, source_checksum);


--
-- Name: import_run_rows import_run_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_run_rows
    ADD CONSTRAINT import_run_rows_pkey PRIMARY KEY (id);


--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);


--
-- Name: incidents incidents_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_id_user_id_key UNIQUE (id, user_id);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: interventions interventions_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_id_user_id_key UNIQUE (id, user_id);


--
-- Name: interventions interventions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_pkey PRIMARY KEY (id);


--
-- Name: locataires locataires_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_id_user_id_key UNIQUE (id, user_id);


--
-- Name: locataires locataires_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_pkey PRIMARY KEY (id);


--
-- Name: logements logements_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_id_user_id_key UNIQUE (id, user_id);


--
-- Name: logements logements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: moyens_paiement_employes moyens_paiement_employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes
    ADD CONSTRAINT moyens_paiement_employes_pkey PRIMARY KEY (id);


--
-- Name: moyens_paiement moyens_paiement_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement
    ADD CONSTRAINT moyens_paiement_pkey PRIMARY KEY (id);


--
-- Name: notifications_outbox notifications_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications_outbox
    ADD CONSTRAINT notifications_outbox_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: paiements_employes paiements_employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_pkey PRIMARY KEY (id);


--
-- Name: paiements paiements_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_id_user_id_key UNIQUE (id, user_id);


--
-- Name: paiements paiements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: plans plans_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_code_key UNIQUE (code);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: platform_events platform_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_pkey PRIMARY KEY (id);


--
-- Name: prestataires prestataires_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires
    ADD CONSTRAINT prestataires_id_user_id_key UNIQUE (id, user_id);


--
-- Name: prestataires prestataires_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires
    ADD CONSTRAINT prestataires_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: quota_reservations quota_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quota_reservations
    ADD CONSTRAINT quota_reservations_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_buckets rate_limit_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (key);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_user_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_unique UNIQUE (user_id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tenant_invitations tenant_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant_invitations
    ADD CONSTRAINT tenant_invitations_pkey PRIMARY KEY (id);


--
-- Name: tenant_invitations tenant_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant_invitations
    ADD CONSTRAINT tenant_invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: versements versements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_pkey PRIMARY KEY (id);


--
-- Name: abonnement_paiements_idempotency_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX abonnement_paiements_idempotency_uidx ON public.abonnement_paiements USING btree (user_id, provider, idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: abonnement_paiements_transaction_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX abonnement_paiements_transaction_uidx ON public.abonnement_paiements USING btree (provider, transaction_id) WHERE ((transaction_id IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: abonnement_paiements_user_statut_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX abonnement_paiements_user_statut_idx ON public.abonnement_paiements USING btree (user_id, statut, created_at DESC);


--
-- Name: account_recovery_emails_email_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX account_recovery_emails_email_uidx ON public.account_recovery_emails USING btree (lower(email));


--
-- Name: agences_biens_bien_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX agences_biens_bien_idx ON public.agences_biens USING btree (bien_id);


--
-- Name: agences_biens_proprietaire_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX agences_biens_proprietaire_idx ON public.agences_biens USING btree (proprietaire_id);


--
-- Name: agences_proprietaires_proprietaire_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX agences_proprietaires_proprietaire_idx ON public.agences_proprietaires USING btree (proprietaire_id);


--
-- Name: bictorys_webhooks_event_id_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX bictorys_webhooks_event_id_uidx ON public.bictorys_webhooks USING btree (event_id) WHERE (event_id IS NOT NULL);


--
-- Name: bictorys_webhooks_payment_reference_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX bictorys_webhooks_payment_reference_idx ON public.bictorys_webhooks USING btree (payment_reference);


--
-- Name: biens_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX biens_user_id_idx ON public.biens USING btree (user_id);


--
-- Name: depenses_bien_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX depenses_bien_idx ON public.depenses USING btree (bien_id);


--
-- Name: depenses_user_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX depenses_user_date_idx ON public.depenses USING btree (user_id, date_depense DESC);


--
-- Name: employes_account_uid_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX employes_account_uid_uidx ON public.employes USING btree (account_uid) WHERE ((account_uid IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: employes_biens_owner_employee_bien_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX employes_biens_owner_employee_bien_uidx ON public.employes_biens USING btree (user_id, employe_id, bien_id);


--
-- Name: employes_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employes_user_id_idx ON public.employes USING btree (user_id);


--
-- Name: idx_announcements_audience; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_announcements_audience ON public.announcements USING btree (audience);


--
-- Name: idx_announcements_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_announcements_status ON public.announcements USING btree (status);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_logs_level; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_level ON public.audit_logs USING btree (level);


--
-- Name: idx_audit_logs_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_featured_items_priority; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_featured_items_priority ON public.featured_items USING btree (priority DESC);


--
-- Name: idx_featured_items_target; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_featured_items_target ON public.featured_items USING btree (target_type, target_id);


--
-- Name: idx_moyens_paiement_employes_uid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_moyens_paiement_employes_uid ON public.moyens_paiement_employes USING btree (employe_uid);


--
-- Name: idx_platform_events_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_platform_events_date ON public.platform_events USING btree (event_date);


--
-- Name: idx_platform_events_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_platform_events_status ON public.platform_events USING btree (status);


--
-- Name: import_drafts_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX import_drafts_created_at_idx ON public.import_drafts USING btree (created_at);


--
-- Name: import_run_rows_run_number_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX import_run_rows_run_number_uidx ON public.import_run_rows USING btree (run_id, row_number) WHERE (superseded_at IS NULL);


--
-- Name: import_runs_user_idempotency_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX import_runs_user_idempotency_uidx ON public.import_runs USING btree (user_id, idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (status <> 'failed'::text) AND (superseded_at IS NULL));


--
-- Name: incidents_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX incidents_user_id_idx ON public.incidents USING btree (user_id);


--
-- Name: interventions_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX interventions_user_id_idx ON public.interventions USING btree (user_id);


--
-- Name: locataires_account_uid_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX locataires_account_uid_uidx ON public.locataires USING btree (account_uid) WHERE ((account_uid IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: locataires_logement_actif_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX locataires_logement_actif_uidx ON public.locataires USING btree (logement_id) WHERE ((logement_id IS NOT NULL) AND (statut = 'actif'::text) AND (superseded_at IS NULL));


--
-- Name: locataires_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX locataires_user_id_idx ON public.locataires USING btree (user_id);


--
-- Name: logements_bien_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX logements_bien_id_idx ON public.logements USING btree (bien_id);


--
-- Name: logements_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX logements_user_id_idx ON public.logements USING btree (user_id);


--
-- Name: messages_agence_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_agence_created_idx ON public.messages USING btree (agence_id, created_at DESC);


--
-- Name: messages_proprietaire_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_proprietaire_created_idx ON public.messages USING btree (proprietaire_id, created_at DESC);


--
-- Name: messages_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_user_id_idx ON public.messages USING btree (user_id);


--
-- Name: moyens_paiement_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX moyens_paiement_user_id_idx ON public.moyens_paiement USING btree (user_id);


--
-- Name: notifications_outbox_pending_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notifications_outbox_pending_idx ON public.notifications_outbox USING btree (next_attempt_at) WHERE (delivered_at IS NULL);


--
-- Name: notifications_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notifications_user_id_idx ON public.notifications USING btree (user_id);


--
-- Name: paiements_employes_employe_mois_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paiements_employes_employe_mois_uidx ON public.paiements_employes USING btree (user_id, employe_id, mois) WHERE ((employe_id IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: paiements_employes_employe_uid_mois_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paiements_employes_employe_uid_mois_uidx ON public.paiements_employes USING btree (user_id, employe_uid, mois) WHERE ((employe_uid IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: paiements_locataire_mois_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paiements_locataire_mois_uidx ON public.paiements USING btree (user_id, locataire_id, mois) WHERE ((locataire_id IS NOT NULL) AND (superseded_at IS NULL));


--
-- Name: paiements_owner_mois_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paiements_owner_mois_uidx ON public.paiements USING btree (user_id, mois) WHERE ((locataire_id IS NULL) AND (superseded_at IS NULL));


--
-- Name: password_reset_tokens_expires_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX password_reset_tokens_expires_at_idx ON public.password_reset_tokens USING btree (expires_at);


--
-- Name: password_reset_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX password_reset_tokens_user_id_idx ON public.password_reset_tokens USING btree (user_id);


--
-- Name: plans_audience_actif_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX plans_audience_actif_idx ON public.plans USING btree (audience, prix) WHERE (actif = true);


--
-- Name: prestataires_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX prestataires_user_id_idx ON public.prestataires USING btree (user_id);


--
-- Name: profiles_email_lower_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX profiles_email_lower_uidx ON public.profiles USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));


--
-- Name: profiles_email_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX profiles_email_uidx ON public.profiles USING btree (email) WHERE ((email IS NOT NULL) AND (email <> ''::text));


--
-- Name: INDEX profiles_email_uidx; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.profiles_email_uidx IS 'E-mails renseignés uniquement : un profil sans e-mail (inscription sans adresse) ne collisionne pas. Audit F7.';


--
-- Name: profiles_username_uniq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX profiles_username_uniq ON public.profiles USING btree (username) WHERE (username IS NOT NULL);


--
-- Name: quota_reservations_idempotency_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX quota_reservations_idempotency_uidx ON public.quota_reservations USING btree (user_id, resource, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: sessions_mfa_pending_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_mfa_pending_idx ON public.sessions USING btree (token_hash) WHERE ((action = 'mfa_pending'::text) AND (revoked_at IS NULL));


--
-- Name: sessions_token_hash_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX sessions_token_hash_uidx ON public.sessions USING btree (token_hash) WHERE (token_hash IS NOT NULL);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: tasks_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_user_id_idx ON public.tasks USING btree (user_id);


--
-- Name: tenant_invitations_active_tenant_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX tenant_invitations_active_tenant_uidx ON public.tenant_invitations USING btree (user_id, locataire_id) WHERE (revoked_at IS NULL);


--
-- Name: tenant_invitations_token_hash_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX tenant_invitations_token_hash_uidx ON public.tenant_invitations USING btree (token_hash);


--
-- Name: versements_agence_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX versements_agence_created_idx ON public.versements USING btree (agence_id, created_at DESC);


--
-- Name: versements_proprietaire_periode_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX versements_proprietaire_periode_uidx ON public.versements USING btree (proprietaire_id, agence_id, bien_id, periode) NULLS NOT DISTINCT;


--
-- Name: versements_proprietaire_statut_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX versements_proprietaire_statut_idx ON public.versements USING btree (proprietaire_id, statut);


--
-- Name: versements_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX versements_user_id_idx ON public.versements USING btree (user_id);


--
-- Name: employes_biens employes_biens_owner_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER employes_biens_owner_guard BEFORE INSERT OR UPDATE OF user_id, employe_id, bien_id ON public.employes_biens FOR EACH ROW EXECUTE FUNCTION public.employes_biens_owner_guard();


--
-- Name: locataires locataires_bien_sync; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER locataires_bien_sync BEFORE INSERT OR UPDATE OF logement_id, bien_id ON public.locataires FOR EACH ROW EXECUTE FUNCTION public.sync_locataire_bien_id();


--
-- Name: profiles mim_trial_subscription_on_signup; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER mim_trial_subscription_on_signup AFTER INSERT OR UPDATE OF account_type ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.mim_trial_subscription_on_signup();


--
-- Name: tenant_invitations tenant_invitations_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER tenant_invitations_guard BEFORE INSERT OR UPDATE ON public.tenant_invitations FOR EACH ROW EXECUTE FUNCTION public.tenant_invitations_guard();


--
-- Name: abonnement_paiements abonnement_paiements_plan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_plan_fkey FOREIGN KEY (plan) REFERENCES public.plans(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: abonnement_paiements abonnement_paiements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_emails account_recovery_emails_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.account_recovery_emails
    ADD CONSTRAINT account_recovery_emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_biens agences_biens_agence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_agence_id_fkey FOREIGN KEY (agence_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_biens agences_biens_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE CASCADE;


--
-- Name: agences_biens agences_biens_proprietaire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_proprietaire_id_fkey FOREIGN KEY (proprietaire_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_biens agences_biens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_biens
    ADD CONSTRAINT agences_biens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_proprietaires agences_proprietaires_agence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_agence_id_fkey FOREIGN KEY (agence_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_proprietaires agences_proprietaires_proprietaire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_proprietaire_id_fkey FOREIGN KEY (proprietaire_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agences_proprietaires agences_proprietaires_revoque_par_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_revoque_par_fkey FOREIGN KEY (revoque_par) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: agences_proprietaires agences_proprietaires_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agences_proprietaires
    ADD CONSTRAINT agences_proprietaires_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: announcements announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: biens biens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens
    ADD CONSTRAINT biens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: depenses depenses_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.depenses
    ADD CONSTRAINT depenses_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE CASCADE;


--
-- Name: depenses depenses_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.depenses
    ADD CONSTRAINT depenses_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: depenses depenses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.depenses
    ADD CONSTRAINT depenses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: employes employes_account_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_account_uid_fkey FOREIGN KEY (account_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: employes_biens employes_biens_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_bien_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_bien_owner_fk FOREIGN KEY (bien_id, user_id) REFERENCES public.biens(id, user_id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_employe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_employe_id_fkey FOREIGN KEY (employe_id) REFERENCES public.employes(id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_employe_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_employe_owner_fk FOREIGN KEY (employe_id, user_id) REFERENCES public.employes(id, user_id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: employes employes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: featured_items featured_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items
    ADD CONSTRAINT featured_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: import_run_rows import_run_rows_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_run_rows
    ADD CONSTRAINT import_run_rows_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE CASCADE;


--
-- Name: import_runs import_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: incidents incidents_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_logement_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_logement_owner_fk FOREIGN KEY (logement_id, user_id) REFERENCES public.logements(id, user_id) ON DELETE RESTRICT;


--
-- Name: incidents incidents_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.employes(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: interventions interventions_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.incidents(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_incident_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_incident_owner_fk FOREIGN KEY (incident_id, user_id) REFERENCES public.incidents(id, user_id) ON DELETE RESTRICT;


--
-- Name: interventions interventions_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_logement_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_logement_owner_fk FOREIGN KEY (logement_id, user_id) REFERENCES public.logements(id, user_id) ON DELETE RESTRICT;


--
-- Name: interventions interventions_prestataire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_prestataire_id_fkey FOREIGN KEY (prestataire_id) REFERENCES public.prestataires(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_prestataire_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_prestataire_owner_fk FOREIGN KEY (prestataire_id, user_id) REFERENCES public.prestataires(id, user_id) ON DELETE RESTRICT;


--
-- Name: interventions interventions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: locataires locataires_account_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_account_uid_fkey FOREIGN KEY (account_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_bien_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_bien_owner_fk FOREIGN KEY (bien_id, user_id) REFERENCES public.biens(id, user_id) ON DELETE RESTRICT;


--
-- Name: locataires locataires_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_logement_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_logement_owner_fk FOREIGN KEY (logement_id, user_id) REFERENCES public.logements(id, user_id) ON DELETE RESTRICT;


--
-- Name: locataires locataires_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: logements logements_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE SET NULL;


--
-- Name: logements logements_bien_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_bien_owner_fk FOREIGN KEY (bien_id, user_id) REFERENCES public.biens(id, user_id) ON DELETE RESTRICT;


--
-- Name: logements logements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_agence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_agence_id_fkey FOREIGN KEY (agence_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_auteur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_auteur_id_fkey FOREIGN KEY (auteur_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: messages messages_proprietaire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_proprietaire_id_fkey FOREIGN KEY (proprietaire_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: moyens_paiement_employes moyens_paiement_employes_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes
    ADD CONSTRAINT moyens_paiement_employes_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: moyens_paiement moyens_paiement_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement
    ADD CONSTRAINT moyens_paiement_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paiements_employes paiements_employes_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_employe_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_employe_owner_fk FOREIGN KEY (employe_id, user_id) REFERENCES public.employes(id, user_id) ON DELETE RESTRICT;


--
-- Name: paiements_employes paiements_employes_employe_restrict_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_employe_restrict_fk FOREIGN KEY (employe_id) REFERENCES public.employes(id) ON DELETE RESTRICT;


--
-- Name: paiements_employes paiements_employes_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_moyen_employe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_moyen_employe_id_fkey FOREIGN KEY (moyen_employe_id) REFERENCES public.moyens_paiement_employes(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: paiements paiements_locataire_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_locataire_owner_fk FOREIGN KEY (locataire_id, user_id) REFERENCES public.locataires(id, user_id) ON DELETE RESTRICT;


--
-- Name: paiements paiements_locataire_restrict_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_locataire_restrict_fk FOREIGN KEY (locataire_id) REFERENCES public.locataires(id) ON DELETE RESTRICT;


--
-- Name: paiements paiements_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: paiements paiements_logement_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_logement_owner_fk FOREIGN KEY (logement_id, user_id) REFERENCES public.logements(id, user_id) ON DELETE RESTRICT;


--
-- Name: paiements paiements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: paiements paiements_validated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: platform_events platform_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: prestataires prestataires_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires
    ADD CONSTRAINT prestataires_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: quota_reservations quota_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quota_reservations
    ADD CONSTRAINT quota_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: tasks tasks_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tenant_invitations tenant_invitations_account_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant_invitations
    ADD CONSTRAINT tenant_invitations_account_uid_fkey FOREIGN KEY (account_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: tenant_invitations tenant_invitations_locataire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant_invitations
    ADD CONSTRAINT tenant_invitations_locataire_id_fkey FOREIGN KEY (locataire_id) REFERENCES public.locataires(id) ON DELETE RESTRICT;


--
-- Name: tenant_invitations tenant_invitations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant_invitations
    ADD CONSTRAINT tenant_invitations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: versements versements_agence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_agence_id_fkey FOREIGN KEY (agence_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: versements versements_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE SET NULL;


--
-- Name: versements versements_effectue_par_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_effectue_par_fkey FOREIGN KEY (effectue_par) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: versements versements_proprietaire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_proprietaire_id_fkey FOREIGN KEY (proprietaire_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: versements versements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.versements
    ADD CONSTRAINT versements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: abonnement_paiements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.abonnement_paiements ENABLE ROW LEVEL SECURITY;

--
-- Name: account_recovery_emails; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.account_recovery_emails ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements admin_read_announcements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_announcements ON public.announcements FOR SELECT TO authenticated USING (((status = 'published'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text])))))));


--
-- Name: audit_logs admin_read_audit_logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_audit_logs ON public.audit_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text]))))));


--
-- Name: platform_events admin_read_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_events ON public.platform_events FOR SELECT TO authenticated USING (((status = 'published'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text])))))));


--
-- Name: agences_biens agence_all_agences_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY agence_all_agences_biens ON public.agences_biens TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: agences_proprietaires agence_all_agences_proprietaires; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY agence_all_agences_proprietaires ON public.agences_proprietaires TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: messages agence_all_messages; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY agence_all_messages ON public.messages TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: versements agence_all_versements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY agence_all_versements ON public.versements TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: agences_biens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.agences_biens ENABLE ROW LEVEL SECURITY;

--
-- Name: agences_proprietaires; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.agences_proprietaires ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: plans authenticated_select_plans; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY authenticated_select_plans ON public.plans FOR SELECT TO authenticated USING ((actif = true));


--
-- Name: bictorys_webhooks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.bictorys_webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: biens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.biens ENABLE ROW LEVEL SECURITY;

--
-- Name: account_recovery_emails closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.account_recovery_emails USING (false) WITH CHECK (false);


--
-- Name: bictorys_webhooks closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.bictorys_webhooks USING (false) WITH CHECK (false);


--
-- Name: import_run_rows closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.import_run_rows USING (false) WITH CHECK (false);


--
-- Name: import_runs closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.import_runs USING (false) WITH CHECK (false);


--
-- Name: password_reset_tokens closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.password_reset_tokens USING (false) WITH CHECK (false);


--
-- Name: quota_reservations closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.quota_reservations USING (false) WITH CHECK (false);


--
-- Name: sessions closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.sessions USING (false) WITH CHECK (false);


--
-- Name: POLICY closed_deny_all ON sessions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON POLICY closed_deny_all ON public.sessions IS 'Fermeture explicite (audit F3/F6) : seuls les rôles BYPASSRLS (service_role) lisent les sessions.';


--
-- Name: tenant_invitations closed_deny_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY closed_deny_all ON public.tenant_invitations USING (false) WITH CHECK (false);


--
-- Name: depenses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.depenses ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement_employes employe_all_own_moyens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_all_own_moyens ON public.moyens_paiement_employes TO authenticated USING ((employe_uid = auth.uid())) WITH CHECK ((employe_uid = auth.uid()));


--
-- Name: biens employe_select_biens_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_biens_affectes ON public.biens FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = biens.id)))));


--
-- Name: incidents employe_select_incidents_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_incidents_affectes ON public.incidents FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM ((public.logements lg
     JOIN public.employes_biens eb ON ((eb.bien_id = lg.bien_id)))
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((lg.id = incidents.logement_id) AND (e.account_uid = auth.uid())))));


--
-- Name: interventions employe_select_interventions_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_interventions_affectes ON public.interventions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM ((public.logements lg
     JOIN public.employes_biens eb ON ((eb.bien_id = lg.bien_id)))
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((lg.id = interventions.logement_id) AND (e.account_uid = auth.uid())))));


--
-- Name: locataires employe_select_locataires_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_locataires_affectes ON public.locataires FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = locataires.bien_id)))));


--
-- Name: logements employe_select_logements_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_logements_affectes ON public.logements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = logements.bien_id)))));


--
-- Name: employes employe_select_own_employe; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_employe ON public.employes FOR SELECT TO authenticated USING ((account_uid = auth.uid()));


--
-- Name: employes_biens employe_select_own_employes_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_employes_biens ON public.employes_biens FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.employes e
  WHERE ((e.account_uid = auth.uid()) AND (e.id = employes_biens.employe_id)))));


--
-- Name: paiements_employes employe_select_own_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_paiements ON public.paiements_employes FOR SELECT TO authenticated USING ((employe_uid = auth.uid()));


--
-- Name: tasks employe_select_own_tasks; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_tasks ON public.tasks FOR SELECT TO authenticated USING ((employe_uid = auth.uid()));


--
-- Name: paiements_employes employe_update_own_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_update_own_paiements ON public.paiements_employes FOR UPDATE TO authenticated USING ((employe_uid = auth.uid())) WITH CHECK ((employe_uid = auth.uid()));


--
-- Name: employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employes ENABLE ROW LEVEL SECURITY;

--
-- Name: employes_biens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employes_biens ENABLE ROW LEVEL SECURITY;

--
-- Name: featured_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.featured_items ENABLE ROW LEVEL SECURITY;

--
-- Name: import_drafts; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.import_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: import_run_rows; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.import_run_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: import_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: incidents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: interventions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;

--
-- Name: locataires; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.locataires ENABLE ROW LEVEL SECURITY;

--
-- Name: logements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.logements ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.moyens_paiement ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement_employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.moyens_paiement_employes ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_delete_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY notifications_delete_own ON public.notifications FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notifications_outbox; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notifications_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_select_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notifications notifications_update_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: biens owner_all_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_biens ON public.biens TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: depenses owner_all_depenses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_depenses ON public.depenses USING ((auth.uid() = user_id));


--
-- Name: employes owner_all_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_employes ON public.employes TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: incidents owner_all_incidents; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_incidents ON public.incidents TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: interventions owner_all_interventions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_interventions ON public.interventions TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: locataires owner_all_locataires; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_locataires ON public.locataires TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: logements owner_all_logements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_logements ON public.logements TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: moyens_paiement owner_all_moyens_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_moyens_paiement ON public.moyens_paiement TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: paiements owner_all_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_paiements ON public.paiements TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: paiements_employes owner_all_paiements_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_paiements_employes ON public.paiements_employes TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: prestataires owner_all_prestataires; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_prestataires ON public.prestataires TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: tasks owner_all_tasks; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_tasks ON public.tasks TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: moyens_paiement_employes owner_select_employe_moyens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_employe_moyens ON public.moyens_paiement_employes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.employes e
  WHERE ((e.account_uid = moyens_paiement_employes.employe_uid) AND (e.user_id = auth.uid())))));


--
-- Name: abonnement_paiements owner_select_own_abonnement_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_own_abonnement_paiements ON public.abonnement_paiements FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: subscriptions owner_select_own_subscription; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_own_subscription ON public.subscriptions FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: paiements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paiements ENABLE ROW LEVEL SECURITY;

--
-- Name: paiements_employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paiements_employes ENABLE ROW LEVEL SECURITY;

--
-- Name: password_reset_tokens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: plans; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.platform_events ENABLE ROW LEVEL SECURITY;

--
-- Name: prestataires; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.prestataires ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: agences_biens proprietaire_select_own_bien_liaison; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY proprietaire_select_own_bien_liaison ON public.agences_biens FOR SELECT TO authenticated USING ((proprietaire_id = auth.uid()));


--
-- Name: agences_proprietaires proprietaire_select_own_liaison; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY proprietaire_select_own_liaison ON public.agences_proprietaires FOR SELECT TO authenticated USING ((proprietaire_id = auth.uid()));


--
-- Name: messages proprietaire_select_own_messages; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY proprietaire_select_own_messages ON public.messages FOR SELECT TO authenticated USING ((proprietaire_id = auth.uid()));


--
-- Name: versements proprietaire_select_own_versements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY proprietaire_select_own_versements ON public.versements FOR SELECT TO authenticated USING ((proprietaire_id = auth.uid()));


--
-- Name: featured_items public_read_featured; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY public_read_featured ON public.featured_items FOR SELECT TO authenticated USING (true);


--
-- Name: quota_reservations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.quota_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limit_buckets; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: employes restrict_no_locataire_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY restrict_no_locataire_employes ON public.employes AS RESTRICTIVE FOR SELECT TO authenticated USING ((COALESCE(( SELECT p.account_type
   FROM public.profiles p
  WHERE (p.id = auth.uid())), ''::text) = ANY (ARRAY['proprietaire'::text, 'agence'::text, 'entreprise'::text, 'employe'::text])));


--
-- Name: moyens_paiement_employes restrict_no_locataire_moyens_paiement_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY restrict_no_locataire_moyens_paiement_employes ON public.moyens_paiement_employes AS RESTRICTIVE FOR SELECT TO authenticated USING ((COALESCE(( SELECT p.account_type
   FROM public.profiles p
  WHERE (p.id = auth.uid())), ''::text) = ANY (ARRAY['proprietaire'::text, 'agence'::text, 'entreprise'::text, 'employe'::text])));


--
-- Name: paiements_employes restrict_no_locataire_paiements_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY restrict_no_locataire_paiements_employes ON public.paiements_employes AS RESTRICTIVE FOR SELECT TO authenticated USING ((COALESCE(( SELECT p.account_type
   FROM public.profiles p
  WHERE (p.id = auth.uid())), ''::text) = ANY (ARRAY['proprietaire'::text, 'agence'::text, 'entreprise'::text, 'employe'::text])));


--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: system_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_invitations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: biens tenant_select_bien; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_bien ON public.biens FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.logements lg
     JOIN public.locataires l ON ((l.logement_id = lg.id)))
  WHERE ((lg.bien_id = biens.id) AND (l.account_uid = auth.uid())))));


--
-- Name: incidents tenant_select_incident; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_incident ON public.incidents FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.logements lg
     JOIN public.locataires l ON ((l.logement_id = lg.id)))
  WHERE ((lg.id = incidents.logement_id) AND (l.account_uid = auth.uid())))));


--
-- Name: locataires tenant_select_locataire; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_locataire ON public.locataires FOR SELECT TO authenticated USING ((account_uid = ( SELECT auth.uid() AS uid)));


--
-- Name: logements tenant_select_logement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_logement ON public.logements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.locataires l
  WHERE ((l.account_uid = auth.uid()) AND (l.logement_id = logements.id)))));


--
-- Name: moyens_paiement tenant_select_moyens_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_moyens_paiement ON public.moyens_paiement FOR SELECT TO authenticated USING (((actif = true) AND (EXISTS ( SELECT 1
   FROM (public.locataires l
     JOIN public.logements lg ON ((lg.id = l.logement_id)))
  WHERE ((l.account_uid = auth.uid()) AND (lg.user_id = moyens_paiement.user_id))))));


--
-- Name: paiements tenant_select_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_paiement ON public.paiements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.locataires l
  WHERE ((l.account_uid = auth.uid()) AND (l.id = paiements.locataire_id)))));


--
-- Name: announcements ultra_admin_all_announcements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_announcements ON public.announcements TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: platform_events ultra_admin_all_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_events ON public.platform_events TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: featured_items ultra_admin_all_featured; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_featured ON public.featured_items TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: system_config ultra_admin_all_system_config; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_system_config ON public.system_config TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: profiles users_can_update_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY users_can_update_own ON public.profiles FOR UPDATE TO authenticated USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));


--
-- Name: profiles users_can_view_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY users_can_view_own ON public.profiles FOR SELECT TO authenticated USING ((id = ( SELECT auth.uid() AS uid)));


--
-- Name: versements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.versements ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION activate_subscription_payment(p_payment_id bigint, p_transaction_id text, p_paid_at timestamp with time zone, p_expected_amount numeric, p_currency text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.activate_subscription_payment(p_payment_id bigint, p_transaction_id text, p_paid_at timestamp with time zone, p_expected_amount numeric, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.activate_subscription_payment(p_payment_id bigint, p_transaction_id text, p_paid_at timestamp with time zone, p_expected_amount numeric, p_currency text) TO service_role;


--
-- Name: FUNCTION consume_quota(p_reservation_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.consume_quota(p_reservation_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_quota(p_reservation_id uuid, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION consume_tenant_invitation(p_token_hash text, p_account_uid uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.consume_tenant_invitation(p_token_hash text, p_account_uid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_tenant_invitation(p_token_hash text, p_account_uid uuid) TO service_role;


--
-- Name: FUNCTION create_tenant_invitation(p_user_id uuid, p_locataire_id bigint, p_token_hash text, p_expires_at timestamp with time zone, p_max_uses integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_tenant_invitation(p_user_id uuid, p_locataire_id bigint, p_token_hash text, p_expires_at timestamp with time zone, p_max_uses integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_tenant_invitation(p_user_id uuid, p_locataire_id bigint, p_token_hash text, p_expires_at timestamp with time zone, p_max_uses integer) TO service_role;


--
-- Name: FUNCTION employes_biens_owner_guard(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.employes_biens_owner_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.employes_biens_owner_guard() TO service_role;


--
-- Name: FUNCTION guard_public_auth_metadata(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.guard_public_auth_metadata() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_public_auth_metadata() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION notifications_outbox_flush(p_limit integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.notifications_outbox_flush(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.notifications_outbox_flush(p_limit integer) TO service_role;


--
-- Name: FUNCTION rate_limit_bump(p_key text, p_window_ms integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.rate_limit_bump(p_key text, p_window_ms integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rate_limit_bump(p_key text, p_window_ms integer) TO service_role;


--
-- Name: FUNCTION record_manual_subscription_payment(p_user_id uuid, p_plan_code text, p_amount numeric, p_reference text, p_method text, p_paid_at timestamp with time zone, p_duration integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.record_manual_subscription_payment(p_user_id uuid, p_plan_code text, p_amount numeric, p_reference text, p_method text, p_paid_at timestamp with time zone, p_duration integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_manual_subscription_payment(p_user_id uuid, p_plan_code text, p_amount numeric, p_reference text, p_method text, p_paid_at timestamp with time zone, p_duration integer) TO service_role;


--
-- Name: FUNCTION release_quota(p_reservation_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.release_quota(p_reservation_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_quota(p_reservation_id uuid, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION reserve_quota(p_user_id uuid, p_resource text, p_quantity integer, p_idempotency_key text, p_ttl interval, p_metadata jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.reserve_quota(p_user_id uuid, p_resource text, p_quantity integer, p_idempotency_key text, p_ttl interval, p_metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_quota(p_user_id uuid, p_resource text, p_quantity integer, p_idempotency_key text, p_ttl interval, p_metadata jsonb) TO service_role;


--
-- Name: FUNCTION sync_profile_account_type(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.sync_profile_account_type() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_profile_account_type() TO service_role;


--
-- Name: FUNCTION tenant_invitations_guard(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.tenant_invitations_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.tenant_invitations_guard() TO service_role;


--
-- Name: TABLE abonnement_paiements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.abonnement_paiements TO service_role;
GRANT SELECT ON TABLE public.abonnement_paiements TO authenticated;


--
-- Name: SEQUENCE abonnement_paiements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.abonnement_paiements_id_seq TO service_role;


--
-- Name: TABLE account_recovery_emails; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.account_recovery_emails TO service_role;


--
-- Name: TABLE agences_biens; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agences_biens TO service_role;
GRANT SELECT ON TABLE public.agences_biens TO authenticated;


--
-- Name: SEQUENCE agences_biens_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.agences_biens_id_seq TO service_role;


--
-- Name: TABLE agences_proprietaires; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agences_proprietaires TO service_role;
GRANT SELECT ON TABLE public.agences_proprietaires TO authenticated;


--
-- Name: SEQUENCE agences_proprietaires_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.agences_proprietaires_id_seq TO service_role;


--
-- Name: TABLE announcements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.announcements TO service_role;


--
-- Name: SEQUENCE announcements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.announcements_id_seq TO service_role;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.audit_logs TO service_role;


--
-- Name: SEQUENCE audit_logs_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.audit_logs_id_seq TO service_role;


--
-- Name: TABLE bictorys_webhooks; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.bictorys_webhooks TO service_role;


--
-- Name: SEQUENCE bictorys_webhooks_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.bictorys_webhooks_id_seq TO service_role;


--
-- Name: TABLE biens; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.biens TO service_role;
GRANT SELECT ON TABLE public.biens TO authenticated;


--
-- Name: SEQUENCE biens_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.biens_id_seq TO service_role;


--
-- Name: TABLE depenses; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.depenses TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.depenses TO authenticated;


--
-- Name: SEQUENCE depenses_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.depenses_id_seq TO service_role;
GRANT SELECT,USAGE ON SEQUENCE public.depenses_id_seq TO authenticated;


--
-- Name: TABLE employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employes TO service_role;
GRANT SELECT ON TABLE public.employes TO authenticated;


--
-- Name: TABLE employes_biens; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employes_biens TO service_role;
GRANT SELECT ON TABLE public.employes_biens TO authenticated;


--
-- Name: SEQUENCE employes_biens_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.employes_biens_id_seq TO service_role;


--
-- Name: SEQUENCE employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.employes_id_seq TO service_role;


--
-- Name: TABLE featured_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.featured_items TO service_role;


--
-- Name: SEQUENCE featured_items_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.featured_items_id_seq TO service_role;


--
-- Name: TABLE import_drafts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.import_drafts TO service_role;


--
-- Name: TABLE import_run_rows; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.import_run_rows TO service_role;


--
-- Name: SEQUENCE import_run_rows_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.import_run_rows_id_seq TO service_role;


--
-- Name: TABLE import_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.import_runs TO service_role;


--
-- Name: TABLE incidents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.incidents TO service_role;
GRANT SELECT ON TABLE public.incidents TO authenticated;


--
-- Name: SEQUENCE incidents_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.incidents_id_seq TO service_role;


--
-- Name: TABLE interventions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.interventions TO service_role;
GRANT SELECT ON TABLE public.interventions TO authenticated;


--
-- Name: SEQUENCE interventions_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.interventions_id_seq TO service_role;


--
-- Name: TABLE locataires; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.locataires TO service_role;
GRANT SELECT ON TABLE public.locataires TO authenticated;


--
-- Name: SEQUENCE locataires_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.locataires_id_seq TO service_role;


--
-- Name: TABLE logements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.logements TO service_role;
GRANT SELECT ON TABLE public.logements TO authenticated;


--
-- Name: SEQUENCE logements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.logements_id_seq TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.messages TO service_role;
GRANT SELECT ON TABLE public.messages TO authenticated;


--
-- Name: SEQUENCE messages_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.messages_id_seq TO service_role;


--
-- Name: TABLE moyens_paiement; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.moyens_paiement TO service_role;
GRANT SELECT ON TABLE public.moyens_paiement TO authenticated;


--
-- Name: TABLE moyens_paiement_employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.moyens_paiement_employes TO service_role;
GRANT SELECT ON TABLE public.moyens_paiement_employes TO authenticated;


--
-- Name: SEQUENCE moyens_paiement_employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.moyens_paiement_employes_id_seq TO service_role;


--
-- Name: SEQUENCE moyens_paiement_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.moyens_paiement_id_seq TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.notifications TO service_role;
GRANT SELECT,DELETE ON TABLE public.notifications TO authenticated;


--
-- Name: COLUMN notifications.lu; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(lu) ON TABLE public.notifications TO authenticated;


--
-- Name: SEQUENCE notifications_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.notifications_id_seq TO service_role;


--
-- Name: TABLE notifications_outbox; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.notifications_outbox TO service_role;


--
-- Name: SEQUENCE notifications_outbox_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.notifications_outbox_id_seq TO service_role;


--
-- Name: TABLE paiements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paiements TO service_role;
GRANT SELECT ON TABLE public.paiements TO authenticated;


--
-- Name: TABLE paiements_employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paiements_employes TO service_role;
GRANT SELECT ON TABLE public.paiements_employes TO authenticated;


--
-- Name: SEQUENCE paiements_employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.paiements_employes_id_seq TO service_role;


--
-- Name: SEQUENCE paiements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.paiements_id_seq TO service_role;


--
-- Name: TABLE password_reset_tokens; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.password_reset_tokens TO service_role;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.plans TO service_role;
GRANT SELECT ON TABLE public.plans TO authenticated;


--
-- Name: TABLE platform_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.platform_events TO service_role;


--
-- Name: SEQUENCE platform_events_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.platform_events_id_seq TO service_role;


--
-- Name: TABLE prestataires; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.prestataires TO service_role;
GRANT SELECT ON TABLE public.prestataires TO authenticated;


--
-- Name: SEQUENCE prestataires_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.prestataires_id_seq TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.phone; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(phone) ON TABLE public.profiles TO authenticated;


--
-- Name: TABLE quota_reservations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.quota_reservations TO service_role;


--
-- Name: TABLE rate_limit_buckets; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.rate_limit_buckets TO service_role;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sessions TO service_role;


--
-- Name: SEQUENCE sessions_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.sessions_id_seq TO service_role;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.subscriptions TO service_role;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;


--
-- Name: TABLE system_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.system_config TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tasks TO service_role;
GRANT SELECT ON TABLE public.tasks TO authenticated;


--
-- Name: SEQUENCE tasks_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.tasks_id_seq TO service_role;


--
-- Name: TABLE tenant_invitations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tenant_invitations TO service_role;


--
-- Name: TABLE versements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.versements TO service_role;
GRANT SELECT ON TABLE public.versements TO authenticated;


--
-- Name: SEQUENCE versements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.versements_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


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
