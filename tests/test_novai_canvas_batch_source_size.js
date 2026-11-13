#!/usr/bin/env node
/* 批量生成「原图比例」：按行取源图真实像素算显式尺寸，不静默变 1:1（不走真实生成）
   跑法：node tests/test_novai_canvas_batch_source_size.js */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const ratio = load('novai-canvas-ui/src/canvas/canvas-next/originalRatio.ts');
const { buildRequest } = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');

/* 1) 纯函数 batchSourceSize */
assert.strictEqual(ratio.batchSourceSize([{ kind: 'image', url: '/a.png', w: 800, h: 600 }], '2K'), '2048x1536', '800×600 + 2K → 2048×1536');
assert.strictEqual(ratio.batchSourceSize([{ kind: 'video', url: '/v.mp4' }, { kind: 'image', url: '/a.png', w: 800, h: 600 }, { kind: 'image', url: '/b.png', w: 1000, h: 1000 }], '1K'), '1024x768', '多张图取第一张（跳过非图片）');
assert.strictEqual(ratio.batchSourceSize([], '2K'), '', '无图 → 空（调用方回退）');
assert.strictEqual(ratio.batchSourceSize([], '2K', '1024x1024'), '1024x1024', '无图可给回退值');
assert.strictEqual(ratio.batchSourceSize([{ kind: 'image', url: '/a.png' }], '2K'), '', '有图但没量到像素 → 空，不瞎猜');

/* 2) buildRequest 批量行：params.sourceSize / size 是这一行源图的显式尺寸 */
const model = { id: 'm::m1', name: 'm1', vendor: 'm', kind: 'image', tags: [], secs: 10, i2i: true, maxRefs: 4, batch: [1] };
const imageNode = (id, extra) => ({ id, kind: 'image', x: 0, y: 0, w: 200, h: 200, data: { gen: { title: id, prompt: '', params: {}, hist: [], order: [], ...extra } } });
const gen = imageNode('g1', { title: '行节点', prompt: '写点东西', params: { ratio: 'auto', resolution: '2K' }, order: ['e1'] });
const src = imageNode('img1', { title: '素材', hist: [{ url: '/a.png', w: 800, h: 600 }] });
const row = { row: 1, text: '', media: [{ nodeId: 'img1', kind: 'image', title: '素材', src: '/a.png', url: '/a.png' }], tableId: 't' };
const storeWith = (doc) => ({ state: { doc, canvasId: 'c1' }, modelOf: () => model, node: (id) => doc.nodes.find((n) => n.id === id) });
const doc = { nodes: [gen, src], edges: [{ id: 'e1', from: 'img1', to: 'g1' }] };
const req = buildRequest(storeWith(doc), gen, row);
assert.ok(req, '批量行能组装请求');
assert.strictEqual(req.params.sourceSize, '2048x1536', '行请求带这一行源图的显式尺寸（sourceSize）');
assert.strictEqual(req.params.size, '2048x1536', '行请求 params.size 也是显式尺寸');
const want = ratio.wantedRatio(doc, gen, 'image', req.params);
assert.ok(want && Math.abs(want - 4 / 3) < 1e-6, '比例按源图 4:3（不再回落 1:1）');

/* 3) 行里没图：回落到生成节点上游图；上游也没有 → 不崩（不带尺寸）+ 源码有 journal 提醒 */
const noRowMedia = { ...row, media: [] };
const fallbackReq = buildRequest(storeWith(doc), gen, noRowMedia);
assert.strictEqual(fallbackReq.params.sourceSize, '2048x1536', '行里没图回落到节点上游图比例');
const emptyDoc = { nodes: [gen], edges: [] };
const lonelyGen = { ...gen, data: { gen: { ...gen.data.gen, order: [] } } };
const lonelyReq = buildRequest(storeWith({ nodes: [lonelyGen], edges: [] }), lonelyGen, noRowMedia);
assert.ok(lonelyReq && !lonelyReq.params.sourceSize, '没有行图也没有上游图：正常组装请求，不带 sourceSize，不崩');
const engineSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
assert.ok(engineSrc.includes('这一行没有参考图，原图比例按 1:1 生成'), 'journal 里有「没有参考图」的提醒');
assert.ok(engineSrc.includes('batchSourceSize(sized, tier)'), 'runTableBatch 路径用 batchSourceSize 算显式尺寸');

/* 4) 显式比例不受影响 */
const explicitGen = imageNode('g2', { prompt: 'x', params: { ratio: '3:4', resolution: '2K' }, order: [] });
const explicitReq = buildRequest(storeWith({ nodes: [explicitGen], edges: [] }), explicitGen, row);
assert.ok(!explicitReq.params.sourceSize && !explicitReq.params.size, '显式比例不写 sourceSize/size，行为不变');

console.log('[PASS] 批量原图比例：batchSourceSize 5 条 + buildRequest 6 条 + 回落/提醒/显式比例 4 条 全部通过');
