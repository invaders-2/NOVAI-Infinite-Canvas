#!/usr/bin/env node
'use strict';
/**
 * 画布助手「重新生成」一个已经有结果的节点：不在原节点追加版本（前端 autoSelfUrl 会把当前这一版
 * 当第一参考喂回新一轮，越改越偏），改成在右侧新建同类型节点再跑，旧节点原样保留。
 *
 * 验的是真链路：autorun.runAgentQueued(store) → regenAsNew + runNode → buildRequest → backend.generate。
 *   ① 文档里多一个新节点；② 旧节点 hist / 连线未变；③ 新节点没有连旧节点的边；
 *   ④ 这次请求的 inputs 里没有旧结果（selfSrc 也不是旧结果）；⑤ 没有 regenAsNew 标记时行为不变。
 * 跑法：node tests/test_novai_canvas_agent_regen_as_new.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

/* ---------- 浏览器桩：store / engine 会在加载和写回时碰这些 ---------- */
global.Image = class FakeImage {
    constructor() { this.naturalWidth = 1024; this.naturalHeight = 1024; this.onload = null; this.onerror = null; }
    set src(_v) { setTimeout(() => this.onload && this.onload(), 0); }
};
const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};
if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'node' } });
}

function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' } });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');
const autorun = load('novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts');

const IMG = { id: 'm::img', name: 'img', vendor: 'v', kind: 'image', i2i: true, maxRefs: 4 };
const genParams = () => ({ ...model.defaultParams('image', IMG), model: IMG.id, ratio: '1:1' });
const node = (id, gen = {}, data = {}) => ({ id, kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { ...data, gen: { title: id, prompt: '', params: genParams(), order: [], hist: [], hi: 0, ...gen } } });
const version = (url, prompt = '把杯子做成海报') => ({ url, w: 1024, h: 1024, meta: { runId: 'run-' + url, prompt } });
const edge = (id, from, to) => ({ id, from, to });

function makeBackend(requests) {
    return {
        kind: 'bridge',
        available: () => true,
        listModels: async () => [IMG],
        loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1 }),
        saveDoc: async () => ({ ok: true, version: 2 }),
        generate: async (req) => {
            requests.push({ inputs: (req.inputs || []).map((x) => ({ nodeId: x.nodeId, url: x.url, role: x.role })), selfSrc: req.selfSrc, prompt: req.prompt, kind: req.kind });
            return { outputs: [{ url: '/out/' + requests.length + '.png', w: 1024, h: 1024 }] };
        },
        importAsset: async (_c, u) => u,
        importRemote: async (_c, u) => u,
        resolveAsset: async (r) => r,
        editImage: async () => ({ outputs: [] }),
        chat: async () => '',
    };
}

function makeStore(requests, doc) {
    const store = new CanvasStore(makeBackend(requests), 'canvas-regen-as-new');
    store.set({ doc, loaded: true, models: [IMG] });
    return store;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
    return false;
}

(async () => {
    /* ---------- ① 有结果 + regenAsNew：新建节点再跑，旧节点不动 ---------- */
    {
        const U = node('u1', { prompt: '', uploaded: true, hist: [{ url: '/upload.png', w: 800, h: 600 }], hi: 0 });
        const N = node('n1', { title: '把杯子做成海报', prompt: '把杯子做成海报', hist: [version('/gen-1.png'), version('/gen-2.png'), version('/gen-3.png')], hi: 2 });
        const beforeEdges = [edge('e1', 'u1', 'n1')];
        N.data.agentRun = { at: Date.now(), regenAsNew: true };
        const requests = [];
        const store = makeStore(requests, { nodes: [U, N], edges: beforeEdges });
        autorun.runAgentQueued(store);
        const created = await waitFor(() => store.state.doc.nodes.some((n) => n.data && n.data.sourceNodeId === 'n1' && model.outOf(n)));
        assert.ok(created, '① 新建了结果节点并跑出了结果');

        const nodes = store.state.doc.nodes;
        assert.strictEqual(nodes.length, 3, '① 文档里多了一个新节点（u1 / n1 / 新节点）');
        const fresh = nodes.find((n) => n.data && n.data.sourceNodeId === 'n1');
        assert.strictEqual(fresh.kind, 'image', '① 新节点是同类型（图片）');
        assert.ok(model.genOf(fresh).title.startsWith('把杯子做成海报'), '① 新节点标题沿用原名 + 序号：' + model.genOf(fresh).title);
        assert.strictEqual(model.genOf(fresh).prompt, '把杯子做成海报', '① 新节点继承提示词');

        const old = store.node('n1');
        assert.strictEqual(model.genOf(old).hist.length, 3, '② 旧节点还是 3 个版本（没有追加）');
        assert.strictEqual(model.genOf(old).hi, 2, '② 旧节点的当前版本没动');
        assert.strictEqual(model.outOf(old).url, '/gen-3.png', '② 旧结果原样保留');
        assert.deepStrictEqual(store.state.doc.edges.filter((e) => e.from === 'n1').map((e) => e.to), [], '③ 新节点没有连旧节点的边');
        assert.ok(store.state.doc.edges.some((e) => e.from === 'u1' && e.to === 'n1'), '② 旧节点原有的连线原样保留');
        assert.ok(store.state.doc.edges.some((e) => e.from === 'u1' && e.to === fresh.id), '② 新节点复制了旧节点的输入连线（fresh 语义）');

        assert.strictEqual(requests.length, 1, '④ 只发了一次生成请求');
        const req = requests[0];
        assert.ok(!req.inputs.some((x) => x.url === '/gen-3.png'), '④ 请求 inputs 里没有旧结果（3/3）');
        assert.notStrictEqual(req.selfSrc, '/gen-3.png', '④ selfSrc 不是旧结果');
        assert.deepStrictEqual(req.inputs.map((x) => x.nodeId), ['u1'], '④ 输入沿用旧节点的原始素材（fresh 语义）');

        // agentDone：旧节点带上新节点 id，新节点也有一份；旧 agentRun 标记已清掉
        assert.strictEqual(old.data.agentRun, undefined, '⑤ 旧节点上的 agentRun 标记已经清掉（不会重复跑）');
        assert.ok(old.data.agentDone && old.data.agentDone.ok === true, '⑤ 旧节点写回了 agentDone');
        assert.strictEqual(old.data.agentDone.node_id, fresh.id, '⑤ agentDone.node_id = 新节点 id');
        assert.ok(model.genOf(store.node(fresh.id)).hist.length === 1, '⑤ 新节点自己有一版结果');
    }

    /* ---------- ② 没有标记：行为不变（原地追加版本） ---------- */
    {
        const U = node('u2', { prompt: '', uploaded: true, hist: [{ url: '/upload2.png', w: 800, h: 600 }], hi: 0 });
        const N = node('n2', { title: '封面', prompt: '封面', hist: [version('/g1.png', '封面'), version('/g2.png', '封面')], hi: 1 });
        N.data.agentRun = { at: Date.now() };
        const requests = [];
        const store = makeStore(requests, { nodes: [U, N], edges: [edge('e1', 'u2', 'n2')] });
        autorun.runAgentQueued(store);
        await waitFor(() => store.state.doc.nodes.length > 0 && model.genOf(store.node('n2')).hist.length >= 3);
        assert.strictEqual(store.state.doc.nodes.length, 2, '⑤ 没有标记时不开新节点');
        assert.strictEqual(model.genOf(store.node('n2')).hist.length, 3, '⑤ 没有标记时还是在原节点上追加版本');
        assert.strictEqual(model.genOf(store.node('n2')).hi, 2, '⑤ 当前版本指向新追加的那一版');
    }

    /* ---------- ③ 有标记但节点还没有结果：仍然原地跑 ---------- */
    {
        const N = node('n3', { title: '空节点', prompt: '画一只猫', hist: [], hi: 0 });
        N.data.agentRun = { at: Date.now(), regenAsNew: true };
        const requests = [];
        const store = makeStore(requests, { nodes: [N], edges: [] });
        autorun.runAgentQueued(store);
        await waitFor(() => model.genOf(store.node('n3')).hist.length >= 1);
        assert.strictEqual(store.state.doc.nodes.length, 1, '⑤ 节点没有结果时不开新节点（原地跑）');
        assert.strictEqual(model.genOf(store.node('n3')).hist.length, 1, '⑤ 结果写在原节点上');
        assert.strictEqual(requests.length, 1, '⑤ 只跑了一次');
    }

    /* ---------- ④ 源码契约：后端标记字段与前端读取都对上 ---------- */
    const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    assert.ok(src('novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts').includes('regenAsNew'), '前端读 agentRun.regenAsNew');
    assert.ok(src('main.py').includes('run["regenAsNew"] = True'), '后端在 agentRun 里写 regenAsNew');
    assert.ok(src('main.py').includes('_agent_beat_has_result'), '后端按「节点当前有没有结果」判断');

    console.log('[PASS] 助手重跑已有结果的节点：右侧新建节点（旧节点 / 连线 / 版本都不动）、请求不带旧结果、无标记与空节点行为不变');
})().catch((error) => { console.error(error); process.exit(1); });
