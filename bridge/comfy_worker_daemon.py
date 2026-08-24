#!/usr/bin/env python3
"""
ComfyUI Worker Daemon & Execution Bridge
Connects local/remote GPU servers (e.g., Hardonian EPYC lab) to the comfyui-api gateway.
Claims jobs, streams progress in real time via WebSocket, and submits generation outputs.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import signal
import socket
import sys
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import aiohttp
    import requests
    import websockets
except ImportError:
    print("Required packages missing. Please install: pip install aiohttp requests websockets")
    sys.exit(1)

from bridge.workflow_adapter import adapt_workflow

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ComfyWorkerDaemon")


class ComfyWorkerDaemon:
    def __init__(
        self,
        api_url: str,
        comfy_url: str = "http://127.0.0.1:8188",
        worker_key: Optional[str] = None,
        node_id: Optional[str] = None,
        node_name: Optional[str] = None,
        output_dir: str = "outputs",
        poll_interval: float = 3.0,
        heartbeat_interval: float = 30.0,
    ):
        self.api_url = api_url.rstrip("/")
        self.comfy_url = comfy_url.rstrip("/")
        self.worker_key = worker_key or os.environ.get("WORKER_API_KEY") or os.environ.get("API_KEY")
        self.node_id = node_id or f"node_{socket.gethostname().lower()}_{uuid.uuid4().hex[:6]}"
        self.node_name = node_name or f"GPU-Worker-{socket.gethostname()}"
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.poll_interval = poll_interval
        self.heartbeat_interval = heartbeat_interval
        self.running = False
        self.current_job_id: Optional[str] = None
        self.session: Optional[aiohttp.ClientSession] = None

    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "User-Agent": f"ComfyWorker/{self.node_id}"}
        if self.worker_key:
            headers["Authorization"] = f"Bearer {self.worker_key}"
            headers["X-API-Key"] = self.worker_key
        return headers

    def detect_gpu_info(self) -> Dict[str, Any]:
        """Detect GPU hardware metadata."""
        gpu_info = {
            "gpu_type": "CPU/Generic",
            "vram_gb": 0.0,
            "platform": platform.platform(),
            "python": platform.python_version(),
            "hostname": socket.gethostname(),
        }
        try:
            import torch
            if torch.cuda.is_available():
                gpu_info["gpu_type"] = torch.cuda.get_device_name(0)
                gpu_info["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
                gpu_info["device_count"] = torch.cuda.device_count()
        except ImportError:
            pass
        return gpu_info

    async def register_node(self) -> bool:
        """Register worker node with central API gateway."""
        gpu_meta = self.detect_gpu_info()
        payload = {
            "node_id": self.node_id,
            "name": self.node_name,
            "hostname": socket.gethostname(),
            "gpu_type": gpu_meta["gpu_type"],
            "vram_gb": gpu_meta["vram_gb"],
            "max_concurrency": 1,
            "metadata": gpu_meta,
        }
        try:
            async with self.session.post(
                f"{self.api_url}/api/v1/nodes/register",
                json=payload,
                headers=self._get_headers(),
                timeout=10,
            ) as resp:
                if resp.status in (200, 201):
                    logger.info(f"Node successfully registered: {self.node_id} ({gpu_meta['gpu_type']})")
                    return True
                else:
                    err_txt = await resp.text()
                    logger.warning(f"Registration returned status {resp.status}: {err_txt}")
                    return False
        except Exception as e:
            logger.error(f"Failed to register node with API at {self.api_url}: {e}")
            return False

    async def send_heartbeat(self):
        """Periodic heartbeat loop."""
        while self.running:
            try:
                payload = {
                    "node_id": self.node_id,
                    "active_jobs": 1 if self.current_job_id else 0,
                    "status": "busy" if self.current_job_id else "online",
                }
                async with self.session.post(
                    f"{self.api_url}/api/v1/nodes/heartbeat",
                    json=payload,
                    headers=self._get_headers(),
                    timeout=8,
                ) as resp:
                    if resp.status != 200:
                        logger.debug(f"Heartbeat response: {resp.status}")
            except Exception as e:
                logger.debug(f"Heartbeat error: {e}")

            await asyncio.sleep(self.heartbeat_interval)

    async def check_comfyui_health(self) -> bool:
        """Check if local ComfyUI instance is reachable."""
        try:
            async with self.session.get(f"{self.comfy_url}/system_stats", timeout=5) as resp:
                return resp.status == 200
        except Exception:
            return False

    async def claim_job(self) -> Optional[Dict[str, Any]]:
        """Attempt to claim the next available job from the queue."""
        payload = {"node_id": self.node_id, "lease_seconds": 240}
        try:
            async with self.session.post(
                f"{self.api_url}/api/v1/jobs/claim",
                json=payload,
                headers=self._get_headers(),
                timeout=10,
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("job")
                elif resp.status == 401:
                    logger.error("Authentication failed claiming job. Check WORKER_API_KEY.")
        except Exception as e:
            logger.debug(f"Claim request error: {e}")
        return None

    async def report_progress(
        self,
        job_id: str,
        progress: int,
        current_node: Optional[str] = None,
        current_step: int = 0,
        total_steps: int = 0,
        log_message: Optional[str] = None,
    ):
        """Report execution progress back to the API gateway."""
        payload = {
            "node_id": self.node_id,
            "progress": progress,
            "current_node": current_node,
            "current_step": current_step,
            "total_steps": total_steps,
            "log_message": log_message,
            "lease_extend_seconds": 180,
        }
        try:
            async with self.session.post(
                f"{self.api_url}/api/v1/jobs/{job_id}/progress",
                json=payload,
                headers=self._get_headers(),
                timeout=8,
            ) as resp:
                if resp.status != 200:
                    logger.debug(f"Progress update returned {resp.status}")
        except Exception as e:
            logger.debug(f"Failed to report progress: {e}")

    async def report_completion(self, job_id: str, outputs: List[Dict[str, Any]], metrics: Dict[str, Any]):
        """Report successful job completion to the API gateway."""
        payload = {
            "node_id": self.node_id,
            "outputs": outputs,
            "metrics": metrics,
        }
        try:
            async with self.session.post(
                f"{self.api_url}/api/v1/jobs/{job_id}/complete",
                json=payload,
                headers=self._get_headers(),
                timeout=15,
            ) as resp:
                if resp.status == 200:
                    logger.info(f"Job {job_id} successfully marked as completed.")
                else:
                    logger.warning(f"Complete report returned {resp.status}")
        except Exception as e:
            logger.error(f"Failed to report completion for job {job_id}: {e}")

    async def report_failure(self, job_id: str, error_msg: str, traceback_str: Optional[str] = None, can_retry: bool = True):
        """Report job execution failure to the API gateway."""
        payload = {
            "node_id": self.node_id,
            "error": error_msg,
            "traceback": traceback_str,
            "can_retry": can_retry,
        }
        try:
            async with self.session.post(
                f"{self.api_url}/api/v1/jobs/{job_id}/fail",
                json=payload,
                headers=self._get_headers(),
                timeout=15,
            ) as resp:
                logger.info(f"Reported failure for job {job_id}: {error_msg}")
        except Exception as e:
            logger.error(f"Failed to report failure for job {job_id}: {e}")

    async def execute_job(self, job: Dict[str, Any]):
        """Execute a single claimed job on the local ComfyUI instance."""
        job_id = job["job_id"]
        self.current_job_id = job_id
        start_time = time.time()
        logger.info(f"Starting execution of job {job_id} (Workflow: {job.get('workflow_name', 'custom')})")

        try:
            raw_workflow = job.get("workflow")
            if not raw_workflow:
                raise ValueError("Job payload missing workflow definition")

            params = job.get("params") or {}
            adapted_prompt, seed_used = adapt_workflow(raw_workflow, params)

            job_out_dir = self.output_dir / job_id
            job_out_dir.mkdir(parents=True, exist_ok=True)

            client_id = f"worker_{self.node_id}_{uuid.uuid4().hex[:8]}"
            parsed = urllib.parse.urlparse(self.comfy_url)
            ws_protocol = "wss" if parsed.scheme == "https" else "ws"
            ws_url = f"{ws_protocol}://{parsed.netloc}/ws?clientId={client_id}"

            await self.report_progress(job_id, progress=5, log_message=f"Prompt prepared with seed {seed_used}. Connecting to ComfyUI WebSocket...")

            # 1. Connect to ComfyUI WebSocket
            async with websockets.connect(ws_url, max_size=100 * 1024 * 1024) as ws:
                # 2. Submit prompt to ComfyUI REST endpoint
                submit_payload = {"prompt": adapted_prompt, "client_id": client_id}
                async with self.session.post(f"{self.comfy_url}/prompt", json=submit_payload) as resp:
                    if resp.status != 200:
                        err_text = await resp.text()
                        raise RuntimeError(f"ComfyUI prompt submission failed ({resp.status}): {err_text}")
                    submit_resp = await resp.json()
                    prompt_id = submit_resp.get("prompt_id")
                    if not prompt_id:
                        raise RuntimeError(f"ComfyUI response did not return prompt_id: {submit_resp}")

                logger.info(f"Job {job_id} assigned ComfyUI prompt_id: {prompt_id}")
                await self.report_progress(job_id, progress=10, log_message=f"Prompt queued in ComfyUI (ID: {prompt_id})")

                # 3. Stream execution events
                total_nodes = len(adapted_prompt)
                executed_nodes = 0
                max_steps_observed = 0

                while True:
                    msg = await ws.recv()
                    if isinstance(msg, str):
                        event = json.loads(msg)
                        etype = event.get("type")
                        edata = event.get("data", {})

                        if etype == "executing" and edata.get("prompt_id") == prompt_id:
                            node_id = edata.get("node")
                            if node_id is None:
                                logger.info(f"ComfyUI reported execution finished for {job_id}")
                                break
                            else:
                                executed_nodes += 1
                                node_title = adapted_prompt.get(str(node_id), {}).get("_meta", {}).get("title", f"Node {node_id}")
                                calc_prog = min(90, int(15 + (executed_nodes / max(1, total_nodes)) * 75))
                                await self.report_progress(
                                    job_id,
                                    progress=calc_prog,
                                    current_node=node_title,
                                    log_message=f"Executing node: {node_title} ({node_id})",
                                )

                        elif etype == "progress":
                            step_val = edata.get("value", 0)
                            step_max = edata.get("max", 1)
                            max_steps_observed = max(max_steps_observed, step_max)
                            step_prog = int((step_val / max(1, step_max)) * 100)
                            calc_prog = min(88, int(20 + (step_val / max(1, step_max)) * 65))
                            await self.report_progress(
                                job_id,
                                progress=calc_prog,
                                current_step=step_val,
                                total_steps=step_max,
                                log_message=f"Sampler progress: {step_val}/{step_max} ({step_prog}%)",
                            )

                        elif etype == "execution_error" and edata.get("prompt_id") == prompt_id:
                            exc_msg = edata.get("exception_message", "Unknown execution error")
                            exc_trace = edata.get("traceback", "")
                            raise RuntimeError(f"ComfyUI Execution Error: {exc_msg}\n{exc_trace}")

            # 4. Fetch outputs from ComfyUI history
            await self.report_progress(job_id, progress=92, log_message="Execution finished. Fetching generated outputs...")
            async with self.session.get(f"{self.comfy_url}/history/{prompt_id}") as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Failed to fetch history from ComfyUI ({resp.status})")
                history_data = await resp.json()
                outputs_map = history_data.get(prompt_id, {}).get("outputs", {})

            saved_artifacts: List[Dict[str, Any]] = []
            for node_k, node_out in outputs_map.items():
                for media_type in ["images", "gifs", "videos", "audio"]:
                    if media_type in node_out:
                        for item in node_out[media_type]:
                            fname = item.get("filename")
                            if fname:
                                view_params = {
                                    "filename": fname,
                                    "subfolder": item.get("subfolder", ""),
                                    "type": item.get("type", "output"),
                                }
                                async with self.session.get(f"{self.comfy_url}/view", params=view_params) as vresp:
                                    if vresp.status == 200:
                                        file_bytes = await vresp.read()
                                        dest_file = job_out_dir / fname
                                        dest_file.write_bytes(file_bytes)
                                        saved_artifacts.append({
                                            "filename": fname,
                                            "path": str(dest_file.resolve()),
                                            "media_type": media_type,
                                            "size_bytes": len(file_bytes),
                                            "node_id": node_k,
                                        })
                                        logger.info(f"Saved artifact: {dest_file.name} ({len(file_bytes)} bytes)")

            duration = round(time.time() - start_time, 2)
            metrics = {
                "duration_seconds": duration,
                "seed_used": seed_used,
                "node_id": self.node_id,
                "artifacts_count": len(saved_artifacts),
            }

            await self.report_completion(job_id, outputs=saved_artifacts, metrics=metrics)
            logger.info(f"Job {job_id} successfully finalized in {duration}s")

        except Exception as e:
            import traceback
            tb_str = traceback.format_exc()
            logger.error(f"Execution error on job {job_id}: {e}\n{tb_str}")
            await self.report_failure(job_id, error_msg=str(e), traceback_str=tb_str, can_retry=True)
        finally:
            self.current_job_id = None

    async def run(self):
        """Main worker daemon polling and execution loop."""
        self.running = True
        timeout = aiohttp.ClientTimeout(total=60)
        self.session = aiohttp.ClientSession(timeout=timeout)

        logger.info("=" * 60)
        logger.info(f"ComfyUI Worker Daemon starting...")
        logger.info(f"Gateway API:  {self.api_url}")
        logger.info(f"ComfyUI Host: {self.comfy_url}")
        logger.info(f"Node ID:      {self.node_id}")
        logger.info("=" * 60)

        # Initial node registration
        await self.register_node()

        # Start heartbeat task
        heartbeat_task = asyncio.create_task(self.send_heartbeat())

        try:
            while self.running:
                # 1. Verify ComfyUI is up
                is_healthy = await self.check_comfyui_health()
                if not is_healthy:
                    logger.warning(f"Local ComfyUI not reachable at {self.comfy_url}. Waiting...")
                    await asyncio.sleep(5)
                    continue

                # 2. Claim available job
                job = await self.claim_job()
                if job:
                    await self.execute_job(job)
                else:
                    await asyncio.sleep(self.poll_interval)

        except asyncio.CancelledError:
            logger.info("Daemon cancelled.")
        finally:
            self.running = False
            heartbeat_task.cancel()
            await self.session.close()
            logger.info("ComfyUI Worker Daemon stopped.")

    def stop(self):
        """Signal daemon to gracefully stop."""
        logger.info("Stopping daemon gracefully...")
        self.running = False


def main():
    parser = argparse.ArgumentParser(description="ComfyUI Worker Daemon for comfyui-api")
    parser.add_argument("--api-url", type=str, default=os.environ.get("API_URL", "http://127.0.0.1:8787"), help="comfyui-api gateway URL")
    parser.add_argument("--comfy-url", type=str, default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"), help="ComfyUI backend URL")
    parser.add_argument("--worker-key", type=str, default=os.environ.get("WORKER_API_KEY"), help="Worker authentication key")
    parser.add_argument("--node-id", type=str, default=os.environ.get("NODE_ID"), help="Unique node identifier")
    parser.add_argument("--output-dir", type=str, default="outputs", help="Output directory for generated files")
    parser.add_argument("--poll-interval", type=float, default=3.0, help="Polling interval in seconds")
    args = parser.parse_args()

    daemon = ComfyWorkerDaemon(
        api_url=args.api_url,
        comfy_url=args.comfy_url,
        worker_key=args.worker_key,
        node_id=args.node_id,
        output_dir=args.output_dir,
        poll_interval=args.poll_interval,
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def handle_sig(sig, frame):
        daemon.stop()
        loop.stop()

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    try:
        loop.run_until_complete(daemon.run())
    except KeyboardInterrupt:
        daemon.stop()
    finally:
        loop.close()


if __name__ == "__main__":
    main()
