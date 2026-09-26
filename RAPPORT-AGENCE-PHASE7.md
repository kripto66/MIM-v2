# RAPPORT PHASE 7 — MODE 2 : sous-pages du bien géré

Livré le 23/09/2026 · suite de la PHASE 6 (RAPPORT-AGENCE-PHASE6.md) ;
conforme au plan §5.2 (RAPPORT-AGENCE-PHASE2.md).

## Objectif
Créer les sous-pages `second_Mode/` de gestion d'un bien géré : **logs,
locataires, paiements, incidents, prestataires, interventions, notifications**,
toutes scoped sur le bien via la **base swap** (`scope.js` → `MIM.apiBase`)
et l'infra partagée `mode2.js`. Le JS propriétaire est réutilisé tel quel
(`../PartProprietaires/*.js`) ; seule la page, le scope et la sidebar changent.

## Fichiers créés

| Fichier | Contenu |
|---|---|
| `second_Mode/mode2.js` | **Infra commune PHASE 7**, incluse APRÈS `scope.js` et AVANT `api.js`. Elle : (1) **shim `/auth/*`** — `apiRequest()` ré-aiguille `/auth/verify-password` et `/auth/logout` vers la base globale `/api` (sinon le base swap les enverrait vers `/api/agence/bien/<id>/auth/...` → 404) ; (2) injecte `?bien=<id>` sur tous les liens `.html` de la sidebar (scope conservé au changement de page) ; (3) renomme « Le bien » avec le nom du bien courant ; (4) affiche la **bannière bien** (`#bienBanner`) via `GET <scoped>/contexte` (propriétaire géré + nom du bien) ; (5) redirige vers `../first_Mode/dashboard.html` si aucun bien n'est posé. |
| `second_Mode/logements.html` | **CRUD scoped dédié** (nouveau, pas d'équivalent standalone côté propriétaire) : `CrudPage.init({ resource: "logements" })`, champs nom/type/nombre_chambres/adresse/loyer_mensuel/statut. L'adresse vide est héritée du bien (serveur). Toggle « type = chambre » (masque le nombre de chambres). |
| `second_Mode/locataires.html` | Adaptation scoped de la page propriétaire : **pas de sélecteur/état global** des biens, logement rattaché au bien courant (existant `logement_id` / nouveau `logement` / édition `logement_update`), formulaire unique avec création auto de compte locataire (`autoAccount`), saisie du mot de passe via `confirmPassword` → `/auth/verify-password` (global, via shim), **modal de résultats** (username/mot de passe initial/échéance). Scripts : `scope.js → api.js → crud.js → mode2.js → form-utils.js` + inline. |
| `second_Mode/paiements.html` | Version scoped : **« Paiements à valider »** (`/paiements-validation/en-attente`, valider/refuser avec motif) + **historique CRUD** (`paiements`, filtre `statut !== "en_validation"`). **Sections retirées** : onglets employés, moyens de paiement (non scopables), barre d'onglets. Modal paiement avec méthode attendue + montant + mois (mois futur refusé serveur). |
| `second_Mode/incidents.html` | Copie adaptée : sidebar MODE 2 + `mode2.js`, JS réutilisé `../PartProprietaires/incidents.js`, statuts nouveau/en_cours/intervention/resolu. |
| `second_Mode/prestataires.html` | **Lecture seule** (seule route scoped = `GET /prestataires`) : liste des prestataires du propriétaire géré, bouton « Planifier » → `interventions.html?prestataire=<id>`. |
| `second_Mode/interventions.html` | CRUD scoped `interventions` : sélecteurs incidents/prestataires/logements chargés via les routes scoped (`/incidents`, `/prestataires`, `/logements`), statuts planifie/en_cours/termine, date prévue. |
| `second_Mode/notifications.html` | **Notifications GLOBALES** de l'utilisateur agence : **`api.js` chargé AVANT `scope.js`** (commenté dans le HTML), donc `MIM.apiBase` reste `/api` et l'API vise `/api/notifications`. `scope.js` tourne quand même pour la sidebar `?bien=`. |

## Serveur — modifications (`server/routes/agence.js`)
- **`refBelongsToScope` réparé** : la version précédente sélectionnait
  `user_id, bien_id` pour TOUTES les tables de référence — or `incidents`,
  `interventions`, `paiements` **n'ont pas de colonne `bien_id`** (ils sont
  rattachés au bien via `logement_id`) → erreur PostgREST captée par le
  catch fail-closed → « introuvable ou hors de votre portée ». Désormais,
  `logements`/`locataires` → contrôle sur `bien_id` ; `incidents`/
  `interventions`/`paiements` → contrôle sur l'appartenance de leur
  `logement_id` aux logements du bien ; autres → `user_id` seul.
- **Parité `scopedUpdate` ↔ PUT générique`** : un locataire du bien peut
  embarquer `logement_new` (création du logement DANS le bien géré, adresse
  héritée du bien, statut occupe/libre selon le locataire) et
  `logement_update` (mise à jour du logement + re-synchronisation des
  échéances ouvertes via `syncMontantEcheancesOuvertes`, import dynamique).
  Correctif : la condition `Number(upd.loyer_mensuel) !== undefined` remplacée
  par `upd.loyer_mensuel !== undefined` puis restructuration pour exécuter
  l'update logement même sans changement de loyer.
- **Invariant occupation** ajouté au PUT scoped (déjà présent au POST) : un
  logement = un seul locataire actif.
- Rappel : pare-feu, commandes POST scoped de création d'un paiement en
  attendant la validation, `paiements-validation/{en-attente,valider,refuser}`,
  `GET /prestataires` lectures uniquement.

## CSS
- `first_Mode/style.css` : classes `.shortcut-grid` / `.shortcut-card`
  (grille de raccourcis de `bien.html`, PHASE 6) ajoutées — elles étaient
  utilisées sans style.

## Vérifications effectuées (serveur :3100, supabase local)
- **Smoke PHASE 7 : 30/30 PASS** (`agence.mode2.phase7.smoke.mjs`) :
  - 8 pages MODE 2 servies (200, sidebar + `mode2.js`) ;
  - CRUD scoped `logements` (création + liste) ;
  - POST scoped `locataires` sur logement existant / **2e locataire actif same
    logement → 400** ;
  - **PUT scoped locataire + `logement_new`** → 200 ;
  - paiements : POST en_validation, `en-attente`, `paiements`, **valider** ;
  - incidents + interventions (création + liste) ;
  - prestataires (lecture) ;
  - notifications globales `/api/notifications` ;
  - `/auth/verify-password` global ;
  - bien inconnu → **403** (fail-closed).
- **Régressions** : PHASE 6 MODE 2 15/15 PASS · frontend MODE 1 20/20 PASS ·
  API 32/32 PASS.
- `node --check server/routes/agence.js` → OK.

## Décisions
- **`moyens-paiement.html` écarté** (plan §5.2, PHASE 7). Raisons : il
  n'existe ni page standalone côté propriétaire (c'est une section de
  `paiements.html`) ni route scoped `GET /bien/:bienId/moyens-paiement`
  (le plan §4.2 marquait cette route « optionnel » et la table
  `moyens_paiement` n'a pas de lien au bien). Les moyens de paiement restent
  gérés au niveau global propriétaire, hors périmètre d'un bien géré.
- **`prestataires.html` en lecture seule** : la table `prestataires` n'a pas de
  colonne `bien_id` (scope = propriétaire géré) ; création/modification
  restent la prérogative du propriétaire géré (cohérent avec `crud.js`
  `ownerOnly`).
- **Notifications MODE 2 ≠ scoped** : les notifications concernent
  l'utilisateur agence, pas le bien → base globale (`api.js` avant `scope.js`).

## État
- PHASE 7 **terminée**. Étapes suivantes planifiées : PHASE 8+ (styling
  premier_Mode agent, reverse paiements aux propriétaires gérés), etc.