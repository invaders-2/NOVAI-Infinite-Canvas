# -*- coding: utf-8 -*-
"""本地深度模型（Depth Anything V2 small）契约：按需下载 / 断点续传 / 校验 / 可取消，
以及「模型没下」时深度动作捕捉给出的可执行文案。

真实故障：2.0.08 安装版把 models 目录排除在安装包外（installer.nsi /x "models"），
而深度模型只有配置、没有任何下载入口 → 用户点「深度动作捕捉」必然报「缺少文件」。
这组用例把下载链路和文案钉住（不发真实外网请求、不跑推理）。
"""
import asyncio
import hashlib
import os
import sys
import tempfile
import types
import unittest
import unittest.mock
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


def run(coro):
    return asyncio.run(coro)


PAYLOAD = bytes(range(256)) * 8192         # 2MB，够验证写入 / 断点续传 / 校验，又不用真下 27MB
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()


class _Resp:
    """假的 requests.get 响应（支持 with / iter_content / 206 续传）。"""

    def __init__(self, body: bytes, status_code: int = 200, headers: dict | None = None):
        self._body = body
        self.status_code = status_code
        self.headers = headers if headers is not None else {"Content-Length": str(len(body))}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("HTTP %s" % self.status_code)

    def iter_content(self, chunk_size: int = 65536):
        for at in range(0, len(self._body), chunk_size):
            yield self._body[at:at + chunk_size]


class _DepthTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-depth-model-")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.model_path = os.path.join(self.tmp, "depth_anything_v2_small_int8.onnx")
        self.addCleanup(lambda: main._MODEL_DOWNLOAD_TASKS.pop(main._DEPTH_MODEL_TASK_ID, None))
        main._MODEL_DOWNLOAD_TASKS.pop(main._DEPTH_MODEL_TASK_ID, None)
        self.patches = [
            mock.patch.object(main, "_DEPTH_MODEL_PATH", self.model_path),
            mock.patch.object(main, "_models_path", side_effect=lambda name: self.model_path),
            mock.patch.object(main, "_depth_reset_session"),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)


class _SmallModelTestBase(_DepthTestBase):
    """下载细节用例：把 27MB 的模型缩成 32KB，验证写入 / 续传 / 校验逻辑本身。"""

    def setUp(self):
        super().setUp()
        for patch in (mock.patch.object(main, "_DEPTH_MODEL_SIZE", len(PAYLOAD)),
                      mock.patch.object(main, "_DEPTH_MODEL_SHA256", PAYLOAD_SHA)):
            patch.start()
            self.addCleanup(patch.stop)


class DepthModelConstantsTests(unittest.TestCase):
    def test_source_is_the_modelscope_file_already_verified(self):
        # 下载源必须和开发机那份逐字节一致（SHA-256 / 体积都钉住），换源要同时改这里
        self.assertEqual(main._DEPTH_MODEL_NAME, "depth_anything_v2_small_int8.onnx")
        self.assertEqual(
            main._DEPTH_MODEL_URL,
            "https://modelscope.cn/models/onnx-community/depth-anything-v2-small"
            "/resolve/master/onnx/model_quantized.onnx",
        )
        self.assertEqual(main._DEPTH_MODEL_SIZE, 27258801)
        self.assertEqual(main._DEPTH_MODEL_SHA256, "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d")
        self.assertEqual(main._DEPTH_MODEL_SIZE_MB, 26)
        self.assertTrue(main._DEPTH_MODEL_PATH.endswith("depth_anything_v2_small_int8.onnx"))

    def test_model_missing_message_is_actionable(self):
        text = main._depth_model_missing_message()
        self.assertIn("26 MB", text)                  # 用户要知道下多大
        self.assertIn("深度动作捕捉", text)            # 要说清去哪点
        self.assertIn("depth-model/download", text)    # 也给出接口入口


class DepthModelStatusTests(_DepthTestBase):
    def status(self, downloaded=False, task=None):
        with mock.patch.object(main, "_depth_model_downloaded", return_value=downloaded), \
                mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS", {main._DEPTH_MODEL_TASK_ID: task} if task else {}):
            return run(main.video_depth_model_status())

    def test_not_downloaded_shape(self):
        s = self.status(downloaded=False)
        for key in ("downloaded", "model_size_mb", "downloading", "verifying", "progress",
                    "downloaded_mb", "total_mb", "speed_mbps", "eta_seconds", "attempt",
                    "retrying", "hint", "cancelled", "error", "runtime_ready", "available",
                    "load_error"):
            self.assertIn(key, s)
        self.assertFalse(s["downloaded"])
        self.assertEqual(s["model_size_mb"], 26)
        self.assertEqual(s["progress"], 0)
        self.assertEqual(s["downloaded_mb"], 0.0)

    def test_downloaded_shows_full_progress(self):
        s = self.status(downloaded=True)
        self.assertTrue(s["downloaded"])
        self.assertEqual(s["progress"], 100)
        self.assertEqual(s["downloaded_mb"], s["total_mb"])

    def test_downloading_progress_speed_eta(self):
        task = {"downloading": True, "downloaded": 10 * 1024 * 1024, "total": main._DEPTH_MODEL_SIZE,
                "speed": 1.5 * 1024 * 1024, "progress": 38, "attempt": 2, "error_hint": "网络抖动，正在重试"}
        s = self.status(downloaded=False, task=task)
        self.assertTrue(s["downloading"])
        self.assertTrue(s["retrying"])
        self.assertEqual(s["progress"], 38)
        self.assertGreaterEqual(s["downloaded_mb"], 10.0)
        self.assertGreater(s["eta_seconds"], 0)
        self.assertEqual(s["eta"], s["eta_seconds"])
        self.assertEqual(s["attempt"], 2)
        self.assertIn("重试", s["hint"])

    def test_missing_runtime_reported_before_first_use(self):
        with mock.patch.object(main, "_depth_runtime_ready", return_value=False):
            s = self.status(downloaded=True)
        self.assertFalse(s["runtime_ready"])
        self.assertFalse(s["available"])
        self.assertIn("onnxruntime", s["load_error"])

    def test_available_when_model_and_runtime_ready(self):
        with mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_DEPTH_LOAD_ERROR", {"msg": ""}):
            s = self.status(downloaded=True)
        self.assertTrue(s["available"])

    def test_load_error_blocks_available(self):
        with mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_DEPTH_LOAD_ERROR", {"msg": "深度模型加载失败"}):
            s = self.status(downloaded=True)
        self.assertFalse(s["available"])
        self.assertEqual(s["load_error"], "深度模型加载失败")

    def test_status_never_loads_the_model(self):
        # 状态接口只看文件 + import：加载 27MB 模型会让设置页/弹窗卡住
        def boom(*a, **k):
            raise AssertionError("状态接口不许加载模型")

        with mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch("server.split_engine.depth_capture._session", side_effect=boom):
            s = self.status(downloaded=True)
        self.assertTrue(s["downloaded"])


class DepthModelDownloadStartTests(_SmallModelTestBase):
    """起下载：幂等、断点续传大小、只起一个线程、可取消。"""
    def test_already_downloaded_is_idempotent(self):
        Path(self.model_path).write_bytes(PAYLOAD)
        with mock.patch.object(main, "Thread") as thread:
            r = run(main.video_depth_model_download())
        self.assertTrue(r["ok"])
        self.assertTrue(r["downloaded"])
        self.assertEqual(thread.call_count, 0)

    def test_downloading_twice_does_not_start_a_second_thread(self):
        main._MODEL_DOWNLOAD_TASKS[main._DEPTH_MODEL_TASK_ID] = {"downloading": True, "progress": 7}
        with mock.patch.object(main, "Thread") as thread:
            r = run(main.video_depth_model_download())
        self.assertTrue(r["already"])
        self.assertEqual(r["progress"], 7)
        self.assertEqual(thread.call_count, 0)

    def test_start_reports_resume_size_and_starts_one_thread(self):
        part = self.model_path + ".part"
        Path(part).write_bytes(PAYLOAD[: len(PAYLOAD) // 2])     # 上次下到一半
        with mock.patch.object(main, "Thread") as thread:
            r = run(main.video_depth_model_download())
        self.assertTrue(r["ok"])
        self.assertEqual(r["task_id"], main._DEPTH_MODEL_TASK_ID)
        self.assertGreater(r["resumed_from_mb"], 0.0)
        self.assertEqual(thread.call_count, 1)
        self.assertTrue(main._MODEL_DOWNLOAD_TASKS[main._DEPTH_MODEL_TASK_ID]["downloading"])

    def test_cancel_sets_flag_and_is_safe_without_task(self):
        main._MODEL_DOWNLOAD_TASKS[main._DEPTH_MODEL_TASK_ID] = {"downloading": True}
        self.assertTrue(run(main.video_depth_model_cancel())["ok"])
        self.assertTrue(main._MODEL_DOWNLOAD_TASKS[main._DEPTH_MODEL_TASK_ID]["cancel"])
        main._MODEL_DOWNLOAD_TASKS.pop(main._DEPTH_MODEL_TASK_ID, None)
        self.assertTrue(run(main.video_depth_model_cancel())["ok"])


class DepthModelDownloadTests(_SmallModelTestBase):
    def task(self):
        task = {"downloading": True, "progress": 0, "error": "", "done": False, "cancel": False,
                "downloaded": 0, "total": len(PAYLOAD)}
        main._MODEL_DOWNLOAD_TASKS[main._DEPTH_MODEL_TASK_ID] = task
        return task

    def test_full_download_verifies_then_renames(self):
        task = self.task()
        with mock.patch.object(main.requests, "get", return_value=_Resp(PAYLOAD)) as get:
            main._download_depth_model(main._DEPTH_MODEL_TASK_ID)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args[0][0], main._DEPTH_MODEL_URL)
        self.assertFalse(os.path.exists(self.model_path + ".part"), ".part 应该被 os.replace 掉")
        self.assertEqual(Path(self.model_path).read_bytes(), PAYLOAD)
        self.assertTrue(task["done"])
        self.assertEqual(task["progress"], 100)
        self.assertEqual(task["error"], "")

    def test_resume_uses_range_and_appends(self):
        part = self.model_path + ".part"
        half = len(PAYLOAD) // 2
        Path(part).write_bytes(PAYLOAD[:half])
        task = self.task()
        with mock.patch.object(main.requests, "get",
                               return_value=_Resp(PAYLOAD[half:], status_code=206,
                                                  headers={"Content-Length": str(len(PAYLOAD) - half)})) as get:
            main._download_depth_model(main._DEPTH_MODEL_TASK_ID)
        self.assertEqual(get.call_args.kwargs["headers"], {"Range": "bytes=%d-" % half})
        self.assertEqual(Path(self.model_path).read_bytes(), PAYLOAD)
        self.assertTrue(task["done"])

    def test_retry_keeps_part_file_and_resumes(self):
        part = self.model_path + ".part"
        Path(part).write_bytes(PAYLOAD[:100])
        task = self.task()
        with mock.patch.object(main.requests, "get", side_effect=[main.requests.exceptions.ConnectionError("boom"), _Resp(PAYLOAD[100:], status_code=206)]), \
                mock.patch.object(main.time, "sleep"):
            main._download_depth_model(main._DEPTH_MODEL_TASK_ID)
        self.assertEqual(Path(self.model_path).read_bytes(), PAYLOAD)
        self.assertTrue(task["done"])

    def test_sha_mismatch_removes_part_and_reports(self):
        task = self.task()
        broken = bytes(len(PAYLOAD))
        with mock.patch.object(main.requests, "get", return_value=_Resp(broken)):
            main._download_depth_model(main._DEPTH_MODEL_TASK_ID)
        self.assertFalse(os.path.exists(self.model_path + ".part"))
        self.assertFalse(os.path.exists(self.model_path))
        self.assertIn("校验失败", task["error"])
        self.assertFalse(task["downloading"])

    def test_cancel_keeps_part_for_next_time(self):
        part = self.model_path + ".part"
        task = self.task()
        with mock.patch.object(main.requests, "get", return_value=_Resp(PAYLOAD[:200], status_code=206)):
            task["cancel"] = True
            main._download_depth_model(main._DEPTH_MODEL_TASK_ID)
        self.assertTrue(task["cancelled"])
        self.assertFalse(os.path.exists(self.model_path))


class DepthEnsureModelTests(_SmallModelTestBase):
    def test_already_downloaded_needs_no_wait(self):
        Path(self.model_path).write_bytes(PAYLOAD)
        with mock.patch.object(main, "_begin_depth_model_download") as begin:
            r = run(main._depth_ensure_model(timeout=1))
        self.assertTrue(r["ok"])
        self.assertFalse(r["auto_downloaded"])
        self.assertEqual(begin.call_count, 0)

    def test_runtime_missing_is_reported_without_downloading(self):
        with mock.patch.object(main, "_depth_runtime_ready", return_value=False), \
                mock.patch.object(main, "_begin_depth_model_download") as begin:
            r = run(main._depth_ensure_model(timeout=1))
        self.assertFalse(r["ok"])
        self.assertIn("onnxruntime", r["message"])
        self.assertEqual(begin.call_count, 0)

    def test_waits_until_model_arrives(self):
        state = {"n": 0}

        def downloaded():
            state["n"] += 1
            return state["n"] >= 3

        with mock.patch.object(main, "_depth_model_downloaded", side_effect=downloaded), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_begin_depth_model_download", return_value={"ok": True, "resumed_from_mb": 0.0}), \
                mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS",
                                  {main._DEPTH_MODEL_TASK_ID: {"downloading": True, "progress": 0}}), \
                mock.patch.object(main.asyncio, "sleep"):
            r = run(main._depth_ensure_model(timeout=5))
        self.assertTrue(r["ok"])
        self.assertTrue(r["auto_downloaded"])

    def test_failed_download_points_to_the_menu(self):
        with mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_begin_depth_model_download", return_value={"ok": True}), \
                mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS",
                                  {main._DEPTH_MODEL_TASK_ID: {"downloading": False, "error": "网络连接中断"}}):
            r = run(main._depth_ensure_model(timeout=2))
        self.assertFalse(r["ok"])
        self.assertIn("网络连接中断", r["message"])
        self.assertIn("深度动作捕捉", r["message"])      # 指向视频节点菜单里的下载入口

    def test_timeout_message_says_first_download_is_26mb(self):
        with mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_begin_depth_model_download", return_value={"ok": True}), \
                mock.patch.object(main, "_MODEL_DOWNLOAD_TASKS",
                                  {main._DEPTH_MODEL_TASK_ID: {"downloading": True}}), \
                mock.patch.object(main.asyncio, "sleep"):
            r = run(main._depth_ensure_model(timeout=0.01))
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("timeout"))
        self.assertIn("26 MB", r["message"])


class DepthCaptureMessageTests(_DepthTestBase):
    def payload(self):
        return main.DepthCaptureRequest(url="/output/depth_src.mp4")

    def _src_file(self):
        fh = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        fh.write(b"fake")
        fh.close()
        self.addCleanup(lambda: os.path.exists(fh.name) and os.remove(fh.name))
        return fh.name

    def test_capture_without_model_returns_actionable_400(self):
        src = self._src_file()
        with mock.patch.object(main, "output_file_from_url", return_value=src), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=False):
            with self.assertRaises(main.HTTPException) as caught:
                run(main.video_depth_capture(self.payload()))
        self.assertEqual(caught.exception.status_code, 400)
        detail = str(caught.exception.detail)
        self.assertIn("26 MB", detail)
        self.assertIn("深度动作捕捉", detail)

    def test_capture_without_runtime_returns_actionable_400(self):
        src = self._src_file()
        with mock.patch.object(main, "output_file_from_url", return_value=src), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=True), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=False):
            with self.assertRaises(main.HTTPException) as caught:
                run(main.video_depth_capture(self.payload()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("onnxruntime", str(caught.exception.detail))

    def test_capture_status_without_model_is_200_and_actionable(self):
        with mock.patch.object(main, "_depth_model_downloaded", return_value=False):
            s = run(main.video_depth_capture_status())
        self.assertFalse(s["ready"])
        self.assertIn("26 MB", s["message"])
        self.assertIn("深度动作捕捉", s["message"])

    def test_capture_status_without_runtime(self):
        with mock.patch.object(main, "_depth_model_downloaded", return_value=True), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=False):
            s = run(main.video_depth_capture_status())
        self.assertFalse(s["ready"])
        self.assertIn("onnxruntime", s["message"])


class AgentDepthCaptureAutoDownloadTests(_DepthTestBase):
    def run_tool(self, args):
        tool = main.AGENT_TOOLS["depth_capture"]
        return run(tool["run"](tool["validate"](args)))

    def _fake_module(self, ready_after_download: bool):
        calls = {"available": 0}
        captured = {}

        def available(ffmpeg):
            calls["available"] += 1
            if calls["available"] == 1:
                return False, "本地深度模型未下载（找不到 %s）" % main._DEPTH_MODEL_PATH
            return (True, "") if ready_after_download else (False, "深度模型加载失败")

        def capture_video(ffmpeg, src, dst, *, max_seconds=0.0, keep_audio=True):
            captured.update(src=src, max_seconds=max_seconds)
            Path(dst).write_bytes(b"d")
            return {"path": dst, "frames": 24, "duration": 1.0, "width": 640, "height": 360}, ""

        return types.SimpleNamespace(available=available, capture_video=capture_video), captured

    def test_first_call_downloads_then_converts(self):
        src = main.output_path_for("depth_auto.mp4", "output")
        Path(src).write_bytes(b"x")
        self.addCleanup(lambda: os.path.exists(src) and os.remove(src))
        module, _ = self._fake_module(ready_after_download=True)
        ensure = mock.AsyncMock(return_value={"ok": True, "downloaded": True, "auto_downloaded": True,
                                              "seconds": 8.2, "message": ""})
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(module, "")), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_depth_ensure_model", ensure), \
                mock.patch.object(main, "ffmpeg_binary", return_value="/usr/bin/ffmpeg"):
            result = self.run_tool({"url": main.output_url_for("depth_auto.mp4", "output")})
        self.assertTrue(ensure.await_count == 1, "首次调用应自动下载模型")
        self.assertTrue(result["ready"])
        self.assertTrue(result["model_download"]["auto_downloaded"])
        self.assertIn("首次使用已自动下载约 26 MB 深度模型", result["message"])

    def test_download_failure_is_actionable_not_silent(self):
        ensure = mock.AsyncMock(return_value={"ok": False, "downloaded": False, "auto_downloaded": True,
                                              "message": "网络连接中断；已下载的部分会保留，下次接着下。"})
        module, _ = self._fake_module(ready_after_download=False)
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(module, "")), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_depth_ensure_model", ensure), \
                mock.patch.object(main, "ffmpeg_binary", return_value="/usr/bin/ffmpeg"):
            result = self.run_tool({"url": "/output/whatever.mp4"})
        self.assertFalse(result["ready"])
        self.assertIn("网络连接中断", result["message"])
        self.assertIn("本机深度动作捕捉不可用", result["message"])

    def test_missing_runtime_returns_executable_error_without_download(self):
        module, _ = self._fake_module(ready_after_download=False)
        ensure = mock.AsyncMock()
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(module, "")), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=False), \
                mock.patch.object(main, "_depth_ensure_model", ensure), \
                mock.patch.object(main, "ffmpeg_binary", return_value="/usr/bin/ffmpeg"):
            result = self.run_tool({"url": "/output/whatever.mp4"})
        self.assertFalse(result["ready"])
        self.assertFalse(result["runtime_ready"])
        self.assertIn("onnxruntime", result["message"])
        self.assertEqual(ensure.await_count, 0)

    def test_check_only_never_starts_a_download(self):
        module, _ = self._fake_module(ready_after_download=False)
        ensure = mock.AsyncMock()
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(module, "")), \
                mock.patch.object(main, "_depth_model_downloaded", return_value=False), \
                mock.patch.object(main, "_depth_runtime_ready", return_value=True), \
                mock.patch.object(main, "_depth_ensure_model", ensure), \
                mock.patch.object(main, "ffmpeg_binary", return_value="/usr/bin/ffmpeg"):
            result = self.run_tool({"check_only": True})
        self.assertFalse(result["ready"])
        self.assertEqual(ensure.await_count, 0, "check_only 只查状态，不该动本机文件")
        self.assertIn("26 MB", result["reason"])


if __name__ == "__main__":
    unittest.main()
