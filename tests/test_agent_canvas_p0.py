"""画布助手 P0：智能画布节点读写对齐、自动连线、生成口径、写回、预算信封、逐字段 ops、撤销。

全部用内存画布打桩（不起服务、不调模型、不发真实生成）：
  1. update_node 写进前端真正读取的 promptDraft* / runSettings，比例按前端的档位名存；
  2. 助手读得到用户写在节点里的提示词，上游提示词节点也算进生成提示词（不再报 empty_prompt）；
  3. create_node 建视频节点 = smart-video（老数据 smart-image+apiKind=video 也认）；inputs 一步连好并维护 inputNodeIds；
  4. 连线校验：类型不对、成环都拒绝，并说明原因；
  5. run_generation：节点已有图时新开结果节点，任务先登记到 pendingTasks 再入队；
  6. 写回：只认登记过的任务，结果追加不覆盖；失败写状态；
  7. 批准的方案就是生成次数上限，超出就停下来要确认；
  8. canvas_ops 对已有节点只下发改动的字段；撤销只撤助手改的部分；删除记墓碑。
"""
import asyncio
import contextlib
import copy
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def smart_canvas():
    return {
        "id": "c1", "kind": "smart", "title": "测试画布", "updated_at": 1, "settings": {"engine": "api", "count": 1},
        "nodes": [
            {"id": "p1", "type": "smart-prompt", "x": 0, "y": 0, "w": 316, "h": 240, "text": "黄昏海边的猫", "created_at": 1},
            {"id": "i1", "type": "smart-image", "x": 400, "y": 0, "title": "Image", "images": [], "created_at": 2,
             "promptDraftText": "电影感", "promptDraftHtml": "电影感", "inputNodeIds": ["p1"],
             "runSettings": {"engine": "api", "apiKind": "image", "provider_id": "prov", "model": "img-model",
                             "ratio": "square", "resolution": "1k"}},
            {"id": "i2", "type": "smart-image", "x": 800, "y": 0, "title": "Image", "created_at": 3,
             "images": [{"url": "/output/a.png", "kind": "image", "name": "a.png"}],
             "promptDraftText": "白底产品图",
             "runSettings": {"engine": "api", "apiKind": "image", "provider_id": "prov", "model": "img-model"}},
            {"id": "l1", "type": "smart-label", "x": 0, "y": 600, "text": "标签", "created_at": 4},
        ],
        "connections": [{"from": "p1", "to": "i1", "kind": "input"}],
    }


class MemoryCanvas:
    """把 load_canvas / 写盘换成内存字典，测试结束自动还原。"""

    def __init__(self, testcase, canvas):
        self.store = {canvas["id"]: copy.deepcopy(canvas)}
        self.writes = 0
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
            self.writes += 1
            self.store[str(path)[len("mem://"):]] = copy.deepcopy(data)

    def node(self, node_id, canvas_id="c1"):
        return next((n for n in self.store[canvas_id]["nodes"] if n.get("id") == node_id), None)


def run_tool(tool, args):
    async def go():
        with contextlib.redirect_stdout(io.StringIO()):
            return await main.agent_execute_step(tool, args)
    return asyncio.run(go())


class FakeTasks:
    def __init__(self, testcase):
        self.created, self.enqueued, self.n = [], [], 0
        self.store = {}

        def create(kind, payload, runner_name, provider_id="", model_id="", extra=None):
            self.n += 1
            task = {"id": f"t{self.n}", "kind": kind, "status": "queued", "payload": payload, **(extra or {})}
            self.created.append(task)
            self.store[task["id"]] = task
            return dict(task)

        async def enqueue(task_id):
            self.enqueued.append(task_id)
            return True

        patches = [
            patch.object(main, "task_create", side_effect=create),
            patch.object(main, "task_enqueue", new=AsyncMock(side_effect=enqueue)),
            patch.object(main, "task_get", side_effect=lambda tid: dict(self.store[tid]) if tid in self.store else None),
            patch.object(main, "agent_image_size", side_effect=lambda provider, model, size="", ratio="": size or "1024x1024"),
        ]
        for item in patches:
            item.start()
            testcase.addCleanup(item.stop)


class FieldMappingTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())

    def test_update_prompt_and_settings_land_in_fields_the_canvas_reads(self):
        with patch.object(main, "_agent_validate_settings", side_effect=lambda raw, kind: {"ratio": "wide"} if raw else {}):
            r = run_tool("update_node", {"canvas_id": "c1", "node_id": "i1", "prompt": "黄昏 <海边> 的猫",
                                         "settings": {"ratio": "16:9"}})
        self.assertTrue(r["ok"], r)
        node = self.mem.node("i1")
        self.assertEqual(node["promptDraftText"], "黄昏 <海边> 的猫")
        self.assertEqual(node["promptDraftHtml"], "黄昏 &lt;海边&gt; 的猫")
        self.assertTrue(node["promptDraftTouched"])
        self.assertNotIn("text", node)
        self.assertNotIn("params", node)
        self.assertEqual(node["runSettings"]["ratio"], "wide")
        self.assertEqual(node["runSettings"]["model"], "img-model")  # 没提到的参数不动

    def test_settings_validation_maps_ratio_and_reports_options(self):
        self.assertEqual(main._agent_validate_settings({"ratio": "16:9", "resolution": "2K", "count": 2}, "image"),
                         {"ratio": "wide", "resolution": "2k", "count": 2})
        self.assertEqual(main._agent_validate_settings({"aspect_ratio": "9:16", "seconds": 8}, "video"),
                         {"ratio": "9:16", "duration": 8})
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_validate_settings({"ratio": "7:3"}, "image")
        self.assertIn("可选", ctx.exception.message)
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_validate_settings({"duration": 99}, "video")
        self.assertIn("1-15", ctx.exception.message)
        with self.assertRaises(main.AgentToolError):
            main._agent_validate_settings({"seed": 1}, "image")

    def test_params_on_smart_canvas_is_rejected_with_guidance(self):
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "i1", "params": {"prompt": "x"}})
        self.assertFalse(r["ok"])
        self.assertIn("settings", r["error"])

    def test_agent_reads_user_prompt_and_upstream_prompt(self):
        canvas = self.mem.load("c1")
        i1 = main._agent_find_node(canvas, "i1")
        self.assertEqual(main._agent_node_own_prompt(i1), "电影感")
        self.assertEqual(main._agent_node_effective_prompt(canvas, i1), "黄昏海边的猫\n\n电影感")
        summary = main._agent_canvas_summary(canvas)
        row = next(n for n in summary["nodes"] if n["id"] == "i1")
        self.assertEqual(row["prompt"], "电影感")
        self.assertEqual(row["upstream"], ["p1"])
        self.assertEqual(row["kind"], "image")
        self.assertEqual(row["settings"]["ratio"], "1:1")

    def test_summary_puts_selected_first_and_never_drops_it(self):
        canvas = self.mem.load("c1")
        summary = main._agent_canvas_summary(canvas, max_nodes=1, priority_ids=["l1"])
        self.assertEqual([n["id"] for n in summary["nodes"]], ["l1"])
        self.assertIn("omitted_nodes", summary)


class CreateAndConnectTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())

    def test_create_video_node_with_inputs_wires_it(self):
        r = run_tool("create_node", {"canvas_id": "c1", "type": "video", "prompt": "镜头缓慢推进", "inputs": ["p1", "i2"]})
        self.assertTrue(r["ok"], r)
        nid = r["result"]["node_id"]
        node = self.mem.node(nid)
        self.assertEqual(node["type"], "smart-video")
        self.assertEqual(node["runSettings"]["apiKind"], "video")
        self.assertEqual(node["promptDraftText"], "镜头缓慢推进")
        self.assertEqual(node["inputNodeIds"], ["p1", "i2"])
        conns = self.mem.store["c1"]["connections"]
        self.assertIn({"from": "p1", "to": nid, "kind": "input"}, conns)
        self.assertIn({"from": "i2", "to": nid, "kind": "input"}, conns)
        # 不和已有节点重叠
        for other in self.mem.store["c1"]["nodes"]:
            if other["id"] == nid:
                continue
            ox, oy, ow, oh = main._agent_node_box(other)
            overlap = node["x"] < ox + ow and ox < node["x"] + 300 and node["y"] < oy + oh and oy < node["y"] + 300
            self.assertFalse(overlap, other["id"])

    def test_connect_rejects_wrong_types_and_cycles(self):
        bad = run_tool("connect_nodes", {"canvas_id": "c1", "from": "l1", "to": "i1"})
        self.assertFalse(bad["ok"])
        self.assertIn("不能连到", bad["error"])
        cycle = run_tool("connect_nodes", {"canvas_id": "c1", "from": "i1", "to": "p1"})
        self.assertFalse(cycle["ok"])
        self.assertIn("环路", cycle["error"])
        ok = run_tool("connect_nodes", {"canvas_id": "c1", "from": "i2", "to": "i1"})
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(self.mem.node("i1")["inputNodeIds"], ["p1", "i2"])
        gone = run_tool("disconnect_nodes", {"canvas_id": "c1", "from": "i2", "to": "i1"})
        self.assertTrue(gone["ok"], gone)
        self.assertEqual(self.mem.node("i1")["inputNodeIds"], ["p1"])

    def test_smart_video_node_accepts_the_same_connections_as_smart_image(self):
        made = run_tool("create_node", {"canvas_id": "c1", "type": "video", "title": "Video"})
        self.assertTrue(made["ok"], made)
        vid = made["result"]["node_id"]
        self.assertEqual(self.mem.node(vid)["type"], "smart-video")
        # 图片节点 / 分组 / 提示词 / 文本都能连进视频节点（与 smart-image 同规则）
        for src in ("p1", "i2"):
            r = run_tool("connect_nodes", {"canvas_id": "c1", "from": src, "to": vid})
            self.assertTrue(r["ok"], r)
        self.assertEqual(self.mem.node(vid)["inputNodeIds"], ["p1", "i2"])
        # 视频节点也能作为上游连到图片节点
        back = run_tool("connect_nodes", {"canvas_id": "c1", "from": vid, "to": "i1"})
        self.assertTrue(back["ok"], back)
        # 不认识的类型仍然拒绝
        bad = run_tool("connect_nodes", {"canvas_id": "c1", "from": "l1", "to": vid})
        self.assertFalse(bad["ok"])
        self.assertIn("不能连到", bad["error"])

    def test_smart_video_prompt_and_settings_use_media_fields(self):
        made = run_tool("create_node", {"canvas_id": "c1", "type": "video", "prompt": "镜头拉近"})
        vid = made["result"]["node_id"]
        node = self.mem.node(vid)
        self.assertEqual(main._agent_node_kind(node), "video")
        self.assertEqual(node["promptDraftText"], "镜头拉近")
        self.assertNotIn("text", node)
        upd = run_tool("update_node", {"canvas_id": "c1", "node_id": vid,
                                       "settings": {"ratio": "9:16", "duration": 8}})
        self.assertTrue(upd["ok"], upd)
        rs = self.mem.node(vid)["runSettings"]
        self.assertEqual(rs["videoAspect"], "9:16")
        self.assertEqual(rs["videoDuration"], 8)
        summary = main._agent_canvas_summary(self.mem.load("c1"))
        row = next(n for n in summary["nodes"] if n["id"] == vid)
        self.assertEqual(row["kind"], "video")

    def test_create_node_with_bad_input_fails_without_leaving_half_workflow(self):
        before = len(self.mem.store["c1"]["nodes"])
        r = run_tool("create_node", {"canvas_id": "c1", "type": "text", "inputs": ["i2"]})
        self.assertFalse(r["ok"])
        self.assertEqual(len(self.mem.store["c1"]["nodes"]), before)

    def test_delete_records_tombstone(self):
        r = run_tool("delete_node", {"canvas_id": "c1", "node_id": "p1", "force": True})
        self.assertTrue(r["ok"], r)
        self.assertEqual([s["id"] for s in self.mem.store["c1"]["deleted_node_ids"]], ["p1"])
        self.assertEqual(self.mem.node("i1")["inputNodeIds"], [])


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())
        self.tasks = FakeTasks(self)

    def test_run_generation_uses_upstream_prompt_and_registers_task_first(self):
        r = run_tool("run_generation", {"canvas_id": "c1", "node_id": "i1"})
        self.assertTrue(r["ok"], r)
        task = self.tasks.created[0]
        self.assertEqual(task["payload"]["prompt"], "黄昏海边的猫\n\n电影感")
        self.assertEqual(task["payload"]["provider_id"], "prov")
        node = self.mem.node("i1")
        self.assertEqual([t["taskId"] for t in node["pendingTasks"]], ["t1"])
        self.assertEqual(node["pending"], 1)
        self.assertEqual(self.tasks.enqueued, ["t1"])

    def test_rerun_node_with_images_branches_and_uses_own_image_as_reference(self):
        r = run_tool("run_generation", {"canvas_id": "c1", "node_id": "i2"})
        self.assertTrue(r["ok"], r)
        res = r["result"]
        self.assertNotEqual(res["node_id"], "i2")
        self.assertEqual(res["source_node_id"], "i2")
        self.assertEqual(self.mem.node("i2")["images"][0]["url"], "/output/a.png")  # 原图保留
        branch = self.mem.node(res["node_id"])
        self.assertEqual(branch["sourceNodeId"], "i2")
        self.assertEqual(self.tasks.created[0]["payload"]["reference_images"], [{"url": "/output/a.png"}])

    def test_empty_prompt_is_explained(self):
        self.mem.store["c1"]["nodes"].append({"id": "i3", "type": "smart-image", "x": 0, "y": 900, "images": []})
        r = run_tool("run_generation", {"canvas_id": "c1", "node_id": "i3"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "empty_prompt")

    def test_writeback_appends_and_ignores_unregistered_nodes(self):
        run_tool("run_generation", {"canvas_id": "c1", "node_id": "i1"})
        with contextlib.redirect_stdout(io.StringIO()):
            cid = main._agent_writeback_task_result("t1", "image", ["/output/new.png"])
        self.assertEqual(cid, "c1")
        node = self.mem.node("i1")
        self.assertEqual([i["url"] for i in node["images"]], ["/output/new.png"])
        self.assertNotIn("pendingTasks", node)
        self.assertEqual(node["lastTaskStatus"], "succeeded")
        # 同一结果再写一次：不重复；节点没登记的任务：不碰
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main._agent_writeback_task_result("t1", "image", ["/output/new.png"]), "")
        self.tasks.store["t9"] = {"id": "t9", "agent": True, "canvas_id": "c1", "node_id": "i2"}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main._agent_writeback_task_result("t9", "image", ["/output/x.png"]), "")
        self.assertEqual(len(self.mem.node("i2")["images"]), 1)

    def test_writeback_failure_marks_node(self):
        run_tool("run_generation", {"canvas_id": "c1", "node_id": "i1"})
        with contextlib.redirect_stdout(io.StringIO()):
            main._agent_writeback_task_result("t1", "image", [], "余额不足")
        node = self.mem.node("i1")
        self.assertEqual(node["lastTaskStatus"], "failed")
        self.assertEqual(node["lastTaskError"], "余额不足")
        self.assertEqual(node["pending"], 0)


class OpsAndUndoTests(unittest.TestCase):
    def test_ops_patch_only_changed_fields(self):
        before = smart_canvas()
        after = copy.deepcopy(before)
        after["nodes"][1]["promptDraftText"] = "新提示词"
        del after["nodes"][1]["promptDraftHtml"]
        after["nodes"].append({"id": "n9", "type": "smart-prompt", "text": "x"})
        ops = main._agent_canvas_ops(before, after)
        self.assertEqual(ops["nodes_upsert"], [{"id": "n9", "type": "smart-prompt", "text": "x"}])
        self.assertEqual(ops["nodes_patch"], [{"id": "i1", "set": {"promptDraftText": "新提示词"},
                                               "unset": ["promptDraftHtml"]}])

    def test_undo_reverts_only_agent_changes(self):
        before = smart_canvas()
        step1 = copy.deepcopy(before)
        step1["nodes"][1]["promptDraftText"] = "助手改的"
        step1["nodes"].append({"id": "n9", "type": "smart-prompt", "text": "助手建的"})
        step1["connections"].append({"from": "n9", "to": "i1", "kind": "input"})
        log = main._agent_undo_log_new()
        main._agent_undo_log_record(log, before, step1)
        # 用户在运行后自己改了别的节点
        current = copy.deepcopy(step1)
        current["nodes"][2]["promptDraftText"] = "用户自己改的"
        stats = main._agent_undo_apply(current, log)
        ids = [n["id"] for n in current["nodes"]]
        self.assertNotIn("n9", ids)
        i1 = next(n for n in current["nodes"] if n["id"] == "i1")
        i2 = next(n for n in current["nodes"] if n["id"] == "i2")
        self.assertEqual(i1["promptDraftText"], "电影感")
        self.assertEqual(i2["promptDraftText"], "用户自己改的")
        self.assertNotIn({"from": "n9", "to": "i1", "kind": "input"}, current["connections"])
        self.assertEqual([s["id"] for s in current["deleted_node_ids"]], ["n9"])
        self.assertEqual(stats["removed_nodes"], 1)


def canvas_stub():
    return smart_canvas()


class BudgetEnvelopeTests(unittest.TestCase):
    def test_extra_generation_beyond_approved_plan_needs_confirmation(self):
        approved = [{"tool": "generate_image", "args": {"canvas_id": "c1", "prompt": "海报"}, "description": "出一张"}]
        execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1", "task_id": "t1",
                                                                  "generation_units": 1}, "message": "执行成功"})
        replies = [json.dumps({"thought": "再来一张", "steps": [
            {"tool": "generate_image", "args": {"canvas_id": "c1", "prompt": "海报2"}, "description": "再出一张"}],
            "done": False}, ensure_ascii=False),
            json.dumps({"done": True, "message": "好了"}, ensure_ascii=False)]
        chat = AsyncMock(side_effect=replies)
        req = {"canvas_id": "c1", "instruction": "出一张海报", "focus": main._agent_run_normalize_focus(None),
               "history": [], "chat": {"provider": "x", "base": "https://x.invalid", "headers": {}, "model": "m",
                                       "provider_cfg": {}},
               "max_steps": 6, "mode": "run", "approved_steps": approved}
        with patch.object(main, "load_canvas", side_effect=lambda cid: smart_canvas()), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "snapshot_canvas_version", return_value=3), \
                patch.object(main, "agent_execute_step", new=execute), \
                patch.object(main, "_agent_run_chat", new=chat):
            async def go():
                queue = asyncio.Queue()
                with contextlib.redirect_stdout(io.StringIO()):
                    await main._agent_run_producer(req, queue)
                out = []
                while not queue.empty():
                    item = queue.get_nowait()
                    if item is None:
                        break
                    out.append(item)
                return out
            chunks = asyncio.run(go())
        names = [c.split("\n")[0][len("event: "):] for c in chunks if c.startswith("event: ")]
        self.assertEqual(execute.await_count, 1)
        self.assertIn("confirm_required", names)
        done = json.loads([c for c in chunks if c.startswith("event: done")][0].split("data: ", 1)[1])
        self.assertIn("session_id", done)


def _drain_run(req, execute, replies):
    chat = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])
    with patch.object(main, "load_canvas", side_effect=lambda cid: smart_canvas()), \
            patch.object(main, "agent_session_save"), \
            patch.object(main, "snapshot_canvas_version", return_value=3), \
            patch.object(main, "agent_execute_step", new=execute), \
            patch.object(main, "_agent_run_chat", new=chat):
        async def go():
            queue = asyncio.Queue()
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, queue)
            out = []
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                out.append(item)
            return out
        chunks = asyncio.run(go())
    events = []
    for c in chunks:
        if c.startswith("event: "):
            name = c.split("\n")[0][len("event: "):]
            events.append((name, json.loads(c.split("data: ", 1)[1])))
    return events


def _req(approved=None, mode="run"):
    return {"canvas_id": "c1", "instruction": "删掉这个", "focus": main._agent_run_normalize_focus(None),
            "history": [], "chat": {"provider": "x", "base": "https://x.invalid", "headers": {}, "model": "m",
                                    "provider_cfg": {}},
            "max_steps": 6, "mode": mode, "approved_steps": approved or []}


class ConfirmFlowTests(unittest.TestCase):
    def test_delete_from_model_waits_for_confirmation_with_details(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        events = _drain_run(_req(), execute, [
            {"steps": [{"tool": "delete_node", "args": {"canvas_id": "c1", "node_id": "p1"}, "description": "删提示词"}]},
            {"done": True, "message": "等你确认"}])
        self.assertEqual(execute.await_count, 0)
        confirm = [d for n, d in events if n == "confirm_required"][0]
        self.assertEqual(confirm["confirm_kind"], "delete")
        self.assertEqual(confirm["description"], "删提示词")
        self.assertEqual(confirm["args"]["node_id"], "p1")

    def test_delete_confirmed_on_card_is_executed(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        approved = [{"tool": "delete_node", "args": {"canvas_id": "c1", "node_id": "p1", "force": True}, "description": "删"}]
        events = _drain_run(_req(approved), execute, [{"done": True, "message": "删好了"}])
        self.assertEqual([c.args[0] for c in execute.await_args_list], ["delete_node"])
        self.assertNotIn("confirm_required", [n for n, _ in events])

    def test_done_reports_changes_for_undo_footer(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        events = _drain_run(_req(), execute, [{"done": True, "message": "好"}])
        done = [d for n, d in events if n == "done"][0]
        self.assertIn("changes", done)
        # artifacts 是「本轮产物」新增字段（artifact_updated 事件同源），其余字段不变
        self.assertEqual(set(done["changes"]),
                         {"nodes_created", "nodes_modified", "nodes_deleted", "connections",
                          "generations", "artifacts"})
        self.assertIsInstance(done["changes"]["artifacts"], list)
        self.assertFalse(done["undoable"])


class RefinePromptTests(unittest.TestCase):
    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())

    def test_refine_returns_candidates_with_diff_and_does_not_write(self):
        r = run_tool("refine_prompt", {"canvas_id": "c1", "node_id": "i2", "instruction": "背景换成雨夜街道",
                                       "candidates": [{"prompt": "雨夜街道背景的产品图", "note": "只换了背景"}, "白底产品图，柔光"],
                                       "keep": ["产品图"]})
        self.assertTrue(r["ok"], r)
        res = r["result"]
        self.assertEqual(len(res["candidates"]), 2)
        self.assertEqual(res["original"], "白底产品图")
        ops = [seg["op"] for seg in res["candidates"][0]["diff"]]
        self.assertIn("del", ops)
        self.assertIn("ins", ops)
        self.assertEqual("".join(seg["text"] for seg in res["candidates"][0]["diff"] if seg["op"] != "del"), "雨夜街道背景的产品图")
        self.assertEqual(self.mem.node("i2")["promptDraftText"], "白底产品图")  # 没写入

    def test_refine_rejects_dropping_kept_fragment(self):
        r = run_tool("refine_prompt", {"canvas_id": "c1", "node_id": "i2", "candidates": ["雨夜街道"], "keep": ["白底"]})
        self.assertFalse(r["ok"])
        self.assertIn("白底", r["error"])

    def test_apply_prompt_writes_and_keeps_history(self):
        with patch.object(main.manager, "broadcast_canvas_updated", new=AsyncMock()):
            out = asyncio.run(main.agent_apply_prompt(main.AgentApplyPromptRequest(canvas_id="c1", node_id="i2", prompt="雨夜街道背景的产品图")))
        node = self.mem.node("i2")
        self.assertEqual(node["promptDraftText"], "雨夜街道背景的产品图")
        self.assertEqual(node["promptHistory"][-1]["text"], "白底产品图")
        self.assertIn("i2", [p["id"] for p in out["canvas_ops"]["nodes_patch"]])
        summary = main._agent_canvas_summary(self.mem.load("c1"))
        row = next(n for n in summary["nodes"] if n["id"] == "i2")
        self.assertEqual(row["earlier_prompts"], ["白底产品图"])

    def test_veo_guidance_and_upstream_rewrite_flag(self):
        self.mem.store["c1"]["nodes"][2]["runSettings"] = {"engine": "api", "apiKind": "video", "videoModel": "veo3.1-fast"}
        r = run_tool("refine_prompt", {"canvas_id": "c1", "node_id": "i2", "candidates": ["镜头推进的产品视频"]})
        self.assertTrue(r["ok"], r)
        self.assertIn("英文", r["result"]["guidance"])
        self.assertTrue(r["result"]["candidates"][0]["upstream_rewrite"])

    def test_plan_mode_runs_refine_directly_without_plan_card(self):
        execute = AsyncMock(return_value={"ok": True, "result": {"candidates": []}, "message": "执行成功"})
        events = _drain_run(_req(mode="plan"), execute, [
            {"intent": "改提示词", "steps": [{"tool": "refine_prompt", "args": {"canvas_id": "c1", "node_id": "i2",
                                                                              "candidates": ["x"]}}]},
            {"done": True, "message": "给你两个版本"}])
        self.assertEqual([c.args[0] for c in execute.await_args_list], ["refine_prompt"])
        plans = [d for n, d in events if n == "plan"]
        self.assertTrue(plans and all("round" in d for d in plans))


class AliasAndThreadTests(unittest.TestCase):
    """P1：节点编号与按画布保存的对话。"""

    def test_aliases_are_assigned_per_kind_and_never_reused(self):
        cv = smart_canvas()
        cv["nodes"].append({"id": "v1", "type": "smart-image", "images": [], "created_at": 5,
                            "runSettings": {"apiKind": "video"}})
        self.assertTrue(main._agent_ensure_aliases(cv))
        names = {n["id"]: n.get("alias") for n in cv["nodes"]}
        self.assertEqual(names, {"p1": "提示词1", "i1": "图1", "i2": "图2", "l1": None, "v1": "视频1"})
        # 删掉图2 再建一张：编号不回收
        cv["nodes"] = [n for n in cv["nodes"] if n["id"] != "i2"]
        cv["nodes"].append({"id": "i9", "type": "smart-image", "images": [], "created_at": 9})
        main._agent_ensure_aliases(cv)
        self.assertEqual(next(n for n in cv["nodes"] if n["id"] == "i9")["alias"], "图3")
        self.assertFalse(main._agent_ensure_aliases(cv))

    def test_save_keeps_alias_when_frontend_did_not_send_it(self):
        old = smart_canvas()
        main._agent_ensure_aliases(old)
        new = copy.deepcopy(old)
        for n in new["nodes"]:
            n.pop("alias", None)
        new.pop("alias_counters", None)
        main._agent_ensure_aliases(new, {"nodes": old["nodes"], "alias_counters": old["alias_counters"]})
        self.assertEqual([n.get("alias") for n in new["nodes"]], [n.get("alias") for n in old["nodes"]])

    def test_tools_accept_alias_in_args(self):
        mem = MemoryCanvas(self, smart_canvas())
        cv = mem.store["c1"]
        main._agent_ensure_aliases(cv)
        r = run_tool("update_node", {"canvas_id": "c1", "node_id": "图1", "prompt": "用编号改的"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(mem.node("i1")["promptDraftText"], "用编号改的")
        r = run_tool("connect_nodes", {"canvas_id": "c1", "from": "@图2", "to": "图1"})
        self.assertTrue(r["ok"], r)
        summary = main._agent_canvas_summary(mem.load("c1"))
        self.assertEqual(next(n for n in summary["nodes"] if n["id"] == "i1")["alias"], "图1")

    def test_thread_roundtrip_and_recent(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, patch.object(main, "AGENT_THREADS_DIR", tmp):
            main.agent_thread_append("c1", [{"role": "user", "text": "出一张猫"},
                                            {"role": "assistant", "text": "好了", "actions": ["generate_image 图3"]}],
                                     ["图3", "提示词2"])
            main.agent_thread_append("c1", [{"role": "assistant", "text": "改好了"}], ["图1"])
            thread = main.agent_thread_load("c1")
            self.assertEqual([m["text"] for m in thread["messages"]], ["出一张猫", "好了", "改好了"])
            self.assertEqual(thread["recent"][:3], ["图1", "图3", "提示词2"])
            hist = main._agent_thread_history(thread)
            self.assertIn("[动作] generate_image 图3", hist[1]["text"])
            asyncio.run(main.agent_thread_clear("c1"))
            self.assertEqual(main.agent_thread_load("c1")["messages"], [])


class VisionTests(unittest.TestCase):
    """P1：助手看图——能看图的模型直接给图；看不了就先转文字说明，并告诉用户。"""

    def _req(self, model):
        focus = main._agent_run_normalize_focus({"selected_node_ids": ["i2"], "reference_images": ["/assets/input/r.png"]})
        return {"canvas_id": "c1", "instruction": "这张图什么风格", "focus": focus, "history": [],
                "chat": {"provider": "x", "base": "https://x.invalid", "headers": {}, "model": model, "provider_cfg": {}},
                "max_steps": 6, "mode": "plan", "approved_steps": []}

    def _drain(self, req, chat_mock, caption_chat=None):
        patches = [patch.object(main, "load_canvas", side_effect=lambda cid: smart_canvas()),
                   patch.object(main, "agent_session_save"),
                   patch.object(main, "snapshot_canvas_version", return_value=1),
                   patch.object(main, "_agent_mutate_canvas", side_effect=lambda cid, fn: (smart_canvas(), None)),
                   patch.object(main, "reference_to_data_url", side_effect=lambda ref, max_size=None: "data:image/png;base64,QUJD"),
                   patch.object(main, "_agent_run_chat", new=chat_mock),
                   patch.object(main, "_agent_pick_caption_model", return_value=caption_chat),
                   patch.object(main, "_agent_captions_load", return_value={}),
                   patch.object(main, "_agent_captions_save")]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        main._AGENT_VISION_DENY.clear()

        async def go():
            queue = asyncio.Queue()
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, queue)
            out = []
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                out.append(item)
            return out
        chunks = asyncio.run(go())
        events = []
        for c in chunks:
            if c.startswith("event: "):
                name = c.split("\n")[0][len("event: "):]
                data = json.loads(c.split("data: ", 1)[1])
                events.append((name, data))
        return events

    def test_collect_images_labels_by_alias(self):
        cv = smart_canvas()
        main._agent_ensure_aliases(cv)
        focus = main._agent_run_normalize_focus({"selected_node_ids": ["i2", "p1"], "reference_images": ["/a/x.png", "/a/v.mp4"]})
        imgs = main._agent_run_collect_images(focus, cv)
        self.assertEqual([i["label"] for i in imgs], ["图2", "参考图1"])

    def test_vision_model_gets_real_images(self):
        chat = AsyncMock(return_value=json.dumps({"done": True, "message": "写实摄影风格"}, ensure_ascii=False))
        events = self._drain(self._req("gpt-4o"), chat)
        content = chat.await_args_list[0].args[1][1]["content"]
        self.assertIsInstance(content, list)
        self.assertEqual(sum(1 for p in content if p.get("type") == "image_url"), 2)
        self.assertIn(("vision", "direct"), [(n, d.get("mode")) for n, d in events])

    def test_text_model_gets_captions_and_user_is_told(self):
        cap_chat = {"provider": "v", "base": "https://v.invalid", "headers": {}, "model": "qwen-vl-max", "provider_cfg": {}}
        calls = []

        async def fake(chat, messages):
            calls.append((chat["model"], messages))
            if chat["model"] == "qwen-vl-max":
                return "一双红色运动鞋，白底棚拍"
            return json.dumps({"done": True, "message": "棚拍产品图风格"}, ensure_ascii=False)
        events = self._drain(self._req("deepseek-chat"), AsyncMock(side_effect=fake), cap_chat)
        main_calls = [m for model, m in calls if model == "deepseek-chat"]
        self.assertTrue(main_calls)
        self.assertIsInstance(main_calls[0][1]["content"], str)  # 文本模型不发图
        self.assertIn("一双红色运动鞋", main_calls[0][0]["content"])
        vision = [d for n, d in events if n == "vision"][0]
        self.assertEqual(vision["mode"], "caption")
        self.assertIn("看不了图", vision["text"])

    def test_model_rejecting_images_falls_back_to_captions(self):
        cap_chat = {"provider": "v", "base": "https://v.invalid", "headers": {}, "model": "qwen-vl-max", "provider_cfg": {}}
        state = {"n": 0}

        async def fake(chat, messages):
            if chat["model"] == "qwen-vl-max":
                return "白底红鞋"
            state["n"] += 1
            if isinstance(messages[1]["content"], list):
                raise main.AgentRunError("image not supported", code="provider_http_error")
            return json.dumps({"done": True, "message": "好"}, ensure_ascii=False)
        events = self._drain(self._req("gpt-4o-mini-text"), AsyncMock(side_effect=fake), cap_chat)
        modes = [d.get("mode") for n, d in events if n == "vision"]
        self.assertEqual(modes, ["direct", "caption"])
        self.assertIn("x:gpt-4o-mini-text", main._AGENT_VISION_DENY)
        self.assertEqual([n for n, _ in events][-1], "done")

    def test_no_vision_model_anywhere_is_honest(self):
        chat = AsyncMock(return_value=json.dumps({"done": True, "message": "好"}, ensure_ascii=False))
        events = self._drain(self._req("deepseek-chat"), chat, None)
        vision = [d for n, d in events if n == "vision"][0]
        self.assertEqual(vision["mode"], "none")
        self.assertIn("不要假装看过图", chat.await_args_list[0].args[1][0]["content"])


class TableBatchTests(unittest.TestCase):
    """第 38 轮：用户要「多维表格 / 批量」时，助手建「表格 → 批量生成」并交给页面逐行跑，而不是点对点出图。"""

    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())
        stub = patch.object(main, "_agent_validate_settings",
                            side_effect=lambda raw, kind: ({"ratio": "story"} if kind == "image" else {"ratio": "16:9"}) if raw else {})
        stub.start()
        self.addCleanup(stub.stop)

    def test_batch_generate_builds_table_batch_and_hands_run_to_page(self):
        rows = ["樱花粉连衣裙海报", "白色运动鞋海报", "风衣大片海报"]
        r = run_tool("batch_generate", {"canvas_id": "c1", "rows": rows, "settings": {"ratio": "3:4", "count": 4},
                                        "common_prompt": "春季上新，留出标题位", "inputs": ["i2"]})
        self.assertTrue(r["ok"], r)
        res = r["result"]
        table, batch = self.mem.node(res["table_node_id"]), self.mem.node(res["batch_node_id"])
        self.assertEqual(table["type"], "table")
        self.assertEqual(table["table"]["columns"], ["提示词"])
        self.assertEqual(table["table"]["rows"], [[x] for x in rows])
        self.assertEqual(table["table"]["selectedRows"], [0, 1, 2])   # 默认全选，否则页面一行都不跑
        self.assertEqual(batch["type"], "smart-batch")
        self.assertEqual(batch["runSettings"]["ratio"], "story")
        conns = self.mem.store["c1"]["connections"]
        self.assertIn({"from": table["id"], "to": batch["id"], "kind": "input"}, conns)
        self.assertIn({"from": "i2", "to": table["id"], "kind": "input"}, conns)
        prompt_id = res["prompt_node_id"]
        self.assertEqual(self.mem.node(prompt_id)["text"], "春季上新，留出标题位")
        self.assertIn({"from": prompt_id, "to": table["id"], "kind": "input"}, conns)
        self.assertEqual(res["client_action"], {"type": "run_batch", "node_id": batch["id"], "rows": 3})
        self.assertEqual(res["generation_units"], 3)
        self.assertEqual(table["alias"], "表格1")
        self.assertEqual(batch["alias"], "批量1")
        self.assertGreater(batch["x"], table["x"] + 500)

    def test_video_batch_and_cell_rows(self):
        r = run_tool("batch_generate", {"canvas_id": "c1", "media": "video", "columns": ["画面", "运镜"],
                                        "rows": [["海边日落", "缓慢推进"], ["城市夜景", "环绕"]], "run": False})
        self.assertTrue(r["ok"], r)
        batch = self.mem.node(r["result"]["batch_node_id"])
        self.assertTrue(batch["tableBatchVideo"])
        self.assertEqual(batch["runSettings"]["apiKind"], "video")
        self.assertNotIn("client_action", r["result"])
        self.assertEqual(self.mem.node(r["result"]["table_node_id"])["table"]["rows"][1], ["城市夜景", "环绕"])

    def test_empty_row_is_rejected(self):
        r = run_tool("batch_generate", {"canvas_id": "c1", "rows": ["a", "  "]})
        self.assertFalse(r["ok"])
        self.assertIn("第 2 行", r["error"])

    def test_units_and_impact_count_rows(self):
        steps = [{"tool": "batch_generate", "args": {"canvas_id": "c1", "rows": ["a", "b", "c", "d"]}}]
        self.assertEqual(main._agent_step_generation_units("batch_generate", steps[0]["args"], "c1"), 4)
        impact = main.agent_plan_impact(steps)
        self.assertEqual(impact["generations"], 4)
        self.assertEqual(impact["nodes"], 2)

    def test_create_table_and_batch_nodes_then_run_and_edit_rows(self):
        t = run_tool("create_node", {"canvas_id": "c1", "type": "table", "rows": ["一", "二"]})
        self.assertTrue(t["ok"], t)
        tid = t["result"]["node_id"]
        b = run_tool("create_node", {"canvas_id": "c1", "type": "batch", "inputs": [tid]})
        self.assertTrue(b["ok"], b)
        bid = b["result"]["node_id"]
        # 编号也能用：表格1 → 批量节点
        rb = run_tool("run_batch", {"canvas_id": "c1", "node_id": "表格1"})
        self.assertTrue(rb["ok"], rb)
        self.assertEqual(rb["result"]["client_action"]["node_id"], bid)
        self.assertEqual(rb["result"]["rows"], 2)
        up = run_tool("update_node", {"canvas_id": "c1", "node_id": tid, "append_rows": ["三"]})
        self.assertTrue(up["ok"], up)
        self.assertEqual(self.mem.node(tid)["table"]["rows"], [["一"], ["二"], ["三"]])
        self.assertEqual(self.mem.node(tid)["table"]["selectedRows"], [0, 1, 2])
        self.assertEqual(main._agent_step_generation_units("run_batch", {"canvas_id": "c1", "node_id": bid}), 3)

    def test_connect_rules_for_table_and_batch(self):
        run_tool("create_node", {"canvas_id": "c1", "type": "table", "rows": ["一"]})
        canvas = self.mem.store["c1"]
        tid = next(n["id"] for n in canvas["nodes"] if n["type"] == "table")
        self.assertEqual(main._agent_connect_check(canvas, "i2", tid), "")
        r = run_tool("create_node", {"canvas_id": "c1", "type": "batch", "inputs": ["i2"]})
        self.assertFalse(r["ok"])  # 批量节点只吃表格

    def test_summary_shows_table_rows(self):
        run_tool("create_node", {"canvas_id": "c1", "type": "table", "rows": ["春天", "夏天"]})
        canvas = self.mem.store["c1"]
        node = next(n for n in canvas["nodes"] if n["type"] == "table")
        summary = main._agent_node_summary(node, canvas=canvas)
        self.assertEqual(summary["rows"], 2)
        self.assertEqual(summary["kind"], "table")
        self.assertEqual(summary["rows_preview"], ["春天", "夏天"])



class ReviewTests(unittest.TestCase):
    """第 39 轮：生成后检查只给结论和建议步骤，不自己执行；批量只改、只重跑出问题的行。"""

    def setUp(self):
        canvas = smart_canvas()
        canvas["nodes"].append({"id": "i3", "type": "smart-image", "x": 400, "y": 400, "title": "Image", "created_at": 5,
                                "images": [{"url": "/output/c.png", "kind": "image"}], "inputNodeIds": ["p1"]})
        canvas["connections"].append({"from": "p1", "to": "i3", "kind": "input"})
        self.mem = MemoryCanvas(self, canvas)
        self.chat = {"provider": "v", "base": "http://x", "headers": {}, "model": "fake-vision", "provider_cfg": {}}
        for item in (patch.object(main, "_agent_image_payload_url", side_effect=lambda url: "data:image/png;base64,AA"),
                     patch.object(main, "_agent_validate_settings", side_effect=lambda raw, kind: {})):
            item.start()
            self.addCleanup(item.stop)

    def review(self, payload, reply, chat="default"):
        with patch.object(main, "_agent_review_pick_chat", return_value=self.chat if chat == "default" else chat), \
             patch.object(main, "_agent_run_chat", new=AsyncMock(return_value=json.dumps(reply, ensure_ascii=False))) as m:
            with contextlib.redirect_stdout(io.StringIO()):
                out = asyncio.run(main.agent_review(main.AgentReviewRequest(**payload)))
        return out, m

    def test_bad_image_gets_fix_steps_on_the_prompt_that_drives_it(self):
        out, m = self.review({"canvas_id": "c1", "instruction": "樱花粉海报，留出标题位",
                              "items": [{"node_id": "i3", "url": "/output/c.png"}]},
                             {"summary": "主色不对", "items": [{"label": "i3", "ok": False, "issues": ["主色偏橙"],
                                                             "revised_prompt": "樱花粉主色，左上留白"}]})
        self.assertEqual(out["mode"], "ok")
        v = out["items"][0]
        self.assertFalse(v["ok"])
        self.assertEqual(v["issues"], ["主色偏橙"])
        # i3 自己没写提示词，提示词来自上游 p1：改 p1，再重跑 i3
        self.assertEqual([s["tool"] for s in out["steps"]], ["update_node", "run_generation"])
        self.assertEqual(out["steps"][0]["args"]["node_id"], "p1")
        self.assertEqual(out["steps"][1]["args"]["node_id"], "i3")
        self.assertEqual(out["units"], 1)
        # 模型拿到了真图和用户原话
        sent = m.call_args[0][1][0]["content"]
        self.assertTrue(any(p.get("type") == "image_url" for p in sent))
        self.assertIn("樱花粉海报", sent[0]["text"])
        # 没有执行任何东西：p1 的提示词没变
        self.assertEqual(self.mem.node("p1")["text"], "黄昏海边的猫")

    def test_node_with_own_prompt_is_fixed_in_place(self):
        out, _ = self.review({"canvas_id": "c1", "items": [{"node_id": "i2", "url": "/output/a.png", "label": "图2"}]},
                             {"items": [{"label": "图2", "ok": False, "issues": ["背景不是白色"], "revised_prompt": "纯白底产品图"}]})
        self.assertEqual(out["steps"][0]["args"]["node_id"], "i2")

    def test_all_good_has_no_steps(self):
        out, _ = self.review({"canvas_id": "c1", "items": [{"node_id": "i2", "url": "/output/a.png", "label": "图2"}]},
                             {"summary": "都对", "items": [{"label": "图2", "ok": True, "issues": []}]})
        self.assertTrue(out["items"][0]["ok"])
        self.assertEqual(out["steps"], [])

    def test_no_vision_model_is_honest(self):
        out, _ = self.review({"canvas_id": "c1", "items": [{"node_id": "i2", "url": "/output/a.png"}]}, {}, chat=None)
        self.assertEqual(out["mode"], "none")
        self.assertIn("看图", out["text"])

    def test_batch_fixes_only_bad_rows_and_reruns_them(self):
        r = run_tool("batch_generate", {"canvas_id": "c1", "rows": ["一双白鞋", "一双黑鞋", "一双红鞋"], "run": False})
        bid, tid = r["result"]["batch_node_id"], r["result"]["table_node_id"]
        out, _ = self.review({"canvas_id": "c1", "batch_node_id": bid, "instruction": "每行一双鞋",
                              "items": [{"url": f"/output/r{i}.png", "row": i, "label": f"第 {i} 行", "node_id": bid} for i in (1, 2, 3)]},
                             {"items": [{"label": "第 1 行", "ok": True}, {"label": "第 2 行", "ok": False, "issues": ["出现了两双鞋"],
                                                                         "revised_prompt": "只有一双黑鞋"}, {"label": "第 3 行", "ok": True}]})
        self.assertEqual(out["units"], 1)
        upd, rerun = out["steps"]
        self.assertEqual(upd["args"]["rows"], [["一双白鞋"], ["只有一双黑鞋"], ["一双红鞋"]])
        self.assertEqual(rerun["args"], {"canvas_id": "c1", "node_id": bid, "row_numbers": [2]})
        # 批准后：改行、只勾选第 2 行，生成次数按 1 行算
        self.assertTrue(run_tool("update_node", upd["args"])["ok"])
        self.assertEqual(main._agent_step_generation_units("run_batch", rerun["args"]), 1)
        rb = run_tool("run_batch", rerun["args"])
        self.assertTrue(rb["ok"], rb)
        self.assertEqual(self.mem.node(tid)["table"]["selectedRows"], [1])
        self.assertEqual(rb["result"]["client_action"]["rows"], 1)

    def test_run_batch_rejects_bad_row_numbers(self):
        r = run_tool("batch_generate", {"canvas_id": "c1", "rows": ["a", "b"], "run": False})
        rb = run_tool("run_batch", {"canvas_id": "c1", "node_id": r["result"]["batch_node_id"], "row_numbers": [3]})
        self.assertFalse(rb["ok"])
        self.assertIn("1-2", rb["error"])


class TemplateTests(unittest.TestCase):
    """第 40 轮：流程模板 = 资产库「工作流」条目；存、列、按模板一键搭出并接着出图。"""

    def setUp(self):
        import tempfile, zipfile as _zip
        self._zip = _zip
        canvas = smart_canvas()
        canvas["nodes"].append({"id": "s1", "type": "smart-image", "x": -300, "y": 0, "title": "Image", "created_at": 6,
                                "images": [{"url": "/output/shoe.png", "kind": "image", "name": "shoe.png"}]})
        canvas["connections"].append({"from": "s1", "to": "i1", "kind": "input"})
        self.mem = MemoryCanvas(self, canvas)
        self.tmp = tempfile.mkdtemp()
        self.lib = main.default_asset_library()
        for item in (patch.object(main, "ASSET_LIBRARY_DIR", self.tmp),
                     patch.object(main, "load_asset_library", side_effect=lambda: self.lib),
                     patch.object(main, "save_asset_library", side_effect=lambda lib: None),
                     patch.object(main, "_agent_validate_settings", side_effect=lambda raw, kind: dict(raw or {}))):
            item.start()
            self.addCleanup(item.stop)

    def save(self, name="电商主图", ids=("s1", "p1", "i1")):
        return run_tool("save_template", {"canvas_id": "c1", "name": name, "node_ids": list(ids)})

    def test_save_template_lands_in_library_and_is_clean(self):
        r = self.save()
        self.assertTrue(r["ok"], r)
        items = [it for c in self.lib["libraries"][0]["categories"] if c["type"] == "workflow" for it in c["items"]]
        self.assertEqual([it["name"] for it in items], ["电商主图"])
        with self._zip.ZipFile(main._agent_template_path(items[0])) as zf:
            wf = json.loads(zf.read("workflow.json"))
        by = {n["id"]: n for n in wf["nodes"]}
        self.assertEqual(set(by), {"s1", "p1", "i1"})
        self.assertEqual(by["i1"]["images"], [])          # 生成节点不带上次结果
        self.assertEqual(len(by["s1"]["images"]), 1)       # 素材位保留素材
        self.assertNotIn("alias", by["i1"])
        self.assertEqual(len(wf["connections"]), 2)
        self.assertFalse(self.save()["ok"])                # 同名不覆盖

    def test_list_templates(self):
        self.save()
        r = run_tool("list_templates", {})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["templates"][0]["template"], "电商主图")
        self.assertEqual(r["result"]["templates"][0]["nodes"], 3)

    def test_http_list_and_clone_without_generation(self):
        from fastapi.testclient import TestClient
        self.save()
        client = TestClient(main.app)
        listing = client.get("/api/canvas-templates")
        self.assertEqual(listing.status_code, 200)
        item = listing.json()["templates"][0]
        self.assertEqual(item["name"], "电商主图")
        self.assertEqual(item["node_count"], 3)
        self.assertEqual(item["connection_count"], 2)
        self.assertEqual(item["input_count"], 1)
        self.assertEqual(item["generation_count"], 1)
        self.assertEqual(item["covers"], ["/output/shoe.png"])

        start = AsyncMock(side_effect=lambda cid, nid, **kw: {"task_id": "unexpected"})
        with patch.object(main, "_agent_start_node_generation", new=start):
            response = client.post("/api/canvas-templates/%s/apply" % item["id"], json={"canvas_id": "c1"})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertFalse(result["run"])
        self.assertEqual(result["node_count"], 3)
        self.assertEqual(result["task_ids"], [])
        start.assert_not_called()
        new_nodes = [self.mem.node(node_id) for node_id in result["node_ids"]]
        self.assertEqual(len(new_nodes), 3)
        prompt = next(n for n in new_nodes if n["type"] == "smart-prompt")
        gen = next(n for n in new_nodes if n["type"] == "smart-image" and not n.get("images"))
        self.assertIn({"from": prompt["id"], "to": gen["id"], "kind": "input"}, self.mem.store["c1"]["connections"])

    def test_apply_template_swaps_material_prompt_and_runs_first_layer(self):
        self.save()
        start = AsyncMock(side_effect=lambda cid, nid, **kw: {"task_id": "t-" + nid, "node_id": nid, "kind": "image"})
        with patch.object(main, "_agent_start_node_generation", new=start):
            r = run_tool("apply_template", {"canvas_id": "c1", "template": "电商", "inputs": ["i2"],
                                            "prompt": "白色运动鞋，纯白底", "settings": {"ratio": "1:1"}})
        self.assertTrue(r["ok"], r)
        res = r["result"]
        new = [self.mem.node(i) for i in res["node_ids"]]
        self.assertEqual(len(new), 3)
        slot = next(n for n in new if n["type"] == "smart-image" and n.get("images"))
        self.assertEqual(slot["images"][0]["url"], "/output/a.png")        # 素材位换成了 i2 的图
        prompt = next(n for n in new if n["type"] == "smart-prompt")
        self.assertEqual(prompt["text"], "白色运动鞋，纯白底")
        gen = next(n for n in new if n["type"] == "smart-image" and not n.get("images"))
        # apply 现在自己把原始冒号串归一成前端档位名（本用例把 _agent_validate_settings 打桩成透传）
        self.assertEqual(gen["runSettings"].get("ratio"), "square")
        conns = self.mem.store["c1"]["connections"]
        self.assertIn({"from": prompt["id"], "to": gen["id"], "kind": "input"}, conns)
        self.assertEqual(res["task_ids"], ["t-" + gen["id"]])             # 只跑第一层生成节点
        self.assertTrue(all(n["x"] > 800 for n in new))                    # 放在已有节点右边
        self.assertTrue(all(n.get("alias") for n in new))

    def test_units_and_impact(self):
        self.save()
        args = {"canvas_id": "c1", "template": "电商主图"}
        self.assertEqual(main._agent_step_generation_units("apply_template", args), 1)
        self.assertEqual(main._agent_step_generation_units("apply_template", {**args, "run": False}), 0)
        impact = main.agent_plan_impact([{"tool": "apply_template", "args": args}])
        self.assertEqual((impact["generations"], impact["nodes"]), (1, 3))

    def test_unknown_template_lists_choices(self):
        self.save()
        r = run_tool("apply_template", {"canvas_id": "c1", "template": "海报"})
        self.assertFalse(r["ok"])
        self.assertIn("电商主图", r["error"])


class NativeToolCallTests(unittest.TestCase):
    """第 41 轮：原生工具调用 —— tool_calls 直接变步骤；平台不认 tools 就退回 JSON 方式并记住。"""

    def setUp(self):
        main._AGENT_NATIVE_DENY.clear()
        self.chat = {"provider": "p", "base": "http://x", "headers": {}, "model": "m",
                     "provider_cfg": {"id": "p", "protocol": "openai"}}

    def test_tool_defs_cover_every_tool(self):
        defs = main._agent_native_tool_defs()
        names = {d["function"]["name"] for d in defs}
        self.assertEqual(names, set(main.AGENT_TOOLS))
        gen = next(d for d in defs if d["function"]["name"] == "update_node")["function"]["parameters"]
        self.assertIn("description", gen["properties"])
        self.assertNotIn("canvas_id", gen.get("required", []))

    def test_tool_calls_become_steps_with_canvas_filled(self):
        raw = {"choices": [{"message": {"content": "把图3 改成横版", "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "update_node",
             "arguments": json.dumps({"node_id": "图3", "settings": {"ratio": "16:9"}, "description": "把图3 的比例改成 16:9"})}}]}}]}
        d = main._agent_decision_from_native(raw, "c1")
        self.assertFalse(d["done"])
        self.assertEqual(d["intent"], "把图3 改成横版")
        self.assertEqual(d["steps"], [{"tool": "update_node", "description": "把图3 的比例改成 16:9",
                                       "args": {"node_id": "图3", "settings": {"ratio": "16:9"}, "canvas_id": "c1"}}])

    def test_json_text_with_stray_newlines_from_platform(self):
        """第 45 轮：某平台 gemini 把方案写在正文里，分片拼接插入了真实换行（用户截图原样）。"""
        content = ('```json\n{\n  "intent": "提取图\n89的人物面部并生成真实质感的纯白背景三视图",\n  "steps": [\n    {\n      \n"tool": "generate_image",\n'
                   '      "args": {\n        "prompt": "从原图中提取\n人物面部主体，去除原背景及所有杂物",\n'
                   '        "reference_urls": ["/assets/input/ai_ref_3b28b64cdbf4.jpg"], "provider": "my-platform", "model": "gemini-3-pro"\n      },\n'
                   '      "description": "生成三视图"\n    }\n  ]\n}\n```')
        d = main._agent_decision_from_native({"choices": [{"message": {"content": content}}]}, "c1")
        self.assertEqual(d["intent"], "提取图89的人物面部并生成真实质感的纯白背景三视图")
        self.assertEqual(d["steps"][0]["tool"], "generate_image")
        self.assertEqual(d["steps"][0]["args"]["prompt"], "从原图中提取人物面部主体，去除原背景及所有杂物")
        self.assertEqual(d["steps"][0]["args"]["canvas_id"], "c1")
        # JSON 方式同样认得
        self.assertEqual(main._agent_run_parse_round(content)["steps"][0]["tool"], "generate_image")
        # 正常转义的换行保留
        self.assertEqual(main._agent_json_loads('{"a": "x\\ny"}')["a"], "x\ny")

    def test_unparseable_plan_text_is_not_shown_as_reply(self):
        bad = '```json\n{"intent": "x", "steps": [{"tool": "generate_image", "args": {"prompt": "a" ]}\n```'
        with self.assertRaises(main.AgentRunError) as cm:
            main._agent_decision_from_native({"choices": [{"message": {"content": bad}}]}, "c1")
        self.assertEqual(cm.exception.code, "bad_model_json")

    def test_plain_text_is_the_reply_and_json_text_still_works(self):
        d = main._agent_decision_from_native({"choices": [{"message": {"content": "你想要几张？"}}]}, "c1")
        self.assertEqual((d["done"], d["message"]), (True, "你想要几张？"))
        d = main._agent_decision_from_native({"choices": [{"message": {"content": '{"done": false, "steps": [{"tool": "get_canvas", "args": {}}]}'}}]}, "c1")
        self.assertEqual(d["steps"][0]["tool"], "get_canvas")
        with self.assertRaises(main.AgentRunError):
            main._agent_decision_from_native({"choices": [{"message": {"content": ""}}]}, "c1")

    def test_decide_uses_native_when_supported(self):
        raw = {"choices": [{"message": {"content": "", "tool_calls": [
            {"function": {"name": "get_canvas", "arguments": "{}"}}]}}]}
        native = AsyncMock(return_value=raw)
        text = AsyncMock(return_value='{"done": true, "message": "x"}')
        with patch.object(main, "effective_protocol", return_value="openai"), \
             patch.object(main, "_agent_run_chat_raw", new=native), patch.object(main, "_agent_run_chat", new=text):
            d = asyncio.run(main._agent_run_decide(self.chat, "SYS TOOLS", "hi", "c1", "TOOLS"))
        self.assertEqual(d["steps"][0], {"tool": "get_canvas", "args": {"canvas_id": "c1"}, "description": ""})
        sent = native.call_args
        self.assertTrue(sent.kwargs["tools"])
        self.assertIn("工具定义见函数调用列表", sent.args[1][0]["content"])   # 原生模式不再塞整份工具 JSON
        text.assert_not_called()

    def test_decide_falls_back_and_remembers_when_platform_rejects_tools(self):
        native = AsyncMock(side_effect=main.AgentRunError("tools not supported", code="provider_http_error"))
        text = AsyncMock(return_value='{"done": true, "message": "好的"}')
        with patch.object(main, "effective_protocol", return_value="openai"), \
             patch.object(main, "_agent_run_chat_raw", new=native), patch.object(main, "_agent_run_chat", new=text), \
             contextlib.redirect_stdout(io.StringIO()):
            d = asyncio.run(main._agent_run_decide(self.chat, "SYS", "hi", "c1"))
            self.assertEqual(d["message"], "好的")
            self.assertFalse(main._agent_native_enabled(self.chat))         # 记住了：之后直接走 JSON
            asyncio.run(main._agent_run_decide(self.chat, "SYS", "hi", "c1"))
        self.assertEqual(native.call_count, 1)

    def test_switch_off_and_unknown_protocol(self):
        with patch.object(main, "effective_protocol", return_value="gemini"):
            self.assertFalse(main._agent_native_enabled(self.chat))
        with patch.dict(os.environ, {"NOVAI_AGENT_NATIVE_TOOLS": "0"}), patch.object(main, "effective_protocol", return_value="openai"):
            self.assertFalse(main._agent_native_enabled(self.chat))
        self.assertFalse(main._agent_native_enabled({**self.chat, "provider_cfg": {}}))


class MemoryTests(unittest.TestCase):
    """第 42 轮：项目记忆 —— 只在明确要求时记；两层（这张画布 / 所有画布）；每轮带进上下文；能改能删。"""

    def setUp(self):
        import tempfile
        self.mem = MemoryCanvas(self, smart_canvas())
        self.dir = tempfile.mkdtemp()
        p = patch.object(main, "AGENT_MEMORY_DIR", self.dir)
        p.start(); self.addCleanup(p.stop)
        w = patch.object(main, "write_json_atomic", side_effect=self._write)
        w.start(); self.addCleanup(w.stop)

    def _write(self, path, data, **kw):
        if str(path).startswith("mem://"):
            self.mem.store[str(path)[6:]] = json.loads(json.dumps(data)); return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def test_remember_two_scopes_and_no_duplicates(self):
        r = run_tool("remember", {"canvas_id": "c1", "items": ["以后默认 3:4 竖版", "模型用 Seedream 4.0"]})
        self.assertTrue(r["ok"], r)
        self.assertEqual([i["text"] for i in r["result"]["memory"]["items"]], ["以后默认 3:4 竖版", "模型用 Seedream 4.0"])
        self.assertEqual(r["result"]["memory"]["scope"], "canvas")
        r2 = run_tool("remember", {"canvas_id": "c1", "items": ["以后默认 3:4 竖版"]})
        self.assertEqual(r2["result"]["memory"]["items"], [])
        run_tool("remember", {"canvas_id": "c1", "items": ["品牌主色 #E8505B"], "scope": "global"})
        self.assertEqual(len(main.agent_memory_load("c1", "canvas")), 2)
        self.assertEqual([i["text"] for i in main.agent_memory_load("other", "global")], ["品牌主色 #E8505B"])  # 所有画布通用
        self.assertEqual(main.agent_memory_load("other", "canvas"), [])

    def test_prompt_carries_memory(self):
        run_tool("remember", {"canvas_id": "c1", "items": ["以后默认 3:4 竖版"]})
        run_tool("remember", {"canvas_id": "c1", "items": ["品牌主色 #E8505B"], "scope": "global"})
        text = main._agent_memory_prompt("c1")
        self.assertIn("项目记忆", text)
        self.assertIn("这张画布：\n- 以后默认 3:4 竖版", text)
        self.assertIn("所有画布：\n- 品牌主色 #E8505B", text)
        other = main._agent_memory_prompt("other")          # 别的画布只带「所有画布」那几条
        self.assertIn("品牌主色", other)
        self.assertNotIn("3:4", other)

    def test_forget_by_keyword_across_scopes(self):
        run_tool("remember", {"canvas_id": "c1", "items": ["以后默认 3:4 竖版"]})
        run_tool("remember", {"canvas_id": "c1", "items": ["品牌主色 #E8505B"], "scope": "global"})
        r = run_tool("forget", {"canvas_id": "c1", "text": "主色"})
        self.assertTrue(r["ok"], r)
        self.assertEqual([i["text"] for i in r["result"]["memory"]["items"]], ["品牌主色 #E8505B"])
        self.assertEqual(main.agent_memory_load("c1", "global"), [])
        self.assertEqual(len(main.agent_memory_load("c1", "canvas")), 1)

    def test_endpoints_edit_and_delete(self):
        added = asyncio.run(main.agent_memory_post(main.AgentMemoryItemRequest(canvas_id="c1", text="人物统一亚洲面孔")))["added"][0]
        asyncio.run(main.agent_memory_put(added["id"], main.AgentMemoryItemRequest(canvas_id="c1", text="人物统一亚洲面孔，自然光")))
        got = asyncio.run(main.agent_memory_get("c1"))
        self.assertEqual(got["canvas"][0]["text"], "人物统一亚洲面孔，自然光")
        asyncio.run(main.agent_memory_delete(added["id"], canvas_id="c1", scope="canvas"))
        self.assertEqual(asyncio.run(main.agent_memory_get("c1"))["canvas"], [])

    def test_memory_steps_run_without_plan_card(self):
        self.assertTrue(main._agent_steps_are_free([{"tool": "remember", "args": {}}]))
        self.assertFalse(main._agent_steps_are_free([{"tool": "remember", "args": {}}, {"tool": "generate_image", "args": {}}]))


class ChainTests(unittest.TestCase):
    """第 43 轮：串起来的流程整条跑完 —— 上游齐了马上跑，其余等前面写回结果后自动接着跑。"""

    def setUp(self):
        import tempfile
        canvas = smart_canvas()
        # p1 → i1(空，生成) → v1(空视频，生成) ；i2 有图 → v2(空)
        canvas["nodes"] += [
            {"id": "v1", "type": "smart-image", "x": 800, "y": 0, "images": [], "created_at": 7,
             "runSettings": {"engine": "api", "apiKind": "video"}, "inputNodeIds": ["i1"]},
            {"id": "v2", "type": "smart-image", "x": 1200, "y": 0, "images": [], "created_at": 8,
             "runSettings": {"engine": "api", "apiKind": "video"}, "inputNodeIds": ["i2"]},
        ]
        canvas["connections"] += [{"from": "i1", "to": "v1", "kind": "input"}, {"from": "i2", "to": "v2", "kind": "input"}]
        self.mem = MemoryCanvas(self, canvas)
        tmp = tempfile.mkdtemp()
        p = patch.object(main, "AGENT_CHAINS_FILE", os.path.join(tmp, "chains.json"))
        p.start(); self.addCleanup(p.stop)
        w = patch.object(main, "write_json_atomic", side_effect=self._write)
        w.start(); self.addCleanup(w.stop)
        self.started = []

        async def start(cid, nid, **kw):
            self.started.append(nid)
            def _m(cv):
                n = main._agent_find_node(cv, nid)
                n["pendingTasks"] = [{"taskId": "t-" + nid}]
            main._agent_mutate_canvas(cid, _m)
            return {"task_id": "t-" + nid, "node_id": nid, "kind": "image"}
        s = patch.object(main, "_agent_start_node_generation", new=AsyncMock(side_effect=start))
        s.start(); self.addCleanup(s.stop)
        b = patch.object(main.manager, "broadcast_canvas_updated", new=AsyncMock())
        b.start(); self.addCleanup(b.stop)

    def _write(self, path, data, **kw):
        if str(path).startswith("mem://"):
            self.mem.store[str(path)[6:]] = json.loads(json.dumps(data)); return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def finish(self, nid):
        def _m(cv):
            n = main._agent_find_node(cv, nid)
            n.pop("pendingTasks", None)
            n["images"] = [{"url": f"/output/{nid}.png", "kind": "image"}]
        main._agent_mutate_canvas("c1", _m)
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_chain_advance("c1"))

    def test_runs_first_wave_then_continues_after_writeback(self):
        r = run_tool("run_downstream", {"canvas_id": "c1", "node_id": "p1"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.started, ["i1"])                  # v1 要等 i1 出结果
        self.assertEqual(r["result"]["generation_units"], 2)
        self.assertEqual(len(main._agent_chains_load()), 1)
        self.finish("i1")
        self.assertEqual(self.started, ["i1", "v1"])            # i1 写回后自动接着跑 v1
        self.assertEqual(main._agent_chains_load(), [])         # 链条跑完就清掉

    def test_upstream_with_result_runs_immediately(self):
        r = run_tool("run_downstream", {"canvas_id": "c1", "node_id": "i2"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.started, ["v2"])
        self.assertEqual(main._agent_chains_load(), [])

    def test_units_counted_for_whole_chain(self):
        self.assertEqual(main._agent_step_generation_units("run_downstream", {"canvas_id": "c1", "node_id": "p1"}), 2)

    def test_failed_upstream_stops_chain_and_says_why(self):
        run_tool("run_downstream", {"canvas_id": "c1", "node_id": "p1"})
        def _m(cv):
            n = main._agent_find_node(cv, "i1")
            n.pop("pendingTasks", None)
            n["lastTaskStatus"] = "failed"
        main._agent_mutate_canvas("c1", _m)
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_chain_advance("c1"))
        self.assertEqual(self.started, ["i1"])
        self.assertIn("没生成成功", self.mem.node("v1")["lastTaskError"])
        self.assertEqual(main._agent_chains_load(), [])

    def test_nothing_to_run(self):
        r = run_tool("run_downstream", {"canvas_id": "c1", "node_id": "i2"})
        self.finish("v2")
        r = run_tool("run_downstream", {"canvas_id": "c1", "node_id": "i2"})
        self.assertFalse(r["ok"])
        self.assertIn("没有还没出结果", r["error"])


class ArrangeTests(unittest.TestCase):
    """第 44 轮：一键整理只下发给页面（要用真实节点大小排），不改服务端画布、不出方案卡。"""

    def setUp(self):
        self.mem = MemoryCanvas(self, smart_canvas())

    def test_whole_canvas(self):
        before = json.dumps(self.mem.store["c1"], sort_keys=True)
        r = run_tool("arrange_canvas", {"canvas_id": "c1"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["client_action"], {"type": "arrange", "node_ids": []})
        self.assertEqual(json.dumps(self.mem.store["c1"], sort_keys=True), before)   # 服务端画布不动

    def test_one_node_expands_to_its_chain(self):
        r = run_tool("arrange_canvas", {"canvas_id": "c1", "node_ids": ["i1"]})
        self.assertEqual(sorted(r["result"]["client_action"]["node_ids"]), ["i1", "p1"])

    def test_free_step(self):
        self.assertTrue(main._agent_steps_are_free([{"tool": "arrange_canvas", "args": {}}]))
        self.assertEqual(main._agent_step_generation_units("arrange_canvas", {"canvas_id": "c1"}), 0)


if __name__ == "__main__":
    unittest.main()
