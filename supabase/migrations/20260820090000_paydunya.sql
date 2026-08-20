-- ============================================================
-- MIM - Paiements PayDunya (PAR + PER)
--
-- Remplacent UnitechPay pour :
--   - l'encaissement des abonnements MIM (admin)
--   - l'encaissement des loyers (locataire -> MIM -> propriétaire)
--   - l'encaissement des salaires (propriétaire -> MIM -> employé)
--
-- Tables ADDITIVES (les tables unitech_* existantes sont conservées
-- comme archives historiques, plus utilisées par le code) :
--   paydunya_invoices      : session de facture liée à un paiement MIM
--   paydunya_webhooks      : journal des IPN reçus (dédup + audit)
--   paydunya_redistributions : versements PER (MIM -> destinataire)
-- Les clés API ne vivent que dans server/.env (PAYDUNYA_*).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.paydunya_invoices (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'abonnement'
        CHECK (source IN ('abonnement', 'loyer', 'salaire')),
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
    amount NUMERIC(12,2) NOT NULL,
    payment_url TEXT,
    receipt_url TEXT,
    description TEXT,
    custom_data JSONB,
    last_ipn JSONB,
    paiement_id BIGINT REFERENCES public.paiements(id) ON DELETE SET NULL,
    paiement_employe_id BIGINT REFERENCES public.paiements_employes(id) ON DELETE SET NULL,
    abonnement_paiement_id BIGINT REFERENCES public.abonnement_paiements(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paydunya_invoices_paiement_idx
    ON public.paydunya_invoices (paiement_id);
CREATE INDEX IF NOT EXISTS paydunya_invoices_paiement_employe_idx
    ON public.paydunya_invoices (paiement_employe_id);
CREATE INDEX IF NOT EXISTS paydunya_invoices_abonnement_idx
    ON public.paydunya_invoices (abonnement_paiement_id);
CREATE INDEX IF NOT EXISTS paydunya_invoices_source_idx
    ON public.paydunya_invoices (source);

-- Journal des IPN : fingerprint UNIQUE = garantie d'idempotence
-- (un même payload ne peut être traité qu'une seule fois).
CREATE TABLE IF NOT EXISTS public.paydunya_webhooks (
    id BIGSERIAL PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    token TEXT,
    status TEXT,
    payload JSONB NOT NULL,
    handled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Versements « Payment And Redistribution » : MIM crédite le compte
-- PayDunya du destinataire (propriétaire pour un loyer, employé pour
-- un salaire). Un échec reste 'pending' et peut être relancé depuis
-- l'admin (POST /api/paydunya/redistributions/:id/retry).
CREATE TABLE IF NOT EXISTS public.paydunya_redistributions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('loyer', 'salaire')),
    paiement_id BIGINT REFERENCES public.paiements(id) ON DELETE SET NULL,
    paiement_employe_id BIGINT REFERENCES public.paiements_employes(id) ON DELETE SET NULL,
    recipient_alias TEXT NOT NULL,
    recipient_label TEXT,
    amount NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'success', 'failed')),
    transaction_id TEXT,
    response JSONB,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paydunya_redistributions_paiement_idx
    ON public.paydunya_redistributions (paiement_id);
CREATE INDEX IF NOT EXISTS paydunya_redistributions_paiement_employe_idx
    ON public.paydunya_redistributions (paiement_employe_id);
CREATE INDEX IF NOT EXISTS paydunya_redistributions_status_idx
    ON public.paydunya_redistributions (status);

-- Alias PayDunya optionnel du destinataire de la redistribution.
-- Utilisé en priorité, sinon le téléphone/email du profil est utilisé.
ALTER TABLE public.moyens_paiement ADD COLUMN IF NOT EXISTS paydunya_alias TEXT;
ALTER TABLE public.moyens_paiement_employes ADD COLUMN IF NOT EXISTS paydunya_alias TEXT;

-- La méthode 'paydunya' rejoint les CHECK de paiements / paiements_employes
-- (subscriptions et abonnement_paiements n'ont pas de contrainte de méthode).
ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'paydunya')
);
ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'paydunya')
);
-- abonnement_paiements a historiquement une contrainte restrictive
-- (mobile_money seul) : elle est élargie pour accepter le paiement PayDunya.
ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;
ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('mobile_money', 'paydunya')
);

-- RLS : le titulaire (propriétaire OU locataire selon la source) accède
-- à ses sessions ; le journal des webhooks et les redistributions restent
-- strictement réservés au service_role (aucune policy = refusé).
ALTER TABLE public.paydunya_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paydunya_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paydunya_redistributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_paydunya_invoices" ON public.paydunya_invoices
    FOR ALL USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

GRANT ALL ON public.paydunya_invoices TO service_role;
GRANT ALL ON public.paydunya_webhooks TO service_role;
GRANT ALL ON public.paydunya_redistributions TO service_role;
GRANT ALL ON public.paydunya_invoices_id_seq TO service_role;
GRANT ALL ON public.paydunya_webhooks_id_seq TO service_role;
GRANT ALL ON public.paydunya_redistributions_id_seq TO service_role;