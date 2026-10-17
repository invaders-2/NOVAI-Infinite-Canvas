#!/usr/bin/env node
// 生图尺寸「enum 吸附 / bounds 比例夹取」回归测试。
//
// 官方口径（developers.openai.com/api/reference/resources/images/methods/generate 与 .../edit）：
//   * gpt-image-2 系列支持任意 WIDTHxHEIGHT：宽高都要能被 16 整除、比例必须落在 1:3~3:1、最大 3840x2160。
//     → 21:9 / 9:21 这类官方允许的比例不能被静默吸成 3:2；只有超出 1:3~3:1 才夹比例，且必须有提示。
//   * gpt-image-1 系列官方只有 1024x1024 / 1536x1024 / 1024x1536 三张标准尺寸。
//     → 21:9 仍应吸附成 3:2（三张里最接近的横图），并且必须有提示。
//
// 复现的失效场景：
//   1) 21:9 在 gpt-image-2 被静默换成 3:2（官方其实允许 21:9）；
//   2) 1:1@4K 在 gpt-image-2 被 enum 吸成 2048x2048（官方 4K 方图是 2880x2880）；
//   3) 超出 1:3~3:1 的比例被静默改掉却没有提示；
//   4) 吸附发生在非受限平台（free/hintOnly）时把自由尺寸改掉。
//
// 差分证明（同一批用例接改前的 model_protocols.json：gpt-image-2 还是 8 尺寸 enum，应失败）：
//   NOVAI_SIZE_TEST_POLICY_SRC=/tmp/novai-official-a-evidence/backup/model_protocols.json \
//     node tests/test_api_image_size_enum_snap.js
//
// 运行：node tests/test_api_image_size_enum_snap.js
'use strict'
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLASSIC_SRC = process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || path.join(__dirname, '../static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_SIZE_TEST_SMART_SRC || path.join(__dirname, '../static/js/smart-canvas.js');
const BOUNDS_MODEL = 'gpt-image-2';
const ENUM_MODEL = 'gpt-image-1';
const FREE_MODEL = 'nano-banana-pro';
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
function modelPolicyTable(){
    const policyPath = process.env.NOVAI_SIZE_TEST_POLICY_SRC || path.join(__dirname, '../server/protocols/model_protocols.json');
    const protocols = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
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
    vm.runInContext('function tr(key){ return key; }', sandbox);
    vm.runInContext('globalThis.settings = {engine:"api", apiKind:"image", model:"gpt-image-2", ratio:"square", resolution:"1k"};', sandbox);
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(policyTable))) });
    const consts = [
        blockOf(sourceText, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(sourceText, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(sourceText, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(sourceText, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/),
        blockOf(sourceText, /const API_RATIO_LABELS = \{[^\n]*\};/)
    ];
    const names = ['parseSizeValue', 'parseRatioValue', 'gcdInt', 'apiImageSize', 'apiRatioLabel'];
    if(kind === 'classic'){
        consts.push('let models = {gpt:"gpt-image-2", nano:"nano-banana-pro"};');
        consts.push('let managedProviderId = "";');
        consts.push('function allImageModels(){ return []; }');
        names.push('resolveImageModel', 'sizePolicyFor', 'resPixelLimitFor');
    }else{
        names.push('resPixelLimitFor', 'apiRatioText', 'apiRatioSnap', 'apiRatioSnapNotice', 'apiRatioSnapNote',
            'apiRatioSnapForCurrentSettings', 'apiRatioSnapNoticeForCurrentSettings');
    }
    const body = consts.concat(names.map(name => topLevelFunction(sourceText, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-snap-sandbox.js' });
    return sandbox;
}

async function main(){
    const table = modelPolicyTable();
    const smart = buildSandbox(fs.readFileSync(SMART_SRC, 'utf8'), 'smart', table);
    const classic = buildSandbox(fs.readFileSync(CLASSIC_SRC, 'utf8'), 'classic', table);
    await vm.runInContext('NovaSizePolicy.load()', smart);
    await vm.runInContext('NovaSizePolicy.load()', classic);
    console.log('[size-snap] 经典画布源码 = ' + (process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || 'static/js/canvas.js'));

    // ── 0. 模式判定：gpt-image-2 = bounds（官方任意 W×H），gpt-image-1 = enum（官方 3 张标准尺寸）──
    const boundsPolicy = smart.NovaSizePolicy.policy(BOUNDS_MODEL);
    ok(boundsPolicy.mode === 'bounds', BOUNDS_MODEL + ' 策略是 bounds（实测 ' + boundsPolicy.mode + '）');
    ok(Math.abs(boundsPolicy.minRatio - 1 / 3) < 1e-9 && boundsPolicy.maxRatio === 3,
        BOUNDS_MODEL + ' 比例边界 = [1/3, 3]（实测 ' + boundsPolicy.minRatio + ' ~ ' + boundsPolicy.maxRatio + '）');
    ok(boundsPolicy.maxEdge === 3840 && boundsPolicy.multipleOf === 16,
        BOUNDS_MODEL + ' 最大边 3840、边长为 16 的倍数');
    ok(smart.NovaSizePolicy.policy(ENUM_MODEL).mode === 'enum', ENUM_MODEL + ' 仍是 enum');
    // 比例受限的 bounds 也会「实发比例 ≠ 选中比例」，吸附提示必须覆盖它，否则超范围比例会被静默夹取。
    ok(smart.NovaSizePolicy.isEnum(BOUNDS_MODEL) === true && smart.NovaSizePolicy.isEnum(FREE_MODEL) === false,
        '吸附提示闸门：bounds+比例范围算受限、free 不算');
    ok(smart.NovaSizePolicy.enumOptions(BOUNDS_MODEL) === null, BOUNDS_MODEL + ' 没有固定枚举表');
    const oneOptions = smart.NovaSizePolicy.enumOptions(ENUM_MODEL).filter(item => /^\d+x\d+$/.test(item));
    ok(oneOptions.length === 3 && oneOptions.includes('1536x1024'),
        ENUM_MODEL + ' 合法尺寸 = 3 张（' + oneOptions.join(',') + '）');

    // ── 1. gpt-image-2：官方允许的比例一律不吸附，且像素按官方 / bounds 口径 ────────────────
    const OFFICIAL_BOUNDS = [
        ['square', '1k', '1024x1024'],
        ['square', '2k', '2048x2048'],
        ['square', '4k', '2880x2880'],       // 官方 1:1@4K = 2880x2880（旧 enum 会吞成 2048x2048）
        ['wide', '1k', '1536x864'],          // 官方映射表 16:9 1k
        ['wide', '2k', '2048x1152'],
        ['wide', '4k', '3840x2160'],         // 官方上限 3840x2160
        ['ultrawide', '1k', '2016x864'],     // 21:9 官方允许，不能被吸附成 3:2
        ['ultrawide', '2k', '2688x1152'],
        ['ultrawide', '4k', '3840x1648'],
        ['ultratall', '1k', '864x2016'],     // 9:21 官方允许
        ['ultratall', '4k', '1648x3840'],
        ['portrait', '2k', '1360x2048'],
        ['landscape', '4k', '3520x2336']
    ];
    OFFICIAL_BOUNDS.forEach(([ratio, level, size]) => {
        const actual = smart.apiImageSize(ratio, level, '', '', BOUNDS_MODEL);
        ok(actual === size, BOUNDS_MODEL + ' ' + ratio + '@' + level.toUpperCase() + ' = ' + size + '（实际 ' + actual + '）');
        ok(smart.apiRatioSnap(BOUNDS_MODEL, ratio, level, '', '') === null,
            BOUNDS_MODEL + ' ' + ratio + '@' + level.toUpperCase() + ' 官方允许 → 不吸附、不提示');
        const classicSize = classic.apiImageSize(ratio, level, '', '', BOUNDS_MODEL);
        ok(classicSize === size, '经典画布 ' + ratio + '@' + level.toUpperCase() + ' = ' + size + '（实际 ' + classicSize + '）');
    });

    // 自定义比例在 1:3~3:1 内同样原样换算，不吸附
    ok(smart.apiImageSize('custom', '4k', '56:75', '', BOUNDS_MODEL) === '2480x3328',
        '自定义 56:75@4K = 2480x3328（实际 ' + smart.apiImageSize('custom', '4k', '56:75', '', BOUNDS_MODEL) + '）');
    ok(smart.apiRatioSnap(BOUNDS_MODEL, 'custom', '4k', '56:75', '') === null, '自定义 56:75@4K 比例未被改 → 不提示');
    ok(smart.apiRatioSnap(BOUNDS_MODEL, 'custom', 'custom', '', '16384x16384') === null,
        '自定义 16384x16384 收敛后仍是 1:1 → 不提示');
    ok(smart.apiImageSize('custom', '1k', '1:1', '', BOUNDS_MODEL) === '1536x1536',
        '自定义 1:1@1K = 1536x1536（bounds 不吸附档位）');
    ok(smart.apiImageSize('custom', '4k', '1:1', '', BOUNDS_MODEL) === '2880x2880', '自定义 1:1@4K = 2880x2880');

    // ── 2. 只有超出 1:3~3:1 才夹比例，且必须提示 ─────────────────────────────────────────
    const CLAMP_CASES = [
        ['custom', 'custom', '', '3840x1000', '2976x992', '3:1'],
        ['custom', '4k', '4:1', '', '2880x960', '3:1'],
        ['custom', '4k', '1:4', '', '960x2880', '1:3']
    ];
    CLAMP_CASES.forEach(([ratioKey, level, customRatio, customSize, size, snappedRatio]) => {
        const actual = smart.apiImageSize(ratioKey, level, customRatio, customSize, BOUNDS_MODEL);
        ok(actual === size, '超范围比例 ' + (customSize || customRatio) + '@' + level.toUpperCase() + ' 夹到 ' + size + '（实际 ' + actual + '）');
        const snap = smart.apiRatioSnap(BOUNDS_MODEL, ratioKey, level, customRatio, customSize);
        ok(!!snap && snap.size === size && snap.ratio === snappedRatio,
            '超范围比例 ' + (customSize || customRatio) + ' 必须判出吸附（实际 ' + JSON.stringify(snap) + '）');
        const notice = smart.apiRatioSnapNotice(BOUNDS_MODEL, ratioKey, level, customRatio, customSize);
        ok(notice.indexOf(BOUNDS_MODEL) === 0 && notice.indexOf('不支持') > 0 && notice.indexOf(snappedRatio) > 0,
            '超范围比例提示说清「模型 / 不支持 / 实际比例」：' + notice);
        const note = smart.apiRatioSnapNote(BOUNDS_MODEL, ratioKey, level, customRatio, customSize);
        ok(note.indexOf(size.replace('x', '×')) > 0, '超范围比例详细提示带实发像素：' + note);
    });

    // ── 3. gpt-image-1（官方 3 尺寸）：枚举吸附仍然成立，且必须有提示 ──────────────────────
    const ENUM_MUST_NOTICE = [
        ['ultrawide', '1k', '1536x1024', '3:2'],
        ['ultrawide', '4k', '1536x1024', '3:2'],
        ['landscape43', '2k', '1536x1024', '3:2'],
        ['wide', '1k', '1536x1024', '3:2'],
        ['portrait43', '1k', '1024x1536', '2:3'],
        ['ultratall', '4k', '1024x1536', '2:3']
    ];
    ENUM_MUST_NOTICE.forEach(([ratio, level, size, snappedRatio]) => {
        const snap = smart.apiRatioSnap(ENUM_MODEL, ratio, level, '', '');
        ok(!!snap, ENUM_MODEL + ' ' + ratio + '@' + level.toUpperCase() + ' 吸附必须被判出（返回非空）');
        if(!snap) return;
        ok(snap.size === size, ratio + '@' + level.toUpperCase() + ' 吸附落点 = ' + size + '（实际 ' + snap.size + '）');
        ok(snap.ratio === snappedRatio, ratio + '@' + level.toUpperCase() + ' 吸附后比例 = ' + snappedRatio + '（实际 ' + snap.ratio + '）');
        ok(oneOptions.includes(snap.size), ratio + '@' + level.toUpperCase() + ' 吸附落点属于官方 3 尺寸（' + snap.size + '）');
        const notice = smart.apiRatioSnapNotice(ENUM_MODEL, ratio, level, '', '');
        ok(notice.indexOf(ENUM_MODEL) === 0 && notice.indexOf('不支持') > 0 && notice.indexOf(snap.ratio) > 0,
            ratio + '@' + level.toUpperCase() + ' 提示文案说清「模型 / 不支持 / 实际比例」：' + notice);
        const note = smart.apiRatioSnapNote(ENUM_MODEL, ratio, level, '', '');
        ok(note.indexOf(snap.size.replace('x', '×')) > 0, ratio + '@' + level.toUpperCase() + ' 详细提示带实发像素：' + note);
    });
    // 用户选的比例真的被平台支持时不能误报
    ['square|1k', 'square|2k', 'square|4k', 'landscape|4k', 'portrait|4k'].forEach(item => {
        const [ratio, level] = item.split('|');
        ok(smart.apiRatioSnap(ENUM_MODEL, ratio, level, '', '') === null, ratio + '@' + level.toUpperCase() + ' 比例一致时不能误报吸附');
    });
    // gpt-image-1 任意比例都要落进官方 3 尺寸
    ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide', 'ultrawide', 'ultratall'].forEach(ratio => {
        API_RES_LEVELS.forEach(level => {
            const size = smart.apiImageSize(ratio, level, '', '', ENUM_MODEL);
            ok(oneOptions.includes(size), ENUM_MODEL + ' enum 实发尺寸合法：' + ratio + '@' + level.toUpperCase() + ' = ' + size);
        });
    });
    // gpt-image-2 实发尺寸必须在 bounds 内：16 的倍数、比例 ∈ [1/3,3]、边长 ≤ 3840、像素 ≤ 8294400
    ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide', 'ultrawide', 'ultratall'].forEach(ratio => {
        API_RES_LEVELS.forEach(level => {
            const text = smart.apiImageSize(ratio, level, '', '', BOUNDS_MODEL);
            const box = /^(\d+)x(\d+)$/.exec(text);
            const legal = !!box && Number(box[1]) % 16 === 0 && Number(box[2]) % 16 === 0
                && Number(box[1]) <= 3840 && Number(box[2]) <= 3840 && Number(box[1]) * Number(box[2]) <= 8294400
                && Number(box[1]) / Number(box[2]) >= 1 / 3 - 1e-9 && Number(box[1]) / Number(box[2]) <= 3 + 1e-9;
            ok(legal, BOUNDS_MODEL + ' bounds 实发尺寸合法：' + ratio + '@' + level.toUpperCase() + ' = ' + text);
        });
    });

    // ── 4. 非受限平台原样放行，snap 必须为 null ───────────────────────────────────────────
    ['square', 'portrait', 'wide', 'ultrawide', 'ultratall'].forEach(ratio => {
        API_RES_LEVELS.forEach(level => {
            ok(smart.apiRatioSnap(FREE_MODEL, ratio, level, '', '') === null,
                '非受限平台 ' + FREE_MODEL + ' ' + ratio + '@' + level.toUpperCase() + ' 不判定吸附');
        });
    });
    ok(smart.apiImageSize('ultrawide', '1k', '', '', FREE_MODEL) === '2016x864', '非受限平台 21:9@1K 原样放行 2016x864');
    ok(smart.apiImageSize('custom', '4k', '4:1', '', FREE_MODEL) === '3840x960', '非受限平台自定义 4:1@4K 原样 3840x960');
    ok(classic.apiImageSize('ultrawide', '1k', '', '', FREE_MODEL) === '2016x864', '经典画布非受限平台同样原样放行');

    // ── 5. 提示只对「API 生图」生效，视频/其它引擎不参与（行为不变）─────────────────────
    const setSettings = value => vm.runInContext('settings = ' + JSON.stringify(value) + ';', smart);
    setSettings({ engine: 'api', apiKind: 'image', model: BOUNDS_MODEL, ratio: 'custom', customRatio: '4:1', resolution: '4k', customSize: '' });
    ok(!!smart.apiRatioSnapForCurrentSettings(''), 'API 生图当前设置命中比例夹取');
    ok(smart.apiRatioSnapNoticeForCurrentSettings().indexOf('4:1') > 0, '当前设置提示里带用户选的比例：' + smart.apiRatioSnapNoticeForCurrentSettings());
    setSettings({ engine: 'api', apiKind: 'image', model: BOUNDS_MODEL, ratio: 'ultrawide', resolution: '1k', customRatio: '', customSize: '' });
    ok(smart.apiRatioSnapForCurrentSettings('') === null, '官方允许的 21:9 当前设置不再提示');
    ok(smart.apiRatioSnapForCurrentSettings('ms') === null, '带 prefix（ModelScope 通道）不参与 API 生图吸附');
    setSettings({ engine: 'api', apiKind: 'video', model: BOUNDS_MODEL, ratio: 'ultrawide', resolution: '1k' });
    ok(smart.apiRatioSnapForCurrentSettings('') === null, '视频通道不参与比例吸附');
    setSettings({ engine: 'comfyui', apiKind: 'image', model: BOUNDS_MODEL, ratio: 'custom', customRatio: '4:1', resolution: '1k' });
    ok(smart.apiRatioSnapForCurrentSettings('') === null, '非 API 引擎不参与比例吸附');

    console.log('[size-snap] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
