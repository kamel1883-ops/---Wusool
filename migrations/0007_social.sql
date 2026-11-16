-- Wusool — social accounts, posts and the publishing queue.
--
-- Rules encoded in the schema:
--   * A connection always belongs to one company; tokens live in a separate
--     table so listing accounts never touches ciphertext.
--   * A target row is one platform/account inside a post, so a success on one
--     platform and a failure on another never touches the successful one.
--   * Approval is a stored fact (approved_by/approved_at) with an immutable
--     version snapshot per edit.
--   * Jobs are unique per target: publishing twice cannot create two jobs.

CREATE TABLE IF NOT EXISTS social_connections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT,
  profile_id TEXT,
  account_name TEXT NOT NULL,
  account_type TEXT,
  -- connected | expiring | expired | requires_reconnect | pending_review | requires_credentials | not_supported
  token_status TEXT NOT NULL DEFAULT 'connected',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  connected_by TEXT,
  connected_at TEXT NOT NULL,
  expires_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, platform, account_id)
);
CREATE INDEX IF NOT EXISTS idx_social_connections_company ON social_connections(company_id, platform);

-- Ciphertext only. Never selected by any endpoint that builds a response.
CREATE TABLE IF NOT EXISTS social_tokens (
  connection_id TEXT PRIMARY KEY REFERENCES social_connections(id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- OAuth authorization attempts. Short-lived, single use, bound to the user and
-- company that started the flow so a callback cannot attach an account to a
-- different tenant.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  return_path TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  pending_token_enc TEXT,
  pending_accounts_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_company ON oauth_states(company_id, platform);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT,
  body_ar TEXT,
  body_en TEXT,
  link_url TEXT,
  cta_label TEXT,
  hashtags TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en', 'both')),
  -- draft | awaiting_approval | approved | scheduled | publishing | published
  -- | partially_published | failed | cancelled | archived
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  scheduled_at TEXT,
  created_by TEXT,
  submitted_by TEXT,
  submitted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_company ON social_posts(company_id, status, created_at);

CREATE TABLE IF NOT EXISTS social_post_versions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (post_id, version)
);

CREATE TABLE IF NOT EXISTS social_post_targets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES social_connections(id) ON DELETE SET NULL,
  platform TEXT NOT NULL,
  account_name TEXT,
  adapted_text TEXT,
  adapted_json TEXT NOT NULL DEFAULT '{}',
  -- blocked | ready | scheduled | publishing | published | failed | skipped
  status TEXT NOT NULL DEFAULT 'blocked',
  external_id TEXT,
  external_url TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (post_id, platform, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_social_targets_post ON social_post_targets(post_id);
CREATE INDEX IF NOT EXISTS idx_social_targets_company ON social_post_targets(company_id, status);

CREATE TABLE IF NOT EXISTS social_post_metrics (
  target_id TEXT PRIMARY KEY REFERENCES social_post_targets(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  impressions INTEGER,
  reach INTEGER,
  clicks INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  source TEXT NOT NULL DEFAULT 'platform api',
  fetched_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS social_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES social_post_targets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'publish_target',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- One job per target: requesting publishing twice cannot double-post.
  UNIQUE (target_id)
);
CREATE INDEX IF NOT EXISTS idx_social_jobs_due ON social_jobs(state, run_at);

CREATE TABLE IF NOT EXISTS social_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connection_id TEXT,
  post_id TEXT,
  target_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_events_company ON social_events(company_id, created_at);
