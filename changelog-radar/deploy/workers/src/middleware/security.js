/**
 * Security headers middleware.
 */

export function securityHeaders() {
  return {
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'x-xss-protection': '0', // Disabled in favor of CSP
  };
}

/**
 * Inject security headers + request ID + CORS into response.
 */
export function wrapResponse(body, status, extraHeaders, requestId) {
  const headers = {
    'content-type': 'application/json',
    'x-request-id': requestId || '',
    ...securityHeaders(),
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}
