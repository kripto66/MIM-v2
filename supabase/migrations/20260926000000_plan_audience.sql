-- ============================================================
-- MIM - Catalogue d'abonnements : grille séparée propriétaire / agence
--
--   Propriétaire (audience = 'proprietaire') :
--     standard 7 000 / premium 15 000 / pro 30 000 / agence 50 000
--
--   Agence (audience = 'agence') — forfait mensuel :
--     agence_starter  15 000 XOF
--     agence_pro      25 000 XOF
--     agence_business 40 000 XOF
--
-- Les capacités restent modifiables depuis l'interface Ultra Admin ;
-- cette migration n'est que l'état initial vérifié.
-- ============================================================

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'proprietaire';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_audience_ck'
  ) THEN
    ALTER TABLE public.plans
      ADD CONSTRAINT plans_audience_ck CHECK (audience IN ('proprietaire', 'agence')) NOT VALID;
  END IF;
END $$;

UPDATE public.plans SET audience = 'proprietaire' WHERE audience IS NULL OR audience = '';

CREATE INDEX IF NOT EXISTS plans_audience_actif_idx
  ON public.plans (audience, prix)
  WHERE actif = true;

INSERT INTO public.plans (code, nom, type, prix, devise, max_immeubles, max_logements, max_locataires, duree_abonnement, audience, actif, description)
VALUES
  ('agence_starter', 'Agence Starter', 'agence', 15000, 'XOF', 10, 100, 100, 1, 'agence', true,
   'Pour une agence qui démarre : 10 biens, 100 logements et 100 locataires gérés.'),
  ('agence_pro', 'Agence Pro', 'agence', 25000, 'XOF', 30, 300, 300, 1, 'agence', true,
   'Pour une agence en croissance : 30 biens, 300 logements et 300 locataires gérés.'),
  ('agence_business', 'Agence Business', 'agence', 40000, 'XOF', 80, 800, 800, 1, 'agence', true,
   'Pour une agence structurée : 80 biens, 800 logements et 800 locataires gérés.')
ON CONFLICT (code) DO UPDATE
  SET nom = EXCLUDED.nom,
      type = EXCLUDED.type,
      prix = EXCLUDED.prix,
      devise = EXCLUDED.devise,
      audience = EXCLUDED.audience,
      duree_abonnement = EXCLUDED.duree_abonnement,
      description = EXCLUDED.description;

ALTER TABLE public.plans VALIDATE CONSTRAINT plans_audience_ck;
