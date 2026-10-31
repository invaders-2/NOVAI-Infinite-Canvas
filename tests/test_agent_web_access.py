import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-web-access-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main
from server import web_access


class WebAccessToolTests(unittest.TestCase):
    def test_disabled_by_default_and_rejected_by_executor(self):
        with patch.object(main, "load_settings", return_value={}):
            self.assertFalse(main.agent_web_enabled())
            self.assertNotIn("web_search", {item["name"] for item in main._agent_build_tools_catalog()})
            result = asyncio.run(main.agent_execute_step("web_search", {"query": "NOVAI"}))
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "web_access_disabled")

    def test_setting_round_trip_and_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "settings.json")
            with patch.object(main, "SETTINGS_FILE", path):
                self.assertFalse(main.get_agent_web_access()["enabled"])
                self.assertTrue(main.set_agent_web_access(main.AgentWebAccessPayload(enabled=True))["enabled"])
                self.assertIn("web_search", {item["name"] for item in main._agent_build_tools_catalog()})
                self.assertIn("fetch_url", {item["name"] for item in main._agent_build_tools_catalog()})
                self.assertFalse(main.set_agent_web_access(main.AgentWebAccessPayload(enabled=False))["enabled"])
                self.assertNotIn("fetch_url", {item["name"] for item in main._agent_build_tools_catalog()})

    def test_readability_removes_scripts_and_truncates(self):
        text = web_access.readable_text(b"<html><script>alert(1)</script><style>x</style><p>Hello <b>world</b></p></html>")
        self.assertEqual(text, "Hello world")
        self.assertLessEqual(len(web_access.readable_text(b"x" * 21000, "text/plain")), 20100)

    def test_search_parser_decodes_results(self):
        html = b'''<div><a class="result__a" href="https://example.com/docs">NOVAI Docs</a>
        <a class="result__snippet">A useful &amp; concise result</a></div>'''
        with patch.object(web_access, "download", return_value=(html, "text/html", "https://html.duckduckgo.com")), \
             patch.object(web_access, "validate_public_url", side_effect=lambda url: url):
            results = web_access.web_search("NOVAI")
        self.assertEqual(results, [{"title": "NOVAI Docs", "url": "https://example.com/docs", "snippet": "A useful & concise result"}])

    def test_rejects_private_and_nonstandard_urls(self):
        for url in ("http://127.0.0.1:3000", "http://localhost", "file:///tmp/a", "https://user:pass@example.com", "https://example.com:8443"):
            with self.subTest(url=url):
                with self.assertRaises(web_access.WebAccessError):
                    web_access.validate_public_url(url)

    def test_fetch_url_returns_final_url_and_text(self):
        with patch.object(web_access, "download", return_value=(b"<p>Hello</p>", "text/html", "https://example.com/final")):
            result = web_access.fetch_url("https://example.com")
        self.assertEqual(result, {"url": "https://example.com/final", "text": "Hello"})


if __name__ == "__main__":
    unittest.main()
