#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力运行的输入解析：把「上一轮产物链接 / 本地产物文件 / 上传的报告文件」读成模型可用的文本。

为什么在 NOVAI 侧解析而不是丢给 OpenClaw 浏览器：
- NOVAI 自己的产物链接是相对路径 /api/agents/runs/<run_id>/files/<name>，xlsx 还是二进制；
  按受控路径读本地文件（store.is_safe_output_path）比让浏览器下载更确定；
- 外部 http(s) 报告链接才走 httpx 抓取；抓不到时如实记录失败原因，让模型再用 browser 抓，
  绝不把抓不到的内容编成「已解析」；
- 上传的 html/xlsx 也走这里，避免把带标签的 HTML 原文直接塞给模型。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

from server.agents import store
from server.agents import tools as agent_tools

REPORT_EXTS = (".html", ".htm", ".xlsx", ".xlsm", ".xls", ".csv", ".json", ".md", ".txt")
# 上传文件里自动当报告解析的扩展名：xlsx/csv 由 prepare_table_sidecars 转 CSV，
# 这里不重复解析，避免给表格类能力多塞一份同样内容。
UPLOAD_REPORT_EXTS = (".html", ".htm", ".json", ".md", ".txt")
_REPORT_KEYS = ("reportUrls", "report_urls", "reportUrl", "report_url", "reportLinks",
                "report_links", "reportLink", "report_link", "report", "reports",
                "reportFiles", "report_files")
_TEXT_SCAN_KEYS = ("message", "goal", "content")
_ARTIFACT_RE = re.compile(r"/api/agents/runs/([A-Za-z0-9_-]+)/files/([^/?#\s]+)")
_SKIP_TAGS = ("script", "style", "noscript", "svg", "template", "nav", "iframe")
_BLOCK_TAGS = ("p", "div", "section", "article", "header", "footer", "main", "ul", "ol",
               "li", "tr", "table", "thead", "tbody", "h1", "h2", "h3", "h4", "h5", "h6",
               "br", "hr", "blockquote", "pre")


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _iter_texts(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            for text in _iter_texts(item):
                yield text
    elif isinstance(value, dict):
        for item in value.values():
            for text in _iter_texts(item):
                yield text


def _looks_like_ref(token: str) -> bool:
    text = str(token or "").strip()
    if not text:
        return False
    if text.startswith(("http://", "https://", "file://", "/api/")):
        return True
    if _ARTIFACT_RE.search(text):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", text):
        return True
    if text.startswith(("/", "./", "../", "~/")):
        return True
    if text.lower().endswith(REPORT_EXTS):
        return True
    return False


def _split_refs(value: Any) -> List[str]:
    out: List[str] = []
    for text in _iter_texts(value):
        for raw in re.split(r"[\s,，;；]+", str(text or "")):
            token = raw.strip().strip('"').strip("'").strip("）)】]")
            if not token or not _looks_like_ref(token):
                continue
            if token not in out:
                out.append(token)
    return out


def artifact_ref_to_path(ref: str) -> Optional[str]:
    match = _ARTIFACT_RE.search(str(ref or ""))
    if not match:
        return None
    return store.is_safe_output_path(match.group(1), unquote(match.group(2)))


def resolve_local_ref(ref: str) -> Optional[str]:
    """把一条输入引用解析成本地真实文件；解析不到（含纯 http(s)）返回 None。"""
    text = unquote(str(ref or "").strip().strip('"').strip("'"))
    if not text:
        return None
    artifact = artifact_ref_to_path(text)
    if artifact:
        return artifact
    parsed = urlparse(text)
    if parsed.scheme in ("http", "https"):
        return None
    if parsed.scheme and len(parsed.scheme) > 1 and not os.path.isabs(text):
        candidate = text
    elif parsed.scheme == "file":
        candidate = parsed.path
    else:
        candidate = parsed.path or text
    if candidate and os.path.isabs(candidate) and os.path.isfile(candidate):
        return candidate
    bases = [os.getcwd(), _project_root(), store.data_dir(),
             os.path.dirname(store.data_dir())]
    for base in bases:
        if not base:
            continue
        probe = os.path.abspath(os.path.join(base, str(candidate).lstrip("/")))
        if os.path.isfile(probe):
            return probe
    return None


def extract_report_refs(params: Dict[str, Any]) -> List[str]:
    """从 params 里收集报告引用：显式 report* 字段 + 正文里的 NOVAI 产物链接。"""
    out: List[str] = []

    def add(value: Any) -> None:
        for token in _split_refs(value):
            if token not in out:
                out.append(token)

    data = params if isinstance(params, dict) else {}
    for key in _REPORT_KEYS:
        if key in data:
            add(data.get(key))
    for key in _TEXT_SCAN_KEYS:
        value = data.get(key)
        if isinstance(value, str):
            for match in _ARTIFACT_RE.finditer(value):
                add(match.group(0))
    for value in data.values():
        for text in _iter_texts(value):
            for match in _ARTIFACT_RE.finditer(text):
                add(match.group(0))
    return out


class _HTMLTextExtractor(HTMLParser):
    """把 HTML 收成可读文本：标题、标题层级、表格单元格、列表项，丢掉脚本与导航。"""

    def __init__(self) -> None:
        HTMLParser.__init__(self, convert_charrefs=True)
        self.parts: List[str] = []
        self.title_parts: List[str] = []
        self.skip = 0
        self.in_title = False

    def _newline(self) -> None:
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in _SKIP_TAGS:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "title":
            self.in_title = True
        elif tag in ("td", "th"):
            self._newline()
        elif tag == "li":
            self._newline()
            self.parts.append("- ")
        elif tag in _BLOCK_TAGS:
            self._newline()

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            if self.skip:
                self.skip -= 1
            return
        if self.skip:
            return
        if tag == "title":
            self.in_title = False
        elif tag in ("td", "th"):
            self.parts.append(" | ")
        elif tag in _BLOCK_TAGS:
            self._newline()

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
            return
        if self.skip:
            return
        text = str(data or "").strip()
        if text:
            self.parts.append(text + " ")

    def text(self, max_chars: int = 18000) -> str:
        title = re.sub(r"[ \t\u00a0]+", " ", "".join(self.title_parts)).strip()
        lines: List[str] = []
        if title:
            lines.append("# %s" % title)
        for line in "".join(self.parts).split("\n"):
            collapsed = re.sub(r"[ \t\u00a0]+", " ", line).strip()
            if collapsed:
                lines.append(collapsed)
        return "\n".join(lines)[:max_chars]


def html_to_text(raw: str, max_chars: int = 18000) -> str:
    parser = _HTMLTextExtractor()
    try:
        parser.feed(str(raw or ""))
        parser.close()
    except Exception:
        return re.sub(r"<[^>]+>", " ", str(raw or ""))[:max_chars]
    return parser.text(max_chars)


def _decode_text(raw: bytes) -> str:
    data = raw if isinstance(raw, bytes) else str(raw or "").encode("utf-8")
    for enc in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _render_sheets(sheets: List[Dict[str, Any]], max_rows: int = 200, max_cols: int = 40,
                   max_chars: int = 18000) -> str:
    chunks: List[str] = []
    for sheet in sheets or []:
        rows = sheet.get("rows") or []
        lines = ["【工作表 %s】（读取 %d 行）" % (sheet.get("name") or "Sheet1", len(rows))]
        shown = 0
        truncated = False
        for row in rows:
            cells = [agent_tools._cell_text(c) for c in (row or [])][:max_cols]
            if not any(cells):
                continue
            lines.append(" | ".join(cells))
            shown += 1
            if shown >= max_rows:
                truncated = len(rows) > shown
                break
        if truncated:
            lines.append("...（超过 %d 行已截断）" % max_rows)
        chunks.append("\n".join(lines))
    return "\n\n".join(chunks)[:max_chars]


def _sheets_from_bytes(raw: bytes):
    handle, path = tempfile.mkstemp(suffix=".xlsx")
    try:
        with os.fdopen(handle, "wb") as f:
            f.write(raw)
        return agent_tools._load_sheets(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _parse_table_bytes(raw: bytes, ext: str, max_chars: int) -> Dict[str, Any]:
    if ext == ".csv":
        text = _decode_text(raw)
        return {"kind": "table", "text": text[:max_chars], "chars": min(len(text), max_chars)}
    sheets = _sheets_from_bytes(raw)
    text = _render_sheets(sheets, max_chars=max_chars)
    return {"kind": "table", "text": text, "chars": len(text)}


def _parse_payload(name: str, raw: bytes, content_type: str,
                   max_chars: int = 18000) -> Dict[str, Any]:
    ext = os.path.splitext(str(name or ""))[1].lower()
    ctype = str(content_type or "").lower()
    if ext in (".xlsx", ".xlsm", ".xls") or "spreadsheet" in ctype or "ms-excel" in ctype:
        return _parse_table_bytes(raw, ext, max_chars)
    text = _decode_text(raw)
    if ext == ".csv" or "text/csv" in ctype:
        return {"kind": "table", "text": text[:max_chars], "chars": min(len(text), max_chars)}
    if ext in (".html", ".htm") or "html" in ctype or "<html" in text[:4000].lower():
        out = html_to_text(text, max_chars)
        return {"kind": "html", "text": out, "chars": len(out)}
    if ext == ".json" or "json" in ctype:
        try:
            pretty = json.dumps(json.loads(text), ensure_ascii=False, indent=1)
        except Exception:
            pretty = text
        return {"kind": "json", "text": pretty[:max_chars], "chars": min(len(pretty), max_chars)}
    return {"kind": "text", "text": text[:max_chars], "chars": min(len(text), max_chars)}


def parse_local_report(path: str, max_chars: int = 18000) -> Dict[str, Any]:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xls", ".csv"):
        sheets = agent_tools._load_sheets(path)
        text = _render_sheets(sheets, max_chars=max_chars) if ext != ".csv" else None
        if text is None:
            with open(path, "rb") as f:
                text = _decode_text(f.read())[:max_chars]
        return {"kind": "table", "text": text, "chars": len(text)}
    with open(path, "rb") as f:
        raw = f.read(32 * 1024 * 1024)
    return _parse_payload(os.path.basename(path), raw, "", max_chars)


async def fetch_external(url: str, max_bytes: int = 12 * 1024 * 1024,
                         timeout: float = 30.0):
    import httpx

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8",
    }
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.content[:max_bytes], response.headers.get("content-type", ""), str(response.url)


async def load_report_ref(ref: str, max_chars: int = 16000) -> Dict[str, Any]:
    item: Dict[str, Any] = {"ref": str(ref or ""), "name": "", "kind": "", "text": "",
                            "chars": 0, "error": "", "via": ""}
    if not item["ref"]:
        item["error"] = "空引用"
        return item
    local = resolve_local_ref(item["ref"])
    if local:
        item["name"] = os.path.basename(local)
        item["via"] = "本地文件"
        try:
            parsed = parse_local_report(local, max_chars=max_chars)
        except Exception as exc:
            item["error"] = "%s: %s" % (type(exc).__name__, exc)
            return item
        item.update({"kind": parsed.get("kind") or "", "text": parsed.get("text") or "",
                     "chars": int(parsed.get("chars") or 0)})
        return item
    parsed_url = urlparse(item["ref"])
    if parsed_url.scheme in ("http", "https") and not artifact_ref_to_path(item["ref"]):
        item["via"] = "HTTP 抓取"
        try:
            raw, ctype, final_url = await fetch_external(item["ref"])
        except Exception as exc:
            item["error"] = "抓取失败：%s: %s" % (type(exc).__name__, exc)
            return item
        item["name"] = os.path.basename(urlparse(final_url).path) or parsed_url.netloc
        try:
            parsed = _parse_payload(item["name"], raw, ctype, max_chars=max_chars)
        except Exception as exc:
            item["error"] = "解析失败：%s: %s" % (type(exc).__name__, exc)
            return item
        item.update({"kind": parsed.get("kind") or "", "text": parsed.get("text") or "",
                     "chars": int(parsed.get("chars") or 0)})
        return item
    item["error"] = "无法定位：既不是本地产物/文件，也不是可抓取的 http(s) 链接"
    return item


async def prepare_report_sources(params: Dict[str, Any], run_id: str = "",
                                 files: Optional[List[Dict[str, Any]]] = None,
                                 max_chars_per_source: int = 16000,
                                 max_total_chars: int = 40000) -> List[Dict[str, Any]]:
    refs = extract_report_refs(params)
    uploads_dir = store.run_uploads_dir(run_id) if run_id else ""
    for item in files or []:
        name = str(item.get("name") or "")
        if os.path.splitext(name)[1].lower() not in UPLOAD_REPORT_EXTS:
            continue
        path = os.path.join(uploads_dir, name) if uploads_dir else ""
        if path and os.path.isfile(path) and path not in refs:
            refs.append(path)
    results: List[Dict[str, Any]] = []
    used = 0
    for ref in refs[:8]:
        item = await load_report_ref(ref, max_chars=max_chars_per_source)
        text = item.get("text") or ""
        if text:
            remain = max_total_chars - used
            if remain <= 0:
                item["text"] = ""
                item["chars"] = 0
                item["error"] = "已纳入的总字数达到上限，本条未纳入"
            else:
                item["text"] = text[:remain]
                item["chars"] = len(item["text"])
                used += item["chars"]
        results.append(item)
    return results


def render_report_block(sources: List[Dict[str, Any]]) -> str:
    items = [s for s in sources or [] if isinstance(s, dict)]
    if not items:
        return ""
    ok = [s for s in items if s.get("text")]
    bad = [s for s in items if not s.get("text")]
    lines = ["## 已解析的报告链接 / 报告文件内容（上一轮产物，直接用这些真实内容做策划）"]
    for index, item in enumerate(ok, 1):
        lines.append("【来源 %d】%s（%s，解析 %d 字）"
                     % (index, item.get("ref"), item.get("kind") or "文本",
                        int(item.get("chars") or 0)))
        lines.append(item.get("text") or "")
        lines.append("")
    for item in bad:
        lines.append("【解析失败】%s：%s（不要凭标题编造这份报告的内容；必要时用 browser 打开该地址重试）"
                     % (item.get("ref"), item.get("error") or "内容为空"))
    return "\n".join(lines)


def has_reference_input(params: Dict[str, Any]) -> bool:
    return bool(extract_report_refs(params))
