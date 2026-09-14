#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨语言对拍：前端 NovaWorkflowUtils.rowIntent 与后端 _run_row_intent 必须完全一致。

后端解析由 node 执行真实的前端实现，Python 侧调用真实的 main.py 函数，逐例比对。
运行： python tests/test_row_intent_parity.py
"""
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

CASES = [
    {"type": "image", "references": []},
    {"type": "image", "references": [{"url": "a.png"}]},
    {"type": "video", "references": []},
    {"type": "video", "references": [{"url": "a.png"}]},
    {"type": "IMAGE", "references": []},
    {"type": "VIDEO", "references": [{"url": "a.png"}]},
    {"references": []},
    {},
]


def frontend_intents(cases):
    script = (
        "const W=require(process.argv[1]);"
        "console.log(JSON.stringify(process.argv[2] ? JSON.parse(process.argv[2]).map(c=>W.rowIntent(c)) : []));"
    )
    module = os.path.join(BASE, "static", "js", "shared", "workflow-utils.js")
    out = subprocess.run(
        ["node", "-e", script, module, json.dumps(cases)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout.strip())


def main():
    import main as backend
    js_intents = frontend_intents(CASES)
    py_intents = [backend._run_row_intent(case) for case in CASES]
    failures = []
    for case, js_value, py_value in zip(CASES, js_intents, py_intents):
        if js_value != py_value:
            failures.append("%r -> 前端=%s 后端=%s" % (case, js_value, py_value))
    print("对拍 %d 例，一致 %d 例" % (len(CASES), len(CASES) - len(failures)))
    if failures:
        for item in failures:
            print("  不一致：" + item)
        return 1
    print("前后端 intent 判定完全一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())