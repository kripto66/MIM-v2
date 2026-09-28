# Audit de la base de données MIM — Rapport

**Périmètre** : `server/supabase-schema.sql`, `server/schema-tenant.sql`, `server/schema-admin.sql`, `supabase/migrations/*`, `supabase/config.toml`, `server/utils/plans.js`, `server/utils/quota.js`.
**Méthode** : lecture seule, aucun fichier source modifié. Chaque constat ci-dessous est appuyé sur une ligne présente dans le dépôt.

**Liste des migrations** (44 fichiers, `20260812193516_init.sql` → `20260926001000_sync_profile_app_metadata.sql`) :

```
20260812193516_init.sql                        20260820090000_paydunya.sql
20260812195716_grants.sql                      20260821090000_paydunya_robustesse.sql
20260812210000_tenant_accounts.sql             20260821100000_paydunya_deboursement.sql
20260812230000_validation_securite.sql         20260822000000_cinetpay.sql
20260813090000_grants_minimaux.sql             20260826000000_admin_must_change_password.sql
20260813192500_fixes.sql                       20260828000000_ultra_admin.sql
20260814090000_employes.sql                    20260903000000_remove_paydunya_cinetpay.sql
20260814150000_abonnements.sql                 20260904000000_remove_unitech.sql
20260814160000_methodes_paiement.sql           20260921000000_bictorys.sql
20260814180000_unitechpay.sql                  20260922000000_plan_packs.sql
20260814190000_unitech_seul_methode.sql        20260922230000_password_reset_tokens.sql
20260814190100_abonnement_paiement_attente.sql 20260923000000_agence.sql
20260815090000_confirmer_paiement.sql          20260924000000_security_integrity_hardening.sql
20260815160000_declaration_paiement.sql        20260924010000_function_repairs.sql
20260816100000_paiements_employes_confirmation.sql  20260924020000_plan_constraints.sql
20260816120000_simplification.sql              20260924030000_quota_counts.sql
20260816130000_fix_rls_locataires_bien.sql     20260924040000_active_plan_rls.sql
20260817120000_incidents_resolution.sql        20260924050000_validate_integrity.sql
20260817150000_rls_with_check.sql              20260924060000_financial_user_restrict.sql
20260817160000_rls_column_privileges.sql       20260925000000_security_blockers.sql
                                               20260925010000_security_followup.sql
                                               20260925020000_validate_mfa_status.sql
                                               20260926000000_plan_audience.sql
                                               20260926001000_sync_profile_app_metadata.sql
```

---

## Synthèse

| Sévérité | Nombre |
|---|---|
| CRITIQUE | 1 |
| HAUT | 9 |
| MOYEN | 9 |
| FAIBLE | 9 |

---

## CRITIQUE

### C1 — Suppression `DROP TABLE ... CASCADE` sans archivage de 8 tables de transactions financières

- **Réf** : `supabase/migrations/20260903000000_remove_paydunya_cinetpay.sql:18-23` et `supabase/migrations/20260904000000_remove_unitech.sql:10-11`
- **SQL** :
  ```sql
  DROP TABLE IF EXISTS public.paydunya_invoices CASCADE;
  DROP TABLE IF EXISTS public.paydunya_redistributions CASCADE;
  DROP TABLE IF EXISTS public.cinetpay_payments CASCADE;
  DROP TABLE IF EXISTS public.cinetpay_payouts CASCADE;
  -- + paydunya_webhooks, cinetpay_webhooks (lignes 19, 22)
  DROP TABLE IF EXISTS public.unitech_checkouts CASCADE;
  DROP TABLE IF EXISTS public.unitech_webhooks CASCADE;
  ```
- **Impact** : effacement définitif de factures, encaissements et **déboursements (payouts)** déjà enregistrés. `CASCADE` supprime silencieusement tout objet dépendant non listé. Aucune étape d'export (`CREATE TABLE ... AS`, `COPY`, `pg_dump`) n'est faite en amont : le dépôt ne contient donc aucun point de restauration pour ces données comptables.
- **Correction** : exporter les 8 tables en CSV/archive avant suppression, puis les renommer en `*_arch_<date>` au lieu de `DROP ... CASCADE`.

---

## HAUT

### H1 — Le schéma de référence ne contient aucun déclencheur sur `auth.users`

- **Réf** : `server/supabase-schema.sql:1942` et `:1946` (seuls `CREATE TRIGGER` du fichier) ; fonctions présentes mais **jamais rattachées** `:154` (`guard_public_auth_metadata`), `:176-207` (`handle_new_user`), `:133`. Rattachées réellement dans `supabase/migrations/20260924000000_security_integrity_hardening.sql:142` et `:160`.
- **SQL** :
  ```sql
  CREATE TRIGGER "employes_biens_owner_guard" ... ON "public"."employes_biens";    -- :1942
  CREATE TRIGGER "tenant_invitations_guard"  ... ON "public"."tenant_invitations";  -- :1946
  -- AUCUN : CREATE TRIGGER ... ON "auth"."users"
  ```
- **Impact** : le dump n'inclut que le schéma `public`, donc à toute reconstruction (`server/run-schema.mjs`) : (a) `handle_new_user` ne se déclenche plus → aucun `profiles` créé à l'inscription ; (b) surtout, `guard_public_auth_metadata` (`:162-167`, qui `RAISE EXCEPTION` si `raw_user_meta_data.account_type` n'est pas `proprietaire`/`agence`) disparaît → GoTrue accepte un self-signup avec `user_metadata: {account_type: 'ultra_admin'}`, que `accountTypeOf()` (`server/routes/auth.js:123-127`) accepte tel quel et réinjecte dans le payload de session (`auth.js:132`) : **élévation de privilège jusqu'à `ultra_admin`**.
- **Correction** : régénérer le dump avec le schéma `auth` (`pg_dump --schema=public --schema=auth`) ou y réintégrer les trois `CREATE TRIGGER ... ON auth.users`.

### H2 — Le schéma de référence est désynchronisé des migrations : `plans.audience` absent

- **Réf** : `server/supabase-schema.sql:1113-1135` (définition de `plans`) vs `supabase/migrations/20260926000000_plan_audience.sql:16,25,31`
- **SQL** : table `plans` sans colonne `audience`, sans `plans_audience_ck`, sans `plans_audience_actif_idx`, et sans les plans `agence_starter` / `agence_pro` / `agence_business`.
- **Impact** : `server/utils/plans.js:28` exécute `.eq('audience', audience)` ; sur une base reconstruite depuis ce dump, la lecture du catalogue renvoie `column public.plans.audience does not exist` et tout parcours d'abonnement propriétaire/agence est bloqué. Les migrations `20260926000000` et `20260926001000` (`sync_profile_account_type()` + trigger `mim_sync_profile_role`) sont également absentes.
- **Correction** : régénérer `supabase-schema.sql` après application de la dernière migration, et ajouter un contrôle CI « dump == migrations ».

### H3 — `run-tenant-schema.mjs` pousse un SQL dangereux sans garde

- **Réf** : `server/run-tenant-schema.mjs:3-5` (aucun verrou, contraste avec `server/run-schema.mjs:3-6`), `server/schema-tenant.sql:10-13`
- **SQL** :
  ```sql
  CREATE POLICY "tenant_link_locataire" ON public.locataires
      FOR UPDATE USING (lower(email) = lower(auth.jwt()->>'email') AND account_uid IS NULL)
      WITH CHECK (account_uid = auth.uid());
  ```
- **Impact** : cette politique a été **supprimée** par `20260924000000_security_integrity_hardening.sql:435` et `20260925000000_security_blockers.sql:149`. Le script la recrée avec une simple `SUPABASE_PAT` et un projet codé en dur (`:4`). Dès que les politiques divergent (base neuve, restauration partielle), un compte dont l'email correspond à une fiche locataire non rattachée — y compris l'email interne `{username}@mim.local`, rendu prévisible par `tenantEmailFor()` (`server/utils/tenantAccount.js:46-48`) — la rattache à son propre `auth.uid()` et ouvre l'accès à ses logements, incidents et paiements.
- **Correction** : supprimer la politique de `schema-tenant.sql` et protéger `run-tenant-schema.mjs` avec le même verrou que `run-schema.mjs`.

### H4 — `schema-tenant.sql` réouvre l'écriture côté client sur les employés et la paie

- **Réf** : `server/schema-tenant.sql:115-116` (+ politique `:105`) ; état actuel imposé par `20260924000000_security_integrity_hardening.sql:448,451` et `20260925000000_security_blockers.sql:155,158` ; politique latente `server/supabase-schema.sql:2471`
- **SQL** :
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.employes, public.tasks, public.paiements_employes TO authenticated;
  ```
- **Impact** : annule le `REVOKE ALL ON ALL TABLES ... FROM anon,authenticated` puis `GRANT SELECT` du durcissement. Le privilège UPDATE rend aussitôt effective la politique `employe_update_own_paiements FOR UPDATE USING (employe_uid = auth.uid())` : un employé pourrait modifier en base directe le montant et le statut de son propre bulletin.
- **Correction** : ne conserver que `GRANT SELECT` sur ces trois tables.

### H5 — Divergence multi-tenant : `ON DELETE CASCADE` sur la paie

- **Réf** : `server/schema-tenant.sql:87-88` vs `server/supabase-schema.sql:2211` et `2226`
- **SQL** :
  ```sql
  -- schema-tenant.sql:87-88
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  employe_id BIGINT REFERENCES public.employes(id) ON DELETE CASCADE,
  -- état final : ON DELETE RESTRICT pour user_id (2226) et pour employe_id (2211)
  ```
- **Impact** : supprimer un compte ou une fiche employé efface en cascade toute l'historique de sa paie (`paiements_employes`) — perte financière irréversible, en contradiction directe avec `20260924060000_financial_user_restrict.sql`. `employe_id` est en plus nullable dans la variante tenant alors qu'il est `NOT NULL` dans l'état final.
- **Correction** : aligner les deux clés sur `ON DELETE RESTRICT` et `NOT NULL`.

### H6 — Les deux « variantes de schéma » recréent un `CHECK` incompatible

- **Réf** : `server/schema-admin.sql:8-10` et `server/schema-tenant.sql:55-57` vs `server/supabase-schema.sql:1214`
- **SQL** :
  ```sql
  -- schema-admin.sql : 5 valeurs
  CHECK (account_type IN ('proprietaire','agence','entreprise','locataire','admin'));
  -- schema-tenant.sql : 6 valeurs
  CHECK (account_type IN ('proprietaire','agence','entreprise','locataire','admin','employe'));
  -- état final (dump:1214) : 7 valeurs, dont employe et ultra_admin
  ```
- **Impact** : `schema-admin.sql` casse la création/modification des comptes `employe` **et** `ultra_admin` ; `schema-tenant.sql` bloque `ultra_admin`. Si un compte concerné existe déjà, l'`ALTER` échoue tout court.
- **Correction** : supprimer ces recréations de `CHECK` (l'état final fait foi) ou les rendre strictement identiques à `supabase-schema.sql:1214`.

### H7 — Jetons d'authentification Supabase stockés en clair

- **Réf** : `server/supabase-schema.sql:1256-1257` (table `sessions`), colonnes créées par `20260924000000_security_integrity_hardening.sql:8-9`
- **SQL** : `"supabase_access_token" "text", "supabase_refresh_token" "text",`
- **Impact** : toute lecture de `sessions` (dump fuité, sauvegarde brute, injection SQL en lecture sur le rôle `service_role`) donne un matériau de séquestre de session réutilisable ; la valeur n'est ni hachée ni chiffrée, contrairement à `password_reset_tokens.token_hash`.
- **Correction** : ne conserver que le hash du refresh token et interdire toute `SELECT` sur ces deux colonnes.

### H8 — Moyens de paiement, IBAN et salaires en clair, lisibles par le locataire

- **Réf** : `server/supabase-schema.sql:901-906` (`moyens_paiement`), `:919-929` (`moyens_paiement_employes`), `:572` (`employes.salaire`), politique `:2671-2674`
- **SQL** :
  ```sql
  "numero" "text", "num_compte" "text", "iban" "text", "bic" "text",
  -- politique :
  CREATE POLICY "tenant_select_moyens_paiement" ON "public"."moyens_paiement"
      FOR SELECT USING ("actif" = true AND EXISTS (SELECT 1 FROM locataires l ...));
  ```
- **Impact** : aucun chiffrement (point 8 de l'audit). De plus, `tenant_select_moyens_paiement` donne au locataire la lecture du **numéro / compte / IBAN** du propriétaire dès qu'il occupe l'un de ses logements : toute donnée bancaire du propriétaire devient visible par ses locataires. `moyens_paiement_employes` expose en clair les coordonnées bancaires des salariés, `employes.salaire` leur rémunération.
- **Correction** : chiffrer (ou stocker un masque type `**** 4321`) et restreindre la politique `tenant_select_moyens_paiement` aux champs non sensibles (`type`, `nom_titulaire`).

### H9 — Piste d'audit et sessions effacées en cascade avec le compte

- **Réf** : `server/supabase-schema.sql:2006` et `:2286` (80 clés étrangères au total : 79 avec `ON DELETE`, 1 seule `ON UPDATE` seul)
- **SQL** :
  ```sql
  ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  ```
- **Impact** : la suppression d'un compte `auth.users` efface toutes les entrées d'audit de cet utilisateur (`audit_logs.user_id` étant `NOT NULL` à `:467`, aucun anonymisation possible) : la preuve des actions antérieures est détruite. `sessions` disparaît de la même façon.
- **Correction** : rendre `audit_logs.user_id` nullable et utiliser `ON DELETE SET NULL` (ou `RESTRICT` + anonymisation du compte).

---

## MOYEN

### M1 — Index `user_id` / `bien_id` manquants

- **Réf** : `server/supabase-schema.sql:1778-1938` (liste complète des 58 index) vs tables `:314-1500`
- **SQL** : aucune occurrence de `CREATE INDEX ... ON "public"."biens" ("user_id")`, ni sur `logements(user_id)`, `logements(bien_id)`, `locataires(user_id)`, `prestataires`, `incidents`, `interventions`, `employes`, `tasks`, `notifications`, `sessions`, `moyens_paiement`, `versements(user_id)`, `messages(user_id)`.
- **Impact** : le prédicat RLS `user_id = auth.uid()` est souvent le **seul** filtre d'une requête ; sans index, PostgreSQL fait un `Seq Scan` sur la table entière puis évalue la politique ligne à ligne — dégradation proportionnelle à la taille du jeu de données, pour chaque requête de chaque utilisateur. Les index qui commencent par `user_id` (`paiements*`, `quota_reservations`, `import_runs`, `tenant_invitations`) sont **partiels** (`WHERE superseded_at IS NULL`, `WHERE locataire_id IS NOT NULL`, …) et donc inexploitables si la requête ne répète pas cette clause.
- **Correction** : ajouter un index simple sur `("user_id")` pour chaque table concernée et `("bien_id")` sur `logements` (utilisé par `tenant_select_bien` à `:2647`).

### M2 — Quotas non appliqués : `employes` / `prestataires` toujours illimités, et fail-open sans abonnement

- **Réf** : `server/supabase-schema.sql:265`, `:278-279`, `:283`, `:285`
- **SQL** :
  ```sql
  IF v_resource NOT IN ('biens','logements','locataires','employes','prestataires') THEN RAISE ...;
  v_limit := CASE v_resource WHEN 'biens' THEN v_plan.max_immeubles ... ELSE NULL END;
  ELSE v_limit := NULL; END IF;
  ELSIF ... ELSE v_current := 0; END IF;
  IF v_limit IS NOT NULL AND v_current + v_reserved + p_quantity > v_limit THEN ...
  ```
- **Impact** : deux failles distinctes. (a) La fonction **accepte** `p_resource IN ('employes','prestataires')` (`:265`) mais leur limite est toujours `NULL` et leur compteur toujours `0` → quota purement décoratif. (b) Sans ligne `subscriptions` pour le compte, `v_limit := NULL` → **illimité** (fail-open assumé dans `plans.js:79-99` : « Sans abonnement (héritage) ou capacité NULL → aucune limite ») : un compte sans abonnement peut créer autant de biens, logements et locataires qu'il le souhaite.
- **Correction** : lever une exception quand aucune souscription n'existe et que `v_plan.max_*` est `NULL` pour une ressource non héritée.

### M3 — Contraintes d'unicité manquantes

- **Réf** : `server/supabase-schema.sql:1521-1770` (bloc `ADD CONSTRAINT ... UNIQUE`), index partiels `:1898`, `:1910`, `:1790`
- **SQL** : pas de `UNIQUE (user_id, agence_id, bien_id, periode)` sur `versements` (`bien_id` est nullable, `:1380`) ; `paiements_locataire_mois_uidx ON (user_id, locataire_id, mois) WHERE locataire_id IS NOT NULL` (`:1898`) ; `profiles_email_key UNIQUE ("email")` sensible à la casse (`:1724`) alors que `account_recovery_emails_email_uidx ON lower("email")` (`:1790`).
- **Impact** : (a) `versements` accepte plusieurs lignes pour le même propriétaire/agence/bien/période → le rapprochement mensuel peut doubler ; (b) `paiements` **sans** `locataire_id` (paiement libre) n'a aucune contrainte de non-répétition ; (c) `profiles.email` étant sensible à la casse, `A@x.fr` et `a@x.fr` coexistent alors que `resolveLoginEmail` (`tenantAccount.js:51-56`) et les politiques `lower(email)` les traitent comme un seul identifiant ; (d) `locataires.email` et `employes.email` n'ont aucune unicité.
- **Correction** : ajouter `UNIQUE (user_id, agence_id, bien_id, periode)` sur `versements`, une index unique partielle sur `paiements (user_id, mois) WHERE locataire_id IS NULL`, et une clé unique sur `lower(email)` de `profiles`.

### M4 — `versements.periode` sans contrôle de format ni de validité

- **Réf** : `server/supabase-schema.sql:1382` (`versements.periode`), contrasté avec `:1018-1019` (`paiements_mois_ck`, `paiements_mois_valid_ck`) et `:1047` (`paiements_employes_mois_ck`)
- **SQL** : `"periode" "text",` sans `CHECK` ; à comparer avec `"mois" TEXT ... CHECK (mois ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`.
- **Impact** : `2025-13`, `2025-001`, `""` et `2025-01-01` sont tous acceptés pour la même clé d'unicité, ce qui neutralise la contrainte de M3 et corrompt l'historique de versements.
- **Correction** : ajouter `CHECK (periode ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`.

### M5 — `locataires.bien_id` dénormalisé sans déclencheur de cohérence

- **Réf** : `server/supabase-schema.sql:2439-2442` (politique `employe_select_locataires_affectes`), `:1942`/`:1946` (seuls déclencheurs du dump)
- **SQL** :
  ```sql
  WHERE (("e"."account_uid" = "auth"."uid"()) AND ("eb"."bien_id" = "locataires"."bien_id"))
  ```
- **Impact** : la politique repose **uniquement** sur la colonne dénormalisée `locataires.bien_id` (plus sur `logement_id`), renseignée par l'application ; aucun déclencheur ne garantit `locataires.bien_id = logements.bien_id`. Si `bien_id` reste `NULL` ou désynchronisé, le locataire devient **invisible** pour l'employé affecté — dysfonctionnement silencieux de visibilité (fail-soft non détecté), alors que la même règle via `logements.bien_id` aurait fonctionné.
- **Correction** : ajouter un déclencheur `BEFORE INSERT OR UPDATE` qui recopie `bien_id` depuis `logements`, ou faire porter la jointure par `logement_id`.

### M6 — Politique de suppression de compte incohérente

- **Réf** : `server/supabase-schema.sql:1956, 2226, 2251, 2296, 2346` (`ON DELETE RESTRICT`) vs `:2006, 2286` (`ON DELETE CASCADE`), `:2056` (`import_run_rows` → `import_runs` `RESTRICT`)
- **SQL** : `paiements`, `paiements_employes`, `abonnement_paiements`, `subscriptions`, `versements` → `ON DELETE RESTRICT` ; `audit_logs`, `sessions` → `ON DELETE CASCADE`.
- **Impact** : la suppression d'un compte est **impossible** dès qu'il possède un seul versement, abonnement ou bulletin (violation `RESTRICT`), alors que le nettoyage est en même temps `CASCADE` sur les tables d'audit — aucune stratégie de rétention cohérente : on bloque la suppression utile et on détruit les preuves quand elle finit par passer. `import_run_rows` en `RESTRICT` bloque en plus la purge d'un import, même terminé.
- **Correction** : passer les tables d'audit en `RESTRICT` et prévoir un scénario explicite d'anonymisation de compte (`ON DELETE SET NULL` + pseudonymisation) pour les tables financières.

### M7 — Aucune sauvegarde ni point de restauration dans le dépôt

- **Réf** : `supabase/migrations/seed.sql` (2 lignes, vide), `supabase/config.toml:66-71` (`[db.seed] enabled = true`, `sql_paths = ["./seed.sql"]`), `supabase/migrations/20260903000000_remove_paydunya_cinetpay.sql:18-23`, absence de script `pg_dump`/`pg_restore`
- **SQL** : aucun objet SQL de restauration (pas de `RESTORE`, pas de sauvegarde versionnée de `public`).
- **Impact** : point 8 de l'audit. Le seul « schéma de référence » est un dump **schema-only** (aucune donnée) ; `supabase db reset` exécute bien `seed.sql` (`config.toml:68`) mais ce fichier est vide, donc la base reconstruite n'a **aucun catalogue de plans** — les seuls `INSERT` sont dans `20260921000000:44`, `20260922000000:49` et `20260926000000:35`, jamais réappliqués sur un dump. Et après C1, aucun moyen de revenir en arrière.
- **Correction** : alimenter `supabase/seed.sql` avec le catalogue `plans` et versionner un script de backup `pg_dump -Fc` avec une procédure de restauration documentée.

### M8 — `supabase/config.toml` : aucune restriction réseau, TLS éteint, limites d'auth à 500

- **Réf** : `supabase/config.toml:73-85` (`[db.network_restrictions] enabled = false`, `allowed_cidrs = ["0.0.0.0/0"]`, `allowed_cidrs_v6 = ["::/0"]`, `[db.ssl_enforcement]` commenté), `:18` (`max_rows = 1000`), `:203-220` (`email_sent = 500`, `token_refresh = 500`, `sign_in_sign_ups = 500`), `:26-28` (`[api.tls] enabled = false`)
- **SQL** :
  ```toml
  [db.network_restrictions]
  enabled = false
  allowed_cidrs = ["0.0.0.0/0"]
  # [db.ssl_enforcement]
  # enabled = true
  ```
- **Impact** : le fichier est clairement identifié comme **local** (commentaires `:204-205` et `:214-216` expliquent que ces valeurs servent la stack E2E), mais il n'existe aucune autre config d'environnement dans le dépôt : copier ce `config.toml` sur un projet distant rend la base accessible depuis tout Internet en clair (`ssl_enforcement` désactivé) et `sign_in_sign_ups = 500` / `email_sent = 500` suppriment la protection anti-énumération de GoTrue.
- **Correction** : fournir un `config.toml` de production avec `allowed_cidrs` restreints, `ssl_enforcement` actif et les limites d'authentification aux valeurs par défaut Supabase.

### M9 — Le dump ne fige pas les révocations de privilèges par défaut

- **Réf** : `server/supabase-schema.sql:3059-3075` (aucune commande `REVOKE` sur les *default ACL*) vs `supabase/migrations/20260925000000_security_blockers.sql:181-183` et `20260924000000_security_integrity_hardening.sql:448-450`
- **SQL** : le dump ne contient que `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO "postgres";` (`:3074`) et **ne contient pas** `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;`
- **Impact** : une restauration conserve les privilèges par défaut de la plateforme (`TO anon, authenticated`) ; toute table créée **après** la restauration reçoit spontanément `ALL` pour `anon` et `authenticated` — régression silencieuse du modèle « privilèges minimaux + RLS ».
- **Correction** : faire précéder la restauration des commandes `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ... FROM anon, authenticated` (réappliquer les migrations `20260924000000` et `20260925000000`).

---

## FAIBLE

### F1 — Contraintes `CHECK` strictement dupliquées

- **Réf** : `server/supabase-schema.sql:1130-1133`
- **SQL** : `plans_max_locataires_ck` / `plans_max_locataires_positive` et `plans_max_logements_ck` / `plans_max_logements_positive` expriment exactement la même règle.
- **Impact** : bruit dans le schéma et `DROP CONSTRAINT` divergents entre `schema-tenant.sql` et `schema-admin.sql`.
- **Correction** : supprimer les doublons `*_ck`.

### F2 — `subscriptions.montant` sans contrôle de non-négativité

- **Réf** : `server/supabase-schema.sql` (table `subscriptions`) vs `plans_prix_positive` (`:1134`), `employes_salaire_nonnegative_ck` (`:579`), `versements_montant_check` (`:1391`)
- **SQL** : `"montant" numeric(12,2) NOT NULL` sans `CHECK (montant >= 0)`.
- **Impact** : un montant d'abonnement négatif passerait toutes les validations, alors que le reste du schéma est cohérent sur ce point.
- **Correction** : ajouter `CHECK (montant >= 0)`.

### F3 — Politique morte sur `sessions`

- **Réf** : `server/supabase-schema.sql:2566` (politique) vs `:3020` (seul `GRANT` de `sessions`, vers `service_role`)
- **SQL** : `CREATE POLICY "owner_all_sessions" ON "public"."sessions" USING (("auth"."uid"() = "user_id")) ...` alors qu'aucun `GRANT` n'accorde `sessions` à `authenticated`.
- **Impact** : politique inappliquable ; elle laisse croire que l'utilisateur consulte ses propres sessions alors que la table est fermée — dette de lisibilité et risque de « réouverture » accidentelle.
- **Correction** : supprimer la politique ou documenter pourquoi elle est conservée.

### F4 — Politiques `FOR ALL` sans clause `TO authenticated` : elles s'appliquent aussi à `anon`

- **Réf** : `server/supabase-schema.sql:2526-2570` (`owner_all_biens`, `owner_all_paiements`, `owner_all_sessions`, …)
- **SQL** : `CREATE POLICY "owner_all_paiements" ON "public"."paiements" USING ("auth"."uid"() = "user_id") WITH CHECK (...)` — sans `TO "authenticated"`.
- **Impact** : sans clause de rôle, la politique s'applique aussi à `anon`. Inerte aujourd'hui (zéro privilège objet pour `anon`), mais la moindre future ouverture `GRANT ... TO anon` rendrait ces politiques `FOR ALL` opérationnelles immédiatement.
- **Correction** : ajouter `TO authenticated` à toutes les politiques sans clause de rôle.

### F5 — `FORCE ROW LEVEL SECURITY` sur 2 tables seulement

- **Réf** : `server/supabase-schema.sql:367` (`account_recovery_emails`) et `:595` (`employes_biens`)
- **SQL** : `ALTER TABLE ONLY "public"."..." FORCE ROW LEVEL SECURITY;` — absent des 33 autres tables.
- **Impact** : le propriétaire `postgres` contourne la RLS sur les 33 autres tables (ce qui fait fonctionner les 11 `SECURITY DEFINER`), mais toute connexion directe (`psql`, URL `postgres://`) échappe donc totalement aux politiques, y compris sur `sessions`, `moyens_paiement` et `paiements`.
- **Correction** : passer les tables sensibles en `FORCE` et laisser les fonctions s'appuyer explicitement sur `SECURITY DEFINER`.

### F6 — 7 tables en RLS sans aucune politique (fermées, jamais documentées)

- **Réf** : `server/supabase-schema.sql` — `account_recovery_emails`, `bictorys_webhooks`, `import_runs`, `import_run_rows`, `password_reset_tokens`, `quota_reservations`, `tenant_invitations`
- **SQL** : `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` sans aucune `CREATE POLICY` correspondante (28 autres tables en ont).
- **Impact** : comportement sûr (deny-all) mais non explicite : un futur `GRANT` de confort suivi d'une `CREATE POLICY` rapide réouvre ces tables sans que rien ne signale qu'elles étaient fermées ; `quota_reservations`/`import_runs` ne sont accessibles que via `service_role` (attendu, mais non documenté).
- **Correction** : ajouter un commentaire SQL explicite ou une politique `FOR ALL USING (false)` intentionnelle.

### F7 — `handle_new_user` écrit un email vide dans une colonne `NOT NULL UNIQUE`

- **Réf** : `server/supabase-schema.sql:176-207` (fonction) + `:1724` (`profiles.email` `NOT NULL` `UNIQUE`)
- **SQL** : `INSERT INTO public.profiles (id, email, ...) VALUES (NEW.id, COALESCE(NEW.email, ''), ...)`.
- **Impact** : deux comptes créés sans email produisent tous deux `''` → violation d'unicité → échec silencieux de la création du profil, donc de l'inscription. Les emails internes générés par `tenantEmailFor` (`@mim.local`) rendent ce cas rare, mais le chemin reste ouvert.
- **Correction** : rendre `profiles.email` nullable et ajouter `UNIQUE (email) WHERE email IS NOT NULL`.

### F8 — `SET row_security = off` en tête de dump

- **Réf** : `server/supabase-schema.sql:13`
- **SQL** : `SET row_security = off;`
- **Impact** : invalide la RLS pour toute la session d'exécution du fichier ; inoffensif sur du DDL pur, mais tout contenu ajouté manuellement après la ligne 13 (données, `UPDATE`) s'exécute sans politique.
- **Correction** : supprimer la ligne ou la réserver à la section des `CREATE`.

### F9 — `abonnement_paiements_plan_fkey` : seule FK des 80 sans `ON DELETE`

- **Réf** : `server/supabase-schema.sql:1951` (contrainte) — l'unique `FOREIGN KEY` sans `ON DELETE` sur les 80 du dump (`ON UPDATE CASCADE` seul).
- **SQL** : `FOREIGN KEY ("plan") REFERENCES "public"."plans"("code") ON UPDATE CASCADE;`
- **Impact** : comportement par défaut `NO ACTION` → suppression d'un `plans.code` référencé refusée. C'est l'effet **souhaité**, mais le schéma n'est pas homogène : le fait de ne pas savoir si c'est volontaire constitue le défaut.
- **Correction** : expliciter `ON DELETE RESTRICT`.

---

## Analyse de risque (clé `anon` exposée / injection SQL)

- **Clé `anon` exposée au client** : risque **faible**. `server/app.js:41,53` et `server/utils/oauth.js:7` utilisent la clé `anon` **uniquement côté serveur** ; le dump lui-même ne contient **aucune ligne `GRANT ... TO "anon"`** sur des objets (seul `GRANT USAGE ON SCHEMA "public" TO "anon"` à `:2720`, normal pour PostgREST). Une clé `anon` publique donne donc le droit de se connecter, mais zéro privilège sur table, colonne, fonction ou séquence. Le filet de sécurité est la révocation des privilèges par défaut — qui n'est **pas** figée dans le dump (voir M9).
- **Injection SQL utilisant le rôle `anon`** : le modèle tient grâce à la RLS, qui n'a aucune politique d'écriture `USING (true)` (voir points forts). En revanche une injection qui réussirait à emprunter `service_role` (`SUPABASE_SERVICE_ROLE_KEY`, `app.js:64`) **contourne entièrement la RLS** : la base n'a alors aucune seconde ligne de défense au niveau du schéma (les tables métier ne sont pas en `FORCE`, F5, et les `SECURITY DEFINER` valident les paramètres mais pas l'appartenance des données). Le vrai point de vigilance est donc le secret `service_role` et l'étanchéité du serveur, non la clé `anon`.

---

## Points forts

1. **RLS activée sur les 35/35 tables** du schéma `public` — aucun oubli.
2. **`anon` n'a aucun privilège objet** : aucune ligne `GRANT ... TO "anon"` dans les 3 075 lignes du dump ; `REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS ... FROM anon, authenticated` (`20260924000000:448-450`, `20260925000000:155-157`) et `ALTER DEFAULT PRIVILEGES ... REVOKE` (`20260925000000:181-183`).
3. **Aucune politique en écriture avec `USING (true)`** : la seule occurrence est `public_read_featured` (`:2625`), réservée en `FOR SELECT` sur le contenu mis en avant.
4. **Accès client strictement lecture seule** : `authenticated` ne reçoit que `GRANT SELECT` sur 22 tables (`:2782-3051`), plus deux privilèges colonne étroits — `UPDATE("name")` et `UPDATE("phone")` sur `profiles` (`:3008,3012`) et `UPDATE("lu")` + `DELETE` sur `notifications` (`:2947,2951`). L'écriture métier passe exclusivement par `service_role`.
5. **11 fonctions `SECURITY DEFINER` toutes en `SET "search_path" TO ''`** (`:26-313`) : protection contre les attaques par schéma recherché.
6. **`REVOKE ... EXECUTE ... FROM PUBLIC` sur les 11 fonctions** (`:2726-2776`) : aucune fonction accessible par défaut à `anon`/`authenticated`.
7. **Aucune contrainte `NOT VALID` résiduelle** : `20260924050000_validate_integrity.sql` et `20260925010000_security_followup.sql` les ont toutes validées.
8. **`server/run-schema.mjs:3-6`** est verrouillé par `MIM_ALLOW_LEGACY_SCHEMA_PUSH=I_UNDERSTAND_SCHEMA_PUSH` + `SUPABASE_PROJECT_REF` obligatoire — bonne pratique à étendre à `run-tenant-schema.mjs` (voir H3).
9. **Déclencheurs de protection en base** : `employes_biens_owner_guard` (`:1942`, refuse toute affectation si l'employé et le bien n'ont pas le même propriétaire, `:141-145`) et `tenant_invitations_guard` (`:1946`, valide le jeton, l'expiration et le nombre d'usages) — des garanties qui ne dépendent pas du code applicatif.
10. **Intégrité financière homogène** : `ON DELETE RESTRICT` sur `paiements`, `paiements_employes`, `abonnement_paiements`, `subscriptions`, `versements` (`20260924060000`), et index d'idempotence partiels bien conçus — `abonnement_paiements_idempotency_uidx`, `abonnement_paiements_transaction_uidx`, `paiements_locataire_mois_uidx` (`:1778-1898`).
11. **Identifiants non prévisibles** : `profiles_username_uniq` partiel (`:1910`) combiné à `uniqueUsername` (`tenantAccount.js:115-133`) qui impose un jeton aléatoire, et `account_recovery_emails_email_uidx` sur `lower(email)` (`:1790`).
12. **Jetons hachés plutôt qu'en clair** : `password_reset_tokens.token_hash` et `tenant_invitations.token_hash` avec index unique — le modèle à reproduire pour `sessions` (voir H7).
