# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.x (current) | ✅ Active support |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report vulnerabilities privately using one of these methods:

1. **GitHub Security Advisories** (preferred): Navigate to the [Security tab](../../security/advisories) and click "Report a vulnerability"
2. **Email**: Contact the maintainer directly

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix + disclosure**: Coordinated with reporter

## Security Measures in Place

### Authentication & Authorization

- PBKDF2 password hashing (100,000 iterations, SHA-256, random 16-byte salt)
- JWT tokens (HMAC-SHA256) with configurable expiry
- API keys stored as SHA-256 hashes (never plaintext, shown once on creation)
- Scoped API keys (read, write, admin)
- Constant-time comparison for password and token verification

### Data Protection

- All database queries use parameterized statements (zero SQL injection surface)
- Input validation on all endpoints (email, URL, string length, enums)
- Request body size limits (1MB max)
- Content-Type enforcement (application/json required)

### Transport Security

- HSTS with 2-year max-age, includeSubDomains, preload
- CORS restricted to configured origins (not wildcard in production)
- All Cloudflare Workers traffic is HTTPS by default

### HTTP Security Headers

- `Strict-Transport-Security`: HSTS enforcement
- `X-Content-Type-Options: nosniff`: Prevent MIME sniffing
- `X-Frame-Options: DENY`: Prevent clickjacking
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: Restrict browser APIs
- `X-Request-Id`: Request tracing

### Rate Limiting

- Per-IP rate limiting for unauthenticated requests (20 req/min)
- Per-user rate limiting based on plan tier
- Stricter limits on lead capture (5 req/min) and auth endpoints
- `429 Too Many Requests` with `Retry-After` header

### Webhook Security

- Outbound webhook payloads signed with HMAC-SHA256
- Signature sent in `X-ACR-Signature` header
- Event type in `X-ACR-Event` header

### Audit & Monitoring

- All mutations logged in audit_log table
- IP address and user agent captured
- Alert delivery history tracked
- Failed login attempts tracked

### CI/CD Security

- Gitleaks secret scanning on every push and PR
- npm audit for dependency vulnerabilities
- CodeQL static analysis for JavaScript
- Dependabot auto-merge for patch/minor security updates
- Least-privilege GitHub Actions permissions

## Dependencies

The Worker backend has **zero runtime dependencies**. All cryptographic operations use the Web Crypto API built into Cloudflare Workers. Dev dependencies (wrangler, vitest, eslint) are build-time only.
