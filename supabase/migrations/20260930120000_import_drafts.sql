-- M-03 : les usernames affichés à l'aperçu d'import doivent être ceux
-- effectivement créés à l'exécution. L'aperçu ne signe aucune écriture
-- métier : le draft est donc persisté ici, identifié par le checksum
-- des fichiers envoyés, et consommé par POST /api/import/execute qui
-- réutilise les noms réservés s'ils sont toujours libres.
--
-- Pas de policy RLS : seule la clé service (serveur) y accède, comme
-- pour import_runs. TTL purgé côté serveur (voir utils/importCsv.js).

CREATE TABLE IF NOT EXISTS public.import_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_checksum TEXT NOT NULL,
  usernames JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT import_drafts_user_checksum_uq UNIQUE (user_id, source_checksum)
);

ALTER TABLE public.import_drafts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS import_drafts_created_at_idx
  ON public.import_drafts (created_at);

REVOKE ALL ON public.import_drafts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.import_drafts TO service_role;
