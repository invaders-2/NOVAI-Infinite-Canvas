"""音频节点编号：smart-audio 必须拿到「音频N」，与 image/video 并列（纯函数）。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class AgentAudioAliasTests(unittest.TestCase):

    def test_node_kind_is_audio(self):
        self.assertEqual(main._agent_node_kind({"type": "smart-audio"}), "audio")
        self.assertEqual(main._agent_alias_prefix({"type": "smart-audio"}), "音频")

    def test_alias_re_matches_audio(self):
        for text, expected in (("音频1", ("音频", "1")), ("@音频12号", ("音频", "12")), ("音频 3", ("音频", "3"))):
            match = main._AGENT_ALIAS_RE.match(text)
            self.assertIsNotNone(match, text)
            self.assertEqual((match.group(1), match.group(2)), expected)

    def test_ensure_aliases_assigns_audio_and_image(self):
        canvas = {"kind": "smart", "nodes": [
            {"id": "a1", "type": "smart-audio", "created_at": 1},
            {"id": "i1", "type": "smart-image", "created_at": 2},
        ]}
        changed = main._agent_ensure_aliases(canvas)
        self.assertTrue(changed)
        aliases = {node["id"]: node.get("alias") for node in canvas["nodes"]}
        self.assertEqual(aliases["a1"], "音频1")
        self.assertEqual(aliases["i1"], "图1")
        self.assertEqual(canvas["alias_counters"]["音频"], 1)
        self.assertEqual(canvas["alias_counters"]["图"], 1)
        # 已有编号不重排：再跑一次不变
        self.assertFalse(main._agent_ensure_aliases(canvas))
        self.assertEqual({node["id"]: node.get("alias") for node in canvas["nodes"]},
                         {"a1": "音频1", "i1": "图1"})

    def test_existing_video_alias_unaffected(self):
        canvas = {"kind": "smart", "nodes": [
            {"id": "v1", "type": "smart-video", "alias": "视频7", "created_at": 1},
            {"id": "a2", "type": "smart-audio", "created_at": 2},
        ]}
        main._agent_ensure_aliases(canvas)
        aliases = {node["id"]: node.get("alias") for node in canvas["nodes"]}
        self.assertEqual(aliases["v1"], "视频7")
        self.assertEqual(aliases["a2"], "音频1")


if __name__ == "__main__":
    unittest.main()
