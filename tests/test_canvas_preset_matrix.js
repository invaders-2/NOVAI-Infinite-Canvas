#!/usr/bin/env node
// 节点编辑器「按模型自动切预设」矩阵 + 两页一致 + UI 接线 + 老数据守卫。
//
// 覆盖：
//   1) 两套画布（canvas.js / smart-canvas.js）的能力表逐项一致：MODEL_CAPABILITIES
//      （resLevels / aspects / videoResolutions / durationMin / durationMax / ratios / preset）、
//      MODEL_TIER_PIXELS、GEMINI_RATIO_KEYS / SEEDREAM_RATIO_KEYS；
//   2) 图片侧：逐模型比例集合 = web/src/pages/online/sizeData.js 预设键；档位集合 = 官方档位；
//      0.5K/1.5K/3K 的像素逐格等于 web 预设（Agnes 等于 main.py AGNES_OUTPUT_PIXELS）；
//   3) 视频侧：逐模型宽高比 / 分辨率 / 时长官方区间（与 main.py 归一化函数同口径）；
//   4) UI 接线：两页都真的按模型过滤选项、时长上下限进 UI；历史选中值保留可见（不静默改写）；
//   5) 老数据守卫：9:21 / keep_ratio / 已存自定义尺寸在纯函数层不被改。
//
// 官方出处：
//   视频 /tmp/novai-video-docs（Ark create-video-generation-task-api、APIMart Seedance 2.0 / Kling v3 /
//        VEO3.1、Agnes Video 2.5）；main.py volcengine_video_duration / volcengine_video_resolution /
//        apimart_video_duration / apimart_veo31_duration / agnes_video_seconds。
//   图片 web/src/pages/online/sizeData.js + main.py AGNES_OUTPUT_PIXELS + /tmp/novai-official-docs。
//
// 差分证明（接改前备份应失败）：
//   NOVAI_PRESET_TEST_CLASSIC_SRC=/tmp/novai-preset-evidence/backup/canvas.js \
//   NOVAI_PRESET_TEST_SMART_SRC=/tmp/novai-preset-evidence/backup/smart-canvas.js \
//     node tests/test_canvas_preset_matrix.js
// 运行：node tests/test_canvas_preset_matrix.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CLASSIC_SRC = process.env.NOVAI_PRESET_TEST_CLASSIC_SRC || path.join(ROOT, 'static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_PRESET_TEST_SMART_SRC || path.join(ROOT, 'static/js/smart-canvas.js');
const WEB_SRC = path.join(ROOT, 'web/src/pages/online/sizeData.js');
const MAIN_SRC = path.join(ROOT, 'main.py');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');

// ── 官方口径（本文件是矩阵测试的对照真值）─────────────────────────────────────
const GEMINI_14 = ['square', 'portrait14', 'portrait18', 'portrait', 'landscape', 'portrait43',
    'landscape41', 'landscape43', 'portrait45', 'landscape54', 'landscape81', 'story', 'wide', 'ultrawide'];
const SEEDREAM_8 = ['square', 'landscape43', 'portrait43', 'wide', 'story', 'landscape', 'portrait', 'ultrawide'];
const OFFICIAL_IMAGE = {
    'nano-banana-2': { resLevels: ['0.5k', '1k', '2k', '4k'], ratios: GEMINI_14, preset: 'gemini-3.1-flash-image' },
    'nano-banana-pro': { resLevels: ['1k', '2k', '4k'], ratios: GEMINI_14 },
    'nano-banana': { resLevels: ['1k', '2k', '4k'], ratios: GEMINI_14 },
    'seedream-5.0-pro': { resLevels: ['1k', '1.5k', '2k'], ratios: SEEDREAM_8, preset: 'seedream-5.0-pro' },
    'seedream-5.0-flash': { resLevels: ['1k', '1.5k', '2k'], ratios: SEEDREAM_8, preset: 'seedream-5.0-pro' },
    'seedream-5.0-lite': { resLevels: ['2k', '3k', '4k'], ratios: SEEDREAM_8, preset: 'seedream-5.0-lite' },
    'seedream-4.5': { resLevels: ['2k', '4k'], ratios: SEEDREAM_8 },
    'seedream-4.0': { resLevels: ['1k', '2k', '4k'], ratios: SEEDREAM_8 },
    'agnes-image-25-flash': { resLevels: ['1k', '2k', '3k', '4k'], ratios: SEEDREAM_8, preset: 'agnes-image' },
    'gpt-image-2': { resLevels: ['1k', '2k', '4k'], ratios: null }
};
const OFFICIAL_VIDEO = {
    'doubao-seedance-2-5-260628': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p'], duration: [4, 30] },
    'doubao-seedance-2-0-fast-260128': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p'], duration: [4, 15] },
    'doubao-seedance-2-0-260128': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p', '4k'], duration: [4, 15] },
    'doubao-seedance-1-0-pro-250528': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p'], duration: [2, 12] },
    'kling-v3': { aspects: ['16:9', '9:16', '1:1'], videoResolutions: ['720p', '1080p', '4k'], duration: [3, 15] },
    'kling-3.0-turbo': { aspects: ['16:9', '9:16', '1:1'], videoResolutions: ['720p', '1080p'], duration: [3, 15] },
    'veo3.1-fast': { aspects: ['16:9', '9:16'], duration: [4, 8] },
    'veo-3.1-fast': { aspects: ['16:9', '9:16'], duration: [4, 8] },
    // Lovart 真实视频模型名（下划线 + v 前缀）
    'generate_video_seedance_v2_5': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p'], duration: [4, 30] },
    'generate_video_seedance_v2_0_fast': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p'], duration: [4, 15] },
    'generate_video_seedance_v2_0': { aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], videoResolutions: ['480p', '720p', '1080p', '4k'], duration: [4, 15] },
    'generate_video_kling_v3': { aspects: ['16:9', '9:16', '1:1'], videoResolutions: ['720p', '1080p', '4k'], duration: [3, 15] },
    'generate_video_veo3_1': { aspects: ['16:9', '9:16'], duration: [4, 8] },
    'agnes-video-v2.0': { aspects: ['16:9', '9:16', '4:3', '1:1', '3:4', '21:9'], duration: [4, 12] },
    'some-unknown-video': { aspects: null, videoResolutions: null, duration: null }
};
// 0.5K/1.5K/3K 的官方像素（web sizeData.js / main.py AGNES_OUTPUT_PIXELS）
const OFFICIAL_TIER_PIXELS = {
    'gemini-3.1-flash-image': {
        level: '0.5k', cells: {
            square: '512x512', portrait14: '256x1024', portrait18: '192x1536', portrait: '424x632',
            landscape: '632x424', portrait43: '448x600', landscape41: '1024x256', landscape43: '600x448',
            portrait45: '464x576', landscape54: '576x464', landscape81: '1536x192', story: '384x688',
            wide: '688x384', ultrawide: '792x168'
        }
    },
    'seedream-5.0-pro': {
        level: '1.5k', cells: {
            square: '1536x1536', landscape43: '1792x1344', portrait43: '1344x1792', wide: '2048x1152',
            story: '1152x2048', landscape: '1872x1248', portrait: '1248x1872', ultrawide: '2352x1008'
        }
    },
    'seedream-5.0-lite': {
        level: '3k', cells: {
            square: '3072x3072', landscape43: '3456x2592', portrait43: '2592x3456', wide: '4096x2304',
            story: '2304x4096', landscape: '3744x2496', portrait: '2496x3744', ultrawide: '4704x2016'
        }
    },
    'agnes-image': {
        level: '3k', cells: {
            square: '3072x3072', portrait43: '2592x3456', landscape43: '3456x2592', wide: '3936x2208',
            story: '2208x3936', portrait: '2496x3744', landscape: '3744x2496', ultrawide: '4704x2016'
        }
    }
};

function blockOf(src, re){
    const m = src.match(re);
    if(!m) throw new Error('缺少源码块 ' + re);
    return m[0];
}
function topLevelFunction(src, name){
    const matched = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    if(!matched) throw new Error('未找到函数 ' + name);
    const start = matched.index + 1;
    const end = src.indexOf('\n}', start + 1);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
function buildSandbox(src, kind){
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext('function tr(key){ return key; }', sandbox);
    vm.runInContext('globalThis.settings = {};', sandbox);
    vm.runInContext('globalThis.NovaSizePolicy = { constrain: size => size };', sandbox);
    vm.runInContext('function resolveImageModel(value){ return value || "gpt-image-2"; }', sandbox);
    const consts = [
        blockOf(src, /const GEMINI_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const SEEDREAM_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/),
        blockOf(src, /const MODEL_TIER_PIXELS = \{[\s\S]*?\n\};/),
        blockOf(src, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(src, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(src, /const RES_LONG_SIDE = \{[^}]*\};/)
    ];
    const names = ['parseSizeValue', 'parseRatioValue', 'modelCapabilityFor', 'imageResLevelsFor',
        'imageRatiosFor', 'imageRatioSupported', 'getVideoAspectRatios', 'videoResolutionsFor',
        'videoDurationRange', 'modelTierPixelFor', 'apiImageSize'];
    const body = consts.concat(names.map(name => topLevelFunction(src, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-preset-sandbox.js' });
    return sandbox;
}
// web sizeData.js 真模块（真值锚点之一）
async function loadWebData(){
    const mod = await import(pathToFileURL(WEB_SRC).href);
    return mod;
}
function webPresetTable(preset){
    const table = {};
    Object.keys(preset || {}).forEach(key => {
        const tiers = {};
        (preset[key] || []).forEach(([value, level]) => { tiers[String(level).toLowerCase()] = value; });
        table[key] = tiers;
    });
    return table;
}
// main.py AGNES_OUTPUT_PIXELS：1:1→square 等
function agnesOfficialPixels(){
    const src = fs.readFileSync(MAIN_SRC, 'utf8');
    const block = (src.match(/AGNES_OUTPUT_PIXELS = \{[\s\S]*?\n\}/) || [])[0];
    if(!block) throw new Error('缺少 AGNES_OUTPUT_PIXELS：' + MAIN_SRC);
    const map = {};
    const rowRe = /"([^"]+)"\s*:\s*\{([^}]*)\}/g;
    let m;
    while((m = rowRe.exec(block))){
        const tiers = {};
        const cellRe = /"(1K|2K|3K|4K)"\s*:\s*\((\d+),\s*(\d+)\)/g;
        let c;
        while((c = cellRe.exec(m[2]))) tiers[c[1].toLowerCase()] = c[2] + 'x' + c[3];
        map[m[1]] = tiers;
    }
    return map;
}

const RATIO_KEY_TO_OFFICIAL = {
    square: '1:1', portrait: '2:3', landscape: '3:2', portrait43: '3:4', landscape43: '4:3',
    story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21', portrait12: '1:2',
    landscape21: '2:1', landscape54: '5:4', portrait45: '4:5', portrait14: '1:4', portrait18: '1:8',
    landscape41: '4:1', landscape81: '8:1', landscape31: '3:1', portrait13: '1:3'
};

async function main(){
    const classicSrc = fs.readFileSync(CLASSIC_SRC, 'utf8');
    const smartSrc = fs.readFileSync(SMART_SRC, 'utf8');
    const classic = buildSandbox(classicSrc, 'classic');
    const smart = buildSandbox(smartSrc, 'smart');
    const web = await loadWebData();
    const agnes = agnesOfficialPixels();
    console.log('[preset-matrix] 经典画布 = ' + (process.env.NOVAI_PRESET_TEST_CLASSIC_SRC || 'static/js/canvas.js'));
    console.log('[preset-matrix] 智能画布 = ' + (process.env.NOVAI_PRESET_TEST_SMART_SRC || 'static/js/smart-canvas.js'));

    // ── 1. 两页能力表逐项一致 ────────────────────────────────────────────────
    const classicCaps = classic.modelCapabilityFor ? vm.runInContext('MODEL_CAPABILITIES', classic) : null;
    const smartCaps = vm.runInContext('MODEL_CAPABILITIES', smart);
    eq(vm.runInContext('GEMINI_RATIO_KEYS', classic), vm.runInContext('GEMINI_RATIO_KEYS', smart), '两页 GEMINI_RATIO_KEYS 一致');
    eq(vm.runInContext('SEEDREAM_RATIO_KEYS', classic), vm.runInContext('SEEDREAM_RATIO_KEYS', smart), '两页 SEEDREAM_RATIO_KEYS 一致');
    eq(vm.runInContext('MODEL_TIER_PIXELS', classic), vm.runInContext('MODEL_TIER_PIXELS', smart), '两页 MODEL_TIER_PIXELS 一致');
    eq(vm.runInContext('JSON.parse(JSON.stringify(MODEL_CAPABILITIES))', classic),
        vm.runInContext('JSON.parse(JSON.stringify(MODEL_CAPABILITIES))', smart), '两页 MODEL_CAPABILITIES 逐项一致');
    const capModels = vm.runInContext('MODEL_CAPABILITIES.map(entry => entry.match)', classic);
    ['seedance-2-5', 'kling-3.0-turbo', 'veo-3.1', 'nano-banana-2', 'seedream-5.0-lite', 'agnes-image'].forEach(key => {
        ok(capModels.indexOf(key) >= 0, '能力表含 ' + key);
    });
    ok(capModels.indexOf('seedance-2-5') < capModels.indexOf('seedance'), 'seedance-2-5 排在族名 seedance 之前');
    ok(capModels.indexOf('kling-3.0-turbo') < capModels.indexOf('kling'), 'kling-3.0-turbo 排在族名 kling 之前');
    // 任何宽高比集合都不含官方没有的 9:21（图片比例键 ultratall 是另一回事）
    classicCaps.forEach(entry => {
        (entry.aspects || []).forEach(value => ok(value !== '9:21', entry.match + ' 视频宽高比不含 9:21'));
    });

    // ── 2. 图片矩阵：比例集合 / 档位集合 / 官方档位像素 ──────────────────────
    Object.keys(OFFICIAL_IMAGE).forEach(model => {
        const expected = OFFICIAL_IMAGE[model];
        eq(classic.imageResLevelsFor(model), expected.resLevels, '经典画布 imageResLevelsFor(' + model + ')');
        eq(smart.imageResLevelsFor(model), expected.resLevels, '智能画布 imageResLevelsFor(' + model + ')');
        eq(classic.imageRatiosFor(model), expected.ratios, '经典画布 imageRatiosFor(' + model + ')');
        eq(smart.imageRatiosFor(model), expected.ratios, '智能画布 imageRatiosFor(' + model + ')');
        if(expected.preset) eq(classic.modelCapabilityFor(model, 'preset'), expected.preset, model + ' preset');
    });

    // 2a. MODEL_TIER_PIXELS 逐格 = web sizeData.js（Agnes = main.py）
    Object.keys(OFFICIAL_TIER_PIXELS).forEach(preset => {
        const spec = OFFICIAL_TIER_PIXELS[preset];
        const table = vm.runInContext('MODEL_TIER_PIXELS[' + JSON.stringify(preset) + ']', smart);
        ok(!!table, 'MODEL_TIER_PIXELS 含 ' + preset);
        Object.keys(spec.cells).forEach(ratioKey => {
            eq(table[ratioKey] && table[ratioKey][spec.level], spec.cells[ratioKey],
                'MODEL_TIER_PIXELS ' + preset + ' ' + ratioKey + '@' + spec.level);
        });
        // 每个官方比例键都要有该档位的像素格，且没有多余档位
        eq(Object.keys(table).sort(), Object.keys(spec.cells).sort(), 'MODEL_TIER_PIXELS ' + preset + ' 比例键齐全');
        Object.keys(table).forEach(ratioKey => eq(Object.keys(table[ratioKey]), [spec.level], preset + ' ' + ratioKey + ' 只带官方档位'));
    });
    // 与 web 预设逐格对账（Gemini / Seedream）
    [['gemini-3.1-flash-image', 'nano-banana-2', '0.5k'],
     ['seedream-5.0-pro', 'seedream-5.0-pro', '1.5k'],
     ['seedream-5.0-lite', 'seedream-5.0-lite', '3k']].forEach(([preset, webKey, level]) => {
        const webTable = webPresetTable(web.MODEL_SIZE_PRESETS[webKey]);
        const table = vm.runInContext('MODEL_TIER_PIXELS[' + JSON.stringify(preset) + ']', smart);
        eq(Object.keys(table).sort(), Object.keys(webTable).sort(), preset + ' 比例键 = web ' + webKey + ' 预设键');
        Object.keys(webTable).forEach(ratioKey => {
            eq(table[ratioKey][level], webTable[ratioKey][level], preset + ' ' + ratioKey + '@' + level + ' = web');
        });
    });
    // Agnes 3K 对 main.py
    Object.keys(OFFICIAL_TIER_PIXELS['agnes-image'].cells).forEach(ratioKey => {
        const ratio = RATIO_KEY_TO_OFFICIAL[ratioKey];
        const official = agnes[ratio] && agnes[ratio]['3k'];
        eq(OFFICIAL_TIER_PIXELS['agnes-image'].cells[ratioKey], official, 'Agnes ' + ratio + '@3K = main.py AGNES_OUTPUT_PIXELS');
    });

    // 2b. apiImageSize 端到端：0.5K/1.5K/3K 走官方像素，1K/2K/4K 仍走 SIZE_MAP
    [['nano-banana-2', 'square', '0.5k', '512x512'],
     ['nano-banana-2', 'wide', '0.5k', '688x384'],
     ['generate_image_nano_banana_2', 'square', '0.5k', '512x512'],
     ['seedream-5.0-pro', 'wide', '1.5k', '2048x1152'],
     ['seedream-5.0-flash', 'wide', '1.5k', '2048x1152'],
     ['generate_image_seedream_v5_pro', 'square', '1.5k', '1536x1536'],
     ['seedream-5.0-lite', 'square', '3k', '3072x3072'],
     ['agnes-image-25-flash', 'wide', '3k', '3936x2208']].forEach(([model, ratio, level, expected]) => {
        eq(classic.apiImageSize(ratio, level, '', '', model), expected, '经典画布 apiImageSize ' + model + ' ' + ratio + '@' + level);
        eq(smart.apiImageSize(ratio, level, '', '', model), expected, '智能画布 apiImageSize ' + model + ' ' + ratio + '@' + level);
    });
    // SIZE_MAP 依然覆盖 1k/2k/4k（不被逐模型表干扰）
    eq(classic.apiImageSize('square', '4k', '', '', 'nano-banana-2'), '2880x2880', '1K/2K/4K 仍走 SIZE_MAP（nano-banana-2 4K）');
    eq(smart.apiImageSize('square', '4k', '', '', 'nano-banana-2'), '2880x2880', '智能画布 4K 仍走 SIZE_MAP');

    // ── 3. 视频矩阵：宽高比 / 分辨率 / 时长官方区间 ────────────────────────────
    Object.keys(OFFICIAL_VIDEO).forEach(model => {
        const expected = OFFICIAL_VIDEO[model];
        eq(classic.getVideoAspectRatios(model), expected.aspects, '经典画布 aspects(' + model + ')');
        eq(smart.getVideoAspectRatios(model), expected.aspects, '智能画布 aspects(' + model + ')');
        eq(classic.videoResolutionsFor(model), expected.videoResolutions || null, '经典画布 videoResolutionsFor(' + model + ')');
        eq(smart.videoResolutionsFor(model), expected.videoResolutions || null, '智能画布 videoResolutionsFor(' + model + ')');
        const range = expected.duration ? {min: expected.duration[0], max: expected.duration[1]} : null;
        eq(classic.videoDurationRange(model), range, '经典画布 videoDurationRange(' + model + ')');
        eq(smart.videoDurationRange(model), range, '智能画布 videoDurationRange(' + model + ')');
    });

    // ── 4. UI 接线：两页都真的按模型过滤 + 时长上下限进 UI ────────────────────
    ok(/imageRatiosFor\(apiModel\)/.test(classicSrc), '经典画布图片比例按模型过滤（imageRatiosFor）');
    ok(/videoResolutionsFor\(node\.model\)/.test(classicSrc), '经典画布视频分辨率按模型过滤（videoResolutionsFor）');
    ok(/videoDurationRange\(node\.model\)[\s\S]{0,120}durationMin|durationMin = durationRange \? durationRange\.min : 1/.test(classicSrc),
        '经典画布视频时长上下限取模型区间');
    ok(/option\.hidden = !supported && !isCurrent/.test(classicSrc), '经典画布：历史选中比例保留可见（不因模型切换被隐藏/改写）');
    ok(/current !== 'keep_ratio' && allowed && !allowed\.includes\(current\)/.test(classicSrc), '经典画布：keep_ratio 不被模型切换改写');
    ok(/durationSelect\.min = String\(min\)/.test(classicSrc) && /durationSelect\.max = String\(max\)/.test(classicSrc),
        '经典画布：时长 input 的 min/max 随模型写进 UI');

    ok(/imageRatiosFor\(settings\.model\)/.test(smartSrc), '智能画布图片比例按模型过滤（imageRatiosFor）');
    ok(/const visibleRatioTiles = ratioTiles\.filter/.test(smartSrc), '智能画布尺寸弹窗只渲染模型支持的比例');
    ok(/return tile\.value === currentRatio;/.test(smartSrc), '智能画布：历史选中比例保留可见（不静默改写）');
    ok(/videoResolutionsFor\(settings\.videoModel\)/.test(smartSrc), '智能画布视频分辨率按模型过滤');
    ok(/videoDurationBounds\(settings\.videoModel\)|function videoDurationBounds\(model\)/.test(smartSrc),
        '智能画布时长上下限取模型区间');
    ok(/min="\$\{durationBounds\.min\}" max="\$\{durationBounds\.max\}"/.test(smartSrc)
        || /durationBounds\.min/.test(smartSrc), '智能画布：时长滑条上下限随模型');
    // 两页都保留 custom / source / keep_ratio 这类画布保留字
    ok(/value === 'custom' \|\| value === 'source'/.test(classicSrc), '经典画布比例过滤放行 custom/source');
    ok(/tile\.value === 'custom' \|\| tile\.value === 'source'/.test(smartSrc), '智能画布比例过滤放行 custom/source');

    // ── 5. 老数据守卫（纯函数层）────────────────────────────────────────────
    // 9:21（ultratall）不是 Gemini / Seedream 官方比例，但历史存档里的选中值必须保留（UI 层可见）
    ok(classic.imageRatioSupported('nano-banana-2', 'ultratall') === false, '9:21 对 nano-banana-2 不是官方比例');
    ok(smart.imageRatioSupported('seedream-5.0-pro', 'ultratall') === false, '9:21 对 seedream-5.0-pro 不是官方比例');
    ok(classic.imageRatioSupported('nano-banana-2', 'square') === true, '官方比例放行');
    ok(classic.imageRatiosFor('unknown-model') === null, '未知模型不限制比例（返回 null）');
    ok(classic.videoDurationRange('veo3-fast') === null, '没有官方区间的模型返回 null（保留原上下限）');
    ok(classic.videoResolutionsFor('veo3-fast') === null, '没有官方分辨率的模型返回 null');
    // 780P 私有档位两页都不出现
    ok(!/780P/i.test(classicSrc), 'canvas.js 不含 780P 私有档位');
    ok(!/780P/i.test(smartSrc), 'smart-canvas.js 不含 780P 私有档位');

    console.log('[preset-matrix] ' + pass + ' 项通过');
    if(fails.length){
        fails.slice(0, 80).forEach(msg => console.error('  ✗ ' + msg));
        if(fails.length > 80) console.error('  … 其余 ' + (fails.length - 80) + ' 项');
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
