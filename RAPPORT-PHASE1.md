# RAPPORT DE MISSION — PHASE 1 : CORRECTIFS P0

> Date : 17 août 2026
> Projet : MIM (`C:\xampp\htdocs\MIM2.1\MIM`)
> Périmètre : les 4 problèmes critiques P0 identifiés par l'audit (`RAPPORT-AUDIT.md`).

---

## P0-1 — ESPACE EMPLOYÉ INACCESSIBLE (404 `/api/api/...`)

**Statut : CORRIGÉ** ✅

**Problème (audit m1/m2)** : la base d'URL de l'API employé (`PartEmployes/employe.js`, `E.base`) se terminait par `/api` alors que les constantes `E.*` commençaient déjà par `/api/...`. Tous les appels partaient en `/api/api/employe/...` → 404 généralisé (dashboard, tâches, incidents, salaires, etc.).

**Correction** (`PartEmployes/employe.js`) :
- `E.*` ne contiennent plus le préfixe `/api` : `/employe/me`, `/employe/dashboard`, `/employe/tasks`, `/employe/incidents`, `/employe/interventions`, `/employe/logements`, `/employe/locataires`, `/employe/paiements`, `/employe/notifications`, `/employe/notifications/read-all`, `/employe/profile`, `/employe/password`.
- Déconnexion : `E.logout = "/auth/logout"` (route réelle, vérifiée dans `server/routes/auth.js`).

**Vérification** :
- Toutes les routes backend correspondantes existent et sont montées (`/api/employe/*`, `/api/auth/logout`, `/api/upload/avatar` POST/DELETE).
- Tests navigateur live : connexion employé, dashboard, biens affectés, locataires, incidents + résolution, salaires + confirmation, profil, déconnexion — **aucun 404**.
- Tests automatisés : 576/576 PASS.

---

## P0-2 — PAGE PAIEMENTS PROPRIÉTAIRE QUI CRASHE

**Statut : CORRIGÉ** ✅

**Problème (audit m3/m4)** : `PartProprietaires/paiements.html` utilisait `CrudPage.init()` qui exige l'élément `config.addBtnEl` (`#addPaiementBtn`) — élément absent du DOM → `CrudPage.init` levait une exception au chargement → plus aucun gestionnaire attaché (liste des paiements, onglets, moyens, salaires tous morts). En parallèle, `escapeAttr` était appelée mais non définie (exploit XSS potentiel via le champ `lien_paiement`).

**Correction** (`PartProprietaires/paiements.html`) :
- Bouton `#addPaiementBtn` ajouté dans la barre d'actions de la section paiements.
- Fonction utilitaire `escapeAttr()` ajoutée (échappement des guillemets pour les attributs HTML).

**Vérification** :
- Page chargée sans erreur JS ; toutes les listes se chargent (`pendingList`, historique, moyens, employés) ; onglets fonctionnels.
- CRUD complet d'un moyen de réception via l'UI : création, désactivation/réactivation, modification, suppression — vérifié en base à chaque étape (tests live 67/67).
- Tests automatisés : 576/576 PASS.

---

## P0-3 — FLUX LOCATAIRE « À CONFIRMER » INCOMPLET

**Statut : CORRIGÉ** ✅

**Problème (audit m5/m6)** : le backend disposait déjà de la route `POST /api/locataire/paiements/:id/confirmer` (webhook UnitechPay → `statut = 'a_confirmer'`), mais aucune interface locataire n'offrait le bouton de confirmation : le paiement restait bloqué en `a_confirmer`, sans notification propriétaire ni validation possible.

**Correction** :
- `PartLocataires/LocaDash.js` : branche `a_confirmer` dans le rendu du paiement courant (carte + bouton réel `data-confirm-payment`), listener délégué sur `document` qui appelle `POST /api/locataire/paiements/:id/confirmer`, désactivation du bouton (anti double-clic), re-rendu du dashboard après succès.
- `PartLocataires/paiements.html` : branche `a_confirmer` dans `renderPayer()` (carte `.payer-card.pending`, badge `.status.info`, bouton `data-confirm-payment`), extension du handler `payerContent` (POST + `reloadPage()`, bouton réactivé en cas d'erreur).

**Vérification (tests live, flux complet) :
- Webhook simulé (service role) : paiement → `a_confirmer`.
- UI locataire (dashboard ET page paiements) : carte « À confirmer » + bouton réel présents.
- Clic : `en_validation`, notification propriétaire créée, interface actualisée.
- Tests négatifs : double confirmation → 400 « Paiement déjà confirmé » ; id inexistant → 404 ; paiement d'un autre locataire → 404 (le paiement d'autrui reste inchangé).
- Validation propriétaire depuis `paiements.html` : `paye` + `validated_at` + `validated_by` ; échéance suivante gérée (anti-doublon confirmé : 2026-08 déjà présente avant/après).
- Tests automatisés : 576/576 PASS.

---

## P0-4 — CONTENEUR `supabase_vector_MIM` EN BOUCLE DE REDÉMARRAGE

**Statut : CORRIGÉ** ✅

**Problème (audit m18)** : le conteneur `vector` (agent de logs Logflare, image `public.ecr.aws/supabase/vector:0.53.0-alpine`) ne peut pas joindre le socket Docker sous Windows (`tcp connect error code 111 Connection refused`, `mounts=[]`, pas de `/var/run/docker.sock`) → il s'arrête immédiatement et redémarre en boucle (restart policy `unless-stopped`). Ce conteneur ne sert qu'aux analytics.

**Correction** (`supabase/config.toml`) :
- `[analytics] enabled = true → false` (avec commentaire expliquant le pourquoi).
- `supabase stop` puis `supabase start` : la stack redémarre depuis le backup, le conteneur `vector` n'est plus créé.

**Vérification** :
- `docker ps` : 10 conteneurs healthy (db, kong, auth, rest, storage, realtime, studio, pg_meta, inbucket, edge_runtime), conteneur vector absent, plus aucune boucle de redémarrage.
- Aucune dépendance de MIM aux analytics : le code ne référence aucune table analytics ; bases présentes dans postgres : `template0/1, postgres, _supabase, storage_vectors` (pas de `analytics`).
- API : `GET /api/health` → `{"success":true,"message":"MIM API OK"}`.
- 20 tables du schéma `public` intactes après redémarrage.

---

## RÉSULTATS DES TESTS

### Tests automatisés (`server/scripts/tests/run.js`, exécutés depuis `server/`)
| Indicateur | Valeur |
|---|---|
| Suites exécutées | 17 (auth, crud, isolation, relations, stats, security, concurrency, final, admin, abonnement, unitech, declarations, import, locataires, salaires, vierge, simplif) |
| Tests | **576/576 PASS** |
| Échecs | **0** |
| Bloqués | **0** |

### Tests navigateur live (puppeteer-core + Chrome, parcours réels)
| Partie | Parcours | Résultat |
|---|---|---|
| A — Propriétaire | connexion, dashboard, paiements (chargement, boutons réels), CRUD moyens complet (créer/modifier/activer/désactiver/supprimer, vérifié en base), onglet salaires, création employé auto (identifiants générés), incidents, déconnexion | ✅ |
| B — Locataire | connexion (avec changement de mot de passe imposé le cas échéant), signalement d'un incident (UI + base) | ✅ |
| C — Employé | connexion username/1234, changement forcé de mot de passe, dashboard, biens affectés, locataires, incident du bien affecté visible + résolution réelle (statut `resolu`, `resolved_by`, notification propriétaire), moyen de réception ajouté, salaire déclaré par le propriétaire → confirmé par l'employé (`paye` + `confirmed_at`), profil mis à jour, déconnexion | ✅ |
| D — Locataire | flux `a_confirmer` complet (webhook simulé → UI « À confirmer » sur dashboard et page paiements → confirmation → `en_validation` + notification propriétaire), tests négatifs (double clic 400, id invalide 404, paiement d'autrui 404), validation propriétaire → `paye` + `validated_at` + échéance suivante, page profil, déconnexions | ✅ |

**Total : 67/67 PASS.**

---

## NOTES COMPLÉMENTAIRES (constatées pendant la validation live)

1. **Bouton « Déconnexion » mort sur certaines pages propriétaire** : `incidents.html`, `paiements.html`, `prestataires.html`, `import.html`, `biens.html`, `interventions.html` n'attachent aucun gestionnaire à `#logoutBtn` (seuls `employes.html`, `locataires.html`, `notifications.html`, `parametres.html` le font). Impact : l'utilisateur ne peut pas se déconnecter depuis ces pages. → **À traiter en Phase 2 (P1-7)**.
2. **Méthode de paiement forcée à « Wave » à l'ouverture de la modal de paiement propriétaire** (`onOpenEdit`/`onOpenAdd` de `paiements.html`) : la méthode existante est écrasée en édition. → **P1-3, corrigé en Phase 2**.
3. Le changement de mot de passe des locataires est bien imposé par le flag `must_change_password` (comportement attendu du seed).

---

## COMMIT

Les correctifs P0 ont été intégrés au dépôt par le mécanisme d'auto-sauvegarde du projet au moment de la connexion de `owner1@mimtest.com` pendant les tests (commit `e978854`), working tree propre.