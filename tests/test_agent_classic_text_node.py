"""BEAT（classic）画布建「文字节点」：type=text 归一成 prompt 节点，正文必须落到节点文本上。

背景：工具目录里 create_node 的 type enum 含 text（智能画布有独立的文本节点），
但 BEAT 画布 kind=classic，classic 校验原来只认 image|prompt|video，
于是用户说「新建一个文字节点」时模型选 text → 批准后执行直接被拒（用户侧看起来就是「画布没反应」）。
前端把 prompt 节点渲染成文本节点，所以这里统一归一成 prompt，并保证 prompt/text/content 三种正文写法都带回节点文本。
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
    return {"id": "c1", "kind": "classic", "title": "经典画布", "updated_at": 1,
            "nodes": [{"id": "p1", "type": "prompt", "x": 600, "y": 0, "title": "旧提示词", "text": "旧内容", "created_at": 1}],
            "connections": []}


class MemoryCanvas:
    """把 load_canvas / 写盘换成内存字典（与 P0 测试同一套打桩思路）。"""

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


def run_tool(tool, args):
    async def go():
        with contextlib.redirect_stdout(io.StringIO()):
            return await main.agent_execute_step(tool, args)
    return asyncio.run(go())


def validate(args):
    return main._agent_tool_create_node_validate(args)


class ClassicTextNodeValidateTests(unittest.TestCase):
    def setUp(self):
        self.canvas = classic_canvas()

    def test_text_type_is_normalized_to_prompt(self):
        with patch.object(main, "load_canvas", return_value=self.canvas):
            norm = validate({"canvas_id": "c1", "type": "text", "prompt": "最终验证"})
        self.assertEqual(norm["type"], "prompt")
        self.assertEqual(norm["prompt"], "最终验证")

    def test_body_is_taken_from_prompt_text_or_content(self):
        for field in ("prompt", "text", "content"):
            with patch.object(main, "load_canvas", return_value=self.canvas):
                norm = validate({"canvas_id": "c1", "type": "text", field: "正文" + field})
            self.assertEqual(norm["prompt"], "正文" + field, field)
            self.assertEqual(norm["type"], "prompt", field)

    def test_unknown_type_is_still_rejected_and_message_mentions_text(self):
        with patch.object(main, "load_canvas", return_value=self.canvas):
            with self.assertRaises(main.AgentToolError) as ctx:
                validate({"canvas_id": "c1", "type": "音频", "prompt": "x"})
        self.assertEqual(ctx.exception.code, "invalid_args")
        self.assertIn("text", ctx.exception.message)

    def test_existing_types_keep_their_mapping(self):
        with patch.object(main, "load_canvas", return_value=self.canvas):
            self.assertEqual(validate({"canvas_id": "c1", "type": "image"})["type"], "image")
            self.assertEqual(validate({"canvas_id": "c1", "type": "video"})["type"], "video")
            self.assertEqual(validate({"canvas_id": "c1", "type": "prompt"})["type"], "prompt")


class ClassicTextNodeCreateTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, classic_canvas())

    def test_text_node_lands_as_prompt_node_with_body_not_only_title(self):
        r = run_tool("create_node", {"canvas_id": "c1", "type": "text", "prompt": "最终验证"})
        self.assertTrue(r["ok"], r)
        node = self.mem.store["c1"]["nodes"][-1]
        self.assertEqual(node["type"], "prompt")          # BEAT 前端把它渲染成文本节点
        self.assertEqual(node["text"], "最终验证")          # 正文真的落到节点文本上
        self.assertEqual(node["title"], "最终验证")         # 没给标题时用正文首行，不出现「Prompt」
        self.assertEqual(r["result"]["node_count"], 2)

    def test_title_survives_when_model_sends_content_instead_of_prompt(self):
        r = run_tool("create_node", {"canvas_id": "c1", "type": "text", "title": "标题", "content": "正文"})
        self.assertTrue(r["ok"], r)
        node = self.mem.store["c1"]["nodes"][-1]
        self.assertEqual(node["title"], "标题")
        self.assertEqual(node["text"], "正文")

    def test_new_node_does_not_stack_on_existing_node(self):
        run_tool("create_node", {"canvas_id": "c1", "type": "text", "prompt": "第二个"})
        node = self.mem.store["c1"]["nodes"][-1]
        self.assertFalse(node["x"] == 0 and node["y"] == 0, node)   # 有旧节点时不能落回 (0,0) 重叠


if __name__ == "__main__":
    unittest.main()
