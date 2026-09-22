/**
 * Alerts routes — CRUD + test + delivery log.
 */
import { requireAuth } from '../middleware/auth.js';
import { parseBody, validateAll, validateEnum, validateUrl, validateString } from '../utils/validate.js';
import { CONFIG } from '../config.js';

const ALERT_CHANNELS = ['email', 'slack', 'webhook', 'in_app'];

/**
 * POST /api/v1/alerts — create alert config.
 */
export async function createAlert(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const v = validateAll([
    { field: 'channel', result: validateEnum(body.value.channel, 'Channel', ALERT_CHANNELS) },
    { field: 'target', result: validateString(body.value.target, 'Target', { max: 500 }) },
  ]);
  if (!v.valid) return ctx.json({ error: v.error }, 400);

  // Validate target based on channel
  if (v.values.channel === 'webhook' || v.values.channel === 'slack') {
    const urlCheck = validateUrl(v.values.target);
    if (!urlCheck.valid) return ctx.json({ error: `Target must be a valid URL for ${v.values.channel} channel` }, 400);
  }

  // Check plan feature access
  const plan = CONFIG.plans[ctx.user.plan_key] || CONFIG.plans.free;
  if (v.values.channel === 'webhook' && !plan.features.webhookAlerts) {
    return ctx.json({ error: 'Webhook alerts require Starter plan or higher' }, 403);
  }
  if (v.values.channel === 'slack' && !plan.features.slackAlerts) {
    return ctx.json({ error: 'Slack alerts require Growth plan or higher' }, 403);
  }

  const sourceId = body.value.source_id || null;
  if (sourceId) {
    const source = await env.DB.prepare(
      'SELECT id FROM sources WHERE id = ? AND user_id = ?'
    ).bind(sourceId, ctx.user.id).first();
    if (!source) return ctx.json({ error: 'Source not found' }, 404);
  }

  const configJson = JSON.stringify(body.value.config || {});

  const result = await env.DB.prepare(
    `INSERT INTO alerts (user_id, source_id, channel, target, config_json)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(ctx.user.id, sourceId, v.values.channel, v.values.target, configJson).run();

  const alert = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?')
    .bind(result.meta.last_row_id).first();

  await ctx.audit(env, ctx.user.id, 'alert.create', 'alert', alert.id);

  return ctx.json({ alert }, 201);
}

/**
 * GET /api/v1/alerts — list user's alert configs.
 */
export async function listAlerts(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const alerts = await env.DB.prepare(
    `SELECT a.*, s.name as source_name FROM alerts a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC`
  ).bind(ctx.user.id).all();

  return ctx.json({ alerts: alerts.results });
}

/**
 * PUT /api/v1/alerts/:id — update alert.
 */
export async function updateAlert(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const alert = await env.DB.prepare(
    'SELECT * FROM alerts WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!alert) return ctx.json({ error: 'Alert not found' }, 404);

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const updates = {};
  if (body.value.target !== undefined) {
    const v = validateString(body.value.target, 'Target', { max: 500 });
    if (!v.valid) return ctx.json({ error: v.error }, 400);
    updates.target = v.value;
  }
  if (body.value.enabled !== undefined) {
    updates.enabled = body.value.enabled ? 1 : 0;
  }
  if (body.value.config !== undefined) {
    updates.config_json = JSON.stringify(body.value.config);
  }

  if (Object.keys(updates).length === 0) return ctx.json({ error: 'No fields to update' }, 400);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE alerts SET ${setClauses} WHERE id = ?`)
    .bind(...Object.values(updates), alert.id).run();

  const updated = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?')
    .bind(alert.id).first();

  await ctx.audit(env, ctx.user.id, 'alert.update', 'alert', alert.id);

  return ctx.json({ alert: updated });
}

/**
 * DELETE /api/v1/alerts/:id
 */
export async function deleteAlert(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const alert = await env.DB.prepare(
    'SELECT * FROM alerts WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!alert) return ctx.json({ error: 'Alert not found' }, 404);

  await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(alert.id).run();

  await ctx.audit(env, ctx.user.id, 'alert.delete', 'alert', alert.id);

  return ctx.json({ deleted: true });
}

/**
 * POST /api/v1/alerts/:id/test — send a test notification.
 */
export async function testAlert(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const alert = await env.DB.prepare(
    'SELECT * FROM alerts WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!alert) return ctx.json({ error: 'Alert not found' }, 404);

  const { sendNotification } = await import('../engines/notifier.js');
  const testDiff = {
    id: 0,
    source_id: alert.source_id || 0,
    added_lines: 3,
    removed_lines: 1,
    severity: 'info',
    summary_text: '🧪 Test notification from API Changelog Radar',
    detected_at: new Date().toISOString(),
  };

  const result = await sendNotification(alert, testDiff, 'Test Source', env);

  return ctx.json({ test_result: result });
}

/**
 * GET /api/v1/alerts/:id/log — delivery history.
 */
export async function alertLog(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const alert = await env.DB.prepare(
    'SELECT * FROM alerts WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!alert) return ctx.json({ error: 'Alert not found' }, 404);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);

  const logs = await env.DB.prepare(
    'SELECT * FROM alert_log WHERE alert_id = ? ORDER BY sent_at DESC LIMIT ?'
  ).bind(alert.id, limit).all();

  return ctx.json({ log: logs.results });
}
