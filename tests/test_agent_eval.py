# -*- coding: utf-8 -*-
"""助手评测工具本身的测试：用例文件合法、打分规则、报告对比，以及用假模型完整跑通几条用例。"""
import asyncio
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-eval-test-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_fix_main_wiring import chat_config, flags  # noqa: E402

_spec = importlib.util.spec_from_file_location("agent_eval", ROOT / "tools" / "agent_eval" / "agent_eval.py")
agent_eval = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_eval)


def summary(**kw):
    base = {"tools": [], "actions": [], "plan": False, "status": "ok", "rounds": 1, "message": "",
            "failures": [], "new_nodes": [], "connections": [], "generations": 0}
    base.update(kw)
    return base


class CaseFileTests(unittest.TestCase):
    def test_cases_load_and_validate(self):
        cases = agent_eval.load_cases()
        self.assertGreaterEqual(len(cases), 12)
        self.assertEqual(len({c["id"] for c in cases}), len(cases))

    def test_validator_catches_mistakes(self):
        bad = [{"id": "x", "instruction": "做图", "expect": {"typo_check": 1},
                "canvas": {"nodes": [{"id": "a", "kind": "image", "asset": "nope"}]}, "focus": {"selected": ["zz"]}}]
        problems = "\n".join(agent_eval.validate_cases(bad))
        for piece in ("typo_check", "asset", "zz"):
            self.assertIn(piece, problems)

    def test_only_filter(self):
        self.assertEqual([c["id"] for c in agent_eval.load_cases(only=["split-grid"])], ["split-grid"])
        with self.assertRaises(ValueError):
            agent_eval.load_cases(only=["no-such-case"])


class ScoreTests(unittest.TestCase):
    def test_actions_with_params_and_min(self):
        case = {"expect": {"actions": [{"action": "angle", "min": 3}, {"action": "split", "params": {"cols": 3}}]}}
        s = summary(actions=[{"action": "angle", "yaw": 45}] * 3 + [{"action": "split", "cols": 3, "rows": 3}])
        self.assertTrue(agent_eval.score_case(case, s)["passed"])
        s = summary(actions=[{"action": "angle"}] * 2 + [{"action": "split", "cols": 2, "rows": 2}])
        res = agent_eval.score_case(case, s)
        self.assertFalse(res["passed"])
        self.assertEqual(res["score"], 0.0)

    def test_new_nodes_from_prompt_and_mode(self):
        node = {"id": "n1", "kind": "video", "data": {"gen": {"prompt": "把靴子换成运动鞋", "params": {"mode": "视频编辑"}}}}
        case = {"expect": {"new_nodes": [{"kind": "video", "from": ["clip"], "prompt_any": ["运动鞋"], "mode": "视频编辑"}]}}
        ok = summary(new_nodes=[node], connections=[{"from": "clip", "to": "n1"}])
        self.assertTrue(agent_eval.score_case(case, ok)["passed"])
        self.assertFalse(agent_eval.score_case(case, summary(new_nodes=[node]))["passed"], "没接原视频")

    def test_asks_tools_none_and_error(self):
        case = {"expect": {"asks": True, "tools_none": ["generate_image"], "new_nodes_max": 0}}
        self.assertTrue(agent_eval.score_case(case, summary(message="你想做图还是视频？"))["passed"])
        res = agent_eval.score_case(case, summary(message="好的", tools=["generate_image"]), error="boom")
        self.assertFalse(res["passed"])
        self.assertEqual([c["ok"] for c in res["checks"]], [False, False, False, True])

    def test_report_and_compare(self):
        runs = [{"id": "a", "title": "A", "category": "x", "passed": True, "score": 1.0, "rounds": 2, "seconds": 3.0, "checks": []},
                {"id": "a", "title": "A", "category": "x", "passed": False, "score": 0.5, "rounds": 4, "seconds": 5.0,
                 "checks": [{"check": "组件 angle", "ok": False}]}]
        report = agent_eval.build_report(runs, {"provider": "p", "model": "m"})
        self.assertEqual(report["cases"][0]["pass_rate"], 0.5)
        self.assertEqual(report["cases"][0]["failed_checks"], ["组件 angle"])
        diff = agent_eval.compare(report, {"cases": [{"id": "a", "score": 1.0}]})
        self.assertEqual(diff[0]["delta"], -0.25)
        md = agent_eval.render_markdown(report, diff)
        self.assertIn("通过率 50%", md)
        self.assertIn("↓ A", md)

    def test_prepare_data_dir_copies_only_config(self):
        src, dst = tempfile.mkdtemp(), tempfile.mkdtemp()
        os.makedirs(os.path.join(src, "data", "canvases"))
        Path(src, "data", "settings.json").write_text("{}", encoding="utf-8")
        Path(src, "data", "canvases", "c.json").write_text("{}", encoding="utf-8")
        self.assertEqual(agent_eval.prepare_data_dir(src, dst), ["data/settings.json"])
        self.assertFalse(Path(dst, "data", "canvases").exists(), "画布等正式数据不能带进评测目录")


class EndToEndMockTests(unittest.TestCase):
    """假模型按剧本出步骤，真跑 producer + 真工具，验证评测能正确判通过 / 不通过。"""

    def _run(self, case_id, scripted):
        case = agent_eval.load_cases(only=[case_id])[0]
        calls = []

        async def fake_decide(chat, messages, canvas_id, tools_json_text="", tools=None, rebuild_json=None):
            calls.append(canvas_id)
            step = scripted[min(len(calls), len(scripted)) - 1]
            if step.get("steps"):
                for s in step["steps"]:
                    s.setdefault("args", {})["canvas_id"] = canvas_id
            return step
        with flags(CONTEXT="1"), patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "_agent_run_auto_caption", new=lambda *a, **k: asyncio.sleep(0, 0)), \
                patch.dict(os.environ, {"NOVAI_AGENT_AUTO_VIDEO": "0"}):
            run = asyncio.run(agent_eval.run_case_async(main, case, chat_config(), timeout=60))
        s = agent_eval.summarize_run(run, main)
        return agent_eval.score_case(case, s, run["error"]), s

    def test_split_grid_passes(self):
        res, s = self._run("split-grid", [
            {"thought": "拆九宫格", "steps": [{"tool": "canvas_action",
                                             "args": {"action": "split", "node_id": "grid", "params": {"cols": 3, "rows": 3}}}]},
            {"done": True, "message": "拆好了九张"}])
        self.assertTrue(res["passed"], res["checks"])
        self.assertEqual(len([n for n in s["new_nodes"] if n["kind"] == "image"]), 9)

    def test_angle_three_passes_and_wrong_tool_fails(self):
        steps = [{"tool": "canvas_action", "args": {"action": "angle", "node_id": "shoe", "params": {"yaw": y}}}
                 for y in (45, 90, 0)]
        res, s = self._run("angle-three", [{"thought": "三个机位", "steps": steps}, {"done": True, "message": "好了"}])
        self.assertTrue(res["passed"], res["checks"])
        self.assertTrue(s["plan"], "模型编辑要停在待生成卡片")
        self.assertEqual(s["generations"], 3)
        res, _ = self._run("angle-three", [
            {"thought": "硬生图", "steps": [{"tool": "generate_image", "args": {"prompt": "鞋子换个角度"}}]},
            {"done": True, "message": "好了"}])
        self.assertFalse(res["passed"])
        self.assertIn("组件 angle ×3", [c["check"] for c in res["checks"] if not c["ok"]])

    def test_ambiguous_ask_passes(self):
        res, _ = self._run("ambiguous-ask", [{"done": True, "message": "想做什么呢？",
                                              "questions": [{"question": "做图还是视频？", "options": ["图", "视频"]}]}])
        self.assertTrue(res["passed"], res["checks"])


if __name__ == "__main__":
    unittest.main()
