/**
 * Diffs routes — list and detail.
 */
import { requireAuth } from '../middleware/auth.js';
import { CONFIG } from '../config.js';

/**
 * GET /api/v1/sources/:id/diffs — list diffs for a source.
 */
export async function listSourceDiffs(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  // Verify ownership
  const source = await env.DB.prepare(
    'SELECT id FROM sources WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!source) return ctx.json({ error: 'Source not found' }, 404);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), CONFIG.pagination.maxLimit);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const diffs = await env.DB.prepare(
    `SELECT id, source_id, old_snapshot_id, new_snapshot_id, added_lines, removed_lines,
            changed_sections, summary_text, severity, detected_at
     FROM diffs WHERE source_id = ?
     ORDER BY detected_at DESC LIMIT ? OFFSET ?`
  ).bind(ctx.params.id, limit, offset).all();

  const total = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM diffs WHERE source_id = ?'
  ).bind(ctx.params.id).first();

  return ctx.json({
    diffs: diffs.results,
    pagination: { total: total?.count || 0, limit, offset },
  });
}

/**
 * GET /api/v1/diffs/:id — get diff detail with patch.
 */
export async function getDiff(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const diff = await env.DB.prepare(
    `SELECT d.* FROM diffs d
     JOIN sources s ON s.id = d.source_id
     WHERE d.id = ? AND s.user_id = ?`
  ).bind(ctx.params.id, ctx.user.id).first();

  if (!diff) return ctx.json({ error: 'Diff not found' }, 404);

  // Get source name for context
  const source = await env.DB.prepare('SELECT name, url, kind FROM sources WHERE id = ?')
    .bind(diff.source_id).first();

  return ctx.json({ diff, source });
}

/**
 * GET /api/v1/diffs/recent — recent diffs across all user sources (dashboard feed).
 */
export async function recentDiffs(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), CONFIG.pagination.maxLimit);

  const diffs = await env.DB.prepare(
    `SELECT d.id, d.source_id, d.added_lines, d.removed_lines, d.summary_text,
            d.severity, d.detected_at, s.name as source_name, s.url as source_url
     FROM diffs d
     JOIN sources s ON s.id = d.source_id
     WHERE s.user_id = ?
     ORDER BY d.detected_at DESC LIMIT ?`
  ).bind(ctx.user.id, limit).all();

  return ctx.json({ diffs: diffs.results });
}
