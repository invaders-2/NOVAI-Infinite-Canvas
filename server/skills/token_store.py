#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub 令牌的本地存储：后台可配，不用碰环境变量。

与 main.py 的 _CONFIG_FILE 同一口径：$NOVAI_DATA_DIR/config.json（默认 ~/.NOVAI/config.json）。
只动 "github_token" 这一个键，其它键原样保留；写盘先写临时文件再 os.replace，权限 0600。
令牌只保存在被忽略的本地配置里（.gitignore 里的 /config.json），绝不进源码 / 仓库 / 安装包。

读取优先级：环境变量 NOVAI_GITHUB_TOKEN / GITHUB_TOKEN > config.json 里的 github_token。

另有一份"令牌中转"配置（github_relay / github_relay_token）：配置后客户端完全不碰本地令牌，
由中转服务带着自己的 GITHUB_TOKEN 去访问 GitHub。环境变量 NOVAI_GITHUB_RELAY /
NOVAI_GITHUB_RELAY_TOKEN 优先。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
from typing import Optional

TOKEN_KEY = "github_token"
RELAY_KEY = "github_relay"
RELAY_SECRET_KEY = "github_relay_token"

# 20~255 位令牌字符；前缀（ghp_ / github_pat_ 等）只作提示，不因此拒绝
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,255}$")
_ENV_KEYS = ("NOVAI_GITHUB_TOKEN", "GITHUB_TOKEN")
_RELAY_ENV_KEYS = ("NOVAI_GITHUB_RELAY",)
_RELAY_SECRET_ENV_KEYS = ("NOVAI_GITHUB_RELAY_TOKEN",)
_LOCAL_RELAY_HOSTS = ("127.0.0.1", "localhost")


def config_file():
    """与 main.py 的 _CONFIG_FILE 保持一致：数据目录下的 config.json。"""
    root = os.environ.get("NOVAI_DATA_DIR") or os.path.expanduser("~/.NOVAI")
    return os.path.join(root, "config.json")


def _read_config():
    path = config_file()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_config(data):
    path = config_file()
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    tmp = "%s.tmp" % path
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    try:
        os.chmod(tmp, 0o600)        # 创建即 0600，别让同机其它用户读到令牌
    except OSError:
        pass
    os.replace(tmp, path)
    return path


def saved_token():
    """config.json 里保存的令牌；坏 JSON / 类型不对都当没有。"""
    value = _read_config().get(TOKEN_KEY)
    if not isinstance(value, str):
        return ""
    return value.strip()


def active_token():
    for key in _ENV_KEYS:
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    return saved_token()


def token_source():
    """令牌来自哪里：env（环境变量）/ settings（后台保存）/ ""（没有）。"""
    for key in _ENV_KEYS:
        if str(os.environ.get(key) or "").strip():
            return "env"
    return "settings" if saved_token() else ""


def mask(token):
    """只露前 4 + … + 后 4；太短（<12）只露前 2，避免把令牌基本露完。"""
    text = str(token or "").strip()
    if not text:
        return ""
    if len(text) < 12:
        return text[:2] + "…"
    return text[:4] + "…" + text[-4:]


def validate_token(token):
    """本地校验（不联网）：返回 strip 后的令牌，不合法抛 ValueError。"""
    text = str(token or "").strip()
    if not text:
        raise ValueError("令牌不能为空")
    if any(char.isspace() for char in text):
        raise ValueError("令牌里不能有空格或换行")
    if not _TOKEN_RE.match(text):
        raise ValueError("令牌格式不对：应为 20~255 位字母、数字、下划线或连字符"
                         "（例如 ghp_... 或 github_pat_...）")
    return text


def save_token(token):
    """把令牌写进 config.json 的 github_token，其它键保留；返回 strip 后的令牌。"""
    text = validate_token(token)
    data = _read_config()
    data[TOKEN_KEY] = text
    _write_config(data)
    return text


def clear_token():
    """删掉 settings 里的令牌（其它键保留）；本来就没有返回 False。"""
    data = _read_config()
    if TOKEN_KEY not in data:
        return False
    data.pop(TOKEN_KEY, None)
    _write_config(data)
    return True


def public_state():
    """给界面看的状态：不含明文令牌。"""
    token = active_token()
    return {
        "configured": bool(token),
        "source": token_source(),
        "masked": mask(token) if token else "",
    }


# ---------------------------------------------------------------------------
# 令牌中转（relay）：客户端只存中转地址，令牌只在中转服务上
# ---------------------------------------------------------------------------

def normalize_relay_url(url):
    """校验中转地址：默认必须 https，本地自测允许 http://127.0.0.1 / http://localhost。"""
    text = str(url or "").strip().rstrip("/")
    if not text:
        raise ValueError("中转地址不能为空")
    if len(text) > 512:
        raise ValueError("中转地址最长 512 字符")
    try:
        parsed = urllib.parse.urlparse(text)
    except ValueError:
        raise ValueError("中转地址不合法")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        pass
    elif parsed.scheme == "http" and host in _LOCAL_RELAY_HOSTS:
        pass        # 只在本地自测放行明文 http，公网必须 https
    else:
        raise ValueError("中转地址必须以 https:// 开头（本地自测可用 http://127.0.0.1 或 http://localhost）")
    if parsed.username or parsed.password:
        raise ValueError("中转地址不要带账号密码")
    return text


def _first_env(keys):
    for key in keys:
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    return ""


def saved_relay_url():
    value = _read_config().get(RELAY_KEY)
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        return normalize_relay_url(value)
    except ValueError:
        return ""


def relay_url():
    """生效的中转地址：环境变量优先，其次 config.json；坏值当没配。"""
    from_env = _first_env(_RELAY_ENV_KEYS)
    if from_env:
        try:
            return normalize_relay_url(from_env)
        except ValueError:
            return ""
    return saved_relay_url()


def relay_source():
    """生效的中转地址来自哪里：env / settings / ""。"""
    if _first_env(_RELAY_ENV_KEYS):
        return "env"
    return "settings" if saved_relay_url() else ""


def relay_secret():
    from_env = _first_env(_RELAY_SECRET_ENV_KEYS)
    if from_env:
        return from_env
    value = _read_config().get(RELAY_SECRET_KEY)
    if not isinstance(value, str):
        return ""
    return value.strip()


def save_relay(url, secret=None):
    """保存中转地址；secret 传 None 保留原密钥，传 "" 清掉密钥。"""
    text = normalize_relay_url(url)
    data = _read_config()
    data[RELAY_KEY] = text
    if secret is not None:
        cleaned = str(secret).strip()
        if cleaned and (any(char.isspace() for char in cleaned) or len(cleaned) > 255):
            raise ValueError("中转密钥不合法：不能含空白，最长 255 字符")
        if cleaned:
            data[RELAY_SECRET_KEY] = cleaned
        else:
            data.pop(RELAY_SECRET_KEY, None)
    _write_config(data)
    return relay_state()


def clear_relay():
    """删掉中转地址与密钥（其它键保留）；本来就没有返回 False。"""
    data = _read_config()
    if RELAY_KEY not in data and RELAY_SECRET_KEY not in data:
        return False
    data.pop(RELAY_KEY, None)
    data.pop(RELAY_SECRET_KEY, None)
    _write_config(data)
    return True


def relay_state():
    """给界面看的中转状态：不含明文密钥。"""
    url = relay_url()
    secret = relay_secret()
    return {
        "configured": bool(url),
        "url": url,
        "masked_secret": mask(secret) if secret else "",
    }

