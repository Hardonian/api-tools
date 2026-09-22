"""
Workflow Adapter & Parameter Override Engine for ComfyUI.
Handles deep AST traversal of ComfyUI prompt graphs to inject dynamic parameters,
seeds, prompt variations, latent dimensions, and asset inputs.
"""
from __future__ import annotations

import copy
import logging
import random
from typing import Any, Dict, Optional, Tuple, Union

logger = logging.getLogger("WorkflowAdapter")


def adapt_workflow(
    workflow_graph: Union[Dict[str, Any], list],
    params: Optional[Dict[str, Any]] = None,
    uploaded_image_name: Optional[str] = None,
) -> Tuple[Dict[str, Any], int]:
    """
    Applies user parameters and CLI overrides to a ComfyUI prompt dictionary.
    
    Returns:
        Tuple of (modified_prompt_dict, seed_used)
    """
    if not isinstance(workflow_graph, dict):
        raise ValueError("Workflow must be a ComfyUI prompt format dictionary (node_id -> node_definition).")

    params = params or {}
    prompt_copy = copy.deepcopy(workflow_graph)

    # 1. Determine seed
    seed_override = params.get("seed")
    if seed_override is None:
        seed_used = random.randint(1, 2**32 - 1)
    else:
        try:
            seed_used = int(seed_override)
        except (ValueError, TypeError):
            seed_used = random.randint(1, 2**32 - 1)

    # 2. Extract standard parameters
    positive_prompt = params.get("prompt") or params.get("positive") or params.get("text")
    negative_prompt = params.get("negative") or params.get("negative_prompt")
    steps = params.get("steps")
    cfg = params.get("cfg") or params.get("cfg_scale")
    sampler_name = params.get("sampler_name") or params.get("sampler")
    scheduler = params.get("scheduler")
    width = params.get("width")
    height = params.get("height")
    batch_size = params.get("batch_size")
    denoise = params.get("denoise")
    custom_overrides = params.get("overrides", {})  # Optional direct {"node_id": {"input_key": val}}

    # 3. Iterate through nodes and apply intelligent parameter injection
    for node_id, node in prompt_copy.items():
        if not isinstance(node, dict):
            continue

        inputs = node.setdefault("inputs", {})
        title = str(node.get("_meta", {}).get("title", "")).lower()
        class_type = str(node.get("class_type", ""))

        # Direct explicit node override
        if node_id in custom_overrides and isinstance(custom_overrides[node_id], dict):
            for k, v in custom_overrides[node_id].items():
                inputs[k] = v

        # Seed injection (KSampler, KSamplerAdvanced, Noise, etc.)
        for seed_key in ["seed", "noise_seed", "Seed"]:
            if seed_key in inputs and not isinstance(inputs[seed_key], list):
                inputs[seed_key] = seed_used

        # Sampling steps
        if steps is not None:
            for step_key in ["steps", "step_count"]:
                if step_key in inputs and not isinstance(inputs[step_key], list):
                    try:
                        inputs[step_key] = int(steps)
                    except (ValueError, TypeError):
                        pass

        # CFG Scale
        if cfg is not None:
            if "cfg" in inputs and not isinstance(inputs["cfg"], list):
                try:
                    inputs["cfg"] = float(cfg)
                except (ValueError, TypeError):
                    pass

        # Sampler name & scheduler
        if sampler_name and "sampler_name" in inputs and not isinstance(inputs["sampler_name"], list):
            inputs["sampler_name"] = str(sampler_name)
        if scheduler and "scheduler" in inputs and not isinstance(inputs["scheduler"], list):
            inputs["scheduler"] = str(scheduler)

        # Denoise strength
        if denoise is not None and "denoise" in inputs and not isinstance(inputs["denoise"], list):
            try:
                inputs["denoise"] = float(denoise)
            except (ValueError, TypeError):
                pass

        # Latent dimensions (EmptyLatentImage, EmptySD3LatentImage, FluxResolution, etc.)
        if width is not None and "width" in inputs and not isinstance(inputs["width"], list):
            try:
                inputs["width"] = int(width)
            except (ValueError, TypeError):
                pass
        if height is not None and "height" in inputs and not isinstance(inputs["height"], list):
            try:
                inputs["height"] = int(height)
            except (ValueError, TypeError):
                pass
        if batch_size is not None and "batch_size" in inputs and not isinstance(inputs["batch_size"], list):
            try:
                inputs["batch_size"] = int(batch_size)
            except (ValueError, TypeError):
                pass

        # Text prompt encoding (CLIPTextEncode, CLIPTextEncodeFlux, CR Prompt Text, etc.)
        if class_type in [
            "CLIPTextEncode",
            "CLIPTextEncodeFlux",
            "CR Prompt Text",
            "Textarea",
            "ShowText|pysssss",
            "PromptText",
        ]:
            is_negative_node = any(x in title for x in ["neg", "negative", "bad", "avoid", "unwanted"])
            if is_negative_node and negative_prompt is not None:
                inputs["text"] = str(negative_prompt)
            elif not is_negative_node and positive_prompt is not None:
                inputs["text"] = str(positive_prompt)

        # Uploaded image injection (LoadImage, LoadImageMask)
        if uploaded_image_name and class_type in ["LoadImage", "LoadImageMask", "LoadImageBase64"]:
            if "image" in inputs and not isinstance(inputs["image"], list):
                inputs["image"] = uploaded_image_name

    return prompt_copy, seed_used
