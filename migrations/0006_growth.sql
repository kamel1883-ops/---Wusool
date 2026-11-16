-- Wusool — lead acquisition and marketing automation.
--
-- Every row carries company_id and is only ever read through the company
-- resolved from the caller's membership. A lead cannot exist without an
-- evidence URL and a stated interest signal, and contact details cannot be
-- stored without declaring where they came from.

CREATE TABLE IF NOT EXISTS company_icp (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  services_json TEXT NOT NULL DEFAULT '[]',
  sectors_json TEXT NOT NULL DEFAULT '[]',
  cities_json TEXT NOT NULL DEFAULT '[]',
  countries_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  problems_json TEXT NOT NULL DEFAULT '[]',
  ideal_audience TEXT,
  offer TEXT,
  analysis_id TEXT REFERENCES site_analyses(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Discovery connectors are configuration, never fabricated data: a source is
-- only usable when the deployment actually holds its credentials.
CREATE TABLE IF NOT EXISTS lead_sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('licensed_data', 'organisation_search', 'crm')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_credentials'
    CHECK (status IN ('not_connected', 'requires_credentials', 'awaiting_approval', 'connected', 'disabled')),
  credential_ref TEXT,
  last_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, provider)
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id TEXT,
  name TEXT,
  company_name TEXT,
  job_title TEXT,
  sector TEXT,
  city TEXT,
  country TEXT,
  email TEXT,
  email_source TEXT CHECK (email_source IN ('public_page', 'licensed_provider', 'customer_provided')),
  phone TEXT,
  phone_source TEXT CHECK (phone_source IN ('public_page', 'licensed_provider', 'customer_provided')),
  website TEXT,
  profile_url TEXT,
  profile_platform TEXT,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('licensed_provider', 'manual_research', 'crm_import', 'inbound_form')),
  source_provider TEXT,
  source_url TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  evidence_checked_at TEXT,
  interest_signal TEXT NOT NULL
    CHECK (interest_signal IN ('search_intent', 'public_request', 'public_question', 'company_fit', 'inbound')),
  score INTEGER NOT NULL DEFAULT 0,
  score_reason_json TEXT NOT NULL DEFAULT '[]',
  stage TEXT NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'qualified', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost')),
  consent_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (consent_state IN ('unknown', 'granted', 'withdrawn')),
  consent_at TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT,
  discovered_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  UNIQUE (company_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_leads_company_stage ON leads(company_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_company_campaign ON leads(company_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_company_discovered ON leads(company_id, discovered_at);

CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('note', 'email', 'call', 'whatsapp', 'meeting', 'proposal', 'stage_change', 'consent')),
  note TEXT,
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'all')),
  address TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, channel, address)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT,
  audience TEXT,
  sector TEXT,
  city TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'meta', 'linkedin')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'awaiting_channel', 'ready', 'running', 'paused', 'completed', 'cancelled')),
  content_ref TEXT,
  content_approved INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  budget_sar INTEGER,
  starts_on TEXT,
  ends_on TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id, created_at);

CREATE TABLE IF NOT EXISTS campaign_channels (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_credentials',
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, channel)
);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'blocked', 'queued', 'sent', 'delivered', 'failed', 'replied', 'unsubscribed')),
  provider TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outreach_company ON outreach_messages(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_messages(campaign_id, status);

CREATE TABLE IF NOT EXISTS campaign_metrics (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  period_date TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  engagements INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  leads_count INTEGER NOT NULL DEFAULT 0,
  meetings INTEGER NOT NULL DEFAULT 0,
  proposals INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  revenue_sar INTEGER NOT NULL DEFAULT 0,
  spend_sar INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider')),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, period_date)
);
CREATE INDEX IF NOT EXISTS idx_metrics_company ON campaign_metrics(company_id, period_date);
