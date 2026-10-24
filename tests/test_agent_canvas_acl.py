# -*- coding: utf-8 -*-
"""三个 Agent 路由的画布级权限：登录后按 owner/admin/editor/viewer 判定（与其它画布路由一致）。

覆盖：
  1. auth-off（request_auth_user 返回 None）：三条路由都放行；
  2. viewer：run（不带 approved_steps）放行、run（带 approved_steps）403「需要可编辑权限」、
     stream 放行、steer 403；
  3. editor / owner：三条都放行；
  4. 不存在的 run：stream / steer 仍 404「run 不存在或已过期」；
  5. 画布被删（bus 在、load_canvas 404）：404「画布不存在」；
  6. 403 发生在返回 StreamingResponse 之前（await 路由函数即可捕获，且不会新建 bus）。

身份与角色用 patch 控制（不建 users.db、不真起服务、不调模型）。
"""
import asyncio
import contextlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-canvas-acl-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "owner_id": 1,
            "nodes": [], "connections": [], "updated_at": 1700000000000}


def chat_config():
    return {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
            "provider_cfg": {}}


def request():
    """占位 request：身份与角色都在 _enter() 里 patch 掉，这里不需要真实属性。"""
    return object()


def payload(approved=False):
    # 注意：AgentRunRequest 的 approved_steps 有个 before 校验器，只认 dict（FastAPI 传进来的就是 dict），
    # 直接塞 AgentRunStep 实例会被它丢掉——这里按线上形状给 dict。
    steps = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"},
              "description": "建提示词节点"}] if approved else []
    return main.AgentRunRequest(canvas_id="c1", instruction="做个海报", mode="run",
                                approved_steps=steps)


async def _noop_drive(req, bus):
    """替换后台 producer：这些用例只验证入口权限，不跑真实循环。"""
    return None


class CanvasAclTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def _enter(self, role, canvas_error=None):
        """role=None → auth-off；否则视为已登录、角色为 role。返回 ExitStack 供 with 使用。"""
        stack = contextlib.ExitStack()
        user = None if role is None else {"id": 2, "role": "user"}
        stack.enter_context(patch.object(main, "request_auth_user", return_value=user))
        stack.enter_context(patch.object(main, "canvas_access_role", return_value=role))
        if canvas_error is not None:
            stack.enter_context(patch.object(main, "load_canvas", side_effect=canvas_error))
        else:
            stack.enter_context(patch.object(main, "load_canvas", return_value=canvas()))
        stack.enter_context(patch.object(main, "_agent_run_resolve_chat", return_value=chat_config()))
        stack.enter_context(patch.object(main, "_agent_run_bus_drive", new=_noop_drive))
        return stack

    # ---------------------------------------------------------------- auth-off

    def test_auth_off_allows_all_three_routes(self):
        async def go():
            main._agent_run_bus_new("run_auth_off", "c1")
            resp = await main.agent_run(payload(approved=True), request())
            stream = await main.agent_run_stream("run_auth_off", request(), 0, None)
            steer = await main.agent_run_steer("run_auth_off",
                                               main.AgentRunSteerRequest(message="换个风格"), request())
            await asyncio.sleep(0)          # 放后台任务跑完（已是 noop）
            return resp, stream, steer

        with self._enter(None):
            resp, stream, steer = asyncio.run(go())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(stream.status_code, 200)
        self.assertEqual(steer, {"accepted": True, "pending": 1})

    # ---------------------------------------------------------------- viewer

    def test_viewer_can_run_without_approved_steps(self):
        async def go():
            return await main.agent_run(payload(approved=False), request())

        with self._enter("viewer"):
            resp = asyncio.run(go())
        self.assertEqual(resp.status_code, 200)

    def test_viewer_cannot_run_with_approved_steps(self):
        async def go():
            return await main.agent_run(payload(approved=True), request())

        before = set(main._AGENT_RUN_BUS)
        with self._enter("viewer"):
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(go())
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(str(caught.exception.detail), "需要可编辑权限")
        # 403 在创建 bus / 返回 StreamingResponse 之前就抛了
        self.assertEqual(set(main._AGENT_RUN_BUS), before)

    def test_viewer_can_stream_but_cannot_steer(self):
        async def go():
            main._agent_run_bus_new("run_viewer", "c1")
            stream = await main.agent_run_stream("run_viewer", request(), 0, None)
            with self.assertRaises(main.HTTPException) as caught:
                await main.agent_run_steer("run_viewer",
                                           main.AgentRunSteerRequest(message="换个风格"), request())
            return stream, caught.exception

        with self._enter("viewer"):
            stream, blocked = asyncio.run(go())
        self.assertEqual(stream.status_code, 200)
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(str(blocked.detail), "需要可编辑权限")
        # 被拦下的插话不能进队列
        self.assertEqual(main._agent_run_bus_drain_steer("run_viewer"), [])

    # ---------------------------------------------------------------- editor / owner

    def test_editor_and_owner_can_do_everything(self):
        for role in ("editor", "owner"):
            with self.subTest(role=role):
                main._AGENT_RUN_BUS.clear()
                run_id = "run_%s" % role

                async def go():
                    resp = await main.agent_run(payload(approved=True), request())
                    main._agent_run_bus_new(run_id, "c1")
                    stream = await main.agent_run_stream(run_id, request(), 0, None)
                    steer = await main.agent_run_steer(run_id,
                                                       main.AgentRunSteerRequest(message="换个风格"), request())
                    await asyncio.sleep(0)
                    return resp, stream, steer

                with self._enter(role):
                    resp, stream, steer = asyncio.run(go())
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(stream.status_code, 200)
                self.assertTrue(steer["accepted"])

    # ---------------------------------------------------------------- 404 分支

    def test_unknown_run_is_404(self):
        async def go():
            with self.assertRaises(main.HTTPException) as stream_err:
                await main.agent_run_stream("run_missing", request(), 0, None)
            with self.assertRaises(main.HTTPException) as steer_err:
                await main.agent_run_steer("run_missing",
                                           main.AgentRunSteerRequest(message="x"), request())
            return stream_err.exception, steer_err.exception

        with self._enter("viewer"):
            stream_err, steer_err = asyncio.run(go())
        for exc in (stream_err, steer_err):
            self.assertEqual(exc.status_code, 404)
            self.assertIn("run 不存在或已过期", str(exc.detail))

    def test_deleted_canvas_is_404(self):
        async def go():
            main._agent_run_bus_new("run_gone", "c1")
            with self.assertRaises(main.HTTPException) as caught:
                await main.agent_run_stream("run_gone", request(), 0, None)
            return caught.exception

        with self._enter("owner", canvas_error=main.HTTPException(status_code=404, detail="画布不存在")):
            exc = asyncio.run(go())
        self.assertEqual(exc.status_code, 404)
        self.assertIn("画布不存在", str(exc.detail))

    def test_bus_created_for_old_runs_without_canvas_is_not_blocked(self):
        # 历史/非画布 run（bus 没有 canvas_id）：不误伤，权限判定直接放行
        async def go():
            main._agent_run_bus_new("run_no_canvas")
            return await main.agent_run_stream("run_no_canvas", request(), 0, None)

        with self._enter("viewer"):
            resp = asyncio.run(go())
        self.assertEqual(resp.status_code, 200)


if __name__ == "__main__":
    unittest.main()
