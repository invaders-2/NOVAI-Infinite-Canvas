"""本地抠图（RMBG-2.0）后端契约：模型状态 / 下载（可重复调用、可取消）/ 未下载时的明确 400。

真实故障场景：前端「本地抠图」面板靠这几个字段渲染进度和文案；字段缺失或下载重复启动会让
用户看到空白进度 / 两个线程抢同一个 .part。这里把契约钉住（不发真实外网下载、不跑推理）。
"""
import asyncio
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def run(coro):
    return asyncio.run(coro)


class MattingStatusTests(unittest.TestCase):
    def setUp(self):
        main._MODEL_DOWNLOAD_TASKS.pop("matting_model_download", None)
        self.addCleanup(lambda: main._MODEL_DOWNLOAD_TASKS.pop("matting_model_download", None))

    def status(self, downloaded=False, task=None):
        with unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=downloaded), \
                unittest.mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS", {"matting_model_download": task} if task else {}):
            return run(main.matting_model_status())

    def test_not_downloaded_shape(self):
        s = self.status(downloaded=False)
        for key in ("downloaded", "model_size", "model_size_mb", "progress", "downloaded_mb", "total_mb",
                    "speed_mbps", "eta", "eta_seconds", "attempt", "retrying", "hint", "cancelled",
                    "error", "load_error", "downloading", "verifying", "runtime_ready", "available"):
            self.assertIn(key, s)
        self.assertFalse(s["downloaded"])
        self.assertEqual(s["model_size"], "349 MB")
        self.assertEqual(s["model_size_mb"], 349)
        self.assertEqual(s["progress"], 0)
        self.assertEqual(s["downloaded_mb"], 0.0)

    def test_downloaded_shows_full_progress(self):
        # 已下载完：downloaded_mb 以前会显示 0（进度 100 但已下 0MB 自相矛盾）
        s = self.status(downloaded=True)
        self.assertTrue(s["downloaded"])
        self.assertEqual(s["progress"], 100)
        self.assertEqual(s["downloaded_mb"], s["total_mb"])

    def test_downloading_progress_and_eta(self):
        task = {"downloading": True, "downloaded": 100 * 1024 * 1024, "total": 349 * 1024 * 1024,
                "speed": 2 * 1024 * 1024, "progress": 28, "attempt": 2, "error_hint": "网络抖动，正在重试"}
        s = self.status(downloaded=False, task=task)
        self.assertTrue(s["downloading"])
        self.assertTrue(s["retrying"])
        self.assertEqual(s["progress"], 28)
        self.assertGreaterEqual(s["downloaded_mb"], 100.0)
        self.assertGreater(s["eta"], 0)
        self.assertEqual(s["eta"], s["eta_seconds"])
        self.assertEqual(s["attempt"], 2)
        self.assertIn("重试", s["hint"])

    def test_missing_runtime_is_reported_before_first_use(self):
        # 模型在、但推理组件没装：状态就要说清「不可用 + 原因」，别等用户点抠图才 500
        with unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=True), \
                unittest.mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS", {}), \
                unittest.mock.patch.object(main, "_matting_runtime_ready", return_value=False):
            s = run(main.matting_model_status())
        self.assertFalse(s["runtime_ready"])
        self.assertFalse(s["available"])
        self.assertIn("onnxruntime", s["load_error"])

    def test_available_when_model_and_runtime_ready(self):
        with unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=True), \
                unittest.mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS", {}), \
                unittest.mock.patch.object(main, "_matting_runtime_ready", return_value=True):
            s = run(main.matting_model_status())
        self.assertTrue(s["available"])

    def test_cancelled_and_error_fields_pass_through(self):
        task = {"downloading": False, "cancelled": True, "error": "", "progress": 12}
        s = self.status(downloaded=False, task=task)
        self.assertTrue(s["cancelled"])
        self.assertEqual(s["error"], "")


class MattingDownloadTests(unittest.TestCase):
    def setUp(self):
        main._MODEL_DOWNLOAD_TASKS.pop("matting_model_download", None)
        self.addCleanup(lambda: main._MODEL_DOWNLOAD_TASKS.pop("matting_model_download", None))

    def test_already_downloaded_is_idempotent(self):
        with unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=True):
            r = run(main.matting_model_download())
        self.assertTrue(r["ok"])
        self.assertTrue(r["downloaded"])
        self.assertNotIn("matting_model_download", main._MODEL_DOWNLOAD_TASKS)

    def test_downloading_twice_does_not_start_a_second_thread(self):
        main._MODEL_DOWNLOAD_TASKS["matting_model_download"] = {"downloading": True, "progress": 7}
        with unittest.mock.patch.object(main, "Thread") as thread, \
                unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=False):
            r = run(main.matting_model_download())
        self.assertTrue(r["already"])
        self.assertEqual(r["progress"], 7)
        self.assertEqual(thread.call_count, 0)

    def test_start_download_returns_task_and_resume_size(self):
        main._MODEL_DOWNLOAD_TASKS.pop("matting_model_download", None)
        with unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=False), \
                unittest.mock.patch.object(main.os.path, "exists", return_value=False), \
                unittest.mock.patch.object(main, "Thread") as thread:
            r = run(main.matting_model_download())
        self.assertTrue(r["ok"])
        self.assertEqual(r["task_id"], "matting_model_download")
        self.assertEqual(r["resumed_from_mb"], 0.0)
        self.assertEqual(thread.call_count, 1)
        self.assertTrue(main._MODEL_DOWNLOAD_TASKS["matting_model_download"]["downloading"])

    def test_cancel_sets_flag(self):
        main._MODEL_DOWNLOAD_TASKS["matting_model_download"] = {"downloading": True}
        r = run(main.matting_model_cancel())
        self.assertTrue(r["ok"])
        self.assertTrue(main._MODEL_DOWNLOAD_TASKS["matting_model_download"]["cancel"])
        r2 = run(main.matting_model_cancel())      # 没有下载任务时也不报错
        self.assertTrue(r2["ok"])


class MattingLocalModeTests(unittest.TestCase):
    def payload(self, mode="local"):
        return main.ImageMattingRequest(url="/output/test-c19.png", mode=mode)

    def test_local_mode_without_model_returns_clear_400(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            fh.write(b"fake")
            path = fh.name
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        with unittest.mock.patch.object(main, "output_file_from_url", return_value=path), \
                unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=False):
            with self.assertRaises(main.HTTPException) as caught:
                run(main.image_matting(self.payload()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("本地抠图模型未下载", str(caught.exception.detail))

    def test_local_mode_without_session_reports_reason(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            fh.write(b"fake")
            path = fh.name
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        with unittest.mock.patch.object(main, "output_file_from_url", return_value=path), \
                unittest.mock.patch.object(main, "_matting_model_downloaded", return_value=True), \
                unittest.mock.patch.object(main, "_matting_session", return_value=None), \
                unittest.mock.patch.object(main, "_matting_unavailable_reason", return_value="onnxruntime 未安装"):
            with self.assertRaises(main.HTTPException) as caught:
                run(main.image_matting(self.payload()))
        self.assertEqual(caught.exception.status_code, 500)
        self.assertIn("onnxruntime", str(caught.exception.detail))


if __name__ == "__main__":
    unittest.main()
