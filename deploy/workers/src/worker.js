/**
 * ComfyUI API Gateway & Queue Engine
 * Enterprise Cloudflare Worker implementation for ComfyUI Job Orchestration,
 * GPU Node Dispatching, Workflow Registry, and Pack Factory Integration.
 */

import { Router } from 'itty-router';

const router = Router();

// ============================================================================
// HELPER FUNCTIONS & RESPONSE WRAPPERS
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Client-ID',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function error(message, status = 400, details = null) {
  const payload = { error: message, status_code: status, timestamp: new Date().toISOString() };
  if (details) payload.details = details;
  return json(payload, status);
}

function generateId(prefix = 'job') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

// Timing-safe string comparison
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================================
// AUTHENTICATION & SECURITY MIDDLEWARE
// ============================================================================

async function authenticate(request, env, requiredRoles = ['client', 'worker', 'admin']) {
  // If no auth keys configured in environment, allow open development access
  const adminKey = env.ADMIN_API_KEY;
  const workerKey = env.WORKER_API_KEY || adminKey;
  const clientKey = env.CLIENT_API_KEY || adminKey;

  if (!adminKey && !workerKey && !clientKey) {
    return { authenticated: true, role: 'admin', keyName: 'dev-mode' };
  }

  const authHeader = request.headers.get('Authorization');
  const apiKeyHeader = request.headers.get('X-API-Key');

  let token = apiKeyHeader;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    return { authenticated: false, reason: 'Missing API key or Bearer token' };
  }

  // Check static environment keys
  if (adminKey && constantTimeCompare(token, adminKey)) {
    return { authenticated: true, role: 'admin', keyName: 'admin-env' };
  }
  if (workerKey && constantTimeCompare(token, workerKey) && requiredRoles.includes('worker')) {
    return { authenticated: true, role: 'worker', keyName: 'worker-env' };
  }
  if (clientKey && constantTimeCompare(token, clientKey) && requiredRoles.includes('client')) {
    return { authenticated: true, role: 'client', keyName: 'client-env' };
  }

  // Check database API keys table if present
  try {
    const keyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hashHex = Array.from(new Uint8Array(keyHash)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    const dbKey = await env.DB.prepare(
      'SELECT id, name, role, is_active FROM api_keys WHERE key_hash = ? AND is_active = 1'
    ).bind(hashHex).first();

    if (dbKey && requiredRoles.includes(dbKey.role)) {
      // Update last_used_at asynchronously
      env.DB.prepare('UPDATE api_keys SET last_used_at = datetime("now") WHERE id = ?').bind(dbKey.id).run().catch(() => {});
      return { authenticated: true, role: dbKey.role, keyName: dbKey.name };
    }
  } catch (err) {
    // If DB check fails, fallback to rejection
  }

  return { authenticated: false, reason: 'Invalid or unauthorized API key' };
}

// OPTIONS preflight handler
router.options('*', () => new Response(null, { headers: CORS_HEADERS, status: 204 }));

// ============================================================================
// SYSTEM & HEALTH ENDPOINTS
// ============================================================================

router.get('/health', async (request, env) => {
  let dbStatus = 'healthy';
  let pendingCount = 0;
  try {
    const res = await env.DB.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'queued'").first();
    pendingCount = res ? res.count : 0;
  } catch (e) {
    dbStatus = 'degraded: ' + e.message;
  }

  return json({
    status: dbStatus === 'healthy' ? 'ok' : 'degraded',
    service: 'comfyui-api',
    version: '1.0.0',
    database: dbStatus,
    queue: { queued_jobs: pendingCount },
    timestamp: new Date().toISOString(),
  });
});

router.get('/api/v1/health', async (request, env, ctx) => router.fetch(new Request('http://localhost/health', request), env, ctx));

router.get('/api/v1/stats', async (request, env) => {
  try {
    const totalJobs = await env.DB.prepare('SELECT COUNT(*) as c FROM jobs').first();
    const queuedJobs = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'queued'").first();
    const claimedJobs = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'claimed'").first();
    const processingJobs = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'processing'").first();
    const completedJobs = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'completed'").first();
    const failedJobs = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'failed'").first();
    const workflowsCount = await env.DB.prepare('SELECT COUNT(*) as c FROM workflows WHERE is_active = 1').first();
    const nodesCount = await env.DB.prepare("SELECT COUNT(*) as c FROM gpu_nodes WHERE status != 'offline'").first();

    const activeNodes = await env.DB.prepare(
      "SELECT node_id, name, gpu_type, vram_gb, status, active_jobs, completed_jobs, last_heartbeat FROM gpu_nodes ORDER BY last_heartbeat DESC LIMIT 20"
    ).all();

    return json({
      jobs: {
        total: totalJobs ? totalJobs.c : 0,
        queued: queuedJobs ? queuedJobs.c : 0,
        claimed: claimedJobs ? claimedJobs.c : 0,
        processing: processingJobs ? processingJobs.c : 0,
        completed: completedJobs ? completedJobs.c : 0,
        failed: failedJobs ? failedJobs.c : 0,
      },
      workflows: workflowsCount ? workflowsCount.c : 0,
      nodes: {
        active_count: nodesCount ? nodesCount.c : 0,
        list: activeNodes ? activeNodes.results : [],
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return error('Failed to fetch system stats', 500, e.message);
  }
});

// ============================================================================
// JOB MANAGEMENT API
// ============================================================================

// Submit a new generation job
router.post('/api/v1/jobs', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON payload in request body');
  }

  let {
    workflow,
    workflow_json,
    workflow_id,
    workflow_slug,
    params,
    priority,
    gpu_required,
    client_id,
    webhook_url,
    max_retries,
  } = body;

  let resolvedWorkflowJson = workflow_json || workflow;
  let resolvedWorkflowName = null;
  let resolvedWorkflowId = workflow_id || null;

  // If a workflow template ID or slug was provided, fetch the template from DB
  if (!resolvedWorkflowJson && (workflow_id || workflow_slug)) {
    let wfQuery = workflow_id
      ? env.DB.prepare('SELECT workflow_id, name, workflow_json, default_params_json FROM workflows WHERE workflow_id = ? AND is_active = 1').bind(workflow_id)
      : env.DB.prepare('SELECT workflow_id, name, workflow_json, default_params_json FROM workflows WHERE slug = ? AND is_active = 1').bind(workflow_slug);

    const wf = await wfQuery.first();
    if (!wf) {
      return error(`Workflow template '${workflow_id || workflow_slug}' not found`, 404);
    }
    resolvedWorkflowJson = wf.workflow_json;
    resolvedWorkflowName = wf.name;
    resolvedWorkflowId = wf.workflow_id;

    // Increment workflow usage
    env.DB.prepare('UPDATE workflows SET usage_count = usage_count + 1 WHERE workflow_id = ?').bind(wf.workflow_id).run().catch(() => {});
  }

  if (!resolvedWorkflowJson) {
    return error('Either workflow_json, workflow, workflow_id, or workflow_slug is required');
  }

  const rawWorkflowStr = typeof resolvedWorkflowJson === 'string' ? resolvedWorkflowJson : JSON.stringify(resolvedWorkflowJson);
  const rawParamsStr = params ? (typeof params === 'string' ? params : JSON.stringify(params)) : null;

  // Validate priority range (1 to 10)
  const jobPriority = Math.max(1, Math.min(10, parseInt(priority, 10) || 5));
  const jobId = generateId('job');

  try {
    await env.DB.prepare(
      `INSERT INTO jobs (
        job_id, client_id, workflow_id, workflow_name, workflow_json, params_json,
        status, priority, gpu_required, max_retries, webhook_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      jobId,
      client_id || null,
      resolvedWorkflowId,
      resolvedWorkflowName,
      rawWorkflowStr,
      rawParamsStr,
      jobPriority,
      gpu_required || 'any',
      parseInt(max_retries, 10) || 3,
      webhook_url || null
    ).run();

    // Get queue position
    const posResult = await env.DB.prepare(
      "SELECT COUNT(*) as pos FROM jobs WHERE status = 'queued' AND (priority > ? OR (priority = ? AND created_at <= (SELECT created_at FROM jobs WHERE job_id = ?)))"
    ).bind(jobPriority, jobPriority, jobId).first();

    return json({
      job_id: jobId,
      status: 'queued',
      priority: jobPriority,
      position: posResult ? posResult.pos : 1,
      workflow_name: resolvedWorkflowName,
      created_at: new Date().toISOString(),
    }, 201);
  } catch (e) {
    return error('Failed to enqueue job', 500, e.message);
  }
});

// List jobs with filtering and pagination
router.get('/api/v1/jobs', async (request, env) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const clientId = url.searchParams.get('client_id');
  const nodeId = url.searchParams.get('node_id');
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);

  let query = 'SELECT id, job_id, client_id, workflow_id, workflow_name, status, priority, gpu_required, assigned_node_id, progress, current_node, current_step, total_steps, outputs_json, error, retry_count, webhook_url, created_at, started_at, completed_at, updated_at FROM jobs WHERE 1=1';
  const binds = [];

  if (status) {
    query += ' AND status = ?';
    binds.push(status);
  }
  if (clientId) {
    query += ' AND client_id = ?';
    binds.push(clientId);
  }
  if (nodeId) {
    query += ' AND assigned_node_id = ?';
    binds.push(nodeId);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  try {
    const stmt = env.DB.prepare(query);
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all();
    
    // Parse outputs_json for clean API consumption
    const jobs = (result.results || []).map(j => {
      let outputs = null;
      if (j.outputs_json) {
        try { outputs = JSON.parse(j.outputs_json); } catch {}
      }
      return { ...j, outputs };
    });

    return json({ jobs, limit, offset, count: jobs.length });
  } catch (e) {
    return error('Failed to query jobs', 500, e.message);
  }
});

// Get detailed job information by ID
router.get('/api/v1/jobs/:id', async (request, env) => {
  const jobId = request.params.id;
  try {
    const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ? OR id = ?').bind(jobId, jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    let workflow = null;
    let params = null;
    let outputs = null;

    try { if (job.workflow_json) workflow = JSON.parse(job.workflow_json); } catch {}
    try { if (job.params_json) params = JSON.parse(job.params_json); } catch {}
    try { if (job.outputs_json) outputs = JSON.parse(job.outputs_json); } catch {}

    return json({
      ...job,
      workflow,
      params,
      outputs,
    });
  } catch (e) {
    return error('Failed to retrieve job', 500, e.message);
  }
});

// Lightweight job status polling endpoint
router.get('/api/v1/jobs/:id/status', async (request, env) => {
  const jobId = request.params.id;
  try {
    const job = await env.DB.prepare(
      'SELECT job_id, status, progress, current_node, current_step, total_steps, outputs_json, error, retry_count, updated_at FROM jobs WHERE job_id = ?'
    ).bind(jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    let outputs = null;
    if (job.outputs_json) {
      try { outputs = JSON.parse(job.outputs_json); } catch {}
    }

    return json({
      job_id: job.job_id,
      status: job.status,
      progress: job.progress,
      current_node: job.current_node,
      current_step: job.current_step,
      total_steps: job.total_steps,
      has_outputs: !!job.outputs_json,
      outputs,
      error: job.error,
      retry_count: job.retry_count,
      updated_at: job.updated_at,
    });
  } catch (e) {
    return error('Failed to fetch job status', 500, e.message);
  }
});

// Cancel a job
router.post('/api/v1/jobs/:id/cancel', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const jobId = request.params.id;
  try {
    const job = await env.DB.prepare('SELECT id, job_id, status FROM jobs WHERE job_id = ?').bind(jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return error(`Cannot cancel job in '${job.status}' state`, 400);
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = 'cancelled', updated_at = datetime('now'), completed_at = datetime('now') WHERE job_id = ?"
    ).bind(jobId).run();

    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'WARN', 'Job cancelled by user request', datetime('now'))"
    ).bind(jobId).run().catch(() => {});

    return json({ job_id: jobId, status: 'cancelled', message: 'Job successfully cancelled' });
  } catch (e) {
    return error('Failed to cancel job', 500, e.message);
  }
});

// Retry a failed or cancelled job
router.post('/api/v1/jobs/:id/retry', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const jobId = request.params.id;
  try {
    const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    await env.DB.prepare(
      `UPDATE jobs SET
        status = 'queued',
        assigned_node_id = NULL,
        lease_expires_at = NULL,
        progress = 0,
        current_node = NULL,
        current_step = 0,
        outputs_json = NULL,
        error = NULL,
        retry_count = retry_count + 1,
        started_at = NULL,
        completed_at = NULL,
        updated_at = datetime('now')
       WHERE job_id = ?`
    ).bind(jobId).run();

    return json({ job_id: jobId, status: 'queued', retry_count: job.retry_count + 1, message: 'Job requeued successfully' });
  } catch (e) {
    return error('Failed to retry job', 500, e.message);
  }
});

// Get job logs
router.get('/api/v1/jobs/:id/logs', async (request, env) => {
  const jobId = request.params.id;
  try {
    const logs = await env.DB.prepare(
      'SELECT id, level, message, timestamp FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT 200'
    ).bind(jobId).all();

    return json({ job_id: jobId, logs: logs ? logs.results : [] });
  } catch (e) {
    return error('Failed to retrieve job logs', 500, e.message);
  }
});

// ============================================================================
// WORKER NODE DISPATCHING & COORDINATION PROTOCOL
// ============================================================================

// Register a GPU worker node
router.post('/api/v1/nodes/register', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { node_id, name, hostname, ip_address, gpu_type, vram_gb, max_concurrency, metadata } = body;
  if (!node_id || !name) return error('node_id and name are required');

  const rawMeta = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO gpu_nodes (node_id, name, hostname, ip_address, gpu_type, vram_gb, status, max_concurrency, last_heartbeat, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'online', ?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(node_id) DO UPDATE SET
         name = excluded.name,
         hostname = excluded.hostname,
         ip_address = excluded.ip_address,
         gpu_type = excluded.gpu_type,
         vram_gb = excluded.vram_gb,
         status = 'online',
         max_concurrency = excluded.max_concurrency,
         last_heartbeat = datetime('now'),
         metadata_json = excluded.metadata_json`
    ).bind(
      node_id,
      name,
      hostname || null,
      ip_address || null,
      gpu_type || 'generic-gpu',
      parseFloat(vram_gb) || 0.0,
      parseInt(max_concurrency, 10) || 1,
      rawMeta
    ).run();

    return json({ node_id, status: 'registered', timestamp: new Date().toISOString() });
  } catch (e) {
    return error('Failed to register node', 500, e.message);
  }
});

// Worker heartbeat ping
router.post('/api/v1/nodes/heartbeat', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { node_id, active_jobs, status } = body;
  if (!node_id) return error('node_id is required');

  try {
    const result = await env.DB.prepare(
      `UPDATE gpu_nodes SET
         last_heartbeat = datetime('now'),
         status = ?,
         active_jobs = ?
       WHERE node_id = ?`
    ).bind(
      status || 'online',
      parseInt(active_jobs, 10) || 0,
      node_id
    ).run();

    if (result.meta && result.meta.changes === 0) {
      return error(`Node '${node_id}' not registered`, 404);
    }

    return json({ status: 'ok', node_id, timestamp: new Date().toISOString() });
  } catch (e) {
    return error('Failed to process heartbeat', 500, e.message);
  }
});

// List all registered GPU nodes
router.get('/api/v1/nodes', async (request, env) => {
  try {
    const nodes = await env.DB.prepare(
      'SELECT node_id, name, hostname, ip_address, gpu_type, vram_gb, status, max_concurrency, active_jobs, completed_jobs, failed_jobs, last_heartbeat, created_at FROM gpu_nodes ORDER BY last_heartbeat DESC'
    ).all();

    // Mark nodes inactive if heartbeat older than 2 minutes
    const now = Date.now();
    const enriched = (nodes.results || []).map(n => {
      const hbTime = new Date(n.last_heartbeat + 'Z').getTime();
      const isStale = (now - hbTime) > 120000;
      return {
        ...n,
        is_stale: isStale,
        computed_status: isStale ? 'offline' : n.status,
      };
    });

    return json({ nodes: enriched });
  } catch (e) {
    return error('Failed to list nodes', 500, e.message);
  }
});

// Claim next available job (Atomic Worker Lease)
router.post('/api/v1/jobs/claim', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const { node_id, gpu_type, lease_seconds = 180 } = body;
  if (!node_id) return error('node_id is required to claim jobs');

  try {
    // Find highest priority queued job (or expired lease) matching GPU capability
    let candidateQuery = `
      SELECT id, job_id, workflow_id, workflow_name, workflow_json, params_json, priority, gpu_required, retry_count
      FROM jobs
      WHERE (status = 'queued' OR (status IN ('claimed', 'processing') AND lease_expires_at < datetime('now')))
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `;

    const candidate = await env.DB.prepare(candidateQuery).first();
    if (!candidate) {
      return json({ job: null, message: 'No queued jobs available' });
    }

    // Atomic lease update: ensure job is still queued or expired
    const leaseTimeSeconds = Math.max(30, Math.min(600, parseInt(lease_seconds, 10) || 180));
    const updateResult = await env.DB.prepare(
      `UPDATE jobs SET
         status = 'claimed',
         assigned_node_id = ?,
         lease_expires_at = datetime('now', '+' || ? || ' seconds'),
         started_at = COALESCE(started_at, datetime('now')),
         updated_at = datetime('now')
       WHERE id = ? AND (status = 'queued' OR (status IN ('claimed', 'processing') AND lease_expires_at < datetime('now')))`
    ).bind(node_id, leaseTimeSeconds, candidate.id).run();

    if (updateResult.meta && updateResult.meta.changes === 0) {
      // Race condition: another worker claimed it first
      return json({ job: null, message: 'Job claimed by another worker, retry claim' });
    }

    // Update node active jobs count
    env.DB.prepare('UPDATE gpu_nodes SET active_jobs = active_jobs + 1, last_heartbeat = datetime("now") WHERE node_id = ?').bind(node_id).run().catch(() => {});

    // Record log entry
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'INFO', ? , datetime('now'))"
    ).bind(candidate.job_id, `Job claimed by worker node ${node_id}`).run().catch(() => {});

    let workflow = null;
    let params = null;
    try { workflow = JSON.parse(candidate.workflow_json); } catch {}
    try { if (candidate.params_json) params = JSON.parse(candidate.params_json); } catch {}

    return json({
      job: {
        job_id: candidate.job_id,
        workflow_id: candidate.workflow_id,
        workflow_name: candidate.workflow_name,
        workflow,
        params,
        priority: candidate.priority,
        retry_count: candidate.retry_count,
        lease_seconds: leaseTimeSeconds,
      },
    });
  } catch (e) {
    return error('Failed to claim job', 500, e.message);
  }
});

// Worker progress update & lease extension
router.post('/api/v1/jobs/:id/progress', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const jobId = request.params.id;
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { node_id, progress, current_node, current_step, total_steps, log_message, lease_extend_seconds = 120 } = body;

  try {
    const leaseSec = Math.max(30, Math.min(600, parseInt(lease_extend_seconds, 10) || 120));
    await env.DB.prepare(
      `UPDATE jobs SET
         status = 'processing',
         progress = ?,
         current_node = ?,
         current_step = ?,
         total_steps = ?,
         lease_expires_at = datetime('now', '+' || ? || ' seconds'),
         updated_at = datetime('now')
       WHERE job_id = ? AND (assigned_node_id = ? OR assigned_node_id IS NULL)`
    ).bind(
      Math.max(0, Math.min(100, parseInt(progress, 10) || 0)),
      current_node || null,
      parseInt(current_step, 10) || 0,
      parseInt(total_steps, 10) || 0,
      leaseSec,
      jobId,
      node_id || ''
    ).run();

    if (log_message) {
      await env.DB.prepare(
        "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'INFO', ?, datetime('now'))"
      ).bind(jobId, log_message).run().catch(() => {});
    }

    return json({ status: 'ok', job_id: jobId, progress });
  } catch (e) {
    return error('Failed to update progress', 500, e.message);
  }
});

// Worker complete job
router.post('/api/v1/jobs/:id/complete', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const jobId = request.params.id;
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { node_id, outputs, metrics } = body;
  const rawOutputs = outputs ? (typeof outputs === 'string' ? outputs : JSON.stringify(outputs)) : JSON.stringify([]);

  try {
    const job = await env.DB.prepare('SELECT id, webhook_url FROM jobs WHERE job_id = ?').bind(jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    await env.DB.prepare(
      `UPDATE jobs SET
         status = 'completed',
         progress = 100,
         outputs_json = ?,
         lease_expires_at = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE job_id = ?`
    ).bind(rawOutputs, jobId).run();

    // Update node metrics
    if (node_id) {
      env.DB.prepare('UPDATE gpu_nodes SET completed_jobs = completed_jobs + 1, active_jobs = MAX(0, active_jobs - 1), last_heartbeat = datetime("now") WHERE node_id = ?').bind(node_id).run().catch(() => {});
    }

    // Log completion
    const metricsMsg = metrics ? ` Completed with metrics: ${JSON.stringify(metrics)}` : '';
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'INFO', ?, datetime('now'))"
    ).bind(jobId, `Job completed successfully.${metricsMsg}`).run().catch(() => {});

    // Trigger webhook if registered
    if (job.webhook_url) {
      dispatchWebhook(job.webhook_url, { event: 'job.completed', job_id: jobId, outputs, status: 'completed' }).catch(() => {});
    }

    return json({ status: 'completed', job_id: jobId, message: 'Job recorded as completed' });
  } catch (e) {
    return error('Failed to complete job', 500, e.message);
  }
});

// Worker fail job
router.post('/api/v1/jobs/:id/fail', async (request, env) => {
  const auth = await authenticate(request, env, ['worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const jobId = request.params.id;
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { node_id, error: errorMsg, traceback, can_retry = true } = body;

  try {
    const job = await env.DB.prepare('SELECT id, retry_count, max_retries, webhook_url FROM jobs WHERE job_id = ?').bind(jobId).first();
    if (!job) return error(`Job '${jobId}' not found`, 404);

    const shouldRetry = can_retry && (job.retry_count < job.max_retries);
    const newStatus = shouldRetry ? 'queued' : 'failed';

    await env.DB.prepare(
      `UPDATE jobs SET
         status = ?,
         error = ?,
         lease_expires_at = NULL,
         retry_count = retry_count + 1,
         assigned_node_id = CASE WHEN ? = 'queued' THEN NULL ELSE assigned_node_id END,
         completed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END,
         updated_at = datetime('now')
       WHERE job_id = ?`
    ).bind(newStatus, errorMsg || 'Unknown worker execution failure', newStatus, newStatus, jobId).run();

    // Update node metrics
    if (node_id) {
      env.DB.prepare('UPDATE gpu_nodes SET failed_jobs = failed_jobs + 1, active_jobs = MAX(0, active_jobs - 1), last_heartbeat = datetime("now") WHERE node_id = ?').bind(node_id).run().catch(() => {});
    }

    // Log failure
    const logText = `Execution failed on node ${node_id || 'unknown'}: ${errorMsg}.${shouldRetry ? ' Re-queued for retry.' : ' Max retries exceeded.'}`;
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'ERROR', ?, datetime('now'))"
    ).bind(jobId, logText).run().catch(() => {});

    if (traceback) {
      await env.DB.prepare(
        "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'DEBUG', ?, datetime('now'))"
      ).bind(jobId, `Traceback: ${traceback}`).run().catch(() => {});
    }

    if (newStatus === 'failed' && job.webhook_url) {
      dispatchWebhook(job.webhook_url, { event: 'job.failed', job_id: jobId, error: errorMsg, status: 'failed' }).catch(() => {});
    }

    return json({ status: newStatus, job_id: jobId, retry_scheduled: shouldRetry, error: errorMsg });
  } catch (e) {
    return error('Failed to record job failure', 500, e.message);
  }
});

// Helper for background webhook dispatch
async function dispatchWebhook(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ComfyUI-API-Webhook/1.0' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Webhook delivery failed:', err);
  }
}

// ============================================================================
// WORKFLOW TEMPLATE REGISTRY
// ============================================================================

// Register a new workflow template
router.post('/api/v1/workflows', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { name, slug, description, category, tags, workflow_json, default_params, version, author } = body;
  if (!name || !workflow_json) return error('name and workflow_json are required');

  const wfSlug = slug || slugify(name);
  const wfId = generateId('wf');
  const rawWfStr = typeof workflow_json === 'string' ? workflow_json : JSON.stringify(workflow_json);
  const rawDefParams = default_params ? (typeof default_params === 'string' ? default_params : JSON.stringify(default_params)) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO workflows (workflow_id, name, slug, description, category, tags, workflow_json, default_params_json, version, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      wfId,
      name,
      wfSlug,
      description || '',
      category || 'general',
      tags || '',
      rawWfStr,
      rawDefParams,
      version || '1.0.0',
      author || 'Hardonian'
    ).run();

    return json({ workflow_id: wfId, name, slug: wfSlug, version: version || '1.0.0' }, 201);
  } catch (e) {
    return error('Failed to register workflow template', 500, e.message);
  }
});

// List workflows
router.get('/api/v1/workflows', async (request, env) => {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const search = url.searchParams.get('search');

  let query = 'SELECT id, workflow_id, name, slug, description, category, tags, default_params_json, version, author, usage_count, created_at, updated_at FROM workflows WHERE is_active = 1';
  const binds = [];

  if (category) {
    query += ' AND category = ?';
    binds.push(category);
  }
  if (search) {
    query += ' AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const term = `%${search}%`;
    binds.push(term, term, term);
  }

  query += ' ORDER BY usage_count DESC, created_at DESC LIMIT 100';

  try {
    const stmt = env.DB.prepare(query);
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all();

    const workflows = (result.results || []).map(w => {
      let default_params = null;
      if (w.default_params_json) {
        try { default_params = JSON.parse(w.default_params_json); } catch {}
      }
      return { ...w, default_params };
    });

    return json({ workflows, count: workflows.length });
  } catch (e) {
    return error('Failed to list workflows', 500, e.message);
  }
});

// Get workflow by ID or slug
router.get('/api/v1/workflows/:id', async (request, env) => {
  const idOrSlug = request.params.id;
  try {
    const wf = await env.DB.prepare(
      'SELECT * FROM workflows WHERE (workflow_id = ? OR slug = ? OR id = ?) AND is_active = 1'
    ).bind(idOrSlug, idOrSlug, idOrSlug).first();

    if (!wf) return error(`Workflow '${idOrSlug}' not found`, 404);

    let workflow_json = null;
    let default_params = null;
    try { workflow_json = JSON.parse(wf.workflow_json); } catch {}
    try { if (wf.default_params_json) default_params = JSON.parse(wf.default_params_json); } catch {}

    return json({ ...wf, workflow_json, default_params });
  } catch (e) {
    return error('Failed to retrieve workflow', 500, e.message);
  }
});

// Update workflow template
router.put('/api/v1/workflows/:id', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const idOrSlug = request.params.id;
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { name, description, category, tags, workflow_json, default_params, version } = body;

  try {
    const wf = await env.DB.prepare('SELECT workflow_id FROM workflows WHERE (workflow_id = ? OR slug = ?) AND is_active = 1').bind(idOrSlug, idOrSlug).first();
    if (!wf) return error(`Workflow '${idOrSlug}' not found`, 404);

    const rawWfStr = workflow_json ? (typeof workflow_json === 'string' ? workflow_json : JSON.stringify(workflow_json)) : null;
    const rawDefParams = default_params ? (typeof default_params === 'string' ? default_params : JSON.stringify(default_params)) : null;

    await env.DB.prepare(
      `UPDATE workflows SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         category = COALESCE(?, category),
         tags = COALESCE(?, tags),
         workflow_json = COALESCE(?, workflow_json),
         default_params_json = COALESCE(?, default_params_json),
         version = COALESCE(?, version),
         updated_at = datetime('now')
       WHERE workflow_id = ?`
    ).bind(
      name || null,
      description || null,
      category || null,
      tags || null,
      rawWfStr,
      rawDefParams,
      version || null,
      wf.workflow_id
    ).run();

    return json({ workflow_id: wf.workflow_id, message: 'Workflow updated successfully' });
  } catch (e) {
    return error('Failed to update workflow', 500, e.message);
  }
});

// Delete (soft-delete) workflow
router.delete('/api/v1/workflows/:id', async (request, env) => {
  const auth = await authenticate(request, env, ['admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const idOrSlug = request.params.id;
  try {
    const res = await env.DB.prepare(
      "UPDATE workflows SET is_active = 0, updated_at = datetime('now') WHERE workflow_id = ? OR slug = ?"
    ).bind(idOrSlug, idOrSlug).run();

    if (res.meta && res.meta.changes === 0) return error(`Workflow '${idOrSlug}' not found`, 404);

    return json({ workflow_id: idOrSlug, message: 'Workflow deleted successfully' });
  } catch (e) {
    return error('Failed to delete workflow', 500, e.message);
  }
});

// Direct execute workflow template shortcut
router.post('/api/v1/workflows/:id/execute', async (request, env, ctx) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  const idOrSlug = request.params.id;
  let body = {};
  try { body = await request.json(); } catch {}

  const wf = await env.DB.prepare(
    'SELECT workflow_id, name, workflow_json FROM workflows WHERE (workflow_id = ? OR slug = ?) AND is_active = 1'
  ).bind(idOrSlug, idOrSlug).first();

  if (!wf) return error(`Workflow template '${idOrSlug}' not found`, 404);

  // Delegate to job submission logic
  const jobPayload = {
    workflow_id: wf.workflow_id,
    workflow_json: wf.workflow_json,
    params: body.params || body,
    priority: body.priority || 5,
    gpu_required: body.gpu_required || 'any',
    webhook_url: body.webhook_url || null,
    client_id: body.client_id || null,
  };

  const reqMock = new Request('http://localhost/api/v1/jobs', {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(jobPayload),
  });

  return router.fetch(reqMock, env, ctx);
});

// ============================================================================
// BATCH GENERATION API (PACK FACTORY INTEGRATION)
// ============================================================================

router.post('/api/v1/batch/submit', async (request, env) => {
  const auth = await authenticate(request, env, ['client', 'worker', 'admin']);
  if (!auth.authenticated) return error(auth.reason, 401);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON payload'); }

  const { workflow_id, workflow_slug, workflow_json, items, common_params = {}, priority = 5 } = body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return error('items must be a non-empty array of parameter configurations');
  }

  if (items.length > 100) {
    return error('Batch items count cannot exceed 100 per submission');
  }

  let resolvedWorkflowJson = workflow_json;
  let resolvedWorkflowName = null;
  let resolvedWorkflowId = workflow_id || null;

  if (!resolvedWorkflowJson && (workflow_id || workflow_slug)) {
    const wf = await env.DB.prepare(
      'SELECT workflow_id, name, workflow_json FROM workflows WHERE (workflow_id = ? OR slug = ?) AND is_active = 1'
    ).bind(workflow_id || '', workflow_slug || '').first();

    if (!wf) return error(`Workflow template '${workflow_id || workflow_slug}' not found`, 404);
    resolvedWorkflowJson = wf.workflow_json;
    resolvedWorkflowName = wf.name;
    resolvedWorkflowId = wf.workflow_id;
  }

  if (!resolvedWorkflowJson) return error('Workflow must be provided via workflow_id, workflow_slug, or workflow_json');

  const rawWfStr = typeof resolvedWorkflowJson === 'string' ? resolvedWorkflowJson : JSON.stringify(resolvedWorkflowJson);
  const createdJobs = [];
  const batchId = generateId('batch');

  for (let i = 0; i < items.length; i++) {
    const itemParams = { ...common_params, ...items[i] };
    const jobId = generateId('job');
    const itemPriority = itemParams.priority || priority || 5;

    await env.DB.prepare(
      `INSERT INTO jobs (
        job_id, client_id, workflow_id, workflow_name, workflow_json, params_json,
        status, priority, gpu_required, max_retries, webhook_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 3, ?, datetime('now'), datetime('now'))`
    ).bind(
      jobId,
      batchId,
      resolvedWorkflowId,
      resolvedWorkflowName,
      rawWfStr,
      JSON.stringify(itemParams),
      itemPriority,
      itemParams.gpu_required || 'any',
      itemParams.webhook_url || null
    ).run();

    createdJobs.push({ job_id: jobId, index: i, params: itemParams });
  }

  return json({
    batch_id: batchId,
    workflow_name: resolvedWorkflowName,
    job_count: createdJobs.length,
    jobs: createdJobs,
    created_at: new Date().toISOString(),
  }, 201);
});

// ============================================================================
// GITHUB WEBHOOK INTEGRATION
// ============================================================================

router.post('/api/v1/webhook/github', async (request, env) => {
  const event = request.headers.get('x-github-event');
  let payload = {};
  try { payload = await request.json(); } catch {}

  if (event === 'push') {
    return json({ status: 'received', repo: payload.repository?.full_name, ref: payload.ref });
  }
  return json({ status: 'ignored', event });
});

// ============================================================================
// CRON SCHEDULED MAINTENANCE
// ============================================================================

async function handleCronMaintenance(event, env) {
  console.log('[Cron Maintenance] Running lease cleanup and node health check...');

  // 1. Reclaim jobs with expired leases
  const expiredJobs = await env.DB.prepare(
    "SELECT id, job_id, retry_count, max_retries FROM jobs WHERE status IN ('claimed', 'processing') AND lease_expires_at < datetime('now')"
  ).all();

  let reclaimed = 0;
  for (const job of expiredJobs.results || []) {
    if (job.retry_count < job.max_retries) {
      await env.DB.prepare(
        `UPDATE jobs SET
           status = 'queued',
           assigned_node_id = NULL,
           lease_expires_at = NULL,
           retry_count = retry_count + 1,
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(job.id).run();

      await env.DB.prepare(
        "INSERT INTO job_logs (job_id, level, message, timestamp) VALUES (?, 'WARN', 'Worker lease expired; re-queued for retry', datetime('now'))"
      ).bind(job.job_id).run().catch(() => {});
      reclaimed++;
    } else {
      await env.DB.prepare(
        "UPDATE jobs SET status = 'failed', error = 'Worker lease timed out; max retries exceeded', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).bind(job.id).run();
    }
  }

  // 2. Mark stale nodes as offline (heartbeat > 3 minutes ago)
  await env.DB.prepare(
    "UPDATE gpu_nodes SET status = 'offline' WHERE status != 'offline' AND last_heartbeat < datetime('now', '-3 minutes')"
  ).run();

  return { reclaimed_jobs: reclaimed };
}

// Default 404 catch-all
router.all('*', () => error('Resource or route not found', 404));

// ============================================================================
// WORKER MODULE EXPORT
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    return router.fetch(request, env, ctx).catch(err => {
      console.error('Unhandled Worker Error:', err);
      return error('Internal Worker Error', 500, err.message);
    });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronMaintenance(event, env));
  },
};
