from __future__ import annotations

import json
import os
from pathlib import Path

VERSION = "0.1.0"
SPLIT_JOBS_DIRNAME = "split_jobs"
VISION_CONFIG_FILENAME = "split-vision.json"


def _repo_root() -> Path:
    # server/split_engine/config.py -> server/split_engine -> server -> 仓库根
    return Path(__file__).resolve().parents[2]


def repo_root() -> Path:
    """安装根：源码运行即仓库根，打包后是安装目录（内置模型可能只在这里）。"""
    return _repo_root()


def data_root() -> Path:
    """与 NOVAI 主后端同源：优先 NOVAI_DATA_DIR，源码运行/未注入时落到仓库根。"""
    env_root = (os.environ.get("NOVAI_DATA_DIR") or "").strip()
    if env_root:
        return Path(env_root).expanduser()
    return _repo_root()


def data_dir() -> Path:
    """拆分任务目录：{NOVAI_DATA_DIR}/split_jobs/<jobId>。"""
    return data_root() / SPLIT_JOBS_DIRNAME


def _vision_file_config() -> dict:
    path = data_root() / VISION_CONFIG_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        key: str(raw.get(key) or "").strip()
        for key in ("base_url", "api_key", "model")
    }


def vision_config() -> dict:
    """环境变量优先，缺项回落到 <data_root()>/split-vision.json。"""
    env = {
        "base_url": (os.environ.get("SPLIT_VISION_BASE_URL") or "").strip(),
        "api_key": (os.environ.get("SPLIT_VISION_API_KEY") or "").strip(),
        "model": (os.environ.get("SPLIT_VISION_MODEL") or "").strip(),
    }
    if all(env.values()):
        return env
    stored = _vision_file_config()
    return {
        key: env[key] or stored.get(key, "")
        for key in ("base_url", "api_key", "model")
    }


def vision_ready() -> bool:
    cfg = vision_config()
    return bool(cfg["base_url"] and cfg["api_key"] and cfg["model"])


def engine_mode() -> str:
    mode = (os.environ.get("SPLIT_ENGINE") or "auto").strip().lower()
    return mode if mode in {"auto", "heuristic", "vision"} else "auto"


def effective_engine() -> str:
    mode = engine_mode()
    if mode == "heuristic":
        return "heuristic"
    if mode == "vision":
        return "vision" if vision_ready() else "heuristic"
    return "vision" if vision_ready() else "heuristic"
