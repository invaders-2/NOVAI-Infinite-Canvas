#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力（智能体/技能）运行的 OpenClaw 后端。

与 server/routes/agents.py 的分工：
- 路由层只负责「创建 run 记录 / 保存上传 / 推送 SSE」；
- 本模块负责「把能力定义与输入转成给 OpenClaw 会话的指令 → 发送 → 把 OpenClaw 的
  真实工具事件映射成既有 SSE 事件（run_start/step_start/step_result/message/done/error）
  → 收集产物」。

复用 server/integrations/openclaw.py 的 OpenClawGatewayClient / OpenClawSettings，
不另造 WS 客户端。Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。

实测契约（OpenClaw 2026.6.9，见汇报）：
- 本会话工具：read/write/edit/apply_patch/exec/process/web_fetch/browser/pdf 等；
  没有 read_table / write_html_report / write_xlsx，表格要先转成 CSV 文本再读；
- 文件进出：agent 的 sandbox.mode=off，read/exec/write 都接受绝对路径，
  所以上传文件按绝对路径喂进去、产物直接写到 data/agent_outputs/<run_id>/；
- 工具事件：event=agent, stream=tool, phase=start|update|result（详见 openclaw.py）。
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import time
from typing import Any, Callable, Dict, List, Optional

from server.agents import store
from server.agents import tools as agent_tools
from server.integrations import input_sources
from server.integrations import video_sources
from server.integrations.openclaw import (
    OpenClawError,
    OpenClawGatewayClient,
    OpenClawIdleTimeoutError,
    OpenClawSettings,
    bridge_run_media,
)

_TEXT_EXTS = (".csv", ".xlsx", ".xlsm")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_SKIP_ARTIFACT_DIRS = ("uploads",)
_MISSING_PARAM_KEYS = ("provider", "model", "ms_model", "max_steps", "url", "urls")
# 图片参数里可能带 ratio/size；这些不作为“用户填写参数”整段回灌
_IMAGE_SIZE_KEYS = ("size", "ratio", "image_size", "image_model", "image_provider")


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip()


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _capability_idle_timeout() -> float:
    """能力运行专用空闲超时（默认 420s）；chat 路径仍是 NOVAI_OPENCLAW_IDLE_TIMEOUT(180s)。"""
    return _env_float("NOVAI_OPENCLAW_CAPABILITY_IDLE_TIMEOUT", 420.0)


def _idle_retry_budget() -> int:
    """空闲超时自动重连重试次数：NOVAI_OPENCLAW_IDLE_RETRY，默认 1，设 0 关闭。"""
    raw = _env("NOVAI_OPENCLAW_IDLE_RETRY")
    if not raw:
        return 1
    try:
        return max(0, int(float(raw)))
    except ValueError:
        return 1


def _has_generated_image_artifacts(run_id: str,
                                   generated_images: Optional[List[Dict[str, Any]]]) -> bool:
    """产物目录顶层是否已有图片产物（重试守卫：避免重复调用上游生图重复计费）。"""
    if generated_images:
        return True
    output_dir = store.run_output_dir(run_id)
    try:
        names = os.listdir(output_dir)
    except OSError:
        return False
    for name in names:
        path = os.path.join(output_dir, name)
        if os.path.isfile(path) and os.path.splitext(name)[1].lower() in _IMAGE_EXTS:
            return True
    return False


def bridge_input_images(run_id: str, files: List[Dict[str, Any]],
                        video_sources_data: Optional[Dict[str, Any]] = None
                        ) -> Dict[str, Any]:
    """把模型需要看的本地图片（视频关键帧 + 上传图片）复制到 OpenClaw 允许根。

    只在 OpenClaw 后端启用；local 后端直接返回空映射（不复制、不改指令里的路径）。
    """
    media: Dict[str, Any] = {"root": "", "mapped": {}, "failed": [], "failed_paths": []}
    if backend_name() != "openclaw":
        return media
    output_dir = store.run_output_dir(run_id)
    frame_paths: List[str] = []
    for entry in (video_sources_data or {}).get("files") or []:
        for frame in entry.get("frames") or []:
            frame_paths.append(str(frame.get("path") or ""))
    paths = [str(item.get("path") or "") for item in _uploaded_images(run_id, files)]
    paths.extend(frame_paths)
    paths = [path for path in paths if path]
    if not paths:
        return media
    result = bridge_run_media(run_id, paths, base_dir=output_dir)
    media["root"] = str(result.get("root") or "")
    media["mapped"] = dict(result.get("mapped") or {})
    media["failed"] = list(result.get("failed") or [])
    media["failed_paths"] = [str(item.get("path")) for item in media["failed"] if item.get("path")]
    failed_frames = [path for path in media["failed_paths"] if path in frame_paths]
    if failed_frames and isinstance(video_sources_data, dict):
        notes = video_sources_data.setdefault("notes", [])
        notes.append("下列关键帧没能复制到 OpenClaw 允许目录，仍用原路径，读取可能被拒绝：%s"
                     % "、".join(failed_frames))
    return media


def backend_name() -> str:
    """NOVAI_CAPABILITY_BACKEND=openclaw|local，默认 openclaw；local 才走原 NOVAI 循环。"""
    value = _env("NOVAI_CAPABILITY_BACKEND", "openclaw").lower()
    return value if value in ("openclaw", "local") else "openclaw"


def capability_settings() -> Any:
    """能力运行专用网关配置：不设 NOVAI_CAPABILITY_OPENCLAW_* 时与普通聊天共用同一网关。"""
    settings = OpenClawSettings()
    ws_url = _env("NOVAI_CAPABILITY_OPENCLAW_WS_URL")
    if ws_url:
        settings.ws_url = ws_url
    token = _env("NOVAI_CAPABILITY_OPENCLAW_TOKEN")
    if token:
        settings.token = token
    token_file = _env("NOVAI_CAPABILITY_OPENCLAW_TOKEN_FILE")
    if token_file:
        settings.token_file = token_file
    config_path = _env("NOVAI_CAPABILITY_OPENCLAW_CONFIG")
    if config_path:
        settings.config_path = config_path
        if not token:
            # 独立网关通常有自己的 token：让 config_path 里的 gateway.auth.token 生效
            settings.token = ""
    agent_id = _env("NOVAI_CAPABILITY_OPENCLAW_AGENT")
    if agent_id:
        settings.agent_id = agent_id
    model = _env("NOVAI_CAPABILITY_OPENCLAW_MODEL") or settings.model
    return settings, model


def extract_urls(params: Dict[str, Any]) -> List[str]:
    """从 params 里收集用户给的网址（url / urls / message 里单独成词的 http(s) 链接）。"""
    import re

    out: List[str] = []
    for key in ("url", "urls", "url_list", "link"):
        value = (params or {}).get(key)
        items = value if isinstance(value, list) else [value]
        for item in items:
            text = str(item or "").strip()
            if text and text not in out:
                out.append(text)
    for key in ("message", "goal", "content"):
        value = (params or {}).get(key)
        if not isinstance(value, str):
            continue
        for match in re.findall(r"https?://[^\s，。；、）)]+", value):
            if match not in out:
                out.append(match)
    return out


def prepare_table_sidecars(run_id: str, files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把上传的 xlsx/csv 转成同目录 CSV 文本，供 OpenClaw 的 read 工具直接读取。

    OpenClaw 的 read 工具实测读不了 xlsx（二进制）；exec+openpyxl 可以，但依赖模型
    自己写对 python。这里由 NOVAI 先转好 CSV，保证数据一定能进到会话里。
    代价：多存一份纯文本、公式/样式/合并单元格丢失，多工作表拆成多个文件。
    """
    uploads_dir = store.run_uploads_dir(run_id)
    sidecars: List[Dict[str, Any]] = []
    for item in files or []:
        name = str(item.get("name") or "")
        source = os.path.join(uploads_dir, name)
        if not name or not os.path.isfile(source):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in _TEXT_EXTS:
            continue
        try:
            sheets = agent_tools._load_sheets(source)
        except Exception as exc:  # 转不了就把原始路径给模型，如实记录
            sidecars.append({"source": name, "sheet": "", "path": source,
                             "error": "%s: %s" % (type(exc).__name__, exc)})
            continue
        stem = os.path.splitext(name)[0]
        for sheet in sheets:
            rows = sheet.get("rows") or []
            sheet_name = str(sheet.get("name") or "Sheet1")
            target_name = store.safe_filename("%s.%s.csv" % (stem, sheet_name))
            target = os.path.join(uploads_dir, target_name)
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            for row in rows:
                writer.writerow([agent_tools._cell_text(cell) for cell in row])
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(buffer.getvalue())
            sidecars.append({"source": name, "sheet": sheet_name, "path": target,
                             "rows": len(rows), "error": ""})
    return sidecars


def _is_image_name(name: str) -> bool:
    return os.path.splitext(str(name or ""))[1].lower() in _IMAGE_EXTS


def _is_video_name(name: str) -> bool:
    return os.path.splitext(str(name or ""))[1].lower() in video_sources.VIDEO_EXTS


def _uploaded_images(run_id: str, files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """本次上传里真实存在的图片文件（绝对路径 + 字段 name）。"""
    uploads_dir = store.run_uploads_dir(run_id)
    out: List[Dict[str, Any]] = []
    for item in files or []:
        name = str(item.get("name") or "")
        if not name or not _is_image_name(name):
            continue
        path = os.path.join(uploads_dir, name)
        if os.path.isfile(path):
            out.append({"name": name, "path": path, "size": item.get("size")})
    return out


def _wants_generated_image(cap: Dict[str, Any], params: Dict[str, Any]) -> bool:
    """要不要由 NOVAI 侧先生成图片：交付物含 image，或用户显式给了 image_prompt。"""
    if (params or {}).get("generate_image") is False:
        return False
    if str((params or {}).get("image_prompt") or "").strip():
        return True
    for item in cap.get("deliverables") or []:
        if isinstance(item, dict) and str(item.get("kind") or "").lower() == "image":
            return True
    return False


def _image_count(params: Dict[str, Any]) -> int:
    """单次能力运行默认只生成 1 张（生图真实计费）；可用 params.image_count 调高，上限 4。"""
    try:
        value = int((params or {}).get("image_count") or 1)
    except (TypeError, ValueError):
        value = 1
    return max(1, min(value, 4))


def _image_prompt_text(cap: Dict[str, Any], params: Dict[str, Any]) -> str:
    explicit = str((params or {}).get("image_prompt") or "").strip()
    if explicit:
        return explicit
    name = str(cap.get("name") or "").strip()
    desc = str(cap.get("description") or "").strip()
    subject = ""
    for key in ("productDescription", "productSellPoint", "productDesc", "product",
                "category", "goal", "subject"):
        value = (params or {}).get(key)
        if isinstance(value, str) and value.strip():
            subject = value.strip()
            break
    parts = ["为「%s」生成电商商品主图" % name if name else "生成电商商品主图"]
    if subject:
        parts.append("商品与核心卖点：%s" % subject)
    if desc and desc != subject:
        parts.append("目标：%s" % desc)
    parts.append("主体清晰、构图干净、符合电商主图规范，画面不要出现文字或水印")
    return "。".join(parts)


async def _image_phase(run_id: str, cap: Dict[str, Any], files: List[Dict[str, Any]],
                       params: Dict[str, Any], emit: Callable[[str, Dict[str, Any]], None],
                       start_index: int = 0):
    """NOVAI 侧执行生图：复用 main.py 的 capability_generate_image（既有生图链路）。

    实测（OpenClaw 2026.6.9 + 本机网关）：tools.invoke 确实能调到 OpenClaw 自带的
    image_generate（image_generate action=list 返回 google/gemini-3.1-flash-image-preview 已配置）。
    但它用的是 OpenClaw 自己的 providers/密钥（agents.defaults.imageGenerationModel 那一套），
    与「复用 NOVAI 生图链路 / data/api_providers.json 的 image_models」相冲突，也无法把 NOVAI
    的 provider 配置透给 OpenClaw。所以这里选「NOVAI 侧执行生图、再把产物路径喂回会话」：
    provider/model/尺寸全部走 NOVAI 配置，产物直接落 run 产物目录并登记为受控产物。
    失败一律抛出并让本次 run 明确失败，不静默降级。
    """
    if not _wants_generated_image(cap, params):
        return [], start_index
    from server.routes.deps import deps as deps_container
    generator = deps_container.get("AGENT_IMAGE_GENERATE")
    if generator is None:
        raise OpenClawError("生图执行器未接入：服务端未注册 AGENT_IMAGE_GENERATE")
    images = _uploaded_images(run_id, files)
    output_dir = store.run_output_dir(run_id)
    os.makedirs(output_dir, exist_ok=True)
    prompt = _image_prompt_text(cap, params)
    refs = [item["path"] for item in images[:6]]
    size = str((params or {}).get("size") or "").strip()
    ratio = str((params or {}).get("ratio") or "").strip()
    provider = str((params or {}).get("image_provider") or "").strip()
    model = str((params or {}).get("image_model") or "").strip()
    count = _image_count(params)
    generated: List[Dict[str, Any]] = []
    index = start_index
    for seq in range(count):
        cap_name = str(cap.get("name") or cap.get("id") or "")
        args = {"prompt": prompt, "size": size, "ratio": ratio, "reference_images": refs,
                "provider": provider, "model": model, "count": 1}
        description = "NOVAI 生图链路生成图片（%s，第 %d/%d 张，参考图 %d 张）" % (
            cap_name, seq + 1, count, len(refs))
        try:
            result = await generator({
                "run_id": run_id,
                "output_dir": output_dir,
                "prompt": prompt,
                "size": size,
                "ratio": ratio,
                "provider": provider,
                "model": model,
                "reference_images": refs,
                "count": 1,
                "name_prefix": cap_name or "能力生图",
            })
        except Exception as exc:
            text = "%s: %s" % (type(exc).__name__, exc)
            _emit_step(emit, run_id, index, "image_generate", args, description, False, text)
            raise OpenClawError("能力生图失败：%s" % text)
        for item in (result or {}).get("images") or []:
            if isinstance(item, dict) and item.get("name"):
                generated.append({
                    "name": item.get("name"),
                    "path": os.path.join(output_dir, str(item.get("name"))),
                    "url": item.get("url") or "",
                    "bytes": item.get("bytes") or 0,
                })
        text = "生成 %d 张；platform=%s model=%s size=%s" % (
            result.get("count") or 0, result.get("provider") or "", result.get("model") or "",
            result.get("size") or "")
        _emit_step(emit, run_id, index, "image_generate", args, description, True, text)
        index += 1
    return generated, index


def _files_block(run_id: str, files: List[Dict[str, Any]],
                 sidecars: List[Dict[str, Any]],
                 media: Optional[Dict[str, Any]] = None) -> str:
    if not files:
        return "本次没有上传文件。"
    uploads_dir = store.run_uploads_dir(run_id)
    mapped = (media or {}).get("mapped") or {}
    failed = set((media or {}).get("failed_paths") or [])
    images = [f for f in files if _is_image_name(f.get("name"))]
    videos = [f for f in files if _is_video_name(f.get("name"))]
    tables = [f for f in files if f not in images and f not in videos]
    lines = []
    if videos:
        lines.append("本次上传的视频文件已由 NOVAI 解析（元数据 / 关键帧 / 口播转写见后面「已解析的视频输入」块），"
                     "不要用 read 工具直接读视频二进制。")
    if images:
        lines.append("本次上传的图片（绝对路径，可作为参考图；用 read 工具直接读取图片查看；"
                     "不要用 image 工具，它依赖 OpenClaw 图像描述模型，本机未配置时会每次超时 60 秒；"
                     "路径以本块列出的为准，禁止编造）：")
        for item in images:
            path = os.path.join(uploads_dir, str(item.get("name") or ""))
            shown = mapped.get(path, path)
            lines.append("- %s（%s 字节，字段 name=%s）" % (shown, item.get("size"), item.get("name")))
        upload_failures = sorted(p for p in failed if p.startswith(uploads_dir + os.sep))
        if upload_failures:
            lines.append("- 注意：下列输入图片没能复制到 OpenClaw 允许目录，仍用原路径，读取可能被拒绝：%s"
                         % "、".join(upload_failures))
    if tables:
        lines.append("本次上传的表格/其它文件（绝对路径）：")
        for item in tables:
            path = os.path.join(uploads_dir, str(item.get("name") or ""))
            lines.append("- %s（%s 字节，字段 name=%s）" % (path, item.get("size"), item.get("name")))
    readable = [s for s in sidecars if not s.get("error")]
    if readable:
        lines.append("已由 NOVAI 转好的表格文本（CSV，直接用 read 工具读这些路径）：")
        for item in readable:
            lines.append("- %s（来源 %s，工作表 %s，%s 行）"
                         % (item["path"], item["source"], item["sheet"], item.get("rows")))
    failed = [s for s in sidecars if s.get("error")]
    for item in failed:
        lines.append("- 注意：%s 无法转成 CSV（%s），请用 exec + /usr/bin/python3 读取。"
                     % (item["source"], item["error"]))
    return "\n".join(lines)


def _params_block(params: Dict[str, Any]) -> str:
    clean = {}
    for key, value in (params or {}).items():
        if key in _MISSING_PARAM_KEYS:
            continue
        if value in ("", None, [], {}):
            continue
        clean[key] = value
    if not clean:
        return ""
    return "用户填写的参数（JSON）：" + json.dumps(clean, ensure_ascii=False)


def _deliverables_block(cap: Dict[str, Any]) -> str:
    items = cap.get("deliverables") or []
    if not items:
        return "交付物：按技能说明产出。"
    lines = ["交付物（必须真实写在产物目录里）："]
    for item in items:
        if not isinstance(item, dict):
            continue
        lines.append("- %s（类型 %s，建议文件名 %s）"
                     % (item.get("label") or item.get("name"), item.get("kind"), item.get("name")))
    return "\n".join(lines)


def build_instruction(cap: Dict[str, Any], run_id: str, files: List[Dict[str, Any]],
                      params: Dict[str, Any], sidecars: List[Dict[str, Any]],
                      urls: List[str], output_dir: str,
                      generated_images: Optional[List[Dict[str, Any]]] = None,
                      report_sources: Optional[List[Dict[str, Any]]] = None,
                      video_sources_data: Optional[Dict[str, Any]] = None,
                      media: Optional[Dict[str, Any]] = None) -> str:
    """把能力定义 + 输入 + 工具映射要求拼成给 OpenClaw 会话的指令。

    说明（不藏）：OpenClaw 的 chat.send 只接受 message 正文，没有 per-session 的
    system prompt 通道；所以能力定义是作为一条**带明确分隔块**的指令消息注入的，
    并且在最前面显式声明工具映射（read_table→read CSV / write_*→write/exec / 网址→browser）。
    """
    name = str(cap.get("name") or cap.get("id") or "")
    uploaded_images = [f for f in (files or []) if _is_image_name(f.get("name"))]
    uploaded_tables = [f for f in (files or [])
                       if f not in uploaded_images and not _is_video_name(f.get("name"))]
    report_block = input_sources.render_report_block(report_sources or [])
    video_block = video_sources.render_video_block(video_sources_data or {}, media)
    parts: List[str] = []
    parts.append("【NOVAI 能力运行 · OpenClaw 执行器】")
    parts.append("你正在 NOVAI 的一次能力运行里执行任务，必须用真实工具完成，不要只回文字。")
    parts.append("")
    parts.append("## 执行纪律（最高优先级，必须遵守）")
    parts.append("1. 只能用真实的工具调用来完成任务；禁止用文字、计划、伪代码或示例代码代替工具调用。")
    parts.append("2. 不要输出 Step 1 之类编号、不要写 python 代码块、不要写方括号包起来的工具名；直接调用工具。")
    parts.append("3. 现在立刻从第一个工具调用开始（browser / read / exec），不要在回复里做规划。")
    parts.append("4. 只有把交付文件真正写进产物目录之后，才输出一句中文总结。")
    parts.append("5. 不要读取工作区里的 AGENTS.md / SOUL.md / USER.md / TOOLS.md / HEARTBEAT.md 等文件，它们与本任务无关。")
    if urls:
        parts.append("6. 第一步必须立刻调用 browser 工具打开 %s（action=open），不要先做别的、不要先回复文字。" % urls[0])
    elif uploaded_images and not uploaded_tables:
        parts.append("6. 第一步必须立刻用 read 工具读取上面列出的输入图片，不要先做别的、不要先回复文字。"
                     "不要用 image 工具：它依赖 OpenClaw 图像描述模型（agents.defaults.imageModel），"
                     "本机未配置可用的 provider/key，每次调用会超时 60 秒。")
    elif files:
        parts.append("6. 第一步必须立刻用 read 工具读取输入文件，不要先做别的、不要先回复文字。")
    elif report_block or video_block:
        parts.append("6. 本次报告/视频内容已由 NOVAI 解析并贴在下面；直接从按技能说明写交付文件开始，"
                     "不要再下载同一链接、不要重复解析。")
    parts.append("")
    parts.append("## 能力定义")
    parts.append("名称：%s（id=%s，kind=%s）" % (name, cap.get("id"), cap.get("kind") or "agent"))
    description = str(cap.get("description") or "").strip()
    if description:
        parts.append("简介：%s" % description)
    parts.append(_deliverables_block(cap))
    parts.append("")
    parts.append("## 本次输入")
    parts.append(_files_block(run_id, files, sidecars, media))
    if generated_images:
        parts.append("")
        parts.append("已由 NOVAI 生图链路生成并落在产物目录的图片（这些就是交付物/配图，直接使用，不要再自己生成图片）：")
        for item in generated_images:
            parts.append("- %s（%s 字节，受控下载 URL %s）"
                         % (item.get("path"), item.get("bytes"), item.get("url")))
    params_text = _params_block(params)
    if params_text:
        parts.append(params_text)
    if urls:
        parts.append("用户提供的网页地址（必须用 browser 工具打开并抓真实页面数据）：")
        for url in urls:
            parts.append("- %s" % url)
    if report_block:
        parts.append("")
        parts.append(report_block)
    if video_block:
        parts.append("")
        parts.append(video_block)
    parts.append("")
    parts.append("## 工具映射（本会话没有 NOVAI 的文件工具，按下面的真实工具做）")
    parts.append("- 读表格（原技能里的 read_table）：用 read 工具读取上面列出的 CSV 文本路径；"
                 "如果 CSV 不存在，用 exec 调 /usr/bin/python3 + openpyxl 读原始 xlsx。")
    parts.append("- 写报告（原技能里的 write_html_report）：用 write 工具把完整 HTML（含 <html> 结构）"
                 "直接写到产物目录下的绝对路径；不要只在回复里贴报告内容。")
    parts.append("- 写 Excel（原技能里的 write_xlsx）：用 exec 调 /usr/bin/python3 + openpyxl 生成 .xlsx。")
    parts.append("- 抓网址：用 browser 工具（action=open 打开、action=snapshot 读取页面结构、"
                 "必要时 action=act 点击/输入）。原技能说明里「不使用浏览器插件」在本次运行不适用，"
                 "只要有网址就必须用 browser 抓取，不得凭猜测编造。")
    parts.append("- 生图：本会话没有生图工具；需要用图时直接用上面「已由 NOVAI 生成的图片」，"
                 "既不要编造图片路径，也不要用 exec 调外部生图服务。")
    parts.append("- 报告链接 / 报告文件：NOVAI 已把真实内容解析并贴在「已解析的报告链接 / 报告文件内容」块里；"
                 "直接据此策划，不要再抓同一链接，也不要把没贴出来的内容当成已知。")
    parts.append("- 视频：关键帧是 NOVAI 用 ffmpeg 抽出的真实图片，已复制到 OpenClaw 允许目录，"
                 "用 read 工具查看（不要用 image 工具：它依赖 OpenClaw 图像描述模型，"
                 "本机未配置可用的 provider/key，每次调用会超时 60 秒）；"
                 "路径一律用上面列出的绝对路径，禁止编造；"
                 "口播台词只以「音频口播转写」为准，转写标为不可用时写「数据不足」，不要编造台词。")
    parts.append("- 数据必须来自输入文件或抓取到的真实页面；字段缺失就写「数据不足」。")
    parts.append("")
    parts.append("## 产物要求")
    parts.append("产物目录（必须写到这里，绝对路径）：%s" % output_dir)
    parts.append("用途：把每个交付文件写到该目录下（用上面给的绝对路径，不要写到 workspace）。")
    parts.append("完成后用一句中文总结你产出了哪些文件、数据来源是什么。")
    parts.append("")
    parts.append("## 技能说明（原文，工作流/分析口径以它为准）")
    parts.append("-----")
    parts.append(str(cap.get("skill_prompt") or "").strip())
    parts.append("-----")
    parts.append("")
    parts.append("再次强调：立刻调用真实工具，把交付文件写进产物目录；不要回复计划或示例代码。")
    return "\n".join(parts)


def _kind_for(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".xlsx", ".xlsm", ".xls"):
        return "xlsx"
    if ext == ".csv":
        return "csv"
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        return "image"
    if ext in (".md", ".txt"):
        return "text"
    if ext == ".json":
        return "json"
    if ext == ".pdf":
        return "pdf"
    return ""


def collect_artifacts(run_id: str) -> List[Dict[str, Any]]:
    """扫描产物目录顶层文件并登记为受控下载产物（刷新后仍可下载）。"""
    output_dir = store.run_output_dir(run_id)
    items: List[Dict[str, Any]] = []
    if not os.path.isdir(output_dir):
        return items
    try:
        names = sorted(os.listdir(output_dir))
    except OSError:
        return items
    for name in names:
        if name in _SKIP_ARTIFACT_DIRS:
            continue
        path = os.path.join(output_dir, name)
        if not os.path.isfile(path):
            continue
        items.append(store.add_artifact(run_id, _kind_for(name), name, path))
    return items


def _tool_description(name: str, args: Dict[str, Any]) -> str:
    args = args if isinstance(args, dict) else {}
    if name == "exec":
        command = str(args.get("command") or "").strip().replace("\n", " ")
        return "exec：" + (command[:140] or "")
    if name == "browser":
        action = str(args.get("action") or "").strip()
        url = str(args.get("url") or args.get("targetUrl") or "").strip()
        return ("browser %s%s" % (action, (" " + url) if url else "")).strip()
    if name in ("read", "write", "edit"):
        return "%s %s" % (name, str(args.get("path") or args.get("file_path") or ""))
    if name == "web_fetch":
        return "web_fetch " + str(args.get("url") or "")
    try:
        return "%s：%s" % (name, json.dumps(args, ensure_ascii=False)[:120])
    except Exception:
        return name


def _result_text(data: Dict[str, Any]) -> str:
    result = data.get("result") if isinstance(data.get("result"), dict) else {}
    if not result and isinstance(data.get("partialResult"), dict):
        result = data["partialResult"]
    content = result.get("content")
    chunks: List[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                chunks.append(block["text"])
    text = "\n".join(chunks).strip()
    if not text:
        details = result.get("details") if isinstance(result.get("details"), dict) else {}
        for key in ("aggregated", "summary", "tail", "stdout"):
            value = details.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
    return text


class _ToolMapper(object):
    """把 OpenClaw 的 tool 事件流映射成既有 step_start/step_result 事件。"""

    def __init__(self, run_id: str, emit: Callable[[str, Dict[str, Any]], None]):
        self.run_id = run_id
        self.emit = emit
        self.index_by_call: Dict[str, int] = {}
        self.next_index = 0
        self.steps_executed = 0

    def _index_for(self, tool_call_id: str, name: str) -> int:
        key = str(tool_call_id or name or "tool")
        if key not in self.index_by_call:
            self.index_by_call[key] = self.next_index
            self.next_index += 1
        return self.index_by_call[key]

    def on_tool(self, data: Dict[str, Any]) -> None:
        if not isinstance(data, dict):
            return
        phase = str(data.get("phase") or "")
        name = str(data.get("name") or "tool")
        call_id = str(data.get("toolCallId") or "")
        if phase == "start":
            index = self._index_for(call_id, name)
            args = data.get("args") if isinstance(data.get("args"), dict) else {}
            description = _tool_description(name, args)
            self.emit("step_start", {"index": index, "tool": name, "args": args,
                                     "description": description})
        elif phase == "result":
            index = self._index_for(call_id, name)
            ok = not bool(data.get("isError"))
            text = _result_text(data)
            summary = text[:400]
            if ok:
                self.steps_executed += 1
            step = {"index": index, "tool": name, "description": _tool_description(name, {}),
                    "ok": ok}
            if summary:
                step["summary"] = summary[:200]
            if not ok:
                step["error"] = text[:500] or "工具执行失败"
            store.append_step(self.run_id, step)
            payload = {"index": index, "tool": name, "ok": ok,
                       "result": {"value": summary}, "message": summary or ("执行成功" if ok else "执行失败")}
            if not ok:
                payload["error"] = text[:500] or "工具执行失败"
                payload["code"] = "tool_error"
            self.emit("step_result", payload)


def _emit_done(emit: Callable[[str, Dict[str, Any]], None], run_id: str, status: str,
               message: str, steps_executed: int, rounds: int,
               artifacts: List[Dict[str, Any]]) -> None:
    record = store.load_run(run_id) or {}
    emit("done", {
        "run_id": run_id,
        "status": status,
        "steps_executed": steps_executed,
        "rounds": rounds,
        "message": message[:2000],
        "changes": {"nodes_created": 0, "nodes_modified": 0, "nodes_deleted": 0,
                    "connections": 0, "generations": 0},
        "session_id": record.get("session_id") or "",
        "undoable": False,
        "artifacts": artifacts,
        "backend": "openclaw",
    })


def capability_mode() -> str:
    """NOVAI_CAPABILITY_OPENCLAW_MODE=agent|orchestrated。

    - agent（默认）：把能力定义交给 OpenClaw 会话，由模型自己决定并调用工具（browser/read/write）。
    - orchestrated：模型不会自行调用工具时，由 NOVAI 明确驱动 OpenClaw 的 browser 抓取，
      再把抓到的真实内容交给 OpenClaw 会话模型生成报告。两种模式都由 OpenClaw 执行，
      都不会回落到 NOVAI 本地循环（那是 NOVAI_CAPABILITY_BACKEND=local 的职责）。
    """
    value = _env("NOVAI_CAPABILITY_OPENCLAW_MODE", "agent").lower()
    return value if value in ("agent", "orchestrated") else "agent"


def _invoke_text(payload: Dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    output = payload.get("output")
    if isinstance(output, dict):
        return _result_text({"result": output})
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "")
    return ""


def _emit_step(emit: Callable[[str, Dict[str, Any]], None], run_id: str, index: int,
               tool: str, args: Dict[str, Any], description: str, ok: bool, text: str) -> None:
    emit("step_start", {"index": index, "tool": tool, "args": args, "description": description})
    step = {"index": index, "tool": tool, "description": description, "ok": bool(ok)}
    if text:
        step["summary"] = text[:200]
    if not ok:
        step["error"] = (text or "执行失败")[:500]
    store.append_step(run_id, step)
    payload = {"index": index, "tool": tool, "ok": bool(ok),
               "result": {"value": text[:400]},
               "message": text[:300] or ("执行成功" if ok else "执行失败")}
    if not ok:
        payload["error"] = (text or "执行失败")[:500]
        payload["code"] = "tool_error"
    emit("step_result", payload)


def _extract_html(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    fence = re.search(r"\x60\x60\x60(?:html)?\s*(.*?)\x60\x60\x60", raw, re.S | re.I)
    if fence and "<html" in fence.group(1).lower():
        raw = fence.group(1).strip()
    lower = raw.lower()
    start = lower.find("<!doctype")
    if start < 0:
        start = lower.find("<html")
    if start < 0:
        return ""
    if start > 0:
        raw = raw[start:]
    return raw.strip()


def _strip_external_notice(text: str) -> str:
    """去掉 browser 快照开头的安全提示噪声，只留页面内容（提示本身不是页面数据）。"""
    raw = str(text or "")
    marker = "Reveal sensitive information"
    index = raw.find(marker)
    if index < 0:
        return raw.strip()
    split = raw.find("\n\n", index)
    if split < 0:
        return raw.strip()
    return raw[split:].strip()


def _report_filenames(cap: Dict[str, Any]) -> List[str]:
    names: List[str] = []
    for item in cap.get("deliverables") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("kind") or "").lower() != "html":
            continue
        name = str(item.get("name") or "").strip()
        if name:
            names.append(name)
    if not names:
        names = ["%s报告.html" % (cap.get("name") or "能力")]
    return names


def _write_reports(run_id: str, cap: Dict[str, Any], html: str) -> List[str]:
    output_dir = store.run_output_dir(run_id)
    written: List[str] = []
    for name in _report_filenames(cap):
        safe = store.safe_filename(name)
        if not safe.lower().endswith(".html"):
            safe = "%s.html" % safe
        with open(os.path.join(output_dir, safe), "w", encoding="utf-8") as handle:
            handle.write(html)
        written.append(safe)
    return written


def _table_text_block(sidecars: List[Dict[str, Any]], limit: int = 8000) -> str:
    parts: List[str] = []
    for item in sidecars:
        if item.get("error"):
            continue
        path = str(item.get("path") or "")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                content = handle.read()
        except OSError:
            continue
        parts.append("【%s / 工作表 %s】\n%s" % (item.get("source"), item.get("sheet"),
                                              content[:limit]))
    return "\n\n".join(parts)


def _orchestrated_prompt(cap: Dict[str, Any], scraped: List[str], table_text: str,
                         params: Dict[str, Any], urls: List[str],
                         generated_images: Optional[List[Dict[str, Any]]] = None,
                         report_sources: Optional[List[Dict[str, Any]]] = None,
                         video_sources_data: Optional[Dict[str, Any]] = None,
                         media: Optional[Dict[str, Any]] = None) -> str:
    parts: List[str] = []
    parts.append("【很重要】本次只需要你在回复里直接输出一份完整 HTML 报告；不要调用任何工具，"
                 "本会话没有 write_html_report / write_xlsx / read_table 这些工具。")
    parts.append("")
    parts.append("你是 NOVAI 能力「%s」的执行者。" % (cap.get("name") or cap.get("id")))
    parts.append("下面是本次运行拿到的真实数据，请据此完成分析。")
    params_text = _params_block(params)
    if params_text:
        parts.append(params_text)
    if urls:
        parts.append("数据来源（OpenClaw 浏览器抓取）：%s" % "、".join(urls))
    if scraped:
        parts.append("\n".join(scraped))
    if table_text:
        parts.append("数据来源（上传表格）：")
        parts.append(table_text)
    report_block = input_sources.render_report_block(report_sources or [])
    if report_block:
        parts.append(report_block)
    video_block = video_sources.render_video_block(video_sources_data or {}, media)
    if video_block:
        parts.append(video_block)
    if generated_images:
        parts.append("已由 NOVAI 生图链路生成并落在产物目录的图片（可直接引用这些绝对路径作为配图）：")
        for item in generated_images:
            parts.append("- %s（%s 字节）" % (item.get("path"), item.get("bytes")))
    parts.append("")
    parts.append("必须遵循的技能说明（工作流 / 分析口径 / 输出模块）：")
    parts.append("-----")
    parts.append(str(cap.get("skill_prompt") or "").strip())
    parts.append("-----")
    parts.append("")
    parts.append("输出要求（最重要）：立即输出完整 HTML 报告，第一行必须是 <!doctype html>；"
                 "不要调用工具、不要解释、不要 markdown 代码围栏；"
                 "数据必须来自上面提供的真实内容，字段缺失就写「数据不足」。")
    return "\n".join(parts)


async def run_orchestrated(run_id: str, cap: Dict[str, Any], files: List[Dict[str, Any]],
                           params: Dict[str, Any],
                           emit: Callable[[str, Dict[str, Any]], None],
                           settings: Any, model: str) -> None:
    """编排模式：NOVAI 驱动 OpenClaw browser 抓取 → OpenClaw 会话模型出报告。"""
    cap_id = str(cap.get("id") or "")
    cap_name = str(cap.get("name") or cap_id)
    output_dir = store.run_output_dir(run_id)
    os.makedirs(output_dir, exist_ok=True)
    sidecars = prepare_table_sidecars(run_id, files)
    report_sources = await input_sources.prepare_report_sources(params, run_id, files)
    video_sources_data = await video_sources.prepare_video_sources(run_id, files, params, output_dir)
    media = bridge_input_images(run_id, files, video_sources_data)
    urls = extract_urls(params)
    for item in video_sources_data.get("links") or []:
        if item.get("url") and item["url"] not in urls:
            urls.append(item["url"])
    session_key = settings.capability_session_key(run_id)
    if model:
        settings.model = model

    emit("run_start", {"run_id": run_id, "capability_id": cap_id, "capability_name": cap_name,
                       "model": model or "openclaw-agent-default", "max_steps": 0,
                       "backend": "openclaw", "mode": "orchestrated", "urls": urls})
    store.update_run(run_id, backend="openclaw", mode="orchestrated", provider="openclaw",
                     model=model or "", status="running")

    try:
        generated_images, index = await _image_phase(run_id, cap, files, params, emit)
    except OpenClawError as exc:
        message = "OpenClaw 能力运行失败：%s" % exc
        store.update_run(run_id, status="failed", error=message, message=message)
        emit("error", {"message": message, "code": "image_generate_failed"})
        _emit_done(emit, run_id, "failed", message, 0, 0, [])
        return

    client = OpenClawGatewayClient(settings)
    scraped: List[str] = []
    scrape_errors: List[str] = []

    for url in urls[:2]:
        open_args = {"action": "open", "url": url}
        try:
            open_payload = await client.invoke_tool("browser", open_args,
                                                    agent_id=settings.agent_id, timeout=120)
        except OpenClawError as exc:
            open_payload = {"ok": False, "error": {"message": str(exc)}}
        open_text = _invoke_text(open_payload)
        _emit_step(emit, run_id, index, "browser", open_args,
                   "OpenClaw 浏览器打开 %s" % url, bool(open_payload.get("ok")), open_text)
        index += 1
        if not open_payload.get("ok"):
            scrape_errors.append("打开 %s 失败：%s" % (url, open_text))
            continue
        snap_args = {"action": "snapshot", "compact": True, "maxChars": 24000}
        try:
            snap_payload = await client.invoke_tool("browser", snap_args,
                                                    agent_id=settings.agent_id, timeout=180)
        except OpenClawError as exc:
            snap_payload = {"ok": False, "error": {"message": str(exc)}}
        snap_text = _invoke_text(snap_payload)
        _emit_step(emit, run_id, index, "browser", snap_args,
                   "OpenClaw 浏览器抓取页面内容", bool(snap_payload.get("ok")), snap_text)
        index += 1
        if snap_payload.get("ok") and snap_text.strip():
            page_text = _strip_external_notice(snap_text)
            scraped.append("【%s 的页面内容（OpenClaw 浏览器抓取）】\n%s"
                           % (url, page_text[:20000]))
        else:
            scrape_errors.append("抓取 %s 失败：%s" % (url, snap_text))

    table_text = _table_text_block(sidecars)
    if not scraped and not table_text:
        message = "本次运行没有可分析的数据：网址抓取失败（%s），且没有可读表格。" % (
            "；".join(scrape_errors) or "未提供网址")
        store.update_run(run_id, status="failed", error=message, message=message)
        emit("error", {"message": message, "code": "no_input_data"})
        _emit_done(emit, run_id, "failed", message, 0, 0, [])
        return

    prompt = _orchestrated_prompt(cap, scraped, table_text, params, urls,
                                  generated_images=generated_images,
                                  report_sources=report_sources,
                                  video_sources_data=video_sources_data,
                                  media=media)
    chat_args = {"model": model, "prompt_chars": len(prompt), "scraped_sources": len(scraped)}
    idle_retry = _idle_retry_budget()
    attempts = 0
    chat_ok, chat_text = False, ""
    while True:
        attempts += 1
        try:
            report_text = await client.chat(prompt, session_key=session_key,
                                            idle_timeout=_capability_idle_timeout())
            chat_ok, chat_text = True, report_text
            break
        except OpenClawIdleTimeoutError as idle_exc:
            # 编排模式没有工具步骤；只要还没有图片产物就可以安全重连重试。
            if attempts > idle_retry or _has_generated_image_artifacts(run_id, generated_images):
                chat_ok, chat_text = False, str(idle_exc)
                break
            emit("message", {"text": "OpenClaw 网关空闲超时（%s）；本次还没有任何图片产物，"
                                     "自动重连重试（第 %d 次，runId=%s）。"
                                     % (idle_exc, attempts, run_id)})
        except OpenClawError as exc:
            chat_ok, chat_text = False, str(exc)
            break
    _emit_step(emit, run_id, index, "openclaw.chat", chat_args,
               "OpenClaw 会话模型生成 HTML 报告", chat_ok, chat_text)
    index += 1

    if not chat_ok:
        message = "OpenClaw 模型生成报告失败：%s" % chat_text
        store.update_run(run_id, status="failed", error=message, message=message,
                         steps_executed=index)
        emit("error", {"message": message, "code": "model_failed"})
        _emit_done(emit, run_id, "failed", message, index, index, [])
        return

    html = _extract_html(chat_text)
    if not html:
        message = "OpenClaw 模型没有返回 HTML 报告（返回内容前 200 字：%s）" % chat_text[:200]
        store.update_run(run_id, status="failed", error=message, message=message,
                         steps_executed=index)
        emit("error", {"message": message, "code": "no_html"})
        _emit_done(emit, run_id, "failed", message, index, index, [])
        return

    try:
        written = _write_reports(run_id, cap, html)
    except OSError as exc:
        message = "写报告失败：%s" % exc
        store.update_run(run_id, status="failed", error=message, message=message)
        emit("error", {"message": message, "code": "write_failed"})
        _emit_done(emit, run_id, "failed", message, index, index, [])
        return

    artifacts = collect_artifacts(run_id)
    message = "OpenClaw（编排模式）已完成：浏览器抓取 %d 个来源，产出 %s。" % (
        len(scraped), "、".join(written))
    store.update_run(run_id, status="ok", message=message, error="",
                     steps_executed=index, rounds=index, artifacts=artifacts)
    emit("message", {"text": message})
    _emit_done(emit, run_id, "ok", message, index, index, artifacts)


async def run(run_id: str, cap: Dict[str, Any], record: Dict[str, Any],
              files: List[Dict[str, Any]], params: Dict[str, Any],
              emit: Callable[[str, Dict[str, Any]], None]) -> None:
    """OpenClaw 后端：跑一次能力，事件全部经 emit(event, data) 发出。"""
    if capability_mode() == "orchestrated":
        settings_o, model_o = capability_settings()
        await run_orchestrated(run_id, cap, files, params, emit, settings_o, model_o)
        return
    cap_id = str(cap.get("id") or "")
    cap_name = str(cap.get("name") or cap_id)
    output_dir = store.run_output_dir(run_id)
    os.makedirs(output_dir, exist_ok=True)
    sidecars = prepare_table_sidecars(run_id, files)
    urls = extract_urls(params)
    settings, model = capability_settings()
    session_key = settings.capability_session_key(run_id)

    emit("run_start", {"run_id": run_id, "capability_id": cap_id, "capability_name": cap_name,
                       "model": model or "openclaw-agent-default", "max_steps": 0,
                       "backend": "openclaw", "mode": "agent", "urls": urls})
    store.update_run(run_id, backend="openclaw", model=model or "",
                     provider="openclaw", status="running")

    # 生图能力：先由 NOVAI 侧用既有生图链路真实出图，再把产物路径喂给 OpenClaw 会话
    try:
        generated_images, image_index = await _image_phase(run_id, cap, files, params, emit)
    except OpenClawError as exc:
        message = "OpenClaw 能力运行失败：%s" % exc
        store.update_run(run_id, status="failed", error=message, message=message)
        emit("error", {"message": message, "code": "image_generate_failed"})
        _emit_done(emit, run_id, "failed", message, 0, 0, [])
        return

    report_sources = await input_sources.prepare_report_sources(params, run_id, files)
    video_sources_data = await video_sources.prepare_video_sources(run_id, files, params, output_dir)
    media = bridge_input_images(run_id, files, video_sources_data)
    index = image_index
    for source in report_sources:
        ok = bool(source.get("text"))
        _emit_step(emit, run_id, index, "input.report", {"ref": source.get("ref")},
                   "解析报告链接 / 报告文件：%s" % source.get("ref"), ok,
                   ("解析出 %d 字" % int(source.get("chars") or 0)) if ok
                   else (source.get("error") or "内容为空"))
        index += 1
    for entry in video_sources_data.get("files") or []:
        frames = len(entry.get("frames") or [])
        transcript = entry.get("transcript") or {}
        ok = bool(frames) or bool(transcript.get("ok"))
        _emit_step(emit, run_id, index, "input.video",
                   {"name": entry.get("name")}, "解析视频文件：%s" % entry.get("name"), ok,
                   "关键帧 %d 张；口播转写 %s" % (
                       frames, ("成功（%d 字）" % len(transcript.get("text") or ""))
                       if transcript.get("ok") else (transcript.get("error") or "不可用")))
        index += 1
    for entry in video_sources_data.get("links") or []:
        ok = not entry.get("error")
        _emit_step(emit, run_id, index, "input.video",
                   {"url": entry.get("url")}, "解析视频链接：%s" % entry.get("url"), ok,
                   (entry.get("title") or (entry.get("descriptions") or [""])[0]
                    or "页面无可读文案") if ok else (entry.get("error") or "抓取失败"))
        index += 1

    instruction = build_instruction(cap, run_id, files, params, sidecars, urls, output_dir,
                                    generated_images=generated_images,
                                    report_sources=report_sources,
                                    video_sources_data=video_sources_data,
                                    media=media)

    mapper = _ToolMapper(run_id, emit)
    mapper.next_index = index
    rounds = 0
    client = OpenClawGatewayClient(settings)
    run_timeout = _env_float("NOVAI_CAPABILITY_OPENCLAW_RUN_TIMEOUT", 600.0)

    def _count_round(data: Dict[str, Any]) -> None:
        nonlocal rounds
        if isinstance(data, dict) and str(data.get("phase") or "") == "start":
            rounds += 1

    def on_tool(data: Dict[str, Any]) -> None:
        _count_round(data)
        mapper.on_tool(data)

    idle_timeout = _capability_idle_timeout()
    idle_retry = _idle_retry_budget()
    attempts = 0
    try:
        while True:
            attempts += 1
            try:
                result = await client.chat_stream(
                    instruction, session_key=session_key, model=model,
                    on_tool=on_tool, timeout=run_timeout, idle_timeout=idle_timeout)
                break
            except OpenClawIdleTimeoutError as idle_exc:
                # 守卫：只要本次运行还没有图片交付物就重试。重复计费风险只来自上游生图，
                # 而它由 _image_phase 负责，聊天阶段不会触发上游生图。
                can_retry = not _has_generated_image_artifacts(run_id, generated_images)
                if attempts > idle_retry or not can_retry:
                    raise
                emit("message", {"text": "OpenClaw 网关空闲超时（%s）；本次尝试还没有产出图片交付物，"
                                         "自动重连重试（第 %d 次，runId=%s）。"
                                         % (idle_exc, attempts, run_id)})
    except OpenClawError as exc:
        # 生图能力：NOVAI 侧已经用既有生图链路产出交付图，此时 OpenClaw 会话模型这一步
        # 失败不应把整次运行判死；产物照常登记，失败原因写进 message（不静默）。
        artifacts = collect_artifacts(run_id)
        if artifacts:
            message = ("NOVAI 生图链路已产出 %d 个交付文件；"
                       "OpenClaw 会话模型这一步失败：%s" % (len(artifacts), exc))
            store.update_run(run_id, status="ok", message=message, error="",
                             steps_executed=mapper.steps_executed, rounds=rounds,
                             artifacts=artifacts)
            emit("message", {"text": message})
            _emit_done(emit, run_id, "ok", message, mapper.steps_executed, rounds, artifacts)
            return
        message = "OpenClaw 能力运行失败：%s" % exc
        store.update_run(run_id, status="failed", error=message, message=message)
        emit("error", {"message": message, "code": "openclaw_error"})
        _emit_done(emit, run_id, "failed", message, mapper.steps_executed, rounds, [])
        return

    text = str(result.get("text") or "").strip()
    artifacts = collect_artifacts(run_id)
    if text:
        emit("message", {"text": text})

    if artifacts:
        status = "ok"
        message = text or ("OpenClaw 已完成本次能力运行，产出 %d 个文件" % len(artifacts))
    else:
        status = "failed"
        message = (text + "\n\n" if text else "") + \
            "OpenClaw 运行结束，但产物目录 %s 下没有写出任何交付文件。" % output_dir
        emit("error", {"message": message, "code": "no_artifacts"})

    store.update_run(run_id, status=status, message=message,
                     steps_executed=mapper.steps_executed, rounds=rounds,
                     error=message if status == "failed" else "", artifacts=artifacts)
    _emit_done(emit, run_id, status, message, mapper.steps_executed, rounds, artifacts)


def now_ms() -> int:
    return int(time.time() * 1000)
