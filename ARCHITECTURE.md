# Architecture

## Platform Context

**api-tools** is one of seven Hardonia monorepos. It provides API-layer tooling — a ComfyUI API gateway, webhook capture/replay, and vendor changelog monitoring — all targeting the Cloudflare edge platform.

## Position in the Hardonia Platform

```
┌─────────────────────────────────────────────────────────────────┐
│                        Hardonia Platform                        │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│  Consumer    │  API         │  Ops         │  Infra / AI         │
│  Surface     │  Surface     │  Surface     │  Core               │
├──────────────┼──────────────┼──────────────┼─────────────────────┤
│ consumer-tools│ api-tools   │ ops-tools    │ autopilot           │
│              │              │              │ agent-infra         │
│              │              │              │ agent-edge          │
│              │              │              │ model-tools         │
└──────────────┴──────────────┴──────────────┴─────────────────────┘
```

| Layer | Repo | Purpose |
|-------|------|---------|
| Consumer Surface | **[consumer-tools](https://github.com/Hardonian/consumer-tools)** | Warranty tracking, review intelligence, inbox cleanup |
| API Surface | **[api-tools](https://github.com/Hardonian/api-tools)** | ComfyUI API gateway, webhook capture, changelog tracking |
| Ops Surface | **[ops-tools](https://github.com/Hardonian/ops-tools)** | Continuity assurance, Terraform drift, developer platform |
| Core | **[autopilot](https://github.com/Hardonian/autopilot)** | Autonomous agent orchestration |
| Core | **[agent-infra](https://github.com/Hardonian/agent-infra)** | Agent infrastructure and runtime |
| Core | **[agent-edge](https://github.com/Hardonian/agent-edge)** | Edge-deployed agent runtimes |
| Core | **[model-tools](https://github.com/Hardonian/model-tools)** | Model management, evaluation, deployment |

## Internal Architecture

```
api-tools/
├── comfyui-api/         # Enterprise ComfyUI API gateway + GPU job queue
├── webhook-witness/     # Capture, inspect, replay webhook payloads
├── changelog-radar/     # Monitor vendor API changelogs for breaking changes
└── package.json         # pnpm workspace root
```

All three packages target the Cloudflare edge platform (Workers + D1 + Pages). They share a common deployment model and can be operated independently or as a unified API operations stack.

## Cross-Repo Dependencies

- **consumer-tools/review-radar** — uses comfyui-api for image generation
- **ops-tools/continuity** — webhook-witness can feed continuity assurance events
- **model-tools** — comfyui-api wraps model-tools inference endpoints
