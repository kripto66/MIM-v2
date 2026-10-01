-- ============================================================
-- MIM - M-01 : outbox de rejeu des notifications.
--
-- `notify()` ne lève jamais et, jusqu'ici, un échec d'insertion
-- était simplement journalisé en console : la notification était
-- perdue en silence. L'outbox fiabilise la remise :
--   * insertion nominale directe dans `notifications` (inchangée) ;
--   * si elle échoue, la ligne est journalisée dans cette file ;
--   * `notifications_outbox_flush()` (SECURITY DEFINER, service_role
--     uniquement) reprend les lignes pending avec backoff
--     exponentiel, en FOR UPDATE SKIP LOCKED pour que plusieurs
--     process puissent balayer sans double remise.
--
-- La table n'a PAS de FK sur user_id : c'est un journal de rejeu —
-- un compte supprimé entre-temps doit rester journalisable (la remise
-- échouera alors définitivement et la ligne devient dead letter, avec
-- `last_error` pour diagnostic ; purge au-delà de 7 jours).
--
-- MIGRATION STRICTEMENT ADDITIVE.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications_outbox (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS notifications_outbox_pending_idx
    ON public.notifications_outbox (next_attempt_at)
    WHERE delivered_at IS NULL;

-- Table interne serveur : le client ne lit que `notifications`.
ALTER TABLE public.notifications_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notifications_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.notifications_outbox TO service_role;
GRANT ALL ON SEQUENCE notifications_outbox_id_seq TO service_role;

-- ------------------------------------------------------------------
-- Rejeu : purge des lignes expirées, remise des lignes prêtes.
-- Retourne le nombre de notifications délivrées.
--   - SKIP LOCKED : deux process balayant en même temps ne traitent
--     jamais la même ligne ;
--   - backoff 30s x 2^attempts, 8 tentatives max au-delà desquelles la
--     ligne reste en dead letter inspectable (last_error) ;
--   - purge : délivrées depuis > 7 jours, ou dead letters vieilles de
--     > 7 jours.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notifications_outbox_flush(p_limit INTEGER DEFAULT 50)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
    r RECORD;
    v_n INTEGER := 0;
    v_limit INTEGER := 50;
BEGIN
    IF p_limit IS NOT NULL AND p_limit >= 1 AND p_limit <= 500 THEN
        v_limit := p_limit;
    END IF;

    DELETE FROM public.notifications_outbox
     WHERE (delivered_at IS NOT NULL AND delivered_at < clock_timestamp() - interval '7 days')
        OR (attempts >= 8 AND created_at < clock_timestamp() - interval '7 days');

    FOR r IN
        SELECT id, user_id, type, message, attempts
        FROM public.notifications_outbox
        WHERE delivered_at IS NULL
          AND next_attempt_at <= clock_timestamp()
          AND attempts < 8
        ORDER BY created_at
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            INSERT INTO public.notifications (user_id, type, message)
            VALUES (r.user_id, r.type, r.message);
            UPDATE public.notifications_outbox
               SET delivered_at = clock_timestamp()
             WHERE id = r.id;
            v_n := v_n + 1;
        EXCEPTION WHEN OTHERS THEN
            UPDATE public.notifications_outbox
               SET attempts = attempts + 1,
                   last_error = SQLERRM,
                   next_attempt_at = clock_timestamp()
                       + (interval '30 seconds' * power(2, LEAST(r.attempts, 6)))
             WHERE id = r.id;
        END;
    END LOOP;

    RETURN v_n;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.notifications_outbox_flush(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifications_outbox_flush(INTEGER) TO service_role;
