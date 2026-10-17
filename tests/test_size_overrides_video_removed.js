#!/usr/bin/env node
/*
 * 「能力覆盖」只给生图模型可编辑：视频模型不出现在模型下拉，但已有的视频覆盖原样保留、保存不丢。
 *
 * 背景：后端 server/protocols/registry.py 的 size_policy_table 只展开 image_models，
 * 给视频模型加的覆盖会落盘但不进 /api/ai/size-policy（不生效）。旧版下拉把视频模型
 * 也列成一组，用户选了以为会生效——这里断言它已经不在可选范围里，同时老数据不丢。
 *
 * 断言：
 *   1) modelChoices 只返回生图模型 + 已有覆盖里的「不在生图列表」模型（视频覆盖在这里，仅显示）；
 *   2) nextOverrideModel 只挑生图模型，只有视频模型时返回空（添加按钮置灰）；
 *   3) 卡片模板不再渲染视频模型分组，已有覆盖仍然逐行渲染、不按模型列表过滤；
 *   4) 保存出站 payload（真跑 useApiStore.payloadOf）原样带回视频模型覆盖，键和字段都不丢；
 *   5) 后端 size_policy_table 仍只展开 image_models（视频覆盖不生效的前提，后端一旦支持就应放开下拉）。
 *
 * 运行：node tests/test_size_overrides_video_removed.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CARD = path.join(ROOT, 'web/src/shell/settings/api/parts/SizeOverridesCard.vue');
const CORE = path.join(ROOT, 'web/src/shell/settings/api/core/sizeOverrides.js');
const STORE = path.join(ROOT, 'web/src/shell/settings/api/core/useApiStore.js');
const REGISTRY = path.join(ROOT, 'server/protocols/registry.py');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');
const read = file => fs.readFileSync(file, 'utf8');

const VIDEO_OVERRIDE = { ratios: ['1:1', '9:16'], resolutions: ['2k'], maxEdge: 1280 };
const VIDEO_MODEL = 'capfix-video-x';

function providerFixture() {
    return {
        id: 'capfix',
        name: 'CapFix Test',
        base_url: 'https://example.com/v1',
        protocol: 'openai',
        image_request_mode: 'openai',
        enabled: true,
        image_models: ['capfix-image-a', 'capfix-image-b'],
        chat_models: [],
        video_models: [VIDEO_MODEL],
        model_names: {},
        model_protocols: {},
        ms_loras: [],
        rh_apps: [],
        rh_workflows: [],
        size_overrides: {
            'capfix-image-a': { ratios: ['16:9'], resolutions: ['1k'] },
            [VIDEO_MODEL]: JSON.parse(JSON.stringify(VIDEO_OVERRIDE)),
        },
    };
}

// 真跑 useApiStore 里的 payloadOf：截出函数源码，注入它依赖的四个外部符号
function buildPayloadOf() {
    const src = read(STORE);
    const start = src.indexOf('function payloadOf(p) {');
    const tail = src.indexOf('clear_lovart_secret_key: lovart && p._clearLovartSecretKey === true,', start);
    const close = src.indexOf('\n    }', tail);
    if (start < 0 || tail < 0 || close < 0) throw new Error('useApiStore.js 里找不到完整的 payloadOf()');
    const fnSrc = src.slice(start, close + 6);
    const make = new Function(
        'isLovartContext', 'normalizeMaxConcurrency', 'normalizeUseProxy', 'VOLCENGINE_DEFAULT_PROJECT_NAME',
        fnSrc + '\nreturn payloadOf;'
    );
    return make(() => false, value => Number(value) || 0, value => (value === 'on' ? 'on' : 'auto'), 'default');
}

async function main() {
    const card = read(CARD);
    const registry = read(REGISTRY);
    const core = await import(pathToFileURL(CORE).href);

    /* ── 1. 可选列表 ── */
    const choices = core.modelChoices(providerFixture());
    eq(choices.image, ['capfix-image-a', 'capfix-image-b'], '模型下拉只有该平台的生图模型');
    ok(choices.image.indexOf(VIDEO_MODEL) < 0, '视频模型不在可选模型列表里');
    ok(!('video' in choices), 'modelChoices 不再返回视频模型分组');
    eq(choices.orphans, [VIDEO_MODEL], '已有视频覆盖仅作为「不在生图列表」的已有行保留');

    const videoOnly = core.modelChoices({ image_models: [], video_models: [VIDEO_MODEL], size_overrides: {} });
    eq(videoOnly.image, [], '只有视频模型时下拉没有可选模型');
    eq(videoOnly.orphans, [], '没有覆盖的视频模型完全不出现（不能新建视频覆盖）');

    /* ── 2. 添加模型只挑生图模型 ── */
    eq(core.nextOverrideModel(providerFixture()), 'capfix-image-b', '添加时挑第一个还没覆盖的生图模型');
    eq(core.nextOverrideModel({ image_models: [], video_models: [VIDEO_MODEL], size_overrides: {} }), '',
        '只有视频模型时不给添加（按钮置灰，不再新建不生效的覆盖）');

    /* ── 3. 卡片模板 ── */
    ok(!/choices\.video/.test(card), '卡片不再引用视频模型分组');
    ok(!/optgroup[^>]*api\.videoModels/.test(card), '卡片模板里没有视频模型 optgroup');
    ok(/v-if="!knownModel\(row\.model\)"/.test(card), '不在生图列表里的已有覆盖仍作为单独 option 显示');
    ok(/Object\.keys\(src\)\.map/.test(card), '所有已有覆盖都渲染成行（不按模型列表过滤，视频覆盖不丢）');

    /* ── 4. 保存出站 payload：视频覆盖原样保留 ── */
    const payloadOf = buildPayloadOf();
    const provider = providerFixture();
    const sent = payloadOf(provider);
    eq(Object.keys(sent.size_overrides), ['capfix-image-a', VIDEO_MODEL], '出站 payload 带回全部覆盖键（含视频模型）');
    eq(sent.size_overrides[VIDEO_MODEL], VIDEO_OVERRIDE, '视频模型覆盖字段完整（ratios / resolutions / maxEdge）');

    // 在生图模型上再改一条覆盖（等同卡片里点选比例）后保存：视频那条仍然原样在
    provider.size_overrides['capfix-image-b'] = { ratios: ['4:3'] };
    const sentAfterEdit = payloadOf(provider);
    eq(sentAfterEdit.size_overrides[VIDEO_MODEL], VIDEO_OVERRIDE, '改其它模型的覆盖后，视频覆盖仍原样保留');
    eq(Object.keys(sentAfterEdit.size_overrides).length, 3, '保存只带当前覆盖，不新增也不删除键');

    /* ── 5. 前提：后端仍只展开 image_models ── */
    ok(/for raw in provider\.get\("image_models"\) or \[\]:/.test(registry),
        '后端 size_policy_table 仍只展开 image_models（视频覆盖不生效；后端支持后应放开下拉并更新本测试）');

    console.log('[size-overrides-video-removed] ' + pass + ' 项通过');
    if (fails.length) {
        fails.forEach(msg => console.error('  \u2717 ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('[size-overrides-video-removed] 全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
