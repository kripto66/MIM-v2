# RAPPORT D'AUDIT COMPLET — MIM (MyImmoManagement)

Date : 17/08/2026
Périmètre : tout le projet `C:\xampp\htdocs\MIM2.1\MIM` (frontend ×4 zones, backend Express, Supabase local, migrations SQL, scripts, tests).

## Méthodologie

1. **Suite de tests bout-en-bout réelle** (`server/scripts/tests/run.js`) : **576/576 tests PASS** sur 17 suites (auth, crud, isolation, relations, stats, sécurité, concurrence, final, admin, abonnement, unitech, déclarations, import, locataires, salaires, vierge, simplif).
2. **Tests live** sur le serveur de production locale (:3000) : health, protection des pages par zone, inscription → connexion → me → stats → onboarding → logout, cron loyers, sauvegarde git automatique.
3. **Analyse statique exhaustive** des 4 zones frontend croisée avec les 16 routes backend (endpoints appelés vs définis, champs envoyés vs attendus, IDs HTML vs event listeners, liens et redirections).
4. **Vérification des migrations SQL** dans l'ordre + état réel de la base (psql, probes d'INSERT service_role, ACL des séquences).
5. **Vérification manuelle de chaque bug critique signalé** (lecture du code + preuve).

## État de l'environnement

| Composant | État |
|---|---|
| API Node (:3000) | ✅ UP |
| Supabase local (Docker) | ✅ 10/11 conteneurs healthy |
| `supabase_vector_MIM` (analytics Vector) | 🔴 **Restart loop** (Connection refused sur socket Docker — non bloquant pour l'app) |
| Base PostgreSQL (RLS, 20 tables) | ✅ UP, schéma conforme |
| Git (master) | ✅ propre, sauvegarde auto opérationnelle |
| Tests | ✅ 576/576 |

---

## ✅ CE QUI FONCTIONNE (vérifié par tests + live)

### Authentification & comptes
- Inscription propriétaire (compte + profil auto), connexion par email/username, déconnexion, `/auth/me`.
- Session glissante 7 jours + cookie `httpOnly` + **revalidation serveur à CHAQUE requête** (rôle depuis `profiles`, statut ban GoTrue, suspension du propriétaire pour locataire/employé, expiration d'abonnement) — fail-closed.
- Mot de passe oublié → lien par email (Mailpit local), reset avec token.
- Changement de mot de passe forcé (`must_change_password`), politique de mot de passe miroir frontend/backend.
- Changement de username (locataire/employé) avec unicité vérifiée + mise à jour email `@mim.local`.
- 2FA TOTP : activation, vérification, désactivation (testée 47/47 dans la suite auth).
- OAuth Google configuré (secrets dans `.env`, gitignoré).
- Suspension/réactivation de comptes par l'admin ; suspension propagée aux locataires/employés du propriétaire.
- Rate limiting API + auth (429 testé).
- Protection des pages par zone : sans session → redirect connexion ; rôle inadapté → redirect (vérifié en live).

### Espace propriétaire
- CRUD complet : biens, logements, locataires, paiements, incidents, prestataires, interventions (sanitization, validation, références croisées appartenant au propriétaire, un seul locataire actif par logement).
- Dashboard : compteurs réels (biens, logements, loyers attendus/encaissés/retards, incidents, interventions, salaires en attente, paiements à valider) + abonnement.
- Formulaire unique locataire : logement créé à la volée (occupé), compte auto (`username` généré, mot de passe initial `1234`, `must_change_password`), échéance initiale, **compensation totale en cas d'échec intermédiaire**.
- Formulaire employé : mode auto (username généré, mot de passe `1234`) ou manuel, affectation à N biens (remplacement, bien étranger refusé), vérification serveur + RLS.
- Paiements : création, édition, statuts, déclarations locataires à valider/refuser (motifs), historique.
- Salaires : déclaration de versement (`attente` → confirmation employé `paye`/`non_recu`), paiement direct `paye` (compat UnitechPay), historique, moyens de réception des employés (vue actifs uniquement).
- Import CSV : modèles (BOM UTF-8, `;`, colonnes sensibles), aperçu avec erreurs/doublons/usernames générés, exécution avec **progression réelle** (`setImmediate`, compensation par ligne, rapport final téléchargeable), politiques `ignore`/`abort`/`update`, isolation par propriétaire.
- Onboarding première connexion (modal importer/configurer).
- Notifications (lecture, tout marquer lu), photo de profil (upload/remplacement/suppression, bucket `avatars`), sauvegarde git auto (non bloquante, sérialisée).
- Paramètres, prestataires, interventions (statuts, planification).

### Espace locataire
- Dashboard réel : loyer, statut du paiement en cours, prochain paiement, incidents ouverts, notifications.
- Paiement : moyens du propriétaire affichés (copier le numéro), déclaration de paiement (`en_validation`), états payé/attente/retard/refusé/à confirmer affichés.
- Incident : signalement avec photo compressée (canvas), déduit de la fiche (jamais un id client).
- Logement, notifications, profil (avatar, username, mot de passe).

### Espace employé
- Backend complet et testé : dashboard (tâches, incidents, interventions, priorités, notifications), incidents de SES biens + résolution (`resolved_by`/`resolved_at` serveur + notification propriétaire), salaires (confirmer/non reçus avec motif), moyens de réception CRUD, profil, photo.
- Isolation réelle par bien affecté (tests : bien étranger → 403).

### Admin
- Compteurs réels (8), graphique revenus 12 mois, activité récente, listes (locataires, biens, paiements, incidents).
- Gestion des propriétaires : suspension/réactivation.
- Abonnements : liste, encaissement via UnitechPay (plan/montant/opérateur/mode Orange), vérification webhook.

### Paiement mobile (UnitechPay)
- Initiation checkout (loyers, salaires, abonnements), webhook HMAC-SHA256 (corps brut), déduplication par fingerprint, mise à jour conditionnelle, mode test + mock pour les tests (83/83).
- Abonnement : expiration calculée en base, blocage connexion + requêtes si expiré, cache invalidé.

### Scripts / infra
- Cron `checkLoyers` : **testé en live** — échéances du mois créées, échéances dépassées → `retard` + notification locataire.
- Git backup auto : **testé en live** — commit + push à chaque écriture/connexion/déconnexion.
- `npm run dev`/`start` OK, Node 24, dépendances installées.

---

## ❌ CE QUI NE FONCTIONNE PAS (bugs confirmés)

### 🔴 CRITIQUES (à corriger en priorité)

**C1 — PartEmployes : 100 % de la zone employé est morte (double préfixe `/api/api`)**
`PartEmployes/employe.js:5` : `API` se termine par `"/api"`, et toutes les constantes `E.*` (lignes 8-22) commencent par `"/api/..."`. Chaque `fetch(API + p)` produit `http://localhost:3000/api/api/employe/me` → **404 sur tout** : dashboard, tâches, incidents, salaires, moyens de paiement, profil, avatar. Seul le logout redirige malgré l'erreur. `window.MIM_API_BASE` (employe.js:2) n'est défini nulle part.
Fix : retirer le `/api` de la ligne 5 (les autres zones le font).

**C2 — Page « Paiements » du propriétaire : inopérante (crash JavaScript au chargement)**
`PartProprietaires/paiements.html:581` configure `addBtnEl: "addPaiementBtn"`, mais **aucun élément** avec cet id n'existe dans le HTML. `crud.js:25` fait `document.getElementById(config.addBtnEl).addEventListener(...)` → `TypeError: null` → **tout le script inline après la ligne 644 ne s'exécute jamais** : validation/refus des paiements, moyens de réception du propriétaire, onglet « Payer mes employés », chargement initial des données. La page affiche des onglets vides (« Locataire inconnu » partout).

**C3 — `escapeAttr` n'existe nulle part (ReferenceError)**
`paiements.html:686` (lien de paiement) et `:852` (`data-emp-nom`) appellent `escapeAttr()`, défini nulle part dans le projet (seulement dans `parametres.html:358`, local). Bug actuellement masqué par C2, mais il bloquera la page dès que C2 sera corrigé.

**C4 — Flux `a_confirmer` sans issue : un locataire est bloqué pour toujours**
Le webhook UnitechPay passe le paiement loyer en `a_confirmer` (routes/unitech.js:502). Le backend expose `POST /locataire/paiements/:id/confirmer` (locataire.js:127) pour le confirmer, mais **aucun frontend ne l'appelle** :
- `LocaDash.js:246-281` : pour `a_confirmer`, affiche le bouton « Payer mon loyer » → déclaration → refusée par le backend (`locataire.js:255` : seuls `attente/retard/refuse` déclarables).
- La notification « confirmez-le depuis votre espace » n'a aucun bouton correspondant.
Le paiement reste `a_confirmer` indéfiniment ; il ne peut ni être validé, ni re-déclaré.

### 🟠 MOYENNES

**M1 — 2FA + changement de mot de passe obligatoire : contourné pour locataire/employé**
`2fa.html:118-122` redirige vers `"../" + data.redirect` sans traiter `mustChangePassword` renvoyé par `verify-2fa`, et la branche `mfaRequired` du login (auth.js:388-393) ne transmet pas le drapeau. Un locataire/employé avec 2FA activée ne passe jamais par `change-password.html` ; `must_change_password` reste `true`.

**M2 — `change-password.html` sans champ `current_password`**
Le backend (auth.js:743-745) exige `current_password` quand `must_change_password` est faux, mais la page n'a que `password`/`password_confirm`. Un utilisateur qui rouvre la page hors flux forcé est bloqué (400) sans champ pour saisir le mot de passe actuel.

**M3 — Édition d'un paiement : la méthode est écrasée à « Wave »**
`paiements.html:613-615` : `onOpenEdit` force `methode_paiement = "wave"` à chaque ouverture → toute édition enregistre silencieusement Wave à la place de la méthode réelle (virement, Orange Money, espèces…). Perte de donnée silencieuse.

**M4 — Édition d'un locataire sans logement : impossible à enregistrer**
`locataires.html:454-455` : `logement_id` mis à `"__new__"` mais `logementFields` masqué et `onLogementSelectChange()` jamais rappelé → la validation exige `lg_nom` + `loyer_mensuel` (invisibles) → blocage de l'édition.

**M5 — Tâches employé : clés `titre`/`statut` (backend) vs `title`/`status` (frontend)**
Backend `/employe/tasks` renvoie `titre`/`statut` ; `employe.js:430,466,476` lit `title`/`status` → titres « tasks », filtres « À faire / En cours / Terminées » toujours vides, badge de comptage erroné. Même problème pour les interventions (`titre` vs `title`, employe.js:466). (Masqué par C1.)

**M6 — `locataires.bien_id` non dénormalisé dans le POST simple**
`crud.js:618-685` (POST générique `/api/locataires`) ne déduit pas `bien_id` du logement (contrairement au POST avec compte, :550, et au PUT, :747) → fiche avec `bien_id = NULL`, invisible pour la politique RLS employé par bien (défense en profondeur affaiblie).

**M7 — Politiques RLS UPDATE sans `WITH CHECK`**
(migrations init + fixes) : un utilisateur peut modifier toutes les colonnes de ses propres lignes via l'API REST directe (ex. `account_type` sur `profiles`, `montant`/`statut` sur `paiements`). Protégé côté middleware serveur, mais exposition PostgREST directe réelle.

### 🟡 MINEURES

| # | Fichier:ligne | Description |
|---|---|---|
| m1 | `dashboard.js:35-39` | `STATUS.paiement` n'a pas `en_validation`/`refuse` → libellés bruts en anglais dans « Paiements récents » |
| m2 | `admin.js:722-724` | Lit `d.qr_code` jamais renvoyé par `/admin/subscriptions/register` → bloc QR mort (le lien fonctionne) |
| m3 | `incidents.html:170` | `maxlength=200` sur le titre vs 120 côté serveur → erreur serveur pour 121-200 caractères |
| m4 | `LocaDash.js:106` | `loadTenantIdentity()` cible `profileName`/`profilePhone` (inexistants ; les vrais : `profileNameInput`/`profilePhoneInput`) — code mort silencieux |
| m5 | `employes.html:641` | Date de salaire affichée en ISO brut (`2026-08-17`) au lieu d'une date lisible |
| m6 | `form-utils.js:77-99` | `checkUsernameAvailability` jamais appelé (code mort) |
| m7 | `paiements.html:609-612` | `onOpenAdd` force `methode_paiement = "wave"` (écrase la saisie utilisateur) |
| m8 | `connexion.html:107` | `password-strength.js` chargé inutilement sur la page connexion |
| m9 | `change-password.html:114` | `next` par défaut → PartLocataires : un employé ouvrant la page directement serait redirigé vers la mauvaise zone |
| m10 | `change-password.html:221-237` | `update-username` exécuté AVANT `change-password` → état partiel si le mot de passe échoue |
| m11 | `.has-error` | Classe ajoutée par form-utils.js mais aucun CSS ne la définit (inerte) |
| m12 | `supabase-schema.sql` | Schéma de référence obsolète vs migrations (manque `employes_biens`, `avatar_url`, `bien_id`, `unitech_*`, statuts…) — trompeur pour la doc |
| m13 | `config.toml` | `[studio] api_url = http://127.0.0.1` sans port 64321 |
| m14 | Migration `14180000` | Séquences `unitech_checkouts_id_seq`/`unitech_webhooks_id_seq` non accordées explicitement — fonctionne en local (privilèges par défaut, vérifié en base : `service_role=w`), **fragile pour un déploiement cloud** |
| m15 | `auth.js:308-342` | Login distingue `ACCOUNT_NOT_FOUND` de `INVALID_CREDENTIALS` → énumération de comptes possible |
| m16 | `auth.js:970` | `reset-password` donne priorité à la session du cookie sur les jetons du lien → un utilisateur connecté qui clique un lien de reset pour un autre compte modifie SON mot de passe |
| m17 | `bcryptjs` | Déclaré dans `server/package.json` mais jamais utilisé (dépendance morte) |
| m18 | `supabase_vector_MIM` | Conteneur en boucle de restart (logique d'analytics, non bloquant) |
| m19 | `LocaDash.js:57` | Clé `intervention` dans `INCIDENT_LABEL` jamais produite (code mort) |
| m20 | Admin labels | `a_confirmer`/`en_validation`/`refuse`/`expire` affichés bruts dans les listes admin |
| m21 | Notifications tenant | `email = ""` masqué pour les locataires → « Compte non rattaché » avec email vide (cosmétique) |

---

## 💥 DOMMAGES CRITIQUES (résumé exécutif)

1. **Zone employés entièrement hors service** (C1) — double `/api/api`, régression probable d'un refactor des chemins. Impact : aucun employé ne peut utiliser l'application.
2. **Page Paiements propriétaire hors service** (C2+C3) — la page la plus stratégique (encaissements + salaires) affiche des listes vides et aucun bouton ne fonctionne.
3. **Paiements mobile bloqués pour les locataires** (C4) — tout paiement loyer reçu via UnitechPay reste « à confirmer » sans issue.
4. **Backend : 576/576 tests PASS** — aucune défaillance serveur détectée. Les dégâts sont concentrés dans le **frontend**.
5. **Infra** : conteneur analytics Vector en restart loop (non bloquant mais à nettoyer).
6. **Sécurité (mineure à moyenne)** : RLS UPDATE sans `WITH CHECK` (accès REST direct), énumération de comptes au login, priorité session sur token de reset.

---

## 🔧 MODIFICATIONS NÉCESSAIRES (par priorité)

### P0 — Urgent (bloquant)
1. `PartEmployes/employe.js:5` : retirer `/api` de la constante `API` (aligner sur les autres zones).
2. `PartProprietaires/paiements.html` : ajouter l'élément `id="addPaiementBtn"` (ou retirer `addBtnEl` de la config) ; corriger `escapeAttr` (définir une fonction partagée dans api.js/form-utils.js).
3. `PartLocataires` : ajouter un bouton « Confirmer le paiement » pour le statut `a_confirmer` (LocaDash + paiements.html) appelant `POST /locataire/paiements/:id/confirmer`.

### P1 — Important
4. `2fa.html` + branche `mfaRequired` du login : transmettre et traiter `mustChangePassword` (redirection vers change-password.html avec `next`).
5. `change-password.html` : ajouter le champ `current_password` (affiché quand le changement n'est pas forcé).
6. `paiements.html:613-615` : ne plus forcer `methode_paiement = "wave"` à l'édition (préserver la valeur existante).
7. `locataires.html:454-455` : afficher les champs du nouveau logement en mode `__new__`.
8. `employe.js` : aligner `title`/`status` → `titre`/`statut` (tâches + interventions).
9. `crud.js` POST simple : dénormaliser `locataires.bien_id` depuis le logement.
10. Migrations : ajouter `WITH CHECK` aux politiques UPDATE sensibles ; GRANT explicite des séquences unitech (portabilité cloud).

### P2 — Qualité
11. Compléter `STATUS.paiement` (dashboard) avec `en_validation`/`refuse`/`a_confirmer`.
12. Harmoniser `maxlength` du titre incident (120), date des salaires, labels admin, retirer les codes morts (qr_code, checkUsernameAvailability, loadTenantIdentity, bcryptjs, `.has-error`).
13. Mettre à jour `supabase-schema.sql` et `config.toml` (port Studio), supprimer/relancer le conteneur Vector, désactiver `UNITECH_TEST_MODE` en production.
14. Énumération de comptes au login : renvoyer la même réponse pour compte inexistant et mauvais identifiants (optionnel).
15. `reset-password` : faire prévaloir le token du lien sur la session cookie (sécurité).

---

## Vérification finale

- **576/576 tests** ✅ — toutes les suites repassées après correction doivent rester vertes.
- Le backend est **excellent** (conception défensive : mises à jour conditionnelles, compensation, RLS, fail-closed). Les bugs sont frontend + quelques points de sécurité/portabilité.