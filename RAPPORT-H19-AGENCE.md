# RAPPORT H-19 — Module agence : aucun compte orphelin

Livré le 30/09/2026 · suite de la PHASE 7 (RAPPORT-AGENCE-PHASE7.md).
Suite de tests : `server/scripts/tests/agence.test.js`.

## Objectif

Invariant **H-19** : toute création de compte via le module agence est
atomique du point de vue métier — si une étape suivante échoue
(rattachement, lien de gestion, validation), le compte est **remboursé**
(profil + liens cascadeent depuis `auth.users`) et il ne reste **jamais un
compte orphelin** dont les identifiants ne sont retournés à personne.

## Résultat des tests

Exécution du 30/09/2026 (base Supabase locale, serveur :3100) :

| Suite | Résultat |
|---|---|
| `agence` | **15 / 15 PASS** |
| `crud` (non-régression) | **54 / 54 PASS** |
| `mandat` (non-régression) | **38 / 38 PASS** |
| `test:syntax` | **139 fichiers OK** |

Avant correctifs : `agence` = 11 PASS / 5 FAIL.

## Anomalie n°1 — rollback H-19 qui échoue silencieusement (bug produit)

**Symptôme** : `[tenantAccount/test-h19] rollback du compte … :
Database error deleting user`, suivi d'un `profiles` fantôme persistant
(échec du test « rollback supprime le compte Auth ET son profil »).

**Cause racine** : la migration
`supabase/migrations/20260927100000_quota_essai.sql` ajoute le trigger
`mim_trial_subscription_on_signup` (`AFTER INSERT ON public.profiles`) qui
insère une souscription **essai 14 jours** pour tout compte
`proprietaire` / `agence` / `entreprise`. Or
`subscriptions_user_id_fkey … REFERENCES auth.users(id) ON DELETE
RESTRICT` : `auth.admin.deleteUser()` échoue, la compensation ne supprime
donc rien, et le compte reste en place — **violation directe de H-19**.

Les tables concernées par ce blocage (`ON DELETE RESTRICT` vers
`auth.users`) sont : `subscriptions`, `abonnement_paiements`,
`paiements_employes`, `paiements`, `versements`.

**Correctif** — `server/utils/tenantAccount.js` :

- nouvelle fonction `deleteAuthAccount(sb, userId, contexte)` : purge
  préalable des lignes des 5 tables RESTRICT (colonne `user_id` partout),
  puis `deleteUser()`. Ne lève jamais, journalise chaque échec ;
- `rollbackCreatedAccount()` (compensation H-19) délègue à cette
  fonction — le rollback supprime désormais réellement le compte ;
- export `deleteAuthAccount` réutilisable par les routes.

**Correctif** — `server/routes/agence.js` (ligne du `provisionProfile`
en échec) : le `deleteUser` brut `.catch(() => {})` sur un compte
propriétaire, qui échouait de la même manière de façon invisible, est
remplacé par `deleteAuthAccount()`.

Les autres sites (`crud.js`, `employes.js`, `importCsv.js`) ne créent que
des comptes locataire/employé, qui ne reçoivent pas de souscription
d'essai — non impactés, laissés inchangés.

## Anomalie n°2 — test d'abonnement en `INSERT` (bug de test)

**Symptôme** : `duplicate key value violates unique constraint
"subscriptions_user_unique"`, puis **3 tests de quotas ratés** en cascade
(`IMMEUBLES_LIMIT_REACHED`, `LOGEMENTS_LIMIT_REACHED`,
`LOCATAIRES_LIMIT_REACHED` obtenus en 201/400 au lieu de 409).

**Cause racine** : le test créait le propriétaire 2 puis `INSERT`ait sa
souscription de test — mais le trigger d'essai l'avait déjà créée (voir
anomalie n°1). L'insertion échouait, le plan de test (`max_immeubles: 1`,
`max_logements: 1`, `max_locataires: 1`) n'était donc **jamais appliqué**,
et les vérifications de quota laissaient tout passer.

**Correctif** — `server/scripts/tests/agence.test.js` :

- `insert` → **`upsert` avec `onConflict: 'user_id'`** ;
- le `plan_id` est lu puis écrasé avec celui du plan de test : sans cela,
  `planForSubscription()` (server/utils/plans.js:46) privilégie `plan_id`
  et retiendrait l'essai — le plan de test ne s'appliquerait toujours pas.

**Note** : le compte total de tests affiché passe de 16 à 15. Ce n'est pas
une perte : le test « abonnement du propriétaire 2 inséré »
(`agence.test.js:336`) n'enregistre un résultat **qu'en cas d'échec**
(`if (subErr) r.fail(...)`). Le 16ᵉ résultat était l'échec de
configuration, devenu inutile.

## Incident infrastructure rencontré pendant la validation

Les premières exécutions ont échoué hors du code applicatif :
`supabase_db_MIM` s'est fait tuer (exit 137, mémoire libre à 228 Mo /
7,9 Go) — symptômes : requêtes à 22 s puis `Database connection error`,
`statement timeout` systématiques, `auth.users` en 504 pendant le wipe.

Actions : redémarrage de `supabase_db_MIM` (crash recovery PostgreSQL OK),
redémarrage de `supabase_auth_MIM` et `supabase_rest_MIM` (conteneur
zombie), arrêt de `supabase_realtime` / `supabase_edge_runtime` /
`studio` / `pg_meta` (209–261 % CPU en boucle de health-check). Latences
revenir à 41 ms–1 s.

À surveiller : la machine ne dispose que de ~8 Go pour Docker Desktop +
applications, et `mim_trial_subscription_on_signup` repousse chaque
inscription propriétaire vers une souscription d'essai — les comptes de
test s'accumulent en lignes `subscriptions` entre deux wipes.

## Fichiers modifiés

| Fichier | Modification |
|---|---|
| `server/utils/tenantAccount.js` | `AUTH_RESTRICT_TABLES` + `purgeAuthLinkedRows()` + nouvelle `deleteAuthAccount()` ; `rollbackCreatedAccount()` délègue à celle-ci. |
| `server/routes/agence.js` | import de `deleteAuthAccount` ; remplacement du `deleteUser` brut du `provisionProfile` en échec. |
| `server/scripts/tests/agence.test.js` | souscription du propriétaire 2 : `insert` → `upsert` avec `plan_id` explicite. |

## Vérifications effectuées

- `npm run test:syntax` : 139 fichiers OK.
- `--suite=agence` : **15/15 PASS** (était 11/16).
- `--suite=crud` : **54/54 PASS** (non-régression sur la création de
  locataire avec compte et ses compensations).
- `--suite=mandat` : **38/38 PASS** (non-régression sur les routes
  agence modifiées).

Commande de lancement (opt-ins requis, la base est wipe/seedée) :

```
MIM_E2E_ALLOW_SEED=I_UNDERSTAND_E2E_SEED
MIM_E2E_ALLOW_LOCAL=I_UNDERSTAND_LOCAL_E2E
node scripts/tests/run.js --suite=agence
```
