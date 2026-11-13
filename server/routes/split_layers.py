#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""split_layers.py —— 智能画布「拆分图层」后端接口（beat 接入）。

- POST /api/canvas/split
- GET  /api/canvas/split/files/{job_id}/{file_name}
- GET  /api/canvas/split/health

引擎在 server/split_engine/（由 split-layers/backend/engine 迁入，heuristic 全程离线），
任务数据写 {NOVAI_DATA_DIR}/split_jobs/<jobId>/；图层 URL 是绝对地址、同源；
不返回 credits（前端不展示积分）。
"""
from __future__ import annotations

import functools
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/canvas", tags=["split-layers"])
logger = logging.getLogger("novai.split")


class SplitSelection(BaseModel):
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0


class SplitRequest(BaseModel):
    image: Optional[str] = None
    mode: Optional[str] = None
    prompt: Optional[str] = None
    selection: Optional[SplitSelection] = None
    maxLayers: Optional[int] = None


@functools.lru_cache(maxsize=1)
def _engine_modules() -> Dict[str, Any]:
    """延迟加载：numpy/scipy/Pillow 缺失时不影响 NOVAI 主服务启动。"""
    from server.split_engine import (
        config,
        errors,
        export,
        heuristic,
        image_io,
        ocr,
        store,
        vision,
    )

    return {
        "config": config,
        "errors": errors,
        "export": export,
        "heuristic": heuristic,
        "image_io": image_io,
        "ocr": ocr,
        "store": store,
        "vision": vision,
    }


@functools.lru_cache(maxsize=1)
def _store_module():
    from server.split_engine import store

    return store


@functools.lru_cache(maxsize=1)
def _health_modules():
    from server.split_engine import config, ocr

    return config, ocr


def _error(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"ok": False, "error": {"code": code, "message": message}},
    )


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _clamp_selection(selection: SplitSelection, width: int, height: int) -> Dict[str, int]:
    x = min(max(0.0, float(selection.x)), width - 1)
    y = min(max(0.0, float(selection.y)), height - 1)
    w = min(max(1.0, float(selection.w)), width - x)
    h = min(max(1.0, float(selection.h)), height - y)
    return {"x": int(round(x)), "y": int(round(y)), "w": int(round(w)), "h": int(round(h))}


def _default_style() -> Dict[str, Any]:
    return {
        "color": "#FFFFFF",
        "strokeColor": None,
        "strokeWidth": 0,
        "fontFamily": "Inter",
        "fontWeight": 400,
        "fontSize": 32,
        "letterSpacing": 0,
        "lineHeight": 1.1,
        "align": "center",
        "opacity": 1,
    }


def _run_engine(
    engine: Dict[str, Any],
    loaded,
    mode: str,
    prompt: str,
    selection: Optional[Dict[str, int]],
    max_layers: int,
) -> tuple:
    config = engine["config"]
    warnings = list(loaded.warnings)
    configured = config.effective_engine()
    if config.engine_mode() == "vision" and not config.vision_ready():
        warnings.append("SPLIT_ENGINE=vision 但未配置 vision 环境变量，已使用启发式引擎")

    if configured == "vision":
        try:
            drafts, vision_warnings, engine_used = engine["vision"].split(
                loaded, mode, prompt, selection, max_layers
            )
            return drafts, warnings + vision_warnings, engine_used
        except Exception as exc:  # noqa: BLE001 - 任何失败都回退启发式
            logger.warning("vision 引擎失败，回退启发式: %s", exc)
            warnings.append("vision 引擎不可用（%s），已回退启发式引擎" % exc)

    drafts, split_warnings, engine_used = engine["heuristic"].split(
        loaded, mode, prompt, selection, max_layers, engine["ocr"].is_available()
    )
    return drafts, warnings + split_warnings, engine_used


def _dedupe(items: List[str]) -> List[str]:
    seen = set()
    result: List[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


@router.get("/split/health")
def split_health():
    try:
        config, ocr = _health_modules()
    except Exception as exc:  # noqa: BLE001
        logger.exception("拆分引擎加载失败")
        return _error("ENGINE_FAILED", "拆分引擎依赖缺失：%s" % exc, 500)
    return {
        "ok": True,
        "engine": config.effective_engine(),
        "tesseract": ocr.is_available(),
        "vision": config.vision_ready(),
    }


@router.post("/split")
def split_layers(payload: SplitRequest, request: Request):
    started = time.perf_counter()
    try:
        engine = _engine_modules()
    except Exception as exc:  # noqa: BLE001
        logger.exception("拆分引擎加载失败")
        return _error("ENGINE_FAILED", "拆分引擎依赖缺失：%s" % exc, 500)

    split_error = engine["errors"].SplitError
    if not payload.image or not payload.image.strip():
        return _error("INVALID_ARGS", "缺少 image 字段（dataURL 或纯 base64）", 400)

    mode = (payload.mode or "auto").strip().lower()
    if mode not in {"auto", "custom"}:
        return _error("INVALID_ARGS", "mode 必须是 auto 或 custom", 400)

    prompt = (payload.prompt or "").strip()
    if len(prompt) > 300:
        prompt = prompt[:300]

    if mode == "custom" and not prompt and payload.selection is None:
        return _error("INVALID_ARGS", "custom 模式需要 prompt 或 selection 至少一个", 400)

    try:
        store = engine["store"]
        store.prune()
        loaded = engine["image_io"].load_image(payload.image)

        selection = None
        if payload.selection is not None:
            if payload.selection.w <= 0 or payload.selection.h <= 0:
                return _error("INVALID_ARGS", "selection 的 w/h 必须大于 0", 400)
            selection = _clamp_selection(payload.selection, loaded.width, loaded.height)

        max_available = 16 if mode == "auto" else 24
        requested = payload.maxLayers
        if requested is not None and (not isinstance(requested, int) or isinstance(requested, bool)):
            return _error("INVALID_ARGS", "maxLayers 必须是整数", 400)
        max_layers = min(max_available, max(2, int(requested or max_available)))

        drafts, warnings, engine_used = _run_engine(
            engine, loaded, mode, prompt, selection, max_layers
        )
        if not drafts:
            return _error("ENGINE_FAILED", "引擎未生成任何图层", 500)

        job_id, job_dir = store.new_job()
        base = _base_url(request)
        files_base = "%s/api/canvas/split/files/%s" % (base, job_id)
        layers: List[Dict[str, Any]] = []
        meta_layers: List[Dict[str, Any]] = []
        for index, draft in enumerate(drafts, start=1):
            layer_id = "L%d" % index
            saved = engine["export"].save_layer(
                job_dir, layer_id, draft.png, draft.bbox, loaded.width, loaded.height
            )
            bbox = engine["export"].clamp_bbox(draft.bbox, loaded.width, loaded.height)
            layer: Dict[str, Any] = {
                "id": layer_id,
                "name": draft.name,
                "type": draft.kind,
                "role": draft.role,
                "z": (index - 1) * 100,
                "bbox": {"x": bbox[0], "y": bbox[1], "w": bbox[2], "h": bbox[3]},
                "png": "%s/%s" % (files_base, saved["png"]),
                "thumb": "%s/%s" % (files_base, saved["thumb"]),
                "visible": True,
            }
            if draft.kind == "text":
                layer["text"] = draft.text or ""
                layer["style"] = draft.style or _default_style()
                layer["confidence"] = (
                    draft.confidence if draft.confidence is not None else 0.8
                )
            layers.append(layer)

            meta_layer = {
                "id": layer_id,
                "name": draft.name,
                "type": draft.kind,
                "role": draft.role,
                "z": layer["z"],
                "bbox": layer["bbox"],
                "pngFile": saved["png"],
                "thumbFile": saved["thumb"],
                "pngBytes": saved["pngBytes"],
                "visible": True,
            }
            if draft.kind == "text":
                meta_layer["text"] = draft.text
                meta_layer["style"] = draft.style
                meta_layer["confidence"] = layer["confidence"]
            meta_layers.append(meta_layer)
    except split_error as exc:
        return _error(exc.code, exc.message, exc.status)
    except Exception as exc:  # noqa: BLE001
        logger.exception("拆分失败")
        return _error("ENGINE_FAILED", "拆分引擎内部错误：%s" % exc, 500)

    duration_ms = int(round((time.perf_counter() - started) * 1000))
    warnings = _dedupe(warnings)

    response = {
        "ok": True,
        "jobId": job_id,
        "mode": mode,
        "engine": engine_used,
        "width": loaded.width,
        "height": loaded.height,
        "durationMs": duration_ms,
        "layers": layers,
        "warnings": warnings,
    }
    try:
        store.write_meta(
            job_dir,
            {
                "ok": True,
                "jobId": job_id,
                "mode": mode,
                "engine": engine_used,
                "width": loaded.width,
                "height": loaded.height,
                "durationMs": duration_ms,
                "layerCount": len(layers),
                "textLayerCount": sum(1 for layer in layers if layer["type"] == "text"),
                "warnings": warnings,
                "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "request": {
                    "mode": mode,
                    "prompt": prompt,
                    "selection": selection,
                    "maxLayers": max_layers,
                },
                "layers": meta_layers,
            },
        )
    except OSError:
        logger.warning("写入任务元信息失败 job=%s", job_id)

    logger.info(
        "split job=%s mode=%s engine=%s layers=%d text=%d duration=%dms",
        job_id,
        mode,
        engine_used,
        len(layers),
        sum(1 for layer in layers if layer["type"] == "text"),
        duration_ms,
    )
    return response


@router.get("/split/files/{job_id}/{file_name}")
def split_layer_file(job_id: str, file_name: str):
    try:
        store = _store_module()
    except Exception as exc:  # noqa: BLE001
        logger.exception("拆分任务存储加载失败")
        return _error("ENGINE_FAILED", "拆分引擎依赖缺失：%s" % exc, 500)

    try:
        directory = store.resolve_job_dir(job_id)
    except FileNotFoundError:
        return _error("NOT_FOUND", "job 不存在或已过期", 404)

    if not store.valid_file_name(file_name):
        return _error("NOT_FOUND", "文件不存在", 404)

    path = (directory / file_name).resolve()
    if path.parent != directory or not path.is_file():
        return _error("NOT_FOUND", "文件不存在", 404)

    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )
