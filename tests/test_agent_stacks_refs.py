# -*- coding: utf-8 -*-
"""画布助手 @ 多个堆叠：每个堆叠都要取到自己的参考图，标签要能区分。

现场：同时 @「服搭堆叠 + 人物堆叠 + 产品白底图堆叠」，发出去全变成第一个堆叠的东西。
根因（复现出来的）：_agent_run_collect_images 用 _agent_media_items 逐个节点取图，而 group 节点在
_agent_beat_media_items 里直接返回 []（只认 image/video/audio）→ 堆叠在看图链路里一张图都取不到，
再加上 focus 文本里堆叠标题可能都是空的，模型只能瞎猜，最后全用了第一个堆叠。

画布数据全在内存，不读写仓库 data/、不连上游。
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-stack-refs-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


STACKS = {
    "stack_outfit": ("服搭堆叠", {"o1", "o2"}),
    "stack_person": ("人物堆叠", {"p1", "p2", "p3"}),
    "stack_product": ("产品白底图堆叠", {"w1", "w2"}),
}


def _img(nid, url):
    return {"id": nid, "kind": "image", "x": 0, "y": 0, "w": 200, "h": 200, "url": url,
            "data": {"gen": {"title": nid, "params": {}, "hist": [{"url": url}], "hi": 0}}}


def _stack(nid, title, children, x=0):
    return {"id": nid, "kind": "group", "x": x, "y": 0, "w": 240, "h": 240,
            "children": children, "data": {"stack": True, "gen": {"title": title}}}


def canvas():
    """三个堆叠（各自的成员 url 不同）+ 一个普通分组 + 一张单独图片，叠内顺序和 y 都打乱过。"""
    return {
        "id": "c1", "kind": "classic", "title": "多堆叠引用测试", "updated_at": 1700000000000,
        "nodes": [
            _stack("stack_outfit", "服搭堆叠", ["o1", "o2"], x=0),
            _img("o1", "/assets/o1.png"), _img("o2", "/assets/o2.png"),
            _stack("stack_person", "人物堆叠", ["p1", "p2", "p3"], x=600),
            _img("p1", "/assets/p1.png"), _img("p2", "/assets/p2.png"), _img("p3", "/assets/p3.png"),
            _stack("stack_product", "产品白底图堆叠", ["w1", "w2"], x=1200),
            _img("w1", "/assets/w1.png"), _img("w2", "/assets/w2.png"),
            # 普通分组（按画布位置排序展开）：成员故意逆序摆放
            {"id": "plain", "kind": "group", "x": 1800, "y": 0, "w": 240, "h": 240,
             "children": ["n_b", "n_a"], "data": {"gen": {"title": "普通分组"}}},
            dict(_img("n_b", "/assets/n_b.png"), y=300),
            dict(_img("n_a", "/assets/n_a.png"), y=0),
            # 单独节点：行为不许变
            _img("solo", "/assets/solo.png"),
        ],
        "connections": [],
    }


def focus(selected=None, references=None):
    return main._agent_run_normalize_focus({
        "selected_node_ids": list(selected if selected is not None else STACKS.keys()),
        "references": references or [],
    })


def collect(sel=None, refs=None):
    return main._agent_run_collect_images(focus(sel, refs), canvas())


def focus_text(sel=None, refs=None):
    return main._agent_run_focus_text(focus(sel, refs), canvas())


class MultiStackReferenceTests(unittest.TestCase):
    def test_every_stack_contributes_its_own_image(self):
        """三个堆叠都要出图，而且各用自己成员的 url——不能被折叠成第一个堆叠。"""
        picked = collect()
        urls = [item["url"] for item in picked]
        self.assertEqual(len(urls), len(set(urls)), "同一张图不能重复占位：" + repr(urls))
        for stack_id, (title, own) in STACKS.items():
            mine = [item for item in picked if item["url"].rsplit("/", 1)[-1].split(".")[0] in own]
            self.assertTrue(mine, f"{title} 一张图都没取到：{urls}")
            for item in mine:
                self.assertTrue(item["url"].startswith("/assets/"), item)
        # 三个堆叠取到的 url 集合互不相交（各取各的）
        buckets = []
        for stack_id, (title, own) in STACKS.items():
            buckets.append({item["url"] for item in picked
                            if item["url"].rsplit("/", 1)[-1].split(".")[0] in own})
        self.assertEqual(sum(len(b) for b in buckets), len(set().union(*buckets)), "堆叠之间串图了")

    def test_labels_distinguish_stacks(self):
        labels = [item["label"] for item in collect()]
        self.assertEqual(len(labels), len(set(labels)), "标签重复，模型分不清是哪个堆叠：" + repr(labels))
        joined = "｜".join(labels)
        for title, _own in STACKS.values():
            self.assertIn(title, joined, "标签里要带堆叠名：" + repr(labels))

    def test_focus_text_lists_all_three_stacks(self):
        text = focus_text()
        for stack_id, (title, _own) in STACKS.items():
            self.assertIn(stack_id, text, "选中的堆叠 id 要进 system prompt：" + text)
            self.assertIn(title, text, "堆叠标题要能区分：" + text)

    def test_single_node_and_plain_group_still_work(self):
        solo = collect(sel=["solo"])
        self.assertEqual([item["url"] for item in solo], ["/assets/solo.png"])
        self.assertEqual([item["label"] for item in solo], ["solo"])
        # 普通分组按画布位置排序（n_a 的 y=0 在 n_b 的 y=300 前面）
        plain = collect(sel=["plain"])
        self.assertEqual([item["url"] for item in plain], ["/assets/n_a.png", "/assets/n_b.png"], plain)

    def test_reverse_without_expansion_stacks_have_no_images(self):
        """反向断言：把堆叠展开关掉（等价于修复前的行为）→ 三个堆叠一张图都取不到。"""
        with mock.patch.object(main, "_agent_beat_channel_items", return_value=[]):
            picked = collect(sel=list(STACKS.keys()))
        self.assertEqual(picked, [], "修复前的行为应该是空（这正是用户看到的“全变成第一个堆叠”）")


if __name__ == "__main__":
    unittest.main()
