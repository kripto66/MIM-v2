-- ============================================================
-- MIM - Privilèges de colonnes (audit M7 / P1-6, suite)
--
-- La migration 20260813090000 a donné GRANT UPDATE (table entière)
-- à authenticated. Un compte connecté peut donc modifier TOUTES
-- les colonnes de ses lignes via l'API PostgREST directe
-- (ex. account_type/role sur profiles, montant/statut d'un
-- paiement de salaire, user_id partout).
--
-- Ici : REVOKE du UPDATE de table, puis GRANT UPDATE par colonne
-- (liste blanche) — exactement les colonnes que l'application
-- modifie légitimement avec le token utilisateur :
--   * CRUD générique (server/routes/crud.js, sanitize) ;
--   * profiles.name/phone (auth.js update-profile, token utilisateur) ;
--   * notifications.lu (notifications.js, token utilisateur) ;
--   * locataires.account_uid (liaison du compte locataire à sa
--     fiche, politique "tenant_link_locataire", token utilisateur) ;
--   * locataires.bien_id (dénormalisation faite côté serveur dans
--     le PUT générique, crud.js:747 — le client ne l'envoie pas).
-- Toutes les autres écritures passent par service_role
-- (employes.js, employe.js, tasks.js, moyensPaiement.js,
-- validations.js, locataire.js, unitech.js, upload.js, cron…)
-- et ne sont pas affectées.
--
-- INSERT / SELECT / DELETE restent accordés au niveau table.
-- ============================================================

-- ---------- REVOKE du UPDATE de table ----------

REVOKE UPDATE ON public.profiles FROM authenticated;
REVOKE UPDATE ON public.biens FROM authenticated;
REVOKE UPDATE ON public.logements FROM authenticated;
REVOKE UPDATE ON public.locataires FROM authenticated;
REVOKE UPDATE ON public.paiements FROM authenticated;
REVOKE UPDATE ON public.incidents FROM authenticated;
REVOKE UPDATE ON public.prestataires FROM authenticated;
REVOKE UPDATE ON public.interventions FROM authenticated;
REVOKE UPDATE ON public.notifications FROM authenticated;
REVOKE UPDATE ON public.sessions FROM authenticated;
REVOKE UPDATE ON public.employes FROM authenticated;
REVOKE UPDATE ON public.tasks FROM authenticated;
REVOKE UPDATE ON public.paiements_employes FROM authenticated;
REVOKE UPDATE ON public.employes_biens FROM authenticated;
REVOKE UPDATE ON public.moyens_paiement FROM authenticated;
REVOKE UPDATE ON public.moyens_paiement_employes FROM authenticated;
REVOKE UPDATE ON public.unitech_checkouts FROM authenticated;
REVOKE UPDATE ON public.unitech_webhooks FROM authenticated;
REVOKE UPDATE ON public.subscriptions FROM authenticated;
REVOKE UPDATE ON public.abonnement_paiements FROM authenticated;

-- ---------- GRANT UPDATE par colonne (liste blanche) ----------

GRANT UPDATE (name, phone) ON public.profiles TO authenticated;

GRANT UPDATE (nom, type, adresse, ville, pays, description) ON public.biens TO authenticated;

GRANT UPDATE (bien_id, nom, type, nombre_chambres, adresse, loyer_mensuel, statut, description)
    ON public.logements TO authenticated;

GRANT UPDATE (logement_id, nom, email, phone, date_entree, jour_echeance, statut, bien_id, account_uid)
    ON public.locataires TO authenticated;

GRANT UPDATE (locataire_id, logement_id, montant, mois, statut, date_paiement, methode_paiement, reference)
    ON public.paiements TO authenticated;

GRANT UPDATE (logement_id, titre, description, photo, statut) ON public.incidents TO authenticated;

GRANT UPDATE (nom, specialite, phone, email) ON public.prestataires TO authenticated;

GRANT UPDATE (incident_id, prestataire_id, logement_id, titre, description, statut, date_prevue)
    ON public.interventions TO authenticated;

GRANT UPDATE (lu) ON public.notifications TO authenticated;