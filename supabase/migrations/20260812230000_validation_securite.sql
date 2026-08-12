-- ============================================================
-- MIM - Validation, sécurité et nouveaux besoins
--
--  * Logements : type (appartement / chambre), nombre de
--    chambres et adresse propres au logement.
--  * Locataires : jour d'échéance du paiement (jour_echeance).
--  * Incidents : photo facultative + statut 'intervention'
--    (signalé -> pris en charge -> intervention -> résolu).
--  * RLS : le locataire peut signaler un incident sur SON logement.
-- ============================================================

-- ============================================================
-- LOGEMENTS
-- ============================================================
ALTER TABLE public.logements ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE public.logements ADD COLUMN IF NOT EXISTS nombre_chambres INT;
ALTER TABLE public.logements ADD COLUMN IF NOT EXISTS adresse TEXT;

DO $$
BEGIN
    ALTER TABLE public.logements DROP CONSTRAINT IF EXISTS logements_type_check;
    ALTER TABLE public.logements ADD CONSTRAINT logements_type_check
        CHECK (type IS NULL OR type IN ('appartement', 'chambre'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- LOCATAIRES : jour d'échéance du paiement
-- ============================================================
ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS jour_echeance INT DEFAULT 1;

-- ============================================================
-- INCIDENTS : photo facultative + statut 'intervention'
-- ============================================================
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS photo TEXT;

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_statut_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_statut_check
    CHECK (statut IN ('nouveau', 'en_cours', 'intervention', 'resolu'));

-- ============================================================
-- RLS : le locataire signale un incident sur son logement
-- (défense en profondeur, les routes vérifient aussi côté serveur)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'incidents'
          AND policyname = 'tenant_insert_incident'
    ) THEN
        CREATE POLICY "tenant_insert_incident" ON public.incidents
            FOR INSERT WITH CHECK (
                EXISTS (
                    SELECT 1
                    FROM public.locataires l
                    JOIN public.logements lg ON lg.id = l.logement_id
                    WHERE l.account_uid = auth.uid()
                      AND lg.id = incidents.logement_id
                      AND lg.user_id = incidents.user_id
                )
            );
    END IF;
END $$;
