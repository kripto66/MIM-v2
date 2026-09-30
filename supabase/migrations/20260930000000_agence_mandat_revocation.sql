-- ============================================================
-- MIM - H-18 : traçabilité de la révocation d'un mandat agence
--
-- Avant cette migration, aucune voie applicative ne pouvait passer
-- une liaison agences_proprietaires à 'inactif' : un mandat ne
-- pouvait être révoqué qu'en intervenant directement en base, et
-- l'agence conservait l'accès à tous les biens et données gérés.
--
-- Les endpoints de révocation / réactivation (côté agence et côté
-- propriétaire) écrivent désormais sur la ligne de liaison :
--   * revoque_par : compte à l'origine de la dernière suspension —
--     seul LE MÊME compte peut réactiver (gouvernance) ;
--   * motif       : raison saisie (obligatoire) ;
--   * updated_at  : horodatage de la transition.
-- Chaque transition est aussi journalisée dans audit_logs.
-- Migration strictement additive : 3 colonnes nullable.
-- ============================================================

ALTER TABLE public.agences_proprietaires
    ADD COLUMN IF NOT EXISTS revoque_par UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS motif TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.agences_proprietaires.revoque_par IS
    'Compte (agence ou proprietaire) a l''origine de la derniere suspension : seul ce compte peut reactiver.';
COMMENT ON COLUMN public.agences_proprietaires.motif IS
    'Motif saisi lors de la derniere transition de statut (obligatoire).';
COMMENT ON COLUMN public.agences_proprietaires.updated_at IS
    'Horodatage de la derniere transition de statut.';
