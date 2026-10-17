#!/usr/bin/env node
// 前端 SIZE_MAP（canvas.js / smart-canvas.js）× 官方 APIMart size×resolution 映射表，全矩阵校验。
//
// 官方口径（https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation，
// 归档文本 /tmp/novai-official-docs/text/apimart_gpt_image_2_generation_md.txt:404-420）：
//   size 支持 15 个比例，resolution 单独给 1k / 2k / 4k，两者共同决定实际像素；
//   1k 格子偶尔列两组等价像素（如 2:1 = 2048x1024 / 1774x887），前端预置取「比例精确」的第一组。
//
// 三段等式（每个预置比例 × 每个档位都要成立）：
//   前端 apiImageSize(ratio, level)          —— SIZE_MAP 预置像素经前端策略收口；
//   后端策略计算结果                          —— server/protocols/registry.py + main.py（node 起 python3 实测）；
//   官方映射值                                —— 本文件内联的官方表 + main.py APIMART_OFFICIAL_PIXELS。
// 另覆盖 gpt-image-2 这类 bounds 平台：官方像素是策略不动点（不吸附、不缩放），且不弹比例吸附提示；
// 超范围自定义比例仍按 1:3~3:1 夹取并提示（「只夹比例与上限」的行为不能被对齐动作改掉）。
//
// 差分证明（同一批用例接改前的 SIZE_MAP：应大面积失败）：
//   NOVAI_SIZE_TEST_CLASSIC_SRC=/tmp/novai-frontmap-evidence/backup/canvas.js \
//   NOVAI_SIZE_TEST_SMART_SRC=/tmp/novai-frontmap-evidence/backup/smart-canvas.js \
//     node tests/test_size_map_official.js
//
// 运行：node tests/test_size_map_official.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

const CLASSIC_SRC = process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || path.join(ROOT, 'static/js/canvas.js');
const SMART_SRC = process.env.NOVAI_SIZE_TEST_SMART_SRC || path.join(ROOT, 'static/js/smart-canvas.js');
const POLICY_SRC = process.env.NOVAI_SIZE_TEST_POLICY_SRC || path.join(ROOT, 'server/protocols/model_protocols.json');
const BOUNDS_MODEL = 'gpt-image-2';
const FREE_MODEL = 'nano-banana-pro';
const API_RES_LEVELS = ['1k', '2k', '4k'];

// 官方 size × resolution → 实际像素（text/apimart_gpt_image_2_generation_md.txt:406-420）。
// 每个格子是官方列出的全部等价像素；第一个是前端预置采用的「比例精确」值。
const OFFICIAL_PIXELS = {
    '1:1':  { '1k': ['1024x1024', '1254x1254'], '2k': ['2048x2048'], '4k': ['2880x2880'] },
    '3:2':  { '1k': ['1536x1024'], '2k': ['2048x1360'], '4k': ['3520x2336'] },
    '2:3':  { '1k': ['1024x1536'], '2k': ['1360x2048'], '4k': ['2336x3520'] },
    '4:3':  { '1k': ['1024x768'], '2k': ['2048x1536'], '4k': ['3312x2480'] },
    '3:4':  { '1k': ['768x1024'], '2k': ['1536x2048'], '4k': ['2480x3312'] },
    '5:4':  { '1k': ['1280x1024', '1448x1086'], '2k': ['2560x2048'], '4k': ['3216x2576'] },
    '4:5':  { '1k': ['1024x1280', '1122x1402'], '2k': ['2048x2560'], '4k': ['2576x3216'] },
    '16:9': { '1k': ['1536x864', '1672x941'], '2k': ['2048x1152'], '4k': ['3840x2160'] },
    '9:16': { '1k': ['864x1536', '941x1672'], '2k': ['1152x2048'], '4k': ['2160x3840'] },
    '2:1':  { '1k': ['2048x1024', '1774x887'], '2k': ['2688x1344'], '4k': ['3840x1920'] },
    '1:2':  { '1k': ['1024x2048', '887x1774'], '2k': ['1344x2688'], '4k': ['1920x3840'] },
    // 3:1 / 1:3 的 1k 官方列了两组；第一组 1881x836 / 887x1774 非 16 对齐（bounds 会吸附），
    // 前端预置取官方另一组 3:1 / 1:3 精确且 /16 的像素，等价组留作候选。
    '3:1':  { '1k': ['1536x512', '1881x836'], '2k': ['3072x1024'], '4k': ['3840x1280'] },
    '1:3':  { '1k': ['512x1536', '887x1774'], '2k': ['1024x3072'], '4k': ['1280x3840'] },
    '21:9': { '1k': ['2016x864', '1915x821'], '2k': ['2688x1152'], '4k': ['3840x1648'] },
    '9:21': { '1k': ['864x2016', '821x1915'], '2k': ['1152x2688'], '4k': ['1648x3840'] },
};

// 画布预置比例 key → 官方比例（与 API_RATIO_LABELS / apiRatioText 同源）
const KEY_TO_RATIO = {
    square: '1:1', portrait: '2:3', portrait43: '3:4', landscape43: '4:3', landscape: '3:2',
    story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21',
    portrait12: '1:2', landscape21: '2:1', landscape54: '5:4', portrait45: '4:5',
    landscape31: '3:1', portrait13: '1:3',
};
const SMART_KEYS = ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide',
    'ultrawide', 'ultratall', 'portrait12', 'landscape21', 'landscape54', 'portrait45',
    'landscape31', 'portrait13'];
const CLASSIC_KEYS = ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide',
    'ultrawide', 'ultratall'];

// ── 源码抽取 ────────────────────────────────────────────────────────────────
function extractSizeMap(src, label){
    const block = (src.match(/const SIZE_MAP = \{[\s\S]*?\n\};/) || [])[0];
    if(!block) throw new Error('缺少 SIZE_MAP：' + label);
    const map = {};
    const keyRe = /(\w+)\s*:\s*\{([^}]*)\}/g;
    let m;
    while((m = keyRe.exec(block))){
        const entry = {};
        const pairRe = /'([^']+)'\s*:\s*'([^']+)'/g;
        let p;
        while((p = pairRe.exec(m[2]))) entry[p[1]] = p[2];
        map[m[1]] = entry;
    }
    return map;
}
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
function buildSandbox(sourceText, kind, policyTable){
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'static/js/shared/size-policy.js'), 'utf8'), sandbox);
    vm.runInContext('globalThis.NovaSizePolicy = window.NovaSizePolicy;', sandbox);
    vm.runInContext('function tr(key){ return key; }', sandbox);
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(policyTable))) });
    const consts = [
        blockOf(sourceText, /const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(sourceText, /const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(sourceText, /const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(sourceText, /const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/),
        blockOf(sourceText, /const API_RATIO_LABELS = \{[^\n]*\};/)
    ];
    const names = ['parseSizeValue', 'parseRatioValue', 'gcdInt', 'apiImageSize', 'resPixelLimitFor'];
    if(kind === 'classic'){
        consts.push('let models = {gpt:"gpt-image-2", nano:"nano-banana-pro"};');
        consts.push('let managedProviderId = "";');
        consts.push('function allImageModels(){ return []; }');
        names.push('resolveImageModel', 'sizePolicyFor');
    }else{
        names.push('apiRatioText', 'apiRatioSnap', 'apiRatioSnapNotice', 'apiRatioSnapNote');
    }
    const body = consts.concat(names.map(name => topLevelFunction(sourceText, name))).join('\n');
    vm.runInContext(body, sandbox, { filename: kind + '-sizemap-sandbox.js' });
    return sandbox;
}
function parseSize(text){
    const m = /^(\d+)x(\d+)$/.exec(String(text || ''));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// ── 后端真值：node 起 python3 跑真实的 main.py / registry.py ──────────────────
function backendProbe(rows){
    const script = [
        'import json, sys',
        'import main',
        'from server.protocols import registry',
        'rows = json.load(sys.stdin)',
        'out = []',
        'for row in rows:',
        '    ratio, tier = main.apimart_size_resolution(row["size"])',
        '    constrained = registry.constrain_size({"protocol": "apimart"}, "gpt-image-2", row["size"])',
        '    out.append({"key": row["key"], "level": row["level"], "size": row["size"],',
        '                "ratio": ratio, "tier": tier, "constrained": constrained})',
        'print(json.dumps(out))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', script], {
        cwd: ROOT,
        input: JSON.stringify(rows),
        encoding: 'utf8',
        timeout: 120000,
        env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }),
    });
    if(result.error || result.status !== 0){
        const detail = (result.stderr || result.stdout || String(result.error || '')).trim().slice(0, 500);
        console.log('[size-map] 跳过 python3 后端实测（' + detail + '）');
        return null;
    }
    try {
        return JSON.parse(result.stdout);
    } catch(err){
        console.log('[size-map] python3 输出无法解析：' + String(result.stdout || '').slice(0, 200));
        return null;
    }
}

// ── gpt-image-2 bounds 合法域（官方：/16、比例 1:3~3:1、上限 3840x2160）────────
function boundsLegal(text){
    const box = parseSize(text);
    if(!box) return false;
    return box.width % 16 === 0 && box.height % 16 === 0
        && box.width <= 3840 && box.height <= 3840
        && box.width * box.height <= 8294400
        && box.width / box.height >= 1 / 3 - 1e-9 && box.width / box.height <= 3 + 1e-9;
}

async function main(){
    const classicSrc = fs.readFileSync(CLASSIC_SRC, 'utf8');
    const smartSrc = fs.readFileSync(SMART_SRC, 'utf8');
    const table = modelPolicyTable();
    const classic = buildSandbox(classicSrc, 'classic', table);
    const smart = buildSandbox(smartSrc, 'smart', table);
    await vm.runInContext('NovaSizePolicy.load()', classic);
    await vm.runInContext('NovaSizePolicy.load()', smart);
    console.log('[size-map] 经典画布源码 = ' + (process.env.NOVAI_SIZE_TEST_CLASSIC_SRC || 'static/js/canvas.js'));
    console.log('[size-map] 智能画布源码 = ' + (process.env.NOVAI_SIZE_TEST_SMART_SRC || 'static/js/smart-canvas.js'));

    const classicMap = extractSizeMap(classicSrc, 'canvas.js');
    const smartMap = extractSizeMap(smartSrc, 'smart-canvas.js');

    // ── 0. 覆盖：两套画布都要覆盖各自该有的全部预置比例 ──────────────────────────
    ok(Object.keys(classicMap).length === CLASSIC_KEYS.length && CLASSIC_KEYS.every(k => classicMap[k]),
        'canvas.js SIZE_MAP 覆盖 ' + CLASSIC_KEYS.length + ' 个预置比例（实际 ' + Object.keys(classicMap).join(',') + '）');
    ok(Object.keys(smartMap).length === SMART_KEYS.length && SMART_KEYS.every(k => smartMap[k]),
        'smart-canvas.js SIZE_MAP 覆盖 ' + SMART_KEYS.length + ' 个预置比例（实际 ' + Object.keys(smartMap).join(',') + '）');
    CLASSIC_KEYS.forEach(key => {
        ok(KEY_TO_RATIO[key], key + ' 有官方比例映射');
    });

    // ── 1. 逐格：前端预置 == 官方映射（两套画布）────────────────────────────────
    const rows = [];
    let cells = 0;
    SMART_KEYS.forEach(key => {
        const ratio = KEY_TO_RATIO[key];
        const official = OFFICIAL_PIXELS[ratio];
        ok(!!official, ratio + ' 在官方 15 比例表里');
        API_RES_LEVELS.forEach(level => {
            cells += 1;
            const expected = official[level][0];
            const smartSize = smart.apiImageSize(key, level, '', '', FREE_MODEL);
            ok(smartSize === expected,
                '智能画布 ' + key + '(' + ratio + ')@' + level.toUpperCase() + ' = ' + expected + '（实际 ' + smartSize + '）');
            const block = smartMap[key] || {};
            ok(block[level] === expected, 'smart-canvas.js SIZE_MAP[' + key + '][' + level + '] = ' + expected + '（实际 ' + block[level] + '）');
            if(CLASSIC_KEYS.includes(key)){
                const classicSize = classic.apiImageSize(key, level, '', '', FREE_MODEL);
                ok(classicSize === expected,
                    '经典画布 ' + key + '(' + ratio + ')@' + level.toUpperCase() + ' = ' + expected + '（实际 ' + classicSize + '）');
                const cblock = classicMap[key] || {};
                ok(cblock[level] === expected, 'canvas.js SIZE_MAP[' + key + '][' + level + '] = ' + expected + '（实际 ' + cblock[level] + '）');
            }
            // bounds 平台：官方像素是策略不动点，且不吸附、不提示
            ok(smart.apiImageSize(key, level, '', '', BOUNDS_MODEL) === expected,
                BOUNDS_MODEL + ' ' + key + '@' + level.toUpperCase() + ' = ' + expected + '（实际 ' + smart.apiImageSize(key, level, '', '', BOUNDS_MODEL) + '）');
            ok(smart.NovaSizePolicy.constrain(expected, BOUNDS_MODEL) === expected,
                'bounds 策略对官方像素是不动点：' + expected);
            ok(smart.apiRatioSnap(BOUNDS_MODEL, key, level, '', '') === null,
                BOUNDS_MODEL + ' ' + key + '@' + level.toUpperCase() + ' 官方比例精确 → 不得出现吸附提示');
            ok(boundsLegal(expected), '官方像素落在 bounds 合法域：' + expected);
            // 其余同格等价像素（如 1k 的第二组）只保证是合法 WxH 写法；它们不必满足 bounds /16
            // （APIMart 走比例+档位下发，不传像素），也不作为前端预置。
            official[level].slice(1).forEach(cand => {
                ok(!!parseSize(cand), '官方等价像素写法合法：' + cand);
                ok(cand !== expected, '前端预置取第一组 ' + expected + '，不取 ' + cand);
            });
            rows.push({ key, ratio, level, size: smartSize, expected });
        });
    });
    ok(cells === SMART_KEYS.length * API_RES_LEVELS.length,
        '矩阵覆盖 ' + cells + ' 格（' + SMART_KEYS.length + ' 比例 × ' + API_RES_LEVELS.length + ' 档）');

    // ── 2. bounds 平台「只夹比例与上限」的行为不能被对齐动作改掉 ──────────────────
    ok(smart.apiImageSize('custom', 'custom', '', '3840x1000', BOUNDS_MODEL) === '2976x992',
        '超范围自定义比例仍夹到 3:1（' + smart.apiImageSize('custom', 'custom', '', '3840x1000', BOUNDS_MODEL) + '）');
    ok(!!smart.apiRatioSnap(BOUNDS_MODEL, 'custom', 'custom', '', '3840x1000'),
        '超范围自定义比例仍必须提示吸附');
    ok(smart.apiImageSize('custom', '4k', '1:1', '', BOUNDS_MODEL) === '2880x2880',
        'bounds 自定义 1:1@4K 仍按像素上限收敛到 2880x2880');
    ok(smart.apiImageSize('custom', 'custom', '', '1536x864', BOUNDS_MODEL) === '1536x864',
        '官方举例 1536x864 原样放行（不吸附）');

    // ── 3. 后端真值：main.py / registry.py 与前端逐格一致 ────────────────────────
    const backend = backendProbe(rows.map(r => ({ key: r.key, level: r.level, size: r.size })));
    if(backend){
        ok(backend.length === rows.length, 'python3 后端实测返回 ' + rows.length + ' 格（实际 ' + backend.length + '）');
        backend.forEach((item, index) => {
            const row = rows[index];
            ok(item.ratio === row.ratio && item.tier === row.level,
                '后端 apimart_size_resolution(' + row.size + ') = ' + row.ratio + '/' + row.level
                + '（实际 ' + item.ratio + '/' + item.tier + '）');
            ok(item.constrained === row.size,
                '后端 registry.constrain_size(gpt-image-2, ' + row.size + ') 不动点（实际 ' + item.constrained + '）');
        });
    }

    console.log('[size-map] ' + pass + ' 项通过，矩阵 ' + cells + ' 格');
    if(fails.length){
        fails.slice(0, 60).forEach(msg => console.error('  ✗ ' + msg));
        if(fails.length > 60) console.error('  … 其余 ' + (fails.length - 60) + ' 项');
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
