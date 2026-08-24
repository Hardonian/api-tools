"""
Tests for ComfyUI Python Client SDK (Sync & Async).
"""
import pytest
from unittest.mock import MagicMock, patch
from client.comfyui_api_client import ComfyUIClient, AsyncComfyUIClient, ComfyUIAPIError


def test_client_init_and_headers():
    client = ComfyUIClient(api_url="https://api.comfyui.hardonian.com", api_key="sk_test_12345")
    assert client.api_url == "https://api.comfyui.hardonian.com"
    headers = client._headers()
    assert headers["Authorization"] == "Bearer sk_test_12345"
    assert headers["X-API-Key"] == "sk_test_12345"


@patch("requests.Session.request")
def test_client_submit_job(mock_request):
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.status_code = 201
    mock_resp.json.return_value = {
        "job_id": "job_abc123",
        "status": "queued",
        "priority": 7,
        "position": 1,
    }
    mock_request.return_value = mock_resp

    client = ComfyUIClient(api_url="http://127.0.0.1:8787", api_key="sk_test")
    res = client.submit_job(
        workflow_id="wf_portrait",
        params={"prompt": "test prompt", "seed": 42},
        priority=7,
    )

    assert res["job_id"] == "job_abc123"
    assert res["status"] == "queued"
    mock_request.assert_called_once()


@patch("requests.Session.request")
def test_client_wait_for_job_completion(mock_request):
    status_resp = MagicMock()
    status_resp.ok = True
    status_resp.status_code = 200
    status_resp.json.return_value = {"job_id": "job_123", "status": "completed", "progress": 100}

    job_resp = MagicMock()
    job_resp.ok = True
    job_resp.status_code = 200
    job_resp.json.return_value = {
        "job_id": "job_123",
        "status": "completed",
        "outputs": [{"filename": "out.png"}],
    }

    mock_request.side_effect = [status_resp, job_resp]

    client = ComfyUIClient(api_url="http://127.0.0.1:8787")
    res = client.wait_for_job("job_123", poll_interval=0.01)

    assert res["status"] == "completed"
    assert len(res["outputs"]) == 1


@patch("requests.Session.request")
def test_client_error_handling(mock_request):
    mock_resp = MagicMock()
    mock_resp.ok = False
    mock_resp.status_code = 404
    mock_resp.json.return_value = {"error": "Job not found", "status_code": 404}
    mock_request.return_value = mock_resp

    client = ComfyUIClient(api_url="http://127.0.0.1:8787")
    with pytest.raises(ComfyUIAPIError) as exc_info:
        client.get_job("nonexistent_job")

    assert "Job not found" in str(exc_info.value)
    assert exc_info.value.status_code == 404


def test_async_client_lifecycle():
    import asyncio

    async def _test():
        client = AsyncComfyUIClient(api_url="http://127.0.0.1:8787", api_key="sk_async_key")
        assert client.api_url == "http://127.0.0.1:8787"
        await client.close()

    asyncio.run(_test())
