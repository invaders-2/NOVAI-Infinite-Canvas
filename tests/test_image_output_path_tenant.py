#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图片产物落盘目录与返回 URL 一致性回归（2026-11）。

跑法（项目 venv）：
    venv/bin/python -m pytest tests/test_image_output_path_tenant.py -q

背景（这组用例守的就是那个 bug）：POST /api/image/upscale 与 POST /api/image/matting 曾经
无条件把结果写进 assets/output/，返回的 URL 却走 output_url_for()（登录后是
/assets/users/{uid}/output/）。登录用户请求自己的图就是 404，画布上表现为「增强到 4K 后图片是坏的」。
这里把落盘函数打桩成「按传进来的 out_path 写一张小 PNG」，于是断言的就是路径本身。
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 必须在 import main 之前：数据根/素材根是导入时定死的
_TMP_DATA = tempfile.mkdtemp(prefix="novai-output-path-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ["NOVAI_ADMIN_USER"] = "admin"
os.environ["NOVAI_ADMIN_PASSWORD"] = "test-pass-123"
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"
os.environ.pop("NOVAI_AUTH_DISABLED", None)

import pytest  # noqa: E402

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from server.auth import ratelimit, service  # noqa: E402

ADMIN_USER = os.environ["NOVAI_ADMIN_USER"]
ADMIN_PASS = os.environ["NOVAI_ADMIN_PASSWORD"]
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def set_auth(enabled: bool) -> None:
    if enabled:
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_DISABLED", None)
        os.environ.pop("NOVAI_AUTH_MODE", None)
    else:
        os.environ.pop("NOVAI_AUTH_ENABLED", None)
        os.environ["NOVAI_AUTH_MODE"] = "off"


@pytest.fixture()
def auth_env():
    """用例自己摆登录模式，用完还原，别把同进程的其它用例带跑偏。"""
    saved = {key: os.environ.get(key) for key in ("NOVAI_AUTH_ENABLED", "NOVAI_AUTH_MODE", "NOVAI_AUTH_DISABLED")}
    yield set_auth
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def fresh_client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 50000), follow_redirects=False)


def seed_source_png() -> str:
    """造一张真源图：路由前置校验只用到「存在 + 大小 + 后缀」。"""
    folder = os.path.join(main.ASSETS_DIR, "input")
    os.makedirs(folder, exist_ok=True)
    name = "path-src-%s.png" % uuid.uuid4().hex[:10]
    with open(os.path.join(folder, name), "wb") as fh:
        fh.write(PNG_1PX)
    return "/assets/input/" + name


def write_png(path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    Image.new("RGB", (8, 8), (200, 30, 30)).save(path, "PNG")


def login_user() -> tuple:
    """照 tests/test_cloud_isolation.py 的租户绑定写法：管理员发邀请码 → 新用户注册并登录。"""
    admin = fresh_client()
    logged = admin.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert logged.status_code == 200, logged.text
    issued = admin.post("/api/admin/invites", json={"uses": 1, "days": 7})
    assert issued.status_code == 200, issued.text
    client = fresh_client()
    registered = client.post("/api/auth/register", json={
        "username": ("pathiso" + uuid.uuid4().hex[:10])[:32],
        "password": "path-iso-pass-123",
        "invite_code": issued.json()["code"],
    })
    assert registered.status_code == 200, registered.text
    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    return client, int(me.json()["id"])


def tenant_output_dir(uid: int) -> str:
    return os.path.abspath(os.path.join(main._assets_root(), "users", str(uid), "output"))


def test_upscale_lands_in_bound_tenant_dir(monkeypatch, auth_env):
    """绑定租户后：URL 是 /assets/users/{uid}/output/ 前缀，且那个文件真的在磁盘上。"""
    auth_env(True)
    ratelimit.reset()
    service.bootstrap_admin()
    client, uid = login_user()
    src_url = seed_source_png()
    written = {}

    monkeypatch.setattr(main, "_upscale_runtime_installed", lambda: True)

    def fake_upscale(src_path, out_path, target_long):
        written["out_path"] = out_path
        write_png(out_path)
        return {"skipped": False, "method": "stub", "width": 8, "height": 8,
                "source_width": 1, "source_height": 1, "elapsed_ms": 0}

    monkeypatch.setattr(main, "run_local_upscale", fake_upscale)

    response = client.post("/api/image/upscale", json={"url": src_url, "target": "4k"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["skipped"] is False
    assert body["url"].startswith("/assets/users/%d/output/" % uid), body["url"]

    on_disk = main.output_file_from_url(body["url"])
    assert on_disk, "返回的 URL 在磁盘上不存在：%s" % body["url"]
    assert os.path.isfile(on_disk)
    # 核心：写盘用的路径 == URL 反解出来的路径（旧 bug 里这两个分叉了）
    assert os.path.abspath(written["out_path"]) == os.path.abspath(on_disk)
    assert os.path.dirname(os.path.abspath(on_disk)) == tenant_output_dir(uid)


def test_matting_local_lands_in_bound_tenant_dir(monkeypatch, auth_env):
    """本地抠图分支（mode=local）同一条规则。"""
    auth_env(True)
    ratelimit.reset()
    service.bootstrap_admin()
    client, uid = login_user()
    src_url = seed_source_png()
    written = {}

    monkeypatch.setattr(main, "_matting_model_downloaded", lambda: True)
    monkeypatch.setattr(main, "_matting_session", lambda: object())

    def fake_matting(src_path, out_path):
        written["out_path"] = out_path
        write_png(out_path)

    monkeypatch.setattr(main, "run_image_matting", fake_matting)

    response = client.post("/api/image/matting", json={"url": src_url, "mode": "local"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"].startswith("/assets/users/%d/output/" % uid), body["url"]

    on_disk = main.output_file_from_url(body["url"])
    assert on_disk, "返回的 URL 在磁盘上不存在：%s" % body["url"]
    assert os.path.abspath(written["out_path"]) == os.path.abspath(on_disk)
    assert os.path.dirname(os.path.abspath(on_disk)) == tenant_output_dir(uid)


def test_matting_api_branch_lands_in_bound_tenant_dir(monkeypatch, auth_env):
    """API 绿幕转透明分支（默认 mode=api）写盘同一条规则。"""
    auth_env(True)
    ratelimit.reset()
    service.bootstrap_admin()
    client, uid = login_user()
    src_url = seed_source_png()
    green_url = seed_source_png()

    async def fake_analyze(raw_url):
        return None

    async def fake_api_matting(raw_url, subject):
        return green_url, "stub-provider"

    monkeypatch.setattr(main, "analyze_image_subject", fake_analyze)
    monkeypatch.setattr(main, "_api_matting", fake_api_matting)
    monkeypatch.setattr(main, "chroma_key_to_transparent", lambda data, orig_path="": PNG_1PX)

    response = client.post("/api/image/matting", json={"url": src_url, "mode": "api"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"].startswith("/assets/users/%d/output/" % uid), body["url"]

    on_disk = main.output_file_from_url(body["url"])
    assert on_disk, "返回的 URL 在磁盘上不存在：%s" % body["url"]
    assert os.path.dirname(os.path.abspath(on_disk)) == tenant_output_dir(uid)


def test_single_user_upscale_keeps_shared_output_dir(monkeypatch, auth_env):
    """反向：没绑租户（单用户模式）必须继续落 assets/output/，URL 保持不变。"""
    auth_env(False)
    ratelimit.reset()
    client = fresh_client()
    src_url = seed_source_png()

    monkeypatch.setattr(main, "_upscale_runtime_installed", lambda: True)

    def fake_upscale(src_path, out_path, target_long):
        write_png(out_path)
        return {"skipped": False, "method": "stub", "width": 8, "height": 8,
                "source_width": 1, "source_height": 1, "elapsed_ms": 0}

    monkeypatch.setattr(main, "run_local_upscale", fake_upscale)

    response = client.post("/api/image/upscale", json={"url": src_url, "target": "4k"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"].startswith("/assets/output/hd_"), body["url"]
    assert "/assets/users/" not in body["url"]

    on_disk = main.output_file_from_url(body["url"])
    assert on_disk, "返回的 URL 在磁盘上不存在：%s" % body["url"]
    assert os.path.dirname(os.path.abspath(on_disk)) == os.path.abspath(main.OUTPUT_OUTPUT_DIR)
