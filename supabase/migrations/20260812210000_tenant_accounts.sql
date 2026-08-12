-- ============================================================
-- MIM - Comptes locataires créés par le propriétaire
--
-- Règle métier :
--  * Le locataire ne crée jamais son propre compte.
--  * Le propriétaire crée le compte (username + mot de passe temporaire).
--  * L'email n'est PAS obligatoire pour un locataire (email interne généré).
--  * À la première connexion, le locataire doit changer son mot de passe.
--  * Le locataire peut modifier son username depuis son profil.
-- ============================================================

-- Username affiché / utilisé pour la connexion
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uniq
    ON public.profiles (username) WHERE username IS NOT NULL;

-- Mot de passe à changer à la première connexion
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Username visible sur la fiche locataire du propriétaire
ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS username TEXT;

-- Trigger : crée le profil à l'inscription (inclut username + must_change_password)
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
