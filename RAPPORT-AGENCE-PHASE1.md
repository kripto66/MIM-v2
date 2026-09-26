# RAPPORT D'ANALYSE — PHASE 1 : SYSTÈME AGENCE

> Date : 23 septembre 2026
> Projet : MIM (`C:\xampp\htdocs\MIM2.1\MIM`)
> Périmètre : analyse en **lecture seule** (aucun fichier modifié) — architecture actuelle, dashboard propriétaire, auth, rôles, abonnement, base de données, RLS, composants réutilisables, routes, fichiers à modifier/créer, risques de régression.
> Méthode : 3 explorations parallèles (backend, SQL/RLS, frontend) + vérifications croisées sur le code en place.

---

## 1. Architecture actuelle

- **Serveur unique** Node.js (ESM) / Express 4 dans `MIM\server\` (`server.js` entry, `app.js` montage), port `PORT || 3000`.
- **Chaîne de requête** : headers sécurité → `express.json({limit:'4mb'})` (le webhook Bictorys est monté avant en `express.raw`) → rate limiting (`authRateLimit` 30/10min ; `apiRateLimit` 300/60s) → middlewares d'auth par groupe (`authenticate`, `requireActive`, `requireRole/requireZone`) → handler utilise `serviceClient()` (service_role, contourne RLS) ou `authedClient(token)` (RLS active) → réponse `{ success, data|message|errors }`.
- **Supabase** : 3 clients — anon (auth), service_role (écritures système), authed (token user).
- **Zones statiques** protégées par `express.static` + `authenticatePage` + `requireZone(...)` (`app.js:143-148`) :

| Zone | Rôles autorisés |
|---|---|
| `/PartProprietaires` | `proprietaire`, **`agence`**, `entreprise` |
| `/PartLocataires` | `locataire` |
| `/PartEmployes` | `employe` |
| `/PartAdmin` | `admin`, `ultra_admin` |
| `/PartUltraAdmin` | `ultra_admin` |

- **Frontend** : 7 espaces — `PartPublic`, `PartProprietaires`, `PartLocataires`, `PartEmployes`, `PartAdmin`, `PartUltraAdmin`, **`PartAgence` (dossiers `first_Mode/` et `second_Mode/` déjà créés, vides)**.

> Constat clé : une agence **accède déjà à tout l'espace propriétaire** — le rôle est traité comme un « owner » de première classe, sans différence backend.

---

## 2. Fonctionnement du Dashboard Propriétaire

- **Redirection par rôle** : `PAGE_BY_TYPE.agence → PartProprietaires/dashboard.html` (`routes/auth.js`) — même destination qu'un propriétaire.
- **Pages** : `dashboard.html/js` + `biens.html/js`, `locataires.html/js`, `paiements.html/js`, `employes.html/js`, `abonnements.html/js`, `incidents.html/js`, `prestataires.html/js`, `interventions.html`, `notifications.html/js`, `parametres.html/js`, `import.html/js` + `api.js`, `crud.js`, `style.css`, `onboarding.js`.
- **Données** : pages appellent `/api/crud/<ressource>` (CRUD générique `createCrudRouter`) et `/api/stats/dashboard` (KPIs).
- **Naviation biens** : les biens sont créés via le CRUD générique ; la liste des ressources est **toujours filtrée par `user_id` uniquement**.

> **Constat bloquant pour le MODE 2** : les listes `GET /` de `createCrudRouter` ne filtrent que par `.eq('user_id', userId(req))` (`crud.js:131-136`, vérifié). Aucune route ne supporte de paramètre `?bien_id=` / `property_id` (grep sur `server/routes/` : zéro `req.query.bien`). Pour un « dashboard d'un bien » filtré strictement, **une intervention serveur est indispensable** sur : `createCrudRouter` (biens, logements, locataires, paiements, incidents, prestataires, interventions) + `stats/dashboard` + `paiements-validation` + `moyens-paiement` + `employes`/`tasks` (+ notifications si besoin).

---

## 3. Authentification

- **Cookies** : `mim_token` httpOnly, sameSite lax, secure en prod, maxAge 7 j, **session glissante** (rafraîchi à chaque requête) ; `mim_mfa_pending` 10 min (2FA en cours).
- **`verifyToken`** (appelé par `authenticate`) : jwt → refresh Supabase si `< now+300s` → **revalidation serveur systématique (fail-closed)** : `profiles.account_type` relu en base, statut GoTrue (`banned_until`), suspension du propriétaire **lié en base** pour locataire/employe (jamais un owner_id client), `subscriptionExpiredFor` pour les owners.
- **`signToken`** : payload `{ id, account_type, supabase_token, refresh_token, supabase_expires_at }`.
- **Inscription** : `ALLOWED_TYPES = ['proprietaire', 'agence', 'entreprise']` → **une agence peut déjà s'inscrire librement** et est redirigée vers le dashboard.
- **Sessions** : login/logout journalisés (`sessions`), logout par session ciblée, 2FA TOTP (`/mfa/*`, `verify-2fa`), OAuth Google (PKCE), reset de mot de passe par token haché (`password_reset_tokens`, 30 min).
- **CSRF** : middleware vide (stubs) — protégé par sameSite lax.

---

## 4. Rôles

- **CHECK `profiles.account_type`** : `proprietaire | agence | entreprise | locataire | admin | employe | ultra_admin`.
- **`OWNER_TYPES = ['proprietaire', 'agence', 'entreprise']`** (`middleware/auth.js`) — utilisés par `requireRole(...)` et `requireActive`.
- **Toutes les routes métier** : `requireRole('proprietaire','agence','entreprise')` → aucun middleware à forcer pour l'agence.
- **Trigger `handle_new_user`** : `COALESCE(account_type,'proprietaire')`, réécriture de `role` pour admin/ultra_admin/employe.
- **Différence actuelle agence vs propriétaire** : **aucune côté backend**. Les vraies décisions produit sont frontend (nommage, CTA, branding de l'espace agence) et gouvernance (qui peut créer un compte `agence` : aujourd'hui tout le monde via `/api/auth/register`, comme pour les propriétaires).

---

## 5. Abonnement

- **Source de vérité** : `date_expiration` (`computeStatus`) — le champ `statut` n'est jamais fiable côté front. Cache 2 s, invalidé à chaque changement. **Fail-open volontaire** : pas d'abonnement ou plan inconnu → aucune limite (accès historique conservé).
- **Plans** : table `plans` (code UNIQUE). `PLAN_CODES = ['standard','premium','pro','agence']`. **`agence` = 25 immeubles / 750 logements / 750 locataires** (`bictorys.test.js` vérifie les capacités 25/750/750). Employés & prestataires illimités.
- **En ligne** : **Bictorys uniquement** — `POST /api/webhooks/bictorys` (corps raw, HMAC), **idempotent** via `bictorys_webhooks.fingerprint`, activé **seulement** par statut `succeeded` (`applySucceededPayment` en upsert sur `user_id`), accusé 200 même en erreur interne. `reconcilePendingPayment` = fallback polling.
- **Manuel** : `POST /api/admin/subscriptions/register` (paiement `provider:'manuel'`).
- **`subscriptions` = UNIQUE(user_id)** → 1 ligne par owner, donc une agence a sa propre ligne.
- `GET /api/subscription/me` enrichi (`augmentStatus`), `GET /plans` (catalogue actif), `GET /payments` (historique). Routes montées **sans** `requireActive` (un abonnement expiré doit pouvoir être renouvelé).

---

## 6. Base de données

- **31 migrations** dans `supabase/migrations/` (convention `YYYYMMDDHHMMSS_*.sql`), schéma **unique `public`** (pas de multi-schéma), **isolation par `user_id` + RLS**.
- **Tables métier** : `profiles`, `biens`, `logements`, `locataires`, `paiements`, `incidents`, `prestataires`, `interventions`, `notifications`, `sessions`.
- **Espace employé** : `employes`, `tasks`, `paiements_employes`, `employes_biens`, `moyens_paiement`, `moyens_paiement_employes`.
- **SaaS** : `subscriptions`, `abonnement_paiements`, `plans`, `bictorys_webhooks`, `password_reset_tokens`, `audit_logs`, `system_config`, `announcements`, `platform_events`, `featured_items`.
- **Absents** : aucune table `agences`/`agences_proprietaires`/`versements`/`messages`/`mandats`/`gestionnaires` ; **aucune colonne `agence_id` / `property_id` / `tenant_id`** (le `owner_id` ne survit que dans des tables supprimées). L'union des `CREATE TABLE` ne fait apparaître aucune de ces tables.
- **Pattern existant à imiter** : **`employes_biens`** — table d'association (`user_id` + `employe_id` + `bien_id`, `UNIQUE(employe_id,bien_id)`, RLS owner + `employe_select_own_employes_biens`). C'est le modèle « association + périmètre par EXISTS » le plus proche d'un rattachement agence↔biens.
- **`server/supabase-schema.sql`** = pg_dump **obsolète** (antérieur aux migrations 21→31 : pas de `plans`, `bictorys_webhooks`, `password_reset_tokens`). `schema-tenant.sql`/`schema-admin.sql` = variantes historiques d'accès. Scripts `run-schema.mjs` / `run-tenant-schema.mjs` exécutent le SQL via l'API Management Supabase (ref `wjrlklqzuxyixlhahlie`, `SUPABASE_PAT`).

---

## 7. RLS / Permissions

- **Owner** : `owner_all_<table>` `USING (auth.uid() = user_id) WITH CHECK` sur 14 tables (biens, logements, locataires, paiements, paiements_employes, employes, employes_biens, moyens_paiement, incidents, interventions, prestataires, notifications, sessions, tasks).
- **Employé** : accès par `employes.account_uid = auth.uid()`, `employes_biens` et policies `EXISTS` (`employe_select_biens_affectes`, `employe_select_logements_affectes`, `employe_select_locataires_affectes` via `locataires.bien_id`, incidents/interventions via `logements.bien_id`).
- **Locataire** : `tenant_select_*` par `account_uid` (ou email/username), lien via `tenant_link_locataire`, `tenant_insert_incident`.
- **Admin/ultra_admin** : policies par sous-requête sur `profiles`.
- **GRANT par colonne** (migration `20260817160000`) : `authenticated` = SELECT/INSERT/DELETE sur tout, **UPDATE sur liste blanche uniquement** ; tout le reste passe par `service_role`. Colonnes sensibles (`user_id`, `account_type`, `statut`, `montant`…) non modifiables par l'utilisateur.
- `subscriptions` / `abonnement_paiements` : lecture `auth.uid()=user_id`, **écriture service_role uniquement**. `bictorys_webhooks` / `password_reset_tokens` : aucune policy (service_role seul).

> Pour l'agence il faudra **créer** les policies et grants — rien n'existe pour matérialiser un rattachement agence propiétaire etc.

---

## 8. Composants réutilisables

- **Frontend** : `PartPublic/sidebar.js` (navigation + **logout centralisé** `#logoutBtn`), `dash-fx.js` (compteurs animés `data-count`, `.fx-title`), `mim-errors.js/css` (`MIM.parse`, `MIM.handleAuthError`, `formFieldError`, `.has-error`), `form-utils.js`, `password-strength.js`/`mimPasswordRuleMessage`, `style.css` (espace propriétaire, partagé par toutes les pages avec sidebar).
- **Backend** : `createCrudRouter` (validation par ressource + plafonds abonnement + comptes auto), `employes_biens` (pattern association), `stats/dashboard` (KPIs), `getNow()` (simulation temporelle), `gitAutoBackup`, `notifications` (création/lecture), `moyensPaiement`, `importCsv` (templates + exécution), `paiementMethodes.js` (`sanitizeMoyenBody`).
- **Pages de référence** : `employes.html/js` (création de comptes subordonnés à rebondir pour les propriétaires gérés), `abonnements.html/js` (état + plans + checkout), `LocaDash.css`/`employe.css` (refontes récentes à imiter pour le style agence).

---

## 9. Routes existantes (inventaire pertinent)

| Route | Middlewares | Note |
|---|---|---|
| `/api/auth/*` (register, login, me, change-password, verify-2fa, mfa/*, forgot, reset-password, update-profile, logout) | `authRateLimit` | SANS `requireActive` (compte suspendu/expiré peut se reconnecter, renouveler, changer mdp) |
| `/api/stats` (`/dashboard`) | `authenticate`, `requireActive`, `requireRole(owners)` | KPIs dashboard |
| `/api/crud/<biens, logements, locataires, paiements, incidents, prestataires, interventions>` | idem + `ownerOnly` | Moteur CRUD générique |
| `/api/employes`, `/api/tasks`, `/api/paiements-validation`, `/api/moyens-paiement`, `/api/import`, `/api/onboarding` | idem | Gestion subordonnés / validation / imports |
| `/api/notifications` | `authenticate`, `requireActive` | GET / PUT / DELETE |
| `/api/subscription` (`/me`, `/plans`, `/checkout`, `/checkout/refresh`, `/payments`) | `authenticate`, `requireRole(owners)`, **SANS `requireActive`** | Auto-service abonnement |
| `/api/employe/*` | `authenticate`, `requireActive`, `requireRole('employe')` | Espace employé connecté (modèle de « zone gérée » à copier) |
| `/api/locataire/*` | idem `('locataire')` | Espace locataire |
| `/api/admin/*`, `/api/ultra-admin/*` | rôles VIP | Console / SaaS |
| `/api/webhooks/bictorys` | — (raw body) | Webhook paiement |

---

## 10. Fichiers à modifier (liste consolidée — détails en PHASE 2)

**Backend :**
- `server/routes/crud.js` : ajouter le filtrage de liste par `bien_id` (et éventuellement `agence_id`) sur les GET de `createCrudRouter`, uniquement quand un contexte bien/agence est demandé.
- `server/routes/stats.js` (`/dashboard`), `server/routes/validations.js` (`paiements-validation`/`en-attente`), `server/routes/employes.js` (+ `tasks`), `server/routes/moyensPaiement.js`, éventuellement `notifications.js` : mêmes filtres de périmètre.
- `server/routes/auth.js` : `PAGE_BY_TYPE.agence` → `PartAgence/first_Mode/` une fois le MODE 1 construit.
- `server/app.js` : zone statique `/PartAgence` (`requireZone(owners)` ou dédiée) + route `/api/agence`.
- `server/utils/*` : plans/saasStatus déjà OK (plan `agence` présent).

**Base de données :**
- `supabase/migrations/<YYYYMMDDHHMMSS>_agence.sql` : tables agence + association + policies + grants + seed.
- `server/supabase-schema.sql` : **régénérer** après les migrations (dump actuel obsolète).

**Frontend :**
- `PartPublic/connexion.html` + `index.html` : CTA « Espace Agence » (branding).
- `PartProprietaires/dashboard.html/js` : ne **pas** casser — si MODE 2 réutilise ces fichiers, les rendre paramétrables par le contexte agence/bien (sinon tout copier dans `PartAgence/second_Mode/`).
- `PartAgence/first_Mode/*` : espace global agence.

---

## 11. Fichiers à créer

- **Backend** : `server/routes/agence.js` (dashboard global : portefeuille biens/propriétaires gérés, stats agrégées, versements, messages, abonnement) + éventuels routeurs dédiés (versements/messages si tables nouvelles).
- **Frontend** :
  - `PartAgence/first_Mode/` : `index.html`, `dashboard.html/js`, `style.css`, etc. (dashboard global agence).
  - `PartAgence/second_Mode/` : `index.html` + pages du dashboard d'un bien (copies paramétrées du dashboard propriétaire, avec bouton « ← Retour au Dashboard Agence »).
- **Base de données** : migration `agence.sql` (+ tables `versements`, `messages` si retenues).
- **Tests** : nouvelles suites dans `server/scripts/tests/` (agence : inscription, quotas plan agence, isolation stricte, MODE 2 pour chaque ressource).

---

## 12. Risques de régression

1. **MODE 2 = intervention serveur obligatoire** : sans filtre `?bien_id=` serveur, le « dashboard du bien » exposerait toutes les données du compte. Toute modification de `crud.js` impacte les 7 routes propriétaire → rejouer les suites (576 tests automatisés + sujets isolation/relations) et le parcours navigateur propriétaire complet.
2. **Option « colonne `agence_id` sur chaque table » (invasion)** : casserait le GRANT colonne-par-colonne de la migration `20260817160000` et obligerait à réécrire ~15 policies → **préférer des tables d'association** (pattern `employes_biens`).
3. **Isolation** : ne **jamais** se fier à un `property_id`/`agence_id` fourni par le frontend — suivre le pattern employé : périmètre **calculé en base** (policies EXISTS + revalidation serveur).
4. **Régénération du schéma de référence** après migrations (dump actuel antérieur à plans/bictorys/password_reset_tokens).
5. **Abonnement** : une agence est un owner ordinaire → `subscriptions.user_id` = compte agence ; la bascule « chaque propriétaire géré a son propre abonnement » est un changement métier à arbitrer (probablement : abonnement de l'agence couvre les biens gérés).
6. **Inscription libre en `agence`** : aujourd'hui n'importe qui peut s'inscrire comme agence (gouvernance à trancher, hors technique).
7. **MODE 2 via réutilisation** : les pages propriétaire utilisent des URLs tactiques (`biens.html`, `locataires.html`…) sans paramètre de contexte ; sans adaptation elles ne reflèteraient pas le bien courant. Prévoir la propagation du contexte (`?bien=` / sessionStorage) ou la copie paramétrée.
8. **`messages` / `versements` inexistants** : fonctionnalités entièrement à créer (tables + policies + routes + UI) — à phaser et évaluer.

---

## Décisions structurantes à trancher en PHASE 2

1. **Modèle de possession des biens gérés par une agence** :
   - *(a) Agence-propriétaire (état actuel)* : l'agence possède directement biens/logements/locataires. Simple et déjà fonctionnel, mais un propriétaire physique ne « voit » pas ses biens et le partage de compte est problématique.
   - *(b) Mandat (recommandé)* : le propriétaire reste `user_id` des lignes métier ; l'agence est rattachée via des tables d'association (`agences`, `agences_proprietaires`, `agences_biens`) + policies `EXISTS` + routes serveur qui vérifient le rattachement. Plus lourd mais permet portefeuille multi-propriétaires, versements et isolation stricte.
2. **MODE 2** : réutiliser physiquement les fichiers du dashboard propriétaire (avec contexte) vs. copies paramétrées dans `PartAgence/second_Mode/`.
3. **Versements / messages** : créer les tables dès la PHASE 3 ou les phaser après le socle agence.
4. **Gouvernance** : qui crée les comptes « propriétaire géré » (l'agence via compte auto comme pour les employés, ou le propriétaire lui-même) ?

---

## Synthèse

- Le **rôle « agence » est déjà pleinement supporté** côté backend (inscription, routes, quota plan 25/750/750, RLS owner, tests E2E existants).
- Ce qui manque : **la matérialisation de l'espace agence** (frontend `PartAgence`, MODE 1 + MODE 2), **le rattachement propriétaire↔biens↔agence** (DB/RLS si modèle mandat), **le filtrage serveur par bien** (requis pour le MODE 2), **versements et messages** (à créer), et les **décisions produit** ci-dessus.
- Aucun fichier n'a été modifié pendant cette phase.