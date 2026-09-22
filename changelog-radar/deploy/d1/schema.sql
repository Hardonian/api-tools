-- API Changelog Radar — Production D1 Schema
-- All tables use TEXT for datetimes (ISO-8601) as required by D1/SQLite.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-----------------------------------------------------------------------
-- Plans (must exist before users reference them)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  price_monthly  INTEGER NOT NULL,       -- cents
  max_sources    INTEGER NOT NULL,
  max_team_members INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  features_json  TEXT NOT NULL DEFAULT '{}' -- arbitrary feature flags
);

INSERT OR IGNORE INTO plans (key, name, price_monthly, max_sources, max_team_members, retention_days, rate_limit_rpm, features_json)
VALUES
  ('free',    'Free',    0,    2,   1,   7,   30,  '{"api_access":false,"webhook_alerts":false,"slack_alerts":false}'),
  ('starter', 'Starter', 3900, 5,   1,  30,   60,  '{"api_access":true,"webhook_alerts":true,"slack_alerts":false}'),
  ('growth',  'Growth',  14900,25,  5,  90,  300,  '{"api_access":true,"webhook_alerts":true,"slack_alerts":true}'),
  ('scale',   'Scale',   49900,200, 25, 365, 1000, '{"api_access":true,"webhook_alerts":true,"slack_alerts":true}');

-----------------------------------------------------------------------
-- Users
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  plan_key      TEXT NOT NULL DEFAULT 'free' REFERENCES plans(key),
  verified_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-----------------------------------------------------------------------
-- Teams
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key      TEXT NOT NULL DEFAULT 'free' REFERENCES plans(key),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);

CREATE TABLE IF NOT EXISTS team_members (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, team_id)
);

-----------------------------------------------------------------------
-- Sources (monitored URLs)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id              INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK(kind IN ('changelog','spec','webhook','rss','custom')),
  url                  TEXT NOT NULL,
  selector             TEXT,                    -- CSS selector for HTML extraction
  poll_interval_minutes INTEGER NOT NULL DEFAULT 60,
  status               TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_polled_at       TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_user   ON sources(user_id);
CREATE INDEX IF NOT EXISTS idx_sources_team   ON sources(team_id);
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status, last_polled_at);

-----------------------------------------------------------------------
-- Snapshots (fetched content)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash    TEXT NOT NULL,
  raw_content     TEXT,                     -- full fetched text
  character_count INTEGER NOT NULL DEFAULT 0,
  line_count      INTEGER NOT NULL DEFAULT 0,
  headline        TEXT,
  http_status     INTEGER,
  fetch_duration_ms INTEGER,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_source  ON snapshots(source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_hash    ON snapshots(source_id, content_hash);

-----------------------------------------------------------------------
-- Diffs (detected changes)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diffs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  old_snapshot_id   INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  new_snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  added_lines      INTEGER NOT NULL DEFAULT 0,
  removed_lines    INTEGER NOT NULL DEFAULT 0,
  changed_sections TEXT,                    -- JSON array of section names
  diff_patch       TEXT,                    -- unified diff format
  summary_text     TEXT,                    -- human-readable summary
  severity         TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','breaking')),
  notify_sent      INTEGER NOT NULL DEFAULT 0,
  detected_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_diffs_source   ON diffs(source_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_diffs_unsent   ON diffs(notify_sent, detected_at);

-----------------------------------------------------------------------
-- Alerts (notification configs)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id          INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  source_id        INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL CHECK(channel IN ('email','slack','webhook','in_app')),
  target           TEXT NOT NULL,           -- email addr / webhook URL / slack webhook
  config_json      TEXT NOT NULL DEFAULT '{}',
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_user   ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts(source_id);

-----------------------------------------------------------------------
-- Alert Log (delivery history)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  diff_id       INTEGER NOT NULL REFERENCES diffs(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','retried')),
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_log_alert ON alert_log(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_log_status ON alert_log(status);

-----------------------------------------------------------------------
-- Leads (landing page captures)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  email       TEXT NOT NULL,
  source_url  TEXT,
  converted   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

-----------------------------------------------------------------------
-- API Keys (programmatic access)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,              -- first 8 chars for identification
  name        TEXT NOT NULL DEFAULT 'Default',
  scopes      TEXT NOT NULL DEFAULT 'read',  -- comma-separated: read,write,admin
  last_used_at TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-----------------------------------------------------------------------
-- Audit Log (security trail)
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,             -- e.g. 'source.create', 'auth.login'
  resource_type TEXT,                      -- e.g. 'source', 'alert'
  resource_id   INTEGER,
  details_json  TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);

-----------------------------------------------------------------------
-- Rate Limit Tracking
-----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,             -- 'ip:1.2.3.4' or 'user:42'
  count      INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
