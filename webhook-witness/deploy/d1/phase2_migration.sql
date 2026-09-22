CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL,
  company TEXT,
  plan TEXT NOT NULL DEFAULT 'starter',
  access_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  use_case TEXT,
  plan TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT NOT NULL DEFAULT 'landing-page',
  notes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE events ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);

INSERT OR IGNORE INTO workspaces (name, slug, owner_email, company, plan, access_token, created_at, last_seen_at)
VALUES ('Demo Workspace', 'demo-workspace', 'demo@webhookwitness.dev', 'Webhook Witness', 'starter', 'demo-workspace-token', datetime('now'), datetime('now'));

UPDATE events
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'demo-workspace')
WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id);
