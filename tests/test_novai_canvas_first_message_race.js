#!/usr/bin/env node
/* L5：新画布第一条消息不能被「历史还在加载」冲掉。
   复现路径：loadThreadMessages 请求在飞 + 用户刚发第一条消息（本地 append）→ 历史回来后
   必须把本地消息保留下来（用户消息 + 「正在思考」占位），否则面板看起来发了没反应。
   跑法：node tests/test_novai_canvas_first_message_race.js（run-all 会自动带上） */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function loadAgentState() {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/state.ts')],
        bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    });
    const canvasRequire = (id) => {
        if (id.startsWith('.') || path.isAbsolute(id)) return require(id);
        try { return require(path.join(root, 'novai-canvas-ui/node_modules', id)); }
        catch (error) { return require(id); }
    };
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, canvasRequire);
    return module.exports;
}

/* 宿主桥：task.command 被 AgentState 用来拉线程；localStorage 给 read/write 兜底 */
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.localStorage = storage;
let threadsActive = "th1";
const calls = [];
let pendingMessages = null;

function command(request) {
    calls.push(request);
    const type = String(request && request.type || "");
    if (type === "thread/list") {
        return Promise.resolve({ ok: true, activeId: threadsActive, threads: [{ id: "th1", title: "对话 1" }] });
    }
    if (type === "thread/messages") {
        return new Promise((resolve) => { pendingMessages = resolve; });
    }
    return Promise.resolve({ ok: false, error: "NOT_SUPPORTED" });
}
global.window = { novai: { task: { command } } };

const { AgentState } = loadAgentState();

async function waitFor(cond, label, timeout = 1000) {
    const started = Date.now();
    while (!cond()) {
        if (Date.now() - started > timeout) throw new Error("等不到：" + label);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

(async () => {
    const state = new AgentState("c1");
    state.activeThreadId = "th1";

    /* 1) 历史加载在飞时发第一条消息 → 回来不能冲掉本地消息 */
    const loading = state.loadThreadMessages("th1");
    state.appendMessage({ id: "local-u", role: "u", text: "帮我做一张海报", at: 1 }, "th1");
    state.appendMessage({ id: "local-a", role: "a", text: "", at: 2, think: { live: true, open: false, secs: "0", lines: [] } }, "th1");
    await waitFor(() => !!pendingMessages, "线程消息请求发出");
    pendingMessages({ ok: true, messages: [{ role: "user", content: "很早以前的一条消息", at: 0 }], start: 0, has_more: false });
    await loading;

    const msgs = state.threadMessages("th1");
    const texts = msgs.map((m) => m.text);
    assert.ok(texts.includes("帮我做一张海报"), "用户刚发的消息不能被历史覆盖：" + JSON.stringify(texts));
    assert.ok(msgs.some((m) => m.role === "a" && m.think && m.think.live), "「正在思考」占位还在，回复才有地方显示");
    assert.ok(texts.includes("很早以前的一条消息"), "旧历史要接在前面，不是整段丢掉");
    assert.ok(texts.indexOf("很早以前的一条消息") < texts.indexOf("帮我做一张海报"), "顺序：旧的在前、新的在后");

    /* 2) 没有并发发送时，历史就是整段替换（不堆重复） */
    pendingMessages = null;
    const second = state.loadThreadMessages("th1");
    await waitFor(() => !!pendingMessages, "第二次线程消息请求发出");
    pendingMessages({ ok: true, messages: [{ role: "user", content: "服务端的一条", at: 0 }], start: 0, has_more: false });
    await second;
    const after = state.threadMessages("th1");
    assert.strictEqual(after.length, 1, "顺序读取时按服务端历史整体替换");
    assert.strictEqual(after[0].text, "服务端的一条");

    /* 3) 面板接线：结束后没拿到可见回复要主动读一次线程；模型清单没加载完不能吞掉第一条消息 */
    const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
    assert.ok(/settled && !nextText && threadId && threadId !== "__new__"/.test(panel),
        "结束后没有可见回复时要读一次线程（不刷新也能看到回复）");
    assert.ok(/loadThreadMessages\(threadId\)\.then/.test(panel), "读线程后要重绘面板");
    assert.ok(/for \(let i = 0; i < 24 && !store\.state\.models\.length; i \+= 1\)/.test(panel),
        "模型清单还在加载时要等一会儿，别把刚发出去的第一条消息吞掉");

    console.log("first-message-race ok：3 组断言通过");
})().catch((error) => { console.error(error); process.exit(1); });
