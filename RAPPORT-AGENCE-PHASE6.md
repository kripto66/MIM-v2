# RAPPORT PHASE 6 — Navigation MODE 1 → MODE 2 (scope + lobby du bien)

Livré le 23/09/2026 · seed du plan (RAPPORT-AGENCE-PHASE2.md, §5.3 et §8).

## Objectif
Ouvrir la navigation vers la gestion d'un bien géré : chaque bien du MODE 1
mène vers `../second_Mode/bien.html?bien=<id>` (lobby scoped), qui valide le
mandat serveur via `/contexte` avant tout affichage. Préparer la mécanique
de **base swap** (`scope.js`) qui permettra à la PHASE 7 de réutiliser le JS
propriétaire tel quel.

## Fichiers créés

| Fichier | Contenu |
|---|---|
| `PartAgence/second_Mode/scope.js` | **Fixation du scope** : lit `?bien=` (ou `?id=`, historique), mémorise en `sessionStorage` (`mim_agence_bien_v1`), restaure le dernier bien sinon ; pose `MIM.agenceBien = {id, nom}` et **commute `MIM.apiBase`** sur `/api/agence/bien/<id>` (lu par `api.js` au chargement). Expose `agenceBack()` et le marqueur `MIM.agenceMode2`. Ordre d'inclusion : `scope.js` → `api.js` → `crud.js` → page. |
| `PartAgence/second_Mode/index.html` | Entrée MODE 2 (nav sidebar) : redirige vers `bien.html?bien=<dernier bien>` ou vers `first_Mode/portefeuille.html` si aucun. |
| `PartAgence/second_Mode/bien.html` + `bien.js` | **Lobby du bien** : bandeau (nom/type/ville/adresse, propriétaire géré), KPI scoped via `GET /bien/:id/contexte` + `GET /bien/:id/stats/dashboard`, grille de raccourcis vers les pages MODE 2 (PHASE 7). Chaque lien de sous-page reçoit `?bien=<id>` (injecté par `exposeMode2Links`) pour conserver le scope au changement de page. |

## Fichiers modifiés (MODE 1 — alignement `?bien=`)
- `first_Mode/dashboard.js`, `portefeuille.js`, `proprietaires.js` :
  liens « Gérer ce bien » → `../second_Mode/bien.html?bien=<id>` (au lieu de `?id=`).

## Vérifications effectuées (serveur :3100)
- **Smoke PHASE 6 : 15/15 PASS** — `bien.html?bien=` 200 avec session
  (et redirigé sans session), assets servis, `/contexte` → bien + stats,
  `/stats/dashboard` scoped → champs KPI, `index.html` redirige bien,
  contexte d'un bien inconnu → **403** (fail-closed).
- **Régression frontend MODE 1 : 20/20 PASS** ; **régression API 32/32 PASS**.
- `node --check` : `scope.js`, `bien.js` et JS first_Mode → OK.

## Notes
- Les pages MODE 2 (logements, locataires, paiements, incidents,
  prestataires, interventions, notifications) sont **annoncées** dans la
  sidebar et la grille du lobby mais créées en PHASE 7 (404 jusqu'à alors),
  conformément au plan.
- `first_Mode/index.html` et la bascule `PAGE_BY_TYPE.agence` restent
  planifiés pour la fin de PHASE 11 (aucun impact sur les E2E).

## État
- PHASE 6 **terminée**. Prochaine étape : PHASE 7 — `second_Mode/` pages
  scoped ré-utilisant le JS propriétaire (base swap + sidebar « bannière bien »).