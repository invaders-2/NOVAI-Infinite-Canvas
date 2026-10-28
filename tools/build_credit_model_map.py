#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 server/credits/model_map.json：给每个 provider 模型一个显式价格来源。

规则（对应验收要求 B）：
1. APIMart 同名/别名能命中的：mode=direct，按档位精确计费；
2. 其它 provider：映射到最接近的 APIMart 等价模型，mode=proxy，运行时取该等价模型的
   **最高档价**（不是均价），保证不亏；
3. 实在无法映射的（10 个语音模型、ideogram/luma 等）：mode=conservative，
   成本取该类型全价目表的 **最高价**，绝不静默用中位价。

用法：
    python3 tools/build_credit_model_map.py
    python3 tools/build_credit_model_map.py --providers data/api_providers.json \
        --pricing server/credits/apimart_pricing.json --out server/credits/model_map.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

KIND_OF_LIST = {
    "image_models": "image",
    "video_models": "video",
    "audio_models": "audio",
    "chat_models": "chat",
}

# ---------------------------------------------------------------- 显式映射表
# Lovart 的模型名是 generate_image_<model>[_quality] / generate_video_<model>
PROXY_TABLES: Dict[str, Dict[str, Dict[str, str]]] = {
    "lovart": {
        "image": {
            "gpt_image_2_5_flare": "gpt-image-2.5-flare",
            "gpt_image_2_5_sunburst": "gpt-image-2.5-sunburst",
            "gpt_image_2": "gpt-image-2",
            "gpt_image_1_5": "gpt-image-1.5-official",
            "nano_banana_pro": "gemini-3-pro-image-preview",
            "nano_banana_2": "gemini-3.1-flash-image-preview",
            "nano_banana_2_lite": "gemini-3.1-flash-lite-image",
            "nano_banana": "gemini-2.5-flash-image-preview",
            "seedream_v5_pro": "seedream-5-0-pro",
            "seedream_v5": "seedream-5-0-flash",
            "seedream_v4_5": "seedream-4-5",
            "seedream_v4": "seedream-4-0",
            "flux_2_max": "flux-2-max",
            "flux_2_pro": "flux-2-pro",
            "midjourney": "midjourney",
            "qwen_image3": "qwen-image-3.0",
            "qwen_image3_pro": "qwen-image-3.0-pro",
        },
        "video": {
            "seedance_v2_5": "seedance-2.5",
            "seedance_v2_0": "seedance-2.0",
            "seedance_v2_0_fast": "seedance-2.0-fast",
            "seedance_v2_0_mini": "seedance-2.0-mini",
            "seedance_pro_v1_5": "seedance-1-5-pro",
            "kling_v3": "kling-v3",
            "kling_v3_omni": "kling-v3-omni",
            "kling_v2_6": "kling-v2-6",
            "kling_omni_v1": "kling-video-o1",
            "minimax_h3": "MiniMax-H3",
            "minimax_h3_max": "MiniMax-H3-Max",
            "hailuo_v2_3": "MiniMax-Hailuo-2.3",
            "wan_v2_6": "wan2.6",
            "wan_v3": "wan3.0-video",
            "wan_v3_prime": "wan3.0-video-prime",
            "veo3_1": "veo3.1-quality-ext（veo3.1-quality）",
            "veo3_1_fast": "veo3.1-fast-ext（veo3.1-fast）",
            "veo3": "veo3.1-quality-ext",
            "vidu_q2": "viduq3",
            "gemini_omni_flash": "gemini-omni-flash-preview",
        },
        "chat": {"lovart_agent": "gemini-3.5-flash"},
    },
    "jimeng": {
        "image": {
            "5.0pro": "seedream-5-0-pro",
            "5.0": "seedream-5-0-pro",
            "4.7": "seedream-4-5",
            "4.6": "seedream-4-5",
            "4.5": "seedream-4-5",
            "4.1": "seedream-4-5",
            "4.0": "seedream-4-0",
            "3.1": "seedream-4-0",
            "3.0": "seedream-4-0",
            "jimeng-image-2k": "seedream-4-5",
            "jimeng-image-4k": "seedream-5-0-pro",
        },
        "video": {
            "seedance2.0fast_vip": "seedance-2.0-fast",
            "seedance2.0_vip": "seedance-2.0",
            "seedance2.0": "seedance-2.0",
            "seedance2.0fast": "seedance-2.0-fast",
            "seedance2.0mini": "seedance-2.0-mini",
            "seedance1.5pro": "seedance-1-5-pro",
            "jimeng-video-720p": "seedance-2.0",
            "jimeng-video-1080p": "seedance-2.5",
        },
    },
    "modelscope": {
        "image": {
            "tongyi-mai/z-image-turbo": "z-image-turbo",
            "qwen/qwen-image-2512": "qwen-image-2.0",
            "qwen/qwen-image-edit-2511": "qwen-image-2.0",
            "black-forest-labs/flux.2-klein-9b": "flux-2-flex",
        },
    },
    "agnes-ai": {
        "image": {"agnes_image_2_0_flash": "gpt-image-2.5-ext",
                  "agnes_image_2_1_flash": "gpt-image-2.5-ext",
                  "agnes_image_2_5_flash": "gpt-image-2.5-ext"},
        "video": {"agnes_video_2_5": "seedance-2.5",
                  "agnes_video_2_5_flash": "seedance-2.5",
                  "agnes_video_v2_0": "seedance-2.5"},
        "chat": {"agnes_2_0_flash": "gemini-3.5-flash",
                 "agnes_2_5_flash": "gemini-3.5-flash",
                 "agnes_2_5_pro": "gemini-3-pro-preview",
                 "agnes_2_5_pro_alpha": "gemini-3-pro-preview",
                 "agnes_2_5_pro_beta": "gemini-3-pro-preview",
                 "agnes_3_0_flash": "gemini-3.8-flash"},
    },
    "volcengine": {"chat": {"deepseek_v4_1_flash_260910": "deepseek-v4.1-flash"}},
    "runninghub": {
        "image": {
            "gpt-image-2.0/text-to-image-channel-low-price": "gpt-image-2",
            "gpt-image-2.0/edit-channel-low-price": "gpt-image-2",
            "gpt-image-2/text-to-image-official-stable": "gpt-image-2",
            "gpt-image-2/image-to-image-official-stable": "gpt-image-2",
            "nano-banana/text-to-image-official-stable": "gemini-3-pro-image-preview",
            "nano-banana/edit-official-stable": "gemini-3-pro-image-preview",
        },
        "video": {
            "google/veo3.1-fast/text-to-video-channel-low-price": "veo3.1-fast-ext（veo3.1-fast）",
            "seedance-2.0-global/text-to-video": "seedance-2.0",
            "seedance-2.0-global/image-to-video": "seedance-2.0",
        },
    },
    "codex": {"image": {"gpt_image_2": "gpt-image-2"}, "chat": {"gpt_5_5": "gpt-5.5"}},
    "gemini-cli": {"image": {"auto": "gpt-image-2.5-ext"}, "chat": {"auto": "gemini-3.5-flash"}},
}

# 明确不映射、走 conservative 的模型（记录原因）
# APIMart 的语音模型：价目页没有独立价格，改为生成后按实际用量后付费
POSTPAID_MODELS = {
    "gpt-4o-audio-preview",
    "gpt-4o-audio-preview-2024-10-01",
    "gpt-4o-mini-tts",
    "gpt-audio-mini",
    "gpt-audio-mini-2025-10-06",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "whisper-1",
}

FORCE_CONSERVATIVE = {
    "lovart": {
        "image": {"generate_image_luma_uni_1", "generate_image_istro", "generate_image_ideogram_v4",
                  "generate_image_p_image_ideogram"},
    },
    "runninghub": {"video": {"sora-2/text-to-video-official-stable"}},
}

BUILTIN_MODELS = [
    ("runninghub", "image", "gpt-image-2.0/text-to-image-channel-low-price"),
    ("runninghub", "image", "gpt-image-2.0/edit-channel-low-price"),
    ("runninghub", "image", "gpt-image-2/text-to-image-official-stable"),
    ("runninghub", "image", "gpt-image-2/image-to-image-official-stable"),
    ("runninghub", "image", "nano-banana/text-to-image-official-stable"),
    ("runninghub", "image", "nano-banana/edit-official-stable"),
    ("runninghub", "video", "google/veo3.1-fast/text-to-video-channel-low-price"),
    ("runninghub", "video", "sora-2/text-to-video-official-stable"),
    ("runninghub", "video", "seedance-2.0-global/text-to-video"),
    ("runninghub", "video", "seedance-2.0-global/image-to-video"),
    ("codex", "image", "gpt-image-2"),
    ("codex", "chat", "gpt-5.5"),
    ("gemini-cli", "image", "auto"),
    ("gemini-cli", "chat", "auto"),
    ("jimeng", "image", "jimeng-image-2k"),
    ("jimeng", "image", "jimeng-image-4k"),
    ("jimeng", "video", "jimeng-video-720p"),
    ("jimeng", "video", "jimeng-video-1080p"),
]


def _norm(name: str) -> str:
    text = str(name or "").strip().lower()
    text = re.sub(r"^generate_(image|video)_", "", text)
    text = re.sub(r"_(low|medium|high|xhigh|max|ultra)$", "", text)
    return text.replace("-", "_")


def _strict_resolve(pricing: Dict[str, Any], name: str) -> Optional[str]:
    models = pricing.get("models") or {}
    aliases = pricing.get("alias_map") or {}
    key = str(name or "").strip()
    for candidate in (key, key.lower(), re.sub(r"[^a-z0-9]+", "", key.lower())):
        if candidate in models:
            return candidate
        target = aliases.get(candidate)
        if target and target in models:
            return target
    return None


def _canon(name: str) -> str:
    text = str(name or "").strip().lower()
    text = re.sub(r"^generate_(image|video)_", "", text)
    return text.replace("_", "-").replace(".", "-").replace(" ", "-")


def _candidate_names(model: str) -> List[str]:
    raw = str(model or "").strip().lower()
    stripped = re.sub(r"^generate_(image|video)_", "", raw)
    base = re.sub(r"_(low|medium|high|xhigh|max|ultra)$", "", stripped)
    names = [raw, stripped, base, base.replace("_", "-"), stripped.replace("_", "-")]
    seen = []
    for name in names:
        if name and name not in seen:
            seen.append(name)
    return seen


def _table_lookup(provider: str, kind: str, model: str) -> Optional[str]:
    table = (PROXY_TABLES.get(provider) or {}).get(kind) or {}
    for candidate in _candidate_names(model):
        if candidate in table:
            return table[candidate]
        for key, value in table.items():
            if _canon(key) == _canon(candidate):
                return value
    return None


def _conservative_values(pricing: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    models = pricing.get("models") or {}
    best: Dict[str, Dict[str, Any]] = {}
    for model_id, record in models.items():
        category = record.get("category")
        for tier in record.get("tiers") or []:
            gold = (tier.get("gold") or {}).get("usd")
            if gold in (None, "") or float(gold) <= 0:
                continue
            unit = tier.get("unit")
            value = float(gold)
            group = "%s:%s" % (category, unit)
            if group not in best or value > best[group]["usd"]:
                best[group] = {"usd": value, "model": model_id, "spec": tier.get("spec"), "unit": unit}
        # chat 的 token 价在 token_rates 里
        for key, block in (record.get("token_rates") or {}).items():
            gold = ((block.get("gold") or {}).get("usd"))
            if gold in (None, "") or float(gold) <= 0:
                continue
            group = "%s:%s" % (category, key)
            value = float(gold)
            if group not in best or value > best[group]["usd"]:
                best[group] = {"usd": value, "model": model_id, "spec": key, "unit": "per_1m_tokens"}

    def pick(*keys):
        return max((best[key] for key in keys if key in best), key=lambda item: item["usd"], default=None)

    image = pick("image:per_image", "image:per_call")
    # 视频优先按秒的最高价（未知时长也能覆盖）；没有按秒价才退回按次
    video = pick("video:per_second") or pick("video:per_call")
    audio = pick("audio:per_call") or pick("audio:per_second")
    chat_in = pick("chat:text_input", "chat:image_input", "chat:input")
    chat_out = pick("chat:text_output", "chat:image_output", "chat:output")
    return {
        "image": {"usd": image["usd"] if image else 0.6, "unit": image["unit"] if image else "per_image",
                  "source_model": image["model"] if image else "", "source_spec": image["spec"] if image else ""},
        "video": {"usd": video["usd"] if video else 0.8, "unit": video["unit"] if video else "per_second",
                  "source_model": video["model"] if video else "", "source_spec": video["spec"] if video else ""},
        "audio": {"usd": audio["usd"] if audio else 1.0, "unit": audio["unit"] if audio else "per_call",
                  "source_model": audio["model"] if audio else "", "source_spec": audio["spec"] if audio else ""},
        "chat": {"input_usd": chat_in["usd"] if chat_in else 10.0,
                 "output_usd": chat_out["usd"] if chat_out else 50.0,
                 "source_model_in": chat_in["model"] if chat_in else "",
                 "source_model_out": chat_out["model"] if chat_out else "",
                 "unit": "per_1m_tokens"},
    }


def build(providers: List[Dict[str, Any]], pricing: Dict[str, Any]) -> Dict[str, Any]:
    entries: Dict[str, Dict[str, Any]] = {}
    configured = 0

    def add(provider: str, kind: str, model: str, target: Optional[str], mode: str,
            note: str = "", quality: str = "") -> None:
        key = "%s|%s|%s" % (provider, kind, model)
        entries[key] = {
            "provider": provider,
            "kind": kind,
            "model": model,
            "target": target or "",
            "mode": mode,
            "quality": quality,
            "note": note,
        }

    def classify(provider: str, kind: str, model: str) -> None:
        if provider == "apimart" and kind == "audio" and model in POSTPAID_MODELS:
            add(provider, kind, model, "", "postpaid", "APIMart 语音后付费：生成完成后按实际用量扣")
            return
        forced = ((FORCE_CONSERVATIVE.get(provider) or {}).get(kind) or set())
        if model in forced:
            add(provider, kind, model, "", "conservative", "显式排除：无常量等价模型")
            return
        target = None
        if provider == "apimart":
            target = _strict_resolve(pricing, model)
        else:
            target = _table_lookup(provider, kind, model)
        if not target:
            # 通用启发式：去掉 generate_ 前缀/质量后缀后直接找价目同名/别名
            for candidate in _candidate_names(model):
                target = _strict_resolve(pricing, candidate) or _strict_resolve(pricing, candidate.replace("_", "-"))
                if target:
                    break
        if provider == "apimart":
            if target:
                record = (pricing.get("models") or {}).get(target) or {}
                if record.get("category") == kind:
                    add(provider, kind, model, target, "direct")
                    return
            add(provider, kind, model, "", "conservative", "APIMart 价目表无此模型（语音）")
            return
        if target:
            record = (pricing.get("models") or {}).get(target) or {}
            if record.get("category") != kind:
                target = None
        quality = ""
        match = re.search(r"_(low|medium|high|xhigh|max|ultra)$", str(model).lower())
        if match:
            quality = match.group(1)
        if target:
            add(provider, kind, model, target, "proxy", "映射到 APIMart 等价模型，按最高档价", quality)
        else:
            add(provider, kind, model, "", "conservative", "无等价模型，按类型最高价", quality)

    for provider in providers:
        pid = str(provider.get("id") or "")
        for list_key, kind in KIND_OF_LIST.items():
            for model in provider.get(list_key) or []:
                name = str(model or "").strip()
                if not name:
                    continue
                configured += 1
                classify(pid, kind, name)

    builtin = 0
    for pid, kind, model in BUILTIN_MODELS:
        key = "%s|%s|%s" % (pid, kind, model)
        if key in entries:
            continue
        builtin += 1
        classify(pid, kind, model)

    counts = {"direct": 0, "proxy": 0, "conservative": 0, "postpaid": 0}
    for entry in entries.values():
        counts[entry["mode"]] = counts.get(entry["mode"], 0) + 1
    uncovered = sum(1 for entry in entries.values()
                    if not entry["target"] and entry["mode"] not in ("conservative", "postpaid"))
    return {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": {"providers": "data/api_providers.json", "pricing": "server/credits/apimart_pricing.json"},
        "entries": entries,
        "conservative": _conservative_values(pricing),
        "coverage": {
            "configured_models": configured,
            "builtin_models": builtin,
            "total_entries": len(entries),
            "direct": counts.get("direct", 0),
            "proxy": counts.get("proxy", 0),
            "conservative": counts.get("conservative", 0),
            "postpaid": counts.get("postpaid", 0),
            "uncovered": uncovered,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成积分模型映射表")
    parser.add_argument("--providers", default=os.path.join(_ROOT, "data", "api_providers.json"))
    parser.add_argument("--pricing", default=os.path.join(_ROOT, "server", "credits", "apimart_pricing.json"))
    parser.add_argument("--out", default=os.path.join(_ROOT, "server", "credits", "model_map.json"))
    args = parser.parse_args()
    with open(args.providers, "r", encoding="utf-8") as handle:
        providers = json.load(handle)
    with open(args.pricing, "r", encoding="utf-8") as handle:
        pricing = json.load(handle)
    payload = build(providers, pricing)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    coverage = payload["coverage"]
    print("[model-map] %s" % args.out)
    print("[model-map] configured=%d builtin=%d entries=%d direct=%d proxy=%d conservative=%d postpaid=%d uncovered=%d" % (
        coverage["configured_models"], coverage["builtin_models"], coverage["total_entries"],
        coverage["direct"], coverage["proxy"], coverage["conservative"], coverage.get("postpaid", 0),
        coverage["uncovered"]))
    print("[model-map] conservative: %s" % json.dumps(payload["conservative"], ensure_ascii=False))
    return 0 if coverage["uncovered"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
