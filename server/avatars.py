#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用户头像（M7）：2MB 内的 png/jpg/webp，落 DATA_DIR/avatars/{id}.{ext}。

users.avatar 只存相对文件名（如 "3.png"），空串表示没有头像。
服务端按文件 magic 判断真实格式，content-type 只做辅助校验。
"""
from __future__ import annotations

import os
import time
from typing import Optional, Tuple

from server.auth import store as auth_store
from server.auth.errors import AuthError

MAX_BYTES = 2 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "application/octet-stream", "",
}
MIME_BY_EXT = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


def avatar_dir() -> str:
    return os.path.join(auth_store.data_dir(), "avatars")


def sniff_extension(content: bytes) -> Optional[str]:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return None


def _user_id(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise AuthError("用户 ID 不合法", 400, "invalid_user_id")


def save_bytes(user_id, content: bytes, content_type: str = "") -> str:
    uid = _user_id(user_id)
    if not content:
        raise AuthError("头像内容为空", 400, "invalid_avatar")
    if len(content) > MAX_BYTES:
        raise AuthError("头像不能超过 2MB", 413, "avatar_too_large")
    ct = str(content_type or "").split(";", 1)[0].strip().lower()
    if ct not in ALLOWED_CONTENT_TYPES:
        raise AuthError("头像只支持 png / jpg / webp", 415, "invalid_avatar_type")
    ext = sniff_extension(content)
    if not ext:
        raise AuthError("头像只支持 png / jpg / webp", 415, "invalid_avatar_type")

    folder = avatar_dir()
    os.makedirs(folder, exist_ok=True)
    for old_ext in MIME_BY_EXT:
        old_path = os.path.join(folder, "%d.%s" % (uid, old_ext))
        if old_ext != ext and os.path.isfile(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass
    target = os.path.join(folder, "%d.%s" % (uid, ext))
    temp = target + ".tmp"
    with open(temp, "wb") as fh:
        fh.write(content)
    os.replace(temp, target)
    auth_store.set_user_avatar(uid, os.path.basename(target))
    return url_for(uid)


def delete(user_id) -> None:
    uid = _user_id(user_id)
    folder = avatar_dir()
    for ext in MIME_BY_EXT:
        path = os.path.join(folder, "%d.%s" % (uid, ext))
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
    auth_store.set_user_avatar(uid, "")


def file_for(user_id) -> Optional[str]:
    uid = _user_id(user_id)
    folder = avatar_dir()
    stored = ""
    user = auth_store.get_user_by_id(uid)
    if user:
        stored = str(user.get("avatar") or "")
    if stored and os.path.basename(stored) == stored:
        path = os.path.join(folder, stored)
        if os.path.isfile(path):
            return path
    for ext in MIME_BY_EXT:
        path = os.path.join(folder, "%d.%s" % (uid, ext))
        if os.path.isfile(path):
            return path
    return None


def url_for(user_id) -> str:
    path = file_for(user_id)
    if not path:
        return ""
    try:
        version = int(os.path.getmtime(path) * 1000)
    except OSError:
        version = int(time.time() * 1000)
    return "/api/auth/avatar/%d?v=%d" % (_user_id(user_id), version)


def etag_for(path: str) -> str:
    stat = os.stat(path)
    return '"%s-%d-%d"' % (os.path.basename(path), int(stat.st_mtime_ns), int(stat.st_size))


def mime_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return MIME_BY_EXT.get(ext, "application/octet-stream")
