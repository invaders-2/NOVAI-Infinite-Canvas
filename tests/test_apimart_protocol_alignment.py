"""APIMart 协议对齐：域名识别 / 官方渠道图像模型 / Midjourney 根地址（纯函数 + 源码断言）。

官方文档（docs.apimart.ai，内容相同的镜像 docs.apib.ai）只写：
  * Base URL https://api.apimart.ai，路径前缀 /v1。
  * 图像请求体 image_urls 是字符串数组；扩展渠道（gpt-image-2、gemini-3-pro-image-preview 等）
    支持 URL 与 base64 data URI 混填，官方渠道模型（*-official，含别名 nano-banana-pro）只接受
    公网可访问的图片 URL，且官方文档明确写「使用官方渠道时不能使用 official_fallback」：
    /cn/api-reference/images/gpt-image-2/generation.md、.../official.md、.../gemini-3-pro/generation.md。
  * 上传图片 POST /v1/uploads/images（multipart 字段 file）返回扁平 {"url": ...}，72 小时有效。
  * Midjourney 提交 /v1/midjourney/generations、查询 /v1/midjourney/{task_id}，
    主机跟随用户配置的 Base URL（/cn/api-reference/images/midjourney/query.md 等）。

apib.ai / api.apib.ai 官方文档未记载（全量语料命中 0 次），是实测同源的国内备用域名
（/v1/models 返回 {"type":"apimart_error"}），因此按同一异步协议处理。
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

MAIN_SOURCE = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")


def slice_between(source, start_marker, end_marker):
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def function_source(source, name):
    match = re.search(r"^(?:async )?def %s\(" % re.escape(name), source, re.M)
    if not match:
        raise AssertionError("main.py 里找不到函数 " + name)
    rest = source[match.start() + 1:]
    tail = re.search(r"^(?:async )?def |^class |^@", rest, re.M)
    end = match.start() + 1 + (tail.start() if tail else len(rest))
    return source[match.start():end]


APIMART_IMAGE_BRANCH = slice_between(
    MAIN_SOURCE, "        elif is_apimart:", "        elif is_gpt2 and not image_refs")


class ApimartProviderDomainTests(unittest.TestCase):
    """实测同源的国内备用域名 apib.ai / api.apib.ai（官方文档未记载），判定必须与 apimart.ai 一致。"""

    def test_mirror_hosts_are_apimart(self):
        for base_url in ("https://apib.ai", "https://api.apib.ai", "https://api.apimart.ai"):
            self.assertTrue(main.is_apimart_provider({"base_url": base_url}), base_url)

    def test_other_host_is_not_apimart(self):
        self.assertFalse(main.is_apimart_provider({"base_url": "https://api.openai.com"}))
        self.assertFalse(main.is_apimart_provider({}))

    def test_explicit_protocol_wins_without_base_url(self):
        self.assertTrue(main.is_apimart_provider({"protocol": "apimart", "base_url": ""}))


class ApimartOfficialImageModelTests(unittest.TestCase):
    """官方渠道模型：模型名以 -official 结尾，或等于官方别名 nano-banana-pro。"""

    def test_official_channel_models(self):
        for model in ("gpt-image-2-official", "gemini-3-pro-image-preview-official", "nano-banana-pro",
                      "GPT-Image-2-Official", "nano_banana_pro"):
            self.assertTrue(main.is_apimart_official_image_model(model), model)

    def test_extension_channel_models(self):
        for model in ("gpt-image-2", "gpt-image-2-ext", "nano-banana-pro-ext", "seedream-4.5", ""):
            self.assertFalse(main.is_apimart_official_image_model(model), model)


class ApimartApiBaseTests(unittest.TestCase):
    """Midjourney 主机跟随用户配置的 Base URL，没配才回退默认根地址。"""

    def test_provider_base_url_wins(self):
        self.assertEqual(main.apimart_api_base({"base_url": "https://api.apib.ai"}), "https://api.apib.ai")
        self.assertEqual(main.apimart_api_base({"base_url": "https://api.apimart.ai/v1"}), "https://api.apimart.ai")

    def test_falls_back_to_default_root(self):
        self.assertEqual(main.apimart_api_base({}), main.APIMART_MIDJOURNEY_API_ROOT)
        self.assertEqual(main.apimart_api_base(None), main.APIMART_MIDJOURNEY_API_ROOT)


class ApimartImageBranchSourceTests(unittest.TestCase):
    """official_fallback 只允许出现在扩展渠道；官方渠道参考图必须先上传成公网 URL。"""

    def test_official_fallback_only_on_extension_channel(self):
        stripped = [line.strip() for line in APIMART_IMAGE_BRANCH.splitlines()]
        hits = [index for index, line in enumerate(stripped)
                if "official_fallback" in line and not line.startswith("#")]
        self.assertEqual(len(hits), 1, "APIMart 图像分支只应有一处 official_fallback 写入")
        self.assertEqual(stripped[hits[0]], 'body["official_fallback"] = False')
        self.assertTrue(stripped[hits[0] - 1].startswith("if not apimart_official"),
                        "official_fallback 必须只在非官方渠道分支写入")
        self.assertNotIn('"official_fallback": False', APIMART_IMAGE_BRANCH)

    def test_official_channel_uploads_reference_images(self):
        self.assertIn("is_apimart_official_image_model(model)", APIMART_IMAGE_BRANCH)
        self.assertIn("upload_image_for_apimart(client, provider", APIMART_IMAGE_BRANCH)
        self.assertIn('startswith(("http://", "https://"))', APIMART_IMAGE_BRANCH)
        self.assertIn('body["image_urls"] = official_urls', APIMART_IMAGE_BRANCH)

    def test_extension_channel_keeps_data_uri(self):
        self.assertIn("reference_to_data_url(ref, max_size=1536)", APIMART_IMAGE_BRANCH)


class ApimartMidjourneyBaseSourceTests(unittest.TestCase):
    """Midjourney 提交与查询都不再硬编码官方根地址。"""

    def test_uses_configured_base(self):
        for name in ("apimart_midjourney_request", "midjourney_result"):
            source = function_source(MAIN_SOURCE, name)
            self.assertIn("apimart_api_base(provider)", source, name)
            self.assertNotIn("APIMART_MIDJOURNEY_API_ROOT", source, name)


if __name__ == "__main__":
    unittest.main()
