-- ============================================================
-- MIM - Prix du plan figé sur le paiement (checkout Bictorys)
--
-- Constat (audit du 2026-09-27) :
--   * createCheckout() écrit abonnement_paiements.montant avec
--     plans.prix AU MOMENT du checkout, puis crée le lien Bictorys
--     avec ce même montant : le client paie le prix en vigueur à la
--     commande ;
--   * activate_subscription_payment() exigeait
--     v_payment.montant = v_plan.prix, c'est-à-dire le prix en
--     vigueur AU MOMENT DE L'ACTIVATION. Dès qu'un administrateur
--     changeait un prix (ou enchaînait deux changements) pendant la
--     fenêtre entre le checkout et l'encaissement, l'activation
--     levait « Montant plan invalide. » : le client avait payé et
--     l'abonnement ne s'activait jamais ;
--   * routes/ultra-admin.js ne faisait que renvoyer une
--     « avertissement » explicatif, sans empêcher ni résoudre
--     l'incohérence.
--
-- Correction : le prix est figé SUR LE PAIEMENT (prix_plan), ce qui
-- était déjà la vérité métier. L'activation compare alors le montant
-- encaissé au prix figé à la commande, et non au catalogue courant :
--   * un changement de prix ne bloque plus les paiements déjà
--     engagés ;
--   * l'intégrité est préservée : prix_plan est écrit côté serveur
--     au checkout (il n'est jamais dérivé d'une saisie client) et
--     montant continue d'être confronté au montant réellement
--     encaissé par Bictorys (p_expected_amount + webhook) ;
--   * les lignes sans prix_plan (créées avant cette migration)
--     conservent l'ancien comportement strict, puis sont rétro-
--     remplies ci-dessous.
--
-- Idempotent : ADD COLUMN IF NOT EXISTS, garde pg_constraint avant
-- ADD CONSTRAINT, UPDATE ciblé, CREATE OR REPLACE FUNCTION.
-- ============================================================


-- ============================================================
-- (a) Colonne prix_plan
-- ============================================================

ALTER TABLE public.abonnement_paiements ADD COLUMN IF NOT EXISTS prix_plan numeric;

COMMENT ON COLUMN public.abonnement_paiements.prix_plan IS
    'Prix du plan au moment de la création du checkout (écrit par le serveur). Permet d''activer un paiement engagé à l''ancien prix après un changement de catalogue. NULL = ligne antérieure à la migration (comparaison au catalogue courant).';

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.abonnement_paiements'::regclass
          AND conname = 'abonnement_paiements_prix_plan_ck'
    ) THEN
        ALTER TABLE public.abonnement_paiements
            ADD CONSTRAINT abonnement_paiements_prix_plan_ck
            CHECK (prix_plan IS NULL OR prix_plan >= 0)
            NOT VALID;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.abonnement_paiements'::regclass
          AND conname = 'abonnement_paiements_prix_plan_ck'
          AND NOT convalidated
    ) THEN
        ALTER TABLE public.abonnement_paiements
            VALIDATE CONSTRAINT abonnement_paiements_prix_plan_ck;
    END IF;
EXCEPTION WHEN others THEN
    RAISE WARNING 'abonnement_paiements_prix_plan_ck : NON creee/validee - %', SQLERRM;
END $do$;


-- ============================================================
-- (b) Rétro-compatibilité des paiements déjà engagés
--
-- Tous les paiements Bictorys ont été créés avec montant = plans.prix
-- à la commande : leur figer le même montant en prix_plan leur rend
-- exactement le comportement qu'ils avaient avant la migration, sans
-- changer aucun montant.
-- ============================================================

UPDATE public.abonnement_paiements
   SET prix_plan = montant
 WHERE prix_plan IS NULL
   AND pg_catalog.lower(pg_catalog.btrim(COALESCE(provider, 'bictorys'))) = 'bictorys';


-- ============================================================
-- (c) activate_subscription_payment : comparaison au prix figé
-- ============================================================

CREATE OR REPLACE FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text" DEFAULT NULL::"text", "p_paid_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_amount" numeric DEFAULT NULL::numeric, "p_currency" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_payment public.abonnement_paiements%ROWTYPE; v_plan public.plans%ROWTYPE; v_sub public.subscriptions%ROWTYPE; v_now timestamptz := clock_timestamp(); v_paid timestamptz; v_start timestamptz; v_expiry timestamptz; v_duration integer; v_id uuid; v_tx text; v_cur text;
BEGIN
    SELECT * INTO v_payment FROM public.abonnement_paiements WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Paiement introuvable.'; END IF;
    IF v_payment.statut = 'paid' THEN SELECT id INTO v_id FROM public.subscriptions WHERE user_id = v_payment.user_id; IF NOT FOUND THEN RAISE EXCEPTION 'Abonnement manquant.'; END IF; RETURN v_id; END IF;
    IF v_payment.statut <> 'pending' THEN RAISE EXCEPTION 'Paiement non pending.'; END IF;
    SELECT * INTO v_plan FROM public.plans WHERE code = lower(btrim(v_payment.plan)) AND actif = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan inactif.'; END IF;
    IF p_expected_amount IS NOT NULL AND v_payment.montant IS DISTINCT FROM p_expected_amount THEN RAISE EXCEPTION 'Montant invalide.'; END IF;
    -- Prix figé à la commande (prix_plan) : un changement de catalogue
    -- entre le checkout et l'encaissement ne doit pas bloquer un
    -- paiement légitime. À défaut de prix figé (lignes antérieures),
    -- on retombe sur l'ancienne comparaison au catalogue courant.
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' THEN
        IF v_payment.prix_plan IS NOT NULL THEN
            IF v_payment.montant IS DISTINCT FROM v_payment.prix_plan THEN RAISE EXCEPTION 'Montant plan invalide.'; END IF;
        ELSIF v_payment.montant IS DISTINCT FROM v_plan.prix THEN
            RAISE EXCEPTION 'Montant plan invalide.';
        END IF;
    END IF;
    v_cur := upper(COALESCE(NULLIF(btrim(p_currency),''),upper(btrim(v_payment.devise)),upper(btrim(v_plan.devise))));
    IF upper(btrim(v_payment.devise)) <> v_cur OR upper(btrim(v_plan.devise)) <> v_cur THEN RAISE EXCEPTION 'Devise invalide.'; END IF;
    v_duration := COALESCE(v_payment.duree_abonnement,v_plan.duree_abonnement);
    IF v_duration < 1 OR v_duration > 36 THEN RAISE EXCEPTION 'Duree invalide.'; END IF;
    v_tx := COALESCE(NULLIF(btrim(p_transaction_id),''),NULLIF(btrim(v_payment.transaction_id),''));
    IF lower(COALESCE(v_payment.provider,'manuel')) = 'bictorys' AND v_tx IS NULL THEN RAISE EXCEPTION 'Transaction absente.'; END IF;
    IF v_payment.transaction_id IS NOT NULL AND v_payment.transaction_id <> v_tx THEN RAISE EXCEPTION 'Transaction incoherente.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_payment.user_id::text || ':subscription',0));
    SELECT * INTO v_sub FROM public.subscriptions WHERE user_id = v_payment.user_id FOR UPDATE;
    v_paid := COALESCE(p_paid_at,v_now);
    v_start := CASE WHEN v_sub.id IS NOT NULL AND v_sub.date_expiration > v_now THEN v_sub.date_expiration ELSE v_now END;
    v_expiry := v_start + make_interval(months => v_duration);
    INSERT INTO public.subscriptions(user_id,plan,plan_id,statut,date_debut,date_expiration,date_paiement,montant,methode_paiement,reference,bictorys_transaction_id,bictorys_reference,duree_abonnement,updated_at)
    VALUES(v_payment.user_id,v_plan.code,v_plan.id,'actif',COALESCE(v_sub.date_debut,v_start),v_expiry,v_paid,v_payment.montant,v_payment.methode_paiement,v_payment.reference,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_tx ELSE NULL END,CASE WHEN lower(COALESCE(v_payment.provider,'manuel'))='bictorys' THEN v_payment.reference ELSE NULL END,v_duration,v_now)
    ON CONFLICT (user_id) DO UPDATE SET plan=EXCLUDED.plan,plan_id=EXCLUDED.plan_id,statut='actif',date_expiration=EXCLUDED.date_expiration,date_paiement=EXCLUDED.date_paiement,montant=EXCLUDED.montant,methode_paiement=EXCLUDED.methode_paiement,reference=EXCLUDED.reference,bictorys_transaction_id=EXCLUDED.bictorys_transaction_id,bictorys_reference=EXCLUDED.bictorys_reference,duree_abonnement=EXCLUDED.duree_abonnement,updated_at=EXCLUDED.updated_at
    RETURNING id INTO v_id;
    UPDATE public.abonnement_paiements SET statut='paid',transaction_id=COALESCE(v_tx,transaction_id),date_paiement=v_paid,updated_at=v_now WHERE id=p_payment_id AND statut='pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Conflit de paiement.'; END IF;
    RETURN v_id;
END;
$$;

ALTER FUNCTION "public"."activate_subscription_payment"("p_payment_id" bigint, "p_transaction_id" "text", "p_paid_at" timestamp with time zone, "p_expected_amount" numeric, "p_currency" "text") OWNER TO "postgres";
