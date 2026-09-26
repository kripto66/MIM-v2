-- ============================================================
-- MIM - Système AGENCE : mandat de gestion de biens
--
-- Modèle « mandat » (voir RAPPORT-AGENCE-PHASE2.md) :
--   * le propriétaire géré reste le `user_id` de SES lignes métier
--     (biens, logements, locataires, ...) — policies owner existantes
--     inchangées, GRANT colonne-par-colonne intacts ;
--   * l'agence (account_type = 'agence') accède aux biens UNIQUEMENT
--     via les tables d'association ci-dessous ;
--   * toute écriture d'une agence passe par le serveur (service_role)
--     avec vérification de mandat fail-closed — aucune écriture
--     client directe sur ces tables ;
--   * le propriétaire géré peut LIRE ses versements et messages.
--
-- MIGRATION STRICTEMENT ADDITIVE : crée 4 tables, n'altère aucune
-- table métier existante.
-- ============================================================

-- ------------------------------------------------------------
-- 1. agences_proprietaires : l'agence gère un propriétaire (compte
--    auth créé par l'agence, pattern « compte auto » des employés).
--    user_id = agence_id = compte auth.uid() de l'agence.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agences_proprietaires (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agence_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    proprietaire_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agences_proprietaires_unique UNIQUE (agence_id, proprietaire_id)
);

CREATE INDEX IF NOT EXISTS agences_proprietaires_proprietaire_idx
    ON public.agences_proprietaires (proprietaire_id);

-- ------------------------------------------------------------
-- 2. agences_biens : l'agence gère un bien (pattern employes_biens).
--    proprietaire_id est DÉNORMALISÉ depuis biens.user_id par le
--    serveur (jamais fourni par le client).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agences_biens (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agence_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    proprietaire_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bien_id BIGINT NOT NULL REFERENCES public.biens(id) ON DELETE CASCADE,
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'retire')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agences_biens_unique UNIQUE (agence_id, bien_id)
);

CREATE INDEX IF NOT EXISTS agences_biens_bien_idx
    ON public.agences_biens (bien_id);
CREATE INDEX IF NOT EXISTS agences_biens_proprietaire_idx
    ON public.agences_biens (proprietaire_id);

-- ------------------------------------------------------------
-- 3. versements : versements de l'agence vers le propriétaire géré.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.versements (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agence_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    proprietaire_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bien_id BIGINT REFERENCES public.biens(id) ON DELETE SET NULL,
    montant NUMERIC(12,2) NOT NULL CHECK (montant > 0),
    periode TEXT,
    statut TEXT NOT NULL DEFAULT 'attente' CHECK (statut IN ('attente', 'en_cours', 'effectue', 'annule')),
    methode_paiement TEXT CHECK (
        methode_paiement IS NULL
        OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')
    ),
    reference TEXT,
    note TEXT,
    effectue_a TIMESTAMPTZ,
    effectue_par UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS versements_proprietaire_statut_idx
    ON public.versements (proprietaire_id, statut);
CREATE INDEX IF NOT EXISTS versements_agence_created_idx
    ON public.versements (agence_id, created_at DESC);

-- ------------------------------------------------------------
-- 4. messages : messagerie agence <-> propriétaire géré.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agence_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    proprietaire_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    auteur_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    lu_par_destinataire BOOLEAN NOT NULL DEFAULT false,
    objet TEXT,
    corps TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_proprietaire_created_idx
    ON public.messages (proprietaire_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_agence_created_idx
    ON public.messages (agence_id, created_at DESC);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.agences_proprietaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agences_biens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.versements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- L'agence gère SES rattachements.
CREATE POLICY "agence_all_agences_proprietaires" ON public.agences_proprietaires
    FOR ALL USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "agence_all_agences_biens" ON public.agences_biens
    FOR ALL USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Le propriétaire géré consulte sa liaison (ne peut pas la modifier).
CREATE POLICY "proprietaire_select_own_liaison" ON public.agences_proprietaires
    FOR SELECT USING (proprietaire_id = auth.uid());

CREATE POLICY "proprietaire_select_own_bien_liaison" ON public.agences_biens
    FOR SELECT USING (proprietaire_id = auth.uid());

-- Versements : l'agence gère, le propriétaire consulte les siens.
CREATE POLICY "agence_all_versements" ON public.versements
    FOR ALL USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "proprietaire_select_own_versements" ON public.versements
    FOR SELECT USING (proprietaire_id = auth.uid());

-- Messages : mêmes règles.
CREATE POLICY "agence_all_messages" ON public.messages
    FOR ALL USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "proprietaire_select_own_messages" ON public.messages
    FOR SELECT USING (proprietaire_id = auth.uid());

-- ------------------------------------------------------------
-- Privilèges
-- ------------------------------------------------------------
-- authenticated : lecture seule (les écritures passent par le serveur,
-- service_role, avec vérification de mandat).
GRANT SELECT ON public.agences_proprietaires TO authenticated;
GRANT SELECT ON public.agences_biens TO authenticated;
GRANT SELECT ON public.versements TO authenticated;
GRANT SELECT ON public.messages TO authenticated;

-- service_role : administration complète (contourne la RLS).
GRANT ALL ON public.agences_proprietaires TO service_role;
GRANT ALL ON public.agences_biens TO service_role;
GRANT ALL ON public.versements TO service_role;
GRANT ALL ON public.messages TO service_role;

GRANT USAGE, SELECT ON SEQUENCE agences_proprietaires_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE agences_biens_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE versements_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE messages_id_seq TO authenticated;

GRANT ALL ON SEQUENCE agences_proprietaires_id_seq TO service_role;
GRANT ALL ON SEQUENCE agences_biens_id_seq TO service_role;
GRANT ALL ON SEQUENCE versements_id_seq TO service_role;
GRANT ALL ON SEQUENCE messages_id_seq TO service_role;