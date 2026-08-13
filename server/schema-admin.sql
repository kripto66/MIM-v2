-- ============================================================
-- MIM - Migration : rôle Administrateur
-- Ajoute 'admin' aux types de compte autorisés pour public.profiles.
-- À exécuter dans Supabase : SQL Editor → New query
-- ============================================================

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
    CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire', 'admin'));
