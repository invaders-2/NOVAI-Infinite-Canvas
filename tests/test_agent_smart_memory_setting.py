"""设置页「画布助手智能记忆」开关：默认关；打开后记忆候选 / 设置 / recall 立即可用（不用重启），关掉又回到 400。
环境变量 NOVAI_AGENT_V2_MEMORY 配了就以它为准，设置页显示只读。"""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-smart-memory-")
    os.environ["NOVAI_DATA_DIR"] = _TMP
os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

CLIENT = TestClient(main.app)


class SmartMemorySettingTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        CLIENT.put("/api/agent/smart-memory", json={"enabled": False})

    def tearDown(self):
        os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        CLIENT.put("/api/agent/smart-memory", json={"enabled": False})

    def test_default_off_and_routes_400(self):
        data = CLIENT.get("/api/agent/smart-memory").json()
        self.assertFalse(data["enabled"])
        self.assertFalse(data["locked"])
        canvas_id = main.new_canvas("智能记忆开关")["id"]
        resp = CLIENT.get("/api/agent/memory/settings", params={"canvas_id": canvas_id})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("智能记忆未开启", resp.json()["detail"])
        self.assertNotIn(main.RECALL_TOOL_NAME, main.AGENT_TOOLS)

    def test_turn_on_takes_effect_without_restart(self):
        canvas_id = main.new_canvas("智能记忆打开")["id"]
        data = CLIENT.put("/api/agent/smart-memory", json={"enabled": True}).json()
        self.assertTrue(data["enabled"])
        self.assertTrue(main.load_settings().get("agent_smart_memory"))
        self.assertEqual(CLIENT.get("/api/agent/memory/settings", params={"canvas_id": canvas_id}).status_code, 200)
        self.assertEqual(CLIENT.get("/api/agent/memory/candidates", params={"canvas_id": canvas_id}).status_code, 200)
        self.assertIn(main.RECALL_TOOL_NAME, main.AGENT_TOOLS)
        self.assertIn(main.RECALL_TOOL_NAME, main.AGENT_FREE_TOOLS)
        # 关掉：立即回到 400，recall 工具撤下
        CLIENT.put("/api/agent/smart-memory", json={"enabled": False})
        self.assertEqual(CLIENT.get("/api/agent/memory/settings", params={"canvas_id": canvas_id}).status_code, 400)
        self.assertNotIn(main.RECALL_TOOL_NAME, main.AGENT_TOOLS)
        self.assertNotIn(main.RECALL_TOOL_NAME, main.AGENT_FREE_TOOLS)

    def test_env_variable_wins_and_locks(self):
        CLIENT.put("/api/agent/smart-memory", json={"enabled": True})
        os.environ["NOVAI_AGENT_V2_MEMORY"] = "0"
        data = CLIENT.get("/api/agent/smart-memory").json()
        self.assertFalse(data["enabled"])
        self.assertTrue(data["locked"])


if __name__ == "__main__":
    unittest.main()
