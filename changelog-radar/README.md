# API Changelog Radar

<!-- BEGIN: REPO HERO -->
![api-changelog-radar — hero generated locally on the GPU stack](assets/repo-hero.png)
<!-- END: REPO HERO -->

**Monitor vendor API changelogs, diff changes automatically, and alert your team before integrations break.**

[![Deploy](https://github.com/Hardonian/api-changelog-radar/actions/workflows/deploy.yml/badge.svg)](https://github.com/Hardonian/api-changelog-radar/actions/workflows/deploy.yml)
[![CI](https://github.com/Hardonian/api-changelog-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/Hardonian/api-changelog-radar/actions/workflows/ci.yml)
[![Security](https://github.com/Hardonian/api-changelog-radar/actions/workflows/security.yml/badge.svg)](https://github.com/Hardonian/api-changelog-radar/actions/workflows/security.yml)

## What It Does

API Changelog Radar automatically polls vendor changelog pages, API specs, and documentation URLs on a configurable schedule. When content changes, it computes a line-by-line diff, classifies the severity (info, warning, breaking), and sends alerts via Slack, webhooks, email, or in-app notifications.

## Architecture

```text
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│   Landing    │     │    Dashboard      │     │   GitHub     │
│  (CF Pages)  │     │   (CF Pages)      │     │   Actions    │
└──────┬───────┘     └────────┬──────────┘     └──────┬───────┘
       │                      │                       │
       ▼                      ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│                Cloudflare Worker (Edge API)                     │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌──────────┐ ┌────────────┐  │
│  │  Auth  │ │ CORS │ │  Rate  │ │ Security │ │   Router   │  │
│  │Midware │ │      │ │ Limit  │ │ Headers  │ │ 30+ routes │  │
│  └────────┘ └──────┘ └────────┘ └──────────┘ └────────────┘  │
│  ┌────────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Polling Engine │  │ Diff Engine  │  │ Notifier Engine   │  │
│  │ (cron: 5 min)  │  │ (LCS-based)  │  │ (cron: 1 min)    │  │
│  └────────────────┘  └──────────────┘  └───────────────────┘  │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │ Cloudflare  │
                    │  D1 (SQLite)│
                    └─────────────┘
```

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Runtime** | Cloudflare Workers (JavaScript, zero dependencies) |
| **Database** | Cloudflare D1 (SQLite-compatible, edge-replicated) |
| **Auth** | JWT (HMAC-SHA256) + API keys, all via Web Crypto API |
| **Deploy** | Wrangler via GitHub Actions |
| **Frontends** | Static HTML/CSS/JS on Cloudflare Pages |
| **Alerts** | Webhooks (HMAC-signed), Slack (Block Kit), Email (Resend API) |

## Features

- ✅ **Full REST API** — 30+ endpoints for sources, diffs, alerts, API keys, plans
- ✅ **Automatic Polling** — Cron-triggered content fetching with configurable intervals
- ✅ **Smart Diffing** — LCS-based line diff with severity classification (info/warning/breaking)
- ✅ **Multi-Channel Alerts** — Webhook, Slack, email, and in-app notifications
- ✅ **JWT Authentication** — PBKDF2 password hashing, scoped API keys
- ✅ **Rate Limiting** — Plan-aware, D1-backed rate limiting
- ✅ **Security Headers** — HSTS, CSP, X-Frame-Options, X-Content-Type-Options
- ✅ **Audit Logging** — All mutations logged with IP, user agent, timestamp
- ✅ **Plan Enforcement** — Source limits, feature gating, retention policies
- ✅ **Zero Dependencies** — Entire backend runs with 0 npm dependencies

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/Hardonian/api-changelog-radar.git
cd api-changelog-radar/deploy/workers
npm install
```

### 2. Set Up D1 Database

```bash
# Create the database (first time only)
wrangler d1 create api_changelog_radar

# Apply migrations
npm run db:migrate:local
```

### 3. Set Secrets

```bash
wrangler secret put JWT_SECRET
wrangler secret put WEBHOOK_SIGNING_KEY
# Optional:
wrangler secret put EMAIL_API_KEY
wrangler secret put EMAIL_FROM
```

### 4. Run Locally

```bash
npm run dev
# → http://localhost:8787
```

### 5. Deploy

```bash
npm run deploy
```

## API Reference

See [API.md](API.md) for complete API documentation.

### Key Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | No | Create account |
| `POST` | `/api/v1/auth/login` | No | Sign in, get JWT |
| `GET` | `/api/v1/auth/me` | Yes | Current user + usage |
| `POST` | `/api/v1/sources` | Yes | Add monitored source |
| `GET` | `/api/v1/sources` | Yes | List sources |
| `GET` | `/api/v1/diffs/recent` | Yes | Recent changes feed |
| `POST` | `/api/v1/alerts` | Yes | Create alert config |
| `POST` | `/api/v1/api-keys` | Yes | Generate API key |
| `GET` | `/api/v1/plans` | No | List pricing plans |
| `POST` | `/api/v1/leads` | No | Lead capture |
| `GET` | `/health` | No | Health check |

## Project Structure

```text
deploy/
├── workers/
│   ├── src/
│   │   ├── worker.js              # Entry point (fetch + cron handlers)
│   │   ├── router.js              # Request router
│   │   ├── config.js              # Centralized configuration
│   │   ├── middleware/
│   │   │   ├── auth.js            # JWT + API key authentication
│   │   │   ├── cors.js            # CORS handling
│   │   │   ├── rate-limit.js      # Plan-aware rate limiting
│   │   │   └── security.js        # Security headers
│   │   ├── routes/
│   │   │   ├── auth.js            # Register, login, refresh, me
│   │   │   ├── sources.js         # CRUD + manual poll
│   │   │   ├── diffs.js           # List + detail
│   │   │   ├── alerts.js          # CRUD + test + log
│   │   │   ├── plans.js           # List from D1
│   │   │   ├── leads.js           # Lead capture
│   │   │   └── apikeys.js         # Generate, list, revoke
│   │   ├── engines/
│   │   │   ├── poller.js          # Cron URL fetcher
│   │   │   ├── differ.js          # LCS diff + severity
│   │   │   └── notifier.js        # Alert dispatch
│   │   └── utils/
│   │       ├── crypto.js          # PBKDF2, JWT, HMAC, SHA-256
│   │       └── validate.js        # Input validation
│   ├── tests/
│   │   ├── router.test.js
│   │   ├── crypto.test.js
│   │   ├── differ.test.js
│   │   └── validate.test.js
│   ├── wrangler.toml              # Worker + D1 + cron config
│   └── package.json
├── d1/
│   ├── schema.sql                 # Canonical schema
│   └── migrations/001_initial.sql # D1 migration
├── frontend/index.html            # Dashboard SPA
└── landing/index.html             # Marketing landing page
.github/workflows/
├── deploy.yml                     # Production deploy pipeline
├── ci.yml                         # Lint + test + audit
├── security.yml                   # Gitleaks + CodeQL + npm audit
└── dependabot-auto-merge.yml      # Auto-merge patch/minor deps
```

## Security

- All passwords hashed with PBKDF2 (100k iterations, SHA-256)
- JWT tokens signed with HMAC-SHA256
- API keys stored as SHA-256 hashes (never plaintext)
- Webhook payloads signed with HMAC-SHA256
- All DB queries use parameterized statements (zero SQL injection surface)
- Security headers on every response (HSTS, X-Frame-Options, CSP, etc.)
- Rate limiting on all endpoints
- Audit logging on all mutations
- Secret scanning in CI (Gitleaks)
- Dependency scanning (npm audit, CodeQL)

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

See [LICENSE](LICENSE).
