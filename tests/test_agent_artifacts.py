# -*- coding: utf-8 -*-
"""智能体 run 产物事件：artifact_updated / done.changes.artifacts / 受控下载路由。

用真实 FilesRunContext + 真实 write_html_report（真写文件），只打桩模型决策。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-agent-artifacts-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.agents import store as agent_store  # noqa: E402
from server.agents.context import FilesRunContext  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def parse_events(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str):
            continue
        event, data = None, None
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if event:
            events.append({"event": event, "data": data})
    return events


def run_report_agent():
    """跑一次真实 producer：模型先要求 write_html_report，再返回 done。"""
    run = agent_store.create_run("artifact-agent", agent_store.new_session_id(), files=[], params={},
                                 provider="p", model="m")
    ctx = FilesRunContext(run, {"id": "artifact-agent", "name": "测试产物技能",
                                "skill_prompt": "生成一份 HTML 报告。"}, [], {})
    req = {
        "context": ctx,
        "canvas_id": "",
        "run_id": run["run_id"],
        "instruction": "出一份报告",
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                 "model": "test-chat-model", "provider_cfg": {}},
        "max_steps": 4,
        "mode": "run",
        "approved_steps": [],
    }
    decisions = [
        {"thought": "先写报告",
         "steps": [{"tool": "write_html_report",
                    "args": {"title": "产物测试报告",
                             "sections": [{"title": "结论", "body": "这是测试结论"}]}}]},
        {"done": True, "message": "报告已生成"},
    ]

    async def fake_decide(*args, **kwargs):
        return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

    async def go():
        queue = asyncio.Queue()
        with patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=fake_decide)):
            await main._agent_run_producer(req, queue)
        chunks = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            chunks.append(item)
        return parse_events(chunks)

    events = asyncio.run(go())
    return run, events


class ArtifactEventTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.run_record, cls.events = run_report_agent()
        cls.artifact_events = [e for e in cls.events if e["event"] == "artifact_updated"]
        cls.done = next(e for e in cls.events if e["event"] == "done")

    def test_artifact_updated_event_shape(self):
        self.assertTrue(self.artifact_events, "缺少 artifact_updated 事件")
        files = []
        for item in self.artifact_events:
            files.extend(item["data"]["files"])
        self.assertTrue(files)
        artifact = files[0]
        self.assertEqual(set(artifact.keys()), {"name", "kind", "size", "url"})
        self.assertEqual(artifact["kind"], "html")
        self.assertTrue(artifact["name"].endswith(".html"))
        self.assertGreater(artifact["size"], 0)
        self.assertEqual(artifact["url"], "/api/agent/files/%s" % artifact["name"])

    def test_done_changes_has_artifacts(self):
        changes = self.done["data"]["changes"]
        self.assertIn("artifacts", changes)
        self.assertTrue(changes["artifacts"])
        first = changes["artifacts"][0]
        self.assertEqual(set(first.keys()), {"name", "kind", "size", "url"})
        self.assertEqual(first["kind"], "html")
        # 与 artifact_updated 一致
        event_files = [f for item in self.artifact_events for f in item["data"]["files"]]
        self.assertEqual([f["name"] for f in event_files], [a["name"] for a in changes["artifacts"]])
        # 同时登记进了 run 记录（能力运行侧也能查到）
        record = agent_store.load_run(self.run_record["run_id"])
        self.assertTrue(any(item.get("kind") == "html" for item in record.get("artifacts") or []))

    def test_download_route_serves_artifact(self):
        artifact = self.done["data"]["changes"]["artifacts"][0]
        resp = CLIENT.get(artifact["url"])
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("text/html", resp.headers.get("content-type", ""))
        self.assertIn("产物测试报告", resp.text)

    def test_download_route_rejects_bad_extension(self):
        output_dir = agent_store.run_output_dir(self.run_record["run_id"])
        bad = os.path.join(output_dir, "evil.exe")
        with open(bad, "wb") as fh:
            fh.write(b"x")
        resp = CLIENT.get("/api/agent/files/evil.exe")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不支持的文件类型", resp.json()["detail"])

    def test_download_route_rejects_traversal(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(main.agent_artifact_file("../secret.html"))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx2:
            asyncio.run(main.agent_artifact_file("..\\secret.html"))
        self.assertEqual(ctx2.exception.status_code, 400)

    def test_download_route_missing_is_404(self):
        resp = CLIENT.get("/api/agent/files/no-such-report.html")
        self.assertEqual(resp.status_code, 404)


class CanvasRunArtifactTests(unittest.TestCase):
    """画布助手的 run：文件工具可见、能真写产物、事件与下载都通；越权路径被挡。"""

    def test_file_tools_visible_in_canvas_catalog(self):
        canvas = main.new_canvas("产物工具画布", kind="smart")
        ctx = main._CanvasRunContext({"canvas_id": canvas["id"],
                                      "focus": main._agent_run_normalize_focus(None)})
        tool_names = set(ctx.tools())
        for name in ("read_table", "write_html_report", "write_xlsx"):
            self.assertIn(name, tool_names)
        catalog = {item["name"]: item for item in ctx.tool_catalog()}
        for name in ("read_table", "write_html_report", "write_xlsx"):
            self.assertIn(name, catalog)
        self.assertIn("会写文件", catalog["write_html_report"]["description"])
        self.assertIn("会写文件", catalog["write_xlsx"]["description"])

    def test_canvas_run_emits_artifacts_and_downloads(self):
        canvas = main.new_canvas("产物事件画布", kind="smart")
        req = {
            "canvas_id": canvas["id"],
            "instruction": "生成一份报告",
            "focus": main._agent_run_normalize_focus(None),
            "history": [],
            "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                     "model": "test-chat-model", "provider_cfg": {}},
            "max_steps": 4,
            "mode": "run",
            "approved_steps": [],
        }
        decisions = [
            {"thought": "写报告",
             "steps": [{"tool": "write_html_report",
                        "args": {"name": "canvas-report.html", "title": "画布产物报告",
                                 "sections": [{"title": "结论", "body": "画布助手产出的报告"}]}}]},
            {"done": True, "message": "报告好了"},
        ]

        async def fake_decide(*args, **kwargs):
            return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

        async def go():
            queue = asyncio.Queue()
            with patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=fake_decide)), \
                    patch.object(main, "agent_session_save"):
                await main._agent_run_producer(req, queue)
            chunks = []
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                chunks.append(item)
            return parse_events(chunks)

        events = asyncio.run(go())
        artifact_events = [e for e in events if e["event"] == "artifact_updated"]
        self.assertTrue(artifact_events, "画布 run 没有 artifact_updated 事件")
        files = [f for e in artifact_events for f in e["data"]["files"]]
        self.assertTrue(files)
        artifact = files[0]
        self.assertEqual(artifact["name"], "canvas-report.html")
        self.assertEqual(artifact["kind"], "html")
        self.assertGreater(artifact["size"], 0)
        self.assertEqual(artifact["url"], "/api/agent/files/canvas-report.html")

        step_results = [e["data"] for e in events if e["event"] == "step_result"]
        self.assertTrue(any(item.get("files") == ["canvas-report.html"] for item in step_results),
                        "step_result 里没有带上产出的文件名")
        done = next(e for e in events if e["event"] == "done")
        self.assertEqual([a["name"] for a in done["data"]["changes"]["artifacts"]],
                         ["canvas-report.html"])
        resp = CLIENT.get(artifact["url"])
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("画布产物报告", resp.text)

    def test_out_of_range_write_is_rejected_as_tool_error(self):
        for name in ("../evil.html", "sub/dir/evil.html", "evil.exe", "..\\evil.html"):
            with self.subTest(name=name):
                result = asyncio.run(main.agent_execute_step(
                    "write_html_report", {"name": name, "html": "<p>x</p>"}))
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "artifact_path_rejected")
                self.assertTrue("文件名" in result["error"] or "扩展名" in result["error"])


if __name__ == "__main__":
    unittest.main()
