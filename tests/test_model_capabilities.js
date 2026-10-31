#!/usr/bin/env node
// 模型能力表矩阵校验（两套画布 × 官方口径）：
//   1) canvas.js 与 smart-canvas.js 的 MODEL_CAPABILITIES 同内容；
//   2) 图片分辨率档位逐项等于官方（Gemini 0.5K、火山 1.5K/3K、Agnes 3K）；
//   3) 视频宽高比逐项等于官方（Ark Seedance 2.0 / Kling / APIMart VEO3.1 / Google Veo），任何表都不含 9:21；
//   4) 档位词表 / RES_LONG_SIDE / RES_PIXEL_LIMIT_FALLBACK 覆盖全部官方档位；
//   5) 视频分辨率下拉 = Auto/480p/720p/1080p/4K（780P 已删）；
//   6) 经典画布 keep_ratio 发请求前解析成具体比例，与智能画布同语义。
//
// 官方出处：
//   视频 /tmp/novai-video-docs（Ark create-video-generation-task-api.md、APIMart VEO3.1、Kling、Gemini Veo）
//   图片 /tmp/novai-ratio-audit + /tmp/novai-official-docs（gemini_image_generation / volcengine_ark_image_api / agnes_image_25_flash）
//
// 差分证明（接改前备份应失败）：
//   NOVAI_CAP_TEST_CLASSIC_SRC=/tmp/novai-canvas-official-evidence/backup/canvas.js \
//   NOVAI_CAP_TEST_SMART_SRC=/tmp/novai-canvas-official-evidence/backup/smart-canvas.js \
//     node tests/test_model_capabilities.js
// 运行：node tests/test_model_capabilities.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLASSIC_SRC = process.env.NOVAI_CAP_TEST_CLASSIC_SRC || path.join(ROOT, 'static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_CAP_TEST_SMART_SRC || path.join(ROOT, 'static/js/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (actual, expected, msg) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    ok(a === b, msg + '（实际 ' + a + '，期望 ' + b + '）');
};

// ── 官方口径（本文件是矩阵测试的对照真值）────────────────────────────────────
const OFFICIAL_IMAGE_RES_LEVELS = {
    midjourney: ['1k'],
    'gpt-image-2.5-ext': ['1k', '2k', '4k'],
    'gpt-image-1': ['1k'],
    'imagen-4.0': ['1k'],
    'qwen-image-2.0': ['1k', '2k'],
    'qwen-image-3.0': ['1k', '2k'],
    'Tongyi-MAI/Z-Image-Turbo': ['1k', '2k', '4k'],
    'z-image-turbo': ['1k', '2k'],
    'mai-image-2.6': ['1k', '2k'],
    'flux-2': ['1k', '2k', '4k'],
    'flux-3-image-klein': ['768sq', '1k', '1.5k', '2k', '4k'],
    'flux-3-image': ['1k', '2k', '4k'],
    'flux-kontext': ['1k'],
    'hy-image-v3.5-preview': ['1k', '2k', '4k'],
    'grok-imagine-2.0-ext': ['quality'],
    'grok-imagine-image-2.0': ['1k', '2k'],
    'grok-imagine-image-quality': ['1k', '2k'],
    'grok-imagine-image': ['1k', '2k'],
    'grok-imagine-1.5': ['1k'],
    'wan2.7-image-pro': ['1k', '2k', '4k'],
    'wan2.7-image': ['1k', '2k'],
    'nano-banana-2': ['0.5k', '1k', '2k', '4k'],
    'nano-banana': ['1k', '2k', '4k'],
    'seedream-5.0-lite': ['2k', '3k', '4k'],
    'seedream-5.0': ['1k', '1.5k', '2k'],
    'seedream-4.5': ['2k', '4k'],
    'seedream-4.0': ['1k', '2k', '4k'],
    'agnes-image': ['1k', '2k', '3k', '4k']
};
const OFFICIAL_VIDEO_ASPECTS = {
    seedance: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    kling: ['16:9', '9:16', '1:1'],
    'veo-3': ['16:9', '9:16'],
    veo: ['16:9', '9:16']
};
const OFFICIAL_TIERS = ['0.5k', '768sq', '1k', 'quality', '1.5k', '2k', '3k', '4k'];
const OFFICIAL_LONG_SIDE = { '0.5k': 768, '768sq': 768, '1k': 1536, quality: 1536, '1.5k': 1920, '2k': 2048, '3k': 3072, '4k': 3840 };
const OFFICIAL_PIXEL_FALLBACK = { '0.5k': 262144, '768sq': 589824, '1k': 1572864, quality: 1572864, '1.5k': 3145728, '2k': 4194304, '3k': 9437184, '4k': 8294400 };

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
// MODEL_CAPABILITIES：{ match: 'x', resLevels: [...] / aspects: [...] }
function extractCapabilities(src){
    const block = blockOf(src, /const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/);
    const entries = {};
    const re = /\{\s*match:\s*'([^']+)'([^}]*)\}/g;
    let m;
    while((m = re.exec(block))){
        const entry = {};
        const levels = /resLevels:\s*\[([^\]]*)\]/.exec(m[2]);
        if(levels) entry.resLevels = levels[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
        const aspects = /aspects:\s*\[([^\]]*)\]/.exec(m[2]);
        if(aspects) entry.aspects = aspects[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
        entries[m[1]] = entry;
    }
    return entries;
}
function buildSandbox(src, kind){
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext('function tr(key){ return key; }', sandbox);
    vm.runInContext('globalThis.settings = {};', sandbox);
    const consts = [
        blockOf(src, /const GEMINI_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const SEEDREAM_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/),
        blockOf(src, /const MODEL_TIER_PIXELS = \{[\s\S]*?\n\};/),
        blockOf(src, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(src, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(src, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/)
    ];
    const names = ['modelCapabilityFor', 'imageResLevelsFor', 'getVideoAspectRatios', 'videoResolutionsFor', 'videoDurationRange'];
    if(kind === 'classic'){
        consts.push(blockOf(src, /const VIDEO_ASPECT_SUPPORTED = \[[^\]]*\];/));
        names.push('videoAspectNumber', 'nearestVideoAspectForCanvasSize', 'resolveVideoNodeAspectRatio');
        vm.runInContext('globalThis.getImageDimensions = async () => ({ width: 4000, height: 3000 });', sandbox);
    }else{
        vm.runInContext('globalThis.settings = {};', sandbox);
        names.push('videoAspectOptions', 'videoResolutionOptions');
    }
    const body = consts.concat(names.map(name => topLevelFunction(src, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-cap-sandbox.js' });
    return sandbox;
}

async function main(){
    const classicSrc = fs.readFileSync(CLASSIC_SRC, 'utf8');
    const smartSrc = fs.readFileSync(SMART_SRC, 'utf8');
    console.log('[model-cap] 经典画布源码 = ' + (process.env.NOVAI_CAP_TEST_CLASSIC_SRC || 'static/js/canvas.js'));
    console.log('[model-cap] 智能画布源码 = ' + (process.env.NOVAI_CAP_TEST_SMART_SRC || 'static/js/smart-canvas.js'));

    const classicCaps = extractCapabilities(classicSrc);
    const smartCaps = extractCapabilities(smartSrc);

    // ── 1. 两页同表：每一个 match 的 resLevels / aspects 都一致 ──────────────
    eq(Object.keys(classicCaps).sort(), Object.keys(smartCaps).sort(), '两页 MODEL_CAPABILITIES 的 key 集合一致');
    Object.keys(classicCaps).forEach(key => {
        if(!smartCaps[key]) return;
        eq(smartCaps[key].resLevels || null, classicCaps[key].resLevels || null, '两页 ' + key + '.resLevels 一致');
        eq(smartCaps[key].aspects || null, classicCaps[key].aspects || null, '两页 ' + key + '.aspects 一致');
    });

    // ── 2. 图片档位逐项等于官方 ─────────────────────────────────────────────
    Object.keys(OFFICIAL_IMAGE_RES_LEVELS).forEach(key => {
        eq((classicCaps[key] || {}).resLevels, OFFICIAL_IMAGE_RES_LEVELS[key], '经典画布图片档位 ' + key);
        eq((smartCaps[key] || {}).resLevels, OFFICIAL_IMAGE_RES_LEVELS[key], '智能画布图片档位 ' + key);
    });

    // ── 3. 视频宽高比逐项等于官方；任何表都不含 9:21 ──────────────────────────
    Object.keys(OFFICIAL_VIDEO_ASPECTS).forEach(key => {
        eq((classicCaps[key] || {}).aspects, OFFICIAL_VIDEO_ASPECTS[key], '经典画布视频宽高比 ' + key);
    });
    const allAspectLists = [];
    Object.keys(classicCaps).forEach(key => { if(classicCaps[key].aspects) allAspectLists.push([key, classicCaps[key].aspects]); });
    Object.keys(smartCaps).forEach(key => { if(smartCaps[key].aspects) allAspectLists.push([key, smartCaps[key].aspects]); });
    ok(allAspectLists.length > 0, '能力表里有视频宽高比集合');
    allAspectLists.forEach(([key, list]) => ok(!list.includes('9:21'), key + ' 的宽高比不含 9:21（官方无此档）'));

    // ── 4. 档位词表 / 长边 / 像素上限覆盖官方六个档 ───────────────────────────
    const classic = buildSandbox(classicSrc, 'classic');
    const smart = buildSandbox(smartSrc, 'smart');
    // const 声明在 vm 里是词法绑定，不会挂到 sandbox 对象上，要再跑一次表达式读取
    const readCtx = (box, expr) => vm.runInContext(expr, box);
    eq(readCtx(classic, 'API_RES_LEVELS'), OFFICIAL_TIERS, 'canvas.js API_RES_LEVELS = 官方档位词表');
    eq(readCtx(smart, 'API_RES_LEVELS'), OFFICIAL_TIERS, 'smart-canvas.js API_RES_LEVELS = 官方档位词表');
    OFFICIAL_TIERS.forEach(level => {
        const levelKey = JSON.stringify(level);
        eq(readCtx(classic, 'RES_LONG_SIDE[' + levelKey + ']'), OFFICIAL_LONG_SIDE[level], 'canvas.js RES_LONG_SIDE[' + level + ']');
        eq(readCtx(smart, 'RES_LONG_SIDE[' + levelKey + ']'), OFFICIAL_LONG_SIDE[level], 'smart-canvas.js RES_LONG_SIDE[' + level + ']');
        eq(readCtx(classic, 'RES_PIXEL_LIMIT_FALLBACK[' + levelKey + ']'), OFFICIAL_PIXEL_FALLBACK[level], 'canvas.js 档位像素兜底[' + level + ']');
        eq(readCtx(smart, 'RES_PIXEL_LIMIT_FALLBACK[' + levelKey + ']'), OFFICIAL_PIXEL_FALLBACK[level], 'smart-canvas.js 档位像素兜底[' + level + ']');
    });

    // ── 5. 按模型解析：档位 / 宽高比 ─────────────────────────────────────────
    const imageCases = [
        ['midjourney', ['1k']],
        ['gpt-image-2.5-ext', ['1k', '2k', '4k']],
        ['imagen-4.0-apimart', ['1k']],
        ['qwen-image-2.0', ['1k', '2k']],
        ['z-image-turbo', ['1k', '2k']],
        ['flux-3-image-klein', ['768sq', '1k', '1.5k', '2k', '4k']],
        ['grok-imagine-2.0-ext', ['quality']],
        ['grok-imagine-image-2.0', ['1k', '2k']],
        ['hy-image-v3.5-preview', ['1k', '2k', '4k']],
        ['wan2.7-image-pro', ['1k', '2k', '4k']],
        ['wan2.7-image', ['1k', '2k']],
        ['nano-banana-2', ['0.5k', '1k', '2k', '4k']],
        ['nano-banana-pro', ['1k', '2k', '4k']],
        ['gemini-2.5-flash-image', ['1k', '2k', '4k']],
        ['seedream-5.0-pro', ['1k', '1.5k', '2k']],
        ['seedream-5.0-flash', ['1k', '1.5k', '2k']],
        ['seedream-5.0-lite', ['2k', '3k', '4k']],
        ['seedream-4.5', ['2k', '4k']],
        ['seedream-4.0', ['1k', '2k', '4k']],
        ['agnes-image-25-flash', ['1k', '2k', '3k', '4k']],
        ['gpt-image-2', ['1k', '2k', '4k']],
        ['Tongyi-MAI/Z-Image-Turbo', ['1k', '2k', '4k']],
        // Lovart 下划线写法（真实 provider 模型名）
        ['generate_image_nano_banana_2', ['0.5k', '1k', '2k', '4k']],
        ['generate_image_nano_banana', ['1k', '2k', '4k']],
        ['generate_image_seedream_v5_pro', ['1k', '1.5k', '2k']],
        ['generate_image_seedream_v5', ['1k', '1.5k', '2k']],
        ['generate_image_seedream_v4_5', ['2k', '4k']],
        ['generate_image_seedream_v4', ['1k', '2k', '4k']]
    ];
    imageCases.forEach(([model, expected]) => {
        eq(classic.imageResLevelsFor(model), expected, '经典画布 imageResLevelsFor(' + model + ')');
        eq(smart.imageResLevelsFor(model), expected, '智能画布 imageResLevelsFor(' + model + ')');
    });
    const videoCases = [
        ['doubao-seedance-2-0-260128', ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']],
        ['kling-v3', ['16:9', '9:16', '1:1']],
        ['veo-3.1-fast', ['16:9', '9:16']],
        ['veo3-fast', ['16:9', '9:16']],
        ['some-unknown-model', null]
    ];
    videoCases.forEach(([model, expected]) => {
        eq(classic.getVideoAspectRatios(model), expected, '经典画布 getVideoAspectRatios(' + model + ')');
    });

    // ── 6. 经典画布 keep_ratio 解析成具体比例（与智能画布同语义）───────────────
    ok(typeof classic.resolveVideoNodeAspectRatio === 'function', '经典画布有 resolveVideoNodeAspectRatio');
    eq(await classic.resolveVideoNodeAspectRatio({ aspectRatio: 'keep_ratio', model: 'seedance' }, [{ url: 'a.png' }]), '4:3',
        '经典画布 seedance keep_ratio + 4000x3000 参考图 → 具体 4:3');
    eq(await classic.resolveVideoNodeAspectRatio({ aspectRatio: 'keep_ratio', model: 'veo-3' }, [{ url: 'a.png' }]), '16:9',
        '经典画布 veo-3 keep_ratio → 官方支持的 16:9（不再是 1:1）');
    eq(await classic.resolveVideoNodeAspectRatio({ aspectRatio: 'keep_ratio', model: 'seedance' }, []), 'adaptive',
        '经典画布无参考素材时 keep_ratio → Ark 官方认的 adaptive');
    eq(await classic.resolveVideoNodeAspectRatio({ aspectRatio: '16:9', model: 'seedance' }, []), '16:9',
        '非 keep_ratio 原样返回');
    eq(classic.nearestVideoAspectForCanvasSize(1920, 1080, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']), '16:9',
        'nearestVideoAspectForCanvasSize(1920x1080)');
    eq(classic.nearestVideoAspectForCanvasSize(1080, 1920, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']), '9:16',
        'nearestVideoAspectForCanvasSize(1080x1920)');
    // 历史存档（9:21 / 780P / keep_ratio）不崩、不被渲染期静默改写
    const legacyNode = { aspectRatio: '9:21', resolution: '780P', model: 'generate_video_seedance_v2_0' };
    await classic.resolveVideoNodeAspectRatio(legacyNode, []);
    eq(legacyNode.aspectRatio, '9:21', '历史 9:21 不被渲染期改写');
    eq(legacyNode.resolution, '780P', '历史 780P 不被渲染期改写');
    const keepNode = { aspectRatio: 'keep_ratio', model: 'generate_video_seedance_v2_0' };
    await classic.resolveVideoNodeAspectRatio(keepNode, []);
    eq(keepNode.aspectRatio, 'keep_ratio', '解析 keep_ratio 只改本次请求、不改节点存档');

    // ── 7. 视频分辨率下拉：官方集合，780P 已删 ───────────────────────────────
    ok(!/780P/i.test(classicSrc), 'canvas.js 里不再出现 780P');
    ok(!/780P/i.test(smartSrc), 'smart-canvas.js 里不再出现 780P');
    const classicRes = blockOf(classicSrc, /class="select-lite video-resolution compact-select">[\s\S]*?<\/select>/);
    ['480p', '720p', '1080p', '4k'].forEach(value => ok(classicRes.includes('value="' + value + '"'), '经典画布视频分辨率有 ' + value));
    ok(!/value="780P"/.test(classicRes), '经典画布视频分辨率没有 780P');
    eq(smart.videoResolutionOptions().map(item => item[0]), ['', '480p', '720p', '1080p', '4k'], '智能画布视频分辨率集合');
    eq(smart.videoAspectOptions().map(item => item[0]),
        ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'keep_ratio', 'adaptive'], '智能画布视频比例不含 9:21');

    // ── 8. 视频比例下拉：经典画布静态选项不含 9:21；按模型过滤逻辑在 test_canvas_preset_matrix.js ──
    const classicRatios = blockOf(classicSrc, /class="select-lite video-aspect compact-select">[\s\S]*?<\/select>/);
    ok(!classicRatios.includes('9:21'), '经典画布视频比例下拉不含 9:21');
    ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].forEach(value => ok(classicRatios.includes('value="' + value + '"'), '经典画布视频比例下拉有 ' + value));
    ok(classicRatios.includes('value="keep_ratio"'), '经典画布视频比例下拉保留 keep_ratio');
    ok(classicRatios.includes('value="adaptive"'), '经典画布视频比例下拉保留 adaptive');

    // ── 9. 预设比例表：经典收窄 9 个 / 智能 15 个（含新补 3:1、1:3）────────────
    const classicMap = blockOf(classicSrc, /const SIZE_MAP = \{[\s\S]*?\n\};/);
    const smartMap = blockOf(smartSrc, /const SIZE_MAP = \{[\s\S]*?\n\};/);
    const countKeys = block => (block.match(/^\s{4}\w+:/gm) || []).length;
    eq(countKeys(classicMap), 9, '经典画布 SIZE_MAP 按设计保持 9 个比例');
    ok(/landscape31:\s*\{'1k':'1536x512'/.test(smartMap), '智能画布 SIZE_MAP 补 3:1 官方对齐像素');
    ok(/portrait13:\s*\{'1k':'512x1536'/.test(smartMap), '智能画布 SIZE_MAP 补 1:3 官方对齐像素');

    console.log('');
    console.log('[model-cap] ' + pass + ' 项通过');
    if(fails.length){
        fails.slice(0, 60).forEach(msg => console.error('  ✗ ' + msg));
        if(fails.length > 60) console.error('  … 其余 ' + (fails.length - 60) + ' 项');
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
