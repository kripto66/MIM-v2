-- ============================================================
-- Migration : Ultra-Admin Architecture
-- Tables : audit_logs, system_config, announcements, events, featured_items
-- Rôle : ultra_admin ajouté au CHECK de profiles.account_type
-- ============================================================

-- 1. Étendre le rôle pour inclure ultra_admin
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_account_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_type_check
  CHECK (account_type IN ('proprietaire','agence','entreprise','locataire','admin','employe','ultra_admin'));

-- 2. Table audit_logs (journal d'audit des actions administratives)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_id TEXT,
  target_type TEXT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','critical')),
  meta JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_level ON public.audit_logs(level);

-- RLS : seuls les admins et ultra_admins lisent les logs
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_audit_logs ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type IN ('admin', 'ultra_admin')
    )
  );

-- Insertion via service_role uniquement (pas de RLS INSERT pour authenticated)

-- 3. Table system_config (configurations globales de la plateforme)
CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS : seuls les ultra_admins lisent/écrivent
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY ultra_admin_all_system_config ON public.system_config
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type = 'ultra_admin'
    )
  );

-- 4. Table announcements (annonces Ultra Admin)
CREATE TABLE IF NOT EXISTS public.announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','owners','tenants','employees','admins')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_announcements_status ON public.announcements(status);
CREATE INDEX idx_announcements_audience ON public.announcements(audience);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY ultra_admin_all_announcements ON public.announcements
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type = 'ultra_admin'
    )
  );

-- Les admins et ultra_admins peuvent lire les annonces publiées
CREATE POLICY admin_read_announcements ON public.announcements
  FOR SELECT TO authenticated
  USING (
    status = 'published'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type IN ('admin', 'ultra_admin')
    )
  );

-- 5. Table events (événements Ultra Admin)
CREATE TABLE IF NOT EXISTS public.platform_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_date TIMESTAMPTZ NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','owners','tenants','employees','admins')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_events_status ON public.platform_events(status);
CREATE INDEX idx_platform_events_date ON public.platform_events(event_date);

ALTER TABLE public.platform_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ultra_admin_all_events ON public.platform_events
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type = 'ultra_admin'
    )
  );

CREATE POLICY admin_read_events ON public.platform_events
  FOR SELECT TO authenticated
  USING (
    status = 'published'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type IN ('admin', 'ultra_admin')
    )
  );

-- 6. Table featured_items (mise en avant / favoris)
CREATE TABLE IF NOT EXISTS public.featured_items (
  id BIGSERIAL PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','bien','logement','announcement','event')),
  target_id TEXT NOT NULL,
  badge TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  featured_until TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_featured_items_target ON public.featured_items(target_type, target_id);
CREATE INDEX idx_featured_items_priority ON public.featured_items(priority DESC);

ALTER TABLE public.featured_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY ultra_admin_all_featured ON public.featured_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.account_type = 'ultra_admin'
    )
  );

-- Lecture publique des éléments en avant (pour affichage éventuel)
CREATE POLICY public_read_featured ON public.featured_items
  FOR SELECT USING (true);
