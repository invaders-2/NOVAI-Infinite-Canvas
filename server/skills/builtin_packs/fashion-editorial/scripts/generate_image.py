#!/usr/bin/env python3
"""
generate_image.py — 多参考图图片生成脚本（服装大片出图引擎）

支持的后端类型（image_backend.type，config.json 或环境变量）：
  openai    : OpenAI 兼容 /images/generations 接口。覆盖 OpenAI gpt-image-1、
              火山方舟即梦 Seedream 4.0（多参考图）、SiliconFlow 及其他兼容服务。
              支持文生图与多参考图图生图（--ref 可重复传入，需后端模型支持多图输入）。
  dashscope : 阿里云百炼 DashScope 异步接口（通义万相 wanx 系列）。仅文生图，
              不支持参考图——服装大片一致性场景请用 openai 类型后端。

配置优先级：环境变量 > config.json
  FE_IMG_BASE_URL / FE_IMG_API_KEY / FE_IMG_MODEL / FE_IMG_SIZE

用法示例：
  # 从拍摄计划逐镜头出图（主流程，推荐）
  python3 generate_image.py --plan outputs/shotplan.json --all
  python3 generate_image.py --plan outputs/shotplan.json --shot full-front --n 2

  # 直接用提示词出图（单张）
  python3 generate_image.py --prompt "..." --negative "..." --size 832x1472

  # 多参考图图生图
  python3 generate_image.py --prompt "..." --ref garment.png --ref model.png --ref scene.png
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_ROOT, "config.json")


def load_image_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = (json.load(f) or {}).get("image_backend") or {}
        except Exception as e:
            sys.stderr.write("[CONFIG] config.json 解析失败：%s\n" % e)
            sys.exit(2)
    merged = {
        "type": os.environ.get("FE_IMG_TYPE") or cfg.get("type") or "openai",
        "base_url": os.environ.get("FE_IMG_BASE_URL") or cfg.get("base_url"),
        "api_key": os.environ.get("FE_IMG_API_KEY") or cfg.get("api_key"),
        "model": os.environ.get("FE_IMG_MODEL") or cfg.get("model"),
        "default_size": cfg.get("default_size") or "832x1472",
        "timeout": cfg.get("timeout", 300),
        "image_as_list": cfg.get("image_as_list", True),
    }
    if not merged["base_url"] or not merged["api_key"] or not merged["model"]:
        sys.stderr.write(
            "[CONFIG] image_backend 未配置。两种方式任选：\n"
            "  1. 复制 config.example.json 为 config.json 并填写 image_backend（type/base_url/api_key/model）\n"
            "  2. 设置环境变量 FE_IMG_BASE_URL / FE_IMG_API_KEY / FE_IMG_MODEL\n"
            "申请指引见 references/api-guide.md\n"
        )
        sys.exit(2)
    return merged


def http_json(url, payload=None, headers=None, method=None, timeout=300):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_download(url, dest_path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        with open(dest_path, "wb") as f:
            f.write(resp.read())


def sanitize_filename(name, maxlen=40):
    name = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", name).strip("_")
    return name[:maxlen] or "image"


def save_b64(b64_str, dest_path):
    with open(dest_path, "wb") as f:
        f.write(base64.b64decode(b64_str))


def generate_openai(cfg, prompt, negative, ref_paths, size, n, seed, output_dir, base_name):
    base_url = cfg["base_url"].rstrip("/")
    payload = {"model": cfg["model"], "prompt": prompt, "n": n, "size": size}
    if negative:
        payload["negative_prompt"] = negative
    if seed is not None:
        payload["seed"] = seed
    if ref_paths:
        b64_list = []
        for p in ref_paths:
            with open(p, "rb") as f:
                b64_list.append(base64.b64encode(f.read()).decode("ascii"))
        # 单参考图传字符串（最大兼容），多参考图传数组（Seedream 4.0 等多图参考模型）
        payload["image"] = b64_list[0] if len(b64_list) == 1 else b64_list
        if len(b64_list) > 1 and not cfg.get("image_as_list", True):
            payload["image"] = b64_list[0]
            sys.stderr.write("[WARN] image_as_list=false：多参考图仅传第一张，一致性会受损\n")

    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["api_key"],
    }
    try:
        body = http_json(base_url + "/images/generations", payload, headers, method="POST",
                         timeout=cfg["timeout"])
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:800]
        sys.stderr.write("[HTTP %s] %s\n" % (e.code, detail))
        sys.exit(1)

    data = body.get("data") or []
    if not data:
        sys.stderr.write("[ERROR] 响应中无图片数据: %s\n" % json.dumps(body, ensure_ascii=False)[:800])
        sys.exit(1)
    results = []
    for i, item in enumerate(data):
        dest = os.path.join(output_dir, "%s_%d.png" % (base_name, i + 1))
        if item.get("b64_json"):
            save_b64(item["b64_json"], dest)
        elif item.get("url"):
            http_download(item["url"], dest)
        else:
            sys.stderr.write("[WARN] 第 %d 张结果既无 b64_json 也无 url，跳过\n" % (i + 1))
            continue
        results.append(dest)
        print("[OK] 已保存 " + dest)
    return results


def generate_dashscope(cfg, prompt, negative, size, n, seed, output_dir, base_name):
    api_key = cfg["api_key"]
    submit_url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + api_key,
        "X-DashScope-Async": "enable",
    }
    payload = {
        "model": cfg["model"],
        "input": {"prompt": prompt},
        "parameters": {"n": n, "size": size},
    }
    if negative:
        payload["input"]["negative_prompt"] = negative
    if seed is not None:
        payload["parameters"]["seed"] = seed
    try:
        body = http_json(submit_url, payload, headers, method="POST", timeout=60)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:800]
        sys.stderr.write("[HTTP %s] %s\n" % (e.code, detail))
        sys.exit(1)
    task_id = (body.get("output") or {}).get("task_id")
    if not task_id:
        sys.stderr.write("[ERROR] 未获取到 task_id: %s\n" % json.dumps(body, ensure_ascii=False)[:800])
        sys.exit(1)
    poll_headers = {"Authorization": "Bearer " + api_key}
    poll_url = "https://dashscope.aliyuncs.com/api/v1/tasks/" + task_id
    deadline = time.time() + cfg["timeout"]
    while time.time() < deadline:
        time.sleep(3)
        task = http_json(poll_url, headers=poll_headers, method="GET", timeout=60)
        status = (task.get("output") or {}).get("task_status")
        if status == "SUCCEEDED":
            results = []
            for i, item in enumerate((task.get("output") or {}).get("results") or []):
                url = item.get("url")
                if not url:
                    continue
                dest = os.path.join(output_dir, "%s_%d.png" % (base_name, i + 1))
                http_download(url, dest)
                results.append(dest)
                print("[OK] 已保存 " + dest)
            if not results:
                sys.stderr.write("[ERROR] 任务成功但无图片 URL\n")
                sys.exit(1)
            return results
        if status in ("FAILED", "CANCELED"):
            sys.stderr.write("[ERROR] 任务失败: %s\n" % json.dumps(task, ensure_ascii=False)[:800])
            sys.exit(1)
        print("[WAIT] 任务状态: %s" % status)
    sys.stderr.write("[ERROR] 任务超时（task_id=%s），请稍后用该 id 查询\n" % task_id)
    sys.exit(1)


def load_plan_shots(plan_path):
    """加载拍摄计划，返回 (plan, shots)；计划中的参考图路径一并返回。"""
    with open(plan_path, "r", encoding="utf-8") as f:
        plan = json.load(f)
    refs = (plan.get("reference_images") or {})
    ref_paths = list(refs.get("look") or []) + list(refs.get("scene") or [])
    missing = [p for p in ref_paths if not os.path.exists(p)]
    if missing:
        sys.stderr.write("[WARN] 计划中的参考图不存在，已跳过：%s\n" % ", ".join(missing))
        ref_paths = [p for p in ref_paths if os.path.exists(p)]
    return plan, plan.get("shots") or [], ref_paths


def main():
    parser = argparse.ArgumentParser(description="多参考图图片生成（服装大片出图引擎）")
    parser.add_argument("--plan", help="shoot_plan.py 输出的 shotplan.json 路径")
    parser.add_argument("--shot", help="配合 --plan：只生成指定 shot_id 的镜头")
    parser.add_argument("--all", action="store_true", help="配合 --plan：生成计划内全部镜头")
    parser.add_argument("--prompt", help="直接指定生成提示词（不用 --plan 时）")
    parser.add_argument("--negative", help="负面提示词（缺省取计划中的 negative_prompt）")
    parser.add_argument("--ref", action="append", default=[], help="参考图路径，可重复传入（覆盖计划中的参考图）")
    parser.add_argument("--size", default=None, help="尺寸，如 832x1472 / 1024x1024")
    parser.add_argument("--n", type=int, default=1, help="每个镜头生成张数")
    parser.add_argument("--seed", type=int, default=None, help="随机种子")
    parser.add_argument("--output", default="./outputs", help="输出目录")
    parser.add_argument("--name", default=None, help="输出文件名前缀")
    parser.add_argument("--model", default=None, help="运行时覆盖出图模型（优先级高于 config/环境变量，出图模型按用户要求切换）")
    args = parser.parse_args()

    cfg = load_image_config()
    if args.model:
        cfg["model"] = args.model
    os.makedirs(args.output, exist_ok=True)

    if args.plan:
        plan, shots, plan_refs = load_plan_shots(args.plan)
        if args.shot:
            shots = [s for s in shots if s.get("shot_id") == args.shot]
            if not shots:
                sys.stderr.write("[ERROR] 计划中未找到镜头 '%s'\n" % args.shot)
                sys.exit(1)
        elif not args.all:
            sys.stderr.write("[ERROR] 使用 --plan 时需指定 --shot <id> 或 --all\n")
            sys.exit(1)
        if not shots:
            sys.stderr.write("[ERROR] 计划中没有镜头\n")
            sys.exit(1)
        ref_paths = args.ref or plan_refs
        default_negative = plan.get("negative_prompt") or ""
        all_files = []
        for s in shots:
            sid = s.get("shot_id") or sanitize_filename(s.get("zh_title") or "shot")
            size = args.size or s.get("size") or "832x1472"
            negative = args.negative or default_negative
            base_name = args.name or sid
            if len(shots) > 1:
                sys.stderr.write("[GEN] 镜头 %s（%s）...\n" % (sid, s.get("zh_title", "")))
            if cfg["type"] == "dashscope":
                files = generate_dashscope(cfg, s["en_prompt"], negative, size, args.n,
                                           args.seed, args.output, base_name)
            else:
                files = generate_openai(cfg, s["en_prompt"], negative, ref_paths, size, args.n,
                                        args.seed, args.output, base_name)
            all_files.extend(files)
        print(json.dumps({"files": all_files}, ensure_ascii=False))
        return

    # ---- 直接提示词模式 ----
    if not args.prompt:
        sys.stderr.write("[ERROR] 需要 --plan 或 --prompt\n")
        sys.exit(1)
    size = args.size or cfg["default_size"]
    base_name = args.name or sanitize_filename(args.prompt)
    if cfg["type"] == "dashscope":
        if args.ref:
            sys.stderr.write("[ERROR] dashscope 后端不支持参考图；服装大片请用 openai 类型后端（Seedream 4.0 等）\n")
            sys.exit(1)
        files = generate_dashscope(cfg, args.prompt, args.negative, size, args.n,
                                   args.seed, args.output, base_name)
    else:
        files = generate_openai(cfg, args.prompt, args.negative, args.ref, size, args.n,
                                args.seed, args.output, base_name)
    print(json.dumps({"files": files}, ensure_ascii=False))


if __name__ == "__main__":
    main()
