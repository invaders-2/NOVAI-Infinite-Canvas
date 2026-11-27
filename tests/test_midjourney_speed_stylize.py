"""Midjourney 画布生成一直失败：speed / stylize 下发 + 按 APIMart 文档重试。

现场报错：upstream code=9: upstream submit failure: RELAX@569fdb...: upstream submit failure
根因：画布从来没把「速度」发给上游 → apimart 默认 speed=relax → 任务进 RELAX 通道提交失败。

这里用本地假上游（不连真网、不花钱）断言四件事：
  1. speed / stylize 真的进了 body，没传时两个字段都不出现；
  2. 提交阶段 body code=9（HTTP 200）会自动重试，第二次拿到 task_id 就成功；
  3. 提交阶段 code=24（敏感词）不重试，抛的是中文文案；
  4. 轮询到 FAILURE：code=9 重新提交并最终成功，code=24 不重试。
"""
import asyncio
import inspect
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

SUBMIT_PATH = "/v1/midjourney/generations"
TASK_OK_1 = "task_mj_ok_1"
TASK_OK_2 = "task_mj_ok_2"
TASK_BAD = "task_mj_bad"


def submitted(task_id):
    return {"code": 200, "data": [{"status": "submitted", "task_id": task_id}]}


def task_failed(text, code=None):
    payload = {"data": {"status": "FAILURE", "fail_reason": text}}
    if code is not None:
        payload["code"] = code
    return payload


def task_succeeded(task_id, *urls, grid=""):
    data = {"id": task_id, "status": "SUCCESS", "image_urls": list(urls)}
    if grid:
        data["grid_image_url"] = grid
    return {"code": 200, "data": data}


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

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _record(self):
        body = self._read_body()
        content_type = str(self.headers.get("Content-Type") or "")
        if "json" in content_type.lower() and body:
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                parsed = {"raw": body.decode("utf-8", "replace")[:500]}
        else:
            parsed = None
        entry = {"method": self.command, "path": self.path.split("?", 1)[0], "body": parsed}
        with self.server.log_lock:
            self.server.requests.append(entry)
        return entry

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        self._record()
        if path != SUBMIT_PATH:
            self._send(404, {"error": "no such mock route", "path": path})
            return
        with self.server.log_lock:
            queued = self.server.submit_queue.pop(0) if self.server.submit_queue else None
        if queued is None:
            self._send(200, submitted(TASK_OK_1))
            return
        self._send(queued[0], queued[1])

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self._record()
        if path.startswith("/files/") and path.endswith(".png"):
            data = _png_8x8()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if not path.startswith("/v1/midjourney/"):
            self._send(404, {"error": "no such mock route", "path": path})
            return
        task_id = path.rsplit("/", 1)[-1]
        with self.server.log_lock:
            plan = self.server.task_plan.get(task_id)
            if plan and len(plan) > 1:
                payload = plan.pop(0)
            else:
                payload = plan[0] if plan else {"code": 200, "data": {"id": task_id, "status": "SUBMITTED"}}
        self._send(200, payload)


class MidjourneySpeedStylizeTests(unittest.TestCase):
    provider_id = "apimart-mj"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.server.submit_queue = []
        cls.server.task_plan = {}
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-mj-speed-")
        cls.assets = os.path.join(cls.tmp, "assets")
        os.makedirs(os.path.join(cls.assets, "output"), exist_ok=True)

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
                "image_models": ["midjourney"],
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
            "APIMART_IMAGE_TASK_TIMEOUT": main.APIMART_IMAGE_TASK_TIMEOUT,
            "HISTORY_FILE": main.HISTORY_FILE,
        }
        main.API_PROVIDERS_FILE = provider_file
        main.ASSETS_DIR = cls.assets
        main.OUTPUT_INPUT_DIR = os.path.join(cls.assets, "input")
        main.OUTPUT_OUTPUT_DIR = os.path.join(cls.assets, "output")
        main.APIMART_IMAGE_INITIAL_POLL_DELAY = 0.01
        main.APIMART_IMAGE_POLL_INTERVAL = 0.01
        main.APIMART_IMAGE_TASK_TIMEOUT = 20.0
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
        main._APIMART_UPLOAD_CACHE.clear()
        with self.server.log_lock:
            self.server.requests.clear()
            self.server.submit_queue.clear()
            self.server.task_plan.clear()

    # --- mock 编排 ---

    def queue_submit(self, *responses):
        with self.server.log_lock:
            self.server.submit_queue.extend(responses)

    def plan_task(self, task_id, *responses):
        with self.server.log_lock:
            self.server.task_plan[task_id] = list(responses)

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def submit_posts(self):
        return [item for item in self.requests()
                if item["method"] == "POST" and item["path"] == SUBMIT_PATH]

    def build_result(self, n=1, speed="fast"):
        """走真实入口 build_online_image_result：caps 拆批 + 提取 + 本地落盘都算进来。"""
        payload = main.OnlineImageRequest(
            prompt="a red fox in snow", provider_id=self.provider_id, model="midjourney",
            size="1024x1024", n=n, midjourney_speed=speed)
        with mock.patch.object(main, "save_to_history", lambda *a, **k: None), \
                mock.patch.object(main, "GLOBAL_LOOP", None):
            return asyncio.run(main.build_online_image_result(payload))

    def generate_via_provider_layer(self, speed="", stylize=0, version="", hd=False):
        provider = main.get_api_provider(self.provider_id)

        async def run():
            return await main.generate_apimart_midjourney_provider_image(
                "a red fox in snow", "1024x1024", [], provider, version, hd, speed, stylize)
        return asyncio.run(run())

    def generate(self, speed="", stylize=0, prompt="a red fox in snow", size="1024x1024"):
        async def run():
            return await main._generate_ai_image_unlimited(
                prompt=prompt, size=size, quality="", model="midjourney",
                reference_images=[], provider_id=self.provider_id,
                midjourney_speed=speed, midjourney_stylize=stylize)
        return asyncio.run(run())

    # --- 1. speed / stylize 真的下发 ---

    def test_body_carries_speed_and_stylize(self):
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        image_data, _raw = self.generate(speed="fast", stylize=750)
        self.assertEqual(image_data.get("type"), "url")
        self.assertEqual(image_data.get("value"), self.base + "/files/mj.png")
        posts = self.submit_posts()
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertEqual(body.get("speed"), "fast", body)
        self.assertEqual(body.get("stylize"), 750, body)
        self.assertEqual(body.get("size"), "1:1", body)

    def test_agent_path_defaults_speed_to_fast(self):
        """没有前端面板的入口（助手生图工具链）不传速度时也要落到 fast，不能退回上游默认 relax。"""
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate()
        body = self.submit_posts()[0]["body"]
        self.assertEqual(body.get("speed"), "fast", body)
        self.assertNotIn("stylize", body, body)

    def test_agent_path_keeps_explicit_speed(self):
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate(speed="relax")
        self.assertEqual(self.submit_posts()[0]["body"].get("speed"), "relax")

    def test_provider_layer_omits_speed_when_empty(self):
        """provider 层保持「传空就不发」：老画布 / 直接调用方的显式行为不能被默认值改掉。"""
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        image_data = self.generate_via_provider_layer(speed="")
        self.assertEqual(image_data[0].get("value"), self.base + "/files/mj.png")
        body = self.submit_posts()[0]["body"]
        self.assertNotIn("speed", body, body)
        self.assertNotIn("stylize", body, body)

    # --- 成功码：官方码表是 1 / 200 ---

    def test_body_code_1_is_success(self):
        self.queue_submit((200, {"code": 1, "data": [{"task_id": TASK_OK_1, "status": "submitted"}]}))
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        image_data, _raw = self.generate()
        self.assertEqual(image_data.get("value"), self.base + "/files/mj.png")
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_body_code_200_is_success(self):
        self.queue_submit((200, {"code": 200, "data": [{"task_id": TASK_OK_1, "status": "submitted"}]}))
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        image_data, _raw = self.generate()
        self.assertEqual(image_data.get("value"), self.base + "/files/mj.png")
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_unknown_speed_and_out_of_range_stylize_are_ignored(self):
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate(speed="warp-9", stylize=99999)
        body = self.submit_posts()[0]["body"]
        self.assertNotIn("speed", body, body)
        self.assertNotIn("stylize", body, body)

    def test_online_request_forwards_speed_and_stylize(self):
        """前端发的是 OnlineImageRequest 的字段：这里确认它们真的被透传到生图调用上。"""
        payload = main.OnlineImageRequest(
            prompt="a red fox in snow", provider_id=self.provider_id, model="midjourney",
            size="1024x1024", midjourney_speed="fast", midjourney_stylize=750)
        captured = {}

        async def fake_generate(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            raise RuntimeError("stop-after-capture")

        with mock.patch.object(main, "generate_ai_image", new=fake_generate):
            with self.assertRaises(RuntimeError):
                asyncio.run(main.build_online_image_result(payload))
        # 按形参名断言，不依赖位置：generate_ai_image 的形参顺序会随功能演进（本轮尾部加了
        # skill / length / series_images，旧断言 args[-2]/args[-1] 会错位到 length/series_images）
        bound = inspect.signature(main.generate_ai_image).bind(*captured["args"], **captured["kwargs"])
        self.assertEqual(bound.arguments["midjourney_speed"], "fast", bound.arguments)
        self.assertEqual(bound.arguments["midjourney_stylize"], 750, bound.arguments)

    # --- 张数：上游一次出 4 张候选，画布取前 N 张，只提交 1 次 ---

    def test_count_four_takes_four_images_from_one_submit(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls))
        result = self.build_result(n=4)
        images = result.get("images") or []
        self.assertEqual(len(images), 4, images)
        for url in images:
            self.assertTrue(str(url).startswith("/assets/output/"), url)
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_count_two_takes_two_images(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls))
        result = self.build_result(n=2)
        self.assertEqual(len(result.get("images") or []), 2, result.get("images"))
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_count_one_takes_one_image(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls))
        result = self.build_result(n=1)
        self.assertEqual(len(result.get("images") or []), 1, result.get("images"))
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    # --- 四宫格：候选之后追加一张，免费赠品，不多发请求也不多扣费 ---

    def test_grid_image_is_appended_after_candidates(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls, grid=self.base + "/files/grid.png"))
        result = self.build_result(n=4)
        images = result.get("images") or []
        items = result.get("image_items") or []
        self.assertEqual(len(images), 5, images)          # 4 张候选 + 1 张四宫格
        self.assertEqual(len(items), 5, items)
        self.assertEqual(sum(1 for item in items if item.get("mj_grid") is True), 1, items)
        self.assertTrue(items[-1].get("mj_grid"), items[-1])
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_grid_appends_to_one_candidate(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls, grid=self.base + "/files/grid.png"))
        result = self.build_result(n=1)
        self.assertEqual(len(result.get("images") or []), 2, result.get("images"))   # 1 候选 + 四宫格
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_grid_appends_to_two_candidates(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls, grid=self.base + "/files/grid.png"))
        result = self.build_result(n=2)
        self.assertEqual(len(result.get("images") or []), 3, result.get("images"))   # 2 候选 + 四宫格
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_no_grid_url_returns_candidates_only(self):
        urls = ["%s/files/mj%d.png" % (self.base, index) for index in range(1, 5)]
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, *urls))
        result = self.build_result(n=4)
        self.assertEqual(len(result.get("images") or []), 4, result.get("images"))
        self.assertFalse(any(item.get("mj_grid") for item in result.get("image_items") or []))
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_grid_does_not_change_pricing(self):
        """四宫格是上游附带的赠品：按候选张数计费，不因为多一张就涨。"""
        from server.credits import pricing as credits_pricing
        quote = credits_pricing.estimate("image", "midjourney", {"rows": 4})
        self.assertAlmostEqual(quote["cost_usd"], 0.04504, places=6)
        self.assertAlmostEqual(quote["price"], 0.59, places=4)

    def test_caps_declare_four_candidates_and_three_speeds(self):
        caps = main.APIMART_IMAGE_MODEL_CAPS["midjourney"]
        self.assertEqual(caps.get("n_max"), 4, caps)
        # 有 batch 会把画布默认张数顶成 batch[0]（=4）；n_max 才是「一次最多几张候选」
        self.assertNotIn("batch", caps, caps)
        self.assertEqual(caps["mj"]["speeds"], ["fast", "turbo", "relax"])
        provider = main.get_api_provider(self.provider_id)
        # /api/model-caps 真正下发的那份（_caps_payload 组装后）：n_max 在、batch 不在
        served = main.model_caps_for(provider, "midjourney", "image") or {}
        self.assertEqual(served.get("n_max"), 4, served)
        self.assertNotIn("batch", served, served)
        self.assertEqual(served["mj"]["speeds"], ["fast", "turbo", "relax"], served)
        self.assertEqual(main.direct_image_request_batches(provider, "midjourney", 4), [4])
        self.assertEqual(main.direct_image_request_batches(provider, "midjourney", 2), [2])
        self.assertEqual(main.direct_image_request_batches(provider, "midjourney", 1), [1])

    # --- 提示词里的 MJ 参数不能进上游 body ---

    def test_prompt_params_do_not_reach_upstream_body(self):
        """真机根因回归：提示词尾部的 -ar 16:9 / --v 6.0 会被上游当非法参数拒单（code=9）。"""
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate(speed="fast", prompt="a red fox in snow --ar 16:9 --v 6.0", size="1024x1024")
        body = self.submit_posts()[0]["body"]
        for token in ("--ar", "-ar", "--v", "-v", "16:9", "6.0"):
            self.assertNotIn(token, body["prompt"], body["prompt"])
        self.assertIn("a red fox in snow", body["prompt"])
        # 请求显式给了比例 → 请求优先，--ar 不覆盖；6.0 不在接口白名单，不拿非法版本去撞 400
        self.assertEqual(body.get("size"), "1:1")
        self.assertNotIn("version", body)

    def test_prompt_ar_maps_to_body_when_request_has_no_explicit_size(self):
        """请求没给像素/比例（auto / 自适应）时，提示词里的 --ar 才兜底到 body.size。"""
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate(speed="fast", prompt="a red fox in snow --ar 16:9", size="auto")
        body = self.submit_posts()[0]["body"]
        self.assertEqual(body.get("size"), "16:9")
        self.assertNotIn("--ar", body["prompt"])

    def test_prompt_version_and_stylize_map_when_body_missing(self):
        self.plan_task(TASK_OK_1, task_succeeded(TASK_OK_1, self.base + "/files/mj.png"))
        self.generate(speed="fast", prompt="a fox --v 7 --s 750")
        body = self.submit_posts()[0]["body"]
        self.assertEqual(body.get("version"), "7")
        self.assertEqual(body.get("stylize"), 750)

    # --- 2. 提交阶段 code=9 自动重试 ---

    def test_submit_business_code_9_retries_then_succeeds(self):
        self.queue_submit((200, {"code": 9, "description": "upstream submit failure: RELAX@569fdb"}))
        self.queue_submit((200, submitted(TASK_OK_2)))
        self.plan_task(TASK_OK_2, task_succeeded(TASK_OK_2, self.base + "/files/mj2.png"))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            image_data, _raw = self.generate(speed="fast")
        self.assertEqual(image_data.get("value"), self.base + "/files/mj2.png")
        self.assertEqual(len(self.submit_posts()), 2, self.requests())

    def test_submit_http_500_retries_then_succeeds(self):
        self.queue_submit((500, {"message": "bad gateway"}))
        self.queue_submit((200, submitted(TASK_OK_2)))
        self.plan_task(TASK_OK_2, task_succeeded(TASK_OK_2, self.base + "/files/mj2.png"))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            image_data, _raw = self.generate()
        self.assertEqual(image_data.get("value"), self.base + "/files/mj2.png")
        self.assertEqual(len(self.submit_posts()), 2, self.requests())

    # --- 3. 提交阶段 code=24 不重试 ---

    def test_submit_business_code_24_is_not_retried_and_says_content_review(self):
        self.queue_submit((200, {"code": 24, "description": "banned prompt: content safety"}))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            with self.assertRaises(main.HTTPException) as caught:
                self.generate()
        detail = caught.exception.detail
        self.assertEqual(caught.exception.status_code, 502, detail)
        self.assertIn("内容审核", detail)
        self.assertIn("banned prompt", detail)
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_submit_code_4_is_not_retried(self):
        self.queue_submit((200, {"code": 4, "description": "无法识别的参数: --ar"}))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            with self.assertRaises(main.HTTPException) as caught:
                self.generate()
        self.assertIn("上游不认的参数", caught.exception.detail)
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    # --- 4. 轮询 FAILURE 后的重新提交 ---

    def test_task_failure_code_9_resubmits_and_finally_succeeds(self):
        self.plan_task(TASK_BAD, task_failed("upstream code=9: upstream submit failure: RELAX@569fdb: upstream submit failure"))
        self.queue_submit((200, submitted(TASK_BAD)))
        self.queue_submit((200, submitted(TASK_OK_2)))
        self.plan_task(TASK_OK_2, task_succeeded(TASK_OK_2, self.base + "/files/mj2.png"))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            image_data, _raw = self.generate(speed="fast")
        self.assertEqual(image_data.get("value"), self.base + "/files/mj2.png")
        self.assertEqual(len(self.submit_posts()), 2, self.requests())

    def test_task_failure_code_24_is_not_retried(self):
        self.plan_task(TASK_BAD, task_failed("banned prompt: content safety", code=24))
        self.queue_submit((200, submitted(TASK_BAD)))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            with self.assertRaises(main.HTTPException) as caught:
                self.generate()
        self.assertIn("内容审核", caught.exception.detail)
        self.assertEqual(len(self.submit_posts()), 1, self.requests())

    def test_task_failure_code_9_finally_reports_chinese_message(self):
        # 5 次尝试全部失败：文案里的重试次数是参数化的（attempts-1 = 4），不是写死的数字
        ids = [TASK_BAD, "task_mj_2", "task_mj_3", "task_mj_4", "task_mj_5"]
        self.plan_task(TASK_BAD, task_failed("upstream code=9: upstream submit failure"))
        self.queue_submit(*[(200, submitted(task_id)) for task_id in ids])
        for task_id in ids[1:]:
            self.plan_task(task_id, task_failed("upstream code=9: upstream submit failure"))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            with self.assertRaises(main.HTTPException) as caught:
                self.generate()
        detail = caught.exception.detail
        self.assertIn("上游这次没接住任务", detail)
        self.assertIn("已自动重试 4 次仍未成功", detail)
        self.assertIn("自动退款", detail)
        self.assertEqual(len(self.submit_posts()), 5, self.requests())

    def test_submit_survives_four_consecutive_code_9_failures(self):
        """真机抖动是十几秒级的：4 次 code=9 之后第 5 次成功，必须能出图（旧 3 次窗口会在这里失败）。"""
        for _ in range(4):
            self.queue_submit((200, {"code": 9, "description": "upstream submit failure: FAST@7e803b01"}))
        self.queue_submit((200, submitted(TASK_OK_2)))
        self.plan_task(TASK_OK_2, task_succeeded(TASK_OK_2, self.base + "/files/mj2.png"))
        with mock.patch.object(main, "MIDJOURNEY_RETRY_BACKOFFS", (0.01, 0.01)):
            image_data, _raw = self.generate(speed="fast")
        self.assertEqual(image_data.get("value"), self.base + "/files/mj2.png")
        self.assertEqual(len(self.submit_posts()), 5, self.requests())

    def test_submit_retry_sleep_is_jittered(self):
        """真实路径上的等待必须带 ±20% 抖动（把 asyncio.sleep 打桩收集，不真等 1 秒）。"""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(float(seconds))

        self.queue_submit((200, {"code": 9, "description": "upstream submit failure"}))
        self.queue_submit((200, submitted(TASK_OK_2)))
        self.plan_task(TASK_OK_2, task_succeeded(TASK_OK_2, self.base + "/files/mj2.png"))
        with mock.patch.object(main.asyncio, "sleep", new=fake_sleep):
            image_data, _raw = self.generate(speed="fast")
        self.assertEqual(image_data.get("value"), self.base + "/files/mj2.png")
        retry_sleeps = [value for value in sleeps if value > 0.5]   # 0.01 的轮询间隔不算
        self.assertEqual(len(retry_sleeps), 1, sleeps)
        self.assertGreaterEqual(retry_sleeps[0], 0.8)
        self.assertLessEqual(retry_sleeps[0], 1.2)

    # --- 退避 / 判定口径 ---

    def test_retry_backoff_matches_apimart_guidance(self):
        # 官方 1/4/16 指数退避，8s 是补的中间档；5 次尝试 = 最长约 29 秒窗口
        self.assertEqual(tuple(main.MIDJOURNEY_RETRY_BACKOFFS), (1.0, 4.0, 8.0, 16.0))
        self.assertEqual(main.MIDJOURNEY_MAX_ATTEMPTS, 5)
        # 每次等 ±20% 抖动：只验范围（数量级对了就是对的，别写死具体秒数）
        for attempt, base in ((1, 1.0), (2, 4.0), (3, 8.0), (4, 16.0), (5, 16.0)):
            for _ in range(40):
                slept = main.midjourney_retry_backoff(attempt)
                self.assertGreaterEqual(slept, base * 0.8 - 1e-9)
                self.assertLessEqual(slept, base * 1.2 + 1e-9)

    def test_retryable_classification(self):
        self.assertTrue(main.midjourney_failure_retryable("code=9 / upstream submit failure"))
        self.assertTrue(main.midjourney_failure_retryable("No available upstream, please retry"))
        self.assertTrue(main.midjourney_failure_retryable("HTTP 503 temporarily unavailable"))
        self.assertFalse(main.midjourney_failure_retryable("code=24 / banned prompt"))
        self.assertFalse(main.midjourney_failure_retryable("code=4 / 无法识别的参数"))
        self.assertFalse(main.midjourney_failure_retryable(""))

    def test_error_message_keeps_original_text(self):
        message = main.midjourney_error_message("code=9 / upstream submit failure", attempts=2)
        self.assertIn("上游这次没接住任务", message)
        self.assertIn("已自动重试 2 次仍未成功", message)
        self.assertIn("原文：", message)
        self.assertEqual(main.midjourney_error_message("something odd"), "something odd")


class MidjourneyPromptCleanTests(unittest.TestCase):
    """提示词清洗：参数规范化 + 只把 body 有等价字段的摘掉；其余原样保留，正文连字符不动。"""

    def test_body_params_are_mapped_and_removed(self):
        text, params = main.midjourney_prompt_params("masterpiece, best quality --ar 16:9 --v 6.0")
        self.assertEqual(params, {"aspect": "16:9", "version": "6.0"})
        for token in ("--ar", "-ar", "--v", "-v", "16:9", "6.0"):
            self.assertNotIn(token, text)
        self.assertIn("masterpiece", text)

    def test_single_dash_residue_is_recognized_and_mapped(self):
        # 历史清洗把 "--ar 16:9" 压成了 "-ar 16:9"：单横杠同样要识别、同样要摘掉
        text, params = main.midjourney_prompt_params("masterpiece -ar 16:9 -v 6.0")
        self.assertEqual(params, {"aspect": "16:9", "version": "6.0"})
        self.assertEqual(text, "masterpiece")

    def test_prompt_only_params_are_kept_and_normalized(self):
        # 面板没有对应字段的能力不许丢：规范化成 --flag 后原样保留给上游 MJ
        text, params = main.midjourney_prompt_params(
            "poster -iw 1.2 -tile -weird 500 --chaos 10 -style raw --fast")
        self.assertEqual(text, "poster --iw 1.2 --tile --weird 500 --chaos 10 --style raw --fast")
        self.assertEqual(params, {})

    def test_negative_prompt_token_is_kept(self):
        # 没有确认的 negative_prompt body 字段前不硬塞（硬塞可能再触发 code=4/9）：
        # 规范化后原样留给上游 MJ 自己解析，用户的排除能力不丢
        text, params = main.midjourney_prompt_params("poster --no ugly, blurry")
        self.assertEqual(text, "poster --no ugly, blurry")
        self.assertEqual(params, {})

    def test_hyphenated_prose_is_kept(self):
        self.assertEqual(main.midjourney_prompt_text("a black slip dress, e-commerce photo"),
                         "a black slip dress, e-commerce photo")

    def test_markdown_hr_becomes_space(self):
        text = main.midjourney_prompt_text("第一段\n---\n第二段")
        self.assertNotIn("---", text)
        self.assertNotIn("-", text)
        self.assertIn("第一段", text)
        self.assertIn("第二段", text)

    def test_cjk_prefix_and_quotes_are_kept(self):
        source = "参考图顺序：图1=「红裙」——根据「国潮」生成海报"
        self.assertEqual(main.midjourney_prompt_text(source), source)

    def test_unknown_parameter_like_words_are_kept(self):
        # 参数名白名单之外的词不能被吃掉（-variant 不是 MJ 参数，正文要留下）
        text = main.midjourney_prompt_text("a dress -variant b and -colorful c")
        self.assertIn("-variant", text)
        self.assertIn("-colorful", text)


if __name__ == "__main__":
    unittest.main()
