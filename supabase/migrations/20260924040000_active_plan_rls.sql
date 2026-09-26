DROP POLICY IF EXISTS authenticated_select_plans ON public.plans;
CREATE POLICY authenticated_select_plans ON public.plans
  FOR SELECT TO authenticated
  USING (actif = true);
