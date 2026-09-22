import { Router } from 'itty-router';

const router = Router();

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

const PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    price_monthly: 29,
    inboxes: 1,
    events_per_month: 500,
    support: 'Email support',
    billing_state: 'manual-checkout-shell',
  },
  {
    key: 'team',
    name: 'Team',
    price_monthly: 99,
    inboxes: 5,
    events_per_month: 10000,
    support: 'Slack alerts + faster support',
    billing_state: 'manual-checkout-shell',
  },
  {
    key: 'agency',
    name: 'Agency',
    price_monthly: 299,
    inboxes: 25,
    events_per_month: 100000,
    support: 'Client workspaces + priority help',
    billing_state: 'manual-checkout-shell',
  },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function toPreview(text, max = 220) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readBodyText(request) {
  try {
    return await request.text();
  } catch {
    return '';
  }
}

function serializeHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

function serializeQuery(url) {
  const out = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

function makeToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getProvidedToken(request, url) {
  return url.searchParams.get('token') || request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
}

async function getWorkspaceBySlug(env, slug) {
  return env.DB.prepare(
    `SELECT id, name, slug, owner_email, company, plan, access_token, created_at, last_seen_at
     FROM workspaces WHERE slug = ?`
  ).bind(slug).first();
}

async function requireWorkspaceAccess(request, env, slug) {
  const url = new URL(request.url);
  const workspace = await getWorkspaceBySlug(env, slug);
  if (!workspace) {
    return { error: json({ error: 'Workspace not found' }, 404) };
  }
  const providedToken = getProvidedToken(request, url);
  if (!providedToken || providedToken !== workspace.access_token) {
    return { error: json({ error: 'Unauthorized workspace token' }, 401) };
  }
  await env.DB.prepare(`UPDATE workspaces SET last_seen_at = datetime('now') WHERE id = ?`).bind(workspace.id).run();
  return { workspace };
}

async function ensureWorkspaceForLegacyDemo(env) {
  const slug = 'demo-workspace';
  let workspace = await getWorkspaceBySlug(env, slug);
  if (!workspace) {
    await env.DB.prepare(
      `INSERT INTO workspaces (name, slug, owner_email, company, plan, access_token, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind('Demo Workspace', slug, 'demo@webhookwitness.dev', 'Webhook Witness', 'starter', 'demo-workspace-token').run();
    workspace = await getWorkspaceBySlug(env, slug);
  }
  return workspace;
}

async function insertEvent(env, workspaceId, source, method, contentType, ip, headersJson, queryJson, bodyText, bodyPreview) {
  return env.DB.prepare(
    `INSERT INTO events (workspace_id, source, method, content_type, ip, headers_json, query_json, body_text, body_preview, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(workspaceId, source, method, contentType, ip, headersJson, queryJson, bodyText, bodyPreview).run();
}

router.options('*', () => new Response(null, { status: 204, headers: CORS_HEADERS }));

router.get('/health', (_request, env) => json({ status: 'ok', app: env.APP_NAME || 'webhook-witness', phase: 'phase-2' }));

router.get('/api/v1/plans', () => json({ plans: PLANS }));

router.post('/api/v1/leads', async (request, env) => {
  const payload = await readJson(request);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const company = String(payload.company || '').trim();
  const plan = String(payload.plan || 'starter').trim().toLowerCase();
  const useCase = String(payload.use_case || payload.useCase || '').trim();
  const source = String(payload.source || 'landing-page').trim();

  if (!name || !email) {
    return json({ error: 'name and email are required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO leads (name, email, company, use_case, plan, status, source, notes_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?, datetime('now'))`
  ).bind(name, email, company, useCase, plan, source, JSON.stringify({ origin: 'phase-2', billing_state: 'manual-checkout-shell' })).run();

  return json({ ok: true, message: 'Lead captured', next_step: 'Manual follow-up or Stripe checkout wiring' }, 201);
});

router.post('/api/v1/workspaces/bootstrap', async (request, env) => {
  const payload = await readJson(request);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const company = String(payload.company || '').trim();
  const requestedPlan = String(payload.plan || 'starter').trim().toLowerCase();
  const useCase = String(payload.use_case || payload.useCase || '').trim();

  if (!name || !email) {
    return json({ error: 'name and email are required' }, 400);
  }

  let slug = slugify(company || name);
  const existing = await getWorkspaceBySlug(env, slug);
  if (existing) slug = `${slug}-${Math.floor(Date.now() / 1000).toString(36)}`;
  const accessToken = makeToken();

  await env.DB.prepare(
    `INSERT INTO workspaces (name, slug, owner_email, company, plan, access_token, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(name, slug, email, company, requestedPlan, accessToken).run();

  await env.DB.prepare(
    `INSERT INTO leads (name, email, company, use_case, plan, status, source, notes_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'workspace-created', 'workspace-bootstrap', ?, datetime('now'))`
  ).bind(name, email, company, useCase, requestedPlan, JSON.stringify({ workspace_slug: slug, billing_state: 'manual-checkout-shell' })).run();

  const workspace = await getWorkspaceBySlug(env, slug);
  return json({
    ok: true,
    workspace: {
      name: workspace.name,
      slug: workspace.slug,
      owner_email: workspace.owner_email,
      company: workspace.company,
      plan: workspace.plan,
      access_token: workspace.access_token,
      capture_url: `https://webhook-witness.scottrmhardie.workers.dev/api/v1/capture/${workspace.slug}/stripe?token=${workspace.access_token}`,
      dashboard_url: `https://webhook-witness-frontend.pages.dev/?workspace=${workspace.slug}&token=${workspace.access_token}`,
      billing_state: 'manual-checkout-shell',
    }
  }, 201);
});

router.post('/api/v1/auth/workspace', async (request, env) => {
  const payload = await readJson(request);
  const slug = String(payload.slug || '').trim();
  const token = String(payload.token || '').trim();
  const workspace = await getWorkspaceBySlug(env, slug);
  if (!workspace || token !== workspace.access_token) {
    return json({ error: 'Invalid workspace credentials' }, 401);
  }
  return json({
    ok: true,
    workspace: {
      name: workspace.name,
      slug: workspace.slug,
      owner_email: workspace.owner_email,
      company: workspace.company,
      plan: workspace.plan,
      access_token: workspace.access_token,
      capture_url: `https://webhook-witness.scottrmhardie.workers.dev/api/v1/capture/${workspace.slug}/stripe?token=${workspace.access_token}`,
      billing_state: 'manual-checkout-shell',
    }
  });
});

router.post('/api/v1/capture/:workspaceSlug/:source', async (request, env) => {
  const workspaceSlug = request.params.workspaceSlug || '';
  const access = await requireWorkspaceAccess(request, env, workspaceSlug);
  if (access.error) return access.error;

  const workspace = access.workspace;
  const url = new URL(request.url);
  const bodyText = await readBodyText(request.clone());
  const source = request.params.source || 'unknown';
  const headersJson = JSON.stringify(serializeHeaders(request.headers));
  const queryJson = JSON.stringify(serializeQuery(url));
  const bodyPreview = toPreview(bodyText);
  const contentType = request.headers.get('content-type') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';

  const result = await insertEvent(env, workspace.id, source, request.method, contentType, ip, headersJson, queryJson, bodyText, bodyPreview);
  return json({ ok: true, event_id: result.meta.last_row_id, workspace: workspace.slug, source, received_at: new Date().toISOString() }, 201);
});

router.post('/api/v1/demo-seed', async (_request, env) => {
  const workspace = await ensureWorkspaceForLegacyDemo(env);
  const sample = {
    provider: 'stripe',
    type: 'invoice.payment_succeeded',
    customer_email: 'buyer@example.com',
    amount: 9900,
    currency: 'usd'
  };
  const bodyText = JSON.stringify(sample, null, 2);
  const result = await insertEvent(env, workspace.id, 'stripe-demo', 'POST', 'application/json', '', JSON.stringify({ 'x-demo-seed': 'true' }), JSON.stringify({}), bodyText, toPreview(bodyText));
  return json({ ok: true, event_id: result.meta.last_row_id, workspace: workspace.slug, message: 'Demo event captured' }, 201);
});

router.post('/api/v1/workspaces/:slug/demo-seed', async (request, env) => {
  const access = await requireWorkspaceAccess(request, env, request.params.slug || '');
  if (access.error) return access.error;
  const workspace = access.workspace;
  const sample = {
    provider: 'stripe',
    type: 'invoice.payment_succeeded',
    customer_email: workspace.owner_email,
    amount: workspace.plan === 'agency' ? 29900 : workspace.plan === 'team' ? 9900 : 2900,
    currency: 'usd',
    workspace: workspace.slug,
  };
  const bodyText = JSON.stringify(sample, null, 2);
  const result = await insertEvent(env, workspace.id, 'stripe-demo', 'POST', 'application/json', '', JSON.stringify({ 'x-demo-seed': 'true' }), JSON.stringify({}), bodyText, toPreview(bodyText));
  return json({ ok: true, event_id: result.meta.last_row_id, workspace: workspace.slug, message: 'Workspace demo event captured' }, 201);
});

router.get('/api/v1/workspaces/:slug/summary', async (request, env) => {
  const access = await requireWorkspaceAccess(request, env, request.params.slug || '');
  if (access.error) return access.error;
  const workspace = access.workspace;
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?').bind(workspace.id).first();
  const sourceCount = await env.DB.prepare('SELECT COUNT(DISTINCT source) AS count FROM events WHERE workspace_id = ?').bind(workspace.id).first();
  const latest = await env.DB.prepare('SELECT source, received_at FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1').bind(workspace.id).first();
  return json({
    workspace: {
      name: workspace.name,
      slug: workspace.slug,
      owner_email: workspace.owner_email,
      company: workspace.company,
      plan: workspace.plan,
      capture_url: `https://webhook-witness.scottrmhardie.workers.dev/api/v1/capture/${workspace.slug}/stripe?token=${workspace.access_token}`,
      billing_state: 'manual-checkout-shell',
    },
    total_events: total?.count || 0,
    total_sources: sourceCount?.count || 0,
    latest_source: latest?.source || null,
    latest_received_at: latest?.received_at || null,
  });
});

router.get('/api/v1/workspaces/:slug/events', async (request, env) => {
  const access = await requireWorkspaceAccess(request, env, request.params.slug || '');
  if (access.error) return access.error;
  const workspace = access.workspace;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
  const rows = await env.DB.prepare(
    `SELECT id, workspace_id, source, method, content_type, ip, body_preview, received_at
     FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`
  ).bind(workspace.id, limit).all();
  return json({ workspace: workspace.slug, events: rows.results || [] });
});

router.get('/api/v1/workspaces/:slug/events/:id', async (request, env) => {
  const access = await requireWorkspaceAccess(request, env, request.params.slug || '');
  if (access.error) return access.error;
  const workspace = access.workspace;
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, source, method, content_type, ip, headers_json, query_json, body_text, body_preview, received_at
     FROM events WHERE id = ? AND workspace_id = ?`
  ).bind(request.params.id, workspace.id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json({
    ...row,
    headers: JSON.parse(row.headers_json || '{}'),
    query: JSON.parse(row.query_json || '{}'),
  });
});

router.get('/api/v1/workspaces/:slug/replay-plan/:id', async (request, env) => {
  const access = await requireWorkspaceAccess(request, env, request.params.slug || '');
  if (access.error) return access.error;
  const workspace = access.workspace;
  const row = await env.DB.prepare(
    `SELECT source, method, content_type, body_text FROM events WHERE id = ? AND workspace_id = ?`
  ).bind(request.params.id, workspace.id).first();
  if (!row) return json({ error: 'Not found' }, 404);

  const contentTypeHeader = row.content_type ? `-H ${JSON.stringify(`content-type: ${row.content_type}`)}` : '';
  const dataFlag = row.body_text ? `--data-binary ${JSON.stringify(row.body_text)}` : '';
  const curl = `curl -X ${row.method} ${contentTypeHeader} ${dataFlag} https://your-app.example.com/webhooks/${row.source}`.replace(/\s+/g, ' ').trim();
  return json({
    source: row.source,
    workspace: workspace.slug,
    replay_target_hint: `https://your-app.example.com/webhooks/${row.source}`,
    curl_command: curl,
  });
});

router.get('/api/v1/stats', async (_request, env) => {
  const workspace = await ensureWorkspaceForLegacyDemo(env);
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?').bind(workspace.id).first();
  const sourceCount = await env.DB.prepare('SELECT COUNT(DISTINCT source) AS count FROM events WHERE workspace_id = ?').bind(workspace.id).first();
  const latest = await env.DB.prepare('SELECT source, received_at FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1').bind(workspace.id).first();
  return json({
    workspace: workspace.slug,
    total_events: total?.count || 0,
    total_sources: sourceCount?.count || 0,
    latest_source: latest?.source || null,
    latest_received_at: latest?.received_at || null,
  });
});

router.get('/api/v1/events', async (_request, env) => {
  const workspace = await ensureWorkspaceForLegacyDemo(env);
  const rows = await env.DB.prepare(
    `SELECT id, workspace_id, source, method, content_type, ip, body_preview, received_at
     FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 20`
  ).bind(workspace.id).all();
  return json({ workspace: workspace.slug, events: rows.results || [] });
});

router.get('/api/v1/events/:id', async (request, env) => {
  const workspace = await ensureWorkspaceForLegacyDemo(env);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, source, method, content_type, ip, headers_json, query_json, body_text, body_preview, received_at
     FROM events WHERE id = ? AND workspace_id = ?`
  ).bind(request.params.id, workspace.id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json({ ...row, headers: JSON.parse(row.headers_json || '{}'), query: JSON.parse(row.query_json || '{}') });
});

router.get('/api/v1/replay-plan/:id', async (request, env) => {
  const workspace = await ensureWorkspaceForLegacyDemo(env);
  const row = await env.DB.prepare(
    `SELECT source, method, content_type, body_text FROM events WHERE id = ? AND workspace_id = ?`
  ).bind(request.params.id, workspace.id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  const contentTypeHeader = row.content_type ? `-H ${JSON.stringify(`content-type: ${row.content_type}`)}` : '';
  const dataFlag = row.body_text ? `--data-binary ${JSON.stringify(row.body_text)}` : '';
  const curl = `curl -X ${row.method} ${contentTypeHeader} ${dataFlag} https://your-app.example.com/webhooks/${row.source}`.replace(/\s+/g, ' ').trim();
  return json({ source: row.source, workspace: workspace.slug, replay_target_hint: `https://your-app.example.com/webhooks/${row.source}`, curl_command: curl });
});

router.all('*', () => json({ error: 'Not found' }, 404));

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx),
};
