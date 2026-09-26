# RAPPORT PHASE 5 — Frontend agence MODE 1 (`PartAgence/first_Mode/`)

Livré le 23/09/2026 · seed du plan (RAPPORT-AGENCE-PHASE2.md).

## Objectif
Construire l'interface web de l'espace Agence **MODE 1** (vue globale) :
dashboard (KPI + portefeuille + propriétaires + notifications),
portefeuille, gestion des propriétaires (création de compte + biens),
notifications et abonnement. Le tout branché sur `/api/agence/*` et
réutilisant les patterns visuels/JS du dashboard propriétaire.

## Fichiers créés (`PartAgence/first_Mode/`)

| Fichier | Type | Contenu |
|---|---|---|
| `dashboard.html` + `dashboard.js` | nouveau | Vue globale : KPI (`/agence/stats`), actions (versements à reverser, retards, messages non lus), portefeuille récent, propriétaires récents, notifications (marquer lu / supprimer / tout lu), bandeau abonnement, auto-refresh 1 min / 3 min |
| `portefeuille.html` + `portefeuille.js` | nouveau | Liste complète des biens gérés (`/agence/portefeuille`) : logements, occupation, loyers cumulés, propriétaire rattaché, lien « Gérer ce bien » |
| `proprietaires.html` + `proprietaires.js` | nouveau | Liste des propriétaires gérés (`/agence/proprietaires`), **création avec compte auto** (identifiants générés affichés/copiés), déroulé des biens du propriétaire, **création d'un bien au nom du propriétaire** (`POST /agence/proprietaires/:id/biens`), focus via `?proprietaire=` |
| `notifications.html` + `notifications.js` | copies adaptées | Copie du pattern propriétaire (endpoints génériques `/notifications`) |
| `abonnements.html` + `abonnements.js` | copies adaptées | Copie (`/subscription/*`, plans « agence » inclus) |
| `api.js` (copie) | asset | `API` respecte `window.MIM.apiBase` (swap MODE 2) |
| `crud.js` (copie) | asset | Helpers partagés |
| `style.css` (copie) | asset | Même habillage que `PartProprietaires` |

Scripts globaux : `/mim-errors.js`, `/PartPublic/form-utils.js`,
`/PartPublic/sidebar.js` (aucun nouveau fichier partagé nécessaire).

## Décisions
- Une seule copie de `style.css` dans `first_Mode` (espace autonome) ;
  pas de couplage CSS inter-zones.
- Le lien « Gérer un bien (Mode 2) » et les boutons « Gérer ce bien »
  pointent vers `../second_Mode/…` (URL du plan) — **routes inactives
  jusqu'à la PHASE 6/7**, signalé dans la nav et les cartes.
- `PAGE_BY_TYPE.agence` reste inchangé (→ `PartProprietaires/dashboard.html`)
  : le basculement vers `PartAgence/first_Mode/index.html` est prévu en fin
  de PHASE 11 (aucun impact E2E avant cela). L'entrée prévue `index.html`
  sera ajoutée lors de la bascule.

## Vérifications effectuées (smoke E2E, serveur sur :3100)
- **Frontend : 20/20 PASS** — pages `200` avec `<title>` correct, assets
  servis, accès non authentifié redirigé, `PartAdmin` interdit à l'agence,
  endpoints MODE 1 répondent dans la forme attendue.
- **Régression API : 32/32 PASS** (scénario PHASE 4 rejoué sans modification).
- `node --check` des fichiers JS produits : OK.

## État
- PHASE 5 **terminée**. Prochaine étape : PHASE 6 (`PartAgence/scope.js` —
  bootstrap du scope bien + swap `MIM.apiBase`), puis PHASE 7
  (`second_Mode/` pages réutilisées, base swap).