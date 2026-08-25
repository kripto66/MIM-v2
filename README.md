# MyImmoManagement (MIM)

SaaS de gestion immobilière : logements, locataires, paiements, incidents, prestataires, interventions.

## Architecture

- **Frontend** : HTML / CSS / JavaScript (dossiers `PartPublic` et `PartProprietaires`)
- **Backend** : Node.js + Express (`server/`)
- **Base de données** : Supabase (PostgreSQL) avec Row Level Security

## Démarrage

```bash
cd server
npm install
npm start
```

Le serveur écoute sur `http://localhost:3000`.

Le CORS n'autorise que les origines listées dans `CORS_ORIGINS`. Sans cette
variable, le CORS est désactivé : l'application doit alors être servie par ce
même serveur (même origine). En production, les cookies sont marqués `Secure`
et le serveur fait confiance à un reverse proxy (Nginx…) si
`TRUST_PROXY=true` (ou `NODE_ENV=production`).

## Configuration

Crée le fichier `server/.env` :

```
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_ANON_KEY=votre_cle_publishable
JWT_SECRET=votre_secret
PORT=3000
APP_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://localhost
TRUST_PROXY=true
GIT_REPO_PATH=C:\xampp\htdocs\MIM2.1\MIM
GIT_BRANCH=master
```

### Supabase local

Ce projet tourne sur une stack Supabase **locale** (pas de projet cloud). Les ports
standard (54xxx) sont réservés par Windows (Hyper-V) sur cette machine, ils sont
donc configurés en `64xxx` dans `supabase/config.toml` :

| Service   | URL |
|-----------|-----|
| API       | `http://127.0.0.1:64321` |
| Studio    | `http://127.0.0.1:64323` |
| Mailpit   | `http://127.0.0.1:64324` |
| Base SQL  | `postgresql://postgres:postgres@127.0.0.1:64322/postgres` |

Démarrage : ouvrir **Docker Desktop**, puis depuis `supabase/` :
`supabase start`. Les clés `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` sont
affichées par `supabase status` et copiées dans `server/.env`. Les migrations
s'appliquent via `supabase migration up --local` (pas `db push`, réservé au cloud).

Le serveur Node sert aussi le frontend (`PartPublic` et `PartProprietaires`) :
l'application est accessible sur `http://localhost:3000` (l'usage via XAMPP reste possible).

## API

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Créer un compte |
| POST | `/api/auth/login` | Se connecter |
| POST | `/api/auth/logout` | Se déconnecter |
| GET | `/api/auth/me` | Profil connecté |
| POST | `/api/auth/forgot` | Demande de réinitialisation de mot de passe |
| POST | `/api/auth/reset-password` | Nouveau mot de passe (avec `code` du lien envoyé par email) |
| GET | `/api/stats/dashboard` | Statistiques du tableau de bord |
| POST | `/api/git/backup` | Sauvegarde git manuelle |
| GET | `/api/onboarding/status` | L'espace du propriétaire nécessite-t-il une première configuration ? |
| GET | `/api/import/templates/:cat` | Télécharger le modèle CSV d'une catégorie (`biens`, `logements`, `locataires`, `employes`, `grouped`) |
| POST | `/api/import/preview` | Validation + aperçu avant import (doublons, usernames générés) |
| POST | `/api/import/execute` | Exécuter l'import (création des biens, logements, comptes locataires/employés) |
| GET | `/api/import/meta` | Métadonnées de l'import (dictionnaire catégories/labels/colonnes) |
| GET | `/api/employes` | Liste des employés du propriétaire (avec `en_attente_confirmation`, `dernier_paiement`) |
| POST | `/api/employes` | Créer un employé + son compte de connexion (si `username`/`password` absents : générés automatiquement, mot de passe initial `1234` à changer à la première connexion) |
| GET | `/api/employes/:id/paiements` | Historique des salaires d'un employé (avec moyen de réception) |
| POST | `/api/employes/:id/paiements` | Déclarer un versement de salaire (`attente` → l'employé confirme) ; `paye` direct conservé |
| GET | `/api/employes/:id/moyens-paiement` | Moyens de réception **actifs** d'un employé (vue propriétaire) |
| POST | `/api/employes/:id/moyens-paiement` | Créer un moyen de réception pour un employé |
| GET | `/api/employe/paiements` | Salaires de l'employé connecté (statut, moyen, confirmations/refus) |
| POST | `/api/employe/paiements/:id/confirmer` | L'employé confirme avoir reçu son salaire (`paye` + notification propriétaire) |
| POST | `/api/employe/paiements/:id/non-recus` | L'employé signale ne pas avoir reçu le paiement (`non_recu` + motif + notification propriétaire) |
| GET | `/api/employe/incidents` | Incidents des biens affectés à l'employé (logement, locataire, statut, traces de résolution) |
| POST | `/api/employe/incidents/:id/resoudre` | Résoudre un incident de SES biens : `resolu` + `resolved_by` + `resolved_at` (heure serveur) + notification propriétaire |
| GET | `/api/employe/moyens-paiement` | Moyens de réception de l'employé connecté |
| POST | `/api/employe/moyens-paiement` | Ajouter un moyen de réception (Wave, Orange Money, virement, espèces) |
| PUT | `/api/employe/moyens-paiement/:id` | Modifier un moyen de réception (ex. `actif`, `paydunya_alias`) |
| DELETE | `/api/employe/moyens-paiement/:id` | Supprimer un moyen de réception |
| POST | `/api/paydunya/initiate` | Créer une facture PayDunya (`source: loyer` par le locataire, `source: salaire` par le propriétaire — montant/destinataire toujours relus en base) |
| GET | `/api/paydunya/status/:token` | Statut d'une facture (initiateur seul, confirmé auprès de l'API PayDunya) |
| POST | `/api/paydunya/webhook` | Webhook IPN PayDunya (hash SHA-512 du Master Key, dédup par fingerprint, pas de passage à « payé » côté client) |
| GET | `/api/paydunya/checkouts` | Sessions d'encaissement PayDunya (admin uniquement) |
| GET | `/api/paydunya/redistributions` | Redistributions PER vers les destinataires (admin uniquement, filtre `?status=`) |
| POST | `/api/paydunya/redistributions/:id/retry` | Relancer une redistribution échouée (admin uniquement) |

## Import CSV et onboarding propriétaire

À sa première connexion, le propriétaire est accueilli par un assistant
(`PartProprietaires/onboarding.js`) qui propose soit d'**importer ses données**
via des modèles CSV (`PartProprietaires/import.html`, wizard en 5 étapes), soit
de **configurer manuellement** son espace (parcours existant, inchangé). La
section « Importation / Exportation » des paramètres permet de relancer
l'import à tout moment.

Détails :

- **Mode « tout-en-un » (`grouped`)** : au lieu d'un fichier par catégorie, un
  SEUL fichier regroupe tout — chaque ligne décrit un logement (et son
  locataire éventuel, colonnes `locataire_*`) ou un employé (colonnes
  `employe_*`). Les cellules vides des colonnes structurelles (`bien`,
  `type_bien`, `adresse_bien`, `ville`, `pays`, `logement`) reprennent la
  valeur de la ligne au-dessus : les détails d'un bien ne se saisissent
  qu'à sa première ligne, sans répétition. Le fichier est découpé côté
  serveur (`server/utils/importGrouped.js`) puis traité par le moteur
  standard ; le mode est demandé via `mode: 'grouped'` sur `/preview` et
  `/execute`.
- Les modèles CSV sont téléchargeables (BOM UTF-8, séparateur `;`, en-têtes
  français, colonnes surlignées en jaune et sensibles à la casse).
- L'ordre d'import respecte les dépendances : `biens` → `logements` →
  `locataires` / `employes`.
- L'aperçu (`/import/preview`) signale ligne par ligne les erreurs, doublons et
  avertissements, et génère les usernames (`amadou.diop`, `amadou.diop2`, …).
- L'exécution (`/import/execute`) crée les biens/logements/locataires/employés
  **et** les comptes de connexion automatiquement : mot de passe initial
  `1234` (affiché dans le rapport final, téléchargeable en CSV), avec
  `must_change_password = true` → le premier login force le changement.
- Politiques de doublons : `ignore` (défaut), `abort` (refuse tout l'import),
  `update` (met à jour les champs fournis).
- Sécurité : l'import n'opère que sur les données du propriétaire connecté
  (isolation par RLS, `user_id` toujours issu de la session) ; le moteur se
  trouve dans `server/utils/importCsv.js`, les routes dans
  `server/routes/import.js`.

## Création d'un locataire (formulaire unique)

Depuis `PartProprietaires/locataires.html`, un seul formulaire « Ajouter un
locataire » crée tout ce qui est nécessaire (`POST /api/locataires` avec
`autoAccount: true`) :

- **Logement** : existant (sélectionné par bien) ou créé à la volée (nom, type,
  chambres, adresse) ; marqué `occupe` ; le loyer est toujours relu depuis
  `logements.loyer_mensuel`, jamais pris du client ;
- **Locataire** : fiche + profil ; le loyer, la date d'entrée et le
  `jour_echeance` viennent du formulaire ;
- **Compte** : username généré (`amadou.diop`, `amadou.diop2`, …), mot de passe
  initial `1234` (jamais stocké en clair, `must_change_password = true`) ;
- **Échéance initiale** : une ligne `paiements` `attente` pour le mois courant
  (montant = loyer du logement).

La première connexion force le changement du username et du mot de passe
(`PartPublic/change-password.html`). En cas d'échec intermédiaire, tout est
annulé (compensation). L'édition d'un locataire ne recrée jamais le compte.

## Création d'un employé (mode automatique)

Depuis `PartProprietaires/employes.html`, le formulaire « Ajouter un employé »
laisse les champs username / mot de passe **vides** pour activer le mode
automatique (`POST /api/employes`) :

- **Username** : généré côté serveur depuis le nom complet
  (`amadou.diop`, `amadou.diop2`, …), unique dans toute l'application
  (vérifié + index unique `profiles_username_uniq` en base) ;
- **Mot de passe initial** : `1234` (temporaire, `must_change_password = true`) ;
- **Biens affectés** : champ multi-sélection « Biens affectés » — l'employé ne
  voit que les données de SES biens (logements, locataires, incidents,
  interventions), vérifié côté serveur (aucun bien étranger accepté) et par
  RLS (`employes_biens`). Une réaffectation remplace les liaisons existantes ;
- **Compte** : créé via `auth.admin` (email interne `@mim.local`), fiche
  `employes` liée, notification envoyée à l'employé ;
- **Retour** : `201` + `account: { username, password }` → l'interface affiche
  les identifiants (bouton « Copier ») sans rechargement manuel.

Le propriétaire peut toujours fournir lui-même username + mot de passe (mode
manuel, mêmes validations qu'avant). La première connexion force le changement
du mot de passe (`PartPublic/change-password.html`) ; l'employé peut aussi
changer son username (profil `PartEmployes/employe.html` ou première
connexion, `POST /api/auth/update-username` autorise les comptes employés,
unicité vérifiée, fiche `employes` + `profiles` + email `@mim.local` mis à
jour).

## Photo de profil (propriétaire, locataire, employé)

Chaque profil (paramètres du propriétaire, profil locataire, profil employé)
permet d'uploader une vraie photo :

- **Upload** : `POST /api/upload/avatar` (base64 JSON, jpeg/png/webp, 2 Mo
  max décodés) → bucket Supabase Storage `avatars` (public), fichier nommé
  `<user_id>.<ext>`, remplacé par `upsert` (une seule photo par compte,
  anciennes extensions supprimées, jamais le fichier tout juste écrit) ;
- **Lecture** : `profiles.avatar_url` renvoyé par `/auth/me`,
  `/api/locataire/dashboard` et `/api/employe/me` ;
- **Suppression** : `DELETE /api/upload/avatar` (fichier retiré du bucket,
  `avatar_url` remis à `null`) ;
- **Défaut** : si aucune photo, un avatar par défaut (SVG ou initiale) est
  affiché, clairement distinct d'une photo réelle. Aucune fausse image.

## Import CSV et progression réelle

L'import (`/import/execute`) écrit sa progression dans l'état du serveur
(`GET /api/import/progress/:runId` et `/progress/latest`) : le frontend
(`PartProprietaires/import.js`) poll et affiche un pourcentage **réel**
(barre, `ligne(s)/s`, ETA calculés depuis le travail effectué), jamais simulé.
Le moteur traite les lignes en libérant l'event loop (`setImmediate`) pour que
le polling réponde pendant un gros import. Chaque ligne est créée avec
compensation en cas d'erreur (fiche + compte nettoyés), les erreurs sont
collectées ligne par ligne (`997 réussies / 3 erreurs`) et le rapport final
(comptes créés, usernames, mot de passe initial `1234`) est téléchargeable en
CSV. Les employés importés sont affectés au bien indiqué dans la colonne
« bien » du modèle.

## Sauvegarde automatique

À chaque **connexion**, **déconnexion** et **écriture**, une sauvegarde git
(commit + push) est lancée de manière **non bloquante** (le requête n'attend pas)
et **sérialisée** (une seule opération git à la fois, pas de conflit d'index).

La sauvegarde est **désactivée en production** (`NODE_ENV=production`) sauf si
`GIT_BACKUP=true` est défini — le binaire git et les identifiants GitHub n'y
existent pas forcément.
Variables optionnelles : `GIT_BIN` (chemin du binaire git, sinon `git` du PATH),
`GIT_REPO_PATH` (dépôt), `GIT_BRANCH` (défaut `master`).

## Paiement en ligne PayDunya (loyers, salaires, abonnements)

PayDunya remplace UnitechPay (tables `unitech_*` conservées comme archives) :

- **Loyer** : le locataire initie une facture (`source: loyer`) → paie sur la
  page PayDunya (Wave, Orange Money, carte…) → l'IPN (hash SHA-512 du Master
  Key, dédup par fingerprint) marque le loyer `paye` et MIM redistribue au
  propriétaire (PER `direct-pay/credit-account`).
- **Salaire** : le propriétaire initie une facture (`source: salaire`) → le
  salaire passe `paye` et MIM redistribue à l'employé.
- **Abonnement** : l'admin génère le lien (`PartAdmin` → Abonnements →
  « Enregistrer un paiement ») → activation/renouvellement après confirmation.
- **Destinataire de la redistribution** : `paydunya_alias` du moyen de
  réception (configurable par le propriétaire et l'employé, champ « Compte
  PayDunya »), sinon téléphone du profil, sinon email du compte auth.
- **Monitoring admin** : onglet « PayDunya » de `PartAdmin` — sessions
  d'encaissement et redistributions, avec relance manuelle des versements
  échoués (`/redistributions/:id/retry`).
- Le montant, le destinataire et le propriétaire ne viennent **jamais** du
  client : ils sont relus en base. L'IPN est re-confirmé auprès de l'API
  (source de vérité) avant tout traitement.
- Variables `server/.env` : `PAYDUNYA_MODE` (`test`/`production`),
  `PAYDUNYA_MASTER_KEY`, `PAYDUNYA_PRIVATE_KEY`, `PAYDUNYA_TOKEN`,
  `PAYDUNYA_STORE_*`, `PAYDUNYA_TEST_MODE` (webhook de test, jamais en
  production) et `PAYDUNYA_API_URL` (override, utilisé par le mock de tests).

## Tâche périodique (loyers)

À lancer quotidiennement (cron externe : crontab, GitHub Actions…) :

```
cd server && npm run cron:loyers
```

Le script `server/scripts/checkLoyers.js` :
1. crée l'échéance du mois courant pour chaque locataire actif qui n'en a pas ;
2. passe en « retard » les échéances « attente » dont le jour `jour_echeance` est dépassé, et notifie le locataire.

Nécessite `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` dans `server/.env`.

## Tests

Suite de tests bout en bout (API réelle + Supabase local) dans
`server/scripts/tests/` :

```
cd server
node scripts/tests/run.js --suite=import   # une suite
node scripts/tests/run.js                  # toutes les suites
```

Options : `--no-server` (serveur déjà lancé), `--no-seed`, `--suite=<nom>`.
La suite `import` couvre : statut d'onboarding, modèles CSV, imports biens /
logements / locataires / employés (comptes créés, mot de passe initial 1234,
`must_change_password`, usernames uniques), isolation entre propriétaires et
réimportation (doublons, politiques `abort` / `update`).
La suite `locataires` couvre le formulaire unique : création auto (logement,
compte, échéance), usernames uniques, première connexion (changement username +
mot de passe), paiement immédiat, édition sans recréation de compte, isolation
et suppression.
La suite `salaires` couvre les paiements de salaire : moyens de réception gérés
par l'employé (ajout / édition / désactivation / suppression, multiples), vue
propriétaire (actifs uniquement), déclaration de versement (`attente`),
confirmation par l'employé (`paye` + notifications des deux côtés), refus
(`non_recu` + motif), paiement direct `paye`, historique enrichi et isolation
propriétaire / employé.
La suite `vierge` couvre un **propriétaire totalement nouveau** : dashboard et
listes 100 % vides (aucune donnée fictive, tous les compteurs à 0), création
d'un locataire et d'un employé en mode automatique (username généré, mot de
passe initial `1234`, `must_change_password`, changement obligatoire puis
compte normal), unicité des usernames (3 × même nom) et isolation de ses
données.
La suite `simplif` couvre le parcours simplifié : locataire créé en une
requête avec logement embarqué (adresse héritée du bien, logement marqué
occupé), employé affecté à un ou plusieurs biens (création, remplacement,
bien étranger refusé), isolation réelle de l'employé (logements/locataires/
incidents limités à SES biens, élargissement par réaffectation), changement
de username employé à la première connexion, photos de profil (upload,
remplacement PNG→JPG, suppression) et import par lots avec progression réelle
(runId, `progress/latest`, employés importés affectés à leur bien, bien
inconnu détecté à l'aperçu). Elle couvre aussi les **moyens de paiement sans
lien** (Wave et Orange Money sans lien → lien null en base, avec lien →
conservé, édition qui efface le lien, vue locataire : nom/numéro présents et
aucun lien à ouvrir) et la **résolution d'incidents par l'employé** (il voit
les incidents de SES biens avec logement/description/date, ne voit pas ceux
des autres biens, résolution valide → `resolu` + `resolved_by` + `resolved_at`
serveur + notification propriétaire, hors périmètre → 403, déjà résolu → 400).
Elle couvre enfin le **flux complet d'un incident signalé par le locataire** :
logement déduit de la fiche (id envoyé ignoré), visible chez le propriétaire
(`GET /incidents`), invisible chez un autre propriétaire, visible chez
l'employé affecté (logement + locataire), puis résolu par lui avec
notification du propriétaire.
La suite `auth` couvre aussi la **déconnexion côté pages** : une page de zone
protégée est servie avec session (200 + `Cache-Control: no-store`), redirigée
vers la connexion (302) sans session et après logout — le bouton « retour »
du navigateur ne peut donc pas réafficher un dashboard avec une session
invalide.

## Base de données

Le schéma complet se trouve dans `server/supabase-schema.sql` :

- `profiles` — profils utilisateurs (créés automatiquement par trigger à l'inscription ; `username` unique pour les comptes locataires/employés, `must_change_password`, `avatar_url` photo de profil)
- `biens`, `logements`, `locataires`, `paiements` (le logement d'un locataire créé via le formulaire unique est créé sur la volée ; `locataires.bien_id` dénormalise le bien pour les RLS employé par bien)
- `employes`, `employes_biens` (affectation d'un employé à ses biens), `paiements_employes` (salaires : `attente` → `paye` / `non_recu`)
- `moyens_paiement` (réception des loyers), `moyens_paiement_employes` (réception des salaires)
- `incidents`, `prestataires`, `interventions` (`incidents.resolved_by` → fiche `employes`, `resolved_at` horodatage serveur de résolution par un employé)
- `notifications`, `sessions`, `password_resets`

Chaque table est protégée par Row Level Security : un utilisateur ne voit que ses propres données, et un employé uniquement les données de SES biens affectés.
