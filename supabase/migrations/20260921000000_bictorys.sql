-- ============================================================
-- MIM - Abonnement propriétaire PAIEMENT EN LIGNE via Bictorys
--
-- Bictorys devient le système officiel de paiement des abonnements
-- MIM des propriétaires (grille mensuelle : Standard 1 immeuble,
-- Premium 3, Pro 10, Agence 25 — voir 20260922000000_plan_packs.sql
-- pour les capacités logements/locataires et l'archivage d'Ultra).
-- L'abonnement n'est ACTIVÉ que par webhook Bictorys (statut
-- succeeded) ; aucun flux frontal ne peut activer un abonnement.
--
-- Cette migration :
--   1) crée la table public.plans (catalogue des packs) ;
--   2) étend public.subscriptions (statuts, lien plan, références
--      Bictorys) ;
--   3) étend public.abonnement_paiements (statut de paiement,
--      device, fournisseur, transaction Bictorys, payload brut) ;
--   4) crée public.bictorys_webhooks (journal idempotent des
--      notifications, modèle du pattern paydunya_webhooks) ;
--   5) met à jour les privilèges / RLS.
--
-- Les packs de la grille mensuelle sont complétés/archivés par la
-- migration 20260922000000_plan_packs.sql (Pro/Agence + Ultra archivé).
-- ============================================================

-- 1) Catalogue des plans d'abonnement propriétaire.
CREATE TABLE IF NOT EXISTS public.plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    nom TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'proprietaire',
    prix NUMERIC(12,2) NOT NULL,
    devise TEXT NOT NULL DEFAULT 'XOF',
    max_immeubles INTEGER NOT NULL,
    duree_abonnement INTEGER NOT NULL DEFAULT 12,
    description TEXT,
    actif BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plans_max_immeubles_positive CHECK (max_immeubles > 0),
    CONSTRAINT plans_prix_positive CHECK (prix >= 0),
    CONSTRAINT plans_duree_positive CHECK (duree_abonnement > 0)
);

INSERT INTO public.plans (code, nom, type, prix, devise, max_immeubles, duree_abonnement, description)
VALUES
    ('standard', 'Propriétaire Standard', 'proprietaire', 7000, 'XOF', 1, 1, '1 immeuble — 1 mois'),
    ('premium',  'Propriétaire Premium',  'proprietaire', 15000, 'XOF', 3, 1, '3 immeubles — 1 mois'),
    ('ultra',    'Propriétaire Ultra',    'proprietaire', 25000, 'XOF', 10, 1, '10 immeubles — 1 mois')
ON CONFLICT (code) DO NOTHING;

-- 2) Abonnement : nouveaux statuts + lien catalogue + références Bictorys.
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_statut_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_statut_check CHECK (statut IN ('actif', 'expire', 'pending', 'cancelled', 'failed'));

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES public.plans(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS bictorys_transaction_id TEXT;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS bictorys_reference TEXT;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS duree_abonnement INTEGER;

-- Rattachage des abonnements existants (créés manuellement : code = plan).
UPDATE public.subscriptions s
SET plan_id = p.id
FROM public.plans p
WHERE p.code = s.plan AND s.plan_id IS NULL;

-- 3) Historique des paiements d'abonnement : statut de paiement etc.
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS devise TEXT NOT NULL DEFAULT 'XOF';
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'manuel';
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS transaction_id TEXT;
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS statut TEXT NOT NULL DEFAULT 'paid' CHECK (statut IN ('pending', 'paid', 'failed', 'cancelled'));
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS raw_response JSONB;
ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- La méthode « bictorys » (paiement en ligne des abonnements) rejoint les
-- méthodes manuelles sur l'historique d'abonnement uniquement.
ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;
ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'bictorys')
);

-- 4) Journal idempotent des notifications webhook Bictorys.
--    fingerprint UNIQUE garantit qu'un même événement n'est traité
--    qu'une seule fois (idempotence), même si Bictorys le renvoie.
CREATE TABLE IF NOT EXISTS public.bictorys_webhooks (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT,
    merchant_id TEXT,
    type TEXT,
    status TEXT,
    amount NUMERIC(12,2),
    currency TEXT,
    payment_reference TEXT,
    merchant_reference TEXT,
    payload JSONB NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    handled BOOLEAN NOT NULL DEFAULT false,
    handled_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bictorys_webhooks_event_id_uidx ON public.bictorys_webhooks (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bictorys_webhooks_payment_reference_idx ON public.bictorys_webhooks (payment_reference);

-- Index de recherche du paiement en attente d'un propriétaire.
CREATE INDEX IF NOT EXISTS abonnement_paiements_user_statut_idx ON public.abonnement_paiements (user_id, statut, created_at DESC);

-- 5) RLS + privilèges.
--    plans : lisible par tout utilisateur authentifié, écrit par service_role.
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_select_plans" ON public.plans
    FOR SELECT USING (true);

--    bictorys_webhooks : aucun accès client (service_role uniquement,
--    contourne la RLS). Défaut : deny.
ALTER TABLE public.bictorys_webhooks ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plans TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bictorys_webhooks TO service_role;
GRANT ALL ON SEQUENCE bictorys_webhooks_id_seq TO service_role;