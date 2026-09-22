# RAPPORT D'AUDIT COMPLET — MIM (mise à jour du 22/09/2026)

Date : 22/09/2026
Périmètre : tout le projet `C:\xampp\htdocs\MIM2.1\MIM`.
Référence : l'audit précédent (`RAPPORT-AUDIT.md`, 17/08/2026) reste la base ; ce
rapport **vérifie chaque point de l'audit précédent** (corrigé ?), analyse les
**évolutions depuis** (Bictorys, plans, renouvellement en ligne, plafonds serveur,
suppression de PayDunya/Cinetpay/Unitech, retrait du CSRF) et liste les **nouvelles
anomalies**.

## Méthodologie & limites

- **Limite majeure** : le serveur Node (:3000), Docker et Supabase local sont tous
  **arrêtés** au moment de l'audit (Docker Desktop non lancé, 0 conteneur). La suite
  de tests bout-en-bout (20 suites, dont les nouvelles `bictorys`, `csrf-validation`,
  `complet`, `matrice`) **n'a pas pu être rejouée** — elle exige Supabase local. Cet
  audit est donc **statique et approfondi** (lecture croisée backend/frontend/migrations).
- Reconstitution de la matrice complète routes × appels frontend sur les 6 zones
  (PartPublic, PartProprietaires, PartLocataires, PartEmployes, PartAdmin, PartUltraAdmin),
  des objets `getElementById`/sélecteurs vs HTML, et revue des 30 migrations SQL.

## État de l'environnement

| Composant | État |
|---|---|
| API Node (:3000) | 🔴 DOWN au moment de l'audit |
| Docker / Supabase local | 🔴 DOWN (Docker Desktop non démarré) |
| Tests | ⚪ non rejoués (environnement indisponible) |
| Git | 🟠 travail en cours : 17 fichiers modifiés + 9 fichiers untracked non commités (routes bictorys, plans.js, migrations) |
| `.env` / `.gitignore` | ✅ secrets gitignorés (`.env*`, `server/.env`) ; variables claires |

---

## ✅ Ce qui a été CORRIGÉ depuis l'audit du 17/08 (vérifié dans le code)

Tous les bugs bloquants de l'audit précédent ont été traités :

| Ancien | Fichier:ligne de référence | Statut vérifié |
|---|---|---|
| **C1** double `/api/api` employé | `PartEmployes/employe.js:3-24` | ✅ **Corrigé** — base `/api` + chemins `E.*` sans préfixe |
| **C2** `addPaiementBtn` absent | `paiements.html:117` | ✅ **Corrigé** — l'élément existe |
| **C3** `escapeAttr` inexistant | `paiements.html:421` | ✅ **Corrigé** — fonction locale définie |
| **C4** flux `a_confirmer` sans issue | — | ✅ **Asséché** : `a_confirmer` n'est **plus produit par aucun code** (Unitech/PayDunya/Cinetpay supprimés, voir ci-dessous). Endpoint `/locataire/paiements/:id/confirmer` (locataire.js:125) conservé ; lignes historiques en attente toujours non confirmables depuis l'UI (mineur) |
| **M1** 2FA + `must_change_password` | `2fa.js:41-46` + `auth.js:184-185,323,439-440` | ✅ **Corrigé** — renvoyé par `finalizeLogin`, redirige vers change-password |
| **M2** champ `current_password` manquant | `PartPublic/change-password.js:17,97,134-135` | ✅ **Corrigé** (affichage conditionnel) |
| **M3** édition paiement écrasée à Wave | `paiements.html` (recherche) | ✅ **Corrigé** — plus aucun forçage dans `onOpenEdit` (reste dans `onOpenAdd` en pré-remplissage, acceptable) |
| **M4** édition locataire `__new__` bloquée | `locataires.html:478-487,512-513` | ✅ **Corrigé** — `onLogementSelectChange()` appelé après réaffectation |
| **M5** tasks `title/status` vs `titre/statut` | `employe.js:430,433,468-469` | ✅ **Corrigé** en défensif — fallbacks `titre||title||name`, `statut??status` |
| **M6** `locataires.bien_id` non dénormalisé | `crud.js:777-786` | ✅ **Corrigé** (POST générique déduit `bien_id` du logement) |
| **M7** RLS UPDATE sans `WITH CHECK` | `20260817150000_rls_with_check.sql` | ✅ **Corrigé** — migration dédiée, 14+ politiques |
| **m1** labels statut dashboard | `dashboard.js:27-34` | ✅ **Corrigé** (`a_confirmer/en_validation/refuse` ajoutés) |
| **m3** `maxlength` incident | `PartLocataires/incidents.html:171` | ✅ **Corrigé** (`120`) |
| **m6** `checkUsernameAvailability` mort | projet | ✅ **Corrigé** (fonction disparue) |
| **m13** Studio api_url sans port | `config.toml:94-99` | ✅ **Corrigé** (`http://127.0.0.1:64321`) |
| **m15** énumération de comptes au login | `auth.js:381,393` | ✅ **Corrigé** — réponse unique `INVALID_CREDENTIALS` |
| **m16** reset-password : session prime | `auth.js:1123-1181` | ✅ **Corrigé** — le jeton du lien prime explicitement (commentaire « audit m16 ») |
| **m17** `bcryptjs` mort | `server/package.json` | ✅ **Corrigé** (retiré) |

---

## 🆕 Évolutions depuis le 17/08 (analyse)

1. **Bictorys** remplace PayDunya/Cinetpay/Unitech pour l'**abonnement propriétaire**
   payé en ligne (`providers/bictorys.js`, `routes/bictorys.js`, migrations
   `20260921000000_bictorys.sql`, mesages de suppression `202608/09..._remove_*`).
   Les loyers restent **100 % manuels** (déclaration + validation) — cohérent avec
   le commentaire d'app.js.
2. **Grille 4 packs** : Standard/Premium/Pro/Agence + Ultra archivé, nouvelles colonnes
   de capacité `max_logements`/`max_locataires` (`20260922000000_plan_packs.sql`).
3. **Renouvellement en ligne pour abonnement expiré** : le login n'est plus bloqué ;
   seules les routes métier restent verrouillées par `requireActive`
   (`auth.js:395+`, `app.js:200-204,212`).
4. **Plafonds du plan appliqués côté serveur** à la création bien/logement/locataire
   (`crud.js:504-548,718-744` + `utils/subscription.js:264+`).
5. **CSRF retiré** (commentaire d'app.js:28-31) au profit de `SameSite=Lax`
   (`middleware/csrf.js` ; `mim-errors.js:131-136`). Compromis documenté et
   acceptable (pas de cookie cross-origin en mutation).
6. **Suspension par motif** : `suspendedReasons` (`banned`/`owner_suspended`/
   `subscription_expired`) exposés sur `req.user` (`middleware/auth.js:115+`).

### Solidité générale constatée (positif)
- Prix/montant/devise de l'abonnement **toujours relus en base** (`subscription.js:364,382-383`),
  jamais du client ; 0/positif rejetés.
- Webhook : corps **brut**, monté avant `express.json`, journal `bictorys_webhooks`
  dédupliqué (`fingerprint UNIQUE` + index partiel `event_id`), mise à jour
  conditionnelle `WHERE statut='pending'` — anti-double-clic.
- Isolation locataire déduite de `account_uid` (jamais un id client) dans
  `declarer`/`confirmer` ; moyens de paiement revérifiés propriétaire+actif.
- RLS : nouvelles tables en deny-by-default, privilèges explicites, `WITH CHECK`
  en place sur les UPDATE sensibles ; `plans` en SELECT public authentifié (faible
  sensibilité).

---

## 🔴 CRITIQUES (à traiter en priorité)

**K1 — Boucle de renouvellement pour abonnement expiré : l'utilisateur est renvoyé
vers la connexion au lieu de la page d'abonnement**
Le changement d'app.js (login autorisé si abonnement expiré) n'est pas aligné avec
le frontend :
- `requireActive` (`middleware/auth.js:148-156`) répond `401 ACCOUNT_SUSPENDED` sur
  **toutes** les routes métier, y compris `/api/stats/dashboard` (app.js:207).
- `MIM.handleAuthError` (`mim-errors.js:83-91`) **redirige vers la connexion** pour
  tout 401 → `dashboard.js:75,135` et `login` tombent dedans.
- Le propriétaire dont l'abonnement expire : login OK → dashboard → `/stats` → 401 →
  `connexion.html?error=ACCOUNT_SUSPENDED` → message « Votre compte a été suspendu. »
  (**erreur de sémantique**). Il ne voit **jamais** la bannière « Renouveler en ligne »
  (`dashboard.js:329`) puisqu'elle est court-circuitée avant render.
- Le renouvellement reste seulement accessible **en tapant l'URL
  `abonnements.html` à la main** (la page est servie car `authenticatePage` ne vérifie
  pas `suspended`, et `/api/subscription/*` est monté sans `requireActive`).

Recommandations : sur `code === "subscription_expired"` (ou sur les 401 des routes
stats), rediriger vers `abonnements.html` et afficher « abonnement expiré — renouvelez
en ligne » ; ne pas rediriger vers la connexion pour ce motif.

---

## 🟠 MOYENNES

**A — PartAdmin : 4 routes `ultra-*` mortes → 404 (zone « Ultra » inaccessible)**
`PartAdmin/admin.js:108` (`POST /api/admin/ultra-verify`), `:822` (`DELETE
/api/admin/ultra/delete-all`), `:845` (`POST /api/admin/ultra/suspend-saas`),
`:865` (`POST /api/admin/ultra/reactivate-saas`). Aucune de ces routes n'existe :
les vraies sont dans `ultra-admin.js` réservées `ultra_admin` (ex. `POST
/api/ultra-admin/saas/suspend`). Les onglets « Ultra » du panneau admin aboutissent
à des 404 silencieux. Soit brancher ces actions sur les vraies routes, soit retirer
l'UI.

**B — PartUltraAdmin : PATCH `{statut}` vs `{action}` → boutons sans effet**
`ultra.js:1018,1028` envoient `{statut:"suspendu"|"actif"}` à `PATCH
/api/ultra-admin/users/:id`, alors que le backend attend `{action:'suspend'|'reactivate'}`
(`ultra-admin.js:299`, sinon 400 « Action invalide »). Idem pour les admins
(`ultra.js:1041,1051` vs `ultra-admin.js:147`). La suspension d'un utilisateur/admin
depuis l'UltraAdmin ne fonctionne pas.

**C — Webhook Bictorys : HMAC optionnel, montant/devise non vérifiés**
`providers/bictorys.js:180-189` : l'authenticité repose sur le seul header
`X-Secret-Key` ; la signature HMAC n'est vérifiée **que si présente**. Dans
`subscription.js:617`, l'égalité de montant est **sautée quand le payload omet
`amount`**, et la devise n'est **jamais** contrôlée. Si `X-Secret-Key` fuit, un
attaquant peut activer une souscription avec un payload `succeeded` dépourvu
d'`amount`. Défense en profondeur à durcir : exiger HMAC + montant + devise.

**D — Reconstitution/reconciliation sans garde de montant**
`subscription.js:695-701` : le repli (poll/actualiser) appelle `applySucceededPayment`
directement, sans la vérification montant que fait le chemin webhook. Périmètre
maîtrisé (propriétaire scellé), incohérence de défense à corriger.

**E — `BICTORYS_SIMULATE=1` + secret fallback codé en dur**
`providers/bictorys.js:31-35` : si `isSimulate()`, le secret de vérification est la
constante publique `'bictorys_test_secret'`. Combiné à `BICTORYS_AUTOCONFIRM=1`
(`subscription.js:32`, lui-même conditionné à `isSimulate()`), un déploiement en
production avec `SIMULATE` mal réglé s'**auto-active sans argent réel**. Le `.env`
local a `SIMULATE=1` et `AUTOCONFIRM=1` (acceptable en dev/démo, les tests forcent
`AUTOCONFIRM=0` dans `run.js:97`). À durcir : refuser `isSimulate()` si
`NODE_ENV=production`.

**F — Plan archivé → activation « muette » à 1 mois**
`subscription.js:542-562` : au webhook d'un paiement dont le plan a été archivé,
`planByCode(..., false)` renvoie null → `duree` par défaut **1 mois** et l'abonnement
est activé avec la référence au plan historique. Non exploitable par un locataire,
mais un admin archivant un plan doit être averti.

**G — Flask de simulation trompeur**
`PartProprietaires/abonnements.js:21` : « Paiement simulé accepté. Votre abonnement
est activé. » s'affiche même quand `AUTOCONFIRM=0` (cas des tests et de la prod),
alors qu'aucun webhook n'arrivera — le paiement reste `pending`. Le message doit
refléter l'état réel (serveur) ou la condition `AUTOCONFIRM`.

---

## 🟡 MINEURES

| # | Fichier:ligne | Description |
|---|---|---|
| m-a | `PartPublic/2fa.js:45` | `"../" + data.redirect` : si `redirect` manquait → `../undefined` (non atteignable aujourd'hui, `finalizeLogin` renvoie toujours `redirect`) ; défensif à prévoir |
| m-b | `PartPublic/connexion.js:71` | Défaut `next` = `PartLocataires/LocaDash.html` pour `mustChangePassword` : un **employé** serait dirigé vers la zone locataire (hérité de l'ancien m9) |
| m-c | `PartEmployes/employe.js:2` | `window.MIM_API_BASE` jamais défini nulle part (config morte) |
| m-d | `PartPublic/sidebar.js:27` | Logout durcodé `/api/auth/logout` ignore la base configurée — OK en same-origin, casse en montage séparé |
| m-e | `20260921000000_bictorys.sql:111-112` | `plans` en SELECT `USING (true)` pour tout `authenticated` (y c. les plans archivés) ; faible sensibilité, à confirmer |
| m-f | `20260922000000_plan_packs.sql` + `utils/plans.js:71,79` | `max_logements`/`max_locataires` **sans `CHECK > 0`** : un `0` en base signifie « illimité » (fail-open silencieux). Doc de `plan_packs.sql:13-15` renvoyant à « bictorys.sql mis à jour » fausse (bictorys.sql:44-49 ne sème que standard/premium/ultra) |
| m-g | `server/_diag_sub.mjs` | Script de diagnostic laissé dans `server/` (untracked) — à supprimer |
| m-h | `bictorys.test.js:260` | `pendStd` référencé hors du scope du `r.section` (ReferenceError latent si branche d'échec) ; `:264,303` `evt_success_1` fixe → fragile à la reprise sur base non reseedée |
| m-i | `abonnement_paiements.plan` | Colonne TEXT libre sans FK vers `plans(id)` ; code plan inconnu → activation 1 mois (voir F) |
| m-j | `mim-errors.css` / `.has-error` | Toujours aucun style pour `.has-error` (cosmétique, hérité) |
| m-k | Legacy `a_confirmer` | Statut plus produit ; lignes historiques « À confirmer » non confirmables depuis l'UI (aucun bouton n'appelle `/locataire/paiements/:id/confirmer`) — voir C4 asséché |
| m-l | Endpoints backend jamais consommés | `GET /api/import/progress/:runId` (import.js:322), `GET /api/import/meta` (import.js:342), `GET /api/employes/mois-courant` (employes.js:676) — code mort ou API publique à documenter |

---

## 💥 Résumé exécutif

1. **Le gros de l'audit précédent est corrigé** : C1→C4, M1→M7, m1/m3/m6/m13/m15/m16/m17
   vérifiés revus dans le code. Le backend a gagné des plafonds d'abonnement serveur
   et une refonte du paiement plus défensive.
2. **La pièce centrale de la nouvelle version (renouvellement en ligne d'un abonnement
   expiré) est mal intégrée côté frontend** : l'utilisateur ciblé est rejeté vers la
   connexion avec un message de « suspension » (K1). C'est l'unique blocage fonctionnel
   critique relevé.
3. **Zone admin/ultra** : 4 routes mortes (PartAdmin) et 2 PATCH désynchronisés
   (PartUltraAdmin) — deux zones d'administration affichent des actions
   inopérantes → `404`/`400` silencieux.
4. **Webhook Bictorys** : logique saine (idempotence, activation unique, prix serveur)
   mais à durcir niveau authentification (HMAC/amount/devise obligatoires) (C, D, E).
5. **Non exécuté** : suite de tests (environnement Docker/Supabase arrêté). Avant toute
   correction, rejouer `cd server && node scripts/tests/run.js` (attendu : 20 suites,
   dont la nouvelle `bictorys`).

## 🔧 Corrections recommandées (par priorité)

**P0 — fonctionnel**
1. K1 : ne pas rediriger vers la connexion quand `req.user.suspendedReasons` =
   `subscription_expired` ; orienter vers `abonnements.html` avec un message dédié
   (frontend `mim-errors.js`/`dashboard.js` + backend `requireActive`).

**P1 — admin/ultra & portails**
2. PartAdmin : retirer l'UI ultra-* ou la brancher sur les vraies routes ultra-admin.
3. PartUltraAdmin : aligner le payload sur `{action}` (`ultra.js:1018,1028,1041,1051`).

**P2 — sécurité du webhook**
4. Rendre HMAC **obligatoire** et exigir `amount`/`currency` avec égalité stricte
   (`subscription.js` `processWebhook`, `providers/bictorys.js` `verifyWebhook`) ;
   appliquer la même garde à la reconciliation (D).
5. Refuser `isSimulate()` en `NODE_ENV=production` (E) ; supprimer le secret fallback
   codé en dur.

**P3 — qualité/portabilité**
6. Handle de plan archivé (F) et toast de simulation (G) ; FK `abonnement_paiements.plan`
   + `CHECK` positifs sur `max_logements/max_locataires` (m-f) ; nettoyer `_diag_sub.mjs`
   (m-g) ; corriger la doc de `plan_packs.sql` ; supprimer/consommer les routes mortes (m-l) ;
   défini `MIM_API_BASE` ou retirer la config morte (m-c) ; harmoniser `change-password.js`
   pour le cas employé (m-b).

## ✅ Résolutions appliquées (séance du 22/09 — P0/P1)

**K1 — redirection abonnement expiré (P0)**
- `server/middleware/auth.js` `requireActive` : pour `account_type` ∈
  `proprietaire|agence|entreprise` dont `suspendedReasons` = uniquement
  `['subscription_expired']`, renvoie maintenant `401 { code: 'SUBSCRIPTION_EXPIRED' }`
  (message dédié) ; le code `ACCOUNT_SUSPENDED` est conservé pour toute autre
  suspension/bannissement (y compris locataire/employé dont le propriétaire est
  suspendu).
- `server/middleware/auth.js` `authenticatePage` : un propriétaire dont le seul motif
  est `subscription_expired` est redirigé vers `/PartProprietaires/abonnements.html`
  au lieu de la connexion (cookie posé au préalable pour garder la session). La page
  `abonnements.html` elle-même est exclue de la redirection (garde sur `req.path`),
  sinon boucle infinie.
- `server/routes/auth.js` `finalizeLogin` : login, 2FA et OAuth renvoient
  `redirect: 'PartProprietaires/abonnements.html'` pour les owners expirés.
- `PartPublic/mim-errors.js` `MIM.handleAuthError` : sur `code === 'SUBSCRIPTION_EXPIRED'`,
  redirection directe vers `/PartProprietaires/abonnements.html` (aucun retour à la
  connexion).

**P1 — PartAdmin (routes ultra mortes)**
- UI ultra supprimée : `admin.js` (mode/vérification `ultraVerify`, `ultraSystem`,
   `ultraDeleteAll`, `ultraSuspendSaas`, `ultraReactivateSaas`, `ultraDanger`,
   listeners, entrées `RENDERERS`/`sections`), `admin.html` (toggle, nav ultra-only,
   `ultraModal`), `admin.css` (blocs `.ultra-*`, `.saas-status-*`,
   `.confirm-danger-zone`). Le rôle `admin` ne peut plus suspendre le SaaS ni
   supprimer la base ; l'outil réel reste dans PartUltraAdmin (role `ultra_admin`).

**P1 — PartUltraAdmin (PATCH {statut} → {action})**
- `ultra.js` : 4 requêtes alignées sur le contrat backend
  (`server/routes/ultra-admin.js` :150/:302) :
  - `:1018` users → `{ action: "suspend" }`
  - `:1028` users → `{ action: "reactivate" }`
  - `:1041` admins → `{ action: "suspend" }`
  - `:1051` admins → `{ action: "reactivate" }`

## Vérification proposée avant clôture
- Rejouer la suite complète des tests après corrections (elle exige Supabase local :
  démarrer Docker Desktop puis `supabase start`).
- Tester en live le parcours « propriétaire expiré → renouvellement Bictorys » (le
  blocage K1 doit disparaître) et les deux zones d'administration.