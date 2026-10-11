import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from fastapi import HTTPException


class UpdateWriteGuardTests(unittest.TestCase):
    def _request(self, **kw):
        return main.UpdateRequest(**{"auto_restart": False, "source": "github", "fallback": False, **kw})

    def test_rejects_update_when_install_dir_not_writable(self):
        with patch.object(main, "_dir_writable", return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                main.update_from_github(self._request())
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("安装目录不可写", str(ctx.exception.detail))
        self.assertEqual(main.UPDATE_PROGRESS.get("stage"), "error")
        self.assertIn("安装目录不可写", str(main.UPDATE_PROGRESS.get("error") or ""))
        self.assertTrue(main.UPDATE_LOCK.acquire(blocking=False), "更新锁必须在失败后释放")
        main.UPDATE_LOCK.release()

    def test_guard_runs_before_download(self):
        calls = []
        with patch.object(main, "_dir_writable", return_value=False), \
             patch.object(main, "stage_update_from_source", side_effect=lambda *a, **k: calls.append(a)):
            with self.assertRaises(HTTPException):
                main.update_from_github(self._request())
        self.assertEqual(calls, [], "安装目录不可写时不应发起任何下载")


if __name__ == "__main__":
    unittest.main()
