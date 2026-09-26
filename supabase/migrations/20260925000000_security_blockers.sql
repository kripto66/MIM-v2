ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS mfa_factor_id TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS mfa_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS mfa_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS mfa_processing_at TIMESTAMPTZ;
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_mfa_status_ck;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_mfa_status_ck CHECK (mfa_status IN ('pending','processing','consumed')) NOT VALID;
CREATE INDEX IF NOT EXISTS sessions_mfa_pending_idx ON public.sessions (token_hash) WHERE action = 'mfa_pending' AND revoked_at IS NULL;
DROP INDEX IF EXISTS public.paiements_locataire_mois_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_locataire_mois_uidx ON public.paiements (user_id,locataire_id,mois) WHERE locataire_id IS NOT NULL AND superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.guard_public_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
DROP TRIGGER IF EXISTS mim_guard_public_auth_metadata ON auth.users;
CREATE TRIGGER mim_guard_public_auth_metadata BEFORE INSERT OR UPDATE OF raw_user_meta_data ON auth.users FOR EACH ROW EXECUTE FUNCTION public.guard_public_auth_metadata();

CREATE UNIQUE INDEX IF NOT EXISTS employes_biens_owner_employee_bien_uidx ON public.employes_biens (user_id, employe_id, bien_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.employes_biens'::regclass AND conname = 'employes_biens_employe_owner_fk') THEN
        ALTER TABLE public.employes_biens ADD CONSTRAINT employes_biens_employe_owner_fk FOREIGN KEY (employe_id,user_id) REFERENCES public.employes(id,user_id) ON DELETE CASCADE NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.employes_biens'::regclass AND conname = 'employes_biens_bien_owner_fk') THEN
        ALTER TABLE public.employes_biens ADD CONSTRAINT employes_biens_bien_owner_fk FOREIGN KEY (bien_id,user_id) REFERENCES public.biens(id,user_id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.employes_biens_owner_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;
DROP TRIGGER IF EXISTS employes_biens_owner_guard ON public.employes_biens;
CREATE TRIGGER employes_biens_owner_guard BEFORE INSERT OR UPDATE OF user_id,employe_id,bien_id ON public.employes_biens FOR EACH ROW EXECUTE FUNCTION public.employes_biens_owner_guard();

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id,locataire_id ORDER BY created_at DESC NULLS LAST,id DESC) AS rn
    FROM public.tenant_invitations
    WHERE revoked_at IS NULL
)
UPDATE public.tenant_invitations t SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
FROM ranked r WHERE t.id = r.id AND r.rn > 1;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_active_tenant_uidx ON public.tenant_invitations (user_id,locataire_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.create_tenant_invitation(p_user_id uuid,p_locataire_id bigint,p_token_hash text,p_expires_at timestamptz DEFAULT NULL,p_max_uses integer DEFAULT 1)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.consume_tenant_invitation(p_token_hash text,p_account_uid uuid)
RETURNS TABLE(invitation_id uuid,owner_id uuid,tenant_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

DROP POLICY IF EXISTS "tenant_select_by_email" ON public.locataires;
DROP POLICY IF EXISTS "tenant_link_locataire" ON public.locataires;
DROP POLICY IF EXISTS "owner_all_employes_biens" ON public.employes_biens;

ALTER TABLE public.employes_biens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employes_biens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.profiles,public.biens,public.logements,public.locataires,public.paiements,public.incidents,public.prestataires,public.interventions,public.notifications,public.employes,public.tasks,public.paiements_employes,public.employes_biens,public.moyens_paiement,public.moyens_paiement_employes,public.plans,public.subscriptions,public.abonnement_paiements,public.agences_proprietaires,public.agences_biens,public.versements,public.messages TO authenticated;
GRANT UPDATE (name,phone) ON public.profiles TO authenticated;
GRANT UPDATE (lu) ON public.notifications TO authenticated;
GRANT DELETE ON public.notifications TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.employes_biens FROM anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.locataires FROM anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.profiles FROM anon,authenticated;
GRANT UPDATE (name,phone) ON public.profiles TO authenticated;
REVOKE ALL ON public.sessions,public.bictorys_webhooks,public.password_reset_tokens,public.tenant_invitations,public.quota_reservations,public.import_runs,public.import_run_rows FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_public_auth_metadata() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.employes_biens_owner_guard() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.create_tenant_invitation(UUID,BIGINT,TEXT,TIMESTAMPTZ,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_tenant_invitation(TEXT,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_public_auth_metadata() TO service_role;
GRANT EXECUTE ON FUNCTION public.employes_biens_owner_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_tenant_invitation(UUID,BIGINT,TEXT,TIMESTAMPTZ,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_tenant_invitation(TEXT,UUID) TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon,authenticated;
