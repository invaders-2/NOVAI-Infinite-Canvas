# -*- coding: utf-8 -*-
"""画布助手 focus.references（引用带身份 M1）：归一化、提示词渲染、看图取图。

契约（前端按这个发）：focus.references = [{id, name?, role?, source?}]
  - id：节点 id（必填，字符串）
  - role：subject|style|composition|first_frame|last_frame|context 或 null/缺省
  - name：人类可读名（可选，仅供提示词展示）
  - source：node|upload|asset，缺省 node
旧字段 reference_images / reference_videos 必须继续兼容。

画布数据全部是内存 dict，不读写仓库 data/。
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-focus-refs-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas_fixture():
    return {
        "id": "c1", "kind": "smart", "title": "测试画布", "updated_at": 1,
        "nodes": [
            {"id": "img_subject", "type": "smart-image", "alias": "图3", "title": "主视觉",
             "images": [{"url": "/output/subject.png", "kind": "image", "name": "subject.png"}]},
            {"id": "img_style", "type": "smart-image", "alias": "图4", "title": "风格参考",
             "images": [{"url": "/output/style.png", "kind": "image"}]},
            {"id": "vid_ref", "type": "smart-image", "alias": "视频1", "title": "运镜参考",
             "images": [{"url": "/output/clip.mp4", "kind": "video"}]},
            {"id": "prompt_1", "type": "smart-prompt", "alias": "提示词2", "title": "提示词", "text": "黄昏海边"},
        ],
        "connections": [],
    }


def canvas_with_extra_images(count):
    data = canvas_fixture()
    for i in range(count):
        data["nodes"].append({
            "id": "cap_%d" % i, "type": "smart-image", "alias": "图%d" % (10 + i),
            "title": "批量参考 %d" % i,
            "images": [{"url": "/output/cap_%d.png" % i, "kind": "image"}],
        })
    return data


def normalize(focus=None):
    return main._agent_run_normalize_focus(focus)


def focus_text(focus, canvas=None):
    return main._agent_run_focus_text(normalize(focus), canvas if canvas is not None else canvas_fixture())


def collect(focus, canvas=None):
    return main._agent_run_collect_images(normalize(focus), canvas if canvas is not None else canvas_fixture())


class NormalizeReferencesTests(unittest.TestCase):
    """reference 条目逐条清洗：坏的丢掉、好的留下，绝不吞整张表。"""

    def test_legal_entry_kept(self):
        refs = normalize({"references": [{"id": "img_subject", "name": "主体参考",
                                          "role": "subject", "source": "node"}]})["references"]
        self.assertEqual(refs, [{"id": "img_subject", "name": "主体参考",
                                 "role": "subject", "source": "node"}])

    def test_role_out_of_whitelist_becomes_none(self):
        for role in ("hero", "背景", "SUBJECT_2", ""):
            with self.subTest(role=role):
                self.assertIsNone(normalize({"references": [{"id": "a", "role": role}]})["references"][0]["role"])
        # 大小写不敏感：白名单命中就保留（统一小写）
        self.assertEqual(normalize({"references": [{"id": "a", "role": "Subject"}]})["references"][0]["role"],
                         "subject")
        # 缺省就是 None
        self.assertIsNone(normalize({"references": [{"id": "a"}]})["references"][0]["role"])

    def test_source_out_of_whitelist_falls_back_to_node(self):
        for source in ("weird", "库里", ""):
            with self.subTest(source=source):
                self.assertEqual(normalize({"references": [{"id": "a", "source": source}]})["references"][0]["source"],
                                 "node")
        for source in ("upload", "asset", "UPLOAD"):
            with self.subTest(source=source):
                self.assertEqual(normalize({"references": [{"id": "a", "source": source}]})["references"][0]["source"],
                                 source.lower())

    def test_missing_id_dropped_but_rest_kept(self):
        refs = normalize({"references": [
            {"name": "没有 id"}, {"id": ""}, {"id": "   "}, "脏", 7, None,
            {"id": "img_style", "role": "style"},
        ]})["references"]
        self.assertEqual([r["id"] for r in refs], ["img_style"])
        self.assertEqual(refs[0]["role"], "style")

    def test_duplicate_id_keeps_first(self):
        refs = normalize({"references": [
            {"id": "img_subject", "role": "subject"},
            {"id": "img_subject", "role": "style"},
        ]})["references"]
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0]["role"], "subject")

    def test_limit_12(self):
        raw = [{"id": "n%d" % i} for i in range(20)]
        refs = normalize({"references": raw})["references"]
        self.assertEqual(len(refs), 12)
        self.assertEqual([r["id"] for r in refs], ["n%d" % i for i in range(12)])

    def test_references_not_list_is_empty_and_safe(self):
        for raw in ("abc", {"id": "a"}, 7, None, True):
            with self.subTest(raw=raw):
                self.assertEqual(normalize({"references": raw})["references"], [])
        self.assertEqual(normalize(None)["references"], [])

    def test_name_truncated_to_80(self):
        refs = normalize({"references": [{"id": "a", "name": "名" * 120}]})["references"]
        self.assertEqual(len(refs[0]["name"]), 80)

    def test_request_model_keeps_references(self):
        # 请求模型不声明 references 的话，pydantic 会直接丢掉；这条防止契约在入口失效
        model = main.AgentRunFocus(**{"selected_node_ids": [], "reference_images": [],
                                      "references": [{"id": "img_subject", "role": "subject"}]})
        self.assertEqual(normalize(model)["references"][0]["id"], "img_subject")

    def test_legacy_fields_still_normalized(self):
        focus = normalize({"reference_images": "/assets/a.png", "reference_videos": ["/assets/b.mp4"]})
        self.assertEqual(focus["reference_images"], ["/assets/a.png"])
        self.assertEqual(focus["reference_videos"], ["/assets/b.mp4"])


class FocusTextTests(unittest.TestCase):

    def test_reference_line_for_existing_node(self):
        text = focus_text({"references": [{"id": "img_subject", "role": "subject"}]})
        self.assertIn("用户指定的参考节点", text)
        self.assertIn("- {{node/img_subject}}｜role=subject｜type=smart-image｜标题=主视觉", text)

    def test_role_missing_shows_unspecified(self):
        text = focus_text({"references": [{"id": "img_style"}]})
        self.assertIn("- {{node/img_style}}｜role=未指定｜type=smart-image｜标题=风格参考", text)

    def test_missing_reference_goes_to_missing_sentence(self):
        text = focus_text({"references": [{"id": "gone_node", "role": "style"}]})
        self.assertNotIn("{{node/gone_node}}", text)
        self.assertIn("用户提到但当前画布上不存在的节点 ID", text)
        self.assertIn("gone_node", text)

    def test_selected_and_reference_missing_merged_into_one_line(self):
        text = focus_text({"selected_node_ids": ["gone_selected"],
                           "references": [{"id": "gone_ref"}]})
        missing_lines = [ln for ln in text.split("\n") if "不存在的节点 ID" in ln]
        self.assertEqual(len(missing_lines), 1)
        self.assertIn("gone_selected", missing_lines[0])
        self.assertIn("gone_ref", missing_lines[0])

    def test_legacy_url_lines_survive_without_references(self):
        text = focus_text({"reference_images": ["/assets/a.png"],
                           "reference_videos": ["/assets/b.mp4"]})
        self.assertNotIn("用户指定的参考节点", text)
        self.assertNotIn("用户上传的参考素材", text)
        self.assertIn("用户附带的参考图 URL：/assets/a.png", text)
        self.assertIn("用户附带的参考视频 URL：/assets/b.mp4", text)

    def test_empty_focus_keeps_old_output(self):
        text = focus_text({})
        self.assertIn("用户当前没有选中任何节点。", text)
        self.assertNotIn("用户附带的参考图 URL", text)

    def test_upload_reference_not_in_missing_sentence(self):
        # upload_<ts>_<i> 本来就不在画布 nodes 里：说成「可能已过期」会让模型以为素材没了
        text = focus_text({"references": [{"id": "upload_1700000000_0", "source": "upload",
                                           "name": "产品图"}]})
        self.assertNotIn("不存在的节点 ID", text)              # 不进 missing 那句
        self.assertNotIn("{{node/upload_1700000000_0}}", text)   # 也不假装成画布节点
        self.assertIn("用户上传的参考素材", text)

    def test_upload_reference_line_contains_name(self):
        text = focus_text({"references": [{"id": "upload_1700000000_0", "source": "upload",
                                           "name": "产品图"}]})
        self.assertIn("  - 上传素材：产品图（source=upload，没有画布节点身份）", text)
        # name 缺省时给「未命名素材」，行依然成立
        text2 = focus_text({"references": [{"id": "upload_1700000000_1", "source": "upload"}]})
        self.assertIn("  - 上传素材：未命名素材（source=upload，没有画布节点身份）", text2)

    def test_asset_reference_line_is_marked_as_library(self):
        text = focus_text({"references": [{"id": "asset_88", "source": "asset", "name": "品牌主图"}]})
        self.assertIn("  - 素材库素材：品牌主图（source=asset，没有画布节点身份）", text)
        self.assertNotIn("不存在的节点 ID", text)

    def test_node_and_upload_references_keep_their_order(self):
        text = focus_text({"references": [
            {"id": "upload_1700000000_0", "source": "upload", "name": "产品图"},
            {"id": "img_subject", "role": "subject"},
            {"id": "gone_node", "role": "style"},
        ]})
        lines = text.split("\n")
        node_title = lines.index("用户指定的参考节点（role 说明这次把它当什么用）：")
        upload_title = lines.index("用户上传的参考素材（没有画布节点 ID，不能当 node id 用）：")
        self.assertLess(node_title, upload_title)        # 两段：节点在前、上传素材在后
        # 节点段里是真实节点行，不存在的进 missing 那句（不混进上传段）
        self.assertEqual(lines[node_title + 1], "- {{node/img_subject}}｜role=subject｜type=smart-image｜标题=主视觉")
        self.assertEqual(lines[upload_title + 1], "  - 上传素材：产品图（source=upload，没有画布节点身份）")
        missing_lines = [ln for ln in lines if "不存在的节点 ID" in ln]
        self.assertEqual(len(missing_lines), 1)
        self.assertIn("gone_node", missing_lines[0])
        self.assertNotIn("upload_1700000000_0", missing_lines[0])


class CollectImagesTests(unittest.TestCase):

    def test_references_resolve_images_in_order(self):
        picked = collect({"references": [{"id": "img_subject", "role": "subject"},
                                         {"id": "img_style", "role": "style"}]})
        self.assertEqual([p["url"] for p in picked], ["/output/subject.png", "/output/style.png"])
        self.assertEqual([p["label"] for p in picked], ["图3", "图4"])   # label 用 _agent_node_ref

    def test_references_come_before_legacy_urls(self):
        picked = collect({"references": [{"id": "img_subject"}],
                          "reference_images": ["/assets/old.png"]})
        self.assertEqual([p["url"] for p in picked], ["/output/subject.png", "/assets/old.png"])
        self.assertEqual([p["label"] for p in picked], ["图3", "参考图1"])

    def test_video_node_not_in_image_list(self):
        self.assertEqual(collect({"references": [{"id": "vid_ref"}]}), [])

    def test_missing_reference_skipped(self):
        picked = collect({"references": [{"id": "gone_node"}, {"id": "img_style"}]})
        self.assertEqual([p["url"] for p in picked], ["/output/style.png"])

    def test_duplicate_between_selected_and_reference_deduped(self):
        picked = collect({"selected_node_ids": ["img_subject"],
                          "references": [{"id": "img_subject"}]})
        self.assertEqual([p["url"] for p in picked], ["/output/subject.png"])

    def test_selected_images_still_come_first(self):
        picked = collect({"selected_node_ids": ["img_style"],
                          "references": [{"id": "img_subject"}]})
        self.assertEqual([p["url"] for p in picked], ["/output/style.png", "/output/subject.png"])

    def test_cap_respects_vision_max_images(self):
        canvas = canvas_with_extra_images(8)
        focus = {"references": [{"id": "cap_%d" % i} for i in range(8)]}
        picked = collect(focus, canvas)
        self.assertEqual(len(picked), main.AGENT_VISION_MAX_IMAGES)
        self.assertEqual([p["url"] for p in picked],
                         ["/output/cap_%d.png" % i for i in range(main.AGENT_VISION_MAX_IMAGES)])

    def test_cap_counts_selected_and_legacy_together(self):
        canvas = canvas_with_extra_images(4)
        focus = {"selected_node_ids": ["cap_0"],
                 "references": [{"id": "cap_1"}, {"id": "cap_2"}],
                 "reference_images": ["/assets/a.png", "/assets/b.png"]}
        self.assertEqual(len(collect(focus, canvas)), main.AGENT_VISION_MAX_IMAGES)


if __name__ == "__main__":
    unittest.main()
