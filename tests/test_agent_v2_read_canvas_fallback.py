# -*- coding: utf-8 -*-
"""P1 回归：画布地图带 canvas_id + 读工具执行器回落本次运行画布。

真实验收（_verification-beat-agent-v2/acceptance/）里模型把画布标题当 canvas_id 提交，
2/2 次自然 run 的首次 read_node 都报「画布不存在」。这里覆盖三件事：
1) 地图首行带真实画布 ID；
2) 读工具三种输入（不给 / 给标题这种错值 / 给正确 id）都能读到当前画布；
3) 六个读工具的 schema 不再把 canvas_id 当必填。
另外用真实 producer 跑一次，证明「运行中把 canvas_id 填错」的步骤仍是成功的。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-v2-canvas-fallback-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from server.agent_core import read_tools  # noqa: E402

CANVAS_ID = "c-fallback-1"
CANVAS_TITLE = "验收-200镜头分镜脚本"
KOU_BO = "凌晨三点，我把最后一盏灯留给了你。"


def canvas_fixture():
    return {
        "id": CANVAS_ID,
        "title": CANVAS_TITLE,
        "kind": "beat",
        "updated_at": 1700000000000,
        "nodes": [
            {"id": "shot_003", "kind": "image", "x": 0, "y": 0,
             "data": {"gen": {"title": "镜头 3｜收束",
                              "prompt": "雨夜天台，女主背对镜头望向城市灯海，镜头缓慢推近，冷蓝色调，"
                                        "电影质感，雨水打在栏杆上反光，远处霓虹失焦。口播：" + KOU_BO,
                              "hist": [{"url": "/out/shot_003.png"}]}}},
            {"id": "tb1", "kind": "table", "x": 300, "y": 0,
             "data": {"table": {"columns": ["提示词", "演员"],
                                "rows": [["凌晨三点的独白", "女主"], ["第二行", "男主"]]}}},
        ],
        "connections": [],
    }


class _LoadCanvasPatch(object):
    """只认本次运行画布：别的 id 一律 404（模拟真实的「画布不存在」）。"""

    def __init__(self, canvas):
        self.canvas = canvas
        self.original = None

    def __enter__(self):
        self.original = main.load_canvas

        def fake_load(canvas_id):
            if str(canvas_id or "") == CANVAS_ID:
                return self.canvas
            raise HTTPException(status_code=404, detail="画布不存在")

        main.load_canvas = fake_load
        return self

    def __exit__(self, *exc):
        main.load_canvas = self.original
        return False


class ReadToolCanvasFallbackTests(unittest.TestCase):
    def setUp(self):
        self.canvas = canvas_fixture()
        self.entries = main._agent_v2_read_tool_entries()
        self.canvas_token = main._AGENT_RUN_CANVAS_ID.set(CANVAS_ID)
        self.loader = _LoadCanvasPatch(self.canvas).__enter__()

    def tearDown(self):
        self.loader.__exit__()
        main._AGENT_RUN_CANVAS_ID.reset(self.canvas_token)
        main._AGENT_RUN_BASELINE.set(None)

    def run_tool(self, name, args):
        """跑一遍 validate + run，返回 (归一后的参数, 工具结果)。参数里的 canvas_id 就是回落结果。"""
        entry = self.entries[name]
        norm = entry["validate"](args)
        return norm, entry["run"](norm)

    # --- 1) 三种输入都读到当前画布 ---
    def test_read_node_without_canvas_id_uses_current(self):
        norm, out = self.run_tool("read_node", {"node_ids": ["shot_003"]})
        self.assertEqual(norm["canvas_id"], CANVAS_ID, "没填 canvas_id：用本次运行画布")
        self.assertEqual(out["nodes"][0]["id"], "shot_003")
        self.assertIn(KOU_BO, out["nodes"][0]["prompt"])

    def test_read_node_with_title_as_canvas_id_falls_back(self):
        """真实验收里的错法：模型把画布标题当 canvas_id。"""
        norm, out = self.run_tool("read_node", {"canvas_id": CANVAS_TITLE, "node_ids": ["shot_003"]})
        self.assertEqual(norm["canvas_id"], CANVAS_ID, "标题当 id：回落到本次运行画布，并把真实 id 写回参数")
        self.assertIn(KOU_BO, out["nodes"][0]["prompt"])

    def test_read_node_with_correct_canvas_id(self):
        norm, out = self.run_tool("read_node", {"canvas_id": CANVAS_ID, "node_ids": ["shot_003"]})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertIn(KOU_BO, out["nodes"][0]["prompt"])

    # --- 其余四个要 canvas_id 的读工具同样回落 ---
    def test_other_read_tools_with_wrong_canvas_id(self):
        norm, out = self.run_tool("search_canvas", {"canvas_id": CANVAS_TITLE, "query": "凌晨三点"})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertGreaterEqual(out["total"], 1)
        self.assertIn("shot_003", [n["id"] for n in out["nodes"]])

        norm, out = self.run_tool("read_table", {"canvas_id": CANVAS_TITLE, "node_id": "tb1"})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertEqual(out["row_count"], 2)
        self.assertEqual(out["rows"][0]["cells"][0], "凌晨三点的独白")

        norm, out = self.run_tool("view_image", {"canvas_id": CANVAS_TITLE, "node_id": "shot_003"})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertEqual(out["view_images"][0]["url"], "/out/shot_003.png")

        norm, out = self.run_tool("canvas_diff", {"canvas_id": CANVAS_TITLE})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertIn("available", out, "canvas_diff 不该因为 canvas_id 写错就抛错")

    def test_other_read_tools_without_canvas_id(self):
        norm, out = self.run_tool("search_canvas", {"query": "镜头"})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertGreaterEqual(out["total"], 1)
        norm, out = self.run_tool("read_table", {"node_id": "tb1"})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertEqual(out["row_count"], 2)
        norm, out = self.run_tool("view_image", {"node_id": "shot_003"})
        self.assertEqual(out["view_images"][0]["url"], "/out/shot_003.png")
        norm, out = self.run_tool("canvas_diff", {})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertIn("available", out)

    def test_unknown_canvas_id_no_longer_fatal(self):
        """模型编一个不存在的 id 也一样回落到本次运行画布，不当致命错误。"""
        norm, out = self.run_tool("read_node", {"canvas_id": "no-such-canvas", "node_ids": ["shot_003"]})
        self.assertEqual(norm["canvas_id"], CANVAS_ID)
        self.assertIn(KOU_BO, out["nodes"][0]["prompt"])

    def test_real_other_canvas_still_honored(self):
        """模型真的要看另一张（存在的）画布时照旧读那张，不被硬性覆盖。"""
        other = {"id": "c-other", "title": "另一张", "nodes": [], "connections": []}
        original = main.load_canvas

        def fake_load(canvas_id):
            if str(canvas_id) == "c-other":
                return other
            if str(canvas_id) == CANVAS_ID:
                return self.canvas
            raise HTTPException(status_code=404, detail="画布不存在")

        main.load_canvas = fake_load
        try:
            entry = self.entries["canvas_diff"]
            norm = entry["validate"]({"canvas_id": "c-other"})
            self.assertEqual(norm["canvas_id"], "c-other")
        finally:
            main.load_canvas = original

    # --- 2) 地图首行带真实画布 ID ---
    def test_canvas_map_header_carries_canvas_id(self):
        summary = main._agent_canvas_summary(self.canvas, map_mode=True, focus_ids=["shot_003"])
        text = summary["canvas_map"]
        self.assertIn("画布 ID：" + CANVAS_ID, text)
        self.assertIn(CANVAS_TITLE, text)
        self.assertIn("canvas_id 就填上面这个画布 ID", text)

    # --- 3) schema 不再把 canvas_id 当必填 ---
    def test_schemas_do_not_require_canvas_id(self):
        for name in ("read_node", "search_canvas", "read_table", "canvas_diff", "view_image"):
            schema = read_tools.TOOL_SPECS[name]["schema"]
            self.assertNotIn("canvas_id", schema.get("required") or [], name)
            self.assertIn("不填就用本次运行", schema["properties"]["canvas_id"]["description"], name)
        self.assertEqual(read_tools.TOOL_SPECS["recall_step"]["schema"]["required"], ["index"])

    # --- 开关关闭时对外行为面不变 ---
    def test_flag_off_surface_unchanged(self):
        if main._agent_v2_read_tools_enabled():
            self.skipTest("本进程 import 时开关是开的，跳过「关掉时不变」的断言")
        self.assertNotIn("read_node", main.AGENT_TOOLS)
        self.assertNotIn("search_canvas", main.AGENT_TOOLS)
        self.assertNotIn("read_node", main.AGENT_RUN_STEP_FREE_TOOLS)
        self.assertEqual(main._agent_v2_read_first_hint(), "")
        from server.agents import cli_spec
        self.assertNotIn("node.read", cli_spec.COMMANDS)
        self.assertEqual(len(cli_spec.COMMANDS), 26)


def _parse_events(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str):
            continue
        event = data = None
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if event:
            events.append({"event": event, "data": data})
    return events


class ProducerCanvasIdFallbackTests(unittest.TestCase):
    """真实 producer：模型第一轮就把画布标题当 canvas_id，步骤仍要成功。"""

    @classmethod
    def setUpClass(cls):
        data_dir = str(main.DATA_DIR)
        if not data_dir.startswith(tempfile.gettempdir()):
            cls.canvas_id = ""
            return
        cls.canvas_id = "c-prod-" + uuid.uuid4().hex[:8]
        cls.title = "验收-生产链路"
        cls.kou_bo = KOU_BO
        main.save_canvas({
            "id": cls.canvas_id, "title": cls.title, "kind": "beat",
            "updated_at": int(main.time.time() * 1000),
            "nodes": [{"id": "shot_003", "kind": "text", "x": 0, "y": 0,
                       "text": "第三个镜头：口播「" + cls.kou_bo + "」", "data": {}}],
            "connections": [],
        })

    def setUp(self):
        if not self.canvas_id:
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")

    def tearDown(self):
        pass

    def test_wrong_canvas_id_step_succeeds_in_real_run(self):
        decisions = [
            {"thought": "先读第三个镜头",
             "steps": [{"tool": "read_node",
                        "args": {"canvas_id": self.title, "node_ids": ["shot_003"]}}]},
            {"done": True, "message": "读到了"},
        ]
        seen = []

        async def fake_decide(chat, messages, canvas_id, tools_json_text="", tools=None):
            seen.append([dict(m) for m in messages])
            return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

        async def go():
            req = {
                "canvas_id": self.canvas_id,
                "run_id": "run_" + uuid.uuid4().hex[:12],
                "instruction": "第三个镜头的口播是什么",
                "focus": main._agent_run_normalize_focus(None),
                "history": [],
                "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                         "model": "test-chat-model", "provider_cfg": {"protocol": "custom"}},
                "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
            }
            queue = asyncio.Queue()
            await main._agent_run_producer(req, queue)
            chunks = []
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                chunks.append(item)
            return _parse_events(chunks)

        # 开关在 import 时就决定了 AGENT_TOOLS 里有没有读工具；这里临时挂上、测完原地还原，
        # 不能把读工具漏给同一 pytest 进程里后面的用例。
        saved_tools = dict(main.AGENT_TOOLS)
        saved_free = set(main.AGENT_RUN_STEP_FREE_TOOLS)
        try:
            main.AGENT_TOOLS.update(main._agent_v2_read_tool_entries())
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                    patch.object(main, "_agent_run_decide_v2", new=AsyncMock(side_effect=fake_decide)):
                events = asyncio.run(go())
        finally:
            main.AGENT_TOOLS.clear()
            main.AGENT_TOOLS.update(saved_tools)
            main.AGENT_RUN_STEP_FREE_TOOLS.clear()
            main.AGENT_RUN_STEP_FREE_TOOLS.update(saved_free)

        steps = [e for e in events if e["event"] == "step_result"]
        self.assertTrue(steps, "没有 step_result 事件")
        self.assertTrue(steps[0]["data"]["ok"], steps[0]["data"])
        self.assertEqual(steps[0]["data"]["tool"], "read_node")
        done = next(e for e in events if e["event"] == "done")["data"]
        self.assertEqual(done["status"], "ok", done)
        self.assertFalse([x for x in (done.get("message") or "").split("失败记录")[1:]], done.get("message"))
        self.assertTrue(seen, "模型没有被调用")
        flat = "\n".join(str(m.get("content")) for m in seen[-1])
        self.assertIn(KOU_BO, flat, "下一轮消息里要看得到 read_node 读回来的原文")


if __name__ == "__main__":
    unittest.main()
