# -*- coding: utf-8 -*-
"""create_node 的 url 参数：把现成素材（截帧 / clip_url）直接落成节点，不发起生成。

不做重量级 import：按仓库既有写法（tests/test_novai_cli.py）解析 main.py 源码断言契约，
避免把 2.2 万行的 main 拖进单测。
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main.py"


def source() -> str:
    return MAIN.read_text(encoding="utf-8")


def create_node_entry(text: str) -> str:
    start = text.find('    "create_node": {')
    if start < 0:
        raise AssertionError("main.py 里找不到 create_node 的注册条目")
    end = text.find('    "delete_node": {', start)
    return text[start:end]


class CreateNodeUrlTests(unittest.TestCase):

    def test_schema_exposes_url(self):
        entry = create_node_entry(source())
        self.assertIn('"url": {"type": "string"', entry)

    def test_description_mentions_materializing_asset(self):
        entry = create_node_entry(source())
        self.assertIn("不发起生成", entry)

    def test_validate_accepts_top_level_url(self):
        text = source()
        self.assertIn('norm["params"]["url"] = direct_url', text)

    def test_unresolved_placeholder_is_rejected(self):
        """{first_frame_url} 这种没解析掉的引用不许落成节点（会得到看不见的坏 url）。"""
        self.assertIn("url 里的步骤引用没解析", source())

    def test_resolver_falls_back_to_bare_key(self):
        text = source()
        self.assertIn("裸键兜底", text)

    def test_both_branches_read_params_url(self):
        """classic 与 BEAT 都从 params.url 建节点，顶层 url 收进 params 后才两条分支都能用。"""
        text = source()
        self.assertIn('node["url"] = str(args["params"].get("url") or "")', text)   # classic
        self.assertIn('params.pop("url", "")', text)                                # BEAT


if __name__ == "__main__":
    unittest.main()
