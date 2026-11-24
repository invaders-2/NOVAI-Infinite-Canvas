# -*- coding: utf-8 -*-
"""画布图片 / 视频的画面描述：缓存查找、进画布地图 / read_node / 快照、运行开始补描述。

覆盖：
- 只读缓存，文件 mtime 变了才重读；
- 有描述时 map_line 显示「画面：…」，detail 和 BEAT 快照带 visual；
- 补描述目标：选中 / 引用（含分组成员）优先，其次没提示词的，已描述的跳过，限量；
- NOVAI_AGENT_AUTO_CAPTION=0 或没有看图模型时不补；超时不取消后台任务；
- 补描述出错不影响运行结束。
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-captions-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import read_tools  # noqa: E402
from tests.test_agent_fix_main_wiring import chat_config, flags, make_req, run_producer  # noqa: E402

URL_A = "https://example.invalid/cap-a.png"
URL_B = "https://example.invalid/cap-b.png"
URL_C = "https://example.invalid/cap-c.png"
FRAME = "https://example.invalid/cap-video-frame.jpg"


def image(nid, url, prompt="", created=0, x=0):
    return {"id": nid, "kind": "image", "x": x, "y": 0, "created_at": created,
            "data": {"gen": {"title": nid, "prompt": prompt, "hist": [{"url": url}], "hi": 0}}}


def video(nid):
    return {"id": nid, "kind": "video", "x": 0, "y": 400,
            "data": {"gen": {"title": nid, "prompt": "", "hist": [{"url": "https://example.invalid/v.mp4",
                                                                      "frame": FRAME}], "hi": 0}}}


class CaptionCacheMixin:
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="novai-cap-cache-")
        self.file = os.path.join(self.dir, "agent_image_captions.json")
        self._patch = patch.object(main, "AGENT_CAPTIONS_FILE", self.file)
        self._patch.start()
        main._AGENT_CAPTIONS_MEMO.update({"mtime": None, "data": {}})
        main._AGENT_CAPTION_INFLIGHT.clear()

    def tearDown(self):
        self._patch.stop()
        main._AGENT_CAPTIONS_MEMO.update({"mtime": None, "data": {}})

    def write_cache(self, mapping, bump=0):
        data = {main._agent_caption_key(url): {"caption": cap, "at": time.time()} for url, cap in mapping.items()}
        with open(self.file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        if bump:
            st = os.stat(self.file)
            os.utime(self.file, (st.st_atime, st.st_mtime + bump))


class LookupTests(CaptionCacheMixin, unittest.TestCase):
    def test_lookup_reads_cache_and_refreshes_on_mtime(self):
        self.assertEqual(main._agent_canvas_caption_lookup(URL_A), "")
        self.write_cache({URL_A: "一双棕色  雪地靴\n放在木地板上"})
        self.assertEqual(main._agent_canvas_caption_lookup(URL_A), "一双棕色 雪地靴 放在木地板上")
        self.write_cache({URL_A: "换成了白色运动鞋"}, bump=5)
        self.assertEqual(main._agent_canvas_caption_lookup(URL_A), "换成了白色运动鞋")

    def test_lookup_truncates_long_caption(self):
        self.write_cache({URL_A: "字" * 500})
        got = main._agent_canvas_caption_lookup(URL_A)
        self.assertEqual(len(got), main.AGENT_CAPTION_SHORT + 1)
        self.assertTrue(got.endswith("…"))

    def test_read_tools_wired_to_lookup(self):
        self.assertIs(read_tools._CAPTION_LOOKUP, main._agent_canvas_caption_lookup)


class InjectionTests(CaptionCacheMixin, unittest.TestCase):
    def test_map_line_detail_and_snapshot_show_visual(self):
        self.write_cache({URL_A: "红色背景上的保温杯", FRAME: "女生在雪地里走路"})
        access = read_tools.CanvasAccess()
        img, vid = image("i1", URL_A, prompt="产品图"), video("v1")
        canvas = {"id": "c", "nodes": [img, vid], "connections": []}
        self.assertIn("画面：红色背景上的保温杯", access.map_line(img))
        self.assertIn("画面：女生在雪地里走路", access.map_line(vid))
        self.assertEqual(access.detail(canvas, img).get("visual"), "红色背景上的保温杯")
        self.assertEqual(main._agent_beat_node_summary(img, canvas).get("visual"), "红色背景上的保温杯")

    def test_no_caption_falls_back_to_prompt(self):
        access = read_tools.CanvasAccess()
        img = image("i1", URL_B, prompt="产品图")
        self.assertNotIn("画面：", access.map_line(img))
        self.assertIn("产品图", access.map_line(img))
        self.assertNotIn("visual", access.detail({"nodes": [img], "connections": []}, img))


class TargetTests(CaptionCacheMixin, unittest.TestCase):
    def canvas(self):
        group = {"id": "g1", "kind": "group", "children": ["i3"], "x": 0, "y": 0, "w": 10, "h": 10, "data": {}}
        return {"id": "c", "nodes": [
            image("i1", URL_A, prompt="有提示词", created=3),
            image("i2", URL_B, prompt="", created=1),
            image("i3", URL_C, prompt="有提示词", created=2),
            video("v1"), group]}

    def test_focus_first_then_no_prompt(self):
        focus = main._agent_run_normalize_focus({"selected_node_ids": ["g1"]})
        urls = [t["url"] for t in main._agent_canvas_caption_targets(self.canvas(), focus)]
        self.assertEqual(urls[0], URL_C, "分组成员算选中，排第一")
        self.assertLess(urls.index(URL_B), urls.index(URL_A), "没提示词的上传图排在有提示词的前面")
        self.assertIn(FRAME, urls, "视频用封面帧")

    def test_skips_cached_and_respects_limit(self):
        self.write_cache({URL_B: "已经描述过"})
        urls = [t["url"] for t in main._agent_canvas_caption_targets(self.canvas(), None)]
        self.assertNotIn(URL_B, urls)
        self.assertEqual(len(main._agent_canvas_caption_targets(self.canvas(), None, limit=1)), 1)


class AutoCaptionTests(CaptionCacheMixin, unittest.TestCase):
    def canvas(self):
        return {"id": "c", "nodes": [image("i1", URL_A), image("i2", URL_B)]}

    def test_switch_off(self):
        calls = []

        async def fake(images, *a, **k):
            calls.append(images)
            return ["x"], None
        with patch.dict(os.environ, {"NOVAI_AGENT_AUTO_CAPTION": "0"}), \
                patch.object(main, "_agent_caption_images", new=fake), \
                patch.object(main, "_agent_vision_candidates", new=lambda *a: [{"model": "v"}]):
            self.assertEqual(asyncio.run(main._agent_run_auto_caption(self.canvas())), 0)
        self.assertEqual(calls, [])

    def test_no_vision_model_is_quiet(self):
        with patch.object(main, "_agent_vision_candidates", new=lambda *a: []):
            self.assertEqual(asyncio.run(main._agent_run_auto_caption(self.canvas())), 0)

    def test_captions_new_images_and_emits(self):
        seen, events = [], []

        async def fake(images, *a, **k):
            seen.extend(i["url"] for i in images)
            return ["ok"], None
        with patch.object(main, "_agent_caption_images", new=fake), \
                patch.object(main, "_agent_vision_candidates", new=lambda *a: [{"model": "v"}]):
            n = asyncio.run(main._agent_run_auto_caption(self.canvas(), emit=lambda e, d: events.append((e, d))))
        self.assertEqual(n, 2)
        self.assertEqual(sorted(seen), sorted([URL_A, URL_B]))
        self.assertTrue(any(d.get("kind") == "auto_caption" for _, d in events))
        self.assertEqual(main._AGENT_CAPTION_INFLIGHT, set())

    def test_timeout_does_not_cancel(self):
        finished = []

        async def slow(images, *a, **k):
            await asyncio.sleep(0.3)
            finished.append(images[0]["url"])
            return ["ok"], None

        async def go():
            n = await main._agent_run_auto_caption(self.canvas(), wait=0.05)
            await asyncio.sleep(0.5)
            return n
        with patch.object(main, "_agent_caption_images", new=slow), \
                patch.object(main, "_agent_vision_candidates", new=lambda *a: [{"model": "v"}]):
            n = asyncio.run(go())
        self.assertEqual(n, 0, "超时返回 0")
        self.assertEqual(len(finished), 2, "后台任务继续做完")

    def test_one_failure_does_not_stop_others(self):
        async def flaky(images, *a, **k):
            if images[0]["url"] == URL_A:
                raise RuntimeError("看图失败")
            return ["ok"], None
        with patch.object(main, "_agent_caption_images", new=flaky), \
                patch.object(main, "_agent_vision_candidates", new=lambda *a: [{"model": "v"}]):
            self.assertEqual(asyncio.run(main._agent_run_auto_caption(self.canvas())), 1)


class ProducerTests(CaptionCacheMixin, unittest.TestCase):
    def test_caption_error_does_not_break_run(self):
        canvas_id = "c-cap-" + uuid.uuid4().hex[:8]
        main.save_canvas({"id": canvas_id, "title": "描述", "kind": "beat",
                          "updated_at": int(time.time() * 1000),
                          "nodes": [image("i1", URL_A)], "connections": []})

        async def boom(*a, **k):
            raise RuntimeError("caption boom")

        async def decide(chat, messages, canvas_id, tools_json_text="", tools=None, rebuild_json=None):
            return {"done": True, "message": "完成"}
        with flags(CONTEXT="1"), \
                patch.object(main, "_agent_run_auto_caption", new=boom), \
                patch.object(main, "_agent_run_decide_v2", new=decide):
            events = run_producer(make_req(canvas_id, chat=chat_config(), renderer="beat"))
        done = [e for e in events if e["event"] == "done"][-1]["data"]
        self.assertEqual(done.get("status"), "ok")


if __name__ == "__main__":
    unittest.main()
