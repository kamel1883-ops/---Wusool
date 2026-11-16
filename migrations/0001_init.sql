-- Wusool — Phase 1 schema (platform foundation)
-- Multi-tenant core: companies (tenants), users, memberships, sessions,
-- manual subscriptions/invoices, private payment proofs, usage counters, audit log.

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  price_sar INTEGER NOT NULL DEFAULT 0,
  billing_period TEXT NOT NULL DEFAULT 'annual',
  max_users INTEGER,
  features_ar TEXT NOT NULL DEFAULT '[]',
  features_en TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  domain TEXT,
  industry TEXT,
  city TEXT,
  country TEXT NOT NULL DEFAULT 'SA',
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  plan_id TEXT REFERENCES plans(id),
  subscription_start TEXT,
  subscription_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'expired', 'cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000, -- Workers caps PBKDF2 at 100k
  locale TEXT NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  platform_role TEXT NOT NULL DEFAULT 'none' CHECK (platform_role IN ('none', 'super_admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'marketing_manager', 'content_writer', 'designer', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON memberships(company_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  amount_sar INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'SAR',
  period_start TEXT,
  period_end TEXT,
  issued_at TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('draft', 'issued', 'pending_review', 'paid', 'void')),
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS payment_proofs (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reference TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proofs_invoice ON payment_proofs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_proofs_status ON payment_proofs(status);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('site_analysis', 'content_generation', 'image_generation', 'email_send', 'whatsapp_send')),
  quantity INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  model TEXT,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_company_kind ON usage_events(company_id, kind);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_email TEXT,
  company_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  meta TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_action_entity ON audit_logs(action, entity_id);

-- ---------------------------------------------------------------------------
-- Defaults
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO plans (id, name_ar, name_en, price_sar, billing_period, max_users, features_ar, features_en, is_active, sort_order, created_at)
VALUES
  ('plan_starter', 'الانطلاق', 'Starter', 0, 'annual', NULL, '[]', '[]', 1, 1, datetime('now')),
  ('plan_growth', 'النمو', 'Growth', 0, 'annual', NULL, '[]', '[]', 1, 2, datetime('now')),
  ('plan_enterprise', 'المؤسسات', 'Enterprise', 0, 'annual', NULL, '[]', '[]', 1, 3, datetime('now'));

-- Branding and platform identity are data, not code: everything below can be
-- changed from the Super Admin settings screen without touching the source.
INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('brand.name_ar', 'وصول', datetime('now')),
  ('brand.name_en', 'Wusool', datetime('now')),
  ('brand.tagline_ar', 'منصة ذكاء التسويق للشركات', datetime('now')),
  ('brand.tagline_en', 'Marketing intelligence for B2B teams', datetime('now')),
  ('brand.primary_color', '#17C6B4', datetime('now')),
  ('brand.ink_color', '#0E1B2D', datetime('now')),
  ('brand.logo_url', '/brand/logo.jpg', datetime('now')),
  ('brand.website', '', datetime('now')),
  ('support.email', '', datetime('now')),
  ('support.whatsapp', '', datetime('now')),
  ('billing.bank_name', '', datetime('now')),
  ('billing.account_name', '', datetime('now')),
  ('billing.iban', '', datetime('now')),
  ('billing.account_number', '', datetime('now')),
  ('billing.notes_ar', '', datetime('now')),
  ('billing.notes_en', '', datetime('now')),
  ('billing.currency', 'SAR', datetime('now')),
  ('owner.legal_name_ar', '', datetime('now')),
  ('owner.legal_name_en', '', datetime('now')),
  ('owner.cr_number', '', datetime('now')),
  ('owner.vat_number', '', datetime('now')),
  ('owner.representative', '', datetime('now')),
  ('owner.representative_phone', '', datetime('now')),
  ('owner.address', '', datetime('now')),
  ('owner.email', '', datetime('now')),
  ('owner.domain', '', datetime('now')),
  ('subscription.warning_days', '30', datetime('now')),
  ('platform.default_locale', 'ar', datetime('now')),
  ('platform.supported_locales', 'ar,en', datetime('now')),
  ('platform.setup_completed', '0', datetime('now'));
