# -*- coding: utf-8 -*-
"""BEAT 画布助手重跑已有结果的节点：写 data.agentRun.regenAsNew，交给画布在右侧新建节点重新生成。

背景：在原节点上追加版本时，前端 autoSelfUrl 的 R2（提示词改过 → 当前这一版当第一参考）会把
上一次的错误结果喂回新一轮，越改越偏；classic 画布早就是「右侧新开结果节点」，BEAT 对齐它。

不真存画布：只把 _agent_mutate_canvas 换成「改内存里的假 canvas」，其余走真实路由逻辑。
跑法：NOVAI_DATA_DIR=/tmp/novai-test-beat-regen python3 -m unittest tests.test_agent_beat_regen_as_new -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-beat-regen-as-new-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
import main


def beat_node(node_id="n1", kind="image", hist=None, text="", prompt="白底保温杯"):
    hist = hist or []
    return {"id": node_id, "kind": kind, "text": text, "data": {"gen": {
        "title": "文案" if kind == "text" else "海报",
        "prompt": prompt,
        "params": {"model": "p::m", "ratio": "1:1"},
        "hist": hist, "hi": max(0, len(hist) - 1), "order": []}}}


def canvas_with(node, connections=None):
    return {"id": "c1", "kind": "classic", "title": "BEAT", "nodes": [node], "connections": connections or []}


def run_mark(canvas, node_id="n1", **kwargs):
    """把画布读写换成内存版：mutator 直接改假 canvas，其它逻辑全走真实实现。"""
    def fake_mutate(_canvas_id, mutator):
        return canvas, mutator(canvas)

    with patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
        return main._agent_beat_mark_run("c1", node_id, **kwargs)


class RegenAsNewFlagTests(unittest.TestCase):
    def test_writes_flag_when_node_has_result(self):
        node = beat_node(hist=[{"url": "/gen-1.png", "w": 1024, "h": 1024}])
        result = run_mark(canvas_with(node))
        self.assertIs(result["regen_as_new"], True)
        self.assertIn("新建一个节点", result["message"])
        self.assertIn("原结果", result["message"])
        self.assertIs(node["data"]["agentRun"]["regenAsNew"], True, "契约字段写进 agentRun")

    def test_no_flag_without_result(self):
        node = beat_node(hist=[])
        result = run_mark(canvas_with(node))
        self.assertNotIn("regen_as_new", result)
        self.assertNotIn("regenAsNew", node["data"]["agentRun"])
        self.assertIn("作为新版本出现在节点上", result["message"], "空节点还是原地跑（口径不变）")

    def test_no_flag_for_review_rerun(self):
        # 审查自动重跑按 node_id 回读结果，服务端已强制剔除自产物：保持原地
        node = beat_node(hist=[{"url": "/gen-1.png"}])
        run_mark(canvas_with(node), review_rerun=True)
        self.assertNotIn("regenAsNew", node["data"]["agentRun"])

    def test_flag_survives_exclude_self_refs(self):
        # 助手「再来一张」会传 exclude_self_refs=True：仍然要开新节点（旧节点保留）
        node = beat_node(hist=[{"url": "/gen-1.png"}])
        run_mark(canvas_with(node), exclude_self_refs=True)
        self.assertIs(node["data"]["agentRun"]["regenAsNew"], True)
        self.assertIs(node["data"]["agentRun"]["excludeSelfRefs"], True)

    def test_text_node_result_counts_but_body_text_does_not(self):
        done = beat_node(kind="text", hist=[{"text": "第一版正文"}], prompt="写一段保温杯文案")
        run_mark(canvas_with(done), node_id="n1")
        self.assertIs(done["data"]["agentRun"]["regenAsNew"], True, "文本节点有生成的正文 = 有结果")
        blank = beat_node(kind="text", hist=[], text="只是一段节点标题", prompt="写一段保温杯文案")
        run_mark(canvas_with(blank), node_id="n1")
        self.assertNotIn("regenAsNew", blank["data"]["agentRun"], "只有 node.text 不算结果")

    def test_deferred_path_keeps_old_behavior(self):
        # 待生成卡片（defer）走的不是 agentRun：这一轮不改它（用户在卡片里确认后再跑，仍是原地口径）
        node = beat_node(hist=[{"url": "/gen-1.png"}])
        token = main._AGENT_BEAT_DEFER_GEN.set(True)
        try:
            run_mark(canvas_with(node))
        finally:
            main._AGENT_BEAT_DEFER_GEN.reset(token)
        self.assertIs(node["data"].get("agentPending"), True)
        self.assertIsNone(node["data"].get("agentRun"), "defer 不写 agentRun（所以也没有 regenAsNew）")


if __name__ == "__main__":
    unittest.main()
