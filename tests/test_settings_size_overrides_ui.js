#!/usr/bin/env node
/*
 * 新版设置页「能力覆盖」（provider.size_overrides）可视化编辑。
 *
 * 断言：
 *   1) 选项不重复定义：比例 / 档位词表来自在线生图页的官方集合（RATIOS / EXTRA_RATIOS / RES_LEVELS）；
 *   2) 卡片在「API 设置 → 平台详情」里，交互逻辑（勾选 / 取消 / 顺序 / 未知值 / 模型下拉 / 数字上限）正确；
 *   3) 保存链路：payloadOf 带字段，size_overrides 变了才重拉尺寸策略（pages/online/sizePolicy 新增 reload）；
 *   4) 设计约束：新样式不用 border / 发丝线 / inset 描边，图标走 AIcon 线性图标；
 *   5) i18n：卡片里的中文文案在 lib/i18n-en.json 里都有英文键；
 *   6) 构建产物 static/v2 带上这张卡片。
 *
 * 运行：node tests/test_settings_size_overrides_ui.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CARD = path.join(ROOT, 'web/src/shell/settings/api/parts/SizeOverridesCard.vue');
const VIEW = path.join(ROOT, 'web/src/shell/settings/api/parts/ProviderView.vue');
const CORE = path.join(ROOT, 'web/src/shell/settings/api/core/sizeOverrides.js');
const SYNC = path.join(ROOT, 'web/src/shell/settings/api/core/sizePolicySync.js');
const STORE = path.join(ROOT, 'web/src/shell/settings/api/core/useApiStore.js');
const WEB_POLICY = path.join(ROOT, 'web/src/pages/online/sizePolicy.js');
const ONLINE_SIZES = path.join(ROOT, 'web/src/pages/online/onlineSizes.js');
const I18N = path.join(ROOT, 'web/src/lib/i18n-en.json');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');
const read = file => fs.readFileSync(file, 'utf8');

function section(src, tag) {
    const start = src.indexOf('<' + tag);
    const end = src.indexOf('</' + tag + '>', start);
    if (start < 0 || end < 0) throw new Error('找不到 <' + tag + '> 段');
    return src.slice(start, end);
}

async function main() {
    const card = read(CARD);
    const view = read(VIEW);
    const core = read(CORE);
    const sync = read(SYNC);
    const store = read(STORE);

    /* ── 1. 接入位置 + 选项来源 ── */
    ok(/import SizeOverridesCard from '\.\/SizeOverridesCard\.vue'/.test(view), 'ProviderView 引入了能力覆盖卡片');
    ok(/<SizeOverridesCard \/>/.test(view), '平台详情渲染 <SizeOverridesCard />');
    ok(/from '\.\.\/\.\.\/\.\.\/\.\.\/pages\/online\/onlineSizes\.js'/.test(core),
        'core/sizeOverrides.js 的比例 / 档位来自在线生图页的官方集合');
    ok(/SIZE_RATIOS\s*=\s*\[\.\.\.RATIOS, \.\.\.EXTRA_RATIOS\]/.test(core), '比例 = RATIOS + EXTRA_RATIOS，没有另抄一份');
    ok(/SIZE_LEVELS\s*=\s*RES_LEVELS\.slice\(\)/.test(core), '档位 = RES_LEVELS');
    ok(/SIZE_RATIOS/.test(card) && /SIZE_LEVELS/.test(card), '卡片用这两份选项渲染多选');
    // 卡片里不应再出现一份手写的比例 / 档位清单
    ok(!/\[\s*'1:1'\s*,/.test(card), '卡片里没有手写的比例数组');
    ok(!/\['0\.5k'\s*,/.test(card), '卡片里没有手写的档位数组');

    /* ── 2. 交互逻辑（真跑模块） ── */
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ format: 'novai-size-policy/v1', default: {}, models: {} }) });
    const sizes = await import(pathToFileURL(ONLINE_SIZES).href);
    const coreModule = await import(pathToFileURL(CORE).href);
    const { SIZE_RATIOS, SIZE_LEVELS } = coreModule;
    eq(SIZE_RATIOS.length, sizes.RATIOS.length + sizes.EXTRA_RATIOS.length, '比例选项数量 = 官方 15 + 4');
    eq(SIZE_RATIOS.map(o => o.label).slice(0, 3), ['1:1', '2:3', '3:2'], '比例标签取官方宽高比（不带中文说明）');
    ok(SIZE_RATIOS.some(o => o.label === '1:4') && SIZE_RATIOS.some(o => o.label === '8:1'), '包含 Gemini 官方的 1:4 / 8:1');
    ok(SIZE_RATIOS.some(o => o.label === '21:9'), '包含 21:9');
    eq(SIZE_LEVELS, ['0.5k', '1k', '1.5k', '2k', '3k', '4k'], '档位 = 0.5k / 1k / 1.5k / 2k / 3k / 4k');

    const opt = label => SIZE_RATIOS.find(o => o.label === label);
    const RELAY = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    let ratios = [];
    RELAY.slice().reverse().forEach(label => { ratios = coreModule.toggleRatio(ratios, opt(label)); });
    eq(ratios.length, 10, '勾满 10 个比例');
    eq(ratios, SIZE_RATIOS.map(o => o.label).filter(l => RELAY.indexOf(l) >= 0), '写盘顺序按官方比例顺序，不按点击顺序');
    ratios = coreModule.toggleRatio(ratios, opt('16:9'));
    ok(ratios.indexOf('16:9') < 0 && ratios.length === 9, '再点一次取消勾选');
    ratios = coreModule.toggleRatio(ratios, opt('16:9'));
    ok(ratios.indexOf('16:9') >= 0 && ratios.length === 10, '可以再勾回来');

    // 手写 JSON 用画布内部 key：显示为已选，写回统一成官方标签
    eq(coreModule.matchesRatio('square', opt('1:1')), true, '内部 key square 命中 1:1');
    eq(coreModule.orderRatios(['wide', 'square']), ['1:1', '16:9'], 'key 形式按官方顺序归一成标签');
    eq(coreModule.toggleRatio(['square', '9:21'], opt('1:1')), ['9:21'], '取消 key 形式的 1:1 时其余未知值保留');

    // 未知 / 手写值不静默丢，能单独删掉
    eq(coreModule.extraRatios(['1:1', '7:3']), ['7:3'], '认不出的比例留在自定义 chip 里');
    eq(coreModule.extraLevels(['1k', '8k']), ['8k'], '认不出的档位留在自定义 chip 里');

    let levels = [];
    levels = coreModule.toggleLevel(levels, '1k');
    levels = coreModule.toggleLevel(levels, '2k');
    eq(levels, ['1k', '2k'], '档位多选');
    eq(coreModule.toggleLevel(['1K'], '1k'), [], '档位大小写不敏感（1K = 1k）');
    eq(coreModule.orderLevels(['4k', '0.5k']), ['0.5k', '4k'], '档位按官方顺序');

    const provider = {
        image_models: ['gemini-3.1-flash-image', 'gpt-image-2'],
        video_models: ['seedance-2.0'],
        size_overrides: { 'gemini-3.1-flash-image': { ratios: RELAY, resolutions: ['1k'] }, 'gone-model': {} },
    };
    const choices = coreModule.modelChoices(provider);
    eq(choices.image, ['gemini-3.1-flash-image', 'gpt-image-2'], '模型下拉 = 该平台自己的生图模型');
    ok(!('video' in choices), '模型下拉不再有视频模型分组（后端只展开 image_models，视频覆盖不生效）');
    ok(choices.image.indexOf('seedance-2.0') < 0, '视频模型不在模型下拉里');
    eq(choices.orphans, ['gone-model'], '已配置但不在模型列表的模型仍然列出来（不丢配置）');
    eq(coreModule.nextOverrideModel(provider), 'gpt-image-2', '添加时挑第一个还没覆盖的模型');
    eq(coreModule.nextOverrideModel({ image_models: [], video_models: ['v1'] }), '', '没有生图模型时不再回落到视频模型');
    eq(coreModule.nextOverrideModel({ image_models: [], video_models: [], size_overrides: {} }), '', '一个模型都没有时不给添加');

    eq(coreModule.parseLimit('2 048'), 2048, '数字输入容忍空格 / 非数字');
    eq(coreModule.parseLimit('02048'), 2048, '去前导 0');
    eq(coreModule.parseLimit(''), 0, '留空 = 不限制');
    eq(coreModule.parseLimit('0'), 0, '0 = 不限制（与后端 >0 才生效一致）');

    /* ── 3. 保存链路 ── */
    ok(/size_overrides\s*:/.test(store), 'payloadOf 仍然原样带回 size_overrides');
    ok(/refreshSizePolicy/.test(store), '保存成功后调用 refreshSizePolicy');
    ok(/const overridesChanged = !!overridesOnServer && overridesSnapshot\(S\.providers\) !== overridesOnServer/.test(store),
        '保存后跟后端那份基线比，只有 size_overrides 变了才重拉策略');
    ok(/syncOverridesBaseline\(S\.providers\)/.test(store), '载入 / 重新拉取 / 保存成功都会刷新基线');
    ok(/NovaSizePolicy\.reload\(\)/.test(sync) && /loadPolicy/.test(sync), 'sizePolicySync 先清缓存再让在线生图页重算');
    ok(/function reload\(\)/.test(read(WEB_POLICY)), 'pages/online/sizePolicy.js 提供 reload()');
    ok(/pending = null;/.test(read(WEB_POLICY).slice(read(WEB_POLICY).indexOf('function reload'))), 'reload() 清掉首次加载的缓存');

    /* ── 4. 设计约束 ── */
    const style = section(card, 'style');
    const borderDecls = style.split(';').map(decl => decl.trim())
        .filter(decl => /^border(-[a-z]+)?\s*:/.test(decl) && !/^border-radius\s*:/.test(decl));
    const visibleBorders = borderDecls.filter(decl => !/^border(-[a-z]+)?\s*:\s*(0|none)\s*$/.test(decl));
    ok(!visibleBorders.length, '不用可见 border / 发丝线（只允许 border: 0 / none 重置）'
        + (visibleBorders.length ? '：' + visibleBorders.join(' / ') : ''));
    ok(!/box-shadow\s*:\s*inset/.test(style), '不用 inset 描边');
    ok(!/1px solid/.test(style), '不用 1px solid');
    ok(/background:\s*var\(--fill-1\)/.test(style), '卡片底走 --fill-1（与现有卡片一致）');
    ok(/\.chip\.on\s*\{[^}]*background:\s*var\(--solid\)/.test(style), '选中态 = 软底 + 文字提亮（不描边）');
    ok(!/choices\.video/.test(card) && !/optgroup[^>]*api\.videoModels/.test(card), '卡片不再渲染视频模型选项分组');
    ok(/v-if="!knownModel\(row\.model\)"/.test(card), '不在生图列表里的已有覆盖仍作为单独 option 显示（不丢数据）');
    ok(/<AIcon name="plus"/.test(card) && /<AIcon name="trash"/.test(card), '图标走 AIcon（线性 lucide）');
    ok(!/<img\b/.test(card), '没有位图图标');
    const scriptLines = section(card, 'script').split('\n').filter(line => /^\s+\S/.test(line));
    ok(scriptLines.every(line => (line.match(/^ */)[0].length % 4) === 0), '脚本 4 空格缩进');

    /* ── 5. i18n ── */
    const EN = JSON.parse(read(I18N));
    const zh = [...card.matchAll(/t\('[^']*',\s*'([^']*)'\)/g)].map(match => match[1]);
    const missing = zh.filter(text => /[\u4e00-\u9fa5]/.test(text) && EN[text] === undefined);
    eq(missing, [], '卡片里的中文文案都有英文键');
    ok(zh.some(text => text === '能力覆盖'), '卡片标题走 t()');

    /* ── 6. 构建产物 ── */
    const indexHtml = read(path.join(ROOT, 'static/v2/index.html'));
    const jsFiles = [...new Set([...indexHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]))];
    ok(jsFiles.length > 0, 'static/v2/index.html 引用了构建产物');
    const bundles = jsFiles.filter(file => file.endsWith('.js'))
        .map(file => path.join(ROOT, file.replace(/^\//, '')))
        .filter(file => fs.existsSync(file))
        .map(file => read(file));
    ok(bundles.length > 0, '构建 JS 存在');
    ok(bundles.some(src => src.indexOf('能力覆盖') >= 0 || src.indexOf('\\u80fd\\u529b\\u8986\\u76d6') >= 0), '构建产物带上能力覆盖卡片');
    ok(bundles.some(src => src.indexOf('Capability overrides') >= 0 && src.indexOf('Allowed ratios') >= 0 && src.indexOf('Allowed tiers') >= 0), '构建产物带上卡片的英文文案');

    console.log('[settings-size-overrides-ui] ' + pass + ' 项通过');
    if (fails.length) {
        fails.forEach(msg => console.error('  \u2717 ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('[settings-size-overrides-ui] 全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
