#!/usr/bin/env node
/*
 * 供应商级「能力覆盖」前端消费校验（两套画布 + 在线生图页）。
 *
 * 场景：中转站 43.130.6.197 的 gemini-3.1-flash-image 声明
 *   ratios = 10 个比例 / resolutions = ["1k"]（见 /tmp/novai-matrix-evidence/REPORT.md）。
 * 断言：
 *   1) 带覆盖：两套画布 imageRatiosFor / imageResLevelsFor 与在线页 supportedRatios /
 *      resolutionOptions 只列 1k 与那 10 个比例；1:4 / 1:8 / 4:1 / 8:1 / 9:21 不出现，
 *      0.5k / 2k / 4k 不出现；
 *   2) 不带覆盖：三处与静态表逐字节一致（防回归）；
 *   3) 差分：不带覆盖时被覆盖项确实在列（改前会列出、改后不列）。
 *
 * 运行：node tests/test_size_override_frontend.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CLASSIC_SRC = process.env.NOVAI_OVERRIDE_TEST_CLASSIC_SRC || path.join(ROOT, 'static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_OVERRIDE_TEST_SMART_SRC || path.join(ROOT, 'static/js/smart-canvas.js');
const STATIC_POLICY_SRC = process.env.NOVAI_OVERRIDE_TEST_POLICY_SRC || path.join(ROOT, 'static/js/shared/size-policy.js');
const ONLINE_SIZES_SRC = path.join(ROOT, 'web/src/pages/online/onlineSizes.js');
const WEB_POLICY_SRC = path.join(ROOT, 'web/src/pages/online/sizePolicy.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');

// 供应商配置里的真实模型名（gemini 在线页会别名到 nano-banana-2 预设，画布按真实名匹配）
const RELAY_MODEL = 'gemini-3.1-flash-image';
const RELAY_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const RELAY_RESOLUTIONS = ['1k'];
// Gemini 官方 14 / 画布静态表 14 键；覆盖后剩 10 键
const GEMINI_14 = ['square', 'portrait14', 'portrait18', 'portrait', 'landscape', 'portrait43',
    'landscape41', 'landscape43', 'portrait45', 'landscape54', 'landscape81', 'story', 'wide', 'ultrawide'];
const GEMINI_10 = ['square', 'portrait', 'landscape', 'portrait43', 'landscape43',
    'portrait45', 'landscape54', 'story', 'wide', 'ultrawide'];
const GEMINI_14_LABELS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];
// 在线页比例下拉顺序 = RATIOS 顺序（15 键）+ EXTRA_RATIOS
const ONLINE_10 = ['square', 'portrait', 'landscape', 'portrait43', 'landscape43', 'story', 'wide', 'ultrawide', 'landscape54', 'portrait45'];
const ONLINE_14 = ONLINE_10.concat(['portrait14', 'portrait18', 'landscape41', 'landscape81']);
const API_RES_LEVELS = ['0.5k', '1k', '1.5k', '2k', '3k', '4k'];
const TIERS = [
    { id: '1k', maxPixels: 1572864 },
    { id: '2k', maxPixels: 4194304 },
    { id: '4k', maxPixels: 8294400 },
];

function overrideModel() {
    return {
        mode: 'free', hintOnly: false, maxEdge: 0, maxPixels: 0, minPixels: 0, multipleOf: 0,
        minRatio: 0, maxRatio: 0, options: [], prefer: 'ratio', autoSize: false, defaultLevel: '', tiers: TIERS,
        ratios: RELAY_RATIOS.slice(), resolutions: RELAY_RESOLUTIONS.slice(),
    };
}
function plainModel() {
    const model = overrideModel();
    delete model.ratios;
    delete model.resolutions;
    return model;
}
// 同时覆盖真实模型名与在线页别名，验证两条查找路径
function policyTable(override) {
    return {
        format: 'novai-size-policy/v1',
        default: Object.assign(plainModel(), { tiers: TIERS.map(t => Object.assign({}, t)) }),
        models: {
            [RELAY_MODEL]: override ? overrideModel() : plainModel(),
            'nano-banana-2': override ? overrideModel() : plainModel(),
        },
    };
}

async function loadStaticPolicy(table) {
    const sandbox = { window: {}, console, fetch: async () => ({ ok: true, json: async () => table }) };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(STATIC_POLICY_SRC, 'utf8'), sandbox);
    await sandbox.window.NovaSizePolicy.load();
    return sandbox.window.NovaSizePolicy;
}

function blockOf(src, re) {
    const m = src.match(re);
    if (!m) throw new Error('缺少源码块 ' + re);
    return m[0];
}
function topLevelFunction(src, name) {
    const matched = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    if (!matched) throw new Error('未找到函数 ' + name);
    const start = matched.index + 1;
    const end = src.indexOf('\n}', start + 1);
    if (end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
function buildCanvas(src, policy) {
    const sandbox = { window: {}, console, NovaSizePolicy: policy };
    vm.createContext(sandbox);
    const consts = [
        blockOf(src, /const GEMINI_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const SEEDREAM_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(src, /const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/),
        blockOf(src, /const MODEL_TIER_PIXELS = \{[\s\S]*?\n\};/),
        blockOf(src, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(src, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(src, /const RES_LONG_SIDE = \{[^}]*\};/),
    ];
    const names = ['modelCapabilityFor', 'imageResLevelsFor', 'imageRatiosFor'];
    vm.runInContext(consts.concat(names.map(n => topLevelFunction(src, n))).join('\n'), sandbox, { filename: 'override-sandbox.js' });
    return sandbox;
}
function optionValues(src, selectRe) {
    const block = blockOf(src, selectRe);
    return Array.from(block.matchAll(/<option value="([^"]+)"/g)).map(m => m[1]);
}
function smartRatioTiles(src) {
    const block = blockOf(src, /const ratioTiles = \[[\s\S]*?\]\.map\(/);
    return Array.from(block.matchAll(/\['([^']+)','([^']+)'\]/g)).map(m => m[1]);
}
const sorted = list => list.slice().sort();

async function main() {
    const classicSrc = fs.readFileSync(CLASSIC_SRC, 'utf8');
    const smartSrc = fs.readFileSync(SMART_SRC, 'utf8');

    const basePolicy = await loadStaticPolicy(policyTable(false));
    const relayPolicy = await loadStaticPolicy(policyTable(true));
    const classicBase = buildCanvas(classicSrc, basePolicy);
    const classicRelay = buildCanvas(classicSrc, relayPolicy);
    const smartBase = buildCanvas(smartSrc, basePolicy);
    const smartRelay = buildCanvas(smartSrc, relayPolicy);

    const classicRatioOpts = optionValues(classicSrc, /<select class="select-lite ratio compact-select"[\s\S]*?<\/select>/);
    const classicResOpts = optionValues(classicSrc, /<select class="select-lite resolution compact-select"[\s\S]*?<\/select>/);
    const tiles = smartRatioTiles(smartSrc);

    /* ── 1. 不带覆盖：三处与静态表逐字节一致 ── */
    eq(classicBase.imageResLevelsFor('nano-banana-2'), ['0.5k', '1k', '2k', '4k'], '基线 经典画布档位不变');
    eq(smartBase.imageResLevelsFor('nano-banana-2'), ['0.5k', '1k', '2k', '4k'], '基线 智能画布档位不变');
    eq(classicBase.imageRatiosFor('nano-banana-2'), GEMINI_14, '基线 经典画布比例不变');
    eq(smartBase.imageRatiosFor('nano-banana-2'), GEMINI_14, '基线 智能画布比例不变');
    eq(classicBase.imageResLevelsFor(RELAY_MODEL), ['1k', '2k', '4k'], '基线 真实模型名仍走默认档位');
    ok(classicBase.imageRatiosFor(RELAY_MODEL) === null, '基线 真实模型名仍不限制比例');
    ok(classicBase.imageRatiosFor('unknown-model') === null, '基线 未知模型仍不限制比例');

    /* ── 2. 带覆盖：只列 1k 与 10 个比例 ── */
    eq(classicRelay.imageResLevelsFor('nano-banana-2'), ['1k'], '覆盖 经典画布只列 1k');
    eq(smartRelay.imageResLevelsFor('nano-banana-2'), ['1k'], '覆盖 智能画布只列 1k');
    eq(classicRelay.imageRatiosFor('nano-banana-2'), GEMINI_10, '覆盖 经典画布只列 10 个比例');
    eq(smartRelay.imageRatiosFor('nano-banana-2'), GEMINI_10, '覆盖 智能画布只列 10 个比例');
    eq(classicRelay.imageResLevelsFor(RELAY_MODEL), ['1k'], '覆盖 真实模型名只列 1k');
    eq(sorted(classicRelay.imageRatiosFor(RELAY_MODEL)), sorted(GEMINI_10), '覆盖 真实模型名只列 10 个比例');
    eq(sorted(smartRelay.imageRatiosFor(RELAY_MODEL)), sorted(GEMINI_10), '覆盖 真实模型名智能画布只列 10 个比例');
    GEMINI_14.forEach((key, index) => {
        const inRelay = GEMINI_10.indexOf(key) >= 0;
        const listed = classicRelay.imageRatiosFor(RELAY_MODEL).indexOf(key) >= 0;
        ok(listed === inRelay, '覆盖 比例 ' + GEMINI_14_LABELS[index] + ' ' + (inRelay ? '在列' : '不在列'));
    });
    // 覆盖只作用于被声明的模型：其它模型不受影响
    eq(classicRelay.imageResLevelsFor('gpt-image-2'), ['1k', '2k', '4k'], '覆盖 不泄漏到其它模型（档位）');
    ok(classicRelay.imageRatiosFor('gpt-image-2') === null, '覆盖 不泄漏到其它模型（比例）');

    /* ── 3. 真实 UI 列表：源码里的 select / tiles 经同一函数过滤后的可见项 ── */
    const visibleClassicRatios = classicRatioOpts.filter(v => classicRelay.imageRatiosFor(RELAY_MODEL).indexOf(v) >= 0);
    eq(visibleClassicRatios, ['square', 'portrait', 'landscape', 'portrait43', 'landscape43', 'story', 'wide', 'ultrawide'],
        '覆盖 经典画布比例下拉可见项（ultratall 9:21 被剔除）');
    const visibleClassicLevels = API_RES_LEVELS.filter(v => classicResOpts.indexOf(v) >= 0 && classicRelay.imageResLevelsFor(RELAY_MODEL).indexOf(v) >= 0);
    eq(visibleClassicLevels, ['1k'], '覆盖 经典画布档位下拉可见项只有 1k');
    const visibleSmartTiles = tiles.filter(v => smartRelay.imageRatiosFor(RELAY_MODEL).indexOf(v) >= 0);
    eq(visibleSmartTiles, ['square', 'story', 'wide', 'portrait43', 'landscape43', 'landscape', 'portrait', 'landscape54', 'portrait45', 'ultrawide'],
        '覆盖 智能画布比例格可见项只有 10 个');

    /* ── 4. 在线生图页（真模块）── */
    globalThis.fetch = async () => ({ ok: true, json: async () => policyTable(true) });
    const { NovaSizePolicy } = await import(pathToFileURL(WEB_POLICY_SRC).href);
    const online = await import(pathToFileURL(ONLINE_SIZES_SRC).href);

    // 未加载策略 = 无覆盖：与静态预设一致（真实模型名走 nano-banana-2 别名预设）
    eq(online.supportedRatios('nano-banana-2').map(r => r.id), ONLINE_14, '基线 在线页比例 = 官方 14');
    eq(online.resolutionOptions('nano-banana-2', 'square').map(o => o.value), ['0.5k', '1k', '2k', '4k'], '基线 在线页档位 = 0.5K/1K/2K/4K');
    eq(online.supportedRatios(RELAY_MODEL).map(r => r.id), ONLINE_14, '基线 在线页真实模型名 = 官方 14');

    await NovaSizePolicy.load();
    eq(online.supportedRatios('nano-banana-2').map(r => r.id), ONLINE_10, '覆盖 在线页别名只列 10 个比例');
    eq(online.supportedRatios(RELAY_MODEL).map(r => r.id), ONLINE_10, '覆盖 在线页真实模型名只列 10 个比例');
    eq(online.resolutionOptions(RELAY_MODEL, 'square').map(o => o.value), ['1k'], '覆盖 在线页档位只有 1k');
    eq(online.computeSize({ model: RELAY_MODEL, ratio: 'wide', resolution: '1k' }), '1376x768', '覆盖 在线页 16:9@1K 像素不变');
    ONLINE_10.forEach(id => ok(online.supportedRatios(RELAY_MODEL).map(r => r.id).indexOf(id) >= 0, '覆盖 在线页保留 ' + id));
    ok(online.supportedRatios(RELAY_MODEL).map(r => r.id).indexOf('portrait14') < 0
        && online.supportedRatios(RELAY_MODEL).map(r => r.id).indexOf('landscape41') < 0, '覆盖 在线页不出现 1:4 / 4:1');
    // 未声明的模型保持现状
    eq(online.supportedRatios('gpt-image-2').map(r => r.id).length, 15, '覆盖 在线页其它模型仍是 15 比例');

    /* ── 5. 差分：不带覆盖时被覆盖项确实在列 ── */
    eq(classicBase.imageRatiosFor(RELAY_MODEL), null, '差分 改前真实模型名不限制比例');
    eq(classicRatioOpts.filter(v => classicBase.imageRatiosFor(RELAY_MODEL) === null || classicBase.imageRatiosFor(RELAY_MODEL).indexOf(v) >= 0).length,
        classicRatioOpts.length, '差分 改前经典画布列出全部静态比例（含 9:21）');
    ok(classicBase.imageRatiosFor(RELAY_MODEL) === null || classicBase.imageRatiosFor(RELAY_MODEL).indexOf('ultratall') >= 0,
        '差分 改前列出 9:21');
    eq(tiles.filter(v => smartBase.imageRatiosFor(RELAY_MODEL) === null || smartBase.imageRatiosFor(RELAY_MODEL).indexOf(v) >= 0),
        tiles, '差分 改前智能画布列出全部 15 个比例格');
    ok(basePolicy.ratioAllowed(RELAY_MODEL, 'portrait14') === true, '差分 改前策略放行 1:4');
    ok(basePolicy.levelAllowed(RELAY_MODEL, '2k') === true, '差分 改前策略放行 2K');
    ok(relayPolicy.ratioAllowed(RELAY_MODEL, 'portrait14') === false, '差分 改后策略拒绝 1:4');
    ok(relayPolicy.levelAllowed(RELAY_MODEL, '2k') === false, '差分 改后策略拒绝 2K');

    console.log('[size-override-frontend] ' + pass + ' 项通过');
    if (fails.length) {
        fails.slice(0, 80).forEach(msg => console.error('  \u2717 ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('[size-override-frontend] 全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
