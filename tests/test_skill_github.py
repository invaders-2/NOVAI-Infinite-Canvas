# -*- coding: utf-8 -*-
"""GitHub SKILL.md 下载器：URL 解析、候选、权限与大小限制。"""
import io
import json
import unittest
from unittest import mock

from server.skills import github_install


MARKDOWN = "---\nname: github-test-skill\ndescription: 测试技能\n---\n正文"


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class GithubUrlTests(unittest.TestCase):

    def test_repository_tree_and_raw_urls(self):
        source = github_install.parse_github_url("https://github.com/acme/tools.git")
        self.assertEqual((source.owner, source.repo, source.ref, source.path), ("acme", "tools", "", ""))
        source = github_install.parse_github_url("https://github.com/acme/tools/tree/dev/skills/check")
        self.assertEqual((source.ref, source.path), ("dev", "skills/check"))
        source = github_install.parse_github_url("https://raw.githubusercontent.com/acme/tools/main/SKILL.md")
        self.assertEqual((source.ref, source.path), ("main", "SKILL.md"))

    def test_invalid_hosts_and_paths_are_rejected(self):
        for url in ("https://example.com/acme/tools", "http://github.com/acme/tools", "https://github.com/acme"):
            with self.subTest(url=url):
                with self.assertRaises(github_install.GitHubSkillError):
                    github_install.parse_github_url(url)
        with self.assertRaises(github_install.GitHubSkillError):
            github_install.parse_github_url("https://github.com/acme/tools", path="../secret")


class GithubFetchTests(unittest.TestCase):

    def test_unique_root_skill_and_private_token(self):
        seen = []

        def fake_open(request, timeout, context=None):
            seen.append((request.full_url, request.headers, timeout))
            if request.full_url.endswith("/acme/tools"):
                return FakeResponse(json.dumps({"default_branch": "main"}).encode())
            if "/git/trees/main" in request.full_url:
                return FakeResponse(json.dumps({"tree": [{"type": "blob", "path": "SKILL.md"}]}).encode())
            return FakeResponse(MARKDOWN.encode())

        with mock.patch("urllib.request.urlopen", side_effect=fake_open), \
                mock.patch.dict("os.environ", {"NOVAI_GITHUB_TOKEN": "secret-token"}):
            result = github_install.fetch_skill_markdown("https://github.com/acme/tools")
        self.assertEqual(result["markdown"], MARKDOWN)
        self.assertEqual(result["ref"], "main")
        self.assertEqual(result["path"], "SKILL.md")
        self.assertTrue(all(headers.get("Authorization") == "Bearer secret-token" for _, headers, _ in seen))
        self.assertTrue(all(timeout == 15 for _, _, timeout in seen))

    def test_multiple_candidates_require_path(self):
        payload = {"tree": [{"type": "blob", "path": "a/SKILL.md"}, {"type": "blob", "path": "b/SKILL.md"}]}
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(json.dumps(payload).encode())):
            with self.assertRaisesRegex(github_install.GitHubSkillError, "多个 SKILL.md"):
                github_install._resolve_source(github_install.GitHubSource("acme", "tools", "main", ""), "")

    def test_oversize_markdown_is_rejected(self):
        source = github_install.GitHubSource("acme", "tools", "main", "SKILL.md")
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(b"x" * (github_install.MAX_MARKDOWN_BYTES + 1))):
            with self.assertRaisesRegex(github_install.GitHubSkillError, "1MB"):
                github_install._json("https://raw.githubusercontent.com/acme/tools/main/SKILL.md", "")
        self.assertEqual(source.path, "SKILL.md")


if __name__ == "__main__":
    unittest.main()
