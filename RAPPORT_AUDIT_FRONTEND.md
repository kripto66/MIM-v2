# Rapport d'audit frontend — MIM

**Date :** 27/09/2026
**Périmètre :** `C:\xampp\htdocs\MIM2.1\MIM` — 47 pages HTML + 44 fichiers JS répartis dans `PartPublic`, `PartProprietaires`, `PartAgence` (`first_Mode` / `second_Mode`), `PartLocataires`, `PartAdmin`, `PartUltraAdmin`, `PartEmployes`, `PartProprietairesShadow` (≈ 103 fichiers, 7 000+ lignes de JS côté client).
**Contrainte :** audit en lecture seule. **Aucun fichier du projet n'a été modifié.** Ce document est l'unique livrable.

**Méthode :** lecture ciblée des couches critiques (auth, sessions, CSRF, formulaires, rendu), balayage automatisé de tous les `innerHTML` / interpolations de templates (scan ligne à ligne + scan multi-lignes sur les templates fermés par `` ` ``), vérification systématique de la couverture des `<form>`, des `id` dupliqués, des labels/ARIA, des ressources externes, du stockage navigateur et des appels dangereux (`eval`, `new Function`, `document.write`, `setTimeout(string)`).
**Garde-fous exécutés :** `npm run lint` et `npm run typecheck` → **verts** (133 fichiers JS vérifiés chacun), `npm run test:syntax` non exécuté (non requis, aucun code modifié).

---

## Synthèse

| # | Sévérité | Localisation | Constat |
|---|---|---|---|
| 1 | **Critique** | `PartUltraAdmin/ultra.js:985,998` | `escapeAttr` jamais définie → section **Tarification inutilisable** |
| 2 | **Élevé** | `PartAdmin/admin.js:564,569` | Badges d'abonnement affichés en **HTML brut** dans un tableau |
| 3 | **Élevé** | `PartAdmin/admin.js:542` | Badge de statut affiché en **HTML brut** dans le panneau Incidents |
| 4 | **Moyen** | 5 fichiers | XSS stocké potentiel : champs DB non échappés dans `innerHTML` |
| 5 | **Moyen** | 9 fichiers / ~20 sites | `formatMois()` injectée brute dans `innerHTML` |
| 6 | **Moyen** | `PartUltraAdmin/ultra.js:1397` | « Tapez SUPPRIMER » **non vérifié** (confirmations décoratives) |
| 7 | **Moyen** | tout le frontend | Aucun gestionnaire `pageshow` (bfcache) |
| 8 | **Faible** | 7 fichiers | `id` dupliqués (dont `adminName` en double dans `ultra.html`) |
| 9 | **Faible** | ~8 fichiers | Champs de recherche sans `label` / `aria-label` |
| 10 | **Faible** | 7 fichiers | `catch` silencieux, rendu « null — null », logout `<a href="#">` |

Aucune faille de type secret exposé, dépendance CDN tierce, stockage de jeton, `eval` ou formulaire non câblé n'a été retrouvée (voir *Vérifications negatives*).

---

## A. Bugs par ordre de sévérité

### 🔴 A1 — CRITIQUE : `escapeAttr` non définie → section « Tarification » cassée (Ultra Admin)

- **Fichiers :** `PartUltraAdmin/ultra.js:985` et `ultra.js:998` (fonction `planRow`, `ultra.js:980-1001`), appelée par `plans()` via `rows.map(planRow)` (`ultra.js:1026`).
- **Constat :** `escapeAttr` est utilisée pour les attributs `data-plan` / `data-code`. Cette fonction n'existe **nulle part dans l'espace Ultra Admin** : elle n'est déclarée que dans `PartProprietaires/parametres.js:128` et en script inline dans 6 autres pages (`PartProprietaires/employes.html:369`, `PartProprietaires/paiements.html:423`, `PartProprietaires/locataires.html:285`, `PartAgence/second_Mode/paiements.html:239`, `PartAgence/second_Mode/locataires.html:264`, `PartLocataires/paiements.html:262`).
  `PartUltraAdmin/ultra.html` ne charge que `/mim-errors.js` (qui ne définit que `escapeHtml`), `/PartPublic/form-utils.js` et `ultra.js`.
- **Impact :** `ReferenceError: escapeAttr is not defined` dès le rendu de la première ligne de plan → l'erreur est attrapée par le `catch` de `navigate()` (`ultra.js:1137` et suiv.) → l'utilisateur voit un panneau d'erreur à la place des tableaux « Formules propriétaire » et « Formules agence ». La section **Tarification est totalement inutilisable** (édition, création, activation des plans).
- **Cause profonde :** helper de sécurité dupliqué dans chaque page au lieu d'être centralisé.
- **Correction :** déplacer `escapeAttr` dans `PartPublic/mim-errors.js` (exposé globalement comme `escapeHtml`), supprimer les 7 rédéfinitions locales, et ajouter un test de non-régression (cf. B5).

### 🟠 A2 — ÉLEVÉ : badges d'abonnement affichés en texte brut (Admin)

- **Fichiers :** `PartAdmin/admin.js:551-556` (`subBadge`), `admin.js:564` (colonne `sub`), `admin.js:569` (liste de colonnes), rendu dans `rows()` → `admin.js:457-466`.
- **Constat :** `subBadge()` renvoie du HTML volontaire (`<span class="badge success" title="Expire le …">Abonné · 45 j</span>`). `rows()` échappe **toutes** les colonnes sauf `statut`/`status`/`montant` (`admin.js:459-464` : `escapeHtml(String(val))`).
- **Impact :** dans la table « Propriétaires », la colonne **Abonnement affiche littéralement `<span class="badge success" title="…">Abonné · 45 j</span>`** au lieu du badge. Rendu cassé sur l'écran le plus consulté de l'espace admin.
- **Correction :** donner à `rows()` un marqueur de cellule « HTML assumé » (ex. colonne nommée `sub:html` ou `Set` de colonnes `raw`), ou faire passer le HTML via `onAction`/une fonction de cellule, en gardant l'échappement par défaut.

### 🟠 A3 — ÉLEVÉ : badge de statut affiché en texte brut (panneau Incidents, Admin)

- **Fichiers :** `PartAdmin/admin.js:542` + `admin.js:439-443` (`activity`).
- **Constat :** `activity(r.titre, \`${r.logement} — ${r.locataire}\`, badge(r.statut))` transmet le HTML produit par `badge()` (`admin.js:143-151`, qui renvoie bien `<span class="badge …">`) en **3ᵉ argument**, alors que `activity()` applique `escapeHtml()` à ses trois arguments.
- **Impact :** le panneau « Incidents » du tableau de bord admin affiche `<span class="badge danger">Nouveau</span>` en clair sous chaque incident.
- **Note :** même motif latent dans `admin.js:686` (`activity(a.action, …)`) mais sans HTML → seulement des `null` affichés (cf. D4).
- **Correction :** prévoir une option `{ raw: true }` sur `activity()` pour le troisième argument, ou remplacer l'appel par une colonne de tableau dédiée.

> **Comparaison utile :** `PartUltraAdmin/ultra.js:137-142` utilise la même fonction `rows()` **avec les mêmes écueils**, mais ses colonnes sont toutes textuelles (les boutons passent par `onAction`, non échappés volontairement). Le bug se reproduira dès qu'une colonne HTML y sera ajoutée.

### 🟡 A4 — MOYEN : XSS stocké potentiel — valeur DB brute insérée dans `innerHTML`

Même cause répétée 5 fois : une valeur supposée énumérique (type de moyen de paiement / méthode) est retombée sur son **libellé brut** si le mapping ne la reconnaît pas, et ce fallback n'est jamais échappé.

| Fichier:Ligne | Expression |
|---|---|
| `PartProprietaires/parametres.js:110` | `${TYPE_ICONS[m.type] \|\| "💰"} ${TYPE_LABELS[m.type] \|\| m.type}` |
| `PartProprietaires/paiements.html:490` | `${METHODE_LABELS[p.methode_paiement] \|\| p.methode_paiement \|\| "—"}` |
| `PartProprietaires/paiements.html:980,1005` | `METHODE_LABELS[p.methode_paiement]` (fallback non échappé) |
| `PartAgence/second_Mode/paiements.html:289` | identique à `paiements.html:490` |
| `PartLocataires/paiements.html:389` et `:438` | `const label = TYPE_LABELS[m.type] \|\| m.type` puis `${TYPE_LABELS[method.type] \|\| method.type}` |

- **Impact :** si un `type` / `methode_paiement` non listé arrive en base (API, import CSV `import.js`, écriture directe), toute l'arborescence peut être injectée → **XSS stocké**.
- **Atténuation partielle inexistante :** la CSP utilise `script-src 'self' 'unsafe-inline'` (`server/app.js:122`), elle **n'empêche pas** l'exécution de ce script inline.
- **Correction :** `escapeHtml(TYPE_LABELS[m.type] || m.type)` partout ; idéalement, rejeter côté serveur toute valeur hors liste.

### 🟡 A5 — MOYEN : `formatMois()` injectée brute dans `innerHTML` (~20 sites)

- **Implémentations :**
  - `PartProprietaires/api.js:82-86` et sa copie `PartAgence/first_Mode/api.js:82` : `const [y, m] = mois.split("-"); return \`${MOIS_FR[Number(m)-1]} ${y}\`` → si `mois` ne contient pas `-`, **`y` est la chaîne entière, retournée telle quelle**.
  - `PartLocataires/LocaDash.js:35-38` : même logique.
  - `PartPublic/mim-ui.js:70-74` : `if(!/^\d{4}-\d{2}$/.test(m)) return m || "—"` → **renvoie explicitement la valeur brute**.
- **Sites d'injection non échappés (exemples) :** `PartLocataires/LocaDash.js:144,155` → `:248` (`innerHTML = prochain.echeance`), `LocaDash.js:279,302,311,319` ; `PartProprietaires/paiements.html:488,627,845,980,1005` ; `PartProprietaires/dashboard.js:371` ; `PartAgence/second_Mode/paiements.html:287,426` ; `PartLocataires/paiements.html:309,321,336,351,413,493`.
- **Impact :** XSS stocké conditionnel à un champ `mois` mal formé (l'API ne semble pas contraindre ce format côté client).
- **Correction :** faire de `formatMois` une fonction **qui ne peut renvoyer que du texte sûr** (valider `\d{4}-\d{2}`, sinon `"—"`) **et** échapper à l'appel — les deux, par sécurité.

### 🟡 A6 — MOYEN : les confirmations « tapez SUPPRIMER » ne sont pas vérifiées

- **Fichier :** `PartUltraAdmin/ultra.js:1397-1406` :
  ```js
  const val = (input?.value || "").trim();
  if (!val) return;        // ← aucune comparaison avec "SUPPRIMER"
  resolveConfirm(true);
  ```
- **Appels impactés :** retrait de rôle admin (`:1225`), suppression d'annonce (`:1263`), d'événement (`:1303`), de mise en avant (`:1320`), **suspension du SaaS** (`:1337`).
- **Impact :** la garde psychologique affichée à l'utilisateur (« Tapez SUPPRIMER pour confirmer ») est cosmétique : **n'importe quelle saisie non vide** valide l'action. Atténuation : le serveur reste l'ultime vérificateur, mais la défense en profondeur est inefficace.
- **Correction :** `opts.expected` renseigné par l'appelant (déjà disponible via `inputPlaceholder`) et comparaison insensible à la casse avant `resolveConfirm(true)`.

### 🟡 A7 — MOYEN : aucune gestion du bfcache côté client

- **Constat :** recherche `pageshow|pagehide|beforeunload|persisted` sur les 103 fichiers → **0 occurrence**.
- **Analyse :** le serveur protège déjà l'essentiel (`server/app.js:136-138` : `Cache-Control: no-store` sur `.html` et `/api`), donc la page n'est pas resservie depuis l'HTTP cache. En revanche, **le bfcache du navigateur** (qui restaure l'état JS/CSS, indépendamment de `no-store` selon les moteurs) peut réafficher des listes/filtres figés après une déconnexion, et l'état `sessionStorage` (`second_Mode/scope.js`, `second_Mode/bien.js:115`, `onboarding.js` via `localStorage`) survit.
- **Correction :** `window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });` dans `PartPublic/sidebar.js` (chargé par toutes les zones).

### ⚪ A8-A10 — FAIBLE

- **A8 — `id` dupliqués.** `id="tok"` répété **6 fois** dans chacune des pages `PartLocataires/{LocaDash,incidents,logement,notifications,paiements,profil}.html` (lignes 49-104 ; HTML invalide, `getElementById` renvoie le 1ᵉʳ seulement). `adminName` en double dans `PartUltraAdmin/ultra.html:85` (div du header) **et** `:146` (input du formulaire de création d'admin) — le ciblage par id de l'input est impossible, seul `form.adminName` fonctionne aujourd'hui.
- **A9 — Accessibilité :** champs de recherche/ saisie sans `<label>` ni `aria-label` (placeholder seul) : `PartEmployes/employe.html:62` (`taskQ`), `:72` (`incidentQ`), `:142` (`refusDetail`) ; `PartProprietaires/locataires.html:86`, `employes.html:91`, `paiements.html:159` ; `PartAgence/second_Mode/locataires.html:87` ; `PartAdmin/admin.html:188` (`subMontant`). *À noter :* le formulaire de profil `employe.html:173-183` utilise correctement des labels enveloppants — c'est le modèle à suivre.
- **A10 — Divers :**
  - `catch` silencieux : `PartProprietairesShadow/dashboard.js:221,229,231`, `PartAgence/second_Mode/scope.js:89`, `mode2.js:117`, `bien.js:115`, `PartUltraAdmin/ultra.js:595,1759`, `PartPublic/sidebar.js:29` (les deux derniers sont dans un `finally` et restent tolérables).
  - `PartAdmin/admin.js:542,686` : `a.user` / `a.detail` nuls → « **null — null** » affiché (échappé, donc pas XSS, mais affichage sale).
  - `PartUltraAdmin/ultra.js:992` : `p.max_imbiased ?? p.max_immeubles` — nom de champ douteux (typo ?) → cellule vide si absent des deux côtés.
  - `PartProprietairesShadow/{dashboard,messages,versements}.html` : déconnexion sur `<a href="#" id="logoutBtn">` ; `sidebar.js:25` ne fait **pas** `preventDefault` → le navigateur remonte en haut de page pendant la déconnexion.
  - `PartAdmin/admin.js:191,193` : `statCard()` n'échappe ni `cfg.label` ni `cfg.sub` (valeurs statiques aujourd'hui, contrat fragile — `ultra.js:107-113` le fait correctement).

---

## B. Dettes techniques / suggestions d'amélioration

1. **Duplication généralisée (cause racine des bugs A1 et A2).**
   - `PartProprietaires/api.js` ≡ `PartAgence/first_Mode/api.js` (copie conforme, 86 lignes) ; `crud.js` dupliqué de la même façon ; `formatDate` / `formatMois` / `fmtFCFA` / `badge` / `showProgress`/`hideProgress` réimplémentés dans `admin.js`, `ultra.js`, `employe.js`, `mim-ui.js` ; **`escapeAttr` déclarée 7 fois**.
   - *Suggestion :* faire de `PartPublic/mim-ui.js` (déjà chargé par 20 pages) la source de vérité des helpers de rendu (`escapeHtml`, `escapeAttr`, `formatMois`, `badge`, `money`), avec `mim-errors.js` en noyau minimal chargé partout en premier.

2. **Fichiers monolithes.** `PartProprietaires/paiements.html` ≈ 49 ko, `employes.html` ≈ 43 ko, `locataires.html` ≈ 34 ko, avec logique applicative en script inline (jusqu'à ~500 lignes). Difficile à tester, à relire et à synchroniser avec leurs jumeaux d'agence.
   *Suggestion :* extraire chaque bloc inline dans un `.js` dédié (déjà le modèle de `crud.js` / `api.js`).

3. **Triplication des espaces.** `PartProprietaires` / `PartAgence/first_Mode` / `PartAgence/second_Mode` / `PartProprietairesShadow` sont des copies à évolution divergente (le bug `sub` d'`admin.js` n'existe pas dans `ultra.js`, et inversement pour `escapeAttr`).
   *Suggestion :* un noyau commun + des fichiers de configuration d'espace (libellés, routes, sections) plutôt que des copies de code.

4. **Rendu 100 % `innerHTML`.** 267 affectations recensées, avec un taux d'échappement très bon (28 interpolations en ligne unique : 100 % échappées) mais 7 fuites identifiées (A4/A5).
   *Suggestion :* converger vers des helpers de rendu typés (`renderRow(data)` qui échappe par construction) ou `<template>` + `cloneNode` ; à défaut, imposer la règle « toute interpolation dans un template passe par `escapeHtml`/`escapeAttr` ».

5. **Les garde-fous statiques ne couvrent pas ces bugs.** `npm run lint` et `npm run typecheck` passent (133 fichiers) mais ils ne détectent ni les `ReferenceError` d'exécution (`escapeAttr`), ni les interpolations non échappées.
   *Suggestion (rapide, très rentable) :* deux scripts dans `quality.mjs` :
   - échec si un fichier utilise `escapeAttr`/`escapeHtml` sans qu'elle soit définie dans la page (analyse des `<script src>` de la page) ;
   - échec si une interpolation `${…}` est détectée dans un bloc `innerHTML` sans passer par `escapeHtml`/`escapeAttr`/`Number`/format connu (le scan de cet audit, déjà codé, est réutilisable : ~50 lignes).
   En complément, ESLint avec `no-undef` sur les fichiers de la page (la config actuelle est manifest-based).

6. **CSP affaiblie.** `server/app.js:119-131` met en place une belle CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri`, `form-action`) mais avec `script-src 'self' 'unsafe-inline'`, **nécessaire aux scripts inline du HTML** et donc **inefficace contre l'injection de script**.
   *Suggestion :* extraire les scripts inline vers des fichiers externes (dette B2), puis retirer `unsafe-inline` ; ajouter `frame-src 'none'` et `upgrade-insecure-requests`.

7. **Accessibilité transverse.** Outre A9 : pas d'`aria-live` sur les toasts, pas de piège de focus dans les modales (`confirmModal`, `payEmpModal`, `declareModal`), pas de `:focus-visible` systematique, boutons icônes sans nom accessible.
   *Suggestion :* passer les modales en `<dialog>` natif (focus trap + Échap gratuits).

8. **Observabilité des erreurs.** Les `catch` silencieux (A10) masquent les échecs de synchronisation (notifications lues, scope de bien). *Suggestion :* au minimum `console.warn` en développement et un message utilisateur via `MIM.showError`.

9. **Tests.** `package.json` ne prévoit que `test:syntax` + `test:e2e` (côté serveur). Aucun test de rendu frontend. *Suggestion :* un test « page se rend sans exception » (JSDOM ou Playwright sur les sections connues) aurait détecté A1 et A2 immédiatement.

---

## C. Points forts

- **Échappement global structuré.** `escapeHtml()` centralisé dans `PartPublic/mim-errors.js:9` et utilisé de façon quasi systématique ; sur les 267 `innerHTML`, l'immense majorité des interpolations sont correctement échappées (vérifié par scan).
- **CSRF réellement appliqué.** `await MIM._csrfReady` + `MIM.csrfHeader()` dans **toutes** les couches `fetch` (`mim-errors.js`, `api.js` propriétaires, `crud.js`, `employe.js`, `LocaDash.js`, `sidebar.js`), doublé de `csrfOriginGuard` côté serveur (`server/app.js:155`).
- **Sessions par cookies, sans jeton côté JS.** Aucun JWT ni secret en JS/localStorage ; `localStorage` sert uniquement à un flag d'onboarding (`PartProprietaires/onboarding.js`), `sessionStorage` au seul scope « bien » de l'agence (`second_Mode/scope.js`, `bien.js:115`) — périmètre non sensible.
- **La sécurité ne repose pas sur le JavaScript.** `server/app.js:164-170` : `authenticatePage()` + `requireZone(...)` par espace sur chaque dossier protégé ; `Cache-Control: no-store` (`:136-138`) ; CSP, `X-Robots-Tag: noindex` sur les zones, `Permissions-Policy`, HSTS en production (`:105-131`).
- **`.htaccess` défensif :** refuse `.env`, `/server`, `/supabase`, `*.sql|log|bak|env`.
- **Zéro ressource externe.** Aucun script/style/police de CDN (0 occurrence `cdn|unpkg|jsdelivr|googleapis|cloudflare`) : pas de SRI à maintenir, pas de risque supply-chain navigateur, tout est servi par le backend.
- **Tous les formulaires sont câblés.** Vérification systématique sur les 29 `<form>` répartis dans les 47 pages : chacun possède un handler `submit` (via `addEventListener`, `CrudPage.init()` ou `onsubmit`), avec validation client + `applyServerErrors`/`formFieldError` pour les erreurs serveur.
- **Bonnes pratiques ponctuelles méritant d'être étendues :**
  - `admin.js:479-483` : `csvCell()` neutralise les formules CSV (`=`, `+`, `-`, `@`) → anti form-injection à l'export ;
  - `MIM.httpsUrl()` filtre les URL avant insertion dans un `href` (anti `javascript:`) : `parametres.js:114`, `PartLocataires/paiements.html:396` ;
  - les sorties non-HTML (toasts, noms, compteurs) passent par `textContent` (`mim-ui.js:91-94`, `api.js:74`, `ultra.js:101`) ;
  - messages d'erreur centralisés (`MIM.MESSAGES` / `MIM.userMessage`) → pas de fuite des détails internes serveur vers l'utilisateur ;
  - `admin.js:756-760` : vérification du rôle côté client en complément du garde-fou serveur ;
  - tous les documents déclarent `<meta charset="utf-8">` et `lang="fr"`.

---

## D. Plan de correction recommandé

| Priorité | Action | Effort estimé |
|---|---|---|
| **P0** | A1 — ajouter `escapeAttr` à `mim-errors.js`, supprimer les 7 copies locales | 30 min |
| **P0** | A2/A3 — permettre une cellule HTML assumée dans `rows()` de `admin.js`, corriger l'appel `activity()` | 1 h |
| **P1** | A4/A5 — envelopper les 5 fallbacks de libellés et les ~20 `formatMois()` d'`escapeHtml` (et renforcer `formatMois` pour ne jamais renvoyer de brut) | 1-2 h |
| **P1** | A6 — vérifier la saisie de confirmation dans `confirmAction` | 30 min |
| **P1** | B5 — ajouter les 2 vérifications automatiques (helpers non définis + interpolations non échappées) à `quality.mjs` | 2-3 h |
| **P2** | A7 — handler `pageshow` global ; A8 — nettoyer les `id` dupliqués | 1 h |
| **P2** | A9/A10 — labels/ARIA, `preventDefault` sur le logout Shadow, rendus `null` | 1-2 h |
| **P3** | B1-B3 — mutualisation des helpers et des espaces, extraction des scripts inline, puis durcissement CSP | refonte continue |

---

## E. Vérifications négatives (contrôlées, non retrouvé)

- **Secrets / jetons :** aucun `API_KEY`, token ou identifiant dans les fichiers HTML/JS du client.
- **`eval` / `new Function` / `setTimeout(string)` / `document.write` :** 0 occurrence dans les 8 espaces.
- **Stockage sensible :** aucun `localStorage`/`sessionStorage` contenant des données d'identité ou de session (cf. C).
- **Dépendances externes :** aucun CDN, aucune police tierce (cf. C).
- **Formulaires orphelins :** aucun (29/29 câblés).
- **`innerHTML` avec interpolation non échappée en ligne unique :** 0 sur 28 (seuls les templates multi-lignes présentaient les fuites A4/A5).
- **Écritures de fichiers / exécution de code :** aucun script d'audit n'a modifié le projet ; `npm run lint` et `npm run typecheck` sont des lectures.
