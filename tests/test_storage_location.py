"""存储位置（Bug4）：数据根目录可自定义、整份迁移、失败可回滚、重启后仍生效。

覆盖：
  1. 稳定配置的读取口径（缺失/损坏都当空配置，不拖垮启动）；
  2. 路径工具（absolute_path / same_fs_path / path_inside）与"像不像 NOVAI 数据目录"的判断；
  3. 迁移方案校验：同路径 / 嵌套 / 包住当前目录 / 非空无关目录 / 目标是文件 / 空间不足 全部拒绝并给中文提示；
  4. 迁移主流程：data + output + assets + API + history.json 一起复制，逐文件校验后才写配置，
     旧目录一个不删；data/settings.json 与 data/storage_settings.json 里的绝对路径改到新根；
  5. 中途失败自动撤回：旧数据完好、目标目录不留半份、配置没被改；
  6. 回滚 / 恢复默认只改配置；
  7. 设置页用的 /api/config/storage 与素材库用的 /api/storage/settings 是同一套实现。

全部在临时目录里跑（patch 掉 main 的目录全局变量），不碰真实用户数据、不联网、不起服务。
跑法：python3 -m unittest tests.test_storage_location -v
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-storage-loc-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)
os.environ.setdefault("NOVAI_CONFIG_DIR", os.path.join(_TMP, "cfg"))

import main
from server.routes import assets as assets_routes


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class StorageSandbox:
    """把一个临时目录伪装成数据根，并 patch 掉 main 里所有相关全局变量。"""

    def __init__(self, base):
        self.base = base
        self.src = os.path.join(base, "src")
        self.dst = os.path.join(base, "dst")
        self.config = os.path.join(base, "stable-config", "config.json")
        self.outside = os.path.join(base, "outside-assets")
        self.patches = []

    def seed(self):
        # data / API：NOVAI 自己的固定目录（整目录迁移），未来版本新增的子目录也要能跟上
        write(os.path.join(self.src, "data", "asset_library.json"), '{"libraries": [{"id": "default"}]}')
        write(os.path.join(self.src, "data", "canvases", "c1.json"), '{"id": "c1", "title": "画布"}')
        write(os.path.join(self.src, "data", "future_feature", "state.json"), '{"v": 2}')
        write(os.path.join(self.src, "data", "settings.json"), json.dumps({
            "output_dir": os.path.join(self.src, "output"),
            "preview_limit_files": 500,
        }))
        write(os.path.join(self.src, "data", "storage_settings.json"), json.dumps({
            "upload": os.path.join(self.src, "assets", "input"),
            "generated": os.path.join(self.src, "output"),
            "local": self.outside,
        }))
        write(os.path.join(self.src, "API", ".env"), "COMFLY_API_KEY=x\n")
        write(os.path.join(self.src, "history.json"), "[]")
        # assets：只认 input/output/library/uploads/models/users
        write(os.path.join(self.src, "assets", "input", "a.png"), "PNG-A")
        write(os.path.join(self.src, "assets", "output", "nested", "b.png"), "PNG-B")
        write(os.path.join(self.src, "assets", "library", "lib.json"), '{"items": []}')
        write(os.path.join(self.src, "assets", "uploads", "u.txt"), "UPLOAD")
        write(os.path.join(self.src, "assets", "users", "7", "output", "c.png"), "PNG-C")
        # output：只认生成媒体 + 已知子目录（smart-groups）
        write(os.path.join(self.src, "output", "gen.png"), "GEN")
        write(os.path.join(self.src, "output", "smart-groups", "g1", "group.png"), "GROUP")
        write(self.outside + "/ext.txt", "OUTSIDE")
        # ── 无关内容：绝不能跟着迁移 ──
        write(os.path.join(self.src, "notes.txt"), "not novai")
        write(os.path.join(self.src, "junk", "big.bin"), "x" * 32)
        write(os.path.join(self.src, "assets", "scattered", "photo.png"), "USER")
        write(os.path.join(self.src, "assets", "unknown.bin"), "USER")
        write(os.path.join(self.src, "output", "notes.txt"), "output junk")
        write(os.path.join(self.src, "output", "other", "x.png"), "OUTPUT-OTHER")

    def __enter__(self):
        self.seed()
        self.patches = [
            patch.object(main, "_DATA_ROOT", self.src),
            patch.object(main, "_DATA_ROOT_SOURCE", "env"),
            patch.object(main, "_DATA_DIR_OVERRIDE", self.src),
            patch.object(main, "_STORAGE_CONFIG_WARNING", ""),
            patch.object(main, "BASE_DIR", os.path.join(self.base, "install")),
            patch.object(main, "DATA_DIR", os.path.join(self.src, "data")),
            patch.object(main, "OUTPUT_DIR", os.path.join(self.src, "output")),
            patch.object(main, "ASSETS_DIR", os.path.join(self.src, "assets")),
            patch.object(main, "OUTPUT_INPUT_DIR", os.path.join(self.src, "assets", "input")),
            patch.object(main, "OUTPUT_OUTPUT_DIR", os.path.join(self.src, "assets", "output")),
            patch.object(main, "ASSET_LIBRARY_DIR", os.path.join(self.src, "assets", "library")),
            patch.object(main, "LOCAL_UPLOAD_DIR", os.path.join(self.src, "assets", "uploads")),
            patch.object(main, "CANVAS_DIR", os.path.join(self.src, "data", "canvases")),
            patch.object(main, "CONVERSATION_DIR", os.path.join(self.src, "data", "conversations")),
            patch.object(main, "HISTORY_FILE", os.path.join(self.src, "history.json")),
            patch.object(main, "STABLE_CONFIG_DIR", os.path.dirname(self.config)),
            patch.object(main, "STORAGE_CONFIG_FILE", self.config),
            patch.object(main, "_custom_storage", ""),
        ]
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self.patches):
            item.stop()
        self.patches = []
        return False

    def config_data(self):
        if not os.path.isfile(self.config):
            return {}
        return json.loads(read(self.config))


class StorageLocationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-storage-case-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    # ---------- 1. 稳定配置 ----------
    def test_stable_config_read_is_forgiving(self):
        cfg_dir = os.path.join(self.tmp, "cfg")
        cfg_file = os.path.join(cfg_dir, "config.json")
        with patch.object(main, "STORAGE_CONFIG_FILE", cfg_file):
            self.assertEqual(main.load_storage_config(), {})
            write(cfg_file, '{"data_root": "/x"}')
            self.assertEqual(main.load_storage_config(), {"data_root": "/x"})
            write(cfg_file, "{ broken json")
            self.assertEqual(main.load_storage_config(), {})

    def test_stable_config_dir_env_override_and_platform_default(self):
        with patch.dict(os.environ, {"NOVAI_CONFIG_DIR": os.path.join(self.tmp, "custom-cfg")}):
            self.assertEqual(main.stable_config_dir(), os.path.abspath(os.path.join(self.tmp, "custom-cfg")))
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NOVAI_CONFIG_DIR", None)
            if os.name == "nt":
                expected = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "NOVAI")
                self.assertEqual(main.stable_config_dir(), expected)
            else:
                self.assertEqual(main.stable_config_dir(), os.path.expanduser("~/.NOVAI"))

    def test_default_data_root_falls_back_to_base_dir_for_source_runs(self):
        with patch.object(main, "BASE_DIR", os.path.join(self.tmp, "repo")):
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("NOVAI_INSTALL_DIR", None)
                self.assertEqual(main.default_data_root(), os.path.join(self.tmp, "repo"))

    # ---------- 2. 路径工具 ----------
    def test_path_helpers(self):
        base = os.path.join(self.tmp, "a")
        self.assertTrue(main.path_inside(base, os.path.join(base, "x", "y")))
        self.assertTrue(main.path_inside(base, base))
        self.assertFalse(main.path_inside(base, os.path.join(self.tmp, "b")))
        self.assertTrue(main.same_fs_path(os.path.join(base, "..", "a"), base))
        self.assertFalse(main.same_fs_path(base, os.path.join(self.tmp, "b")))
        self.assertEqual(main.absolute_path("~/novai-x"), os.path.join(os.path.expanduser("~"), "novai-x"))
        self.assertEqual(main.absolute_path(""), "")

    def test_looks_like_novai_data_root(self):
        empty = os.path.join(self.tmp, "unrelated")
        os.makedirs(os.path.join(empty, "data"), exist_ok=True)
        self.assertFalse(main._looks_like_novai_data_root(empty))
        real = os.path.join(self.tmp, "real")
        os.makedirs(os.path.join(real, "data", "canvases"), exist_ok=True)
        os.makedirs(os.path.join(real, "assets", "output"), exist_ok=True)
        self.assertTrue(main._looks_like_novai_data_root(real))

    # ---------- 3. 校验 ----------
    def test_invalid_targets_are_rejected_with_chinese_messages(self):
        with StorageSandbox(self.tmp) as box:
            cases = [
                (box.src, "同一个文件夹"),
                (os.path.join(box.src, "inner"), "里面"),
                (self.tmp, "包在里面"),
            ]
            for target, keyword in cases:
                with self.assertRaises(HTTPException) as ctx:
                    main._storage_target_plan(target)
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertIn(keyword, str(ctx.exception.detail))

            busy = os.path.join(self.tmp, "busy")
            write(os.path.join(busy, "notes.txt"), "keep me")
            with self.assertRaises(HTTPException) as ctx:
                main._storage_target_plan(busy)
            self.assertIn("不是空的", str(ctx.exception.detail))
            self.assertEqual(read(os.path.join(busy, "notes.txt")), "keep me")

            a_file = os.path.join(self.tmp, "a-file")
            write(a_file, "x")
            with self.assertRaises(HTTPException) as ctx:
                main._storage_target_plan(a_file)
            self.assertIn("同名文件", str(ctx.exception.detail))

    def test_relative_target_is_rejected(self):
        with StorageSandbox(self.tmp) as box:
            # 相对路径会被 abspath 解析到进程工作目录（源码版就是仓库），必须拒绝并提示填绝对路径
            for target in ("NOVAI", "./dst", "some/sub/dir"):
                with self.assertRaises(HTTPException) as ctx:
                    main._storage_target_plan(target)
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertIn("绝对路径", str(ctx.exception.detail))
            # ~ 展开后是绝对路径，允许
            plan = main._storage_target_plan("~/novai-abs-test")
            self.assertTrue(os.path.isabs(plan["target"]))

    def test_empty_folder_with_hidden_file_is_allowed(self):
        with StorageSandbox(self.tmp) as box:
            target = os.path.join(self.tmp, "fresh")
            write(os.path.join(target, ".DS_Store"), "junk")
            plan = main._storage_target_plan(target)
            self.assertEqual(plan["action"], "copy")
            self.assertGreater(plan["total"]["files"], 0)

    def test_existing_novai_data_is_adopted_not_merged(self):
        with StorageSandbox(self.tmp) as box:
            write(os.path.join(box.dst, "data", "asset_library.json"), '{"libraries": []}')
            os.makedirs(os.path.join(box.dst, "assets", "library"), exist_ok=True)
            plan = main._storage_target_plan(box.dst)
            self.assertEqual(plan["action"], "adopt")
            result = main.storage_location_move({"path": box.dst})
            self.assertEqual(result["action"], "adopt")
            self.assertFalse(os.path.isdir(os.path.join(box.dst, "output")))
            self.assertEqual(box.config_data()["data_root"], os.path.abspath(box.dst))

    def test_not_enough_space_is_rejected(self):
        with StorageSandbox(self.tmp) as box:
            with patch.object(main.shutil, "disk_usage", return_value=SimpleNamespace(free=1)):
                with self.assertRaises(HTTPException) as ctx:
                    main._storage_target_plan(box.dst)
            self.assertIn("空间不够", str(ctx.exception.detail))

    # ---------- 4. 迁移主流程 ----------
    def test_migration_copies_everything_and_keeps_old_data(self):
        with StorageSandbox(self.tmp) as box:
            plan = main.storage_location_move({"path": box.dst, "dry_run": True})
            self.assertTrue(plan["dry_run"])
            self.assertEqual(plan["action"], "copy")
            names = sorted(entry["name"] for entry in plan["entries"])
            self.assertEqual(names, ["API", "assets", "data", "history.json", "output"])
            self.assertFalse(os.path.exists(box.dst), "dry_run 不能创建目标目录")

            # data5 + assets5 + output2 + API1 + history1 = 14；无关文件/链接都不算
            self.assertEqual(plan["total"]["files"], 14)

            result = main.storage_location_move({"path": box.dst})
            self.assertTrue(result["ok"])
            self.assertTrue(result["kept_old"])
            self.assertEqual(result["old_root"], box.src)
            self.assertEqual(result["migrated"]["files"], 14)

            self.assertEqual(read(os.path.join(box.dst, "data", "asset_library.json")), '{"libraries": [{"id": "default"}]}')
            self.assertEqual(read(os.path.join(box.dst, "assets", "input", "a.png")), "PNG-A")
            self.assertEqual(read(os.path.join(box.dst, "assets", "output", "nested", "b.png")), "PNG-B")
            self.assertEqual(read(os.path.join(box.dst, "assets", "users", "7", "output", "c.png")), "PNG-C")
            self.assertEqual(read(os.path.join(box.dst, "output", "gen.png")), "GEN")
            self.assertEqual(read(os.path.join(box.dst, "output", "smart-groups", "g1", "group.png")), "GROUP")
            self.assertEqual(read(os.path.join(box.dst, "API", ".env")), "COMFLY_API_KEY=x\n")
            self.assertTrue(os.path.isfile(os.path.join(box.dst, "history.json")))
            # data 是整目录搬：未来版本新增的子目录也要跟上（不能靠白名单漏掉）
            self.assertEqual(read(os.path.join(box.dst, "data", "future_feature", "state.json")), '{"v": 2}')

            # 旧目录一个都不删：这是"可回滚、失败不丢数据"的前提（无关文件同样留在原处）
            self.assertEqual(read(os.path.join(box.src, "assets", "input", "a.png")), "PNG-A")
            self.assertTrue(os.path.isfile(os.path.join(box.src, "data", "canvases", "c1.json")))
            self.assertEqual(read(os.path.join(box.src, "notes.txt")), "not novai")

            cfg = box.config_data()
            self.assertEqual(cfg["data_root"], os.path.abspath(box.dst))
            self.assertEqual(cfg["data_root_previous"], os.path.abspath(box.src))

            # 复制过去的数据里存的绝对路径改到新根，否则重启后自定义目录仍指旧位置
            settings = json.loads(read(os.path.join(box.dst, "data", "settings.json")))
            self.assertEqual(settings["output_dir"], os.path.join(box.dst, "output"))
            self.assertEqual(settings["preview_limit_files"], 500)
            dirs = json.loads(read(os.path.join(box.dst, "data", "storage_settings.json")))
            self.assertEqual(dirs["upload"], os.path.join(box.dst, "assets", "input"))
            self.assertEqual(dirs["generated"], os.path.join(box.dst, "output"))
            self.assertEqual(dirs["local"], box.outside)
            self.assertTrue(any("local" in item for item in result["warnings"]))

    def test_unrelated_files_and_symlinks_are_not_migrated(self):
        with StorageSandbox(self.tmp) as box:
            outside_dir = os.path.join(self.tmp, "outside-secret")
            outside_file = os.path.join(outside_dir, "secret.txt")
            write(outside_file, "SECRET")
            link_dir = os.path.join(box.src, "assets", "uploads", "linkdir")
            link_file = os.path.join(box.src, "assets", "uploads", "link.png")
            try:
                os.symlink(outside_dir, link_dir)
                os.symlink(outside_file, link_file)
            except (OSError, NotImplementedError):
                self.skipTest("当前环境不允许创建符号链接")

            plan = main.storage_location_move({"path": box.dst, "dry_run": True})
            self.assertEqual(plan["total"]["files"], 14, "符号链接与无关文件不能算进迁移量")
            self.assertTrue(any("符号链接" in item for item in plan["warnings"]))

            main.storage_location_move({"path": box.dst})
            uploads_dst = os.path.join(box.dst, "assets", "uploads")
            self.assertTrue(os.path.isfile(os.path.join(uploads_dst, "u.txt")))
            self.assertFalse(os.path.lexists(os.path.join(uploads_dst, "linkdir")))
            self.assertFalse(os.path.lexists(os.path.join(uploads_dst, "link.png")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "scattered")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "unknown.bin")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "notes.txt")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "junk")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "output", "notes.txt")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "output", "other")))
            self.assertEqual(read(outside_file), "SECRET", "链接目标不能被改动")

    def test_junction_like_dir_is_skipped(self):
        with StorageSandbox(self.tmp) as box:
            junction = os.path.join(box.src, "assets", "uploads", "junctiondir")
            write(os.path.join(junction, "secret.bin"), "SECRET")
            original = main._is_link_path

            def fake_is_link(path):
                if os.path.abspath(str(path)) == os.path.abspath(junction):
                    return True
                return original(path)

            with patch.object(main, "_is_link_path", side_effect=fake_is_link):
                plan = main.storage_location_move({"path": box.dst, "dry_run": True})
                self.assertEqual(plan["total"]["files"], 14)
                self.assertTrue(any("junction" in item for item in plan["warnings"]))
                main.storage_location_move({"path": box.dst})
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "uploads", "junctiondir")))
            self.assertEqual(read(os.path.join(junction, "secret.bin")), "SECRET")

    def test_legacy_broad_assets_dir_only_takes_known_subpaths(self):
        wide = os.path.join(self.tmp, "wide-user-folder")
        write(os.path.join(wide, "input", "ok.png"), "OK")
        write(os.path.join(wide, "library", "lib.json"), "{}")
        write(os.path.join(wide, "Documents", "thesis.docx"), "SECRET")
        write(os.path.join(wide, "Photos", "me.jpg"), "SECRET")
        write(os.path.join(wide, "random.bin"), "SECRET")
        with StorageSandbox(self.tmp) as box:
            patcher = patch.object(main, "ASSETS_DIR", wide)
            patcher.start()
            self.addCleanup(patcher.stop)

            plan = main.storage_location_move({"path": box.dst, "dry_run": True})
            assets_entry = [entry for entry in plan["entries"] if entry["name"] == "assets"][0]
            self.assertEqual(sorted(item["rel"] for item in assets_entry["includes"]), ["input", "library"])
            self.assertEqual(plan["total"]["files"], 11, "data5+output2+API1+history1+assets2")
            self.assertTrue(any("旧版单独设置的位置" in item for item in plan["warnings"]))
            self.assertIn("旧版单独设置的位置", main.storage_location_info()["warning"])

            main.storage_location_move({"path": box.dst})
            self.assertEqual(read(os.path.join(box.dst, "assets", "input", "ok.png")), "OK")
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "Documents")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "Photos")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "assets", "random.bin")))
            self.assertEqual(read(os.path.join(wide, "Documents", "thesis.docx")), "SECRET")

    def test_heavy_dirs_in_data_and_api_are_skipped(self):
        with StorageSandbox(self.tmp) as box:
            write(os.path.join(box.src, "data", "node_modules", "pkg", "index.js"), "x" * 16)
            write(os.path.join(box.src, "data", ".git", "HEAD"), "ref")
            write(os.path.join(box.src, "API", "node_modules", "x.js"), "x")
            plan = main.storage_location_move({"path": box.dst, "dry_run": True})
            self.assertEqual(plan["total"]["files"], 14, "node_modules/.git 不能算进迁移量")
            self.assertTrue(any("node_modules/.git" in item for item in plan["warnings"]))
            main.storage_location_move({"path": box.dst})
            self.assertFalse(os.path.exists(os.path.join(box.dst, "data", "node_modules")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "data", ".git")))
            self.assertFalse(os.path.exists(os.path.join(box.dst, "API", "node_modules")))
            self.assertTrue(os.path.isfile(os.path.join(box.dst, "data", "canvases", "c1.json")))

    def test_oversized_scan_is_rejected_and_info_degrades_gracefully(self):
        with StorageSandbox(self.tmp) as box:
            for index in range(15):
                write(os.path.join(box.src, "assets", "input", "bulk-%d.png" % index), "x")
            with patch.object(main, "_STORAGE_MAX_FILES", 10):
                info = main.storage_location_info()
                self.assertTrue([item for item in info["items"] if item["too_large"]],
                                "超大目录要在 info 里标记，而不是让接口 500")
                self.assertIn("异常庞大", info["warning"])
                with self.assertRaises(HTTPException) as ctx:
                    main._storage_target_plan(box.dst)
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertIn("超过 10 个文件", str(ctx.exception.detail))
                self.assertFalse(os.path.exists(box.dst))

    def test_info_reports_pending_restart_and_rollback(self):
        with StorageSandbox(self.tmp) as box:
            info = main.storage_location_info()
            self.assertEqual(info["data_root"], box.src)
            self.assertEqual(info["data_root_source"], "env")
            self.assertFalse(info["restart_required"])
            self.assertFalse(info["can_rollback"])
            self.assertEqual(info["config_file"], box.config)

            main.storage_location_move({"path": box.dst})
            info = main.storage_location_info()
            self.assertEqual(info["data_root"], box.src, "不重启的话实际路径不变")
            self.assertEqual(info["configured_data_root"], os.path.abspath(box.dst))
            self.assertTrue(info["restart_required"])
            self.assertTrue(info["can_rollback"])

            main.storage_location_rollback()
            cfg = box.config_data()
            self.assertEqual(cfg["data_root"], os.path.abspath(box.src))
            self.assertEqual(cfg["data_root_previous"], os.path.abspath(box.dst))

    def test_reset_removes_config_key_without_moving_files(self):
        with StorageSandbox(self.tmp) as box:
            main.storage_location_move({"path": box.dst})
            result = main.storage_location_move({"path": ""})
            self.assertTrue(result["reset"])
            self.assertNotIn("data_root", box.config_data())
            self.assertTrue(os.path.isfile(os.path.join(box.dst, "data", "canvases", "c1.json")))
            self.assertTrue(os.path.isfile(os.path.join(box.src, "data", "canvases", "c1.json")))

    # ---------- 4b. SQLite / WAL ----------
    def _make_wal_db(self, path, rows):
        import sqlite3
        os.makedirs(os.path.dirname(path), exist_ok=True)
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        conn.executemany("INSERT INTO users (id, name) VALUES (?, ?)", rows)
        conn.commit()
        return conn

    def test_sqlite_wal_is_checkpointed_before_copy_and_verified_after(self):
        import sqlite3
        with StorageSandbox(self.tmp) as box:
            db_path = os.path.join(box.src, "data", "users.db")
            # 保持连接打开 → 写入停在 -wal 里（模拟正在运行的后端）
            conn = self._make_wal_db(db_path, [(1, "alice"), (2, "bob"), (3, "cindy")])
            self.addCleanup(conn.close)
            wal_path = db_path + "-wal"
            self.assertTrue(os.path.isfile(wal_path) and os.path.getsize(wal_path) > 0, "前置：WAL 里有未落盘的数据")

            result = main.storage_location_move({"path": box.dst})
            self.assertIn("WAL checkpoint", result["database"])
            self.assertIn("quick_check", result["database"])

            wal_size = os.path.getsize(wal_path) if os.path.isfile(wal_path) else 0
            self.assertEqual(wal_size, 0, "迁移前必须把 WAL 落盘并截断")

            target_db = os.path.join(box.dst, "data", "users.db")
            self.assertTrue(os.path.isfile(target_db))
            verify = sqlite3.connect(target_db)
            try:
                self.assertEqual([row[0] for row in verify.execute("PRAGMA quick_check").fetchall()], ["ok"])
                rows = verify.execute("SELECT id, name FROM users ORDER BY id").fetchall()
            finally:
                verify.close()
            self.assertEqual(rows, [(1, "alice"), (2, "bob"), (3, "cindy")])
            self.assertTrue(main._verify_sqlite_quick_check(target_db))

    def test_checkpoint_failure_aborts_without_touching_data(self):
        with StorageSandbox(self.tmp) as box:
            self._make_wal_db(os.path.join(box.src, "data", "users.db"), [(1, "alice")])
            with patch.object(main, "_checkpoint_sqlite", side_effect=RuntimeError("database is locked")):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_location_move({"path": box.dst})
            self.assertEqual(ctx.exception.status_code, 500)
            self.assertIn("同步数据库失败", str(ctx.exception.detail))
            self.assertEqual(box.config_data(), {})
            self.assertFalse(os.path.exists(box.dst), "没开始复制就不该留下目标目录")
            self.assertTrue(os.path.isfile(os.path.join(box.src, "data", "users.db")))

    def test_quick_check_failure_rolls_back(self):
        with StorageSandbox(self.tmp) as box:
            self._make_wal_db(os.path.join(box.src, "data", "users.db"), [(1, "alice")])
            with patch.object(main, "_verify_sqlite_quick_check", return_value=False):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_location_move({"path": box.dst})
            self.assertIn("数据库校验没通过", str(ctx.exception.detail))
            self.assertEqual(box.config_data(), {})
            self.assertFalse(os.path.exists(box.dst))
            self.assertTrue(os.path.isfile(os.path.join(box.src, "data", "users.db")))

    # ---------- 5. 失败回滚 ----------
    def test_failure_midway_rolls_back_and_keeps_config_untouched(self):
        with StorageSandbox(self.tmp) as box:
            real_copy = main._copy_storage_entry
            calls = {"n": 0}

            def flaky(entry, target_abs):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise PermissionError(13, "Permission denied", os.path.join(target_abs, entry["name"]))
                return real_copy(entry, target_abs)

            with patch.object(main, "_copy_storage_entry", side_effect=flaky):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_location_move({"path": box.dst})
            self.assertEqual(ctx.exception.status_code, 500)
            self.assertIn("迁移失败", str(ctx.exception.detail))
            self.assertIn("没有写入权限", str(ctx.exception.detail))
            self.assertEqual(box.config_data(), {}, "迁失败不能写配置")
            self.assertFalse(os.path.exists(box.dst), "半份副本要被清掉（目标目录是这次新建的）")
            self.assertEqual(read(os.path.join(box.src, "data", "canvases", "c1.json")), '{"id": "c1", "title": "画布"}')

    def test_failure_keeps_pre_existing_target_content(self):
        with StorageSandbox(self.tmp) as box:
            target = os.path.join(self.tmp, "empty-target")
            os.makedirs(target)
            write(os.path.join(target, ".keep"), "user file")
            with patch.object(main, "_verify_storage_copy", return_value=False):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_location_move({"path": target})
            self.assertIn("复制校验没通过", str(ctx.exception.detail))
            self.assertTrue(os.path.isfile(os.path.join(target, ".keep")))
            self.assertEqual(box.config_data(), {})

    # ---------- 6. 两个前端入口共用同一套实现 ----------
    def test_legacy_assets_endpoints_delegate_to_same_implementation(self):
        with StorageSandbox(self.tmp) as box:
            info = asyncio.run(assets_routes.api_storage_settings())
            self.assertEqual(info["data_root"], box.src)
            self.assertEqual(info["assets_dir"], os.path.join(box.src, "assets"))
            self.assertEqual(info["config_file"], box.config)

            payload = assets_routes.StoragePathPayload(path=box.dst)
            result = asyncio.run(assets_routes.api_save_storage_settings(payload))
            self.assertTrue(result["ok"])
            self.assertEqual(box.config_data()["data_root"], os.path.abspath(box.dst))

            route_info = asyncio.run(main.get_storage_path())
            self.assertEqual(route_info["configured_data_root"], os.path.abspath(box.dst))


if __name__ == "__main__":
    unittest.main(verbosity=2)
