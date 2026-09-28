-- ---------------------------------------------------------------------
-- CHECK profiles_account_type_check : NE PAS le recréer ici.
-- L'état final (server/supabase-schema.sql:1250, et
-- 20260924000000_security_integrity_hardening.sql:2) autorise 7 valeurs :
--   ('proprietaire','agence','entreprise','locataire','admin','employe','ultra_admin')
-- Recréer une liste réduite dans ce fichier écrase l'état durci et casse
-- les comptes 'ultra_admin' (et 'employe' pour schema-admin.sql).
-- La contrainte existante fait foi : on ne touche pas à profiles.
-- ---------------------------------------------------------------------

ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE POLICY "tenant_select_locataire" ON public.locataires
    FOR SELECT USING (account_uid = auth.uid());

-- ---------------------------------------------------------------------
-- Policy "tenant_link_locataire" SUPPRIMÉE (ne pas la recréer).
-- Elle permettait à n'importe quel porteur d'un JWT dont l'e-mail
-- correspondait de UPDATEr sa fiche locataire : c'est la faille close par
-- 20260924000000_security_integrity_hardening.sql:435 et
-- 20260925000000_security_blockers.sql:149 (DROP POLICY).
-- La liaison compte <-> fiche se fait uniquement côté serveur via
-- public.consume_tenant_invitation() (SECURITY DEFINER, jeton haché).
-- ---------------------------------------------------------------------

CREATE POLICY "tenant_select_logement" ON public.logements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.logement_id = logements.id
        )
    );

CREATE POLICY "tenant_select_bien" ON public.biens
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.bien_id = biens.id AND l.account_uid = auth.uid()
        )
    );

CREATE POLICY "tenant_select_paiement" ON public.paiements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.id = paiements.locataire_id
        )
    );

CREATE POLICY "tenant_select_incident" ON public.incidents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.id = incidents.logement_id AND l.account_uid = auth.uid()
        )
    );

-- ============================================================
-- Espace employé : comptes créés par le propriétaire
-- (type 'employe', table employes, table tasks, paiements de salaire)
-- ============================================================

-- ---------------------------------------------------------------------
-- Type de compte 'employe' : la contrainte profiles_account_type_check
-- a été élargie à 'employe' ET 'ultra_admin' par
-- 20260924000000_security_integrity_hardening.sql:2. Ne pas la recréer
-- ici avec une liste tronquée (voir commentaire en tête de fichier) :
-- l'état final fait foi.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employes (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    username TEXT,
    nom TEXT NOT NULL,
    poste TEXT,
    salaire NUMERIC(12,2) NOT NULL DEFAULT 0,
    email TEXT,
    phone TEXT,
    date_embauche DATE,
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tasks (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    employe_uid UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    titre TEXT NOT NULL,
    description TEXT,
    statut TEXT NOT NULL DEFAULT 'a_faire' CHECK (statut IN ('a_faire', 'en_cours', 'termine')),
    echeance DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.paiements_employes (
    id BIGSERIAL PRIMARY KEY,
    -- État final (server/supabase-schema.sql:2278 et :2263) :
    -- ON DELETE RESTRICT pour user_id et employe_id — l'historique des
    -- salaires ne doit jamais être détruit avec le compte ni avec la
    -- fiche employé. 20260924060000_financial_user_restrict.sql:5 a posé
    -- paiements_employes_user_id_fkey en RESTRICT, et
    -- 20260924000000:244 a remplacé la FK employe_id CASCADE par
    -- paiements_employes_employe_restrict_fk (RESTRICT).
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    employe_id BIGINT REFERENCES public.employes(id) ON DELETE RESTRICT,
    employe_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    montant NUMERIC(12,2) NOT NULL,
    mois TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente' CHECK (statut IN ('paye', 'attente')),
    date_paiement DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paiements_employes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_employes" ON public.employes
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_tasks" ON public.tasks
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_paiements_employes" ON public.paiements_employes
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "employe_select_own_employe" ON public.employes
    FOR SELECT USING (account_uid = auth.uid());
CREATE POLICY "employe_select_own_tasks" ON public.tasks
    FOR SELECT USING (employe_uid = auth.uid());
CREATE POLICY "employe_select_own_paiements" ON public.paiements_employes
    FOR SELECT USING (employe_uid = auth.uid());

-- Privilèges : LECTURE SEULE pour authenticated.
-- 20260924000000:448-451 et 20260925000000:155-158 font
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated
--   puis GRANT SELECT ...
-- Accorder INSERT/UPDATE/DELETE laissait un employé modifier SON bulletin
-- de salaire (montant/mois/statut) via PostgREST. Toutes les écritures
-- passent par service_role (server/routes/*). Les séquences ne sont plus
-- accordées non plus (REVOKE ALL ON ALL SEQUENCES ... FROM PUBLIC,anon,
-- authenticated — 20260924000000:449) : inutile sans INSERT côté client.
GRANT SELECT ON public.employes, public.tasks, public.paiements_employes TO authenticated;
GRANT ALL ON public.employes, public.tasks, public.paiements_employes TO service_role;
GRANT ALL ON SEQUENCE employes_id_seq, tasks_id_seq, paiements_employes_id_seq TO service_role;
