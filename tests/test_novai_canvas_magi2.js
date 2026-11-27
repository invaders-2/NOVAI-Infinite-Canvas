#!/usr/bin/env node
/* 2026-11-26 增量：新视频模型 magi-2（APIMart）接进编辑器。
   覆盖：
   1. caps → ui：时长 4–30 连续整秒、比例 6 个 + auto、分辨率只有 1080p、modes 不含编辑/延长、
      参考上限 9/3/3、声音默认开、内容审核布尔位、画幅跟随首帧；
   2. 模型出现：provider 的 video_models 里登记了 magi-2 → 节点模型下拉拿得到（specSource=spec，带参数）；
   3. 面板行为：时长区间边界（4 / 30 / 越界收口）、单档分辨率不出下拉、图生模式丢 21:9、
      生成方式只列 caps 支持的、参考上限提示、nsfw 开关只在有该能力位时渲染；
   4. 请求链路：nsfw_check 只在该能力模型 + 用户开启时出现，其它情况一个字段都不带。 */
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

const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');

/** 后端 main.py 给 magi-2 写的能力条目在 /api/model-caps 里的形状（与 REPORT-DELTA-20261126 §3 / I1 一致） */
const MAGI_CAPS = {
    provider: 'apimart', model: 'magi-2', kind: 'video',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'auto'],
    resolutions: ['1080p'],
    durations: Array.from({ length: 27 }, (_, i) => i + 4),
    modes: ['text_to_video', 'image_to_video', 'start_end_to_video', 'reference_to_video'],
    ref_max: 10, video_ref_max: 5, audio_ref_max: 5,
    audio: true, audio_default_on: true,
    nsfw: true, ratio_follows_first_frame: true,
};
const magiUi = caps.modelCapsUi('video', MAGI_CAPS);
const magiSpec = model.specFor({ configId: 'apimart::magi-2', label: 'magi-2', vendor: 'APIMART', kind: 'video', ui: magiUi, specSource: 'spec' });

// ---- 1. caps → ui / spec ----
assert.deepStrictEqual(magiUi.ratios, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '自适应'], '6 个比例 + auto → 自适应');
assert.deepStrictEqual(magiUi.res, ['1080p'], '分辨率只有 1080p');
assert.deepStrictEqual(magiUi.durs, Array.from({ length: 27 }, (_, i) => i + 4), '时长 4–30 逐秒都在（不是 5/10 两档）');
assert.deepStrictEqual(magiUi.modes, ['文生视频', '首帧', '首尾帧', '参考生视频'], '四种方式，没有视频编辑 / 视频延长');
assert.ok(!magiUi.modes.includes('视频编辑') && !magiUi.modes.includes('视频延长') && !magiUi.modes.includes('参考视频生视频'), 'edit / extend / 参考视频 一律不落进 ui');
assert.strictEqual(magiUi.maxRefs, 10, '参考图上限 10（ref_max，文档 L40786）');
assert.strictEqual(magiUi.videoRefMax, 5, '参考视频上限 5（video_ref_max 不再被丢掉）');
assert.strictEqual(magiUi.audioRefMax, 5, '参考音频上限 5（audio_ref_max 不再被丢掉）');
assert.strictEqual(magiUi.audio, true, '能出声音且能开关');
assert.strictEqual(magiUi.audioDefaultOn, true, '声音默认开');
assert.strictEqual(magiUi.nsfw, true, '内容审核布尔位 → 面板给开关');
assert.strictEqual(magiUi.ratioFollowsFirstFrame, true, '画幅跟随首帧');

assert.strictEqual(magiSpec.specSource, 'spec', '有 caps → 已验证规格');
assert.deepStrictEqual(magiSpec.modes, magiUi.modes);
assert.strictEqual(magiSpec.nsfw, true);
assert.strictEqual(magiSpec.audioDefaultOn, true);
assert.strictEqual(magiSpec.videoRefMax, 5);
assert.strictEqual(magiSpec.audioRefMax, 5);
assert.strictEqual(magiSpec.ratioFollowsFirstFrame, true);

// 缺这些字段的模型：不得凭空长出来（不按模型名猜）
const plainSpec = model.specFor({ configId: 'apimart::kling-v4', label: 'kling-v4', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', { provider: 'apimart', model: 'kling-v4', kind: 'video', ratios: ['16:9'], resolutions: ['720p', '1080p'], durations: [5] }), specSource: 'spec' });
assert.ok(!plainSpec.nsfw, '没有布尔位 = 没有 nsfw 入口');
assert.ok(!plainSpec.audioDefaultOn, '没有 audio_default_on = 声音默认关');
assert.ok(!plainSpec.ratioFollowsFirstFrame, '没有 ratio_follows_first_frame = 不丢任何比例');
assert.strictEqual(plainSpec.videoRefMax, undefined, '没有 video_ref_max 不编上限');

// ---- 2. 模型出现：v8 更新包把 magi-2 写进 provider 的 video_models → 下拉能看到 ----
const os = require('os');
function loadBackendModule() {
    const entry = path.join(os.tmpdir(), 'novai-magi2-body-entry-' + process.pid + '.ts');
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

async function listVideoModels() {
    const backendMod = loadBackendModule();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const key = String(url);
        if (key === '/api/config') {
            return {
                ok: true, status: 200, json: async () => ({
                    api_providers: [{ id: 'apimart', name: 'APIMART', protocol: 'apimart', enabled: true, has_key: true, video_models: ['magi-2'] }],
                }),
            };
        }
        if (key === '/api/model-caps') return { ok: true, status: 200, json: async () => ({ items: [MAGI_CAPS] }) };
        throw new Error('没有 mock 这个请求：' + key);
    };
    try {
        return await backendMod.createNovaiBackend().listModels();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ---- 3. 时长：默认 5 秒、滑杆逐秒、越界收口 ----
const levels = model.durationSliderLevels(magiSpec.durs);
assert.strictEqual(levels.levels.length, 27, '滑杆 27 个整秒档位（4–30 都能精确选到）');
assert.strictEqual(levels.levels[0], '4', '最左 4s');
assert.strictEqual(levels.levels[levels.levels.length - 1], '30', '最右 30s');
assert.ok(levels.levels.includes('17') && levels.labels['17'] === '17s', '中间每一秒都是独立档位');
assert.ok(!levels.levels.includes('-1'), 'magi-2 没有「自动」档位');
assert.strictEqual(model.defaultParams('video', magiSpec).dur, 5, '新建节点默认 5 秒（上游默认值）');
assert.strictEqual(model.clampVideoDuration(magiSpec, 4), 4, '下界 4 保留');
assert.strictEqual(model.clampVideoDuration(magiSpec, 30), 30, '上界 30 保留');
assert.strictEqual(model.clampVideoDuration(magiSpec, 3), 4, '3 秒收到 4');
assert.strictEqual(model.clampVideoDuration(magiSpec, 31), 30, '31 秒收到 30');
assert.strictEqual(model.clampVideoDuration(magiSpec, 99), 30, '脏值 99 收到 30');
assert.strictEqual(model.clampVideoDuration(magiSpec, -1), 4, '无关的 -1 收到 4（该模型没有自动档）');
assert.strictEqual(model.clampVideoDuration(magiSpec, 2.5), 4, '小数按最近整秒收口');

// ---- 4. 比例：图生视频方式丢 21:9（只看 caps 的 ratio_follows_first_frame）----
assert.deepStrictEqual(model.videoRatioOptions(magiSpec, '文生视频'), ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '自适应'], '文生视频 6 个 + auto 全给');
assert.deepStrictEqual(model.videoRatioOptions(magiSpec, '参考生视频'), ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '自适应'], '参考生视频也全给');
assert.deepStrictEqual(model.videoRatioOptions(magiSpec, '首帧'), ['16:9', '9:16', '1:1', '4:3', '3:4', '自适应'], '图生视频（首帧）不出现 21:9');
assert.deepStrictEqual(model.videoRatioOptions(magiSpec, '首尾帧'), ['16:9', '9:16', '1:1', '4:3', '3:4', '自适应'], '首尾帧同样不出现 21:9');
assert.strictEqual(model.videoRatioFollowsFirstFrame(magiSpec, '首帧'), true, '首帧方式画幅跟随首帧（面板提示一句）');
assert.strictEqual(model.videoRatioFollowsFirstFrame(magiSpec, '文生视频'), false, '文生视频不跟首帧');
const noFollowSpec = model.specFor({ configId: 'apimart::kling-v4', label: 'kling-v4', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', { provider: 'apimart', model: 'kling-v4', kind: 'video', ratios: ['16:9', '21:9'], resolutions: ['720p'], durations: [5] }), specSource: 'spec' });
assert.deepStrictEqual(model.videoRatioOptions(noFollowSpec, '首帧'), ['16:9', '21:9'], 'caps 没声明跟随时不擅自丢比例（不按模型名写死）');

// ---- 5. 分辨率：只有一档时不出下拉 ----
assert.deepStrictEqual(model.videoResChoices(magiSpec), [], '1080p 单档 → 不给只有一项的下拉（底栏已显示 1080p）');
assert.deepStrictEqual(model.videoResChoices(plainSpec), ['720p', '1080p'], '多档模型照旧给下拉');
assert.strictEqual(model.defaultParams('video', magiSpec).res, '1080p', '默认就是唯一那档 1080p');

// ---- 6. 参考上限提示 + 声音默认开 ----
const hint = model.videoRefHint(magiSpec);
assert.ok(hint.includes('图 ≤10') && hint.includes('视频 ≤5') && hint.includes('音频 ≤5'), '参考上限按 caps 显示：' + hint);
assert.ok(hint.includes('每段 2–30 秒') && hint.includes('合计建议 ≤30 秒'), '音频给一句 2–30 秒 / 合计 ≤30 秒的提示');
assert.strictEqual(model.videoRefHint(plainSpec), '', '没有 caps 上限的模型不渲染这行');
const magiParams = model.defaultParams('video', magiSpec);
assert.strictEqual(magiParams.sound, true, '声音默认开（caps.audio_default_on）');
assert.strictEqual(magiParams.nsfw, false, '内容审核默认关');
const fromOther = model.clampParams('video', { model: 'apimart::other', mode: '文生视频', ratio: '16:9', res: '720p', dur: 5, sound: false, times: 1 }, magiSpec);
assert.strictEqual(fromOther.sound, true, '从别的模型切到 magi-2：按新模型的默认打开声音');
assert.strictEqual(model.clampParams('video', { ...magiParams, sound: false }, magiSpec).sound, false, '已经是 magi-2：用户关掉的声音不被掰回去');

// ---- 7. nsfw：只有能力模型才有值，换模型清掉 ----
assert.strictEqual(model.clampParams('video', { ...magiParams, nsfw: true }, magiSpec).nsfw, true, '有能力的模型保留用户打开的内容审核');
assert.strictEqual('nsfw' in model.clampParams('video', { ...magiParams, nsfw: true }, plainSpec), false, '换到没有该能力位的模型：nsfw 清掉（请求不带）');
assert.strictEqual('nsfw' in model.defaultParams('video', plainSpec), false, '没有该能力位的模型默认参数里没有 nsfw');

// ---- 8. 请求链路：nsfw_check 只在该能力模型 + 开启时下发 ----
/** 直接调 backend.generate 截 /api/canvas-video 的请求体（fetch 桩，不真外呼） */
async function videoRequest(backendMod, spec, patch) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const key = (init.method || 'GET') + ' ' + String(url);
        calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
        if (key === 'POST /api/canvas-video?async=1') return { ok: true, status: 200, json: async () => ({ task_id: 'canvas_video_magi' }) };
        if (key === 'GET /api/tasks/canvas_video_magi') return { ok: true, status: 200, json: async () => ({ status: 'succeeded', result: { videos: [{ url: '/output/magi.mp4' }] } }) };
        throw new Error('没有 mock 这个请求：' + key);
    };
    try {
        const backend = backendMod.createNovaiBackend();
        await backend.generate({
            canvasId: 'c1', nodeId: 'n1', kind: 'video', model: spec,
            prompt: '海边日落', resolvedPrompt: '海边日落',
            params: { ...model.defaultParams('video', spec), ...patch }, inputs: [],
        }, () => {}, new AbortController().signal);
        const create = calls.find((call) => call.key === 'POST /api/canvas-video?async=1');
        assert.ok(create && create.body, '要发出视频建任务请求');
        return create.body;
    } finally {
        globalThis.fetch = originalFetch;
    }
}

(async () => {
    const backendMod = loadBackendModule();
    const models = await listVideoModels();
    const listed = models.find((entry) => entry.id === 'apimart::magi-2');
    assert.ok(listed, 'video_models 里登记了 magi-2 → 节点模型下拉能看到（没有被白名单/过滤吃掉）');
    assert.strictEqual(listed.kind, 'video');
    assert.strictEqual(listed.specSource, 'spec', '下拉里拿到的是 caps 的权威参数');
    assert.deepStrictEqual(listed.modes, ['文生视频', '首帧', '首尾帧', '参考生视频'], '下拉里也没有视频编辑 / 延长');
    assert.strictEqual(listed.durs.length, 27, '下拉里带 4–30 的时长档');
    assert.strictEqual(listed.nsfw, true, '下拉里也带内容审核能力位');

    const base = await videoRequest(backendMod, magiSpec, {});
    assert.strictEqual(base.duration, 5, '请求时长默认 5 秒');
    assert.strictEqual(base.aspect_ratio, '16:9', '请求比例走现有映射');
    assert.strictEqual(base.resolution, '1080p', '请求分辨率只有 1080p');
    assert.strictEqual(base.generate_audio, true, '声音默认开 → 请求带 generate_audio:true');
    assert.strictEqual('nsfw_check' in base, false, '默认关：请求体不带 nsfw_check');

    const on = await videoRequest(backendMod, magiSpec, { nsfw: true });
    assert.strictEqual(on.nsfw_check, true, '用户打开内容审核 → 请求带 nsfw_check:true');

    const off = await videoRequest(backendMod, magiSpec, { nsfw: false });
    assert.strictEqual('nsfw_check' in off, false, '用户关掉 → 不带 nsfw_check');

    const other = await videoRequest(backendMod, plainSpec, { nsfw: true });
    assert.strictEqual('nsfw_check' in other, false, '其它模型即使参数里有残留值也不发 nsfw_check');

    const durationEdge = await videoRequest(backendMod, magiSpec, { dur: 30 });
    assert.strictEqual(durationEdge.duration, 30, '30 秒原样下发');

    // ---- 9. 面板接线（源码断言：改样式/组件时防回归）----
    const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
    assert.ok(panel.includes('data-nsfw') && panel.includes('role="switch"'), 'nsfw 用画布统一的胶囊开关（.sw + role=switch）');
    assert.ok(panel.includes('会先做内容审核，稍慢/可能有审核成本'), '打开时给「审核会更慢/可能有成本」的提示');
    assert.ok(panel.includes('默认关：不请求审核'), '关闭时说明不产生审核成本');
    assert.ok(panel.includes('{m.nsfw ? <div className="draft-mode"'), 'nsfw 开关只在 caps 带该布尔位时渲染');
    assert.ok(panel.includes('videoResChoices(m)'), '分辨率下拉走单档收敛（只有一项时不渲染）');
    assert.ok(panel.includes('{resChoices.length ? <>'), '只有一项分辨率的模型不出现分辨率区块');
    assert.ok(panel.includes('videoRatioOptions(m, p.mode)'), '比例列表按 caps 的画幅跟随首帧过滤（图生视频丢 21:9）');
    assert.ok(panel.includes('videoRefHint(m)') && panel.includes('data-vset-refs'), '参数面板显示 caps 的参考上限提示');
    assert.ok(panel.includes('(Object.keys(VMODES) as Array<keyof typeof VMODES>).filter((x) => (mm.modes || []).includes(x))'), '生成方式弹层只列 caps 支持的方式');
    assert.ok(!panel.includes('mm.name + " 不支持"'), '生成方式弹层不再列出「XX 不支持」的灰项（视频编辑 / 延长不出现）');
    assert.ok(!panel.includes('durationTiers('), '面板不自己算时长档位（统一走 DurationSlider + caps.durs）');

    const backendSrc = read('novai-canvas-ui/src/novaiBackend.ts');
    assert.ok(backendSrc.includes('req.model.nsfw === true && params.nsfw === true'), 'nsfw_check 双重条件：能力位 + 用户开启');
    assert.ok(backendSrc.includes('nsfw_check: true'), '请求体字段名按后端契约 nsfw_check');

    console.log('[PASS] magi-2：caps→ui（4–30 逐秒 / 6+auto / 1080p 单档 / 无编辑延长 / 9·3·3 / 声音默认开 / nsfw 布尔位）+ 下拉可见 + 面板接线 + nsfw_check 请求条件');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
