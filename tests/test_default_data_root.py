"""默认数据根：新装「程序装在哪，数据就在哪」，老用户 / 只读安装目录 / macOS 回落用户目录。

覆盖：
  1. 新装 + 安装目录可写 → 安装目录（origin=install），素材/生成物跟着数据根；
  2. 用户目录已有数据（users.db / 画布 / 素材 / 输出 / settings / history）→ 用户目录；
  3. 只读安装目录（写探测失败 / AppImage / deb 装到 /usr、/opt）→ 用户目录；
  4. macOS 一律用户目录（哪怕安装目录可写、也没有老数据）；
  5. 稳定配置里的 data_root 优先（startup_data_root），env 仍然最优先；
  6. 首次判定写进稳定配置并记来源，已有配置不覆盖；老用户不写（留给「迁到安装目录」提示）；
  7. 素材/生成物跟随数据根（不再有「安装目录旁」那条路径）；
  8. 源码运行仍是仓库目录且不写配置；
  9. launcher.py（pywebview 正式版）的判定与 main.py 同口径。

全部在临时目录里跑（不碰真实用户数据、不联网、不起服务）。
跑法：python3 -m unittest tests.test_default_data_root -v
"""
import inspect
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main
import launcher


class DefaultDataRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-default-root-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.install = os.path.join(self.tmp, "install")
        os.makedirs(self.install)
        self.user_root = os.path.join(self.tmp, "home", "NOVAI")
        os.makedirs(self.user_root)
        self.patches = [
            patch.object(main, "_user_data_root", side_effect=lambda: self.user_root),
            patch.object(main, "_install_root", side_effect=lambda: self.install),
            patch.object(main, "_is_macos", return_value=False),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self._stop)
        os.environ.pop("APPIMAGE", None)
        os.environ.pop("NOVAI_INSTALL_DIR", None)

    def _stop(self):
        for item in reversed(self.patches):
            item.stop()

    def seed(self, *relatives):
        for relative in relatives:
            target = os.path.join(self.user_root, *relative.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write("x")

    # ---------- 1. 新装可写 → 安装目录 ----------
    def test_fresh_install_writable_uses_install_dir(self):
        self.assertFalse(main._user_root_has_data(self.user_root))
        self.assertEqual(main.default_data_root(), self.install)
        self.assertEqual(main.default_data_root_origin(self.install), "install")

    def test_new_install_assets_and_outputs_follow_install_root(self):
        os.makedirs(os.path.join(self.install, "assets"))
        with patch.object(main, "_DATA_ROOT", self.install), \
                patch.object(main, "_custom_storage", ""), \
                patch.dict(os.environ, {"NOVAI_INSTALL_DIR": self.install}):
            self.assertEqual(main.resolve_default_assets_dir(), os.path.join(self.install, "assets"))

    # ---------- 2. 老用户（用户目录已有数据）→ 用户目录 ----------
    def test_existing_user_data_keeps_user_root(self):
        signals = (
            "data/users.db",
            "data/settings.json",
            "history.json",
            "data/canvases/c1.json",
            "assets/library/lib.json",
            "output/gen.png",
        )
        for relative in signals:
            with self.subTest(signal=relative):
                self.seed(relative)
                try:
                    self.assertEqual(main.default_data_root(), self.user_root)
                    self.assertEqual(main.default_data_root_origin(self.user_root), "user")
                    # 老用户不写配置：否则会被当成「用户自己选过位置」，挡掉迁移提示
                    self.assertFalse(main._should_fix_default_root(self.user_root, "user"))
                finally:
                    os.remove(os.path.join(self.user_root, *relative.split("/")))

    def test_empty_created_dirs_are_not_old_data(self):
        for relative in ("data/canvases", "assets", "output"):
            os.makedirs(os.path.join(self.user_root, *relative.split("/")), exist_ok=True)
        self.assertFalse(main._user_root_has_data(self.user_root))
        self.assertEqual(main.default_data_root(), self.install)

    # ---------- 3. 只读安装目录 → 用户目录 ----------
    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root 下 chmod 不阻止写入")
    def test_readonly_install_dir_falls_back(self):
        os.chmod(self.install, 0o555)
        self.addCleanup(os.chmod, self.install, 0o755)
        self.assertTrue(main._install_dir_readonly(self.install))
        self.assertEqual(main.default_data_root(), self.user_root)

    def test_appimage_falls_back(self):
        with patch.dict(os.environ, {"APPIMAGE": "/tmp/NOVAI-2.0.6.AppImage"}):
            self.assertTrue(main._install_dir_readonly(self.install))
            self.assertEqual(main.default_data_root(), self.user_root)

    def test_system_install_dirs_are_readonly(self):
        for system_dir in ("/usr", "/usr/lib/novai", "/opt/NOVAI", "/snap/novai/1", "/Applications/NOVAI.app"):
            with self.subTest(system_dir=system_dir):
                # /Applications 是 macOS 分支先拦住的，这里只验证系统目录清单本身
                if system_dir.startswith("/Applications"):
                    continue
                self.assertTrue(main._install_dir_readonly(system_dir))

    def test_windows_program_files_is_protected(self):
        # 真实 Windows 分支只能在 Windows 上跑；这里守住「Program Files 必须进清单」这条规则
        source = inspect.getsource(main._install_dir_readonly)
        self.assertIn("PROGRAMFILES", source)
        self.assertIn("APPIMAGE", source)
        self.assertIn("/usr", source)
        self.assertIn("/opt", source)

    # ---------- 4. macOS 一律用户目录 ----------
    def test_macos_always_user_root(self):
        with patch.object(main, "_is_macos", return_value=True):
            self.assertEqual(main.default_data_root(), self.user_root)

    # ---------- 5/8. 源码运行与配置优先 ----------
    def test_source_run_keeps_repo_and_is_not_pinned(self):
        with patch.object(main, "_install_root", return_value=""):
            self.assertEqual(main.default_data_root(), main.BASE_DIR)
            self.assertEqual(main.default_data_root_origin(main.BASE_DIR), "")
            self.assertFalse(main._should_fix_default_root(main.BASE_DIR, ""))

    def test_frozen_without_executable_path_falls_back(self):
        with patch.object(main, "_install_root", return_value=""), \
                patch.object(main.sys, "frozen", True, create=True):
            self.assertEqual(main.default_data_root(), self.user_root)

    def test_startup_root_priority(self):
        root, source, warning = main.startup_data_root("/tmp/env-root", "/tmp/cfg-root")
        self.assertEqual(root, os.path.abspath("/tmp/env-root"))
        self.assertEqual((source, warning), ("env", ""))
        # env 与配置同一目录 → 按配置算（桌面壳就是这么注入的，设置页不该显示「环境变量」）
        self.assertEqual(main.startup_data_root("/tmp/same", "/tmp/same")[1], "config")
        configured = os.path.join(self.tmp, "configured")
        os.makedirs(configured)
        self.assertEqual(main.startup_data_root("", configured)[:2], (configured, "config"))
        gone = os.path.join(self.tmp, "gone")
        root, source, warning = main.startup_data_root("", gone)
        self.assertEqual((root, source), (self.install, "default"))
        self.assertIn("不可用", warning)

    # ---------- 6. 首次判定写进稳定配置 ----------
    def test_persist_writes_once_with_origin(self):
        cfg_file = os.path.join(self.tmp, "cfg", "config.json")
        with patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            main._persist_default_data_root(self.install, "install")
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.assertEqual(cfg["data_root"], self.install)
            self.assertEqual(cfg["data_root_origin"], "install")
            main._persist_default_data_root(self.user_root, "user")
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.assertEqual(cfg["data_root"], self.install, "已有配置不能被默认判定覆盖")

    def test_persist_keeps_other_config_keys(self):
        cfg_file = os.path.join(self.tmp, "cfg", "config.json")
        os.makedirs(os.path.dirname(cfg_file))
        with open(cfg_file, "w", encoding="utf-8") as f:
            json.dump({"lan_token": "abc", "storage_path": "/x"}, f)
        with patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            main._persist_default_data_root(self.install, "install")
        with open(cfg_file, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["lan_token"], "abc")
        self.assertEqual(cfg["storage_path"], "/x")
        self.assertEqual(cfg["data_root"], self.install)

    def test_should_fix_only_for_install_or_empty_user_root(self):
        self.assertTrue(main._should_fix_default_root(self.install, "install"))
        self.assertTrue(main._should_fix_default_root(self.user_root, "user"))
        self.seed("data/users.db")
        self.assertFalse(main._should_fix_default_root(self.user_root, "user"))

    # ---------- 7. 素材跟随数据根 ----------
    def test_assets_resolver_has_no_install_dir_branch(self):
        source = inspect.getsource(main.resolve_default_assets_dir)
        self.assertNotIn("NOVAI_INSTALL_DIR", source)
        self.assertNotIn("NOVAI_APP_DIR", source)
        with patch.object(main, "_DATA_ROOT", self.user_root), patch.object(main, "_custom_storage", ""):
            self.assertEqual(main.resolve_default_assets_dir(), os.path.join(self.user_root, "assets"))

    # ---------- 9. launcher.py 同口径 ----------
    def test_launcher_rules_match_main(self):
        with patch.object(launcher, "user_data_root", return_value=self.user_root), \
                patch.object(launcher.sys, "platform", "linux"):
            self.assertEqual(launcher.default_data_root(self.install), self.install)
            self.assertEqual(launcher.data_root_origin(self.install, self.install), "install")
            self.assertEqual(launcher.data_root_origin(self.user_root, self.install), "user")
            self.seed("data/users.db")
            self.assertEqual(launcher.default_data_root(self.install), self.user_root)

    def test_launcher_macos_and_appimage(self):
        with patch.object(launcher, "user_data_root", return_value=self.user_root), \
                patch.object(launcher.sys, "platform", "darwin"):
            self.assertEqual(launcher.default_data_root(self.install), self.user_root)
        with patch.object(launcher, "user_data_root", return_value=self.user_root), \
                patch.object(launcher.sys, "platform", "linux"), \
                patch.dict(os.environ, {"APPIMAGE": "/tmp/NOVAI.AppImage"}):
            self.assertEqual(launcher.default_data_root(self.install), self.user_root)

    def test_launcher_persist_skips_old_user_and_keeps_keys(self):
        cfg_file = os.path.join(self.tmp, "cfg2", "config.json")
        with patch.object(launcher, "user_data_root", return_value=self.user_root):
            launcher.persist_data_root(cfg_file, self.user_root, "user")
            self.assertTrue(os.path.isfile(cfg_file), "全新回落用户目录 → 要固定下来")
        os.remove(cfg_file)
        self.seed("data/users.db")
        with patch.object(launcher, "user_data_root", return_value=self.user_root):
            launcher.persist_data_root(cfg_file, self.user_root, "user")
            self.assertFalse(os.path.isfile(cfg_file), "老用户不写配置")
            launcher.persist_data_root(cfg_file, self.install, "install")
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.assertEqual((cfg["data_root"], cfg["data_root_origin"]), (self.install, "install"))
            launcher.persist_data_root(cfg_file, self.user_root, "user")
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.assertEqual(cfg["data_root"], self.install)


    # ---------- 10. 老用户素材在安装目录旁的兼容护栏 ----------
    def write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def install_assets_with_data(self):
        install_assets = os.path.join(self.install, "assets")
        self.write(os.path.join(install_assets, "library", "lib.png"), "PNG")
        return install_assets

    def assets_guard(self, data_root, source="env", configured=""):
        with patch.object(main, "_DATA_ROOT", data_root), \
                patch.object(main, "_DATA_ROOT_SOURCE", source), \
                patch.object(main, "_CONFIGURED_ROOT_AT_START", configured):
            return main._resolve_assets_dir("")

    def test_assets_dir_has_data_ignores_empty_dirs(self):
        empty = os.path.join(self.tmp, "empty-assets")
        for name in ("input", "output", "library", "uploads"):
            os.makedirs(os.path.join(empty, name))
        self.assertFalse(main._assets_dir_has_data(empty))
        self.write(os.path.join(empty, "library", "a.png"), "PNG")
        self.assertTrue(main._assets_dir_has_data(empty))

    def test_old_user_keeps_install_assets(self):
        install_assets = self.install_assets_with_data()
        self.seed("data/users.db")  # 老用户：账号库/画布/注册表在用户目录
        assets_dir, source = self.assets_guard(self.user_root)
        self.assertEqual(assets_dir, install_assets, "老用户的素材库还在安装目录旁，必须沿用")
        self.assertEqual(source, "install_legacy")

    def test_new_install_uses_data_root_assets(self):
        self.install_assets_with_data()
        # 全新安装且安装目录可写：数据根本身就是安装目录
        assets_dir, source = self.assets_guard(self.install, source="default")
        self.assertEqual((assets_dir, source), (os.path.join(self.install, "assets"), "data_root"))

    def test_configured_data_root_keeps_assets_under_root(self):
        self.install_assets_with_data()
        self.seed("data/users.db")
        assets_dir, source = self.assets_guard(self.user_root, source="config", configured=self.user_root)
        self.assertEqual((assets_dir, source), (os.path.join(self.user_root, "assets"), "config"))

    def test_readonly_install_assets_are_not_adopted(self):
        self.install_assets_with_data()
        with patch.object(main, "_dir_writable", return_value=False):
            assets_dir, source = self.assets_guard(self.user_root)
        self.assertEqual((assets_dir, source), (os.path.join(self.user_root, "assets"), "data_root"))

    def test_data_root_assets_with_content_are_kept(self):
        self.install_assets_with_data()
        self.seed("data/users.db")
        self.write(os.path.join(self.user_root, "assets", "input", "a.png"), "PNG")
        assets_dir, source = self.assets_guard(self.user_root)
        self.assertEqual((assets_dir, source), (os.path.join(self.user_root, "assets"), "data_root"))

    def test_macos_never_adopts_install_assets(self):
        self.install_assets_with_data()
        self.seed("data/users.db")
        with patch.object(main, "_is_macos", return_value=True):
            assets_dir, source = self.assets_guard(self.user_root)
        self.assertEqual(assets_dir, os.path.join(self.user_root, "assets"))

    def test_legacy_storage_path_still_wins(self):
        custom = os.path.join(self.tmp, "custom-assets")
        os.makedirs(custom)
        assets_dir, source = main._resolve_assets_dir(custom)
        self.assertEqual((assets_dir, source), (custom, "legacy_config"))

    # ---------- 11. macOS：旧 .app 包内素材一次性复制进数据根 ----------
    def legacy_app_assets(self, root=None):
        """造一份「旧版写在 .app 包内」的素材目录。"""
        legacy = os.path.join(root or self.install, "assets")
        self.write(os.path.join(legacy, "library", "lib.png"), "PNG")
        self.write(os.path.join(legacy, "input", "up.png"), "UP")
        self.write(os.path.join(legacy, "asset_library.json"), '{"libraries": []}')
        self.write(os.path.join(legacy, "notes.txt"), "junk")  # 无关文件不能被搬
        return legacy

    def import_config(self):
        cfg_file = os.path.join(self.tmp, "import-cfg", "config.json")
        return cfg_file

    def run_import(self, cfg_file, assets_dir=None):
        assets_dir = assets_dir or os.path.join(self.user_root, "assets")
        with patch.object(main, "_is_macos", return_value=True), \
                patch.object(main, "_DATA_ROOT", self.user_root), \
                patch.object(main, "_CONFIGURED_ROOT_AT_START", ""), \
                patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            return main.import_legacy_assets_once(assets_dir)

    def test_macos_legacy_assets_imported_once(self):
        legacy = self.legacy_app_assets()
        cfg_file = self.import_config()
        assets_dir = os.path.join(self.user_root, "assets")
        result = self.run_import(cfg_file, assets_dir)
        self.assertTrue(result["imported"], result)
        self.assertEqual(result["from"], legacy)
        # 已知子项 + 注册表 JSON 复制过去，无关文件不搬
        self.assertTrue(os.path.isfile(os.path.join(assets_dir, "library", "lib.png")))
        self.assertTrue(os.path.isfile(os.path.join(assets_dir, "input", "up.png")))
        self.assertTrue(os.path.isfile(os.path.join(assets_dir, "asset_library.json")))
        self.assertFalse(os.path.exists(os.path.join(assets_dir, "notes.txt")))
        # 旧目录一个字节不删
        self.assertTrue(os.path.isfile(os.path.join(legacy, "library", "lib.png")))
        self.assertTrue(os.path.isfile(os.path.join(legacy, "notes.txt")))
        # 标记写进稳定配置
        with open(cfg_file, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["assets_legacy_imported"]["from"], legacy)
        self.assertEqual(cfg["assets_legacy_imported"]["to"], assets_dir)
        self.assertTrue(cfg["assets_legacy_imported"]["at"])

    def test_macos_legacy_import_is_one_time(self):
        legacy = self.legacy_app_assets()
        cfg_file = self.import_config()
        assets_dir = os.path.join(self.user_root, "assets")
        self.assertTrue(self.run_import(cfg_file, assets_dir)["imported"])
        # 清掉复制结果，模拟「标记在、素材被用户删了」：绝不能再搬第二次
        shutil.rmtree(assets_dir)
        result = self.run_import(cfg_file, assets_dir)
        self.assertFalse(result["imported"])
        self.assertEqual(result["reason"], "already_imported")
        self.assertFalse(os.path.isdir(assets_dir))
        self.assertTrue(os.path.isfile(os.path.join(legacy, "library", "lib.png")))

    def test_macos_legacy_import_from_app_bundle_path(self):
        app_root = os.path.join(self.tmp, "NOVAI.app", "Contents", "Resources", "backend")
        legacy = self.legacy_app_assets(app_root)
        cfg_file = self.import_config()
        with patch.object(main, "_install_root", return_value=""), \
                patch.dict(os.environ, {"NOVAI_APP_DIR": app_root}):
            result = self.run_import(cfg_file)
        self.assertTrue(result["imported"], result)
        self.assertEqual(result["from"], legacy)
        self.assertTrue(os.path.isfile(os.path.join(self.user_root, "assets", "library", "lib.png")))

    def test_macos_legacy_import_skipped_when_data_root_has_assets(self):
        self.legacy_app_assets()
        self.write(os.path.join(self.user_root, "assets", "library", "mine.png"), "MINE")
        result = self.run_import(self.import_config())
        self.assertFalse(result["imported"])
        self.assertEqual(result["reason"], "assets_already_have_data")
        self.assertFalse(os.path.exists(self.import_config()))

    def test_macos_legacy_import_skipped_when_data_root_configured(self):
        self.legacy_app_assets()
        cfg_file = self.import_config()
        elsewhere = os.path.join(self.tmp, "other-root")
        os.makedirs(elsewhere)
        with patch.object(main, "_is_macos", return_value=True), \
                patch.object(main, "_DATA_ROOT", self.user_root), \
                patch.object(main, "_CONFIGURED_ROOT_AT_START", elsewhere), \
                patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            result = main.import_legacy_assets_once(os.path.join(self.user_root, "assets"))
        self.assertEqual(result["reason"], "configured", "用户把数据根选到别处，不碰他的素材")
        self.assertFalse(os.path.exists(cfg_file))
        self.assertFalse(os.path.isdir(os.path.join(self.user_root, "assets")))

    def test_macos_legacy_import_skipped_when_data_root_is_not_user_root(self):
        self.legacy_app_assets()
        cfg_file = self.import_config()
        with patch.object(main, "_is_macos", return_value=True), \
                patch.object(main, "_DATA_ROOT", self.install), \
                patch.object(main, "_CONFIGURED_ROOT_AT_START", ""), \
                patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            result = main.import_legacy_assets_once(os.path.join(self.install, "assets"))
        self.assertEqual(result["reason"], "not_user_root")

    def test_macos_legacy_import_retries_when_configured_root_is_auto_decided(self):
        # 首次判定会把用户目录写进配置；这不能挡住「上次复制失败后的重试」
        legacy = self.legacy_app_assets()
        cfg_file = self.import_config()
        assets_dir = os.path.join(self.user_root, "assets")
        with patch.object(main, "_is_macos", return_value=True), \
                patch.object(main, "_DATA_ROOT", self.user_root), \
                patch.object(main, "_CONFIGURED_ROOT_AT_START", self.user_root), \
                patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)):
            result = main.import_legacy_assets_once(assets_dir)
        self.assertTrue(result["imported"], result)
        self.assertEqual(result["from"], legacy)

    def test_macos_legacy_import_failure_keeps_no_marker(self):
        self.legacy_app_assets()
        cfg_file = self.import_config()
        assets_dir = os.path.join(self.user_root, "assets")
        cases = (
            patch.object(main, "_copy_legacy_assets", side_effect=OSError("只读")),
            patch.object(main, "_verify_legacy_assets", return_value=False),
        )
        for failed in cases:
            with self.subTest(case=str(failed.attribute)):
                with failed:
                    result = self.run_import(cfg_file, assets_dir)
                self.assertFalse(result["imported"], "失败不能算成功")
                self.assertEqual(result["reason"], "copy_failed")
                self.assertFalse(os.path.exists(cfg_file), "失败不能写标记（下次启动还能再试）")
                self.assertTrue(os.path.isfile(os.path.join(self.install, "assets", "library", "lib.png")),
                                "旧目录必须原样留着")
                self.assertFalse(main._assets_dir_has_data(assets_dir), "失败要撤掉半份素材，下次才能再试")
        # 清掉故障后，再跑一次应该成功（失败不留标记 → 下次启动还能补上）
        result = self.run_import(cfg_file, assets_dir)
        self.assertTrue(result["imported"], result)
        self.assertTrue(main._assets_dir_has_data(assets_dir))

    def test_non_macos_import_is_noop(self):
        self.legacy_app_assets()
        cfg_file = self.import_config()
        with patch.object(main, "_is_macos", return_value=False):
            result = main.import_legacy_assets_once(os.path.join(self.user_root, "assets"))
        self.assertFalse(result["imported"])
        self.assertEqual(result["reason"], "not_macos")
        self.assertFalse(os.path.exists(cfg_file))
        self.assertFalse(os.path.isdir(os.path.join(self.user_root, "assets")))

    def test_storage_info_reports_legacy_imported(self):
        cfg_file = self.import_config()
        self.write(cfg_file, json.dumps({
            "assets_legacy_imported": {"from": "/old/NOVAI.app/Contents/MacOS/assets", "at": "2026-11-10T13:00:00"},
        }))
        with patch.object(main, "_DATA_ROOT", self.user_root), \
                patch.object(main, "DATA_DIR", os.path.join(self.user_root, "data")), \
                patch.object(main, "OUTPUT_DIR", os.path.join(self.user_root, "output")), \
                patch.object(main, "ASSETS_DIR", os.path.join(self.user_root, "assets")), \
                patch.object(main, "ASSETS_DIR_SOURCE", "legacy_imported"), \
                patch.object(main, "HISTORY_FILE", os.path.join(self.user_root, "history.json")), \
                patch.object(main, "CANVAS_DIR", os.path.join(self.user_root, "data", "canvases")), \
                patch.object(main, "CONVERSATION_DIR", os.path.join(self.user_root, "data", "conversations")), \
                patch.object(main, "_STORAGE_CONFIG_WARNING", ""), \
                patch.object(main, "STORAGE_CONFIG_FILE", cfg_file), \
                patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(cfg_file)), \
                patch.object(main, "OUTPUT_INPUT_DIR", os.path.join(self.user_root, "assets", "input")), \
                patch.object(main, "OUTPUT_OUTPUT_DIR", os.path.join(self.user_root, "assets", "output")), \
                patch.object(main, "ASSET_LIBRARY_DIR", os.path.join(self.user_root, "assets", "library")), \
                patch.object(main, "LOCAL_UPLOAD_DIR", os.path.join(self.user_root, "assets", "uploads")):
            info = main.storage_location_info()
        self.assertEqual(info["assets_source"], "legacy_imported")
        self.assertTrue(info["assets_legacy_imported"])
        self.assertEqual(info["assets_legacy_imported_from"], "/old/NOVAI.app/Contents/MacOS/assets")
        self.assertIn("旧版素材搬到", info["warning"])
        self.assertIn("旧位置保留未删", info["warning"])

    def test_storage_info_reports_assets_source(self):
        with patch.object(main, "_DATA_ROOT", self.user_root), \
                patch.object(main, "DATA_DIR", os.path.join(self.user_root, "data")), \
                patch.object(main, "OUTPUT_DIR", os.path.join(self.user_root, "output")), \
                patch.object(main, "ASSETS_DIR", os.path.join(self.install, "assets")), \
                patch.object(main, "ASSETS_DIR_SOURCE", "install_legacy"), \
                patch.object(main, "HISTORY_FILE", os.path.join(self.user_root, "history.json")), \
                patch.object(main, "CANVAS_DIR", os.path.join(self.user_root, "data", "canvases")), \
                patch.object(main, "CONVERSATION_DIR", os.path.join(self.user_root, "data", "conversations")), \
                patch.object(main, "_STORAGE_CONFIG_WARNING", ""), \
                patch.object(main, "STORAGE_CONFIG_FILE", os.path.join(self.tmp, "no-config", "config.json")), \
                patch.object(main, "OUTPUT_INPUT_DIR", os.path.join(self.install, "assets", "input")), \
                patch.object(main, "OUTPUT_OUTPUT_DIR", os.path.join(self.install, "assets", "output")), \
                patch.object(main, "ASSET_LIBRARY_DIR", os.path.join(self.install, "assets", "library")), \
                patch.object(main, "LOCAL_UPLOAD_DIR", os.path.join(self.install, "assets", "uploads")):
            info = main.storage_location_info()
        self.assertEqual(info["assets_source"], "install_legacy")
        self.assertTrue(info["assets_install_legacy"])
        self.assertEqual(info["assets_dir"], os.path.join(self.install, "assets"))
        self.assertIn("升级前的位置", info["warning"])


if __name__ == "__main__":
    unittest.main()
