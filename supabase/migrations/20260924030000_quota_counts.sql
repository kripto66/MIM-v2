CREATE OR REPLACE FUNCTION public.reserve_quota(p_user_id uuid,p_resource text,p_quantity integer DEFAULT 1,p_idempotency_key text DEFAULT NULL,p_ttl interval DEFAULT interval '15 minutes',p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) TO service_role;
