"""供应商级「能力覆盖」配置（provider.size_overrides）与 /api/ai/size-policy 合并规则。

覆盖：
  1. 带覆盖的供应商 → 该模型 policy 收窄（ratios / resolutions / maxEdge / maxPixels）；
  2. 不带覆盖 → 与旧实现逐字节一致（防回归）；
  3. 覆盖只作用于被声明的模型；
  4. 同名模型跨供应商时取交集 / 更小边界；
  5. 坏声明不影响服务（退回不带覆盖的行为）。

样例（中转站 43.130.6.197 的 gemini-3.1-flash-image，见
/tmp/novai-matrix-evidence/REPORT.md）：10 个比例 + 只有 1k。
"""
import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main  # noqa: E402
from server.protocols import registry as reg  # noqa: E402

RELAY_MODEL = "gemini-3.1-flash-image"
RELAY_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
RELAY_RESOLUTIONS = ["1k"]


def relay_provider(**overrides):
    provider = {
        "id": "sub2api",
        "name": "Sub2API",
        "enabled": True,
        "protocol": "openai",
        "image_models": [RELAY_MODEL, "gpt-image-2"],
    }
    if overrides:
        provider.update(overrides)
    return provider


def no_override_provider():
    return relay_provider()


def override_provider():
    return relay_provider(size_overrides={
        RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": RELAY_RESOLUTIONS},
    })


def legacy_size_policy_table(providers):
    """改动前的实现（仅按 mode 严格度去重），用于逐字节防回归对照。"""
    models = {}
    for provider in providers if isinstance(providers, list) else []:
        if not isinstance(provider, dict) or not provider.get("enabled", True):
            continue
        for raw in provider.get("image_models") or []:
            model = str(raw or "").strip()
            if not model:
                continue
            policy = reg.size_policy_for(provider, model)
            current = models.get(model)
            if current is None or reg.SIZE_MODE_RANK.get(policy["mode"], 0) > reg.SIZE_MODE_RANK.get(current["mode"], 0):
                models[model] = policy
    return {
        "format": reg.SIZE_POLICY_FORMAT,
        "default": reg._default_size_policy(),
        "models": models,
    }


class SizeOverrideParsingTests(unittest.TestCase):

    def test_valid_override_normalized(self):
        parsed = reg._provider_size_overrides({
            "size_overrides": {
                RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": ["1K", " 1k "], "maxEdge": "2048"},
            },
        })
        self.assertEqual(parsed[RELAY_MODEL]["ratios"], RELAY_RATIOS)
        self.assertEqual(parsed[RELAY_MODEL]["resolutions"], ["1k"])
        self.assertEqual(parsed[RELAY_MODEL]["maxEdge"], 2048)

    def test_malformed_override_is_ignored(self):
        for bad in (None, [], "x", {"model": 1}, {"model": {"ratios": "1:1"}}, {"model": {"resolutions": {}}}):
            with self.subTest(bad=bad):
                self.assertEqual(reg._provider_size_overrides({"size_overrides": bad}), {})

    def test_provider_without_size_overrides(self):
        self.assertEqual(reg._provider_size_overrides(relay_provider()), {})


class SizePolicyTableTests(unittest.TestCase):

    def test_without_override_is_byte_identical_to_legacy(self):
        providers = [
            no_override_provider(),
            {"id": "modelscope", "enabled": True, "protocol": "openai", "image_models": ["gpt-image-2", "Tongyi-MAI/Z-Image-Turbo"]},
            {"id": "disabled", "enabled": False, "protocol": "openai", "image_models": [RELAY_MODEL]},
        ]
        new = reg.size_policy_table(copy.deepcopy(providers))
        old = legacy_size_policy_table(copy.deepcopy(providers))
        self.assertEqual(json.dumps(new, sort_keys=True, ensure_ascii=False),
                         json.dumps(old, sort_keys=True, ensure_ascii=False))
        for policy in new["models"].values():
            self.assertNotIn("ratios", policy)
            self.assertNotIn("resolutions", policy)

    def test_override_narrows_policy(self):
        table = reg.size_policy_table([override_provider()])
        policy = table["models"][RELAY_MODEL]
        self.assertEqual(policy["ratios"], RELAY_RATIOS)
        self.assertEqual(policy["resolutions"], RELAY_RESOLUTIONS)
        self.assertEqual(policy["mode"], "free")  # 覆盖不改变全局 mode，只加允许项

    def test_override_only_touches_declared_model(self):
        table = reg.size_policy_table([override_provider()])
        gpt = table["models"]["gpt-image-2"]
        self.assertNotIn("ratios", gpt)
        self.assertNotIn("resolutions", gpt)
        # 未声明模型仍等于不带覆盖时的策略
        self.assertEqual(json.dumps(gpt, sort_keys=True),
                         json.dumps(reg.size_policy_for(override_provider(), "gpt-image-2"), sort_keys=True))

    def test_override_max_edge_and_pixels_win(self):
        provider = relay_provider(size_overrides={
            RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": RELAY_RESOLUTIONS, "maxEdge": 2048, "maxPixels": 4194304},
        })
        policy = reg.size_policy_table([provider])["models"][RELAY_MODEL]
        self.assertEqual(policy["maxEdge"], 2048)
        self.assertEqual(policy["maxPixels"], 4194304)

    def test_duplicate_model_intersects_ratios(self):
        provider_a = relay_provider(size_overrides={
            RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": ["1k", "2k"]},
        })
        provider_b = {
            "id": "other", "enabled": True, "protocol": "openai",
            "image_models": [RELAY_MODEL],
            "size_overrides": {RELAY_MODEL: {"ratios": ["1:1", "16:9"], "resolutions": ["1k"]}},
        }
        policy = reg.size_policy_table([provider_a, provider_b])["models"][RELAY_MODEL]
        self.assertEqual(policy["ratios"], ["1:1", "16:9"])
        self.assertEqual(policy["resolutions"], ["1k"])

    def test_override_applies_to_free_base_only(self):
        # enum 模型（gpt-image-1）声明覆盖时，覆盖项同样并入，但 mode/options 不被覆盖改写
        provider = {
            "id": "openai", "enabled": True, "protocol": "openai", "image_models": ["gpt-image-1"],
            "size_overrides": {"gpt-image-1": {"resolutions": ["1k"]}},
        }
        policy = reg.size_policy_table([provider])["models"]["gpt-image-1"]
        base = reg.size_policy_for(provider, "gpt-image-1")
        self.assertEqual(policy["mode"], base["mode"])
        self.assertEqual(policy["options"], base["options"])
        self.assertEqual(policy["resolutions"], ["1k"])

    def test_malformed_override_falls_back(self):
        provider = relay_provider(size_overrides={RELAY_MODEL: {"ratios": "1:1", "resolutions": 5}})
        table = reg.size_policy_table([provider])
        self.assertEqual(json.dumps(table["models"][RELAY_MODEL], sort_keys=True),
                         json.dumps(reg.size_policy_for(provider, RELAY_MODEL), sort_keys=True))


class ProviderSavePreservesOverridesTests(unittest.TestCase):
    """设置页保存链路（PUT /api/providers → ApiProviderPayload → normalize_provider）不能丢覆盖字段。

    size_overrides / model_protocols 都不在页面做可视化编辑，保存时必须原样带回；
    否则用户在设置页点一次保存，data/api_providers.json 里的声明就被抹掉，
    /api/ai/size-policy 的收窄随之失效。
    """

    def make_payload(self):
        return main.ApiProviderPayload(
            id="sub2api",
            name="Sub2API",
            base_url="http://127.0.0.1:9",
            protocol="openai",
            enabled=True,
            image_models=[RELAY_MODEL, "gpt-image-2"],
            model_protocols={RELAY_MODEL: "gemini"},
            size_overrides={RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": RELAY_RESOLUTIONS}},
        )

    def test_payload_to_provider_keeps_both_fields(self):
        # 与 save_providers 里的 item.dict(exclude={"api_key"}) 同路径
        provider = main.normalize_provider(self.make_payload().model_dump(exclude={"api_key"}))
        self.assertEqual(provider["size_overrides"],
                         {RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": RELAY_RESOLUTIONS}})
        self.assertEqual(provider["model_protocols"], {RELAY_MODEL: "gemini"})

    def test_save_providers_endpoint_roundtrip_keeps_overrides(self):
        captured = {}
        with patch.object(main, "save_api_providers",
                          side_effect=lambda providers: captured.setdefault("providers", providers)), \
             patch.object(main, "load_api_providers", return_value=[]):
            result = asyncio.run(main.save_providers([self.make_payload()]))
        self.assertTrue(result["providers"], "保存接口应返回落库后的平台列表")
        saved = captured["providers"][0]
        self.assertEqual(saved["id"], "sub2api")
        self.assertEqual(saved["size_overrides"],
                         {RELAY_MODEL: {"ratios": RELAY_RATIOS, "resolutions": RELAY_RESOLUTIONS}})
        self.assertEqual(saved["model_protocols"], {RELAY_MODEL: "gemini"})
        # 保存后的配置仍能让 size-policy 收窄
        policy = reg.size_policy_table(captured["providers"])["models"][RELAY_MODEL]
        self.assertEqual(policy["ratios"], RELAY_RATIOS)
        self.assertEqual(policy["resolutions"], RELAY_RESOLUTIONS)

    def test_payload_without_overrides_stays_absent(self):
        # 不带覆盖的旧调用方：行为不变，不凭空多出字段
        provider = main.normalize_provider({
            "id": "plain", "name": "Plain", "protocol": "openai", "image_models": [RELAY_MODEL],
        })
        self.assertNotIn("size_overrides", provider)
        self.assertEqual(provider["model_protocols"], {})


if __name__ == "__main__":
    unittest.main()
