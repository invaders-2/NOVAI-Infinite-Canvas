import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class LovartTrustEnvTests(unittest.TestCase):
    """Lovart 网关必须默认走系统代理，不能跟随全局 NOVAI_USE_PROXY（默认 False 会直连失败）。"""

    def test_auto_trusts_env(self):
        self.assertTrue(main.lovart_trust_env({"use_proxy": "auto"}))

    def test_on_trusts_env(self):
        self.assertTrue(main.lovart_trust_env({"use_proxy": "on"}))

    def test_off_bypasses_env(self):
        self.assertFalse(main.lovart_trust_env({"use_proxy": "off"}))

    def test_missing_field_falls_back_to_auto(self):
        self.assertTrue(main.lovart_trust_env({"id": "lovart"}))
        self.assertTrue(main.lovart_trust_env({"use_proxy": None}))

    def test_none_provider_trusts_env(self):
        self.assertTrue(main.lovart_trust_env(None))

    def test_global_proxy_off_does_not_disable_lovart_auto(self):
        # 防回归关键：NOVAI_USE_PROXY=0 时 _TRUST_ENV 为 False，auto 仍必须走代理
        with patch.object(main, "_TRUST_ENV", False):
            self.assertTrue(main.lovart_trust_env({"use_proxy": "auto"}))
            self.assertTrue(main.lovart_trust_env(None))

    def test_http_client_receives_lovart_trust_env(self):
        async def trust_envs():
            auto_client = main.lovart_http_client({"use_proxy": "auto"}, 5)
            off_client = main.lovart_http_client({"use_proxy": "off"}, 5)
            try:
                return auto_client.trust_env, off_client.trust_env
            finally:
                await auto_client.aclose()
                await off_client.aclose()

        with patch.object(main, "_TRUST_ENV", False):
            auto_trust_env, off_trust_env = asyncio.run(trust_envs())
        self.assertTrue(auto_trust_env)
        self.assertFalse(off_trust_env)


if __name__ == "__main__":
    unittest.main()
