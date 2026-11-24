# -*- coding: utf-8 -*-
"""画布助手评测：拿一组固定任务跑助手，按每条用例的期望打分，出报告；可以和上一次报告对比，看改动后是变好还是变坏。

用法（在仓库根目录）：
    python tools/agent_eval/agent_eval.py --source-data <正式数据目录> --provider <平台> --model <模型>
    python tools/agent_eval/agent_eval.py ... --cases angle-three,split-grid --repeat 3 --baseline <上次的 report.json>

只花对话模型的钱，不花生成额度：智能画布 BEAT 的生成一律停在「待生成卡片」，评测不点执行。
不碰正式数据：每次在临时目录里建独立数据目录，只从 --source-data 复制 API 配置（settings.json /
api_providers.json / API/.env），跑完整个临时目录删掉（--keep 保留以便排查）。
"""
import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CASES_FILE = HERE / "cases.json"
CONFIG_FILES = ("data/settings.json", "data/api_providers.json", "API/.env")
GENERATION_TOOLS = ("generate_image", "generate_video", "batch_generate", "create_node", "run_generation")
EXPECT_KEYS = {"status", "plan", "asks", "tools_any", "tools_all", "tools_none", "actions", "actions_any",
               "new_nodes", "new_nodes_max", "max_rounds", "reply_any", "generations_min"}
NODE_KINDS = {"image", "video", "text", "table", "audio", "group", "prompt", "batch", "timeline"}


# ---------------------------------------------------------------------------
# 用例
# ---------------------------------------------------------------------------

def load_cases(path=CASES_FILE, only=None):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    cases = data.get("cases") or []
    problems = validate_cases(cases)
    if problems:
        raise ValueError("用例文件有问题：\n" + "\n".join(problems))
    if only:
        wanted = [c.strip() for c in only if c.strip()]
        missing = [c for c in wanted if c not in {x["id"] for x in cases}]
        if missing:
            raise ValueError("没有这些用例：" + "、".join(missing))
        cases = [c for c in cases if c["id"] in wanted]
    return cases


def validate_cases(cases):
    problems, seen = [], set()
    for idx, case in enumerate(cases):
        where = f"第 {idx + 1} 条（{case.get('id') or '无 id'}）"
        if not case.get("id") or not case.get("instruction"):
            problems.append(where + "：id / instruction 必填")
        if case.get("id") in seen:
            problems.append(where + "：id 重复")
        seen.add(case.get("id"))
        expect = case.get("expect") or {}
        if not expect:
            problems.append(where + "：expect 不能为空")
        unknown = set(expect) - EXPECT_KEYS
        if unknown:
            problems.append(where + "：不认识的检查 " + "、".join(sorted(unknown)))
        node_ids = set()
        for node in (case.get("canvas") or {}).get("nodes") or []:
            if not node.get("id") or node.get("kind") not in NODE_KINDS:
                problems.append(where + f"：画布节点要有 id 和合法 kind（{node}）")
            if node.get("kind") in ("image", "video") and node.get("asset") not in ASSET_MAKERS:
                problems.append(where + f"：节点 {node.get('id')} 的 asset 只能是 " + " / ".join(ASSET_MAKERS))
            node_ids.add(node.get("id"))
        focus = case.get("focus") or {}
        for nid in (focus.get("selected") or []) + (focus.get("references") or []):
            if nid not in node_ids:
                problems.append(where + f"：focus 里的 {nid} 不在画布上")
        for spec in expect.get("new_nodes") or []:
            for nid in spec.get("from") or []:
                if nid not in node_ids:
                    problems.append(where + f"：new_nodes.from 里的 {nid} 不在画布上")
    return problems


# ---------------------------------------------------------------------------
# 占位素材（不依赖网络 / 真实图片：评测看的是助手选对工具没有，不是画质）
# ---------------------------------------------------------------------------

def _img_product(Image, ImageDraw):
    img = Image.new("RGB", (768, 768), (232, 232, 232))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((180, 380, 600, 540), radius=60, fill=(250, 250, 250), outline=(180, 180, 180), width=6)
    d.ellipse((200, 500, 600, 580), fill=(70, 70, 70))
    d.line((300, 420, 480, 420), fill=(120, 120, 120), width=8)
    return img


def _img_grid3(Image, ImageDraw):
    img = Image.new("RGB", (900, 900), (255, 255, 255))
    d = ImageDraw.Draw(img)
    colors = [(230, 90, 80), (240, 170, 60), (240, 220, 80), (120, 200, 110), (80, 180, 200),
              (90, 120, 220), (160, 100, 210), (220, 110, 170), (130, 130, 130)]
    for i, color in enumerate(colors):
        x, y = (i % 3) * 300, (i // 3) * 300
        d.rectangle((x + 8, y + 8, x + 292, y + 292), fill=color)
    return img


def _img_scene(Image, ImageDraw):
    img = Image.new("RGB", (1280, 720), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(720):
        d.line((0, y, 1280, y), fill=(90 + y // 12, 110 + y // 10, 150 + y // 9))
    d.rectangle((0, 520, 1280, 720), fill=(120, 95, 70))
    d.rounded_rectangle((520, 380, 760, 540), radius=20, fill=(240, 240, 240))
    return img


def _img_person(Image, ImageDraw):
    img = Image.new("RGB", (720, 1280), (210, 215, 225))
    d = ImageDraw.Draw(img)
    d.ellipse((290, 160, 430, 300), fill=(230, 190, 160))
    d.rounded_rectangle((250, 300, 470, 760), radius=40, fill=(60, 80, 140))
    d.rectangle((270, 760, 350, 1140), fill=(40, 40, 50))
    d.rectangle((370, 760, 450, 1140), fill=(40, 40, 50))
    return img


ASSET_MAKERS = {"product": _img_product, "grid3": _img_grid3, "scene": _img_scene, "person": _img_person,
                "video": None}


def make_asset(main, kind):
    """画一张占位图 / 写一段 2 秒占位视频，存进（临时数据目录的）output，返回 url。"""
    from PIL import Image, ImageDraw
    if kind == "video":
        name = f"eval_video_{uuid.uuid4().hex[:8]}.mp4"
        path = main.output_path_for(name, "output")
        try:
            import cv2
            import numpy as np
            writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 12, (640, 360))
            for i in range(24):
                frame = np.full((360, 640, 3), (90, 110, 150), dtype=np.uint8)
                cv2.rectangle(frame, (60 + i * 18, 200), (180 + i * 18, 280), (30, 30, 30), -1)
                writer.write(frame)
            writer.release()
        except Exception:
            Path(path).write_bytes(b"")
        return main.output_url_for(name, "output")
    img = ASSET_MAKERS[kind](Image, ImageDraw)
    name = f"eval_{kind}_{uuid.uuid4().hex[:8]}.png"
    img.save(main.output_path_for(name, "output"), "PNG")
    return main.output_url_for(name, "output")


def build_canvas(main, case, canvas_id):
    nodes = []
    for index, spec in enumerate((case.get("canvas") or {}).get("nodes") or []):
        kind = spec["kind"]
        node = {"id": spec["id"], "kind": kind, "x": (index % 4) * 420, "y": (index // 4) * 420,
                "w": 320, "h": 320 if kind == "image" else 180}
        if kind in ("image", "video"):
            out = {"url": make_asset(main, spec["asset"])}
            if kind == "video":
                out["dur"] = 2
            node["data"] = {"gen": {"title": spec.get("title") or spec["id"], "prompt": spec.get("prompt") or "",
                                    "hist": [out], "hi": 0}}
        elif kind == "text":
            node["data"] = {"text": spec.get("text") or ""}
        nodes.append(node)
    canvas = {"id": canvas_id, "title": "评测 · " + case.get("title", case["id"]), "kind": "beat",
              "updated_at": int(time.time() * 1000), "nodes": nodes, "connections": []}
    main.save_canvas(canvas)
    return canvas


# ---------------------------------------------------------------------------
# 跑一条用例
# ---------------------------------------------------------------------------

def parse_sse(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str):
            continue
        event = data = None
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                try:
                    data = json.loads(line[len("data: "):])
                except ValueError:
                    data = None
        if event:
            events.append({"event": event, "data": data if isinstance(data, dict) else {}})
    return events


async def run_case_async(main, case, chat, timeout=600):
    canvas_id = "eval-" + case["id"] + "-" + uuid.uuid4().hex[:6]
    before = build_canvas(main, case, canvas_id)
    focus = case.get("focus") or {}
    req = {"canvas_id": canvas_id, "run_id": "run_eval_" + uuid.uuid4().hex[:10],
           "instruction": case["instruction"],
           "focus": main._agent_run_normalize_focus({
               "selected_node_ids": list(focus.get("selected") or []),
               "references": [{"id": nid, "source": "node"} for nid in focus.get("references") or []]}),
           "history": [], "thread_id": "", "chat": chat, "max_steps": 0, "mode": "run",
           "approved_steps": [], "renderer": "beat", "use_thread": False, "enforce_write_confirmation": True}
    queue = asyncio.Queue()
    started = time.monotonic()
    error = ""
    try:
        await asyncio.wait_for(main._agent_run_producer(req, queue), timeout=timeout)
    except asyncio.TimeoutError:
        error = f"超时（{timeout} 秒）"
    except Exception as exc:          # 评测要把崩溃记成失败，而不是让整轮评测停掉
        error = f"{type(exc).__name__}: {exc}"
    seconds = round(time.monotonic() - started, 1)
    chunks = []
    while not queue.empty():
        item = queue.get_nowait()
        if item is None:
            break
        chunks.append(item)
    events = parse_sse(chunks)
    try:
        after = main.load_canvas(canvas_id)
    except Exception:
        after = before
    return {"events": events, "before": before, "after": after, "seconds": seconds, "error": error}


# ---------------------------------------------------------------------------
# 打分
# ---------------------------------------------------------------------------

def _subset(want, got):
    for key, val in (want or {}).items():
        if str((got or {}).get(key)).strip().lower() != str(val).strip().lower():
            return False
    return True


def _node_prompt(node):
    gen = ((node.get("data") or {}).get("gen") or {})
    return str(gen.get("prompt") or node.get("text") or "")


def summarize_run(run, main=None):
    events = run["events"]
    steps = [e["data"] for e in events if e["event"] == "step_start"]
    done = next((e["data"] for e in reversed(events) if e["event"] == "done"), {})
    before_ids = {n.get("id") for n in run["before"].get("nodes") or []}
    new_nodes = [n for n in run["after"].get("nodes") or [] if n.get("id") not in before_ids]
    conns = run["after"].get("connections") or []
    generations = 0
    if main is not None:
        for step in steps:
            try:
                generations += int(main._agent_step_generation_units(step.get("tool"), step.get("args") or {}) or 0)
            except Exception:
                pass
    return {
        "tools": [s.get("tool") for s in steps],
        "actions": [dict((s.get("args") or {}).get("params") or {}, action=(s.get("args") or {}).get("action"))
                    for s in steps if s.get("tool") == "canvas_action"],
        "plan": any(e["event"] == "plan" and (e["data"].get("kind") == "generation"
                                               or e["data"].get("requires_confirmation")) for e in events),
        "status": str(done.get("status") or ("error" if run.get("error") else "")),
        "rounds": int(done.get("rounds") or 0),
        "message": str(done.get("message") or ""),
        "failures": list(done.get("failures") or []),
        "new_nodes": new_nodes,
        "connections": conns,
        "generations": generations,
    }


def score_case(case, summary, error=""):
    expect = case.get("expect") or {}
    checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    if error:
        check("运行没有崩溃", False, error)
    if "status" in expect:
        check("结束状态", summary["status"] in expect["status"], f"实际 {summary['status'] or '无'}")
    if "plan" in expect:
        check("出待生成卡片" if expect["plan"] else "不出待生成卡片", summary["plan"] == bool(expect["plan"]))
    if "asks" in expect:
        msg = summary["message"]
        asked = "novai-questions" in msg or "？" in msg or "?" in msg
        check("先问用户" if expect["asks"] else "不反问", asked == bool(expect["asks"]), msg[:80])
    used = summary["tools"]
    if expect.get("tools_any"):
        check("用了其中一个工具：" + "/".join(expect["tools_any"]), any(t in used for t in expect["tools_any"]),
              "实际 " + ("、".join(used) or "无"))
    for tool in expect.get("tools_all") or []:
        check("用了 " + tool, tool in used, "实际 " + ("、".join(used) or "无"))
    for tool in expect.get("tools_none") or []:
        check("没用 " + tool, tool not in used)
    acts = summary["actions"]
    for spec in expect.get("actions") or []:
        hits = [a for a in acts if a.get("action") == spec["action"] and _subset(spec.get("params"), a)]
        need = int(spec.get("min") or 1)
        label = "组件 " + spec["action"] + (f" {spec['params']}" if spec.get("params") else "") + (f" ×{need}" if need > 1 else "")
        check(label, len(hits) >= need, "实际 " + (json.dumps(acts, ensure_ascii=False)[:160] or "无"))
    if expect.get("actions_any"):
        ok = any(a.get("action") == spec["action"] and _subset(spec.get("params"), a)
                 for spec in expect["actions_any"] for a in acts)
        check("组件其一：" + " / ".join(s["action"] for s in expect["actions_any"]), ok,
              "实际 " + (json.dumps(acts, ensure_ascii=False)[:160] or "无"))
    new_nodes = summary["new_nodes"]
    for spec in expect.get("new_nodes") or []:
        pool = [n for n in new_nodes if n.get("kind") == spec["kind"]]
        if spec.get("from"):
            pool = [n for n in pool if any(c.get("from") in spec["from"] and c.get("to") == n.get("id")
                                           for c in summary["connections"])]
        if spec.get("prompt_any"):
            pool = [n for n in pool if any(k.lower() in _node_prompt(n).lower() for k in spec["prompt_any"])]
        if spec.get("mode"):
            pool = [n for n in pool if str((((n.get("data") or {}).get("gen") or {}).get("params") or {}).get("mode"))
                    == spec["mode"]]
        need = int(spec.get("min") or 1)
        bits = [spec["kind"]] + (["接自 " + "/".join(spec["from"])] if spec.get("from") else []) \
            + (["提示词含 " + "/".join(spec["prompt_any"])] if spec.get("prompt_any") else []) \
            + (["方式 " + spec["mode"]] if spec.get("mode") else [])
        check(f"新节点 ≥{need}：" + "，".join(bits), len(pool) >= need, f"符合 {len(pool)} 个，新节点共 {len(new_nodes)} 个")
    if "new_nodes_max" in expect:
        check(f"新节点 ≤{expect['new_nodes_max']}", len(new_nodes) <= int(expect["new_nodes_max"]),
              f"实际 {len(new_nodes)} 个")
    if "max_rounds" in expect:
        check(f"轮数 ≤{expect['max_rounds']}", 0 < summary["rounds"] <= int(expect["max_rounds"]) or
              (summary["rounds"] == 0 and not error), f"实际 {summary['rounds']} 轮")
    if expect.get("reply_any"):
        check("回复提到：" + "/".join(expect["reply_any"]),
              any(k in summary["message"] for k in expect["reply_any"]), summary["message"][:80])
    if "generations_min" in expect:
        check(f"计划生成 ≥{expect['generations_min']} 次", summary["generations"] >= int(expect["generations_min"]),
              f"实际 {summary['generations']} 次")
    passed = sum(1 for c in checks if c["ok"])
    return {"passed": bool(checks) and passed == len(checks), "score": round(passed / len(checks), 3) if checks else 0.0,
            "checks": checks}


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------

def build_report(results, meta):
    by_case = {}
    for r in results:
        by_case.setdefault(r["id"], []).append(r)
    rows = []
    for cid, runs in by_case.items():
        rows.append({"id": cid, "title": runs[0]["title"], "category": runs[0]["category"],
                     "runs": len(runs), "pass_rate": round(sum(1 for r in runs if r["passed"]) / len(runs), 3),
                     "score": round(sum(r["score"] for r in runs) / len(runs), 3),
                     "avg_rounds": round(sum(r["rounds"] for r in runs) / len(runs), 1),
                     "avg_seconds": round(sum(r["seconds"] for r in runs) / len(runs), 1),
                     "failed_checks": sorted({c["check"] for r in runs for c in r["checks"] if not c["ok"]})})
    total = len(results)
    return {"meta": meta, "summary": {
        "cases": len(rows), "runs": total,
        "pass_rate": round(sum(1 for r in results if r["passed"]) / total, 3) if total else 0.0,
        "score": round(sum(r["score"] for r in results) / total, 3) if total else 0.0},
        "cases": rows, "runs": results}


def compare(report, baseline):
    old = {c["id"]: c for c in (baseline or {}).get("cases") or []}
    out = []
    for c in report["cases"]:
        prev = old.get(c["id"])
        if prev is None:
            continue
        delta = round(c["score"] - prev["score"], 3)
        if delta:
            out.append({"id": c["id"], "title": c["title"], "before": prev["score"], "after": c["score"], "delta": delta})
    return sorted(out, key=lambda x: x["delta"])


def render_markdown(report, diff=None):
    s, m = report["summary"], report["meta"]
    lines = [f"# 画布助手评测 · {m.get('started', '')}", "",
             f"模型：{m.get('provider', '')} / {m.get('model', '')}　用例 {s['cases']} 条，共跑 {s['runs']} 次", "",
             f"**通过率 {s['pass_rate'] * 100:.0f}%　平均得分 {s['score'] * 100:.0f}**", ""]
    if diff is not None:
        lines += ["## 和上次比", ""]
        if not diff:
            lines.append("各用例得分没有变化。")
        for d in diff:
            lines.append(f"- {'↓' if d['delta'] < 0 else '↑'} {d['title']}（{d['id']}）：{d['before'] * 100:.0f} → {d['after'] * 100:.0f}")
        lines.append("")
    lines += ["## 各用例", "", "| 用例 | 类别 | 通过率 | 得分 | 轮数 | 耗时(秒) | 没过的检查 |", "|---|---|---|---|---|---|---|"]
    for c in report["cases"]:
        lines.append(f"| {c['title']}（{c['id']}） | {c['category']} | {c['pass_rate'] * 100:.0f}% | {c['score'] * 100:.0f} | "
                     f"{c['avg_rounds']} | {c['avg_seconds']} | {'；'.join(c['failed_checks']) or '—'} |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------

def prepare_data_dir(source, target):
    """临时数据目录：只复制 API 配置，正式数据（画布、素材、记忆）一概不带。"""
    copied = []
    for rel in CONFIG_FILES:
        src = Path(source) / rel
        if src.is_file():
            dst = Path(target) / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied.append(rel)
    return copied


def run_all(main, cases, chat, repeat=1, timeout=600, log=print):
    results = []
    for case in cases:
        for attempt in range(repeat):
            log(f"▶ {case['id']}（{attempt + 1}/{repeat}）{case['instruction'][:40]}")
            run = asyncio.run(run_case_async(main, case, chat, timeout=timeout))
            summary = summarize_run(run, main)
            scored = score_case(case, summary, run["error"])
            results.append({"id": case["id"], "title": case.get("title", case["id"]),
                            "category": case.get("category", ""), "attempt": attempt + 1,
                            "passed": scored["passed"], "score": scored["score"], "checks": scored["checks"],
                            "rounds": summary["rounds"], "seconds": run["seconds"], "status": summary["status"],
                            "tools": summary["tools"], "actions": summary["actions"],
                            "generations": summary["generations"], "error": run["error"],
                            "message": summary["message"][:600], "failures": summary["failures"][:6]})
            bad = [c["check"] for c in scored["checks"] if not c["ok"]]
            log(("  ✓ 通过" if scored["passed"] else "  ✗ 没过：" + "；".join(bad)) + f"（{summary['rounds']} 轮，{run['seconds']} 秒）")
    return results


def main_cli(argv=None):
    ap = argparse.ArgumentParser(description="画布助手评测")
    ap.add_argument("--source-data", required=True, help="从这个数据目录复制 API 配置（正式安装版的数据目录）")
    ap.add_argument("--provider", default="", help="对话平台 id（不填=设置里助手默认的）")
    ap.add_argument("--model", default="", help="对话模型（不填=设置里助手默认的）")
    ap.add_argument("--cases", default="", help="只跑这些用例，逗号分隔")
    ap.add_argument("--repeat", type=int, default=1, help="每条跑几次（模型有随机性，3 次更稳）")
    ap.add_argument("--timeout", type=int, default=600, help="单次运行超时秒数")
    ap.add_argument("--out", default="", help="报告目录（默认 tools/agent_eval/reports/<时间>）")
    ap.add_argument("--baseline", default="", help="上一次的 report.json，用来对比")
    ap.add_argument("--keep", action="store_true", help="保留临时数据目录（排查用）")
    args = ap.parse_args(argv)

    cases = load_cases(only=args.cases.split(",") if args.cases else None)
    tmp = tempfile.mkdtemp(prefix="novai-agent-eval-")
    copied = prepare_data_dir(args.source_data, tmp)
    if not copied:
        print(f"在 {args.source_data} 下没找到 API 配置（{', '.join(CONFIG_FILES)}），没法调用对话模型", file=sys.stderr)
        return 2
    os.environ["NOVAI_DATA_DIR"] = tmp
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    try:
        import main as novai_main
        try:
            chat = novai_main._agent_run_resolve_chat(args.provider, args.model, "")
        except Exception as exc:
            print("选不出对话模型：" + str(getattr(exc, "detail", "") or exc), file=sys.stderr)
            return 2
        started = time.strftime("%Y-%m-%d %H:%M")
        results = run_all(novai_main, cases, chat, repeat=max(1, args.repeat), timeout=args.timeout)
        report = build_report(results, {"started": started, "provider": chat.get("provider"),
                                        "model": chat.get("model"), "repeat": args.repeat})
        diff = None
        if args.baseline:
            with open(args.baseline, "r", encoding="utf-8") as fh:
                diff = compare(report, json.load(fh))
            report["diff"] = diff
        out = Path(args.out) if args.out else HERE / "reports" / time.strftime("%Y%m%d-%H%M%S")
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "report.md").write_text(render_markdown(report, diff), encoding="utf-8")
        s = report["summary"]
        print(f"\n通过率 {s['pass_rate'] * 100:.0f}%，平均得分 {s['score'] * 100:.0f}；报告：{out / 'report.md'}")
        return 0
    finally:
        if args.keep:
            print("临时数据目录保留在 " + tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main_cli())
