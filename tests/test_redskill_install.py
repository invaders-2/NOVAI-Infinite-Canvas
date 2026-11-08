# -*- coding: utf-8 -*-
"""RedSkill 技能包安装：取包、sha256 校验、zip 安全解压、references 内联、可读报错。

全程 monkeypatch redskill_install.urlopen，不打真实网络。
"""
import hashlib
import io
import json
import sys
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.skills import redskill_install, skill_md  # noqa: E402

IDENT = "avant-garde-chromatic-fashion"
ZIP_URL = "http://sns-video-v6.xhscdn.com/skill/abc.zip?sign=x&t=y"
SKILL_MD = "---\nname: %s\ndescription: 测试用 RedSkill 技能\n---\n正文：先读 references/style.md" % IDENT
REFERENCE = "# 风格参考\n\n这一段应该被内联进附录。"
MAX_BUNDLE_BYTES = 10 * 1024 * 1024


class FakeResponse:
    def __init__(self, body, status=200):
        self.body = body.encode("utf-8") if isinstance(body, str) else body
        self.status = status

    def read(self, size=-1):
        return self.body if size is None or size < 0 else self.body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def make_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in entries.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def api_payload(zip_bytes, sha256=None, code=0, success=True, msg="成功",
                zip_url=ZIP_URL, identifier=IDENT, version="1.3.6"):
    return {
        "code": code,
        "success": success,
        "msg": msg,
        "data": {
            "zip_url": zip_url,
            "bundle_size_bytes": len(zip_bytes),
            "size_bytes": len(zip_bytes),
            "sha256": sha256 if sha256 is not None else hashlib.sha256(zip_bytes).hexdigest(),
            "identifier": identifier,
            "version": version,
        },
    }


def fetch_with(payload, zip_bytes=None, fetch_error=None):
    """返回 (fetch 结果或异常上下文, 请求 URL 记录)。"""
    calls = []

    def fake(request, timeout=None):
        calls.append(request.full_url)
        if fetch_error is not None:
            raise fetch_error
        if "get_skill_bundle" in request.full_url:
            return FakeResponse(json.dumps(payload, ensure_ascii=False))
        if zip_bytes is None:
            raise AssertionError("这个用例不该下载技能包：%s" % request.full_url)
        return FakeResponse(zip_bytes)

    patcher = mock.patch.object(redskill_install, "urlopen", side_effect=fake)
    return patcher, calls


class FetchSkillBundleTests(unittest.TestCase):

    def test_success_inlines_references_and_checks_sha256(self):
        zip_bytes = make_zip({
            "SKILL.md": SKILL_MD,
            "README.md": "readme",
            "references/style.md": REFERENCE,
            "references/nested/extra.md": "# 嵌套参考\n\n也要内联。",
        })
        patcher, calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            got = redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(got["identifier"], IDENT)
        self.assertEqual(got["version"], "1.3.6")
        self.assertEqual(got["sha256"], hashlib.sha256(zip_bytes).hexdigest())
        self.assertIn("README.md", got["bundle_files"])
        self.assertIn("SKILL.md", got["bundle_files"])
        self.assertIn("references/style.md", got["bundle_files"])
        self.assertTrue(got["source_url"].startswith("https://sns-video-v6.xhscdn.com/"))
        # http 的 zip_url 必须升级成 https 再下载
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1].startswith("https://sns-video-v6.xhscdn.com/"))
        self.assertIn("## 附录：references/style.md", got["markdown"])
        self.assertIn(REFERENCE.strip(), got["markdown"])
        self.assertIn("## 附录：references/nested/extra.md", got["markdown"])
        parsed = skill_md.parse_skill_md(got["markdown"])
        self.assertEqual(parsed["name"], IDENT)
        self.assertTrue(parsed["body"].startswith("正文：先读 references/style.md"))

    def test_sha256_mismatch_is_rejected(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD})
        patcher, _calls = fetch_with(api_payload(zip_bytes, sha256="0" * 64), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("sha256", str(ctx.exception))
        self.assertIn("已拒绝安装", str(ctx.exception))

    def test_missing_sha256_is_rejected(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD})
        payload = api_payload(zip_bytes)
        payload["data"]["sha256"] = ""
        patcher, _calls = fetch_with(payload, zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertIn("sha256", str(ctx.exception))

    def test_zip_traversal_entry_is_rejected(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD, "../evil.md": "x"})
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("..", str(ctx.exception))
        self.assertIn("不安全", str(ctx.exception))

    def test_zip_absolute_path_entry_is_rejected(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD, "/etc/passwd": "x"})
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("绝对路径", str(ctx.exception))

    def test_zip_symlink_entry_is_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("SKILL.md", SKILL_MD)
            link = zipfile.ZipInfo("references/link.md")
            link.external_attr = (0o120777 << 16)
            archive.writestr(link, "target")
        zip_bytes = buffer.getvalue()
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertIn("符号链接", str(ctx.exception))

    def test_untrusted_bundle_host_is_rejected_before_download(self):
        bad_urls = (
            "http://evil.example.com/skill/abc.zip",
            "https://sns-video-v6.xhscdn.com.evil.com/skill/abc.zip",
            "ftp://sns-video-v6.xhscdn.com/skill/abc.zip",
        )
        for bad_url in bad_urls:
            with self.subTest(bad_url=bad_url):
                zip_bytes = make_zip({"SKILL.md": SKILL_MD})
                patcher, calls = fetch_with(api_payload(zip_bytes, zip_url=bad_url), zip_bytes)
                with patcher:
                    with self.assertRaises(redskill_install.RedSkillError) as ctx:
                        redskill_install.fetch_skill_bundle(IDENT)
                self.assertEqual(ctx.exception.status_code, 502)
                self.assertIn("不可信", str(ctx.exception))
                self.assertEqual(len(calls), 1)

    def test_api_nonzero_code_is_reported_readably(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD})
        payload = api_payload(zip_bytes, code=404, success=False, msg="技能不存在")
        patcher, _calls = fetch_with(payload, zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("找不到技能", str(ctx.exception))
        self.assertIn(IDENT, str(ctx.exception))

    def test_api_success_false_is_rejected(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD})
        payload = api_payload(zip_bytes, code=0, success=False, msg="技能不存在")
        patcher, _calls = fetch_with(payload, zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("找不到技能", str(ctx.exception))

    def test_api_server_error_keeps_code_and_msg(self):
        zip_bytes = make_zip({"SKILL.md": SKILL_MD})
        payload = api_payload(zip_bytes, code=500, success=False, msg="服务异常")
        patcher, _calls = fetch_with(payload, zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("code=500", str(ctx.exception))
        self.assertIn("服务异常", str(ctx.exception))

    def test_network_failure_is_reported_readably(self):
        patcher, _calls = fetch_with(None, fetch_error=urllib.error.URLError("boom"))
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("无法连接 RedSkill", str(ctx.exception))
        self.assertIn("boom", str(ctx.exception))

    def test_bundle_over_10mb_is_rejected(self):
        zip_bytes = b"\0" * (MAX_BUNDLE_BYTES + 1)
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertIn("10MB", str(ctx.exception))

    def test_bundle_without_skill_md_is_rejected(self):
        zip_bytes = make_zip({"README.md": "只有说明，没有技能正文"})
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            with self.assertRaises(redskill_install.RedSkillError) as ctx:
                redskill_install.fetch_skill_bundle(IDENT)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("SKILL.md", str(ctx.exception))

    def test_skill_md_in_subdirectory_is_found(self):
        zip_bytes = make_zip({
            "bundle/SKILL.md": SKILL_MD,
            "bundle/references/style.md": REFERENCE,
        })
        patcher, _calls = fetch_with(api_payload(zip_bytes), zip_bytes)
        with patcher:
            got = redskill_install.fetch_skill_bundle(IDENT)
        self.assertIn(REFERENCE.strip(), got["markdown"])
        self.assertIn("## 附录：references/style.md", got["markdown"])


class ParseRedSkillRefTests(unittest.TestCase):

    def test_explicit_prefix(self):
        self.assertEqual(redskill_install.parse_redskill_ref("redskill:" + IDENT), IDENT)
        self.assertEqual(redskill_install.parse_redskill_ref("redskill://" + IDENT), IDENT)
        self.assertEqual(redskill_install.parse_redskill_ref("  redskill:" + IDENT + "  "), IDENT)

    def test_bare_identifier(self):
        self.assertEqual(redskill_install.parse_redskill_ref(IDENT), IDENT)
        self.assertEqual(redskill_install.parse_redskill_ref("create_y2k-fashion"), "create_y2k-fashion")

    def test_urls_are_not_identifiers(self):
        for value in (
            "https://github.com/acme/tools",
            "https://example.com/SKILL.md",
            "http://sns-video-v6.xhscdn.com/skill/abc.zip",
            "acme/tools",
            "install.md",
            "",
            "redskill:",
            "redskill:Bad Name",
            "redskill:UPPER",
        ):
            with self.subTest(value=value):
                self.assertIsNone(redskill_install.parse_redskill_ref(value))


if __name__ == "__main__":
    unittest.main()
