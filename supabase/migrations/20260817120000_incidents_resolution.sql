-- Résolution d'incident par un employé (biens affectés)
-- Ajoute les traces de résolution à la table incidents.

ALTER TABLE public.incidents
    ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES public.employes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;