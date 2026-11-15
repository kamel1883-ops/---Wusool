-- Wusool — Phase 3a schema: plan period pricing + public purchase requests.
-- Prices are data (editable from Super Admin → Plans), never hardcoded in code.

CREATE TABLE IF NOT EXISTS plan_prices (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  months INTEGER NOT NULL CHECK (months IN (3, 6, 9, 12)),
  price_sar INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, months)
);

-- Public order intake. A request alone creates NO account, NO company and NO
-- session: the customer-chosen password is stored hashed from the start and is
-- never returned by any endpoint. Activation happens only on admin approval.
CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  months INTEGER NOT NULL CHECK (months IN (3, 6, 9, 12)),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 210000,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_email ON purchase_requests(email);

-- Tier names and annual prices (12-month column); periods live in plan_prices.
UPDATE plans SET name_ar = 'الأساسية', name_en = 'Basic', price_sar = 800, sort_order = 1
  WHERE id = 'plan_starter';
UPDATE plans SET name_ar = 'المتوسطة', name_en = 'Growth', price_sar = 1600, sort_order = 2
  WHERE id = 'plan_growth';
UPDATE plans SET name_ar = 'الاحترافية', name_en = 'Professional', price_sar = 2600, sort_order = 3
  WHERE id = 'plan_enterprise';

INSERT OR IGNORE INTO plan_prices (plan_id, months, price_sar) VALUES
  ('plan_starter', 3, 200),
  ('plan_starter', 6, 400),
  ('plan_starter', 9, 600),
  ('plan_starter', 12, 800),
  ('plan_growth', 3, 400),
  ('plan_growth', 6, 800),
  ('plan_growth', 9, 1200),
  ('plan_growth', 12, 1600),
  ('plan_enterprise', 3, 650),
  ('plan_enterprise', 6, 1300),
  ('plan_enterprise', 9, 1950),
  ('plan_enterprise', 12, 2600);
