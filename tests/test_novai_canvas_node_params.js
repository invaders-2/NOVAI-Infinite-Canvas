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

// localStorage 桩：store 的「记住默认模型」用
const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');

const m1 = { id: 'prov::m1', name: 'm1', vendor: 'v', kind: 'image', ratios: ['1:1', '3:4', '9:16'], sizes: ['1K', '2K'], batch: [1, 2, 4], maxRefs: 0, i2i: false, secs: 10, tags: [] };
const m2 = { ...m1, id: 'prov::m2', name: 'm2', ratios: ['1:1', '16:9'], sizes: ['2K'], batch: [1] };
const backend = {
    available: () => true,
    loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1 }),
    listModels: async () => [m1, m2],
    saveDoc: async () => ({ ok: true, version: 2 }),
    generate: async () => ({ outputs: [] }),
    importAsset: async (_c, u) => u,
    resolveAsset: async (u) => u,
};
const store = new CanvasStore(backend, 'canvas-params-test');
store.set({ models: [m1, m2], loaded: true });

const paramsOf = (n) => n.data.gen.params;
const json = (n) => JSON.stringify(paramsOf(n));

// 1) 新建的两个同类节点：参数对象 / camera 都不共享，模型在创建时写死
const A = store.newNode('image', 0, 0, { title: 'A', prompt: 'A' });
const B = store.newNode('image', 300, 0, { title: 'B', prompt: 'B' });
assert.notStrictEqual(paramsOf(A), paramsOf(B), '两个节点不能共用同一个 params 对象');
assert.notStrictEqual(paramsOf(A).camera, paramsOf(B).camera, '嵌套 camera 不能共用引用');
assert.strictEqual(paramsOf(A).model, 'prov::m1', '新建节点创建时就写死模型 id');
assert.strictEqual(paramsOf(B).model, 'prov::m1', '第二个节点也是具体模型 id');

// 2) 改 A 的比例 / 清晰度 / 数量 / camera：B 原值与序列化结果不变
store.addNodes([A, B], [], { select: false });
const bBefore = json(B);
store.patchGen(A.id, (g) => ({ params: { ...g.params, ratio: '9:16', size: '2K', count: 4, camera: { ...g.params.camera, on: true, body: 3, lens: 2 } } }));
const aAfter = paramsOf(store.node(A.id));
const bAfter = paramsOf(store.node(B.id));
assert.strictEqual(aAfter.ratio, '9:16');
assert.strictEqual(aAfter.camera.on, true);
assert.strictEqual(bAfter.ratio, '3:4', 'B 的比例不能跟着 A 变');
assert.strictEqual(bAfter.size, '2K', 'B 的清晰度保持自己的值');
assert.strictEqual(bAfter.count, 1, 'B 的数量保持自己的值');
assert.strictEqual(bAfter.camera.on, false, 'B 的 camera 不能跟着 A 变');
assert.strictEqual(json(store.node(B.id)), bBefore, 'B 的序列化参数在 A 修改后完全不变');
assert.notStrictEqual(paramsOf(store.node(A.id)).camera, paramsOf(store.node(B.id)).camera, '修改后 camera 仍然独立');

// 3) 两个节点从同一个 params 对象创建（模板 / 导入 / 版本铺开这类浅拷贝入口）也要拆开
const sharedParams = { model: m1.id, ratio: '1:1', size: '1K', count: 1, search: false, style: '无', camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 1 } };
const c1 = model.newNode('image', 0, 100, { params: sharedParams }, m1);
const c2 = model.newNode('image', 300, 100, { params: sharedParams }, m1);
assert.notStrictEqual(paramsOf(c1), paramsOf(c2), '同一来源参数创建的两个节点 params 必须拆开');
assert.notStrictEqual(paramsOf(c1).camera, paramsOf(c2).camera, '同一来源参数创建的两个节点 camera 必须拆开');
store.addNodes([c1, c2], [], { select: false });
const c2Before = json(store.node(c2.id));
store.patchGen(c1.id, (g) => ({ params: { ...g.params, camera: { ...g.params.camera, on: true, focal: 5 } } }));
assert.strictEqual(json(store.node(c2.id)), c2Before, '改 c1 不影响 c2');
assert.strictEqual(paramsOf(store.node(c2.id)).camera.on, false, 'c2 的 camera 原样');

// 4) 加入画布时传同一个 params 引用（复制 / 粘贴 / 模板铺开最可能的形态）也会被拆开
const clone = store.newNode('image', 600, 0, { title: 'C', prompt: 'C' });
const shared = paramsOf(clone);
const copy1 = { ...clone, id: 'copy-1', data: { ...clone.data, gen: { ...clone.data.gen, params: shared } } };
const copy2 = { ...clone, id: 'copy-2', data: { ...clone.data, gen: { ...clone.data.gen, params: shared } } };
store.addNodes([copy1, copy2], [], { select: false });
const p1 = paramsOf(store.node('copy-1'));
const p2 = paramsOf(store.node('copy-2'));
assert.notStrictEqual(p1, p2, 'addNodes 要把共用 params 拆成两份');
assert.notStrictEqual(p1.camera, p2.camera, 'addNodes 要把嵌套 camera 拆成两份');
const copy2Before = json(store.node('copy-2'));
store.patchGen('copy-1', (g) => ({ params: { ...g.params, ratio: '9:16' } }));
assert.strictEqual(json(store.node('copy-2')), copy2Before, '改副本 1 不影响副本 2');

// 5) 记住默认模型只影响之后新建的节点，已存在节点不跟随
store.rememberModel('image', m2.id);
assert.strictEqual(store.defaultModel('image').id, m2.id, '默认模型已切到 m2');
assert.strictEqual(store.modelOf(store.node(A.id)).id, m1.id, '已存在的 A 模型不变');
assert.strictEqual(store.modelOf(store.node(B.id)).id, m1.id, '已存在的 B 模型不变');
const D = store.newNode('image', 0, 200, { title: 'D', prompt: 'D' });
assert.strictEqual(paramsOf(D).model, 'prov::m2', '之后新建的节点用新的默认模型');

// 6) 参数里没写模型 / 写了已删除的模型：不再回落全局默认，加入画布时写死当前默认
const legacy = model.newNode('image', 0, 300, { title: 'legacy', prompt: 'legacy' }, m1);
const legacyNoModel = { ...legacy, id: 'legacy-no-model', data: { ...legacy.data, gen: { ...legacy.data.gen, params: { ...paramsOf(legacy), model: '' } } } };
store.addNodes([legacyNoModel], [], { select: false });
const pinned = paramsOf(store.node('legacy-no-model'));
assert.strictEqual(pinned.model, 'prov::m2', '缺模型的节点在加入时写死当时的默认模型');
store.rememberModel('image', m1.id);
assert.strictEqual(store.modelOf(store.node('legacy-no-model')).id, 'prov::m2', '之后默认模型再变也不影响它');
const broken = { ...legacy, id: 'legacy-broken', data: { ...legacy.data, gen: { ...legacy.data.gen, params: { ...paramsOf(legacy), model: 'prov::deleted' } } } };
store.addNodes([broken], [], { select: false });
assert.strictEqual(paramsOf(store.node('legacy-broken')).model, 'prov::m1', '失效模型在加入时写死当前默认模型');
assert.strictEqual(store.modelOf(store.node('legacy-broken')).id, 'prov::m1');

// 7) 源码接线：写回 / 入画布时都拆参数，modelOf 不再回落默认模型
const modelSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/model.ts'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/store.ts'), 'utf8');
assert(modelSrc.includes('export function cloneParams') && modelSrc.includes('g.params = cloneParams(g.params)'), 'withGen 写回时要深拷贝 params');
assert(storeSrc.includes('private isolatedNode') && storeSrc.includes('withGen(n, { params:'), '新节点入画布时隔离参数');
assert(!storeSrc.includes('|| this.defaultModel(node.kind)'), 'modelOf 不能回落到按类型记住的默认模型');

// 各入口都显式深拷贝：模板铺开 / 复制粘贴 / 版本铺开 / 批量 / 导入工作流
for (const [rel, label] of [
    ['engine.ts', '批量与铺开'],
    ['actions.ts', '复制粘贴与版本铺开'],
    ['ui/Chrome.tsx', '模板铺开'],
    ['personalTemplates.ts', '模板保存与导入工作流'],
    ['tableFlow.ts', '分镜流水线'],
]) {
    const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next', rel), 'utf8');
    assert(src.includes('cloneParams'), label + ' 入口要深拷贝 params');
}

console.log('[PASS] 节点参数独立（新建 / 模板 / 复制粘贴 / 版本铺开 / 批量 / 导入 / 记住默认模型不串台）');
