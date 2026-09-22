/**
 * CORS middleware — configurable allowed origins with preflight caching.
 */
import { CONFIG } from '../config.js';

export function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map(s => s.trim())
    : CONFIG.cors.allowedOrigins;

  const isAllowed = allowed.includes(origin) || allowed.includes('*');

  return {
    'access-control-allow-origin': isAllowed ? origin : allowed[0],
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-api-key, x-request-id',
    'access-control-max-age': String(CONFIG.cors.maxAge),
    'access-control-allow-credentials': 'true',
    'vary': 'Origin',
  };
}

export function handlePreflight(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }
  return null;
}
