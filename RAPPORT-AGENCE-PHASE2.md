# RAPPORT D'ARCHITECTURE — PHASE 2 : SYSTÈME AGENCE

> Date : 23 septembre 2026
> Projet : MIM (`C:\xampp\htdocs\MIM2.1\MIM`)
> Suite de : `RAPPORT-AGENCE-PHASE1.md` (analyse). Ce document tranche le modèle et l'architecture avant toute écriture.
> Statut : **aucun fichier de code modifié**.

---

## 1. Décisions adoptées (issues de la Phase 1)

| # | Question | Décision |
|---|---|---|
| **1** | Modèle de possession des biens gérés | **Modèle « mandat »** : le propriétaire géré **reste le `user_id`** de ses lignes métier (biens, logements, locataires…) ; l'agence n'y accède **que** via des tables d'association + vérification serveur. Permet le portefeuille multi-propriétaires, les versements et l'isolation stricte. Pas de colonne `agence_id` sur les tables métier (compatible GRANT colonne-par-colonne existant). |
| **2** | MODE 2 (dashboard d'un bien) | **Réutilisation des fichiers JS du dashboard propriétaire avec commutation de base API** (`MIM.apiBase`) ; pages HTML propres dans `PartAgence/second_Mode/` (sidebar adaptée + bannière bien + bouton « ← Retour au Dashboard Agence »). Pas de double code métier. |
| **3** | Versements / messages | **Créés dès la PHASE 3** (tables `versements`, `messages`) ; les flux associés en PHASE 9. |
| **4** | Comptes « propriétaire géré » | **Créés par l'agence** selon le pattern « compte auto » déjà en place pour les employés (`INITIAL_PASSWORD`, username imprévisible, `must_change_password=true`). Le propriétaire géré a ensuite son propre accès (PROPRIÉTAIRE classique). |

Rappels anchor au code existant :
- `requireRole('proprietaire','agence','entreprise')` couvre déjà l'agence sur toutes les routes owner — on **n'y touche pas**.
- Les listes du CRUD générique filtrent par `user_id` OBLIGATOIREMENT ; on ajoute un **nouveau** chemin `/api/agence/*` (au lieu de modifier `crud.js` — risque de régression nul sur l'espace propriétaire).

---

## 2. Modèle de données (nouvelles tables — PHASE 3)

Toutes les nouvelles tables suivent les conventions du projet : `id bigserial PK`, `user_id uuid NOT NULL → auth.users CASCADE`, RFC `created_at`, RLS activée, GRANT par colonnes.

### 2.1 `agences_proprietaires` — rattachement agence ↔ propriétaire géré
| Colonne | Type | Contrainte |
|---|---|---|
| `id` | bigserial | PK |
| `user_id` | uuid NOT NULL → auth.users CASCADE | le **compte agence** (propriétaire de l'association, = `agence_id`) |
| `agence_id` | uuid NOT NULL → auth.users CASCADE | dénormalisé `= user_id` (cohérence C&L `auth.uid() = user_id`) |
| `proprietaire_id` | uuid NOT NULL → auth.users CASCADE | le propriétaire géré |
| `statut` | text NOT NULL DEFAULT 'actif' | CHECK ∈ (`actif`,`inactif`) |
| `created_at` | timestamptz DEFAULT now() | |
| **UNIQUE** | | `(agence_id, proprietaire_id)` |

### 2.2 `agences_biens` — rattachement agence ↔ bien géré (pattern `employes_biens`)
| Colonne | Type | Contrainte |
|---|---|---|
| `id` | bigserial | PK |
| `user_id` | uuid NOT NULL → auth.users CASCADE | compte agence |
| `agence_id` | uuid NOT NULL → auth.users CASCADE | dénormalisé `= user_id` |
| `proprietaire_id` | uuid NOT NULL → auth.users CASCADE | **dénormalisé depuis `biens.user_id`** (jamais fourni par le client) |
| `bien_id` | bigint NOT NULL → `biens(id)` CASCADE | le bien géré |
| `statut` | text NOT NULL DEFAULT 'actif' | CHECK ∈ (`actif`,`retire`) |
| `created_at` | timestamptz DEFAULT now() | |
| **UNIQUE** | | `(agence_id, bien_id)` |

Trigger (optionnel) : remplir `proprietaire_id` depuis `biens.user_id` à l'insertion — le serveur le fait de toute façon (sécurité par construction).

### 2.3 `versements` — versements agence → propriétaire géré
`id bigserial PK` ; `user_id` (agence), `agence_id`, `proprietaire_id` (→ auth.users, SET NULL), `bien_id bigint → biens SET NULL` ; `montant numeric(12,2) CHECK > 0` ; `periode text` (ex. `2026-09`) ; `statut text DEFAULT 'attente' CHECK (attente,en_cours,effectue,annule)` ; `methode_paiement`, `reference`, `note` ; `effectue_a timestamptz`, `effectue_par uuid` ; `created_at`. Index récapitulés en PHASE 3.

### 2.4 `messages` — messagerie agence ↔ propriétaire géré
`id bigserial PK` ; `agence_id`, `proprietaire_id` (→ auth.users, SET NULL) ; `auteur_id uuid` (expéditeur) ; `lu_par_destinataire boolean DEFAULT false` ; `objet text` ; `corps text NOT NULL` ; `created_at`.

> **Aucune modification des tables métier existantes** (`biens`, `logements`, …) : les GRANT colonne-par-colonne et policies actuels restent intacts.

---

## 3. RLS & privilèges (PHASE 3 — migration `XXXX_agence.sql`)

Principe : **tous les accès agence passent par le serveur (`serviceClient`) avec vérification de mandat fail-closed** ; la RLS n'ajoute que ce dont l'utilisateur direct a besoin.

| Table | Policies |
|---|---|
| `agences_proprietaires` | `agence_all_agences_proprietaires` FOR ALL `USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())` ; `proprietaire_select_own_liaison` FOR SELECT `USING (proprietaire_id = auth.uid())` |
| `agences_biens` | idem (agence ALL + propriétaire SELECT) |
| `versements` | `agence_all_versements` FOR ALL `USING (user_id = auth.uid()) WITH CHECK` ; `proprietaire_select_own_versements` SELECT `USING (proprietaire_id = auth.uid())` |
| `messages` | `agence_all_messages` FOR ALL `USING (user_id = auth.uid()) WITH CHECK` ; `proprietaire_select_own_messages` SELECT `USING (proprietaire_id = auth.uid())` |

GRANT : `authenticated` → SELECT global + UPDATE par colonnes non sensibles ; INSERT/DELETE réservés `service_role` (toutes les écritures côté serveur). Séquences GRANTée à `authenticated`/`service_role`. Aucune policy nouvelle sur les tables métier existantes.

---

## 4. Backend (PHASE 4)

### 4.1 Sécurité : nouvelles routes TOTALE— `server/routes/agence.js`, montées par `app.js` :
```
/api/agence   → authenticate + requireActive + requireRole('agence')
```
- Le traffic MODE 1 + MODE 2 passe **intégralement** par ce routeur, avec **`serviceClient()`** et un contrôle de **mandat serveur** :
  - `mandateBien(req, bienId)` → retourne la ligne `agences_biens` (avec `proprietaire_id`) si `agence_id = req.user.id AND statut='actif'`, sinon **403**. **Jamais de `user_id`/`proprietaire_id` fourni par le client** : le propriétaire est résolu depuis le bien.
  - `mandateOwner(req, proprietaireId)` → vérifie `agences_proprietaires` avant toute action au nom d'un propriétaire.
- **Bonus régression** : `crud.js`, `stats.js`, `employes.js`, `validations.js`, `moyensPaiement.js` restent **inchangés** pour les propriétaires.

### 4.2 Endpoints agence
**MODE 1 (global)**
- `GET /portefeuille` → biens gérés (join `agences_biens` + `biens` + nom du propriétaire) + totaux.
- `GET /proprietaires` ; `POST /proprietaires` (création compte auto propriétaire + liaison) ; `PUT /proprietaires/:id` ; `POST /proprietaires/:id/biens` (crée un bien **au nom du propriétaire**, `user_id = proprietaire_id`, + liaison `agences_biens`).
- `GET /stats` → dashboard global : nb biens gérés, logements, locataires, loyers (expected/paid/late), versements en attente, messages non lus.
- `GET/POST /messages` ; `PUT /messages/:id/lu` ; `POST /messages/:id/read`.
- `GET/POST /versements` ; `POST /versements/:id/effectuer`.
- `GET /employes`, `POST /employes` → réutilise la logique existante (le compte agence est un owner → `/api/employes` déjà fonctionnel ; on expose un proxy scoping si besoin).

**MODE 2 (bien) — contrat de commutation de base**
- `GET /bien/:bienId/contexte` → `{ bien, proprietaire, permissions }` (vérifie le mandat ; sert de bootstrap).
- `GET /bien/:bienId/stats/dashboard` → mêmes champs que `/api/stats/dashboard`, **filtrés sur le bien** (mandat vérifié).
- `GET/POST /bien/:bienId/<table>` + `PUT/DELETE /bien/:bienId/<table>/:id` pour **logements, locataires, paiements, incidents, prestataires, interventions**, shape de réponse **identique au CRUD générique** (→ le JS propriétaire est réutilisé tel quel après commutation de base).
- `GET /bien/:bienId/paiements` + `POST /bien/:bienId/paiements/:id/valider|refuser` ; `GET /bien/:bienId/moyens-paiement` ; `GET /bien/:bienId/notifications` (optionnel).
- Validation `validateResource`/`sanitize` : exportés depuis `crud.js` et réutilisés (aucune duplication de règles).

### 4.3 Zones pages
- `app.js` : `/PartAgence` → `authenticatePage` + `requireZone('agence')` (strictement agence).
- `routes/auth.js` `PAGE_BY_TYPE.agence` → `PartAgence/first_Mode/index.html` (une fois le MODE 1 construit ; conservé tel quel tant que MODE 1 absent).

---

## 5. Frontend (PHASES 5→7)

### 5.1 Mécanique de réutilisation (« base swap »)
- `PartProprietaires/api.js` : ajout **additif** — `window.MIM.apiBase = API` (défaut `/api`) et `apiRequest` construit `${MIM.apiBase}${path}`. Aucun changement de comportement sans contexte agence.
- `PartAgence/second_Mode/scope.js` : posé **avant** le JS métier → `MIM.agenceBien = { id, nom }` (lu dans `?bien=` ou sessionStorage) puis `MIM.apiBase = '/api/agence/bien/' + id`.
- Résultat : `biens.js`, `crud.js`, `locataires.js`, `paiements.js`, `dashboard.js`… **reservés** dans `second_Mode` avec un simple changement de base ; affichage, validations front et messages d'erreur identiques.

### 5.2 Arborescence
```
PartAgence/
  first_Mode/                     ← MODE 1 (PHASE 5)
    index.html                    ← landing (contexte agence)
    dashboard.html/js             ← stats globales
    biens.html/js                 ← portefeuille (clic → MODE 2)
    proprietaires.html/js         ← gestion propriétaires gérés
    versements.html/js
    messages.html/js
    abonnements.html/js           ← réutilise /api/subscription/me
    style.css                     ← variante agence (thème)
  second_Mode/                    ← MODE 2 (PHASE 7)
    scope.js                      ← commutation MIM.apiBase + contexte
    bien.html                     ← lobby du bien (stats scoped + liens)
    logements.html  locataires.html  paiements.html  incidents.html
    prestataires.html  interventions.html  notifications.html
    moyens-paiement.html
    (chacun : sidebar adaptée = bannière bien + « ← Retour au Dashboard Agence »,
     puis <script src="../PartProprietaires/xxx.js">)
```
- Partagés réutilisés : `PartPublic/sidebar.js` (logout centralisé + collapse), `PartPublic/dash-fx.js`, `PartPublic/mim-errors.js/css`, `PartProprietaires/style.css` (avec overrides agence), `PartProprietaires/crud.js`.

### 5.3 Navigation (PHASE 6)
- MODE 1 `biens.html` → clic sur un bien → `../second_Mode/bien.html?bien=<id>` (le serveur valide le mandat au `contexte` avant tout affichage).
- MODE 2 → « ← Retour au Dashboard Agence » → `../first_Mode/index.html` (+ `MIM.apiBase` remis à `/api`).

---

## 6. Abonnement Agence (PHASE 10)

- L'agence garde sa ligne `subscriptions` (`user_id` = agence) et le plan `agence` (25 immeubles) — **la contrainte s'applique au portefeuille géré** (total `agences_biens` actifs) et aux logements/locataires **agrégés sur ces biens** (fonction serveur `enforceAgenceCapacities`, analogue aux `enforce*` existants, read dans `plans`).
- **Double gate** : à la création d'un bien au nom d'un propriétaire, respecter **aussi** le plan du propriétaire (`biens.user_id` = propriétaire → ses capacités s'appliquent naturellement, fail-closed).
- Page `abonnements.html` dans `first_Mode` réutilise `/api/subscription/me` (+ `augmentStatus`) tel quel.

---

## 7. Contrat d'isolation (règle d'or)

1. Tout accès agence est **serveur + mandat vérifié** (`agences_biens`/`agences_proprietaires`), jamais un `id` front.
2. `user_id` des lignes créées pour un bien géré = **id du propriétaire résolu en base** (jamais `req.user.id` pour ces biens, jamais celui fourni par le client).
3. Le propriétaire géré accède à ses données via les policies owner existantes ; l'agence via ses propres policies (aucun chevauchement d'UID).
4. Les tests E2E d'isolation couvrent : agence ≠ autres agences, agence ≠ propriétaires non liés, propriétaire ≠ biens de l'agence hors mandat.

---

## 8. Déroulé des phases 3→12

| Phase | Contenu | Livrable |
|---|---|---|
| 3 | Migration `agence.sql` (4 tables + policies + grants) ; régénérer `supabase-schema.sql` | BDD OK |
| 4 | `routes/agence.js`, mandate, zone `/PartAgence`, `PAGE_BY_TYPE` | Backend OK |
| 5 | MODE 1 : `first_Mode/*` (dashboard global, portefeuille, propriétaires) | Espace agence utilisable |
| 6 | Navigation bien → MODE 2 (`bien.html?bien=`, contexte) | Liens OK |
| 7 | MODE 2 : pages scoped + base swap + routes `/bien/:id/*` | Réutilisation fonctionnelle |
| 8 | Propriétaire géré : compte auto + espace propriétaire + double gate plans | Cycle complet |
| 9 | Versements / stats globales / messages (routes + UI) | Flux financiers OK |
| 10 | Abonnement agence (capacités portefeuille + page) | Quotas OK |
| 11 | Design / branding (CTA « Agence », thème, responsive) | Fini |
| 12 | Suites de tests `agence*` + isolation + régénération des rapports | Validé |

---

## 9. Risques maîtrisés / à surveiller

- **Aucune modification** de `crud.js`/`stats.js`/`employes.js`/RLS métier → faible régression propriétaire (à revérifier par rejeu 576 tests après PHASE 4).
- `api.js` : changement **additif** (default base unchanged) — vérifier qu'aucune page ne lit `API` en direct hors `apiRequest` (grep en PHASE 7).
- Duplication : uniquement les HTML `second_Mode` (le JS métier est partagé) ; la duplication est volontaire et documentée.
- Garantie : chaque phase se termine par vérification ciblée avant la suivante.