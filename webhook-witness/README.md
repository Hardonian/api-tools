# webhook-witness

<!-- BEGIN: REPO HERO -->
![webhook-witness — hero generated locally on the GPU stack](assets/repo-hero.png)
<!-- END: REPO HERO -->

Capture, inspect, and replay webhook payloads.  
**Status:** Phase 2 (deployed on Cloudflare Workers + Pages, active development)

A Cloudflare Workers + D1 + Pages app for SaaS teams that need to preserve and troubleshoot incoming webhook payloads.

## What Works

- **Workspace-scoped capture** — each workspace has a unique slug and token
- **Simple token auth** — per-workspace bearer token for all requests
- **Event ingestion + retrieval** — capture POSTs, browse via GET endpoints
- **Replay curl generator** — produces a curl command from a captured event (placeholder domain in output — edit before use)
- **Lead capture** — `POST /api/v1/leads` wired
- **Plan definitions** — hardcoded in worker.js (`PLANS` constant: Starter $29/mo, Team $99/mo, Agency $299/mo)

## What's Placeholder / Not Wired

- **Billing** — Stripe credentials and webhook secrets not provisioned. Plan limits are defined but not enforced at capture time.
- **Deployment** — static HTML pages exist at `deploy/landing/` and `deploy/frontend/`. Not actively deployed to a public URL.
- **Event limits** — `events_per_month` and `inbox` values defined in `PLANS` constant but not checked on any capture endpoint.

## Stack

- Cloudflare Workers API (JavaScript)
- Cloudflare D1 (SQLite-compatible)
- Cloudflare Pages dashboard + landing (static HTML)

## Core Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/v1/plans` | Hardcoded plan definitions |
| `POST /api/v1/leads` | Capture lead interest |
| `POST /api/v1/workspaces/bootstrap` | Create new workspace |
| `POST /api/v1/auth/workspace` | Authenticate workspace |
| `POST /api/v1/capture/:ws/:source?token=...` | Ingest webhook payload |
| `POST /api/v1/workspaces/:slug/demo-seed?token=...` | Seed demo workspace data |
| `GET /api/v1/workspaces/:slug/summary?token=...` | Workspace event summary |
| `GET /api/v1/workspaces/:slug/events?token=...` | List captured events |
| `GET /api/v1/workspaces/:slug/events/:id?token=...` | Single event detail |
| `GET /api/v1/workspaces/:slug/replay-plan/:id?token=...` | Generate replay curl |

## Known Gaps

- Stripe not provisioned — billing is a hardcoded shell (no checkout, no subscriptions)
- Replay curl outputs `your-app.example.com` placeholder — edit before use
- Event/inbox limits defined but not enforced at the capture layer
