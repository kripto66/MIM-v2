-- ============================================================
-- MyImmoManagement - Schéma Supabase
-- À exécuter dans Supabase : SQL Editor → New query
-- ============================================================

-- Profil étendu (au-dessus de auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    account_type TEXT NOT NULL CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire')),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    email TEXT,
    phone TEXT,
    date_entree DATE,
    statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paiements
CREATE TABLE IF NOT EXISTS public.paiements (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    locataire_id BIGINT REFERENCES public.locataires(id) ON DELETE CASCADE,
    logement_id BIGINT REFERENCES public.logements(id) ON DELETE SET NULL,
    montant NUMERIC(12,2) NOT NULL,
    mois TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente' CHECK (statut IN ('paye', 'attente', 'retard')),
    date_paiement DATE,
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

-- Notifications
CREATE TABLE IF NOT EXISTS public.notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    lu BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- ============================================================
-- Trigger : crée automatiquement le profil à l'inscription
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, account_type, name, email, phone, role)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'account_type', 'proprietaire'),
        COALESCE(NEW.raw_user_meta_data->>'name', ''),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'phone', ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'proprietaire')
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
CREATE POLICY "owner_all_sessions" ON public.sessions
    FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- Espace locataire : compte en ligne (type de compte 'locataire')
-- ============================================================
-- Compatibilité bases existantes : ajuste la contrainte et ajoute la colonne
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
    CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire'));

ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Le locataire lit sa propre fiche
CREATE POLICY "tenant_select_locataire" ON public.locataires
    FOR SELECT USING (account_uid = auth.uid());

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

-- Le locataire voit les incidents de son logement
CREATE POLICY "tenant_select_incident" ON public.incidents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.id = incidents.logement_id AND l.account_uid = auth.uid()
        )
    );
