-- ============================================================
-- MIM - PayDunya : robustesse et audit
--
-- 1. Journal des IPN : horodatage du traitement + message d'erreur
--    (audit/debugging : distinguer « jamais reçu », « reçu mais en
--    attente de re-traitement » et « traité »).
--
-- 2. Index uniques PARTIELS sur les sessions d'encaissement en
--    attente : deux initiations simultanées pour la même cible
--    (paiement de loyer / paiement de salaire) ne peuvent plus créer
--    deux factures 'pending'. La course est arbitrée par PostgreSQL ;
--    l'application rattrape le perdant (code 23505 -> reprise).
--    Les sessions terminées (completed/cancelled/failed) ne sont pas
--    concernées : une nouvelle tentative après échec reste possible.
-- ============================================================

ALTER TABLE public.paydunya_webhooks
    ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS paydunya_invoices_pending_paiement_uidx
    ON public.paydunya_invoices (source, paiement_id)
    WHERE status = 'pending' AND paiement_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS paydunya_invoices_pending_paiement_employe_uidx
    ON public.paydunya_invoices (source, paiement_employe_id)
    WHERE status = 'pending' AND paiement_employe_id IS NOT NULL;
