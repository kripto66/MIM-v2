-- ============================================================
-- MIM - Abonnement propriétaire (séparé des paiements de loyers)
--
-- Règle métier :
--  * L'abonnement MIM du propriétaire (agence/entreprise) est
--    DISTINCT des paiements de loyer que le propriétaire gère pour
--    ses locataires (table public.paiements) : deux systèmes, deux
--    tables, aucune donnée partagée.
--  * L'état réel d'un abonnement est TOUJOURS dérivé de la colonne
--    date_expiration côté serveur (jamais d'une valeur du frontend).
--  * Seul le serveur (service_role) écrit dans ces tables : le
--    propriétaire ne peut lire que sa propre souscription.
-- ============================================================

-- Abonnement courant d'un propriétaire (une ligne par propriétaire).
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'standard',
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'expire')),
    date_debut TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_expiration TIMESTAMPTZ NOT NULL,
    date_paiement TIMESTAMPTZ,
    montant NUMERIC(12,2),
    methode_paiement TEXT,
    reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

-- Historique des paiements d'abonnement (chaque validation par l'admin
-- ajoute une ligne : référence, montant, méthode, échéance calculée).
CREATE TABLE IF NOT EXISTS public.abonnement_paiements (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    montant NUMERIC(12,2) NOT NULL,
    date_paiement TIMESTAMPTZ NOT NULL DEFAULT now(),
    methode_paiement TEXT,
    reference TEXT,
    date_debut TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_expiration TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abonnement_paiements ENABLE ROW LEVEL SECURITY;

-- Propriétaire : lecture de sa propre souscription et de son historique.
-- Aucune politique INSERT/UPDATE/DELETE : l'écriture passe uniquement
-- par le serveur (service_role). Toute écriture directe du client est
-- refusée par la RLS (défaut : deny).
CREATE POLICY "owner_select_own_subscription" ON public.subscriptions
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner_select_own_abonnement_paiements" ON public.abonnement_paiements
    FOR SELECT USING (auth.uid() = user_id);

-- Privilèges (ces tables sont créées après le script de grants minimaux)
GRANT SELECT ON public.subscriptions, public.abonnement_paiements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions, public.abonnement_paiements TO service_role;
GRANT ALL ON SEQUENCE abonnement_paiements_id_seq TO service_role;
