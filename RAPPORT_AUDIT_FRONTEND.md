# Rapport d'audit frontend — MIM

**Audits :** **27/09/2026** (lecture seule) · **29/09/2026** (revue complète des 8 espaces + corrections)
**Périmètre :** `C:\xampp\htdocs\MIM2.1\MIM` — **47 pages HTML**, **45 fichiers JS (10 997 lignes)**, **11 CSS**, **43 scripts distincts** répartis dans `PartPublic`, `PartProprietaires`, `PartAgence` (`first_Mode` / `second_Mode`), `PartLocataires`, `PartAdmin`, `PartUltraAdmin`, `PartEmployes`, `PartProprietairesShadow`.
**État :** **24 fichiers modifiés** dans l'arbre de travail (non commités) — inventaire en §F.

**Méthode :** scripts d'analyse statique lancés hors dépôt (résolution des références et URLs, cibles DOM, cartographie des routes API, scan d'interpolations `innerHTML`, couverture des formulaires, accessibilité, encodage), puis lecture ciblée de chaque alerte pour trancher « bug réel » vs « faux positif ».
**Garde-fous exécutés :** `npm run lint`, `npm run typecheck`, `npm run test:syntax` → **verts** (138 fichiers JS vérifiés chacun).

---

## Synthèse

| | Constat |
|---|---|
| **Bugs du 27/09** | 10 constats (1 critique, 2 élevés, 4 moyens, 3 faibles) → **10/10 corrigés** (§A) |
| **Bugs du 29/09** | 6 nouveaux constats → **6/6 corrigés** (§B) |
| **Re-scan final** | 0 référence cassée, 0 route API manquante, 0 interpolation XSS, 0 champ sans nom accessible, 0 séquence d'encodage corrompue |
| **Reste ouvert** | uniquement de la **dette technique** sans impact runtime (§D) |

---

## A. Bugs du 27/09 — état de correction

| # | Sévérité | Localisation | Statut | Preuve |
|---|---|---|---|---|
| 1 | **Critique** | `PartUltraAdmin/ultra.js` — `escapeAttr` non définie, section Tarification cassée | ✅ corrigé | `escapeAttr` est désormais déclarée **une seule fois**, dans `PartPublic/mim-errors.js:35` ; les 7 copies locales ont disparu (vérifié sur les 8 espaces) |
| 2 | **Élevé** | `PartAdmin/admin.js` — badges d'abonnement en HTML brut | ✅ corrigé | `rows()` accepte une colonne déclarée `{ key, html: true }` (`admin.js:471`), échappement par défaut conservé |
| 3 | **Élevé** | `PartAdmin/admin.js` — badge de statut en HTML brut dans Incidents | ✅ corrigé | `activity(title, text, time, raw = {})` (`admin.js:439-443`) n'échappe que les arguments non marqués ; appel `admin.js:555` passé en `{ time: true }` |
| 4 | **Moyen** | 5 fichiers — fallbacks `TYPE_LABELS[...] \|\| x` non échappés | ✅ corrigé | tous enveloppés : `parametres.js:110`, `PartLocataires/paiements.html:385,434`, `PartProprietaires/paiements.html:486,685,870`, `PartAgence/second_Mode/paiements.html:285` |
| 5 | **Moyen** | ~20 sites — `formatMois()` injectée brute | ✅ corrigé | les 4 implémentations valident `^\d{4}-\d{2}$` sinon `"—"` (`mim-ui.js:73`, `PartProprietaires/api.js:85`, `PartAgence/first_Mode/api.js:85`, `LocaDash.js:38`) **et** les sites d'appel passent par `escapeHtml(formatMois(...))` |
| 6 | **Moyen** | `PartUltraAdmin/ultra.js` — confirmation « tapez SUPPRIMER » non vérifiée | ✅ corrigé | `confirmExpected` calculé depuis `opts.expected \|\| opts.inputPlaceholder` (`ultra.js:269`) puis comparé avant `resolveConfirm(true)` ; les appels renseignent `expected` (ex. `ultra.js:1255`) |
| 7 | **Moyen** | tout le frontend — pas de gestion du bfcache | ✅ corrigé | `window.addEventListener('pageshow', …)` dans `PartPublic/mim-errors.js:15`, chargé par toutes les pages |
| 8 | **Faible** | `id` dupliqués (`tok` ×6, `adminName`) | ✅ corrigé | balayage de tous les `id="…"` des 47 pages : **aucun doublon réel** (voir §D pour le seul cas restant, faux positif) |
| 9 | **Faible** | champs sans `label` / `aria-label` | ✅ corrigé | 0 champ sans nom accessible (labels enveloppants acceptés, cf. §C) |
| 10 | **Faible** | logout `<a href="#">`, rendus « null — null », `statCard` non échappée, typo `max_imbiased` | ✅ corrigé | `sidebar.js:32` (`preventDefault`), `admin.js:555` et `:708` (`.filter(Boolean).join(" — ") \|\| "—"`), `admin.js:191,193` (`escapeHtml`), `ultra.js:1019` (`max_immeubles`) |

---

## B. Bugs trouvés et corrigés le 29/09

### B1 — 🔴 `showToast()` n'existe pas → `ReferenceError` à la suppression d'une notification

- **Fichier :** `PartLocataires/LocaDash.js:381` et `:385` (fonction `deleteNotif`).
- **Constat :** `showToast` n'était déclaré **nulle part** dans `PartLocataires` (ni dans les `.js`, ni dans le HTML, ni dans `PartPublic`). Les autres espaces ont leur propre helper (`PartAdmin/admin.js:170`, `PartProprietaires/api.js:67`, `PartAgence/first_Mode/api.js:67`, `PartUltraAdmin/ultra.js:98`), mais pas le locataire.
- **Impact :** clic sur « ✕ Supprimer » d'une notification → `ReferenceError: showToast is not defined` propagée depuis `deleteNotif`, **le message de succès comme le message d'erreur sont perdus** et la suppression échoue silencieusement côté retour d'information.
- **Correction :** bascule sur le helper déjà présent et déjà utilisé 2 fois dans le même fichier : `showTenantError("Notification supprimée.", true)` et `showTenantError(err.message)` (boîte `#tenantError`, présente sur `LocaDash.html:195`).

### B2 — 🔴 Mojibake CP1252 : les utilisateurs voyaient « Mes employÃ©s », « DÃ©connexion », « â€” »

- **Fichiers (9) :** `PartProprietaires/{employes,import,locataires,parametres,interventions,prestataires,incidents,notifications,biens}.html`.
- **Constat :** du texte UTF-8 avait été **ré-interprété en CP1252 puis re-encodé** : `é` apparaissait `Ã©`, `—` → `â€”`, `⌘` → `âŒ˜`, `✅` → `âœ…`, `🔎` → `ðŸ”Ž`, `« »` → `Â« Â»`. Le navigateur (déclaré en UTF-8) affiche littéralement ces chaînes à l'écran.
- **Volume :** ~**400 séquences** réparées (détection : caractères U+0080–U+00BF isolés, octets C1, `U+FFFD`).
- **Correction :** décodage inverse CP1252 → UTF-8 appliqué séquence par séquence, **uniquement** sur les fichiers réellement corrompus, avec contrôle que chaque décodage produit un caractère sane (pas de contrôle, pas de remplacement). Re-scan final : **0 séquence restante**.

### B3 — 🟠 Un « nettoyage » d'encodage antérieur avait dégradé deux pages

Le diff de travail en cours sur `biens.html` / `employes.html` remplaçait le mojibake par du texte **sans accents**, en introduisant des erreurs de fond :

| Fichier | Texte dégradé | Texte restauré |
|---|---|---|
| `PartProprietaires/biens.html:72` | « Gerez vos immeubles, maisons et autres **proprietaires**. » | « Gérez vos immeubles, maisons et autres **propriétés**. » |
| `PartProprietaires/biens.html:67` | icône hamburger vidée | `☰` |
| `PartProprietaires/biens.html:95` | `<!-- Modale ajout / Addition -->` | `<!-- Modale ajout / édition -->` |
| `PartProprietaires/employes.html:161` | « Biens affectees (l'employ**©** … » | « Biens affectés (l'employé … » |
| `PartProprietaires/employes.html:91` | placeholder emoji devenu `` + accents retirés | `🔎 Rechercher un employé (nom, username, poste, téléphone)…` |
| + 14 autres lignes | `Mes employes`, `Parametres`, `Deconnexion`, `Ajouter un employes`, `Créez…taches`… | accents restaurés |

- **Méthode :** restauration des 2 fichiers depuis `HEAD`, puis réapplication de la réparation d'encodage (B2). Vérification ligne à ligne : **16 différences purement accentuelles + 9 différences de contenu**, toutes conformes à l'intention (énumérées ci-dessus).

### B4 — 🟡 Accessibilité : 2 listes déroulantes sans nom accessible

- `PartEmployes/employe.html:63` — `<select id="taskS">` (filtre de statut des tâches) : `aria-label="Filtrer les tâches par statut"`.
- `PartEmployes/employe.html:73` — `<select id="incidentS">` (filtre d'état des incidents) : `aria-label="Filtrer les incidents par état"`.
- Le champ voisin `#taskQ` avait déjà son `aria-label` : ces deux listes étaient le seul angle mort.

### B5 — 🟡 `meta viewport` absente

- `PartAgence/second_Mode/index.html:5` — page déclarée `lang="fr"` et en UTF-8 mais sans viewport → rendu dézoomé sur mobile. Ajout de `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
- C'était la **seule** page des 47 à la manque (les 46 autres sont conformes).

### B6 — 🟡 Caractères corrompus dans 3 fichiers (dont 1 déjà commité)

| Fichier:Ligne | Texte corrompu | Texte restauré |
|---|---|---|
| `PartAgence/second_Mode/mode2.js:4` | `(MODЕ 2)` — **E** cyrillique U+0415 | `(MODE 2)` |
| `server/scripts/tests/auth.test.js:422,424` | `un jeton hachǸ … est crǸǸ en base` | `un jeton haché … est créé en base` |
| `server/scripts/tests/bictorys.test.js:235,237` | `propriǸtaire … immeubles) <U+FFFD>?" … exposǸ, Ultra archivǸ` | `propriétaire … immeubles) — … exposé, Ultra archivé` |
| `server/scripts/tests/bictorys.test.js:307,309` | `5 formules propriǸtaire` | `5 formules propriétaire` |

- **Origine :** pour `bictorys.test.js`, l'historique git montre que la ligne d'origine (`544d9a2`) portait `—` et `propriétaire` : la corruption date de la réécriture « 4 plans → 5 formules ». `mode2.js` était déjà corrompu dans `HEAD`.
- **Re-scan :** 0 `U+FFFD`, 0 Latin Extended-A/B, 0 cyrillique, 0 grec dans les `.html/.js/.css/.json` du dépôt.

---

## C. Vérifications négatives (re-exécutées le 29/09)

| Contrôle | Périmètre | Résultat |
|---|---|---|
| **Références** (`<link>`, `<img>`, `<script src>`, `href`, `src`) | 47 pages, **731 références** | **0 cassée** — les 9 alertes sont 8 littéraux de template (`${escapeAttr(...)}`) et `/api/auth/google` (route existante, `server/routes/auth.js:729`) |
| **Cibles DOM** (`getElementById`, `querySelector`, `id`) | toutes les pages | **0 cible introuvable** |
| **Routes API** | **211 routes** côté serveur ↔ **71 chemins** appelés par le front | **0 vrai 404** — les 63 résolus + 8 restants s'expliquent par le préfixe `${API}` non résolu par le scan (`/api/mandat/*`, `/api/agence/bien/:id/*`, `/api/onboarding/*`) et par `/api/health` défini dans `server/app.js:253` hors `router.` |
| **XSS / interpolations `innerHTML`** | **633 interpolations**, suspects isolés | **0 faille** : `textContent`/`setText`/`dataset` pour les sorties dynamiques, `escapeHtml`/`escapeAttr` pour le HTML, libellés et compteurs statiques ailleurs ; `en_attente_confirmation` est bien un `.length` côté serveur (`server/routes/employes.js:130`) |
| **Formulaires** | **38 `<form>`** | **38/38 câblés** (`onsubmit`, `CrudPage` ou `addEventListener('submit')` + référence à l'id du formulaire) |
| **Accessibilité** | 47 pages | **0 champ** sans `label for` ni `aria-label` (labels enveloppants acceptés), **0 `<img>` sans `alt`**, **0 `<button>` sans nom accessible** |
| **Métadonnées** | 47 pages | `lang`, `charset`, `viewport`, `title` présents sur **47/47** |
| **`id` en double** | 47 pages | 1 occurrence : `#payEmpCancel` ×2 dans `PartProprietaires/paiements.html:902,912` → **faux positif** (branches d'un ternaire mutuellement exclusives, jamais les deux dans le DOM) |
| **Encodage** | tous `.html/.js/.css/.json` | **0** séquence mojibake, **0** `U+FFFD`, **0** caractère hors Unicode attendu |
| **`eval` / `new Function` / `document.write` / `setTimeout(string)`** | 8 espaces | **0** |
| **Secrets, jetons, `Bearer …`** | fichiers HTML/JS côté client | **0** |
| **CDN / ressources tierces** | 8 espaces | **0** (aucun `cdn\|unpkg\|jsdelivr\|googleapis\|cloudflare`) |
| **`localStorage` sensible** | 8 espaces | **0** (cf. §E) |
| **`insertAdjacentHTML`** | 8 espaces | **0** |

---

## D. Dettes techniques restantes (aucun impact runtime aujourd'hui)

1. **10 pages chargent `crud.js` sans `form-utils.js`.**
   `PartAgence/first_Mode/{dashboard,messages,notifications,portefeuille,versements}.html`, `PartAgence/second_Mode/bien.html`, `PartProprietaires/{dashboard,import,notifications,parametres}.html`.
   *Analyse :* `crud.js` ne fait qu'**exposer** `const CrudPage = { … }` — `clearFormErrors()`, `applyServerErrors()`, `showToast()` ne sont appelés qu'à l'intérieur des méthodes `CrudPage`. Or **aucune** de ces 10 pages ne mentionne `CrudPage` : le code n'est jamais exécuté → **pas de `ReferenceError` possible aujourd'hui**. Les 8 pages qui appellent réellement `CrudPage.init/load` chargent bien `form-utils.js` + `api.js` (vérifié).
   *Risque :* première activation de `CrudPage` sur l'une de ces pages = `ReferenceError`. *Action :* ajouter `<script src="/form-utils.js">` (et `api.js`) ou retirer l'inclusion `crud.js`.

2. **`#payEmpCancel` déclaré deux fois dans la source** (`PartProprietaires/paiements.html:902` et `:912`) — faux positif aujourd'hui (ternaire), mais HTML invalide et piège si les branches divergent. *Action :* id distinct (`payEmpClose`) ou suppression de l'id sur la seconde.

3. **CSP avec `script-src 'self' 'unsafe-inline'`** (`server/app.js`) : indispensable aux scripts inline du HTML, donc **inefficace contre l'injection de script**. *Action :* extraire les scripts inline (dette 4) puis retirer `unsafe-inline`, ajouter `frame-src 'none'` et `upgrade-insecure-requests`.

4. **Duplication des espaces.** `PartProprietaires/api.js` ≡ `PartAgence/first_Mode/api.js` ; `crud.js` dupliqué ; `formatDate`/`formatMois`/`fmtFCFA`/`badge` réimplémentés dans `admin.js`, `ultra.js`, `employe.js`, `mim-ui.js`. C'est la **cause racine** des bugs 1, 4 et 5 du 27/09 : toute correction doit aujourd'hui être appliquée 4 fois.
   *Action :* noyau commun (`mim-errors.js` = sécurité minimal, `mim-ui.js` = rendu) + fichiers de configuration d'espace.

5. **Fichiers monolithes + scripts inline.** `PartProprietaires/paiements.html` ≈ 49 ko, `employes.html` ≈ 43 ko, `locataires.html` ≈ 34 ko, avec jusqu'à ~500 lignes inline. *Action :* extraire vers des `.js` dédiés (modèle déjà en place avec `crud.js` / `api.js`).

6. **Garde-fous statiques incomplets.** `lint`/`typecheck`/`test:syntax` passent (138 fichiers) mais ne détectent ni les `ReferenceError` d'exécution (bug 1 du 27/09, bug B1), ni les doublons d'`id`, ni un helper chargé par une page qui ne l'inclut pas. `quality.mjs` couvre déjà migrations, XSS, `innerHTML`, schéma de référence, démarrage et configuration.
   *Action :* ajouter (a) définition-vs-chargement des helpers par page, (b) doublons d'`id` hors branches conditionnelles, (c) présence de `meta viewport`.

7. **Tests de rendu frontend inexistants.** `package.json` ne prévoit que `test:syntax` + `test:e2e` (serveur). *Action :* un test « la page se rend sans exception » aurait attrapé le bug critique du 27/09 et `showToast` (B1) immédiatement.

8. **`catch` silencieux** (commentés mais muets) : `PartProprietairesShadow/dashboard.js`, `PartAgence/second_Mode/{scope,mode2,bien}.js`, `PartUltraAdmin/ultra.js`, `PartPublic/sidebar.js:29`. *Action :* `console.warn` en dev + message utilisateur via `MIM.showError`.

---

## E. Points forts

- **Échappement centralisé.** `escapeHtml` **et** `escapeAttr` dans `PartPublic/mim-errors.js` (lignes 9 et 35), déclarés **une seule fois** pour tout le projet ; règle appliquée sur la totalité des interpolations HTML auditées.
- **CSRF réellement appliqué.** `await MIM._csrfReady` + `MIM.csrfHeader()` dans toutes les couches `fetch`, doublé de `csrfOriginGuard` côté serveur.
- **Sessions par cookies, sans jeton côté JS.** Aucun JWT/secret en JS ou `localStorage` ; `localStorage` sert uniquement au flag d'onboarding, `sessionStorage` au seul scope « bien » de l'agence.
- **La sécurité ne repose pas sur le JavaScript.** `authenticatePage()` + `requireZone(...)` par espace sur chaque dossier protégé, `Cache-Control: no-store`, CSP, `X-Robots-Tag`, `Permissions-Policy`, HSTS, `.htaccess` défensif.
- **Zéro ressource externe.** Aucun CDN, aucune police tierce → pas de SRI à maintenir, pas de risque supply-chain navigateur.
- **38 formulaires sur 38 câblés**, avec validation client + `applyServerErrors` / `formFieldError` pour les erreurs serveur.
- **Bonnes pratiques à étendre :** `csvCell()` anti form-injection à l'export (`admin.js:479-483`), `MIM.httpsUrl()` contre les `javascript:` dans les `href`, `MIM.linkify` (liens cliquables des notifications, **échappé avant** de transformer les URL), sorties non-HTML en `textContent`, messages d'erreur centralisés (`MIM.MESSAGES` / `MIM.userMessage`).

---

## F. Inventaire des modifications (24 fichiers, non commités)

**Corrections de cette session (§B) :**
`PartLocataires/LocaDash.js` · `PartEmployes/employe.html` · `PartAgence/second_Mode/index.html` · `PartAgence/second_Mode/mode2.js` · `PartProprietaires/{biens,employes,import,incidents,interventions,locataires,notifications,parametres,prestataires}.html` · `server/scripts/tests/auth.test.js` · `server/scripts/tests/bictorys.test.js`

**Travail antérieur déjà présent dans l'arbre de travail (conservé tel quel) :**
`PartPublic/{index.html,mim-errors.js}` (tarification landing, `MIM.linkify`, handler `pageshow`) · `PartProprietaires/{dashboard.js,notifications.js}` · `PartAgence/first_Mode/{dashboard.js,notifications.js}` · `PartEmployes/employe.js` · `server/routes/auth.js` (lien de récupération déposé en notification) · `server/scripts/quality.mjs` · `server/scripts/tests/auth.test.js`

**Vérifications finales :** `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run test:syntax` ✅ (138 fichiers JS chacun) — re-scan des 7 domaines d'audit : **0 anomalie résiduelle**.
