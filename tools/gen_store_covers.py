#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给应用市场的技能条目生成统一风格的高清概念图封面（宽图 16:10 + 1:1 方形裁切）。

流程：catalog.json 的 skill 条目 + 技能注册表里的内置技能 → 每条一句英文主体提示词（附中文说明）
→ POST 本机 /api/online-image（provider=modelscope，首选 Qwen/Qwen-Image-2512，失败退
Tongyi-MAI/Z-Image-Turbo）→ Pillow 转 WebP 写 static/store/covers/gen-<name>.webp（最长边 1600）
与 gen-<name>-sq.webp（800×800 卡片用）→ 改写 catalog.json / details 的 cover_url、cover_poster_url，
原值另存 cover_original_url / cover_original_poster_url 以便回退。生成源图落在 assets/output 时，
复制完就删掉，不污染用户素材库。

幂等：已有 gen-<name>.webp 且未 --force 就跳过（仍会把 catalog 指回已有文件）。
Python 3.9 兼容：只用标准库 + Pillow，注解用 Optional/Dict/List，禁止 X | Y 联合写法。

用法：
    python3 tools/gen_store_covers.py --dry-run
    python3 tools/gen_store_covers.py --only fashion-editorial,depth-video-studio --report /tmp/covers.json
    python3 tools/gen_store_covers.py --limit 10 --batch-size 10
    python3 tools/gen_store_covers.py --restore            # 把 cover_url 还原成 cover_original_url
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE_DIR = os.path.join(REPO_ROOT, "server", "store_data")
DETAILS_DIR = os.path.join(STORE_DIR, "details")
COVERS_DIR = os.path.join(REPO_ROOT, "static", "store", "covers")
COVERS_URL_PREFIX = "/static/store/covers/"
GEN_PREFIX = "gen-"
WIDE_MAX_EDGE = 1600
SQUARE_MAX_EDGE = 800
WEBP_QUALITY = 88
WIDE_ASPECT = 1.6                      # 16:10；源图比例偏差超过 0.06 时居中裁成 16:10
ASPECT_TOLERANCE = 0.06
DEFAULT_SIZE = "1600x1000"
DEFAULT_MODEL = "Qwen/Qwen-Image-2512"
DEFAULT_FALLBACK_MODEL = "Tongyi-MAI/Z-Image-Turbo"
DEFAULT_HOST = "http://127.0.0.1:3999"
DEFAULT_TIMEOUT = 240.0
DEFAULT_CONCURRENCY = 2
DEFAULT_BATCH = 10
GENERATED_FILE_PREFIX = "online_"    # main.py 保存在线生图产物时的文件名前缀

# ---------------------------------------------------------------- 美术方向

ART_DIRECTION_EN = (
    "Premium cinematic key art for a creative AI skill. {subject}. "
    "Wide 16:10 editorial composition, one clear hero subject held in the center with generous negative space, "
    "soft volumetric key light from the upper left, warm amber and honey highlights over deep charcoal-teal shadows, "
    "muted film-grade color palette, subtle 35mm grain and matte texture, shallow depth of field with gentle atmospheric haze, "
    "the scene dissolves softly into the background at its edges, no visible frame or border. "
    "Absolutely no text, no letters, no numbers, no logos, no brand marks, no watermark, no user interface, "
    "no screenshot, no signage, no chart labels. Photographic, highly detailed, 8k."
)

ART_DIRECTION_ZH = (
    "16:10 电影感概念插画：{note}；统一深青灰影调 + 暖琥珀高光，柔和体积光、35mm 胶片颗粒与亚光质感，"
    "主体居中、四周留白，画面边缘自然融进背景不留框线；画面零文字、无 logo、无水印、无界面元素。"
)

# 每条技能一个「主体」，英文写进提示词，中文进报告给人看。
SUBJECTS = {
    "primordia-creator-skills": (
        "a director's pre-production table: character portrait sheets, a miniature film set model and a hand-drawn shot list "
        "pinned on a dark studio wall under a warm desk lamp",
        "影视创作筹备台：角色设定稿、微缩片场模型与手绘镜头表"),
    "character-asset-pack": (
        "a lineup of character asset sheets on a studio table: a sculpted bust, fabric costume swatches and a glowing voice "
        "waveform on a small monitor",
        "角色资产台：半身像、服装料片与发光声音波形"),
    "primordia-art-director": (
        "an art director composing a miniature 3D film set: foam architecture, tiny practical lights, translucent color-script "
        "panels floating above the set",
        "三维造景：微缩片场 + 半透明色彩脚本"),
    "shot-planning": (
        "a top-down storyboard wall with cinematic shot frames linked by thin lines of light, a cinema lens and a director's "
        "viewfinder resting on the table",
        "镜头规划墙：分镜画格 + 镜头与取景器"),
    "astra-studio": (
        "an experimental creative lab where floating 3D shapes, motion trails and generative art spheres hang in a dark "
        "studio void",
        "创意实验场：漂浮三维形体与生成艺术球体"),
    "3d-studio": (
        "a 3D viewport world floating in a dark room: a wireframe sculpture rotating above a lit grid floor with a camera "
        "orbit path drawn in light",
        "3D实验室：线框雕塑 + 环绕运镜轨迹"),
    "3d-studio-v2": (
        "a virtual 3D film stage with blockout characters and lighting rigs arranged on a reflective floor while a previs "
        "camera glides through low haze",
        "3D片场：白模角色、灯架与穿雾预演镜头"),
    "whitebox-to-film": (
        "a white clay-like blockout film set that turns photoreal at one edge, white maquette characters, a camera dolly and "
        "glowing motion arrows",
        "白模预演：白模片场一侧转为真实材质"),
    "skill-creator": (
        "a craftsman's workbench where modular glowing skill cards are assembled like precision instruments, faint "
        "instruction lines of light in the air",
        "技能创建：像装配精密仪器一样拼起技能卡"),
    "seedance-2-prompt-copilot": (
        "a director's monitor showing a cinematic frame surrounded by floating storyboard tiles, ribbons of camera motion "
        "and a sound waveform",
        "视频提示词：监视器 + 分镜浮块 + 声音波形"),
    "seedance-2-5-prompt-copilot": (
        "a ribbon of cinematic frames stretching through dark space, the first and last frames joined by a glowing motion arc",
        "连续时间线：首尾帧由光弧衔接"),
    "plugin-guide": (
        "a hub of connected application nodes floating in dark space, glowing connector lines radiating from a central "
        "modular workspace",
        "应用连接：中心工作台向外辐射的应用节点"),
    "minimax-h3-prompt-copilot": (
        "a color-graded film slate and a timecode timeline of cinematic shots sliced by bars of light",
        "带时间码的分段镜头时间线"),
    "kling-prompt-copilot": (
        "a storyboard of dramatic action frames with a clapperboard, magnetic reference cards and a lens flare",
        "动作分镜：场记板、磁吸参考卡与镜头光晕"),
    "gpt-image2-prompt-copilot": (
        "a design desk with layered poster comps, a print layout grid, color swatches and a stylus, every sheet blank",
        "版式设计台：分层海报稿、网格与色卡"),
    "explain-how-it-made": (
        "a translucent process map where luminous nodes of prompt fragments and iteration passes orbit a finished artwork",
        "创作过程图：提示词碎片与迭代节点环绕成图"),
    "client-surface-routing": (
        "three floating platforms — desktop, cloud and an external app — linked by one luminous routing path with a glowing "
        "decision node",
        "执行路径：桌面 / 云端 / 外部应用三平台路由"),
    "banana-prompt-copilot": (
        "a color-grading suite with reference photos, a stylus and a carousel of glowing image variants on a dark table",
        "图像变体台：参考图、触控笔与发光变体轮播"),
    "3d-scene-director": (
        "a flat photograph peeling up from a table into a fully modeled 3D room, wireframe edges resolving into real light "
        "and shadow",
        "图片转 3D：照片边缘升起成可预览房间"),
    "depth-video-studio": (
        "a night film set with a camera crane: a depth-sensing rig casts a visible lattice of light over an actor, "
        "volumetric fog and tracking marks on the ground",
        "片场运镜 + 深度光栅覆盖演员"),
    "opus-motion-studio": (
        "a code-driven motion stage: a floating kinetic sculpture of light and abstract typographic blocks with trails of "
        "motion, no readable letters",
        "代码动效：由代码驱动的漂浮动效雕塑"),
    "opus55-motion-icon": (
        "one abstract subject looping inside a small glowing frame, a clean motion arc and ghosted trail on a minimal dark "
        "stage",
        "循环图标：单一主体 + 干净动作弧线"),
    "html-beat-morph-video": (
        "abstract rhythm bars and typographic blocks morphing along a beat grid with pulses of light, no readable letters",
        "动态文字：沿节拍网格变形的字形块"),
    "youtube-product-video": (
        "a product hero on a brand-film set with softbox lighting, a cinema camera and a monitor carrying a blank title frame",
        "品牌影片片场：产品主视觉 + 电影机与监视器"),
    "digital-human-studio": (
        "a virtual broadcaster studio: a digital human presenter in a glass broadcast booth with ring lights and a "
        "teleprompter glow",
        "虚拟主播站在演播厅玻璃舱内，环形灯与提词器"),
    "digital-human-social-talking-head": (
        "a vertical talking-head setup: a friendly presenter framed inside a 9:16 ring light, phone gimbal and warm "
        "apartment bokeh",
        "社媒口播：9:16 竖屏框内的数字人主播"),
    "digital-human-property-tour": (
        "a presenter walking through a sunlit empty modern apartment on a property tour, soft lens flare and clean interior",
        "房产带看：数字人穿行阳光空房"),
    "digital-human-product-demo": (
        "a presenter at a product demo desk holding a sleek device, macro detail and studio softbox light",
        "产品演示：主讲人手持产品特写"),
    "digital-human-course-explainer": (
        "a digital tutor presenting beside floating diagram panels in a dark classroom studio lit by a warm key light",
        "知识讲解：讲师与漂浮图解面板"),
    "digital-human-market-bulletin": (
        "a newsroom broadcast set with a digital anchor at a glowing desk and ribbons of data on the back wall",
        "新闻播报：数字主播与数据背景屏"),
    "digital-human-asset": (
        "a character creation pod: a digital human bust inside a scanning ring of light with a voice waveform and identity "
        "blueprint beside it",
        "数字人资产：扫描光环中的分身与声音蓝图"),
    "ecommerce-studio": (
        "an e-commerce creative studio: a product on a seamless cyclorama, several blank format boards, ring light, stylus "
        "and tablet",
        "电商设计室：无缝摄影棚、多版位空框与打光"),
    "ad-localizer": (
        "one ad artwork passing through a translation lens and re-forming into a different-culture layout on the other side",
        "广告本地化：素材穿过镜头重排成本地版式"),
    "ad-resizer": (
        "a single hero poster splitting into several blank aspect-ratio frames — 4:5, 1:1, 9:16 and a banner — floating in "
        "dark space",
        "尺寸适配：一张海报拆成多比例版位"),
    "headline-multiplier": (
        "a wall of variant headline cards with blank typographic bars, an A/B split of light and a rising meter",
        "标题变体：空字形卡片墙与上升曲线"),
    "customer-voice-ads": (
        "glowing review bubbles rising from a phone toward a vertical video frame, speech ribbons and a product",
        "客户之声：好评气泡汇聚成竖屏视频"),
    "hook-multiplier": (
        "a vertical video frame whose first three seconds glow and branch into three alternate openings above a timeline "
        "scrubber",
        "开头钩子：前 3 秒分叉出三个开场"),
    "social-instagram-content": (
        "a creator's flat lay: a phone showing a Reel frame, first-frame cover options in a square grid, coffee and soft "
        "window light",
        "Instagram 素材包：Reel 首屏与方形封面选项"),
    "social-tiktok-content": (
        "three vertical phone frames side by side, each showing a different opening hook, comparison light beams between "
        "them",
        "TikTok 钩子对比：三块竖屏并排"),
    "social-linkedin-content": (
        "a clean desktop layout with a document carousel and a text-safe image frame on a dark editorial desk",
        "LinkedIn 洞察：文档轮播与安全区图文框"),
    "social-content-repurposer": (
        "one long film strip breaking into many small vertical content atoms flying toward several platform frames",
        "内容复用：长片带拆成多平台素材"),
    "social-trending-recast": (
        "a popular source video frame with a new actor inserted, a motion-lock grid overlay and phone screens",
        "热门复刻：源视频运镜锁定 + 新人物"),
    "trending-recast-gallery": (
        "a dark wall of glowing vertical 9:16 template cards, one card lifted out and expanding into a playable video frame",
        "爆款模板墙：一张竖屏模板被抽出放大"),
    "social-media-content-studio": (
        "a social content workbench with storyboard cards, platform frames and a moodboard under warm studio light",
        "社媒素材工作台：分镜卡、平台框与情绪板"),
    "ai-influencer-studio": (
        "a virtual influencer forge: a stylized 3D character being assembled from light and clay beside three portrait "
        "options",
        "虚拟网红锻造：角色由光与雕塑成形"),
    "ai-influencer-builder": (
        "a character trait board with three candidate portraits, sliders of light and a first-video preview frame",
        "角色设定板：三版候选形象与首个视频预览"),
    "fish-audio-audiobook": (
        "an audiobook recording booth: a vintage microphone, a glowing manuscript and a warm amber lamp, sound waves "
        "drifting in the air",
        "有声书录音间：复古话筒与发光手稿"),
    "fish-audio-podcast": (
        "two podcast hosts facing each other across a desk with microphones, waveform ribbons weaving between them",
        "双主持人播客：两人对坐，波形在中间交织"),
    "fish-audio-drama": (
        "a radio drama performed in one take: a single lit stage where character voices converge as luminous ribbons",
        "广播剧一镜到底：声音化作汇聚的光带"),
    "fish-audio-game-voices": (
        "a game voice pack: an NPC character silhouette surrounded by animated glowing voice lines, no readable text",
        "游戏语音包：NPC 剪影被发光台词环绕"),
    "fish-audio-bilingual-voiceover": (
        "one microphone emitting two interweaving voice ribbons of different colors to show a seamless language switch",
        "双语配音：一支话筒放出两色交织声带"),
    "fish-audio-names-numbers": (
        "a precision voice console with a microphone, a waveform grid and abstract digits of light for names, prices and "
        "codes",
        "人名数字精准朗读：话筒与波形网格"),
    "fish-audio-lab": (
        "a director's console for a voice actor: a script on a stand, faders and a performer silhouette in a lit booth",
        "配音导演台：剧本架、推子与录音间剪影"),
    "argon-how-it-works": (
        "an exploded 3D mechanism suspended in dark space with cutaway layers glowing and subtle orbit rings",
        "3D 原理演示：悬浮爆炸结构件"),
    "argon-photo-to-3d": (
        "a photo of a desk lifting into a walkable 3D room, its edges turning to wireframe, a warm lamp glowing inside",
        "照片转 3D：桌面照片升起成可走房间"),
    "argon-sketch-to-game": (
        "a paper sketch on a desk rising into a colorful playable game world with a tiny character and arcade light",
        "草图转游戏：纸面草图立起成游戏世界"),
    "argon-3d-web-page": (
        "a 3D landing page hero floating in space: layered scene depth, light-shaped navigation elements and a cursor",
        "3D 网页：悬浮的分层首屏场景"),
    "argon-kinetic-type": (
        "a single line of abstract typographic glyphs frozen mid-motion on a beat grid with motion trails, no readable words",
        "动态文字循环：字形停在节拍网格上"),
    "argon-generative-art": (
        "an algorithmic poster blooming from structured code lines into organic color fields, plotter and color chips beside it",
        "生成艺术：算法线条长出色彩场"),
    "gemini-argon-studio": (
        "a creative studio where a question mark of light transforms into a 3D world, a small game and a kinetic type loop",
        "Argon Studio：一个光之问号展开成 3D 世界"),
    "fashion-editorial": (
        "a fashion editorial studio and darkroom: a sculptural couture look on a mannequin beside the amber beam of an "
        "enlarger, contact sheets and fabric swatches on the workbench",
        "时装摄影工作台 + 暗房放大机光束"),
}

# ---------------------------------------------------------------- 小工具


def _atomic_write_bytes(path: str, data: bytes) -> None:
    folder = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o644)          # mkstemp 建的是 0600，静态资源要跟其它封面同权限
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _atomic_write_json(path: str, data: Any) -> None:
    folder = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _dir_bytes(folder: str) -> int:
    if not os.path.isdir(folder):
        return 0
    total = 0
    for name in os.listdir(folder):
        try:
            total += os.path.getsize(os.path.join(folder, name))
        except OSError:
            pass
    return total


def gen_filename(name: str, square: bool = False) -> str:
    return "%s%s%s.webp" % (GEN_PREFIX, name, "-sq" if square else "")


def gen_url(name: str, square: bool = False) -> str:
    return COVERS_URL_PREFIX + gen_filename(name, square)


def gen_path(name: str, square: bool = False) -> str:
    return os.path.join(COVERS_DIR, gen_filename(name, square))


# ---------------------------------------------------------------- 数据


def load_catalog() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    path = os.path.join(STORE_DIR, "catalog.json")
    payload = _read_json(path, None)
    if not isinstance(payload, dict):
        raise SystemExit("读不到或解析不了 %s" % path)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return payload, data


def load_details() -> Dict[str, Dict[str, Any]]:
    details = {}
    if not os.path.isdir(DETAILS_DIR):
        return details
    for filename in sorted(n for n in os.listdir(DETAILS_DIR) if n.endswith(".json")):
        data = _read_json(os.path.join(DETAILS_DIR, filename), None)
        if isinstance(data, dict):
            details[filename] = data
    return details


def load_builtin_skills() -> List[Dict[str, Any]]:
    """技能注册表里的内置技能；读失败只打印，不让封面脚本挂掉。"""
    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)
    try:
        from server.skills import registry as skills_registry  # noqa: WPS433
        skills = skills_registry.load_skills()
    except Exception as exc:  # pragma: no cover - 依赖运行时环境
        print("[提示] 读取技能注册表失败，本次只处理 catalog 里的技能: %s" % exc)
        return []
    out = []
    for skill in skills or []:
        if isinstance(skill, dict) and str(skill.get("id") or "").strip():
            out.append(skill)
    return out


def _norm_key(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("_", "-").split())


def collect_targets(catalog_data: Dict[str, Any], builtin_skills: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    targets = []
    seen = set()
    for item in catalog_data.get("items") or []:
        if not isinstance(item, dict) or item.get("kind") != "skill":
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        targets.append({
            "name": name,
            "display_name": str(item.get("display_name") or "").strip(),
            "description": str(item.get("description") or "").strip(),
            "marketing_line": str(item.get("marketing_line") or "").strip(),
            "category": str(item.get("category") or "").strip(),
            "activation_skill": str(item.get("activation_skill") or "").strip(),
            "in_catalog": True,
            "builtin": False,
            "cover_url": str(item.get("cover_url") or ""),
            "cover_poster_url": str(item.get("cover_poster_url") or ""),
        })
    for skill in builtin_skills:
        sid = str(skill.get("id") or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        targets.append({
            "name": sid,
            "display_name": str(skill.get("name") or "").strip(),
            "description": str(skill.get("description") or "").strip(),
            "marketing_line": str(skill.get("description") or "").strip()[:90],
            "category": str(skill.get("category") or "").strip(),
            "activation_skill": sid,
            "in_catalog": False,
            "builtin": True,
            "cover_url": "",
            "cover_poster_url": "",
        })
    return targets


def select_targets(targets: List[Dict[str, Any]], only: str) -> List[Dict[str, Any]]:
    """--only 按「name > 显示名 > activation_skill」优先匹配。

    activation_skill 会重复（例如 fish-audio-lab 被 7 条技能共用），所以只有在前两级都
    没命中时才用它兜底，避免 --only 一条技能把同组的都带出来。
    """
    tokens = [_norm_key(token) for token in str(only or "").split(",") if _norm_key(token)]
    if not tokens:
        return targets
    tiers = ("name", "display_name", "activation_skill")
    picked = []
    for token in tokens:
        matched: List[Dict[str, Any]] = []
        for tier in tiers:
            matched = [t for t in targets if _norm_key(t.get(tier)) == token]
            if matched:
                break
        if not matched:
            print("[警告] --only 没匹配到技能：%s" % token)
            continue
        if len(matched) > 1:
            print("[提示] %s 同时匹配 %d 条技能（%s），请改用 name 精确指定"
                  % (token, len(matched), ", ".join(t["name"] for t in matched)))
        for target in matched:
            if target not in picked:
                picked.append(target)
    return picked


# ---------------------------------------------------------------- 提示词


def build_prompt(target: Dict[str, Any]) -> Tuple[str, str]:
    subject = SUBJECTS.get(target["name"])
    if subject is None and target.get("activation_skill"):
        subject = SUBJECTS.get(target["activation_skill"])
    if subject is not None:
        subject_en, note_zh = subject
    else:
        label = target.get("display_name") or target.get("name")
        subject_en = ("a creative professional workspace that captures the essence of a skill called \"%s\": %s"
                      % (label, target.get("description") or target.get("marketing_line") or label))
        note_zh = (target.get("marketing_line") or target.get("description") or label)[:80]
    prompt_en = ART_DIRECTION_EN.format(subject=subject_en)
    prompt_zh = ART_DIRECTION_ZH.format(note=note_zh)
    return prompt_en, prompt_zh


# ---------------------------------------------------------------- 生图


class CoverError(Exception):
    pass


def post_online_image(host: str, provider: str, model: str, prompt: str, size: str, timeout: float) -> str:
    url = host.rstrip("/") + "/api/online-image"
    body = json.dumps({
        "provider_id": provider,
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise CoverError("HTTP %s：%s" % (exc.code, detail or exc.reason))
    except urllib.error.URLError as exc:
        raise CoverError("连接失败：%s" % (exc.reason,))
    except Exception as exc:  # socket.timeout 等
        raise CoverError("请求异常：%s" % (exc,))
    try:
        payload = json.loads(raw)
    except ValueError:
        raise CoverError("响应不是 JSON：%s" % raw[:300])
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict) and "images" not in payload:
        payload = payload["data"]
    if not isinstance(payload, dict):
        raise CoverError("响应结构异常：%s" % raw[:300])
    if payload.get("detail"):
        raise CoverError("接口返回错误：%s" % str(payload.get("detail"))[:400])
    images = payload.get("images") or []
    if not images:
        raise CoverError("接口没有返回图片：%s" % raw[:300])
    return str(images[0])


def _output_dirs() -> List[str]:
    data_root = os.environ.get("NOVAI_DATA_DIR") or REPO_ROOT
    dirs = [
        os.path.join(data_root, "assets", "output"),
        os.path.join(data_root, "output"),
    ]
    for extra in (os.environ.get("NOVAI_INSTALL_DIR"), os.environ.get("NOVAI_APP_DIR")):
        if extra:
            dirs.append(os.path.join(extra, "assets", "output"))
            dirs.append(os.path.join(extra, "output"))
    return dirs


OUTPUT_DIRS = _output_dirs()


def _local_source_path(url: str) -> Optional[str]:
    """把 /output/... 或 /assets/... 形式的结果 URL 落到本机文件；找不到返回 None。"""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path if parsed.scheme or parsed.netloc else url
    if not path.startswith("/"):
        return None
    if path.startswith("/assets/"):
        relative = path[len("/assets/"):]
        data_root = os.environ.get("NOVAI_DATA_DIR") or REPO_ROOT
        candidates = [os.path.join(root, "assets", relative) for root in (data_root, REPO_ROOT)]
        for extra in (os.environ.get("NOVAI_INSTALL_DIR"), os.environ.get("NOVAI_APP_DIR")):
            if extra:
                candidates.append(os.path.join(extra, "assets", relative))
    elif path.startswith("/output/"):
        relative = path[len("/output/"):]
        candidates = [os.path.join(folder, relative) for folder in OUTPUT_DIRS]
    else:
        return None
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def fetch_image_bytes(url: str, host: str, timeout: float) -> Tuple[bytes, Optional[str]]:
    local = _local_source_path(url)
    if local:
        with open(local, "rb") as fh:
            return fh.read(), local
    if url.startswith("/"):
        url = host.rstrip("/") + url
    request = urllib.request.Request(url, headers={"User-Agent": "NOVAI-store-covers/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), None
    except Exception as exc:
        raise CoverError("下载生成图失败：%s" % (exc,))


def cleanup_source(path: Optional[str]) -> bool:
    """删掉生成过程中落在用户素材目录里的源图（只删本脚本触发生成、带 online_ 前缀的文件）。"""
    if not path or not os.path.isfile(path):
        return False
    if not os.path.basename(path).startswith(GENERATED_FILE_PREFIX):
        print("  [提示] 跳过清理非本脚本生成的源图：%s" % path)
        return False
    real = os.path.abspath(path)
    for folder in OUTPUT_DIRS:
        root = os.path.abspath(folder)
        if real.startswith(root + os.sep):
            try:
                os.remove(real)
                return True
            except OSError as exc:
                print("  [提示] 源图删除失败 %s：%s" % (real, exc))
                return False
    print("  [提示] 源图不在素材目录里，未删除：%s" % real)
    return False


# ---------------------------------------------------------------- 图片处理


def _flatten(img: Any) -> Any:
    from PIL import Image

    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    if img.mode != "RGB":
        return img.convert("RGB")
    return img


def _crop_to_aspect(img: Any, aspect: float) -> Any:
    from PIL import Image

    width, height = img.size
    current = width / float(height)
    if abs(current - aspect) <= ASPECT_TOLERANCE:
        return img
    if current > aspect:
        new_width = int(round(height * aspect))
        left = (width - new_width) // 2
        return img.crop((left, 0, left + new_width, height))
    new_height = int(round(width / aspect))
    top = (height - new_height) // 2
    return img.crop((0, top, width, top + new_height))


def encode_cover(content: bytes) -> Tuple[bytes, Tuple[int, int], bytes, Tuple[int, int]]:
    """源图字节 → (宽图 webp, 宽图尺寸, 方形 webp, 方形尺寸)。"""
    from PIL import Image

    with Image.open(io.BytesIO(content)) as raw:
        raw.load()
        img = _flatten(raw)
    img = _crop_to_aspect(img, WIDE_ASPECT)
    if max(img.size) > WIDE_MAX_EDGE:
        img.thumbnail((WIDE_MAX_EDGE, WIDE_MAX_EDGE), Image.LANCZOS)
    wide = img
    side = min(wide.size)
    left = (wide.size[0] - side) // 2
    top = (wide.size[1] - side) // 2
    square = wide.crop((left, top, left + side, top + side))
    if max(square.size) > SQUARE_MAX_EDGE:
        square = square.resize((SQUARE_MAX_EDGE, SQUARE_MAX_EDGE), Image.LANCZOS)

    wide_buffer = io.BytesIO()
    wide.save(wide_buffer, "WEBP", quality=WEBP_QUALITY, method=6)
    square_buffer = io.BytesIO()
    square.save(square_buffer, "WEBP", quality=WEBP_QUALITY, method=6)
    return wide_buffer.getvalue(), wide.size, square_buffer.getvalue(), square.size


# ---------------------------------------------------------------- 单条任务


def generate_one(target: Dict[str, Any], args: Any, index: int, total: int) -> Dict[str, Any]:
    name = target["name"]
    prompt_en, prompt_zh = build_prompt(target)
    wide_path = gen_path(name)
    square_path = gen_path(name, square=True)
    result = {
        "name": name,
        "display_name": target.get("display_name") or name,
        "ok": False,
        "skipped": False,
        "model": "",
        "attempts": [],
        "duration_s": 0.0,
        "size_requested": args.size,
        "size": "",
        "square_size": "",
        "files": {"wide": os.path.relpath(wide_path, REPO_ROOT), "square": os.path.relpath(square_path, REPO_ROOT)},
        "bytes": {"wide": 0, "square": 0},
        "prompt_en": prompt_en,
        "prompt_zh": prompt_zh,
        "error": "",
        "cleaned": 0,
    }
    if os.path.isfile(wide_path) and os.path.isfile(square_path) and not args.force:
        result["ok"] = True
        result["skipped"] = True
        result["bytes"]["wide"] = os.path.getsize(wide_path)
        result["bytes"]["square"] = os.path.getsize(square_path)
        try:
            from PIL import Image
            with Image.open(wide_path) as img:
                result["size"] = "%dx%d" % img.size
            with Image.open(square_path) as img:
                result["square_size"] = "%dx%d" % img.size
        except Exception:
            pass
        print("[%d/%d] %s 已有封面，跳过（--force 可重生成）" % (index, total, name))
        return result

    started = time.time()
    models = [args.model]
    if args.fallback_model and args.fallback_model != args.model:
        models.append(args.fallback_model)
    content = None
    source_path = None
    used_model = ""
    for scope_index, model in enumerate(models):
        tries = 2 if scope_index == 0 else 1
        for attempt in range(tries):
            if attempt:
                time.sleep(3)
            attempt_started = time.time()
            try:
                url = post_online_image(args.host, args.provider, model, prompt_en, args.size, args.timeout)
                content, source_path = fetch_image_bytes(url, args.host, args.timeout)
                used_model = model
                result["attempts"].append({
                    "model": model, "ok": True, "seconds": round(time.time() - attempt_started, 1), "url": url})
                break
            except CoverError as exc:
                result["attempts"].append({
                    "model": model, "ok": False, "seconds": round(time.time() - attempt_started, 1),
                    "error": str(exc)[:400]})
                result["error"] = str(exc)[:400]
                print("[%d/%d] %s 第 %d 次失败（%s）：%s" % (index, total, name, attempt + 1, model, str(exc)[:200]))
        if content is not None:
            break

    result["duration_s"] = round(time.time() - started, 1)
    if content is None:
        print("[%d/%d] %s 生成失败，保留原封面" % (index, total, name))
        return result

    try:
        wide_bytes, wide_size, square_bytes, square_size = encode_cover(content)
    except Exception as exc:
        result["error"] = "图片处理失败：%s" % (exc,)
        print("[%d/%d] %s 图片处理失败：%s" % (index, total, name, exc))
        return result

    _atomic_write_bytes(wide_path, wide_bytes)
    _atomic_write_bytes(square_path, square_bytes)
    result.update({
        "ok": True,
        "model": used_model,
        "size": "%dx%d" % wide_size,
        "square_size": "%dx%d" % square_size,
        "bytes": {"wide": len(wide_bytes), "square": len(square_bytes)},
        "cleaned": 1 if cleanup_source(source_path) else 0,
    })
    print("[%d/%d] %s 完成 %.1fs %s %s → %s（%.0f KB）/ %s（%.0f KB）" % (
        index, total, name, result["duration_s"], used_model, result["size"],
        gen_filename(name), len(wide_bytes) / 1024.0, gen_filename(name, square=True), len(square_bytes) / 1024.0))
    return result


# ---------------------------------------------------------------- 数据改写


def plan_cover_urls(name: str, square_list: bool) -> Tuple[str, str]:
    wide = gen_url(name)
    square = gen_url(name, square=True)
    return (square, wide) if square_list else (wide, square)


def rewrite_entry(node: Dict[str, Any], name: str, square_list: bool) -> bool:
    """把一条数据的封面指到 gen-*，原值另存；返回是否有变化。"""
    cover, poster = plan_cover_urls(name, square_list)
    changed = False
    if "cover_original_url" not in node:
        node["cover_original_url"] = str(node.get("cover_url") or "")
        changed = True
    if "cover_original_poster_url" not in node:
        node["cover_original_poster_url"] = str(node.get("cover_poster_url") or "")
        changed = True
    if str(node.get("cover_url") or "") != cover:
        node["cover_url"] = cover
        changed = True
    if str(node.get("cover_poster_url") or "") != poster:
        node["cover_poster_url"] = poster
        changed = True
    return changed


def apply_catalog(results: List[Dict[str, Any]], args: Any) -> Dict[str, Any]:
    """把生成成功的条目写回 catalog.json 与 details/*.json。"""
    payload, data = load_catalog()
    done = {item["name"]: item for item in results if item.get("ok")}
    if not done:
        return {"catalog_changed": False, "details_changed": 0, "entries": []}
    touched = []
    for item in data.get("items") or []:
        if not isinstance(item, dict) or item.get("kind") != "skill":
            continue
        name = str(item.get("name") or "").strip()
        if name not in done:
            continue
        before = str(item.get("cover_url") or "")
        if rewrite_entry(item, name, args.square_list):
            touched.append({"file": "catalog.json", "name": name,
                            "before": before, "after": item.get("cover_url")})
    if touched:
        _atomic_write_json(os.path.join(STORE_DIR, "catalog.json"), payload)

    details_changed = 0
    for filename, detail in load_details().items():
        name = str(detail.get("name") or "").strip()
        if name not in done:
            continue
        if rewrite_entry(detail, name, args.square_list):
            _atomic_write_json(os.path.join(DETAILS_DIR, filename), detail)
            details_changed += 1
    return {"catalog_changed": bool(touched), "details_changed": details_changed, "entries": touched}


def restore_originals() -> int:
    """把 cover_url / cover_poster_url 还原成 cover_original_* 里记的原值。"""
    payload, data = load_catalog()
    restored = 0
    for item in data.get("items") or []:
        if not isinstance(item, dict) or item.get("kind") != "skill" or "cover_original_url" not in item:
            continue
        item["cover_url"] = str(item.get("cover_original_url") or "")
        if "cover_original_poster_url" in item:
            item["cover_poster_url"] = str(item.get("cover_original_poster_url") or "")
        restored += 1
    if restored:
        _atomic_write_json(os.path.join(STORE_DIR, "catalog.json"), payload)
    for filename, detail in load_details().items():
        if not isinstance(detail, dict) or "cover_original_url" not in detail:
            continue
        detail["cover_url"] = str(detail.get("cover_original_url") or "")
        if "cover_original_poster_url" in detail:
            detail["cover_poster_url"] = str(detail.get("cover_original_poster_url") or "")
        _atomic_write_json(os.path.join(DETAILS_DIR, filename), detail)
    return restored


# ---------------------------------------------------------------- 主流程


def print_plan(targets: List[Dict[str, Any]], args: Any) -> None:
    print("计划（dry-run，不生成不写盘）：%d 条技能" % len(targets))
    for target in targets:
        prompt_en, prompt_zh = build_prompt(target)
        cover, poster = plan_cover_urls(target["name"], args.square_list)
        print("  - %s（%s）%s" % (target["name"], target.get("display_name") or "-",
                                 "[内置]" if target.get("builtin") else ""))
        print("      cover_url: %s → %s" % (target.get("cover_url") or "<空>", cover))
        print("      poster   : %s → %s" % (target.get("cover_poster_url") or "<空>", poster))
        print("      提示词   : %s" % prompt_zh[:120])
        print("      英文主句 : %s" % prompt_en[:160])


def run(args: Any) -> int:
    payload, catalog_data = load_catalog()
    builtin_skills = load_builtin_skills() if not args.no_builtin else []
    targets = collect_targets(catalog_data, builtin_skills)
    targets = select_targets(targets, args.only)
    if args.limit and args.limit > 0:
        targets = targets[:args.limit]

    print("技能条目：%d（catalog %d + 内置 %d）| 本次处理：%d | 尺寸：%s | 首选模型：%s | 失败退回：%s" % (
        len(collect_targets(catalog_data, builtin_skills)),
        sum(1 for t in collect_targets(catalog_data, builtin_skills) if t.get("in_catalog")),
        sum(1 for t in collect_targets(catalog_data, builtin_skills) if t.get("builtin")),
        len(targets), args.size, args.model, args.fallback_model or "<无>"))
    if not targets:
        print("没有匹配的技能，结束。")
        return 0
    if args.dry_run:
        print_plan(targets, args)
        return 0

    before_bytes = _dir_bytes(COVERS_DIR)
    started_all = time.time()
    results: List[Dict[str, Any]] = []
    batch_size = max(1, args.batch_size)
    for offset in range(0, len(targets), batch_size):
        batch = targets[offset:offset + batch_size]
        with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
            futures = [pool.submit(generate_one, target, args, offset + idx + 1, len(targets))
                       for idx, target in enumerate(batch)]
            for future in as_completed(futures):
                results.append(future.result())
        finished = min(offset + batch_size, len(targets))
        ok = sum(1 for item in results if item.get("ok"))
        if finished < len(targets) or len(targets) > batch_size:
            print("进度 %d/%d：成功 %d、跳过 %d、失败 %d、耗时 %.0fs" % (
                finished, len(targets), ok, sum(1 for i in results if i.get("skipped")),
                sum(1 for i in results if not i.get("ok")), time.time() - started_all))

    results.sort(key=lambda item: item["name"])
    changed = {"catalog_changed": False, "details_changed": 0} if args.no_catalog else apply_catalog(results, args)

    generated = [item for item in results if item.get("ok") and not item.get("skipped")]
    skipped = [item for item in results if item.get("skipped")]
    failed = [item for item in results if not item.get("ok")]
    durations = [item["duration_s"] for item in generated if item.get("duration_s")]
    after_bytes = _dir_bytes(COVERS_DIR)
    summary = {
        "total": len(results),
        "success": len(generated),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_names": [item["name"] for item in failed],
        "avg_seconds": round(sum(durations) / len(durations), 1) if durations else 0.0,
        "elapsed_seconds": round(time.time() - started_all, 1),
        "covers_dir_bytes_before": before_bytes,
        "covers_dir_bytes_after": after_bytes,
        "covers_dir_bytes_added": after_bytes - before_bytes,
        "cleaned_sources": sum(int(item.get("cleaned") or 0) for item in results),
        "catalog_changed": changed.get("catalog_changed", False),
        "details_changed": changed.get("details_changed", 0),
        "model": args.model,
        "fallback_model": args.fallback_model,
        "size_requested": args.size,
        "square_list": bool(args.square_list),
    }
    print("")
    print("== 汇总 ==")
    print("总数 %d | 成功 %d | 跳过 %d | 失败 %d | 平均 %.1fs | 总耗时 %.0fs" % (
        summary["total"], summary["success"], summary["skipped"], summary["failed"],
        summary["avg_seconds"], summary["elapsed_seconds"]))
    print("封面目录 %.2f MB → %.2f MB（+%.2f MB）| 清理源图 %d 张 | catalog 改写 %s | details 改写 %d 个" % (
        before_bytes / 1048576.0, after_bytes / 1048576.0, summary["covers_dir_bytes_added"] / 1048576.0,
        summary["cleaned_sources"], "是" if summary["catalog_changed"] else "否", summary["details_changed"]))
    if failed:
        print("失败清单：")
        for item in failed:
            print("  - %s：%s" % (item["name"], (item.get("error") or "")[:160]))

    if args.report:
        report = dict(summary)
        report["items"] = results
        report["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _atomic_write_json(os.path.abspath(args.report), report)
        print("报告：%s" % os.path.abspath(args.report))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="为应用市场技能生成高清概念图封面（WebP，宽图 + 方形）")
    parser.add_argument("--host", default=DEFAULT_HOST, help="本机后端地址，默认 %s" % DEFAULT_HOST)
    parser.add_argument("--provider", default="modelscope", help="provider_id，默认 modelscope")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="首选模型，默认 %s" % DEFAULT_MODEL)
    parser.add_argument("--fallback-model", default=DEFAULT_FALLBACK_MODEL,
                        help="首选模型失败后改用的模型，默认 %s（传空串关闭）" % DEFAULT_FALLBACK_MODEL)
    parser.add_argument("--size", default=DEFAULT_SIZE, help="请求尺寸 WxH，默认 %s" % DEFAULT_SIZE)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="单张超时秒数，默认 240")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="并发数，默认 2")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH, help="每批数量，默认 10（批间打印进度）")
    parser.add_argument("--only", default="", help="只处理这些技能（逗号分隔，可用 name/显示名/activation_skill）")
    parser.add_argument("--limit", type=int, default=0, help="最多处理 N 条（0 = 全部）")
    parser.add_argument("--force", action="store_true", help="已有 gen-*.webp 也重新生成")
    parser.add_argument("--skip-existing", action="store_true", default=True,
                        help="已有封面跳过（默认行为，显式传更好读）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不生成不写盘")
    parser.add_argument("--no-catalog", action="store_true", help="只生成图片，不改写 catalog / details")
    parser.add_argument("--no-builtin", action="store_true", help="不并入技能注册表里的内置技能")
    parser.add_argument("--square-list", action="store_true",
                        help="cover_url 用方形图（列表卡 48px 更清楚），cover_poster_url 用宽图")
    parser.add_argument("--report", default="", help="把每条结果写成 JSON 报告")
    parser.add_argument("--restore", action="store_true", help="把 cover_url 还原成 cover_original_url 后退出")
    args = parser.parse_args(argv)

    if not os.path.isfile(os.path.join(STORE_DIR, "catalog.json")):
        print("找不到 %s" % os.path.join(STORE_DIR, "catalog.json"))
        return 2
    if args.restore:
        count = restore_originals()
        print("已还原 %d 条技能的封面 URL（catalog + details）" % count)
        return 0
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
