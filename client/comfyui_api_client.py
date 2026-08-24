"""
ComfyUI API Client SDK (Sync & Async)
Python SDK for dispatching generation jobs, querying workflows, monitoring fleet status,
and orchestrating batch execution with comfyui-pack-factory.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable, Dict, List, Optional, Union

try:
    import aiohttp
    import requests
except ImportError:
    raise ImportError("Please install dependencies: pip install requests aiohttp")

logger = logging.getLogger("ComfyUIClient")


class ComfyUIAPIError(Exception):
    """Exception raised for API client errors."""

    def __init__(self, message: str, status_code: Optional[int] = None, details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


class ComfyUIClient:
    """Synchronous Client for comfyui-api."""

    def __init__(
        self,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.api_url = (api_url or os.environ.get("COMFYUI_API_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.api_key = api_key or os.environ.get("COMFYUI_API_KEY") or os.environ.get("API_KEY")
        self.timeout = timeout
        self.session = requests.Session()

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "User-Agent": "ComfyUI-Python-SDK/1.0"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["X-API-Key"] = self.api_key
        return headers

    def _request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        url = f"{self.api_url}{endpoint}"
        kwargs.setdefault("headers", self._headers())
        kwargs.setdefault("timeout", self.timeout)
        try:
            resp = self.session.request(method, url, **kwargs)
            try:
                data = resp.json()
            except Exception:
                data = {"raw": resp.text}

            if not resp.ok:
                err_msg = data.get("error") or data.get("message") or f"HTTP {resp.status_code}"
                raise ComfyUIAPIError(err_msg, status_code=resp.status_code, details=data)
            return data
        except requests.RequestException as e:
            raise ComfyUIAPIError(f"Request to {url} failed: {e}")

    # ==================== Health & Stats ====================

    def get_health(self) -> Dict[str, Any]:
        return self._request("GET", "/health")

    def get_stats(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/stats")

    def list_nodes(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/api/v1/nodes").get("nodes", [])

    # ==================== Jobs ====================

    def submit_job(
        self,
        workflow_json: Optional[Union[Dict[str, Any], str]] = None,
        workflow_id: Optional[str] = None,
        workflow_slug: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
        priority: int = 5,
        gpu_required: str = "any",
        client_id: Optional[str] = None,
        webhook_url: Optional[str] = None,
        max_retries: int = 3,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "priority": priority,
            "gpu_required": gpu_required,
            "max_retries": max_retries,
        }
        if workflow_json is not None:
            payload["workflow_json"] = workflow_json
        if workflow_id:
            payload["workflow_id"] = workflow_id
        if workflow_slug:
            payload["workflow_slug"] = workflow_slug
        if params is not None:
            payload["params"] = params
        if client_id:
            payload["client_id"] = client_id
        if webhook_url:
            payload["webhook_url"] = webhook_url

        return self._request("POST", "/api/v1/jobs", json=payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/jobs/{job_id}")

    def get_job_status(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/jobs/{job_id}/status")

    def get_job_logs(self, job_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/api/v1/jobs/{job_id}/logs").get("logs", [])

    def list_jobs(
        self,
        status: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        client_id: Optional[str] = None,
        node_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        params = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status
        if client_id:
            params["client_id"] = client_id
        if node_id:
            params["node_id"] = node_id
        return self._request("GET", "/api/v1/jobs", params=params)

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/jobs/{job_id}/cancel")

    def retry_job(self, job_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/jobs/{job_id}/retry")

    def wait_for_job(
        self,
        job_id: str,
        poll_interval: float = 2.0,
        timeout: float = 300.0,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Polls until job finishes or fails."""
        start_time = time.time()
        last_progress = -1

        while (time.time() - start_time) < timeout:
            status_data = self.get_job_status(job_id)
            current_status = status_data.get("status")
            progress = status_data.get("progress", 0)

            if on_progress and progress != last_progress:
                on_progress(status_data)
                last_progress = progress

            if current_status == "completed":
                return self.get_job(job_id)
            elif current_status in ("failed", "cancelled"):
                raise ComfyUIAPIError(
                    f"Job {job_id} {current_status}: {status_data.get('error', 'No error details provided')}",
                    details=status_data,
                )

            time.sleep(poll_interval)

        raise TimeoutError(f"Job {job_id} did not complete within {timeout}s")

    def generate(
        self,
        workflow: Union[Dict[str, Any], str],
        params: Optional[Dict[str, Any]] = None,
        priority: int = 5,
        timeout: float = 300.0,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Convenience method: submit job and wait for output artifacts."""
        if isinstance(workflow, dict):
            res = self.submit_job(workflow_json=workflow, params=params, priority=priority)
        elif workflow.startswith("wf_"):
            res = self.submit_job(workflow_id=workflow, params=params, priority=priority)
        else:
            res = self.submit_job(workflow_slug=workflow, params=params, priority=priority)

        job_id = res["job_id"]
        return self.wait_for_job(job_id, timeout=timeout, on_progress=on_progress)

    # ==================== Workflows ====================

    def register_workflow(
        self,
        name: str,
        workflow_json: Union[Dict[str, Any], str],
        slug: Optional[str] = None,
        description: Optional[str] = None,
        category: str = "general",
        tags: Optional[str] = None,
        default_params: Optional[Dict[str, Any]] = None,
        version: str = "1.0.0",
        author: str = "Hardonian",
    ) -> Dict[str, Any]:
        payload = {
            "name": name,
            "slug": slug,
            "description": description,
            "category": category,
            "tags": tags,
            "workflow_json": workflow_json,
            "default_params": default_params,
            "version": version,
            "author": author,
        }
        return self._request("POST", "/api/v1/workflows", json=payload)

    def list_workflows(self, category: Optional[str] = None, search: Optional[str] = None) -> List[Dict[str, Any]]:
        params = {}
        if category:
            params["category"] = category
        if search:
            params["search"] = search
        return self._request("GET", "/api/v1/workflows", params=params).get("workflows", [])

    def get_workflow(self, workflow_id_or_slug: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/workflows/{workflow_id_or_slug}")

    def update_workflow(self, workflow_id_or_slug: str, **updates) -> Dict[str, Any]:
        return self._request("PUT", f"/api/v1/workflows/{workflow_id_or_slug}", json=updates)

    def delete_workflow(self, workflow_id_or_slug: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/workflows/{workflow_id_or_slug}")

    def execute_workflow(
        self,
        workflow_id_or_slug: str,
        params: Optional[Dict[str, Any]] = None,
        priority: int = 5,
    ) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/workflows/{workflow_id_or_slug}/execute", json={"params": params, "priority": priority})

    # ==================== Batch ====================

    def submit_batch(
        self,
        items: List[Dict[str, Any]],
        workflow_id: Optional[str] = None,
        workflow_slug: Optional[str] = None,
        workflow_json: Optional[Union[Dict[str, Any], str]] = None,
        common_params: Optional[Dict[str, Any]] = None,
        priority: int = 5,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "items": items,
            "common_params": common_params or {},
            "priority": priority,
        }
        if workflow_id:
            payload["workflow_id"] = workflow_id
        if workflow_slug:
            payload["workflow_slug"] = workflow_slug
        if workflow_json:
            payload["workflow_json"] = workflow_json

        return self._request("POST", "/api/v1/batch/submit", json=payload)


class AsyncComfyUIClient:
    """Asynchronous Client for comfyui-api using aiohttp."""

    def __init__(
        self,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.api_url = (api_url or os.environ.get("COMFYUI_API_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.api_key = api_key or os.environ.get("COMFYUI_API_KEY") or os.environ.get("API_KEY")
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            headers = {"Content-Type": "application/json", "User-Agent": "ComfyUI-Async-Python-SDK/1.0"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
                headers["X-API-Key"] = self.api_key
            self._session = aiohttp.ClientSession(timeout=self.timeout, headers=headers)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def _request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        session = await self._get_session()
        url = f"{self.api_url}{endpoint}"
        try:
            async with session.request(method, url, **kwargs) as resp:
                try:
                    data = await resp.json()
                except Exception:
                    data = {"raw": await resp.text()}

                if resp.status >= 400:
                    err_msg = data.get("error") or data.get("message") or f"HTTP {resp.status}"
                    raise ComfyUIAPIError(err_msg, status_code=resp.status, details=data)
                return data
        except aiohttp.ClientError as e:
            raise ComfyUIAPIError(f"Request to {url} failed: {e}")

    async def get_health(self) -> Dict[str, Any]:
        return await self._request("GET", "/health")

    async def get_stats(self) -> Dict[str, Any]:
        return await self._request("GET", "/api/v1/stats")

    async def submit_job(self, **kwargs) -> Dict[str, Any]:
        return await self._request("POST", "/api/v1/jobs", json=kwargs)

    async def get_job(self, job_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/v1/jobs/{job_id}")

    async def get_job_status(self, job_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/v1/jobs/{job_id}/status")

    async def wait_for_job(
        self,
        job_id: str,
        poll_interval: float = 2.0,
        timeout: float = 300.0,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        start_time = time.time()
        last_progress = -1

        while (time.time() - start_time) < timeout:
            status_data = await self.get_job_status(job_id)
            current_status = status_data.get("status")
            progress = status_data.get("progress", 0)

            if on_progress and progress != last_progress:
                on_progress(status_data)
                last_progress = progress

            if current_status == "completed":
                return await self.get_job(job_id)
            elif current_status in ("failed", "cancelled"):
                raise ComfyUIAPIError(
                    f"Job {job_id} {current_status}: {status_data.get('error', 'No error details provided')}",
                    details=status_data,
                )

            await asyncio.sleep(poll_interval)

        raise TimeoutError(f"Job {job_id} did not complete within {timeout}s")
