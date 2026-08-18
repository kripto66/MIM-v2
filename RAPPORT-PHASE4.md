# RAPPORT DE MISSION — PHASE 4 : RELIQUATS D'AUDIT (P1-7 `__new__`, m19, UNITECH_TEST_MODE)

> Date : 18 août 2026
> Projet : MIM (`C:\xampp\htdocs\MIM2.1\MIM`)
> Périmètre : dernier point P1 de l'audit non traité + arbitrages sur les points de qualité restants.

---

## P1-7 — ÉDITION D'UN LOCATAIRE SANS LOGEMENT BLOQUÉE (audit, `locataires.html`)

**Statut : CORRIGÉ** ✅

**Problème** (audit « M4 », p.111) : `openTenantEdit` mettait `logement_id` à `"__new__"` pour un locataire sans logement, **mais** masquait `logementFields` et n'appelait jamais `onLogementSelectChange()` → la validation exige `lg_nom` + `loyer_mensuel` (invisibles) → toute édition d'un locataire sans logement était impossible.

**Correction** (`PartProprietaires/locataires.html:455`) : `el("logementFields").style.display = "none"` remplacé par un appel à `onLogementSelectChange()` — le champset suit désormais le mode réel :
- mode `__new__` (aucun logement) → champs « nouveau logement » **visibles** + réinitialisés (appartement, chambres, loyer) ;
- mode logement existant → champset masqué, loyer/hint gérés comme avant (édition conservée intacte).

Le serveur gère déjà `logement_new` au PUT (`crud.js:711-715`) — rien à changer côté backend.

**Vérification live** (6 nouveaux checks navigateur, tous PASS) :
1. Locataire sans logement créé via l'API (session propriétaire réelle).
2. Édition : `logement_id` = `__new__` ✓
3. **`logementFields` visible (block)** ✓
4. Un bien sélectionnable ✓
5. Soumission réelle → le locataire reçoit un `logement_id` en base ✓
6. Le logement créé porte le loyer saisi + `bien_id` correct ✓

(Données du test supprimées après vérification ; ordre de suppression locataire→logement pour éviter la FK.)

---

## m19 — CLÉ `intervention` DANS `INCIDENT_LABEL` (LocaDash.js)

**Statut : NON APPLICABLE (code mort réfuté)** ⚪

L'audit considérait la clé `intervention` comme jamais produite. Analyse complète :

- Le statut `intervention` est **légal** côté base : `incidents_statut_check = ('nouveau','en_cours','intervention','resolu')` (supabase-schema.sql:232).
- Le **propriétaire** peut passer un incident en « Intervention » (`incidents.html:117` — `<option value="intervention">`).
- Le dashboard locataire renvoie les incidents **sans filtre de statut** (`locataire.js:444-454`) → un incident `intervention` atteint l'espace locataire, où `badgeStatut(statut, "incident")` (LocaDash.js:62, incidents locataire :322/365, LocaDash :325) affiche la clé.

La clé est donc **atteignable** : la retirer aurait affiché « intervention » en brut aux locataires. **Aucun changement.**

---

## UNITECH_TEST_MODE (audit P2 §13)

**Statut : GARDE POUR LE DEV, FAIL-CLOSED EN PROD** ⚪

`unitech.js:320-341` : le mode test (webhook simulé `POST /unitech/webhook`) n'activé que si `UNITECH_TEST_MODE=true` ; sinon la route renvoie **404**. C'est déjà fail-closed : il suffit de ne **pas** définir la variable en production. En dev, elle est requise par la suite de tests automatiques `unitech` (83/83 PASS). Aucun changement de code — action de déploiement documentée.

---

## RÉSULTATS DES TESTS

### Tests automatisés (`server/scripts/tests/run.js`)
| Indicateur | Valeur |
|---|---|
| Suites exécutées | 17 |
| Tests | **576/576 PASS** |
| Échecs / Bloqués | **0 / 0** |

### Tests navigateur live (puppeteer-core + Chrome, viewport 1400×900)
Parcours A→E inchangés (propriétaire, locataire, employé, `a_confirmer`, 2FA) **+ 6 nouveaux checks P1-7 audit** (édition locataire sans logement, ci-dessus).

**Total : 90/90 PASS.**

---

## ÉTAT D'AVANCEMENT GLOBAL

| Phase | Contenu | Résultat |
|---|---|---|
| 1 | P0 critiques (employé, paiements, confirmer, infra) | ✅ validée |
| 2 | P1-1…P1-6 (2FA/change-password/current_password, Wave, locataire bien_id, RLS) | ✅ 82/82 nav + 576/576 |
| 3 | P2-1…P2-16 + P1-7 logout (qualité, sécurité, schéma) | ✅ 84/84 nav + 576/576 |
| 4 | P1-7 audit (`__new__`), arbitrage m19, note UNITECH | ✅ 90/90 nav + 576/576 |

**Tous les points de `RAPPORT-AUDIT.md` sont traités ou arbitrés.**

---

## COMMIT

Correctif `locataires.html` intégré par l'auto-sauvegarde : commit `454fc5f` (working tree propre). Ce rapport : commit dédié.