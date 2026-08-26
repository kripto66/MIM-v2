-- ============================================================
-- MIM - Mot de passe obligatoire pour admin à la première connexion
--
-- Le compte admin@mim.local est créé avec Admin@1976 comme
-- mot de passe initial. Cette migration force le changement
-- au prochain login (mécanisme déjà présent pour locataires
-- et employés via profiles.must_change_password).
-- ============================================================

UPDATE public.profiles
SET must_change_password = true
WHERE email = 'admin@mim.local'
  AND COALESCE(must_change_password, false) = false;
