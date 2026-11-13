from __future__ import annotations

import json
import re
import secrets
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import config

JOB_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.png$")


def new_job() -> tuple[str, Path]:
    root = config.data_dir()
    root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for _ in range(10):
        job_id = f"{stamp}-{secrets.token_hex(2)}"
        directory = root / job_id
        try:
            directory.mkdir(parents=True, exist_ok=False)
            return job_id, directory
        except FileExistsError:
            continue
    raise RuntimeError("无法创建任务目录")


def valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID_RE.match(job_id or ""))


def resolve_job_dir(job_id: str) -> Path:
    if not valid_job_id(job_id):
        raise FileNotFoundError(job_id)
    directory = (config.data_dir() / job_id).resolve()
    root = config.data_dir().resolve()
    if root not in directory.parents or not directory.is_dir():
        raise FileNotFoundError(job_id)
    return directory


def valid_file_name(name: str) -> bool:
    return bool(FILE_RE.match(name or "")) and ".." not in name


def write_meta(job_dir: Path, payload: dict) -> None:
    (job_dir / "meta.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_meta(job_dir: Path) -> dict | None:
    path = job_dir / "meta.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def prune(max_age_hours: int = 24, max_jobs: int = 300) -> None:
    root = config.data_dir()
    if not root.is_dir():
        return
    deadline = time.time() - max_age_hours * 3600
    directories = [path for path in root.iterdir() if path.is_dir() and valid_job_id(path.name)]
    directories.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for index, directory in enumerate(directories):
        try:
            if index >= max_jobs or directory.stat().st_mtime < deadline:
                shutil.rmtree(directory, ignore_errors=True)
        except OSError:
            continue
