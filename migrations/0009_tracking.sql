-- Wusool — first-party tracking (UTM links, clicks, events).
--
-- Every row belongs to exactly one company. A link is the only thing that is
-- public: its code is random and resolves to one destination, so a redirect
-- cannot be pointed at another tenant's data. Events never store an IP
-- address or a user agent — only a salted hash that cannot be reversed.

CREATE TABLE IF NOT EXISTS tracking_links (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  post_id TEXT REFERENCES social_posts(id) ON DELETE SET NULL,
  platform TEXT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracking_links_company ON tracking_links(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tracking_links_campaign ON tracking_links(company_id, campaign_id);

CREATE TABLE IF NOT EXISTS tracking_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES tracking_links(id) ON DELETE SET NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  post_id TEXT,
  campaign_id TEXT,
  kind TEXT NOT NULL
    CHECK (kind IN ('click', 'page_view', 'whatsapp_click', 'call_click', 'form_submit', 'lead')),
  platform TEXT,
  occurred_at TEXT NOT NULL,
  period_date TEXT NOT NULL,
  -- Salted SHA-256 of ip + user agent. Never the raw values.
  visitor_hash TEXT NOT NULL,
  country TEXT,
  device TEXT,
  referrer_host TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracking_events_company_date ON tracking_events(company_id, period_date);
CREATE INDEX IF NOT EXISTS idx_tracking_events_link ON tracking_events(link_id, kind);
CREATE INDEX IF NOT EXISTS idx_tracking_events_campaign ON tracking_events(company_id, campaign_id);

-- A lead can be attributed to the link that produced it. Nullable because
-- manual and provider leads have no Wusool link.
ALTER TABLE leads ADD COLUMN tracking_link_id TEXT;
