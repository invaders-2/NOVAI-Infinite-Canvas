#!/usr/bin/env node
/* task-7：节点编辑器「优化提示词」不再因为切节点 / 关面板中断。
   用 esbuild 打包 optimizeTasks.ts，配假 store + 假 backend.chat 覆盖：
   · 切节点（面板卸载）不 abort，流式文本只收集不渲染，切回来接上当前草稿；
   · 结果按发起时的 nodeId 写回原节点并 toast；
   · 再点一次（显式取消）才 abort，且不写回、提示「未改动」；
   · 两个节点可并行，各自写回各自的节点；
   · 节点被删除时结束任务，不写回。
   另外静态断言 OptimizeButton.tsx 已改为从注册表取状态，卸载不再 abort。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');

const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        logLevel: 'silent',
        loader: { '.css': 'empty' },
    });
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
    return mod.exports;
}

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const t = load('novai-canvas-ui/src/canvas/canvas-next/ui/optimizeTasks.ts');
const TICK = () => new Promise((r) => setTimeout(r, 0));

const TEXT_MODEL = { id: 'm1', name: '假文本模型', kind: 'text' };

function makeNode(id, prompt) {
    return model.newNode('text', 0, 0, { id, prompt, title: '节点' + id });
}

/** 假 store：只实现优化任务用到的那部分；patchGen 走真的 withGen，writes 记录每次写回 */
function makeStore(nodes, chat) {
    const listeners = new Set();
    const store = {
        writes: [],
        toasts: [],
        state: { canvasId: 'c1', doc: { nodes, edges: [], comments: [] }, models: [TEXT_MODEL], runtime: {}, ui: { sel: new Set() } },
        backend: { kind: 'mock', chat },
        node: (id) => store.state.doc.nodes.find((n) => n.id === id),
        patchGen(id, patch, opts = {}) {
            store.writes.push({ id, patch, opts });
            const doc = store.state.doc;
            store.state = {
                ...store.state,
                doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? model.withGen(n, typeof patch === 'function' ? patch(model.genOf(n)) : patch) : n)) },
            };
            store.emit();
        },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        emit() { for (const fn of [...listeners]) fn(); },
        toast(html) { store.toasts.push(String(html)); },
        optimizeModel: () => undefined,
        defaultModel: () => TEXT_MODEL,
        modelOf: () => undefined,
    };
    return store;
}

/** 假后端 chat：不联网，手动 delta / resolve / abort；abort 时像真后端一样 reject */
function makeChat() {
    const calls = [];
    const chat = (req, onDelta, signal) => new Promise((resolve, reject) => {
        let settled = false;
        const call = {
            req, onDelta, signal,
            resolve: (v) => { if (!settled) { settled = true; resolve(v); } },
            reject: (e) => { if (!settled) { settled = true; reject(e); } },
        };
        signal.addEventListener('abort', () => call.reject(new Error('STOPPED')));
        calls.push(call);
    });
    return { calls, chat };
}

const genPrompt = (store, id) => model.genOf(store.node(id)).prompt;
const removeNode = (store, id) => {
    store.state = { ...store.state, doc: { ...store.state.doc, nodes: store.state.doc.nodes.filter((n) => n.id !== id) } };
    store.emit();
};

async function testSwitchNodeKeepsRunning() {
    const chat = makeChat();
    const store = makeStore([makeNode('a', '一只猫'), makeNode('b', '原提示词B')], chat.chat);

    t.startOptimize(store, 'a', { draft: '一只猫', undoHint: '⌘Z' });
    assert.equal(t.isOptimizing('a'), true, '发起后注册表里有一个任务');
    assert.equal(chat.calls.length, 1);

    const seen = [];
    const detach = t.attachOptimizeView('a', (v) => seen.push(v));
    assert.deepEqual(seen, ['一只猫'], '刚挂上面板先显示发起时的草稿');
    chat.calls[0].onDelta('一只猫');
    assert.deepEqual(seen, ['一只猫', '一只猫'], '流式文本写进当前面板');

    detach(); // 切到别的节点 = 面板卸载
    chat.calls[0].onDelta('一只猫在沙发上');
    assert.deepEqual(seen, ['一只猫', '一只猫'], '面板切走后不再往这个草稿里写');
    assert.equal(chat.calls[0].signal.aborted, false, '切节点不会 abort 请求');
    assert.equal(t.optimizeDraft('a'), '一只猫在沙发上', '切走后仍继续收集流式草稿');

    const back = [];
    const detachBack = t.attachOptimizeView('a', (v) => back.push(v));
    assert.deepEqual(back, ['一只猫在沙发上'], '切回来立刻接上当前流式草稿');

    chat.calls[0].resolve('一只猫在沙发上');
    await TICK();
    assert.equal(t.isOptimizing('a'), false, '完成后任务清出注册表');
    assert.equal(genPrompt(store, 'a'), '一只猫在沙发上', '结果写回发起时的节点');
    assert.equal(genPrompt(store, 'b'), '原提示词B', '不写别的节点');
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].id, 'a');
    assert.equal(store.writes[0].opts.history, true, '写回可撤销（history: true）');
    assert.ok(store.toasts.at(-1).includes('优化提示词') && store.toasts.at(-1).includes('可撤销'), '完成有 toast');
    detachBack();
}

async function testCancelOnlyAbortsThatNode() {
    const chat = makeChat();
    const store = makeStore([makeNode('a', '一只猫')], chat.chat);

    t.startOptimize(store, 'a', { draft: '一只猫', undoHint: '⌘Z' });
    const view = [];
    t.attachOptimizeView('a', (v) => view.push(v));
    const call = chat.calls[0];
    call.onDelta('一只猫在奔跑');

    t.cancelOptimize('a'); // 再点一次
    assert.equal(call.signal.aborted, true, '显式取消才 abort');
    await TICK();
    assert.equal(t.isOptimizing('a'), false);
    assert.equal(store.writes.length, 0, '取消不写回节点');
    assert.equal(genPrompt(store, 'a'), '一只猫', '提示词保持原样');
    assert.ok(store.toasts.at(-1).includes('已停止优化，提示词未改动'), '取消提示「未改动」');
    assert.deepEqual(view.at(-1), '一只猫', '面板草稿恢复成发起前的样子');
}

async function testTwoNodesInParallel() {
    const chat = makeChat();
    const store = makeStore([makeNode('n1', '第一'), makeNode('n2', '第二')], chat.chat);

    t.startOptimize(store, 'n1', { draft: '第一' });
    t.startOptimize(store, 'n2', { draft: '第二' });
    assert.equal(chat.calls.length, 2, '两个节点各发一个请求');
    assert.equal(chat.calls[0].signal.aborted, false);
    assert.equal(chat.calls[1].signal.aborted, false);

    chat.calls[1].resolve('第二版');
    await TICK();
    assert.equal(t.isOptimizing('n1'), true, '另一个节点不受影响');
    assert.equal(t.isOptimizing('n2'), false);
    assert.equal(genPrompt(store, 'n2'), '第二版');
    assert.equal(genPrompt(store, 'n1'), '第一');

    chat.calls[0].resolve('第一版');
    await TICK();
    assert.equal(genPrompt(store, 'n1'), '第一版');
    assert.equal(genPrompt(store, 'n2'), '第二版');
    assert.deepEqual(store.writes.map((w) => w.id), ['n2', 'n1'], '各自写回自己的节点');
}

async function testDeletedNodeStopsSilently() {
    const chat = makeChat();
    const store = makeStore([makeNode('d1', '待删节点')], chat.chat);

    t.startOptimize(store, 'd1', { draft: '待删节点', undoHint: '⌘Z' });
    const call = chat.calls[0];
    removeNode(store, 'd1'); // 删除 / 撤销 / 远端同步
    assert.equal(call.signal.aborted, true, '节点没了就结束任务');
    await TICK();
    assert.equal(t.isOptimizing('d1'), false, '任务清出注册表');
    assert.equal(store.writes.length, 0, '不写回已删除的节点');
    assert.ok(!store.toasts.some((x) => x.includes('已停止优化')), '删除不是用户停止，不弹「已停止」');
    assert.ok(!store.toasts.some((x) => x.includes('优化提示词')), '也不会有完成提示');
}

function testOptimizeButtonUsesRegistry() {
    const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/OptimizeButton.tsx'), 'utf8');
    assert.ok(!/useEffect\(\(\) => \(\) => \{[^}]*abort\(/.test(src), '卸载时不再 abort 请求');
    assert.ok(src.includes('subscribeOptimizeTasks') && src.includes('isOptimizing(node.id)'), 'busy 从注册表派生');
    assert.ok(src.includes('startOptimize(store, node.id'), '点击走模块级任务');
    assert.ok(src.includes('cancelOptimize(node.id)'), '再点一次只取消该节点的任务');
    assert.ok(src.includes('attachOptimizeView(node.id, setDraft)'), '切回节点接上流式草稿');
}

(async () => {
    await testSwitchNodeKeepsRunning();
    await testCancelOnlyAbortsThatNode();
    await testTwoNodesInParallel();
    await testDeletedNodeStopsSilently();
    testOptimizeButtonUsesRegistry();
    console.log('PASS test_novai_canvas_optimize_continue');
})().catch((e) => { console.error(e); process.exit(1); });
