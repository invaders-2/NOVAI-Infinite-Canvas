# -*- coding: utf-8 -*-
"""前缀缓存：同一次运行里，每轮发给模型的消息只能在末尾变（画布地图 / 进度放最后一条），
system 前缀和前面的对话原样不动——否则平台的前缀缓存每轮都命不中，又慢又贵。"""
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-prefix-cache-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_fix_main_wiring import chat_config, flags, make_req, run_producer  # noqa: E402


class PrefixCacheTests(unittest.TestCase):
    def test_messages_only_change_at_the_tail(self):
        cid = "c-prefix-" + uuid.uuid4().hex[:8]
        main.save_canvas({"id": cid, "title": "前缀", "kind": "beat", "updated_at": 1,
                          "nodes": [{"id": "t1", "kind": "text", "x": 0, "y": 0, "data": {"text": "文案"}}],
                          "connections": []})
        seen = []

        async def decide(chat, messages, canvas_id, tools_json_text="", tools=None, rebuild_json=None):
            seen.append([dict(m) for m in messages])
            if len(seen) == 1:
                return {"thought": "先建个文本", "steps": [{"tool": "create_node", "args": {
                    "canvas_id": canvas_id, "type": "text", "text": "第二段文案"}}]}
            return {"done": True, "message": "好了"}
        with flags(CONTEXT="1"), patch.object(main, "_agent_run_decide_v2", new=decide):
            run_producer(make_req(cid, chat=chat_config(), renderer="beat"))
        self.assertGreaterEqual(len(seen), 2, "要跑满两轮才能比较")
        first, second = seen[0], seen[1]
        self.assertEqual(first[0]["role"], "system")
        self.assertEqual(first[0]["content"], second[0]["content"], "system 前缀每轮必须一字不差")
        # 第一轮除了最后一条（环境状态）之外的消息，必须原样出现在第二轮开头
        stable = first[:-1]
        self.assertEqual(second[:len(stable)], stable, "前面的消息不能被改写，只能在后面追加")
        self.assertIn("当前环境状态", str(second[-1]["content"]), "每轮变化的环境状态放在最后一条")


if __name__ == "__main__":
    unittest.main()
