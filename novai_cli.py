#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI 只读 CLI：查服务状态、画布、节点与命令表，不改任何数据。

只走 HTTP API，不直接读写 data/ 下的 JSON：直接改盘会绕开画布锁、版本快照/撤销和生成预算闸门。
零第三方依赖；语法保持 Python 3.9（注解只用 Optional/Dict/List）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from server.agents import cli_spec

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_READ_ONLY = 2
EXIT_UNREACHABLE = 3
EXIT_HTTP = 4

DEFAULT_PORT = "3000"
DEFAULT_TIMEOUT = 10.0
TITLE_LIMIT = 40

_NOVAI_ROOT = os.path.dirname(os.path.abspath(__file__))
_VALUE_FLAGS = ("--base-url", "--token", "--timeout")


class CliError(Exception):
    """带退出码的 CLI 错误：上层统一打成中文错误并返回非零。"""

    def __init__(self, message: str, exit_code: int = EXIT_HTTP):
        super().__init__(message)
        self.message = str(message)
        self.exit_code = int(exit_code)


# ---------------------------------------------------------------------------
# 配置：地址 / 口令 / 版本
# ---------------------------------------------------------------------------

def default_base_url(env: Optional[Dict[str, str]] = None) -> str:
    environ = os.environ if env is None else env
    port = str(environ.get("NOVAI_PORT") or DEFAULT_PORT).strip() or DEFAULT_PORT
    return "http://127.0.0.1:%s" % port


def _read_security_token(data_dir: str) -> str:
    # 服务端实际落在 <数据目录>/data/security.json，同时也兼容直接放在数据目录下
    for candidate in (os.path.join(data_dir, "security.json"), os.path.join(data_dir, "data", "security.json")):
        try:
            with open(candidate, "r", encoding="utf-8") as handle:
                token = str((json.load(handle) or {}).get("lan_token", "")).strip()
        except (OSError, ValueError, AttributeError, TypeError):
            continue
        if token:
            return token
    return ""


def resolve_token(cli_token: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                  data_dir: Optional[str] = None) -> str:
    token = str(cli_token or "").strip()
    if token:
        return token
    environ = os.environ if env is None else env
    token = str(environ.get("NOVAI_LAN_TOKEN") or "").strip()
    if token:
        return token
    directory = str(data_dir or environ.get("NOVAI_DATA_DIR") or _NOVAI_ROOT).strip()
    return _read_security_token(os.path.abspath(directory))


def read_version(root: Optional[str] = None) -> str:
    try:
        with open(os.path.join(root or _NOVAI_ROOT, "VERSION"), "r", encoding="utf-8") as handle:
            return handle.read().strip() or "-"
    except OSError:
        return "-"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def unreachable_message(base_url: str, exc: Optional[BaseException] = None) -> str:
    host = urllib.parse.urlsplit(str(base_url or "")).netloc or str(base_url or "服务地址")
    message = "连不上 %s，请先启动 NOVAI（macOS: ./mac-启动服务.sh，或 python3 main.py）" % host
    reason = (getattr(exc, "reason", None) or exc) if exc is not None else None
    if reason:
        message += "；底层原因：%s" % reason
    return message


def _http_error_message(exc: urllib.error.HTTPError) -> str:
    body = ""
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:
        body = ""
    detail = ""
    try:
        payload = json.loads(body) if body else None
        if isinstance(payload, dict):
            detail = str(payload.get("detail") or "").strip()
    except ValueError:
        detail = ""
    if not detail:
        # 网关/代理常回 HTML 或纯文本，正文比状态短语更能说明问题
        detail = body.strip()[:200] or str(getattr(exc, "reason", "") or "").strip()
    if int(exc.code) == 401:
        message = "服务要求局域网访问口令（HTTP 401）：用 --token 或环境变量 NOVAI_LAN_TOKEN 提供"
        return message + ("；%s" % detail if detail else "")
    if detail:
        return "服务返回 HTTP %s：%s" % (exc.code, detail)
    return "服务返回 HTTP %s（%s）" % (exc.code, getattr(exc, "url", "") or "")


def http_get_json(base_url: str, path: str, token: str = "", timeout: float = DEFAULT_TIMEOUT) -> Any:
    """GET 一个 API 并解析 JSON；连不上或非 2xx 一律抛 CliError，绝不静默返回空。"""
    url = str(base_url or default_base_url()).rstrip("/") + str(path)
    headers = {"Accept": "application/json"}
    if token:
        headers["x-novai-token"] = str(token)
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise CliError(_http_error_message(exc), EXIT_HTTP)
    except (urllib.error.URLError, OSError) as exc:
        raise CliError(unreachable_message(base_url, exc), EXIT_UNREACHABLE)
    try:
        return json.loads(raw.decode("utf-8", "replace") or "null")
    except ValueError:
        raise CliError("服务返回的不是 JSON：%s" % url, EXIT_HTTP)


def _api_get(settings: Dict[str, Any], path: str) -> Any:
    return http_get_json(settings["base_url"], path, token=settings["token"], timeout=settings["timeout"])


def _canvas_path(canvas_id: str) -> str:
    return "/api/canvases/%s" % urllib.parse.quote(str(canvas_id or ""), safe="")


# ---------------------------------------------------------------------------
# 纯函数：接口字段 → 给人看的摘要
# ---------------------------------------------------------------------------

def canvas_records(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, dict):
        items = payload.get("canvases")
    elif isinstance(payload, list):
        items = payload
    else:
        items = None
    return [item for item in (items or []) if isinstance(item, dict)]


def unwrap_canvas(payload: Any) -> Dict[str, Any]:
    if isinstance(payload, dict):
        inner = payload.get("canvas")
        if isinstance(inner, dict):
            return inner
        return payload
    return {}


def canvas_title(canvas: Any) -> str:
    if not isinstance(canvas, dict):
        return "未命名画布"
    for key in ("title", "name"):
        value = str(canvas.get(key) or "").strip()
        if value:
            return value
    return "未命名画布"


def truncate(text: Any, limit: int = TITLE_LIMIT) -> str:
    value = "" if text is None else str(text).replace("\r", " ").replace("\n", " ").strip()
    if len(value) <= limit:
        return value
    return value[:limit] + "…"


def node_summary(canvas: Any) -> Dict[str, Any]:
    """画布对象 → 节点总数 + 按类型计数（计数从多到少，便于一眼看结构）。"""
    nodes = canvas.get("nodes") if isinstance(canvas, dict) else None
    nodes = nodes if isinstance(nodes, list) else []
    counts: Dict[str, int] = {}
    total = 0
    for node in nodes:
        if not isinstance(node, dict):
            continue
        total += 1
        kind = str(node.get("type") or "").strip() or "unknown"
        counts[kind] = counts.get(kind, 0) + 1
    ordered = dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))
    return {"node_count": total, "type_counts": ordered}


def node_rows(canvas: Any) -> List[Dict[str, str]]:
    """画布对象 → 逐行节点（id / type / title 截断 40 字），缺字段给占位。"""
    nodes = canvas.get("nodes") if isinstance(canvas, dict) else None
    nodes = nodes if isinstance(nodes, list) else []
    rows: List[Dict[str, str]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        rows.append({
            "id": str(node.get("id") or "-"),
            "type": str(node.get("type") or "unknown"),
            "title": truncate(node.get("title")),
        })
    return rows


def format_timestamp(value: Any) -> str:
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        return "-"
    if stamp <= 0:
        return "-"
    if stamp > 1e12:  # 服务端存毫秒
        stamp = stamp / 1000.0
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stamp))
    except (OverflowError, OSError, ValueError):
        return "-"


def _display_width(text: str) -> int:
    # 中文按两列宽算，表格才对得齐
    return sum(2 if ord(char) > 0x2E7F else 1 for char in str(text))


def _pad(text: str, width: int) -> str:
    value = str(text)
    return value + " " * max(0, width - _display_width(value))


def _render_table(headers: List[str], rows: List[List[str]]) -> str:
    table = [[str(cell) for cell in row] for row in rows]
    widths: List[int] = []
    for index, header in enumerate(headers):
        cells = [row[index] for row in table if index < len(row)]
        widths.append(max([_display_width(header)] + [_display_width(cell) for cell in cells]))
    lines = ["  ".join(_pad(header, widths[index]) for index, header in enumerate(headers)).rstrip()]
    lines.append("  ".join("-" * width for width in widths))
    for row in table:
        lines.append("  ".join(_pad(cell, widths[index]) for index, cell in enumerate(row)).rstrip())
    return "\n".join(lines)


def _print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def _fail(message: str, exit_code: int, json_mode: bool = False) -> int:
    print("错误：%s" % message, file=sys.stderr)
    if json_mode:
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return int(exit_code)


# ---------------------------------------------------------------------------
# 写命令拦截
# ---------------------------------------------------------------------------

def _positional_words(argv: List[str]) -> List[str]:
    words: List[str] = []
    skip_next = False
    for word in argv:
        if skip_next:
            skip_next = False
            continue
        if word in _VALUE_FLAGS:
            skip_next = True
            continue
        if any(word.startswith(flag + "=") for flag in _VALUE_FLAGS):
            continue
        if word.startswith("-"):
            continue
        words.append(word)
    return words


def blocked_write_command(argv: List[str]) -> str:
    """命中写命令时返回它的点号名（如 node.create），否则空串。"""
    words = _positional_words(argv)
    if len(words) < 2:
        return ""
    pair = (words[0], words[1])
    for name, spec in cli_spec.iter_commands():
        if not spec.get("mutates"):
            continue
        if tuple(str(name).split(".", 1)) == pair:
            return name
    return ""


# ---------------------------------------------------------------------------
# 子命令实现
# ---------------------------------------------------------------------------

def _cmd_status(parsed: argparse.Namespace, settings: Dict[str, Any]) -> int:
    version = read_version()
    records = canvas_records(_api_get(settings, "/api/canvases"))
    data = {
        "base_url": settings["base_url"],
        "reachable": True,
        "version": version,
        "canvas_count": len(records),
    }
    if settings["json"]:
        _print_json(data)
        return EXIT_OK
    print("服务地址：%s" % data["base_url"])
    print("可达状态：可达")
    print("画布总数：%d" % data["canvas_count"])
    print("版本号：%s" % data["version"])
    return EXIT_OK


def _cmd_canvas_ls(parsed: argparse.Namespace, settings: Dict[str, Any]) -> int:
    records = canvas_records(_api_get(settings, "/api/canvases"))
    rows = [{
        "id": str(item.get("id") or "-"),
        "title": canvas_title(item),
        "project": str(item.get("project") or "-"),
        "updated_at": item.get("updated_at", 0),
    } for item in records]
    if settings["json"]:
        _print_json({"base_url": settings["base_url"], "count": len(rows), "canvases": rows})
        return EXIT_OK
    if not rows:
        print("服务在 %s 上，但还没有画布。" % settings["base_url"])
        return EXIT_OK
    print(_render_table(
        ["ID", "名称", "项目", "更新时间"],
        [[row["id"], row["title"], row["project"], format_timestamp(row["updated_at"])] for row in rows],
    ))
    print()
    print("共 %d 张画布（%s）" % (len(rows), settings["base_url"]))
    return EXIT_OK


def _cmd_canvas_show(parsed: argparse.Namespace, settings: Dict[str, Any]) -> int:
    canvas_id = str(getattr(parsed, "canvas_id", "") or "").strip()
    canvas = unwrap_canvas(_api_get(settings, _canvas_path(canvas_id)))
    summary = node_summary(canvas)
    data = {
        "id": canvas.get("id") or canvas_id,
        "title": canvas_title(canvas),
        "project": str(canvas.get("project") or ""),
        "updated_at": canvas.get("updated_at", 0),
        "node_count": summary["node_count"],
        "type_counts": summary["type_counts"],
    }
    if settings["json"]:
        _print_json(data)
        return EXIT_OK
    print("画布：%s" % data["title"])
    print("ID：%s" % data["id"])
    if data["project"]:
        print("项目：%s" % data["project"])
    print("节点数：%d" % data["node_count"])
    print("更新时间：%s" % format_timestamp(data["updated_at"]))
    if data["type_counts"]:
        print("按类型：")
        for kind, count in data["type_counts"].items():
            print("  %s  %d" % (kind, count))
    else:
        print("按类型：（空画布，还没有节点）")
    return EXIT_OK


def _cmd_nodes_ls(parsed: argparse.Namespace, settings: Dict[str, Any]) -> int:
    canvas_id = str(getattr(parsed, "canvas_id", "") or "").strip()
    rows = node_rows(unwrap_canvas(_api_get(settings, _canvas_path(canvas_id))))
    if settings["json"]:
        _print_json({"canvas_id": canvas_id, "count": len(rows), "nodes": rows})
        return EXIT_OK
    if not rows:
        print("画布 %s 还没有节点。" % canvas_id)
        return EXIT_OK
    print(_render_table(["节点 ID", "类型", "标题"], [[row["id"], row["type"], row["title"]] for row in rows]))
    print()
    print("共 %d 个节点" % len(rows))
    return EXIT_OK


def _cmd_commands(parsed: argparse.Namespace, settings: Dict[str, Any]) -> int:
    commands = [{
        "name": name,
        "tool": str(spec.get("tool") or ""),
        "mutates": bool(spec.get("mutates")),
        "mutates_canvas": bool(spec.get("mutates_canvas")),
        "summary": str(spec.get("summary") or ""),
    } for name, spec in cli_spec.iter_commands()]
    local = [{"name": name, "summary": str(spec.get("summary") or "")}
             for name, spec in cli_spec.iter_local_commands()]
    write_count = len([item for item in commands if item["mutates"]])
    if settings["json"]:
        _print_json({
            "note": "本期只读，写命令未开放",
            "local_commands": local,
            "commands": commands,
            "total": len(commands),
            "write_count": write_count,
        })
        return EXIT_OK
    print("本地只读命令：")
    print(_render_table(["命令", "说明"], [[item["name"], item["summary"]] for item in local]))
    print()
    print("工具命令表（唯一真相源：server/agents/cli_spec.py）：")
    print(_render_table(
        ["命令", "对应工具", "写操作", "说明"],
        [[item["name"], item["tool"], "是" if item["mutates"] else "否", item["summary"]] for item in commands],
    ))
    print()
    print("共 %d 条命令，其中 %d 条会改数据。" % (len(commands), write_count))
    print("本期只读，写命令未开放（执行写命令直接返回退出码 2）。")
    return EXIT_OK


# ---------------------------------------------------------------------------
# 参数解析与入口
# ---------------------------------------------------------------------------

def _common_options() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", dest="base_url", default=argparse.SUPPRESS,
                        help="服务地址（默认 http://127.0.0.1:<NOVAI_PORT，默认 3000>）")
    common.add_argument("--token", dest="token", default=argparse.SUPPRESS,
                        help="局域网访问口令（默认取 NOVAI_LAN_TOKEN，再取数据目录里的 security.json）")
    common.add_argument("--timeout", dest="timeout", type=float, default=argparse.SUPPRESS,
                        help="单次请求超时秒数（默认 10）")
    common.add_argument("--json", dest="json", action="store_true", default=argparse.SUPPRESS,
                        help="以 JSON 输出（便于脚本消费）")
    return common


def build_parser() -> argparse.ArgumentParser:
    common = _common_options()
    parser = argparse.ArgumentParser(
        prog="novai_cli.py",
        description="NOVAI 只读 CLI：查询服务状态、画布、节点与命令表，不改任何数据。",
        epilog=("示例：\n"
                "  python3 novai_cli.py status\n"
                "  python3 novai_cli.py canvas ls\n"
                "  python3 novai_cli.py canvas show <canvas_id>\n"
                "  python3 novai_cli.py nodes ls <canvas_id> --json"),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[common],
    )
    parser.set_defaults(handler=None)
    subparsers = parser.add_subparsers(dest="command", metavar="<命令>")

    status = subparsers.add_parser("status", parents=[common],
                                   help="服务是否可达 / 画布总数 / 版本号")
    status.set_defaults(handler=_cmd_status)

    canvas = subparsers.add_parser("canvas", parents=[common], help="画布相关（只读）")
    canvas_actions = canvas.add_subparsers(dest="canvas_command", metavar="<动作>")
    canvas_ls = canvas_actions.add_parser("ls", parents=[common], help="列出全部画布")
    canvas_ls.set_defaults(handler=_cmd_canvas_ls)
    canvas_show = canvas_actions.add_parser("show", parents=[common],
                                            help="画布概要（名称、节点数、按类型分组的计数）")
    canvas_show.add_argument("canvas_id", help="画布 ID")
    canvas_show.set_defaults(handler=_cmd_canvas_show)

    nodes = subparsers.add_parser("nodes", parents=[common], help="节点相关（只读）")
    nodes_actions = nodes.add_subparsers(dest="nodes_command", metavar="<动作>")
    nodes_ls = nodes_actions.add_parser("ls", parents=[common], help="逐行列出节点（ID / 类型 / 标题）")
    nodes_ls.add_argument("canvas_id", help="画布 ID")
    nodes_ls.set_defaults(handler=_cmd_nodes_ls)

    commands = subparsers.add_parser("commands", parents=[common],
                                     help="打印命令表（本期只读）")
    commands.set_defaults(handler=_cmd_commands)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    blocked = blocked_write_command(args)
    if blocked:
        message = "命令 %s 是写操作：本期只读，写命令未开放。" % blocked
        if "--json" in args:
            print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        else:
            print(message)
        return EXIT_READ_ONLY

    parser = build_parser()
    parsed = parser.parse_args(args)
    handler = getattr(parsed, "handler", None)
    if handler is None:
        parser.print_help(sys.stderr)
        print("错误：请指定子命令（status / canvas / nodes / commands）。", file=sys.stderr)
        return EXIT_USAGE

    try:
        timeout = float(getattr(parsed, "timeout", DEFAULT_TIMEOUT))
    except (TypeError, ValueError):
        timeout = -1.0
    if timeout <= 0:
        return _fail("--timeout 必须是大于 0 的秒数", EXIT_USAGE, bool(getattr(parsed, "json", False)))

    settings = {
        "base_url": (getattr(parsed, "base_url", None) or default_base_url()).rstrip("/"),
        "token": resolve_token(getattr(parsed, "token", None)),
        "timeout": timeout,
        "json": bool(getattr(parsed, "json", False)),
    }
    try:
        return int(handler(parsed, settings))
    except CliError as exc:
        return _fail(exc.message, exc.exit_code, settings["json"])
    except KeyboardInterrupt:
        return _fail("已中断", EXIT_USAGE, settings["json"])


if __name__ == "__main__":
    sys.exit(main())
