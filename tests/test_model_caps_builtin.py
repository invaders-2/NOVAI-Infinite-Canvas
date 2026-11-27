# -*- coding: utf-8 -*-
"""GET /api/model-caps?include_builtin=1：补「能力表有、用户清单没登记」的 APIMart 模型。

锁定四件事：
  1. 不带参数时 items 与以前完全一致（条数、形状、没有 builtin 字段）；
  2. 带 include_builtin=1 时新增条目全部来自能力表、都带 builtin:true；
  3. 不与已登记模型重复（含 seedream-5.0-pro / seedream-5-0-pro 这种点号-连字符写法）；
  4. 只对 protocol=apimart 的 provider 生效，其他协议不编造模型。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


def make_provider(provider_id, protocol, **overrides):
    provider = {
        "id": provider_id,
        "name": provider_id,
        "base_url": "https://api.apimart.ai" if protocol == "apimart" else "https://example.com",
        "protocol": protocol,
        "enabled": True,
        "primary": True,
        "image_model": "",
        "image_models": [],
        "chat_models": [],
        "video_models": [],
        "audio_models": [],
        "model_names": {},
        "model_protocols": {},
        "max_concurrency": 0,
        "protocol_version": 0,
    }
    provider.update(overrides)
    return provider


class ModelCapsBuiltinTests(unittest.TestCase):

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="novai-model-caps-builtin-")
        self._orig_providers_file = main.API_PROVIDERS_FILE
        main.API_PROVIDERS_FILE = os.path.join(self.tmpdir, "api_providers.json")
        self.addCleanup(self._restore)
        self._write({
            "apimart": [
                "seedream-5-0-pro",          # 已登记（能力表 key 同名）
                "seedream-5.5",              # 已登记（点号写法，归一化后 = seedream-5-5）
            ],
            "video": ["seedance-2.0"],       # 已登记（点号写法，归一化后 = seedance-2-0）
        })
        main.invalidate_model_caps_cache()

    def _restore(self) -> None:
        main.API_PROVIDERS_FILE = self._orig_providers_file
        main.invalidate_model_caps_cache()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, models) -> None:
        providers = [make_provider(
            "apimart", "apimart",
            image_models=list(models.get("apimart") or []),
            video_models=list(models.get("video") or []),
        )]
        # 非 APIMart 协议：有 Gemini 图片规格，但绝不能冒出 builtin 条目
        providers.append(make_provider(
            "gemini", "gemini",
            base_url="https://generativelanguage.googleapis.com",
            image_models=["gemini-2.5-flash-image-preview"],
        ))
        main.API_PROVIDERS_FILE = os.path.join(self.tmpdir, "api_providers.json")
        with open(main.API_PROVIDERS_FILE, "w", encoding="utf-8") as handle:
            json.dump(providers, handle, ensure_ascii=False)
        main.invalidate_model_caps_cache()

    def _items(self, query="") -> list:
        response = TestClient(main.app).get("/api/model-caps%s" % query)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["items"]

    def test_default_response_unchanged(self) -> None:
        default = self._items()
        truthy_off = self._items("?include_builtin=0")
        self.assertEqual(default, truthy_off)
        # 已登记且有规格的 4 条：3 个 APIMart（2 图 + 1 视频）+ 1 个 Gemini 图
        self.assertEqual(len(default), 4)
        self.assertEqual({(item["provider"], item["kind"]) for item in default},
                         {("apimart", "image"), ("apimart", "video"), ("gemini", "image")})
        for item in default:
            self.assertNotIn("builtin", item)
        # 响应形状没变
        payload = TestClient(main.app).get("/api/model-caps").json()
        self.assertEqual(set(payload), {"items", "generated_at"})

    def test_include_builtin_appends_caps_entries(self) -> None:
        default = self._items()
        expanded = self._items("?include_builtin=1")
        self.assertGreater(len(expanded), len(default))
        # 前 len(default) 项与不带参数时逐项一致（只在末尾追加）
        self.assertEqual(expanded[:len(default)], default)
        extra = [item for item in expanded if item.get("builtin") is True]
        self.assertEqual(extra, expanded[len(default):])
        # 新增条目全部来自能力表：模型 ID 在 APIMART_BUILTIN_MODEL_IDS 里，规格从表里来，且只补 APIMart
        all_builtin_ids = set()
        for ids in main.APIMART_BUILTIN_MODEL_IDS["image"].values():
            all_builtin_ids.update(ids)
        for ids in main.APIMART_BUILTIN_MODEL_IDS["video"].values():
            all_builtin_ids.update(ids)
        for ids in main.APIMART_BUILTIN_MODEL_IDS["chat"].values():
            all_builtin_ids.update(ids)
        for item in extra:
            self.assertEqual(item["provider"], "apimart")
            self.assertIn(item["kind"], ("chat", "image", "video"))
            self.assertIn(item["model"], all_builtin_ids)
            if item["kind"] == "chat":
                # chat 没有参数文档：只下发空档位（不编造比例/分辨率/时长）
                self.assertEqual(item["ratios"], [], item["model"])
                self.assertEqual(item["resolutions"], [], item["model"])
                self.assertEqual(item["durations"], [], item["model"])
                continue
            # prompt_only 的模型（MiniMax-H3-Context-IR）只有 modes/prompt_only，没有档位
            self.assertTrue(item.get("prompt_only") or item.get("ratios") or item.get("resolutions")
                            or item.get("durations"), item["model"])
        models = {item["model"] for item in extra}
        # 能力表 key 不能直接当模型名下发（否则 seedance-2-0 会被原样发给上游）
        for key in main.APIMART_BUILTIN_MODEL_IDS["video"]:
            if key != main.APIMART_BUILTIN_MODEL_IDS["video"][key][0]:
                self.assertNotIn(key, models)
        # seedance-2.0 已登记（点号写法）不会重复出现；同族的 2.5 才会作为 builtin 补进来
        self.assertNotIn("seedance-2.0", models)
        self.assertIn("seedance-2.5", models)
        self.assertIn("seedance-1-0-pro-quality", models)
        self.assertIn("wan2.7-image", models)
        # 2026-11-25 v7：7 个「仅定价页 + 定价接口」chat 模型只在内置清单里出现（kind=chat）
        for chat_model in ("gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon",
                           "gpt-6.2-astra", "gpt-6.2-sol", "claude-fable-5.2", "qwen4-max"):
            self.assertIn(chat_model, models, chat_model)
            row = next(item for item in extra if item["model"] == chat_model)
            self.assertEqual(row["kind"], "chat")
            self.assertIs(row["builtin"], True)

    def test_builtin_skips_registered_models(self) -> None:
        expanded = self._items("?include_builtin=1")
        keys = [(item["provider"], item["model"].lower(), item["kind"]) for item in expanded]
        self.assertEqual(len(keys), len(set(keys)), "同一 provider 不能出现重复模型")
        models = {item["model"].lower() for item in expanded}
        # 已登记的点号写法必须挡住 builtin 的连字符写法
        self.assertNotIn("seedream-5-5", models)
        self.assertNotIn("seedance-2-0", models)
        self.assertIn("seedance-2.5", models)       # 没登记的同族模型仍然补
        builtin_models = {item["model"].lower() for item in expanded if item.get("builtin")}
        self.assertNotIn("seedream-5-0-pro", builtin_models)

    def test_non_apimart_provider_gets_no_builtin(self) -> None:
        expanded = self._items("?include_builtin=1")
        gemini = [item for item in expanded if item["provider"] == "gemini"]
        self.assertEqual(len(gemini), 1)            # 只有它自己登记的那条
        self.assertNotIn("builtin", gemini[0])
        self.assertTrue(all(item["provider"] == "apimart" for item in expanded if item.get("builtin")))

    def test_cache_separates_flag(self) -> None:
        self.assertEqual(len(self._items()), 4)
        self.assertGreater(len(self._items("?include_builtin=true")), 4)
        # 反向再查：带过 include_builtin 之后，默认请求不能吃到带 builtin 的缓存
        self.assertEqual(len(self._items()), 4)


if __name__ == "__main__":
    unittest.main()
