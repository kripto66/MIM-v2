-- ============================================================
-- MIGRATION : Intégration CinetPay
-- Deux domaines strictement séparés :
--   1) cinetpay_payments  : encaissement des loyers (Checkout API v2)
--   2) cinetpay_payouts   : reversements automatiques aux propriétaires
--                           (Transfer API v1)
-- + journal idempotent des webhooks (checkout ET transferts).
-- Statuts paiements  : PENDING / PROCESSING / SUCCESS / FAILED / CANCELLED
-- Statuts reversemts : PENDING / PROCESSING / SUCCESS / FAILED / RETRYING
-- ============================================================

-- ------------------------------------------------------------
-- 1) La méthode 'cinetpay' rejoint les CHECK existants
-- ------------------------------------------------------------
ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'paydunya', 'cinetpay')
);
ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_methode_check;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_methode_check CHECK (
    methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money', 'paydunya', 'cinetpay')
);

-- ------------------------------------------------------------
-- 2) Encaissements : cinetpay_payments
--    Une ligne = une session Checkout CinetPay pour UN loyer.
--    transaction_id est généré par MIM (jamais par le client).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cinetpay_payments (
    id              BIGSERIAL PRIMARY KEY,
    -- Compte locataire initiateur
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Loyer MIM visé (paiements.id)
    paiement_id     BIGINT NOT NULL REFERENCES public.paiements(id) ON DELETE CASCADE,
    owner_id        UUID NOT NULL,
    -- Référence unique envoyée à CinetPay (transaction_id)
    transaction_id  TEXT NOT NULL UNIQUE,
    -- payment_token renvoyé par CinetPay à la création
    payment_token   TEXT,
    -- URL de paiement Checkout renvoyée à la création (reprise de session)
    payment_url     TEXT,
    amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    currency        TEXT NOT NULL DEFAULT 'XOF',
    provider        TEXT NOT NULL DEFAULT 'cinetpay',
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED','CANCELLED')),
    payment_method  TEXT,
    operator_id     TEXT,
    paid_at         TIMESTAMPTZ,
    last_check      JSONB,
    webhook_payload JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un seul encaissement "en cours" par loyer : bloque les doubles
-- initiations concurrentes au niveau base (comme paydunya_invoices).
CREATE UNIQUE INDEX IF NOT EXISTS cinetpay_payments_one_pending_per_paiement
    ON public.cinetpay_payments (paiement_id)
    WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX IF NOT EXISTS cinetpay_payments_user_idx
    ON public.cinetpay_payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cinetpay_payments_owner_idx
    ON public.cinetpay_payments (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cinetpay_payments_status_idx
    ON public.cinetpay_payments (status);

-- ------------------------------------------------------------
-- 3) Journal idempotent des webhooks (checkout + transferts)
--    Fingerprint unique => un même webhook ne peut être traité 2 fois.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cinetpay_webhooks (
    id           BIGSERIAL PRIMARY KEY,
    kind         TEXT NOT NULL DEFAULT 'payment'
                 CHECK (kind IN ('payment','payout')),
    transaction_ref TEXT,
    fingerprint  TEXT UNIQUE NOT NULL,
    payload      JSONB,
    handled      BOOLEAN NOT NULL DEFAULT false,
    result       TEXT,
    error        TEXT,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cinetpay_webhooks_ref_idx
    ON public.cinetpay_webhooks (transaction_ref, received_at DESC);

-- ------------------------------------------------------------
-- 4) Reversements : cinetpay_payouts
--    Une ligne = un transfert d'argent vers le propriétaire.
--    UNE SEULE ligne par encaissement : les retries mettent à jour
--    cette même ligne (retry_count), jamais de duplication.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cinetpay_payouts (
    id                    BIGSERIAL PRIMARY KEY,
    -- Encaissement source (unique : pas de double reversement possible)
    cinetpay_payment_id   BIGINT UNIQUE
                          REFERENCES public.cinetpay_payments(id) ON DELETE SET NULL,
    -- Loyer MIM d'origine
    paiement_id           BIGINT REFERENCES public.paiements(id) ON DELETE SET NULL,
    owner_id              UUID NOT NULL,
    beneficiary_name      TEXT,
    beneficiary_prefix    TEXT,
    beneficiary_phone     TEXT,
    payment_method        TEXT,
    amount                NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    currency              TEXT NOT NULL DEFAULT 'XOF',
    provider              TEXT NOT NULL DEFAULT 'cinetpay',
    client_transaction_id TEXT UNIQUE NOT NULL,
    provider_transfer_id  TEXT,
    lot                   TEXT,
    status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED','RETRYING')),
    retry_count           INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    max_retries           INTEGER NOT NULL DEFAULT 5 CHECK (max_retries > 0),
    last_error            TEXT,
    last_attempt_at       TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cinetpay_payouts_owner_idx
    ON public.cinetpay_payouts (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cinetpay_payouts_status_idx
    ON public.cinetpay_payouts (status);

-- ------------------------------------------------------------
-- 5) RLS
--    - cinetpay_payments : le locataire initiateur voit ses sessions.
--    - cinetpay_payouts  : le propriétaire bénéficiaire voit ses
--      reversements (lecture seule).
--    - cinetpay_webhooks : aucune policy => service_role uniquement.
-- ------------------------------------------------------------
ALTER TABLE public.cinetpay_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cinetpay_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cinetpay_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_all_cinetpay_payments" ON public.cinetpay_payments;
CREATE POLICY "owner_all_cinetpay_payments" ON public.cinetpay_payments
    FOR ALL USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_read_cinetpay_payouts" ON public.cinetpay_payouts;
CREATE POLICY "owner_read_cinetpay_payouts" ON public.cinetpay_payouts
    FOR SELECT USING (auth.uid() = owner_id);

GRANT ALL ON public.cinetpay_payments TO service_role;
GRANT ALL ON public.cinetpay_webhooks TO service_role;
GRANT ALL ON public.cinetpay_payouts TO service_role;
