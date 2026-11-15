-- Wusool — Phase 2 schema (site analysis + first strategic report)
-- Every table carries company_id; all access is filtered server-side by the
-- company resolved from the caller's membership (never from request input).

CREATE TABLE IF NOT EXISTS site_analyses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'crawling', 'extracting', 'analyzing',
                      'awaiting_review', 'approved', 'changes_requested', 'failed', 'cancelled')),
  provider TEXT,
  crawler_provider TEXT,
  model TEXT,
  locale TEXT NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en', 'ar-en')),
  max_pages INTEGER NOT NULL DEFAULT 10,
  max_depth INTEGER NOT NULL DEFAULT 2,
  consent_confirmed INTEGER NOT NULL DEFAULT 0,
  latest_version INTEGER NOT NULL DEFAULT 0,
  approved_version INTEGER,
  robots_policy TEXT,
  pages_found INTEGER NOT NULL DEFAULT 0,
  pages_analyzed INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_analyses_company ON site_analyses(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_analyses_status ON site_analyses(status);
CREATE INDEX IF NOT EXISTS idx_site_analyses_company_status ON site_analyses(company_id, status);

CREATE TABLE IF NOT EXISTS site_pages (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES site_analyses(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  status_code INTEGER,
  content_markdown TEXT,
  content_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  crawl_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (crawl_status IN ('ok', 'blocked', 'not_found', 'error', 'skipped')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (analysis_id, url)
);
CREATE INDEX IF NOT EXISTS idx_site_pages_analysis ON site_pages(analysis_id);
CREATE INDEX IF NOT EXISTS idx_site_pages_company ON site_pages(company_id);

-- Results are versioned and never overwritten: an edit inserts a new version,
-- so a previously approved report always stays retrievable.
CREATE TABLE IF NOT EXISTS analysis_results (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES site_analyses(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  source_summary TEXT,
  confidence REAL,
  created_by_ai INTEGER NOT NULL DEFAULT 1,
  edited_by_user TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (analysis_id, version)
);
CREATE INDEX IF NOT EXISTS idx_analysis_results_analysis ON analysis_results(analysis_id, version);

CREATE TABLE IF NOT EXISTS analysis_approvals (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES site_analyses(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('submitted', 'approved', 'changes_requested', 'reanalysis_requested')),
  user_id TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_approvals_analysis ON analysis_approvals(analysis_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_approvals_company ON analysis_approvals(company_id);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT,
  analysis_id TEXT,
  provider TEXT,
  model TEXT,
  operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_company ON ai_usage_events(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_analysis ON ai_usage_events(analysis_id);

-- ---------------------------------------------------------------------------
-- Analysis limits and provider defaults. All editable from Super Admin →
-- Platform settings; hard caps are enforced again in code.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('analysis.default_max_pages', '10', datetime('now')),
  ('analysis.default_max_depth', '2', datetime('now')),
  ('analysis.max_pages_hard_limit', '40', datetime('now')),
  ('analysis.max_depth_hard_limit', '4', datetime('now')),
  ('analysis.max_concurrent_jobs', '1', datetime('now')),
  ('analysis.rate_limit_per_hour', '10', datetime('now')),
  ('analysis.ai_provider', 'mock', datetime('now')),
  ('analysis.ai_model', 'mock-structured-v1', datetime('now')),
  ('analysis.crawler_provider', 'mock', datetime('now')),
  ('analysis.crawler_user_agent', 'WusoolBot/1.0', datetime('now')),
  ('analysis.show_cost_to_client', '0', datetime('now')),
  ('analysis.require_consent', '1', datetime('now'));
