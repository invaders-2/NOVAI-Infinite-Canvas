#!/usr/bin/env node
/*
 * 在线生图页（web/src/pages/online）尺寸/比例/档位官方口径校验。
 *
 * 官方依据（/tmp/novai-official-docs/）：
 *   - APIMart gpt-image-2 generation：15 比例 × 1k/2k/4k 像素映射表
 *       text/apimart_gpt_image_2_generation_md.txt:380-422
 *   - Google Gemini 图像生成：14 比例、16:9@4K=5504x3072、21:9@4K=6336x2688、
 *       3.1 Flash Image 另有 512px(0.5K)：text/gemini_image_generation.txt:4632-4984
 *   - 火山方舟 Seedream：5.0 pro/flash=1K/1.5K/2K、5.0 lite=2K/3K/4K、4.5=2K/4K、
 *       4.0=1K/2K/4K 各档官方参考像素：text/volcengine_ark_image_api.txt:138-470
 *
 * 运行：node tests/test_online_sizes_official.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const ONLINE = path.join(ROOT, 'web/src/pages/online/onlineSizes.js');
const DATA = path.join(ROOT, 'web/src/pages/online/sizeData.js');

// 在线页可见比例下拉的 15 个通用比例 key ↔ 官方比例
//（= tests/test_size_map_parity.js 的 KEY_TO_RATIO + ALIGNED_KEYS）
const KEY_TO_RATIO = {
    square: '1:1', portrait: '2:3', landscape: '3:2', portrait43: '3:4', landscape43: '4:3',
    story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21', landscape21: '2:1',
    portrait12: '1:2', landscape54: '5:4', portrait45: '4:5', landscape31: '3:1', portrait13: '1:3',
};
// Gemini 官方独有、不在 gpt-image-2 15 键表里的 4 个比例
const EXTRA_KEY_TO_RATIO = { portrait14: '1:4', portrait18: '1:8', landscape41: '4:1', landscape81: '8:1' };
// Gemini 官方 14 比例（text/gemini_image_generation.txt:4642-4738）
const GEMINI_RATIOS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');
const levelsOf = (preset, key) => (((preset || {})[key]) || []).map(item => item[1]);
const pixelsOf = (preset, key, level) => ((((preset || {})[key]) || []).find(item => item[1] === level) || [])[0];

async function main() {
    const online = await import(pathToFileURL(ONLINE).href);
    const data = await import(pathToFileURL(DATA).href);
    const { RATIOS, EXTRA_RATIOS = [], RES_LEVELS, supportedRatios, resolutionOptions, computeSize } = online;
    const { SIZE_OPTIONS, MODEL_SIZE_PRESETS } = data;

    // 1) RATIOS（可见下拉）⊆ SIZE_OPTIONS；SIZE_OPTIONS / gpt-image-2 预设必须补齐官方 15 比例
    const ratioIds = RATIOS.map(r => r.id);
    const sizeKeys = Object.keys(SIZE_OPTIONS);
    ratioIds.forEach(id => ok(sizeKeys.indexOf(id) >= 0, 'RATIOS 的 ' + id + ' 必须在 SIZE_OPTIONS 键集合里'));
    eq(ratioIds, Object.keys(KEY_TO_RATIO), 'RATIOS 就是可见 15 键');
    ok(ratioIds.indexOf('landscape31') >= 0 && ratioIds.indexOf('portrait13') >= 0,
        '3:1 / 1:3 已进入在线页可见比例下拉');
    eq(sizeKeys.slice().sort(), Object.keys(KEY_TO_RATIO).slice().sort(), 'SIZE_OPTIONS = 官方 15 比例');
    eq(Object.keys(MODEL_SIZE_PRESETS['gpt-image-2']).slice().sort(),
        Object.keys(KEY_TO_RATIO).slice().sort(), 'gpt-image-2 预设 = SIZE_OPTIONS = 官方 15 比例');
    eq(pixelsOf(SIZE_OPTIONS, 'landscape31', '1k'), '1536x512', 'SIZE_OPTIONS 3:1@1K 取 16 对齐官方像素');
    eq(pixelsOf(SIZE_OPTIONS, 'portrait13', '1k'), '512x1536', 'SIZE_OPTIONS 1:3@1K 取 16 对齐官方像素');
    // 任务要求补的 6 个比例
    ['ultrawide', 'ultratall', 'landscape21', 'portrait12', 'landscape54', 'portrait45']
        .forEach(id => ok(ratioIds.indexOf(id) >= 0, 'RATIOS 必须补上 ' + id));
    // EXTRA_RATIOS 只补 Gemini 独有 4 比例，不落进 SIZE_OPTIONS
    eq(EXTRA_RATIOS.map(r => r.id), Object.keys(EXTRA_KEY_TO_RATIO), 'EXTRA_RATIOS = Gemini 独有 4 比例');
    EXTRA_RATIOS.forEach(r => ok(sizeKeys.indexOf(r.id) < 0, 'EXTRA_RATIOS 的 ' + r.id + ' 不进 gpt-image-2 的 SIZE_OPTIONS'));
    eq(RES_LEVELS, ['0.5k', '1k', '1.5k', '2k', '3k', '4k'], 'RES_LEVELS 补上 0.5k/1.5k/3k');

    // 2) 按模型过滤：出现的比例必须在该模型预设里；预设没有 3:1 / 1:3 的模型不得出现这两项
    const gpt2 = supportedRatios('gpt-image-2').map(r => r.id);
    eq(gpt2, ratioIds, 'gpt-image-2 出现全部 15 个通用比例');
    ok(gpt2.indexOf('landscape31') >= 0 && gpt2.indexOf('portrait13') >= 0, 'gpt-image-2 出现 3:1 / 1:3');
    Object.keys(EXTRA_KEY_TO_RATIO).forEach(id => ok(gpt2.indexOf(id) < 0, 'gpt-image-2 不得出现 ' + id));
    const seedream40 = supportedRatios('seedream-4.0').map(r => r.id);
    ok(seedream40.indexOf('portrait12') < 0 && seedream40.indexOf('landscape21') < 0
        && seedream40.indexOf('landscape54') < 0 && seedream40.indexOf('portrait45') < 0,
        'seedream-4.0 不出现火山官方 8 比例以外的预置比例');
    ['seedream-4.0', 'seedream-4.5', 'seedream-5.0-pro', 'nano-banana', 'nano-banana-2', 'nano-banana-pro']
        .forEach(model => {
            const ids = supportedRatios(model).map(r => r.id);
            ok(ids.indexOf('landscape31') < 0 && ids.indexOf('portrait13') < 0,
                model + ' 预设无 3:1 / 1:3，下拉不得出现');
        });
    Object.keys(MODEL_SIZE_PRESETS).forEach(key => {
        const opts = MODEL_SIZE_PRESETS[key];
        supportedRatios(key).forEach(r => ok(!!opts[r.id], key + ' 的选项 ' + r.id + ' 必须来自它自己的预设表'));
    });
    // Gemini 系按官方 14 比例：10 通用 + 4 独有
    ['nano-banana', 'nano-banana-2', 'nano-banana-pro'].forEach(model => {
        const ids = supportedRatios(model).map(r => r.id);
        const ratios = ids.map(id => (KEY_TO_RATIO[id] || EXTRA_KEY_TO_RATIO[id]));
        eq(ratios.slice().sort(), GEMINI_RATIOS.slice().sort(), model + ' 覆盖 Gemini 官方 14 比例');
    });

    // 3) 档位按模型过滤：模型没有的档位直接隐藏（不出现在下拉里）
    eq(resolutionOptions('gpt-image-2', 'square').map(o => o.value), ['1k', '2k', '4k'], 'gpt-image-2 隐藏 0.5k/1.5k/3k');
    eq(resolutionOptions('nano-banana-2', 'square').map(o => o.value), ['0.5k', '1k', '2k', '4k'], '3.1 Flash Image(0.5K) 档位');
    eq(resolutionOptions('seedream-5.0-pro', 'square').map(o => o.value), ['1k', '1.5k', '2k'], 'Seedream 5.0 pro/flash 无 3K');
    eq(resolutionOptions('seedream-5.0-lite', 'square').map(o => o.value), ['2k', '3k', '4k'], 'Seedream 5.0 lite 有 3K');
    eq(resolutionOptions('seedream-4.0', 'square').map(o => o.value), ['1k', '2k', '4k'], 'Seedream 4.0 有 4K');
    // 该比例没有的档位置灰（而不是整档消失）
    const seedreamWide = resolutionOptions('seedream-4.0', 'wide');
    ok(seedreamWide.filter(o => !o.disabled).length === 3, 'Seedream 4.0 16:9 有 3 个可用档');

    // 4) Gemini 官方像素（text/gemini_image_generation.txt:4642-4738 / 4749-4874）
    const gemini = MODEL_SIZE_PRESETS['nano-banana-pro'];
    eq(pixelsOf(gemini, 'square', '4k'), '4096x4096', 'Gemini 1:1@4K=4096x4096');
    eq(pixelsOf(gemini, 'wide', '4k'), '5504x3072', 'Gemini 16:9@4K=5504x3072');
    eq(pixelsOf(gemini, 'ultrawide', '4k'), '6336x2688', 'Gemini 21:9@4K=6336x2688');
    eq(pixelsOf(gemini, 'portrait14', '1k'), '512x2048', 'Gemini 1:4@1K=512x2048');
    eq(pixelsOf(gemini, 'landscape81', '2k'), '6144x768', 'Gemini 8:1@2K=6144x768');
    eq(pixelsOf(MODEL_SIZE_PRESETS['nano-banana-2'], 'square', '0.5k'), '512x512', '3.1 Flash Image 0.5K=512x512');
    eq(pixelsOf(MODEL_SIZE_PRESETS['nano-banana-2'], 'wide', '0.5k'), '688x384', '3.1 Flash Image 16:9@0.5K=688x384');
    eq(computeSize({ model: 'nano-banana-pro', ratio: 'wide', resolution: '4k' }), '5504x3072', 'computeSize 走 Gemini 官方像素');

    // 5) Seedream 官方像素与档位（text/volcengine_ark_image_api.txt:152-209, 292-349, 361-401, 413-470）
    const v50 = MODEL_SIZE_PRESETS['seedream-5.0-pro'];
    eq(levelsOf(v50, 'wide'), ['1k', '1.5k', '2k'], '5.0 pro 16:9 档位 1K/1.5K/2K');
    eq(pixelsOf(v50, 'wide', '1k'), '1424x800', '5.0 pro 16:9@1K=1424x800');
    eq(pixelsOf(v50, 'wide', '1.5k'), '2048x1152', '5.0 pro 16:9@1.5K=2048x1152');
    eq(pixelsOf(v50, 'wide', '2k'), '2816x1584', '5.0 pro 16:9@2K=2816x1584');
    const lite = MODEL_SIZE_PRESETS['seedream-5.0-lite'];
    eq(levelsOf(lite, 'wide'), ['2k', '3k', '4k'], '5.0 lite 16:9 档位 2K/3K/4K');
    eq(pixelsOf(lite, 'square', '3k'), '3072x3072', '5.0 lite 1:1@3K=3072x3072');
    eq(pixelsOf(lite, 'wide', '4k'), '5504x3040', '5.0 lite 16:9@4K=5504x3040');
    const v45 = MODEL_SIZE_PRESETS['seedream-4.5'];
    eq(levelsOf(v45, 'wide'), ['2k', '4k'], '4.5 16:9 档位 2K/4K');
    const v40 = MODEL_SIZE_PRESETS['seedream-4.0'];
    eq(levelsOf(v40, 'wide'), ['1k', '2k', '4k'], '4.0 16:9 档位 1K/2K/4K');
    eq(pixelsOf(v40, 'wide', '1k'), '1280x720', '4.0 16:9@1K=1280x720');
    eq(pixelsOf(v40, 'wide', '4k'), '5504x3040', '4.0 16:9@4K=5504x3040');

    const gptExt = MODEL_SIZE_PRESETS['gpt-image-2.5-ext'];
    eq(Object.keys(gptExt).length, 10, 'GPT-Image-2.5 Ext 只展示 10 种比例');
    ok(!('portrait12' in gptExt) && !('ultratall' in gptExt), 'GPT-Image-2.5 Ext 不展示 1:2 / 9:21');
    eq(pixelsOf(MODEL_SIZE_PRESETS['qwen-image-2.0'], 'wide', '1k'), '1280x720', 'Qwen 16:9@1K=1280x720');
    eq(pixelsOf(MODEL_SIZE_PRESETS['qwen-image-2.0'], 'portrait', '2k'), '1360x2048', 'Qwen 2:3@2K=1360x2048');
    eq(pixelsOf(MODEL_SIZE_PRESETS['z-image-turbo'], 'landscape43', '1k'), '1152x864', 'Z-Image 4:3@1K=1152x864');

    // 6) 真实模型名（含 Lovart 的下划线命名）要能命中对应预设
    const resolved = [
        ['gpt-image-2', 'gpt-image-2'],
        ['nano-banana-pro', 'nano-banana-pro'],
        ['generate_image_nano_banana_pro', 'nano-banana-pro'],
        ['generate_image_nano_banana_2', 'nano-banana-2'],
        ['generate_image_seedream_v5_pro', 'seedream-5.0-pro'],
        ['generate_image_seedream_v5', 'seedream-5.0'],
        ['generate_image_seedream_v4_5', 'seedream-4.5'],
        ['generate_image_seedream_v4', 'seedream-4.0'],
    ];
    resolved.forEach(([model, key]) => {
        const got = online.getSizeOptionsForModel(model);
        ok(got === MODEL_SIZE_PRESETS[key], model + ' 应命中预设 ' + key);
    });


    // 7) 旧外壳 static/online.html 与新版同值（比例/档位/预置像素），防止再次分叉
    const html = fs.readFileSync(path.join(ROOT, 'static/online.html'), 'utf8');
    const legacyBlock = (html.match(/const GEMINI_OFFICIAL_14 = \{[\s\S]*?const MODEL_SIZE_PRESETS = \{[\s\S]*?\n        \};/) || [])[0];
    ok(!!legacyBlock, 'static/online.html 里能找到内联尺寸表');
    if (legacyBlock) {
        const legacy = new Function(legacyBlock + '\nreturn { SIZE_OPTIONS, MODEL_SIZE_PRESETS };')();
        eq(legacy.SIZE_OPTIONS, SIZE_OPTIONS, '旧外壳 SIZE_OPTIONS 与新版同值');
        ['gpt-image-2', 'nano-banana-pro', 'nano-banana-2', 'nano-banana', 'seedream-5.0-lite',
            'seedream-5.0-pro', 'seedream-5.0', 'seedream-4.5', 'seedream-4.0']
            .forEach(key => eq(legacy.MODEL_SIZE_PRESETS[key], MODEL_SIZE_PRESETS[key], '旧外壳预设 ' + key + ' 与新版同值'));
        const resSelect = (html.match(/<select id="resolutionSelect"[\s\S]*?<\/select>/) || [])[0] || '';
        const resOptions = Array.from(resSelect.matchAll(/<option value="([^"]+)"/g)).map(m => m[1]).filter(v => v !== 'custom');
        eq(resOptions, RES_LEVELS, '旧外壳档位下拉 = RES_LEVELS');
        const ratioSelect = (html.match(/<select id="ratioSelect"[\s\S]*?<\/select>/) || [])[0] || '';
        const ratioValues = Array.from(ratioSelect.matchAll(/<option value="([^"]+)"/g)).map(m => m[1]).filter(v => v && v !== 'custom');
        eq(ratioValues, RATIOS.concat(EXTRA_RATIOS).map(r => r.id), '旧外壳比例下拉 = RATIOS + EXTRA_RATIOS');
        ok(ratioValues.indexOf('landscape31') >= 0 && ratioValues.indexOf('portrait13') >= 0,
            '旧外壳比例下拉同样含 3:1 / 1:3（与新版一致）');
    }

    console.log('[online-sizes-official] ' + pass + ' 项通过');
    if (fails.length) {
        fails.slice(0, 60).forEach(msg => console.error('  \u2717 ' + msg));
        if (fails.length > 60) console.error('  \u2026 其余 ' + (fails.length - 60) + ' 项');
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('[online-sizes-official] 全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
