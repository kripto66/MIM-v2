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
et le serveur fait confiance à un reverse proxy (Vercel/Nginx) si
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

## Sauvegarde automatique

À chaque **connexion** et **déconnexion** :
1. La session est enregistrée dans la table `sessions` (Supabase)
2. Une sauvegarde git (commit + push) est automatiquement créée

## Tâche périodique (loyers)

À lancer quotidiennement (cron externe : crontab, Vercel Cron, GitHub Actions…) :

```
cd server && npm run cron:loyers
```

Le script `server/scripts/checkLoyers.js` :
1. crée l'échéance du mois courant pour chaque locataire actif qui n'en a pas ;
2. passe en « retard » les échéances « attente » dont le jour `jour_echeance` est dépassé, et notifie le locataire.

Nécessite `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` dans `server/.env`.

## Base de données

Le schéma complet se trouve dans `server/supabase-schema.sql` :

- `profiles` — profils utilisateurs (créés automatiquement par trigger à l'inscription)
- `biens`, `logements`, `locataires`, `paiements`
- `incidents`, `prestataires`, `interventions`
- `notifications`, `sessions`, `password_resets`

Chaque table est protégée par Row Level Security : un utilisateur ne voit que ses propres données.
