# comfyui-api — Deployment

Deployment wrapper for the local ComfyUI inference API. This repository contains **deploy configuration only** (no application source — the API runs from the EPYC lab's local ComfyUI install).

## Contents
```
deploy/
  d1/           # primary deploy target (wrangler.toml, schema.sql, src/)
  frontend/     # edge/frontend config
  workers/      # worker definitions
.github/        # CI / deploy workflows
```

## What it deploys
- A Cloudflare Workers front end (`wrangler.toml`) routing to the local ComfyUI API.
- Schema/init SQL for the backing store.
- Worker scripts that proxy/secure the local ComfyUI endpoint.

## Notes
- The runtime ComfyUI + model assets live on the EPYC lab, not in this repo.
- See the Hardonia AI lab command center for live service status.
