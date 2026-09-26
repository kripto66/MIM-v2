ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check CHECK (account_type IN ('proprietaire','agence','entreprise','locataire','admin','employe','ultra_admin'));

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS absolute_expires_at TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS supabase_access_token TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS supabase_refresh_token TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS supabase_expires_at TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE public.sessions ALTER COLUMN absolute_expires_at SET DEFAULT (clock_timestamp() + interval '7 days');

ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
UPDATE public.password_reset_tokens SET status = 'used' WHERE used_at IS NOT NULL AND status = 'pending';
UPDATE public.password_reset_tokens SET status = 'expired' WHERE expires_at <= clock_timestamp() AND used_at IS NULL AND status = 'pending';

ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS duree_abonnement INTEGER;
UPDATE public.abonnement_paiements SET idempotency_key = reference WHERE idempotency_key IS NULL AND reference IS NOT NULL;

ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE public.employes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE public.paiements_employes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.tenant_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    locataire_id BIGINT NOT NULL REFERENCES public.locataires(id) ON DELETE RESTRICT,
    account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tenant_invitations_usage_ck CHECK (max_uses > 0 AND usage_count >= 0 AND usage_count <= max_uses),
    CONSTRAINT tenant_invitations_expiration_ck CHECK (expires_at > created_at),
    CONSTRAINT tenant_invitations_hash_ck CHECK (length(btrim(token_hash)) >= 32)
);

CREATE TABLE IF NOT EXISTS public.quota_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'reserved',
    idempotency_key TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT quota_reservations_resource_ck CHECK (resource IN ('biens','logements','locataires','employes','prestataires')),
    CONSTRAINT quota_reservations_quantity_ck CHECK (quantity > 0),
    CONSTRAINT quota_reservations_status_ck CHECK (status IN ('reserved','consumed','released','expired')),
    CONSTRAINT quota_reservations_expiration_ck CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS public.import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    idempotency_key TEXT,
    source_filename TEXT,
    source_checksum TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total_rows INTEGER NOT NULL DEFAULT 0,
    processed_rows INTEGER NOT NULL DEFAULT 0,
    created_rows INTEGER NOT NULL DEFAULT 0,
    updated_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    superseded_at TIMESTAMPTZ,
    CONSTRAINT import_runs_status_ck CHECK (status IN ('running','completed','failed','aborted')),
    CONSTRAINT import_runs_counters_ck CHECK (total_rows >= 0 AND processed_rows >= 0 AND created_rows >= 0 AND updated_rows >= 0 AND skipped_rows >= 0)
);

CREATE TABLE IF NOT EXISTS public.import_run_rows (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES public.import_runs(id) ON DELETE RESTRICT,
    row_number INTEGER NOT NULL,
    source_row_hash TEXT NOT NULL,
    entity_type TEXT,
    entity_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB,
    error_message TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    superseded_at TIMESTAMPTZ,
    CONSTRAINT import_run_rows_number_ck CHECK (row_number > 0),
    CONSTRAINT import_run_rows_status_ck CHECK (status IN ('pending','created','updated','skipped','failed'))
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_account_type text;
    v_public_role text;
    v_public_type text;
    v_must_change text;
BEGIN
    v_public_role := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'role', '')));
    v_public_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'account_type', '')));
    IF v_public_role IN ('admin','ultra_admin','employe','locataire')
       OR v_public_type IN ('admin','ultra_admin','employe','locataire') THEN
        RAISE EXCEPTION 'Les rôles privilégiés doivent être fournis par le serveur.';
    END IF;
    v_account_type := lower(pg_catalog.btrim(COALESCE(NULLIF(NEW.raw_app_meta_data ->> 'mim_account_type',''),'proprietaire')));
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.guard_public_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    IF lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'role',''))) IN ('admin','ultra_admin','employe','locataire')
       OR lower(pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data ->> 'account_type',''))) IN ('admin','ultra_admin','employe','locataire') THEN
        RAISE EXCEPTION 'Les rôles privilégiés doivent être fournis par le serveur.';
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mim_guard_public_auth_metadata ON auth.users;
CREATE TRIGGER mim_guard_public_auth_metadata BEFORE INSERT OR UPDATE OF raw_user_meta_data ON auth.users FOR EACH ROW EXECUTE FUNCTION public.guard_public_auth_metadata();

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY account_uid ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.locataires WHERE account_uid IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.locataires l SET superseded_at = clock_timestamp() FROM ranked r WHERE l.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY account_uid ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.employes WHERE account_uid IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.employes e SET superseded_at = clock_timestamp() FROM ranked r WHERE e.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY logement_id ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.locataires WHERE logement_id IS NOT NULL AND statut = 'actif' AND superseded_at IS NULL
)
UPDATE public.locataires l SET superseded_at = clock_timestamp() FROM ranked r WHERE l.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id,locataire_id,mois ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.paiements WHERE locataire_id IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.paiements p SET superseded_at = clock_timestamp() FROM ranked r WHERE p.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id,employe_id,mois ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.paiements_employes WHERE employe_id IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.paiements_employes p SET superseded_at = clock_timestamp() FROM ranked r WHERE p.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id,employe_uid,mois ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.paiements_employes WHERE employe_uid IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.paiements_employes p SET superseded_at = clock_timestamp() FROM ranked r WHERE p.id = r.id AND r.rn > 1;
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id,provider,idempotency_key ORDER BY created_at DESC NULLS LAST,id DESC) AS rn FROM public.abonnement_paiements WHERE idempotency_key IS NOT NULL AND superseded_at IS NULL
)
UPDATE public.abonnement_paiements p SET superseded_at = clock_timestamp() FROM ranked r WHERE p.id = r.id AND r.rn > 1;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.biens'::regclass AND conname = 'biens_id_user_id_key') THEN ALTER TABLE public.biens ADD CONSTRAINT biens_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.logements'::regclass AND conname = 'logements_id_user_id_key') THEN ALTER TABLE public.logements ADD CONSTRAINT logements_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.locataires'::regclass AND conname = 'locataires_id_user_id_key') THEN ALTER TABLE public.locataires ADD CONSTRAINT locataires_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND conname = 'paiements_id_user_id_key') THEN ALTER TABLE public.paiements ADD CONSTRAINT paiements_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.incidents'::regclass AND conname = 'incidents_id_user_id_key') THEN ALTER TABLE public.incidents ADD CONSTRAINT incidents_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.prestataires'::regclass AND conname = 'prestataires_id_user_id_key') THEN ALTER TABLE public.prestataires ADD CONSTRAINT prestataires_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.interventions'::regclass AND conname = 'interventions_id_user_id_key') THEN ALTER TABLE public.interventions ADD CONSTRAINT interventions_id_user_id_key UNIQUE (id,user_id); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.employes'::regclass AND conname = 'employes_id_user_id_key') THEN ALTER TABLE public.employes ADD CONSTRAINT employes_id_user_id_key UNIQUE (id,user_id); END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uniq ON public.profiles (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS locataires_account_uid_uidx ON public.locataires (account_uid) WHERE account_uid IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employes_account_uid_uidx ON public.employes (account_uid) WHERE account_uid IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS locataires_logement_actif_uidx ON public.locataires (logement_id) WHERE logement_id IS NOT NULL AND statut = 'actif' AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_locataire_mois_uidx ON public.paiements (user_id,locataire_id,mois) WHERE locataire_id IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_employes_employe_mois_uidx ON public.paiements_employes (user_id,employe_id,mois) WHERE employe_id IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_employes_employe_uid_mois_uidx ON public.paiements_employes (user_id,employe_uid,mois) WHERE employe_uid IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS abonnement_paiements_idempotency_uidx ON public.abonnement_paiements (user_id,provider,idempotency_key) WHERE idempotency_key IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS abonnement_paiements_transaction_uidx ON public.abonnement_paiements (provider,transaction_id) WHERE transaction_id IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uidx ON public.sessions (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quota_reservations_idempotency_uidx ON public.quota_reservations (user_id,resource,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_token_hash_uidx ON public.tenant_invitations (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_user_idempotency_uidx ON public.import_runs (user_id,idempotency_key) WHERE idempotency_key IS NOT NULL AND status <> 'failed' AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS import_run_rows_run_number_uidx ON public.import_run_rows (run_id,row_number) WHERE superseded_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_role_account_type_ck') THEN ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_account_type_ck CHECK (role = account_type) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.logements'::regclass AND conname = 'logements_loyer_positive_ck') THEN ALTER TABLE public.logements ADD CONSTRAINT logements_loyer_positive_ck CHECK (loyer_mensuel IS NULL OR loyer_mensuel > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.logements'::regclass AND conname = 'logements_chambres_positive_ck') THEN ALTER TABLE public.logements ADD CONSTRAINT logements_chambres_positive_ck CHECK (nombre_chambres IS NULL OR nombre_chambres > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.locataires'::regclass AND conname = 'locataires_jour_ck') THEN ALTER TABLE public.locataires ADD CONSTRAINT locataires_jour_ck CHECK (jour_echeance IS NULL OR jour_echeance BETWEEN 1 AND 31) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND conname = 'paiements_montant_ck') THEN ALTER TABLE public.paiements ADD CONSTRAINT paiements_montant_ck CHECK (montant > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND conname = 'paiements_mois_ck') THEN ALTER TABLE public.paiements ADD CONSTRAINT paiements_mois_ck CHECK (mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements_employes'::regclass AND conname = 'paiements_employes_montant_ck') THEN ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_montant_ck CHECK (montant > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements_employes'::regclass AND conname = 'paiements_employes_mois_ck') THEN ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_mois_ck CHECK (mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.abonnement_paiements'::regclass AND conname = 'abonnement_paiements_montant_ck') THEN ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_montant_ck CHECK (montant > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.abonnement_paiements'::regclass AND conname = 'abonnement_paiements_duration_ck') THEN ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_duration_ck CHECK (duree_abonnement IS NULL OR duree_abonnement BETWEEN 1 AND 36) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_max_logements_ck') THEN ALTER TABLE public.plans ADD CONSTRAINT plans_max_logements_ck CHECK (max_logements IS NULL OR max_logements > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_max_locataires_ck') THEN ALTER TABLE public.plans ADD CONSTRAINT plans_max_locataires_ck CHECK (max_locataires IS NULL OR max_locataires > 0) NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.moyens_paiement'::regclass AND conname = 'moyens_paiement_lien_https_ck') THEN ALTER TABLE public.moyens_paiement ADD CONSTRAINT moyens_paiement_lien_https_ck CHECK (lien_paiement IS NULL OR btrim(lien_paiement) = '' OR lien_paiement ~ '^https://[^[:space:]]+$') NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.moyens_paiement_employes'::regclass AND conname = 'moyens_paiement_employes_lien_https_ck') THEN ALTER TABLE public.moyens_paiement_employes ADD CONSTRAINT moyens_paiement_employes_lien_https_ck CHECK (lien_paiement IS NULL OR btrim(lien_paiement) = '' OR lien_paiement ~ '^https://[^[:space:]]+$') NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.password_reset_tokens'::regclass AND conname = 'password_reset_status_ck') THEN ALTER TABLE public.password_reset_tokens ADD CONSTRAINT password_reset_status_ck CHECK (status IN ('pending','processing','used','expired','revoked')) NOT VALID; END IF;
END $$;

DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.paiements'::regclass AND attname = 'locataire_id')]::smallint[] LOOP EXECUTE format('ALTER TABLE public.paiements DROP CONSTRAINT %I',r.conname); END LOOP;
    FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.paiements_employes'::regclass AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.paiements_employes'::regclass AND attname = 'employe_id')]::smallint[] LOOP EXECUTE format('ALTER TABLE public.paiements_employes DROP CONSTRAINT %I',r.conname); END LOOP;
END $$;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_locataire_restrict_fk FOREIGN KEY (locataire_id) REFERENCES public.locataires(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_employe_restrict_fk FOREIGN KEY (employe_id) REFERENCES public.employes(id) ON DELETE RESTRICT NOT VALID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.logements'::regclass AND conname = 'logements_bien_owner_fk') THEN ALTER TABLE public.logements ADD CONSTRAINT logements_bien_owner_fk FOREIGN KEY (bien_id,user_id) REFERENCES public.biens(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.locataires'::regclass AND conname = 'locataires_logement_owner_fk') THEN ALTER TABLE public.locataires ADD CONSTRAINT locataires_logement_owner_fk FOREIGN KEY (logement_id,user_id) REFERENCES public.logements(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.locataires'::regclass AND conname = 'locataires_bien_owner_fk') THEN ALTER TABLE public.locataires ADD CONSTRAINT locataires_bien_owner_fk FOREIGN KEY (bien_id,user_id) REFERENCES public.biens(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND conname = 'paiements_locataire_owner_fk') THEN ALTER TABLE public.paiements ADD CONSTRAINT paiements_locataire_owner_fk FOREIGN KEY (locataire_id,user_id) REFERENCES public.locataires(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements'::regclass AND conname = 'paiements_logement_owner_fk') THEN ALTER TABLE public.paiements ADD CONSTRAINT paiements_logement_owner_fk FOREIGN KEY (logement_id,user_id) REFERENCES public.logements(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.incidents'::regclass AND conname = 'incidents_logement_owner_fk') THEN ALTER TABLE public.incidents ADD CONSTRAINT incidents_logement_owner_fk FOREIGN KEY (logement_id,user_id) REFERENCES public.logements(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.interventions'::regclass AND conname = 'interventions_incident_owner_fk') THEN ALTER TABLE public.interventions ADD CONSTRAINT interventions_incident_owner_fk FOREIGN KEY (incident_id,user_id) REFERENCES public.incidents(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.interventions'::regclass AND conname = 'interventions_prestataire_owner_fk') THEN ALTER TABLE public.interventions ADD CONSTRAINT interventions_prestataire_owner_fk FOREIGN KEY (prestataire_id,user_id) REFERENCES public.prestataires(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.interventions'::regclass AND conname = 'interventions_logement_owner_fk') THEN ALTER TABLE public.interventions ADD CONSTRAINT interventions_logement_owner_fk FOREIGN KEY (logement_id,user_id) REFERENCES public.logements(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.paiements_employes'::regclass AND conname = 'paiements_employes_employe_owner_fk') THEN ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_employe_owner_fk FOREIGN KEY (employe_id,user_id) REFERENCES public.employes(id,user_id) ON DELETE RESTRICT NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.employes_biens'::regclass AND conname = 'employes_biens_employe_owner_fk') THEN ALTER TABLE public.employes_biens ADD CONSTRAINT employes_biens_employe_owner_fk FOREIGN KEY (employe_id,user_id) REFERENCES public.employes(id,user_id) ON DELETE CASCADE NOT VALID; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.employes_biens'::regclass AND conname = 'employes_biens_bien_owner_fk') THEN ALTER TABLE public.employes_biens ADD CONSTRAINT employes_biens_bien_owner_fk FOREIGN KEY (bien_id,user_id) REFERENCES public.biens(id,user_id) ON DELETE CASCADE NOT VALID; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.employes_biens_owner_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_employee_owner uuid; v_bien_owner uuid;
BEGIN
    SELECT user_id INTO v_employee_owner FROM public.employes WHERE id = NEW.employe_id;
    SELECT user_id INTO v_bien_owner FROM public.biens WHERE id = NEW.bien_id;
    IF v_employee_owner IS NULL OR v_bien_owner IS NULL OR v_employee_owner IS DISTINCT FROM NEW.user_id OR v_bien_owner IS DISTINCT FROM NEW.user_id THEN RAISE EXCEPTION 'Employe et bien doivent avoir le meme proprietaire.'; END IF;
    RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS employes_biens_owner_guard ON public.employes_biens;
CREATE TRIGGER employes_biens_owner_guard BEFORE INSERT OR UPDATE OF user_id,employe_id,bien_id ON public.employes_biens FOR EACH ROW EXECUTE FUNCTION public.employes_biens_owner_guard();

CREATE OR REPLACE FUNCTION public.tenant_invitations_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.locataires l WHERE l.id = NEW.locataire_id AND l.user_id = NEW.user_id AND l.superseded_at IS NULL) THEN RAISE EXCEPTION 'Fiche locataire invalide.'; END IF;
    IF length(pg_catalog.btrim(NEW.token_hash)) < 32 OR NEW.expires_at <= pg_catalog.clock_timestamp() OR NEW.max_uses < 1 OR NEW.usage_count < 0 OR NEW.usage_count > NEW.max_uses THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS tenant_invitations_guard ON public.tenant_invitations;
CREATE TRIGGER tenant_invitations_guard BEFORE INSERT OR UPDATE ON public.tenant_invitations FOR EACH ROW EXECUTE FUNCTION public.tenant_invitations_guard();

CREATE OR REPLACE FUNCTION public.create_tenant_invitation(p_user_id uuid,p_locataire_id bigint,p_token_hash text,p_expires_at timestamptz DEFAULT NULL,p_max_uses integer DEFAULT 1)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_id uuid; v_now timestamptz := clock_timestamp(); v_expiry timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_locataire_id IS NULL OR length(btrim(COALESCE(p_token_hash,''))) < 32 OR p_max_uses < 1 OR p_max_uses > 10 THEN RAISE EXCEPTION 'Invitation invalide.'; END IF;
    v_expiry := COALESCE(p_expires_at,v_now + interval '7 days');
    IF v_expiry <= v_now OR v_expiry > v_now + interval '30 days' THEN RAISE EXCEPTION 'Expiration invalide.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.locataires l WHERE l.id = p_locataire_id AND l.user_id = p_user_id AND l.superseded_at IS NULL) THEN RAISE EXCEPTION 'Fiche locataire invalide.'; END IF;
    INSERT INTO public.tenant_invitations (token_hash,user_id,locataire_id,expires_at,max_uses) VALUES (btrim(p_token_hash),p_user_id,p_locataire_id,v_expiry,p_max_uses) RETURNING id INTO v_id;
    RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_tenant_invitation(p_token_hash text,p_account_uid uuid)
RETURNS TABLE(invitation_id uuid,owner_id uuid,tenant_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_inv public.tenant_invitations%ROWTYPE; v_tenant public.locataires%ROWTYPE; v_now timestamptz := clock_timestamp();
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
    IF v_key IS NOT NULL THEN SELECT id,status INTO v_id,v_status FROM public.quota_reservations WHERE user_id = p_user_id AND resource = v_resource AND idempotency_key = v_key; IF FOUND THEN IF v_status IN ('reserved','consumed') THEN RETURN v_id; END IF; RAISE EXCEPTION 'Cle quota deja terminale.'; END IF; END IF;
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

CREATE OR REPLACE FUNCTION public.release_quota(p_reservation_id uuid,p_user_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_user uuid; v_resource text; v_now timestamptz := clock_timestamp();
BEGIN
    SELECT user_id,resource INTO v_user,v_resource FROM public.quota_reservations WHERE id = p_reservation_id; IF NOT FOUND THEN RETURN false; END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_user THEN RAISE EXCEPTION 'Reservation invalide.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_resource,0));
    UPDATE public.quota_reservations SET status = CASE WHEN status = 'consumed' THEN status ELSE 'released' END,released_at = CASE WHEN status = 'consumed' THEN released_at ELSE v_now END,updated_at = v_now WHERE id = p_reservation_id;
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_quota(p_reservation_id uuid,p_user_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.activate_subscription_payment(p_payment_id bigint,p_transaction_id text DEFAULT NULL,p_paid_at timestamptz DEFAULT NULL,p_expected_amount numeric DEFAULT NULL,p_currency text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_payment public.abonnement_paiements%ROWTYPE; v_plan public.plans%ROWTYPE; v_sub public.subscriptions%ROWTYPE; v_now timestamptz := clock_timestamp(); v_paid timestamptz; v_start timestamptz; v_expiry timestamptz; v_duration integer; v_id uuid; v_tx text; v_cur text;
BEGIN
    SELECT * INTO v_payment FROM public.abonnement_paiements WHERE id = p_payment_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Paiement introuvable.'; END IF;
    IF v_payment.statut = 'paid' THEN SELECT id INTO v_id FROM public.subscriptions WHERE user_id = v_payment.user_id; IF NOT FOUND THEN RAISE EXCEPTION 'Abonnement manquant.'; END IF; RETURN v_id; END IF;
    IF v_payment.statut <> 'pending' THEN RAISE EXCEPTION 'Paiement non pending.'; END IF;
    SELECT * INTO v_plan FROM public.plans WHERE code = lower(btrim(v_payment.plan)) AND actif = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan inactif.'; END IF;
    IF p_expected_amount IS NOT NULL AND v_payment.montant IS DISTINCT FROM p_expected_amount THEN RAISE EXCEPTION 'Montant invalide.'; END IF;
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' AND v_payment.montant IS DISTINCT FROM v_plan.prix THEN RAISE EXCEPTION 'Montant plan invalide.'; END IF;
    v_cur := upper(COALESCE(NULLIF(btrim(p_currency),''),upper(btrim(v_payment.devise)),upper(btrim(v_plan.devise))));
    IF upper(btrim(v_payment.devise)) <> v_cur OR upper(btrim(v_plan.devise)) <> v_cur THEN RAISE EXCEPTION 'Devise invalide.'; END IF;
    v_duration := COALESCE(v_payment.duree_abonnement,v_plan.duree_abonnement); IF v_duration < 1 OR v_duration > 36 THEN RAISE EXCEPTION 'Duree invalide.'; END IF;
    v_tx := COALESCE(NULLIF(btrim(p_transaction_id),''),NULLIF(btrim(v_payment.transaction_id),''));
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' AND v_tx IS NULL THEN RAISE EXCEPTION 'Transaction absente.'; END IF;
    IF v_payment.transaction_id IS NOT NULL AND v_payment.transaction_id <> v_tx THEN RAISE EXCEPTION 'Transaction incoherente.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_payment.user_id::text || ':subscription',0));
    SELECT * INTO v_sub FROM public.subscriptions WHERE user_id = v_payment.user_id FOR UPDATE;
    v_paid := COALESCE(p_paid_at,v_now); v_start := CASE WHEN v_sub.id IS NOT NULL AND v_sub.date_expiration > v_now THEN v_sub.date_expiration ELSE v_now END; v_expiry := v_start + make_interval(months => v_duration);
    INSERT INTO public.subscriptions(user_id,plan,plan_id,statut,date_debut,date_expiration,date_paiement,montant,methode_paiement,reference,bictorys_transaction_id,bictorys_reference,duree_abonnement,updated_at)
    VALUES(v_payment.user_id,v_plan.code,v_plan.id,'actif',COALESCE(v_sub.date_debut,v_start),v_expiry,v_paid,v_payment.montant,v_payment.methode_paiement,v_payment.reference,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_tx ELSE NULL END,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_payment.reference ELSE NULL END,v_duration,v_now)
    ON CONFLICT (user_id) DO UPDATE SET plan=EXCLUDED.plan,plan_id=EXCLUDED.plan_id,statut='actif',date_expiration=EXCLUDED.date_expiration,date_paiement=EXCLUDED.date_paiement,montant=EXCLUDED.montant,methode_paiement=EXCLUDED.methode_paiement,reference=EXCLUDED.reference,bictorys_transaction_id=EXCLUDED.bictorys_transaction_id,bictorys_reference=EXCLUDED.bictorys_reference,duree_abonnement=EXCLUDED.duree_abonnement,updated_at=EXCLUDED.updated_at
    RETURNING id INTO v_id;
    UPDATE public.abonnement_paiements SET statut='paid',transaction_id=COALESCE(v_tx,transaction_id),date_paiement=v_paid,updated_at=v_now WHERE id=p_payment_id AND statut='pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Conflit de paiement.'; END IF;
    RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_manual_subscription_payment(p_user_id uuid,p_plan_code text,p_amount numeric,p_reference text,p_method text DEFAULT 'especes',p_paid_at timestamptz DEFAULT NULL,p_duration integer DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
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
$function$;

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_run_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_select_by_email" ON public.locataires;
DROP POLICY IF EXISTS "tenant_link_locataire" ON public.locataires;
DROP POLICY IF EXISTS "tenant_select_locataire" ON public.locataires;
DROP POLICY IF EXISTS "tenant_insert_incident" ON public.incidents;
CREATE POLICY "tenant_select_locataire" ON public.locataires FOR SELECT TO authenticated USING (account_uid = (SELECT auth.uid()));
DROP POLICY IF EXISTS "users_can_view_own" ON public.profiles;
DROP POLICY IF EXISTS "users_can_update_own" ON public.profiles;
CREATE POLICY "users_can_view_own" ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY "users_can_update_own" ON public.profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "owner_all_notifications" ON public.notifications;
CREATE POLICY "notifications_select_own" ON public.notifications FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "notifications_delete_own" ON public.notifications FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.profiles,public.biens,public.logements,public.locataires,public.paiements,public.incidents,public.prestataires,public.interventions,public.notifications,public.employes,public.tasks,public.paiements_employes,public.employes_biens,public.moyens_paiement,public.moyens_paiement_employes,public.plans,public.subscriptions,public.abonnement_paiements,public.agences_proprietaires,public.agences_biens,public.versements,public.messages TO authenticated;
GRANT UPDATE (name,phone) ON public.profiles TO authenticated;
GRANT UPDATE (lu) ON public.notifications TO authenticated;
GRANT DELETE ON public.notifications TO authenticated;
REVOKE ALL ON public.sessions,public.bictorys_webhooks,public.password_reset_tokens,public.tenant_invitations,public.quota_reservations,public.import_runs,public.import_run_rows FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_public_auth_metadata() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.employes_biens_owner_guard() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.tenant_invitations_guard() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.create_tenant_invitation(UUID,BIGINT,TEXT,TIMESTAMPTZ,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_tenant_invitation(TEXT,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.release_quota(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_quota(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_subscription_payment(BIGINT,TEXT,TIMESTAMPTZ,NUMERIC,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.record_manual_subscription_payment(UUID,TEXT,NUMERIC,TEXT,TEXT,TIMESTAMPTZ,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_public_auth_metadata() TO service_role;
GRANT EXECUTE ON FUNCTION public.employes_biens_owner_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_invitations_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_tenant_invitation(UUID,BIGINT,TEXT,TIMESTAMPTZ,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_tenant_invitation(TEXT,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID,TEXT,INTEGER,TEXT,INTERVAL,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_quota(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_quota(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_subscription_payment(BIGINT,TEXT,TIMESTAMPTZ,NUMERIC,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_manual_subscription_payment(UUID,TEXT,NUMERIC,TEXT,TEXT,TIMESTAMPTZ,INTEGER) TO service_role;
