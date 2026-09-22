# api-tools

**Unified API tooling monorepo** — ComfyUI API wrapper, webhook verification, and API changelog tracking.

## Packages

| Directory | Description | Stack |
|---|---|---|
| [`comfyui-api/`](./comfyui-api) | Enterprise ComfyUI API gateway, GPU job queue coordinator, and worker bridge | Cloudflare Workers + D1, Node.js |
| [`webhook-witness/`](./webhook-witness) | Capture, inspect, and replay webhook payloads for SaaS integrations | Cloudflare Workers + D1 + Pages |
| [`changelog-radar/`](./changelog-radar) | Monitor vendor API changelogs, diff changes, and alert before integrations break | Cloudflare Workers + Pages, GitHub Actions |

## Quick Start

```bash
# Install dependencies across all packages
pnpm install

# Work on a specific package
cd comfyui-api
pnpm dev

cd ../webhook-witness
# see its README for setup

cd ../changelog-radar
# see its README for setup
```

## Architecture

All three packages target the Cloudflare edge platform (Workers + D1 + Pages). They share a common deployment model and can be operated independently or as a unified API operations stack:

- **comfyui-api** — submit inference jobs, manage GPU worker fleets, serve generated assets
- **webhook-witness** — capture and debug webhook payloads from any SaaS provider
- **changelog-radar** — track breaking changes in third-party APIs before they hit production

## Development

Each package is self-contained with its own `README.md`, configuration, and deployment setup. See individual package docs for details.

## Related Repos

### Hardonia Monorepos

| Repo | Purpose |
|------|---------|
| [autopilot](https://github.com/Hardonian/autopilot) | Autonomous agent orchestration |
| [agent-infra](https://github.com/Hardonian/agent-infra) | Agent infrastructure and runtime |
| [agent-edge](https://github.com/Hardonian/agent-edge) | Edge-deployed agent runtimes |
| [model-tools](https://github.com/Hardonian/model-tools) | Model management, evaluation, deployment |
| [consumer-tools](https://github.com/Hardonian/consumer-tools) | Warranty tracking, review intelligence, inbox cleanup |
| [ops-tools](https://github.com/Hardonian/ops-tools) | Continuity assurance, Terraform drift, developer platform |

### Commercial Repos

| Repo | Purpose |
|------|---------|
| [hardonia-store](https://github.com/Hardonian/hardonia-store) | Hardonia storefront |
| [comfyui-workflow-packs](https://github.com/Hardonian/comfyui-workflow-packs) | ComfyUI workflow packages |
| [content-repo](https://github.com/Hardonian/content-repo) | Content assets |
| [ai-prompt-templates](https://github.com/Hardonian/ai-prompt-templates) | AI prompt templates |
| [ai-ops-toolkit](https://github.com/Hardonian/ai-ops-toolkit) | AI operations toolkit |

## License

MIT — see individual package LICENSE files.
