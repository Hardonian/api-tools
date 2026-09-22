/**
 * API Changelog Radar — Cloudflare Worker Entry Point
 *
 * Wires together: router, middleware, cron handlers, and error boundary.
 */
import { Router } from './router.js';
import { authMiddleware, requireAuth } from './middleware/auth.js';
import { handlePreflight, corsHeaders } from './middleware/cors.js';
import { checkRateLimit, getRateLimit } from './middleware/rate-limit.js';
import { securityHeaders, wrapResponse } from './middleware/security.js';
import { generateRequestId } from './utils/crypto.js';
import { CONFIG } from './config.js';

// Route handlers
import { register, login, refresh, me } from './routes/auth.js';
import { createSource, listSources, getSource, updateSource, deleteSource, triggerPoll } from './routes/sources.js';
import { listSourceDiffs, getDiff, recentDiffs } from './routes/diffs.js';
import { createAlert, listAlerts, updateAlert, deleteAlert, testAlert, alertLog } from './routes/alerts.js';
import { listPlans, getPlan } from './routes/plans.js';
import { captureLead } from './routes/leads.js';
import { createApiKey, listApiKeys, revokeApiKey } from './routes/apikeys.js';

// Engines
import { runPoller } from './engines/poller.js';
import { runNotifier } from './engines/notifier.js';

// ── Build Router ───────────────────────────────────────────────────────

const router = new Router();

// Health (public)
router.get('/health', async (req, env, ctx) => {
  return ctx.json({
    status: 'ok',
    app: env.APP_NAME || CONFIG.app.name,
    version: CONFIG.app.version,
    timestamp: new Date().toISOString(),
  });
});

// Auth (public)
router.post('/api/v1/auth/register', register);
router.post('/api/v1/auth/login', login);
router.post('/api/v1/auth/refresh', refresh);
router.get('/api/v1/auth/me', me);

// Sources (authenticated)
router.post('/api/v1/sources', createSource);
router.get('/api/v1/sources', listSources);
router.get('/api/v1/sources/:id', getSource);
router.put('/api/v1/sources/:id', updateSource);
router.delete('/api/v1/sources/:id', deleteSource);
router.post('/api/v1/sources/:id/poll', triggerPoll);

// Diffs (authenticated)
router.get('/api/v1/sources/:id/diffs', listSourceDiffs);
router.get('/api/v1/diffs/recent', recentDiffs);
router.get('/api/v1/diffs/:id', getDiff);

// Alerts (authenticated)
router.post('/api/v1/alerts', createAlert);
router.get('/api/v1/alerts', listAlerts);
router.put('/api/v1/alerts/:id', updateAlert);
router.delete('/api/v1/alerts/:id', deleteAlert);
router.post('/api/v1/alerts/:id/test', testAlert);
router.get('/api/v1/alerts/:id/log', alertLog);

// Plans (public)
router.get('/api/v1/plans', listPlans);
router.get('/api/v1/plans/:key', getPlan);

// Leads (public, rate-limited)
router.post('/api/v1/leads', captureLead);

// API Keys (authenticated)
router.post('/api/v1/api-keys', createApiKey);
router.get('/api/v1/api-keys', listApiKeys);
router.delete('/api/v1/api-keys/:id', revokeApiKey);

// ── Audit Logger ───────────────────────────────────────────────────────

async function audit(env, userId, action, resourceType, resourceId, ctx) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, action, resourceType, resourceId, ctx?.ip || null, ctx?.userAgent || null).run();
  } catch {
    // Audit logging should never break the request
  }
}

// ── Worker Export ───────────────────────────────────────────────────────

export default {
  /**
   * HTTP request handler.
   */
  async fetch(request, env, _execCtx) {
    const requestId = generateRequestId();
    const url = new URL(request.url);

    // CORS preflight
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    // Build context object passed to all handlers
    const ctx = {
      params: {},
      user: null,
      authMethod: null,
      ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown',
      userAgent: request.headers.get('user-agent') || '',
      requestId,
      json: (body, status = 200) => {
        return new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
            ...securityHeaders(),
            ...corsHeaders(request, env),
          },
        });
      },
      audit: (env, userId, action, resourceType, resourceId) => {
        return audit(env, userId, action, resourceType, resourceId, ctx);
      },
    };

    try {
      // Run auth middleware (non-blocking — sets ctx.user if valid)
      await authMiddleware(request, env, ctx);

      // Rate limiting
      const { identifier, max } = getRateLimit(ctx);
      const rateLimited = await checkRateLimit(identifier, max, env);
      if (rateLimited) {
        // Add CORS + security headers to rate limit response
        const headers = { ...securityHeaders(), ...corsHeaders(request, env) };
        for (const [k, v] of Object.entries(headers)) {
          rateLimited.headers.set(k, v);
        }
        return rateLimited;
      }

      // Route matching
      const match = router.match(request.method, url.pathname);
      if (!match) {
        return ctx.json({ error: 'Not found', path: url.pathname }, 404);
      }

      ctx.params = match.params;
      return await match.handler(request, env, ctx);

    } catch (err) {
      console.error(`Unhandled error [${requestId}]:`, err.message, err.stack);
      return ctx.json({
        error: 'Internal server error',
        request_id: requestId,
      }, 500);
    }
  },

  /**
   * Cron trigger handler.
   */
  async scheduled(event, env, _execCtx) {
    const cron = event.cron;
    console.log(`Cron triggered: ${cron}`);

    try {
      if (cron === '*/5 * * * *') {
        // Every 5 minutes: poll sources
        await runPoller(env);
      }

      if (cron === '* * * * *') {
        // Every minute: send notifications
        await runNotifier(env);
      }
    } catch (err) {
      console.error(`Cron error [${cron}]:`, err.message, err.stack);
    }
  },
};
