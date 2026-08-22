# PayDunya — Robustesse de bout en bout (Phase 5)

Suite de la Phase 4 (intégration fonctionnelle). Cette phase rend le
paiement en ligne **tolérant aux pannes et aux manipulations
involontaires** : notification IPN perdue, API PayDunya momentanément
indisponible, double-clics, versements refusés, alias invalides.

## 1. Architecture de réconciliation

Nouveau module : `server/utils/paydunyaReconcile.js`

Point UNIQUE où l'état d'une session est confirmé auprès de l'API
PayDunya puis répercuté sur les données MIM. Il est appelé par :

| Déclencheur | Effet |
|---|---|
| Webhook IPN (`/api/paydunya/webhook`) | traitement événementiel principal |
| `GET /api/paydunya/status/:token` | **rattrapage automatique** (polling des pages) |

Règles appliquées à chaque exécution (toutes idempotentes) :

1. Confirmation auprès de l'API (le statut annoncé n'est jamais cru sur parole).
2. Contrôle du montant confirmé = montant de la session (`amount_mismatch` sinon).
3. Jamais d'abaissement d'une session complétée ; un replay est signalé
   `already_completed` mais les effets restent rejoués sans risque.
4. Écritures conditionnelles (statut attendu) : en cas de course, une
   seule écriture « gagne » et devient responsable des notifications.
5. Pipeline loyer : paiement → échéance suivante (anti-doublon) →
   redistribution dédoublonnée par cible → notifications.
6. Pipeline salaire : paiement → redistribution employé → notifications.
7. Pipeline abonnement : historique daté une seule fois, upsert
   souscription idempotent, caches invalidés, notification unique.

## 2. Webhook renforcé

- Hash SHA-512(Master Key) obligatoire (inchangé), dédup par empreinte.
- **Échec transitoire** (API injoignable, panne DB) : le journal IPN
  reste `handled=false`, la réponse est **503** — PayDunya renverra la
  notification ; le poll de statut peut aussi rattraper entre-temps.
- Nouvelles colonnes d'audit : `paydunya_webhooks.handled_at` (horodatage
  de clôture) et `.error` (dernier message d'échec transitoire).

## 3. Sessions d'encaissement

- Index uniques PARTIELS (`20260821090000_paydunya_robustesse.sql`) :
  impossible de créer deux sessions `pending` pour la même cible.
  L'application rattrape le perdant d'une course (code 23505 → reprise
  de la facture gagnante, réponse `resumed`).
- Après annulation, une nouvelle initiation redevient possible.
- `GET /status/:token` applique la même logique que l'IPN puis renvoie
  l'état frais + un champ `reconciliation`.

## 4. Redistributions PER

- `findRedistributionForTarget` : une seule opération financière par
  paiement, quel que soit le nombre de re-traitements.
- Une redistribution existante non aboutie est **relancée**
  automatiquement au lieu d'être dupliquée.
- **Relance admin** (`POST /redistributions/:id/retry`) : l'alias ACTUEL
  du destinataire est relu — s'il a corrigé son compte PayDunya depuis
  l'échec, le versement part sur le nouvel alias.
- Notifications destinataire : « versement en attente » (après 2
  tentatives infructueuses) et « versement effectué » (après relance).

## 5. Anti-doublon salaire PayDunya

`POST /employes/:id/paiements` avec `methode_paiement='paydunya'` :
un second clic reprend la ligne existante (`attente` ou `paye`)
au lieu d'en créer une seconde (réponse 200 + même identifiant).

## 6. Alias PayDunya validés

`paydunyaAliasError()` (utils/paiementMethodes.js) : vide = autorisé,
sinon email valide ou numéro (≥ 6 chiffres, séparateurs tolérés).
Câblé sur : moyens propriétaire (POST/PUT), moyen employé créé par le
propriétaire, moyens employé (POST/PUT).

## 7. Pages de retour PayDunya

- `/paiement-succes` et `/paiement-annule` (URLs propres câblées dans
  app.js ; fichiers `PartPublic/paiement-succes.html`,
  `paiement-annule.html`, style `paiement.css`).
- Helper partagé `PartPublic/pay-status.js` : lecture du token, polling
  du statut (4 s, ~3 min max), lien de retour selon le rôle connecté.
- La page d'annulation vérifie quand même le statut réel (PayDunya
  redirige parfois vers l'annulation alors que le paiement est passé).
- Polling intégré aux interfaces : `LocaDash.html`, `paiements.html`
  (locataire) et `employes.html` (propriétaire) se rafraîchissent
  automatiquement dès confirmation.

## 8. Tests (mock PayDunya étendu)

Mock : panne de confirmation simulable (`/mock/fail-confirm`),
comptes destinataires refusant le versement (alias contenant
`.reject.`), création de facture inconnue via `/mock/pay`.

Nouvelles sections (suite paydunya : 34 → **75 vérifications**) :

1. Rattrapage par consultation de statut (IPN jamais envoyé) + échéance
   suivante + IPN tardif sans double effet.
2. Échec transitoire API → 503, journal conservé non traité, puis
   re-traitement du MÊME payload après retour de l'API.
3. Annulation : session cancelled, loyer intact, ré-initiation possible.
4. Course d'initiation parallèle : une seule facture pending.
5. Double-clic salaire : une seule ligne, même identifiant repris.
6. Redistribution bloquée → notification propriétaire → correction de
   l'alias → relance admin réussie → notification de succès ;
   relance idempotente sur succès.
7. Validation des formats d'alias (refus aberrant, téléphone OK, vide
   OK, côté employé également).
8. Abonnement : replay d'IPN différent → `already_completed`, pas de
   prolongation ni de notification en double (compte dédié).

## 9. Résultat campagne

```
TOTAL  569   ✅ 569   ❌ 0   ⛔ 0   🟢
```

(528 avant phase 5 → 569 après : +41 vérifications, dont les 41
nouvelles de la suite paydunya.)

## 10. Versements automatiques — décaissement direct (phase 6)

Jusqu'ici MIM reversait chaque encaissement sur un **compte PayDunya**,
obligé d'aller ensuite retirer manuellement. La phase 6 ajoute l'API
officielle **Déboursement (PUSH v2)** : le versement part DIRECTEMENT
sur le wallet choisi par le destinataire (Wave, Orange Money…).

### Choix du destinataire (`pour_versement`)

- Nouvelle colonne `pour_versement` sur `moyens_paiement` et
  `moyens_paiement_employes` (migration
  `20260821100000_paydunya_deboursement.sql`, qui ajoute aussi
  `withdraw_mode`, `provider_token`, `provider_ref` à
  `paydunya_redistributions`).
- Le destinataire coche « Recevoir les versements automatiques » sur UN
  moyen (exclusivité appliquée côté serveur : choisir celui-ci désactive
  les autres). Côtés couverts : paramètres propriétaire, paiements
  propriétaire, espace employé ; l'admin voit le canal utilisé dans le
  tableau des redistributions.
- Résolution de cible (`recipientTargetOf*`) :
  1. moyen `pour_versement` : wallet direct si type décaissable +
     numéro exploitable (indicatif 221 retiré), sinon son alias PayDunya ;
  2. chaîne historique inchangée (alias → téléphone profil → email).

### Flux officiel v2 (`utils/paydunya.js`)

`get-invoice → submit-invoice → statut` avec `withdraw_mode`
(`wave-senegal`, `orange-money-senegal`) et `disburse_id` idempotent ;
statuts `success | pending | failed`. Les clés restent côté serveur
(`PAYDUNYA_DISBURSE_API_URL` pour le sandbox/test).

### Sécurité double-paiement

- Un décaissement soumis (`pending`) n'est JAMAIS rejoué aveuglément :
  sa statut est revérifié (`check-status`) avant toute nouvelle
  tentative ; un `failed` confirmé repart proprement sur une NOUVELLE
  cible relue en base (numéro corrigé entre-temps = nouveau versement).
- **Callback signé** `POST /api/paydunya/disburse-callback`
  (hash SHA-512 Master Key, monté comme le webhook IPN) : confirme le
  statut final poussé par PayDunya. Finalisation idempotente
  (écriture conditionnelle sur `status='pending'`), notifications
  « confirmé » / « refusé » sans doublon.
- Relance admin inchangée (`POST /redistributions/:id/retry`) mais
  désormais consciente des décaissements wallet (vérification d'abord,
  jamais de double envoi).

### Tests

Nouvelle section « décaissement direct » (suite paydunya 75 → **95**) :
versement Wave immédiat (sans crédit PER), salaire employé sur Orange
Money, exclusivité du moyen de réception, décaissement différé
(`pending`) confirmé par callback signé (+ rejet mauvais hash,
idempotence), échec différé confirmé puis relance admin réussie vers le
numéro corrigé par l'employé lui-même.

## 11. Résultat campagne (après phase 6)

```
TOTAL  589   ✅ 589   ❌ 0   ⛔ 0   🟢
```

(569 après phase 5 → 589 : +20 vérifications.)

## 12. Passage en production (rappel)

1. `PAYDUNYA_MODE=live` + clés live dans `server/.env`.
2. `PAYDUNYA_TEST_MODE=false` (désactive /test-ipn).
3. URLs de callback HTTPS configurées chez PayDunya : webhook IPN
   (`/api/paydunya/webhook`) ET callback de décaissement
   (`/api/paydunya/disburse-callback`) — activées si `APP_URL` est en HTTPS.
4. Migrations Supabase appliquées (déjà fait en local).
