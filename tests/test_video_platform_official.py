"""视频分支官方口径：分辨率 / 时长 / 比例 / Kling mode / Agnes 档位（纯函数，不真实调用上游）。

官方出处：
  * 火山方舟 create-video-generation-task-api.md（/tmp/novai-video-docs/text/volcengine_ark_video_task.txt）：
    - resolution 可选 480p/720p/1080p/4k，且按模型收窄：4k 仅 Seedance 2.0，
      2.5 / 1.0 pro 系列最高 1080p，2.0 fast/mini 最高 720p（第 266、273-278 行）；
      ratio 白名单无 keep_ratio/source（第 281 行）；
    - duration 参数自身的模型支持：2.5 [4,30]、2.0 系列 [4,15]、1.0 pro / pro fast [2,12]（第 354-358 行）；
      2.5 视频编辑任务固定 -1（第 261、351-353 行）。
  * APIMart Seedance 2.0（apimart_video_seedance_2_0.txt）：duration 4-15、resolution 默认 720p。
  * APIMart seedance-1.0-pro / doubao（apimart_video_doubao.txt）：duration 2-12。
  * APIMart Kling v3（apimart_video_kling_v3.txt）：duration 3-15、mode std/pro/4k；
    3.0-turbo（apimart_video_kling_3_0_turbo.txt）官方仍用 resolution 720p/1080p。
  * Agnes Video 2.5（agnes_video_25.txt 第 355、363-371 行）：size 只认 720P/1080P/1K/2K；
    aspect_ratio 只认 21:9/16:9/4:3/1:1/3:4/9:16（auto / 白名单之外返回 400）。

780P 是本项目私有笔误档位（官方全部平台都没有）：只做 780P→720p 兼容映射，任何分支都不原样下发。
"""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class Legacy780PAliasTests(unittest.TestCase):
    """780P 私有档位：统一兼容映射为 720p，绝不原样下发。"""

    def test_alias_maps_to_720p(self):
        self.assertEqual(main.legacy_video_resolution("780P"), "720p")
        self.assertEqual(main.legacy_video_resolution("780p"), "720p")

    def test_other_values_pass_through(self):
        for value in ("", "480p", "720p", "1080p", "4k", "auto"):
            self.assertEqual(main.legacy_video_resolution(value), value)


class VolcengineVideoResolutionTests(unittest.TestCase):
    def test_4k_only_for_seedance_2_0(self):
        self.assertEqual(main.volcengine_video_resolution("4k", "doubao-seedance-2-0-260128"), "4k")
        self.assertEqual(main.volcengine_video_resolution("4K", "doubao-seedance-2-0-260128"), "4k")

    def test_4k_narrowed_to_model_top_tier(self):
        for model, expected in (
            ("doubao-seedance-2-5-260628", "1080p"),
            ("doubao-seedance-2-0-fast-260128", "720p"),
            ("doubao-seedance-2-0-mini-260128", "720p"),
            ("doubao-seedance-1-0-pro-250528", "1080p"),
            ("doubao-seedance-1-0-pro-fast-250528", "1080p"),
            ("", "1080p"),
        ):
            self.assertEqual(main.volcengine_video_resolution("4k", model), expected, model)

    def test_non_4k_tiers_pass_through_by_model(self):
        for model in ("doubao-seedance-2-5-260628", "doubao-seedance-2-0-fast-260128"):
            for value in ("480p", "720p", "1080p"):
                self.assertEqual(main.volcengine_video_resolution(value, model), value, (model, value))

    def test_780p_maps_to_720p(self):
        self.assertEqual(main.volcengine_video_resolution("780P", "doubao-seedance-2-0-260128"), "720p")

    def test_auto_stays_empty(self):
        for value in ("", None, "auto", "Auto"):
            self.assertEqual(main.volcengine_video_resolution(value, "doubao-seedance-2-0-260128"), "")

    def test_unknown_is_dropped(self):
        self.assertEqual(main.volcengine_video_resolution("9k", "doubao-seedance-2-0-260128"), "")


class VolcengineVideoDurationTests(unittest.TestCase):
    def test_seedance_2_0_range(self):
        for value, expected in ((1, 4), (3, 4), (4, 4), (15, 15), (16, 15), (60, 15)):
            self.assertEqual(
                main.volcengine_video_duration(value, "doubao-seedance-2-0-fast-260128"), expected, value)

    def test_seedance_2_5_range(self):
        for value, expected in ((1, 4), (2, 4), (3, 4), (4, 4), (30, 30), (31, 30), (60, 30)):
            self.assertEqual(
                main.volcengine_video_duration(value, "doubao-seedance-2-5-260628"), expected, value)

    def test_seedance_1_0_range(self):
        for value, expected in ((1, 2), (2, 2), (12, 12), (13, 12)):
            self.assertEqual(
                main.volcengine_video_duration(value, "doubao-seedance-1-0-pro-250528"), expected, value)

    def test_other_models_keep_legacy_window(self):
        self.assertEqual(main.volcengine_video_duration(60, "doubao-seedance-1-5-pro-251215"), 60)
        self.assertEqual(main.volcengine_video_duration(60, ""), 60)


class VolcengineVideoRatioTests(unittest.TestCase):
    def test_legacy_keep_ratio_maps_to_adaptive(self):
        self.assertEqual(main.volcengine_video_ratio("keep_ratio"), "adaptive")
        self.assertEqual(main.volcengine_video_ratio("source"), "adaptive")

    def test_official_ratios_unchanged(self):
        for value in ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"):
            self.assertEqual(main.volcengine_video_ratio(value), value)


class ApimartVideoDurationTests(unittest.TestCase):
    def test_seedance_2_0_range(self):
        for value, expected in ((1, 4), (4, 4), (15, 15), (60, 15)):
            self.assertEqual(main.apimart_video_duration(value, "doubao-seedance-2.0"), expected, value)

    def test_seedance_1_0_pro_range(self):
        for value, expected in ((1, 2), (2, 2), (12, 12), (13, 12)):
            self.assertEqual(main.apimart_video_duration(value, "doubao-seedance-1.0-pro"), expected, value)

    def test_kling_range(self):
        for value, expected in ((1, 3), (3, 3), (15, 15), (20, 15)):
            self.assertEqual(main.apimart_video_duration(value, "kling-v3"), expected, value)

    def test_unknown_models_keep_4_15(self):
        self.assertEqual(main.apimart_video_duration(20, "veo3-fast"), 15)
        self.assertEqual(main.apimart_video_duration(1, ""), 4)


class ApimartVideoResolutionTests(unittest.TestCase):
    def test_auto_uses_official_720p(self):
        for value in ("", None, "auto", "Auto"):
            self.assertEqual(main.apimart_video_resolution(value), "720p", value)

    def test_explicit_values_unchanged(self):
        for value in ("480p", "720p", "1080p", "4k"):
            self.assertEqual(main.apimart_video_resolution(value), value)

    def test_780p_maps_to_720p(self):
        self.assertEqual(main.apimart_video_resolution("780P"), "720p")


class ApimartVeo31UnchangedTests(unittest.TestCase):
    """VEO3.1 时长保持可调（不锁 8 秒），分辨率沿用官方 720p/1080p/4k。"""

    def test_duration_stays_adjustable(self):
        self.assertEqual(main.apimart_veo31_duration(4), 4)
        self.assertEqual(main.apimart_veo31_duration(6), 6)
        self.assertEqual(main.apimart_veo31_duration(8), 8)
        self.assertEqual(main.apimart_veo31_duration(60), 8)

    def test_resolution_keeps_4k_and_aliases_780p(self):
        self.assertEqual(main.apimart_veo31_resolution("4k"), "4k")
        self.assertEqual(main.apimart_veo31_resolution("780P"), "720p")


class ApimartKlingFieldTests(unittest.TestCase):
    def test_kling_v3_uses_mode(self):
        self.assertEqual(main.apimart_kling_video_params("kling-v3", "720p"), {"mode": "std"})
        self.assertEqual(main.apimart_kling_video_params("kling-v3", "1080p"), {"mode": "pro"})
        self.assertEqual(main.apimart_kling_video_params("kling-v3", "4k"), {"mode": "4k"})

    def test_kling_auto_and_480p_fall_back_to_std(self):
        self.assertEqual(main.apimart_kling_video_params("kling-video-o1", ""), {"mode": "std"})
        self.assertEqual(main.apimart_kling_video_params("kling-video-o1", "480p"), {"mode": "std"})
        self.assertEqual(main.apimart_kling_video_params("kling-video-o1", "780P"), {"mode": "std"})

    def test_kling_turbo_keeps_official_resolution(self):
        self.assertEqual(main.apimart_kling_video_params("kling-3.0-turbo", "1080p"), {"resolution": "1080p"})
        self.assertEqual(main.apimart_kling_video_params("kling-3.0-turbo", "4k"), {"resolution": "1080p"})
        self.assertEqual(main.apimart_kling_video_params("kling-3.0-turbo", ""), {"resolution": "720p"})

    def test_kling_detection(self):
        self.assertTrue(main.apimart_is_kling_model("kling-v3"))
        self.assertTrue(main.apimart_is_kling_model("Kling-3.0-turbo"))
        self.assertTrue(main.apimart_is_kling_model("kling_video_o1"))
        self.assertFalse(main.apimart_is_kling_model("doubao-seedance-2.0"))


class AgnesVideoTierTests(unittest.TestCase):
    def test_official_tiers(self):
        self.assertEqual(main.agnes_video_size_tier("720p"), "720P")
        self.assertEqual(main.agnes_video_size_tier("1080p"), "1080P")
        self.assertEqual(main.agnes_video_size_tier("1k"), "1K")
        self.assertEqual(main.agnes_video_size_tier("2k"), "2K")

    def test_unofficial_inputs_converge(self):
        self.assertEqual(main.agnes_video_size_tier(""), "720P")
        self.assertEqual(main.agnes_video_size_tier("auto"), "720P")
        self.assertEqual(main.agnes_video_size_tier("480p"), "720P")
        self.assertEqual(main.agnes_video_size_tier("4k"), "2K")

    def test_flash_is_pinned_to_720p(self):
        self.assertEqual(main.agnes_video_size_tier("4k", "agnes-video-2.5-flash"), "720P")


class AgnesVideoAspectTests(unittest.TestCase):
    def test_official_aspects_unchanged(self):
        for value in ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"):
            self.assertEqual(main.agnes_video_aspect_ratio(value), value)

    def test_unsupported_inputs_converge(self):
        for value in ("", None, "keep_ratio", "adaptive", "auto", "source", "16:10"):
            self.assertEqual(main.agnes_video_aspect_ratio(value), "16:9", value)
        self.assertEqual(main.agnes_video_aspect_ratio("9:21"), "9:16")

    def test_request_body_uses_mapping(self):
        class Payload:
            prompt = "p"
            duration = 5
            resolution = "4k"
            aspect_ratio = "9:21"
            seed = None

        body = main.build_agnes_openai_video_body(Payload(), "agnes-video-2.5", [], [])
        self.assertEqual(body["size"], "2K")
        self.assertEqual(body["aspect_ratio"], "9:16")


class _FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload
        self.text = str(payload)

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _RecordingAgnesClient:
    """记录发往上游的请求体，按顺序回放预置响应（不联网）。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.posts = []
        self.gets = []

    async def post(self, url, headers=None, json=None):
        self.posts.append((url, json))
        return _FakeResponse(self.responses.pop(0))

    async def get(self, url, headers=None):
        self.gets.append(url)
        return _FakeResponse(self.responses.pop(0))


AGNES_HUB = {"id": "agnes-ai", "name": "Agnes AI", "base_url": "https://apihub.agnes-ai.com"}


class AgnesVideoReferenceLimitTests(unittest.TestCase):
    """官方 reference 模式参考图上限按型号区分：2.5 标准版 8 张、Flash 5 张。
    来源：wiki.agnes-ai.com/zh-Hans/docs/agnes-video-25.md「图片最多 8 张」；
    agnes-video-25-flash.md「images 最多 5 张」。超限沿用现有约定：静默截断，不报错。"""

    class Payload:
        prompt = "p"
        duration = 5
        resolution = "720p"
        aspect_ratio = "16:9"
        seed = None
        multimodal = False
        images = []

    @staticmethod
    def _urls(count):
        return [f"https://example.com/ref{i}.png" for i in range(count)]

    def test_standard_model_keeps_eight_reference_images(self):
        body = main.build_agnes_openai_video_body(
            self.Payload(), "agnes-video-2.5", self._urls(8), ["reference"] * 8)
        self.assertEqual(body["mode"], "reference")
        self.assertEqual(len(body["images"]), 8)

    def test_flash_keeps_five_reference_images(self):
        body = main.build_agnes_openai_video_body(
            self.Payload(), "agnes-video-2.5-flash", self._urls(8), ["reference"] * 8)
        self.assertEqual(body["mode"], "reference")
        self.assertEqual(body["images"], self._urls(5))

    def test_keyframe_mode_keeps_first_last_frames(self):
        # 首尾帧模式不走 images，改动参考图上限不能影响它。
        body = main.build_agnes_openai_video_body(
            self.Payload(), "agnes-video-2.5", self._urls(2), ["first_frame", "last_frame"])
        self.assertEqual(body["mode"], "keyframe")
        self.assertEqual(body["first_frame"], self._urls(2)[0])
        self.assertEqual(body["last_frame"], self._urls(2)[1])
        self.assertNotIn("images", body)


class AgnesVideoReferenceRequestTests(unittest.TestCase):
    """参数级断言：8 张参考图真的进了上游请求体（非 Flash 8 张 / Flash 5 张）。"""

    def _submit(self, model, count):
        payload = SimpleNamespace(
            prompt="p", duration=5, resolution="720p", aspect_ratio="16:9", seed=None, multimodal=False,
            images=[SimpleNamespace(url=f"https://example.com/ref{i}.png", role="reference") for i in range(count)],
        )
        client = _RecordingAgnesClient(
            [{"video_id": "vid_1", "status": "completed", "url": "https://cdn.example.com/out.mp4"}])

        async def keep_url(url, *args, **kwargs):
            return url

        with mock.patch.object(main, "api_headers", return_value={"Authorization": "Bearer test"}):
            with mock.patch.object(main, "save_remote_video_to_output", new=keep_url):
                result = asyncio.run(
                    main.generate_agnes_video(client, payload, AGNES_HUB, "https://apihub.agnes-ai.com", model))
        return client.posts[0], result

    def test_standard_model_sends_eight_reference_images_upstream(self):
        (url, body), result = self._submit("agnes-video-2.5", 8)
        self.assertEqual(url, "https://apihub.agnes-ai.com/v1/videos")
        self.assertEqual(body["model"], "agnes-video-2.5")
        self.assertEqual(body["mode"], "reference")
        self.assertEqual(len(body["images"]), 8)
        self.assertEqual(body["images"], [f"https://example.com/ref{i}.png" for i in range(8)])
        self.assertEqual(result["videos"], ["https://cdn.example.com/out.mp4"])

    def test_flash_sends_five_reference_images_upstream(self):
        (_, body), _ = self._submit("agnes-video-2.5-flash", 8)
        self.assertEqual(body["mode"], "reference")
        self.assertEqual(len(body["images"]), 5)


class AgnesVideoPollCadenceTests(unittest.TestCase):
    """官方「每隔 1–2 秒查询一次」：首个间隔 1.5s；退避与 12s 封顶逻辑保持原样。"""

    PENDING = {"status": "in_progress", "progress": 1}
    DONE = {"status": "completed", "url": "https://cdn.example.com/out.mp4"}

    def _poll_delays(self, pending_rounds):
        client = _RecordingAgnesClient([self.PENDING] * pending_rounds + [self.DONE])
        slept = []

        async def fake_sleep(seconds):
            slept.append(round(seconds, 6))

        with mock.patch.object(main, "api_headers", return_value={}):
            with mock.patch.object(main.asyncio, "sleep", new=fake_sleep):
                asyncio.run(main.wait_for_agnes_video_task(client, AGNES_HUB, "vid_1", "agnes-video-2.5"))
        return slept

    def test_first_poll_is_official_cadence(self):
        delays = self._poll_delays(0)
        self.assertEqual(len(delays), 1)
        self.assertTrue(1.0 <= delays[0] <= 2.0, delays)

    def test_backoff_sequence_keeps_cap(self):
        delays = self._poll_delays(9)
        print("\n[agnes poll] 实际间隔序列(s):", delays)
        self.assertEqual(len(delays), 10)
        self.assertEqual(delays[0], 1.5)
        self.assertEqual(delays[1], 2.025)
        self.assertEqual(delays[-1], 12.0)
        self.assertEqual(delays, sorted(delays))
        for value in delays:
            self.assertLessEqual(value, 12.0)


class AgnesVideoModelAliasTests(unittest.TestCase):
    """apihub.agnes-ai.com 的 /v1/models 只剩 2.5 两档：旧名 v2.0 必须归一再发。"""

    HUB = {"id": "agnes-ai", "name": "Agnes AI", "base_url": "https://apihub.agnes-ai.com"}
    OTHER = {"id": "custom", "name": "自建中转", "base_url": "https://example.com"}

    def test_legacy_names_map_to_upstream_model(self):
        for legacy in ("agnes-video-v2.0", "agnes-video-2.0", "agnes-video-v2", "AGNES-VIDEO-V2.0"):
            self.assertEqual(main.agnes_upstream_video_model(self.HUB, legacy), "agnes-video-2.5", legacy)

    def test_real_models_pass_through(self):
        for model in ("agnes-video-2.5", "agnes-video-2.5-flash"):
            self.assertEqual(main.agnes_upstream_video_model(self.HUB, model), model)

    def test_other_hubs_are_not_rewritten(self):
        self.assertEqual(main.agnes_upstream_video_model(self.OTHER, "agnes-video-v2.0"), "agnes-video-v2.0")
        self.assertEqual(main.agnes_upstream_video_model(None, "agnes-video-v2.0"), "agnes-video-v2.0")

    def test_default_models_exist_upstream(self):
        # 这份清单会补进「拉取模型列表」的结果，塞进上游没有的名字等于给用户挖坑。
        self.assertNotIn("agnes-video-v2.0", main.AGNES_DEFAULT_VIDEO_MODELS)
        self.assertEqual(main.AGNES_DEFAULT_VIDEO_MODELS, ["agnes-video-2.5", "agnes-video-2.5-flash"])


class AgnesVideoErrorDetailTests(unittest.TestCase):
    """网关的 model_not_found 原文要翻成能照着做的中文提示，并去掉每次都变的 request id。"""

    PROVIDER = {"id": "agnes-ai", "name": "Agnes AI"}
    BODY = (
        '{"error":{"code":"model_not_found","message":"No available channel for model '
        'agnes-video-v2.0 under group default (distributor) (request id: 202610170802176054597179vzVTyrB)",'
        '"type":"AgnesAI_error"}}'
    )

    def test_missing_channel_is_actionable(self):
        text = main.agnes_video_error_detail(self.BODY, self.PROVIDER, "agnes-video-v2.0")
        self.assertIn("Agnes AI", text)
        self.assertIn("agnes-video-v2.0", text)
        self.assertIn("没有模型", text)
        self.assertIn("开通", text)
        self.assertIn("agnes-video-2.5", text)
        # 上游原始 message 要带上，但 request id 不进展示文案
        self.assertIn("No available channel for model agnes-video-v2.0", text)
        self.assertNotIn("request id", text)
        self.assertNotIn('{"error"', text)

    def test_same_cause_across_rows_collapses_to_one_text(self):
        rows = [self.BODY.replace("202610170802176054597179vzVTyrB", f"202610170802176054597179REQ{i}") for i in range(3)]
        reasons = {main.agnes_video_error_detail(body, self.PROVIDER, "agnes-video-v2.0") for body in rows}
        self.assertEqual(len(reasons), 1, reasons)

    def test_insufficient_quota_is_actionable(self):
        # 实测回包（2026-10）：网关把余额不足回成顶层 code，而不是 error 对象。
        body = ('{"code":"insufficient_user_quota","message":"Failed to pre-consume quota, remaining: '
                '＄0.013664, required: ＄0.125000 (request id: 20261017080413221440225NsbEyrc6)","data":null}')
        text = main.agnes_video_error_detail(body, self.PROVIDER, "agnes-video-2.5")
        self.assertIn("余额不足", text)
        self.assertIn("＄0.013664", text)
        self.assertIn("＄0.125000", text)
        self.assertIn("充值", text)
        self.assertNotIn("request id", text)

    def test_other_upstream_errors_keep_message(self):
        body = '{"error":{"code":"insufficient_quota","message":"quota exceeded (request id: abc)","type":"x"}}'
        text = main.agnes_video_error_detail(body, self.PROVIDER, "agnes-video-2.5")
        self.assertIn("quota exceeded", text)
        self.assertNotIn("request id", text)
        self.assertNotIn("没有模型", text)

    def test_plain_text_body_survives(self):
        text = main.agnes_video_error_detail("upstream gateway timeout", self.PROVIDER, "agnes-video-2.5")
        self.assertEqual(text, "Agnes 视频接口错误：upstream gateway timeout")


class VideoDispatchSourceTests(unittest.TestCase):
    """请求体必须真正走归一化函数（防止以后有人把映射绕开）。"""

    @staticmethod
    def _source():
        return Path(main.__file__).read_text(encoding="utf-8")

    def test_volcengine_body_uses_normalizers(self):
        source = self._source()
        self.assertIn('body["ratio"] = volcengine_video_ratio(payload.aspect_ratio)', source)
        self.assertIn("resolution = volcengine_video_resolution(payload.resolution, volc_model)", source)
        self.assertIn("body[\"duration\"] = volcengine_video_duration(payload.duration, volc_model)", source)

    def test_apimart_seedance_body_uses_normalizers(self):
        # 文档依据（docs.apimart.ai/cn/api-reference/videos/*）：24 个模型用 aspect_ratio、13 个用 size，
        # duration 区间与分辨率字段各模型不同，所以 body 改为 apimart_video_body_params 表驱动；
        # 断言保留「必须走归一化、不能直写」的口径，未知模型仍回落到旧的 size + resolution 归一化函数。
        source = self._source()
        self.assertIn("apimart_seedance_model = selected_model(payload.model, \"doubao-seedance-2.0\")", source)
        self.assertIn("video_params = apimart_video_body_params(", source)
        self.assertIn('body[video_params["ratio_key"]] = video_params["ratio_value"]', source)
        self.assertIn('body[video_params["resolution_key"]] = video_params["resolution_value"]', source)
        self.assertIn("def apimart_video_body_params(", source)
        self.assertIn("apimart_video_duration(duration, model)", source)
        self.assertIn("apimart_video_size(ratio)", source)
        self.assertIn("apimart_video_resolution(resolution)", source)
        self.assertIn("apimart_kling_video_params(model, resolution)", source)

    def test_raw_resolution_paths_use_alias(self):
        source = self._source()
        self.assertIn('body["resolution"] = legacy_video_resolution(payload.resolution)', source)
        self.assertIn('legacy_video_resolution(payload.resolution or "720p").lower()', source)

    def test_agnes_video_uses_model_alias_and_error_translation(self):
        source = self._source()
        self.assertIn('selected_model(requested_model, "agnes-video-2.5")', source)
        self.assertIn("requested_model = agnes_upstream_video_model(provider, requested_model)", source)
        self.assertIn("agnes_video_error_detail(text, provider, requested_model)", source)
        self.assertNotIn('detail=f"Agnes 视频接口错误：{text}"', source)


if __name__ == "__main__":
    unittest.main()
