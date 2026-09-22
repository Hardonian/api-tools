# API Changelog Radar — API Reference

Base URL: `https://api-changelog-radar.scottrmhardie.workers.dev`

## Authentication

### Bearer Token (JWT)

```http
Authorization: Bearer <token>
```

### API Key

```http
X-API-Key: acr_<key>
```

---

## Auth

### Register

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "min8chars",
  "name": "Optional Name"
}
```

**Response (201):**

```json
{
  "user": { "id": 1, "email": "user@example.com", "display_name": "user", "plan_key": "free" },
  "token": "eyJ...",
  "expires_in": 86400
}
```

### Login

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (200):** Same shape as register.

### Get Current User

```http
GET /api/v1/auth/me
Authorization: Bearer <token>
```

**Response (200):**

```json
{
  "user": { "id": 1, "email": "user@example.com", "display_name": "user", "plan_key": "free" },
  "usage": { "sources": 2, "max_sources": 5 },
  "plan": { "key": "free", "name": "Free", "max_sources": 2 }
}
```

### Refresh Token

```http
POST /api/v1/auth/refresh
Authorization: Bearer <token>
```

---

## Sources

### Create Source

```http
POST /api/v1/sources
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Stripe API Changelog",
  "kind": "changelog",
  "url": "https://stripe.com/docs/changelog",
  "selector": "#content",
  "poll_interval_minutes": 60
}
```

**Response (201):**

```json
{
  "source": {
    "id": 1,
    "name": "Stripe API Changelog",
    "kind": "changelog",
    "url": "https://stripe.com/docs/changelog",
    "status": "active"
  }
}
```

### List Sources

```http
GET /api/v1/sources?limit=20&offset=0&status=active
Authorization: Bearer <token>
```

### Get Source

```http
GET /api/v1/sources/:id
Authorization: Bearer <token>
```

### Update Source

```http
PUT /api/v1/sources/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Updated Name",
  "status": "paused"
}
```

### Delete Source

```http
DELETE /api/v1/sources/:id
Authorization: Bearer <token>
```

### Trigger Poll

```http
POST /api/v1/sources/:id/poll
Authorization: Bearer <token>
```

---

## Diffs

### List Diffs for Source

```http
GET /api/v1/sources/:id/diffs?limit=20&offset=0
Authorization: Bearer <token>
```

### Get Diff Detail

```http
GET /api/v1/diffs/:id
Authorization: Bearer <token>
```

**Response (200):**

```json
{
  "diff": {
    "id": 1,
    "source_id": 1,
    "added_lines": 5,
    "removed_lines": 2,
    "severity": "warning",
    "summary_text": "Notable change: +5 lines added, -2 lines removed",
    "diff_patch": "...",
    "detected_at": "2026-08-25T12:00:00Z"
  },
  "source": {
    "name": "Stripe API Changelog",
    "url": "https://stripe.com/docs/changelog"
  }
}
```

### Recent Diffs (Dashboard Feed)

```http
GET /api/v1/diffs/recent?limit=20
Authorization: Bearer <token>
```

---

## Alerts

### Create Alert

```http
POST /api/v1/alerts
Authorization: Bearer <token>
Content-Type: application/json

{
  "channel": "webhook",
  "target": "https://your-server.com/webhook",
  "source_id": 1,
  "config": {}
}
```

### List Alerts

```http
GET /api/v1/alerts
Authorization: Bearer <token>
```

### Update Alert

```http
PUT /api/v1/alerts/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "enabled": false
}
```

### Delete Alert

```http
DELETE /api/v1/alerts/:id
Authorization: Bearer <token>
```

### Test Alert

```http
POST /api/v1/alerts/:id/test
Authorization: Bearer <token>
```

### Alert Delivery Log

```http
GET /api/v1/alerts/:id/log?limit=20
Authorization: Bearer <token>
```

---

## Webhook Payload

When a change is detected, webhook alerts receive:

```json
{
  "event": "changelog.change_detected",
  "source": {
    "id": 1,
    "name": "Stripe API Changelog"
  },
  "diff": {
    "id": 42,
    "severity": "breaking",
    "added_lines": 3,
    "removed_lines": 10,
    "summary": "Breaking change: -10 lines removed in Authentication",
    "detected_at": "2026-08-25T12:00:00Z"
  },
  "timestamp": "2026-08-25T12:00:05Z"
}
```

**Signature verification:**

```http
X-ACR-Signature: sha256=<hmac_hex>
X-ACR-Event: changelog.change_detected
```

Verify by computing `HMAC-SHA256(request_body, your_webhook_signing_key)`.

---

## API Keys

### Generate Key

```http
POST /api/v1/api-keys
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "CI/CD Key",
  "scopes": "read,write"
}
```

**Response (201):**

```json
{
  "key": "acr_a1b2c3d4...",
  "prefix": "acr_a1b2c3d4",
  "name": "CI/CD Key",
  "scopes": "read,write",
  "warning": "Save this key now. It cannot be retrieved again."
}
```

### List Keys

```http
GET /api/v1/api-keys
Authorization: Bearer <token>
```

### Revoke Key

```http
DELETE /api/v1/api-keys/:id
Authorization: Bearer <token>
```

---

## Plans

### List Plans

```http
GET /api/v1/plans
```

**Response (200):**

```json
{
  "plans": [
    {
      "key": "free",
      "name": "Free",
      "price_monthly": 0,
      "price_monthly_dollars": "0.00",
      "max_sources": 2
    },
    {
      "key": "starter",
      "name": "Starter",
      "price_monthly": 3900,
      "price_monthly_dollars": "39.00"
    }
  ]
}
```

---

## Leads

### Capture Lead

```http
POST /api/v1/leads
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@company.com",
  "source_url": "https://stripe.com/docs/changelog"
}
```

No authentication required. Rate limited to 5 requests per minute per IP.

---

## Health

### Health Check

```http
GET /health
```

**Response (200):**

```json
{
  "status": "ok",
  "app": "API Changelog Radar",
  "version": "1.0.0",
  "timestamp": "2026-08-25T20:00:00.000Z"
}
```

---

## Error Responses

All errors return JSON with an `error` field:

```json
{
  "error": "Source not found"
}
```

| Status | Meaning |
| --- | --- |
| 400 | Bad request (validation error) |
| 401 | Authentication required |
| 403 | Forbidden (plan limit, insufficient scope) |
| 404 | Resource not found |
| 409 | Conflict (duplicate) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

Rate limit responses include a `Retry-After` header.

All responses include `X-Request-Id` for tracing.
