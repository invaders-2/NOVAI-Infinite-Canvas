"""画布助手：生成比例映射（缺陷 1）与群组参考图收集（缺陷 2）。

缺陷 1（比例未生效）：前端「出图设置」下拉给的是冒号串（3:4），智能画布图片尺寸表
（SIZE_MAP）只认档位名（portrait43）；后端必须把两种写法都归一成档位名，
不合法值要报错而不是静默回退 1:1；视频侧保持冒号串写进 videoAspect，不转档位名。

缺陷 2（选中群组取不到全部图片）：节点自身/上游是群组时要递归 items 收集组内全部图片，
带 visited 防环、深度上限，屏蔽键（nodeId|index 与 url|url）与去重/截断语义不变。

全部用内存画布 JSON（不落盘、不起服务、不调模型）。
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def image_node(node_id, urls, kind="image"):
    return {"id": node_id, "type": "smart-image",
            "images": [{"url": url, "kind": kind} for url in urls]}


def group_node(node_id, items, images=None):
    return {"id": node_id, "type": "smart-group", "items": list(items), "images": list(images or [])}


def canvas_of(nodes, connections=None):
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": list(nodes),
            "connections": list(connections or [])}


class AgentRatioMappingTests(unittest.TestCase):
    """比例归一：冒号串 ↔ 档位名，两种写法都要能落到前端读取的值上。"""

    def test_image_colon_strings_map_to_frontend_keys(self):
        cases = {"3:4": "portrait43", "16:9": "wide", "1:1": "square", "4:3": "landscape43",
                 "9:16": "story", "2:3": "portrait", "3:2": "landscape"}
        for raw, key in cases.items():
            self.assertEqual(main._agent_validate_settings({"ratio": raw}, "image"), {"ratio": key}, raw)
            self.assertEqual(main._agent_ratio_setting("image", raw), key, raw)

    def test_image_key_names_are_kept_as_is(self):
        for key in ("portrait43", "wide", "square", "story", "landscape43"):
            self.assertEqual(main._agent_validate_settings({"ratio": key}, "image"), {"ratio": key}, key)
            self.assertEqual(main._agent_ratio_setting("image", key), key, key)

    def test_empty_and_auto_stay_empty(self):
        self.assertEqual(main._agent_validate_settings({"ratio": ""}, "image"), {})
        for value in ("", None, "  ", "自动", "auto", "自适应"):
            self.assertEqual(main._agent_ratio_setting("image", value), "", repr(value))

    def test_unsupported_image_ratio_raises_with_options(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_validate_settings({"ratio": "7:5"}, "image")
        self.assertIn("可选", ctx.exception.message)
        self.assertIn("3:4", ctx.exception.message)
        with self.assertRaises(main.AgentToolError):
            main._agent_ratio_setting("image", "7:5")
        # 收口处（写 runSettings 的 _agent_apply_settings）也不能静默放过
        with self.assertRaises(main.AgentToolError):
            main._agent_apply_settings({}, "image", {"ratio": "7:5"})

    def test_video_ratio_keeps_colon_string_in_video_aspect(self):
        self.assertEqual(main._agent_validate_settings({"ratio": "9:16"}, "video"), {"ratio": "9:16"})
        node = {"id": "v1", "type": "smart-image"}
        changed = main._agent_apply_settings(node, "video", {"ratio": "9:16"})
        self.assertEqual(changed, ["ratio"])
        self.assertEqual(node["runSettings"]["videoAspect"], "9:16")
        self.assertNotIn("ratio", node["runSettings"])  # 没有把视频转成档位名
        with self.assertRaises(main.AgentToolError):
            main._agent_ratio_setting("video", "7:5")

    def test_converted_key_resolves_the_frontend_size_map(self):
        three_four = main._agent_ratio_setting("image", "3:4")
        self.assertEqual(main._AGENT_SMART_SIZE_MAP[three_four]["1k"], "1008x1344")
        wide = main._agent_ratio_setting("image", "16:9")
        self.assertEqual(main._AGENT_SMART_SIZE_MAP[wide]["1k"], "1280x720")


class AgentApplySettingsNormalizationTests(unittest.TestCase):
    """收口处自己归一：不经过 _agent_validate_settings，直接拿原始冒号串调 apply 也要落成档位名。"""

    def apply(self, kind, value, node=None):
        node = node if node is not None else {"id": "n1", "type": "smart-image"}
        changed = main._agent_apply_settings(node, kind, {"ratio": value})
        return node["runSettings"], changed

    def test_image_colon_strings_land_as_frontend_keys(self):
        for raw, key in (("3:4", "portrait43"), ("16:9", "wide"), ("1:1", "square")):
            rs, changed = self.apply("image", raw)
            self.assertEqual(rs["ratio"], key, raw)
            self.assertEqual(changed, ["ratio"])

    def test_image_key_name_is_kept_as_is(self):
        rs, _ = self.apply("image", "portrait43")
        self.assertEqual(rs["ratio"], "portrait43")

    def test_video_colon_string_stays_in_video_aspect(self):
        rs, changed = self.apply("video", "9:16")
        self.assertEqual(rs["videoAspect"], "9:16")
        self.assertNotIn("ratio", rs)  # 视频不转档位名
        self.assertEqual(changed, ["ratio"])

    def test_unsupported_image_ratio_raises(self):
        with self.assertRaises(main.AgentToolError):
            self.apply("image", "7:5")


class AgentGenerateSmartRatioTests(unittest.TestCase):
    """生成工具真正落盘的 runSettings：模型给的档位名和用户下拉的冒号串都要生效。"""

    def _run(self, args, kind):
        canvas = {"id": "c1", "kind": "smart", "nodes": [{"id": "gen1", "type": "smart-image"}],
                  "connections": []}

        def fake_create_run(node_args):
            return {"node_id": "prompt1" if node_args.get("type") == "prompt" else "gen1"}

        def fake_mutate(canvas_id, mutator):
            mutator(canvas)
            return canvas, None

        async def fake_start(canvas_id, node_id, **kwargs):
            return {"node_id": node_id, "message": "已提交"}

        with patch.object(main, "_agent_tool_create_node_validate", side_effect=lambda a: a),                 patch.object(main, "_agent_tool_create_node_run", side_effect=fake_create_run),                 patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate),                 patch.object(main, "_agent_start_node_generation", new=fake_start):
            asyncio.run(main._agent_generate_smart(args, kind))
        return canvas["nodes"][0]["runSettings"]

    def _args(self, ratio):
        return {"canvas_id": "c1", "prompt": "一只猫", "provider": "prov", "ratio": ratio}

    def test_model_key_name_and_user_colon_string_both_land(self):
        self.assertEqual(self._run(self._args("portrait43"), "image")["ratio"], "portrait43")
        self.assertEqual(self._run(self._args("3:4"), "image")["ratio"], "portrait43")
        self.assertEqual(self._run(self._args("16:9"), "image")["ratio"], "wide")

    def test_unsupported_ratio_is_rejected_not_silently_squared(self):
        with self.assertRaises(main.AgentToolError):
            self._run(self._args("7:5"), "image")

    def test_video_generation_writes_video_aspect_untouched(self):
        args = {"canvas_id": "c1", "prompt": "一段视频", "provider": "prov", "ratio": "9:16", "duration": 5}
        rs = self._run(args, "video")
        self.assertEqual(rs["videoAspect"], "9:16")
        self.assertNotIn("ratio", rs)


class AgentGroupReferenceTests(unittest.TestCase):
    """选中群组 / 上游群组要拿到组内全部图片：递归 items、防环、去重、屏蔽、截断。"""

    def refs(self, canvas, node):
        return [r["url"] for r in main._agent_node_reference_items(canvas, node)]

    def test_selected_group_collects_all_member_images(self):
        nodes = [group_node("A", ["m1", "m2", "m3"]),
                 image_node("m1", ["/a.png"]), image_node("m2", ["/b.png"]), image_node("m3", ["/c.png"])]
        self.assertEqual(self.refs(canvas_of(nodes), nodes[0]), ["/a.png", "/b.png", "/c.png"])

    def test_nested_group_is_recursed(self):
        nodes = [group_node("A", ["m1", "m2", "m3", "B"]),
                 image_node("m1", ["/a.png"]), image_node("m2", ["/b.png"]), image_node("m3", ["/c.png"]),
                 group_node("B", ["b1", "b2"]), image_node("b1", ["/d.png"]), image_node("b2", ["/e.png"])]
        refs = self.refs(canvas_of(nodes), nodes[0])
        self.assertEqual(refs, ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"])

    def test_group_own_images_come_first_then_items_order(self):
        nodes = [group_node("A", ["m1", "m2"], images=[{"url": "/own.png", "kind": "image"}]),
                 image_node("m1", ["/a.png"]), image_node("m2", ["/b.png"])]
        self.assertEqual(self.refs(canvas_of(nodes), nodes[0]), ["/own.png", "/a.png", "/b.png"])

    def test_cycle_is_stable_and_terminates(self):
        nodes = [group_node("A", ["m1", "m2", "m3", "B"]),
                 image_node("m1", ["/a.png"]), image_node("m2", ["/b.png"]), image_node("m3", ["/c.png"]),
                 group_node("B", ["b1", "b2", "A"]), image_node("b1", ["/d.png"]), image_node("b2", ["/e.png"])]
        canvas = canvas_of(nodes)
        first = self.refs(canvas, nodes[0])
        self.assertEqual(first, ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"])
        self.assertEqual(self.refs(canvas, nodes[0]), first)  # 结果稳定

    def test_upstream_group_and_image_members_are_included(self):
        nodes = [image_node("T", ["/t.png"]),
                 group_node("G", ["g1", "g2"]), image_node("g1", ["/g1.png"]), image_node("g2", ["/g2.png"]),
                 image_node("U", ["/u.png"])]
        conns = [{"from": "G", "to": "T", "kind": "input"}, {"from": "U", "to": "T", "kind": "input"}]
        self.assertEqual(self.refs(canvas_of(nodes, conns), nodes[0]), ["/t.png", "/g1.png", "/g2.png", "/u.png"])

    def test_duplicate_urls_are_deduplicated(self):
        nodes = [group_node("A", ["m1", "m2"]),
                 image_node("m1", ["/same.png"]), image_node("m2", ["/same.png"])]
        self.assertEqual(self.refs(canvas_of(nodes), nodes[0]), ["/same.png"])

    def test_blocked_input_refs_both_key_forms(self):
        nodes = [group_node("A", ["m1", "m2"]),
                 image_node("m1", ["/a1.png", "/a2.png"]), image_node("m2", ["/b.png"])]
        node = nodes[0]
        node["blockedInputRefs"] = ["m1|1", "url|/b.png"]
        self.assertEqual(self.refs(canvas_of(nodes), node), ["/a1.png"])

    def test_manual_input_refs_come_last(self):
        nodes = [group_node("A", ["m1"]), image_node("m1", ["/a.png"]),
                 image_node("T", ["/t.png"])]
        node = {"id": "target", "type": "smart-image",
                "manualInputRefs": [{"url": "/manual.png", "nodeId": "m9", "imageIndex": 3}]}
        conns = [{"from": "A", "to": "target", "kind": "input"}]
        canvas = canvas_of(nodes + [node], conns)
        # 先上游群组的 /a.png，再手动参考 /manual.png
        self.assertEqual([r["url"] for r in main._agent_node_reference_items(canvas, node)],
                         ["/a.png", "/manual.png"])

    def test_depth_limit_stops_deep_nesting(self):
        # 10 层嵌套：深度上限 6 时只收 depth 0..6 共 7 层，不会无限递归
        nodes = []
        for i in range(10):
            members = [f"g{i + 1}"] if i < 9 else []
            nodes.append(group_node(f"g{i}", members, images=[{"url": f"/{i}.png", "kind": "image"}]))
        self.assertEqual(self.refs(canvas_of(nodes), nodes[0]), [f"/{i}.png" for i in range(7)])

    def test_results_are_truncated_to_ref_limit(self):
        members = [f"m{i}" for i in range(main._AGENT_REF_LIMIT + 5)]
        nodes = [group_node("A", members)] + [image_node(m, [f"/{m}.png"]) for m in members]
        self.assertEqual(len(self.refs(canvas_of(nodes), nodes[0])), main._AGENT_REF_LIMIT)

    def test_self_then_upstream_then_manual_order(self):
        target = {"id": "T", "type": "smart-image", "images": [{"url": "/t.png", "kind": "image"}],
                  "manualInputRefs": [{"url": "/m.png", "nodeId": "x", "imageIndex": 0}]}
        nodes = [target, image_node("U", ["/u.png"])]
        conns = [{"from": "U", "to": "T", "kind": "input"}]
        self.assertEqual(self.refs(canvas_of(nodes, conns), target), ["/t.png", "/u.png", "/m.png"])


class AgentPlanReferenceBoundaryTests(unittest.TestCase):
    """第 3 条边界：≥2 张参考图的提示只数图片、去重；方案示例里的 3:4 / 2k 必须真的能过参数校验。"""

    def test_hint_counts_only_images_and_dedupes(self):
        refs = ["/assets/a.png", "/assets/a.png", "https://x/b.mp4", "/assets/c.webp"]
        self.assertEqual(main.agent_reference_image_count(refs), 2)
        hint = main.agent_plan_reference_hint(refs)
        self.assertIn("2 张参考图", hint)
        self.assertIn("table → batch", hint)
        # 单张参考图 / 只有视频时不注入
        self.assertEqual(main.agent_plan_reference_hint(["/assets/a.png"]), "")
        self.assertEqual(main.agent_plan_reference_hint(["https://x/a.mp4", "https://x/b.mov"]), "")

    def test_plan_example_settings_are_valid(self):
        self.assertEqual(main._agent_validate_settings({"ratio": "3:4", "resolution": "2k"}, "image"),
                         {"ratio": "portrait43", "resolution": "2k"})
        self.assertEqual(main._agent_ratio_setting("image", "3:4"), "portrait43")
        self.assertEqual(main._AGENT_SMART_SIZE_MAP["portrait43"]["2k"], "1536x2048")


if __name__ == "__main__":
    unittest.main()
