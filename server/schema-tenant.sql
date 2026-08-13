ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
    CHECK (account_type IN ('proprietaire', 'agence', 'entreprise', 'locataire', 'admin'));

ALTER TABLE public.locataires ADD COLUMN IF NOT EXISTS account_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE POLICY "tenant_select_locataire" ON public.locataires
    FOR SELECT USING (account_uid = auth.uid());

CREATE POLICY "tenant_link_locataire" ON public.locataires
    FOR UPDATE
    USING (lower(email) = lower(auth.jwt() ->> 'email') AND account_uid IS NULL)
    WITH CHECK (account_uid = auth.uid());

CREATE POLICY "tenant_select_logement" ON public.logements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.logement_id = logements.id
        )
    );

CREATE POLICY "tenant_select_bien" ON public.biens
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.bien_id = biens.id AND l.account_uid = auth.uid()
        )
    );

CREATE POLICY "tenant_select_paiement" ON public.paiements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.locataires l
            WHERE l.account_uid = auth.uid() AND l.id = paiements.locataire_id
        )
    );

CREATE POLICY "tenant_select_incident" ON public.incidents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.logements lg
            JOIN public.locataires l ON l.logement_id = lg.id
            WHERE lg.id = incidents.logement_id AND l.account_uid = auth.uid()
        )
    );
