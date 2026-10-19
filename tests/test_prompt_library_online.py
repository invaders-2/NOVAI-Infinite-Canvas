# -*- coding: utf-8 -*-
"""prompt_library 在线提示词库代理单测（不联网：monkeypatch fetch_page）。

覆盖：正常聚合、q 过滤（不区分大小写）、分页、缓存命中不重复抓、上游失败无缓存→502、
refresh 强制刷新、失败页数容忍/超限、磁盘缓存未过期时 stale 兜底、过期时 502。

跑法：
    venv/bin/python -m pytest tests/test_prompt_library_online.py -q
    venv/bin/python -m unittest tests.test_prompt_library_online -v
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.routes import prompt_library as pl  # noqa: E402


def make_card(card_id, zh_title, zh_prompt, zh_remark=""):
    return {
        "id": card_id,
        "attributes": {
            "zh": {
                "title": zh_title,
                "prompt": zh_prompt,
                "remark": zh_remark,
                "description": "",
            },
            "en": {
                "title": "EN " + zh_title,
                "prompt": "EN " + zh_prompt,
                "remark": "",
                "description": "",
            },
            "tags": ["tag-a", {"name": "tag-b"}],
            "count": card_id % 7,
        },
    }


def make_pages(total=279, per_page=25):
    cards = [
        make_card(i + 1, "标题 %d watercolor" % (i + 1), "prompt body %d" % (i + 1), "remark %d" % (i + 1))
        for i in range(total)
    ]
    page_count = (total + per_page - 1) // per_page
    pages = []
    for index in range(page_count):
        chunk = cards[index * per_page:(index + 1) * per_page]
        pages.append({
            "data": chunk,
            "meta": {"pagination": {"page": index + 1, "pageCount": page_count, "total": total}},
        })
    return pages, page_count


class PromptLibraryOnlineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NOVAI_DATA_DIR": self.tmp.name})
        self.env.start()
        pl.reset_memory_cache()
        self.pages, self.page_count = make_pages()
        self.calls = []
        self.fetch = self._fetch_ok
        self.patch_fetch = patch.object(pl, "fetch_page", side_effect=self._dispatch)
        self.patch_fetch.start()

    def tearDown(self):
        self.patch_fetch.stop()
        self.env.stop()
        self.tmp.cleanup()
        pl.reset_memory_cache()

    async def _fetch_ok(self, page):
        return self.pages[page - 1]

    async def _dispatch(self, page):
        self.calls.append(page)
        return await self.fetch(page)

    def run_online(self, **kwargs):
        return asyncio.run(pl.online_prompt_library(**kwargs))

    # ------------------------------------------------------------ 正常聚合

    def test_aggregates_all_pages_and_projects(self):
        res = self.run_online()
        self.assertTrue(res["ok"])
        self.assertEqual(res["source"], "aishort")
        self.assertEqual(res["total"], 279 + len(pl.LOCAL_ECOMMERCE_PROMPTS))
        self.assertEqual(res["page"], 1)
        self.assertEqual(res["pageSize"], 30)
        self.assertEqual(res["pageCount"], 10)
        self.assertEqual(len(res["items"]), 30)
        first = res["items"][0]
        self.assertEqual(first["id"], "1")
        self.assertEqual(first["url"], "https://www.aishort.top/community-prompt/1")
        self.assertEqual(first["title"], "标题 1 watercolor")
        self.assertEqual(first["tags"], ["tag-a", "tag-b"])
        self.assertEqual(first["count"], 1)
        self.assertEqual(self.calls, list(range(1, 13)))
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, "data", pl.CACHE_FILE_NAME)))
        self.assertFalse(res["stale"])
        self.assertIsNotNone(res["updatedAt"])
        self.assertIsInstance(res["ageSeconds"], int)
        self.assertGreaterEqual(res["ageSeconds"], 0)
        self.assertEqual(res["matchMode"], "none")
        self.assertEqual(res["expandedTerms"], [])

    def test_lang_switch_and_invalid_lang_fallback(self):
        en = self.run_online(lang="en")
        self.assertTrue(en["items"][0]["title"].startswith("EN "))
        zh = self.run_online(lang="xx")
        self.assertEqual(zh["items"][0]["title"], "标题 1 watercolor")

    # ------------------------------------------------------------ q 过滤

    def test_q_filter_is_case_insensitive(self):
        self.pages[0]["data"][0]["attributes"]["zh"]["remark"] = "UniqueNeedle Alpha"
        res = self.run_online(q="uniqueneedle")
        self.assertEqual(res["total"], 1)
        self.assertEqual(res["items"][0]["id"], "1")
        prompt_res = self.run_online(q="PROMPT BODY 1")
        self.assertGreater(prompt_res["total"], 0)
        self.assertTrue(all("prompt body 1" in item["prompt"].lower() for item in prompt_res["items"]))
        fuzzy_or_none = self.run_online(q="no-such-prompt-xyz")
        self.assertIn(fuzzy_or_none["matchMode"], ("fuzzy", "none"))
        self.assertEqual(fuzzy_or_none["expandedTerms"], [])

    # ------------------------------------------------------------ 分页

    def test_pagination(self):
        page1 = self.run_online(page=1, pageSize=100)
        self.assertEqual(page1["pageCount"], 3)
        self.assertEqual(len(page1["items"]), 100)
        page3 = self.run_online(page=3, pageSize=100)
        self.assertEqual(len(page3["items"]), 89)
        beyond = self.run_online(page=4, pageSize=100)
        self.assertEqual(beyond["items"], [])
        capped = self.run_online(page=1, pageSize=999)
        self.assertEqual(capped["pageSize"], 100)

    # ------------------------------------------------------------ tag 过滤

    def _set_tags(self, index, tags):
        self.pages[0]["data"][index]["attributes"]["tags"] = tags

    def run_categories(self, **kwargs):
        return asyncio.run(pl.online_prompt_library_categories(**kwargs))

    def test_tag_filter_single_and_case_insensitive(self):
        self._set_tags(0, ["write", "ai"])
        self._set_tags(1, ["write"])
        self._set_tags(2, ["ai"])
        res = self.run_online(tag="write")
        self.assertEqual(res["total"], 2)
        self.assertEqual([item["id"] for item in res["items"]], ["1", "2"])
        upper = self.run_online(tag="WRITE")
        self.assertEqual(upper["total"], 2)
        unknown = self.run_online(tag="no-such-tag")
        self.assertEqual(unknown["total"], 0)
        self.assertEqual(unknown["items"], [])

    def test_tag_combines_with_q(self):
        self._set_tags(0, ["write", "ai"])
        self.pages[0]["data"][0]["attributes"]["zh"]["remark"] = "UniqueNeedle Alpha"
        self._set_tags(1, ["write"])
        res = self.run_online(tag="write", q="uniqueneedle")
        self.assertEqual(res["total"], 1)
        self.assertEqual(res["items"][0]["id"], "1")
        other = self.run_online(tag="ai", q="uniqueneedle")
        self.assertEqual(other["total"], 1)

    # ------------------------------------------------------------ 分类统计

    def test_categories_counts_and_sort(self):
        cards = [
            make_card(1, "A", "pa"),
            make_card(2, "B", "pb"),
            make_card(3, "C", "pc"),
            make_card(4, "D", "pd"),
        ]
        tags_by_id = {1: ["write", "ai"], 2: ["write"], 3: ["write", "ai", "code"], 4: ["code"]}
        for card in cards:
            card["attributes"]["tags"] = tags_by_id[card["id"]]
        self.pages = [{"data": cards, "meta": {"pagination": {"page": 1, "pageCount": 1, "total": 4}}}]
        res = self.run_categories()
        self.assertTrue(res["ok"])
        self.assertEqual(res["total"], 4 + len(pl.LOCAL_ECOMMERCE_PROMPTS))
        lookup = {entry["key"]: entry["count"] for entry in res["items"]}
        self.assertEqual(lookup.get("ecommerce"), 10)  # 本地精选 tags
        # write/code 被别名合并：只留 writing/coding，count 为虚拟命中 ∪ 真实 tag 命中
        self.assertNotIn("write", lookup)
        self.assertNotIn("code", lookup)
        local_writing = [
            prompt for prompt in pl.LOCAL_ECOMMERCE_PROMPTS
            if pl.matches_virtual_category(prompt, pl.VIRTUAL_CATEGORIES["writing"])
        ]
        self.assertEqual(lookup.get("writing"), 3 + len(local_writing))
        self.assertEqual(lookup.get("coding"), 2)
        self.assertEqual(lookup.get("ai"), 2)
        pairs = [(entry["count"], entry["key"]) for entry in res["items"]]
        self.assertEqual(pairs, sorted(pairs, key=lambda pair: (-pair[0], pair[1])))
        self.assertFalse(res["stale"])
        self.assertIsNotNone(res["updatedAt"])
        self.assertIsInstance(res["ageSeconds"], int)

    def test_categories_upstream_empty_still_has_local_prompts(self):
        self.pages = [{"data": [], "meta": {"pagination": {"page": 1, "pageCount": 1, "total": 0}}}]
        res = self.run_categories()
        self.assertTrue(res["ok"])
        self.assertEqual(res["total"], len(pl.LOCAL_ECOMMERCE_PROMPTS))
        lookup = {entry["key"]: entry["count"] for entry in res["items"]}
        self.assertEqual(lookup.get("ecommerce"), len(pl.LOCAL_ECOMMERCE_PROMPTS))

    def test_categories_upstream_failure_returns_502(self):
        async def boom(page):
            raise RuntimeError("upstream down")

        self.fetch = boom
        res = self.run_categories()
        self.assertEqual(res.status_code, 502)
        body = json.loads(res.body.decode("utf-8"))
        self.assertFalse(body["ok"])

    def test_aliases_merge_chips_and_union_count(self):
        cards = [
            make_card(1, "标签写作", "tagged write"),
            make_card(2, "文章润色", "text"),
            make_card(3, "写作助手", "text"),
        ]
        cards[0]["attributes"]["tags"] = ["write"]
        cards[1]["attributes"]["tags"] = ["write"]
        cards[2]["attributes"]["tags"] = []
        self._set_pages(cards)
        res = self.run_categories()
        lookup = {entry["key"]: entry["count"] for entry in res["items"]}
        self.assertIn("writing", lookup)
        self.assertNotIn("write", lookup)  # 被合并掉，不再单独输出
        local_writing = {
            prompt["id"] for prompt in pl.LOCAL_ECOMMERCE_PROMPTS
            if pl.matches_virtual_category(prompt, pl.VIRTUAL_CATEGORIES["writing"])
        }
        expected_union = {"1", "2", "3"} | local_writing
        self.assertEqual(lookup.get("writing"), len(expected_union))
        self.assertGreater(lookup.get("writing"), 3)  # 并集 > 真实 tag 命中 3
        self.assertEqual(lookup.get("ecommerce"), 10)  # 其它 tag 不受影响

    def test_alias_chips_do_not_duplicate_labels(self):
        cards = [
            make_card(1, "写作助手", "text"),
            make_card(2, "编程助手", "text"),
            make_card(3, "翻译助手", "text"),
            make_card(4, "教育助手", "text"),
        ]
        tags_by_id = {1: ["write"], 2: ["code"], 3: ["interpreter"], 4: ["pedagogy"]}
        for card in cards:
            card["attributes"]["tags"] = tags_by_id[card["id"]]
        self._set_pages(cards)
        res = self.run_categories()
        chip_keys = {entry["key"].lower() for entry in res["items"]}
        for virtual_key, aliases in pl.VIRTUAL_TAG_ALIASES.items():
            self.assertIn(virtual_key, chip_keys)
            for alias in aliases:
                self.assertNotIn(alias, chip_keys)
        self.assertEqual(
            {"writing", "coding", "translation", "education"} & chip_keys,
            {"writing", "coding", "translation", "education"},
        )

    def test_contribute_hidden_in_categories_but_tag_request_works(self):
        cards = [make_card(1, "投稿", "text"), make_card(2, "投稿", "text")]
        cards[0]["attributes"]["tags"] = ["contribute"]
        cards[1]["attributes"]["tags"] = ["contribute"]
        self._set_pages(cards)
        res = self.run_categories()
        chip_keys = {entry["key"].lower() for entry in res["items"]}
        self.assertNotIn("contribute", chip_keys)
        tag_res = self.run_online(tag="contribute")
        self.assertEqual(tag_res["total"], 2)

    # ------------------------------------------------------------ 智能搜索

    def _set_pages(self, cards):
        self.pages = [{"data": cards, "meta": {"pagination": {"page": 1, "pageCount": 1, "total": len(cards)}}}]

    def _local_ids(self):
        return [prompt["id"] for prompt in pl.LOCAL_ECOMMERCE_PROMPTS]

    def test_local_prompts_in_default_list(self):
        tail = self.run_online(page=10, pageSize=30)
        ids = [item["id"] for item in tail["items"]]
        for local_id in self._local_ids():
            self.assertIn(local_id, ids)
        locals_ = [item for item in tail["items"] if item["source"] == "local"]
        self.assertEqual(len(locals_), len(pl.LOCAL_ECOMMERCE_PROMPTS))
        for item in locals_:
            self.assertEqual(item["url"], "")
            self.assertEqual(item["tags"], ["ecommerce"])
            self.assertEqual(item["count"], 0)
            self.assertTrue(item["prompt"])

    def test_exact_match_mode(self):
        res = self.run_online(q="口播", pageSize=100)
        self.assertEqual(res["matchMode"], "exact")
        self.assertEqual(res["expandedTerms"], [])
        self.assertIn("local-ecom-7", [item["id"] for item in res["items"]])

    def test_ecommerce_query_includes_local_prompts(self):
        res = self.run_online(q="电商", pageSize=50)
        self.assertEqual(res["matchMode"], "expanded")
        self.assertIn("电商", res["expandedTerms"])
        self.assertGreaterEqual(res["total"], len(pl.LOCAL_ECOMMERCE_PROMPTS))
        ids = [item["id"] for item in res["items"]]
        self.assertEqual(ids[:len(pl.LOCAL_ECOMMERCE_PROMPTS)], self._local_ids())
        self.assertEqual(
            [item["title"] for item in res["items"][:3]],
            ["商品主图构图方案", "详情页文案结构", "差异化卖点提炼"],
        )

    def test_expanded_synonyms_for_non_ecommerce_query(self):
        self.pages[0]["data"][0]["attributes"]["zh"]["title"] = "Resume Builder"
        res = self.run_online(q="简历")
        self.assertEqual(res["matchMode"], "expanded")
        self.assertIn("resume", res["expandedTerms"])
        self.assertEqual(res["items"][0]["id"], "1")

    def test_fuzzy_match_mode(self):
        res = self.run_online(q="主 图", pageSize=100)
        self.assertEqual(res["matchMode"], "fuzzy")
        self.assertEqual(res["expandedTerms"], [])
        self.assertGreater(res["total"], 0)

    def test_none_match_mode(self):
        res = self.run_online(q="qxzv")
        self.assertEqual(res["matchMode"], "none")
        self.assertEqual(res["items"], [])

    # ------------------------------------------------------------ 虚拟分类

    def test_ecommerce_tag_returns_exactly_local_prompts(self):
        res = self.run_online(tag="ecommerce", pageSize=50)
        self.assertEqual(res["total"], len(pl.LOCAL_ECOMMERCE_PROMPTS))
        self.assertEqual([item["id"] for item in res["items"]], self._local_ids())
        self.assertEqual(res["matchMode"], "none")
        for item in res["items"]:
            self.assertEqual(item["source"], "local")
            self.assertEqual(item["url"], "")
            self.assertEqual(item["tags"], ["ecommerce"])
            self.assertEqual(item["count"], 0)
            self.assertTrue(item["title"])
            self.assertTrue(item["prompt"])

    def test_virtual_categories_counts_and_sort(self):
        cards = [
            make_card(1, "淘宝主图设计", "电商海报"),
            make_card(2, "亚马逊 listing", "跨境电商选品"),
            make_card(3, "视频剪辑", "短视频脚本"),
            make_card(4, "写作助手", "文章润色"),
            make_card(5, "Python 编程", "代码检查"),
            make_card(6, "翻译助手", "中英互译"),
            make_card(7, "教育场景", "教学大纲"),
            make_card(8, "品牌推广", "广告创意"),
        ]
        self._set_pages(cards)
        res = self.run_categories()
        lookup = {entry["key"]: entry["count"] for entry in res["items"]}
        self.assertEqual(lookup.get("ecommerce"), len(pl.LOCAL_ECOMMERCE_PROMPTS))
        self.assertEqual(lookup.get("video"), 1)
        self.assertEqual(lookup.get("coding"), 1)
        self.assertEqual(lookup.get("translation"), 1)
        self.assertEqual(lookup.get("education"), 1)
        self.assertGreaterEqual(lookup.get("writing", 0), 1)
        self.assertGreaterEqual(lookup.get("marketing", 0), 1)
        pairs = [(entry["count"], entry["key"]) for entry in res["items"]]
        self.assertEqual(pairs, sorted(pairs, key=lambda pair: (-pair[0], pair[1])))

    def test_virtual_category_does_not_duplicate_real_tag(self):
        cards = [
            make_card(1, "视频剪辑", "短视频"),
            make_card(2, "视频生成", "剪辑"),
            make_card(3, "视频教程", "无标签"),
        ]
        cards[0]["attributes"]["tags"] = ["video"]
        cards[1]["attributes"]["tags"] = ["video"]
        self._set_pages(cards)
        res = self.run_categories()
        video_entries = [entry for entry in res["items"] if entry["key"] == "video"]
        self.assertEqual(len(video_entries), 1)  # 真实 tag 优先，不重复追加
        self.assertEqual(video_entries[0]["count"], 2)  # 真实 tag 命中数（虚拟本会算 3）

    # ------------------------------------------------------------ TTL / 元信息

    def test_ttl_is_one_hour(self):
        self.assertEqual(pl.CACHE_TTL_SECONDS, 3600)

    def test_updated_at_and_age_seconds(self):
        base_time = 1_700_000_000.0
        with patch.object(pl, "_now", return_value=base_time):
            first = self.run_online()
        expected_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base_time))
        self.assertEqual(first["updatedAt"], expected_iso)
        self.assertEqual(first["ageSeconds"], 0)
        self.assertFalse(first["stale"])
        with patch.object(pl, "_now", return_value=base_time + 120):
            second = self.run_online()
        self.assertEqual(second["updatedAt"], expected_iso)
        self.assertEqual(second["ageSeconds"], 120)
        self.assertEqual(len(self.calls), 12)  # 仍在 TTL 内，不重抓

    def test_memory_cache_expires_after_ttl(self):
        base_time = 1_700_000_000.0
        with patch.object(pl, "_now", return_value=base_time):
            self.run_online()
        self.assertEqual(len(self.calls), 12)
        with patch.object(pl, "_now", return_value=base_time + pl.CACHE_TTL_SECONDS - 10):
            self.run_online()
        self.assertEqual(len(self.calls), 12)  # 未过期命中缓存
        with patch.object(pl, "_now", return_value=base_time + pl.CACHE_TTL_SECONDS + 10):
            refreshed = self.run_online()
        self.assertEqual(len(self.calls), 24)  # 过期后重新抓
        self.assertEqual(refreshed["ageSeconds"], 0)  # 刚重抓，age 归零

    def test_categories_refresh_forces_refetch(self):
        with patch.object(pl, "_now", return_value=1_700_000_000.0):
            first = self.run_categories()
        self.assertEqual(len(self.calls), 12)
        self.assertIsNotNone(first["updatedAt"])
        with patch.object(pl, "_now", return_value=1_700_000_100.0):
            second = self.run_categories(refresh=True)
        self.assertEqual(len(self.calls), 24)
        self.assertEqual(second["ageSeconds"], 0)  # refresh 后刚抓取，age 归零
        self.assertFalse(second["stale"])

    # ------------------------------------------------------------ 缓存

    def test_cache_hit_does_not_fetch_again(self):
        first = self.run_online()
        second = self.run_online()
        self.assertEqual(first["total"], second["total"])
        self.assertEqual(len(self.calls), 12)  # 第二次走缓存

    def test_refresh_forces_refetch(self):
        self.run_online()
        self.assertEqual(len(self.calls), 12)
        self.run_online(refresh=True)
        self.assertEqual(len(self.calls), 24)

    # ------------------------------------------------------------ 上游失败

    def test_upstream_failure_without_cache_returns_502(self):
        async def boom(page):
            raise RuntimeError("upstream down")

        self.fetch = boom
        res = self.run_online()
        self.assertEqual(res.status_code, 502)
        body = json.loads(res.body.decode("utf-8"))
        self.assertFalse(body["ok"])
        self.assertTrue(body["error"])

    def test_two_failed_pages_tolerated(self):
        broken = {3, 5}

        async def partial(page):
            if page in broken:
                raise RuntimeError("page %d down" % page)
            return self.pages[page - 1]

        self.fetch = partial
        res = self.run_online()
        self.assertTrue(res["ok"])
        self.assertEqual(res["total"], 279 - len(broken) * 25 + len(pl.LOCAL_ECOMMERCE_PROMPTS))

    def test_more_than_two_failed_pages_returns_502(self):
        broken = {2, 3, 4}

        async def partial(page):
            if page in broken:
                raise RuntimeError("page %d down" % page)
            return self.pages[page - 1]

        self.fetch = partial
        res = self.run_online()
        self.assertEqual(res.status_code, 502)
        body = json.loads(res.body.decode("utf-8"))
        self.assertFalse(body["ok"])

    # ------------------------------------------------------------ 磁盘缓存兜底

    def _cached_item(self):
        return {
            "id": "999",
            "zh": {"title": "缓存标题", "remark": "", "description": "", "prompt": "缓存 prompt"},
            "en": {"title": "Cached", "remark": "", "description": "", "prompt": "cached prompt"},
            "tags": ["cached"],
            "count": 3,
            "url": "https://www.aishort.top/community-prompt/999",
        }

    def test_fresh_disk_cache_served_with_stale_on_upstream_failure(self):
        base_time = 1_700_000_000.0
        with patch.object(pl, "_now", return_value=base_time):
            pl._write_disk_cache([self._cached_item()], base_time)
        pl.reset_memory_cache()

        async def boom(page):
            raise RuntimeError("upstream down")

        self.fetch = boom
        with patch.object(pl, "_now", return_value=base_time + 60):
            res = self.run_online()
        self.assertTrue(res["ok"])
        self.assertTrue(res.get("stale"))
        self.assertEqual(res["total"], 1 + len(pl.LOCAL_ECOMMERCE_PROMPTS))
        self.assertEqual(res["items"][0]["title"], "缓存标题")

    def test_expired_disk_cache_with_upstream_failure_returns_502(self):
        base_time = 1_700_000_000.0
        with patch.object(pl, "_now", return_value=base_time):
            pl._write_disk_cache([self._cached_item()], base_time)
        pl.reset_memory_cache()

        async def boom(page):
            raise RuntimeError("upstream down")

        self.fetch = boom
        expired_time = base_time + pl.CACHE_TTL_SECONDS + 10
        with patch.object(pl, "_now", return_value=expired_time):
            res = self.run_online()
        self.assertEqual(res.status_code, 502)


if __name__ == "__main__":
    unittest.main()
