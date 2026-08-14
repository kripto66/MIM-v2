-- ============================================================
-- MIM - Sessions de paiement UnitechPay (mobile money)
--
-- Deux tables ADDITIVES, sans toucher aux tables existantes :
--   unitech_checkouts : session d'initiation liée à un paiement MIM
--                      (loyer) et à la référence UnitechPay.
--   unitech_webhooks  : journal des webhooks reçus (dédup + audit).
-- La clé API UnitechPay ne vit que dans server/.env (UNITECH_API_KEY).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.unitech_checkouts (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    paiement_id BIGINT NOT NULL REFERENCES public.paiements(id) ON DELETE CASCADE,
    unitech_reference TEXT NOT NULL UNIQUE,
    unitech_transaction_id TEXT,
    method TEXT NOT NULL CHECK (method IN ('wave', 'orange_qr', 'orange_maxit', 'orange_om')),
    amount NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'expired')),
    payment_url TEXT,
    description TEXT,
    last_webhook JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unitech_checkouts_paiement_idx
    ON public.unitech_checkouts (paiement_id);

-- Journal des webhooks : fingerprint UNIQUE = garantie d'idempotence
-- (un même payload ne peut être traité qu'une seule fois).
CREATE TABLE IF NOT EXISTS public.unitech_webhooks (
    id BIGSERIAL PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    event TEXT NOT NULL,
    unitech_reference TEXT,
    payload JSONB NOT NULL,
    handled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS : le propriétaire accède à ses sessions ; le journal des webhooks
-- reste strictement réservé au service_role (aucune policy = refusé aux
-- comptes connectés).
ALTER TABLE public.unitech_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unitech_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_unitech_checkouts" ON public.unitech_checkouts
    FOR ALL USING (auth.uid() = user_id);

GRANT ALL ON public.unitech_checkouts TO service_role;
GRANT ALL ON public.unitech_webhooks TO service_role;
