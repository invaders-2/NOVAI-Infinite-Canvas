#!/usr/bin/env node
// 生图尺寸「分辨率漂移 / 幂等」回归测试。
//
// 复现的失效场景：
//  1) 同一 (比例, 档位, 模型) 反复计算，实发尺寸本应恒定（不允许隐藏状态累积偏移）；
//  2) 反复「切比例 → 切档位 → 切回原值」后实发尺寸回不到原值（累积漂移）；
//  3) 档位被 applyApiResolutionLimit / applySmartApiResolutionLimit 自动下调后越降越低；
//  4) 自动下调把清晰度悄悄降了（同一张图在降档前后实发尺寸变化）。
//
// 约定：apiImageSize / NovaSizePolicy.constrain 是纯函数（同一输入恒等），
// 档位自动下调只发生在「该档位与该比例下没有更高清尺寸」时，且下调后实发尺寸不变；
// 下调收敛到不动点，重复调用不再继续降档。
//
// 运行：node tests/test_api_image_size_drift.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const REPS = 50;

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLASSIC_SRC = process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || path.join(__dirname, '../static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_SIZE_TEST_SMART_SRC || path.join(__dirname, '../static/js/smart-canvas.js');
const ENUM_MODEL = 'gpt-image-2';
const ENUM_1_MODEL = 'gpt-image-1';
const FREE_MODEL = 'nano-banana-pro';
const MODELS = [ENUM_MODEL, ENUM_1_MODEL, FREE_MODEL];
const API_RES_LEVELS = ['1k', '2k', '4k'];
const PRESET_KEYS = ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide', 'ultrawide', 'ultratall'];
const CUSTOM_RATIOS = ['1:10', '10:1', '56:75', '75:56', '21:9', '9:21', '2:3', '3:2', '1:1'];

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
    vm.runInContext('function tr(key){ return key; }', sandbox);
    vm.runInContext('globalThis.settings = {engine:"api", apiKind:"image", model:"gpt-image-2", ratio:"square", resolution:"1k"};', sandbox);
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(policyTable))) });
    const consts = [
        blockOf(sourceText, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(sourceText, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(sourceText, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(sourceText, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/),
        blockOf(sourceText, /const API_RATIO_LABELS = \{[^\n]*\};/),
        blockOf(sourceText, /const GEMINI_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(sourceText, /const SEEDREAM_RATIO_KEYS = \[[^\]]*\];/),
        blockOf(sourceText, /const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/)
    ];
    const names = ['parseSizeValue', 'parseRatioValue', 'gcdInt', 'modelCapabilityFor', 'imageResLevelsFor',
        'apiSizeTier', 'enumMaxSizeLevel', 'apiImageSize', 'apiRatioLabel', 'apiResolutionSupport', 'apiResolutionNote',
        'nearestApiResolution', 'apiResolutionChangeNotice'];
    names.push(kind === 'classic' ? 'sizePolicyFor' : 'resPixelLimitFor');
    if(kind === 'classic'){
        consts.push('let models = {gpt:"gpt-image-2", nano:"nano-banana-pro"};');
        consts.push('let managedProviderId = "";');
        consts.push('function allImageModels(){ return []; }');
        names.push('resolveImageModel', 'parseSizePair', 'resPixelLimitFor', 'applyApiResolutionLimit');
    }else{
        names.push('apiAllowsAuto', 'defaultSmartApiResolution', 'applySmartApiResolutionLimit', 'normalizeApiSizeSettings');
    }
    const body = consts.concat(names.map(name => topLevelFunction(sourceText, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-drift-sandbox.js' });
    return sandbox;
}

async function main(){
    const table = modelPolicyTable();
    const classic = buildSandbox(fs.readFileSync(CLASSIC_SRC, 'utf8'), 'classic', table);
    const smart = buildSandbox(fs.readFileSync(SMART_SRC, 'utf8'), 'smart', table);
    await vm.runInContext('NovaSizePolicy.load()', classic);
    await vm.runInContext('NovaSizePolicy.load()', smart);
    console.log('[size-drift] 经典画布源码 = ' + (process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || 'static/js/canvas.js'));

    const matrix = [];
    MODELS.forEach(model => {
        PRESET_KEYS.forEach(ratio => API_RES_LEVELS.forEach(level => matrix.push({ model, ratio, level, custom: '' })));
        CUSTOM_RATIOS.forEach(ratio => API_RES_LEVELS.forEach(level => matrix.push({ model, ratio, level, custom: ratio })));
    });

    // ── 1. 纯函数幂等：同一输入重复 50 次结果恒等 ───────────────────────────────
    let stableCount = 0;
    matrix.forEach(item => {
        const args = [item.custom ? 'custom' : item.ratio, item.level, item.custom, '', item.model];
        const expected = classic.apiImageSize.apply(null, args);
        const smartExpected = smart.apiImageSize.apply(null, args);
        let stable = true;
        for(let i = 0; i < REPS; i++){
            if(classic.apiImageSize.apply(null, args) !== expected) stable = false;
            if(smart.apiImageSize.apply(null, args) !== smartExpected) stable = false;
        }
        if(stable) stableCount += 1;
        else fails.push('幂等失败：model=' + item.model + ' ratio=' + (item.custom || item.ratio) + ' ' + item.level + ' 重复 ' + REPS + ' 次结果不恒定');
    });
    console.log('[size-drift] 幂等矩阵 ' + matrix.length + ' 组 × ' + REPS + ' 次');
    ok(stableCount === matrix.length, '幂等：' + stableCount + '/' + matrix.length + ' 组重复 ' + REPS + ' 次结果恒定');
    ok(matrix.length === MODELS.length * (PRESET_KEYS.length + CUSTOM_RATIOS.length) * API_RES_LEVELS.length,
        '幂等覆盖 ' + matrix.length + ' 组 (模型 × 比例 × 档位)');

    // ── 2. 档位循环：反复 1k→2k→4k→2k→1k，每档实发尺寸恒定 ─────────────────────
    const LEVEL_CYCLE = ['1k', '2k', '4k', '2k', '1k'];
    MODELS.forEach(model => {
        PRESET_KEYS.forEach(ratio => {
            const memo = {};
            API_RES_LEVELS.forEach(level => { memo[level] = classic.apiImageSize(ratio, level, '', '', model); });
            let healthy = true;
            for(let rep = 0; rep < REPS; rep++){
                LEVEL_CYCLE.forEach(level => {
                    if(classic.apiImageSize(ratio, level, '', '', model) !== memo[level]) healthy = false;
                });
            }
            ok(healthy, '档位循环不漂移：model=' + model + ' ratio=' + ratio);
        });
    });

    // ── 3. 「切比例 → 切档位 → 切回原值」循环 50 次后回到原值 ────────────────────
    MODELS.forEach(model => {
        [['portrait', '4k'], ['wide', '1k'], ['ultratall', '2k'], ['square', '4k']].forEach(([ratioA, levelA]) => {
            const original = classic.apiImageSize(ratioA, levelA, '', '', model);
            let returned = true;
            for(let i = 0; i < REPS; i++){
                // 切走
                classic.apiImageSize('square' === ratioA ? 'wide' : 'square', '1k', '', '', model);
                classic.apiImageSize('story', '2k', '', '', model);
                // 切回原值
                if(classic.apiImageSize(ratioA, levelA, '', '', model) !== original) returned = false;
            }
            ok(returned, '比例/档位往返回原值：model=' + model + ' ' + ratioA + '@' + levelA.toUpperCase() + ' = ' + original);
        });
    });

    // ── 4. 自定义比例同样往返不漂 ─────────────────────────────────────────────
    MODELS.forEach(model => {
        CUSTOM_RATIOS.forEach(ratio => {
            ['1k', '4k'].forEach(level => {
                const original = classic.apiImageSize('custom', level, ratio, '', model);
                let returned = true;
                for(let i = 0; i < REPS; i++){
                    classic.apiImageSize('custom', level === '4k' ? '2k' : '4k', ratio, '', model);
                    classic.apiImageSize('custom', level, ratio === '1:1' ? '2:3' : '1:1', '', model);
                    if(classic.apiImageSize('custom', level, ratio, '', model) !== original) returned = false;
                }
                ok(returned, '自定义比例往返不漂：model=' + model + ' ' + ratio + '@' + level.toUpperCase() + ' = ' + original);
            });
        });
    });

    // ── 5. 档位自动下调：收敛到不动点，且降档前后实发尺寸不变 ────────────────────
    const setSettings = value => vm.runInContext('settings = ' + JSON.stringify(value) + ';', smart);
    MODELS.forEach(model => {
        PRESET_KEYS.forEach(ratio => {
            setSettings({ engine: 'api', apiKind: 'image', model, ratio, resolution: '4k', customRatio: '', customSize: '' });
            const before = smart.apiImageSize(ratio, '4k', '', '', model);
            let steps = 0;
            while(steps < 6){
                if(!smart.applySmartApiResolutionLimit()) break;
                steps += 1;
            }
            const landed = smart.settings.resolution;
            const after = smart.apiImageSize(smart.settings.ratio, landed, '', '', model);
            ok(steps <= 2, '档位自动下调最多 2 步收敛：' + model + ' ' + ratio + '（实际 ' + steps + ' 步）');
            ok(after === before, '档位自动下调不降清晰度：' + model + ' ' + ratio + ' 降档 ' + before + ' → ' + after + '（落点 ' + landed + '）');
            // 不动点：重复 50 次不再变化
            let stable = true;
            for(let i = 0; i < REPS; i++){
                if(smart.applySmartApiResolutionLimit() !== '') stable = false;
                if(smart.settings.resolution !== landed) stable = false;
            }
            ok(stable, '档位下调后是不动点：' + model + ' ' + ratio + ' 保持 ' + landed + '，重复 ' + REPS + ' 次不再降档');
        });
    });
    // gpt-image-1 只有 1K 有实际尺寸：4K / 2K 都必须被拉回 1K，且实发尺寸不变
    setSettings({ engine: 'api', apiKind: 'image', model: ENUM_1_MODEL, ratio: 'wide', resolution: '4k' });
    const oneBefore = smart.apiImageSize('wide', '4k', '', '', ENUM_1_MODEL);
    smart.applySmartApiResolutionLimit();
    ok(smart.settings.resolution === '1k', ENUM_1_MODEL + ' wide@4K 自动落到 1K（实际 ' + smart.settings.resolution + '）');
    ok(smart.apiImageSize('wide', smart.settings.resolution, '', '', ENUM_1_MODEL) === oneBefore,
        ENUM_1_MODEL + ' 降档前后实发尺寸不变（' + oneBefore + '）');

    // ── 6. 降档后再次计算的稳定性：同一 (比例, 降档后档位) 恒等 ──────────────────
    // gpt-image-2 官方改为任意 W×H（bounds）后 1:1@4K 本来就合法（2880x2880），不会再降档；
    // 这里用仍是 enum 的 gpt-image-1（官方只有 3 张标准尺寸）锁「降档后稳定」的机制。
    setSettings({ engine: 'api', apiKind: 'image', model: ENUM_1_MODEL, ratio: 'square', resolution: '4k' });
    const downgradeNotice = smart.applySmartApiResolutionLimit();
    ok(!!downgradeNotice && smart.settings.resolution === '1k', ENUM_1_MODEL + ' square@4K 自动落到 1K：' + downgradeNotice);
    const stableSize = smart.apiImageSize('square', smart.settings.resolution, '', '', ENUM_1_MODEL);
    let stableOk = true;
    for(let i = 0; i < REPS; i++){ if(smart.apiImageSize('square', '1k', '', '', ENUM_1_MODEL) !== stableSize) stableOk = false; }
    ok(stableOk, '降档后同档位重复计算恒等（' + stableSize + '）');
    // 在降档后的档位上再切比例，实发尺寸仍必须是该平台合法枚举，且不继续往下降
    const legal = smart.NovaSizePolicy.enumOptions(ENUM_1_MODEL).filter(item => /^\d+x\d+$/.test(item));
    let legalOk = true;
    let floorOk = true;
    PRESET_KEYS.forEach(ratio => {
        const size = smart.apiImageSize(ratio, '1k', '', '', ENUM_1_MODEL);
        if(!legal.includes(size)) legalOk = false;
        if(API_RES_LEVELS.indexOf(smart.settings.resolution) < 0) floorOk = false;
    });
    ok(legalOk, '降档后各比例实发尺寸仍是平台合法枚举');
    ok(floorOk, '降档不会把档位降成非法值');
    // gpt-image-2 官方 bounds：1:1@4K = 2880x2880 本来就合法，不降档
    setSettings({ engine: 'api', apiKind: 'image', model: ENUM_MODEL, ratio: 'square', resolution: '4k' });
    ok(smart.applySmartApiResolutionLimit() === '' && smart.settings.resolution === '4k',
        'gpt-image-2 bounds：1:1@4K 不降档（实际 ' + smart.settings.resolution + '）');
    ok(smart.apiImageSize('square', '4k', '', '', ENUM_MODEL) === '2880x2880',
        'gpt-image-2 1:1@4K = 2880x2880（官方 4K 方图口径）');

    // ── 7. nearestApiResolution：有更低可用档时不能往上跳 ────────────────────────
    MODELS.forEach(model => {
        PRESET_KEYS.forEach(ratio => {
            const info = smart.apiResolutionSupport(model, ratio);
            API_RES_LEVELS.forEach(level => {
                const target = smart.nearestApiResolution(model, ratio, level);
                const levelIndex = API_RES_LEVELS.indexOf(level);
                const hasLower = info.supported.some(item => API_RES_LEVELS.indexOf(item) <= levelIndex);
                if(hasLower){
                    ok(API_RES_LEVELS.indexOf(target) <= levelIndex,
                        'nearest 不向上跳：' + model + ' ' + ratio + ' 请求 ' + level + ' → ' + target);
                }
                let stable = true;
                for(let i = 0; i < REPS; i++){ if(smart.nearestApiResolution(model, ratio, level) !== target) stable = false; }
                ok(stable, 'nearest 幂等：' + model + ' ' + ratio + ' ' + level + ' → ' + target);
            });
        });
    });

    // ── 8. 经典画布 applyApiResolutionLimit：同样的不动点语义 ─────────────────────
    MODELS.forEach(model => {
        PRESET_KEYS.forEach(ratio => {
            const node = { model, ratio, resolution: '4k', customRatio: '' };
            const before = classic.apiImageSize(ratio, '4k', '', '', model);
            let steps = 0;
            while(steps < 6){ if(!classic.applyApiResolutionLimit(node)) break; steps += 1; }
            const after = classic.apiImageSize(node.ratio, node.resolution, '', '', model);
            ok(steps <= 2, '经典画布档位下调最多 2 步收敛：' + model + ' ' + ratio + '（' + steps + ' 步）');
            ok(after === before, '经典画布档位下调不降清晰度：' + model + ' ' + ratio + ' ' + before + ' → ' + after);
            let stable = true;
            for(let i = 0; i < REPS; i++){ if(classic.applyApiResolutionLimit(node) !== '') stable = false; }
            ok(stable, '经典画布档位下调后是不动点：' + model + ' ' + ratio);
        });
    });

    console.log('[size-drift] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
