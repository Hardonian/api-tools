
/**
 * Cloudflare Workers API for ComfyUI-as-a-Service
 * Free tier: 100K req/day
 */

import { Router } from 'itty-router';

const router = Router();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

router.get('/health', () => json({
  status: 'ok', service: 'comfyui-api', version: '0.1.0',
  timestamp: new Date().toISOString(),
}));

router.post('/api/v1/jobs', async (request, env) => {
  const body = await request.json();
  const { workflow, priority, gpu_required } = body;
  if (!workflow) return error('workflow is required');

  const jobId = 'job_' + crypto.randomUUID().slice(0, 8);
  const result = await env.DB.prepare(
    `INSERT INTO jobs (job_id, workflow, status, priority, gpu_required)
     VALUES (?, ?, 'queued', ?, ?)`
  ).bind(jobId, workflow, priority || 5, gpu_required || 'any').run();

  return json({ job_id: jobId, status: 'queued', position: result.meta.last_row_id });
});

router.get('/api/v1/jobs', async (request, env) => {
  const result = await env.DB.prepare(
    'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50'
  ).all();
  return json({ jobs: result.results });
});

router.get('/api/v1/jobs/:id', async (request, env) => {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?')
    .bind(request.params.id).first();
  if (!job) return error('Job not found', 404);
  return json(job);
});

router.post('/api/v1/workflows', async (request, env) => {
  const body = await request.json();
  const { name, description, workflow_json, category } = body;
  if (!name || !workflow_json) return error('name and workflow_json are required');

  const result = await env.DB.prepare(
    `INSERT INTO workflows (name, description, workflow_json, category) VALUES (?, ?, ?, ?)`
  ).bind(name, description || '', workflow_json, category || 'general').run();

  return json({ workflow_id: result.meta.last_row_id, name });
});

router.get('/api/v1/workflows', async (request, env) => {
  const result = await env.DB.prepare(
    'SELECT id, name, description, category, usage_count FROM workflows ORDER BY usage_count DESC LIMIT 50'
  ).all();
  return json({ workflows: result.results });
});

router.get('/api/v1/stats', async (request, env) => {
  const total = await env.DB.prepare('SELECT COUNT(*) as c FROM jobs').first();
  const queued = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'queued'").first();
  const processing = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'processing'").first();
  const completed = await env.DB.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'completed'").first();
  const workflows = await env.DB.prepare('SELECT COUNT(*) as c FROM workflows').first();

  return json({
    jobs: { total: total.count, queued: queued.count, processing: processing.count, completed: completed.count },
    workflows: workflows.count,
  });
});

router.post('/api/v1/webhook/github', async (request, env) => {
  const event = request.headers.get('x-github-event');
  const payload = await request.json();
  if (event === 'push') return json({ status: 'received', repo: payload.repository?.full_name });
  return json({ status: 'ignored', event });
});

async function handleCron(event, env) {
  const queued = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at LIMIT 5"
  ).all();

  for (const job of queued.results) {
    await env.DB.prepare("UPDATE jobs SET status = 'processing' WHERE id = ?").bind(job.id).run();
  }

  return json({ processed: queued.results.length });
}

router.all('*', () => error('Not found', 404));

export default {
  async fetch(request, env, ctx) { return router.fetch(request, env, ctx); },
  async scheduled(event, env, ctx) { ctx.waitUntil(handleCron(event, env)); },
};
