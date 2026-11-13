# -*- coding: utf-8 -*-
"""「动作复刻换产品」内置技能包：能装上、默认未添加、正文只用画布工具、不写死某条视频 / 某个产品。"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-pmr-pack-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

from server.skills import registry  # noqa: E402

FORBIDDEN_INSTRUCTIONS = ("references/", "python3 ", "npx ", "--follow")
# 用户第一次测试用的那条视频 / 那双靴子：方法要通用，正文里不能出现
HARDCODED = ("短靴", "帆布", "Converse", "匡威", "9.5 秒", "高帮")


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


class ProductMotionRecastPackTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-pmr-case-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self._previous = registry._DATA_DIR
        registry.set_data_dir(os.path.join(self.root, "data"))
        self.addCleanup(registry.set_data_dir, self._previous)

    def skill(self):
        for item in registry.load_skills():
            if item["id"] == "product-motion-recast":
                return item
        self.fail("product-motion-recast 内置技能没有装上")

    def test_installed_with_chinese_market_card(self):
        item = self.skill()
        self.assertEqual(item["name"], "动作复刻换产品")
        self.assertEqual(item["category"], "视频创作")
        self.assertIn("首尾帧", item.get("description", ""))
        self.assertFalse(item["enabled"], "官方技能要在应用市场添加后才启用")

    def test_prompt_fits_and_uses_canvas_tools(self):
        prompt = self.skill()["skill_prompt"]
        self.assertTrue(prompt.startswith("# 动作复刻换产品"), prompt[:60])
        self.assertLess(len(prompt), 20000)
        for tool in ("analyze_video", "view_image", "generate_image", "generate_video",
                     "start_end_to_video", "last_frame_url", "clip=true", "type=timeline"):
            self.assertIn(tool, prompt)
        for bad in FORBIDDEN_INSTRUCTIONS:
            self.assertNotIn(bad, prompt)

    def test_method_is_generic(self):
        prompt = self.skill()["skill_prompt"]
        for word in HARDCODED:
            self.assertNotIn(word, prompt)
        # 结构对比 + 接缝选择 + 原产品部件残留检查，是这套方法的三个支点
        for key in ("结构", "接缝", "原产品才有的部件"):
            self.assertIn(key, prompt)


if __name__ == "__main__":
    unittest.main()
