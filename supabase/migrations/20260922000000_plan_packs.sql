-- ============================================================
-- MIM - Grille tarifaire mensuelle à 4 packs propriétaires
--
--   Standard   7 000 XOF/mois : 1 immeuble  / 20 logements / 20 locataires
--   Premium   15 000 XOF/mois : 3 immeubles / 75 logements / 75 locataires
--   Pro       30 000 XOF/mois : 10 immeubles / 300 logements / 300 locataires
--   Agence    50 000 XOF/mois : 25 immeubles / 750 logements / 750 locataires
--
-- Employés et prestataires : ILLIMITÉS sur tous les plans (l'architecture
-- ne les plafonne pas — argument commercial fort, rien n'est restreint).
-- L'ancien pack « Ultra » (10 immeubles) est archivé (actif = false).
--
-- Migration additive/idempotente : à appliquer sur les bases existantes
-- (supabase db push --local). Les nouvelles installations suivent
-- également cette migration après 20260921000000_bictorys.sql.
-- ============================================================

-- 1) Nouvelles colonnes de capacité (NULL = aucune limite, fail open).
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_logements INTEGER;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_locataires INTEGER;

-- 2) Packs existants : nouvelles capacités / descriptions.
UPDATE public.plans
SET max_immeubles = 1,
    max_logements = 20,
    max_locataires = 20,
    duree_abonnement = 1,
    description = '1 immeuble — 20 logements — 20 locataires',
    updated_at = now()
WHERE code = 'standard';

UPDATE public.plans
SET max_immeubles = 3,
    max_logements = 75,
    max_locataires = 75,
    duree_abonnement = 1,
    description = '3 immeubles — 75 logements — 75 locataires',
    updated_at = now()
WHERE code = 'premium';

-- 3) L'ancien pack Ultra (10 immeubles) est archivé.
UPDATE public.plans
SET actif = false,
    description = '10 immeubles — plan archivé (remplacé par Pro / Agence)',
    updated_at = now()
WHERE code = 'ultra';

-- 4) Nouveaux packs Pro et Agence.
INSERT INTO public.plans
    (code, nom, type, prix, devise, max_immeubles, max_logements, max_locataires, duree_abonnement, description, actif)
VALUES
    ('pro',    'Propriétaire Pro',    'proprietaire', 30000, 'XOF', 10, 300, 300, 1, '10 immeubles — 300 logements — 300 locataires', true),
    ('agence', 'Propriétaire Agence', 'proprietaire', 50000, 'XOF', 25, 750, 750, 1, '25 immeubles — 750 logements — 750 locataires', true)
ON CONFLICT (code) DO NOTHING;