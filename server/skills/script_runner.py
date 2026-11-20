"""技能包脚本：保存完整技能包 + 在技能自己的目录里运行包内脚本。

安全边界（运行前每次都要用户在方案卡上点「执行」，闸门在 main.py 的 run_skill_script 那一段）：
- 只运行技能目录（skills_dir/<skill_id>/）里的文件，路径解析后必须仍在该目录内（拒绝 .. / 绝对路径 / 符号链接逃逸）；
- 只认 .py / .sh / .js / .mjs / .cjs；
- 工作目录 = 技能目录，超时强杀整个进程组，stdout/stderr 截断；
- 环境变量去掉 KEY / TOKEN / SECRET / PASSWORD 一类，避免脚本拿到用户的接口密钥；
- 产物只收输出目录（参数里写 {output_dir} 或读环境变量 NOVAI_SKILL_OUTPUT_DIR）。
纯标准库，不依赖 main.py。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

from server.skills import registry as skills_registry

SCRIPT_EXTS = {".py": "python", ".sh": "bash", ".js": "node", ".mjs": "node", ".cjs": "node"}
MANIFEST_NAME = ".novai-package.json"
MAX_ARGS = 32
MAX_ARG_CHARS = 2000
MAX_OUTPUT_CHARS = 8000
MAX_OUTPUT_FILES = 40
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 600
_SECRET_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|AUTH)", re.I)
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_MISSING_MODULE_RE = re.compile(r"No module named ['\"]([A-Za-z0-9_.\-]+)['\"]")


class ScriptError(Exception):
    def __init__(self, message: str, code: str = "skill_script_failed", status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def package_dir(skill_id: str) -> str:
    sid = str(skill_id or "").strip()
    if not _ID_RE.match(sid):
        raise ScriptError("技能 id 不合法：%s" % (sid or "<空>"), code="invalid_args")
    root = os.path.abspath(skills_registry.skills_dir())
    path = os.path.abspath(os.path.join(root, sid))
    if not path.startswith(root + os.sep):
        raise ScriptError("技能 id 不合法：%s" % sid, code="invalid_args")
    return path


# --- 保存技能包 ---

def save_package(skill_id: str, files: Dict[str, bytes], skill_md_path: str, source: str = "") -> Dict[str, Any]:
    """把 zip 里 SKILL.md 所在目录下的全部文件落到 skills_dir/<skill_id>/（先写临时目录再整体替换）。
    files 已经过 redskill_install._read_bundle 的安全校验（无绝对路径 / .. / 符号链接 / 总量受限）。"""
    target = package_dir(skill_id)
    prefix = skill_md_path.rsplit("/", 1)[0] + "/" if "/" in skill_md_path else ""
    picked: Dict[str, bytes] = {}
    for name, data in files.items():
        if prefix and not name.startswith(prefix):
            continue
        rel = name[len(prefix):]
        if not rel or rel.endswith("/"):
            continue
        parts = rel.split("/")
        if any(p in ("", ".", "..") for p in parts) or rel.startswith("/") or "\\" in rel:
            continue
        if parts[0] == "__MACOSX" or parts[-1] == ".DS_Store" or rel == MANIFEST_NAME:
            continue
        picked[rel] = data
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".pkg-", dir=parent)
    try:
        staging_root = os.path.abspath(staging)
        for rel, data in picked.items():
            dest = os.path.abspath(os.path.join(staging, *rel.split("/")))
            if not dest.startswith(staging_root + os.sep):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(data)
            if os.path.splitext(rel)[1].lower() in (".sh", ".py"):
                try:
                    os.chmod(dest, 0o755)
                except OSError:
                    pass
        scripts = sorted(rel for rel in picked if os.path.splitext(rel)[1].lower() in SCRIPT_EXTS)
        manifest = {"skill_id": skill_id, "source": source, "installed_at": int(time.time()),
                    "files": sorted(picked), "scripts": scripts,
                    "requirements": "requirements.txt" if "requirements.txt" in picked else ""}
        with open(os.path.join(staging, MANIFEST_NAME), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
        if os.path.isdir(target):
            backup = target + ".old-%d" % int(time.time() * 1000)
            os.replace(target, backup)
            os.replace(staging, target)
            shutil.rmtree(backup, ignore_errors=True)
        else:
            os.replace(staging, target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return manifest


def read_manifest(skill_id: str) -> Dict[str, Any]:
    root = package_dir(skill_id)
    if not os.path.isdir(root):
        return {}
    try:
        with open(os.path.join(root, MANIFEST_NAME), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    # 内置技能包（registry 同步过来的目录）没有清单：现扫一遍
    scripts = []
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in SCRIPT_EXTS:
                scripts.append(os.path.relpath(os.path.join(base, name), root).replace(os.sep, "/"))
    return {"skill_id": skill_id, "scripts": scripts,
            "requirements": "requirements.txt" if os.path.isfile(os.path.join(root, "requirements.txt")) else ""}


def scripts_appendix(manifest: Dict[str, Any]) -> str:
    """追加到技能正文末尾，让助手知道包里有哪些脚本、怎么调用。没有脚本时返回空串。"""
    scripts = list(manifest.get("scripts") or [])
    if not scripts:
        return ""
    lines = ["", "", "## 附录：技能包脚本（NOVAI 自动生成）",
             "本技能包带有可执行脚本。需要运行时调用工具 run_skill_script（skill=本技能 id，script=下面的相对路径，"
             "args=命令行参数列表）。每次运行前都会弹确认卡，用户点「执行」后才会在技能目录里运行，超时会被终止。",
             "要产出文件时，把输出路径写成参数里的 {output_dir}（运行时替换成本次的输出目录），"
             "或让脚本写到环境变量 NOVAI_SKILL_OUTPUT_DIR 指向的目录；只有那里的文件会作为结果返回。",
             "脚本列表："]
    lines += ["- %s" % s for s in scripts[:60]]
    if manifest.get("requirements"):
        lines.append("包里有 requirements.txt；缺少依赖时脚本会报错，按报错提示用户安装，不要自行安装。")
    return "\n".join(lines)


# --- 运行脚本 ---

def resolve_script(skill_id: str, script: str) -> str:
    root = package_dir(skill_id)
    if not os.path.isdir(root):
        raise ScriptError("技能「%s」没有保存技能包文件（只有用 .zip 安装或内置的技能包才带脚本）" % skill_id,
                          code="skill_package_missing", status_code=404)
    rel = str(script or "").strip().replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    if not rel or rel.startswith("/") or any(p in ("", ".", "..") for p in rel.split("/")):
        raise ScriptError("脚本路径不合法：%s（要写技能包内的相对路径）" % (script or "<空>"), code="invalid_args")
    ext = os.path.splitext(rel)[1].lower()
    if ext not in SCRIPT_EXTS:
        raise ScriptError("只能运行 .py / .sh / .js 脚本：%s" % rel, code="invalid_args")
    path = os.path.realpath(os.path.join(root, *rel.split("/")))
    if not path.startswith(os.path.realpath(root) + os.sep):
        raise ScriptError("脚本路径越出了技能目录：%s" % rel, code="invalid_args")
    if not os.path.isfile(path):
        listed = "、".join((read_manifest(skill_id).get("scripts") or [])[:8]) or "（无）"
        raise ScriptError("技能包里没有这个脚本：%s；可用脚本：%s" % (rel, listed), code="skill_script_missing",
                          status_code=404)
    return path


def normalize_args(args: Any) -> List[str]:
    if args is None:
        return []
    if isinstance(args, str):
        args = [args] if args.strip() else []
    if not isinstance(args, list):
        raise ScriptError("args 必须是字符串列表", code="invalid_args")
    if len(args) > MAX_ARGS:
        raise ScriptError("参数最多 %d 个" % MAX_ARGS, code="invalid_args")
    out = []
    for item in args:
        if isinstance(item, (dict, list)):
            item = json.dumps(item, ensure_ascii=False)
        text = "" if item is None else str(item)
        if len(text) > MAX_ARG_CHARS:
            raise ScriptError("单个参数最长 %d 字符" % MAX_ARG_CHARS, code="invalid_args")
        if "\x00" in text:
            raise ScriptError("参数里不能有空字符", code="invalid_args")
        out.append(text)
    return out


def _interpreter(kind: str) -> List[str]:
    if kind == "python":
        exe = sys.executable or shutil.which("python3") or shutil.which("python")
        if not exe:
            raise ScriptError("本机没有可用的 Python，无法运行 .py 脚本", code="interpreter_missing", status_code=424)
        return [exe, "-X", "utf8"]
    if kind == "bash":
        exe = shutil.which("bash") or ("/bin/bash" if os.path.exists("/bin/bash") else "")
        if not exe:
            raise ScriptError("本机没有 bash，无法运行 .sh 脚本", code="interpreter_missing", status_code=424)
        return [exe]
    exe = shutil.which("node")
    if not exe:
        raise ScriptError("本机没有安装 Node.js，无法运行 .js 脚本（需要先安装 Node.js）",
                          code="interpreter_missing", status_code=424)
    return [exe]


def _safe_env(output_dir: str, root: str) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not _SECRET_RE.search(k)}
    env["NOVAI_SKILL_OUTPUT_DIR"] = output_dir
    env["NOVAI_SKILL_DIR"] = root
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _clip(text: str) -> str:
    text = text or ""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    half = MAX_OUTPUT_CHARS // 2
    return text[:half] + "\n…（中间省略 %d 字）…\n" % (len(text) - MAX_OUTPUT_CHARS) + text[-half:]


def run_script(skill_id: str, script: str, args: Any, output_dir: str,
               timeout: Optional[int] = None) -> Dict[str, Any]:
    path = resolve_script(skill_id, script)
    root = os.path.realpath(package_dir(skill_id))
    argv = normalize_args(args)
    os.makedirs(output_dir, exist_ok=True)
    argv = [a.replace("{output_dir}", output_dir).replace("{skill_dir}", root) for a in argv]
    kind = SCRIPT_EXTS[os.path.splitext(path)[1].lower()]
    cmd = _interpreter(kind) + [path] + argv
    limit = max(5, min(int(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    started = time.monotonic()
    popen_kw: Dict[str, Any] = {}
    if os.name == "posix":
        popen_kw["start_new_session"] = True
    else:
        popen_kw["creationflags"] = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                     | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    proc = subprocess.Popen(cmd, cwd=root, env=_safe_env(output_dir, root), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_kw)
    timed_out = False
    try:
        out, err = proc.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            proc.kill()
        out, err = proc.communicate()
    stdout = (out or b"").decode("utf-8", "replace")
    stderr = (err or b"").decode("utf-8", "replace")
    produced: List[str] = []
    for base, dirs, names in os.walk(output_dir):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(base, name)
            if os.path.islink(full) or len(produced) >= MAX_OUTPUT_FILES:
                continue
            produced.append(os.path.relpath(full, output_dir).replace(os.sep, "/"))
    missing = sorted(set(m.split(".")[0] for m in _MISSING_MODULE_RE.findall(stderr)))
    return {
        "script": os.path.relpath(path, root).replace(os.sep, "/"),
        "args": argv,
        "exit_code": None if timed_out else proc.returncode,
        "ok": (not timed_out) and proc.returncode == 0,
        "timed_out": timed_out,
        "timeout": limit,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "stdout": _clip(stdout),
        "stderr": _clip(stderr),
        "files": produced,
        "missing_modules": missing,
        "requirements": read_manifest(skill_id).get("requirements") or "",
    }
