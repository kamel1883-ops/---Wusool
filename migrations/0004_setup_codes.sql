-- Wusool — Phase 3 schema additions (setup verification codes + real plan limits)
-- Every package carries functional limits enforced by the API, not just prices.

CREATE TABLE IF NOT EXISTS setup_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  token_hash TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_codes_email ON setup_codes(email);

-- Monthly analysis quota per plan (NULL = unlimited).
ALTER TABLE plans ADD COLUMN monthly_analyses INTEGER;

-- Real functional tiers: seats + monthly analyses + cumulative features.
UPDATE plans SET max_users = 3, monthly_analyses = 10 WHERE id = 'plan_starter';
UPDATE plans SET max_users = 10, monthly_analyses = 40 WHERE id = 'plan_growth';
UPDATE plans SET max_users = NULL, monthly_analyses = 200 WHERE id = 'plan_enterprise';

UPDATE plans SET features_ar = '["تحليل شامل للموقع","10 تحاليل جديدة كل شهر","3 مقاعد للفريق","تقارير عربية وإنجليزية","سجل تدقيق كامل"]',
  features_en = '["Full site analysis","10 new analyses per month","3 team seats","Arabic & English reports","Complete audit log"]'
  WHERE id = 'plan_starter';

UPDATE plans SET features_ar = '["كل مزايا الانطلاق","40 تحليلاً جديداً كل شهر","10 مقاعد للفريق","اعتماد التقارير وطلب التعديلات","أرشفة نسخ التقارير","تنبيه قرب انتهاء الاشتراك"]',
  features_en = '["Everything in Starter","40 new analyses per month","10 team seats","Report approval & change requests","Report version archive","Subscription expiry alerts"]'
  WHERE id = 'plan_growth';

UPDATE plans SET features_ar = '["كل مزايا النمو","200 تحليل جديد كل شهر","مقاعد غير محدودة","أولوية المعالجة","إثباتات الدفع البنكي داخل المنصة","دعم مخصص للاشتراك"]',
  features_en = '["Everything in Growth","200 new analyses per month","Unlimited seats","Priority processing","In-platform bank transfer proofs","Dedicated subscription support"]'
  WHERE id = 'plan_enterprise';
