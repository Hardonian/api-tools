"""
Tests for ComfyUI Worker Bridge & Workflow Adapter Engine.
"""
import pytest
from bridge.workflow_adapter import adapt_workflow
from bridge.comfy_worker_daemon import ComfyWorkerDaemon


SAMPLE_COMFY_PROMPT = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "cfg": 8.0,
            "denoise": 1.0,
            "latent_image": ["5", 0],
            "model": ["4", 0],
            "negative": ["7", 0],
            "positive": ["6", 0],
            "sampler_name": "euler_ancestral",
            "scheduler": "normal",
            "seed": 12345,
            "steps": 20,
        },
    },
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "v1-5-pruned.safetensors"},
    },
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"batch_size": 1, "height": 512, "width": 512},
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"clip": ["4", 1], "text": "a cute cat"},
        "_meta": {"title": "Positive Prompt"},
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"clip": ["4", 1], "text": "bad quality"},
        "_meta": {"title": "Negative Prompt"},
    },
    "8": {
        "class_type": "LoadImage",
        "inputs": {"image": "old_input.png"},
    },
}


def test_workflow_adapter_seed_injection():
    params = {"seed": 987654321}
    adapted, seed_used = adapt_workflow(SAMPLE_COMFY_PROMPT, params)

    assert seed_used == 987654321
    assert adapted["3"]["inputs"]["seed"] == 987654321


def test_workflow_adapter_prompt_and_negative():
    params = {
        "prompt": "futuristic neon city, 8k masterpiece",
        "negative": "blurry, out of focus",
        "steps": 30,
        "cfg": 6.5,
        "width": 1024,
        "height": 768,
    }
    adapted, _ = adapt_workflow(SAMPLE_COMFY_PROMPT, params)

    assert adapted["6"]["inputs"]["text"] == "futuristic neon city, 8k masterpiece"
    assert adapted["7"]["inputs"]["text"] == "blurry, out of focus"
    assert adapted["3"]["inputs"]["steps"] == 30
    assert adapted["3"]["inputs"]["cfg"] == 6.5
    assert adapted["5"]["inputs"]["width"] == 1024
    assert adapted["5"]["inputs"]["height"] == 768


def test_workflow_adapter_image_upload_injection():
    adapted, _ = adapt_workflow(SAMPLE_COMFY_PROMPT, params={}, uploaded_image_name="new_uploaded_image.png")
    assert adapted["8"]["inputs"]["image"] == "new_uploaded_image.png"


def test_workflow_adapter_custom_overrides():
    params = {
        "overrides": {
            "4": {"ckpt_name": "flux1-dev.safetensors"},
            "3": {"sampler_name": "dpmpp_2m"},
        }
    }
    adapted, _ = adapt_workflow(SAMPLE_COMFY_PROMPT, params)
    assert adapted["4"]["inputs"]["ckpt_name"] == "flux1-dev.safetensors"
    assert adapted["3"]["inputs"]["sampler_name"] == "dpmpp_2m"


def test_worker_daemon_init_and_gpu_detection():
    daemon = ComfyWorkerDaemon(
        api_url="http://127.0.0.1:8787",
        comfy_url="http://127.0.0.1:8188",
        worker_key="test-key",
        node_id="test-node-01",
    )

    assert daemon.api_url == "http://127.0.0.1:8787"
    assert daemon.node_id == "test-node-01"

    headers = daemon._get_headers()
    assert headers["Authorization"] == "Bearer test-key"
    assert headers["X-API-Key"] == "test-key"

    gpu_info = daemon.detect_gpu_info()
    assert "gpu_type" in gpu_info
    assert "hostname" in gpu_info
