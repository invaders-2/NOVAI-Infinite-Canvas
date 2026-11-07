"""经典画布（BEAT 的画布 kind=classic）上 update_node / run_generation 的 settings 支持。

真实故障：用户说「把图1 的比例改成 16:9」，模型按工具说明下发
`update_node {settings: {"ratio": "16:9"}}`，但经典画布分支只认 title/prompt/text/x/y/params，
直接报「没有可更新的字段」→ 用户看到的就是「助手无法操作画布」。这里把它钉住。
"""
import asyncio
import contextlib
import copy
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def classic_canvas():
    return {
        "id": "c1", "kind": "classic", "title": "经典画布", "updated_at": 1, "connections": [],
        "nodes": [
            # canvas-next 创建的图片节点（真值在 data.gen.params）
            {"id": "n_img", "type": "smart-image", "kind": "image", "x": 0, "y": 0, "w": 300, "h": 300,
             "title": "海报图", "ratio": "3:4", "created_at": 1,
             "data": {"gen": {"title": "海报图", "prompt": "", "hist": [],
                              "params": {"model": "apimart::gpt-image-1", "ratio": "3:4", "size": "1K", "count": 1}}}},
            # 老式 / 助手建的图片节点（没有 data.gen，只能读顶层字段）
            {"id": "n_legacy", "type": "image", "title": "老图", "x": 400, "y": 0, "created_at": 2},
            # 提示词节点（正文在 text）
            {"id": "n_text", "type": "prompt", "title": "提示词1", "text": "原始内容", "x": 0, "y": 400, "created_at": 3},
            {"id": "n_video", "type": "video", "title": "视频1", "x": 800, "y": 0, "created_at": 4},
        ],
    }


class MemoryCanvas:
    def __init__(self, testcase, canvas):
        self.store = {canvas["id"]: copy.deepcopy(canvas)}
        patches = [
            patch.object(main, "load_canvas", side_effect=self.load),
            patch.object(main, "canvas_path", side_effect=lambda cid: f"mem://{cid}"),
            patch.object(main, "write_json_atomic", side_effect=self.write),
            patch.object(main, "snapshot_canvas_version", return_value=7),
        ]
        for item in patches:
            item.start()
            testcase.addCleanup(item.stop)

    def load(self, canvas_id):
        if canvas_id not in self.store:
            raise main.HTTPException(status_code=404, detail="画布不存在")
        return copy.deepcopy(self.store[canvas_id])

    def write(self, path, data, **kwargs):
        if str(path).startswith("mem://"):
            self.store[str(path)[len("mem://"):]] = copy.deepcopy(data)

    def node(self, node_id):
        return next(n for n in self.store["c1"]["nodes"] if n.get("id") == node_id)


def run_tool(tool, args):
    async def go():
        with contextlib.redirect_stdout(io.StringIO()):
            return await main.agent_execute_step(tool, args)
    return asyncio.run(go())


class ClassicUpdateSettingsTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, classic_canvas())

    def test_ratio_setting_lands_in_canvas_next_params(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_img",
                                     "settings": {"ratio": "16:9", "resolution": "2k", "count": 2}})
        self.assertTrue(r["ok"], r)
        node = self.mem.node("n_img")
        params = node["data"]["gen"]["params"]
        self.assertEqual(params["ratio"], "16:9")
        self.assertEqual(params["size"], "2K")
        self.assertEqual(params["count"], 2)
        self.assertEqual(node["ratio"], "16:9")            # 顶层兼容字段也同步
        self.assertIn("settings", r["result"].get("changed", []))

    def test_ratio_label_is_normalized_to_colon_string(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_img",
                                     "settings": {"ratio": "wide"}})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.mem.node("n_img")["data"]["gen"]["params"]["ratio"], "16:9")

    def test_provider_model_becomes_canvas_next_model_id(self):
        with patch.object(main, "get_api_provider_exact",
                          return_value={"id": "apimart", "protocol": "apimart", "enabled": True,
                                        "image_models": ["gpt-image-2.5-ext"], "video_models": []}):
            r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_img",
                                         "settings": {"provider": "apimart", "model": "gpt-image-2.5-ext"}})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.mem.node("n_img")["data"]["gen"]["params"]["model"], "apimart::gpt-image-2.5-ext")

    def test_legacy_node_without_gen_data_still_gets_ratio(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_legacy",
                                     "settings": {"ratio": "9:16", "resolution": "1k"}})
        self.assertTrue(r["ok"], r)
        node = self.mem.node("n_legacy")
        self.assertEqual(node["ratio"], "9:16")

    def test_video_settings_use_res_dur_fields(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_video",
                                     "settings": {"ratio": "9:16", "resolution": "1080p", "duration": 8}})
        self.assertTrue(r["ok"], r)
        node = self.mem.node("n_video")
        self.assertEqual(node["aspectRatio"], "9:16")
        self.assertEqual(node["duration"], 8)

    def test_prompt_append_appends_to_text(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_text", "prompt_append": "，加一点光"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.mem.node("n_text")["text"], "原始内容，加一点光")

    def test_settings_on_text_node_is_rejected_clearly(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_text", "settings": {"ratio": "16:9"}})
        self.assertFalse(r["ok"])
        self.assertIn("settings", str(r.get("error") or ""))

    def test_rows_only_for_table_nodes(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_img", "rows": [["a"]]})
        self.assertFalse(r["ok"])
        self.assertIn("多维表格", str(r.get("error") or ""))

    def test_unknown_setting_key_is_rejected_with_options(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "n_img", "settings": {"foo": 1}})
        self.assertFalse(r["ok"])
        self.assertIn("settings 不支持", str(r.get("error") or ""))


class ClassicRunGenerationSettingsTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, classic_canvas())

    def test_validate_accepts_settings_and_uses_them(self):
        with patch.object(main, "get_api_provider",
                          return_value={"id": "apimart", "protocol": "apimart", "image_models": ["gpt-image-1"]}):
            norm = main._agent_tool_run_generation_validate(
                {"canvas_id": "c1", "node_id": "n_img", "settings": {"ratio": "16:9", "resolution": "2k"}})
        self.assertEqual(norm["settings"]["ratio"], "16:9")
        self.assertIn("x", norm["size"])               # 已换算成像素尺寸；最终仍过平台尺寸策略
        self.assertNotEqual(norm["size"].upper(), "2K")
        self.assertEqual(norm["provider"], "comfly")    # 没指定平台就沿用默认（与老行为一致）

    def test_settings_are_written_into_node_through_the_apply_helper(self):
        # run 里先写节点再提交任务；这里直接验证写节点函数（避免真建任务/花钱）
        node = self.mem.node("n_img")
        changed = main._agent_classic_apply_settings(node, "image", {"ratio": "16:9", "resolution": "2k"})
        self.assertEqual(changed, ["ratio", "resolution"])
        self.assertEqual(node["data"]["gen"]["params"]["ratio"], "16:9")
        self.assertEqual(node["data"]["gen"]["params"]["size"], "2K")
        self.assertEqual(node["ratio"], "16:9")


if __name__ == "__main__":
    unittest.main()
