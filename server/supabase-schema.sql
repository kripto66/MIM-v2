-- ============================================================
-- MyImmoManagement - Schéma Supabase
-- À exécuter dans Supabase : SQL Editor → New query
-- ============================================================

-- Profil étendu (au-dessus de auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    account_type TEXT NOT NULL CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire', 'admin')),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    username TEXT,
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Username de connexion unique dans toute l'application (comptes locataires/employés)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uniq
    ON public.profiles (username) WHERE username IS NOT NULL;

-- Biens
CREATE TABLE IF NOT EXISTS public.biens (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nom TEXT NOT NULL,
    type TEXT NOT NULL,
    adresse TEXT,
    ville TEXT,
    pays TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logements
CREATE TABLE IF NOT EXISTS public.logements (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bien_id BIGINT REFERENCES public.biens(id) ON DELETE SET NULL,
    nom TEXT NOT NULL,
    loyer_mensuel NUMERIC(12,2) NOT NULL DEFAULT 0,
    statut TEXT NOT NULL DEFAULT 'libre' CHECK (statut IN ('libre', 'occupe', 'maintenance')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Locataires
CREATE TABLE IF NOT EXISTS public.locataires (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    nom TEXT NOT NULL,
    username TEXT,
    email TEXT,
    phone TEXT,
    date_entree DATE,
    jour_echeance INT DEFAULT 1,
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paiements (loyers)
CREATE TABLE IF NOT EXISTS public.paiements (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    locataire_id BIGINT REFERENCES public.locataires(id) ON DELETE CASCADE,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    montant NUMERIC(12,2) NOT NULL,
    mois TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente' CHECK (statut IN ('paye', 'attente', 'retard', 'a_confirmer', 'en_validation', 'refuse')),
    date_paiement DATE,
    methode_paiement TEXT CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')),
    reference TEXT,
    validation_requested_at TIMESTAMPTZ,
    validated_at TIMESTAMPTZ,
    validated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Incidents
CREATE TABLE IF NOT EXISTS public.incidents (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    titre TEXT NOT NULL,
    description TEXT,
    statut TEXT NOT NULL DEFAULT 'nouveau' CHECK (statut IN ('nouveau', 'en_cours', 'resolu')),
    resolved_by BIGINT REFERENCES public.employes(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prestataires
CREATE TABLE IF NOT EXISTS public.prestataires (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nom TEXT NOT NULL,
    specialite TEXT,
    phone TEXT,
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Interventions
CREATE TABLE IF NOT EXISTS public.interventions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    incident_id BIGINT REFERENCES public.incidents(id) ON DELETE SET NULL,
    prestataire_id BIGINT REFERENCES public.prestataires(id) ON DELETE SET NULL,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    titre TEXT NOT NULL,
    description TEXT,
    statut TEXT NOT NULL DEFAULT 'planifie' CHECK (statut IN ('planifie', 'en_cours', 'termine')),
    date_prevue DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Moyens de paiement configurés par le propriétaire (indiqués aux locataires)
CREATE TABLE IF NOT EXISTS public.moyens_paiement (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('wave', 'orange_money', 'virement', 'especes')),
    nom_titulaire TEXT,
    numero TEXT,
    lien_paiement TEXT,
    banque TEXT,
    num_compte TEXT,
    iban TEXT,
    bic TEXT,
    instructions TEXT,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications
CREATE TABLE IF NOT EXISTS public.notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    lu BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Employés (fiches créées par le propriétaire)
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

-- Tâches assignées aux employés
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

-- Paiements de salaire (déclaration propriétaire -> confirmation employé)
CREATE TABLE IF NOT EXISTS public.paiements_employes (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    employe_id BIGINT REFERENCES public.employes(id) ON DELETE CASCADE,
    employe_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    montant NUMERIC(12,2) NOT NULL,
    mois TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente'
        CHECK (statut IN ('paye', 'attente', 'non_recu')),
    date_paiement DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    methode_paiement TEXT CHECK (methode_paiement IS NULL OR methode_paiement IN ('especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money')),
    reference TEXT,
    confirmed_at TIMESTAMPTZ,
    confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    moyen_employe_id BIGINT REFERENCES public.moyens_paiement_employes(id) ON DELETE SET NULL
);

-- Moyens de paiement de l'employé (configurés par lui-même)
CREATE TABLE IF NOT EXISTS public.moyens_paiement_employes (
    id BIGSERIAL PRIMARY KEY,
    employe_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('wave', 'orange_money', 'virement', 'especes')),
    nom_titulaire TEXT,
    numero TEXT,
    lien_paiement TEXT,
    banque TEXT,
    num_compte TEXT,
    iban TEXT,
    bic TEXT,
    instructions TEXT,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions (sauvegarde automatique connexion / déconnexion)
CREATE TABLE IF NOT EXISTS public.sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    logout_at TIMESTAMPTZ
);

-- Abonnement MIM d'un propriétaire (une ligne par propriétaire, distinct
-- des paiements de loyer : l'écriture passe uniquement par le serveur).
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

-- Historique des paiements d'abonnement
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

-- ============================================================
-- Trigger : crée automatiquement le profil à l'inscription
-- (inclut username + must_change_password pour les comptes
-- locataires / employés créés par le propriétaire)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, account_type, name, email, phone, role, username, must_change_password)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'account_type', 'proprietaire'),
        COALESCE(NEW.raw_user_meta_data->>'name', ''),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'phone', ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'proprietaire'),
        NULLIF(NEW.raw_user_meta_data->>'username', ''),
        COALESCE((NEW.raw_user_meta_data->>'must_change_password')::boolean, false)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- Row Level Security : chaque utilisateur ne voit que ses données
-- ============================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locataires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prestataires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moyens_paiement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abonnement_paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_view_own" ON public.profiles
    FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users_can_update_own" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "owner_all_biens" ON public.biens
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_logements" ON public.logements
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_locataires" ON public.locataires
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_paiements" ON public.paiements
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_incidents" ON public.incidents
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_prestataires" ON public.prestataires
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_interventions" ON public.interventions
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_notifications" ON public.notifications
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_moyens_paiement" ON public.moyens_paiement
    FOR ALL USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner_select_own_subscription" ON public.subscriptions
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner_select_own_abonnement_paiements" ON public.abonnement_paiements
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner_all_sessions" ON public.sessions
    FOR ALL USING (auth.uid() = user_id);

-- Espace employé : propriétaire gère ses employés/tâches/salaires ;
-- l'employé lit sa fiche, ses tâches, ses paiements et met à jour
-- ses propres paiements (confirmation / non-réception).
ALTER TABLE public.employes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paiements_employes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moyens_paiement_employes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_employes" ON public.employes
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_tasks" ON public.tasks
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_all_paiements_employes" ON public.paiements_employes
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner_select_employe_moyens" ON public.moyens_paiement_employes
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.employes e
            WHERE e.account_uid = moyens_paiement_employes.employe_uid
              AND e.user_id = auth.uid()
        )
    );

CREATE POLICY "employe_select_own_employe" ON public.employes
    FOR SELECT USING (account_uid = auth.uid());
CREATE POLICY "employe_select_own_tasks" ON public.tasks
    FOR SELECT USING (employe_uid = auth.uid());
CREATE POLICY "employe_select_own_paiements" ON public.paiements_employes
    FOR SELECT USING (employe_uid = auth.uid());
CREATE POLICY "employe_update_own_paiements" ON public.paiements_employes
    FOR UPDATE USING (employe_uid = auth.uid());
CREATE POLICY "employe_all_own_moyens" ON public.moyens_paiement_employes
    FOR ALL USING (employe_uid = auth.uid())
    WITH CHECK (employe_uid = auth.uid());

-- ============================================================
-- Espace locataire : compte en ligne (type de compte 'locataire')
-- ============================================================
-- Compatibilité bases existantes : ajuste la contrainte et ajoute la colonne
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
    CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire', 'admin'));

ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Le locataire lit sa propre fiche
CREATE POLICY "tenant_select_locataire" ON public.locataires
    FOR SELECT USING (account_uid = auth.uid());

-- Sélection par email : nécessaire pour que la liaison (UPDATE) puisse
-- cibler la fiche avant qu'elle ne soit rattachée au compte.
CREATE POLICY "tenant_select_by_email" ON public.locataires
    FOR SELECT USING (lower(email) = lower(auth.jwt() ->> 'email'));

-- Liaison unique : le locataire s'attache à la fiche dont l'email correspond.
-- Une fois lié (account_uid renseigné), il ne peut plus modifier la fiche.
CREATE POLICY "tenant_link_locataire" ON public.locataires
    FOR UPDATE
    USING (lower(email) = lower(auth.jwt() ->> 'email') AND account_uid IS NULL)
    WITH CHECK (account_uid = auth.uid());

-- Le locataire voit son logement
CREATE POLICY "tenant_select_logement" ON public.logements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.logement_id = logements.id
        )
    );

-- Le locataire voit le bien auquel son logement appartient
CREATE POLICY "tenant_select_bien" ON public.biens
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.bien_id = biens.id AND l.account_uid = auth.uid()
        )
    );

-- Le locataire voit ses paiements
CREATE POLICY "tenant_select_paiement" ON public.paiements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.id = paiements.locataire_id
        )
    );

-- Le locataire voit les moyens de paiement ACTIFS du propriétaire de SON
-- logement (déduit via sa fiche locataire, jamais fourni par le client)
CREATE POLICY "tenant_select_moyens_paiement" ON public.moyens_paiement
    FOR SELECT USING (
        actif = TRUE
        AND EXISTS (
            SELECT 1
            FROM public.locataires l
            JOIN public.logements lg ON lg.id = l.logement_id
            WHERE l.account_uid = auth.uid()
              AND lg.user_id = moyens_paiement.user_id
        )
    );

-- Le locataire voit les incidents de son logement
CREATE POLICY "tenant_select_incident" ON public.incidents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.id = incidents.logement_id AND l.account_uid = auth.uid()
        )
    );
