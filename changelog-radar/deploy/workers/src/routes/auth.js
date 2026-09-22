/**
 * Auth routes — register, login, refresh, me.
 */
import { hashPassword, verifyPassword, signJwt } from '../utils/crypto.js';
import { validateEmail, validatePassword, validateString, parseBody, validateAll } from '../utils/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { CONFIG } from '../config.js';

/**
 * POST /api/v1/auth/register
 */
export async function register(request, env, ctx) {
  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const v = validateAll([
    { field: 'email', result: validateEmail(body.value.email) },
    { field: 'password', result: validatePassword(body.value.password) },
  ]);
  if (!v.valid) return ctx.json({ error: v.error }, 400);

  // Check for existing user
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(v.values.email).first();
  if (existing) return ctx.json({ error: 'An account with this email already exists' }, 409);

  const passwordHash = await hashPassword(v.values.password);
  const displayName = body.value.name || body.value.display_name || v.values.email.split('@')[0];

  const result = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, display_name, plan_key)
     VALUES (?, ?, ?, 'free')`
  ).bind(v.values.email, passwordHash, displayName).run();

  const userId = result.meta.last_row_id;
  const jwtSecret = env.JWT_SECRET || 'dev-secret-change-me';
  const token = await signJwt({ sub: userId, email: v.values.email }, jwtSecret, CONFIG.auth.jwtExpirySeconds);

  await ctx.audit(env, userId, 'auth.register', 'user', userId);

  return ctx.json({
    user: { id: userId, email: v.values.email, display_name: displayName, plan_key: 'free' },
    token,
    expires_in: CONFIG.auth.jwtExpirySeconds,
  }, 201);
}

/**
 * POST /api/v1/auth/login
 */
export async function login(request, env, ctx) {
  const body = await parseBody(request);
  if (!body.valid) return ctx.json({ error: body.error }, 400);

  const v = validateAll([
    { field: 'email', result: validateEmail(body.value.email) },
    { field: 'password', result: validatePassword(body.value.password) },
  ]);
  if (!v.valid) return ctx.json({ error: 'Invalid email or password' }, 401);

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, display_name, plan_key FROM users WHERE email = ?'
  ).bind(v.values.email).first();

  if (!user || !(await verifyPassword(v.values.password, user.password_hash))) {
    return ctx.json({ error: 'Invalid email or password' }, 401);
  }

  const jwtSecret = env.JWT_SECRET || 'dev-secret-change-me';
  const token = await signJwt({ sub: user.id, email: user.email }, jwtSecret, CONFIG.auth.jwtExpirySeconds);

  await ctx.audit(env, user.id, 'auth.login', 'user', user.id);

  return ctx.json({
    user: { id: user.id, email: user.email, display_name: user.display_name, plan_key: user.plan_key },
    token,
    expires_in: CONFIG.auth.jwtExpirySeconds,
  });
}

/**
 * POST /api/v1/auth/refresh
 */
export async function refresh(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  const jwtSecret = env.JWT_SECRET || 'dev-secret-change-me';
  const token = await signJwt(
    { sub: ctx.user.id, email: ctx.user.email },
    jwtSecret,
    CONFIG.auth.jwtExpirySeconds
  );

  return ctx.json({ token, expires_in: CONFIG.auth.jwtExpirySeconds });
}

/**
 * GET /api/v1/auth/me
 */
export async function me(request, env, ctx) {
  const authResp = requireAuth(ctx);
  if (authResp) return authResp;

  // Get source count and team info
  const sourceCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM sources WHERE user_id = ? AND status != \'paused\''
  ).bind(ctx.user.id).first();

  const plan = await env.DB.prepare('SELECT * FROM plans WHERE key = ?')
    .bind(ctx.user.plan_key).first();

  return ctx.json({
    user: ctx.user,
    usage: {
      sources: sourceCount?.count || 0,
      max_sources: plan?.max_sources || 2,
    },
    plan,
  });
}
