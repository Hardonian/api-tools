/**
 * Authentication middleware — JWT sessions + API key auth.
 */
import { verifyJwt, hashApiKey } from '../utils/crypto.js';

/**
 * Authenticate the request. Sets ctx.user if valid credentials found.
 * Does NOT reject — use requireAuth() for protected routes.
 */
export async function authMiddleware(request, env, ctx) {
  const authorization = request.headers.get('authorization') || '';
  const apiKey = request.headers.get('x-api-key') || '';

  // Try Bearer token (JWT)
  if (authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    const jwtSecret = env.JWT_SECRET || 'dev-secret-change-me';
    const payload = await verifyJwt(token, jwtSecret);
    if (payload && payload.sub) {
      const user = await env.DB.prepare('SELECT id, email, display_name, plan_key FROM users WHERE id = ?')
        .bind(payload.sub).first();
      if (user) {
        ctx.user = user;
        ctx.authMethod = 'jwt';
        return;
      }
    }
  }

  // Try API key
  if (apiKey) {
    const keyHash = await hashApiKey(apiKey);
    const row = await env.DB.prepare(
      `SELECT ak.id AS key_id, ak.user_id, ak.scopes, u.email, u.display_name, u.plan_key
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = ? AND ak.revoked_at IS NULL`
    ).bind(keyHash).first();
    if (row) {
      ctx.user = { id: row.user_id, email: row.email, display_name: row.display_name, plan_key: row.plan_key };
      ctx.authMethod = 'api_key';
      ctx.apiKeyId = row.key_id;
      ctx.scopes = row.scopes.split(',');
      // Update last_used_at (fire and forget)
      env.DB.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?')
        .bind(row.key_id).run();
      return;
    }
  }
}

/**
 * Require authentication — returns 401 if not authenticated.
 */
export function requireAuth(ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

/**
 * Require specific API key scope.
 */
export function requireScope(ctx, scope) {
  if (ctx.authMethod === 'api_key' && !ctx.scopes.includes(scope) && !ctx.scopes.includes('admin')) {
    return new Response(JSON.stringify({ error: `Insufficient scope. Required: ${scope}` }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}
