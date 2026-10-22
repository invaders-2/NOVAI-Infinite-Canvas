"""APIMart image_urls 发送前校验（复现 v1.0.134 Windows 报错）。

上游原文：
  {"error":{"code":"invalid_request_error",
            "message":"Invalid format for image_urls[0]. Only http/https URL or data:image base64 are supported."}}

image_urls 只认公网 http(s) 与 image base64 data URI。这里断言 v1.0.134 可能出现的三类非法输入：
  1. 本地画布路径 /assets/...（Windows 上 output_file_from_url 没解析到文件时被原样传出）；
  2. data:application/octet-stream（未知扩展名走了 content_type_for_path 的兜底 mime）；
  3. asset:// 私域素材地址（upload_image_for_apimart 原样返回）。
修复目标：能在本地转 JPEG 的转成 data:image/jpeg 再发；转不出来本地 400、不发请求。
"""
import asyncio
import base64
import json
import os
import shutil
import struct
import tempfile
import threading
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

from unittest import mock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

TASK_IMAGE = "task_sanitize_img"
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32

UPSTREAM_MESSAGE = ("Invalid format for image_urls[%d]. "
                    "Only http/https URL or data:image base64 are supported.")


def _png_8x8():
    width = height = 8
    raw = b"".join(b"\x00" + bytes([255, 64, 64, 255]) * width for _ in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def image_urls_format_error(urls):
    """按上游口径检查 image_urls；合法返回 None，否则返回与上游一致的 400 body。"""
    for index, url in enumerate(urls or []):
        text = str(url or "")
        if text.startswith(("http://", "https://")) or text.startswith("data:image/"):
            continue
        return {"error": {"code": "invalid_request_error", "message": UPSTREAM_MESSAGE % index}}
    return None


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
        if path == "/v1/images/generations":
            error = image_urls_format_error(((entry or {}).get("image_urls") or []))
            if error is not None:
                self._send(400, error)
                return
            self._send(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_IMAGE}]})
        else:
            self._send(404, {"error": "no such mock route", "path": path})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self._record(b"")
        base = self._base()
        if path == "/files/out.png":
            self._send(200, raw=_png_8x8(), content_type="image/png")
        elif path == "/v1/tasks/" + TASK_IMAGE:
            self._send(200, {"code": 200, "data": {"id": TASK_IMAGE, "status": "completed", "progress": 100,
                                                   "result": {"images": [{"url": [base + "/files/out.png"],
                                                                          "expires_at": 1893456000}]}}})
        else:
            self._send(404, {"error": "no such mock route", "path": path})


class ApimartImageUrlSanitizeTests(unittest.TestCase):
    provider_id = "apimart-sanitize"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-apimart-sanitize-")
        cls.assets = os.path.join(cls.tmp, "assets")
        cls.output_dir = os.path.join(cls.assets, "output")
        os.makedirs(cls.output_dir, exist_ok=True)
        with open(os.path.join(cls.output_dir, "ref.png"), "wb") as f:
            f.write(_png_8x8())

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
                "image_models": ["gpt-image-2"],
                "chat_models": [],
                "video_models": [],
                "audio_models": [],
            }], f)

        cls.saved = {
            "API_PROVIDERS_FILE": main.API_PROVIDERS_FILE,
            "ASSETS_DIR": main.ASSETS_DIR,
            "OUTPUT_INPUT_DIR": main.OUTPUT_INPUT_DIR,
            "OUTPUT_OUTPUT_DIR": main.OUTPUT_OUTPUT_DIR,
            "APIMART_IMAGE_INITIAL_POLL_DELAY": main.APIMART_IMAGE_INITIAL_POLL_DELAY,
            "APIMART_IMAGE_POLL_INTERVAL": main.APIMART_IMAGE_POLL_INTERVAL,
            "HISTORY_FILE": main.HISTORY_FILE,
        }
        main.API_PROVIDERS_FILE = provider_file
        main.ASSETS_DIR = cls.assets
        main.OUTPUT_INPUT_DIR = os.path.join(cls.assets, "input")
        main.OUTPUT_OUTPUT_DIR = cls.output_dir
        main.APIMART_IMAGE_INITIAL_POLL_DELAY = 0.05
        main.APIMART_IMAGE_POLL_INTERVAL = 0.05
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
        with self.server.log_lock:
            self.server.requests.clear()

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def generation_posts(self):
        return [item for item in self.requests()
                if item["method"] == "POST" and item["path"] == "/v1/images/generations"]

    def generate_image(self, refs):
        async def run():
            image_data, _raw = await main._generate_ai_image_unlimited(
                prompt="mock", size="1024x1024", quality="", model="gpt-image-2",
                reference_images=refs, provider_id=self.provider_id)
            return image_data, await main.save_ai_image_to_output(image_data, prefix="sanitize_")
        return asyncio.run(run())

    def octet_stream_png(self):
        return "data:application/octet-stream;base64," + base64.b64encode(_png_8x8()).decode("ascii")

    # --- sanitize_apimart_image_urls 单元口径 ---

    def test_valid_http_and_image_data_urls_pass_through(self):
        values = ["http://example.com/a.png", "https://example.com/b.jpg",
                  "data:image/png;base64," + base64.b64encode(_png_8x8()).decode("ascii")]
        result = main.sanitize_apimart_image_urls(values, [{"url": "/assets/output/ghost.png"}] * len(values))
        self.assertEqual(result, values)
        self.assertIsNone(image_urls_format_error(result))

    def test_local_path_with_existing_file_becomes_jpeg(self):
        result = main.sanitize_apimart_image_urls(
            ["/assets/output/ref.png"], [{"url": "/assets/output/ref.png"}])
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].startswith("data:image/jpeg;base64,"), result[0][:48])
        self.assertIsNone(image_urls_format_error(result))

    def test_octet_stream_data_url_becomes_jpeg(self):
        result = main.sanitize_apimart_image_urls([self.octet_stream_png()], [])
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].startswith("data:image/jpeg;base64,"), result[0][:48])
        self.assertNotIn("application/octet-stream", result[0])
        self.assertIsNone(image_urls_format_error(result))

    def test_local_path_is_repaired_from_ref_file(self):
        # Windows 上 /assets/... 解析不到文件时，image_urls 里可能是失效路径，但 refs 仍指向可读原图
        result = main.sanitize_apimart_image_urls(
            ["/assets/output/ghost.png"], [{"url": "/assets/output/ref.png"}])
        self.assertTrue(result[0].startswith("data:image/jpeg;base64,"), result[0][:48])

    def test_asset_scheme_is_rejected(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.sanitize_apimart_image_urls(["asset://abc123"], [{"url": "asset://abc123"}])
        detail = caught.exception.detail
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("第 1 张参考图", detail)
        self.assertIn("asset://abc123", detail)
        self.assertIn("格式不支持或文件不存在", detail)
        self.assertIn("JPG/PNG", detail)

    def test_missing_local_file_is_rejected_with_correct_index(self):
        values = ["https://example.com/ok.png", "/assets/output/ghost.png"]
        with self.assertRaises(main.HTTPException) as caught:
            main.sanitize_apimart_image_urls(values, [{"url": values[0]}, {"url": values[1]}])
        self.assertIn("第 2 张参考图", caught.exception.detail)
        self.assertIn("/assets/output/ghost.png", caught.exception.detail)

    def test_undecodable_octet_stream_is_rejected(self):
        bad = "data:application/octet-stream;base64," + base64.b64encode(b"not an image").decode("ascii")
        with self.assertRaises(main.HTTPException) as caught:
            main.sanitize_apimart_image_urls([bad], [])
        self.assertIn("第 1 张参考图", caught.exception.detail)
        self.assertIn("application/octet-stream;base64,...", caught.exception.detail)
        self.assertNotIn(base64.b64encode(b"not an image").decode("ascii"), caught.exception.detail)

    def test_empty_value_is_rejected(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.sanitize_apimart_image_urls([""], [])
        self.assertIn("空地址", caught.exception.detail)

    # --- 真实生成链路：非法值必须在 client.post 之前被修好/拦下 ---

    def test_generation_fixes_local_path_before_upstream(self):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"}]
        with mock.patch.object(main, "reference_to_data_url",
                               lambda ref, max_size=None: "/assets/output/ref.png"):
            image_data, _local = self.generate_image(refs)
        self.assertEqual(image_data.get("type"), "url")
        posts = self.generation_posts()
        self.assertEqual(len(posts), 1, self.requests())
        urls = posts[0]["body"].get("image_urls") or []
        self.assertEqual(len(urls), 1, urls)
        self.assertTrue(urls[0].startswith("data:image/jpeg;base64,"), urls[0][:48])
        self.assertIsNone(image_urls_format_error(urls))

    def test_generation_fixes_octet_stream_before_upstream(self):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"}]
        bad = self.octet_stream_png()
        with mock.patch.object(main, "reference_to_data_url",
                               lambda ref, max_size=None: bad):
            image_data, _local = self.generate_image(refs)
        self.assertEqual(image_data.get("type"), "url")
        urls = self.generation_posts()[0]["body"].get("image_urls") or []
        self.assertEqual(len(urls), 1, urls)
        self.assertTrue(urls[0].startswith("data:image/jpeg;base64,"), urls[0][:48])
        self.assertIsNone(image_urls_format_error(urls))

    def test_generation_rejects_asset_scheme_without_calling_upstream(self):
        with self.assertRaises(main.HTTPException) as caught:
            self.generate_image([{"url": "asset://abc123", "kind": "image"}])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("第 1 张参考图", caught.exception.detail)
        self.assertIn("格式不支持或文件不存在", caught.exception.detail)
        self.assertEqual(self.generation_posts(), [], "非法参考图不应该发出生成请求")

    def test_generation_rejects_missing_file_without_calling_upstream(self):
        with self.assertRaises(main.HTTPException) as caught:
            self.generate_image([{"url": "/assets/output/ghost.png", "kind": "image"}])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("第 1 张参考图", caught.exception.detail)
        self.assertEqual(self.generation_posts(), [], "文件不存在时不应该发出生成请求")

    def test_mock_upstream_really_rejects_the_windows_error_inputs(self):
        for bad in (["/assets/output/ref.png"], [self.octet_stream_png()], ["asset://abc123"]):
            error = image_urls_format_error(bad)
            self.assertIsNotNone(error, bad)
            self.assertEqual(error["error"]["code"], "invalid_request_error")
            self.assertEqual(error["error"]["message"],
                             "Invalid format for image_urls[0]. Only http/https URL or data:image base64 are supported.")

    def test_without_sanitize_the_mock_upstream_returns_the_reported_400(self):
        refs = [{"url": "/assets/output/ref.png", "kind": "image"}]
        with mock.patch.object(main, "reference_to_data_url",
                               lambda ref, max_size=None: "/assets/output/ref.png"), \
                mock.patch.object(main, "sanitize_apimart_image_urls", lambda urls, refs=None: list(urls)):
            with self.assertRaises(httpx.HTTPStatusError) as caught:
                self.generate_image(refs)
        self.assertEqual(caught.exception.response.status_code, 400)
        self.assertIn("Invalid format for image_urls[0]", caught.exception.response.text)
        posts = self.generation_posts()
        self.assertEqual(len(posts), 1, self.requests())
        self.assertEqual((posts[0]["body"].get("image_urls") or [""])[0], "/assets/output/ref.png")

    def test_legit_reference_still_generates(self):
        image_data, local_url = self.generate_image([{"url": "/assets/output/ref.png", "kind": "image"}])
        self.assertEqual(image_data.get("type"), "url")
        posts = self.generation_posts()
        self.assertEqual(len(posts), 1, self.requests())
        urls = posts[0]["body"].get("image_urls") or []
        self.assertTrue(urls[0].startswith("data:image/"), urls[0][:48])
        self.assertIsNone(image_urls_format_error(urls))
        self.assertTrue(local_url.startswith("/assets/output/"), local_url)


class ReferenceDataUrlMimeTests(unittest.TestCase):
    """reference_to_data_url 的兜底 mime 不能再产出 data:application/octet-stream。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="novai-ref-mime-")
        cls.assets = os.path.join(cls.tmp, "assets")
        os.makedirs(cls.assets, exist_ok=True)
        with open(os.path.join(cls.assets, "weird.heic"), "wb") as f:
            f.write(_png_8x8())
        with open(os.path.join(cls.assets, "broken.heic"), "wb") as f:
            f.write(b"not an image")
        with open(os.path.join(cls.assets, "normal.png"), "wb") as f:
            f.write(_png_8x8())
        with open(os.path.join(cls.assets, "clip.mp4"), "wb") as f:
            f.write(MP4_BYTES)
        cls.saved_assets = main.ASSETS_DIR
        main.ASSETS_DIR = cls.assets

    @classmethod
    def tearDownClass(cls):
        main.ASSETS_DIR = cls.saved_assets
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_unknown_extension_with_image_bytes_becomes_jpeg(self):
        url = main.reference_to_data_url({"url": "/assets/weird.heic"})
        self.assertTrue(url.startswith("data:image/jpeg;base64,"), url[:48])
        self.assertNotIn("application/octet-stream", url)

    def test_unknown_extension_with_garbage_returns_empty(self):
        self.assertEqual(main.reference_to_data_url({"url": "/assets/broken.heic"}), "")

    def test_known_image_extension_still_raw_base64(self):
        url = main.reference_to_data_url({"url": "/assets/normal.png"})
        self.assertTrue(url.startswith("data:image/png;base64,"), url[:48])

    def test_video_mime_is_preserved_for_canvas_llm(self):
        url = main.reference_to_data_url({"url": "/assets/clip.mp4"})
        self.assertTrue(url.startswith("data:video/mp4;base64,"), url[:48])


if __name__ == "__main__":
    unittest.main()
