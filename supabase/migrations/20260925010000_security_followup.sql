CREATE TABLE IF NOT EXISTS public.account_recovery_emails (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_recovery_emails_email_uidx
  ON public.account_recovery_emails (lower(email));

ALTER TABLE public.account_recovery_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_recovery_emails FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_recovery_emails FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_recovery_emails TO service_role;

INSERT INTO public.system_config (key, value)
VALUES ('saas_suspended', 'false'), ('simulation_offset_days', '0')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.employes'::regclass
      AND conname = 'employes_salaire_nonnegative_ck'
  ) THEN
    ALTER TABLE public.employes
      ADD CONSTRAINT employes_salaire_nonnegative_ck CHECK (salaire >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.paiements'::regclass
      AND conname = 'paiements_mois_valid_ck'
  ) THEN
    ALTER TABLE public.paiements
      ADD CONSTRAINT paiements_mois_valid_ck
      CHECK (mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND substring(mois, 1, 4) <> '0000') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.paiements_employes'::regclass
      AND conname = 'paiements_employes_mois_valid_ck'
  ) THEN
    ALTER TABLE public.paiements_employes
      ADD CONSTRAINT paiements_employes_mois_valid_ck
      CHECK (mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND substring(mois, 1, 4) <> '0000') NOT VALID;
  END IF;
END $$;

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('profiles', 'profiles_role_account_type_ck'),
      ('logements', 'logements_loyer_positive_ck'),
      ('logements', 'logements_chambres_positive_ck'),
      ('locataires', 'locataires_jour_ck'),
      ('paiements', 'paiements_montant_ck'),
      ('paiements', 'paiements_mois_ck'),
      ('paiements', 'paiements_mois_valid_ck'),
      ('paiements_employes', 'paiements_employes_montant_ck'),
      ('paiements_employes', 'paiements_employes_mois_ck'),
      ('paiements_employes', 'paiements_employes_mois_valid_ck'),
      ('abonnement_paiements', 'abonnement_paiements_montant_ck'),
      ('abonnement_paiements', 'abonnement_paiements_duration_ck'),
      ('plans', 'plans_max_logements_ck'),
      ('plans', 'plans_max_locataires_ck'),
      ('moyens_paiement', 'moyens_paiement_lien_https_ck'),
      ('moyens_paiement_employes', 'moyens_paiement_employes_lien_https_ck'),
      ('password_reset_tokens', 'password_reset_status_ck'),
      ('employes', 'employes_salaire_nonnegative_ck')
    ) AS constraints(table_name, constraint_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', item.table_name)::regclass
        AND conname = item.constraint_name
        AND NOT convalidated
    ) THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', item.table_name, item.constraint_name);
    END IF;
  END LOOP;
END $$;
