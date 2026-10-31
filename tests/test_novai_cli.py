# -*- coding: utf-8 -*-
"""NOVAI 只读 CLI 的测试：命令表完整性、参数解析、节点摘要纯函数。

默认不连真实服务；端到端用例需要显式设置 NOVAI_TEST_URL 才会跑。
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import novai_cli
from server.agents import cli_spec

# 允许清单：与 cli_spec 派生的 26 个工具一一对应；单测另外解析源码核对
ALLOWED_TOOLS = {
    "list_canvases", "get_canvas", "create_node", "delete_node", "connect_nodes",
    "disconnect_nodes", "update_node", "run_generation", "generate_image", "generate_video",
    "batch_generate", "run_batch", "list_templates", "save_template", "apply_template",
    "remember", "forget", "run_downstream", "arrange_canvas", "refine_prompt",
    "use_asset", "check_task",
    "read_table", "write_html_report", "write_xlsx", "image_generate",
}

# 注册在 AGENT_TOOLS 里、但不进入通用画布 CLI 命令表的专用工具。
NON_CANVAS_TOOLS = {"activate_skill", "install_skill", "lipsync_video"}

# 会产生持久化副作用的命令（写画布 / 写素材库或记忆 / 落盘产物 / 发起生成任务）
EXPECTED_WRITE_COMMANDS = {
    "node.create", "node.update", "node.delete", "node.connect", "node.disconnect",
    "generation.run", "generation.downstream", "image.generate", "video.generate",
    "batch.generate", "batch.run", "template.apply",
    "template.save", "memory.remember", "memory.forget",
    "report.write_html", "xlsx.write", "file.image_generate",
}


def _extract_registry_block(relative_path, variable):
    """从源码里抠出 AGENT_TOOLS / AGENT_FILE_TOOLS 的字典文本（顶层 } 收尾）。"""
    text = (ROOT / relative_path).read_text(encoding="utf-8")
    match = re.search(r"^%s = \{\n(.*?)\n\}\n" % re.escape(variable), text, re.S | re.M)
    if not match:
        raise AssertionError("在 %s 里找不到 %s 的定义" % (relative_path, variable))
    return match.group(1)


def _registry_entries(block):
    """{工具名: "True"/"False"/None}，取每个条目里的 mutates_canvas。"""
    entries = {}
    pattern = re.compile(r'^    "([a-z][a-z0-9_]+)": \{\n(.*?)(?=^    "[a-z][a-z0-9_]+": \{\n|\Z)', re.S | re.M)
    for match in pattern.finditer(block):
        segment = match.group(2)
        flag = re.search(r'"mutates_canvas": (True|False)', segment)
        entries[match.group(1)] = flag.group(1) if flag else None
    return entries


def _source_registries():
    canvas_tools = _registry_entries(_extract_registry_block("main.py", "AGENT_TOOLS"))
    file_tools = _registry_entries(_extract_registry_block("server/agents/tools.py", "AGENT_FILE_TOOLS"))
    return canvas_tools, file_tools


def _run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = novai_cli.main(argv)
    return code, out.getvalue(), err.getvalue()


class FakeApi(object):
    """替身：记录调用参数，按需返回 payload 或抛错。"""

    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.calls = []

    def __call__(self, base_url, path, token="", timeout=10.0):
        self.calls.append({"base_url": base_url, "path": path, "token": token, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.payload


class CommandTableTests(unittest.TestCase):

    def test_naming_is_dotted_and_unique(self):
        names = cli_spec.command_names()
        self.assertEqual(len(names), len(set(names)))
        for name in names:
            self.assertRegex(name, r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$", name)

    def test_every_command_has_required_fields(self):
        for name, spec in cli_spec.iter_commands():
            with self.subTest(command=name):
                self.assertIsInstance(spec.get("tool"), str)
                self.assertTrue(spec["tool"])
                self.assertIsInstance(spec.get("mutates"), bool)
                self.assertIsInstance(spec.get("mutates_canvas"), bool)
                summary = spec.get("summary")
                self.assertIsInstance(summary, str)
                self.assertTrue(summary.strip())
                self.assertNotIn("\n", summary)

    def test_every_tool_is_known_and_used_once(self):
        tools = [spec["tool"] for _name, spec in cli_spec.iter_commands()]
        self.assertEqual(len(tools), len(set(tools)))
        for tool in tools:
            self.assertIn(tool, ALLOWED_TOOLS)
        self.assertEqual(set(tools), ALLOWED_TOOLS)
        self.assertEqual(set(novai_cli.cli_spec.TOOL_NAMES), ALLOWED_TOOLS)

    def test_canvas_tool_names_exist_in_main_registry(self):
        canvas_tools, _file_tools = _source_registries()
        # activate_skill / install_skill 给模型管理技能，不属于画布命令，CLI 表不收录
        canvas_only = {name: entry for name, entry in canvas_tools.items()
                       if name not in NON_CANVAS_TOOLS}
        canvas_used = {spec["tool"] for _name, spec in cli_spec.iter_commands()
                       if spec["tool"] in canvas_only}
        self.assertEqual(canvas_used, set(canvas_only))
        self.assertEqual(len(canvas_only), 22)
        # 22 个通用画布工具 + 3 个技能/专用工具 = 25 条；数量变化要在这里显式说明
        self.assertEqual(len(canvas_tools), 22 + len(NON_CANVAS_TOOLS))
        for tool in set(cli_spec.CANVAS_TOOL_NAMES):
            self.assertIn(tool, canvas_only)

    def test_file_tool_names_exist_in_agent_file_tools(self):
        _canvas_tools, file_tools = _source_registries()
        self.assertEqual(set(file_tools), {"read_table", "write_html_report", "write_xlsx", "image_generate"})
        for tool in cli_spec.FILE_TOOL_NAMES:
            self.assertIn(tool, file_tools)

    def test_mutates_canvas_matches_registry_flags(self):
        canvas_tools, file_tools = _source_registries()
        registry = dict(canvas_tools)
        registry.update(file_tools)
        for name, spec in cli_spec.iter_commands():
            with self.subTest(command=name):
                expected = registry.get(spec["tool"])
                self.assertIn(expected, ("True", "False"), "注册表里缺 %s 的 mutates_canvas" % spec["tool"])
                self.assertEqual(spec["mutates_canvas"], expected == "True")

    def test_write_commands_are_flagged(self):
        flagged = {name for name, spec in cli_spec.iter_commands() if spec["mutates"]}
        self.assertEqual(flagged, EXPECTED_WRITE_COMMANDS)
        by_name = dict(cli_spec.iter_commands())
        for name in ("node.create", "node.update", "node.delete", "image.generate", "video.generate"):
            self.assertTrue(by_name[name]["mutates"], name)
        for name in ("canvas.list", "canvas.get", "task.check", "table.read", "prompt.refine"):
            self.assertFalse(by_name[name]["mutates"], name)

    def test_canvas_writes_imply_side_effects(self):
        for name, spec in cli_spec.iter_commands():
            if spec["mutates_canvas"]:
                self.assertTrue(spec["mutates"], name)

    def test_iter_and_names_helpers(self):
        self.assertEqual(cli_spec.command_names(), list(cli_spec.COMMANDS.keys()))
        pairs = list(cli_spec.iter_commands())
        self.assertEqual(len(pairs), len(cli_spec.COMMANDS))
        for name, spec in pairs:
            self.assertIs(spec, cli_spec.COMMANDS[name])
        self.assertIs(cli_spec.get_command("canvas.get"), cli_spec.COMMANDS["canvas.get"])
        self.assertIsNone(cli_spec.get_command("nope.nothing"))
        self.assertEqual(cli_spec.command_for_tool("create_node"), "node.create")
        self.assertIsNone(cli_spec.command_for_tool("nope"))
        self.assertTrue(cli_spec.is_write_command("node.create"))
        self.assertFalse(cli_spec.is_write_command("canvas.list"))
        self.assertTrue(cli_spec.is_write_command("nope.nothing"))

    def test_local_commands_are_read_only_surface(self):
        names = [name for name, _spec in cli_spec.iter_local_commands()]
        self.assertEqual(names, ["status", "canvas.ls", "canvas.show", "nodes.ls", "commands"])
        for name, spec in cli_spec.iter_local_commands():
            self.assertTrue(spec.get("summary"), name)

    def test_cli_spec_does_not_import_main(self):
        source = (ROOT / "server" / "agents" / "cli_spec.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(?:import main|from main import)", source, re.M))


class CliSpecFlagsInCliTests(unittest.TestCase):

    def test_blocked_write_command_matches_cli_verbs(self):
        for command in EXPECTED_WRITE_COMMANDS:
            words = command.split(".", 1)
            self.assertEqual(novai_cli.blocked_write_command(words), command)

    def test_read_only_verbs_are_not_blocked(self):
        for words in (["canvas", "ls"], ["canvas", "show", "abc"], ["nodes", "ls", "abc"],
                      ["status"], ["commands"]):
            self.assertEqual(novai_cli.blocked_write_command(words), "")

    def test_global_flags_do_not_confuse_write_detection(self):
        self.assertEqual(
            novai_cli.blocked_write_command(["--base-url", "http://x:1", "node", "create"]),
            "node.create",
        )
        self.assertEqual(
            novai_cli.blocked_write_command(["--base-url=http://x:1", "--json", "node", "update"]),
            "node.update",
        )
        self.assertEqual(novai_cli.blocked_write_command(["canvas", "--json", "show", "abc"]), "")


class ArgParseTests(unittest.TestCase):

    def test_canvas_show_requires_canvas_id(self):
        with self.assertRaises(SystemExit) as caught:
            with redirect_stderr(io.StringIO()):
                novai_cli.main(["canvas", "show"])
        self.assertEqual(caught.exception.code, 2)

    def test_nodes_ls_requires_canvas_id(self):
        with self.assertRaises(SystemExit) as caught:
            with redirect_stderr(io.StringIO()):
                novai_cli.main(["nodes", "ls"])
        self.assertEqual(caught.exception.code, 2)

    def test_help_exits_zero(self):
        with self.assertRaises(SystemExit) as caught:
            with redirect_stdout(io.StringIO()):
                novai_cli.main(["--help"])
        self.assertEqual(caught.exception.code, 0)

    def test_no_subcommand_prints_help_and_usage_exit(self):
        code, out, err = _run([])
        self.assertEqual(code, novai_cli.EXIT_USAGE)
        self.assertIn("错误：请指定子命令", err)

    def test_json_flag_works_before_and_after_subcommand(self):
        payload = {"canvases": [{"id": "c1", "title": "画布一", "project": "default", "updated_at": 1700000000000}]}
        for argv in (["--json", "canvas", "ls"], ["canvas", "ls", "--json"]):
            fake = FakeApi(payload=payload)
            with mock.patch.object(novai_cli, "http_get_json", fake):
                code, out, _err = _run(argv)
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(data["count"], 1)
            self.assertEqual(data["canvases"][0]["title"], "画布一")
            self.assertEqual(data["canvases"][0]["updated_at"], 1700000000000)

    def test_base_url_token_timeout_are_passed_through(self):
        fake = FakeApi(payload={"canvases": []})
        with mock.patch.object(novai_cli, "http_get_json", fake):
            code, _out, _err = _run(["status", "--base-url", "http://127.0.0.1:9999",
                                     "--token", "tk-1", "--timeout", "2.5", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(fake.calls[0]["base_url"], "http://127.0.0.1:9999")
        self.assertEqual(fake.calls[0]["path"], "/api/canvases")
        self.assertEqual(fake.calls[0]["token"], "tk-1")
        self.assertEqual(fake.calls[0]["timeout"], 2.5)

    def test_bad_timeout_is_rejected(self):
        code, _out, err = _run(["status", "--timeout", "0"])
        self.assertEqual(code, novai_cli.EXIT_USAGE)
        self.assertIn("--timeout", err)

    def test_status_json_reports_version_and_count(self):
        fake = FakeApi(payload={"canvases": [{"id": "a"}, {"id": "b"}]})
        with mock.patch.object(novai_cli, "http_get_json", fake):
            code, out, _err = _run(["status", "--json"])
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertTrue(data["reachable"])
        self.assertEqual(data["canvas_count"], 2)
        self.assertEqual(data["version"], (ROOT / "VERSION").read_text(encoding="utf-8").strip())
        self.assertEqual(data["base_url"], novai_cli.default_base_url())

    def test_unreachable_service_fails_loudly(self):
        message = novai_cli.unreachable_message("http://127.0.0.1:3000")
        fake = FakeApi(error=novai_cli.CliError(message, novai_cli.EXIT_UNREACHABLE))
        with mock.patch.object(novai_cli, "http_get_json", fake):
            code, out, err = _run(["canvas", "ls"])
        self.assertEqual(code, novai_cli.EXIT_UNREACHABLE)
        self.assertIn("连不上 127.0.0.1:3000", err)
        self.assertIn("请先启动 NOVAI", err)
        self.assertNotIn("Traceback", err)
        self.assertEqual(out, "")

    def test_http_error_is_reported_with_code(self):
        fake = FakeApi(error=novai_cli.CliError("服务返回 HTTP 404：画布不存在", novai_cli.EXIT_HTTP))
        with mock.patch.object(novai_cli, "http_get_json", fake):
            code, _out, err = _run(["canvas", "show", "missing-id"])
        self.assertEqual(code, novai_cli.EXIT_HTTP)
        self.assertIn("画布不存在", err)

    def test_write_command_is_blocked_with_exit_code_2(self):
        fake = FakeApi(payload={"canvases": []})
        with mock.patch.object(novai_cli, "http_get_json", fake):
            code, out, _err = _run(["node", "create"])
        self.assertEqual(code, novai_cli.EXIT_READ_ONLY)
        self.assertIn("本期只读", out)
        self.assertEqual(fake.calls, [])

    def test_write_command_after_global_flags_is_blocked(self):
        code, out, _err = _run(["--base-url", "http://127.0.0.1:3917", "image", "generate"])
        self.assertEqual(code, novai_cli.EXIT_READ_ONLY)
        self.assertIn("image.generate", out)

    def test_commands_prints_table_and_read_only_note(self):
        code, out, _err = _run(["commands"])
        self.assertEqual(code, 0)
        self.assertIn("node.create", out)
        self.assertIn("create_node", out)
        self.assertIn("canvas.list", out)
        self.assertIn("list_canvases", out)
        self.assertIn("本期只读，写命令未开放", out)
        self.assertIn("共 %d 条命令" % len(cli_spec.command_names()), out)

    def test_commands_json_shape(self):
        code, out, _err = _run(["commands", "--json"])
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["total"], len(cli_spec.command_names()))
        self.assertEqual(data["write_count"], len(EXPECTED_WRITE_COMMANDS))
        self.assertEqual(len(data["commands"]), data["total"])
        self.assertTrue(data["note"])
        self.assertEqual(data["local_commands"][-1]["name"], "commands")

    def test_canvas_show_json_uses_envelope(self):
        payload = {"canvas": {"id": "c9", "title": "详情画布", "project": "default",
                              "updated_at": 1700000000000,
                              "nodes": [{"id": "n1", "type": "smart-image"},
                                        {"id": "n2", "type": "smart-image"},
                                        {"id": "n3", "type": "smart-prompt"}]}}
        with mock.patch.object(novai_cli, "http_get_json", FakeApi(payload=payload)):
            code, out, _err = _run(["canvas", "show", "c9", "--json"])
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["id"], "c9")
        self.assertEqual(data["title"], "详情画布")
        self.assertEqual(data["node_count"], 3)
        self.assertEqual(data["type_counts"], {"smart-image": 2, "smart-prompt": 1})

    def test_nodes_ls_json_and_text(self):
        payload = {"canvas": {"id": "c1", "nodes": [{"id": "n1", "type": "smart-image", "title": "主图"}]}}
        with mock.patch.object(novai_cli, "http_get_json", FakeApi(payload=payload)):
            code, out, _err = _run(["nodes", "ls", "c1", "--json"])
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(data["canvas_id"], "c1")
            self.assertEqual(data["nodes"], [{"id": "n1", "type": "smart-image", "title": "主图"}])
        with mock.patch.object(novai_cli, "http_get_json", FakeApi(payload=payload)):
            code, out, _err = _run(["nodes", "ls", "c1"])
            self.assertEqual(code, 0)
            self.assertIn("n1", out)
            self.assertIn("主图", out)
            self.assertIn("共 1 个节点", out)

    def test_empty_canvas_list_is_explicit(self):
        with mock.patch.object(novai_cli, "http_get_json", FakeApi(payload={"canvases": []})):
            code, out, _err = _run(["canvas", "ls"])
        self.assertEqual(code, 0)
        self.assertIn("还没有画布", out)


class NodeSummaryTests(unittest.TestCase):

    def test_empty_canvas(self):
        summary = novai_cli.node_summary({"nodes": []})
        self.assertEqual(summary["node_count"], 0)
        self.assertEqual(summary["type_counts"], {})
        self.assertEqual(novai_cli.node_rows({"nodes": []}), [])

    def test_missing_fields_canvas(self):
        for canvas in ({}, {"nodes": None}, None, "not-a-dict", {"nodes": "oops"}):
            with self.subTest(canvas=canvas):
                summary = novai_cli.node_summary(canvas)
                self.assertEqual(summary["node_count"], 0)
                self.assertEqual(summary["type_counts"], {})
                self.assertEqual(novai_cli.node_rows(canvas), [])

    def test_normal_canvas_counts_and_rows(self):
        canvas = {"nodes": [
            {"id": "n1", "type": "smart-image", "title": "主图"},
            {"id": "n2", "type": "smart-prompt", "title": "提示词"},
            {"id": "n3", "type": "smart-image", "title": ""},
        ]}
        summary = novai_cli.node_summary(canvas)
        self.assertEqual(summary["node_count"], 3)
        self.assertEqual(summary["type_counts"], {"smart-image": 2, "smart-prompt": 1})
        self.assertEqual(list(summary["type_counts"].keys()), ["smart-image", "smart-prompt"])
        self.assertEqual(novai_cli.node_rows(canvas), [
            {"id": "n1", "type": "smart-image", "title": "主图"},
            {"id": "n2", "type": "smart-prompt", "title": "提示词"},
            {"id": "n3", "type": "smart-image", "title": ""},
        ])

    def test_nodes_missing_fields_get_placeholders(self):
        canvas = {"nodes": [{"id": "", "type": None, "title": None}, {}, "junk"]}
        rows = novai_cli.node_rows(canvas)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {"id": "-", "type": "unknown", "title": ""})
        self.assertEqual(rows[1], {"id": "-", "type": "unknown", "title": ""})
        self.assertEqual(novai_cli.node_summary(canvas)["node_count"], 2)
        self.assertEqual(novai_cli.node_summary(canvas)["type_counts"], {"unknown": 2})

    def test_title_is_truncated_to_forty_chars(self):
        row = novai_cli.node_rows({"nodes": [{"id": "n1", "type": "smart-image", "title": "字" * 45}]})[0]
        self.assertEqual(len(row["title"]), 41)
        self.assertEqual(row["title"], "字" * 40 + "…")
        exact = novai_cli.node_rows({"nodes": [{"id": "n1", "type": "t", "title": "字" * 40}]})[0]
        self.assertEqual(exact["title"], "字" * 40)
        self.assertNotIn("…", exact["title"])

    def test_truncate_helper(self):
        self.assertEqual(novai_cli.truncate(None), "")
        self.assertEqual(novai_cli.truncate("abc"), "abc")
        self.assertEqual(novai_cli.truncate("a" * 40), "a" * 40)
        self.assertEqual(novai_cli.truncate("a" * 41), "a" * 40 + "…")
        self.assertEqual(novai_cli.truncate("a\nb"), "a b")


class FormatAndPayloadTests(unittest.TestCase):

    def test_format_timestamp(self):
        self.assertEqual(novai_cli.format_timestamp(None), "-")
        self.assertEqual(novai_cli.format_timestamp(0), "-")
        self.assertEqual(novai_cli.format_timestamp("abc"), "-")
        self.assertRegex(novai_cli.format_timestamp(1700000000000), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
        self.assertEqual(novai_cli.format_timestamp(1700000000), novai_cli.format_timestamp(1700000000000))

    def test_canvas_title_fallbacks(self):
        self.assertEqual(novai_cli.canvas_title({"title": "标题"}), "标题")
        self.assertEqual(novai_cli.canvas_title({"name": "名字"}), "名字")
        self.assertEqual(novai_cli.canvas_title({}), "未命名画布")
        self.assertEqual(novai_cli.canvas_title({"title": "  "}), "未命名画布")
        self.assertEqual(novai_cli.canvas_title(None), "未命名画布")

    def test_unwrap_canvas(self):
        self.assertEqual(novai_cli.unwrap_canvas({"canvas": {"id": "x"}}), {"id": "x"})
        self.assertEqual(novai_cli.unwrap_canvas({"id": "x"}), {"id": "x"})
        self.assertEqual(novai_cli.unwrap_canvas([1, 2]), {})
        self.assertEqual(novai_cli.unwrap_canvas(None), {})

    def test_canvas_records(self):
        self.assertEqual(len(novai_cli.canvas_records({"canvases": [{"id": "a"}, "junk"]})), 1)
        self.assertEqual(len(novai_cli.canvas_records([{"id": "a"}])), 1)
        self.assertEqual(novai_cli.canvas_records({"canvases": None}), [])
        self.assertEqual(novai_cli.canvas_records(None), [])

    def test_default_base_url_uses_port_env(self):
        self.assertEqual(novai_cli.default_base_url({}), "http://127.0.0.1:3000")
        self.assertEqual(novai_cli.default_base_url({"NOVAI_PORT": "3917"}), "http://127.0.0.1:3917")


class TokenAndVersionTests(unittest.TestCase):

    def test_token_precedence(self):
        env = {"NOVAI_LAN_TOKEN": "env-token"}
        self.assertEqual(novai_cli.resolve_token("cli-token", env, "/nonexistent"), "cli-token")
        self.assertEqual(novai_cli.resolve_token(None, env, "/nonexistent"), "env-token")
        directory = tempfile.mkdtemp(prefix="novai-cli-test-")
        try:
            self.assertEqual(novai_cli.resolve_token(None, {}, directory), "")
            (Path(directory) / "data").mkdir()
            (Path(directory) / "data" / "security.json").write_text('{"lan_token": "file-token"}',
                                                                   encoding="utf-8")
            self.assertEqual(novai_cli.resolve_token(None, {}, directory), "file-token")
            (Path(directory) / "data" / "security.json").write_text("{坏 JSON", encoding="utf-8")
            self.assertEqual(novai_cli.resolve_token(None, {}, directory), "")
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def test_security_json_at_data_dir_root_is_accepted(self):
        directory = tempfile.mkdtemp(prefix="novai-cli-test-")
        try:
            (Path(directory) / "security.json").write_text('{"lan_token": "root-token"}', encoding="utf-8")
            self.assertEqual(novai_cli.resolve_token(None, {}, directory), "root-token")
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def test_read_version(self):
        self.assertEqual(novai_cli.read_version(str(ROOT)), (ROOT / "VERSION").read_text(encoding="utf-8").strip())
        self.assertEqual(novai_cli.read_version("/nonexistent-path-for-cli-test"), "-")


class HttpErrorMessageTests(unittest.TestCase):

    def _http_error(self, code, body):
        return urllib.error.HTTPError("http://127.0.0.1:3000/api/canvases", code, "err", None, io.BytesIO(body))

    def test_401_points_to_token_sources(self):
        raw = json.dumps({"detail": "需要局域网访问口令"}, ensure_ascii=False).encode("utf-8")
        message = novai_cli._http_error_message(self._http_error(401, raw))
        self.assertIn("HTTP 401", message)
        self.assertIn("NOVAI_LAN_TOKEN", message)
        self.assertIn("需要局域网访问口令", message)

    def test_404_keeps_server_detail(self):
        raw = json.dumps({"detail": "画布不存在"}, ensure_ascii=False).encode("utf-8")
        message = novai_cli._http_error_message(self._http_error(404, raw))
        self.assertIn("HTTP 404", message)
        self.assertIn("画布不存在", message)

    def test_non_json_body_is_still_reported(self):
        message = novai_cli._http_error_message(self._http_error(500, b"<html>boom</html>"))
        self.assertIn("HTTP 500", message)
        self.assertIn("boom", message)


@unittest.skipUnless(os.environ.get("NOVAI_TEST_URL"), "需要真实服务：设置 NOVAI_TEST_URL 后再跑")
class EndToEndTests(unittest.TestCase):

    def _run_json(self, argv):
        code, out, err = _run(argv)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_status_canvas_show_nodes_ls(self):
        url = os.environ["NOVAI_TEST_URL"].rstrip("/")
        status = self._run_json(["status", "--base-url", url, "--json"])
        self.assertTrue(status["reachable"])
        self.assertEqual(status["base_url"], url)

        listing = self._run_json(["canvas", "ls", "--base-url", url, "--json"])
        self.assertEqual(listing["count"], len(listing["canvases"]))
        if not listing["canvases"]:
            self.skipTest("测试服务里没有画布")
        canvas_id = listing["canvases"][0]["id"]

        detail = self._run_json(["canvas", "show", canvas_id, "--base-url", url, "--json"])
        self.assertEqual(detail["id"], canvas_id)
        self.assertEqual(detail["node_count"], sum(detail["type_counts"].values()))

        nodes = self._run_json(["nodes", "ls", canvas_id, "--base-url", url, "--json"])
        self.assertEqual(nodes["canvas_id"], canvas_id)
        self.assertEqual(len(nodes["nodes"]), detail["node_count"])


if __name__ == "__main__":
    unittest.main()
