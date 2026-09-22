/**
 * Sources routes — full CRUD + manual poll trigger.
 */
import { requireAuth } from '../middleware/auth.js';
import { parseBody, validateAll, validateString, validateUrl, validateEnum, validateInt } from '../utils/validate.js';
import { CONFIG } from '../config.js';

const SOURCE_KINDS = ['changelog', 'spec', 'webhook', 'rss', 'custom'];

/**
 * POST /api/v1/sources — create a monitored source.
 */
export async function createSource(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const v = validateAll([
    { field: 'name', result: validateString(body.value.name, 'Name') },
    { field: 'url', result: validateUrl(body.value.url) },
    { field: 'kind', result: validateEnum(body.value.kind, 'Kind', SOURCE_KINDS) },
  ]);
  if (!v.valid) return ctx.json({ error: v.error }, 400);

  // Check plan limits
  const plan = CONFIG.plans[ctx.user.plan_key] || CONFIG.plans.free;
  const count = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM sources WHERE user_id = ?'
  ).bind(ctx.user.id).first();

  if ((count?.count || 0) >= plan.maxSources) {
    return ctx.json({
      error: `Source limit reached (${plan.maxSources} on ${ctx.user.plan_key} plan). Upgrade to add more.`,
    }, 403);
  }

  const selector = body.value.selector || null;
  const pollInterval = body.value.poll_interval_minutes
    ? Math.max(CONFIG.polling.minIntervalMinutes, Math.min(body.value.poll_interval_minutes, CONFIG.polling.maxIntervalMinutes))
    : CONFIG.polling.defaultIntervalMinutes;

  const result = await env.DB.prepare(
    `INSERT INTO sources (user_id, name, kind, url, selector, poll_interval_minutes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(ctx.user.id, v.values.name, v.values.kind, v.values.url, selector, pollInterval).run();

  const source = await env.DB.prepare('SELECT * FROM sources WHERE id = ?')
    .bind(result.meta.last_row_id).first();

  await ctx.audit(env, ctx.user.id, 'source.create', 'source', source.id);

  return ctx.json({ source }, 201);
}

/**
 * GET /api/v1/sources — list user's sources.
 */
export async function listSources(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), CONFIG.pagination.maxLimit);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const status = url.searchParams.get('status');

  let query = 'SELECT * FROM sources WHERE user_id = ?';
  const params = [ctx.user.id];

  if (status && ['active', 'paused', 'error'].includes(status)) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const sources = await env.DB.prepare(query).bind(...params).all();

  const total = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM sources WHERE user_id = ?'
  ).bind(ctx.user.id).first();

  return ctx.json({
    sources: sources.results,
    pagination: { total: total?.count || 0, limit, offset },
  });
}

/**
 * GET /api/v1/sources/:id — get source detail with latest snapshot info.
 */
export async function getSource(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const source = await env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();

  if (!source) return ctx.json({ error: 'Source not found' }, 404);

  const latestSnapshot = await env.DB.prepare(
    'SELECT id, content_hash, character_count, line_count, headline, http_status, fetch_duration_ms, fetched_at FROM snapshots WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1'
  ).bind(source.id).first();

  const diffCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM diffs WHERE source_id = ?'
  ).bind(source.id).first();

  return ctx.json({
    source,
    latest_snapshot: latestSnapshot || null,
    diff_count: diffCount?.count || 0,
  });
}

/**
 * PUT /api/v1/sources/:id — update source config.
 */
export async function updateSource(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const source = await env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();

  if (!source) return ctx.json({ error: 'Source not found' }, 404);

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const updates = {};
  if (body.value.name !== undefined) {
    const v = validateString(body.value.name, 'Name');
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.name = v.value;
  }
  if (body.value.url !== undefined) {
    const v = validateUrl(body.value.url);
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.url = v.value;
  }
  if (body.value.kind !== undefined) {
    const v = validateEnum(body.value.kind, 'Kind', SOURCE_KINDS);
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.kind = v.value;
  }
  if (body.value.status !== undefined) {
    const v = validateEnum(body.value.status, 'Status', ['active', 'paused']);
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.status = v.value;
  }
  if (body.value.selector !== undefined) updates.selector = body.value.selector;
  if (body.value.poll_interval_minutes !== undefined) {
    const v = validateInt(body.value.poll_interval_minutes, 'Poll interval', {
      min: CONFIG.polling.minIntervalMinutes, max: CONFIG.polling.maxIntervalMinutes,
    });
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.poll_interval_minutes = v.value;
  }

  if (Object.keys(updates).length === 0) {
    return ctx.json({ error: 'No fields to update' }, 400);
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  await env.DB.prepare(
    `UPDATE sources SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values, source.id).run();

  const updated = await env.DB.prepare('SELECT * FROM sources WHERE id = ?')
    .bind(source.id).first();

  await ctx.audit(env, ctx.user.id, 'source.update', 'source', source.id);

  return ctx.json({ source: updated });
}

/**
 * DELETE /api/v1/sources/:id — delete source.
 */
export async function deleteSource(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const source = await env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();

  if (!source) return ctx.json({ error: 'Source not found' }, 404);

  await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(source.id).run();

  await ctx.audit(env, ctx.user.id, 'source.delete', 'source', source.id);

  return ctx.json({ deleted: true });
}

/**
 * POST /api/v1/sources/:id/poll — trigger immediate poll.
 */
export async function triggerPoll(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const source = await env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();

  if (!source) return ctx.json({ error: 'Source not found' }, 404);

  // Import and run poller for this single source
  const { pollSingleSource } = await import('../engines/poller.js');
  const result = await pollSingleSource(source, env);

  await ctx.audit(env, ctx.user.id, 'source.poll', 'source', source.id);

  return ctx.json({ poll_result: result });
}
