#!/usr/bin/env node
/* task-11：后端 /api/model-caps → ModelSpec.ui 映射。
   覆盖：图片 ratios/sizes/batch(按 n_max 展开，最高 15)/maxRefs；视频 ratios/res/durs/modes；
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
assert.deepStrictEqual(imageUi.batch, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'n_max=10 展开到 10（不再硬钳 8）');
assert.strictEqual(imageUi.maxRefs, 5, 'max_refs 有就填');
assert.strictEqual('i2i' in imageUi, false, '没有的能力不编');

const imageSpec = model.specFor({ configId: 'apimart::gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview', vendor: 'APIMART', kind: 'image', ui: imageUi, specSource: 'spec' });
assert.strictEqual(imageSpec.specSource, 'spec', '拉到 caps → 已验证规格');
assert.deepStrictEqual(imageSpec.ratios, ['自适应', '1:1', '3:4']);
assert.deepStrictEqual(imageSpec.sizes, ['1K', '2K']);
assert.deepStrictEqual(imageSpec.batch, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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

// ---- 1b. Midjourney：张数降序（默认 4 张候选 + 四宫格）；速度三档 ----
const mjItem = {
    provider: 'apimart', model: 'midjourney', kind: 'image',
    ratios: ['1:1', '16:9'], sizes: ['2K'], n_max: 4, qualities: [],
    mj: { versions: ['8.2', '8.1'], speeds: ['fast', 'turbo', 'relax'], hd: ['8.2', '8.1'] },
};
const mjUiCaps = caps.modelCapsUi('image', mjItem);
assert.deepStrictEqual(mjUiCaps.batch, [4, 3, 2, 1], 'MJ 张数候选降序（4 在前）：1/2/4 全可点');
assert.deepStrictEqual(mjUiCaps.mj.speeds, ['fast', 'turbo', 'relax'], 'MJ 速度三档都进面板');
const mjCapSpec = model.specFor({ configId: 'apimart::midjourney', label: 'midjourney', vendor: 'APIMART', kind: 'image', ui: mjUiCaps, specSource: 'spec' });
assert.strictEqual(model.defaultParams('image', mjCapSpec).count, 4, 'MJ 新建节点默认 4 张候选（四宫格免费附带 → 画布共 5 张）');
assert.strictEqual(model.clampParams('image', { ...model.defaultParams('image', mjCapSpec), count: 1 }, mjCapSpec).count, 1, '已经是 MJ：手动选 1 张保留 1（1 候选 + 四宫格 = 2 张）');
assert.strictEqual(model.clampParams('image', { ...model.defaultParams('image', mjCapSpec), count: 2 }, mjCapSpec).count, 2, '已经是 MJ：手动选 2 张也保留');
const fromOther = { model: 'apimart::gpt-image-2', ratio: '1:1', size: '1K', count: 1, search: false, style: '无', camera: {} };
assert.strictEqual(model.clampParams('image', fromOther, mjCapSpec).count, 4, '从别的模型切到 MJ：按 MJ 默认重新起步 4 张');
// 对照：非 MJ 模型仍是升序 + 默认 1，不许被这次改动带偏
const otherUi = caps.modelCapsUi('image', { provider: 'apimart', model: 'gpt-image-2', kind: 'image', ratios: ['1:1'], n_max: 4 });
assert.deepStrictEqual(otherUi.batch, [1, 2, 3, 4], '非 MJ 模型张数仍是升序');
const otherSpec = model.specFor({ configId: 'apimart::gpt-image-2', label: 'gpt-image-2', vendor: 'APIMART', kind: 'image', ui: otherUi, specSource: 'spec' });
assert.strictEqual(model.defaultParams('image', otherSpec).count, 1, '非 MJ 模型默认张数仍是 1');

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
assert.deepStrictEqual(miniImage.batch, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'n 1–10 全部展开');
// 2026-11-25：n_max 上限从 8 放到 15（后端能力表 seedream-4-0 声明的最高档）
const bigBatch = caps.modelCapsUi('image', { provider: 'apimart', model: 'seedream-4-0', kind: 'image', ratios: ['1:1'], n_max: 15 });
assert.deepStrictEqual(bigBatch.batch, Array.from({ length: 15 }, (_, i) => i + 1), 'n_max=15 展开到 15');
assert.deepStrictEqual(caps.modelCapsUi('image', { provider: 'apimart', model: 'dirty', kind: 'image', ratios: ['1:1'], n_max: 99 }).batch.length, 15, '脏值 n_max=99 只展开到 15（不让面板被撑爆）');
const klingV4Image = caps.modelCapsUi('image', { provider: 'apimart', model: 'kling-v4-image', kind: 'image', ratios: ['auto', '1:1'], resolutions: ['2K', '4K', '8K'], n_max: 9 });
assert.deepStrictEqual(klingV4Image.batch, Array.from({ length: 9 }, (_, i) => i + 1), 'kling-v4-image 声明 n 1–9 → 面板 1–9');
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

// ---- 2b. 视频原生音频（配乐 / 音效）：只有后端明确下发 audio:true 才给开关入口 ----
// 后端 apimart_video_audio_field 判定：只有文档确证有 audio / generate_audio 布尔参数的模型才下发 audio:true
const audioUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'seedance-2.5', kind: 'video',
    ratios: ['16:9'], resolutions: ['720p'], durations: [5], audio: true,
});
assert.strictEqual(audioUi.audio, true, 'audio:true → ui.audio（面板才给「音频」开关）');
const noAudioUi = caps.modelCapsUi('video', {
    provider: 'apimart', model: 'kling-v4', kind: 'video',
    ratios: ['16:9'], resolutions: ['720p'], durations: [5],
});
assert.strictEqual('audio' in noAudioUi, false, '缺字段 = 没有音频开关入口');
const falseAudioItem = { provider: 'apimart', model: 'kling-v4', kind: 'video', ratios: ['16:9'], audio: false };
assert.strictEqual('audio' in caps.modelCapsUi('video', falseAudioItem), false, 'audio:false 不落进 ui');
assert.strictEqual('audio' in caps.modelCapsUi('image', { ...falseAudioItem, kind: 'image', ratios: ['1:1'] }), false, '图片分支不受影响');

const audioSpec = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: audioUi, specSource: 'spec' });
assert.strictEqual(audioSpec.audio, true, 'specFor 认 ui.audio');
const noAudioSpec = model.specFor({ configId: 'apimart::kling-v4', label: 'kling-v4', vendor: 'APIMART', kind: 'video', ui: noAudioUi, specSource: 'spec' });
assert.strictEqual(noAudioSpec.audio, false, '没声明就是不支持（既有约定不变）');
// 有开关的模型：sound 原样保留；没开关的模型：sound 被夹成 false
const keepSound = model.clampParams('video', { model: audioSpec.id, mode: '文生视频', ratio: '16:9', res: '720p', dur: 5, sound: true, times: 1 }, audioSpec);
assert.strictEqual(keepSound.sound, true, '有音频能力的模型保留用户打开的声音');
const dropSound = model.clampParams('video', { model: noAudioSpec.id, mode: '文生视频', ratio: '16:9', res: '720p', dur: 5, sound: true, times: 1 }, noAudioSpec);
assert.strictEqual(dropSound.sound, false, '没有音频能力的模型关掉声音');

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

// ---- 5d. 2026-11-25 新下发字段（契约 §2 原值）：系列 / 长图用途篇幅 / 背景 / 精确像素 ----
const klingImageCaps = {
    provider: 'apimart', model: 'kling-v4-image', kind: 'image',
    ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    resolutions: ['2K', '4K', '8K'], durations: [], qualities: [], n_max: 9, ref_max: 10,
    series: { min: 2, max: 4 },
};
const klingImageUi = caps.modelCapsUi('image', klingImageCaps);
assert.deepStrictEqual(klingImageUi.batch, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'kling-v4-image：n 1–9 九档 batch');
assert.deepStrictEqual(klingImageUi.sizes, ['2K', '4K', '8K'], '8K 档自然来自 caps.resolutions，前端不加特判');
assert.deepStrictEqual(klingImageUi.series, { min: 2, max: 4 }, 'ui.series 读 number → { min, max }');
assert.strictEqual(klingImageUi.sendSize, true, 'send_size 缺省 = 可以带 size');
assert.strictEqual('skill' in klingImageUi, false, '没有 skill 的模型不编用途');
assert.strictEqual('backgroundAllowed' in klingImageUi, false, '没有 background 的模型不编背景枚举');
const klingImageSpec = model.specFor({ configId: 'apimart::kling-v4-image', label: 'kling-v4-image', vendor: 'APIMART', kind: 'image', ui: klingImageUi, specSource: 'spec' });
assert.deepStrictEqual(klingImageSpec.series, { min: 2, max: 4 }, 'specFor 保留 series');
assert.strictEqual(klingImageSpec.sendSize, true);
assert.strictEqual(model.defaultParams('image', klingImageSpec).count, 1, 'kling-v4-image 默认不是系列模式（1 张）');
assert.strictEqual(model.clampParams('image', { ...model.defaultParams('image', klingImageSpec), seriesImages: 4 }, klingImageSpec).seriesImages, 4, '系列 4 张在区间内保留');
assert.strictEqual('seriesImages' in model.clampParams('image', { ...model.defaultParams('image', klingImageSpec), seriesImages: 9 }, klingImageSpec), false, '系列 9 张超出 2–4 → 清掉');

const longImageCaps = {
    provider: 'apimart', model: 'kling-v4-long-image', kind: 'image',
    ratios: [], resolutions: ['1K', '2K'], durations: [], qualities: [], n_max: 1, ref_max: 3,
    skill: ['ecommerce', 'webpage'], length: ['short', 'medium', 'long'], send_size: false,
};
const longImageUi = caps.modelCapsUi('image', longImageCaps);
assert.deepStrictEqual(longImageUi.skill, ['ecommerce', 'webpage'], 'skill → ui.skill');
assert.deepStrictEqual(longImageUi.length, ['short', 'medium', 'long'], 'length → ui.length');
assert.strictEqual(longImageUi.sendSize, false, 'send_size:false → ui.sendSize=false');
assert.deepStrictEqual(longImageUi.ratios, [], 'ratios 为空数组：不编比例');
assert.deepStrictEqual(longImageUi.batch, [1], 'n_max=1 → 1 张');
const longImageSpec = model.specFor({ configId: 'apimart::kling-v4-long-image', label: 'kling-v4-long-image', vendor: 'APIMART', kind: 'image', ui: longImageUi, specSource: 'spec' });
assert.strictEqual(longImageSpec.sendSize, false, 'specFor 保留 sendSize');
assert.deepStrictEqual(longImageSpec.skill, ['ecommerce', 'webpage']);
const longDefaults = model.defaultParams('image', longImageSpec);
assert.strictEqual(longDefaults.skill, 'ecommerce', '用途必填、默认 ecommerce');
assert.strictEqual(longDefaults.length, 'medium', '篇幅默认 medium');
const longWebpage = model.clampParams('image', { ...longDefaults, skill: 'webpage', length: 'long' }, longImageSpec);
assert.strictEqual(longWebpage.skill, 'webpage');
assert.strictEqual('length' in longWebpage, false, 'webpage 模式清掉篇幅（上游只在 ecommerce 收）');
assert.strictEqual(model.clampParams('image', { ...longDefaults, length: 'huge' }, longImageSpec).length, 'medium', '非法篇幅回落 medium');
assert.strictEqual('sourceSize' in model.clampParams('image', { ...longDefaults, ratio: '自适应', sourceSize: '1000x1000' }, longImageSpec), false, 'send_size=false 的模型清掉显式 WxH');

const plainImageCaps = { provider: 'apimart', model: 'seedream-5-0-flash', kind: 'image', ratios: ['1:1'], resolutions: ['2K'], n_max: 4 };
const plainImageUi = caps.modelCapsUi('image', plainImageCaps);
const plainImageSpec = model.specFor({ configId: 'apimart::seedream-5-0-flash', label: 'seedream-5-0-flash', vendor: 'APIMART', kind: 'image', ui: plainImageUi, specSource: 'spec' });
const movedAway = model.clampParams('image', { ...longDefaults, seriesImages: 3, background: 'opaque' }, plainImageSpec);
assert.strictEqual('skill' in movedAway, false, '换模型清掉用途');
assert.strictEqual('length' in movedAway, false, '换模型清掉篇幅');
assert.strictEqual('seriesImages' in movedAway, false, '换模型清掉系列张数');
assert.strictEqual('background' in movedAway, false, '换模型清掉不属于新模型的背景');

const maiImageCaps = {
    provider: 'apimart', model: 'mai-image-2.7', kind: 'image',
    ratios: [], resolutions: ['1K', '2K'], durations: [], qualities: [], max_pixels: 4194304, n_max: 1, ref_max: 5,
    background: ['auto', 'opaque'], min_side: 768, size_step: 32, exact_size_pair: true,
};
const maiImageUi = caps.modelCapsUi('image', maiImageCaps);
assert.deepStrictEqual(maiImageUi.backgroundAllowed, ['auto', 'opaque'], 'background → ui.backgroundAllowed（没有 transparent）');
assert.strictEqual(maiImageUi.exactSizePair, true, 'exact_size_pair:true → ui.exactSizePair');
assert.strictEqual(maiImageUi.minSide, 768, 'min_side → number');
assert.strictEqual(maiImageUi.sizeStep, 32, 'size_step → number');
assert.strictEqual(maiImageUi.sendSize, true, 'mai 仍带 size（后端转 width/height）');
const maiImageSpec = model.specFor({ configId: 'apimart::mai-image-2.7', label: 'mai-image-2.7', vendor: 'APIMART', kind: 'image', ui: maiImageUi, specSource: 'spec' });
assert.deepStrictEqual(maiImageSpec.backgroundAllowed, ['auto', 'opaque']);
assert.strictEqual(maiImageSpec.exactSizePair, true);
assert.strictEqual(maiImageSpec.minSide, 768);
assert.strictEqual(maiImageSpec.sizeStep, 32);
const maiBaseParams = model.defaultParams('image', maiImageSpec);
assert.strictEqual(model.clampParams('image', { ...maiBaseParams, background: 'opaque' }, maiImageSpec).background, 'opaque', 'mai 保留 opaque');
assert.strictEqual('background' in model.clampParams('image', { ...maiBaseParams, background: 'transparent' }, maiImageSpec), false, 'mai 不接受 transparent（上游 400）');
assert.strictEqual('background' in model.clampParams('image', { ...maiBaseParams, background: 'opaque' }, longImageSpec), false, '没有 background 枚举的模型清掉 opaque');

// clampMaiSize：两边 ≥768、总像素 ≤4194304、向下取 size_step 的倍数（与 main.py normalize_mai_image_size 同口径）
const maiSized = (input, limits) => caps.clampMaiSize(input, limits);
assert.strictEqual(maiSized('1000x1000').size, '992x992', '1000 → 992（向下取 32）');
assert.strictEqual(maiSized('1000x1000').clamped, true);
assert.strictEqual(maiSized('512x512').size, '768x768', '小于 768 的边抬到 768');
assert.strictEqual(maiSized('4096x4096').size, '2048x2048', '总像素超限等比收到上限内');
assert.strictEqual(maiSized('2048x2048').clamped, false, '恰好在上限内的合法尺寸不动');
assert.strictEqual(maiSized('auto').size, 'auto', '比例 / auto 不在这里换算');
assert.strictEqual(maiSized('1000x1000', { minSide: 512, sizeStep: 64 }).size, '960x960', '按 caps 下发的 size_step 收敛');
assert.strictEqual(caps.clampImageSize('1000x1000', { maxLongEdge: 3840 }).size, '1000x1000', 'clampImageSize 仍是 GPT-Image 口径（不套在 mai 上）');

// ---- 6. 后端接线静态断言 ----
const backend = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
const card = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskPlanCard.tsx'), 'utf8');
const genPanel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
assert.ok(genPanel.includes('LONG_SKILL_LABEL') && genPanel.includes('data-skill') && genPanel.includes('seg("skill"'), '面板有「用途」下拉（skill）');
assert.ok(genPanel.includes('LONG_LENGTH_LABEL') && genPanel.includes('data-length') && genPanel.includes('seg("length"'), '面板有「篇幅」下拉（length）');
assert.ok(genPanel.includes('kind === "image" && String((p as ImageParams).skill || "").toLowerCase() === "webpage"') && genPanel.includes('webpage（网页长图）暂不支持参考图'), 'webpage 模式隐藏参考图入口并明确提示后端会 400');
assert.ok(genPanel.includes('seriesCounts') && genPanel.includes('data-series') && genPanel.includes('"系列模式"'), '面板有「系列模式」（按 caps.series 的 2–4 张）');
assert.ok(genPanel.includes('if (m?.sendSize !== false)') && genPanel.includes('send_size=false 的模型'), 'send_size=false 的模型不渲染比例 / 尺寸段');
assert.ok(genPanel.includes('data-mai-size') && genPanel.includes('data-p="background-model"') && genPanel.includes('backgroundAllowed'), 'mai 有背景枚举与精确像素说明');
assert.ok(backend.includes('clampMaiSize(size, { minSide: Number(item.min_side)') && !/clampMaiSize\([^)]*maxLongEdge/.test(backend), 'mai 走 clampMaiSize，不复用 clampImageSize');
assert.ok(backend.includes('series_images: seriesImages') && backend.includes('n: seriesImages ? 1 :'), '系列生效时请求体 n 恒为 1，张数走 series_images');
assert.ok(backend.includes('...(skill ? { skill } : {})') && backend.includes('...(length ? { length } : {})'), 'skill / length 只在该模型 caps 声明时下发');
assert.ok(backend.includes('fetch("/api/model-caps"'), 'listModels 会 best-effort 拉 /api/model-caps');
assert.ok(backend.includes('MODEL_CAPS_TIMEOUT_MS = 1000') && backend.includes('AbortController'), '接口带短超时，不拖死模型列表');
// 缓存失效：config 一变（设置页改模型 / 平台增删）两份 caps 都要跟着作废，否则面板参数还是上一个平台的
const invalidateBody = (backend.match(/const invalidate = \(\) => \{([^}]*)\}/) || [])[1] || '';
assert.ok(
  /configCache = null/.test(invalidateBody) && /capsCache = null/.test(invalidateBody)
  && /builtinCapsCache = null/.test(invalidateBody) && /cb\(\)/.test(invalidateBody),
  'caps 缓存与 config 一起失效（含 include_builtin 那份）'
);
// config 拉取失败（切平台 / 网关异常）时同样不能留着上一轮的 caps
const configLine = (backend.match(/configCache = request\("\/api\/config"\)[^\n]*/) || [''])[0];
assert.ok(/capsCache = null/.test(configLine) && /builtinCapsCache = null/.test(configLine), 'config 拉取失败时 caps 缓存一起清掉');
assert.ok(backend.indexOf('const capsPromise = loadCaps()') >= 0 && backend.indexOf('const caps = await capsPromise') >= 0, '模型列表与 caps 并发加载');
assert.ok(backend.includes('let capsUi =') && backend.includes('const ui = capsUi ||') && backend.includes('mergeCapsReferenceCapability'), 'caps 优先于官方硬编码，并保留参考图能力');
assert.ok(card.includes('该模型未提供规格，比例/分辨率为推断'), '未验证模型在方案卡上有提示');
assert.ok(card.includes('上限未知，以实际为准'), 'n_max 缺失时方案卡提示上限未知');
assert.ok(card.includes('生成方式：自动选择'), '视频步骤在方案卡上说明自动选择方式');
assert.ok(genPanel.includes('mm.batchUnknown ? [1] : [...(mm.batch?.length ? mm.batch : [1])]') && !genPanel.includes('上限未知，以实际为准'), '图片面板张数选项按 caps 的 batch 生成（缺失时只给 1 张），弹层不再显示灰字上限提示');
assert.ok(!backend.includes('Math.min(4, Number(params.count)') && backend.includes('requestImageCount'), '请求张数不再硬钳 4，改由 caps 的 n_max 收敛');
assert.ok(card.includes('explicitSpec.specSource !== "spec"'), '提示按 ModelSpec.specSource 判定（只对步骤显式选的模型提示，不暗示默认模型）');
assert.ok(backend.includes('outputFormatForRequest') && backend.includes('output_format: outputFormat'), '生成请求只对 gif / svg 下发 output_format');
assert.ok(genPanel.includes('data-p="output-format"') && genPanel.includes('输出格式'), '图片参数弹层有「输出格式」段');
assert.strictEqual(genPanel.includes('data-seg="background"'), false, '底栏不再有独立的「背景」段');
assert.ok(genPanel.includes('{m.nativeBackground ? <>') && genPanel.includes('data-p="background"') && genPanel.includes('data-background="default"') && genPanel.includes('data-background="transparent"'), '透明背景入口在「比例 · 尺寸」弹层里，只由 caps.nativeBackground 控制');
assert.ok(genPanel.includes('set({ background: "transparent", outputFormat: undefined })'), '开透明背景时连带清掉输出格式');
assert.ok(genPanel.includes('" · 透明"'), '比例摘要显示「 · 透明」状态');
assert.ok(backend.includes('params.background === "transparent"') && backend.includes('background: "transparent"'), '生成请求按透明背景下发 background 字段');

console.log('[PASS] model-caps 映射 / 未验证回落 / 方案卡选项与纠正 / 图片输出格式 / 后端接线 / 2026-11 新模型面板选项（8 组）');

// ---- 7. 请求体：series_images / skill / length / 背景枚举 / mai 精确像素（fetch 桩，不真外呼）----
/** 把 novaiBackend 单独打成一个包：generate() 里的 createImageTask 才是真正组装请求体的地方 */
function loadBackendModule() {
    const os = require('os');
    const entry = path.join(os.tmpdir(), 'novai-caps-body-entry-' + process.pid + '.ts');
    fs.writeFileSync(entry, 'export * as backend from ' + JSON.stringify(path.join(root, 'novai-canvas-ui/src/novaiBackend.ts')) + ';');
    try {
        const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
        const loaded = { exports: {} };
        new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
        return loaded.exports.backend;
    } finally {
        fs.unlinkSync(entry);
    }
}

const BODY_CAPS_ITEMS = [klingImageCaps, longImageCaps, maiImageCaps, plainImageCaps];
const bodySpecFor = (name) => model.specFor({
    configId: 'apimart::' + name, label: name, vendor: 'APIMART', kind: 'image',
    ui: caps.modelCapsUi('image', BODY_CAPS_ITEMS.find((item) => item.model === name)), specSource: 'spec',
});

/** 建任务请求体：POST /api/canvas-image-tasks 不发 task_id → generate() 抛 NO_TASK，正好只截请求体 */
async function imageRequestBody(backendMod, name, patch) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const key = (init.method || 'GET') + ' ' + String(url);
        calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
        if (key === 'GET /api/model-caps') return { ok: true, status: 200, json: async () => ({ items: BODY_CAPS_ITEMS }) };
        if (key === 'POST /api/canvas-image-tasks') return { ok: true, status: 200, json: async () => ({}) };
        throw new Error('没有 mock 这个请求：' + key);
    };
    try {
        const backend = backendMod.createNovaiBackend();
        const spec = bodySpecFor(name);
        await backend.generate({
            canvasId: 'c1', nodeId: 'n1', kind: 'image', model: spec,
            prompt: '画一张', resolvedPrompt: '画一张',
            params: { ...model.defaultParams('image', spec), ...patch }, inputs: [],
        }, () => {}, new AbortController().signal).catch((error) => {
            if (String((error && error.code) || '') !== 'NO_TASK') throw error;
        });
        const create = calls.find((call) => call.key === 'POST /api/canvas-image-tasks');
        assert.ok(create && create.body, '要发出建任务请求');
        assert.strictEqual(create.body.model, name, '请求体换成了要测的模型');
        return create.body;
    } finally {
        globalThis.fetch = originalFetch;
    }
}

(async () => {
    const backendMod = loadBackendModule();

    const seriesBody = await imageRequestBody(backendMod, 'kling-v4-image', { seriesImages: 3, count: 9 });
    assert.strictEqual(seriesBody.series_images, 3, '系列模式：series_images=3 原样下发');
    assert.strictEqual(seriesBody.n, 1, '系列生效时 n 不能 >1（上游 400）');
    assert.strictEqual('skill' in seriesBody, false, 'kling-v4-image 不带 skill');
    assert.strictEqual('length' in seriesBody, false, 'kling-v4-image 不带 length');

    const countBody = await imageRequestBody(backendMod, 'kling-v4-image', { count: 9 });
    assert.strictEqual(countBody.n, 9, '不开系列：9 张原样下发（不再钳 4）');
    assert.strictEqual('series_images' in countBody, false, '不开系列不发 series_images');

    const seriesDirty = await imageRequestBody(backendMod, 'kling-v4-image', { seriesImages: 9, count: 9 });
    assert.strictEqual('series_images' in seriesDirty, false, '系列张数超出 2–4 不发');
    assert.strictEqual(seriesDirty.n, 9, '非法系列值退回普通 n');

    const longEcommerce = await imageRequestBody(backendMod, 'kling-v4-long-image', {});
    assert.strictEqual(longEcommerce.skill, 'ecommerce', '长图用途默认下发 ecommerce');
    assert.strictEqual(longEcommerce.length, 'medium', 'ecommerce 篇幅默认 medium');
    assert.strictEqual(longEcommerce.n, 1, '长图固定 1 张');

    const longWebpage = await imageRequestBody(backendMod, 'kling-v4-long-image', { skill: 'webpage', length: 'long' });
    assert.strictEqual(longWebpage.skill, 'webpage', 'webpage 用途原样下发');
    assert.strictEqual('length' in longWebpage, false, 'webpage 不带 length（上游只在 ecommerce 收）');

    const maiBody = await imageRequestBody(backendMod, 'mai-image-2.7', { ratio: '自适应', sourceSize: '1000x1000', background: 'opaque' });
    assert.strictEqual(maiBody.size, '992x992', 'mai 精确像素 1000→992 后才发（后端再转 width/height）');
    assert.strictEqual(maiBody.background, 'opaque', '背景枚举按用户选的发');
    assert.strictEqual(maiBody.n, 1, 'mai 固定 1 张');

    const otherBody = await imageRequestBody(backendMod, 'seedream-5-0-flash', { skill: 'ecommerce', length: 'long', seriesImages: 3, background: 'opaque' });
    assert.strictEqual('skill' in otherBody, false, '不属于新模型的 skill 不发');
    assert.strictEqual('length' in otherBody, false, '不属于新模型的 length 不发');
    assert.strictEqual('series_images' in otherBody, false, '不属于新模型的 series_images 不发');
    assert.strictEqual('background' in otherBody, false, '没有 background 枚举的模型不发 background');

    console.log('[PASS] 2026-11-25 新字段请求体：series_images / skill / length / background / mai 精确像素');
    // 草稿两段式的请求体依赖上一个 fetch 桩收尾，串行跑（两个桩同时接管 globalThis.fetch 会互相踩）
    await runDraftBodyTests();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

// ---- 8. Seedance 草稿两段式（2026-11-25）：caps → ui / 两段请求体 / 过期与 4K 错误分支 ----
const DRAFT_CAPS_ITEM = {
    provider: 'apimart', model: 'seedance-2.5', kind: 'video',
    ratios: ['16:9', '9:16'], resolutions: ['480p', '720p', '1080p', '4k'], durations: [-1, 4, 5],
    draft: true, draft_resolution: '480p', draft_final_resolutions: ['1080P', '4K'], draft_expires_days: 3,
};
const FLASH_CAPS_ITEM = {
    provider: 'apimart', model: 'seedance-2-5-flash', kind: 'video',
    ratios: ['16:9'], resolutions: ['480p', '720p', '1080p', '4k'], durations: [5],
};
const draftUi = caps.modelCapsUi('video', DRAFT_CAPS_ITEM);
assert.strictEqual(draftUi.draft, true, 'draft:true → ui.draft');
assert.strictEqual(draftUi.draftRes, '480p', 'draft_resolution → ui.draftRes');
assert.deepStrictEqual(draftUi.draftFinals, ['1080p', '4k'], 'draft_final_resolutions 小写去重 → ui.draftFinals');
assert.strictEqual(draftUi.draftExpiresDays, 3, 'draft_expires_days → number');
const flashUi = caps.modelCapsUi('video', FLASH_CAPS_ITEM);
assert.strictEqual('draft' in flashUi, false, '缺字段 = 不支持：flash 不落 draft');
assert.strictEqual('draftFinals' in flashUi, false, 'flash 没有成片档');
assert.strictEqual('draft' in caps.modelCapsUi('video', { ...DRAFT_CAPS_ITEM, draft: false }), false, 'draft:false 不落 ui（不是「支持」）');
assert.strictEqual('draftRes' in caps.modelCapsUi('video', { ...DRAFT_CAPS_ITEM, draft: true, draft_resolution: '' }), false, '空草稿档不落键');
const draftSpecForBody = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: draftUi, specSource: 'spec' });
const flashSpecForBody = model.specFor({ configId: 'apimart::seedance-2-5-flash', label: 'seedance-2-5-flash', vendor: 'APIMART', kind: 'video', ui: flashUi, specSource: 'spec' });
assert.strictEqual(draftSpecForBody.draft, true);
assert.deepStrictEqual(draftSpecForBody.draftFinals, ['1080p', '4k']);
assert.strictEqual(model.draftSupported(draftSpecForBody), true);
assert.strictEqual(model.draftSupported(flashSpecForBody), false, 'flash 没有草稿入口');
assert.deepStrictEqual(model.draftFinalResolutions(flashSpecForBody), [], 'flash 没有成片档');

/** 直接调 backend.generate 截 /api/canvas-video 的请求体（fetch 桩，不真外呼） */
async function videoRequest(backendMod, spec, patch, options = {}) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const key = (init.method || 'GET') + ' ' + String(url);
        calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
        if (key === 'POST /api/canvas-video?async=1') {
            if (options.fail) return { ok: false, status: 400, json: async () => ({ detail: options.fail }) };
            return { ok: true, status: 200, json: async () => ({ task_id: 'canvas_video_t1' }) };
        }
        if (key === 'GET /api/tasks/canvas_video_t1') {
            if (options.pollFail) return { ok: true, status: 200, json: async () => ({ status: 'failed', error: options.pollFail }) };
            return { ok: true, status: 200, json: async () => ({ status: 'succeeded', result: { videos: [{ url: '/output/draft.mp4' }], task_id: options.upstreamTask || 'up_draft_1' } }) };
        }
        throw new Error('没有 mock 这个请求：' + key);
    };
    try {
        const backend = backendMod.createNovaiBackend();
        const params = { ...model.defaultParams('video', spec), ...patch };
        const result = await backend.generate({
            canvasId: 'c1', nodeId: 'n1', kind: 'video', model: spec,
            prompt: '一只猫在窗台', resolvedPrompt: '一只猫在窗台', params, inputs: [],
        }, () => {}, new AbortController().signal);
        const create = calls.find((call) => call.key === 'POST /api/canvas-video?async=1');
        assert.ok(create && create.body, '要发出视频建任务请求');
        return { body: create.body, result };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

/** 只要错误：抛出的 GenError 消息用于断言过期 / 4K 分支 */
async function videoRequestError(backendMod, spec, patch, options) {
    try { await videoRequest(backendMod, spec, patch, options); }
    catch (error) { return error; }
    throw new Error('预期请求失败但没有抛错');
}

async function runDraftBodyTests() {
    const backendMod = loadBackendModule();

    // 第一段：草稿 = 正常请求 + draft:true，分辨率固定草稿档
    const draftStage = await videoRequest(backendMod, draftSpecForBody, { draft: true, res: '4k' });
    assert.strictEqual(draftStage.body.draft, true, '第一段请求带 draft:true');
    assert.strictEqual(draftStage.body.resolution, '480p', '第一段分辨率固定 480p（即使面板选的是 4k）');
    assert.strictEqual('draft_task_id' in draftStage.body, false, '第一段不带 draft_task_id');
    assert.strictEqual(draftStage.result.outputs[0].draftTaskId, 'up_draft_1', '草稿完成：版本上记返回体的 task_id（出成片用）');

    // 第二段：只带 model / draft_task_id / resolution（+ schema 必填的占位 prompt、路由字段）
    const finalStage = await videoRequest(backendMod, draftSpecForBody, { draftTaskId: 'up_draft_1', res: '4k' });
    assert.deepStrictEqual(Object.keys(finalStage.body).sort(), ['canvas_id', 'draft_task_id', 'model', 'node_id', 'prompt', 'provider_id', 'resolution'], '第二段只有 model / draft_task_id / resolution（其余是 schema 必填占位与画布任务绑定字段）');
    assert.strictEqual(finalStage.body.model, 'seedance-2.5');
    assert.strictEqual(finalStage.body.draft_task_id, 'up_draft_1');
    assert.strictEqual(finalStage.body.resolution, '4k');
    for (const field of ['draft', 'duration', 'aspect_ratio', 'images', 'videos', 'audios', 'generate_audio', 'size', 'seed', 'mode']) {
        assert.strictEqual(field in finalStage.body, false, '第二段不带继承字段：' + field);
    }
    assert.strictEqual(finalStage.result.outputs[0].draft, undefined, '成片结果不标 draft');

    const finalDefault = await videoRequest(backendMod, draftSpecForBody, { draftTaskId: 'up_draft_1', res: '720p' });
    assert.strictEqual(finalDefault.body.resolution, '1080p', '成片档不在 1080p/4k 里 → 按 1080p 发');

    // 其它模型：残留的 draft / draft_task_id 一个字段都不带，清晰度也不被改
    const flashDraft = await videoRequest(backendMod, flashSpecForBody, { draft: true, res: '1080p' });
    assert.strictEqual('draft' in flashDraft.body, false, 'seedance-2-5-flash 不发 draft');
    assert.strictEqual('draft_task_id' in flashDraft.body, false, 'flash 不发 draft_task_id');
    assert.strictEqual(flashDraft.body.resolution, '1080p', 'flash 上的旧 draft 值不改清晰度');
    const flashFinal = await videoRequest(backendMod, flashSpecForBody, { draftTaskId: 'up_draft_1', res: '4k' });
    assert.strictEqual('draft_task_id' in flashFinal.body, false, 'flash 不接受成片请求字段');
    assert.strictEqual(flashFinal.body.duration, model.defaultParams('video', flashSpecForBody).dur, 'flash 走正常请求体（带 duration）');

    // 错误分支：过期 / 不存在 → 明确提示 3 天；4K 不支持 → 引导 1080p；草稿步失败 → 说明草稿
    const expired = await videoRequestError(backendMod, draftSpecForBody, { draftTaskId: 'up_expired', res: '1080p' }, { fail: '上游视频接口错误：draft task not found or expired' });
    assert.ok(/草稿不存在或已过期（草稿 3 天内有效）/.test(expired.message), '过期 400 的人话提示：' + expired.message);
    const fourK = await videoRequestError(backendMod, draftSpecForBody, { draftTaskId: 'up_draft_1', res: '4k' }, { fail: '上游视频接口错误：resolution 4k is not supported on this channel' });
    assert.ok(/不支持 4K 成片，改用 1080p/.test(fourK.message), '4K 通道不支持 → 改 1080p：' + fourK.message);
    const draftFail = await videoRequestError(backendMod, draftSpecForBody, { draft: true }, { fail: '草稿模式暂不可用' });
    assert.ok(/草稿生成失败：草稿模式暂不可用/.test(draftFail.message), '草稿步失败说清是草稿：' + draftFail.message);

    console.log('[PASS] Seedance 草稿两段式请求体：caps 映射 / 第一段 draft:true+480p / 第二段白名单 / flash 不带字段 / 过期与 4K 错误分支');
}
