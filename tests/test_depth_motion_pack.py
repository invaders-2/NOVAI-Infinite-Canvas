# -*- coding: utf-8 -*-
"""depth-motion 技能包：清单字段、正文工具名与真实 AGENT_TOOLS 对得上（/tmp 隔离，不碰正式数据）。"""
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-depth-motion-pack-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

from server.skills import registry  # noqa: E402

PACK = ROOT / "server" / "skills" / "builtin_packs" / "depth-motion"


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def agent_tool_names():
    """main.py 里真正注册进 AGENT_TOOLS 的工具名（字典字面量 + 后续 AGENT_TOOLS["x"] = 挂载）。
    技能正文引用的工具改名时这里会先炸。"""
    text = (ROOT / "main.py").read_text(encoding="utf-8")
    names = set(re.findall(r'^AGENT_TOOLS\["([a-z][a-z0-9_]+)"\]', text, re.M))
    literal = re.search(r"^AGENT_TOOLS = \{\n(.*?)\n\}\n", text, re.S | re.M)
    if literal:
        names |= set(re.findall(r'^    "([a-z][a-z0-9_]+)": \{', literal.group(1), re.M))
    return names


class DepthMotionPackTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-depth-motion-case-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self._previous = registry._DATA_DIR
        registry.set_data_dir(os.path.join(self.root, "data"))
        self.addCleanup(registry.set_data_dir, self._previous)

    def skill(self):
        for item in registry.load_skills():
            if item["id"] == "depth-motion":
                return item
        self.fail("depth-motion 内置技能没有装上")

    def test_pack_files_exist(self):
        self.assertTrue((PACK / "SKILL.md").is_file())
        self.assertTrue((PACK / "novai-pack.json").is_file())

    def test_manifest_lands_in_registry(self):
        item = self.skill()
        self.assertEqual(item["name"], "深度动作迁移")
        self.assertEqual(item["category"], "视频创作")
        self.assertFalse(item["enabled"])          # 内置包默认不启用，等用户自己加

    def test_prompt_uses_only_real_canvas_tools(self):
        prompt = self.skill()["skill_prompt"]
        available = agent_tool_names()
        for tool in ("depth_capture", "analyze_video", "generate_video", "create_node"):
            self.assertIn(tool, prompt)
            self.assertIn(tool, available)         # 画布助手真能调到，才允许写进技能
        self.assertLess(len(prompt), 20000)        # 不会被技能注入截断

    def test_prompt_warns_about_depth_limits(self):
        """这几天实测踩出来的坑必须写进正文，否则助手会承诺做不到的事。"""
        prompt = self.skill()["skill_prompt"]
        for phrase in ("30 秒", "锁死产品的形状", "keep_audio", "首帧图"):
            self.assertIn(phrase, prompt)

    def test_prompt_asks_user_for_missing_assets(self):
        """缺人物图 / 产品图时要停下来问用户上传，不许自己编一个顶上。"""
        prompt = self.skill()["skill_prompt"]
        self.assertIn("必须先停下来问用户上传", prompt)
        self.assertIn("不要用生成图替代", prompt)

    def test_missing_reference_video_is_guarded_twice(self):
        """没上传参考视频时：技能正文要拦住，工具层也要有硬校验兜底。"""
        self.assertIn("参考视频必须是画布上的视频节点", self.skill()["skill_prompt"])
        source = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn("深度动作捕捉只处理画布里的本地视频", source)   # run 层拒绝非本地视频
        self.assertIn("node_id 和 url 至少给一个", source)            # validate 层拒绝空参数


if __name__ == "__main__":
    unittest.main()
