/**
 * Rate limiting middleware — D1-backed, plan-aware.
 */
import { CONFIG } from '../config.js';

/**
 * Check rate limit. Returns 429 Response if exceeded, null if OK.
 * @param {string} identifier - 'ip:1.2.3.4' or 'user:42'
 * @param {number} maxRequests - max requests per window
 * @param {object} env - Worker env bindings
 */
export async function checkRateLimit(identifier, maxRequests, env) {
  const windowSeconds = CONFIG.rateLimiting.windowSeconds;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  try {
    const row = await env.DB.prepare(
      'SELECT count, window_start FROM rate_limits WHERE key = ?'
    ).bind(identifier).first();

    if (!row || row.window_start < windowStart) {
      // New window
      await env.DB.prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET count = 1, window_start = datetime('now')`
      ).bind(identifier).run();
      return null;
    }

    if (row.count >= maxRequests) {
      const retryAfter = Math.ceil(
        (new Date(row.window_start).getTime() + windowSeconds * 1000 - now.getTime()) / 1000
      );
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        retry_after: Math.max(retryAfter, 1),
      }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.max(retryAfter, 1)),
        },
      });
    }

    // Increment
    await env.DB.prepare(
      'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
    ).bind(identifier).run();
    return null;
  } catch {
    // If rate limiting fails, allow the request (fail open)
    return null;
  }
}

/**
 * Get the rate limit for a request based on auth state.
 */
export function getRateLimit(ctx) {
  if (ctx.user) {
    const planConfig = CONFIG.plans[ctx.user.plan_key];
    return {
      identifier: `user:${ctx.user.id}`,
      max: planConfig ? planConfig.rateRpm : CONFIG.rateLimiting.unauthenticatedRpm,
    };
  }
  return {
    identifier: `ip:${ctx.ip}`,
    max: CONFIG.rateLimiting.unauthenticatedRpm,
  };
}
