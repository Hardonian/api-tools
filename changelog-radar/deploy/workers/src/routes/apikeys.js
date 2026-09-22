/**
 * API Keys routes — generate, list, revoke.
 */
import { requireAuth } from '../middleware/auth.js';
import { generateApiKey, hashApiKey } from '../utils/crypto.js';
import { parseBody, validateString } from '../utils/validate.js';
import { CONFIG } from '../config.js';

/**
 * POST /api/v1/api-keys — generate new API key.
 */
export async function createApiKey(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  // Check plan allows API access
  const plan = CONFIG.plans[ctx.user.plan_key] || CONFIG.plans.free;
  if (!plan.features.apiAccess) {
    return ctx.json({ error: 'API key access requires Starter plan or higher' }, 403);
  }

  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const name = body.value.name
    ? validateString(body.value.name, 'Name', { max: 100 })
    : { valid: true, value: 'Default' };
  if (!name.valid) return ctx.json({ error: name.error }, 400);

  const scopes = body.value.scopes || 'read';
  const allowedScopes = ['read', 'write', 'admin'];
  const scopeList = scopes.split(',').map(s => s.trim());
  if (!scopeList.every(s => allowedScopes.includes(s))) {
    return ctx.json({ error: `Invalid scopes. Allowed: ${allowedScopes.join(', ')}` }, 400);
  }

  const { key, prefix } = generateApiKey();
  const keyHash = await hashApiKey(key);

  await env.DB.prepare(
    'INSERT INTO api_keys (user_id, key_hash, prefix, name, scopes) VALUES (?, ?, ?, ?, ?)'
  ).bind(ctx.user.id, keyHash, prefix, name.value, scopes).run();

  await ctx.audit(env, ctx.user.id, 'api_key.create', 'api_key', null);

  // Return the full key ONCE — it can never be retrieved again
  return ctx.json({
    key,
    prefix,
    name: name.value,
    scopes,
    warning: 'Save this key now. It cannot be retrieved again.',
  }, 201);
}

/**
 * GET /api/v1/api-keys — list user's keys (prefix only).
 */
export async function listApiKeys(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const keys = await env.DB.prepare(
    `SELECT id, prefix, name, scopes, last_used_at, revoked_at, created_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(ctx.user.id).all();

  return ctx.json({ api_keys: keys.results });
}

/**
 * DELETE /api/v1/api-keys/:id — revoke key.
 */
export async function revokeApiKey(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const key = await env.DB.prepare(
    'SELECT id FROM api_keys WHERE id = ? AND user_id = ?'
  ).bind(ctx.params.id, ctx.user.id).first();
  if (!key) return ctx.json({ error: 'API key not found' }, 404);

  await env.DB.prepare(
    'UPDATE api_keys SET revoked_at = datetime(\'now\') WHERE id = ?'
  ).bind(key.id).run();

  await ctx.audit(env, ctx.user.id, 'api_key.revoke', 'api_key', key.id);

  return ctx.json({ revoked: true });
}
