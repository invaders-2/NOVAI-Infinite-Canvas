#!/usr/bin/env node
// 第三份策略副本（web/src/pages/online/sizePolicy.js）与 static/js/shared/size-policy.js 的逐项 parity。
//
// 阶段 A 给 shared/size-policy.js 加了 minRatio/maxRatio（bounds 比例夹取），但 web 副本没同步，
// 导致在线生图页面对 gpt-image-2 这类「带比例范围的 bounds」不做夹取、也不弹吸附提示。
// 本用例用同一份策略表喂两份实现，逐格比对 constrain / isEnum：
//   - 改前的 web 副本会在超范围比例上给出 3840x1000 → 3840x992（不夹比例）；
//   - 改后应与 static 完全一致：3840x1000 → 2976x992，且 isEnum 返回 true。
//
// 运行：node tests/test_size_policy_web_parity.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

const ROOT = path.join(__dirname, '..');
const STATIC_SRC = process.env.NOVAI_SIZE_TEST_POLICY_SRC || path.join(ROOT, 'static/js/shared/size-policy.js');
const WEB_SRC = process.env.NOVAI_SIZE_TEST_WEB_SRC || path.join(ROOT, 'web/src/pages/online/sizePolicy.js');

const TIERS = [
    { id: '1k', maxPixels: 1572864 },
    { id: '2k', maxPixels: 4194304 },
    { id: '4k', maxPixels: 8294400 },
];
const TABLE = {
    format: 'novai-size-policy/v1',
    default: { mode: 'free', hintOnly: false, autoSize: false, maxEdge: 0, maxPixels: 0, minPixels: 0, multipleOf: 0, minRatio: 0, maxRatio: 0, options: [], prefer: 'ratio', defaultLevel: '', tiers: TIERS },
    models: {
        'gpt-image-2': { mode: 'bounds', maxEdge: 3840, maxPixels: 8294400, minPixels: 655360, multipleOf: 16, minRatio: 1 / 3, maxRatio: 3, autoSize: true, defaultLevel: '4k', tiers: TIERS },
        'seedream-5-0-pro': { mode: 'bounds', maxEdge: 0, maxPixels: 4624220, minPixels: 921600, multipleOf: 16, minRatio: 1 / 16, maxRatio: 16, tiers: TIERS },
        'gpt-image-1': { mode: 'enum', options: ['1024x1024', '1536x1024', '1024x1536'], maxEdge: 3840, maxPixels: 8294400, minPixels: 655360, multipleOf: 16, prefer: 'ratio', tiers: TIERS },
        'free-model': { mode: 'free' },
    },
};
const SIZES = ['1024x1024', '1536x864', '4096x4096', '3840x2160', '2160x3840', '3840x1000', '1000x3840',
    '2048x880', '880x2048', '2560x2048', '1280x720', '4096x1000', '500x2000', '2000x500', '16384x16384', '12345x6789'];

async function buildStatic(){
    const sandbox = { window: {}, console, fetch: async () => ({ ok: true, json: async () => TABLE }) };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(STATIC_SRC, 'utf8'), sandbox);
    await sandbox.window.NovaSizePolicy.load();
    return sandbox.window.NovaSizePolicy;
}

async function main(){
    const staticPolicy = await buildStatic();
    globalThis.fetch = async () => ({ ok: true, json: async () => TABLE });
    const webPolicy = (await import(pathToFileURL(WEB_SRC).href)).NovaSizePolicy;
    await webPolicy.load();

    let compared = 0;
    Object.keys(TABLE.models).forEach(model => {
        SIZES.forEach(size => {
            compared += 1;
            const before = staticPolicy.constrain(size, model);
            const after = webPolicy.constrain(size, model);
            ok(before === after, model + ' ' + size + ' 两份实现一致（static=' + before + ', web=' + after + '）');
        });
        ok(staticPolicy.isEnum(model) === webPolicy.isEnum(model),
            model + ' isEnum 一致（static=' + staticPolicy.isEnum(model) + ', web=' + webPolicy.isEnum(model) + '）');
    });
    ok(compared === Object.keys(TABLE.models).length * SIZES.length, '矩阵覆盖 ' + compared + ' 格');

    // 直接锁住阶段 A 的比例夹取语义：web 副本必须和 static 一样夹比例并弹提示
    ok(webPolicy.constrain('3840x1000', 'gpt-image-2') === '2976x992',
        'web 副本把 3840x1000 夹到 3:1（实际 ' + webPolicy.constrain('3840x1000', 'gpt-image-2') + '）');
    ok(webPolicy.constrain('1000x3840', 'gpt-image-2') === '992x2976',
        'web 副本把 1000x3840 夹到 1:3（实际 ' + webPolicy.constrain('1000x3840', 'gpt-image-2') + '）');
    ok(webPolicy.isEnum('gpt-image-2') === true, 'web 副本对带比例范围的 bounds 返回 isEnum=true');
    ok(webPolicy.isEnum('free-model') === false, 'free 策略不触发吸附提示');
    ok(webPolicy.constrain('4096x4096', 'gpt-image-2') === '2880x2880', 'web 副本 1:1@4K = 2880x2880');
    ok(webPolicy.constrain('4096x4096', 'seedream-5-0-pro') === '2144x2144', 'web 副本 5.0 pro 4K 收敛到面积上限内');

    console.log('[size-policy-web-parity] ' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
