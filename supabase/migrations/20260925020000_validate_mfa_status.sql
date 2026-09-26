DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
      AND conname = 'sessions_mfa_status_ck'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.sessions VALIDATE CONSTRAINT sessions_mfa_status_ck;
  END IF;
END $$;
