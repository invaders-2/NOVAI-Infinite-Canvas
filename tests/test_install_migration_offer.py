"""老用户首次启动一次性提示：把用户目录里的旧数据迁到安装目录。

覆盖：
  1. 只在「数据根在用户目录、安装目录可写、安装目录没有已有数据、用户没回答过」时 offer；
     其余情况给明确 reason（no_install_dir / already_installed / not_in_user_home /
     configured / target_has_data / target_not_writable / answered）；
  2. 回答 keep 写进稳定配置，之后不再 offer；
  3. migrate 复用设置页的迁移流程（复制 + 校验 + 写 data_root），成功后才记 answered；
  4. 迁移失败抛 500 且不写 answered（下次启动还能再问），原有数据完好；
  5. allow_install_root 只放行安装目录本身，普通非空目录照样拒绝。

全部在临时目录里跑（patch 掉 main 的目录全局变量 + NOVAI_INSTALL_DIR），不碰真实用户数据。
跑法：python3 -m unittest tests.test_install_migration_offer -v
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-install-offer-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)
os.environ.setdefault("NOVAI_CONFIG_DIR", os.path.join(_TMP, "cfg"))

import main


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class InstallOfferSandbox:
    """安装目录 + 位于「用户目录」里的数据根，patch 掉 main 的相关全局变量。"""

    def __init__(self, base):
        self.base = base
        self.home = os.path.join(base, "home")
        self.src = os.path.join(self.home, "NOVAI")
        self.install = os.path.join(base, "install")
        self.config = os.path.join(base, "stable-config", "config.json")
        self.patches = []
        self.env = None

    def seed(self):
        write(os.path.join(self.src, "data", "asset_library.json"), '{"libraries": []}')
        write(os.path.join(self.src, "data", "canvases", "c1.json"), '{"id": "c1"}')
        write(os.path.join(self.src, "data", "settings.json"), json.dumps({
            "output_dir": os.path.join(self.src, "output"),
        }))
        write(os.path.join(self.src, "API", ".env"), "K=v\n")
        write(os.path.join(self.src, "history.json"), "[]")
        write(os.path.join(self.src, "assets", "library", "lib.json"), "{}")
        write(os.path.join(self.src, "assets", "input", "a.png"), "PNG-A")
        write(os.path.join(self.src, "output", "gen.png"), "GEN")
        # 安装目录：只有程序文件，没有用户数据
        write(os.path.join(self.install, "main.py"), "# program")
        write(os.path.join(self.install, "static", "index.html"), "<html></html>")

    def __enter__(self):
        self.seed()
        self.env = patch.dict(os.environ, {"NOVAI_INSTALL_DIR": self.install})
        self.env.start()
        self.patches = [
            patch.object(main, "_DATA_ROOT", self.src),
            patch.object(main, "_DATA_ROOT_SOURCE", "env"),
            patch.object(main, "_DATA_DIR_OVERRIDE", self.src),
            patch.object(main, "_STORAGE_CONFIG_WARNING", ""),
            patch.object(main, "BASE_DIR", self.install),
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
            patch.object(main, "_user_home_dir", return_value=self.home),
        ]
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self.patches):
            item.stop()
        self.patches = []
        self.env.stop()
        self.env = None
        return False

    def config_data(self):
        if not os.path.isfile(self.config):
            return {}
        return json.loads(read(self.config))

    def info(self):
        return main.storage_location_info()

    def offer(self):
        return self.info()["install_migration_offer"]


class InstallMigrationOfferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-install-case-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    # ---------- 1. 只在符合条件时 offer ----------
    def test_offer_when_all_conditions_met(self):
        with InstallOfferSandbox(self.tmp) as box:
            info = box.info()
            offer = info["install_migration_offer"]
            self.assertTrue(offer["offer"])
            self.assertEqual(offer["reason"], "ok")
            self.assertEqual(offer["current_root"], box.src)
            self.assertEqual(offer["target_root"], os.path.abspath(box.install))
            self.assertTrue(offer["target_writable"])
            self.assertFalse(offer["target_has_data"])
            # 占用直接用 info 的扫描结果，不额外扫盘
            self.assertEqual(offer["total"], info["total"])
            self.assertGreater(offer["total"]["files"], 0)
            self.assertTrue(offer["restart_required"])

    def test_answered_stops_offering(self):
        with InstallOfferSandbox(self.tmp) as box:
            write(box.config, json.dumps({
                "install_migration_prompt": {"answered": True, "choice": "keep"},
            }))
            offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "answered")

    def test_no_offer_without_install_dir(self):
        with InstallOfferSandbox(self.tmp) as box:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("NOVAI_INSTALL_DIR", None)
                offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "no_install_dir")

    def test_no_offer_when_data_root_already_at_install_dir(self):
        with InstallOfferSandbox(self.tmp) as box:
            with patch.object(main, "_DATA_ROOT", os.path.abspath(box.install)):
                offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "already_installed")

    def test_no_offer_when_data_root_outside_user_home(self):
        with InstallOfferSandbox(self.tmp) as box:
            with patch.object(main, "_DATA_ROOT", os.path.join(self.tmp, "external-disk")):
                offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "not_in_user_home")

    def test_no_offer_when_user_already_configured_storage(self):
        with InstallOfferSandbox(self.tmp) as box:
            write(box.config, json.dumps({"data_root": os.path.join(self.tmp, "chosen-disk")}))
            offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "configured")

    def test_offer_survives_pinned_current_root(self):
        # 老用户被默认逻辑钉在当前用户目录（config.data_root == 正在用的路径）仍要问：
        # 那正是这次提示的目标人群，不能当成"用户自己选过别处"。
        with InstallOfferSandbox(self.tmp) as box:
            write(box.config, json.dumps({"data_root": os.path.abspath(box.src)}))
            offer = box.offer()
            self.assertTrue(offer["offer"])
            self.assertEqual(offer["reason"], "ok")

    def test_no_offer_when_install_dir_has_data(self):
        with InstallOfferSandbox(self.tmp) as box:
            write(os.path.join(box.install, "data", "users.db"), "")
            offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "target_has_data")
            self.assertTrue(offer["target_has_data"])

    def test_no_offer_when_install_dir_not_writable(self):
        with InstallOfferSandbox(self.tmp) as box:
            with patch.object(main, "_dir_writable", return_value=False):
                offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "target_not_writable")

    # ---------- 2. keep ----------
    def test_keep_records_answer_and_never_offers_again(self):
        with InstallOfferSandbox(self.tmp) as box:
            result = main.storage_install_offer_answer({"choice": "keep"})
            self.assertTrue(result["ok"])
            self.assertTrue(result["answered"])
            self.assertEqual(result["choice"], "keep")
            cfg = box.config_data()
            self.assertTrue(cfg["install_migration_prompt"]["answered"])
            self.assertEqual(cfg["install_migration_prompt"]["choice"], "keep")
            self.assertNotIn("data_root", cfg, "keep 不能改数据位置")
            offer = box.offer()
            self.assertFalse(offer["offer"])
            self.assertEqual(offer["reason"], "answered")
            self.assertTrue(os.path.isfile(os.path.join(box.src, "history.json")))

    def test_invalid_choice_is_rejected(self):
        with InstallOfferSandbox(self.tmp) as box:
            for choice in ("", "yes", "migrate-now", None):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_install_offer_answer({"choice": choice})
                self.assertEqual(ctx.exception.status_code, 400)
            self.assertEqual(box.config_data(), {})

    # ---------- 3. migrate ----------
    def test_migrate_copies_data_then_records_answer(self):
        with InstallOfferSandbox(self.tmp) as box:
            result = main.storage_install_offer_answer({"choice": "migrate"})
            self.assertTrue(result["ok"])
            self.assertTrue(result["answered"])
            self.assertEqual(result["choice"], "migrated")
            self.assertTrue(result["restart_required"])
            target = os.path.abspath(box.install)
            self.assertEqual(result["data_root"], target)
            # 数据真的落在安装目录，且只在用户目录的旧副本没被动
            self.assertEqual(read(os.path.join(target, "assets", "input", "a.png")), "PNG-A")
            self.assertEqual(read(os.path.join(target, "data", "canvases", "c1.json")), '{"id": "c1"}')
            self.assertTrue(os.path.isfile(os.path.join(target, "history.json")))
            self.assertEqual(read(os.path.join(box.src, "assets", "input", "a.png")), "PNG-A")
            cfg = box.config_data()
            self.assertEqual(cfg["data_root"], target)
            self.assertTrue(cfg["install_migration_prompt"]["answered"])
            self.assertEqual(cfg["install_migration_prompt"]["choice"], "migrated")
            self.assertFalse(box.offer()["offer"])

    def test_migrate_failure_does_not_write_answered(self):
        with InstallOfferSandbox(self.tmp) as box:
            real_copy = main._copy_storage_entry
            calls = {"n": 0}

            def flaky(entry, target_abs):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise PermissionError(13, "Permission denied", target_abs)
                return real_copy(entry, target_abs)

            with patch.object(main, "_copy_storage_entry", side_effect=flaky):
                with self.assertRaises(HTTPException) as ctx:
                    main.storage_install_offer_answer({"choice": "migrate"})
            self.assertEqual(ctx.exception.status_code, 500)
            self.assertIn("迁移失败", str(ctx.exception.detail))
            cfg = box.config_data()
            self.assertNotIn("install_migration_prompt", cfg, "迁移失败不能记已回答")
            self.assertNotIn("data_root", cfg, "迁移失败不能改数据位置")
            self.assertTrue(box.offer()["offer"], "下次启动还能再问")
            self.assertTrue(os.path.isfile(os.path.join(box.src, "data", "canvases", "c1.json")))

    # ---------- 4. 放行范围只限安装目录 ----------
    def test_allow_install_root_does_not_loosen_other_targets(self):
        with InstallOfferSandbox(self.tmp) as box:
            busy = os.path.join(self.tmp, "busy")
            write(os.path.join(busy, "notes.txt"), "keep me")
            with self.assertRaises(HTTPException) as ctx:
                main._storage_target_plan(busy, allow_install_root=True)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("不是空的", str(ctx.exception.detail))
            self.assertEqual(read(os.path.join(busy, "notes.txt")), "keep me")


if __name__ == "__main__":
    unittest.main(verbosity=2)
