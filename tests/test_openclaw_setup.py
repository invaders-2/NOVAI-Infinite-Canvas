#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenClaw 按需安装引导（后端）单测。

覆盖：
  - 安装命令 / 地址 / 版本要求只来自 config/openclaw.json（环境变量可覆盖）
  - Node 版本判定边界（24.16+ 或 26.1+）
  - 隔离环境下「未安装」检测不抛异常、不刷屏，并如实判定 needsInstall
  - 没有调用安装会话时，安装命令绝不会被执行（mtime/文件为证）
  - 确认后执行 → 实时回传日志 → 自动重新检测验证，整条链真跑（用假 openclaw 二进制，不装任何东西）
  - 权限提示 / 权限失败识别与手动指引只来自配置（env 可覆盖）
  - Chrome/Chromium 检测：配置文件路径 + 环境变量覆盖，找不到时只如实标记、不阻断

跑法：/usr/bin/python3 tests/test_openclaw_setup.py
"""
import asyncio
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.integrations import openclaw_setup as s  # noqa: E402

OFFICIAL_UNIX = "curl -fsSL https://openclaw.ai/install.sh | bash"
OFFICIAL_WIN = "iwr -useb https://openclaw.ai/install.ps1 | iex"


@contextmanager
def env(**values):
    saved = {k: os.environ.get(k) for k in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = str(value)
        s.invalidate_cache()
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        s.invalidate_cache()
        s._ACTIVE = None


def make_fake_openclaw(folder, version="9.9.9"):
    path = os.path.join(folder, "openclaw")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("#!/bin/sh\necho \"OpenClaw %s (test)\"\n" % version)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


class TestConfigDriven(unittest.TestCase):
    def test_official_command_comes_from_config(self):
        cfg, source = s.load_config()
        self.assertTrue(cfg, "config/openclaw.json 应可读")
        settings = s.resolved_settings(cfg)
        self.assertEqual(OFFICIAL_UNIX, settings["command"])
        self.assertEqual("install.command_unix", settings["command_origin"])
        self.assertEqual("https://openclaw.ai/install.sh", settings["script_url"])
        self.assertTrue(settings["size_hint"], "体积提示来自配置")
        self.assertTrue(settings["network_note"], "联网提示来自配置")

    def test_windows_command_and_url_configured(self):
        cfg, _ = s.load_config()
        self.assertEqual(OFFICIAL_WIN, cfg["install"]["command_windows"])
        self.assertEqual("https://openclaw.ai/install.ps1", cfg["install"]["script_url_windows"])

    def test_env_override_wins_and_is_reported(self):
        with env(NOVAI_OPENCLAW_INSTALL_COMMAND="echo override-me"):
            settings = s.resolved_settings(s.load_config()[0])
            self.assertEqual("echo override-me", settings["command"])
            self.assertEqual("env:NOVAI_OPENCLAW_INSTALL_COMMAND", settings["command_origin"])

    def test_missing_config_is_tolerated(self):
        with env(NOVAI_OPENCLAW_SETUP_CONFIG="/nonexistent/openclaw.json"):
            data = s.detect(force=True)
            self.assertFalse(data["config_ok"])
            self.assertEqual("", data["setup"]["command"])
            self.assertIsInstance(data["errors"], list)

    def test_privilege_and_permission_hint_from_config(self):
        cfg, _ = s.load_config()
        settings = s.resolved_settings(cfg)
        self.assertIn("管理员权限", settings["privilege_note"])
        self.assertIn("Node.js", settings["privilege_note"])
        self.assertEqual("install.privilege_note", settings["privilege_note_origin"])
        # 条件式：Node 达标无系统权限操作，不达标才经系统包管理器
        self.assertIn("达标", settings["privilege_note"])
        self.assertIn("Homebrew", settings["privilege_note"])
        self.assertTrue(settings["permission_hint"], "权限失败手动指引来自配置")
        self.assertEqual("install.permission_hint", settings["permission_hint_origin"])
        self.assertTrue(s.permission_patterns(cfg), "权限失败识别特征来自配置")

    def test_env_override_privilege_and_permission(self):
        with env(NOVAI_OPENCLAW_INSTALL_PRIVILEGE_NOTE="自定义权限提示",
                 NOVAI_OPENCLAW_INSTALL_PERMISSION_HINT="自定义手动指引"):
            settings = s.resolved_settings(s.load_config()[0])
            self.assertEqual("自定义权限提示", settings["privilege_note"])
            self.assertEqual("env:NOVAI_OPENCLAW_INSTALL_PRIVILEGE_NOTE", settings["privilege_note_origin"])
            self.assertEqual("自定义手动指引", settings["permission_hint"])
            self.assertEqual("env:NOVAI_OPENCLAW_INSTALL_PERMISSION_HINT", settings["permission_hint_origin"])

    def test_node_warning_and_doctor_steps_from_config(self):
        cfg, _ = s.load_config()
        settings = s.resolved_settings(cfg)
        self.assertIn("Homebrew", settings["node_warning"])
        self.assertIn("macOS", settings["node_warning"])
        self.assertEqual("node.warning", settings["node_warning_origin"])
        self.assertTrue(settings["node_warning_title"], "Node 系统级改动警告标题来自配置")
        self.assertTrue(settings["init_incomplete_title"], "初始化未完成标题来自配置")
        self.assertIn("doctor", settings["init_incomplete_note"])
        self.assertEqual("install.init_incomplete_note", settings["init_incomplete_note_origin"])
        self.assertEqual("install.doctor_steps", settings["doctor_steps_origin"])
        values = [step["value"] for step in settings["doctor_steps"]]
        self.assertIn("openclaw doctor --fix", values, "doctor 收尾步骤来自配置")
        self.assertTrue(settings["doctor_hint"], "doctor 收尾提示来自配置")

    def test_env_override_warning_and_doctor_steps(self):
        raw = "停::my-stop\n修::my-fix\n启::my-start"
        with env(NOVAI_OPENCLAW_NODE_WARNING="自定义系统级警告",
                 NOVAI_OPENCLAW_NODE_WARNING_TITLE="自定义标题",
                 NOVAI_OPENCLAW_INSTALL_INIT_INCOMPLETE_NOTE="自定义收尾说明",
                 NOVAI_OPENCLAW_INSTALL_DOCTOR_STEPS=raw):
            settings = s.resolved_settings(s.load_config()[0])
            self.assertEqual("自定义系统级警告", settings["node_warning"])
            self.assertEqual("env:NOVAI_OPENCLAW_NODE_WARNING", settings["node_warning_origin"])
            self.assertEqual("自定义标题", settings["node_warning_title"])
            self.assertEqual("env:NOVAI_OPENCLAW_NODE_WARNING_TITLE", settings["node_warning_title_origin"])
            self.assertEqual("自定义收尾说明", settings["init_incomplete_note"])
            self.assertEqual("env:NOVAI_OPENCLAW_INSTALL_INIT_INCOMPLETE_NOTE", settings["init_incomplete_note_origin"])
            self.assertEqual("env:NOVAI_OPENCLAW_INSTALL_DOCTOR_STEPS", settings["doctor_steps_origin"])
            self.assertEqual(["my-stop", "my-fix", "my-start"], [step["value"] for step in settings["doctor_steps"]])
            self.assertEqual(["停", "修", "启"], [step["label"] for step in settings["doctor_steps"]])

    def test_node_satisfies_boundaries(self):
        self.assertFalse(s.node_satisfies("22.22.3", "24.16.0", "26.1.0"))
        self.assertFalse(s.node_satisfies("24.15.9", "24.16.0", "26.1.0"))
        self.assertTrue(s.node_satisfies("24.16.0", "24.16.0", "26.1.0"))
        self.assertTrue(s.node_satisfies("25.3.0", "24.16.0", "26.1.0"))
        self.assertFalse(s.node_satisfies("26.0.5", "24.16.0", "26.1.0"))
        self.assertTrue(s.node_satisfies("26.1.0", "24.16.0", "26.1.0"))
        self.assertFalse(s.node_satisfies("", "24.16.0", "26.1.0"))


class TestDetection(unittest.TestCase):
    def test_isolated_env_reports_not_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = os.path.join(tmp, "home")
            os.makedirs(fake_home)
            with env(HOME=fake_home, NOVAI_OPENCLAW_BIN=os.path.join(tmp, "missing", "openclaw"),
                     NOVAI_OPENCLAW_BIN_DIRS=os.path.join(tmp, "empty-bin")):
                data = s.detect(force=True)
                self.assertTrue(data["ok"])
                self.assertFalse(data["installed"])
                self.assertFalse(data["available"])
                self.assertEqual("", data["version"])
                # 没装时不产生刷屏错误：errors 只用于「装了但跑不起来」这类真问题
                self.assertEqual([], data["errors"])

    def test_fake_binary_is_detected_with_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = make_fake_openclaw(tmp)
            with env(NOVAI_OPENCLAW_BIN=binary):
                data = s.detect(force=True)
                self.assertTrue(data["installed"])
                self.assertTrue(data["available"])
                self.assertEqual("9.9.9", data["version"])

    def test_detect_is_cached_until_forced(self):
        with env(NOVAI_OPENCLAW_BIN=None):
            first = s.detect(force=True)
            second = s.detect()
            self.assertTrue(second.get("cached"))
            self.assertEqual(first["checked_at"], second["checked_at"])

    def test_detection_never_runs_install_command(self):
        """只调用检测（界面出现引导入口）时，安装命令绝不能被碰一下。"""
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "installed.marker")
            command = "touch %s" % marker
            with env(NOVAI_OPENCLAW_INSTALL_COMMAND=command, NOVAI_OPENCLAW_BIN=os.path.join(tmp, "nope")):
                data = s.detect(force=True)
                self.assertFalse(data["installed"])
                self.assertEqual(command, data["setup"]["command"])
                self.assertFalse(os.path.exists(marker), "检测阶段不得执行安装命令")

    def test_chrome_detected_from_env_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            chrome = os.path.join(tmp, "Google Chrome")
            with open(chrome, "w", encoding="utf-8") as handle:
                handle.write("#!/bin/sh\necho Chrome\n")
            os.chmod(chrome, os.stat(chrome).st_mode | stat.S_IXUSR)
            with env(NOVAI_OPENCLAW_CHROME_PATHS=chrome):
                data = s.detect(force=True)
                self.assertTrue(data["chrome"]["found"])
                self.assertEqual(chrome, data["chrome"]["path"])
                self.assertEqual("env:NOVAI_OPENCLAW_CHROME_PATHS", data["chrome"]["source"])
                self.assertTrue(data["chrome"]["impact_note"], "Chrome 缺失提示文案来自配置")

    def test_chrome_missing_is_reported_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            with env(NOVAI_OPENCLAW_CHROME_PATHS=os.path.join(tmp, "nope", "chrome")):
                data = s.detect(force=True)
                self.assertFalse(data["chrome"]["found"])
                self.assertEqual("", data["chrome"]["path"])
                self.assertTrue(data["chrome"]["impact_note"])
                # Chrome 缺失不影响 OpenClaw 本体检测结果
                self.assertIn("available", data)

    def test_cancel_without_active_session(self):
        s._ACTIVE = None
        self.assertFalse(s.cancel_install())


class TestInstallSession(unittest.TestCase):
    def test_confirmed_install_runs_logs_and_verifies(self):
        """确认 → 执行 → 日志 → 重新检测验证。用假 openclaw，不装真东西。"""
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home)
            binary = make_fake_openclaw(home, version="2026.6.9")
            marker = os.path.join(tmp, "ran.marker")
            command = "printf 'installing openclaw\\n' && touch %s" % marker
            with env(HOME=home, NOVAI_OPENCLAW_BIN=binary,
                     NOVAI_OPENCLAW_INSTALL_COMMAND=command,
                     NOVAI_OPENCLAW_BIN_DIRS=tmp):
                session = s.begin_install()
                events = asyncio.new_event_loop().run_until_complete(_collect(session))

                kinds = [e["event"] for e in events]
                self.assertEqual("start", kinds[0])
                self.assertEqual(command, events[0]["command"])
                self.assertIn("log", kinds)
                self.assertIn("verify", kinds)
                self.assertEqual("done", kinds[-1])
                logs = "\n".join(e.get("line", "") for e in events if e["event"] == "log")
                self.assertIn("installing openclaw", logs)
                self.assertTrue(os.path.exists(marker), "确认后命令确实执行了")
                done = events[-1]
                self.assertTrue(done["ok"], "假二进制可被检测 → 验证通过")
                self.assertTrue(done["result"]["available"])
                self.assertEqual("done", session.status)
                self.assertEqual("success", done["outcome"])
                self.assertFalse(done["init_incomplete"])
                self.assertEqual("success", session.outcome)
                self.assertFalse(session.init_incomplete)

    def test_permission_failure_is_reported_with_guidance(self):
        """造一个 sudo / 权限报错的命令：识别成权限失败并给明确错误 + 手动指引，而不是只回传原始日志。"""
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home)
            command = "printf 'sudo: a password is required\\n'; exit 1"
            with env(HOME=home, NOVAI_OPENCLAW_BIN=os.path.join(tmp, "nope"),
                     NOVAI_OPENCLAW_BIN_DIRS=os.path.join(tmp, "empty-bin"),
                     NOVAI_OPENCLAW_INSTALL_COMMAND=command):
                session = s.begin_install()
                events = asyncio.new_event_loop().run_until_complete(_collect(session))

                errors = [e for e in events if e["event"] == "error"]
                self.assertTrue(errors, "权限失败要单独给一条 error 事件")
                self.assertEqual("permission_denied", errors[0]["code"])
                self.assertEqual("permission_denied", session.error_code)
                hint = s.resolved_settings(s.load_config()[0])["permission_hint"]
                self.assertEqual(hint, errors[0]["hint"])
                self.assertIn("权限不足", session.error)
                self.assertIn(hint[:10], session.error, "明确错误里要带手动指引")
                self.assertEqual("permission_denied", session.snapshot()["error_code"])

                done = events[-1]
                self.assertEqual("done", done["event"])
                self.assertFalse(done["ok"])
                self.assertEqual("permission_denied", done["code"])
                self.assertIn("权限不足", done["message"])

    def test_second_install_is_rejected_while_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home)
            with env(HOME=home, NOVAI_OPENCLAW_BIN=os.path.join(tmp, "nope"),
                     NOVAI_OPENCLAW_INSTALL_COMMAND="sleep 5"):
                session = s.begin_install()
                session.status = "running"
                with self.assertRaises(s.InstallError):
                    s.begin_install()


    def test_package_installed_but_doctor_failed_is_partial(self):
        """实测场景：包已装成功但 doctor 以 EXIT=1 结束 → 归为「初始化未完成」并给 doctor 收尾指引。"""
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home)
            binary = make_fake_openclaw(home, version="2026.10.3")
            command = ("printf '[2/4] OpenClaw installed\n"
                       "[3/4] doctor failed: session-entry-state: schema-missing\n'; exit 1")
            with env(HOME=home, NOVAI_OPENCLAW_BIN=binary,
                     NOVAI_OPENCLAW_BIN_DIRS=tmp,
                     NOVAI_OPENCLAW_INSTALL_COMMAND=command):
                session = s.begin_install()
                events = asyncio.new_event_loop().run_until_complete(_collect(session))

                done = events[-1]
                self.assertEqual("done", done["event"])
                self.assertFalse(done["ok"], "收尾失败不算成功")
                self.assertEqual("init_incomplete", done["code"])
                self.assertEqual("partial", done["outcome"])
                self.assertTrue(done["init_incomplete"])
                self.assertTrue(session.init_incomplete)
                self.assertEqual("partial", session.outcome)
                self.assertEqual("init_incomplete", session.snapshot()["error_code"])
                self.assertTrue(session.result["installed"], "包确实装上了，只是初始化没完成")
                # 错误里带配置的收尾标题与 doctor 指引，不是一句笼统的失败
                settings = s.resolved_settings(s.load_config()[0])
                self.assertIn(settings["init_incomplete_title"], session.error)
                self.assertTrue(settings["doctor_steps"])
                values = [step["value"] for step in settings["doctor_steps"]]
                self.assertIn("openclaw doctor --fix", values)

    def test_failed_without_package_stays_failed(self):
        """脚本失败且本机并没装上包 → 仍是失败，不误判成初始化未完成。"""
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home)
            with env(HOME=home, NOVAI_OPENCLAW_BIN=os.path.join(tmp, "nope"),
                     NOVAI_OPENCLAW_BIN_DIRS=os.path.join(tmp, "empty-bin"),
                     NOVAI_OPENCLAW_INSTALL_COMMAND="printf 'boom\n'; exit 1"):
                session = s.begin_install()
                events = asyncio.new_event_loop().run_until_complete(_collect(session))

                done = events[-1]
                self.assertEqual("done", done["event"])
                self.assertFalse(done["ok"])
                self.assertFalse(done.get("init_incomplete"))
                self.assertEqual("failed", done["outcome"])
                self.assertEqual("failed", session.outcome)
                self.assertFalse(session.init_incomplete)


async def _collect(session):
    out = []
    async for item in session.stream():
        out.append(item)
    return out


if __name__ == "__main__":
    unittest.main(verbosity=2)
