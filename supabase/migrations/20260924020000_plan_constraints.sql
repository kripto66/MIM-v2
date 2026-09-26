ALTER TABLE public.plans
  ADD CONSTRAINT plans_max_logements_positive CHECK (max_logements IS NULL OR max_logements > 0),
  ADD CONSTRAINT plans_max_locataires_positive CHECK (max_locataires IS NULL OR max_locataires > 0);

ALTER TABLE public.abonnement_paiements
  ADD CONSTRAINT abonnement_paiements_plan_fkey
  FOREIGN KEY (plan) REFERENCES public.plans(code) ON UPDATE CASCADE NOT VALID;

ALTER TABLE public.abonnement_paiements
  VALIDATE CONSTRAINT abonnement_paiements_plan_fkey;
