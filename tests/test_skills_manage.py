# -*- coding: utf-8 -*-
"""技能管理接口：PATCH 启用/停用、DELETE 删除（临时数据目录，不碰用户数据）。"""
import contextlib
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-skills-manage-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.skills import github_install  # noqa: E402

SKILLS = main._skills_registry
CLIENT = TestClient(main.app)
SKILL_ID = "manage-test-skill"
BUILTIN_ID = "builtin-only-skill"


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


class SkillDirCase(unittest.TestCase):
    """每个用例一个临时 skills 目录（只在本用例内替换注册表目录，不污染同进程其它模块）。"""

    def setUp(self):
        root = tempfile.mkdtemp(prefix="novai-skills-manage-case-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        self.skills_dir = os.path.join(root, "skills")
        os.makedirs(self.skills_dir, exist_ok=True)
        patcher = mock.patch.object(SKILLS, "skills_dir", return_value=self.skills_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def skill_file(self, skill_id=SKILL_ID):
        return os.path.join(self.skills_dir, "%s.json" % skill_id)

    def write_skill(self, skill_id=SKILL_ID, enabled=True, **extra):
        data = {"id": skill_id, "name": "管理测试技能", "description": "测试用",
                "skill_prompt": "只回答测试内容", "enabled": enabled, "available": True}
        data.update(extra)
        with open(self.skill_file(skill_id), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        return data

    def read_skill(self, skill_id=SKILL_ID):
        with open(self.skill_file(skill_id), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def listed(self, skill_id):
        skills = {s["id"]: s for s in CLIENT.get("/api/skills").json()["skills"]}
        return skills.get(skill_id)


class SkillPatchTests(SkillDirCase):

    def test_disable_then_enable(self):
        self.write_skill(enabled=True)
        self.assertTrue(self.listed(SKILL_ID)["enabled"])

        response = CLIENT.patch("/api/skills/%s" % SKILL_ID, json={"enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["skill"]["id"], SKILL_ID)
        self.assertFalse(body["skill"]["enabled"])
        self.assertFalse(self.read_skill()["enabled"])
        self.assertFalse(self.listed(SKILL_ID)["enabled"])

        response = CLIENT.patch("/api/skills/%s" % SKILL_ID, json={"enabled": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["skill"]["enabled"])
        self.assertTrue(self.read_skill()["enabled"])
        self.assertTrue(self.listed(SKILL_ID)["enabled"])

    def test_patch_keeps_other_definition_fields(self):
        self.write_skill(enabled=True, license="MIT", allowed_tools=["read_table"])
        response = CLIENT.patch("/api/skills/%s" % SKILL_ID, json={"enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        data = self.read_skill()
        self.assertFalse(data["enabled"])
        self.assertEqual(data["license"], "MIT")
        self.assertEqual(data["allowed_tools"], ["read_table"])
        self.assertEqual(data["skill_prompt"], "只回答测试内容")

    def test_patch_unknown_skill_is_404(self):
        response = CLIENT.patch("/api/skills/no-such-skill", json={"enabled": False})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIn("技能不存在", response.json()["detail"])

    def test_patch_requires_boolean_enabled(self):
        self.write_skill()
        response = CLIENT.patch("/api/skills/%s" % SKILL_ID, json={"enabled": "false"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertTrue(self.read_skill()["enabled"])

    def test_patch_builtin_only_skill_writes_user_override(self):
        builtin = [{"id": BUILTIN_ID, "name": "内置技能", "description": "", "available": True}]
        with mock.patch.object(SKILLS, "load_builtin", return_value=builtin):
            response = CLIENT.patch("/api/skills/%s" % BUILTIN_ID, json={"enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()["skill"]
        self.assertFalse(body["enabled"])
        self.assertEqual(body["skill_type"], "system")
        self.assertTrue(os.path.isfile(self.skill_file(BUILTIN_ID)))
        self.assertFalse(self.read_skill(BUILTIN_ID)["enabled"])


class SkillDeleteTests(SkillDirCase):

    def test_delete_removes_user_skill_file(self):
        self.write_skill()
        self.assertTrue(os.path.isfile(self.skill_file()))

        response = CLIENT.delete("/api/skills/%s" % SKILL_ID)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "deleted": True})
        self.assertFalse(os.path.isfile(self.skill_file()))
        self.assertIsNone(self.listed(SKILL_ID))

        again = CLIENT.delete("/api/skills/%s" % SKILL_ID)
        self.assertEqual(again.status_code, 404, again.text)
        self.assertIn("技能不存在", again.json()["detail"])

    def test_delete_unknown_skill_is_404(self):
        response = CLIENT.delete("/api/skills/no-such-skill")
        self.assertEqual(response.status_code, 404, response.text)

    def test_delete_builtin_only_skill_is_rejected(self):
        builtin = [{"id": BUILTIN_ID, "name": "内置技能", "description": "", "available": True}]
        with mock.patch.object(SKILLS, "load_builtin", return_value=builtin):
            self.assertIsNotNone(SKILLS.get_skill(BUILTIN_ID))    # 只在内置清单里，没有用户文件
            response = CLIENT.delete("/api/skills/%s" % BUILTIN_ID)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("内置技能不能删除", response.json()["detail"])
        self.assertFalse(os.path.isfile(self.skill_file(BUILTIN_ID)))



GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
ENV_TOKEN = "github_pat_11ABCDEFG0123456789_zyxw"


@contextlib.contextmanager
def token_env(data_dir, **extra):
    """令牌相关环境变量先清干净，数据目录指到 /tmp 下的临时目录。"""
    env = {k: v for k, v in os.environ.items()
           if k not in ("NOVAI_GITHUB_TOKEN", "GITHUB_TOKEN", "NOVAI_DATA_DIR",
                         "NOVAI_GITHUB_RELAY", "NOVAI_GITHUB_RELAY_TOKEN")}
    env["NOVAI_DATA_DIR"] = data_dir
    env.update(extra)
    with mock.patch.dict(os.environ, env, clear=True):
        yield


class GithubTokenRouteTests(unittest.TestCase):
    """GET / PUT / DELETE /api/skills/github-token（不联网，check_token 全部 mock）。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-token-route-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.config = os.path.join(self.root, "config.json")

    def saved(self):
        with open(self.config, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_get_without_token(self):
        with token_env(self.root):
            body = CLIENT.get("/api/skills/github-token").json()
        self.assertEqual(body["configured"], False)
        self.assertEqual(body["source"], "")
        self.assertEqual(body["masked"], "")

    @mock.patch("server.routes.agents.github_install.check_token",
                return_value={"limit": 5000, "remaining": 4998})
    def test_put_saves_token_and_reports_quota(self, check):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertNotIn(GITHUB_TOKEN, response.text)          # 响应里没有明文
            self.assertTrue(body["saved"])
            self.assertTrue(body["verified"])
            self.assertEqual(body["limit"], 5000)
            self.assertEqual(body["remaining"], 4998)
            self.assertTrue(body["configured"])
            self.assertEqual(body["source"], "settings")
            self.assertEqual(body["masked"], GITHUB_TOKEN[:4] + "…" + GITHUB_TOKEN[-4:])
            self.assertEqual(self.saved()["github_token"], GITHUB_TOKEN)
            self.assertEqual(stat.S_IMODE(os.stat(self.config).st_mode), 0o600)
            check.assert_called_once_with(GITHUB_TOKEN)

    @mock.patch("server.routes.agents.github_install.check_token",
                return_value={"limit": 5000, "remaining": 4999})
    def test_put_keeps_other_config_keys(self, _check):
        with open(self.config, "w", encoding="utf-8") as fh:
            json.dump({"storage_path": "/data/novai", "theme": "dark"}, fh)
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
        self.assertEqual(response.status_code, 200, response.text)
        data = self.saved()
        self.assertEqual(data["storage_path"], "/data/novai")
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(data["github_token"], GITHUB_TOKEN)

    def test_put_rejects_illegal_token_without_writing(self):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": "too-short"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("令牌", response.json()["detail"])
        self.assertFalse(os.path.exists(self.config))

    @mock.patch("server.routes.agents.github_install.check_token",
                side_effect=github_install.GitHubSkillError("令牌无效或已过期", 400))
    def test_put_rejects_token_github_says_invalid(self, _check):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("令牌无效或已过期", response.json()["detail"])
        self.assertFalse(os.path.exists(self.config))              # 无效令牌不落盘

    @mock.patch("server.routes.agents.github_install.check_token", return_value=None)
    def test_put_saves_when_network_verification_fails(self, _check):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["saved"])
            self.assertFalse(body["verified"])
            self.assertIsNone(body["limit"])
            self.assertTrue(body["message"])
            self.assertEqual(self.saved()["github_token"], GITHUB_TOKEN)

    @mock.patch("server.routes.agents.github_install.check_token",
                side_effect=RuntimeError("thread boom"))
    def test_put_saves_when_verification_raises(self, _check):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["saved"])
            self.assertFalse(body["verified"])
            self.assertIn("thread boom", body["message"])
            self.assertEqual(self.saved()["github_token"], GITHUB_TOKEN)

    @mock.patch("server.routes.agents.github_install.check_token",
                return_value={"limit": 5000, "remaining": 4998})
    def test_env_token_wins_and_is_never_echoed(self, _check):
        with token_env(self.root, NOVAI_GITHUB_TOKEN=ENV_TOKEN):
            CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
            response = CLIENT.get("/api/skills/github-token")
            body = response.json()
            self.assertNotIn(ENV_TOKEN, response.text)
            self.assertNotIn(GITHUB_TOKEN, response.text)
            self.assertEqual(body["source"], "env")
            self.assertEqual(body["masked"], ENV_TOKEN[:4] + "…" + ENV_TOKEN[-4:])
            # 环境变量来源时，DELETE 清不掉也要说明白
            cleared = CLIENT.delete("/api/skills/github-token")
            self.assertEqual(cleared.status_code, 200, cleared.text)
            payload = cleared.json()
            self.assertTrue(payload["configured"])
            self.assertEqual(payload["source"], "env")
            self.assertIn("环境变量优先", payload["message"])
            self.assertNotIn("github_token", self.saved())          # 后台那份已删

    @mock.patch("server.routes.agents.github_install.check_token",
                return_value={"limit": 5000, "remaining": 4998})
    def test_delete_clears_saved_token(self, _check):
        with token_env(self.root):
            CLIENT.put("/api/skills/github-token", json={"token": GITHUB_TOKEN})
            response = CLIENT.delete("/api/skills/github-token")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["configured"], False)
            self.assertEqual(body["source"], "")
            self.assertEqual(body["masked"], "")
            self.assertEqual(body["message"], "已清除后台保存的令牌")
            self.assertNotIn("github_token", self.saved())

    def test_delete_route_is_not_swallowed_by_skill_route(self):
        with token_env(self.root):
            response = CLIENT.delete("/api/skills/github-token")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("configured", response.json())               # 不是「技能不存在」404

    def test_get_reports_masked_token_after_save(self):
        with token_env(self.root):
            with open(self.config, "w", encoding="utf-8") as fh:
                json.dump({"github_token": GITHUB_TOKEN}, fh)
            body = CLIENT.get("/api/skills/github-token").json()
        self.assertTrue(body["configured"])
        self.assertEqual(body["source"], "settings")
        self.assertEqual(body["masked"], GITHUB_TOKEN[:4] + "…" + GITHUB_TOKEN[-4:])



RELAY_URL = "https://relay.example.com"
RELAY_SECRET = "s3cret-relay-token"


class GithubRelayRouteTests(unittest.TestCase):
    """GET / PUT / DELETE /api/skills/github-relay（不联网）。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-relay-route-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.config = os.path.join(self.root, "config.json")

    def saved(self):
        with open(self.config, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_get_unconfigured(self):
        with token_env(self.root):
            body = CLIENT.get("/api/skills/github-relay").json()
        self.assertEqual(body, {"configured": False, "url": "", "masked_secret": ""})

    def test_put_saves_url_and_secret_without_echoing_it(self):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-relay",
                                  json={"url": RELAY_URL + "/", "secret": RELAY_SECRET})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertNotIn(RELAY_SECRET, response.text)          # 不回明文密钥
            self.assertTrue(body["configured"])
            self.assertTrue(body["saved"])
            self.assertEqual(body["url"], RELAY_URL)               # 去掉尾部斜杠
            self.assertEqual(body["masked_secret"], RELAY_SECRET[:4] + "…" + RELAY_SECRET[-4:])
            data = self.saved()
            self.assertEqual(data["github_relay"], RELAY_URL)
            self.assertEqual(data["github_relay_token"], RELAY_SECRET)
            self.assertEqual(stat.S_IMODE(os.stat(self.config).st_mode), 0o600)

    def test_put_allows_local_http_for_selftest(self):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-relay",
                                  json={"url": "http://127.0.0.1:4180"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["url"], "http://127.0.0.1:4180")

    def test_put_rejects_plain_http_public_host(self):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-relay",
                                  json={"url": "http://relay.example.com"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("https://", response.json()["detail"])
        self.assertFalse(os.path.exists(self.config))

    def test_put_rejects_empty_url(self):
        with token_env(self.root):
            response = CLIENT.put("/api/skills/github-relay", json={"url": ""})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("不能为空", response.json()["detail"])

    def test_put_without_secret_keeps_secret(self):
        with token_env(self.root):
            CLIENT.put("/api/skills/github-relay", json={"url": RELAY_URL, "secret": RELAY_SECRET})
            response = CLIENT.put("/api/skills/github-relay",
                                  json={"url": "https://relay2.example.com"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["masked_secret"],
                             RELAY_SECRET[:4] + "…" + RELAY_SECRET[-4:])
            self.assertEqual(self.saved()["github_relay"], "https://relay2.example.com")

    def test_put_empty_secret_clears_it(self):
        with token_env(self.root):
            CLIENT.put("/api/skills/github-relay", json={"url": RELAY_URL, "secret": RELAY_SECRET})
            response = CLIENT.put("/api/skills/github-relay", json={"url": RELAY_URL, "secret": ""})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["masked_secret"], "")
            self.assertNotIn("github_relay_token", self.saved())

    def test_env_relay_wins_and_is_never_echoed(self):
        env = {"NOVAI_GITHUB_RELAY": "https://env-relay.example.com",
               "NOVAI_GITHUB_RELAY_TOKEN": "env-relay-secret"}
        with token_env(self.root, **env):
            body = CLIENT.get("/api/skills/github-relay").json()
            response = CLIENT.get("/api/skills/github-relay")
            self.assertNotIn("env-relay-secret", response.text)
            self.assertEqual(body["url"], "https://env-relay.example.com")
            self.assertEqual(body["masked_secret"], "env-…cret")
            saved = CLIENT.put("/api/skills/github-relay", json={"url": RELAY_URL})
            self.assertIn("环境变量优先", saved.json()["message"])
            cleared = CLIENT.delete("/api/skills/github-relay")
            self.assertTrue(cleared.json()["configured"])
            self.assertIn("环境变量优先", cleared.json()["message"])

    def test_delete_clears_saved_config(self):
        with token_env(self.root):
            CLIENT.put("/api/skills/github-relay", json={"url": RELAY_URL, "secret": RELAY_SECRET})
            response = CLIENT.delete("/api/skills/github-relay")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertFalse(body["configured"])
            self.assertEqual(body["url"], "")
            self.assertEqual(body["message"], "已清除后台保存的中转配置")
            data = self.saved()
            self.assertNotIn("github_relay", data)
            self.assertNotIn("github_relay_token", data)

    def test_delete_route_is_not_swallowed_by_skill_route(self):
        with token_env(self.root):
            response = CLIENT.delete("/api/skills/github-relay")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("configured", response.json())



PACK_SKILL_ID = "fashion-editorial"


class BuiltinPackSkillRouteTests(SkillDirCase):
    """内置技能包：能停用、不能删除（DELETE 400）。"""

    def write_pack_skill(self, enabled=True):
        return self.write_skill(PACK_SKILL_ID, enabled=enabled,
                                builtin_pack=PACK_SKILL_ID, pack_version="abc123",
                                skill_type="system")

    def test_delete_builtin_pack_skill_is_rejected(self):
        self.write_pack_skill()
        response = CLIENT.delete("/api/skills/%s" % PACK_SKILL_ID)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"], "内置技能不能删除（可以停用）")
        self.assertTrue(os.path.isfile(self.skill_file(PACK_SKILL_ID)))    # 文件还在

    def test_builtin_pack_skill_can_be_disabled_but_not_deleted(self):
        self.write_pack_skill()
        response = CLIENT.patch("/api/skills/%s" % PACK_SKILL_ID, json={"enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()["skill"]
        self.assertFalse(body["enabled"])
        self.assertEqual(body["builtin_pack"], PACK_SKILL_ID)             # 标记没丢
        self.assertFalse(self.read_skill(PACK_SKILL_ID)["enabled"])
        again = CLIENT.delete("/api/skills/%s" % PACK_SKILL_ID)
        self.assertEqual(again.status_code, 400, again.text)

    def test_list_exposes_builtin_pack_marker(self):
        self.write_pack_skill()
        self.assertEqual(self.listed(PACK_SKILL_ID)["builtin_pack"], PACK_SKILL_ID)

    def test_normal_user_skill_is_still_deletable(self):
        self.write_skill()
        response = CLIENT.delete("/api/skills/%s" % SKILL_ID)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(os.path.isfile(self.skill_file(SKILL_ID)))


if __name__ == "__main__":
    unittest.main()
