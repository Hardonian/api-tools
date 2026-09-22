-- ComfyUI API D1 Database Schema
-- Production SQLite/D1 Schema for ComfyUI Job Queue & Management Gateway

-- 1. Jobs Table: Track generation jobs lifecycle
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    client_id TEXT,
    workflow_id TEXT,
    workflow_name TEXT,
    workflow_json TEXT NOT NULL,
    params_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 5,
    gpu_required TEXT DEFAULT 'any',
    assigned_node_id TEXT,
    lease_expires_at TEXT,
    progress INTEGER DEFAULT 0,
    current_node TEXT,
    current_step INTEGER DEFAULT 0,
    total_steps INTEGER DEFAULT 0,
    outputs_json TEXT,
    error TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    webhook_url TEXT,
    webhook_status TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. Workflows Registry: Reusable ComfyUI workflow templates
CREATE TABLE workflows (
    id INTEGER PRIMARY KEY,
    workflow_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    category TEXT DEFAULT 'general',
    tags TEXT,
    workflow_json TEXT NOT NULL,
    default_params_json TEXT,
    version TEXT DEFAULT '1.0.0',
    author TEXT DEFAULT 'Hardonian',
    usage_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 3. GPU Worker Nodes: Fleet tracking for local and cloud worker instances
CREATE TABLE gpu_nodes (
    id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    hostname TEXT,
    ip_address TEXT,
    gpu_type TEXT,
    vram_gb REAL DEFAULT 0.0,
    status TEXT DEFAULT 'online',
    max_concurrency INTEGER DEFAULT 1,
    active_jobs INTEGER DEFAULT 0,
    completed_jobs INTEGER DEFAULT 0,
    failed_jobs INTEGER DEFAULT 0,
    last_heartbeat TEXT DEFAULT (datetime('now')),
    metadata_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- 4. Job Logs: Detailed execution logs streamed from workers
CREATE TABLE job_logs (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL,
    level TEXT DEFAULT 'INFO',
    message TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
);

-- 5. API Keys Table: Role-based access control
CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'client',
    rate_limit INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT
);

-- Performance Indexes
CREATE INDEX idx_jobs_status_priority ON jobs(status, priority, created_at);
CREATE INDEX idx_jobs_lease ON jobs(status, lease_expires_at);
CREATE INDEX idx_jobs_node ON jobs(assigned_node_id);
CREATE INDEX idx_jobs_created ON jobs(created_at);
CREATE INDEX idx_workflows_category ON workflows(category);
CREATE INDEX idx_workflows_slug ON workflows(slug);
CREATE INDEX idx_gpu_nodes_status ON gpu_nodes(status, last_heartbeat);
CREATE INDEX idx_job_logs_job_id ON job_logs(job_id, id);
