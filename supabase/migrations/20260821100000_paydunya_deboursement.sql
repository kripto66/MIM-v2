-- ============================================================
-- MIM - Décaissement PayDunya direct (API Déboursement / PUSH v2)
--
-- Le propriétaire / l'employé choisit le moyen qui reçoit les
-- versements automatiques (« pour_versement ») : Wave ou Orange Money.
-- MIM verse alors directement sur ce wallet (withdraw_mode mappé)
-- au lieu d'un simple crédit de compte PayDunya à compte PayDunya.
--
-- paydunya_redistributions gagne la traçabilité du décaissement :
--   withdraw_mode  : mode PayDunya utilisé ('wave-senegal',
--                    'orange-money-senegal', 'paydunya', ...)
--   provider_token : disburse_token v2 (suivi de statut, callback)
--   provider_ref   : référence opérateur retournée par PayDunya
-- ============================================================

ALTER TABLE paydunya_redistributions
  ADD COLUMN IF NOT EXISTS withdraw_mode text;

ALTER TABLE paydunya_redistributions
  ADD COLUMN IF NOT EXISTS provider_token text;

ALTER TABLE paydunya_redistributions
  ADD COLUMN IF NOT EXISTS provider_ref text;

ALTER TABLE moyens_paiement
  ADD COLUMN IF NOT EXISTS pour_versement boolean NOT NULL DEFAULT false;

ALTER TABLE moyens_paiement_employes
  ADD COLUMN IF NOT EXISTS pour_versement boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS paydunya_redistributions_provider_token_idx
  ON paydunya_redistributions (provider_token)
  WHERE provider_token IS NOT NULL;
