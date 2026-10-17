#!/usr/bin/env node
// 生图尺寸「自动降档不回弹」回归测试（经典 canvas.js + 智能 smart-canvas.js 共用同一批用例）。
//
// 复现的失效场景（用户显式档位被自动降档永久吞掉）：
//   1) gpt-image-2 选 wide @ 4K，实发 3840x2160；
//   2) 切到 square：4K 没有合法正方形尺寸，自动降档到 2K 并提示（降档本身是对的）；
//   3) 再把比例切回 wide：用户选的 4K 本应恢复，但修复前 settings.resolution / node.resolution
//      已经被 applySmartApiResolutionLimit / applyApiResolutionLimit 写成 2K，实发变成 2048x1152。
//
// 约定：自动降档只改「当前比例下的有效档位」（界面显示与本次请求都用它）；用户显式选过的档位
//       另记在 apiResolutionChoice，比例切回原值、原档位重新合法时自动还原，且还原不再重复弹降档提示。
//
// 差分证明（同一批用例接修复前的源码，应失败）：
//   git show HEAD:static/js/smart-canvas.js  > /tmp/novai-prefix-smart.js
//   git show HEAD:static/js/canvas.js        > /tmp/novai-prefix-canvas.js
//   NOVAI_SIZE_TEST_SMART_SRC=/tmp/novai-prefix-smart.js \
//   NOVAI_SIZE_TEST_CLASSIC_SRC=/tmp/novai-prefix-canvas.js \
//   node tests/test_api_image_size_sticky.js
//
// 运行：node tests/test_api_image_size_sticky.js
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
// gpt-image-2 官方口径是任意 W×H（bounds：边长 /16、比例 1:3~3:1、上限 3840x2160），不再是固定枚举，
// 也就不会再触发 enum 降档。本用例专门锁「enum 自动降档不吞用户档位」这套机制，所以用旧的 8 尺寸 enum
// 策略做夹具（机制与断言都不变）；真实 gpt-image-2 的 bounds 行为在文件末尾单独校验。
const ENUM_FIXTURE = {
    mode: 'enum',
    autoSize: true,
    prefer: 'ratio',
    options: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'],
    maxEdge: 3840,
    maxPixels: 8294400,
    minPixels: 655360,
    multipleOf: 16,
    tiers: [{ id: '1k', maxPixels: 1572864 }, { id: '2k', maxPixels: 4194304 }, { id: '4k', maxPixels: 8294400 }]
};
const ENUM_MODEL = 'novai-enum-fixture';
const BOUNDS_MODEL = 'gpt-image-2';
const ENUM_1_MODEL = 'gpt-image-1';
const FREE_MODEL = 'nano-banana-pro';
const API_RES_LEVELS = ['1k', '2k', '4k'];
const REPEAT = 50;

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
        names.push('apiAllowsAuto', 'defaultSmartApiResolution', 'applySmartApiResolutionLimit');
    }
    const body = consts.concat(names.map(name => topLevelFunction(sourceText, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-sticky-sandbox.js' });
    return sandbox;
}

async function main(){
    const table = modelPolicyTable();
    table.models[ENUM_MODEL] = JSON.parse(JSON.stringify(ENUM_FIXTURE));
    const smartSrc = fs.readFileSync(SMART_SRC, 'utf8');
    const classicSrc = fs.readFileSync(CLASSIC_SRC, 'utf8');
    const smart = buildSandbox(smartSrc, 'smart', table);
    const classic = buildSandbox(classicSrc, 'classic', table);
    await vm.runInContext('NovaSizePolicy.load()', smart);
    await vm.runInContext('NovaSizePolicy.load()', classic);
    console.log('[size-sticky] 智能画布源码 = ' + (process.env.NOVAI_SIZE_TEST_SMART_SRC || 'static/js/smart-canvas.js'));
    console.log('[size-sticky] 经典画布源码 = ' + (process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || 'static/js/canvas.js'));

    // ── 0. 静态接线：手选档位必须写进 apiResolutionChoice，两套画布语义一致 ───────
    ok(/apiResolutionChoice = API_RES_LEVELS\.indexOf\(settings\.resolution\)/.test(smartSrc),
        '智能画布：手选档位写入 settings.apiResolutionChoice');
    ok(/apiResolutionChoice = API_RES_LEVELS\.indexOf\(node\.resolution\)/.test(classicSrc),
        '经典画布：手选档位写入 node.apiResolutionChoice');
    ok(/API_RES_LEVELS\.indexOf\(settings\.apiResolutionChoice\) >= 0 \? settings\.apiResolutionChoice : settings\.resolution/.test(topLevelFunction(smartSrc, 'applySmartApiResolutionLimit')),
        '智能画布：降档以 apiResolutionChoice 作为用户请求档位');
    ok(/API_RES_LEVELS\.indexOf\(node\.apiResolutionChoice\) >= 0 \? node\.apiResolutionChoice : node\.resolution/.test(topLevelFunction(classicSrc, 'applyApiResolutionLimit')),
        '经典画布：降档以 node.apiResolutionChoice 作为用户请求档位');

    const smartRun = code => vm.runInContext(code, smart);
    const smartSet = value => smartRun('settings = ' + JSON.stringify(value) + ';');
    const smartPick = level => smartRun('settings.resolution = ' + JSON.stringify(level) + '; settings.apiResolutionChoice = API_RES_LEVELS.indexOf(settings.resolution) >= 0 ? settings.resolution : "";');
    const smartSize = () => smart.apiImageSize(smart.settings.ratio, smart.settings.resolution, '', '', smart.settings.model);

    // ── 1. 智能画布：wide@4K → square 降档 → 切回 wide 还原 4K ─────────────────
    smartSet({ engine:'api', apiKind:'image', model:ENUM_MODEL, ratio:'wide', resolution:'4k', customRatio:'', customSize:'', apiResolutionChoice:'' });
    smartPick('4k');
    ok(smart.settings.resolution === '4k', '智能画布 用户手选 wide@4K，档位 = 4K');
    ok(smart.apiImageSize('wide', '4k', '', '', ENUM_MODEL) === '3840x2160', '智能画布 wide@4K 映射 = 3840x2160');
    ok(smart.applySmartApiResolutionLimit() === '', '智能画布 wide@4K 合法：不降档、不提示');

    smartRun('settings.ratio = "square";');
    const squareNotice = smart.applySmartApiResolutionLimit();
    ok(squareNotice.indexOf('4K') > 0 && squareNotice.indexOf('2K') > 0, '智能画布 square@4K 降档提示保留：' + squareNotice);
    ok(smart.settings.resolution === '2k', '智能画布 square 有效档位 = 2K（实际 ' + smart.settings.resolution + '）');
    ok(smart.settings.apiResolutionChoice === '4k', '智能画布 降档后用户档位仍是 4K（实际 ' + smart.settings.apiResolutionChoice + '）');
    ok(smart.apiResolutionNote(ENUM_MODEL, 'square', smart.settings.resolution, '') === '',
        '智能画布 square 界面显示档位就是有效档位（不出现显示 4K、按 2K 出）');

    smartRun('settings.ratio = "wide";');
    const backNotice = smart.applySmartApiResolutionLimit();
    ok(backNotice === '', '智能画布 切回 wide 不重复弹降档提示（实际 "' + backNotice + '"）');
    ok(smart.settings.resolution === '4k', '智能画布 切回 wide 自动还原用户档位 4K（实际 ' + smart.settings.resolution + '）');
    ok(smart.settings.apiResolutionChoice === '4k', '智能画布 切回 wide 用户档位仍是 4K');
    ok(smartSize() === '3840x2160', '智能画布 切回 wide 实发回到 4K 映射 3840x2160（实际 ' + smartSize() + '）');

    // ── 2. 智能画布：降档收敛到不动点，不会越降越低 ─────────────────────────────
    smartRun('settings.ratio = "square";');
    smart.applySmartApiResolutionLimit();
    const smartLanded = smart.settings.resolution;
    let smartStable = true;
    for(let i = 0; i < REPEAT; i++){
        if(smart.applySmartApiResolutionLimit() !== '') smartStable = false;
        if(smart.settings.resolution !== smartLanded) smartStable = false;
    }
    ok(smartStable, '智能画布 降档后重复 ' + REPEAT + ' 次是不动点（保持 ' + smartLanded + '）');

    // ── 3. 智能画布：用户在 square 上明确改选 2K，切回 wide 不应再还原成 4K ──────
    smartPick('2k');
    smartRun('settings.ratio = "wide";');
    const afterPick = smart.applySmartApiResolutionLimit();
    ok(afterPick === '' && smart.settings.resolution === '2k', '智能画布 用户改成 2K 后切回 wide 保持 2K（实际 ' + smart.settings.resolution + '）');
    ok(smartSize() === '2048x1152', '智能画布 wide@2K = 2048x1152（实际 ' + smartSize() + '）');

    // ── 4. 智能画布：换模型降档、换回原模型自动还原 4K ───────────────────────────
    smartSet({ engine:'api', apiKind:'image', model:ENUM_MODEL, ratio:'wide', resolution:'4k', customRatio:'', customSize:'', apiResolutionChoice:'4k' });
    smart.applySmartApiResolutionLimit();
    smartRun('settings.model = ' + JSON.stringify(ENUM_1_MODEL) + ';');
    const oneNotice = smart.applySmartApiResolutionLimit();
    ok(!!oneNotice && smart.settings.resolution === '1k', '智能画布 换成 gpt-image-1 wide@4K 降到 1K：' + oneNotice);
    ok(smart.settings.apiResolutionChoice === '4k', '智能画布 换模型降档后用户档位仍是 4K');
    smartRun('settings.model = ' + JSON.stringify(ENUM_MODEL) + ';');
    const reNotice = smart.applySmartApiResolutionLimit();
    ok(reNotice === '' && smart.settings.resolution === '4k', '智能画布 换回 gpt-image-2 自动还原 4K（实际 ' + smart.settings.resolution + '）');

    // ── 5. 智能画布：旧存档没有 apiResolutionChoice 时也要能还原 ─────────────────
    smartSet({ engine:'api', apiKind:'image', model:ENUM_MODEL, ratio:'square', resolution:'4k', customRatio:'', customSize:'' });
    const legacyNotice = smart.applySmartApiResolutionLimit();
    ok(!!legacyNotice && smart.settings.resolution === '2k' && smart.settings.apiResolutionChoice === '4k',
        '智能画布 旧存档无 choice 时降档会补记 4K（实际 choice=' + smart.settings.apiResolutionChoice + '）');
    smartRun('settings.ratio = "wide";');
    smart.applySmartApiResolutionLimit();
    ok(smart.settings.resolution === '4k' && smartSize() === '3840x2160', '智能画布 旧存档切回 wide 也能还原 4K');

    // ── 6. 智能画布：非 enum 平台不降档，档位原样保留 ────────────────────────────
    smartSet({ engine:'api', apiKind:'image', model:FREE_MODEL, ratio:'square', resolution:'4k', customRatio:'', customSize:'', apiResolutionChoice:'4k' });
    ok(smart.applySmartApiResolutionLimit() === '' && smart.settings.resolution === '4k', '智能画布 非 enum 平台不降档，档位保持 4K');

    // ── 7. 经典画布：同一条 wide@4K → square → wide 路径 ────────────────────────
    const node = { model:ENUM_MODEL, ratio:'wide', resolution:'4k', customRatio:'', apiResolutionChoice:'4k' };
    ok(classic.apiImageSize('wide', '4k', '', '', ENUM_MODEL) === '3840x2160', '经典画布 wide@4K 映射 = 3840x2160');
    ok(classic.applyApiResolutionLimit(node) === '', '经典画布 wide@4K 合法：不降档、不提示');
    node.ratio = 'square';
    const cSquareNotice = classic.applyApiResolutionLimit(node);
    ok(cSquareNotice.indexOf('4K') > 0 && cSquareNotice.indexOf('2K') > 0, '经典画布 square@4K 降档提示保留：' + cSquareNotice);
    ok(node.resolution === '2k', '经典画布 square 有效档位 = 2K（实际 ' + node.resolution + '）');
    ok(node.apiResolutionChoice === '4k', '经典画布 降档后用户档位仍是 4K');
    ok(classic.apiResolutionNote(ENUM_MODEL, 'square', node.resolution, '') === '',
        '经典画布 square 界面显示档位就是有效档位');
    node.ratio = 'wide';
    const cBackNotice = classic.applyApiResolutionLimit(node);
    ok(cBackNotice === '', '经典画布 切回 wide 不重复弹降档提示（实际 "' + cBackNotice + '"）');
    ok(node.resolution === '4k' && node.apiResolutionChoice === '4k', '经典画布 切回 wide 自动还原用户档位 4K（实际 ' + node.resolution + '）');
    ok(classic.apiImageSize('wide', node.resolution, '', '', ENUM_MODEL) === '3840x2160',
        '经典画布 切回 wide 实发回到 4K 映射 3840x2160');

    // ── 8. 经典画布：降档不动点 + 用户改选 2K 后保持 2K ─────────────────────────
    node.ratio = 'square';
    classic.applyApiResolutionLimit(node);
    const classicLanded = node.resolution;
    let classicStable = true;
    for(let i = 0; i < REPEAT; i++){
        if(classic.applyApiResolutionLimit(node) !== '') classicStable = false;
        if(node.resolution !== classicLanded) classicStable = false;
    }
    ok(classicStable, '经典画布 降档后重复 ' + REPEAT + ' 次是不动点（保持 ' + classicLanded + '）');
    node.resolution = '2k';
    node.apiResolutionChoice = '2k';
    node.ratio = 'wide';
    classic.applyApiResolutionLimit(node);
    ok(node.resolution === '2k', '经典画布 用户改成 2K 后切回 wide 保持 2K');
    ok(classic.apiImageSize('wide', node.resolution, '', '', ENUM_MODEL) === '2048x1152', '经典画布 wide@2K = 2048x1152');

    // ── 9. 经典画布：旧存档没有 apiResolutionChoice 时也要能还原 ─────────────────
    const legacyNode = { model:ENUM_MODEL, ratio:'square', resolution:'4k', customRatio:'' };
    const lNotice = classic.applyApiResolutionLimit(legacyNode);
    ok(!!lNotice && legacyNode.resolution === '2k' && legacyNode.apiResolutionChoice === '4k',
        '经典画布 旧存档无 choice 时降档会补记 4K');
    legacyNode.ratio = 'wide';
    classic.applyApiResolutionLimit(legacyNode);
    ok(legacyNode.resolution === '4k' && classic.apiImageSize('wide', legacyNode.resolution, '', '', ENUM_MODEL) === '3840x2160',
        '经典画布 旧存档切回 wide 也能还原 4K');

    // ── 10. 真实 gpt-image-2（bounds）：官方允许的尺寸不该进降档流程 ─────────────────
    smartSet({ engine:'api', apiKind:'image', model:BOUNDS_MODEL, ratio:'square', resolution:'4k', customRatio:'', customSize:'', apiResolutionChoice:'' });
    ok(smart.applySmartApiResolutionLimit() === '' && smart.settings.resolution === '4k',
        '智能画布 gpt-image-2 1:1@4K 是官方合法尺寸，不降档（实际 ' + smart.settings.resolution + '）');
    ok(smartSize() === '2880x2880', '智能画布 gpt-image-2 1:1@4K = 2880x2880（实际 ' + smartSize() + '）');
    smartRun('settings.ratio = "ultrawide";');
    ok(smart.applySmartApiResolutionLimit() === '' && smart.settings.resolution === '4k',
        '智能画布 gpt-image-2 21:9@4K 官方允许，不降档');
    ok(smartSize() === '3840x1648', '智能画布 gpt-image-2 21:9@4K = 3840x1648（实际 ' + smartSize() + '）');
    const boundsNode = { model:BOUNDS_MODEL, ratio:'square', resolution:'4k', customRatio:'', apiResolutionChoice:'' };
    ok(classic.applyApiResolutionLimit(boundsNode) === '' && boundsNode.resolution === '4k',
        '经典画布 gpt-image-2 1:1@4K 不降档');
    ok(classic.apiImageSize('square', '4k', '', '', BOUNDS_MODEL) === '2880x2880',
        '经典画布 gpt-image-2 1:1@4K = 2880x2880');

    console.log('[size-sticky] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
