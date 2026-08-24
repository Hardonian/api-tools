/**
 * ComfyUI API Dashboard Application Logic
 * Real-time monitoring, job submission, logs viewer, and node telemetry.
 */

// State
const state = {
  activeTab: 'jobs',
  apiKey: localStorage.getItem('comfyui_api_key') || '',
  jobs: [],
  workflows: [],
  nodes: [],
  stats: null,
  selectedJob: null,
  autoRefresh: true,
  refreshTimer: null,
  logsTimer: null,
};

const API_BASE = ''; // Same-origin relative paths

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.apiKey) {
    headers['Authorization'] = `Bearer ${state.apiKey}`;
    headers['X-API-Key'] = state.apiKey;
  }
  return headers;
}

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Format date relative
function formatRelativeTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString();
}

// Switch UI tabs
function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabId}`);
  });

  if (tabId === 'jobs') fetchJobs();
  if (tabId === 'workflows') fetchWorkflows();
  if (tabId === 'fleet') fetchNodes();
}

// Fetch System Stats & Health
async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/stats`, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.stats = data;
      document.getElementById('stat-queued').textContent = data.jobs?.queued || 0;
      document.getElementById('stat-active').textContent = (data.jobs?.claimed || 0) + (data.jobs?.processing || 0);
      document.getElementById('stat-completed').textContent = data.jobs?.completed || 0;
      document.getElementById('stat-nodes').textContent = data.nodes?.active_count || 0;
      
      document.getElementById('status-indicator').innerHTML = '<span class="status-dot"></span> System Online';
    }
  } catch (err) {
    document.getElementById('status-indicator').innerHTML = '<span class="status-dot offline"></span> API Offline';
  }
}

// Fetch Jobs
async function fetchJobs() {
  const statusFilter = document.getElementById('job-status-filter')?.value || '';
  let url = `${API_BASE}/api/v1/jobs?limit=50`;
  if (statusFilter) url += `&status=${statusFilter}`;

  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.jobs = data.jobs || [];
      renderJobsTable();
    }
  } catch (err) {
    console.error('Failed to fetch jobs:', err);
  }
}

function renderJobsTable() {
  const tbody = document.getElementById('jobs-table-body');
  if (!tbody) return;

  if (state.jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 2.5rem; color: var(--text-muted);">No jobs found in queue</td></tr>';
    return;
  }

  tbody.innerHTML = state.jobs.map(job => {
    const isProcessing = ['claimed', 'processing'].includes(job.status);
    const progress = job.progress || (job.status === 'completed' ? 100 : 0);

    return `
      <tr>
        <td>
          <a href="javascript:void(0)" onclick="openJobDetails('${job.job_id}')" style="color:var(--primary-light); font-family:var(--font-mono); font-weight:600;">
            ${job.job_id}
          </a>
        </td>
        <td>${escapeHtml(job.workflow_name || 'Custom Workflow')}</td>
        <td>
          <span class="badge-status ${job.status}">${job.status}</span>
        </td>
        <td style="min-width: 140px;">
          <div style="font-size: 0.75rem; display:flex; justify-content:space-between; margin-bottom: 2px;">
            <span>${progress}%</span>
            <span>${job.current_node ? escapeHtml(job.current_node) : ''}</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: ${progress}%"></div>
          </div>
        </td>
        <td>${job.assigned_node_id ? escapeHtml(job.assigned_node_id) : '<span style="color:var(--text-muted)">Unassigned</span>'}</td>
        <td style="font-size: 0.8rem; color: var(--text-dim);">${formatRelativeTime(job.created_at)}</td>
        <td>
          <div style="display:flex; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm" onclick="openJobDetails('${job.job_id}')">View</button>
            ${isProcessing || job.status === 'queued' ? `<button class="btn btn-secondary btn-sm" style="color:var(--danger)" onclick="cancelJob('${job.job_id}')">Cancel</button>` : ''}
            ${['failed', 'cancelled'].includes(job.status) ? `<button class="btn btn-secondary btn-sm" onclick="retryJob('${job.job_id}')">Retry</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Open Job Details Modal
async function openJobDetails(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`, { headers: getHeaders() });
    if (!res.ok) throw new Error('Job not found');
    const job = await res.json();
    state.selectedJob = job;

    document.getElementById('modal-job-id').textContent = job.job_id;
    document.getElementById('modal-job-status').innerHTML = `<span class="badge-status ${job.status}">${job.status}</span>`;
    document.getElementById('modal-job-workflow').textContent = job.workflow_name || 'Custom Workflow';
    document.getElementById('modal-job-created').textContent = job.created_at;
    document.getElementById('modal-job-node').textContent = job.assigned_node_id || 'None';
    document.getElementById('modal-job-error').textContent = job.error || 'None';
    document.getElementById('modal-job-error-container').style.display = job.error ? 'block' : 'none';

    // Render artifacts gallery
    const galleryEl = document.getElementById('modal-gallery');
    if (job.outputs && Array.isArray(job.outputs) && job.outputs.length > 0) {
      galleryEl.innerHTML = job.outputs.map(out => `
        <div class="gallery-item">
          <img src="${out.url || out.path || ''}" alt="${escapeHtml(out.filename || 'Output')}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\'><rect fill=\\'%231e293b\\' width=\\'100\\' height=\\'100\\'/><text fill=\\'%2394a3b8\\' x=\\'50%\\' y=\\'50%\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\'>File</text></svg>'">
          <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.7); font-size:0.7rem; padding:4px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${escapeHtml(out.filename || 'Artifact')}
          </div>
        </div>
      `).join('');
    } else {
      galleryEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No output artifacts generated yet.</p>';
    }

    // Fetch and show logs
    fetchJobLogs(jobId);

    document.getElementById('job-modal').style.display = 'flex';
  } catch (err) {
    showToast('Failed to load job details: ' + err.message, 'error');
  }
}

async function fetchJobLogs(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/logs`, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      const logsEl = document.getElementById('modal-logs');
      if (data.logs && data.logs.length > 0) {
        logsEl.textContent = data.logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
      } else {
        logsEl.textContent = 'No logs recorded yet.';
      }
    }
  } catch {}
}

function closeJobModal() {
  document.getElementById('job-modal').style.display = 'none';
  state.selectedJob = null;
}

// Cancel Job
async function cancelJob(jobId) {
  if (!confirm(`Are you sure you want to cancel job ${jobId}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: getHeaders(),
    });
    if (res.ok) {
      showToast(`Job ${jobId} cancelled`, 'info');
      fetchJobs();
      fetchStats();
    } else {
      const d = await res.json();
      showToast(d.error || 'Failed to cancel job', 'error');
    }
  } catch (err) {
    showToast('Error cancelling job: ' + err.message, 'error');
  }
}

// Retry Job
async function retryJob(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: getHeaders(),
    });
    if (res.ok) {
      showToast(`Job ${jobId} requeued`, 'success');
      fetchJobs();
      fetchStats();
      if (state.selectedJob && state.selectedJob.job_id === jobId) {
        openJobDetails(jobId);
      }
    }
  } catch (err) {
    showToast('Error retrying job: ' + err.message, 'error');
  }
}

// Submit New Job Form
async function handleJobSubmit(e) {
  e.preventDefault();

  const workflowSelect = document.getElementById('submit-workflow-select').value;
  const promptText = document.getElementById('submit-prompt').value;
  const negativeText = document.getElementById('submit-negative').value;
  const seedVal = document.getElementById('submit-seed').value;
  const stepsVal = document.getElementById('submit-steps').value;
  const cfgVal = document.getElementById('submit-cfg').value;
  const widthVal = document.getElementById('submit-width').value;
  const heightVal = document.getElementById('submit-height').value;
  const priorityVal = document.getElementById('submit-priority').value;

  const payload = {
    priority: parseInt(priorityVal, 10) || 5,
    params: {
      prompt: promptText,
      negative: negativeText,
      seed: seedVal ? parseInt(seedVal, 10) : undefined,
      steps: stepsVal ? parseInt(stepsVal, 10) : undefined,
      cfg: cfgVal ? parseFloat(cfgVal) : undefined,
      width: widthVal ? parseInt(widthVal, 10) : undefined,
      height: heightVal ? parseInt(heightVal, 10) : undefined,
    },
  };

  if (workflowSelect.startsWith('wf_') || workflowSelect) {
    payload.workflow_id = workflowSelect;
  } else {
    // Default fallback simple text-to-image prompt graph
    payload.workflow_json = getDefaultWorkflow();
  }

  try {
    const submitBtn = document.getElementById('btn-submit-job');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enqueuing...';

    const res = await fetch(`${API_BASE}/api/v1/jobs`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (res.ok) {
      showToast(`Job ${data.job_id} enqueued! (Position: ${data.position})`, 'success');
      switchTab('jobs');
      fetchJobs();
      fetchStats();
    } else {
      showToast(data.error || 'Failed to submit job', 'error');
    }
  } catch (err) {
    showToast('Submission error: ' + err.message, 'error');
  } finally {
    const submitBtn = document.getElementById('btn-submit-job');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Dispatch Generation Job';
  }
}

// Randomize Seed Helper
function randomizeSeed() {
  document.getElementById('submit-seed').value = Math.floor(Math.random() * 2147483647);
}

// Fetch Workflows
async function fetchWorkflows() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/workflows`, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.workflows = data.workflows || [];
      renderWorkflows();
      updateWorkflowSelects();
    }
  } catch (err) {
    console.error('Failed to fetch workflows:', err);
  }
}

function updateWorkflowSelects() {
  const sel = document.getElementById('submit-workflow-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">-- Default / Generic Workflow --</option>' +
    state.workflows.map(wf => `<option value="${wf.workflow_id}">${escapeHtml(wf.name)} (${wf.category})</option>`).join('');
  sel.value = current;
}

function renderWorkflows() {
  const container = document.getElementById('workflows-container');
  if (!container) return;

  if (state.workflows.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); grid-column:1/-1; text-align:center; padding:3rem;">No workflow templates registered yet. Click "Register Workflow" to add one.</p>';
    return;
  }

  container.innerHTML = state.workflows.map(wf => `
    <div class="workflow-card">
      <div class="card-header-flex">
        <div>
          <h3 style="font-size:1rem; font-weight:700; color:#fff;">${escapeHtml(wf.name)}</h3>
          <span style="font-size:0.75rem; color:var(--primary-light);">${escapeHtml(wf.category)} • v${escapeHtml(wf.version || '1.0.0')}</span>
        </div>
        <span class="badge" style="background:rgba(255,255,255,0.06); font-size:0.7rem; padding:2px 8px; border-radius:12px;">Used ${wf.usage_count}x</span>
      </div>
      <p style="font-size:0.8rem; color:var(--text-dim); margin-bottom:1rem; min-height:40px;">
        ${escapeHtml(wf.description || 'No description provided.')}
      </p>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:0.75rem; color:var(--text-muted);">By ${escapeHtml(wf.author || 'Hardonian')}</span>
        <button class="btn btn-primary btn-sm" onclick="selectWorkflowToRun('${wf.workflow_id}')">Run Workflow</button>
      </div>
    </div>
  `).join('');
}

function selectWorkflowToRun(wfId) {
  switchTab('create');
  document.getElementById('submit-workflow-select').value = wfId;
}

// Fetch GPU Nodes
async function fetchNodes() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/nodes`, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.nodes = data.nodes || [];
      renderNodes();
    }
  } catch (err) {
    console.error('Failed to fetch nodes:', err);
  }
}

function renderNodes() {
  const container = document.getElementById('nodes-container');
  if (!container) return;

  if (state.nodes.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); grid-column:1/-1; text-align:center; padding:3rem;">No GPU worker nodes registered yet. Start the bridge daemon on your GPU server to register.</p>';
    return;
  }

  container.innerHTML = state.nodes.map(n => {
    const isOnline = n.computed_status !== 'offline';
    return `
      <div class="node-card">
        <div class="card-header-flex">
          <div>
            <h3 style="font-size:1rem; font-weight:700; color:#fff;">${escapeHtml(n.name)}</h3>
            <span style="font-size:0.75rem; font-family:var(--font-mono); color:var(--text-dim);">${escapeHtml(n.node_id)}</span>
          </div>
          <span class="badge-status ${n.computed_status}">${n.computed_status}</span>
        </div>
        <div style="margin: 0.85rem 0; font-size: 0.85rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
            <span style="color:var(--text-dim);">GPU:</span>
            <span style="font-weight:600;">${escapeHtml(n.gpu_type || 'Unknown')}</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
            <span style="color:var(--text-dim);">VRAM:</span>
            <span>${n.vram_gb ? n.vram_gb + ' GB' : 'N/A'}</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
            <span style="color:var(--text-dim);">Completed Jobs:</span>
            <span>${n.completed_jobs || 0}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-dim);">Last Heartbeat:</span>
            <span>${formatRelativeTime(n.last_heartbeat)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// API Key Storage
function saveApiKey() {
  const key = document.getElementById('input-api-key').value.trim();
  state.apiKey = key;
  if (key) {
    localStorage.setItem('comfyui_api_key', key);
    showToast('API Key saved', 'success');
  } else {
    localStorage.removeItem('comfyui_api_key');
    showToast('API Key cleared', 'info');
  }
  fetchStats();
  fetchJobs();
}

// Escape HTML helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Sample fallback workflow
function getDefaultWorkflow() {
  return {
    "3": { "class_type": "KSampler", "inputs": { "cfg": 7, "denoise": 1, "latent_image": ["5", 0], "model": ["4", 0], "negative": ["7", 0], "positive": ["6", 0], "sampler_name": "euler", "scheduler": "normal", "seed": 42, "steps": 20 } },
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
    "5": { "class_type": "EmptyLatentImage", "inputs": { "batch_size": 1, "height": 512, "width": 512 } },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": "masterpiece, high quality portrait" }, "_meta": { "title": "Positive Prompt" } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": "blurry, low quality, distorted" }, "_meta": { "title": "Negative Prompt" } },
    "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
    "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] } }
  };
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  // Restore saved API key in UI
  const keyInput = document.getElementById('input-api-key');
  if (keyInput && state.apiKey) {
    keyInput.value = state.apiKey;
  }

  // Initial fetches
  fetchStats();
  fetchJobs();
  fetchWorkflows();
  fetchNodes();

  // Polling loop every 3.5s
  setInterval(() => {
    if (state.autoRefresh) {
      fetchStats();
      if (state.activeTab === 'jobs') fetchJobs();
      if (state.activeTab === 'fleet') fetchNodes();
    }
  }, 3500);

  // Form listener
  document.getElementById('job-form')?.addEventListener('submit', handleJobSubmit);
});
