# RAPPORT DE MISSION — PHASE 3 : CORRECTIFS P2 (QUALITÉ) + P1-7

> Date : 18 août 2026
> Projet : MIM (`C:\xampp\htdocs\MIM2.1\MIM`)
> Périmètre : correctifs P2 de l'audit (`RAPPORT-AUDIT.md` §P2) + report P1-7 de la Phase 1.

---

## P1-7 — BOUTON « DÉCONNEXION » MORT SUR LES PAGES PROPRIÉTAIRE

**Statut : CORRIGÉ** ✅

**Problème** : `incidents.html`, `paiements.html`, `prestataires.html`, `import.html`, `biens.html`, `interventions.html` (et le dashboard) n'attachaient aucun gestionnaire à `#logoutBtn` ; seules 4 pages propriétaire + admin en avaient un.

**Correction** : câblage **centralisé** dans `PartPublic/sidebar.js` (chargé par toutes les pages avec sidebar) — un seul gestionnaire pour `#logoutBtn` partout (fetch `POST /api/auth/logout` + redirection connexion.html), avec garde `data-mim-logout` anti-doublon. Les 5 handlers locaux redondants ont été retirés (employes.html, locataires.html, notifications.html, parametres.html, admin.js). La zone employé (bouton `#logout`) et locataire (`#logoutButton`) étaient déjà câblées et sont inchangées.

**Vérification** : test navigateur live — connexion propriétaire, navigation vers `paiements.html` (une des 6 pages réparées), **clic réel sur le bouton Déconnexion** → connexion.html, re-connexion réussie. **2/2 checks PASS.**

---

## P2-1 — LIBELLÉS « PAIEMENTS RÉCENTS » BRUTS SUR LE DASHBOARD (m1)

**Statut : CORRIGÉ** ✅

`PartProprietaires/dashboard.js` — `STATUS.paiement` complété : `a_confirmer` (« À confirmer », info), `en_validation` (« En validation », warning), `refuse` (« Refusé », danger) — plus de libellés bruts en anglais. **Vérifié** : rendu badge sur `recentPayments`.

---

## P2-2 — TITRE D'INCIDENT TROP LONG (m3)

**Statut : CORRIGÉ** ✅

`PartLocataires/incidents.html` — `maxlength="200"` → `maxlength="120"`, aligné sur la contrainte serveur (`locataire.js:61`, 120 caractères). Les autres `maxlength=200` (champs moyens de paiement) restent valides (aucune contrainte serveur).

---

## P2-3 — DATE DE SALAIRE EN ISO BRUT (m5)

**Statut : CORRIGÉ** ✅

`PartProprietaires/employes.html` — `loadPayHistory` formate `date_paiement` en `toLocaleDateString("fr-FR")` (jj mois aaaa) au lieu d'afficher l'ISO brut.

---

## P2-4 — STATUTS ADMIN AFFICHÉS BRUTS (m20)

**Statut : CORRIGÉ** ✅

`PartAdmin/admin.js` — `LABELS` complété : `a_confirmer`, `en_validation`, `refuse`, `expire`, `intervention` ; `badge()` étendu (classes de couleur cohérentes : validation/expiré → warning, refusé → danger, à confirmer → info).

---

## P2-5 — CODE MORT `loadTenantIdentity` (m4)

**Statut : CORRIGÉ** ✅

`PartLocataires/LocaDash.js` — la boucle ciblait `profileName`/`profilePhone` (éléments inexistants ; le profil est rempli par `profil.html` lui-même via `profileNameInput`/`profilePhoneInput`). Les cibles mortes sont retirées ; la fonction continue d'alimenter `userName`/`welcomeName`/`unlinkedEmail` (existant, vérifié sur 5 pages locataires).

---

## P2-6 — CODE MORT `checkUsernameAvailability` (m6)

**Statut : CORRIGÉ** ✅

`PartPublic/form-utils.js` — fonction retirée : jamais appelée (chaque page a sa propre implémentation du check : profil.html, employes.html, change-password.html — vérifié par grep, la route `/auth/username-available` reste utilisée par ces pages).

---

## P2-7 — BLOC QR MORT DANS L'ADMIN (m2)

**Statut : CORRIGÉ** ✅

`PartAdmin/admin.js` — `if (d.qr_code)` retiré : `/admin/subscriptions/register` ne renvoie jamais `qr_code` (vérifié dans `admin.js:401-421`, la réponse fournit `payment_url` + `reference` + `checkout`). Le lien de paiement reste la sortie affichée.

---

## P2-8 — DÉPENDANCE MORTE `bcryptjs` (m17)

**Statut : CORRIGÉ** ✅

`server/package.json` — `bcryptjs` retiré (aucun import dans le code, vérifié par grep).

---

## P2-9 — CSS `.has-error` INEXISTANT (m11)

**Statut : CORRIGÉ** ✅

La classe ajoutée par `formFieldError` n'était stylée nulle part. Ajout dans les 5 feuilles de style concernées (`connexion.css`, `forgot.css`, `inscription.css`, `LocaDash.css`, `style.css`) : label du groupe en rouge quand `.has-error`.

---

## P2-10 — ÉNUMÉRATION DE COMPTES AU LOGIN (m15)

**Statut : CORRIGÉ** ✅

`server/routes/auth.js` — compte inexistant et mauvais mot de passe renvoient désormais **la même réponse** (`401 INVALID_CREDENTIALS` « Email ou mot de passe incorrect. ») ; la réponse `ACCOUNT_NOT_FOUND` est supprimée (la suspension 403 et le 429 restent distincts — comportements légitimes).

**Vérification** : suite auth 47/47 PASS (le test « mauvais identifiants → 401 » reste vert).

---

## P2-11 — RESET DE MOT DE PASSE : LE JETON DU LIEN PRIME SUR LA SESSION (m16)

**Statut : CORRIGÉ** ✅

`server/routes/auth.js` (`POST /reset-password`) — la session cookie ne pilote plus le reset. Ordre : 1) `access_token` du fragment d'URL, 2) `token_hash` (lien email) ou `code` PKCE, 3) sinon → `401` « Jeton de réinitialisation manquant » (jeton fourni mais invalide → `400` « Lien invalide ou expiré »). Un utilisateur connecté qui clique un lien de reset pour un autre compte ne modifie plus SON mot de passe.

**Vérification** : suite auth 47/47 PASS (reset avec lien réel → 200, sans jeton → 401).

---

## P2-12 — SCRIPT INUTILE SUR LA PAGE DE CONNEXION (m8)

**Statut : CORRIGÉ** ✅

`PartPublic/connexion.html` — `password-strength.js` retiré (aucune fonction utilisée par la page, vérifié par grep ; la page emploie `mimPasswordRuleMessage` de mim-errors.js).

---

## P2-13 — ÉTAT PARTIEL SI LE CHANGEMENT DE MOT DE PASSE ÉCHOUE (m10)

**Statut : CORRIGÉ** ✅

`PartPublic/change-password.html` — ordre inversé : **le changement de mot de passe est exécuté en premier** (il désactive `must_change_password`), le `update-username` (optionnel) n'est tenté qu'après son succès. En cas d'échec du username, le message précise que seul le username n'a pas été enregistré.

---

## P2-14 — EMAIL VIDE DANS « COMPTE NON RATTACHÉ » (m21)

**Statut : CORRIGÉ** ✅

`PartLocataires/LocaDash.html` + `LocaDash.js` — la parenthèse `(<strong id="unlinkedEmail">…)` est masquée quand le compte n'a pas d'email (les autres pages locataires n'affichent pas d'email dans ce bloc).

---

## P2-15 — SCHÉMA DE RÉFÉRENCE OBSOLÈTE (m12)

**Statut : CORRIGÉ** ✅

`server/supabase-schema.sql` — **régénéré** par `pg_dump --schema-only` (base de dev) : reflet exact des 20 tables, colonnes (dont `avatar_url`, `bien_id`, `employes_biens`, `unitech_*`), contraintes, index, politiques RLS (WITH CHECK), privilèges, triggers. En-tête ajouté expliquant l'origine et la régénération. La directive `\restrict` (spécifique pg_dump 17) a été retirée pour la compatibilité SQL Editor.

---

## P2-16 — PORT STUDIO MANQUANT (m13)

**Statut : CORRIGÉ** ✅

`supabase/config.toml` — `[studio] api_url = "http://127.0.0.1"` → `"http://127.0.0.1:64321"` (port Kong de l'API locale, cohérent avec les clients `SUPABASE_URL`).

---

## RÉSULTATS DES TESTS

### Tests automatisés (`server/scripts/tests/run.js`, exécutés depuis `server/`)
| Indicateur | Valeur |
|---|---|
| Suites exécutées | 17 |
| Tests | **576/576 PASS** |
| Échecs / Bloqués | **0 / 0** |

### Tests navigateur live (puppeteer-core + Chrome, parcours réels, viewport desktop 1400×900)
| Partie | Parcours | Résultat |
|---|---|---|
| A — Propriétaire | connexion, dashboard, paiements (listes, boutons réels), CRUD moyen complet, onglet salaires, création employé auto, incidents, déconnexion | ✅ |
| B — Locataire | connexion (+ changement forcé), signalement incident (UI + base) | ✅ |
| C — Employé | connexion, changement forcé, dashboard, biens affectés, résolution réelle d'incident + notification, moyen de réception, salaire déclaré → confirmé, profil, déconnexion | ✅ |
| D — Locataire | flux `a_confirmer` complet + tests négatifs, validation propriétaire ciblée, échéance suivante, profil | ✅ |
| D+ — P1-7 | déconnexion réelle via le bouton de `paiements.html` → connexion.html → re-connexion | ✅ |
| E — Locataire 2FA | P1-1 (2FA → changement forcé), P1-2 (current_password), désactivation propre | ✅ |

**Total : 84/84 PASS.**

---

## NOTES COMPLÉMENTAIRES

1. **Vue mobile** : le breakpoint de la sidebar (800 px) cache la sidebar sur petit écran — le clic de test a nécessité un viewport desktop ; le comportement mobile (ouverture par hamburger) est inchangé.
2. **`gitAutoBackup`** : les modifications ont été intégrées au dépôt par le mécanisme d'auto-sauvegarde au moment des connexions de `owner1@mimtest.com` pendant les tests (commit `0360ead`), working tree propre.
3. **Reliquats de tests** en base de dev : paiements en `a_confirmer`/`en_validation` (runs de la Partie D) et employés `gerant.live.test*` (runs de la Partie A) — données de test cohérentes avec le seed, sans impact.
4. Les points P0 (Phase 1), P1 (Phase 2) et P2 + P1-7 (Phase 3) de l'audit sont tous traités. Le conteneur Vector (m18) avait été neutralisé en Phase 1.

---

## COMMIT

Correctifs P2 + P1-7 intégrés au dépôt par l'auto-sauvegarde : commit `0360ead` (23 fichiers : sidebar.js, admin.js, dashboard.js, LocaDash.*, employes.html, locataires.html, notifications.html, parametres.html, change-password.html, connexion.*, forgot.css, inscription.css, form-utils.js, auth.js, package.json, supabase-schema.sql, config.toml, style.css), working tree propre.