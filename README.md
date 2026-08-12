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

## Configuration

Crée le fichier `server/.env` :

```
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_ANON_KEY=votre_cle_publishable
JWT_SECRET=votre_secret
PORT=3000
APP_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://localhost
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

## Base de données

Le schéma complet se trouve dans `server/supabase-schema.sql` :

- `profiles` — profils utilisateurs (créés automatiquement par trigger à l'inscription)
- `biens`, `logements`, `locataires`, `paiements`
- `incidents`, `prestataires`, `interventions`
- `notifications`, `sessions`, `password_resets`

Chaque table est protégée par Row Level Security : un utilisateur ne voit que ses propres données.
