/**
 * Leads routes — landing page lead capture.
 */
import { parseBody, validateAll, validateEmail, validateUrl, validateString } from '../utils/validate.js';
import { checkRateLimit } from '../middleware/rate-limit.js';
import { CONFIG } from '../config.js';

/**
 * POST /api/v1/leads — capture lead (no auth required).
 */
export async function captureLead(request, env, ctx) {
  // Strict rate limit on lead capture to prevent spam
  const ip = ctx.ip || 'unknown';
  const limited = await checkRateLimit(`lead:${ip}`, CONFIG.rateLimiting.leadCaptureRpm, env);
  if (limited) return limited;

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const v = validateAll([
    { field: 'email', result: validateEmail(body.value.email) },
  ]);
  if (!v.valid) return ctx.json({ error: v.error }, 400);

  const name = body.value.name ? body.value.name.trim().slice(0, 200) : null;
  const sourceUrl = body.value.source_url || null;

  if (sourceUrl) {
    const urlCheck = validateUrl(sourceUrl);
    if (!urlCheck.valid) return ctx.json({ error: urlCheck.error }, 400);
  }

  // Upsert — don't error on duplicate email
  const existing = await env.DB.prepare('SELECT id FROM leads WHERE email = ?')
    .bind(v.values.email).first();

  if (existing) {
    // Update existing lead with new info
    await env.DB.prepare(
      'UPDATE leads SET name = COALESCE(?, name), source_url = COALESCE(?, source_url) WHERE id = ?'
    ).bind(name, sourceUrl, existing.id).run();
    return ctx.json({ message: 'Thanks! We\'ll be in touch.', id: existing.id }, 200);
  }

  const result = await env.DB.prepare(
    'INSERT INTO leads (name, email, source_url) VALUES (?, ?, ?)'
  ).bind(name, v.values.email, sourceUrl).run();

  return ctx.json({ message: 'Thanks! We\'ll be in touch.', id: result.meta.last_row_id }, 201);
}
