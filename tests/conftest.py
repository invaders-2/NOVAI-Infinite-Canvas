# -*- coding: utf-8 -*-
"""pytest 全局约定（后端用例）。

2026-11 起后端默认走流式（NOVAI_AGENT_V2_STREAM 默认开）。本目录里大量 producer 用例是
「非流式一次性返回」的行为快照（统一打桩 main._agent_run_chat），默认走流式会让它们去打真网络、
从而变成另一套断言。所以这里统一把历史用例钉在非流式：

- 测流式行为：用例自己 `patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"})`，
  见 tests/test_agent_stream_events.py、tests/test_agent_run_stream.py；
- 测「默认值」：用例里先 `os.environ.pop("NOVAI_AGENT_V2_STREAM")`，见
  tests/test_sse_not_gzipped.py::test_stream_enabled_by_default_and_can_be_switched_off。

后端默认值本身由 tests/test_sse_not_gzipped.py 守，不靠这里。
"""
import pytest


@pytest.fixture(autouse=True)
def _non_stream_for_legacy_snapshots(monkeypatch):
    monkeypatch.setenv("NOVAI_AGENT_V2_STREAM", "0")
