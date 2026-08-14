-- ============================================================
-- MIM - Espace employé : comptes créés par le propriétaire
--
-- Règle métier :
--  * L'employé ne crée jamais son propre compte : seul le
--    propriétaire crée le compte depuis sa page « Mes employés »
--    (username + mot de passe temporaire), fixe le salaire et paie.
--  * L'employé se connecte pour consulter ses tâches, incidents,
--    interventions et ses paiements de salaire.
-- ============================================================

-- Type de compte 'employe' autorisé
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
    CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire', 'admin', 'employe'));

-- Fiches employés (créées par le propriétaire)
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

-- Tâches assignées aux employés (créées par le propriétaire)
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

-- Paiements de salaire des employés
CREATE TABLE IF NOT EXISTS public.paiements_employes (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    employe_id BIGINT REFERENCES public.employes(id) ON DELETE CASCADE,
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

-- Propriétaire : gestion complète de ses employés, tâches et paiements
CREATE POLICY "owner_all_employes" ON public.employes
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_tasks" ON public.tasks
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_paiements_employes" ON public.paiements_employes
    FOR ALL USING (auth.uid() = user_id);

-- Employé : lecture de sa propre fiche, ses tâches et ses paiements
CREATE POLICY "employe_select_own_employe" ON public.employes
    FOR SELECT USING (account_uid = auth.uid());
CREATE POLICY "employe_select_own_tasks" ON public.tasks
    FOR SELECT USING (employe_uid = auth.uid());
CREATE POLICY "employe_select_own_paiements" ON public.paiements_employes
    FOR SELECT USING (employe_uid = auth.uid());

-- Privilèges (ces tables sont créées après le script de grants minimaux)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employes, public.tasks, public.paiements_employes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE employes_id_seq, tasks_id_seq, paiements_employes_id_seq TO authenticated;
GRANT ALL ON public.employes, public.tasks, public.paiements_employes TO service_role;
GRANT ALL ON SEQUENCE employes_id_seq, tasks_id_seq, paiements_employes_id_seq TO service_role;
