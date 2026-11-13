#!/usr/bin/env node
/*
 * 设置页「能力覆盖」比例 / 档位官方口径校验（词表在 web/src/lib/sizeCatalog.js）。
 *
 * 在线生图页已下线删除，页面尺寸计算（SIZE_OPTIONS / MODEL_SIZE_PRESETS / supportedRatios /
 * resolutionOptions）随页面一起移除；设置页仍用 RATIOS / EXTRA_RATIOS / RES_LEVELS，
 * 这里只守这三份官方词表本身，防止设置页的多选项再次分叉。
 *
 * 官方依据（/tmp/novai-official-docs/）：
 *   - APIMart gpt-image-2 generation：15 比例 × 1k/2k/4k 像素映射表
 *       text/apimart_gpt_image_2_generation_md.txt:380-422
 *   - Google Gemini 图像生成：14 比例、1:4/1:8/4:1/8:1 四个独有比例
 *       text/gemini_image_generation.txt:4642-4738
 *   - 火山方舟 Seedream：档位 0.5K/1K/1.5K/2K/3K/4K
 *       text/volcengine_ark_image_api.txt:138-470
 *
 * 运行：node tests/test_online_sizes_official.js
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CATALOG = process.env.NOVAI_SIZE_TEST_CATALOG_SRC || path.join(ROOT, 'web/src/lib/sizeCatalog.js');

// 设置页可见比例下拉的 15 个通用比例 key ↔ 官方比例
const KEY_TO_RATIO = {
    square: '1:1', portrait: '2:3', landscape: '3:2', portrait43: '3:4', landscape43: '4:3',
    story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21', landscape21: '2:1',
    portrait12: '1:2', landscape54: '5:4', portrait45: '4:5', landscape31: '3:1', portrait13: '1:3',
};
// Gemini 官方独有、不在 gpt-image-2 15 键表里的 4 个比例
const EXTRA_KEY_TO_RATIO = { portrait14: '1:4', portrait18: '1:8', landscape41: '4:1', landscape81: '8:1' };
const LEVELS = ['0.5k', '1k', '1.5k', '2k', '3k', '4k'];

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');
const ratioLabelOf = option => String((option && option.label) || '').split(/\s+/)[0];

async function main() {
    const catalog = await import(pathToFileURL(CATALOG).href);
    const { RATIOS, EXTRA_RATIOS = [], RES_LEVELS } = catalog;

    // 1) RATIOS：官方 15 比例，id 与官方宽高比标签一一对应
    const ratioIds = RATIOS.map(r => r.id);
    eq(ratioIds, Object.keys(KEY_TO_RATIO), 'RATIOS 就是可见 15 键（顺序与设置页一致）');
    ratioIds.forEach((id, index) => {
        eq(ratioLabelOf(RATIOS[index]), KEY_TO_RATIO[id], 'RATIOS 的 ' + id + ' label 以官方比例开头');
    });
    ok(new Set(ratioIds).size === ratioIds.length, 'RATIOS 没有重复 id');
    ok(ratioIds.indexOf('landscape31') >= 0 && ratioIds.indexOf('portrait13') >= 0,
        '3:1 / 1:3 已进入设置页可见比例');
    ['ultrawide', 'ultratall', 'landscape21', 'portrait12', 'landscape54', 'portrait45']
        .forEach(id => ok(ratioIds.indexOf(id) >= 0, 'RATIOS 必须补上 ' + id));

    // 2) EXTRA_RATIOS：只补 Gemini 独有 4 比例，不和 15 键表重复
    eq(EXTRA_RATIOS.map(r => r.id), Object.keys(EXTRA_KEY_TO_RATIO), 'EXTRA_RATIOS = Gemini 独有 4 比例');
    EXTRA_RATIOS.forEach((option, index) => {
        eq(ratioLabelOf(option), Object.keys(EXTRA_KEY_TO_RATIO).map(id => EXTRA_KEY_TO_RATIO[id])[index],
            'EXTRA_RATIOS 的 ' + option.id + ' label 以官方比例开头');
        ok(ratioIds.indexOf(option.id) < 0, 'EXTRA_RATIOS 的 ' + option.id + ' 不进 RATIOS');
    });

    // 3) RES_LEVELS：官方 6 档，顺序固定（设置页按这个顺序写盘）
    eq(RES_LEVELS, LEVELS, 'RES_LEVELS = 0.5k / 1k / 1.5k / 2k / 3k / 4k');

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
