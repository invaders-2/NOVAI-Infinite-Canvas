#!/usr/bin/env node
/* task-11：后端 /api/model-caps → ModelSpec.ui 映射。
   覆盖：图片 ratios/sizes/batch(n_max 上限 8)/maxRefs；视频 ratios/res/durs/modes；
   空/坏字段回落、未验证标记、方案卡换模型纠正参数、后端接线静态断言。 */
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

const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const plan = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');

// ---- 1. 图片 caps ----
const imageCaps = {
    provider: 'apimart', model: 'gemini-3-pro-image-preview', kind: 'image',
    ratios: ['auto', '1:1', '3:4'], resolutions: ['1k', '2k'], n_max: 10, max_refs: 5,
};
const imageUi = caps.modelCapsUi('image', imageCaps);
assert.deepStrictEqual(imageUi.ratios, ['自适应', '1:1', '3:4'], 'auto → 自适应');
assert.deepStrictEqual(imageUi.sizes, ['1K', '2K'], '分辨率统一大写');
assert.deepStrictEqual(imageUi.batch, [1, 2, 3, 4, 5, 6, 7, 8], 'n_max=10 只展开到 8');
assert.strictEqual(imageUi.maxRefs, 5, 'max_refs 有就填');
assert.strictEqual('i2i' in imageUi, false, '没有的能力不编');

const imageSpec = model.specFor({ configId: 'apimart::gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview', vendor: 'APIMART', kind: 'image', ui: imageUi, specSource: 'spec' });
assert.strictEqual(imageSpec.specSource, 'spec', '拉到 caps → 已验证规格');
assert.deepStrictEqual(imageSpec.ratios, ['自适应', '1:1', '3:4']);
assert.deepStrictEqual(imageSpec.sizes, ['1K', '2K']);
assert.deepStrictEqual(imageSpec.batch, [1, 2, 3, 4, 5, 6, 7, 8]);
assert.strictEqual(imageSpec.maxRefs, 5);
assert.strictEqual(imageSpec.style, false, '规格没声明风格 → 不猜');
assert.strictEqual(imageSpec.camera, false, '规格没声明摄影机 → 不猜');

const small = caps.modelCapsUi('image', { kind: 'image', ratios: ['9:16'], resolutions: ['4K'], n_max: 2 });
assert.deepStrictEqual(small.batch, [1, 2], 'n_max=2 → [1,2]');
const one = caps.modelCapsUi('image', { kind: 'image', n_max: 1 });
assert.deepStrictEqual(one.batch, [1], 'n_max=1 → [1]');
const noBatch = caps.modelCapsUi('image', { kind: 'image', ratios: ['1:1'] });
assert.strictEqual('batch' in noBatch, false, '没有 n_max 不编 batch');
assert.strictEqual('maxRefs' in noBatch, false, '没有 maxRefs 不编');
assert.strictEqual(caps.modelCapsUi('image', { kind: 'video', ratios: ['16:9'] }), null, 'kind 不符直接忽略');
assert.strictEqual(caps.modelCapsUi('image', {}), null, '空 caps 返回 null');

// ---- 2. 视频 caps ----
const videoUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'seedance-2.5', kind: 'video',
    ratios: ['adaptive', '16:9', '9:16'], resolutions: ['720P', '1080P'], durations: [10, 5, 5],
    modes: ['text_to_video', 'image_to_video', '不存在的模式'], qualities: ['standard'],
});
assert.deepStrictEqual(videoUi.ratios, ['自适应', '16:9', '9:16']);
assert.deepStrictEqual(videoUi.res, ['720p', '1080p']);
assert.deepStrictEqual(videoUi.durs, [5, 10], '时长去重排序');
assert.deepStrictEqual(videoUi.modes, ['文生视频', '首帧'], '接口值翻译成 VMODES 中文名，未知名丢弃');
const videoSpec = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: videoUi, specSource: 'spec' });
assert.strictEqual(videoSpec.specSource, 'spec');
assert.deepStrictEqual(videoSpec.ratios, ['自适应', '16:9', '9:16']);
assert.deepStrictEqual(videoSpec.res, ['720p', '1080p']);
assert.deepStrictEqual(videoSpec.durs, [5, 10]);
assert.deepStrictEqual(videoSpec.modes, ['文生视频', '首帧']);

// ---- 2a. 2026-11-13 文档新增模型：/api/model-caps 的真实条目 → 编辑器面板选项 ----
// 条目内容与后端实测一致（GET /api/model-caps，provider=apimart）
const klingV4 = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'kling-v4', kind: 'video',
    ratios: ['16:9', '9:16', '1:1', '21:9', 'auto'],
    resolutions: ['720p', '1080p'],
    durations: Array.from({ length: 28 }, (_, i) => i + 3),
    modes: ['text_to_video', 'image_to_video', 'start_end_to_video', 'reference_to_video',
            'video_edit', 'video_extend', 'reference_video_to_video'],
    ref_max: 9, video_ref_max: 3, audio_ref_max: 3, n_max: 1,
});
assert.deepStrictEqual(klingV4.ratios, ['16:9', '9:16', '1:1', '21:9', '自适应'], 'auto → 自适应');
assert.deepStrictEqual(klingV4.res, ['720p', '1080p'], 'V4 用 resolution 档位（不是 std/pro）');
assert.deepStrictEqual(klingV4.durs, Array.from({ length: 28 }, (_, i) => i + 3), '3–30 秒全给');
assert.deepStrictEqual(klingV4.modes, ['文生视频', '首帧', '首尾帧', '参考生视频',
    '视频编辑', '视频延长', '参考视频生视频'], '统一入口的编辑/延长入口都出现');
assert.strictEqual(klingV4.maxRefs, 9, '参考图上限按实际下发能力');

const klingFlash = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'kling-v4-flash', kind: 'video',
    ratios: ['16:9', '9:16', '1:1', '21:9', 'auto'], resolutions: ['720p'],
    durations: Array.from({ length: 18 }, (_, i) => i + 3),
    modes: ['text_to_video', 'image_to_video', 'reference_to_video', 'video_edit', 'video_extend',
            'reference_video_to_video'],
    ref_max: 9,
});
assert.deepStrictEqual(klingFlash.res, ['720p'], 'flash 只有 720p');
assert.ok(!klingFlash.modes.includes('首尾帧'), 'flash 首帧只收 1 张，没有首尾帧入口');

const zoeUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'apimart-zoe', kind: 'video',
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    durations: [-1].concat(Array.from({ length: 27 }, (_, i) => i + 4)),
    modes: ['text_to_video', 'image_to_video', 'start_end_to_video', 'reference_to_video',
            'video_edit', 'reference_video_to_video'],
    ref_max: 9, video_ref_max: 3, audio_ref_max: 3,
});
assert.strictEqual(zoeUi.durs[0], -1, '-1（模型自选时长）保留为「自动」');
assert.ok(zoeUi.modes.includes('视频编辑') && !zoeUi.modes.includes('视频延长'), 'zoe 不支持 extend');

const omniUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'gemini-omni-1.2-flash', kind: 'video',
    ratios: ['16:9', '9:16'], resolutions: ['360p', '720p', '1080p', '4k'],
    durations: Array.from({ length: 13 }, (_, i) => i + 3),
    modes: ['text_to_video', 'image_to_video', 'start_end_to_video', 'reference_to_video',
            'video_edit', 'video_extend'],
});
assert.deepStrictEqual(omniUi.ratios, ['16:9', '9:16']);
assert.deepStrictEqual(omniUi.res, ['360p', '720p', '1080p', '4k']);
assert.deepStrictEqual(omniUi.durs, Array.from({ length: 13 }, (_, i) => i + 3), '3–15 秒');

const miniImage = caps.modelCapsUi('image', {
    provider: 'apimart', model: 'minimax-h3-image', kind: 'image',
    ratios: ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
    resolutions: ['1K', '2K', '4K'], n_max: 10, ref_max: 16,
    output_formats: ['png', 'jpeg', 'webp'],
});
assert.deepStrictEqual(miniImage.sizes, ['1K', '2K', '4K'], '默认 4K 的模型也要能选 1K/2K 省额度');
assert.deepStrictEqual(miniImage.batch, [1, 2, 3, 4, 5, 6, 7, 8], 'n 1–10 只展开到 8');
assert.strictEqual(miniImage.maxRefs, 16, '参考图 ≤16 张');
assert.deepStrictEqual(miniImage.outputFormats, ['png', 'jpeg', 'webp'], '输出格式按文档给');
assert.strictEqual('qualities' in miniImage, false, '文档说 quality 被忽略 → 不给质量档入口');

const veoLiteUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'veo3.1-lite', kind: 'video',
    ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'],
    durations: [8], modes: ['text_to_video'],
});
assert.deepStrictEqual(veoLiteUi.modes, ['文生视频'], 'lite 只出文生视频');
assert.deepStrictEqual(veoLiteUi.durs, [8], 'VEO 3.1 ext 档固定 8 秒');

// ---- 3. 无 caps：保持 guess（未验证）----
const guessed = model.specFor({ configId: 'x::some-image', label: 'some-image', kind: 'image', ui: null });
assert.strictEqual(guessed.specSource, 'guess', '没有 caps 仍标 guess');
assert.ok(Array.isArray(guessed.ratios) && guessed.ratios.length, 'guess 仍有可选项（兜底）');

// ---- 3a0. n_max 缺失：张数只给 1 张 + 上限未知提示 ----
const unknownUi = caps.modelCapsUi('image', { provider: 'agnes-ai', model: 'agnes-image-2.5-flash', kind: 'image', ratios: ['1:1'], resolutions: ['1K', '2K'], n_max: null });
assert.strictEqual(unknownUi.batchUnknown, true, 'n_max=null → batchUnknown');
assert.strictEqual('batch' in unknownUi, false, 'n_max 缺失不编 batch 上限');
const unknownSpec = model.specFor({ configId: 'agnes-ai::agnes-image-2.5-flash', label: 'agnes-image-2.5-flash', vendor: 'Agnes AI', kind: 'image', ui: unknownUi, specSource: 'spec' });
assert.strictEqual(unknownSpec.batchUnknown, true);
assert.deepStrictEqual(unknownSpec.batch, [1], '缺失上限时只保留 1 张');
assert.deepStrictEqual(plan.countOptions(unknownSpec), [1], '方案卡张数只给 1 张');
const unknownStep = { tool: 'generate_image', args: { canvas_id: 'c', provider: 'agnes-ai', model: 'agnes-image-2.5-flash', ratio: '1:1', size: '1024x1024', count: 4 } };
// task-25 起：不再静默降级到 1 —— 显示/批准保留用户要的 4，执行层按 countPlan 拆成 4 次（每次 1 张）
assert.strictEqual(plan.readPlanParams(unknownStep, 'image', [unknownSpec]).count, 4, '批量未知：保留请求张数（拆分执行时提示按 1 张处理）');
const knownSpec = model.specFor({ configId: 'apimart::gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview', kind: 'image', ui: imageUi, specSource: 'spec' });
assert.strictEqual(knownSpec.batchUnknown, undefined, '有 n_max=10 不标未知');
// 明确 n_max=1 的模型：计划里写了 4 张，也要显示/批准成 1 张
const oneSpec = model.specFor({ configId: 'apimart::gpt-image-2.5-ext', label: 'gpt-image-2.5-ext', kind: 'image', ui: caps.modelCapsUi('image', { provider: 'apimart', model: 'gpt-image-2.5-ext', kind: 'image', ratios: ['1:1'], resolutions: ['2K'], n_max: 1 }), specSource: 'spec' });
const fourStep = { tool: 'generate_image', args: { canvas_id: 'c', provider: 'apimart', model: 'gpt-image-2.5-ext', ratio: '1:1', size: '2048x2048', count: 4 } };
// task-25 起：n_max=1 的模型也保留请求张数 4，由 countPlan/expandGenerationSteps 拆成 4 次执行
assert.strictEqual(plan.readPlanParams(fourStep, 'image', [oneSpec]).count, 4, 'n_max=1：保留请求张数（分 4 次执行）');
assert.deepStrictEqual(plan.countOptions(oneSpec), [1]);
// task-25 起：批准前不再把张数夹回 1；由 expandGenerationSteps 按模型档位拆成多次执行
assert.strictEqual(plan.patchPlanStep(fourStep, 'image', [oneSpec], {}).args.count, 4, '批准保留请求张数（执行时拆组）');

// ---- 3a. 参考图能力：caps 不含 maxRefs/i2i 时沿用官方/预设，不能被权威参数误关 ----
const noRefUi = { ratios: imageUi.ratios, sizes: imageUi.sizes, batch: imageUi.batch };
const mergedUi = caps.mergeCapsReferenceCapability('image', noRefUi, { maxRefs: 14, i2i: true });
const mergedSpec = model.specFor({ configId: 'apimart::gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview', kind: 'image', ui: mergedUi, specSource: 'spec' });
assert.strictEqual(mergedSpec.maxRefs, 14, 'caps 没给 maxRefs → 沿用预设的参考图上限');
assert.strictEqual(mergedSpec.i2i, true, 'caps 没给 i2i → 不把所有模型误标成仅文生图');
assert.deepStrictEqual(mergedSpec.ratios, imageSpec.ratios, '参考图能力回填不影响 caps 的比例');
const capsWins = caps.mergeCapsReferenceCapability('image', { ...imageUi, maxRefs: 2, i2i: false }, { maxRefs: 14, i2i: true });
assert.strictEqual(capsWins.maxRefs, 2, 'caps 明确给 maxRefs 时以 caps 为准');
assert.strictEqual(capsWins.i2i, false, 'caps 明确给 i2i 时以 caps 为准');

// ---- 3b. 后端明确给空数组：不能补默认档位/能力 ----
const emptyRes = caps.modelCapsUi('image', { provider: 'jimeng', model: '5.0', kind: 'image', ratios: ['1:1', '3:4'], resolutions: [] });
assert.deepStrictEqual(emptyRes.sizes, [], 'resolutions: [] 原样保留为空');
const emptyResSpec = model.specFor({ configId: 'jimeng::5.0', label: '5.0', vendor: '即梦 CLI', kind: 'image', ui: emptyRes, specSource: 'spec' });
assert.deepStrictEqual(emptyResSpec.sizes, [], 'specFor 不再用 DEFAULTS 把空 sizes 补成 1K/2K');
assert.deepStrictEqual(plan.imageResolutionOptions(emptyResSpec), [], '方案卡分辨率不补默认档位');
const emptyVideo = caps.modelCapsUi('video', { provider: 'apimart', model: 'MiniMax-H3', kind: 'video', ratios: ['16:9'], resolutions: [], durations: [], modes: [] });
assert.deepStrictEqual(emptyVideo.res, []);
assert.deepStrictEqual(emptyVideo.durs, []);
assert.deepStrictEqual(emptyVideo.modes, []);
const emptyVideoSpec = model.specFor({ configId: 'apimart::MiniMax-H3', label: 'MiniMax-H3', vendor: 'APIMART', kind: 'video', ui: emptyVideo, specSource: 'spec' });
assert.deepStrictEqual(emptyVideoSpec.modes, [], 'modes: [] 不再补通用生成方式');
assert.deepStrictEqual(emptyVideoSpec.durs, [], 'durations: [] 不再补 5/10 秒');
assert.deepStrictEqual(plan.durationOptions(emptyVideoSpec), [], '方案卡时长不补默认值');
assert.deepStrictEqual(plan.videoResOptions(emptyVideoSpec), [], '方案卡视频分辨率不补默认值');

// ---- 3c. 视频换模型：方式/清晰度/时长被 clampParams 纠正 ----
const seedanceSpec = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', { provider: 'apimart', model: 'seedance-2.5', kind: 'video', ratios: ['16:9', '9:16'], resolutions: ['720p'], durations: [5, 10], modes: ['text_to_video', 'reference_to_video'] }), specSource: 'spec' });
const minimaxSpec = model.specFor({ configId: 'apimart::MiniMax-H3', label: 'MiniMax-H3', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', { provider: 'apimart', model: 'MiniMax-H3', kind: 'video', ratios: ['16:9'], resolutions: ['1080p'], durations: [5], modes: ['image_to_video'] }), specSource: 'spec' });
assert.deepStrictEqual(seedanceSpec.modes, ['文生视频', '参考生视频']);
assert.deepStrictEqual(minimaxSpec.modes, ['首帧']);
const clamped = model.clampParams('video', { model: seedanceSpec.id, mode: '参考生视频', ratio: '16:9', res: '720p', dur: 10, sound: false, times: 1 }, minimaxSpec);
assert.strictEqual(clamped.mode, '首帧', '换到不支持当前方式的模型 → 纠正为第一个支持的方式');
assert.strictEqual(clamped.res, '1080p', '清晰度跟着新模型变');
assert.strictEqual(clamped.dur, 5, '时长跟着新模型变');

// ---- 4. 索引按 provider::model ----
const index = caps.indexModelCaps([imageCaps, { provider: 'APIMART', model: 'gemini-3-pro-image-preview', kind: 'image', ratios: ['1:1'] }, { provider: '', model: 'bad' }]);
assert.strictEqual(index.size, 1, '只索引合法且有 provider/model 的项；大小写 provider 合并');
const hit = index.get(caps.modelCapsKey('apimart', 'gemini-3-pro-image-preview'));
assert.ok(hit && hit.kind === 'image');
assert.strictEqual(caps.modelCapsKey('APIMART', 'gemini-3-pro-image-preview'), 'apimart::gemini-3-pro-image-preview');

// ---- 5. 方案卡：选项与换模型纠正都来自 ModelSpec ----
const imageStep = { tool: 'generate_image', args: { canvas_id: 'c', prompt: '鞋', provider: 'apimart', model: 'gemini-3-pro-image-preview', ratio: '9:16', size: '2160x3840', count: 4 } };
const read = plan.readPlanParams(imageStep, 'image', [imageSpec]);
assert.strictEqual(read.ratio, '9:16', '原步骤值先保留');
const fixed = plan.patchPlanStep(imageStep, 'image', [imageSpec], { modelConfigId: imageSpec.id });
assert.strictEqual(fixed.args.ratio, '自适应', '新模型不支持 9:16 → 纠正到第一个合法比例（caps 里 auto 排第一）');
assert.strictEqual('size' in fixed.args, false, '自适应不写显式 size');
assert.strictEqual(fixed.args.count, 4, '新模型 batch 1..8 支持 4 张，保持');
const strictSpec = model.specFor({ configId: 'apimart::strict-image', label: 'strict-image', vendor: 'APIMART', kind: 'image', ui: { ratios: ['1:1', '3:4'], sizes: ['1K'], batch: [1, 2] }, specSource: 'spec' });
const strictFixed = plan.patchPlanStep(imageStep, 'image', [strictSpec], { modelConfigId: strictSpec.id });
assert.strictEqual(strictFixed.args.ratio, '1:1', '没有 auto 的模型纠正到第一个合法比例');
assert.strictEqual(strictFixed.args.size, '1024x1024', '分辨率落到新模型的 1K');
// task-25 起：切模型也不许把请求张数改小；batch=[1,2] 时保留 4 张，执行层拆成 2 次每次 2
assert.strictEqual(strictFixed.args.count, 4, '切模型保留请求张数（执行层按新模型档位拆组）');
assert.deepStrictEqual(plan.imageRatioOptions(imageSpec), ['自适应', '1:1', '3:4'], '卡片比例来自 ModelSpec');
assert.deepStrictEqual(plan.imageResolutionOptions(imageSpec), ['1K', '2K'], '卡片分辨率来自 ModelSpec');
assert.deepStrictEqual(plan.countOptions(imageSpec), [1, 2, 3, 4, 5, 6, 7, 8], '卡片张数来自 ModelSpec.batch');
const videoCapsSpec = videoSpec;
assert.deepStrictEqual(plan.videoRatioOptions(videoCapsSpec), ['adaptive', '16:9', '9:16'], '原图比例在方案卡写成接口值 adaptive');
assert.deepStrictEqual(plan.videoResOptions(videoCapsSpec), ['720p', '1080p']);
assert.deepStrictEqual(plan.durationOptions(videoCapsSpec), [5, 10]);

// ---- 5b. 图片输出格式：caps.output_formats → 面板选项 / 请求字段 ----
const formatCaps = {
    provider: 'apimart', model: 'gpt-image-2.6-sunburst', kind: 'image',
    ratios: ['1:1', '3:4'], resolutions: ['1K', '2K'], n_max: 1,
    output_formats: ['PNG', 'jpeg', 'webp', 'SVG', 'gif', 'gif'],
};
const formatUi = caps.modelCapsUi('image', formatCaps);
assert.deepStrictEqual(formatUi.outputFormats, ['png', 'jpeg', 'webp', 'svg', 'gif'], 'output_formats 规范成小写去重');
const staticFormatUi = caps.modelCapsUi('image', { provider: 'apimart', model: 'only-webp', kind: 'image', ratios: ['1:1'], output_formats: ['webp'] });
assert.deepStrictEqual(staticFormatUi.outputFormats, ['webp'], '只有静态格式也原样保留');
assert.deepStrictEqual(caps.modelCapsUi('image', { provider: 'apimart', model: 'none', kind: 'image', ratios: ['1:1'], output_formats: [] }).outputFormats, [], '空数组保留：后端明确没有动图/矢量');
const formatSpec = model.specFor({ configId: 'apimart::gpt-image-2.6-sunburst', label: 'gpt-image-2.6-sunburst', vendor: 'APIMART', kind: 'image', ui: formatUi, specSource: 'spec' });
assert.deepStrictEqual(formatSpec.outputFormats, ['png', 'jpeg', 'webp', 'svg', 'gif'], 'specFor 保留 outputFormats');
assert.deepStrictEqual(model.outputFormatOptions(formatSpec), [
    { value: '', label: '静态图' },
    { value: 'gif', label: 'GIF 动图' },
    { value: 'svg', label: 'SVG 矢量' },
], '含 gif / svg → 静态图 + GIF + SVG 三项');
const staticFormatSpec = model.specFor({ configId: 'apimart::only-webp', label: 'only-webp', vendor: 'APIMART', kind: 'image', ui: staticFormatUi, specSource: 'spec' });
assert.deepStrictEqual(model.outputFormatOptions(staticFormatSpec), [], '不含 gif / svg → 返回空，不给入口');
assert.deepStrictEqual(model.outputFormatOptions(imageSpec), [], '旧 spec 没 outputFormats → 不给入口');
assert.strictEqual(model.outputFormatLabel('gif'), 'GIF 动图');
assert.strictEqual(model.outputFormatLabel(''), '静态图');
assert.strictEqual(model.outputFormatForRequest('gif'), 'gif', 'gif 原样下发');
assert.strictEqual(model.outputFormatForRequest('SVG'), 'svg', '大小写归一');
assert.strictEqual(model.outputFormatForRequest(''), '', '静态图不发字段');
assert.strictEqual(model.outputFormatForRequest('png'), '', '静态格式不发字段');
assert.strictEqual(model.outputFormatForRequest(undefined), '');
const gifParams = model.clampParams('image', { model: formatSpec.id, ratio: '1:1', size: '2K', count: 1, search: false, style: '无', camera: { ...model.DEFAULT_CAMERA }, outputFormat: 'gif' }, formatSpec);
assert.strictEqual(gifParams.outputFormat, 'gif', '支持的模型保留 outputFormat');
const noGifParams = model.clampParams('image', { ...gifParams }, staticFormatSpec);
assert.strictEqual('outputFormat' in noGifParams, false, '换到不支持 gif 的模型清掉 outputFormat');
const dirtyParams = model.clampParams('image', { model: formatSpec.id, ratio: '1:1', size: '2K', count: 1, search: false, style: '无', camera: { ...model.DEFAULT_CAMERA }, outputFormat: '' }, formatSpec);
assert.strictEqual('outputFormat' in dirtyParams, false, '空串不落参数');

// ---- 5c. 透明背景：caps.native_background → 能力位 / 参数互斥 / 请求字段 ----
const bgCaps = caps.modelCapsUi('image', { provider: 'apimart', model: 'gpt-image-1.5-official', kind: 'image', ratios: ['1:1'], resolutions: ['1K'], n_max: 1, native_background: true });
assert.strictEqual(bgCaps.nativeBackground, true, 'native_background:true → ui.nativeBackground');
const noBgCaps = caps.modelCapsUi('image', { provider: 'apimart', model: 'gpt-image-2.5-ext', kind: 'image', ratios: ['1:1'], resolutions: ['1K'], n_max: 1 });
assert.strictEqual('nativeBackground' in noBgCaps, false, '缺省不落 nativeBackground 键');
const looseBgCaps = caps.modelCapsUi('image', { provider: 'apimart', model: 'loose', kind: 'image', ratios: ['1:1'], native_background: 'true' });
assert.strictEqual('nativeBackground' in looseBgCaps, false, '只有明确 true 才算支持');
const bgSpec = model.specFor({ configId: 'apimart::gpt-image-1.5-official', label: 'gpt-image-1.5-official', vendor: 'APIMART', kind: 'image', ui: bgCaps, specSource: 'spec' });
assert.strictEqual(bgSpec.nativeBackground, true, 'specFor 保留 nativeBackground');
const noBgSpec = model.specFor({ configId: 'apimart::gpt-image-2.5-ext', label: 'gpt-image-2.5-ext', vendor: 'APIMART', kind: 'image', ui: noBgCaps, specSource: 'spec' });
assert.strictEqual(noBgSpec.nativeBackground, undefined, '不支持透明背景的模型没有能力位');

const baseImageParams = { model: bgSpec.id, ratio: '1:1', size: '1K', count: 1, search: false, style: '无', camera: { ...model.DEFAULT_CAMERA } };
assert.strictEqual('background' in model.defaultParams('image', bgSpec), false, 'defaultParams 不预置 background');
const keptBg = model.clampParams('image', { ...baseImageParams, background: 'transparent' }, bgSpec);
assert.strictEqual(keptBg.background, 'transparent', '支持的模型保留 background');
const droppedBg = model.clampParams('image', { ...baseImageParams, background: 'transparent' }, noBgSpec);
assert.strictEqual('background' in droppedBg, false, '不支持透明背景的模型清掉 background');

// 透明背景只能出 PNG：和 GIF / SVG 的输出格式互斥
const bgFormatSpec = model.specFor({ configId: 'apimart::bg-format', label: 'bg-format', vendor: 'APIMART', kind: 'image', ui: { ...formatUi, nativeBackground: true }, specSource: 'spec' });
const pngOnly = model.clampParams('image', { ...baseImageParams, model: bgFormatSpec.id, background: 'transparent', outputFormat: 'gif', frameCount: 6, frameDuration: 300 }, bgFormatSpec);
assert.strictEqual(pngOnly.background, 'transparent', '透明背景保留');
assert.strictEqual('outputFormat' in pngOnly, false, '透明背景清掉 outputFormat');
assert.strictEqual('frameCount' in pngOnly, false, '透明背景清掉 frameCount');
assert.strictEqual('frameDuration' in pngOnly, false, '透明背景清掉 frameDuration');
const dirtyBg = model.clampParams('image', { ...baseImageParams, model: bgFormatSpec.id, background: 'keep', outputFormat: 'gif' }, bgFormatSpec);
assert.strictEqual('background' in dirtyBg, false, '非 transparent 的背景值不落参数');
assert.strictEqual(dirtyBg.outputFormat, 'gif', '有输出格式时背景被清掉，格式保留');
const bgToGif = model.clampParams('image', { ...baseImageParams, model: formatSpec.id, background: 'transparent', outputFormat: 'gif' }, formatSpec);
assert.strictEqual('background' in bgToGif, false, '换到不支持透明的模型清掉 background');
assert.strictEqual(bgToGif.outputFormat, 'gif', '输出格式按新模型能力保留');

// ---- 6. 后端接线静态断言 ----
const backend = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
const card = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskPlanCard.tsx'), 'utf8');
const genPanel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
assert.ok(backend.includes('fetch("/api/model-caps"'), 'listModels 会 best-effort 拉 /api/model-caps');
assert.ok(backend.includes('MODEL_CAPS_TIMEOUT_MS = 1000') && backend.includes('AbortController'), '接口带短超时，不拖死模型列表');
assert.ok(backend.includes('capsCache = null') && backend.includes('capsCache = null; cb()'), 'caps 缓存与 config 一起失效');
assert.ok(backend.indexOf('const capsPromise = loadCaps()') >= 0 && backend.indexOf('const caps = await capsPromise') >= 0, '模型列表与 caps 并发加载');
assert.ok(backend.includes('let capsUi =') && backend.includes('const ui = capsUi ||') && backend.includes('mergeCapsReferenceCapability'), 'caps 优先于官方硬编码，并保留参考图能力');
assert.ok(card.includes('该模型未提供规格，比例/分辨率为推断'), '未验证模型在方案卡上有提示');
assert.ok(card.includes('上限未知，以实际为准'), 'n_max 缺失时方案卡提示上限未知');
assert.ok(card.includes('生成方式：自动选择'), '视频步骤在方案卡上说明自动选择方式');
assert.ok(genPanel.includes('mm.batchUnknown ? [1] : [4, 2, 1]') && !genPanel.includes('上限未知，以实际为准'), '图片面板 n_max 缺失只给 1 张，参数弹层不再显示灰字上限提示');
assert.ok(card.includes('explicitSpec.specSource !== "spec"'), '提示按 ModelSpec.specSource 判定（只对步骤显式选的模型提示，不暗示默认模型）');
assert.ok(backend.includes('outputFormatForRequest') && backend.includes('output_format: outputFormat'), '生成请求只对 gif / svg 下发 output_format');
assert.ok(genPanel.includes('data-p="output-format"') && genPanel.includes('输出格式'), '图片参数弹层有「输出格式」段');
assert.strictEqual(genPanel.includes('data-seg="background"'), false, '底栏不再有独立的「背景」段');
assert.ok(genPanel.includes('{m.nativeBackground ? <>') && genPanel.includes('data-p="background"') && genPanel.includes('data-background="default"') && genPanel.includes('data-background="transparent"'), '透明背景入口在「比例 · 尺寸」弹层里，只由 caps.nativeBackground 控制');
assert.ok(genPanel.includes('set({ background: "transparent", outputFormat: undefined })'), '开透明背景时连带清掉输出格式');
assert.ok(genPanel.includes('" · 透明"'), '比例摘要显示「 · 透明」状态');
assert.ok(backend.includes('params.background === "transparent"') && backend.includes('background: "transparent"'), '生成请求按透明背景下发 background 字段');

console.log('[PASS] model-caps 映射 / 未验证回落 / 方案卡选项与纠正 / 图片输出格式 / 后端接线 / 2026-11 新模型面板选项（8 组）');