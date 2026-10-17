#!/usr/bin/env node
// 生图尺寸「比例换算」回归测试（经典画布 canvas.js + 智能画布 smart-canvas.js 共用同一批用例）。
//
// 复现的失效场景（都真实发生过）：
//  1) 56:75@4K 曾出 2480x3840：长边没到 3840，比例还被像素上限夹歪；
//  2) 1:1@4K 曾出 3840x2880、1:1@1K 曾出 1536x1248：正方形被夹成 4:3；
//  3) 2:3@4K 曾出 2336x3840、3:2@4K 曾出 3840x2336：比例被改（2:3→0.608、3:2→1.644）；
//  4) 经典画布长期没跟上智能画布的修复：同一 (比例, 档位, 模型) 两个画布实发尺寸不一致；
//  5) 21:9 / 9:21 / 1:10 / 10:1 这类极端比例被拉回 3:2，或长边不落在档位上。
//
// 修复后的约定：custom/source 比例只由「长边定档 + 短边等比」决定，再做 16px 对齐（floor），
// 最后 Math.max(64, …) 兜底；随后交给 NovaSizePolicy.constrain 收口。
//
// 差分证明（同一批用例接修复前的 canvas.js，应当失败）：
//   NOVAI_SIZE_TEST_CLASSIC_SRC=/tmp/novai-head-canvas.js node tests/test_api_image_size_ratio.js
//
// 运行：node tests/test_api_image_size_ratio.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（实际 ' + a + '，期望 ' + b + ' ± ' + tol + '）');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLASSIC_SRC = process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || path.join(__dirname, '../static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_SIZE_TEST_SMART_SRC || path.join(__dirname, '../static/js/smart-canvas.js');

const API_RES_LEVELS = ['1k', '2k', '4k'];
const RES_LONG_SIDE = { '1k': 1536, '2k': 2048, '4k': 3840 };
const FREE_MODEL = 'nano-banana-pro';
const ENUM_MODEL = 'gpt-image-2';

function topLevelFunction(src, name){
    const start = src.indexOf('\nfunction ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start + 1);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start + 1, end + 2);
}
function blockOf(src, re){
    const m = src.match(re);
    if(!m) throw new Error('缺少源码块 ' + re);
    return m[0];
}
// 尺寸策略真值源：server/protocols/model_protocols.json 的 size 块（与 /api/ai/size-policy 同源）。
// 这里不复制策略字段，直接把真实 size 块喂给 NovaSizePolicy.load()，避免测试和线上策略脱节。
function modelPolicyTable(){
    const protocols = JSON.parse(read('server/protocols/model_protocols.json'));
    const models = {};
    protocols.protocols.forEach(entry => {
        const size = entry && entry.size;
        if(!size) return;
        const match = entry.match || {};
        if(match.provider_ids) return;
        (match.model_patterns || []).forEach(pattern => { models[pattern] = size; });
    });
    return { format: 'novai-size-policy/v1', default: {}, models };
}
function buildSandbox(sourceText, kind, policyTable){
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(read('static/js/shared/size-policy.js'), sandbox);
    vm.runInContext('globalThis.NovaSizePolicy = window.NovaSizePolicy;', sandbox);
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(policyTable))) });
    const consts = [
        blockOf(sourceText, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(sourceText, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(sourceText, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(sourceText, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/)
    ];
    const names = ['parseRatioValue', 'apiImageSize'];
    if(kind === 'classic'){
        consts.push(blockOf(sourceText, /const API_RATIO_LABELS = \{[^\n]*\};/));
        consts.push('let models = {gpt:"gpt-image-2", nano:"nano-banana-pro"};');
        consts.push('let managedProviderId = "";');
        consts.push('function allImageModels(){ return []; }');
        names.push('resolveImageModel', 'sizePolicyFor', 'resPixelLimitFor');
    }
    const body = consts.concat(names.map(name => topLevelFunction(sourceText, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-size-sandbox.js' });
    return sandbox;
}

// 每行：比例字面量 + 修复后在 free 模型下的 [1k, 2k, 4k] 实发尺寸
const CUSTOM_RATIO_CASES = [
    ['1:10',  ['144x1536', '192x2048', '384x3840']],
    ['10:1',  ['1536x144', '2048x192', '3840x384']],
    ['56:75', ['1136x1536', '1520x2048', '2864x3840']],
    ['75:56', ['1536x1136', '2048x1520', '3840x2864']],
    ['21:9',  ['1536x656', '2048x864', '3840x1632']],
    ['9:21',  ['656x1536', '864x2048', '1632x3840']],
    ['2:3',   ['1024x1536', '1360x2048', '2560x3840']],
    ['3:2',   ['1536x1024', '2048x1360', '3840x2560']],
    ['1:1',   ['1536x1536', '2048x2048', '3840x3840']]
];
const PRESET_KEYS = ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide', 'ultrawide', 'ultratall'];

function parseSize(text){
    const m = String(text || '').match(/^(\d+)x(\d+)$/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

async function main(){
    const table = modelPolicyTable();
    // gpt-image-2 官方口径是任意 W×H（bounds：边长 /16、比例 1:3~3:1、上限 3840x2160），不再是固定枚举。
    ok(table.models[ENUM_MODEL] && table.models[ENUM_MODEL].mode === 'bounds',
        '从 model_protocols.json 取到 ' + ENUM_MODEL + ' 的 bounds 策略（官方任意 W×H）');
    ok(!table.models[FREE_MODEL] || table.models[FREE_MODEL].mode !== 'enum',
        FREE_MODEL + ' 不是 enum 平台（自由尺寸应原样放行）');

    const classic = buildSandbox(fs.readFileSync(CLASSIC_SRC, 'utf8'), 'classic', table);
    const smart = buildSandbox(fs.readFileSync(SMART_SRC, 'utf8'), 'smart', table);
    await vm.runInContext('NovaSizePolicy.load()', classic);
    await vm.runInContext('NovaSizePolicy.load()', smart);
    console.log('[size-ratio] 经典画布源码 = ' + (process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || 'static/js/canvas.js'));
    console.log('[size-ratio] 智能画布源码 = ' + (process.env.NOVAI_SIZE_TEST_SMART_SRC || 'static/js/smart-canvas.js'));

    // ── 1. 自定义 / 适配比例：长边定档 + 短边等比 ─────────────────────────────
    CUSTOM_RATIO_CASES.forEach(([ratio, expected]) => {
        expected.forEach((size, index) => {
            const level = API_RES_LEVELS[index];
            const actual = classic.apiImageSize('custom', level, ratio, '', FREE_MODEL);
            ok(actual === size,
                '自定义比例 ' + ratio + '@' + level.toUpperCase() + ' = ' + size + '（修复前长边被像素上限夹歪；实际 ' + actual + '）');
            const smartActual = smart.apiImageSize('custom', level, ratio, '', FREE_MODEL);
            ok(smartActual === size, '智能画布自定义比例 ' + ratio + '@' + level.toUpperCase() + ' = ' + size + '（实际 ' + smartActual + '）');
        });
    });

    // ── 2. 比例误差只来自 16px 对齐；长边必须落在档位上 ────────────────────────
    CUSTOM_RATIO_CASES.forEach(([ratio]) => {
        const parts = ratio.split(':').map(Number);
        const value = parts[0] / parts[1];
        API_RES_LEVELS.forEach(level => {
            const box = parseSize(classic.apiImageSize('custom', level, ratio, '', FREE_MODEL));
            const longSide = RES_LONG_SIDE[level];
            const idealWidth = value >= 1 ? longSide : longSide * value;
            const idealHeight = value >= 1 ? longSide / value : longSide;
            near(box.width, idealWidth, 16, ratio + '@' + level.toUpperCase() + ' 宽度与等比理想值只差 16px 对齐');
            near(box.height, idealHeight, 16, ratio + '@' + level.toUpperCase() + ' 高度与等比理想值只差 16px 对齐');
            ok(Math.max(box.width, box.height) === longSide,
                ratio + '@' + level.toUpperCase() + ' 长边 = 档位长边 ' + longSide + '（实际 ' + Math.max(box.width, box.height) + '）');
            ok((value > 1 ? box.width > box.height : (value < 1 ? box.height > box.width : box.width === box.height)),
                ratio + '@' + level.toUpperCase() + ' 方向没有被翻转（实际 ' + box.width + 'x' + box.height + '）');
        });
    });

    // ── 3. 极端窄高/极宽：短边碰 64px 下限时仍保住长边与方向 ────────────────────
    ok(classic.apiImageSize('custom', '1k', '1:32', '', FREE_MODEL) === '64x1536', '1:32@1K 短边落到 64px 下限（实际 ' + classic.apiImageSize('custom', '1k', '1:32', '', FREE_MODEL) + '）');
    ok(classic.apiImageSize('custom', '1k', '32:1', '', FREE_MODEL) === '1536x64', '32:1@1K 短边落到 64px 下限（实际 ' + classic.apiImageSize('custom', '1k', '32:1', '', FREE_MODEL) + '）');
    ok(classic.apiImageSize('custom', '4k', '1:32', '', FREE_MODEL) === '112x3840', '1:32@4K 长边仍是 3840（实际 ' + classic.apiImageSize('custom', '4k', '1:32', '', FREE_MODEL) + '）');

    // ── 4. 自定义尺寸（resolution=custom）的极小 / 极大 / 非法输入 ──────────────
    ok(classic.apiImageSize('square', 'custom', '', '64x64', FREE_MODEL) === '64x64', '自定义尺寸 64x64 原样放行');
    ok(classic.apiImageSize('square', 'custom', '', '16384x16384', FREE_MODEL) === '16384x16384', '自定义尺寸 16384x16384 原样放行（free 模型不夹）');
    ok(classic.apiImageSize('square', 'custom', '', '', FREE_MODEL) === '', '自定义尺寸为空时返回空串，不退化成某个档位');
    ok(classic.apiImageSize('square', 'auto', '', '', FREE_MODEL) === 'auto', "resolution=auto 直接返回 'auto'");

    // ── 5. 预置比例：1k/2k/4k 全矩阵 ─────────────────────────────────────────
    PRESET_KEYS.forEach(key => {
        API_RES_LEVELS.forEach(level => {
            const actual = classic.apiImageSize(key, level, '', '', FREE_MODEL);
            const smartActual = smart.apiImageSize(key, level, '', '', FREE_MODEL);
            const box = parseSize(actual);
            ok(!!box, '预置比例 ' + key + '@' + level + ' 能解析出像素（实际 ' + actual + '）');
            ok(actual === smartActual, '预置比例 ' + key + '@' + level + ' 经典/智能一致（经典 ' + actual + '，智能 ' + smartActual + '）');
        });
    });
    ok(classic.apiImageSize('square', '4k', '', '', FREE_MODEL) === '2880x2880', '预置 1:1@4K = 官方 2880x2880');
    ok(classic.apiImageSize('ultrawide', '4k', '', '', FREE_MODEL) === '3840x1648', '预置 21:9@4K 仍是 3840x1648');
    ok(classic.apiImageSize('ultratall', '4k', '', '', FREE_MODEL) === '1648x3840', '预置 9:21@4K 仍是 1648x3840');

    // ── 6. 经典 vs 智能：同一矩阵逐项一致（这是之前出过 bug 的地方）────────────
    let compared = 0;
    [ENUM_MODEL, FREE_MODEL].forEach(model => {
        PRESET_KEYS.forEach(key => {
            API_RES_LEVELS.forEach(level => {
                compared += 1;
                const c = classic.apiImageSize(key, level, '', '', model);
                const s = smart.apiImageSize(key, level, '', '', model);
                ok(c === s, '矩阵一致：model=' + model + ' ratio=' + key + ' ' + level + '（经典 ' + c + ' / 智能 ' + s + '）');
            });
        });
        CUSTOM_RATIO_CASES.forEach(([ratio]) => {
            API_RES_LEVELS.forEach(level => {
                compared += 1;
                const c = classic.apiImageSize('custom', level, ratio, '', model);
                const s = smart.apiImageSize('custom', level, ratio, '', model);
                ok(c === s, '矩阵一致：model=' + model + ' custom=' + ratio + ' ' + level + '（经典 ' + c + ' / 智能 ' + s + '）');
            });
        });
    });
    ok(compared === (PRESET_KEYS.length + CUSTOM_RATIO_CASES.length) * API_RES_LEVELS.length * 2,
        '一致性矩阵覆盖 ' + compared + ' 组 (模型 × 比例 × 档位)');
    console.log('[size-ratio] 经典 vs 智能逐项比对 ' + compared + ' 组');

    // ── 7. 档位缺失/非法时的兜底不变（不能抛异常、不能返回 undefined）──────────
    ok(classic.apiImageSize('custom', '8k', '1:1', '', FREE_MODEL) === '1024x1024',
        '未知档位按 1024 长边兜底（实际 ' + classic.apiImageSize('custom', '8k', '1:1', '', FREE_MODEL) + '）');
    ok(classic.apiImageSize('nonexistent-ratio', '1k', '', '', FREE_MODEL) === '1024x1024', '未知预置比例退回 square 1K');
    ok(classic.apiImageSize('custom', '1k', 'not-a-ratio', '', FREE_MODEL) === '1024x1024', '非法自定义比例退回 square 1K');

    console.log('[size-ratio] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
