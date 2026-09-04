# ComfyUI API Gateway & GPU Queue Coordinator

<!-- BEGIN: REPO HERO -->
![comfyui-api — hero generated locally on the GPU stack](assets/repo-hero.png)
<!-- END: REPO HERO -->

[![CI Pipeline](https://github.com/Hardonian/comfyui-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Hardonian/comfyui-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Cloudflare%20Workers%20%2B%20D1-orange)](https://workers.cloudflare.com/)

**ComfyUI API** is an enterprise-grade API gateway, distributed job queue coordinator, worker bridge daemon, and management dashboard for ComfyUI inference workloads. Built to seamlessly power generative production pipelines, GPU farms (such as local AMD EPYC / NVIDIA RTX GPU rigs and cloud instances), and automation systems including [comfyui-pack-factory](https://github.com/Hardonian/comfyui-pack-factory).

---

## 🏛 Architecture Overview

```text
 ┌──────────────────────────────────────────────┐
 │  Clients / Apps / Pack Factory / Frontends   │
 └──────────────────────┬───────────────────────┘
                        │ HTTP / REST / WebSocket
                        ▼
 ┌──────────────────────────────────────────────┐
 │       Cloudflare Worker API Gateway          │
 │  - API Key Auth & Role Access Control        │
 │  - Job Submission & Batch Generation         │
 │  - Workflow Template Catalog & Versioning    │
 │  - Rate Limiting, CORS & Error Sanitization  │
 └──────────────────────┬───────────────────────┘
                        │
                        ▼
 ┌──────────────────────────────────────────────┐
 │       Cloudflare D1 (SQLite Edge DB)         │
 │  - jobs, workflows, gpu_nodes, job_logs      │
 │  - Atomic worker leases & priority queues   │
 └──────────────────────▲───────────────────────┘
                        │
    Long Poll & Lease   │ Status / Progress / Artifacts
                        │
 ┌──────────────────────┴───────────────────────┐
 │          GPU Worker Daemon Bridge            │
 │        (`bridge/comfy_worker_daemon.py`)     │
 │  - Auto node registration & heartbeats       │
 │  - Atomic job claiming with lease timeouts   │
 │  - WebSocket progress streaming              │
 └──────────────────────┬───────────────────────┘
                        │ REST + WebSocket
                        ▼
 ┌──────────────────────────────────────────────┐
 │        Local / Remote ComfyUI Instance       │
 │            (http://127.0.0.1:8188)           │
 └──────────────────────────────────────────────┘
```

---

## 🚀 Key Features

- **Distributed Job Queue**: Prioritized job execution (levels 1-10), atomic leases, timeout detection, and automatic retry handling.
- **Workflow Registry**: Store, version, tag, and execute reusable ComfyUI workflow templates without re-uploading large graph payloads.
- **GPU Fleet Telemetry**: Real-time heartbeat tracking, VRAM telemetry, load balancing across worker rigs.
- **WebSocket Streaming**: Real-time progress updates, sampler step counters (`18/30 steps`), and detailed node execution logs.
- **Batch Processing**: Enqueue parameter matrices (prompts, seeds, dimensions) in single batch calls with batch tracking IDs.
- **Python Client SDK**: Sync (`ComfyUIClient`) and Async (`AsyncComfyUIClient`) SDKs for seamless Python automation.
- **Interactive UI Dashboard**: Modern dark-mode dashboard with glassmorphic aesthetics, live queue monitor, workflow launcher, logs viewer, and artifact gallery.
- **Enterprise Security**: Bearer / API-Key authentication (`admin`, `client`, `worker` roles), timing-safe comparisons, CORS preflight handling, and request guardrails.

---

## 📦 Project Structure

```text
├── bridge/
│   ├── comfy_worker_daemon.py   # GPU server worker bridge daemon
│   └── workflow_adapter.py      # AST parameter override engine
├── client/
│   ├── comfyui_api_client.py    # Sync & Async Python Client SDK
│   └── __init__.py
├── deploy/
│   ├── d1/
│   │   └── schema.sql           # D1 SQLite database schema & indexes
│   ├── frontend/
│   │   ├── app.js               # Dashboard application logic
│   │   ├── index.html           # Management dashboard UI
│   │   └── style.css            # Dark glassmorphic design system
│   └── workers/
│       ├── wrangler.toml        # Cloudflare Worker configuration
│       └── src/
│           └── worker.js        # Core API Gateway & Queue Worker
├── scripts/
│   └── go_live_check.py         # Go-live readiness verification audit
├── tests/
│   ├── test_client_sdk.py       # Python Client SDK test suite
│   ├── test_worker_api.js       # Cloudflare Worker test suite
│   └── test_worker_bridge.py    # Bridge & adapter test suite
├── .env.example                 # Environment variables template
├── package.json                 # Node dependencies and scripts
└── pyproject.toml               # Python package configuration
```

---

## 🛠 Quick Start

### 1. Python Client SDK

Install dependencies or install in editable mode:

```bash
pip install -r requirements.txt
```

```python
from client.comfyui_api_client import ComfyUIClient

# Initialize client
client = ComfyUIClient(
    api_url="https://api.comfyui.hardonian.com",
    api_key="your-api-key"
)

# Submit and wait for generated artifacts
result = client.generate(
    workflow="flux-ultra-portrait",
    params={
        "prompt": "Cinematic portrait of a futuristic nomad, 8k, volumetric light",
        "steps": 28,
        "seed": 42,
        "width": 1024,
        "height": 1024,
    },
    priority=8,
    on_progress=lambda status: print(f"Progress: {status['progress']}% - {status.get('current_node')}")
)

print("Job Status:", result["status"])
print("Generated Outputs:", result["outputs"])
```

### 2. Launch Worker Daemon (on GPU Server)

Run the bridge daemon on your EPYC rig or GPU machine:

```bash
python -m bridge.comfy_worker_daemon \
  --api-url https://api.comfyui.hardonian.com \
  --comfy-url http://127.0.0.1:8188 \
  --worker-key "sk_worker_secret" \
  --output-dir "./outputs"
```

### 3. Deploy Gateway to Cloudflare Workers

1. Copy `.env.example` to `.env` and set your credentials.
2. Initialize and deploy with Wrangler:

```bash
cd deploy/workers
wrangler d1 create comfyui_api_db
wrangler d1 execute comfyui_api_db --remote --file=../d1/schema.sql
wrangler deploy
```

---

## 📡 REST API Reference

| Method | Endpoint | Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | System health check and queue stats |
| `GET` | `/api/v1/stats` | Public | Fleet, queue, and workflow metrics |
| `POST` | `/api/v1/jobs` | Client / Admin | Enqueue a generation job |
| `GET` | `/api/v1/jobs` | Client / Admin | List jobs with status/pagination filters |
| `GET` | `/api/v1/jobs/:id` | Client / Admin | Get detailed job status, outputs, and params |
| `GET` | `/api/v1/jobs/:id/status` | Client / Admin | Lightweight polling endpoint |
| `POST` | `/api/v1/jobs/:id/cancel` | Client / Admin | Cancel a queued or running job |
| `POST` | `/api/v1/jobs/:id/retry` | Client / Admin | Requeue a failed or cancelled job |
| `GET` | `/api/v1/jobs/:id/logs` | Client / Admin | Get execution logs for a job |
| `POST` | `/api/v1/nodes/register` | Worker / Admin | Register a GPU worker node |
| `POST` | `/api/v1/nodes/heartbeat` | Worker / Admin | Send worker heartbeat ping |
| `GET` | `/api/v1/nodes` | Public / Admin | List all registered GPU nodes |
| `POST` | `/api/v1/jobs/claim` | Worker / Admin | Atomically claim next available job lease |
| `POST` | `/api/v1/jobs/:id/progress` | Worker / Admin | Report job progress and extend lease |
| `POST` | `/api/v1/jobs/:id/complete` | Worker / Admin | Finalize job with output artifacts |
| `POST` | `/api/v1/jobs/:id/fail` | Worker / Admin | Report execution failure / retry |
| `POST` | `/api/v1/workflows` | Client / Admin | Register a workflow template |
| `GET` | `/api/v1/workflows` | Public | List available workflow templates |
| `GET` | `/api/v1/workflows/:id` | Public | Retrieve workflow template by ID/slug |
| `POST` | `/api/v1/workflows/:id/execute` | Client / Admin | Execute a workflow template directly |
| `POST` | `/api/v1/batch/submit` | Client / Admin | Submit a parameter matrix batch |

---

## 🧪 Testing & Verification

Run the full automated test suite:

```bash
# Test Cloudflare Worker API
npm test

# Test Python Bridge & SDK
python -m pytest tests/ -v

# Run Comprehensive Go-Live Audit
python scripts/go_live_check.py
```

---

## 📜 License

MIT License © 2026 Hardonian AI
