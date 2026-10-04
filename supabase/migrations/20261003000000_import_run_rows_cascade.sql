-- =====================================================================
-- Audit BDD M6 : import_run_rows.run_id bloquait la suppression de compte.
--
-- Constat :
--   import_runs.user_id       -> auth.users(id)  ON DELETE CASCADE  (OK)
--   import_run_rows.run_id    -> import_runs(id) ON DELETE RESTRICT  (bug)
--
-- Supprimer un compte échouait donc DES QU'IL avait lancé au moins un
-- import : la cascade s'arrêtait sur les lignes filles RESTRICT, le
-- compte restait en place et l'invariant H-19 « aucun compte orphelin »
-- était violé (deleteAuthAccount renvoie ok:false, le compte survit).
--
-- Correction : les lignes détaillées d'un import n'ont aucun sens sans
-- leur run (table fermée : politique closed_deny_all, service_role
-- uniquement, lecture réservée au suivi de progression) — elles suivent
-- leur parent. Aucune donnée utile n'est perdue : les lignes appartiennent
-- au run, et le run appartient au compte supprimé.
--
-- Idempotent : DROP CONSTRAINT IF EXISTS avant recréation.
-- =====================================================================

ALTER TABLE public.import_run_rows
  DROP CONSTRAINT IF EXISTS import_run_rows_run_id_fkey;

ALTER TABLE public.import_run_rows
  ADD CONSTRAINT import_run_rows_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE CASCADE;
