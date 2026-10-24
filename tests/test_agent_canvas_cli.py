# -*- coding: utf-8 -*-
"""画布助手的 canvas_cli：注册项、展开成真实工具、确认闸门不被绕过。

核心安全断言：canvas_cli 的写命令在 main._agent_run_normalize_steps 里就展开成内层真实工具，
所以既有「按工具名」判定的确认闸门 / 免费判定 / 生成单元计数全部照常生效；一旦某处漏了展开，
run() 会直接报错而不是静默成功。

所有画布数据都落在临时目录（NOVAI_DATA_DIR），不碰仓库 data/。
"""
import asyncio
import contextlib
import io
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

# main 会把「用户数据目录」定在 import 那一刻：先指到临时目录，测试就绝不碰真实数据
_TMP_DATA = tempfile.mkdtemp(prefix="novai-canvas-cli-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.agents import canvas_cli, cli_spec


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def normalize(raw_steps, tools=None):
    return main._agent_run_normalize_steps(raw_steps, tools if tools is not None else main.AGENT_TOOLS)


def cli_step(command, inner_args=None, description=""):
    args = {"command": command}
    if inner_args is not None:
        args["args"] = inner_args
    return {"tool": "canvas_cli", "args": args, "description": description}


class RegistryTests(unittest.TestCase):
    """注册进 AGENT_TOOLS 与工具目录，且没顶掉既有 22 个画布工具。"""

    def test_registered_in_agent_tools(self):
        self.assertEqual(canvas_cli.TOOL_NAME, "canvas_cli")
        entry = main.AGENT_TOOLS.get("canvas_cli")
        self.assertIsNotNone(entry)
        for key in ("description", "schema", "validate", "run", "preview", "mutates_canvas"):
            self.assertIn(key, entry)
        self.assertIs(entry["mutates_canvas"], False)      # 写判定交给展开后的内层工具
        for name in cli_spec.CANVAS_TOOL_NAMES:            # 既有画布工具一个都不能少
            self.assertIn(name, main.AGENT_TOOLS)

    def test_catalog_exposes_canvas_cli(self):
        catalog = main._agent_build_tools_catalog()
        item = next((i for i in catalog if i["name"] == "canvas_cli"), None)
        self.assertIsNotNone(item)
        schema = item["schema"]
        self.assertEqual(schema["type"], "object")
        self.assertEqual(schema["required"], ["command"])
        enum = schema["properties"]["command"]["enum"]
        self.assertEqual(enum, sorted(cli_spec.COMMANDS))
        self.assertEqual(len(enum), 26)
        self.assertIn("args", schema["properties"])
        # 文案说的是「一条命令 / 写命令要确认」，并把 26 条命令名都点出来
        self.assertIn("用一条命令操作画布", item["description"])
        self.assertIn("写命令需要用户确认", item["description"])
        for name in cli_spec.command_names():
            self.assertIn(name, item["description"])


class PreviewTests(unittest.TestCase):
    """main.agent_preview 会取 entry["preview"]：26 条命令都必须给一句非空中文，且永不抛错。"""

    def setUp(self):
        self.entry = main.AGENT_TOOLS["canvas_cli"]

    def test_entry_has_preview(self):
        self.assertTrue(callable(self.entry.get("preview")))

    def test_preview_text_for_every_command(self):
        for name in sorted(cli_spec.COMMANDS):
            with self.subTest(command=name):
                text = self.entry["preview"](self.entry["validate"]({"command": name, "args": {}}), {})
                self.assertIsInstance(text, str)
                self.assertTrue(text.strip())
                self.assertIn(name, text)
                # 预览里点明会展开成哪个真实工具（用户看到的是真名，不是外壳名）
                self.assertIn(cli_spec.COMMANDS[name]["tool"], text)

    def test_preview_never_raises_on_dirty_args(self):
        # 校验失败时 agent_preview 会拿**原始** args 再调一次 preview，所以脏输入也只许返回字符串
        for dirty in (None, {}, "脏", [], {"command": "node.boom"}, {"command": 7},
                      {"command": "node.create", "args": ["x"]}):
            with self.subTest(args=dirty):
                text = self.entry["preview"](dirty, {})
                self.assertIsInstance(text, str)
                self.assertTrue(text.strip())


def _json_objects(text):
    """把文本里所有能解析成 JSON 的 {...} 片段抠出来（用来验证提示词里的示例是真 JSON）。"""
    found = []
    for start, ch in enumerate(text):
        if ch != "{":
            continue
        depth = 0
        for end in range(start, len(text)):
            if text[end] == "{":
                depth += 1
            elif text[end] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        found.append(json.loads(text[start:end + 1]))
                    except Exception:
                        pass
                    break
    return found


class PromptGuideTests(unittest.TestCase):
    """提示词要主动告诉模型 canvas_cli 的存在与写法——注册了却不说，模型不会用。"""

    def _formatted_system_prompt(self):
        # 与 _CanvasRunContext.build_system_prompt 同样的 5 个占位符；
        # 字面量大括号少写一个，这里就会 KeyError/ValueError，等于提前抓到线上炸点
        return main._AGENT_RUN_SYSTEM_PROMPT.format(
            tools_json="[]", media_platforms_text="", canvas_summary="{}",
            history_text="", focus_text="")

    def test_system_prompt_mentions_canvas_cli(self):
        prompt = main._AGENT_RUN_SYSTEM_PROMPT
        self.assertIn("canvas_cli", prompt)
        self.assertIn("不要混用两种写法", prompt)      # 原 22 个工具与命令二选一，别混着用
        self.assertIn("用户确认闸门", prompt)          # 写/生成命令未确认只出方案

    def test_system_prompt_has_valid_json_example_with_command(self):
        examples = _json_objects(self._formatted_system_prompt())
        steps = [e for e in examples
                 if isinstance(e, dict) and e.get("tool") == "canvas_cli"
                 and isinstance(e.get("args"), dict)
                 and e["args"].get("command") in cli_spec.COMMANDS]
        self.assertTrue(steps, "系统提示词里缺一个合法的 canvas_cli JSON 示例")
        inner = steps[0]["args"].get("args")
        self.assertIsInstance(inner, dict)             # 内层参数是对象，不是字符串
        self.assertEqual(inner.get("type"), "prompt")  # 示例就是「建一个提示词节点」
        self.assertIn("description", steps[0])         # 每步都要给用户看的一句话

    def test_native_note_mentions_canvas_cli(self):
        self.assertIn("canvas_cli", main._AGENT_NATIVE_NOTE)


class ValidateTests(unittest.TestCase):

    def setUp(self):
        self.validate = main.AGENT_TOOLS["canvas_cli"]["validate"]

    def test_accepts_known_command(self):
        norm = self.validate({"command": "node.create",
                              "args": {"canvas_id": "c1", "type": "prompt", "description": "写个提示词"},
                              "description": "建节点"})
        self.assertEqual(norm["command"], "node.create")
        self.assertEqual(norm["args"], {"canvas_id": "c1", "type": "prompt", "description": "写个提示词"})
        self.assertEqual(norm["description"], "建节点")

    def test_args_may_be_omitted(self):
        self.assertEqual(self.validate({"command": "canvas.get"})["args"], {})
        self.assertEqual(self.validate({"command": "canvas.get", "args": None})["args"], {})

    def test_every_enum_command_passes(self):
        # enum 是命令表的镜像：列表里的每条命令都必须能通过校验，否则模型会拿到互相矛盾的定义
        for name in sorted(cli_spec.COMMANDS):
            with self.subTest(command=name):
                self.assertEqual(self.validate({"command": name, "args": {}})["command"], name)

    def test_rejects_bad_args(self):
        for bad in ("node.create", None, ["node.create"], {"command": "node.boom", "args": {}}):
            with self.subTest(args=bad):
                with self.assertRaises(canvas_cli.CanvasCliError):
                    self.validate(bad)
        with self.assertRaises(canvas_cli.CanvasCliError):
            self.validate({"command": "node.create", "args": ["x"]})


class ExpansionSafetyTests(unittest.TestCase):
    """写命令必须先变成真实工具名，确认闸门才拦得住。"""

    def test_write_command_expands_and_needs_confirmation(self):
        steps, unknown = normalize([cli_step(
            "node.create", {"canvas_id": "c1", "type": "prompt", "prompt": "黄昏海边的猫"},
            description="建一个提示词节点")])
        self.assertEqual(unknown, [])
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["tool"], "create_node")     # 展开成内层真实工具名
        self.assertEqual(steps[0]["args"], {"canvas_id": "c1", "type": "prompt", "prompt": "黄昏海边的猫"})
        self.assertEqual(steps[0]["description"], "建一个提示词节点")

        gate = main.agent_plan_confirmation_needed(steps)
        self.assertTrue(gate["needed"])
        self.assertEqual(gate["tools"], ["create_node"])       # 闸门看到的是真实工具名
        self.assertGreaterEqual(main.agent_plan_impact(steps)["writes"], 1)

    def test_generation_command_expands_and_counts_units(self):
        steps, unknown = normalize([cli_step("generation.run", {"canvas_id": "c1", "node_id": "n1"})])
        self.assertEqual(unknown, [])
        self.assertEqual(steps[0]["tool"], "run_generation")
        self.assertTrue(main.agent_plan_confirmation_needed(steps)["needed"])
        self.assertEqual(main.agent_plan_impact(steps)["generations"], 1)

    def test_delete_command_still_hits_confirm_reason(self):
        # 展开后 delete_node 落在「需要确认」的执行收口里（force 也一样）
        steps, _unknown = normalize([cli_step("node.delete", {"canvas_id": "c1", "node_id": "n1"})])
        self.assertEqual(steps[0]["tool"], "delete_node")
        self.assertTrue(main._agent_run_confirm_reason(steps[0]["tool"], steps[0]["args"]))

    def test_every_read_only_command_expands_free(self):
        for name, spec in cli_spec.iter_commands():
            if spec["mutates"] or spec["tool"] not in main.AGENT_TOOLS:
                continue
            with self.subTest(command=name):
                steps, unknown = normalize([cli_step(name, {"canvas_id": "c1"})])
                self.assertEqual(unknown, [])
                self.assertEqual(steps[0]["tool"], spec["tool"])
                self.assertFalse(main.agent_plan_confirmation_needed(steps)["needed"])
                self.assertNotIn(steps[0]["tool"], main.AGENT_PLAN_CONFIRM_TOOLS)

    def test_read_only_batch_counts_as_free(self):
        # _agent_steps_are_free 还要求批里含 refine_prompt / list_templates / remember / forget / arrange_canvas
        steps, unknown = normalize([cli_step("template.list", {})])
        self.assertEqual(unknown, [])
        self.assertTrue(main._agent_steps_are_free(steps))

    def test_write_command_never_survives_as_canvas_cli(self):
        # 关键断言：无论哪条命令，展开后都不能留下 tool == "canvas_cli" 的步骤
        for name, spec in cli_spec.iter_commands():
            if spec["tool"] not in main.AGENT_TOOLS:
                continue
            with self.subTest(command=name):
                steps, _unknown = normalize([cli_step(name, {})])
                self.assertTrue(steps)
                self.assertNotIn("canvas_cli", [s["tool"] for s in steps])


class UnknownStepTests(unittest.TestCase):
    """展开失败必须进 unknown（模型下一轮能看到原因），而不是变成可执行步骤。"""

    def test_unknown_command(self):
        steps, unknown = normalize([cli_step("node.boom", {})])
        self.assertEqual(steps, [])
        self.assertEqual(len(unknown), 1)
        self.assertEqual(unknown[0], "canvas_cli：未知命令 node.boom")

    def test_missing_command(self):
        steps, unknown = normalize([{"tool": "canvas_cli", "args": {}}])
        self.assertEqual(steps, [])
        self.assertIn("未知命令", unknown[0])

    def test_inner_args_not_dict(self):
        steps, unknown = normalize([{"tool": "canvas_cli", "args": {"command": "node.create", "args": ["x"]}}])
        self.assertEqual(steps, [])
        self.assertIn("args 必须是对象", unknown[0])

    def test_outer_args_not_dict(self):
        expanded, error = canvas_cli.expand_step({"tool": "canvas_cli", "args": "node.create"}, main.AGENT_TOOLS)
        self.assertIsNone(expanded)
        self.assertIn("args 必须是对象", error)

    def test_inner_tool_not_available(self):
        # 命令表里的文件工具不在这张画布工具表里
        steps, unknown = normalize([cli_step("report.write_html", {})])
        self.assertEqual(steps, [])
        self.assertIn("write_html_report", unknown[0])
        self.assertIn("当前不可用", unknown[0])
        # 裁剪一份工具表：被裁掉的工具对应的命令同样进 unknown
        trimmed = {k: v for k, v in main.AGENT_TOOLS.items() if k != "delete_node"}
        steps, unknown = normalize([cli_step("node.delete", {"canvas_id": "c1", "node_id": "n1"})], trimmed)
        self.assertEqual(steps, [])
        self.assertIn("delete_node", unknown[0])

    def test_expansion_error_does_not_block_sibling_steps(self):
        steps, unknown = normalize([cli_step("node.boom", {}),
                                    cli_step("node.create", {"canvas_id": "c1", "type": "text", "prompt": "x"})])
        self.assertEqual([s["tool"] for s in steps], ["create_node"])
        self.assertEqual(len(unknown), 1)


class PassThroughAndPurityTests(unittest.TestCase):

    def test_plain_step_passes_through(self):
        raw = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"}, "description": "建节点"}]
        steps, unknown = normalize(raw)
        self.assertEqual(unknown, [])
        self.assertEqual(steps[0]["tool"], "create_node")
        self.assertEqual(steps[0]["args"], raw[0]["args"])
        self.assertEqual(steps[0]["description"], "建节点")
        # 直接走 expand_steps：非 canvas_cli 的步骤原样返回同一个对象（不复制、不动 args）
        expanded, errors = canvas_cli.expand_steps(raw, main.AGENT_TOOLS)
        self.assertEqual(errors, [])
        self.assertIs(expanded[0], raw[0])

    def test_expand_steps_is_pure(self):
        raw = [{"tool": "canvas_cli",
                "args": {"command": "node.create",
                         "args": {"canvas_id": "c1", "type": "prompt", "description": "内层"}},
                "description": "外层"},
               {"tool": "get_canvas", "args": {"canvas_id": "c1"}, "description": "读画布"}]
        snapshot = json.loads(json.dumps(raw))
        outer_args = raw[0]["args"]
        inner_args = outer_args["args"]

        expanded, errors = canvas_cli.expand_steps(raw, main.AGENT_TOOLS)
        self.assertEqual(errors, [])
        self.assertEqual(raw, snapshot)                       # 入参一个字都没被改
        self.assertIs(raw[0]["args"], outer_args)
        self.assertIs(outer_args["args"], inner_args)
        self.assertEqual(expanded[0]["tool"], "create_node")
        self.assertEqual(expanded[0]["description"], "外层")   # 外层 description 保留
        self.assertEqual(expanded[0]["args"]["description"], "内层")   # 内层 args 原样保留

        expanded[0]["args"]["prompt"] = "只改展开结果"
        self.assertNotIn("prompt", raw[0]["args"]["args"])     # 结果与入参不共享同一个 dict

    def test_non_dict_and_non_list_inputs(self):
        self.assertEqual(canvas_cli.expand_steps("脏", main.AGENT_TOOLS), ([], []))
        self.assertEqual(canvas_cli.expand_step(None, main.AGENT_TOOLS), (None, None))


def _stub_canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def _agent_request(mode="run", approved_steps=None):
    return {"canvas_id": "c1", "instruction": "建个提示词节点",
            "focus": main._agent_run_normalize_focus(None), "history": [],
            # provider_cfg 为空 = 不启用原生工具调用，走被测的 JSON 那条路
            "chat": {"provider": "p", "base": "http://x", "headers": {}, "model": "m", "provider_cfg": {}},
            "max_steps": 6, "mode": mode, "approved_steps": approved_steps or [],
            "enforce_write_confirmation": True}


def _parse_events(chunks):
    events = []
    for chunk in chunks:
        for block in chunk.strip().split("\n\n"):
            if not block or block.startswith(":"):
                continue
            name, data = "message", {}
            for line in block.split("\n"):
                if line.startswith("event: "):
                    name = line[len("event: "):].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            events.append((name, data))
    return events


def _drain(req, replies, execute):
    """跑完 producer，返回 SSE 事件列表（模型与工具全部打桩，不落盘真实画布）。"""
    chat = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])

    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            await main._agent_run_producer(req, queue)
        out = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            out.append(item)
        return out

    with patch.object(main, "load_canvas", return_value=_stub_canvas()), \
            patch.object(main, "agent_session_save"), \
            patch.object(main, "_agent_run_chat", new=chat), \
            patch.object(main, "agent_execute_step", new=execute):
        return _parse_events(asyncio.run(run()))


class ProducerGateTests(unittest.TestCase):
    """落到真正的执行收口：模型发 canvas_cli 写命令、用户没点执行 → 只出方案，一步都不执行。"""

    def test_canvas_cli_write_step_is_deferred_to_plan(self):
        execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"})
        reply = {"thought": "建提示词节点",
                 "steps": [cli_step("node.create",
                                    {"canvas_id": "c1", "type": "prompt", "title": "海报"},
                                    description="建提示词节点")],
                 "done": False}
        events = _drain(_agent_request(mode="run"), [reply], execute)
        names = [name for name, _data in events]

        self.assertEqual(execute.await_count, 0)      # 一步都没执行
        self.assertNotIn("step_start", names)
        self.assertNotIn("step_result", names)
        plan = [data for name, data in events if name == "plan"][0]
        self.assertTrue(plan["requires_confirmation"])
        self.assertEqual(plan["blocked_tools"], ["create_node"])         # 拦的是真实工具名
        self.assertEqual([s["tool"] for s in plan["steps"]], ["create_node"])
        self.assertEqual(plan["impact"]["writes"], 1)
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["steps_executed"], 0)

    def test_canvas_cli_read_step_executes_as_real_tool(self):
        execute = AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})
        reply = {"thought": "看画布",
                 "steps": [cli_step("canvas.get", {"canvas_id": "c1"}, description="看画布")],
                 "done": False}
        events = _drain(_agent_request(mode="run"), [reply, {"done": True, "message": "看完了"}], execute)

        # 记录里看到的是真实工具名（undo / 产物登记 / 审计都按真名走）
        self.assertEqual([call.args[0] for call in execute.await_args_list], ["get_canvas"])
        self.assertNotIn("confirm_required", [name for name, _data in events])


class LoudFailureTests(unittest.TestCase):

    def test_run_refuses_direct_execution(self):
        entry = main.AGENT_TOOLS["canvas_cli"]
        with self.assertRaises(canvas_cli.CanvasCliError) as ctx:
            entry["run"]({"command": "node.create", "args": {"canvas_id": "c1", "type": "prompt"}})
        self.assertEqual(ctx.exception.code, "canvas_cli_not_expanded")
        self.assertIn("展开", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
