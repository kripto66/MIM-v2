-- ============================================================
-- MIM - Récupération de mot de passe (jetons sur mesure)
--
-- Un jeton de récupération est :
--   * généré côté serveur (crypto aléatoire),
--   * STOCKÉ UNIQUEMENT EN HACHÉ (SHA-256) dans token_hash,
--   * à usage unique (used_at une seule fois),
--   * expiré après 30 minutes (expires_at).
-- Le mot de passe est toujours mis à jour via Supabase Auth
-- (auth.users) : aucun hash de mot de passe n'est stocké ici.
--
-- RLS activée sans politique : uniquement accessible par le rôle
-- service (le serveur MIM). Aucun client ne lit cette table.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
    ON public.password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx
    ON public.password_reset_tokens (expires_at);

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- Seul le serveur (service_role) accède à cette table : ni anon ni
-- authenticated ne reçoivent de privilège (aucune politique RLS définie).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.password_reset_tokens TO service_role;

COMMENT ON TABLE public.password_reset_tokens
    IS 'Jetons de récupération de mot de passe (hachés, un usage, 30 min).';
COMMENT ON COLUMN public.password_reset_tokens.token_hash
    IS 'SHA-256 du jeton brut : le jeton en clair n''est jamais stocké.';