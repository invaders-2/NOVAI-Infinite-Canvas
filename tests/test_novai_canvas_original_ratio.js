#!/usr/bin/env node
/* task-21：原图比例
   1) 源图尺寸 → 尺寸档长边等比 WxH；无源图返回空；
   2) 源图取节点自己的结果 / 上游图片结果；
   3) 图片、视频、方案卡的「原图比例」标签，视频写回 adaptive；
   4) 无源图时图片面板禁用原图比例（不再挂灰字提示）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const ratio = load('novai-canvas-ui/src/canvas/canvas-next/originalRatio.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const plan = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');

// ---- 1. 换算 ----
assert.strictEqual(ratio.sourceSizeForTier({ url: 'u', w: 800, h: 600 }, '2K'), '2048x1536', '横图按 2K 长边算，保比例');
assert.strictEqual(ratio.sourceSizeForTier({ url: 'u', w: 600, h: 800 }, '4K'), '3072x4096', '竖图按 4K 长边算');
assert.strictEqual(ratio.sourceSizeForTier({ url: 'u', w: 400, h: 400 }, '3K'), '3072x3072');
assert.strictEqual(ratio.sourceSizeForTier(null, '2K'), '', '没有源图不写 size');
assert.strictEqual(ratio.sourceSizeForTier({ url: 'u', w: 0, h: 0 }, '2K'), '', '尺寸未知不猜');

// ---- 2. 源图选择 ----
const base = { params: { model: 'p::m', ratio: '1:1', size: '2K', count: 1 } };
const own = model.newNode('image', 0, 0, { hist: [{ url: '/own.png', w: 800, h: 600 }], params: base.params });
const target = model.newNode('image', 400, 0, { params: base.params });
const upstream = model.newNode('image', 0, 300, { hist: [{ url: '/up.png', w: 600, h: 800 }], params: base.params });
const edge = { id: 'e1', from: upstream.id, to: target.id };
const store = { state: { doc: { nodes: [own, target, upstream], edges: [edge], comments: [] } } };
assert.deepStrictEqual(ratio.sourceBoxForNode(store, own, 'image'), { url: '/own.png', w: 800, h: 600 }, '优先节点自己的结果');
assert.deepStrictEqual(ratio.sourceBoxForNode(store, target, 'image'), { url: '/up.png', w: 600, h: 800 }, '没自己的结果时取上游图片');
assert.strictEqual(ratio.sourceBoxForNode(store, model.newNode('image', 0, 0, { params: base.params }), 'image'), null, '无图返回 null');

// ---- 3. 标签 / 方案卡 ----
for (const value of ['自适应', 'auto', 'adaptive', '']) assert.strictEqual(ratio.ratioDisplayLabel(value), '原图比例', '原图比例标签: ' + value);
assert.strictEqual(ratio.ratioDisplayLabel('16:9'), '16:9');

const videoSpec = model.specFor({ configId: 'v::m', label: 'video', kind: 'video', ui: { ratios: ['自适应', '16:9'], modes: ['文生视频'] }, specSource: 'spec' });
assert.deepStrictEqual(plan.videoRatioOptions(videoSpec), ['adaptive', '16:9'], '方案卡视频原图比例写接口值 adaptive');
const videoStep = { tool: 'generate_video', args: { canvas_id: 'c', provider: 'v', model: 'm', ratio: '自适应', duration: 5 } };
const videoRead = plan.readPlanParams(videoStep, 'video', [videoSpec]);
assert.strictEqual(videoRead.ratio, 'adaptive');
assert.ok(plan.planParamsSummary([videoStep], [videoSpec]).includes('原图比例'), '摘要标原图比例');
const videoPatched = plan.patchPlanStep(videoStep, 'video', [videoSpec], { ratio: '自适应' });
assert.strictEqual(videoPatched.args.ratio, 'adaptive');
const clampedVideo = model.clampParams('video', { model: videoSpec.id, mode: '文生视频', ratio: 'adaptive', res: '720p', dur: 5, sound: false, times: 1 }, videoSpec);
assert.strictEqual(clampedVideo.ratio, 'adaptive', '换模型时 adaptive 仍被识别为原图比例，不被收回普通比例');
assert.strictEqual(model.defaultParams('video', videoSpec).ratio, 'adaptive', '默认选中 adaptive 的模型也写接口值');

const imageSpec = model.specFor({ configId: 'i::m', label: 'img', kind: 'image', ui: { ratios: ['自适应', '1:1'], sizes: ['1K', '2K'], batch: [1] }, specSource: 'spec' });
const imageStep = { tool: 'generate_image', args: { canvas_id: 'c', provider: 'i', model: 'm', ratio: '自适应', size: '1024x1024', count: 1 } };
assert.ok(plan.planParamsSummary([imageStep], [imageSpec]).includes('原图比例'), '图片方案卡摘要标原图比例');
assert.deepStrictEqual(plan.imageRatioOptions(imageSpec), ['自适应', '1:1']);

// ---- 4. 静态接线 ----
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
const card = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskPlanCard.tsx'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
assert.ok(panel.includes('useSourceBox') && panel.includes('sourceSizeForTier') && panel.includes('ratioDisplayLabel'), '图片/视频面板用源图比例');
assert.ok(panel.includes('disabled: disabled || needSource'), '没有源图时原图比例禁用');
assert.strictEqual(panel.includes('原图比例需要有参考图'), false, '弹层不再显示「原图比例需要有参考图」灰字');
assert.ok(panel.includes('videoRatioChoices') && panel.includes('ratio: videoRatioValue(ratio)'), '视频比例写回 adaptive');
// 方案卡的比例选择已改成 #pop 格子（PlanRatioField，逻辑在 PlanParamPickers.tsx）
const pickers = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/PlanParamPickers.tsx'), 'utf8');
assert.ok(pickers.includes('ratioDisplayLabel(value)') && card.includes('PlanRatioField'), '方案卡比例弹层把自适应显示为原图比例');
assert.ok(backend.includes('params.sourceSize') && backend.includes('/auto|自适应|source/i.test(params.ratio)'), '生成请求使用原图显式 WxH，不再落 1:1');

console.log('[PASS] 原图比例：尺寸换算 / 源图选择 / 图片视频标签 / 方案卡与请求（4 组）');
