-- ============================================================
-- MIM - Correction du déclencheur d'essai automatique
--
-- PROBLÈME (constaté le 2026-09-27 après20260927100000) :
-- 20260927100000_quota_essai.sql:(c) crée l'essai dans un
-- AFTER INSERT ON public.profiles en testant NEW.account_type.
-- Or GoTrue écrit les métadonnées d'application (raw_app_meta_data)
-- dans une étape SÉPARÉE de l'INSERT : c'est exactement pourquoi
-- 20260926001000_sync_profile_app_metadata.sql existe, avec un
-- AFTER UPDATE OF raw_app_meta_data sur auth.users qui corrige
-- profiles.account_type après coup.
--
-- Conséquence : au moment de l'INSERT, handle_new_user() ne lit
-- aucun mim_account_type et retombe sur sa valeur par défaut
-- « proprietaire » (supabase-schema.sql handle_new_user :
-- COALESCE(NULLIF(v_app_type,''), NULLIF(v_public_type,''),
-- 'proprietaire')). Le déclencheur voyait donc TOUJOURS
-- « proprietaire » : locataires, employés, admins et ultra_admins
-- recevaient un abonnement « essai » (153 comptes le 2026-09-27).
-- Deux effets de bord :
--   * subscriptions a un FK ON DELETE RESTRICT vers auth.users :
--     la suppression d'un compte de test bloquait la suite E2E
--     (wipeTestData) ;
--   * des comptes non abonnables portaient une souscription.
--
-- CORRECTION :
--   * le déclencheur devient AFTER INSERT OR UPDATE OF account_type,
--     donc il s'exécute à chaque fois que le type de compte devient
--     fiable — qu'il soit posé par handle_new_user (INSERT) ou
--     corrigé plus tard par sync_profile_account_type /
--     provisionProfile (UPDATE) ;
--   * pour un type NON éligible, on supprime l'abonnement
--     « essai-automatique » éventuellement créé pendant la fenêtre
--     transitoire. Jamais un autre abonnement : seul le marquage
--     reference = 'essai-automatique' est touché, un abonnement
--     payant voit sa référence remplacée par celle du paiement
--     (activate_subscription_payment) et n'est donc pas menacé ;
--   * purge des lignes erronées déjà en base.
--
-- Idempotent : CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS,
-- DELETE ciblé. Relire ce fichier ne change rien.
-- ============================================================


-- ============================================================
-- (a) Fonction corrigée
-- ============================================================

CREATE OR REPLACE FUNCTION public.mim_trial_subscription_on_signup()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $fn$
DECLARE
    v_type text;
    v_plan_id uuid;
    v_now timestamptz;
BEGIN
    v_type := pg_catalog.lower(pg_catalog.btrim(COALESCE(NEW.account_type, '')));

    IF v_type IN ('proprietaire', 'agence', 'entreprise') THEN
        SELECT id INTO v_plan_id FROM public.plans WHERE code = 'essai' AND actif = true;
        IF v_plan_id IS NULL THEN
            RAISE WARNING 'abonnement d''essai ignore : plan « essai » introuvable ou inactif (profil %)', NEW.id;
            RETURN NEW;
        END IF;

        v_now := clock_timestamp();
        BEGIN
            INSERT INTO public.subscriptions
                (user_id, plan, plan_id, statut, date_debut, date_expiration,
                 montant, methode_paiement, reference, duree_abonnement, updated_at)
            VALUES
                (NEW.id, 'essai', v_plan_id, 'actif', v_now, v_now + interval '14 days',
                 0, NULL, 'essai-automatique', NULL, v_now)
            ON CONFLICT (user_id) DO NOTHING;
        EXCEPTION WHEN others THEN
            RAISE WARNING 'abonnement d''essai non cree pour le profil % - %', NEW.id, SQLERRM;
        END;

        RETURN NEW;
    END IF;

    -- Type non éligible (locataire, employe, admin, ultra_admin ou
    -- type invalide corrigé plus tard) : on efface l'essai créé
    -- pendant la fenêtre où account_type valait encore le défaut.
    BEGIN
        DELETE FROM public.subscriptions
         WHERE user_id = NEW.id
           AND reference = 'essai-automatique';
    EXCEPTION WHEN others THEN
        RAISE WARNING 'nettoyage de l''essai automatique impossible pour le profil % - %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.mim_trial_subscription_on_signup() IS
    'Essai gratuit de 14 jours (plan « essai ») pour un compte propriétaire / agence / entreprise, créé dès que account_type est fiable (INSERT ou UPDATE). Pour tout autre type, retire un essai automatique résiduel. Jamais bloquant : chaque erreur est un WARNING.';


-- ============================================================
-- (b) Déclencheur : INSERT + UPDATE OF account_type
-- ============================================================

DROP TRIGGER IF EXISTS mim_trial_subscription_on_signup ON public.profiles;
CREATE OR REPLACE TRIGGER mim_trial_subscription_on_signup
    AFTER INSERT OR UPDATE OF account_type ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.mim_trial_subscription_on_signup();


-- ============================================================
-- (c) Purge des essais automatiques erronés déjà en base
--
-- Seuls les comptes éligibles conservent leur essai. Aucun autre
-- abonnement n'est touché (filtre reference = 'essai-automatique').
-- ============================================================

DELETE FROM public.subscriptions s
 USING public.profiles p
 WHERE p.id = s.user_id
   AND s.reference = 'essai-automatique'
   AND pg_catalog.lower(pg_catalog.btrim(COALESCE(p.account_type, '')))
       NOT IN ('proprietaire', 'agence', 'entreprise');
