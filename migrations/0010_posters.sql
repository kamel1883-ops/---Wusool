-- Wusool — poster drafts generated in-house.
--
-- A poster is text plus a template, rendered to SVG on demand. Nothing is
-- generated with an external image service and nothing enters publishing
-- before a client approves it: the public URL serves approved posters only.

CREATE TABLE IF NOT EXISTS poster_drafts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  headline TEXT NOT NULL,
  subhead TEXT,
  cta TEXT,
  template TEXT NOT NULL DEFAULT 'bold' CHECK (template IN ('bold', 'minimal', 'offer')),
  size_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  brand_color TEXT NOT NULL DEFAULT '#0f766e',
  language TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posters_company ON poster_drafts(company_id, created_at);
