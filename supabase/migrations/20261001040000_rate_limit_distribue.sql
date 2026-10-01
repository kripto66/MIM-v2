-- ============================================================
-- MIM - M-06 : rate limit distribué (persisté en base).
--
-- Les compteurs vivaient dans un Map du process : ils disparaissaient
-- à chaque redémarrage et n'étaient pas partagés entre workers — la
-- protection anti-brute-force était donc réinitialisable à volonté et
-- fragmentée. Les compteurs migrent dans `rate_limit_buckets`, mise à
-- jour par la RPC atomique `rate_limit_bump` (upsert fenêtré) :
--   * partagée par tous les process/instances sur la même base ;
--   * fenêtre glissante par clé (count + window_start) ;
--   * le serveur échoue-open si la base est indisponible (fallback
--     mémoire local) : le limiteur n'est pas le point de dégradation
--     unique — sans base, aucune requête ne passe de toute façon.
--
-- La RPC n'est appelée qu'avec le service_role (REVOKE anon/
-- authenticated) : exposer l'incrémentation à un client permettrait
-- d'épuiser le quota d'une IP tierce (DoS par rate limit).
--
-- MIGRATION STRICTEMENT ADDITIVE.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    count INTEGER NOT NULL DEFAULT 0
);

-- Table interne serveur : aucun accès client.
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_buckets TO service_role;

-- ------------------------------------------------------------------
-- Incrémentation atomique d'un compteur fenêtré. Retourne le nombre
-- d'occurrences dans la fenêtre courante et son début — le middleware
-- compare à son quota et positionne Retry-After.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rate_limit_bump(p_key TEXT, p_window_ms INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_window INTERVAL;
    v_count INTEGER;
    v_start TIMESTAMPTZ;
BEGIN
    IF p_key IS NULL OR length(p_key) < 1 OR length(p_key) > 200 THEN
        RAISE EXCEPTION 'Cle de rate limit invalide.';
    END IF;
    IF p_window_ms IS NULL OR p_window_ms < 1000 OR p_window_ms > 3600000 THEN
        RAISE EXCEPTION 'Fenêtre de rate limit invalide.';
    END IF;

    v_window := make_interval(secs => p_window_ms / 1000.0);

    INSERT INTO public.rate_limit_buckets AS b (key, window_start, count)
    VALUES (p_key, v_now, 1)
    ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN v_now - b.window_start >= v_window THEN 1 ELSE b.count + 1 END,
            window_start = CASE WHEN v_now - b.window_start >= v_window THEN v_now ELSE b.window_start END
    RETURNING b.count, b.window_start
    INTO v_count, v_start;

    RETURN jsonb_build_object('count', v_count, 'window_start', v_start);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_bump(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_bump(TEXT, INTEGER) TO service_role;
