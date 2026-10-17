#!/usr/bin/env node
// gpt-image-2 官方尺寸口径（bounds：任意 W×H）专项用例。
//
// 官方原文（https://developers.openai.com/api/reference/resources/images/methods/generate，text/openai_images_generate.txt:623）：
//   "For gpt-image-2 ... arbitrary resolutions are supported as WIDTHxHEIGHT strings, for example 1536x864.
//    Width and height must both be divisible by 16 and the requested aspect ratio must be between 1:3 and 3:1.
//    Resolutions above 2560x1440 are experimental, and the maximum supported resolution is 3840x2160."
// 官方 API 参考页没有公布最小像素数（只写 must also satisfy the model current pixel and edge limits），
// 所以 minPixels=655360 保留原值、属于「官方未公布、未核对」，本用例只锁它没被凭空改动。
//
// 差分证明（同一批用例接改前的 model_protocols.json：gpt-image-2 还是 8 尺寸 enum，应大面积失败）：
//   NOVAI_SIZE_TEST_POLICY_SRC=/tmp/novai-official-a-evidence/backup/model_protocols.json \
//     node tests/test_api_image_size_bounds.js
//
// 运行：node tests/test_api_image_size_bounds.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLASSIC_SRC = process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || path.join(__dirname, '../static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_SIZE_TEST_SMART_SRC || path.join(__dirname, '../static/js/smart-canvas.js');
const POLICY_SRC = process.env.NOVAI_SIZE_TEST_POLICY_SRC || path.join(__dirname, '../server/protocols/model_protocols.json');
const BOUNDS_MODEL = 'gpt-image-2';
const ENUM_MODEL = 'gpt-image-1';
const API_RES_LEVELS = ['1k', '2k', '4k'];

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
function policyTable(){
    const protocols = JSON.parse(fs.readFileSync(POLICY_SRC, 'utf8'));
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
function buildSmart(policy){
    const src = fs.readFileSync(SMART_SRC, 'utf8');
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(read('static/js/shared/size-policy.js'), sandbox);
    vm.runInContext('globalThis.NovaSizePolicy = window.NovaSizePolicy;', sandbox);
    vm.runInContext('function tr(key){ return key; }', sandbox);
    vm.runInContext('globalThis.settings = {engine:"api", apiKind:"image", model:"gpt-image-2", ratio:"square", resolution:"1k"};', sandbox);
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(policy))) });
    const consts = [
        blockOf(src, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(src, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(src, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(src, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/),
        blockOf(src, /const API_RATIO_LABELS = \{[^\n]*\};/)
    ];
    const names = ['parseSizeValue', 'parseRatioValue', 'gcdInt', 'apiImageSize', 'resPixelLimitFor',
        'apiRatioText', 'apiRatioSnap', 'apiRatioSnapNotice', 'apiRatioSnapNote'];
    const body = consts.concat(names.map(name => topLevelFunction(src, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: 'bounds-sandbox.js' });
    return sandbox;
}

async function main(){
    const policy = JSON.parse(fs.readFileSync(POLICY_SRC, 'utf8'));
    const entry = policy.protocols.find(item => item.id === 'gpt-image-2-family');
    const size = entry && entry.size;
    ok(!!size, 'model_protocols.json 里有 gpt-image-2-family 的 size 块');

    // ── 1. 官方参数落表 ──────────────────────────────────────────────────────────
    ok(size.mode === 'bounds', 'gpt-image-2 是 bounds 模式（任意 W×H），实际 ' + size.mode);
    ok(size.maxEdge === 3840, '官方「maximum supported resolution is 3840x2160」→ maxEdge = 3840');
    ok(size.maxPixels === 8294400, 'maxPixels = 3840x2160 = 8294400');
    ok(size.multipleOf === 16, '官方「divisible by 16」→ multipleOf = 16');
    ok(Math.abs(size.minRatio - 1 / 3) < 1e-9 && size.maxRatio === 3, '官方「aspect ratio between 1:3 and 3:1」→ minRatio/maxRatio');
    ok(size.minPixels === 655360, '官方未公布 minPixels → 保留原值 655360（未核对，不凭空改）');
    ok(!entry.size.options, '不再带固定 options 枚举（官方语义是任意 W×H）');
    const enumEntry = policy.protocols.find(item => item.id === 'gpt-image-1-family');
    ok(enumEntry && enumEntry.size.mode === 'enum' && enumEntry.size.options.length === 3,
        'gpt-image-1 官方 3 个标准尺寸，保持 enum 不动');

    const smart = buildSmart(policyTable());
    await vm.runInContext('NovaSizePolicy.load()', smart);
    const imageSize = smart.apiImageSize;
    const snap = smart.apiRatioSnap;

    // ── 2. 官方举例与上限：原样换算，不再吸附 ────────────────────────────────────
    // 官方原文举例 1536x864；改前 enum 会把它吸成 1536x1024，所以这是最直接的差分点。
    ok(imageSize('custom', 'custom', '', '1536x864', BOUNDS_MODEL) === '1536x864',
        '官方举例 1536x864 原样放行（实际 ' + imageSize('custom', 'custom', '', '1536x864', BOUNDS_MODEL) + '）');
    ok(imageSize('custom', 'custom', '', '864x1536', BOUNDS_MODEL) === '864x1536', '官方举例 864x1536 原样放行');
    ok(snap(BOUNDS_MODEL, 'custom', 'custom', '', '1536x864') === null, '1536x864 比例未被改 → 不提示');

    ok(imageSize('square', '4k', '', '', BOUNDS_MODEL) === '2880x2880',
        '1:1@4K = 2880x2880（官方 4K 方图；改前被 enum 吞成 2048x2048）');
    ok(imageSize('wide', '4k', '', '', BOUNDS_MODEL) === '3840x2160', '16:9@4K = 3840x2160（官方上限）');
    ok(imageSize('wide', '2k', '', '', BOUNDS_MODEL) === '2048x1152', '16:9@2K = 2048x1152');
    ok(imageSize('wide', '1k', '', '', BOUNDS_MODEL) === '1536x864', '16:9@1K = 1536x864（官方映射表）');

    // ── 3. 21:9 / 9:21 官方允许，全档位不得吸附 ──────────────────────────────────
    [['1k', '2016x864'], ['2k', '2688x1152'], ['4k', '3840x1648']].forEach(([level, expected]) => {
        ok(imageSize('ultrawide', level, '', '', BOUNDS_MODEL) === expected,
            '21:9@' + level.toUpperCase() + ' = ' + expected + '（实际 ' + imageSize('ultrawide', level, '', '', BOUNDS_MODEL) + '）');
        ok(snap(BOUNDS_MODEL, 'ultrawide', level, '', '') === null, '21:9@' + level.toUpperCase() + ' 官方允许 → 不吸附、不提示');
    });
    [['1k', '864x2016'], ['2k', '1152x2688'], ['4k', '1648x3840']].forEach(([level, expected]) => {
        ok(imageSize('ultratall', level, '', '', BOUNDS_MODEL) === expected,
            '9:21@' + level.toUpperCase() + ' = ' + expected + '（实际 ' + imageSize('ultratall', level, '', '', BOUNDS_MODEL) + '）');
        ok(snap(BOUNDS_MODEL, 'ultratall', level, '', '') === null, '9:21@' + level.toUpperCase() + ' 官方允许 → 不吸附、不提示');
    });

    // ── 4. 只有超出 1:3~3:1 才夹比例，且必须提示 ────────────────────────────────
    const CLAMPS = [
        ['custom', 'custom', '', '3840x1000', '2976x992', '3:1'],
        ['custom', '4k', '4:1', '', '2880x960', '3:1'],
        ['custom', '4k', '1:4', '', '960x2880', '1:3']
    ];
    CLAMPS.forEach(([ratioKey, level, customRatio, customSize, expected, snappedRatio]) => {
        const actual = imageSize(ratioKey, level, customRatio, customSize, BOUNDS_MODEL);
        ok(actual === expected, '超范围比例 ' + (customSize || customRatio) + ' 夹到 ' + expected + '（实际 ' + actual + '）');
        const result = snap(BOUNDS_MODEL, ratioKey, level, customRatio, customSize);
        ok(!!result && result.size === expected && result.ratio === snappedRatio,
            '超范围比例 ' + (customSize || customRatio) + ' 必须提示吸附（实际 ' + JSON.stringify(result) + '）');
        const notice = smart.apiRatioSnapNotice(BOUNDS_MODEL, ratioKey, level, customRatio, customSize);
        ok(notice.indexOf(BOUNDS_MODEL) === 0 && notice.indexOf('不支持') > 0 && notice.indexOf(snappedRatio) > 0,
            '提示文案：' + notice);
    });
    // 官方允许范围内的极端比例一个都不能被夹
    [['3:1', '3840x1280'], ['1:3', '1280x3840'], ['2:1', '3840x1920'], ['1:2', '1920x3840']].forEach(([ratio, expected]) => {
        ok(imageSize('custom', '4k', ratio, '', BOUNDS_MODEL) === expected,
            ratio + '@4K = ' + expected + '（官方允许，实际 ' + imageSize('custom', '4k', ratio, '', BOUNDS_MODEL) + '）');
    });

    // ── 5. bounds 实发尺寸恒在官方范围内（全比例 × 全档位矩阵）─────────────────────
    const RATIOS = ['square', 'portrait12', 'landscape21', 'story', 'wide', 'portrait43', 'landscape43', 'landscape', 'portrait', 'landscape54', 'portrait45', 'ultrawide', 'ultratall'];
    let matrix = 0;
    RATIOS.forEach(ratio => {
        API_RES_LEVELS.forEach(level => {
            matrix += 1;
            const text = imageSize(ratio, level, '', '', BOUNDS_MODEL);
            const box = /^(\d+)x(\d+)$/.exec(text);
            const width = box ? Number(box[1]) : 0;
            const height = box ? Number(box[2]) : 0;
            ok(!!box && width % 16 === 0 && height % 16 === 0 && width <= 3840 && height <= 3840
                && width * height <= 8294400 && width / height >= 1 / 3 - 1e-9 && width / height <= 3 + 1e-9,
                'bounds 输出合法：' + ratio + '@' + level.toUpperCase() + ' = ' + text);
        });
    });
    ok(matrix === RATIOS.length * API_RES_LEVELS.length, '矩阵覆盖 ' + matrix + ' 组');

    // ── 6. gpt-image-1 未受影响：仍是官方 3 尺寸枚举 ─────────────────────────────
    const oneOptions = smart.NovaSizePolicy.enumOptions(ENUM_MODEL).filter(item => /^\d+x\d+$/.test(item));
    ok(oneOptions.length === 3, ENUM_MODEL + ' 仍是 3 个标准尺寸');
    ok(smart.apiImageSize('ultrawide', '1k', '', '', ENUM_MODEL) === '1536x1024',
        'gpt-image-1 21:9@1K 仍吸附成 3:2（1536x1024）');

    console.log('[size-bounds] 策略源 = ' + (process.env.NOVAI_SIZE_TEST_POLICY_SRC || 'server/protocols/model_protocols.json'));
    console.log('[size-bounds] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
