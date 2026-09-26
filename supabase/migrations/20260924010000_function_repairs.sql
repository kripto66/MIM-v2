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
    ELSIF v_resource = 'locataires' THEN SELECT count(*) INTO v_current FROM public.locataires WHERE user_id = p_user_id AND statut = 'actif' AND superseded_at IS NULL;
    ELSE v_current := 0; END IF;
    SELECT COALESCE(sum(quantity),0) INTO v_reserved FROM public.quota_reservations WHERE user_id = p_user_id AND resource = v_resource AND status = 'reserved' AND expires_at > v_now;
    IF v_limit IS NOT NULL AND v_current + v_reserved + p_quantity > v_limit THEN RAISE EXCEPTION 'Quota de plan atteint pour %',v_resource; END IF;
    INSERT INTO public.quota_reservations(user_id,resource,quantity,idempotency_key,expires_at,metadata) VALUES(p_user_id,v_resource,p_quantity,v_key,v_now + p_ttl,COALESCE(p_metadata,'{}'::jsonb)) RETURNING id INTO v_id;
    RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.activate_subscription_payment(p_payment_id bigint,p_transaction_id text DEFAULT NULL,p_paid_at timestamptz DEFAULT NULL,p_expected_amount numeric DEFAULT NULL,p_currency text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_subscription_payment(BIGINT,TEXT,TIMESTAMPTZ,NUMERIC,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_subscription_payment(BIGINT,TEXT,TIMESTAMPTZ,NUMERIC,TEXT) TO service_role;
