/**
 * Unit & Integration Test Suite for ComfyUI Cloudflare Worker API
 * Tests routing, validation, job lifecycle, worker lease protocol, and auth.
 */

import assert from 'node:assert/strict';
import worker from '../deploy/workers/src/worker.js';

// In-Memory SQLite Mock for D1 Testing
class MockD1Database {
  constructor() {
    this.jobs = [];
    this.workflows = [];
    this.nodes = [];
    this.logs = [];
    this.apiKeys = [];
    this.autoInc = 1;
  }

  prepare(query) {
    const db = this;
    return {
      bind(...params) {
        return {
          async first() {
            const results = db._executeQuery(query, params);
            return results.length > 0 ? results[0] : null;
          },
          async all() {
            const results = db._executeQuery(query, params);
            return { results, meta: { changes: results.length } };
          },
          async run() {
            return db._executeRun(query, params);
          },
        };
      },
      async first() {
        const results = db._executeQuery(query, []);
        return results.length > 0 ? results[0] : null;
      },
      async all() {
        const results = db._executeQuery(query, []);
        return { results, meta: { changes: results.length } };
      },
      async run() {
        return db._executeRun(query, []);
      },
    };
  }

  _executeQuery(query, params) {
    const q = query.trim().toUpperCase().replace(/\s+/g, ' ');

    if (q.includes('FROM JOBS') && q.includes('COUNT(*)')) {
      if (q.includes("STATUS = 'QUEUED'")) {
        const count = this.jobs.filter(j => j.status === 'queued').length;
        return [{ c: count, count }];
      }
      if (q.includes("STATUS = 'CLAIMED'")) return [{ c: this.jobs.filter(j => j.status === 'claimed').length }];
      if (q.includes("STATUS = 'PROCESSING'")) return [{ c: this.jobs.filter(j => j.status === 'processing').length }];
      if (q.includes("STATUS = 'COMPLETED'")) return [{ c: this.jobs.filter(j => j.status === 'completed').length }];
      if (q.includes("STATUS = 'FAILED'")) return [{ c: this.jobs.filter(j => j.status === 'failed').length }];
      return [{ c: this.jobs.length, count: this.jobs.length }];
    }

    if (q.includes('FROM WORKFLOWS') && q.includes('COUNT(*)')) {
      return [{ c: this.workflows.filter(w => w.is_active !== 0).length }];
    }

    if (q.includes('FROM GPU_NODES') && q.includes('COUNT(*)')) {
      return [{ c: this.nodes.filter(n => n.status !== 'offline').length }];
    }

    if (q.includes('FROM JOBS WHERE JOB_ID =') || q.includes('FROM JOBS WHERE (JOB_ID =')) {
      const id = params[0];
      const match = this.jobs.find(j => j.job_id === id || j.id === id);
      return match ? [match] : [];
    }

    if (q.includes('FROM WORKFLOWS WHERE (WORKFLOW_ID =') || q.includes('FROM WORKFLOWS WHERE WORKFLOW_ID =') || q.includes('FROM WORKFLOWS WHERE SLUG =')) {
      const id = params[0];
      const match = this.workflows.find(w => (w.workflow_id === id || w.slug === id || w.id === id) && w.is_active !== 0);
      return match ? [match] : [];
    }

    if (q.includes('FROM JOBS') && (q.includes("STATUS = 'QUEUED'") || q.includes("STATUS IN ('CLAIMED'"))) {
      // Find eligible job for claiming
      const match = this.jobs.find(j => j.status === 'queued' || (['claimed', 'processing'].includes(j.status) && new Date(j.lease_expires_at) < new Date()));
      return match ? [match] : [];
    }

    if (q.includes('FROM JOBS')) {
      return [...this.jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    if (q.includes('FROM WORKFLOWS')) {
      return this.workflows.filter(w => w.is_active !== 0);
    }

    if (q.includes('FROM GPU_NODES')) {
      return [...this.nodes];
    }

    if (q.includes('FROM JOB_LOGS')) {
      const jobId = params[0];
      return this.logs.filter(l => l.job_id === jobId);
    }

    return [];
  }

  _executeRun(query, params) {
    const q = query.trim().toUpperCase().replace(/\s+/g, ' ');

    if (q.startsWith('INSERT INTO JOBS')) {
      const jobId = params[0];
      const clientId = params[1];
      const workflowId = params[2];
      const workflowName = params[3];
      const workflowJson = params[4];
      const paramsJson = params[5];
      const priority = params[6];
      const gpuRequired = params[7];
      const maxRetries = params[8];
      const webhookUrl = params[9];

      const newJob = {
        id: this.autoInc++,
        job_id: jobId,
        client_id: clientId,
        workflow_id: workflowId,
        workflow_name: workflowName,
        workflow_json: workflowJson,
        params_json: paramsJson,
        status: 'queued',
        priority: priority || 5,
        gpu_required: gpuRequired || 'any',
        assigned_node_id: null,
        lease_expires_at: null,
        progress: 0,
        current_node: null,
        current_step: 0,
        total_steps: 0,
        outputs_json: null,
        error: null,
        retry_count: 0,
        max_retries: maxRetries || 3,
        webhook_url: webhookUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.jobs.push(newJob);
      return { meta: { last_row_id: newJob.id, changes: 1 } };
    }

    if (q.startsWith('INSERT INTO WORKFLOWS')) {
      const newWf = {
        id: this.autoInc++,
        workflow_id: params[0],
        name: params[1],
        slug: params[2],
        description: params[3],
        category: params[4],
        tags: params[5],
        workflow_json: params[6],
        default_params_json: params[7],
        version: params[8],
        author: params[9],
        usage_count: 0,
        is_active: 1,
        created_at: new Date().toISOString(),
      };
      this.workflows.push(newWf);
      return { meta: { last_row_id: newWf.id, changes: 1 } };
    }

    if (q.startsWith('INSERT INTO GPU_NODES') || q.includes('ON CONFLICT(NODE_ID)')) {
      const nodeId = params[0];
      const existing = this.nodes.find(n => n.node_id === nodeId);
      if (existing) {
        existing.name = params[1];
        existing.gpu_type = params[4];
        existing.vram_gb = params[5];
        existing.status = 'online';
        existing.last_heartbeat = new Date().toISOString();
      } else {
        this.nodes.push({
          id: this.autoInc++,
          node_id: nodeId,
          name: params[1],
          gpu_type: params[4],
          vram_gb: params[5],
          status: 'online',
          active_jobs: 0,
          completed_jobs: 0,
          failed_jobs: 0,
          last_heartbeat: new Date().toISOString(),
        });
      }
      return { meta: { changes: 1 } };
    }

    if (q.startsWith('INSERT INTO JOB_LOGS')) {
      this.logs.push({
        id: this.autoInc++,
        job_id: params[0],
        level: params[1],
        message: params[2],
        timestamp: new Date().toISOString(),
      });
      return { meta: { changes: 1 } };
    }

    if (q.startsWith('UPDATE JOBS SET STATUS = \'CLAIMED\'')) {
      const nodeId = params[0];
      const targetId = params[2];
      const job = this.jobs.find(j => j.id === targetId);
      if (job) {
        job.status = 'claimed';
        job.assigned_node_id = nodeId;
        job.lease_expires_at = new Date(Date.now() + 180000).toISOString();
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (q.startsWith('UPDATE JOBS SET STATUS = \'PROCESSING\'')) {
      const jobId = params[5];
      const job = this.jobs.find(j => j.job_id === jobId);
      if (job) {
        job.status = 'processing';
        job.progress = params[0];
        job.current_node = params[1];
        job.current_step = params[2];
        job.total_steps = params[3];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (q.startsWith('UPDATE JOBS SET STATUS = \'COMPLETED\'')) {
      const jobId = params[1];
      const job = this.jobs.find(j => j.job_id === jobId);
      if (job) {
        job.status = 'completed';
        job.progress = 100;
        job.outputs_json = params[0];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (q.startsWith('UPDATE JOBS SET STATUS = \'CANCELLED\'')) {
      const jobId = params[0];
      const job = this.jobs.find(j => j.job_id === jobId);
      if (job) {
        job.status = 'cancelled';
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (q.startsWith('UPDATE JOBS SET STATUS = \'QUEUED\'') && q.includes('RETRY_COUNT = RETRY_COUNT + 1')) {
      const jobId = params[0];
      const job = this.jobs.find(j => j.job_id === jobId);
      if (job) {
        job.status = 'queued';
        job.retry_count++;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (q.startsWith('UPDATE GPU_NODES SET LAST_HEARTBEAT')) {
      const nodeId = params[2];
      const node = this.nodes.find(n => n.node_id === nodeId);
      if (node) {
        node.status = params[0];
        node.active_jobs = params[1];
        node.last_heartbeat = new Date().toISOString();
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    return { meta: { changes: 1 } };
  }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

async function runTests() {
  console.log('🚀 Starting ComfyUI API Worker Test Suite...\n');

  const env = {
    DB: new MockD1Database(),
    ADMIN_API_KEY: 'test-admin-secret',
    WORKER_API_KEY: 'test-worker-secret',
    CLIENT_API_KEY: 'test-client-secret',
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-admin-secret',
  };

  // Helper request maker
  async function call(path, method = 'GET', body = null, customHeaders = headers) {
    const opts = { method, headers: customHeaders };
    if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const req = new Request(`http://localhost${path}`, opts);
    const res = await worker.fetch(req, env, { waitUntil: () => {} });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json, text };
  }

  // 1. Health Check
  {
    console.log('▶ Test 1: GET /health');
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.service, 'comfyui-api');
    console.log('  ✔ Health check passed');
  }

  // 2. Auth Rejection
  {
    console.log('▶ Test 2: Authentication Enforcement');
    const unauthed = await call('/api/v1/jobs', 'POST', { workflow_json: {} }, { 'Content-Type': 'application/json' });
    assert.equal(unauthed.status, 401);
    console.log('  ✔ Unauthorized request blocked with 401');
  }

  // 3. Workflow Registration
  let createdWorkflowId;
  {
    console.log('▶ Test 3: POST /api/v1/workflows (Register Workflow)');
    const res = await call('/api/v1/workflows', 'POST', {
      name: 'Flux Ultra Portrait',
      slug: 'flux-ultra-portrait',
      category: 'portraits',
      description: 'Studio photorealistic portrait workflow',
      workflow_json: { "1": { "class_type": "KSampler", "inputs": { "seed": 42 } } },
      default_params: { steps: 25, cfg: 7.0 },
    });
    assert.equal(res.status, 201);
    assert.ok(res.json.workflow_id);
    createdWorkflowId = res.json.workflow_id;
    console.log(`  ✔ Workflow registered: ${createdWorkflowId}`);
  }

  // 4. List Workflows
  {
    console.log('▶ Test 4: GET /api/v1/workflows');
    const res = await call('/api/v1/workflows');
    assert.equal(res.status, 200);
    assert.equal(res.json.workflows.length, 1);
    assert.equal(res.json.workflows[0].name, 'Flux Ultra Portrait');
    console.log('  ✔ Workflows list returned registered template');
  }

  // 5. Submit Job
  let createdJobId;
  {
    console.log('▶ Test 5: POST /api/v1/jobs (Submit Job)');
    const res = await call('/api/v1/jobs', 'POST', {
      workflow_id: createdWorkflowId,
      params: { prompt: 'A cinematic cybernetic portrait', seed: 9999 },
      priority: 8,
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.status, 'queued');
    assert.equal(res.json.priority, 8);
    assert.ok(res.json.job_id);
    createdJobId = res.json.job_id;
    console.log(`  ✔ Job created: ${createdJobId} (Priority: 8)`);
  }

  // 6. Query Job Details & Status
  {
    console.log('▶ Test 6: GET /api/v1/jobs/:id & /status');
    const jobRes = await call(`/api/v1/jobs/${createdJobId}`);
    assert.equal(jobRes.status, 200);
    assert.equal(jobRes.json.job_id, createdJobId);
    assert.equal(jobRes.json.status, 'queued');

    const statusRes = await call(`/api/v1/jobs/${createdJobId}/status`);
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.status, 'queued');
    console.log('  ✔ Job details and status retrieved successfully');
  }

  // 7. Node Fleet Registration & Heartbeat
  const workerHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-worker-secret',
  };

  {
    console.log('▶ Test 7: POST /api/v1/nodes/register & /heartbeat');
    const regRes = await call('/api/v1/nodes/register', 'POST', {
      node_id: 'epyc-gpu-01',
      name: 'Hardonian EPYC GPU Rig',
      gpu_type: 'NVIDIA RTX 4090',
      vram_gb: 24.0,
      max_concurrency: 1,
    }, workerHeaders);
    assert.equal(regRes.status, 200);
    assert.equal(regRes.json.node_id, 'epyc-gpu-01');

    const hbRes = await call('/api/v1/nodes/heartbeat', 'POST', {
      node_id: 'epyc-gpu-01',
      active_jobs: 0,
      status: 'online',
    }, workerHeaders);
    assert.equal(hbRes.status, 200);
    console.log('  ✔ Node registered and heartbeat acknowledged');
  }

  // 8. Atomic Worker Claim Job
  {
    console.log('▶ Test 8: POST /api/v1/jobs/claim');
    const claimRes = await call('/api/v1/jobs/claim', 'POST', {
      node_id: 'epyc-gpu-01',
      gpu_type: 'rtx4090',
    }, workerHeaders);
    assert.equal(claimRes.status, 200);
    assert.ok(claimRes.json.job);
    assert.equal(claimRes.json.job.job_id, createdJobId);
    console.log(`  ✔ Worker claimed job ${createdJobId}`);
  }

  // 9. Worker Report Progress
  {
    console.log('▶ Test 9: POST /api/v1/jobs/:id/progress');
    const progRes = await call(`/api/v1/jobs/${createdJobId}/progress`, 'POST', {
      node_id: 'epyc-gpu-01',
      progress: 45,
      current_node: 'KSampler',
      current_step: 12,
      total_steps: 25,
      log_message: 'Sampler step 12/25',
    }, workerHeaders);
    assert.equal(progRes.status, 200);
    assert.equal(progRes.json.progress, 45);
    console.log('  ✔ Progress updated to 45%');
  }

  // 10. Worker Complete Job
  {
    console.log('▶ Test 10: POST /api/v1/jobs/:id/complete');
    const compRes = await call(`/api/v1/jobs/${createdJobId}/complete`, 'POST', {
      node_id: 'epyc-gpu-01',
      outputs: [
        { filename: 'output_001.png', path: '/outputs/job_1/output_001.png', size_bytes: 2048500 },
      ],
      metrics: { duration_seconds: 4.2 },
    }, workerHeaders);
    assert.equal(compRes.status, 200);
    assert.equal(compRes.json.status, 'completed');

    const jobCheck = await call(`/api/v1/jobs/${createdJobId}`);
    assert.equal(jobCheck.json.status, 'completed');
    assert.equal(jobCheck.json.progress, 100);
    console.log('  ✔ Job marked complete with output artifacts');
  }

  // 11. Batch Generation Submission
  {
    console.log('▶ Test 11: POST /api/v1/batch/submit');
    const batchRes = await call('/api/v1/batch/submit', 'POST', {
      workflow_id: createdWorkflowId,
      items: [
        { seed: 101, prompt: 'Variation 1' },
        { seed: 102, prompt: 'Variation 2' },
        { seed: 103, prompt: 'Variation 3' },
      ],
      priority: 6,
    });
    assert.equal(batchRes.status, 201);
    assert.equal(batchRes.json.job_count, 3);
    assert.ok(batchRes.json.batch_id);
    console.log(`  ✔ Batch submission created ${batchRes.json.job_count} jobs`);
  }

  // 12. Stats Aggregation
  {
    console.log('▶ Test 12: GET /api/v1/stats');
    const statsRes = await call('/api/v1/stats');
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.json.jobs.completed, 1);
    assert.equal(statsRes.json.workflows, 1);
    console.log('  ✔ Stats endpoint returned accurate counts');
  }

  console.log('\n✨ ALL 12 WORKER API TESTS PASSED SUCCESSFULLY! ✨\n');
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
