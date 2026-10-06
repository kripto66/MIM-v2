-- ============================================================
-- MIM - Essai gratuit 30 jours + marqueur trial_used
--
-- Produit :
--   * l'essai automatique à l'inscription passe de 14 à 30 jours ;
--   * une fenêtre d'essai est comptée UNE SEULE fois par compte :
--     la colonne profiles.trial_used est posée dès le démarrage
--     d'une fenêtre (trigger d'inscription) ;
--   * tout compte ayant DÉJÀ réglé un montant > 0 est marqué
--     d'office : après expiration de son abonnement, il souscrit —
--     jamais de second essai gratuit.
--
-- Le mode promo (boutons « Essai gratuit 30j », checkout Bictorys
-- en pause pour les comptes éligibles) n'est PAS posé ici : il est
-- piloté côté serveur par la clé system_config 'plan_trial_mode'
-- (repli sur l'env PLAN_TRIAL_MODE). Ce fichier ne change que les
-- règles de durée et d'éligibilité.
--
-- Idempotent : colonne IF NOT EXISTS, backfill déterministe,
-- CREATE OR REPLACE FUNCTION. Relire ce fichier ne change rien.
-- ============================================================


-- ============================================================
-- (a) Marqueur « une seule fenêtre d'essai par compte »
-- ============================================================

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS trial_used boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.trial_used IS
    'true : ce compte a déjà démarré une fenêtre d''essai ou réglé un abonnement — il n''est plus éligible à un essai gratuit.';


-- ============================================================
-- (b) Backfill : tout compte ayant déjà payé n'a plus droit d'essai
-- ============================================================

UPDATE public.profiles p
   SET trial_used = true
 WHERE p.trial_used = false
   AND EXISTS (
         SELECT 1
           FROM public.abonnement_paiements ap
          WHERE ap.user_id = p.id
            AND ap.statut = 'paid'
            AND ap.montant > 0
       );


-- ============================================================
-- (c) Trigger d'inscription : essai de 30 jours + marquage
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
    v_created uuid;
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
                (NEW.id, 'essai', v_plan_id, 'actif', v_now, v_now + interval '30 days',
                 0, NULL, 'essai-automatique', NULL, v_now)
            ON CONFLICT (user_id) DO NOTHING
            RETURNING id INTO v_created;
        EXCEPTION WHEN others THEN
            RAISE WARNING 'abonnement d''essai non cree pour le profil % - %', NEW.id, SQLERRM;
        END;

        -- Fenêtre d'essai réellement créée (pas un simple conflit) :
        -- le compte ne pourra pas repartir sur un second essai.
        IF v_created IS NOT NULL THEN
            BEGIN
                UPDATE public.profiles
                   SET trial_used = true
                 WHERE id = NEW.id AND trial_used = false;
            EXCEPTION WHEN others THEN
                RAISE WARNING 'marquage trial_used impossible pour le profil % - %', NEW.id, SQLERRM;
            END;
        END IF;

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
    'Essai gratuit de 30 jours (plan « essai ») pour un compte propriétaire / agence / entreprise, créé dès que account_type est fiable (INSERT ou UPDATE) et marquant profiles.trial_used pour n''accorder qu''une seule fenêtre d''essai par compte. Pour tout autre type, retire un essai automatique résiduel. Jamais bloquant : chaque erreur est un WARNING.';


-- ============================================================
-- (d) Description publique du plan « essai » : 14 → 30 jours
-- ============================================================

UPDATE public.plans
   SET description = replace(description, '14 jours', '30 jours'),
       updated_at = now()
 WHERE code = 'essai'
   AND description LIKE '%14 jours%';


-- ============================================================
-- (e) Historique d'essai autorisé dans abonnement_paiements
--
-- Le démarrage d'une fenêtre d'essai écrit une ligne 0 XOF
-- (méthode « essai ») pour que l'utilisateur voie sa trace dans
-- « Historique des paiements ». Deux contraintes datant de l'ère
-- exclusive payée l'en empêchaient :
--   * methode_paiement : 'essai' devient une valeur légale ;
--   * montant > 0 devient montant >= 0 (0 XOF = essai gratuit ;
--     seuls les comptes service_role écrivent dans cette table).
-- ============================================================

ALTER TABLE public.abonnement_paiements
    DROP CONSTRAINT IF EXISTS abonnement_paiements_methode_check;

ALTER TABLE public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_methode_check
    CHECK (
        methode_paiement IS NULL
        OR methode_paiement IN (
            'especes', 'mobile_money', 'virement', 'carte',
            'wave', 'orange_money', 'bictorys', 'essai'
        )
    );

ALTER TABLE public.abonnement_paiements
    DROP CONSTRAINT IF EXISTS abonnement_paiements_montant_ck;

ALTER TABLE public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_montant_ck
    CHECK (montant >= 0);
