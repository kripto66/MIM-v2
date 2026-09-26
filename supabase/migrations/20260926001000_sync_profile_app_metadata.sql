-- ============================================================
-- MIM - Synchronisation du profil avec app_metadata (rôles)
--
-- GoTrue applique `app_metadata` APRÈS l'INSERT de auth.users :
-- le trigger handle_new_user se déclenche donc avec un
-- raw_app_meta_data vide et crée le profil en 'proprietaire'.
-- Tout compte créé par le serveur avec un rôle (employe, locataire,
-- agence, ...) se retrouvait avec un profil au rôle trop élevé
-- tant que l'application ne corrigeait pas la ligne.
--
-- Ce trigger rattrape le coup : dès que app_metadata change
-- (uniquement possible par le service_role, GoTrue interdisant au
-- client de modifier app_metadata), le profil est resynchronisé.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_profile_account_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_type text;
    v_must text;
BEGIN
    v_type := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_account_type', '')));
    IF v_type NOT IN ('proprietaire','agence','entreprise','locataire','employe','admin','ultra_admin') THEN
        RETURN NEW;
    END IF;

    v_must := lower(pg_catalog.btrim(COALESCE(NEW.raw_app_meta_data ->> 'mim_must_change_password', '')));

    UPDATE public.profiles
       SET account_type = v_type,
           role = v_type,
           must_change_password = CASE
               WHEN v_must IN ('true','1') THEN true
               WHEN v_must IN ('false','0') THEN false
               ELSE public.profiles.must_change_password
           END
     WHERE id = NEW.id
       AND public.profiles.account_type IS DISTINCT FROM v_type;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mim_sync_profile_role ON auth.users;
CREATE TRIGGER mim_sync_profile_role
    AFTER UPDATE OF raw_app_meta_data ON auth.users
    FOR EACH ROW
    WHEN (OLD.raw_app_meta_data IS DISTINCT FROM NEW.raw_app_meta_data)
    EXECUTE FUNCTION public.sync_profile_account_type();

REVOKE EXECUTE ON FUNCTION public.sync_profile_account_type() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_profile_account_type() TO service_role;
