#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');
const m1 = { id: 'prov::m1', name: 'm1', vendor: 'v', kind: 'image', ratios: ['1:1'], sizes: ['1K'], batch: [1], maxRefs: 0, i2i: false, secs: 10, tags: [] };
const docOf = (nodes) => ({ nodes, edges: [], comments: [] });
const base = model.newNode('image', 0, 0, { title: 'node', prompt: 'p' }, m1);
const clone = (patch) => JSON.parse(JSON.stringify(base));
const nodeWith = (id, modelId) => {
    const n = clone();
    n.id = id;
    n.data.gen.params.model = modelId;
    return n;
};

// ---- 纯函数：缺 / 失效 model 写死；有效不动；无模型不写；幂等 ----
const missing = nodeWith('n-missing', '');
const valid = nodeWith('n-valid', 'prov::m1');
const stale = nodeWith('n-stale', 'prov::gone');
const doc = docOf([missing, valid, stale]);
const pick = (kind, current) => (current && current === 'prov::m1' ? null : 'prov::m1');
const first = model.pinMissingModelIds(doc, pick);
assert.strictEqual(first.changed, true, '缺 model / model 失效 → 需要迁移');
assert.notStrictEqual(first.doc, doc, '有改动时返回新 doc');
assert.strictEqual(first.doc.nodes.find((n) => n.id === 'n-missing').data.gen.params.model, 'prov::m1');
assert.strictEqual(first.doc.nodes.find((n) => n.id === 'n-stale').data.gen.params.model, 'prov::m1', '失效 model 也写死');
assert.strictEqual(first.doc.nodes.find((n) => n.id === 'n-valid'), valid, '有效 model 的节点对象原样保留（不碰）');
assert.notStrictEqual(first.doc.nodes.find((n) => n.id === 'n-missing').data.gen.params.camera, missing.data.gen.params.camera, '迁移后 camera 是节点自己的副本');
assert.strictEqual(missing.data.gen.params.model, '', '迁移不改入参 doc');

const again = model.pinMissingModelIds(first.doc, pick);
assert.strictEqual(again.changed, false, '第二次迁移不再改（幂等）');
assert.strictEqual(again.doc, first.doc, '幂等时 doc 引用不变');

const noModels = model.pinMissingModelIds(doc, () => null);
assert.strictEqual(noModels.changed, false, '该 kind 没有可用模型时不写');
assert.strictEqual(noModels.doc, doc, '不写时 doc 不变');

// ---- store：载入后迁移一次、不产生撤销/提示、随自动保存落盘、重复载入幂等 ----
const makeBackend = (initialDoc, models, sink) => ({
    available: () => true,
    loadDoc: async () => ({ doc: initialDoc, version: 1 }),
    listModels: async () => models,
    saveDoc: async (_id, next) => { sink.saved = next; sink.count += 1; return { ok: true, version: 2 }; },
    generate: async () => ({ outputs: [] }),
    importAsset: async (_c, u) => u,
    resolveAsset: async (u) => u,
});
const run = async () => {
    const sink = { saved: null, count: 0 };
    const oldDoc = docOf([nodeWith('n-missing-2', ''), nodeWith('n-valid-2', 'prov::m1')]);
    const validNodeRef = oldDoc.nodes[1];
    const store = new CanvasStore(makeBackend(oldDoc, [m1], sink), 'migrate-canvas');
    await store.load();
    assert.strictEqual(store.node('n-missing-2').data.gen.params.model, 'prov::m1', '载入后自动写死 model');
    assert.strictEqual(store.node('n-valid-2'), validNodeRef, '有效节点对象不被替换');
    assert.strictEqual(store.state.undo.length, 0, '迁移不能产生撤销历史');
    assert.strictEqual(store.state.toasts.length, 0, '迁移不能弹提示');
    await store.saveNow();
    assert.strictEqual(sink.saved.nodes.find((n) => n.id === 'n-missing-2').data.gen.params.model, 'prov::m1', '迁移随保存落盘');
    const docRef = store.state.doc;
    assert.strictEqual(store.migrateMissingModelIds(), false, '重复调用不重复写');
    assert.strictEqual(store.state.doc, docRef, '重复调用 doc 引用不变');
    await store.dispose();

    // 重载同一份已迁移的文档：不再写、不再触发保存
    const sink2 = { saved: null, count: 0 };
    const reloaded = new CanvasStore(makeBackend(sink.saved, [m1], sink2), 'migrate-canvas-2');
    await reloaded.load();
    assert.strictEqual(reloaded.node('n-missing-2').data.gen.params.model, 'prov::m1', '重载后仍是写死的 model');
    assert.strictEqual(sink2.count, 0, '重载已迁移文档不再写盘');
    await reloaded.dispose();

    // 模型列表为空：不动，保持原样
    const sink3 = { saved: null, count: 0 };
    const noModelStore = new CanvasStore(makeBackend(docOf([nodeWith('n-empty-3', '')]), [], sink3), 'migrate-canvas-3');
    await noModelStore.load();
    assert.strictEqual(noModelStore.node('n-empty-3').data.gen.params.model, '', '没有可用模型时不写');
    await noModelStore.dispose();

    // 模型列表异步到达（先空、之后 reloadModels）：补跑一次迁移
    const sink4 = { saved: null, count: 0 };
    const lateModels = [];
    const lateBackend = makeBackend(docOf([nodeWith('n-late', '')]), lateModels, sink4);
    const lateStore = new CanvasStore(lateBackend, 'migrate-canvas-4');
    await lateStore.load();
    assert.strictEqual(lateStore.node('n-late').data.gen.params.model, '', '列表还空时不写');
    lateModels.push(m1);
    await lateStore.reloadModels();
    assert.strictEqual(lateStore.node('n-late').data.gen.params.model, 'prov::m1', '模型列表回来后补跑迁移');
    await lateStore.dispose();
};
run().then(() => {
    console.log('[PASS] 旧画布缺 model 节点一次性迁移（幂等 / 有效不动 / 无模型不写 / 自动落盘）');
}).catch((e) => { console.error(e); process.exit(1); });
