"""离线 mock 上游验证 APIMart 官方渠道 / 扩展渠道 / Midjourney 实际打出的 HTTP 请求。

不联网：进程内起一个 http.server 假上游，记录每个请求的 method/path/host/body，再 asyncio 调
main 的真实函数。断言口径来自官方文档：
  * 官方渠道（模型名以 -official 结尾，含别名 nano-banana-pro）参考图必须先 POST /v1/uploads/images
    换成公网 http(s) URL 再放进 image_urls，且不能携带 official_fallback；
  * 扩展渠道参考图能直接塞进 900KB JSON 时不碰 /v1/uploads/images（与旧行为一致）；
    塞不下才先压成小 JPEG、再逐张 POST /v1/uploads/images 换公网 URL，上传任一张失败则整体
    回退到压缩 base64 data URI，整个 JSON 请求体必须低于上游 1MB 网关限制；
  * 扩展渠道允许 official_fallback=false；用 URL 发图后上游 4xx 且抱怨 url/image 时改用压缩
    data URI 重试一次；
  * Midjourney 提交/查询主机跟随 provider.base_url，不再固定 api.apimart.ai。
"""
import asyncio
import json
import os
import shutil
import struct
import tempfile
import threading
import unittest
import zlib
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

TASK_IMAGE = "task_mock_img"
TASK_MIDJOURNEY = "task_mock_mj"
TASK_VIDEO = "task_mock_video"
TASK_AUDIO = "task_mock_audio"
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32
MP3_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 32
REAL_REF_NAMES = (
    "ai_ref_e65b943fab3f.jpg", "ai_ref_213dab10a028.jpg", "ai_ref_aa2b54d457db.jpg",
    "ai_ref_8d80f2bc741f.jpg", "ai_ref_cf80171a80d0.jpg",
)


def _png_8x8():
    width = height = 8
    raw = b"".join(b"\x00" + bytes([255, 64, 64, 255]) * width for _ in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


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
        elif body:
            parsed = {"content_type": content_type, "bytes": len(body)}
        else:
            parsed = None
        with self.server.log_lock:
            self.server.requests.append({
                "method": self.command,
                "path": self.path.split("?", 1)[0],
                "host": self.headers.get("Host") or "",
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
        entry = self._record(self._read_body())
        if path == "/v1/uploads/images":
            status = int(getattr(self.server, "upload_status", 200) or 200)
            if status != 200:
                self._send(status, {"error": "mock upload failure"})
                return
            self._send(200, {"url": self._base() + "/files/uploaded.png", "filename": "uploaded.png",
                             "content_type": "image/png", "bytes": 123, "created_at": 1893456000})
        elif path == "/v1/images/generations":
            urls = ((entry or {}).get("image_urls") or []) if isinstance(entry, dict) else []
            rejects_remote = getattr(self.server, "reject_remote_image_urls", False)
            if rejects_remote and any(str(url).startswith(("http://", "https://")) for url in urls):
                self._send(400, {"error": "failed to download image url: image unavailable"})
                return
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_IMAGE}]})
        elif path == "/v1/midjourney/generations":
            self._send(200, {"code": 200, "data": {"task_id": TASK_MIDJOURNEY, "status": "SUBMITTED"}})
        elif path == "/v1/videos/generations":
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_VIDEO}]})
        elif path == "/v1/music/generations":
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_AUDIO}]})
        else:
            self._send(404, {"error": "no such mock route", "path": path})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self._record(b"")
        base = self._base()
        if path == "/files/out.png":
            self._send(200, raw=_png_8x8(), content_type="image/png")
        elif path == "/files/out.mp4":
            self._send(200, raw=MP4_BYTES, content_type="video/mp4")
        elif path == "/files/out.mp3":
            self._send(200, raw=MP3_BYTES, content_type="audio/mpeg")
        elif path == "/v1/tasks/" + TASK_IMAGE:
            self._send(200, {"code": 200, "data": {"id": TASK_IMAGE, "status": "completed", "progress": 100,
                                                   "result": {"images": [{"url": [base + "/files/out.png"],
                                                                          "expires_at": 1893456000}]}}})
        elif path == "/v1/music/tasks/" + TASK_AUDIO:
            self._send(200, {"code": 200, "data": {"id": TASK_AUDIO, "status": "completed",
                                                   "cost": 0.0123, "credits_cost": 0.123,
                                                   "result": {"music": [{"title": "Mock Song",
                                                                         "audio_url": base + "/files/out.mp3"}]}}})
        elif path == "/v1/tasks/" + TASK_VIDEO:
            self._send(200, {"code": 200, "data": {"id": TASK_VIDEO, "status": "completed",
                                                   "result": {"videos": [{"url": [base + "/files/out.mp4"]}]}}})
        elif path == "/v1/midjourney/" + TASK_MIDJOURNEY:
            self._send(200, {"code": 200, "data": {"task_id": TASK_MIDJOURNEY, "status": "SUCCESS",
                                                   "image_urls": [base + "/files/out.png"]}})
        else:
            self._send(404, {"error": "no such mock route", "path": path})


class ApimartMockUpstreamTests(unittest.TestCase):
    provider_id = "apimart-mock"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-apimart-mock-")
        cls.assets = os.path.join(cls.tmp, "assets")
        cls.output_dir = os.path.join(cls.assets, "output")
        cls.input_dir = os.path.join(cls.assets, "input")
        os.makedirs(cls.output_dir, exist_ok=True)
        os.makedirs(cls.input_dir, exist_ok=True)
        with open(os.path.join(cls.output_dir, "ref.png"), "wb") as f:
            f.write(_png_8x8())
        cls.real_refs = []
        for name in REAL_REF_NAMES:
            src = os.path.join(os.path.expanduser("~/NOVAI/assets/input"), name)
            if not os.path.isfile(src):
                cls.real_refs = []
                break
            shutil.copyfile(src, os.path.join(cls.input_dir, name))
            cls.real_refs.append("/assets/input/" + name)
        provider_file = os.path.join(cls.tmp, "api_providers.json")
        with open(provider_file, "w", encoding="utf-8") as f:
            json.dump([{
                "id": cls.provider_id,
                "name": "Mock Gateway",
                "base_url": cls.base,
                "protocol": "apimart",
                "enabled": True,
                "primary": True,
                "use_proxy": "off",
                "image_models": ["gpt-image-2-official", "gpt-image-2", "seedream-5-0-flash"],
                "chat_models": [],
                "video_models": [],
                "audio_models": ["suno", "flowmusic"],
            }], f)

        cls.saved = {
            "API_PROVIDERS_FILE": main.API_PROVIDERS_FILE,
            "ASSETS_DIR": main.ASSETS_DIR,
            "OUTPUT_INPUT_DIR": main.OUTPUT_INPUT_DIR,
            "OUTPUT_OUTPUT_DIR": main.OUTPUT_OUTPUT_DIR,
            "APIMART_IMAGE_INITIAL_POLL_DELAY": main.APIMART_IMAGE_INITIAL_POLL_DELAY,
            "APIMART_IMAGE_POLL_INTERVAL": main.APIMART_IMAGE_POLL_INTERVAL,
            "APIMART_MUSIC_FIRST_DELAY": main.APIMART_MUSIC_FIRST_DELAY,
            "APIMART_MUSIC_POLL_INTERVAL": main.APIMART_MUSIC_POLL_INTERVAL,
            "HISTORY_FILE": main.HISTORY_FILE,
        }
        main.API_PROVIDERS_FILE = provider_file
        main.ASSETS_DIR = cls.assets
        main.OUTPUT_INPUT_DIR = os.path.join(cls.assets, "input")
        main.OUTPUT_OUTPUT_DIR = cls.output_dir
        main.APIMART_IMAGE_INITIAL_POLL_DELAY = 0.05
        main.APIMART_IMAGE_POLL_INTERVAL = 0.05
        main.APIMART_MUSIC_FIRST_DELAY = 0.02
        main.APIMART_MUSIC_POLL_INTERVAL = 0.02
        main.HISTORY_FILE = os.path.join(cls.tmp, "history.json")
        os.environ[main.provider_key_env(cls.provider_id)] = "sk-mock"

    @classmethod
    def tearDownClass(cls):
        for key, value in cls.saved.items():
            setattr(main, key, value)
        os.environ.pop(main.provider_key_env(cls.provider_id), None)
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.server.upload_status = 200
        self.server.reject_remote_image_urls = False
        with self.server.log_lock:
            self.server.requests.clear()

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def assert_local_output(self, url):
        self.assertIsInstance(url, str)
        self.assertTrue(url.startswith("/assets/output/"), url)
        self.assertTrue(os.path.isfile(os.path.join(self.output_dir, url.split("/assets/output/", 1)[1])), url)

    def generate_image(self, model, refs=None):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"}] if refs is None else refs

        async def run():
            image_data, _raw = await main._generate_ai_image_unlimited(
                prompt="mock", size="1024x1024", quality="", model=model,
                reference_images=refs, provider_id=self.provider_id)
            return image_data, await main.save_ai_image_to_output(image_data, prefix="mock_")
        return asyncio.run(run())

    def real_reference_refs(self):
        if len(self.real_refs) != 5:
            self.skipTest("缺少 ~/NOVAI/assets/input 下的 5 张真实参考图，跳过真实体积验证")
        return [{"url": url, "kind": "image"} for url in self.real_refs]

    def test_official_channel_uploads_reference_before_generating(self):
        image_data, local_url = self.generate_image("gpt-image-2-official")
        self.assertEqual(image_data.get("type"), "url")
        entries = self.requests()
        posts = [(index, item) for index, item in enumerate(entries) if item["method"] == "POST"]
        uploads = [index for index, item in posts if item["path"] == "/v1/uploads/images"]
        generates = [index for index, item in posts if item["path"] == "/v1/images/generations"]
        self.assertEqual(len(uploads), 1, entries)
        self.assertEqual(len(generates), 1, entries)
        self.assertLess(uploads[0], generates[0], "参考图必须先生成公网 URL")
        body = entries[generates[0]]["body"]
        self.assertNotIn("official_fallback", body)
        urls = body.get("image_urls")
        self.assertIsInstance(urls, list)
        self.assertEqual(len(urls), 1)
        self.assertTrue(urls[0].startswith(self.base + "/"), urls)
        self.assertGreaterEqual(sum(1 for item in entries if item["path"] == "/v1/tasks/" + TASK_IMAGE), 1)
        self.assert_local_output(local_url)

    def test_extension_channel_small_request_skips_upload(self):
        _image_data, local_url = self.generate_image("gpt-image-2")
        entries = self.requests()
        self.assertFalse([item for item in entries if item["path"] == "/v1/uploads/images"], entries)
        generates = [index for index, item in enumerate(entries)
                     if item["method"] == "POST" and item["path"] == "/v1/images/generations"]
        self.assertEqual(len(generates), 1, entries)
        entry = entries[generates[0]]
        body = entry["body"]
        self.assertIs(body.get("official_fallback"), False)
        urls = body.get("image_urls") or []
        self.assertEqual(len(urls), 1, urls)
        self.assertTrue(str(urls[0]).startswith("data:image/"), str(urls[0])[:48])
        self.assertLessEqual(entry["bytes"], main.APIMART_JSON_BODY_BUDGET, entry["bytes"])
        self.assert_local_output(local_url)

    def test_reference_to_jpeg_data_url_flattens_rgba(self):
        url = main.reference_to_jpeg_data_url({"url": "/assets/output/ref.png"}, 512, 88)
        self.assertTrue(str(url).startswith("data:image/jpeg;base64,"), str(url)[:48])
        self.assertLess(len(url), 4096, len(url))

    def test_extension_channel_uploads_five_real_references_under_1mb(self):
        refs = self.real_reference_refs()
        _image_data, local_url = self.generate_image("gemini-3-pro-image-preview", refs=refs)
        entries = self.requests()
        uploads = [index for index, item in enumerate(entries)
                   if item["method"] == "POST" and item["path"] == "/v1/uploads/images"]
        generates = [index for index, item in enumerate(entries)
                     if item["method"] == "POST" and item["path"] == "/v1/images/generations"]
        self.assertEqual(len(uploads), 5, entries[:4])
        self.assertEqual(len(generates), 1, entries[-3:])
        entry = entries[generates[0]]
        urls = entry["body"].get("image_urls") or []
        self.assertEqual(len(urls), 5, urls)
        self.assertTrue(all(str(url).startswith(("http://", "https://")) for url in urls), urls)
        self.assertFalse(any("base64" in str(url) for url in urls), urls)
        self.assertLess(entry["bytes"], 1024 * 1024, entry["bytes"])
        upload_bytes = [entries[index]["bytes"] for index in uploads]
        self.assertTrue(all(size < 1024 * 1024 for size in upload_bytes), upload_bytes)
        print("\n[上传成功] 5 张真实参考图：每张 multipart %s 字节，images 请求体 %d 字节"
              % (upload_bytes, entry["bytes"]))
        self.assert_local_output(local_url)

    def test_extension_channel_falls_back_to_compressed_data_urls_under_1mb(self):
        refs = self.real_reference_refs()
        self.server.upload_status = 500
        _image_data, local_url = self.generate_image("gemini-3-pro-image-preview", refs=refs)
        entries = self.requests()
        uploads = [item for item in entries if item["method"] == "POST" and item["path"] == "/v1/uploads/images"]
        generates = [index for index, item in enumerate(entries)
                     if item["method"] == "POST" and item["path"] == "/v1/images/generations"]
        self.assertGreaterEqual(len(uploads), 1, "参考图应先尝试上传")
        self.assertEqual(len(generates), 1, entries[-3:])
        self.assertLess(entries.index(uploads[0]), generates[0], "先尝试上传，失败后才回退")
        self.assertLess(uploads[0]["bytes"], 1024 * 1024, uploads[0]["bytes"])
        entry = entries[generates[0]]
        urls = entry["body"].get("image_urls") or []
        self.assertEqual(len(urls), 5, urls)
        self.assertTrue(all(str(url).startswith("data:image/jpeg;base64,") for url in urls),
                        [str(url)[:32] for url in urls])
        self.assertLess(entry["bytes"], 1024 * 1024, entry["bytes"])
        self.assertLessEqual(entry["bytes"], main.APIMART_JSON_BODY_BUDGET, entry["bytes"])
        decoded = [len(url.split(";base64,", 1)[1]) * 3 // 4 for url in urls]
        print("\n[回退压缩] 5 张真实参考图：每张 JPEG %s 字节，data URL 合计 %d 字节，images 请求体 %d 字节"
              % (decoded, sum(len(url) for url in urls), entry["bytes"]))
        self.assert_local_output(local_url)

    def test_extension_channel_retries_data_urls_when_remote_urls_rejected(self):
        refs = self.real_reference_refs()
        self.server.reject_remote_image_urls = True
        _image_data, local_url = self.generate_image("gemini-3-pro-image-preview", refs=refs)
        entries = self.requests()
        uploads = [item for item in entries if item["method"] == "POST" and item["path"] == "/v1/uploads/images"]
        generates = [index for index, item in enumerate(entries)
                     if item["method"] == "POST" and item["path"] == "/v1/images/generations"]
        self.assertEqual(len(uploads), 5, entries[:6])
        self.assertEqual(len(generates), 2, entries[-3:])
        first_urls = entries[generates[0]]["body"].get("image_urls") or []
        self.assertTrue(all(str(url).startswith(("http://", "https://")) for url in first_urls), first_urls)
        entry = entries[generates[1]]
        urls = entry["body"].get("image_urls") or []
        self.assertEqual(len(urls), 5, urls)
        self.assertTrue(all(str(url).startswith("data:image/jpeg;base64,") for url in urls),
                        [str(url)[:32] for url in urls])
        self.assertLessEqual(entry["bytes"], main.APIMART_JSON_BODY_BUDGET, entry["bytes"])
        self.assert_local_output(local_url)

    def test_compression_failure_keeps_reference_order(self):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"},
                {"url": self.real_reference_refs()[1]["url"], "kind": "image"},
                {"url": "/assets/output/ref.png", "kind": "image"}]
        original = main.reference_to_jpeg_data_url
        broken = refs[1]["url"]

        def fake(ref, max_size, quality=88):
            if ref.get("url") == broken:
                return ""
            return original(ref, max_size, quality)

        with mock.patch.object(main, "reference_to_jpeg_data_url", fake), \
                mock.patch.object(main, "apimart_fallback_compression_ladder", lambda count: [(512, 80)]):
            urls = main.apimart_reference_data_urls(refs, {"model": "m", "prompt": "p"})
        self.assertEqual(len(urls), 3)
        self.assertTrue(urls[0].startswith("data:image/jpeg;base64,"), urls[0][:32])
        self.assertTrue(urls[1].startswith("data:image/jpeg;base64,"), urls[1][:32])
        self.assertGreater(len(urls[1]), 1_000_000, "压缩失败的那张必须退回原图而不是被丢掉")
        self.assertTrue(urls[2].startswith("data:image/jpeg;base64,"), urls[2][:32])
        self.assertGreater(main.apimart_json_body_bytes({"model": "m", "prompt": "p"}, urls),
                           main.APIMART_JSON_BODY_BUDGET)

    def test_unreadable_reference_raises_clear_error(self):
        with mock.patch.object(main, "apimart_fallback_compression_ladder", lambda count: [(512, 80)]):
            with self.assertRaises(main.HTTPException) as caught:
                main.apimart_reference_data_urls([{"url": "/assets/output/missing.png"}], {"prompt": "p"})
        self.assertIn("参考图读取失败", caught.exception.detail)

    def test_image_url_rejected_matches_gateway_complaints(self):
        self.assertTrue(main.apimart_image_url_rejected("failed to download image url"))
        self.assertTrue(main.apimart_image_url_rejected("Invalid image_url: fetch error"))
        self.assertFalse(main.apimart_image_url_rejected("rate limit exceeded"))

    def test_friendly_error_for_nginx_413_html(self):
        html = ("<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n"
                "<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n"
                "</body>\r\n</html>\r\n")
        detail = main.friendly_image_error_detail(html, "1312x2048", "gemini-3-pro-image-preview")
        self.assertIn("1MB", detail)
        self.assertIn("参考图", detail)
        self.assertIn("不是本机", detail)
        self.assertNotIn("<html", detail)
        self.assertNotIn("Request Entity Too Large", detail)
        plain = main.friendly_image_error_detail("413 Payload Too Large", "1312x2048", "gemini-3-pro-image-preview")
        self.assertIn("1MB", plain)

    def test_friendly_error_for_generic_gateway_html(self):
        detail = main.friendly_image_error_detail(
            "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>")
        self.assertTrue(detail)
        self.assertIn("网关", detail)
        self.assertNotIn("<", detail)
        self.assertNotIn("Bad Gateway", detail)

    def test_midjourney_follows_provider_base_url(self):
        provider = main.get_api_provider(self.provider_id)
        self.assertEqual(main.apimart_api_base(provider), self.base)

        async def run():
            _raw, task_id = await main.apimart_midjourney_request(
                provider, "/v1/midjourney/generations", {"prompt": "mock mj"})
            result = await main.midjourney_result(provider, task_id)
            return task_id, result

        task_id, result = asyncio.run(run())
        self.assertEqual(task_id, TASK_MIDJOURNEY)
        submits = [item for item in self.requests() if item["path"] == "/v1/midjourney/generations"]
        self.assertTrue(submits, self.requests())
        self.assertEqual(submits[0]["host"], self.base.split("://", 1)[1])
        self.assertEqual(result.get("status"), "succeeded")
        self.assert_local_output((result.get("images") or [""])[0])


    def _run_video(self, model, duration, ratio, resolution):
        async def run():
            payload = main.CanvasVideoRequest(
                prompt="mock video", provider_id=self.provider_id, model=model,
                duration=duration, aspect_ratio=ratio, resolution=resolution)
            return await main._canvas_video_run_unlimited(payload)
        return asyncio.run(run())

    def test_video_body_follows_document_fields(self):
        seedance = self._run_video("seedance-2.0", 20, "21:9", "4k")
        kling = self._run_video("kling-v3", 1, "21:9", "1080p")
        posts = [item for item in self.requests() if item["method"] == "POST" and item["path"] == "/v1/videos/generations"]
        self.assertEqual(len(posts), 2, self.requests())
        seedance_body = posts[0]["body"]
        self.assertEqual(seedance_body["duration"], 15)
        self.assertEqual(seedance_body["size"], "21:9")
        self.assertEqual(seedance_body["resolution"], "4k")
        self.assertNotIn("aspect_ratio", seedance_body)
        kling_body = posts[1]["body"]
        self.assertEqual(kling_body["duration"], 3)
        self.assertEqual(kling_body["aspect_ratio"], "16:9")
        self.assertEqual(kling_body["mode"], "pro")
        self.assertNotIn("size", kling_body)
        for result in (seedance, kling):
            self.assertEqual(result.get("task_id"), TASK_VIDEO)
            videos = result.get("videos") or []
            self.assertTrue(videos and videos[0].startswith("/assets/output/"), result)
            self.assertTrue(os.path.isfile(os.path.join(self.output_dir, videos[0].split("/assets/output/", 1)[1])))
        self.assertGreaterEqual(sum(1 for item in self.requests() if item["path"] == "/v1/tasks/" + TASK_VIDEO), 2)


    def test_audio_suno_and_flowmusic_bodies_and_files(self):
        async def run(payload):
            return await main.generate_canvas_audio(payload)

        suno = asyncio.run(run(main.CanvasAudioRequest(
            provider_id=self.provider_id, model="suno", prompt="[verse] 歌词", custom=True,
            title="Mock Song", style="pop", duration=30, audio_format="mp3")))
        flow = asyncio.run(run(main.CanvasAudioRequest(
            provider_id=self.provider_id, model="flowmusic", prompt="lofi 鼓点", title="夜色", bpm=90, length=60)))

        posts = [item for item in self.requests() if item["method"] == "POST" and item["path"] == "/v1/music/generations"]
        self.assertEqual(len(posts), 2, self.requests())
        suno_body = posts[0]["body"]
        self.assertEqual(suno_body["model"], "suno")
        self.assertEqual(suno_body["version"], main.APIMART_SUNO_VERSION)
        self.assertIs(suno_body["custom"], True)
        self.assertEqual(suno_body["prompt"], "[verse] 歌词")
        self.assertEqual(suno_body["title"], "Mock Song")
        self.assertEqual(suno_body["style"], "pop")
        self.assertEqual(suno_body["duration"], 30)
        self.assertEqual(suno_body["audio_format"], "mp3")
        flow_body = posts[1]["body"]
        self.assertEqual(flow_body, {"model": "flowmusic", "sound_prompt": "lofi 鼓点", "title": "夜色", "bpm": 90, "length": 60})

        for result in (suno, flow):
            self.assertEqual(result["task_id"], TASK_AUDIO)
            self.assertEqual(result["canvas_meta"]["node_type"], "audio")
            self.assertTrue(result["canvas_meta"]["auto_place"])
            self.assertEqual(len(result["audios"]), 1, result)
            self.assert_local_output(result["audios"][0])
            self.assertTrue(result["audios"][0].endswith(".mp3"), result["audios"][0])
        self.assertEqual(suno["canvas_meta"]["title"], "Mock Song")
        self.assertEqual(suno["cost"], 0.0123)
        self.assertEqual(suno["credits_cost"], 0.123)
        self.assertGreaterEqual(sum(1 for item in self.requests() if item["path"] == "/v1/music/tasks/" + TASK_AUDIO), 2)

    def test_online_image_returns_size_notice_when_clamped(self):
        payload = main.OnlineImageRequest(provider_id=self.provider_id, model="seedream-5-0-flash",
                                          prompt="mock notice", size="4096x4096", n=1)
        result = asyncio.run(main.build_online_image_result(payload))
        self.assertIn("size_notice", result)
        self.assertIn("2K", result["size_notice"])
        self.assertIn("4K", result["size_notice"])
        self.assert_local_output(result["images"][0])

        plain = main.OnlineImageRequest(provider_id=self.provider_id, model="gpt-image-2",
                                        prompt="mock no notice", size="1024x1024", n=1)
        plain_result = asyncio.run(main.build_online_image_result(plain))
        self.assertNotIn("size_notice", plain_result)


if __name__ == "__main__":
    unittest.main()
