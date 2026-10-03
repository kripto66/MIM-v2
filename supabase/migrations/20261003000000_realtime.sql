-- Realtime MIM : publication des tables utilisées par les dashboards.
-- La sécurité repose sur les policies RLS existantes : un client ne
-- reçoit que les lignes qu'il est autorisé à lire.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notifications',
    'paiements',
    'paiements_employes',
    'incidents',
    'interventions',
    'tasks',
    'messages',
    'employes',
    'locataires',
    'logements',
    'biens'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
    -- UPDATE/DELETE : payload complet (ancienne/nouvelle ligne).
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
  END LOOP;
END $$;
