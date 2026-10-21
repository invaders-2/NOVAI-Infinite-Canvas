"""APIMart / 火山参考音视频：上游没有上传端点时回退云上传换公网链接。

不联网：进程内起一个 http.server 假上游（同时扮演 APIMart、uguu、temp.sh、Litterbox），
记录每个请求的 method/path，再 asyncio 调 main 的真实函数。断言：
  * auto 顺序是 uguu → litterbox → temp.sh；音频跳过 Litterbox（实测 412）；
  * 每个通道上传后都对返回链接真发一次 GET：状态 200、Content-Type 不含 text/html、
    实际字节 > 0 才算成功，否则换下一个通道（temp.sh 的 GET 只回 HTML 查看页）；
  * CLOUD_MEDIA_UPLOAD_SERVICE 可显式指定 uguu / temp.sh；
  * 全失败时返回原来的友好 HTTPException 400，进程不崩；
  * 火山参考音频云上传成功用链接，失败回退 data URL；
  * 图片/视频/音频本地路径被云端上传放行，video-only 入口仍拒绝音频。
"""
import asyncio
import json
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

TASK_VIDEO = "task_mock_cloud_video"
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32
MP3_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 32
HTML_PAGE = b"<!DOCTYPE html><html><head><title>file viewer</title></head><body>viewer</body></html>"


class _MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _base(self):
        host, port = self.server.server_address[:2]
        return "http://%s:%s" % (host, port)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _record(self, body):
        content_type = str(self.headers.get("Content-Type") or "")
        if "json" in content_type.lower() and body:
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                parsed = {"raw": body.decode("utf-8", "replace")[:500]}
        else:
            parsed = None
        with self.server.log_lock:
            self.server.requests.append({
                "method": self.command,
                "path": self.path.split("?", 1)[0],
                "content_type": content_type,
                "bytes": len(body),
                "body": parsed,
            })
        return parsed

    def _send(self, status, payload=None, raw=None, content_type="application/json"):
        data = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        self._record(body)
        base = self._base()
        if path.startswith("/v1/uploads/"):
            status = int(getattr(self.server, "upload_endpoint_status", 404) or 404)
            if status in (200, 201):
                self._send(status, {"url": base + "/files/uploaded_asset"})
            else:
                self._send(status, {"error": "mock upload endpoint missing", "path": path})
        elif path == "/v1/videos/generations":
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_VIDEO}]})
        elif path == "/uguu/upload":
            status = int(getattr(self.server, "uguu_status", 200) or 200)
            if status == 200:
                suffix = ".mp3" if b"ref.mp3" in body else ".mp4"
                self._send(200, raw=(base + "/files/uguu" + suffix).encode(), content_type="text/plain")
            else:
                self._send(status, {"error": "mock uguu failure"}, content_type="application/json")
        elif path == "/temp/upload":
            status = int(getattr(self.server, "cloud_status", 200) or 200)
            if status == 200:
                self._send(200, raw=(base + "/files/cloud.mp4").encode(), content_type="text/plain")
            else:
                self._send(status, {"error": "mock temp.sh failure"},
                           content_type="application/json")
        elif path == "/litterbox/upload":
            status = int(getattr(self.server, "litterbox_status", 200) or 200)
            if status == 200:
                suffix = ".mp3" if b"ref.mp3" in body else ".mp4"
                self._send(200, raw=(base + "/files/litterbox" + suffix).encode(), content_type="text/plain")
            else:
                self._send(status, {"error": "mock litterbox failure"},
                           content_type="application/json")
        else:
            self._send(404, {"error": "no such mock route", "path": path})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self._record(b"")
        base = self._base()
        if path == "/files/out.mp4":
            self._send(200, raw=MP4_BYTES, content_type="video/mp4")
        elif path == "/files/out.mp3":
            self._send(200, raw=MP3_BYTES, content_type="audio/mpeg")
        elif path == "/files/cloud.mp4":
            self._send(200, raw=MP4_BYTES, content_type="video/mp4")
        elif path in ("/files/uguu.mp3", "/files/uguu.mp4", "/files/litterbox.mp3", "/files/litterbox.mp4"):
            if getattr(self.server, "uguu_get_html", False) and path.startswith("/files/uguu"):
                self._send(200, raw=HTML_PAGE, content_type="text/html; charset=utf-8")
            elif getattr(self.server, "uguu_get_empty", False) and path.startswith("/files/uguu"):
                self._send(200, raw=b"", content_type="application/octet-stream")
            elif path.endswith(".mp3"):
                self._send(200, raw=MP3_BYTES, content_type="audio/mpeg")
            else:
                self._send(200, raw=MP4_BYTES, content_type="video/mp4")
        elif path == "/v1/tasks/" + TASK_VIDEO:
            self._send(200, {"code": 200, "data": {"id": TASK_VIDEO, "status": "completed",
                                                   "result": {"videos": [{"url": [base + "/files/out.mp4"]}]}}})
        else:
            self._send(404, {"error": "no such mock route", "path": path})


class CloudMediaFallbackTests(unittest.TestCase):
    provider_id = "apimart-cloud-mock"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-cloud-media-")
        cls.assets = os.path.join(cls.tmp, "assets")
        cls.output_dir = os.path.join(cls.assets, "output")
        cls.input_dir = os.path.join(cls.assets, "input")
        os.makedirs(cls.output_dir, exist_ok=True)
        os.makedirs(cls.input_dir, exist_ok=True)
        with open(os.path.join(cls.output_dir, "ref.mp4"), "wb") as f:
            f.write(MP4_BYTES)
        with open(os.path.join(cls.output_dir, "ref.mp3"), "wb") as f:
            f.write(MP3_BYTES)
        provider_file = os.path.join(cls.tmp, "api_providers.json")
        with open(provider_file, "w", encoding="utf-8") as f:
            json.dump([{
                "id": cls.provider_id,
                "name": "Mock APIMart",
                "base_url": cls.base,
                "protocol": "apimart",
                "enabled": True,
                "primary": True,
                "use_proxy": "off",
                "image_models": [],
                "chat_models": [],
                "video_models": [],
                "audio_models": [],
            }], f)

        cls.saved = {
            "API_PROVIDERS_FILE": main.API_PROVIDERS_FILE,
            "ASSETS_DIR": main.ASSETS_DIR,
            "OUTPUT_INPUT_DIR": main.OUTPUT_INPUT_DIR,
            "OUTPUT_OUTPUT_DIR": main.OUTPUT_OUTPUT_DIR,
            "HISTORY_FILE": main.HISTORY_FILE,
        }
        main.API_PROVIDERS_FILE = provider_file
        main.ASSETS_DIR = cls.assets
        main.OUTPUT_INPUT_DIR = cls.input_dir
        main.OUTPUT_OUTPUT_DIR = cls.output_dir
        main.HISTORY_FILE = os.path.join(cls.tmp, "history.json")
        os.environ[main.provider_key_env(cls.provider_id)] = "sk-mock"

        cls.env_keys = ("UGUU_UPLOAD_URL", "TEMP_SH_UPLOAD_URL", "LITTERBOX_UPLOAD_URL",
                        "CLOUD_MEDIA_UPLOAD_SERVICE", "CLOUD_VIDEO_UPLOAD_SERVICE",
                        "APIMART_TRY_VIDEO_UPLOAD", "PUBLIC_BASE_URL", "PUBLIC_MEDIA_BASE_URL")
        cls.saved_env = {key: os.environ.get(key) for key in cls.env_keys}
        os.environ["UGUU_UPLOAD_URL"] = cls.base + "/uguu/upload"
        os.environ["TEMP_SH_UPLOAD_URL"] = cls.base + "/temp/upload"
        os.environ["LITTERBOX_UPLOAD_URL"] = cls.base + "/litterbox/upload"
        for key in ("CLOUD_MEDIA_UPLOAD_SERVICE", "CLOUD_VIDEO_UPLOAD_SERVICE",
                    "APIMART_TRY_VIDEO_UPLOAD", "PUBLIC_BASE_URL", "PUBLIC_MEDIA_BASE_URL"):
            os.environ.pop(key, None)

    @classmethod
    def tearDownClass(cls):
        for key, value in cls.saved.items():
            setattr(main, key, value)
        for key, value in cls.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        os.environ.pop(main.provider_key_env(cls.provider_id), None)
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.server.upload_endpoint_status = 404
        self.server.cloud_status = 200
        self.server.litterbox_status = 500
        self.server.uguu_status = 200
        self.server.uguu_get_html = False
        self.server.uguu_get_empty = False
        os.environ.pop("APIMART_TRY_VIDEO_UPLOAD", None)
        os.environ.pop("CLOUD_MEDIA_UPLOAD_SERVICE", None)
        os.environ.pop("PUBLIC_BASE_URL", None)
        os.environ.pop("PUBLIC_MEDIA_BASE_URL", None)
        with self.server.log_lock:
            self.server.requests.clear()

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def posts(self, prefix=""):
        return [item for item in self.requests()
                if item["method"] == "POST" and item["path"].startswith(prefix)]

    def gets(self, path=""):
        return [item for item in self.requests()
                if item["method"] == "GET" and item["path"].startswith(path)]

    def _run_video(self, videos=None, audios=None):
        async def run():
            payload = main.CanvasVideoRequest(
                prompt="mock cloud media", provider_id=self.provider_id, model="seedance-2.0",
                duration=5, aspect_ratio="16:9", resolution="720p",
                videos=list(videos or []), audios=list(audios or []))
            return await main._canvas_video_run_unlimited(payload)
        return asyncio.run(run())

    def _upload(self, ref, service="auto"):
        return asyncio.run(main.upload_local_video_to_cloud(ref, service))

    # ── uguu 通道与 GET 直读校验 ──
    def test_uguu_upload_returns_verified_direct_url(self):
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["url"], self.base + "/files/uguu.mp4")
        self.assertEqual(result["service"], "uguu")
        self.assertEqual(result["source"], "/assets/output/ref.mp4")
        self.assertEqual(result["name"], "ref.mp4")
        self.assertEqual(set(result), {"url", "source", "name", "expires", "service"}, result)
        self.assertEqual(len(self.posts("/uguu/upload")), 1, self.requests())
        self.assertEqual([item["path"] for item in self.gets("/files/uguu")],
                         ["/files/uguu.mp4"], "校验必须真发 GET 读回链接")
        self.assertFalse(self.posts("/litterbox/upload"), self.requests())
        self.assertFalse(self.posts("/temp/upload"), self.requests())

    def test_uguu_audio_upload_verified(self):
        result = self._upload("/assets/output/ref.mp3")
        self.assertEqual(result["url"], self.base + "/files/uguu.mp3")
        self.assertEqual(result["service"], "uguu")
        self.assertEqual([item["path"] for item in self.gets("/files/uguu")], ["/files/uguu.mp3"])

    def test_service_env_uguu_explicit(self):
        os.environ["CLOUD_MEDIA_UPLOAD_SERVICE"] = "uguu"
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["service"], "uguu")
        self.assertEqual(len(self.posts("/uguu/upload")), 1)
        self.assertFalse(self.posts("/litterbox/upload"), self.requests())
        self.assertFalse(self.posts("/temp/upload"), self.requests())

    def test_uguu_html_link_is_rejected_and_falls_back(self):
        self.server.uguu_get_html = True
        self.server.litterbox_status = 200
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["service"], "litterbox", "uguu 的 GET 是 HTML 查看页，必须判失败并换通道")
        self.assertEqual(result["url"], self.base + "/files/litterbox.mp4")
        paths = [item["path"] for item in self.posts()]
        self.assertLess(paths.index("/uguu/upload"), paths.index("/litterbox/upload"), paths)

    def test_uguu_empty_read_is_rejected_and_falls_back(self):
        self.server.uguu_get_empty = True
        self.server.litterbox_status = 200
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["service"], "litterbox", "GET 读到 0 字节也要判失败")
        check = asyncio.run(main.verify_cloud_media_direct_url(self.base + "/files/uguu.mp4"))
        self.assertEqual(check["bytes"], 0)
        self.assertFalse(check["ok"])

    def test_auto_order_is_uguu_then_litterbox_then_temp_sh(self):
        self.server.uguu_status = 500
        self.server.litterbox_status = 200
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["service"], "litterbox")
        paths = [item["path"] for item in self.posts()]
        self.assertEqual(paths, ["/uguu/upload", "/litterbox/upload"], paths)
        self.server.litterbox_status = 500
        with self.server.log_lock:
            self.server.requests.clear()
        result = self._upload("/assets/output/ref.mp4")
        self.assertEqual(result["service"], "temp.sh")
        paths = [item["path"] for item in self.posts()]
        self.assertEqual(paths, ["/uguu/upload", "/litterbox/upload", "/temp/upload"], paths)

    def test_audio_auto_skips_litterbox(self):
        self.server.uguu_status = 500
        result = self._upload("/assets/output/ref.mp3", "auto")
        self.assertEqual(result["service"], "temp.sh")
        paths = [item["path"] for item in self.posts()]
        self.assertEqual(paths, ["/uguu/upload", "/temp/upload"], paths)

    def test_all_channels_fail_returns_friendly_error(self):
        self.server.uguu_status = 500
        self.server.litterbox_status = 500
        self.server.cloud_status = 500
        with self.assertRaises(main.HTTPException) as caught:
            self._upload("/assets/output/ref.mp4")
        self.assertEqual(caught.exception.status_code, 502)
        detail = str(caught.exception.detail)
        self.assertIn("云端上传失败", detail)
        self.assertIn("uguu", detail)
        self.assertIn("litterbox", detail)
        self.assertIn("temp.sh", detail)

    # ── APIMart 参考音视频回退 ──
    def test_apimart_audio_upload_404_falls_back_to_cloud_upload(self):
        result = self._run_video(audios=["/assets/output/ref.mp3"])
        self.assertTrue(result.get("videos"), result)
        upload_paths = [item["path"] for item in self.posts("/v1/uploads/")]
        self.assertEqual(upload_paths,
                         ["/v1/uploads/audios", "/v1/uploads/files", "/v1/uploads/images"])
        self.assertFalse(self.posts("/litterbox/upload"), "音频不应再打一次注定失败的 Litterbox")
        self.assertEqual(len(self.posts("/uguu/upload")), 1, self.requests())
        body = self.posts("/v1/videos/generations")[0]["body"]
        self.assertEqual(body.get("audio_urls"), [self.base + "/files/uguu.mp3"], body)
        self.assertFalse(any("data:" in str(url) for url in body["audio_urls"]), body)

    def test_apimart_video_switch_off_falls_back_to_cloud_upload(self):
        result = self._run_video(videos=["/assets/output/ref.mp4"])
        self.assertTrue(result.get("videos"), result)
        paths = [item["path"] for item in self.posts()]
        self.assertEqual([p for p in paths if not p.startswith("/v1/")], ["/uguu/upload"], paths)
        self.assertFalse([p for p in paths if p.startswith("/v1/uploads/")],
                         "APIMART_TRY_VIDEO_UPLOAD 关闭时不应请求上传端点")
        body = self.posts("/v1/videos/generations")[0]["body"]
        self.assertEqual(body.get("video_urls"), [self.base + "/files/uguu.mp4"], body)
        self.assertFalse(any("data:" in str(url) for url in body["video_urls"]), body)

    def test_apimart_video_upload_404_falls_back_to_cloud_upload(self):
        os.environ["APIMART_TRY_VIDEO_UPLOAD"] = "1"
        result = self._run_video(videos=["/assets/output/ref.mp4"])
        self.assertTrue(result.get("videos"), result)
        upload_paths = [item["path"] for item in self.posts("/v1/uploads/")]
        self.assertEqual(upload_paths,
                         ["/v1/uploads/videos", "/v1/uploads/files", "/v1/uploads/images"])
        body = self.posts("/v1/videos/generations")[0]["body"]
        self.assertEqual(body.get("video_urls"), [self.base + "/files/uguu.mp4"], body)
        self.assertFalse(any("data:" in str(url) for url in body["video_urls"]), body)

    def test_apimart_video_cloud_failure_returns_friendly_error(self):
        os.environ["APIMART_TRY_VIDEO_UPLOAD"] = "1"
        self.server.uguu_status = 500
        self.server.litterbox_status = 500
        self.server.cloud_status = 500
        with self.assertRaises(main.HTTPException) as caught:
            self._run_video(videos=["/assets/output/ref.mp4"])
        detail = str(caught.exception.detail)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("输入视频无法转换为 APIMart 支持的格式", detail)
        self.assertIn("PUBLIC_BASE_URL", detail)
        self.assertIn("检查网络", detail)
        self.assertEqual(self.posts("/v1/videos/generations"), [], "失败时不应提交生成请求")

    def test_apimart_audio_cloud_failure_returns_friendly_error(self):
        self.server.uguu_status = 500
        self.server.cloud_status = 500
        with self.assertRaises(main.HTTPException) as caught:
            self._run_video(audios=["/assets/output/ref.mp3"])
        detail = str(caught.exception.detail)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("参考音频无法转换为 APIMart 支持的地址", detail)
        self.assertIn("PUBLIC_BASE_URL", detail)
        self.assertIn("检查网络", detail)
        self.assertEqual(self.posts("/v1/videos/generations"), [])

    def test_apimart_audio_uses_cloud_media_service_env(self):
        os.environ["CLOUD_MEDIA_UPLOAD_SERVICE"] = "temp.sh"
        self.server.litterbox_status = 200
        result = self._run_video(audios=["/assets/output/ref.mp3"])
        self.assertTrue(result.get("videos"), result)
        self.assertEqual(len(self.posts("/temp/upload")), 1, self.requests())
        self.assertFalse(self.posts("/uguu/upload"), self.requests())
        self.assertFalse(self.posts("/litterbox/upload"), self.requests())
        body = self.posts("/v1/videos/generations")[0]["body"]
        self.assertEqual(body.get("audio_urls"), [self.base + "/files/cloud.mp4"], body)

    def test_volcengine_audio_uses_cloud_link_when_upload_succeeds(self):
        url = asyncio.run(main.volcengine_audio_reference_url("/assets/output/ref.mp3"))
        self.assertEqual(url, self.base + "/files/uguu.mp3")
        self.assertEqual(len(self.posts("/uguu/upload")), 1, self.requests())

    def test_volcengine_audio_falls_back_to_data_url_when_upload_fails(self):
        self.server.uguu_status = 500
        self.server.cloud_status = 500
        url = asyncio.run(main.volcengine_audio_reference_url("/assets/output/ref.mp3"))
        self.assertTrue(str(url).startswith("data:audio/mpeg;base64,"), str(url)[:48])

    def test_cloud_upload_path_accepts_audio_but_video_entry_rejects_it(self):
        path = main.local_media_path_for_cloud_upload("/assets/output/ref.mp3")
        self.assertEqual(path, os.path.join(self.output_dir, "ref.mp3"))
        self.assertEqual(main.local_media_path_for_cloud_upload("/assets/output/ref.mp4"),
                         os.path.join(self.output_dir, "ref.mp4"))
        with self.assertRaises(main.HTTPException) as caught:
            main.local_video_path_for_cloud_upload("/assets/output/ref.mp3")
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
