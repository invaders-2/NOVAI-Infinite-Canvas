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
TASK_MJ_VIDEO = "task_mock_mj_video"
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
                "response_version": self.headers.get("X-APIMart-Response-Version") or "",
                "has_idempotency_key": bool(self.headers.get("Idempotency-Key")),
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
            model = str((entry or {}).get("model") or "") if isinstance(entry, dict) else ""
            if model == "grok-imagine-2.0-ext" and (
                    urls or entry.get("resolution") != "quality" or entry.get("size") == "auto"):
                self._send(400, {"error": {"message": "invalid grok ext parameters"}})
                return
            if model.startswith("grok-imagine-image") and (
                    "aspect_ratio" not in entry or any(str(url).startswith("data:") for url in urls)):
                self._send(400, {"error": {"message": "invalid grok official parameters"}})
                return
            if model in {"imagen-4.0-apimart", "z-image-turbo"} and urls:
                self._send(400, {"error": {"message": "text-to-image only"}})
                return
            if model == "z-image-turbo" and "n" in entry:
                self._send(400, {"error": {"message": "n is unsupported"}})
                return
            public_only = (
                model.startswith("qwen-image-2.0")
                or (model.startswith("gpt-image-2.5-") and model != "gpt-image-2.5-ext")
                or model == "hy-image-v3.5-preview"
                or model.startswith("grok-imagine-1.5")
            )
            if public_only and any(str(url).startswith("data:") for url in urls):
                self._send(400, {"error": {"message": "public image URL required"}})
                return
            rejects_remote = getattr(self.server, "reject_remote_image_urls", False)
            if rejects_remote and any(str(url).startswith(("http://", "https://")) for url in urls):
                self._send(400, {"error": "failed to download image url: image unavailable"})
                return
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_IMAGE}]})
        elif path == "/v1/midjourney/generations":
            self._send(200, {"code": 200, "data": {"task_id": TASK_MIDJOURNEY, "status": "SUBMITTED"}})
        elif path == "/v1/midjourney/generations/video":
            # 文档：提交只回 task_id；结果走 GET /v1/tasks/{id}
            self._send(200, {"code": 200, "data": {"task_id": TASK_MJ_VIDEO, "status": "SUBMITTED"}})
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
        elif path == "/files/out2.mp4":
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
        elif path == "/v1/tasks/" + TASK_MJ_VIDEO:
            # 文档 L20490–L20520：SUCCESS 带 video_url（首条）+ video_urls（length === batch_size）
            self._send(200, {"code": 200, "data": {
                "id": TASK_MJ_VIDEO, "status": "completed", "action": "VIDEO", "mode": "FAST",
                "video_url": base + "/files/out.mp4",
                "video_urls": [base + "/files/out.mp4", base + "/files/out2.mp4"]}})
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
                "image_models": ["gpt-image-2-official", "gpt-image-2", "seedream-5-0-flash",
                                 "kling-v4-image", "kling-v4-long-image", "mai-image-2.7"],
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
        main._APIMART_UPLOAD_CACHE.clear()
        with self.server.log_lock:
            self.server.requests.clear()

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def assert_local_output(self, url):
        self.assertIsInstance(url, str)
        self.assertTrue(url.startswith("/assets/output/"), url)
        self.assertTrue(os.path.isfile(os.path.join(self.output_dir, url.split("/assets/output/", 1)[1])), url)

    def generate_image(self, model, refs=None, quality="", size="1024x1024", background="auto", n=1,
                       midjourney_version="", midjourney_hd=False, skill="", length="", series_images=0):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"}] if refs is None else refs

        async def run():
            image_data, _raw = await main._generate_ai_image_unlimited(
                prompt="mock", size=size, quality=quality, model=model,
                reference_images=refs, provider_id=self.provider_id, background=background, n=n,
                midjourney_version=midjourney_version, midjourney_hd=midjourney_hd,
                skill=skill, length=length, series_images=series_images)
            return image_data, await main.save_ai_image_to_output(image_data, prefix="mock_")
        return asyncio.run(run())

    def image_body(self, model):
        """取该模型最后一次 /v1/images/generations 的请求体。"""
        entries = self.requests()
        for entry in reversed(entries):
            if entry["method"] == "POST" and entry["path"] == "/v1/images/generations":
                body = entry["body"] or {}
                if str(body.get("model") or "") == model:
                    return body
        self.fail("没有找到 %s 的 /v1/images/generations 请求：%s" % (model, entries))

    def test_kling_v4_image_series_body(self):
        # 系列模式：sequential_image_generation=auto + max_images 2–4，且不能带 n（n>1 上游 400）
        self.generate_image("kling-v4-image", refs=[], size="3:4", series_images=4)
        body = self.image_body("kling-v4-image")
        self.assertEqual(body.get("sequential_image_generation"), "auto")
        self.assertEqual(body.get("sequential_image_generation_options"), {"max_images": 4})
        self.assertNotIn("n", body)
        self.assertEqual(body.get("resolution"), "2K")
        self.assertEqual(body.get("size"), "3:4")
        for field in ("width", "height", "mask_url", "skill", "background"):
            self.assertNotIn(field, body)

    def test_kling_v4_image_standard_keeps_nine(self):
        # 标准模式 n 1–9：后端不许把 n 钳到 4（也不能被旧的 8 张上限吞掉）
        self.generate_image("kling-v4-image", refs=[], size="1:1", n=9)
        body = self.image_body("kling-v4-image")
        self.assertEqual(body.get("n"), 9)
        self.assertNotIn("sequential_image_generation", body)

    def test_kling_v4_long_image_ecommerce_body(self):
        self.generate_image("kling-v4-long-image", size="1024x1024")
        body = self.image_body("kling-v4-long-image")
        self.assertEqual(body.get("skill"), "ecommerce")
        self.assertEqual(body.get("length"), "medium")
        self.assertEqual(body.get("n"), 1)
        # 这个模型收 size/aspect_ratio/width/height 就 400
        for field in ("size", "aspect_ratio", "width", "height", "mask_url"):
            self.assertNotIn(field, body)
        self.assertEqual(len(body.get("image_urls") or []), 1)

    def test_kling_v4_long_image_webpage_without_refs(self):
        self.generate_image("kling-v4-long-image", refs=[], size="1024x1024", skill="webpage",
                            length="long")
        body = self.image_body("kling-v4-long-image")
        self.assertEqual(body.get("skill"), "webpage")
        self.assertNotIn("length", body)   # webpage 传 length 直接 400
        self.assertNotIn("size", body)

    def test_kling_v4_long_image_webpage_with_refs_is_rejected(self):
        with self.assertRaises(main.HTTPException) as ctx:
            self.generate_image("kling-v4-long-image", size="1024x1024", skill="webpage")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("image_with_roles", str(ctx.exception.detail))

    def test_mai_image_sends_width_height_pair(self):
        # 精确像素走 width/height 成对下发，且按 MAI 口径收（1000x1000 → 992x992）
        self.generate_image("mai-image-2.7", refs=[], size="1000x1000")
        body = self.image_body("mai-image-2.7")
        self.assertEqual((body.get("width"), body.get("height")), (992, 992))
        self.assertNotIn("size", body)
        self.assertNotIn("resolution", body)
        self.assertEqual(body.get("background"), "auto")
        self.assertEqual(body.get("n"), 1)

    def test_new_fields_not_sent_to_other_models(self):
        self.generate_image("seedream-5-0-flash", refs=[], size="1024x1024")
        body = self.image_body("seedream-5-0-flash")
        for field in ("skill", "length", "background", "width", "height",
                      "sequential_image_generation", "sequential_image_generation_options"):
            self.assertNotIn(field, body)

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

    def test_generic_midjourney_uses_official_dedicated_routes(self):
        image_data, local_url = self.generate_image("midjourney")
        entries = self.requests()
        self.assertFalse([item for item in entries if item["path"] == "/v1/images/generations"], entries)
        submits = [item for item in entries if item["method"] == "POST" and item["path"] == "/v1/midjourney/generations"]
        self.assertEqual(len(submits), 1, entries)
        body = submits[0]["body"]
        self.assertEqual(body.get("prompt"), "mock")
        self.assertEqual(body.get("size"), "1:1")
        self.assertNotIn("model", body)
        self.assertNotIn("version", body)
        # 没有速度入参的入口必须落到 fast（能力表只声明 fast；空着等于上游默认 relax → code=9）
        self.assertEqual(body.get("speed"), "fast")
        urls = body.get("image_urls") or []
        self.assertEqual(len(urls), 1, urls)
        self.assertTrue(str(urls[0]).startswith("data:image/"), str(urls[0])[:48])
        queries = [item for item in entries if item["method"] == "GET" and item["path"] == "/v1/midjourney/" + TASK_MIDJOURNEY]
        self.assertGreaterEqual(len(queries), 1, entries)
        self.assertEqual(image_data.get("type"), "url")
        self.assert_local_output(local_url)

    def test_generic_midjourney_supports_version_and_hd(self):
        _image_data, local_url = self.generate_image(
            "midjourney", refs=[], midjourney_version="8.2", midjourney_hd=True)
        post = next(item for item in self.requests() if item["path"] == "/v1/midjourney/generations")
        self.assertEqual(post["body"].get("version"), "8.2")
        self.assertIs(post["body"].get("hd"), True)
        self.assert_local_output(local_url)
        with self.assertRaises(main.HTTPException) as caught:
            self.generate_image("midjourney", refs=[], midjourney_version="7", midjourney_hd=True)
        self.assertIn("仅支持 v8.1 或 v8.2", caught.exception.detail)

    def test_grok_ext_uses_quality_resolution_and_rejects_references(self):
        _image_data, local_url = self.generate_image("grok-imagine-2.0-ext", refs=[])
        entries = self.requests()
        post = next(item for item in entries if item["path"] == "/v1/images/generations")
        self.assertEqual(post["body"].get("resolution"), "quality")
        self.assertEqual(post["body"].get("size"), "1:1")
        self.assertNotIn("official_fallback", post["body"])
        self.assertEqual(post["response_version"], "2026-07-27")
        self.assertTrue(post["has_idempotency_key"])
        self.assert_local_output(local_url)
        with self.assertRaises(main.HTTPException) as caught:
            self.generate_image("grok-imagine-2.0-ext")
        self.assertIn("仅支持文生图", caught.exception.detail)

    def test_grok_official_uses_aspect_ratio_and_public_references(self):
        _image_data, local_url = self.generate_image("grok-imagine-image-2.0", quality="medium")
        entries = self.requests()
        self.assertEqual(sum(1 for item in entries if item["path"] == "/v1/uploads/images"), 1, entries)
        post = next(item for item in entries if item["path"] == "/v1/images/generations")
        self.assertEqual(post["body"].get("aspect_ratio"), "1:1")
        self.assertNotIn("size", post["body"])
        self.assertNotIn("quality", post["body"])
        self.assertTrue(post["body"]["image_urls"][0].startswith(self.base + "/"))
        self.assertEqual(post["response_version"], "2026-07-27")
        self.assertTrue(post["has_idempotency_key"])
        self.assert_local_output(local_url)

    def test_public_url_only_models_upload_references(self):
        for model in ("qwen-image-2.0", "gpt-image-2.5-flare", "hy-image-v3.5-preview"):
            with self.subTest(model=model):
                self.setUp()
                _image_data, local_url = self.generate_image(model)
                entries = self.requests()
                self.assertEqual(sum(1 for item in entries if item["path"] == "/v1/uploads/images"), 1, entries)
                post = next(item for item in entries if item["path"] == "/v1/images/generations")
                self.assertTrue(post["body"]["image_urls"][0].startswith(self.base + "/"))
                self.assert_local_output(local_url)

    def test_text_only_models_reject_references_before_submit(self):
        for model in ("imagen-4.0-apimart", "z-image-turbo"):
            with self.subTest(model=model):
                self.setUp()
                with self.assertRaises(main.HTTPException) as caught:
                    self.generate_image(model)
                self.assertIn("仅支持文生图", caught.exception.detail)
                self.assertFalse(self.requests())

    def test_z_image_omits_unsupported_n(self):
        _image_data, local_url = self.generate_image("z-image-turbo", refs=[])
        post = next(item for item in self.requests() if item["path"] == "/v1/images/generations")
        self.assertNotIn("n", post["body"])
        self.assert_local_output(local_url)

    def test_gpt25_quality_exact_size_background_and_native_n(self):
        _image_data, local_url = self.generate_image(
            "gpt-image-2.5-flare", refs=[], quality="max", size="1600x1200", background="transparent", n=3)
        post = next(item for item in self.requests() if item["path"] == "/v1/images/generations")
        body = post["body"]
        self.assertEqual(body.get("size"), "1600x1200")
        self.assertEqual(body.get("quality"), "max")
        self.assertEqual(body.get("background"), "transparent")
        self.assertEqual(body.get("output_format"), "png")
        self.assertEqual(body.get("n"), 3)
        self.assert_local_output(local_url)


    def test_gpt_image_26_flare_quality_levels(self):
        # 文档确证 flare/sunburst 支持 auto/low/medium/high/xhigh/max；auto 不发字段
        for quality, expected in (("max", "max"), ("xhigh", "xhigh"), ("high", "high")):
            with self.server.log_lock:
                self.server.requests.clear()
            _image_data, local_url = self.generate_image(
                "gpt-image-2.6-flare", refs=[], quality=quality, size="1024x1024")
            post = next(item for item in self.requests() if item["path"] == "/v1/images/generations")
            body = post["body"]
            self.assertEqual(body.get("quality"), expected, quality)
            self.assertEqual(body.get("n"), 1)
            self.assertEqual(body.get("resolution"), "1K")
            self.assert_local_output(local_url)
        # auto / 空 = 不发 quality（跟随上游默认）
        for quality in ("auto", ""):
            with self.server.log_lock:
                self.server.requests.clear()
            _image_data, local_url = self.generate_image(
                "gpt-image-2.6-flare", refs=[], quality=quality, size="1024x1024")
            post = next(item for item in self.requests() if item["path"] == "/v1/images/generations")
            self.assertNotIn("quality", post["body"], quality)
            self.assert_local_output(local_url)


    def test_model_caps_overrides_affect_generation_body(self):
        # 协议更新包的参数覆盖不只影响 /api/model-caps：生成请求体也按覆盖后的 caps 收敛
        import json as _json
        path = main.API_PROVIDERS_FILE
        with open(path, encoding="utf-8") as fh:
            original = fh.read()
        try:
            data = _json.loads(original)
            data[0]["model_caps_overrides"] = {
                "gpt-image-2.6-flare": {
                    "model": "gpt-image-2.6-flare", "kind": "image",
                    "caps": {"qualities": ["low"], "resolutions": ["2K"], "n_max": 2},
                }
            }
            with open(path, "w", encoding="utf-8") as fh:
                _json.dump(data, fh, ensure_ascii=False)
            main.invalidate_model_caps_cache()
            _image_data, local_url = self.generate_image(
                "gpt-image-2.6-flare", refs=[], quality="high", size="1024x1024", n=4)
            post = next(item for item in self.requests() if item["path"] == "/v1/images/generations")
            body = post["body"]
            self.assertNotIn("quality", body)          # 覆盖后只允许 low，high 不发
            self.assertEqual(body.get("n"), 2)         # n_max 覆盖为 2
            self.assertEqual(body.get("resolution"), "2K")  # 分辨率按覆盖收敛
            self.assert_local_output(local_url)
        finally:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(original)
            main.invalidate_model_caps_cache()

    def test_online_result_uses_one_native_multi_image_task(self):
        async def run():
            payload = main.OnlineImageRequest(
                prompt="mock", provider_id=self.provider_id, model="gpt-image-2.5-ext",
                size="1024x1024", quality="", n=3, reference_images=[])
            return await main.build_online_image_result(payload)

        result = asyncio.run(run())
        posts = [item for item in self.requests() if item["path"] == "/v1/images/generations"]
        self.assertEqual(len(posts), 1, self.requests())
        self.assertEqual(posts[0]["body"].get("n"), 3)
        self.assertEqual(posts[0]["body"].get("version"), "flare")
        self.assertTrue(result.get("images"))
        self.assertTrue(posts[0]["has_idempotency_key"])


    def _run_video(self, model, duration, ratio, resolution, watermark=False):
        async def run():
            payload = main.CanvasVideoRequest(
                prompt="mock video", provider_id=self.provider_id, model=model,
                duration=duration, aspect_ratio=ratio, resolution=resolution,
                watermark=watermark)
            return await main._canvas_video_run_unlimited(payload)
        return asyncio.run(run())


    def test_minimax_h3_max_1080p_omits_watermark(self):
        # 文档：H3-Max 1080P 不能带 watermark / aigc_watermark（连 false 都不行）
        self._run_video("minimax-h3-max", 10, "16:9", "1080p", watermark=True)
        body = next(item for item in self.requests() if item["path"] == "/v1/videos/generations")["body"]
        self.assertNotIn("watermark", body)
        self.assertNotIn("aigc_watermark", body)
        self.assertEqual(body.get("resolution"), "1080P")
        with self.server.log_lock:
            self.server.requests.clear()
        # 非 1080P / 其它模型：用户开就发 true
        self._run_video("minimax-h3-max", 10, "16:9", "768P", watermark=True)
        body = next(item for item in self.requests() if item["path"] == "/v1/videos/generations")["body"]
        self.assertIs(body.get("watermark"), True)
        self.assertNotIn("aigc_watermark", body)

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

    def test_seedance_draft_mode_request_bodies(self):
        # 文档 L46524–L46602：草稿=正常请求 + draft:true 且 resolution 强制 480p；
        # 成片只发白名单字段，继承字段（同值也 400）一个都不能带，媒体也不上传。
        async def run(payload):
            return await main._canvas_video_run_unlimited(payload)

        draft = asyncio.run(run(main.CanvasVideoRequest(
            prompt="mock draft", provider_id=self.provider_id, model="seedance-2.5",
            duration=5, aspect_ratio="16:9", resolution="", draft=True)))
        posts = [item for item in self.requests() if item["method"] == "POST"
                 and item["path"] == "/v1/videos/generations"]
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertIs(body.get("draft"), True)
        self.assertEqual(body.get("resolution"), "480p")
        self.assertEqual(body.get("model"), "seedance-2.5")
        self.assertEqual(body.get("prompt"), "mock draft")
        self.assertEqual(body.get("size"), "16:9")
        self.assertEqual(draft.get("task_id"), TASK_VIDEO)

        with self.server.log_lock:
            self.server.requests.clear()
        final = asyncio.run(run(main.CanvasVideoRequest(
            prompt="mock final", provider_id=self.provider_id, model="seedance-2.5",
            duration=9, aspect_ratio="21:9", resolution="4k", watermark=True,
            return_last_frame=True, draft_task_id=TASK_VIDEO,
            images=[{"url": "https://example.com/ref.png"}],
            videos=["https://example.com/ref.mp4"])))
        posts = [item for item in self.requests() if item["method"] == "POST"
                 and item["path"] == "/v1/videos/generations"]
        self.assertEqual(len(posts), 1, self.requests())
        final_body = posts[0]["body"]
        self.assertEqual(final_body, {
            "model": "seedance-2.5", "draft_task_id": TASK_VIDEO,
            "resolution": "4k", "return_last_frame": True, "watermark": True,
        })
        for field in main.APIMART_DRAFT_INHERITED_FIELDS:
            self.assertNotIn(field, final_body, field)
        self.assertFalse([item for item in self.requests()
                          if item["path"].startswith("/v1/uploads/")],
                         "成片不许上传草稿阶段已经用过的媒体")
        self.assertEqual(final.get("task_id"), TASK_VIDEO)

    def test_seedance_draft_local_validation(self):
        async def run(payload):
            return await main._canvas_video_run_unlimited(payload)

        # seedance-2.5-flash 明确不支持草稿（L45662）：本地 400，不把错误请求交给上游
        with self.assertRaises(main.HTTPException) as raised:
            asyncio.run(run(main.CanvasVideoRequest(
                prompt="mock flash draft", provider_id=self.provider_id,
                model="seedance-2-5-flash", draft=True)))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("不支持草稿", str(raised.exception.detail))

        # 草稿分辨率必须是 480p（传 4k 上游 400，本地先拦）
        with self.assertRaises(main.HTTPException) as raised:
            asyncio.run(run(main.CanvasVideoRequest(
                prompt="mock bad draft", provider_id=self.provider_id,
                model="seedance-2.5", draft=True, resolution="4k")))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("480p", str(raised.exception.detail))

        # draft 与 draft_task_id 互斥
        with self.assertRaises(main.HTTPException) as raised:
            asyncio.run(run(main.CanvasVideoRequest(
                prompt="mock both", provider_id=self.provider_id, model="seedance-2.5",
                draft=True, draft_task_id=TASK_VIDEO)))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("互斥", str(raised.exception.detail))

        # 成片分辨率只收 1080p/4k
        with self.assertRaises(main.HTTPException) as raised:
            asyncio.run(run(main.CanvasVideoRequest(
                prompt="mock bad final", provider_id=self.provider_id, model="seedance-2.5",
                draft_task_id=TASK_VIDEO, resolution="720p")))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("1080p", str(raised.exception.detail))
        self.assertFalse([item for item in self.requests()
                          if item["path"] == "/v1/videos/generations"],
                         "本地校验失败时不许提交上游")

    def test_first_last_frames_keep_adaptive_ratio(self):
        async def run():
            payload = main.CanvasVideoRequest(
                prompt="mock first last", provider_id=self.provider_id, model="seedance-2-5",
                duration=5, aspect_ratio="adaptive", resolution="720p",
                images=[
                    {"url": "/assets/output/ref.png", "role": "first_frame"},
                    {"url": "/assets/output/ref.png", "role": "last_frame"},
                ])
            return await main._canvas_video_run_unlimited(payload)

        asyncio.run(run())
        posts = [item for item in self.requests() if item["method"] == "POST" and item["path"] == "/v1/videos/generations"]
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertEqual(body["size"], "adaptive", body)
        self.assertNotEqual(body["size"], "1:1", body)
        self.assertEqual([item["role"] for item in body["image_with_roles"]], ["first_frame", "last_frame"])


    def test_reference_limits_follow_caps_table(self):
        """参考上限按能力表声明下发（2026-11-27）：能力表没声明时回落 9/3/3。"""
        async def run(model, image_count):
            payload = main.CanvasVideoRequest(
                prompt="mock refs", provider_id=self.provider_id, model=model,
                duration=5, aspect_ratio="16:9", resolution="720p",
                images=[{"url": "/assets/output/ref.png"} for _ in range(image_count)])
            return await main._canvas_video_run_unlimited(payload)

        def last_video_body():
            posts = [item for item in self.requests()
                     if item["method"] == "POST" and item["path"] == "/v1/videos/generations"]
            self.assertTrue(posts, self.requests())
            return posts[-1]["body"]

        # apimart-zoe 文档 30/10/10：拖 12 张就真发 12 张（不是旧行为的 9 张）
        self.assertEqual(asyncio.run(run("apimart-zoe", 12)).get("task_id"), TASK_VIDEO)
        self.assertEqual(len(last_video_body()["image_urls"]), 12)
        with self.server.log_lock:
            self.server.requests.clear()

        # magi-2 文档 10/5/5：拖 7 张发 7 张，且不超过声明的 10 张
        self.assertEqual(asyncio.run(run("magi-2", 7)).get("task_id"), TASK_VIDEO)
        self.assertEqual(len(last_video_body()["image_urls"]), 7)
        with self.server.log_lock:
            self.server.requests.clear()

        # 未声明 ref_max 的模型仍走保守值 9（seedance-1.0-pro 能力表没有这三个字段）
        self.assertEqual(asyncio.run(run("seedance-1-0-pro", 12)).get("task_id"), TASK_VIDEO)
        self.assertEqual(len(last_video_body()["image_urls"]), 9)

        # 能力表与 /api/model-caps 同源：三模型数字就是文档值
        for model, expected in (("apimart-zoe", (30, 10, 10)),
                               ("seedance-2.5", (30, 10, 10)),
                               ("magi-2", (10, 5, 5))):
            table = main.apimart_video_model_caps(model)
            self.assertEqual((table["ref_max"], table["video_ref_max"], table["audio_ref_max"]),
                             expected, model)
            caps = main.model_caps_for({"id": "apimart-mock", "protocol": "apimart",
                                        "base_url": self.base}, model, "video")
            self.assertEqual((caps["ref_max"], caps["video_ref_max"], caps["audio_ref_max"]),
                             expected, model)

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
        # 画布直发链路用 direct_image_size_caps 的口径：说明「原请求 → 实际尺寸」，不再复述档位名
        notice = result["size_notice"]
        self.assertIn("4096x4096", notice)
        self.assertIn("2048x2048", notice)
        self.assertIn("按模型规格", notice)
        # 实际发给上游的档位也跟着收敛（分辨率档 2K，不是请求的 4K）
        posts = [item for item in self.requests()
                 if item["method"] == "POST" and item["path"] == "/v1/images/generations"]
        self.assertEqual(posts[-1]["body"].get("resolution"), "2K", posts[-1]["body"])
        self.assert_local_output(result["images"][0])

        plain = main.OnlineImageRequest(provider_id=self.provider_id, model="gpt-image-2",
                                        prompt="mock no notice", size="1024x1024", n=1)
        plain_result = asyncio.run(main.build_online_image_result(plain))
        self.assertNotIn("size_notice", plain_result)


    # --- Midjourney 图生视频（虚拟视频模型 midjourney-video）---
    def _run_mj_video(self, **overrides):
        async def run(payload):
            return await main._canvas_video_run_unlimited(payload)
        fields = {"prompt": "mock mj video", "provider_id": self.provider_id,
                  "model": "midjourney-video"}
        fields.update(overrides)
        # 默认走 APIMart 原生上传（/v1/uploads/images）：临时图床在离线测试里不可用
        with mock.patch.dict(os.environ, {main.APIMART_IMAGE_SOURCE_ENV: "apimart"}):
            return asyncio.run(run(main.CanvasVideoRequest(**fields)))

    def _mj_video_posts(self):
        return [item for item in self.requests()
                if item["method"] == "POST" and item["path"] == "/v1/midjourney/generations/video"]

    def test_midjourney_video_image_urls_body(self):
        result = self._run_mj_video(
            images=[{"url": "/assets/output/ref.png", "role": "first_frame"}],
            motion="low", video_type="vid_1.1_i2v_720", mj_batch=4, animate_mode="manual")
        posts = self._mj_video_posts()
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertEqual(body["prompt"], "mock mj video")
        self.assertEqual(body["image_urls"], [self.base + "/files/uploaded.png"])
        self.assertEqual(body["motion"], "low")
        self.assertEqual(body["video_type"], "vid_1.1_i2v_720")
        self.assertEqual(body["batch_size"], 4)
        self.assertEqual(body["animate_mode"], "manual")
        # MJ 视频请求体不带 model / 通用视频字段
        for field in ("model", "duration", "size", "aspect_ratio", "resolution", "seed",
                      "watermark", "generate_audio", "end_url", "task_id", "index"):
            self.assertNotIn(field, body, field)
        self.assertTrue([item for item in self.requests() if item["path"] == "/v1/uploads/images"])
        # 提交后按 GET /v1/tasks/{id} 轮询；结果取 video_urls 全部（batch 可能 > 1）
        self.assertTrue([item for item in self.requests() if item["path"] == "/v1/tasks/" + TASK_MJ_VIDEO])
        self.assertEqual(result["task_id"], TASK_MJ_VIDEO)
        self.assertEqual(len(result["videos"]), 2, result)
        for url in result["videos"]:
            self.assert_local_output(url)
        self.assertEqual(result["mj_video"]["video_type"], "vid_1.1_i2v_720")
        self.assertEqual(result["mj_video"]["batch_size"], 4)

    def test_midjourney_video_task_id_and_animate_auto(self):
        result = self._run_mj_video(
            mj_task_id="task_imagine_mock", mj_index=2, animate_mode="auto", mj_batch=2)
        posts = self._mj_video_posts()
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertEqual(body["task_id"], "task_imagine_mock")
        self.assertEqual(body["index"], 2)
        self.assertEqual(body["animate_mode"], "auto")
        self.assertEqual(body["motion"], "high")            # 默认 high，不影响计费
        self.assertEqual(body["video_type"], "vid_1.1_i2v_480")  # 默认 480p
        self.assertEqual(body["batch_size"], 2)
        self.assertNotIn("image_urls", body)
        self.assertFalse([item for item in self.requests() if item["path"] == "/v1/uploads/images"])
        self.assertEqual(result["task_id"], TASK_MJ_VIDEO)

    def test_midjourney_video_end_url_upgrades_video_type(self):
        result = self._run_mj_video(
            images=[{"url": "/assets/output/ref.png"}],
            end_image={"url": "/assets/output/ref.png"},
            video_type="vid_1.1_i2v_720")
        body = self._mj_video_posts()[0]["body"]
        self.assertEqual(body["end_url"], self.base + "/files/uploaded.png")
        # end_url 设了自动升级 start_end_*，档位保持 720p
        self.assertEqual(body["video_type"], "vid_1.1_i2v_start_end_720")
        self.assertEqual(body["batch_size"], 1)
        self.assertEqual(result["mj_video"]["tier"], "720p")

    def test_midjourney_video_local_validation(self):
        async def run(**fields):
            payload = main.CanvasVideoRequest(prompt="mock mj video", provider_id=self.provider_id,
                                              model="midjourney-video", **fields)
            return await main._canvas_video_run_unlimited(payload)

        cases = [
            ({}, "首帧图"),
            ({"images": [{"url": "/assets/output/ref.png"}], "mj_task_id": "task_x"}, "互斥"),
            ({"mj_task_id": "task_x", "animate_mode": "auto"}, "animate_mode=auto"),
            ({"images": [{"url": "/assets/output/ref.png"}], "video_type": "vid_9.9"}, "video_type"),
            ({"images": [{"url": "/assets/output/ref.png"}], "mj_batch": 3}, "mj_batch"),
            ({"images": [{"url": "/assets/output/ref.png"}], "motion": "medium"}, "motion"),
            ({"images": [{"url": "/assets/output/ref.png"}], "mode": "text_to_video"}, "image_to_video"),
            ({"images": [{"url": "/assets/output/ref.png"}, {"url": "/assets/output/ref.png"}]}, "1 张首帧图"),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                with self.assertRaises(main.HTTPException) as raised:
                    asyncio.run(run(**fields))
                self.assertEqual(raised.exception.status_code, 400)
                self.assertIn(expected, str(raised.exception.detail))
        # 本地校验失败不提交上游、不上传媒体
        self.assertEqual(self._mj_video_posts(), [], self.requests())
        self.assertFalse([item for item in self.requests() if item["path"] == "/v1/uploads/images"])

    def test_midjourney_video_fields_never_reach_other_models(self):
        async def run():
            payload = main.CanvasVideoRequest(
                prompt="mock seedance", provider_id=self.provider_id, model="seedance-2.0",
                duration=5, aspect_ratio="16:9", resolution="720p",
                motion="low", video_type="vid_1.1_i2v_720", mj_batch=4,
                mj_task_id="task_imagine_mock", mj_index=1, animate_mode="auto",
                end_image={"url": "/assets/output/ref.png"},
                images=[{"url": "/assets/output/ref.png"}])
            return await main._canvas_video_run_unlimited(payload)

        asyncio.run(run())
        posts = [item for item in self.requests()
                 if item["method"] == "POST" and item["path"] == "/v1/videos/generations"]
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        for field in ("motion", "video_type", "mj_batch", "batch_size", "mj_task_id", "mj_index",
                      "animate_mode", "end_url", "end_image"):
            self.assertNotIn(field, body, field)
        self.assertEqual(self._mj_video_posts(), [], "别的模型不能走 MJ 视频端点")

    def test_magi_2_submission_body(self):
        """magi-2（文档 2026-11-26 L40642–L40910）：固定 1080p / duration 4–30 / 声音默认开 /
        nsfw 默认不发、显式开才发 / edit-extend 本地 400。"""

        async def run(duration=5, ratio="16:9", resolution="1080p", model="magi-2", **extra):
            payload = main.CanvasVideoRequest(
                prompt="mock magi", provider_id=self.provider_id, model=model,
                duration=duration, aspect_ratio=ratio, resolution=resolution, **extra)
            return await main._canvas_video_run_unlimited(payload)

        def last_body():
            posts = [item for item in self.requests()
                     if item["method"] == "POST" and item["path"] == "/v1/videos/generations"]
            self.assertEqual(len(posts), 1, self.requests())
            return posts[0]["body"]

        asyncio.run(run(duration=10, ratio="9:16"))
        body = last_body()
        self.assertEqual(body["model"], "magi-2")
        self.assertEqual(body["duration"], 10)
        self.assertEqual(body["resolution"], "1080p")
        self.assertEqual(body["aspect_ratio"], "9:16")
        # 上游默认 true：用户没开声音时显式发 false（关掉要能关），开了发 true
        self.assertIs(body["generate_audio"], False)
        self.assertNotIn("nsfw_check", body, "默认不发 nsfw_check")
        self.assertNotIn("watermark", body)

        # 4–30 越界：本地收敛（45→30、1→4），不把非法时长发上游
        with self.server.log_lock:
            self.server.requests.clear()
        asyncio.run(run(duration=45))
        self.assertEqual(last_body()["duration"], 30)

        with self.server.log_lock:
            self.server.requests.clear()
        asyncio.run(run(duration=1))
        self.assertEqual(last_body()["duration"], 4)

        with self.server.log_lock:
            self.server.requests.clear()
        asyncio.run(run(duration=8, generate_audio=True))
        self.assertIs(last_body()["generate_audio"], True)

        # nsfw_check：只有用户显式开启才发 true
        with self.server.log_lock:
            self.server.requests.clear()
        asyncio.run(run(duration=5, nsfw_check=True))
        self.assertIs(last_body()["nsfw_check"], True)

        # edit/extend：上游一律 400（L40891）→ 本地先拦，绝不提交
        with self.server.log_lock:
            self.server.requests.clear()
        for mode in ("video_edit", "video_extend"):
            with self.assertRaises(main.HTTPException) as raised:
                asyncio.run(run(duration=5, mode=mode, videos=["https://example.com/ref.mp4"]))
            self.assertEqual(raised.exception.status_code, 400)
            self.assertIn("不支持视频编辑", str(raised.exception.detail))
        self.assertFalse([item for item in self.requests()
                          if item["path"] == "/v1/videos/generations"], "本地拦截后不许提交上游")

        # 别的模型不出现该字段（同一参数发过去直接忽略）
        with self.server.log_lock:
            self.server.requests.clear()
        asyncio.run(run(duration=5, model="seedance-2.5", nsfw_check=True))
        self.assertNotIn("nsfw_check", last_body())


if __name__ == "__main__":
    unittest.main()
