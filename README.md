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
| GET | `/api/import/templates/:cat` | Télécharger le modèle CSV d'une catégorie (`biens`, `logements`, `locataires`, `employes`) |
| POST | `/api/import/preview` | Validation + aperçu avant import (doublons, usernames générés) |
| POST | `/api/import/execute` | Exécuter l'import (création des biens, logements, comptes locataires/employés) |
| GET | `/api/import/meta` | Métadonnées de l'import (dictionnaire catégories/labels/colonnes) |

## Import CSV et onboarding propriétaire

À sa première connexion, le propriétaire est accueilli par un assistant
(`PartProprietaires/onboarding.js`) qui propose soit d'**importer ses données**
via des modèles CSV (`PartProprietaires/import.html`, wizard en 5 étapes), soit
de **configurer manuellement** son espace (parcours existant, inchangé). La
section « Importation / Exportation » des paramètres permet de relancer
l'import à tout moment.

Détails :

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

## Sauvegarde automatique

À chaque **connexion**, **déconnexion** et **écriture**, une sauvegarde git
(commit + push) est lancée de manière **non bloquante** (le requête n'attend pas)
et **sérialisée** (une seule opération git à la fois, pas de conflit d'index).

La sauvegarde est **désactivée en production** (`NODE_ENV=production`) sauf si
`GIT_BACKUP=true` est défini — le binaire git et les identifiants GitHub n'y
existent pas forcément.
Variables optionnelles : `GIT_BIN` (chemin du binaire git, sinon `git` du PATH),
`GIT_REPO_PATH` (dépôt), `GIT_BRANCH` (défaut `master`).

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

## Base de données

Le schéma complet se trouve dans `server/supabase-schema.sql` :

- `profiles` — profils utilisateurs (créés automatiquement par trigger à l'inscription)
- `biens`, `logements`, `locataires`, `paiements`
- `incidents`, `prestataires`, `interventions`
- `notifications`, `sessions`, `password_resets`

Chaque table est protégée par Row Level Security : un utilisateur ne voit que ses propres données.
