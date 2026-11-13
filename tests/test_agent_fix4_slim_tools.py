# -*- coding: utf-8 -*-
"""工具表瘦身开关 NOVAI_AGENT_V2_SLIM_TOOLS：默认关；开时只留 canvas_cli + 无等价命令的工具。"""
import os
import re
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
    _TMP = tempfile.mkdtemp(prefix="novai-slim-tools-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agents import canvas_cli  # noqa: E402


class SlimToolsFlagTests(unittest.TestCase):
    def setUp(self):
        self._saved = {key: os.environ.get(key) for key in ("NOVAI_AGENT_V2_SLIM_TOOLS",)}

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _with_slim(self, on):
        if on is None:
            os.environ.pop("NOVAI_AGENT_V2_SLIM_TOOLS", None)
        elif on:
            os.environ["NOVAI_AGENT_V2_SLIM_TOOLS"] = "1"
        else:
            os.environ["NOVAI_AGENT_V2_SLIM_TOOLS"] = "0"

    def test_explicit_off_keeps_tools_and_prompt_identical(self):
        self._with_slim(False)
        self.assertFalse(main._agent_v2_slim_tools_enabled())
        tools = dict(main.AGENT_TOOLS)
        self.assertIs(main._agent_slim_tools(tools), tools)
        catalog = main._agent_build_tools_catalog()
        self.assertIs(main._agent_slim_tool_catalog(catalog), catalog)
        prompt = main._AGENT_RUN_SYSTEM_PROMPT
        self.assertEqual(main._agent_slim_system_prompt(prompt), prompt)

    def test_unset_defaults_off(self):
        self._with_slim(None)
        self.assertFalse(main._agent_v2_slim_tools_enabled(), "未设置 SLIM_TOOLS 时默认关闭")
        self.assertIn("create_node", main._agent_slim_tools(dict(main.AGENT_TOOLS)),
                      "默认关闭时工具清单与改造前一致")

    def test_explicit_on_adds_hard_command_prompt(self):
        self._with_slim(True)
        prompt = main._agent_slim_system_prompt(main._AGENT_RUN_SYSTEM_PROMPT)
        self.assertIn("canvas_cli 的这些命令", prompt)
        self.assertIn("command 必填", prompt)
        self.assertIn("canvas_id 不填时默认当前画布", prompt)

    def test_on_removes_duplicate_tools_but_keeps_canvas_cli(self):
        self._with_slim(True)
        self.assertTrue(main._agent_v2_slim_tools_enabled())
        self.assertTrue(main._agent_v2_slim_tools_enabled())
        slim = main._agent_slim_tools(dict(main.AGENT_TOOLS))
        equivalents = main._agent_slim_tool_equivalents()
        self.assertIn(canvas_cli.TOOL_NAME, slim)
        for name in ("create_node", "update_node", "connect_nodes", "generate_image"):
            if name in main.AGENT_TOOLS:
                self.assertNotIn(name, slim, "有等价命令的旧工具不该再展示")
        kept_without_command = [name for name in slim if name not in equivalents]
        self.assertTrue(kept_without_command, "没有等价命令的工具要保留")
        catalog = main._agent_slim_tool_catalog(main._agent_build_tools_catalog())
        names = {item["name"] for item in catalog}
        self.assertIn(canvas_cli.TOOL_NAME, names)
        self.assertNotIn("create_node", names)

    def test_on_removes_mixing_sentence_from_prompt(self):
        self._with_slim(True)
        prompt = main._agent_slim_system_prompt(main._AGENT_RUN_SYSTEM_PROMPT)
        self.assertNotIn("不要混用两种写法", prompt)
        self.assertNotIn("原来的 22 个工具仍然可用", prompt)
        self.assertIn("canvas_cli", prompt.split("{tools_json}")[0] + "canvas_cli")

    def test_command_enum_matches_cli_spec(self):
        self._with_slim(True)
        slim = main._agent_slim_tools(dict(main.AGENT_TOOLS))
        enum = slim[canvas_cli.TOOL_NAME]["schema"]["properties"]["command"]["enum"]
        self.assertEqual(sorted(enum), sorted(canvas_cli.cli_spec.COMMANDS))
        self.assertEqual(len(enum), len(canvas_cli.cli_spec.COMMANDS))

    def test_unset_keeps_catalog_count_and_prompt_untouched(self):
        # 验收 a：不设置任何 NOVAI_AGENT_V2_* 时，工具目录数量不变、提示词里没有「工具限制」
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("NOVAI_AGENT_V2")}
        with patch.dict(os.environ, env, clear=True):
            ctx = main._CanvasRunContext({"canvas_id": "c-slim-default"})
            catalog = ctx.tool_catalog()
            self.assertEqual(len(main._agent_slim_tool_catalog(catalog)), len(catalog))
            self.assertIs(main._agent_slim_tool_catalog(catalog), catalog,
                          "关闭时原样返回同一份目录")
            self.assertNotIn("工具限制", main._agent_slim_system_prompt(main._AGENT_BEAT_SYSTEM_PROMPT))
            self.assertNotIn("工具限制", main._agent_slim_system_prompt(main._AGENT_RUN_SYSTEM_PROMPT))
            self.assertIn("create_node(", main._AGENT_BEAT_SYSTEM_PROMPT,
                          "改造前的提示词本身就是旧工具写法，关闭时必须逐字保留")

    def test_slim_beat_prompt_has_no_legacy_tool_calls(self):
        # 验收 b：瘦身模式下 BEAT 提示词不再教旧工具名，命令名全部来自 cli_spec
        self._with_slim(True)
        prompt = main._agent_slim_system_prompt(main._AGENT_BEAT_SYSTEM_PROMPT)
        self.assertNotIn("create_node(", prompt)
        self.assertNotIn("generate_image(", prompt)
        self.assertNotIn("不会被执行", prompt)
        self.assertIn("canvas_cli 的这些命令", prompt)
        self.assertIn('canvas_cli(command="node.create"', prompt)
        commands = set(re.findall(r'canvas_cli\(command="([^"]+)"', prompt))
        self.assertTrue(commands)
        self.assertTrue(commands <= set(canvas_cli.cli_spec.COMMANDS), commands)
        self.assertIn("一律用 canvas_cli", prompt)

    def test_slim_beat_built_prompt_keeps_canvas_cli_examples(self):
        # 真实 build_system_prompt 路径：瘦身在 format 之后做，args={...} 不能把格式化弄挂
        self._with_slim(True)
        ctx = main._CanvasRunContext({"canvas_id": "c-slim-build"})
        snapshot = {"id": "c-slim-build", "nodes": [], "connections": []}
        with patch.object(main._CanvasRunContext, "_beat", return_value=True), \
                patch.object(main, "_agent_run_media_platforms_text", return_value="（无）"), \
                patch.object(main, "_agent_memory_prompt", return_value=""):
            prompt = ctx.build_system_prompt(snapshot, "[]", "")
        self.assertNotIn("create_node(", prompt)
        self.assertNotIn("generate_image(", prompt)
        self.assertIn("canvas_cli 的这些命令", prompt)
        self.assertIn("args={", prompt)

    def test_command_table_unaffected(self):
        before = {name: dict(spec) for name, spec in canvas_cli.cli_spec.COMMANDS.items()}
        self._with_slim(True)
        main._agent_slim_tools(dict(main.AGENT_TOOLS))
        main._agent_slim_tool_catalog(main._agent_build_tools_catalog())
        self._with_slim(False)
        after = {name: dict(spec) for name, spec in canvas_cli.cli_spec.COMMANDS.items()}
        self.assertEqual(before, after)
        self.assertIn("node.create", after)
        self.assertEqual(after["node.create"].get("tool"), "create_node")


if __name__ == "__main__":
    unittest.main()
