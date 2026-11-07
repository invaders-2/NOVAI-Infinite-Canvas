#!/usr/bin/env node
/*
 * 画布设置：新节点默认模型 / 优化提示词模型（store API + 选择优先级 + 设置页不再是只读）。
 *
 *   node tests/test_novai_canvas_settings_models.js
 */
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

// removeItem 是「自动」能真正清掉的前提，缺了它这里会直接报错
const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const optimize = load('novai-canvas-ui/src/canvas/canvas-next/promptOptimize.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');

const IMG_A = model.specFor({ configId: 'prov::img-a', label: 'Img A', vendor: 'Provider', kind: 'image' });
const IMG_B = model.specFor({ configId: 'prov::img-b', label: 'Img B', vendor: 'Provider', kind: 'image' });
const TXT_A = model.specFor({ configId: 'prov::txt-a', label: 'Txt A', vendor: 'Provider', kind: 'text' });
const TXT_VL = model.specFor({ configId: 'prov::txt-vl', label: 'Txt B VL', vendor: 'Provider', kind: 'text', vision: true });
const MODELS = [IMG_A, IMG_B, TXT_A, TXT_VL];

const modelKey = (canvasId, kind) => 'novai:canvas:model:' + canvasId + ':' + kind;
// 升级前的旧键：读路径必须还能读出来，读到后顺手搬进新键
const legacyModelKey = (canvasId, kind) => 'openarc:canvas:model:' + canvasId + ':' + kind;
const OPTIMIZE_KEY = 'novai:canvas:optimize-model';
const emptyDoc = () => ({ nodes: [], edges: [], comments: [] });
const makeBackend = (models) => ({
    available: () => true,
    loadDoc: async () => ({ doc: emptyDoc(), version: 1 }),
    listModels: async () => models,
    saveDoc: async () => ({ ok: true, version: 2 }),
    generate: async () => ({ outputs: [] }),
    importAsset: async (_c, u) => u,
    resolveAsset: async (u) => u,
});

const run = async () => {
    const store = new CanvasStore(makeBackend(MODELS), 'settings-canvas');
    await store.load();

    // ---- 默认模型：没存过回落列表第一个；选中 / 清除 / 失效 ----
    assert.strictEqual(store.defaultModelId('image'), '', '没存过时显式 id 为空');
    assert.strictEqual(store.defaultModel('image').id, IMG_A.id, '没存过回落到列表第一个');
    store.rememberModel('image', IMG_B.id);
    assert.strictEqual(store.defaultModel('image').id, IMG_B.id, '选了第二个就生效');
    assert.strictEqual(store.defaultModelId('image'), IMG_B.id);
    store.rememberModel('image', '');
    assert.strictEqual(memory.has(modelKey('settings-canvas', 'image')), false, '「自动」要删掉存储，不能只写空串');
    assert.strictEqual(memory.has(legacyModelKey('settings-canvas', 'image')), false, '清除时旧键一起删（否则下次读又把它迁回来）');
    assert.strictEqual(store.defaultModel('image').id, IMG_A.id, '清除后回到列表第一个');
    memory.set(legacyModelKey('settings-canvas', 'image'), 'prov::gone');
    assert.strictEqual(store.defaultModelId('image'), 'prov::gone', '旧键（openarc:）里的值仍然读得出来，失效 id 原样保留');
    assert.strictEqual(memory.get(modelKey('settings-canvas', 'image')), 'prov::gone', '读到旧键时顺手搬进新键（旧键不删）');
    assert.strictEqual(store.defaultModel('image').id, IMG_A.id, '存的模型失效时回落到列表第一个');
    assert.strictEqual(store.defaultModel('audio'), undefined, '该类型一个模型都没有时返回 undefined');

    // ---- 优化提示词模型：只认仍在文本列表里的显式设置 ----
    assert.strictEqual(store.optimizeModel(), undefined, '没设置时 undefined（走自动）');
    store.rememberOptimizeModel(TXT_VL.id);
    assert.strictEqual(store.optimizeModel().id, TXT_VL.id, '设成文本模型就返回它');
    store.rememberOptimizeModel(IMG_A.id);
    assert.strictEqual(store.optimizeModel(), undefined, '设成图片模型 id 不算数（只允许文本模型）');
    assert.strictEqual(memory.get(OPTIMIZE_KEY), IMG_A.id, '失效 / 不合适的 id 不自动删除，留给用户重选');
    store.rememberOptimizeModel('');
    assert.strictEqual(memory.has(OPTIMIZE_KEY), false, '清除优化模型要删掉存储');
    assert.strictEqual(store.optimizeModel(), undefined);

    // ---- 默认模型按画布隔离 ----
    const other = new CanvasStore(makeBackend(MODELS), 'other-canvas');
    await other.load();
    store.rememberModel('image', IMG_B.id);
    assert.strictEqual(other.defaultModel('image').id, IMG_A.id, '别的画布不受影响');
    await other.dispose();
    await store.dispose();

    // ---- pickOptimizerModel：用户设置优先，其余优先级不变 ----
    const ctxText = { kind: 'text', model: TXT_A };
    const ctxImage = { kind: 'image', model: IMG_A };
    assert.strictEqual(optimize.pickOptimizerModel(MODELS, ctxImage, true, TXT_A.id).id, TXT_A.id, '传了 preferId 就用它，看不了图也用它');
    assert.strictEqual(optimize.pickOptimizerModel(MODELS, ctxImage, true, 'prov::gone').id, TXT_VL.id, 'preferId 失效时，需要看图就选第一个能读图的');
    assert.strictEqual(optimize.pickOptimizerModel(MODELS, ctxText, false).id, TXT_A.id, '没传 preferId：文本节点自己的模型优先');
    assert.strictEqual(optimize.pickOptimizerModel(MODELS, ctxImage, true).id, TXT_VL.id, '没传 preferId 且需要看图：选能读图的');
    assert.strictEqual(optimize.pickOptimizerModel(MODELS, ctxImage, false).id, TXT_A.id, '兜底第一个文本模型');
    assert.strictEqual(optimize.pickOptimizerModel([IMG_A], ctxImage, false), undefined, '没有文本模型时返回 undefined');

    // ---- 轻量回归：设置页必须真的能选（别再退回只读格子） ----
    const chrome = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Chrome.tsx'), 'utf8');
    assert.ok(chrome.includes('rememberModel('), 'Chrome.tsx 要调用 store.rememberModel');
    assert.ok(chrome.includes('rememberOptimizeModel('), 'Chrome.tsx 要调用 store.rememberOptimizeModel');
    assert.match(chrome, /data-model-pick=\{kind\}/, '默认模型格子要有 data-model-pick');
    assert.match(chrome, /data-model-opts=\{kind\}/, '模型列表要有 data-model-opts');
    assert.match(chrome, /data-model-opt=\{m\.id\}/, '每个模型选项要有 data-model-opt');
    assert.match(chrome, /"data-model-auto": kind/, '要有「自动」项 data-model-auto');
    assert.match(chrome, /data-opt-pick/, '优化提示词行要有 data-opt-pick');
    assert.match(chrome, /data-opt-opts/, '优化提示词列表要有 data-opt-opts');
    assert.match(chrome, /data-opt-opt=\{m\.id\}/, '每个文本模型选项要有 data-opt-opt');
    assert.match(chrome, /"data-opt-auto"/, '要有「自动」项 data-opt-auto');
    assert.doesNotMatch(chrome, /data-model-kind=/, '旧的只读格子要彻底拿掉');
    const optBtn = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/OptimizeButton.tsx'), 'utf8');
    assert.match(optBtn, /store\.optimizeModel\(\)\?\.id \|\| store\.defaultModel\("text"\)\?\.id/, 'OptimizeButton 要先读显式设置，再回落文本默认模型');
};

run().then(() => {
    console.log('[PASS] 画布设置默认模型 / 优化提示词模型（选择生效、自动清除、失效回落、优先级、设置页可点）');
}).catch((e) => { console.error(e); process.exit(1); });
