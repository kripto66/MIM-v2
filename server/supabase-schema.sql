


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text" DEFAULT NULL::"text", "p_paid_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_amount" numeric DEFAULT NULL::numeric, "p_currency" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' AND v_payment.montant IS DISTINCT FROM v_plan.prix THEN RAISE EXCEPTION 'Montant plan invalide.'; END IF;
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


ALTER FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text", "p_paid_at" timestamp with time zone, "p_expected_amount" numeric, "p_currency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_quota"("p_reservation_id" "uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."consume_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_tenant_invitation"("p_token_hash" "text", "p_account_uid" "uuid") RETURNS TABLE("invitation_id" "uuid", "owner_id" "uuid", "tenant_id" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."consume_tenant_invitation"("p_token_hash" "text", "p_account_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_tenant_invitation"("p_user_id" "uuid", "p_locataire_id" bigint, "p_token_hash" "text", "p_expires_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_max_uses" integer DEFAULT 1) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."create_tenant_invitation"("p_user_id" "uuid", "p_locataire_id" bigint, "p_token_hash" "text", "p_expires_at" timestamp with time zone, "p_max_uses" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."employes_biens_owner_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."employes_biens_owner_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_public_auth_metadata"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."guard_public_auth_metadata"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_manual_subscription_payment"("p_user_id" "uuid", "p_plan_code" "text", "p_amount" numeric, "p_reference" "text", "p_method" "text" DEFAULT 'especes'::"text", "p_paid_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_duration" integer DEFAULT NULL::integer) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."record_manual_subscription_payment"("p_user_id" "uuid", "p_plan_code" "text", "p_amount" numeric, "p_reference" "text", "p_method" "text", "p_paid_at" timestamp with time zone, "p_duration" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_quota"("p_reservation_id" "uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."release_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


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
        v_limit := CASE v_resource WHEN 'biens' THEN v_plan.max_immeubles WHEN 'logements' THEN v_plan.max_logements WHEN 'locataires' THEN v_plan.max_locataires ELSE NULL END;
    ELSE v_limit := NULL; END IF;
    IF v_resource = 'biens' THEN SELECT count(*) INTO v_current FROM public.biens WHERE user_id = p_user_id;
    ELSIF v_resource = 'logements' THEN SELECT count(*) INTO v_current FROM public.logements WHERE user_id = p_user_id;
    ELSIF v_resource = 'locataires' THEN SELECT count(*) INTO v_current FROM public.locataires WHERE user_id = p_user_id AND superseded_at IS NULL;
    ELSE v_current := 0; END IF;
    SELECT COALESCE(sum(quantity),0) INTO v_reserved FROM public.quota_reservations WHERE user_id = p_user_id AND resource = v_resource AND status = 'reserved' AND expires_at > v_now;
    IF v_limit IS NOT NULL AND v_current + v_reserved + p_quantity > v_limit THEN RAISE EXCEPTION 'Quota de plan atteint pour %',v_resource; END IF;
    INSERT INTO public.quota_reservations(user_id,resource,quantity,idempotency_key,expires_at,metadata) VALUES(p_user_id,v_resource,p_quantity,v_key,v_now + p_ttl,COALESCE(p_metadata,'{}'::jsonb)) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."reserve_quota"("p_user_id" "uuid", "p_resource" "text", "p_quantity" integer, "p_idempotency_key" "text", "p_ttl" interval, "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tenant_invitations_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.locataires l WHERE l.id = NEW.locataire_id AND l.user_id = NEW.user_id AND l.superseded_at IS NULL) THEN RAISE EXCEPTION 'Fiche locataire invalide.'; END IF;
    IF length(pg_catalog.btrim(NEW.token_hash)) < 32 OR NEW.expires_at <= pg_catalog.clock_timestamp() OR NEW.max_uses < 1 OR NEW.usage_count < 0 OR NEW.usage_count > NEW.max_uses THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."tenant_invitations_guard"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."abonnement_paiements" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan" "text" NOT NULL,
    "montant" numeric(12,2) NOT NULL,
    "date_paiement" timestamp with time zone DEFAULT "now"(),
    "methode_paiement" "text",
    "reference" "text",
    "date_debut" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_expiration" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "devise" "text" DEFAULT 'XOF'::"text" NOT NULL,
    "provider" "text" DEFAULT 'manuel'::"text",
    "transaction_id" "text",
    "statut" "text" DEFAULT 'paid'::"text" NOT NULL,
    "raw_response" "jsonb",
    "updated_at" timestamp with time zone,
    "idempotency_key" "text",
    "duree_abonnement" integer,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "abonnement_paiements_duration_ck" CHECK ((("duree_abonnement" IS NULL) OR (("duree_abonnement" >= 1) AND ("duree_abonnement" <= 36)))),
    CONSTRAINT "abonnement_paiements_methode_check" CHECK ((("methode_paiement" IS NULL) OR ("methode_paiement" = ANY (ARRAY['especes'::"text", 'mobile_money'::"text", 'virement'::"text", 'carte'::"text", 'wave'::"text", 'orange_money'::"text", 'bictorys'::"text"])))),
    CONSTRAINT "abonnement_paiements_montant_ck" CHECK (("montant" > (0)::numeric)),
    CONSTRAINT "abonnement_paiements_statut_check" CHECK (("statut" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."abonnement_paiements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."abonnement_paiements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."abonnement_paiements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."abonnement_paiements_id_seq" OWNED BY "public"."abonnement_paiements"."id";



CREATE TABLE IF NOT EXISTS "public"."account_recovery_emails" (
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."account_recovery_emails" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_recovery_emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agences_biens" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "agence_id" "uuid" NOT NULL,
    "proprietaire_id" "uuid" NOT NULL,
    "bien_id" bigint NOT NULL,
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agences_biens_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'retire'::"text"])))
);


ALTER TABLE "public"."agences_biens" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agences_biens_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agences_biens_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agences_biens_id_seq" OWNED BY "public"."agences_biens"."id";



CREATE TABLE IF NOT EXISTS "public"."agences_proprietaires" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "agence_id" "uuid" NOT NULL,
    "proprietaire_id" "uuid" NOT NULL,
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agences_proprietaires_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'inactif'::"text"])))
);


ALTER TABLE "public"."agences_proprietaires" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agences_proprietaires_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agences_proprietaires_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agences_proprietaires_id_seq" OWNED BY "public"."agences_proprietaires"."id";



CREATE TABLE IF NOT EXISTS "public"."announcements" (
    "id" bigint NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "audience" "text" DEFAULT 'all'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "announcements_audience_check" CHECK (("audience" = ANY (ARRAY['all'::"text", 'owners'::"text", 'tenants'::"text", 'employees'::"text", 'admins'::"text"]))),
    CONSTRAINT "announcements_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."announcements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."announcements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."announcements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."announcements_id_seq" OWNED BY "public"."announcements"."id";



CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "target_id" "text",
    "target_type" "text",
    "level" "text" DEFAULT 'info'::"text" NOT NULL,
    "meta" "jsonb",
    "ip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_logs_level_check" CHECK (("level" = ANY (ARRAY['info'::"text", 'warn'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_logs_id_seq" OWNED BY "public"."audit_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."bictorys_webhooks" (
    "id" bigint NOT NULL,
    "event_id" "text",
    "merchant_id" "text",
    "type" "text",
    "status" "text",
    "amount" numeric(12,2),
    "currency" "text",
    "payment_reference" "text",
    "merchant_reference" "text",
    "payload" "jsonb" NOT NULL,
    "fingerprint" "text" NOT NULL,
    "handled" boolean DEFAULT false NOT NULL,
    "handled_at" timestamp with time zone,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bictorys_webhooks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bictorys_webhooks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bictorys_webhooks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bictorys_webhooks_id_seq" OWNED BY "public"."bictorys_webhooks"."id";



CREATE TABLE IF NOT EXISTS "public"."biens" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "nom" "text" NOT NULL,
    "type" "text" NOT NULL,
    "adresse" "text",
    "ville" "text",
    "pays" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."biens" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."biens_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."biens_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."biens_id_seq" OWNED BY "public"."biens"."id";



CREATE TABLE IF NOT EXISTS "public"."employes" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_uid" "uuid",
    "username" "text",
    "nom" "text" NOT NULL,
    "poste" "text",
    "salaire" numeric(12,2) DEFAULT 0 NOT NULL,
    "email" "text",
    "phone" "text",
    "date_embauche" "date",
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "employes_salaire_nonnegative_ck" CHECK (("salaire" >= (0)::numeric)),
    CONSTRAINT "employes_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'inactif'::"text"])))
);


ALTER TABLE "public"."employes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employes_biens" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "employe_id" bigint NOT NULL,
    "bien_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."employes_biens" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."employes_biens" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."employes_biens_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employes_biens_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employes_biens_id_seq" OWNED BY "public"."employes_biens"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."employes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employes_id_seq" OWNED BY "public"."employes"."id";



CREATE TABLE IF NOT EXISTS "public"."featured_items" (
    "id" bigint NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "badge" "text",
    "priority" integer DEFAULT 0 NOT NULL,
    "featured_until" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "featured_items_target_type_check" CHECK (("target_type" = ANY (ARRAY['user'::"text", 'bien'::"text", 'logement'::"text", 'announcement'::"text", 'event'::"text"])))
);


ALTER TABLE "public"."featured_items" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."featured_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."featured_items_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."featured_items_id_seq" OWNED BY "public"."featured_items"."id";



CREATE TABLE IF NOT EXISTS "public"."import_run_rows" (
    "id" bigint NOT NULL,
    "run_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "source_row_hash" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" bigint,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb",
    "error_message" "text",
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "import_run_rows_number_ck" CHECK (("row_number" > 0)),
    CONSTRAINT "import_run_rows_status_ck" CHECK (("status" = ANY (ARRAY['pending'::"text", 'created'::"text", 'updated'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."import_run_rows" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."import_run_rows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."import_run_rows_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."import_run_rows_id_seq" OWNED BY "public"."import_run_rows"."id";



CREATE TABLE IF NOT EXISTS "public"."import_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "idempotency_key" "text",
    "source_filename" "text",
    "source_checksum" "text",
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "total_rows" integer DEFAULT 0 NOT NULL,
    "processed_rows" integer DEFAULT 0 NOT NULL,
    "created_rows" integer DEFAULT 0 NOT NULL,
    "updated_rows" integer DEFAULT 0 NOT NULL,
    "skipped_rows" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "import_runs_counters_ck" CHECK ((("total_rows" >= 0) AND ("processed_rows" >= 0) AND ("created_rows" >= 0) AND ("updated_rows" >= 0) AND ("skipped_rows" >= 0))),
    CONSTRAINT "import_runs_status_ck" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'aborted'::"text"])))
);


ALTER TABLE "public"."import_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incidents" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "logement_id" bigint,
    "titre" "text" NOT NULL,
    "description" "text",
    "statut" "text" DEFAULT 'nouveau'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "photo" "text",
    "resolved_by" bigint,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "incidents_statut_check" CHECK (("statut" = ANY (ARRAY['nouveau'::"text", 'en_cours'::"text", 'intervention'::"text", 'resolu'::"text"])))
);


ALTER TABLE "public"."incidents" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."incidents_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."incidents_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."incidents_id_seq" OWNED BY "public"."incidents"."id";



CREATE TABLE IF NOT EXISTS "public"."interventions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "incident_id" bigint,
    "prestataire_id" bigint,
    "logement_id" bigint,
    "titre" "text" NOT NULL,
    "description" "text",
    "statut" "text" DEFAULT 'planifie'::"text" NOT NULL,
    "date_prevue" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "interventions_statut_check" CHECK (("statut" = ANY (ARRAY['planifie'::"text", 'en_cours'::"text", 'termine'::"text"])))
);


ALTER TABLE "public"."interventions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."interventions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."interventions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."interventions_id_seq" OWNED BY "public"."interventions"."id";



CREATE TABLE IF NOT EXISTS "public"."locataires" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_uid" "uuid",
    "logement_id" bigint,
    "nom" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "date_entree" "date",
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "username" "text",
    "jour_echeance" integer DEFAULT 1,
    "bien_id" bigint,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "locataires_jour_ck" CHECK ((("jour_echeance" IS NULL) OR (("jour_echeance" >= 1) AND ("jour_echeance" <= 31)))),
    CONSTRAINT "locataires_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'inactif'::"text"])))
);


ALTER TABLE "public"."locataires" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."locataires_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."locataires_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."locataires_id_seq" OWNED BY "public"."locataires"."id";



CREATE TABLE IF NOT EXISTS "public"."logements" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bien_id" bigint,
    "nom" "text" NOT NULL,
    "loyer_mensuel" numeric(12,2) DEFAULT 0 NOT NULL,
    "statut" "text" DEFAULT 'libre'::"text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "type" "text",
    "nombre_chambres" integer,
    "adresse" "text",
    CONSTRAINT "logements_chambres_positive_ck" CHECK ((("nombre_chambres" IS NULL) OR ("nombre_chambres" > 0))),
    CONSTRAINT "logements_loyer_positive_ck" CHECK ((("loyer_mensuel" IS NULL) OR ("loyer_mensuel" > (0)::numeric))),
    CONSTRAINT "logements_statut_check" CHECK (("statut" = ANY (ARRAY['libre'::"text", 'occupe'::"text", 'maintenance'::"text"]))),
    CONSTRAINT "logements_type_check" CHECK ((("type" IS NULL) OR ("type" = ANY (ARRAY['appartement'::"text", 'chambre'::"text"]))))
);


ALTER TABLE "public"."logements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."logements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."logements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."logements_id_seq" OWNED BY "public"."logements"."id";



CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "agence_id" "uuid" NOT NULL,
    "proprietaire_id" "uuid" NOT NULL,
    "auteur_id" "uuid",
    "lu_par_destinataire" boolean DEFAULT false NOT NULL,
    "objet" "text",
    "corps" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."messages_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."messages_id_seq" OWNED BY "public"."messages"."id";



CREATE TABLE IF NOT EXISTS "public"."moyens_paiement" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "nom_titulaire" "text",
    "numero" "text",
    "lien_paiement" "text",
    "banque" "text",
    "num_compte" "text",
    "iban" "text",
    "bic" "text",
    "instructions" "text",
    "actif" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "moyens_paiement_lien_https_ck" CHECK ((("lien_paiement" IS NULL) OR ("btrim"("lien_paiement") = ''::"text") OR ("lien_paiement" ~ '^https://[^[:space:]]+$'::"text"))),
    CONSTRAINT "moyens_paiement_type_check" CHECK (("type" = ANY (ARRAY['wave'::"text", 'orange_money'::"text", 'virement'::"text", 'especes'::"text"])))
);


ALTER TABLE "public"."moyens_paiement" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moyens_paiement_employes" (
    "id" bigint NOT NULL,
    "employe_uid" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "nom_titulaire" "text",
    "numero" "text",
    "lien_paiement" "text",
    "banque" "text",
    "num_compte" "text",
    "iban" "text",
    "bic" "text",
    "instructions" "text",
    "actif" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "moyens_paiement_employes_lien_https_ck" CHECK ((("lien_paiement" IS NULL) OR ("btrim"("lien_paiement") = ''::"text") OR ("lien_paiement" ~ '^https://[^[:space:]]+$'::"text"))),
    CONSTRAINT "moyens_paiement_employes_type_check" CHECK (("type" = ANY (ARRAY['wave'::"text", 'orange_money'::"text", 'virement'::"text", 'especes'::"text"])))
);


ALTER TABLE "public"."moyens_paiement_employes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."moyens_paiement_employes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."moyens_paiement_employes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."moyens_paiement_employes_id_seq" OWNED BY "public"."moyens_paiement_employes"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."moyens_paiement_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."moyens_paiement_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."moyens_paiement_id_seq" OWNED BY "public"."moyens_paiement"."id";



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "message" "text" NOT NULL,
    "lu" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."notifications_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."notifications_id_seq" OWNED BY "public"."notifications"."id";



CREATE TABLE IF NOT EXISTS "public"."paiements" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "locataire_id" bigint,
    "logement_id" bigint,
    "montant" numeric(12,2) NOT NULL,
    "mois" "text" NOT NULL,
    "statut" "text" DEFAULT 'attente'::"text" NOT NULL,
    "date_paiement" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "methode_paiement" "text",
    "reference" "text",
    "validation_requested_at" timestamp with time zone,
    "validated_at" timestamp with time zone,
    "validated_by" "uuid",
    "rejection_reason" "text",
    "superseded_at" timestamp with time zone,
    CONSTRAINT "paiements_methode_check" CHECK ((("methode_paiement" IS NULL) OR ("methode_paiement" = ANY (ARRAY['especes'::"text", 'mobile_money'::"text", 'virement'::"text", 'carte'::"text", 'wave'::"text", 'orange_money'::"text"])))),
    CONSTRAINT "paiements_mois_ck" CHECK (("mois" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::"text")),
    CONSTRAINT "paiements_mois_valid_ck" CHECK ((("mois" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::"text") AND ("substring"("mois", 1, 4) <> '0000'::"text"))),
    CONSTRAINT "paiements_montant_ck" CHECK (("montant" > (0)::numeric)),
    CONSTRAINT "paiements_statut_check" CHECK (("statut" = ANY (ARRAY['attente'::"text", 'paye'::"text", 'retard'::"text", 'a_confirmer'::"text", 'en_validation'::"text", 'refuse'::"text"])))
);


ALTER TABLE "public"."paiements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."paiements_employes" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "employe_id" bigint,
    "employe_uid" "uuid",
    "montant" numeric(12,2) NOT NULL,
    "mois" "text" NOT NULL,
    "statut" "text" DEFAULT 'attente'::"text" NOT NULL,
    "date_paiement" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "methode_paiement" "text",
    "reference" "text",
    "confirmed_at" timestamp with time zone,
    "confirmed_by" "uuid",
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "moyen_employe_id" bigint,
    "superseded_at" timestamp with time zone,
    CONSTRAINT "paiements_employes_methode_check" CHECK ((("methode_paiement" IS NULL) OR ("methode_paiement" = ANY (ARRAY['especes'::"text", 'mobile_money'::"text", 'virement'::"text", 'carte'::"text", 'wave'::"text", 'orange_money'::"text"])))),
    CONSTRAINT "paiements_employes_mois_ck" CHECK (("mois" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::"text")),
    CONSTRAINT "paiements_employes_mois_valid_ck" CHECK ((("mois" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::"text") AND ("substring"("mois", 1, 4) <> '0000'::"text"))),
    CONSTRAINT "paiements_employes_montant_ck" CHECK (("montant" > (0)::numeric)),
    CONSTRAINT "paiements_employes_statut_check" CHECK (("statut" = ANY (ARRAY['paye'::"text", 'attente'::"text", 'non_recu'::"text"])))
);


ALTER TABLE "public"."paiements_employes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."paiements_employes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."paiements_employes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."paiements_employes_id_seq" OWNED BY "public"."paiements_employes"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."paiements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."paiements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."paiements_id_seq" OWNED BY "public"."paiements"."id";



CREATE TABLE IF NOT EXISTS "public"."password_reset_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "last_attempt_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "password_reset_status_ck" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'used'::"text", 'expired'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."password_reset_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."password_reset_tokens" IS 'Jetons de récupération de mot de passe (hachés, un usage, 30 min).';



COMMENT ON COLUMN "public"."password_reset_tokens"."token_hash" IS 'SHA-256 du jeton brut : le jeton en clair n''est jamais stocké.';



CREATE TABLE IF NOT EXISTS "public"."plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "nom" "text" NOT NULL,
    "type" "text" DEFAULT 'proprietaire'::"text" NOT NULL,
    "prix" numeric(12,2) NOT NULL,
    "devise" "text" DEFAULT 'XOF'::"text" NOT NULL,
    "max_immeubles" integer NOT NULL,
    "duree_abonnement" integer DEFAULT 12 NOT NULL,
    "description" "text",
    "actif" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "max_logements" integer,
    "max_locataires" integer,
    CONSTRAINT "plans_duree_positive" CHECK (("duree_abonnement" > 0)),
    CONSTRAINT "plans_max_immeubles_positive" CHECK (("max_immeubles" > 0)),
    CONSTRAINT "plans_max_locataires_ck" CHECK ((("max_locataires" IS NULL) OR ("max_locataires" > 0))),
    CONSTRAINT "plans_max_locataires_positive" CHECK ((("max_locataires" IS NULL) OR ("max_locataires" > 0))),
    CONSTRAINT "plans_max_logements_ck" CHECK ((("max_logements" IS NULL) OR ("max_logements" > 0))),
    CONSTRAINT "plans_max_logements_positive" CHECK ((("max_logements" IS NULL) OR ("max_logements" > 0))),
    CONSTRAINT "plans_prix_positive" CHECK (("prix" >= (0)::numeric))
);


ALTER TABLE "public"."plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_events" (
    "id" bigint NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "event_date" timestamp with time zone NOT NULL,
    "audience" "text" DEFAULT 'all'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_events_audience_check" CHECK (("audience" = ANY (ARRAY['all'::"text", 'owners'::"text", 'tenants'::"text", 'employees'::"text", 'admins'::"text"]))),
    CONSTRAINT "platform_events_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."platform_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."platform_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."platform_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."platform_events_id_seq" OWNED BY "public"."platform_events"."id";



CREATE TABLE IF NOT EXISTS "public"."prestataires" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "nom" "text" NOT NULL,
    "specialite" "text",
    "phone" "text",
    "email" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prestataires" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."prestataires_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."prestataires_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."prestataires_id_seq" OWNED BY "public"."prestataires"."id";



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "account_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "username" "text",
    "must_change_password" boolean DEFAULT false NOT NULL,
    "avatar_url" "text",
    CONSTRAINT "profiles_account_type_check" CHECK (("account_type" = ANY (ARRAY['proprietaire'::"text", 'agence'::"text", 'entreprise'::"text", 'locataire'::"text", 'admin'::"text", 'employe'::"text", 'ultra_admin'::"text"]))),
    CONSTRAINT "profiles_role_account_type_ck" CHECK (("role" = "account_type"))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quota_reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resource" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "idempotency_key" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "quota_reservations_expiration_ck" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "quota_reservations_quantity_ck" CHECK (("quantity" > 0)),
    CONSTRAINT "quota_reservations_resource_ck" CHECK (("resource" = ANY (ARRAY['biens'::"text", 'logements'::"text", 'locataires'::"text", 'employes'::"text", 'prestataires'::"text"]))),
    CONSTRAINT "quota_reservations_status_ck" CHECK (("status" = ANY (ARRAY['reserved'::"text", 'consumed'::"text", 'released'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."quota_reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sessions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "logout_at" timestamp with time zone,
    "token_hash" "text",
    "absolute_expires_at" timestamp with time zone DEFAULT ("clock_timestamp"() + '7 days'::interval),
    "revoked_at" timestamp with time zone,
    "revoked_reason" "text",
    "supabase_access_token" "text",
    "supabase_refresh_token" "text",
    "supabase_expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "mfa_factor_id" "text",
    "mfa_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "mfa_attempts" integer DEFAULT 0 NOT NULL,
    "mfa_processing_at" timestamp with time zone,
    CONSTRAINT "sessions_mfa_status_ck" CHECK (("mfa_status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'consumed'::"text"])))
);


ALTER TABLE "public"."sessions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sessions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sessions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sessions_id_seq" OWNED BY "public"."sessions"."id";



CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan" "text" DEFAULT 'standard'::"text" NOT NULL,
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "date_debut" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_expiration" timestamp with time zone NOT NULL,
    "date_paiement" timestamp with time zone,
    "montant" numeric(12,2),
    "methode_paiement" "text",
    "reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "plan_id" "uuid",
    "bictorys_transaction_id" "text",
    "bictorys_reference" "text",
    "duree_abonnement" integer,
    CONSTRAINT "subscriptions_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'expire'::"text", 'pending'::"text", 'cancelled'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_config" (
    "key" "text" NOT NULL,
    "value" "text" DEFAULT ''::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."system_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "employe_uid" "uuid",
    "titre" "text" NOT NULL,
    "description" "text",
    "statut" "text" DEFAULT 'a_faire'::"text" NOT NULL,
    "echeance" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tasks_statut_check" CHECK (("statut" = ANY (ARRAY['a_faire'::"text", 'en_cours'::"text", 'termine'::"text"])))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."tasks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."tasks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."tasks_id_seq" OWNED BY "public"."tasks"."id";



CREATE TABLE IF NOT EXISTS "public"."tenant_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token_hash" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "locataire_id" bigint NOT NULL,
    "account_uid" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "usage_count" integer DEFAULT 0 NOT NULL,
    "max_uses" integer DEFAULT 1 NOT NULL,
    "used_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "tenant_invitations_expiration_ck" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "tenant_invitations_hash_ck" CHECK (("length"("btrim"("token_hash")) >= 32)),
    CONSTRAINT "tenant_invitations_usage_ck" CHECK ((("max_uses" > 0) AND ("usage_count" >= 0) AND ("usage_count" <= "max_uses")))
);


ALTER TABLE "public"."tenant_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."versements" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "agence_id" "uuid" NOT NULL,
    "proprietaire_id" "uuid" NOT NULL,
    "bien_id" bigint,
    "montant" numeric(12,2) NOT NULL,
    "periode" "text",
    "statut" "text" DEFAULT 'attente'::"text" NOT NULL,
    "methode_paiement" "text",
    "reference" "text",
    "note" "text",
    "effectue_a" timestamp with time zone,
    "effectue_par" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "versements_methode_paiement_check" CHECK ((("methode_paiement" IS NULL) OR ("methode_paiement" = ANY (ARRAY['especes'::"text", 'mobile_money'::"text", 'virement'::"text", 'carte'::"text", 'wave'::"text", 'orange_money'::"text"])))),
    CONSTRAINT "versements_montant_check" CHECK (("montant" > (0)::numeric)),
    CONSTRAINT "versements_statut_check" CHECK (("statut" = ANY (ARRAY['attente'::"text", 'en_cours'::"text", 'effectue'::"text", 'annule'::"text"])))
);


ALTER TABLE "public"."versements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."versements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."versements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."versements_id_seq" OWNED BY "public"."versements"."id";



ALTER TABLE ONLY "public"."abonnement_paiements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."abonnement_paiements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agences_biens" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agences_biens_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agences_proprietaires" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agences_proprietaires_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."announcements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."announcements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."audit_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bictorys_webhooks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bictorys_webhooks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."biens" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."biens_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employes_biens" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employes_biens_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."featured_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."featured_items_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."import_run_rows" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."import_run_rows_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."incidents" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."incidents_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."interventions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."interventions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."locataires" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."locataires_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."logements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."logements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."messages_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."moyens_paiement" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."moyens_paiement_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."moyens_paiement_employes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."moyens_paiement_employes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."notifications" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notifications_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."paiements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."paiements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."paiements_employes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."paiements_employes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."platform_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."platform_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."prestataires" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."prestataires_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sessions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sessions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."tasks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tasks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."versements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."versements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."abonnement_paiements"
    ADD CONSTRAINT "abonnement_paiements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_recovery_emails"
    ADD CONSTRAINT "account_recovery_emails_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_unique" UNIQUE ("agence_id", "bien_id");



ALTER TABLE ONLY "public"."agences_proprietaires"
    ADD CONSTRAINT "agences_proprietaires_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agences_proprietaires"
    ADD CONSTRAINT "agences_proprietaires_unique" UNIQUE ("agence_id", "proprietaire_id");



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bictorys_webhooks"
    ADD CONSTRAINT "bictorys_webhooks_fingerprint_key" UNIQUE ("fingerprint");



ALTER TABLE ONLY "public"."bictorys_webhooks"
    ADD CONSTRAINT "bictorys_webhooks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."biens"
    ADD CONSTRAINT "biens_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."biens"
    ADD CONSTRAINT "biens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_unique" UNIQUE ("employe_id", "bien_id");



ALTER TABLE ONLY "public"."employes"
    ADD CONSTRAINT "employes_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."employes"
    ADD CONSTRAINT "employes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."featured_items"
    ADD CONSTRAINT "featured_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_run_rows"
    ADD CONSTRAINT "import_run_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_runs"
    ADD CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."logements"
    ADD CONSTRAINT "logements_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."logements"
    ADD CONSTRAINT "logements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moyens_paiement_employes"
    ADD CONSTRAINT "moyens_paiement_employes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moyens_paiement"
    ADD CONSTRAINT "moyens_paiement_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_events"
    ADD CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prestataires"
    ADD CONSTRAINT "prestataires_id_user_id_key" UNIQUE ("id", "user_id");



ALTER TABLE ONLY "public"."prestataires"
    ADD CONSTRAINT "prestataires_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quota_reservations"
    ADD CONSTRAINT "quota_reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."system_config"
    ADD CONSTRAINT "system_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_invitations"
    ADD CONSTRAINT "tenant_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_invitations"
    ADD CONSTRAINT "tenant_invitations_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "abonnement_paiements_idempotency_uidx" ON "public"."abonnement_paiements" USING "btree" ("user_id", "provider", "idempotency_key") WHERE (("idempotency_key" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "abonnement_paiements_transaction_uidx" ON "public"."abonnement_paiements" USING "btree" ("provider", "transaction_id") WHERE (("transaction_id" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE INDEX "abonnement_paiements_user_statut_idx" ON "public"."abonnement_paiements" USING "btree" ("user_id", "statut", "created_at" DESC);



CREATE UNIQUE INDEX "account_recovery_emails_email_uidx" ON "public"."account_recovery_emails" USING "btree" ("lower"("email"));



CREATE INDEX "agences_biens_bien_idx" ON "public"."agences_biens" USING "btree" ("bien_id");



CREATE INDEX "agences_biens_proprietaire_idx" ON "public"."agences_biens" USING "btree" ("proprietaire_id");



CREATE INDEX "agences_proprietaires_proprietaire_idx" ON "public"."agences_proprietaires" USING "btree" ("proprietaire_id");



CREATE UNIQUE INDEX "bictorys_webhooks_event_id_uidx" ON "public"."bictorys_webhooks" USING "btree" ("event_id") WHERE ("event_id" IS NOT NULL);



CREATE INDEX "bictorys_webhooks_payment_reference_idx" ON "public"."bictorys_webhooks" USING "btree" ("payment_reference");



CREATE UNIQUE INDEX "employes_account_uid_uidx" ON "public"."employes" USING "btree" ("account_uid") WHERE (("account_uid" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "employes_biens_owner_employee_bien_uidx" ON "public"."employes_biens" USING "btree" ("user_id", "employe_id", "bien_id");



CREATE INDEX "idx_announcements_audience" ON "public"."announcements" USING "btree" ("audience");



CREATE INDEX "idx_announcements_status" ON "public"."announcements" USING "btree" ("status");



CREATE INDEX "idx_audit_logs_action" ON "public"."audit_logs" USING "btree" ("action");



CREATE INDEX "idx_audit_logs_created_at" ON "public"."audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_logs_level" ON "public"."audit_logs" USING "btree" ("level");



CREATE INDEX "idx_audit_logs_user_id" ON "public"."audit_logs" USING "btree" ("user_id");



CREATE INDEX "idx_featured_items_priority" ON "public"."featured_items" USING "btree" ("priority" DESC);



CREATE INDEX "idx_featured_items_target" ON "public"."featured_items" USING "btree" ("target_type", "target_id");



CREATE INDEX "idx_moyens_paiement_employes_uid" ON "public"."moyens_paiement_employes" USING "btree" ("employe_uid");



CREATE INDEX "idx_platform_events_date" ON "public"."platform_events" USING "btree" ("event_date");



CREATE INDEX "idx_platform_events_status" ON "public"."platform_events" USING "btree" ("status");



CREATE UNIQUE INDEX "import_run_rows_run_number_uidx" ON "public"."import_run_rows" USING "btree" ("run_id", "row_number") WHERE ("superseded_at" IS NULL);



CREATE UNIQUE INDEX "import_runs_user_idempotency_uidx" ON "public"."import_runs" USING "btree" ("user_id", "idempotency_key") WHERE (("idempotency_key" IS NOT NULL) AND ("status" <> 'failed'::"text") AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "locataires_account_uid_uidx" ON "public"."locataires" USING "btree" ("account_uid") WHERE (("account_uid" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "locataires_logement_actif_uidx" ON "public"."locataires" USING "btree" ("logement_id") WHERE (("logement_id" IS NOT NULL) AND ("statut" = 'actif'::"text") AND ("superseded_at" IS NULL));



CREATE INDEX "messages_agence_created_idx" ON "public"."messages" USING "btree" ("agence_id", "created_at" DESC);



CREATE INDEX "messages_proprietaire_created_idx" ON "public"."messages" USING "btree" ("proprietaire_id", "created_at" DESC);



CREATE UNIQUE INDEX "paiements_employes_employe_mois_uidx" ON "public"."paiements_employes" USING "btree" ("user_id", "employe_id", "mois") WHERE (("employe_id" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "paiements_employes_employe_uid_mois_uidx" ON "public"."paiements_employes" USING "btree" ("user_id", "employe_uid", "mois") WHERE (("employe_uid" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE UNIQUE INDEX "paiements_locataire_mois_uidx" ON "public"."paiements" USING "btree" ("user_id", "locataire_id", "mois") WHERE (("locataire_id" IS NOT NULL) AND ("superseded_at" IS NULL));



CREATE INDEX "password_reset_tokens_expires_at_idx" ON "public"."password_reset_tokens" USING "btree" ("expires_at");



CREATE INDEX "password_reset_tokens_user_id_idx" ON "public"."password_reset_tokens" USING "btree" ("user_id");



CREATE UNIQUE INDEX "profiles_username_uniq" ON "public"."profiles" USING "btree" ("username") WHERE ("username" IS NOT NULL);



CREATE UNIQUE INDEX "quota_reservations_idempotency_uidx" ON "public"."quota_reservations" USING "btree" ("user_id", "resource", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "sessions_mfa_pending_idx" ON "public"."sessions" USING "btree" ("token_hash") WHERE (("action" = 'mfa_pending'::"text") AND ("revoked_at" IS NULL));



CREATE UNIQUE INDEX "sessions_token_hash_uidx" ON "public"."sessions" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE UNIQUE INDEX "tenant_invitations_active_tenant_uidx" ON "public"."tenant_invitations" USING "btree" ("user_id", "locataire_id") WHERE ("revoked_at" IS NULL);



CREATE UNIQUE INDEX "tenant_invitations_token_hash_uidx" ON "public"."tenant_invitations" USING "btree" ("token_hash");



CREATE INDEX "versements_agence_created_idx" ON "public"."versements" USING "btree" ("agence_id", "created_at" DESC);



CREATE INDEX "versements_proprietaire_statut_idx" ON "public"."versements" USING "btree" ("proprietaire_id", "statut");



CREATE OR REPLACE TRIGGER "employes_biens_owner_guard" BEFORE INSERT OR UPDATE OF "user_id", "employe_id", "bien_id" ON "public"."employes_biens" FOR EACH ROW EXECUTE FUNCTION "public"."employes_biens_owner_guard"();



CREATE OR REPLACE TRIGGER "tenant_invitations_guard" BEFORE INSERT OR UPDATE ON "public"."tenant_invitations" FOR EACH ROW EXECUTE FUNCTION "public"."tenant_invitations_guard"();



ALTER TABLE ONLY "public"."abonnement_paiements"
    ADD CONSTRAINT "abonnement_paiements_plan_fkey" FOREIGN KEY ("plan") REFERENCES "public"."plans"("code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."abonnement_paiements"
    ADD CONSTRAINT "abonnement_paiements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."account_recovery_emails"
    ADD CONSTRAINT "account_recovery_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_agence_id_fkey" FOREIGN KEY ("agence_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_bien_id_fkey" FOREIGN KEY ("bien_id") REFERENCES "public"."biens"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_proprietaire_id_fkey" FOREIGN KEY ("proprietaire_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_biens"
    ADD CONSTRAINT "agences_biens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_proprietaires"
    ADD CONSTRAINT "agences_proprietaires_agence_id_fkey" FOREIGN KEY ("agence_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_proprietaires"
    ADD CONSTRAINT "agences_proprietaires_proprietaire_id_fkey" FOREIGN KEY ("proprietaire_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agences_proprietaires"
    ADD CONSTRAINT "agences_proprietaires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."biens"
    ADD CONSTRAINT "biens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes"
    ADD CONSTRAINT "employes_account_uid_fkey" FOREIGN KEY ("account_uid") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_bien_id_fkey" FOREIGN KEY ("bien_id") REFERENCES "public"."biens"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_bien_owner_fk" FOREIGN KEY ("bien_id", "user_id") REFERENCES "public"."biens"("id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_employe_id_fkey" FOREIGN KEY ("employe_id") REFERENCES "public"."employes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_employe_owner_fk" FOREIGN KEY ("employe_id", "user_id") REFERENCES "public"."employes"("id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes_biens"
    ADD CONSTRAINT "employes_biens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employes"
    ADD CONSTRAINT "employes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."featured_items"
    ADD CONSTRAINT "featured_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."import_run_rows"
    ADD CONSTRAINT "import_run_rows_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."import_runs"
    ADD CONSTRAINT "import_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_logement_id_fkey" FOREIGN KEY ("logement_id") REFERENCES "public"."logements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_logement_owner_fk" FOREIGN KEY ("logement_id", "user_id") REFERENCES "public"."logements"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."employes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_incident_owner_fk" FOREIGN KEY ("incident_id", "user_id") REFERENCES "public"."incidents"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_logement_id_fkey" FOREIGN KEY ("logement_id") REFERENCES "public"."logements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_logement_owner_fk" FOREIGN KEY ("logement_id", "user_id") REFERENCES "public"."logements"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_prestataire_id_fkey" FOREIGN KEY ("prestataire_id") REFERENCES "public"."prestataires"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_prestataire_owner_fk" FOREIGN KEY ("prestataire_id", "user_id") REFERENCES "public"."prestataires"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."interventions"
    ADD CONSTRAINT "interventions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_account_uid_fkey" FOREIGN KEY ("account_uid") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_bien_id_fkey" FOREIGN KEY ("bien_id") REFERENCES "public"."biens"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_bien_owner_fk" FOREIGN KEY ("bien_id", "user_id") REFERENCES "public"."biens"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_logement_id_fkey" FOREIGN KEY ("logement_id") REFERENCES "public"."logements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_logement_owner_fk" FOREIGN KEY ("logement_id", "user_id") REFERENCES "public"."logements"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."locataires"
    ADD CONSTRAINT "locataires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."logements"
    ADD CONSTRAINT "logements_bien_id_fkey" FOREIGN KEY ("bien_id") REFERENCES "public"."biens"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."logements"
    ADD CONSTRAINT "logements_bien_owner_fk" FOREIGN KEY ("bien_id", "user_id") REFERENCES "public"."biens"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."logements"
    ADD CONSTRAINT "logements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_agence_id_fkey" FOREIGN KEY ("agence_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_proprietaire_id_fkey" FOREIGN KEY ("proprietaire_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moyens_paiement_employes"
    ADD CONSTRAINT "moyens_paiement_employes_employe_uid_fkey" FOREIGN KEY ("employe_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moyens_paiement"
    ADD CONSTRAINT "moyens_paiement_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_employe_owner_fk" FOREIGN KEY ("employe_id", "user_id") REFERENCES "public"."employes"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_employe_restrict_fk" FOREIGN KEY ("employe_id") REFERENCES "public"."employes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_employe_uid_fkey" FOREIGN KEY ("employe_uid") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_moyen_employe_id_fkey" FOREIGN KEY ("moyen_employe_id") REFERENCES "public"."moyens_paiement_employes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."paiements_employes"
    ADD CONSTRAINT "paiements_employes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_locataire_owner_fk" FOREIGN KEY ("locataire_id", "user_id") REFERENCES "public"."locataires"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_locataire_restrict_fk" FOREIGN KEY ("locataire_id") REFERENCES "public"."locataires"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_logement_id_fkey" FOREIGN KEY ("logement_id") REFERENCES "public"."logements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_logement_owner_fk" FOREIGN KEY ("logement_id", "user_id") REFERENCES "public"."logements"("id", "user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."paiements"
    ADD CONSTRAINT "paiements_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_events"
    ADD CONSTRAINT "platform_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prestataires"
    ADD CONSTRAINT "prestataires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quota_reservations"
    ADD CONSTRAINT "quota_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_employe_uid_fkey" FOREIGN KEY ("employe_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_invitations"
    ADD CONSTRAINT "tenant_invitations_account_uid_fkey" FOREIGN KEY ("account_uid") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_invitations"
    ADD CONSTRAINT "tenant_invitations_locataire_id_fkey" FOREIGN KEY ("locataire_id") REFERENCES "public"."locataires"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."tenant_invitations"
    ADD CONSTRAINT "tenant_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_agence_id_fkey" FOREIGN KEY ("agence_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_bien_id_fkey" FOREIGN KEY ("bien_id") REFERENCES "public"."biens"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_effectue_par_fkey" FOREIGN KEY ("effectue_par") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_proprietaire_id_fkey" FOREIGN KEY ("proprietaire_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."versements"
    ADD CONSTRAINT "versements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE "public"."abonnement_paiements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_recovery_emails" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_read_announcements" ON "public"."announcements" FOR SELECT TO "authenticated" USING ((("status" = 'published'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = ANY (ARRAY['admin'::"text", 'ultra_admin'::"text"])))))));



CREATE POLICY "admin_read_audit_logs" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = ANY (ARRAY['admin'::"text", 'ultra_admin'::"text"]))))));



CREATE POLICY "admin_read_events" ON "public"."platform_events" FOR SELECT TO "authenticated" USING ((("status" = 'published'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = ANY (ARRAY['admin'::"text", 'ultra_admin'::"text"])))))));



CREATE POLICY "agence_all_agences_biens" ON "public"."agences_biens" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "agence_all_agences_proprietaires" ON "public"."agences_proprietaires" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "agence_all_messages" ON "public"."messages" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "agence_all_versements" ON "public"."versements" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."agences_biens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agences_proprietaires" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated_select_plans" ON "public"."plans" FOR SELECT TO "authenticated" USING (("actif" = true));



ALTER TABLE "public"."bictorys_webhooks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."biens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employe_all_own_moyens" ON "public"."moyens_paiement_employes" USING (("employe_uid" = "auth"."uid"())) WITH CHECK (("employe_uid" = "auth"."uid"()));



CREATE POLICY "employe_select_biens_affectes" ON "public"."biens" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."employes_biens" "eb"
     JOIN "public"."employes" "e" ON (("e"."id" = "eb"."employe_id")))
  WHERE (("e"."account_uid" = "auth"."uid"()) AND ("eb"."bien_id" = "biens"."id")))));



CREATE POLICY "employe_select_incidents_affectes" ON "public"."incidents" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."logements" "lg"
     JOIN "public"."employes_biens" "eb" ON (("eb"."bien_id" = "lg"."bien_id")))
     JOIN "public"."employes" "e" ON (("e"."id" = "eb"."employe_id")))
  WHERE (("lg"."id" = "incidents"."logement_id") AND ("e"."account_uid" = "auth"."uid"())))));



CREATE POLICY "employe_select_interventions_affectes" ON "public"."interventions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."logements" "lg"
     JOIN "public"."employes_biens" "eb" ON (("eb"."bien_id" = "lg"."bien_id")))
     JOIN "public"."employes" "e" ON (("e"."id" = "eb"."employe_id")))
  WHERE (("lg"."id" = "interventions"."logement_id") AND ("e"."account_uid" = "auth"."uid"())))));



CREATE POLICY "employe_select_locataires_affectes" ON "public"."locataires" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."employes_biens" "eb"
     JOIN "public"."employes" "e" ON (("e"."id" = "eb"."employe_id")))
  WHERE (("e"."account_uid" = "auth"."uid"()) AND ("eb"."bien_id" = "locataires"."bien_id")))));



CREATE POLICY "employe_select_logements_affectes" ON "public"."logements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."employes_biens" "eb"
     JOIN "public"."employes" "e" ON (("e"."id" = "eb"."employe_id")))
  WHERE (("e"."account_uid" = "auth"."uid"()) AND ("eb"."bien_id" = "logements"."bien_id")))));



CREATE POLICY "employe_select_own_employe" ON "public"."employes" FOR SELECT USING (("account_uid" = "auth"."uid"()));



CREATE POLICY "employe_select_own_employes_biens" ON "public"."employes_biens" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."employes" "e"
  WHERE (("e"."account_uid" = "auth"."uid"()) AND ("e"."id" = "employes_biens"."employe_id")))));



CREATE POLICY "employe_select_own_paiements" ON "public"."paiements_employes" FOR SELECT USING (("employe_uid" = "auth"."uid"()));



CREATE POLICY "employe_select_own_tasks" ON "public"."tasks" FOR SELECT USING (("employe_uid" = "auth"."uid"()));



CREATE POLICY "employe_update_own_paiements" ON "public"."paiements_employes" FOR UPDATE USING (("employe_uid" = "auth"."uid"())) WITH CHECK (("employe_uid" = "auth"."uid"()));



ALTER TABLE "public"."employes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employes_biens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."featured_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."import_run_rows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."import_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incidents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interventions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."locataires" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."logements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."moyens_paiement" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."moyens_paiement_employes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_delete_own" ON "public"."notifications" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "notifications_select_own" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "notifications_update_own" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "owner_all_biens" ON "public"."biens" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_employes" ON "public"."employes" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_incidents" ON "public"."incidents" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_interventions" ON "public"."interventions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_locataires" ON "public"."locataires" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_logements" ON "public"."logements" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_moyens_paiement" ON "public"."moyens_paiement" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_paiements" ON "public"."paiements" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_paiements_employes" ON "public"."paiements_employes" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_prestataires" ON "public"."prestataires" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_sessions" ON "public"."sessions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_all_tasks" ON "public"."tasks" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_select_employe_moyens" ON "public"."moyens_paiement_employes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."employes" "e"
  WHERE (("e"."account_uid" = "moyens_paiement_employes"."employe_uid") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "owner_select_own_abonnement_paiements" ON "public"."abonnement_paiements" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "owner_select_own_subscription" ON "public"."subscriptions" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."paiements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."paiements_employes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."password_reset_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prestataires" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "proprietaire_select_own_bien_liaison" ON "public"."agences_biens" FOR SELECT USING (("proprietaire_id" = "auth"."uid"()));



CREATE POLICY "proprietaire_select_own_liaison" ON "public"."agences_proprietaires" FOR SELECT USING (("proprietaire_id" = "auth"."uid"()));



CREATE POLICY "proprietaire_select_own_messages" ON "public"."messages" FOR SELECT USING (("proprietaire_id" = "auth"."uid"()));



CREATE POLICY "proprietaire_select_own_versements" ON "public"."versements" FOR SELECT USING (("proprietaire_id" = "auth"."uid"()));



CREATE POLICY "public_read_featured" ON "public"."featured_items" FOR SELECT USING (true);



ALTER TABLE "public"."quota_reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenant_invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_select_bien" ON "public"."biens" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."logements" "lg"
     JOIN "public"."locataires" "l" ON (("l"."logement_id" = "lg"."id")))
  WHERE (("lg"."bien_id" = "biens"."id") AND ("l"."account_uid" = "auth"."uid"())))));



CREATE POLICY "tenant_select_incident" ON "public"."incidents" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."logements" "lg"
     JOIN "public"."locataires" "l" ON (("l"."logement_id" = "lg"."id")))
  WHERE (("lg"."id" = "incidents"."logement_id") AND ("l"."account_uid" = "auth"."uid"())))));



CREATE POLICY "tenant_select_locataire" ON "public"."locataires" FOR SELECT TO "authenticated" USING (("account_uid" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "tenant_select_logement" ON "public"."logements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."locataires" "l"
  WHERE (("l"."account_uid" = "auth"."uid"()) AND ("l"."logement_id" = "logements"."id")))));



CREATE POLICY "tenant_select_moyens_paiement" ON "public"."moyens_paiement" FOR SELECT USING ((("actif" = true) AND (EXISTS ( SELECT 1
   FROM ("public"."locataires" "l"
     JOIN "public"."logements" "lg" ON (("lg"."id" = "l"."logement_id")))
  WHERE (("l"."account_uid" = "auth"."uid"()) AND ("lg"."user_id" = "moyens_paiement"."user_id"))))));



CREATE POLICY "tenant_select_paiement" ON "public"."paiements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."locataires" "l"
  WHERE (("l"."account_uid" = "auth"."uid"()) AND ("l"."id" = "paiements"."locataire_id")))));



CREATE POLICY "ultra_admin_all_announcements" ON "public"."announcements" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = 'ultra_admin'::"text")))));



CREATE POLICY "ultra_admin_all_events" ON "public"."platform_events" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = 'ultra_admin'::"text")))));



CREATE POLICY "ultra_admin_all_featured" ON "public"."featured_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = 'ultra_admin'::"text")))));



CREATE POLICY "ultra_admin_all_system_config" ON "public"."system_config" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."account_type" = 'ultra_admin'::"text")))));



CREATE POLICY "users_can_update_own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "users_can_view_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."versements" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text", "p_paid_at" timestamp with time zone, "p_expected_amount" numeric, "p_currency" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text", "p_paid_at" timestamp with time zone, "p_expected_amount" numeric, "p_currency" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_tenant_invitation"("p_token_hash" "text", "p_account_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_tenant_invitation"("p_token_hash" "text", "p_account_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_tenant_invitation"("p_user_id" "uuid", "p_locataire_id" bigint, "p_token_hash" "text", "p_expires_at" timestamp with time zone, "p_max_uses" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_tenant_invitation"("p_user_id" "uuid", "p_locataire_id" bigint, "p_token_hash" "text", "p_expires_at" timestamp with time zone, "p_max_uses" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."employes_biens_owner_guard"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."employes_biens_owner_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_public_auth_metadata"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_public_auth_metadata"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_manual_subscription_payment"("p_user_id" "uuid", "p_plan_code" "text", "p_amount" numeric, "p_reference" "text", "p_method" "text", "p_paid_at" timestamp with time zone, "p_duration" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_manual_subscription_payment"("p_user_id" "uuid", "p_plan_code" "text", "p_amount" numeric, "p_reference" "text", "p_method" "text", "p_paid_at" timestamp with time zone, "p_duration" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_quota"("p_reservation_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_quota"("p_user_id" "uuid", "p_resource" "text", "p_quantity" integer, "p_idempotency_key" "text", "p_ttl" interval, "p_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_quota"("p_user_id" "uuid", "p_resource" "text", "p_quantity" integer, "p_idempotency_key" "text", "p_ttl" interval, "p_metadata" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."tenant_invitations_guard"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tenant_invitations_guard"() TO "service_role";



GRANT ALL ON TABLE "public"."abonnement_paiements" TO "service_role";
GRANT SELECT ON TABLE "public"."abonnement_paiements" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."abonnement_paiements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."account_recovery_emails" TO "service_role";



GRANT ALL ON TABLE "public"."agences_biens" TO "service_role";
GRANT SELECT ON TABLE "public"."agences_biens" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."agences_biens_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agences_proprietaires" TO "service_role";
GRANT SELECT ON TABLE "public"."agences_proprietaires" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."agences_proprietaires_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."announcements" TO "service_role";



GRANT ALL ON SEQUENCE "public"."announcements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bictorys_webhooks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bictorys_webhooks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."biens" TO "service_role";
GRANT SELECT ON TABLE "public"."biens" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."biens_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."employes" TO "service_role";
GRANT SELECT ON TABLE "public"."employes" TO "authenticated";



GRANT ALL ON TABLE "public"."employes_biens" TO "service_role";
GRANT SELECT ON TABLE "public"."employes_biens" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."employes_biens_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."featured_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."featured_items_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."import_run_rows" TO "service_role";



GRANT ALL ON SEQUENCE "public"."import_run_rows_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."import_runs" TO "service_role";



GRANT ALL ON TABLE "public"."incidents" TO "service_role";
GRANT SELECT ON TABLE "public"."incidents" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."incidents_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."interventions" TO "service_role";
GRANT SELECT ON TABLE "public"."interventions" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."interventions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."locataires" TO "service_role";
GRANT SELECT ON TABLE "public"."locataires" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."locataires_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."logements" TO "service_role";
GRANT SELECT ON TABLE "public"."logements" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."logements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "service_role";
GRANT SELECT ON TABLE "public"."messages" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."moyens_paiement" TO "service_role";
GRANT SELECT ON TABLE "public"."moyens_paiement" TO "authenticated";



GRANT ALL ON TABLE "public"."moyens_paiement_employes" TO "service_role";
GRANT SELECT ON TABLE "public"."moyens_paiement_employes" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."moyens_paiement_employes_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."moyens_paiement_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "service_role";
GRANT SELECT,DELETE ON TABLE "public"."notifications" TO "authenticated";



GRANT UPDATE("lu") ON TABLE "public"."notifications" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."paiements" TO "service_role";
GRANT SELECT ON TABLE "public"."paiements" TO "authenticated";



GRANT ALL ON TABLE "public"."paiements_employes" TO "service_role";
GRANT SELECT ON TABLE "public"."paiements_employes" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."paiements_employes_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."paiements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."password_reset_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "service_role";
GRANT SELECT ON TABLE "public"."plans" TO "authenticated";



GRANT ALL ON TABLE "public"."platform_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."platform_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."prestataires" TO "service_role";
GRANT SELECT ON TABLE "public"."prestataires" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."prestataires_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("name") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("phone") ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."quota_reservations" TO "service_role";



GRANT ALL ON TABLE "public"."sessions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sessions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";
GRANT SELECT ON TABLE "public"."subscriptions" TO "authenticated";



GRANT ALL ON TABLE "public"."system_config" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "service_role";
GRANT SELECT ON TABLE "public"."tasks" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."tasks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."versements" TO "service_role";
GRANT SELECT ON TABLE "public"."versements" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."versements_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";
