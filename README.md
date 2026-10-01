# MyImmoManagement (MIM)

MIM est une application SaaS de gestion immobilière : biens, logements, locataires, échéances de loyers, incidents, prestataires, interventions, employés et abonnements.

## Prérequis

- Node.js 22 ou supérieur
- npm 10 ou supérieur
- Docker Desktop et Supabase CLI pour la base locale

## Installation et démarrage

Depuis la racine :

```bash
npm ci
npm start
```

Le serveur écoute par défaut sur `http://localhost:3000`. Le serveur Express sert également les zones frontend.

Il est aussi possible de travailler dans `server/` :

```bash
cd server
npm ci
npm start
```

Copier `server/.env.example` vers `server/.env`, puis renseigner les clés. Les fichiers `.env` sont ignorés par Git et ne doivent jamais être commités.

## Configuration

Variables principales de `server/.env` :

| Variable | Usage |
|---|---|
| `PORT` | Port HTTP, `3000` par défaut |
| `APP_URL` | URL de l'application |
| `PUBLIC_BASE_URL` | URL absolue SEO |
| `CORS_ORIGINS` | Origines séparées par des virgules |
| `JWT_SECRET` | Secret de signature des sessions, au moins 16 caractères |
| `SUPABASE_URL` | URL de l'API Supabase |
| `SUPABASE_ANON_KEY` | Clé publiable Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service réservée aux scripts serveur |
| `TRUST_PROXY` | Active la confiance proxy pour les reverse proxies HTTPS |
| `RATE_LIMIT_OFF` | Désactive les limiteurs, uniquement en développement |
| `SMTP_*` | Transport des e-mails de récupération de mot de passe |
| `BICTORYS_*` | Paiement en ligne des abonnements |
| `APP_URL`, `PUBLIC_BASE_URL` | URLs publiques HTTPS en production |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | Transport d’e-mails obligatoire en production |
| `PAYMENT_LINK_ALLOWED_HOSTS` | Allowlist optionnelle des hôtes de liens de paiement |
| `GIT_REPO_PATH`, `GIT_BRANCH`, `GIT_BIN` | Configuration de la sauvegarde Git |
| `GIT_BACKUP` | Active la sauvegarde Git avec `true` |

Les loyers et les salaires sont déclarés puis validés manuellement. Bictorys est utilisé uniquement pour le paiement de l'abonnement MIM. La simulation locale doit rester désactivée en production.

## Supabase local

Les ports de la stack locale sont définis dans `supabase/config.toml` :

| Service | URL |
|---|---|
| API | `http://127.0.0.1:64321` |
| Studio | `http://127.0.0.1:64323` |
| Mailpit | `http://127.0.0.1:64324` |
| PostgreSQL | `postgresql://postgres:postgres@127.0.0.1:64322/postgres` |

Démarrage :

```bash
cd supabase
supabase start
supabase migration up --local
```

La source de vérité du schéma est `supabase/migrations/`. Un ancien dump de référence ne doit pas être utilisé pour déduire l'état courant ni être modifié à la place des migrations.

## API

Les routes sont montées sous `/api` par `server/app.js`.

| Domaine | Routes principales |
|---|---|
| Authentification | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/forgot`, `POST /auth/reset-password` |
| Tableau de bord | `GET /stats/dashboard` |
| Ressources propriétaire | `GET|POST /biens`, `GET|POST /logements`, `GET|POST /locataires`, `GET|POST /paiements`, `GET|POST /incidents`, `GET|POST /prestataires`, `GET|POST /interventions` |
| Employés | `GET|POST /employes`, `GET /employes/mois-courant`, `GET|POST /employes/:id/paiements`, `GET|POST /employes/:id/moyens-paiement` |
| Espace employé | `GET /employe/me`, `GET /employe/dashboard`, `GET /employe/tasks`, `GET|POST /employe/incidents`, `GET /employe/paiements`, `GET|POST /employe/moyens-paiement` |
| Notifications | `GET /notifications`, `PUT /notifications/:id`, `DELETE /notifications/:id` |
| Import | `GET /import/templates/:category`, `GET /import/status`, `POST /import/preview`, `POST /import/execute`, `GET /import/progress/:runId`, `GET /import/meta`, `GET /onboarding/status` |
| Abonnement | `GET /subscription/me`, `GET /subscription/plans`, `POST /subscription/checkout`, `POST /subscription/checkout/refresh`, `GET /subscription/payments` |
| Webhook abonnement | `POST /webhooks/bictorys` |
| Sauvegarde Git | `POST /git/backup` |
| Administration | Routes `/admin/*` et `/ultra-admin/*` |
| Agence | Routes `/agence/*` pour le portefeuille et le mode bien |

Les montants, propriétaires et statuts sensibles sont relus côté serveur. Les endpoints de paiement en ligne n'activent un abonnement que après validation du webhook ou d'une réconciliation serveur.

## Comptes et mot de passe

Les comptes de locataire ou d’employé créés automatiquement reçoivent un mot de passe aléatoire à usage unique, stocké uniquement comme secret d’authentification et accompagné de `must_change_password=true`. Le changement est imposé à la première connexion. Le mot de passe n’est jamais affiché dans une documentation de production.

Les imports et les formulaires de création renvoient les identifiants temporaires dans leur réponse sécurisée afin que l'interface puisse les transmettre à l'utilisateur.

## Sauvegarde Git

La sauvegarde est désactivée par défaut. Elle nécessite `GIT_BACKUP=true` et `GIT_REPO_PATH`.

La sauvegarde Git est une sauvegarde du code, pas une sauvegarde de la base de données. Avant le commit, l’utilitaire refuse les chemins et contenus qui ressemblent à des secrets. Les opérations sont sérialisées et le push est tenté même si aucun fichier n’a changé.

## Tâche périodique des loyers

Le cron diário est lancé avec :

```bash
npm run cron:loyers
```

Le script utilise la date simulée configurée dans `system_config`, crée les échéances manquantes des locataires actifs et passe en retard uniquement les échéances encore au statut `attente` dont la date est dépassée. La mise à jour est conditionnelle au statut afin d’éviter qu’une validation concurrente soit écrasée. Une erreur de traitement termine le cron avec un code non nul. Une planification système externe reste nécessaire.

## Tests et qualité

Les scripts racine sont :

```bash
npm run test:syntax
npm run lint
npm run typecheck
npm test
npm run audit
```

`npm test` enchaîne la vérification syntaxique et la suite E2E. La suite E2E utilise l'API réelle et Supabase local. Elle refuse une base ou un endpoint distant par défaut. Pour une base distante, l’opt-in suivant exact est obligatoire :

```bash
MIM_E2E_ALLOW_REMOTE=I_UNDERSTAND_REMOTE_E2E
```

Le seed est également refusé sans opt-in dédié :

```bash
MIM_E2E_ALLOW_SEED=I_UNDERSTAND_E2E_SEED
MIM_E2E_ALLOW_LOCAL=I_UNDERSTAND_LOCAL_E2E
```

L’opt-in local est obligatoire même pour une URL locale : il faut vérifier que la base pointe vers un environnement isolé avant de lancer le seed.

Les données créées par le seed utilisent un namespace de test et les marqueurs `is_test`; le nettoyage supprime uniquement ces données et vérifie les suppressions. Les tests renvoient un code de sortie non nul en cas d'échec, de blocage ou si aucune suite n'est exécutée.

La suite peut être filtrée :

```bash
node server/scripts/tests/run.js --suite=auth
node server/scripts/tests/run.js --no-server --no-seed
```

La suite `frontend` (audit D7) exécute les 50 pages HTML dans jsdom (devDependency) : scripts résolus depuis le disque, `fetch` simulé, shims des API absentes — toute exception non catchée au chargement ou à l'init `DOMContentLoaded` fait échouer la suite. Elle détecte donc les `ReferenceError` et les pages blanches sans navigateur ; sa sensibilité est vérifiée par mutation (une `ReferenceError` injectée doit la passer au rouge).

`npm run lint` et `npm run typecheck` n'exigent pas ESLint, TypeScript ou un autre outil absent : ils utilisent le parseur JavaScript de Node et contrôlent les manifests du projet. `npm run audit` utilise l'audit npm du lockfile. `npm run lint` inclut les garde-fous d'audit (migrations, XSS/`innerHTML`, schéma de référence, helpers chargés par page, doublons d'id, viewport, encodage, fichiers dupliqués, catches silencieux, vecteurs inline sous CSP).

## Licence

Le projet est distribué sous licence MIT. Voir `LICENSE`.
