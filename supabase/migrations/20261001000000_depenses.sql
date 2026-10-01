-- ============================================================
-- MIM - Table `depenses` : charges du parc immobilier.
--
-- Une dépense appartient à UN bien (bien_id NOT NULL) et peut se
-- rattacher à un logement précis. user_id = propriétaire du bien,
-- comme pour toutes les tables métier :
--   * le propriétaire saisit via le CRUD /api/depenses (owner_only
--     + mandatGuard : impossible pendant qu'il confie son parc) ;
--   * l'agence saisit via les routes scoped /api/agence/bien/:id
--     (service_role + vérification de mandat fail-closed) ;
--   * le propriétaire délégué LIT via /api/mandat/depenses.
--
-- MIGRATION STRICTEMENT ADDITIVE : crée 1 table, n'altère aucune
-- table existante.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.depenses (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bien_id BIGINT NOT NULL REFERENCES public.biens(id) ON DELETE CASCADE,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    libelle TEXT NOT NULL,
    montant NUMERIC(12,2) NOT NULL CHECK (montant >= 0),
    categorie TEXT NOT NULL DEFAULT 'autre'
        CHECK (categorie IN ('entretien', 'travaux', 'assurance', 'charges', 'taxe', 'autre')),
    date_depense DATE NOT NULL DEFAULT CURRENT_DATE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS depenses_user_date_idx
    ON public.depenses (user_id, date_depense DESC);

CREATE INDEX IF NOT EXISTS depenses_bien_idx
    ON public.depenses (bien_id);

-- RLS : strictement le propriétaire du bien (pattern owner_all_*).
ALTER TABLE public.depenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_all_depenses" ON public.depenses;
CREATE POLICY "owner_all_depenses" ON public.depenses
    FOR ALL USING (auth.uid() = user_id);

-- Accès client classiques (l'écriture d'une agence passe par le
-- serveur service_role, aucune écriture client directe).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.depenses TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE depenses_id_seq TO authenticated;

-- service_role : les grants « ALL sur tout le schéma » des migrations de
-- hardening ne s'appliquent qu'aux tables existantes à leur exécution ;
-- toute table créée après doit les recevoir explicitement.
GRANT ALL ON public.depenses TO service_role;
GRANT ALL ON SEQUENCE depenses_id_seq TO service_role;
