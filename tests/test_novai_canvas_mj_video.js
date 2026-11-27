#!/usr/bin/env node
/* Midjourney 图生视频（虚拟视频模型 midjourney-video）的编辑器接线（DRAFT-MJ-VIDEO-CONTRACT §8）：
   1. caps → ui：/api/model-caps 的 mj_video 翻成 ModelSpec.mjVideo（motions / video_types / batch /
      animate_modes / base_by_tier / start_end_by_tier / billing_by_tier / duration_fixed / index 区间），
      缺字段 = 没有这项能力（别的模型一个键都不落）；
   2. 模型出现：/api/config 的 video_models 里有 midjourney-video，listModels 就要给出这个视频模型（带权威 caps）；
   3. 默认值与收敛：480p / motion=high / batch=1 / mode=首帧；1080p·4k 收到 720p；auto 缺 task_id+index 被拦；
      换到别的模型把 MJ 字段全清掉；
   4. 请求体（fetch 桩截 POST /api/canvas-video?async=1）：只带契约字段
      prompt/model/mode/images/end_image/motion/mj_batch/video_type/mj_task_id/mj_index/animate_mode，
      不出现 duration/aspect_ratio/resolution/seed/audio；其它视频模型一个字段都不带；
   5. 面板：MJ 行只在 caps.mj_video 的模型上渲染（data-mj-*），尾帧入口按 supports_end_frame 出现。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

// 后端 GET /api/model-caps?include_builtin=1 的真实条目形状（main.py APIMART_VIDEO_MODEL_CAPS + _caps_mj_video_payload）
const MJ_VIDEO_ITEM = {
    provider: 'apimart', model: 'midjourney-video', kind: 'video',
    modes: ['image_to_video'], durations: [5], ratios: [], resolutions: ['480p', '720p'],
    batch: [1, 2, 4], ref_max: 1, n_max: 1,
    mj_video: {
        endpoint: '/v1/midjourney/generations/video', upstream_model: 'midjourney',
        input_sources: ['image_urls', 'task_id'], requires_first_frame: true, supports_end_frame: true,
        duration_seconds: 5, duration_fixed: true,
        motions: ['low', 'high'], motion_default: 'high',
        video_types: ['vid_1.1_i2v_480', 'vid_1.1_i2v_720', 'vid_1.1_i2v_start_end_480', 'vid_1.1_i2v_start_end_720'],
        video_type_default: 'vid_1.1_i2v_480',
        base_by_tier: { '480p': 'vid_1.1_i2v_480', '720p': 'vid_1.1_i2v_720' },
        start_end_by_tier: { '480p': 'vid_1.1_i2v_start_end_480', '720p': 'vid_1.1_i2v_start_end_720' },
        start_end_video_types: ['vid_1.1_i2v_start_end_480', 'vid_1.1_i2v_start_end_720'],
        animate_modes: ['manual', 'auto'], batch: [1, 2, 4], batch_default: 1,
        index_min: 0, index_max: 3,
        billing: ['midjourney@video', 'midjourney@video-720p'],
        billing_by_tier: { '480p': 'midjourney@video', '720p': 'midjourney@video-720p' },
    },
};
const SEEDANCE_ITEM = {
    provider: 'apimart', model: 'seedance-2.5', kind: 'video',
    modes: ['text_to_video', 'image_to_video'], durations: [5, 10], ratios: ['16:9'],
    resolutions: ['480p', '720p', '1080p', '4k'], ref_max: 9,
};

// ---- 1. caps → ui.mjVideo ----
const mjUi = caps.modelCapsUi('video', MJ_VIDEO_ITEM);
assert.ok(mjUi, 'MJ 视频条目要翻成 ui');
const spec = mjUi.mjVideo;
assert.ok(spec, 'mj_video → ui.mjVideo');
assert.strictEqual(spec.endpoint, '/v1/midjourney/generations/video', 'endpoint 原样带过来（只做标识）');
assert.strictEqual(spec.upstreamModel, 'midjourney', 'upstream_model 原样带过来（不进请求体）');
assert.deepStrictEqual(spec.inputSources, ['image_urls', 'task_id'], '输入二选一');
assert.strictEqual(spec.requiresFirstFrame, true, 'requires_first_frame');
assert.strictEqual(spec.supportsEndFrame, true, 'supports_end_frame → 尾帧入口');
assert.strictEqual(spec.durationSeconds, 5, 'duration_seconds');
assert.strictEqual(spec.durationFixed, true, 'duration_fixed → 不画时长滑杆');
assert.deepStrictEqual(spec.motions, ['low', 'high'], '运动幅度来自 caps');
assert.strictEqual(spec.motionDefault, 'high', '默认 high');
assert.deepStrictEqual(spec.videoTypes, ['vid_1.1_i2v_480', 'vid_1.1_i2v_720', 'vid_1.1_i2v_start_end_480', 'vid_1.1_i2v_start_end_720'], '4 个 video_type 全从 caps 来（不硬编码）');
assert.strictEqual(spec.videoTypeDefault, 'vid_1.1_i2v_480', '默认 480p 基础档');
assert.deepStrictEqual(spec.baseByTier, { '480p': 'vid_1.1_i2v_480', '720p': 'vid_1.1_i2v_720' });
assert.deepStrictEqual(spec.startEndByTier, { '480p': 'vid_1.1_i2v_start_end_480', '720p': 'vid_1.1_i2v_start_end_720' }, '有尾帧时按开始/结束帧的对应值');
assert.deepStrictEqual(spec.animateModes, ['manual', 'auto']);
assert.deepStrictEqual(spec.batch, [1, 2, 4], '批次候选');
assert.strictEqual(spec.batchDefault, 1);
assert.strictEqual(spec.indexMin, 0);
assert.strictEqual(spec.indexMax, 3, '复用 MJ 出图只有第 0–3 张候选');
assert.deepStrictEqual(spec.billing, ['midjourney@video', 'midjourney@video-720p']);
assert.deepStrictEqual(spec.billingByTier, { '480p': 'midjourney@video', '720p': 'midjourney@video-720p' });

// 缺字段 = 没有这个能力；别的模型一个键都不落
assert.strictEqual('mjVideo' in caps.modelCapsUi('video', SEEDANCE_ITEM), false, 'seedance 没有 mj_video → 不落 mjVideo');
assert.strictEqual('mjVideo' in caps.modelCapsUi('video', { ...SEEDANCE_ITEM, mj_video: {} }), false, '空 mj_video 不编能力');
assert.strictEqual('mjVideo' in caps.modelCapsUi('video', { ...SEEDANCE_ITEM, mj_video: { motions: ['low'], motions_bogus: 1 } }), true, '只有部分键时仍按有的键落（缺的不补）');
assert.strictEqual(caps.normalizeMjVideoSpec(null), null, 'normalize 明确返回 null');

// 规格落地：specFor 认 mjVideo，档位只 480p/720p（没有 1080p/4k），比例为空
const mjSpec = model.specFor({ configId: 'apimart::midjourney-video', label: 'midjourney-video', vendor: 'APIMART', kind: 'video', ui: mjUi, specSource: 'spec' });
assert.strictEqual(mjSpec.specSource, 'spec', '权威 caps → 已验证规格');
assert.deepStrictEqual(mjSpec.res, ['480p', '720p'], '分辨率只有 480p / 720p');
assert.deepStrictEqual(mjSpec.ratios, [], '上游没有画幅字段：比例为空（面板不画比例控件）');
assert.deepStrictEqual(mjSpec.durs, [5], '时长只有 5（面板退化成只读说明）');
assert.deepStrictEqual(mjSpec.modes, ['首帧'], '只有图生视频');
assert.strictEqual(mjSpec.maxRefs, 1, '首帧图只收 1 张');
assert.strictEqual(mjSpec.batch, undefined, '视频节点的张数批次不走图片的 batch（走 mj_batch）');
assert.strictEqual(model.mjVideoSpec(mjSpec), mjSpec.mjVideo, 'model.mjVideoSpec 直接取到能力位');

// ---- 2. 默认参数：480p / high / batch 1 / mode 首帧 ----
const dft = model.defaultParams('video', mjSpec);
assert.strictEqual(dft.mode, '首帧', '没有文生视频：默认方式就是它支持的那一种（否则必然 400）');
assert.strictEqual(dft.res, '480p', '默认档位听 caps 的 video_type_default（480p），不套「优先 720p」');
assert.strictEqual(dft.motion, 'high', '默认运动幅度 high');
assert.strictEqual(dft.mjBatch, 1, '默认批次 1');
assert.strictEqual(dft.animateMode, 'manual', '没有 task_id 时固定手动');
assert.strictEqual(dft.dur, 5, '时长固定 5 秒');

// ---- 3. 收敛：1080p/4k 被拦、auto 缺参数被拦、换模型清字段 ----
const from4k = model.clampParams('video', { model: 'apimart::seedance-2.5', mode: '文生视频', ratio: '16:9', res: '4k', dur: 10, sound: true, times: 1 }, mjSpec);
assert.strictEqual(from4k.res, '480p', '换到 MJ 视频：档位回到 caps 的默认 480p（档位决定计费，不继承别家的 4k）');
assert.strictEqual(from4k.ratio, 'adaptive', 'MJ 视频没有画幅字段 → 比例表达成「原图比例」');
const keepTier = model.clampParams('video', { ...dft, res: '720p' }, mjSpec);
assert.strictEqual(keepTier.res, '720p', '已经是 MJ 视频：用户手动选的 720p 保留');
assert.strictEqual(from4k.motion, 'high', '换到 MJ 视频补默认运动幅度');
assert.strictEqual(from4k.mjBatch, 1, '换到 MJ 视频补默认批次');
assert.strictEqual(from4k.mode, '首帧', '生成方式收进 caps 的唯一一种');
assert.strictEqual(model.mjVideoBatch(mjSpec, 3), 1, '批次只认 1/2/4：3 收到默认 1');
assert.strictEqual(model.mjVideoBatch(mjSpec, 4), 4, '批次 4 合法');
assert.strictEqual(model.mjVideoMotion(mjSpec, 'low'), 'low', '运动幅度 low 合法');
assert.strictEqual(model.mjVideoMotion(mjSpec, 'ultra'), 'high', '脏值回默认 high');
assert.strictEqual(model.mjVideoType(mjSpec, '480p', false), 'vid_1.1_i2v_480', '无尾帧 480p → 基础档');
assert.strictEqual(model.mjVideoType(mjSpec, '720p', false), 'vid_1.1_i2v_720');
assert.strictEqual(model.mjVideoType(mjSpec, '720p', true), 'vid_1.1_i2v_start_end_720', '有尾帧 → 首尾帧档（档位不变）');
assert.strictEqual(model.mjVideoType(mjSpec, '1080p', false), '', '没有 1080p 的映射：不猜 video_type');
assert.strictEqual(model.mjVideoTier(mjSpec, '1080p'), '720p', '1080p 残留值收进最近档 720p');
assert.strictEqual(model.mjVideoTier(mjSpec, '4k'), '720p', '4k 残留值也收进 720p');
assert.strictEqual(model.mjVideoDefaultTier(mjSpec), '480p');

const autoNoTask = model.clampParams('video', { ...dft, animateMode: 'auto' }, mjSpec);
assert.strictEqual(autoNoTask.animateMode, 'manual', '没有 task_id 的 auto 收成手动');
const autoTaskNoIndex = model.clampParams('video', { ...dft, animateMode: 'auto', mjTaskId: 'up_mj_1' }, mjSpec);
assert.strictEqual(autoTaskNoIndex.animateMode, 'manual', '有 task_id 但没指明第几张 → 仍是手动');
const autoOk = model.clampParams('video', { ...dft, animateMode: 'auto', mjTaskId: 'up_mj_1', mjIndex: 2 }, mjSpec);
assert.strictEqual(autoOk.animateMode, 'auto', 'task_id + 显式 index 才允许自动');
const backToOther = model.clampParams('video', { ...dft, motion: 'low', mjBatch: 2, mjTaskId: 'up_mj_1', mjIndex: 2, animateMode: 'auto' }, model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', SEEDANCE_ITEM), specSource: 'spec' }));
for (const field of ['motion', 'mjBatch', 'mjTaskId', 'mjIndex', 'animateMode']) {
    assert.strictEqual(field in backToOther, false, '换到别的模型清掉 MJ 字段：' + field);
}

// 提交前拦截（后端也会 400，这里先拦）
const noFrame = model.mjVideoInputError(mjSpec, { ...dft }, false);
assert.ok(/需要一张首帧图/.test(noFrame), '没有首帧图 → 拦住：' + noFrame);
assert.strictEqual(model.mjVideoInputError(mjSpec, { ...dft, mjTaskId: 'up_mj_1', mjIndex: 0 }, false), null, '复用 task_id + index 可以不要首帧图');
assert.ok(/只能二选一/.test(model.mjVideoInputError(mjSpec, { ...dft, mjTaskId: 'up_mj_1' }, true)), '首帧图与 task_id 同时给 → 拦住');
assert.ok(/自动模式必须复用/.test(model.mjVideoInputError(mjSpec, { ...dft, animateMode: 'auto' }, true)), 'auto 缺 task_id / index → 拦住');
assert.ok(/第 0–3 张/.test(model.mjVideoInputError(mjSpec, { ...dft, mjTaskId: 'up_mj_1', mjIndex: 9 }, false)), '候选下标超 0–3 → 拦住');

// 批次 × 计费提示（只解释为什么 ×N，不自己估价）
const batchNote2 = model.mjVideoBatchNote(mjSpec, 2, '720p');
assert.ok(/批次 2/.test(batchNote2) && /费用 ×2/.test(batchNote2) && /midjourney@video-720p/.test(batchNote2), '批次旁注要说清 ×2 与计费 id：' + batchNote2);
assert.ok(/费用 ×4/.test(model.mjVideoBatchNote(mjSpec, 4, '480p')), 'batch=4 提示 ×4');
assert.ok(!/×/.test(model.mjVideoBatchNote(mjSpec, 1, '480p')), 'batch=1 不提倍率');

console.log('[PASS] MJ 图生视频 caps → ui（mj_video / 默认值 / 收敛 / 前端拦截 / 批次×计费提示）');

// ---- 4. 请求体：只带契约字段（fetch 桩截 POST /api/canvas-video?async=1）----
const backendMod = load('novai-canvas-ui/src/novaiBackend.ts');

function stubFetch(handler) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const key = (init.method || 'GET') + ' ' + String(url);
        calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
        return handler(key, init);
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}
const okJson = (data) => ({ ok: true, status: 200, json: async () => data });
const MJ_CANVAS_TASK = 'GET /api/tasks/canvas_video_mj1';

function videoInputs(roles) {
    return roles.map((role, index) => ({ nodeId: 'img' + index, title: '图' + index, kind: 'image', order: index + 1, role, url: '/assets/' + index + '.png' }));
}

async function requestBody(params, inputs, specOverride) {
    const stub = stubFetch((key) => {
        if (key === 'POST /api/canvas-video?async=1') return okJson({ task_id: 'canvas_video_mj1' });
        if (key === MJ_CANVAS_TASK) return okJson({ status: 'succeeded', result: { videos: [{ url: '/output/mj.mp4' }] } });
        throw new Error('没有 mock 这个请求：' + key);
    });
    try {
        const backend = backendMod.createNovaiBackend();
        await backend.generate({
            canvasId: 'c1', nodeId: 'n1', kind: 'video', model: specOverride || mjSpec,
            prompt: '猫在窗台', resolvedPrompt: '猫在窗台', params: { ...model.defaultParams('video', specOverride || mjSpec), ...params }, inputs,
        }, () => {}, new AbortController().signal);
        const create = stub.calls.find((call) => call.key === 'POST /api/canvas-video?async=1');
        assert.ok(create && create.body, '要发出视频建任务请求');
        return create.body;
    } finally {
        stub.restore();
    }
}

async function requestError(params, inputs, specOverride) {
    try { await requestBody(params, inputs, specOverride); }
    catch (error) { return error; }
    throw new Error('预期请求失败但没有抛错');
}

(async () => {
    // 4a. 直接传首帧：只带契约字段，480p 基础档
    const first = await requestBody({}, videoInputs(['first_frame']));
    assert.deepStrictEqual(Object.keys(first).sort(), ['animate_mode', 'canvas_id', 'images', 'mj_batch', 'mode', 'model', 'motion', 'node_id', 'prompt', 'provider_id', 'video_type'].sort(), '首帧请求体只带契约字段');
    assert.strictEqual(first.model, 'midjourney-video');
    assert.strictEqual(first.mode, 'image_to_video', '生成方式固定 image_to_video');
    assert.strictEqual(first.motion, 'high', '默认运动幅度 high');
    assert.strictEqual(first.mj_batch, 1, '默认批次 1');
    assert.strictEqual(first.video_type, 'vid_1.1_i2v_480', '480p 基础档');
    assert.strictEqual(first.animate_mode, 'manual', '没有 task_id 时手动');
    assert.strictEqual(first.images.length, 1, '首帧图只发 1 张');
    assert.strictEqual(first.images[0].role, 'first_frame');
    for (const field of ['duration', 'aspect_ratio', 'resolution', 'seed', 'generate_audio', 'videos', 'audios', 'draft']) {
        assert.strictEqual(field in first, false, 'MJ 请求体不带通用视频字段：' + field);
    }

    // 4b. 尾帧：end_image + 档位升级成首尾帧，档位高的时候换成 start_end_720
    const withEnd = await requestBody({ res: '720p' }, videoInputs(['first_frame', 'last_frame']));
    assert.strictEqual(withEnd.end_image.url, '/assets/1.png', '尾帧走 end_image');
    assert.strictEqual(withEnd.video_type, 'vid_1.1_i2v_start_end_720', '有尾帧 + 720p → start_end_720');
    assert.strictEqual(withEnd.images.length, 1, '尾帧不进 images');
    assert.strictEqual('resolution' in withEnd, false, '有 video_type 时不再发 resolution');

    // 4c. 批次 × 计费：mj_batch 原样透传（N 倍计费由后端按 batch_size × 单价算）
    const batch2 = await requestBody({ mjBatch: 2 }, videoInputs(['first_frame']));
    assert.strictEqual(batch2.mj_batch, 2, '批次 2 → mj_batch: 2');
    assert.strictEqual(batch2.video_type, 'vid_1.1_i2v_480', '批次不影响档位');

    // 4d. 复用 MJ 任务：task_id + index，不发 images；auto 要显式 index
    const reuse = await requestBody({ mjTaskId: 'up_mj_9', mjIndex: 2, animateMode: 'auto' }, []);
    assert.strictEqual(reuse.mj_task_id, 'up_mj_9', '复用模式发上游 task_id');
    assert.strictEqual(reuse.mj_index, 2, '显式候选下标');
    assert.strictEqual(reuse.animate_mode, 'auto', 'auto 允许');
    assert.strictEqual('images' in reuse, false, '复用模式不发首帧图');

    // 4e. 1080p 被拦：clampParams 抢先收到 720p，请求里没有 1080p
    const highRes = await requestBody({ res: '1080p' }, videoInputs(['first_frame']));
    assert.strictEqual(highRes.video_type, 'vid_1.1_i2v_720', '残留 1080p 不会发出去：按 720p 发出');
    assert.ok(!/1080p|4k/i.test(JSON.stringify(highRes)), '请求体里不出现 1080p / 4k');

    // 4f. 前端拦截：没有首帧、auto 缺 task_id —— 都在发请求前就抛
    const noFrameError = await requestError({}, []);
    assert.ok(/需要一张首帧图/.test(noFrameError.message), '没有首帧图 → 前端拦住：' + noFrameError.message);
    const autoError = await requestError({ animateMode: 'auto' }, videoInputs(['first_frame']));
    assert.ok(/自动模式必须复用/.test(autoError.message), 'auto 缺 task_id → 前端拦住：' + autoError.message);

    // 4g. 其它视频模型：残留的 MJ 字段一个都不发
    const otherSpec = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', SEEDANCE_ITEM), specSource: 'spec' });
    const other = await requestBody({ motion: 'low', mjBatch: 4, mjTaskId: 'up_mj_9', mjIndex: 2, animateMode: 'auto' }, videoInputs(['first_frame']), otherSpec);
    for (const field of ['motion', 'mj_batch', 'video_type', 'mj_task_id', 'mj_index', 'animate_mode', 'end_image']) {
        assert.strictEqual(field in other, false, '别的视频模型不带 MJ 字段：' + field);
    }
    assert.ok('duration' in other && 'aspect_ratio' in other, '别的模型仍走原请求体（duration / aspect_ratio）');

    // 4h. 模型出现：/api/config 的 video_models 里登记了 midjourney-video → 视频节点能选到它
    const listStub = stubFetch((key) => {
        if (key === 'GET /api/config') return okJson({ api_providers: [{ id: 'apimart', name: 'APIMART', protocol: 'apimart', enabled: true, has_key: true, chat_models: [], image_models: [], video_models: ['midjourney-video', 'seedance-2.5'] }] });
        if (key.startsWith('GET /api/model-caps')) return okJson({ items: [MJ_VIDEO_ITEM, SEEDANCE_ITEM] });
        throw new Error('没有 mock 这个请求：' + key);
    });
    try {
        const backend = backendMod.createNovaiBackend();
        const list = await backend.listModels();
        const hit = list.find((item) => item.kind === 'video' && item.name === 'midjourney-video');
        assert.ok(hit, '视频节点下拉里要有 midjourney-video');
        assert.strictEqual(hit.specSource, 'spec', '它带权威 caps（不是「未验证」）');
        assert.ok(hit.mjVideo && hit.mjVideo.videoTypes.length === 4, '下拉里就带 mj_video 能力位');
        assert.deepStrictEqual(hit.res, ['480p', '720p'], '下拉里档位只有 480p / 720p');
    } finally {
        listStub.restore();
    }

    console.log('[PASS] MJ 图生视频请求体：契约字段 / 尾帧升级 / 批次透传 / 复用任务 / 1080p 与 auto 拦截 / 其它模型不带 / 下拉里能选到');

    // ---- 5. 面板：MJ 行只在 caps.mj_video 的模型上渲染 ----
    assert.ok(panel.includes('{m.mjVideo ? <MjVideoRows node={node} m={m} p={p} disabled={disabled} /> : null}'), 'MJ 参数行只在 mjVideo 的模型上渲染');
    assert.ok(panel.includes('function MjVideoRows('), 'MJ 行是独立组件（沿用现有参数浮层）');
    assert.ok(panel.includes('data-mj-video-type={videoType || tier}'), '视频规格 → video_type 摘要（档位 / 首尾帧 / 具体值）');
    assert.ok(panel.includes('data-mj-motion={motions.join(",")}') && panel.includes('data-mj-motion-opt={value}'), '运动幅度按 caps 的 motions 出选项（不硬编码）');
    assert.ok(panel.includes('data-mj-batch={batches.join(",")}') && panel.includes('data-mj-batch-opt={value}'), '批次按 caps 的 batch 出选项');
    assert.ok(panel.includes('data-mj-batch-note>{mjVideoBatchNote(m, batch, tier)}'), '批次旁注来自 mjVideoBatchNote（×N 计费）');
    assert.ok(panel.includes('data-mj-animate={taskId ? "auto" : "manual"}'), '动效模式：没有 task_id 时固定手动');
    assert.ok(panel.includes('disabled={disabled || !taskId}'), 'auto 没有 task_id 时不可选');
    assert.ok(panel.includes('data-mj-reuse-note') && panel.includes('复用 MJ 出图任务图（task_id + 第 0–3 张）待后续'), '复用 MJ 任务图入口标「待后续」（不新造大 UI）');
    assert.ok(panel.includes('data-mj-video-note'), '首帧必填 / 尾帧自动切首尾帧 / 5 秒 / 复用待后续的说明行');
    assert.ok(panel.includes('mjVideo?.supportsEndFrame === true'), '尾帧入口只在 caps.supports_end_frame 时出现');
    assert.ok(panel.includes('m?.mjVideo && !imgIns.length'), '没有首帧图时给提示（首帧图必填）');
    assert.ok(panel.includes('{mjVideo ? <div className="gp-note" data-mj-video-note'), 'MJ 说明行只在 MJ 视频模型上出现');
    // 时长：单档退化成只读说明，不出现滑杆（DurationSlider 既有行为）
    assert.strictEqual(model.durationSliderLevels(mjSpec.durs).levels.length, 1, '时长只有 5 一档 → 面板只读说明，不给滑杆');

    const noteStyle = (css.match(/\.cn-root \.vset-note\{[^}]*\}/) || [''])[0];
    assert.ok(noteStyle, '有 .vset-note 样式');
    assert.ok(!/(^|;)\s*border\s*:/.test(noteStyle) && !/inset/.test(noteStyle), '.vset-note 不画边框 / 发丝线：' + noteStyle);

    console.log('[PASS] MJ 图生视频面板：专属行只在 mj_video 模型渲染（规格 / 运动幅度 / 批次×计费 / 动效模式 / 复用待后续 / 尾帧入口 / 首帧必填）');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
