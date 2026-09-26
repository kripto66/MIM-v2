# RAPPORT PHASE 4 — Backend agence (MODE 1 + MODE 2)

Livré le 23/09/2026 · seed du plan (RAPPORT-AGENCE-PHASE2.md).

## Objectif
Implémenter l'API backend de l'espace Agence, entièrement scoped au
modèle « mandat » (fail-closed), sans modifier les routes propriétaires
(zéro régression) et en réutilisant les utilitaires existants.

## Fichiers modifiés / créés

| Fichier | Type | Contenu |
|---|---|---|
| `server/routes/agence.js` | **créé** | Routeur `/api/agence` (MODE 1 + MODE 2) |
| `server/routes/crud.js` | modifié | `export` additif de `sanitize` et `validateResource` (réutilisées par l'agence) |
| `server/app.js` | modifié | Montage `/api/agence` (authenticate + requireActive + requireRole('agence')) ; zone statique `/PartAgence` (authenticatePage + requireZone('agence')) ; `/PartAgence` ajouté aux prefixes protégés (noindex) et au `robots.txt` |
| `server/seo-config.js` | modifié | `/PartAgence` ajouté à `NOINDEX_PATHS` |
| `PartProprietaires/api.js` | modifié | **Base swap additif** : `API` utilise `window.MIM.apiBase` (défaut `/api`) — prérequis MODE 2, aucun changement de comportement par défaut (`apiRequest` → `/api/...` inchangé) |

## Points d'entrée livrés

### MODE 1 (dashboard global agence)
| Route | Description |
|---|---|
| `GET /portefeuille` | Biens gérés (mandats actifs) avec propriétaire, logements_count, occupés, loyer_total |
| `GET /stats` | Totaux (biens, propriétaires, logements, locataires), loyers attendu/encaissé/retard du mois, versements en attente, messages non lus |
| `GET /proprietaires` | Propriétaires gérés + biens_count |
| `POST /proprietaires` | Création d'un propriétaire géré **avec compte d'auth** (pattern « compte auto » : username aléatoire, `INITIAL_PASSWORD`, `must_change_password=true`, trigger `handle_new_user` pour le `profiles`) + liaison `agences_proprietaires` + notification |
| `POST /proprietaires/:id/biens` | Création d'un bien **au nom du propriétaire géré** (mandat vérifié) + liaison `agences_biens` |

### MODE 2 (scoped sur un bien géré — mêmes formes que `/api/crud`)
| Route | Description |
|---|---|
| `GET /bien/:bienId/contexte` | Bootstrap : bien, propriétaire, stats agrégées |
| `GET /bien/:bienId/stats/dashboard` | Même shape que `/api/stats/dashboard` (dashboard.js réutilisable) |
| `GET/POST/PUT/DELETE /bien/:bienId/{logements,locataires,paiements,incidents,interventions}[/:id]` | CRUD scoped : `user_id` = propriétaire du mandat (résolu en base), colonnes de rattachement forcées au bien, refs croisées vérifiées (logement/locataire/incident/prestataire) |
| `GET /bien/:bienId/paiements-validation/en-attente` | Déclarations du bien en attente (avec noms locataire/logement) |
| `POST /bien/:bienId/paiements-validation/:id/valider` | Règles identiques à `validations.js` : statut `en_validation`→`paye`, `creerEcheanceSuivante`, notification locataire |
| `POST /bien/:bienId/paiements-validation/:id/refuser` | Statut `refuse` + motif obligatoire + notification locataire |
| `GET /bien/:bienId/prestataires` | Liste lecture seule (non scoped par bien : table sans bien_id) |

## Garanties de sécurité (fail-closed)
- `proprietaire_id` **jamais** lu depuis le corps de requête : résolu via
  `agences_biens` (`mandateBien`) puis re-vérifié contre `biens.user_id`.
- Toutes les écritures passent par `serviceClient()` (service_role) ;
  c'est le code serveur qui fixe `user_id`, `bien_id`, `logement_id`.
- Refs croisées (locataire↔logement, paiement↔locataire/logement,
  intervention↔incident/prestataire) contrôlées : portée propriétaire + bien.
- Validation réutilisée : `sanitize`/`validateResource` de `crud.js`.
- Doubles paiements : interdit par la contrainte unique en base (409).

## Vérifications effectuées
- `node --check` sur `agence.js`, `crud.js`, `app.js` : OK.
- Exports réels confirmés : `creerEcheanceSuivante`/`formatMois`/`notify`/
  `tenantUidOfLocataire`/`logementNomOf`/`uniqueUsername`/`splitFullName`/
  `INITIAL_PASSWORD`/`tenantEmailFor`/`usernameIsValid`/`passwordRuleError`/
  `gitAutoBackup` — signatures conformes.
- `PAGE_BY_TYPE.agence` **inchangé** (→ `PartProprietaires/dashboard.html`) :
  aucun impact sur les E2E existants (complet.test.js).
- **Migration appliquée** : `20260923000000_agence.sql` poussée sur le
  Supabase local via `psql` (docker `supabase_db_MIM`) puis vérifiée
  (4 tables, RLS activé, 8 policies). PostgreSQL a refusé de la jouer via
  `supabase migration up` (4 migrations anciennes absentes de l'historique
  local) : appliquée en direct, celle-ci est strictement additive.
- **Smoke test E2E runtime** (`scripts/agence.smoke.mjs`, serveur raccordé au
  Supabase local) : **32/32 PASS**, couvrant register agence → MODE 1
  (portefeuille, stats, propriétaire compte auto, création bien) → MODE 2
  (contexte, CRUD logements + héritage adresse, stats/dashboard, locataire +
  refus du 2ᵉ actif, échéance + validation, refus avec motif obligatoire,
  anti-doublon, mois futur interdit, liste « à valider ») → **fail-closed** :
  une 2ᵉ agence reçoit 403 sur le bien et un portefeuille vide.

## Notes pour la suite
- PHASE 5 : écrire `PartAgence/first_Mode/` en s'appuyant sur ces endpoints.
- PHASE 6/7 : `scope.js` posera `MIM.apiBase = '/api/agence/bien/<id>'` pour
  réutiliser `crud.js`/`dashboard.js`/`paiements.html` tels quels.
- PHASE 8/9 : endpoints `versements` et `messages` (tables déjà dans la
  migration PHASE 3) — hors périmètre de la PHASE 4 pour rester testable.