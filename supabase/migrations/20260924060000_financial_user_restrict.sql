ALTER TABLE public.paiements DROP CONSTRAINT IF EXISTS paiements_user_id_fkey;
ALTER TABLE public.paiements ADD CONSTRAINT paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.paiements_employes DROP CONSTRAINT IF EXISTS paiements_employes_user_id_fkey;
ALTER TABLE public.paiements_employes ADD CONSTRAINT paiements_employes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.abonnement_paiements DROP CONSTRAINT IF EXISTS abonnement_paiements_user_id_fkey;
ALTER TABLE public.abonnement_paiements ADD CONSTRAINT abonnement_paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.versements DROP CONSTRAINT IF EXISTS versements_user_id_fkey;
ALTER TABLE public.versements ADD CONSTRAINT versements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
