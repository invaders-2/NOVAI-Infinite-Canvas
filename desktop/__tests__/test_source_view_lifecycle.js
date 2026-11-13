#!/usr/bin/env node
/*
 * 在线素材内嵌浏览器（WebContentsView）生命周期回归：关闭必须真的摘掉视图，bounds 必须收敛在窗口内。
 *
 *   node desktop/__tests__/test_source_view_lifecycle.js
 *
 * 不启动 Electron、不联网：从 desktop/main.js 抽出与生命周期有关的顶层函数，注入
 * 假的 mainWindow / contentView / WebContentsView / webContents 运行。
 * 覆盖（对着 2026-11 用户报的「关闭面板后页面关不掉」）：
 *   A. 关闭一定 removeChildView，重复关闭幂等
 *   B. 前端记的 attached 是假 false、视图其实还挂着时，照样摘掉
 *   C. 摘除失败（父视图异常）→ 兜底销毁，绝不留残留视图
 *   D. bounds 夹进主窗口内容区；越界/整窗 rect 不会铺满；隐藏哨兵不污染 lastSourceViewRect
 *   E. Esc 由主进程兜底关闭并通知画布（页面焦点在视图里时画布收不到 keydown）
 *   F. 打开请求还在加载时面板被关闭：结果不得再翻回“已打开”，视图必须摘掉
 *   G. 正常打开：复用/定位/默认 rect 兜底
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let passed = 0;
async function check(name, fn) {
    const result = fn();
    if (result && typeof result.then === 'function') await result;
    passed += 1;
    console.log('  ok - ' + name);
}

function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((line) => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

const NEEDED = [
    'contentViewContainsView',
    'isSourceViewAttachedToWindow',
    'contentViewRemoveView',
    'normalizeSourceViewRect',
    'isHiddenSourceRect',
    'clampSourceViewRectToWindow',
    'mainWindowContentSize',
    'defaultSourceViewRect',
    'applySourceViewBounds',
    'hideSourceView',
    'handleSourceEscapeKey',
    'openSourceView',
];
const extracted = {};
NEEDED.forEach((name) => { extracted[name] = topLevelFunction(mainSource, name); });
const missing = NEEDED.filter((name) => !extracted[name]);
if (missing.length) {
    console.log('main.js 里找不到这些函数（重构后要同步更新本测试）：' + missing.join(', '));
    process.exit(1);
}

function makeView(label) {
    const view = {
        label: label || 'source-view',
        bounds: null,
        visible: true,
        closed: false,
        url: 'https://www.pinterest.com/',
    };
    view.webContents = {
        isDestroyed() { return false; },
        getURL() { return view.url; },
        setZoomFactor() {},
        loadURL() { return Promise.resolve(); },
        close() { view.closed = true; },
    };
    view.setBounds = (rect) => { view.bounds = rect; };
    view.getBounds = () => view.bounds;
    view.setVisible = (value) => { view.visible = value; };
    return view;
}

function makeWindow(width, height) {
    const sent = [];
    const contentView = {
        children: [],
        addChildView(view) {
            if (contentView.children.indexOf(view) < 0) contentView.children.push(view);
        },
        removeChildView(view) {
            const index = contentView.children.indexOf(view);
            if (index >= 0) contentView.children.splice(index, 1);
        },
    };
    return {
        contentView,
        sent,
        isDestroyed() { return false; },
        getContentBounds() { return { x: 0, y: 0, width: width, height: height }; },
        webContents: { send(channel, payload) { sent.push({ channel, payload }); } },
    };
}

function buildHarness(hooks) {
    const source = [
        "'use strict';",
        'const SOURCE_VIEW_HIDDEN_SENTINEL = -10000;',
        "const SOURCE_BROWSERS = { pinterest: { label: 'Pinterest', url: 'https://www.pinterest.com/' } };",
        "const CUSTOM_SOURCE_KEY = 'custom';",
        'const SOURCE_DEFAULT_ZOOM = 0.75;',
        'let mainWindow = hooks.window || null;',
        'let sourceView = null;',
        'let sourceViewSource = null;',
        'let sourceViewLoaded = false;',
        'let sourceViewAttached = false;',
        'let sourceViewVisible = false;',
        'let lastSourceViewRect = null;',
        'let sourceBoundsReapplyTimer = null;',
        'let lastSourceBoundsLogAt = 0;',
        'let lastCustomSourceUrls = [];',
        "let sourceUiTheme = 'dark';",
        'let sourceControlsFallback = false;',
        'function clog(area, msg) { hooks.log.push(String(area) + ": " + String(msg)); }',
        'function isSourceViewAlive() { return !!(sourceView && sourceView.webContents && !sourceView.webContents.isDestroyed()); }',
        'function isSourceViewVisible() { return sourceViewAttached && sourceViewVisible && isSourceViewAlive(); }',
        'function isSourceViewOpen() { return isSourceViewVisible(); }',
        "function resetSourceZoom() { hooks.log.push('reset-zoom'); }",
        "function isAllowedWebviewUrl() { return true; }",
        "function normalizeCustomSourceUrl(target) { try { const parsed = new URL(String(target || '').trim()); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.toString() : ''; } catch (_) { return ''; } }",
        "function rememberCustomSourceUrl(url) { lastCustomSourceUrls = [url].concat(lastCustomSourceUrls).slice(0, 5); }",
        "function flushSourceCookies() { hooks.log.push('flush-cookies'); }",
        'function sendSourceTheme() {}',
        'function sendSourceUiState() {}',
        'function sourceHistoryState() { return { canGoBack: false, canGoForward: false }; }',
        'function currentSourceZoom() { return 1; }',
        'function sourceViewState() { return { ok: true, open: isSourceViewVisible(), attached: isSourceViewAttachedToWindow(), source: sourceViewSource, url: "", bounds: lastSourceViewRect, canGoBack: false, canGoForward: false, recentCustomUrls: [], zoomFactor: 1, zoomPercent: 100, theme: sourceUiTheme, controlsFallback: sourceControlsFallback }; }',
        'function destroySourceView() {',
        '  const view = sourceView;',
        '  sourceView = null; sourceViewSource = null; sourceViewLoaded = false;',
        '  sourceViewAttached = false; sourceViewVisible = false;',
        "  hooks.log.push('destroy-view');",
        '  if (!view) return;',
        '  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);',
        '  try { view.webContents.close(); } catch (_) {}',
        '}',
        'function createSourceView() { return hooks.createView(); }',
        'function loadSourceViewUrl(webContents, loadFn, url) { return hooks.load(webContents, loadFn, url); }',
        extracted.contentViewContainsView,
        extracted.isSourceViewAttachedToWindow,
        extracted.contentViewRemoveView,
        extracted.normalizeSourceViewRect,
        extracted.isHiddenSourceRect,
        extracted.clampSourceViewRectToWindow,
        extracted.mainWindowContentSize,
        extracted.defaultSourceViewRect,
        extracted.applySourceViewBounds,
        extracted.hideSourceView,
        extracted.handleSourceEscapeKey,
        extracted.openSourceView,
        'return {',
        '  setWindow(value) { mainWindow = value; },',
        '  setSourceView(value) { sourceView = value; },',
        '  getSourceView() { return sourceView; },',
        '  setFlags(flags) {',
        "    if ('attached' in flags) sourceViewAttached = flags.attached;",
        "    if ('visible' in flags) sourceViewVisible = flags.visible;",
        "    if ('source' in flags) sourceViewSource = flags.source;",
        '  },',
        '  getFlags() { return { attached: sourceViewAttached, visible: sourceViewVisible, source: sourceViewSource, lastRect: lastSourceViewRect }; },',
        '  contentViewContainsView, isSourceViewAttachedToWindow, contentViewRemoveView,',
        '  clampSourceViewRectToWindow, applySourceViewBounds, hideSourceView, handleSourceEscapeKey, openSourceView,',
        '  state: sourceViewState,',
        '};',
    ].join('\n');
    return new Function('hooks', source)(hooks);
}

function newHarness(options) {
    const opts = options || {};
    const win = makeWindow(opts.width || 1000, opts.height || 800);
    const hooks = { window: win, log: [], createView: () => makeView(), load: () => Promise.resolve(null) };
    const api = buildHarness(hooks);
    return { api, win, hooks };
}

(async () => {
    console.log('[source-view] 关闭链路');

    await check('关闭一定 removeChildView，并复位可见/挂载状态', () => {
        const { api, win } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true, source: 'pinterest' });
        api.hideSourceView();
        assert.strictEqual(win.contentView.children.length, 0, '视图必须从窗口摘掉');
        assert.strictEqual(view.visible, false, 'setVisible(false) 作为原生层兜底');
        assert.deepStrictEqual(api.getFlags(), { attached: false, visible: false, source: 'pinterest', lastRect: null });
    });

    await check('重复关闭幂等，不抛错也不重复动视图', () => {
        const { api, win } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        api.hideSourceView();
        api.hideSourceView();
        api.hideSourceView();
        assert.strictEqual(win.contentView.children.length, 0);
        assert.strictEqual(api.getFlags().attached, false);
    });

    await check('attach 标志是假 false、视图其实还挂着，也照样摘掉（以 children 为准）', () => {
        const { api, win } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: false, visible: false });
        assert.strictEqual(api.isSourceViewAttachedToWindow(), true, 'children 里有就是挂着');
        api.hideSourceView();
        assert.strictEqual(win.contentView.children.length, 0);
    });

    await check('摘除失败（父视图异常）→ 兜底销毁视图，不留关不掉的页面', () => {
        const { api, win, hooks } = newHarness();
        const view = makeView();
        win.contentView.removeChildView = () => {}; // 模拟父视图异常：摘了还在
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        api.hideSourceView();
        assert.strictEqual(view.closed, true, '兜底销毁 webContents');
        assert.strictEqual(api.getSourceView(), null, '状态复位');
        assert.strictEqual(api.getFlags().visible, false);
        assert.ok(hooks.log.some((line) => line.indexOf('改为销毁视图') >= 0), '写日志，不静默兜底');
    });

    console.log('[source-view] bounds 收敛');

    await check('越界 / 整窗 rect 被夹回主窗口内容区', () => {
        const { api, win } = newHarness({ width: 1000, height: 800 });
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        assert.strictEqual(api.applySourceViewBounds({ x: 0, y: 0, width: 4000, height: 4000 }), true);
        assert.deepStrictEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 800 });
        assert.deepStrictEqual(api.getFlags().lastRect, { x: 0, y: 0, width: 1000, height: 800 });
    });

    await check('正常面板 rect 原样落到视图上', () => {
        const { api, win } = newHarness({ width: 1000, height: 800 });
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        api.applySourceViewBounds({ x: 28, y: 162, width: 496, height: 551 });
        assert.deepStrictEqual(view.bounds, { x: 28, y: 162, width: 496, height: 551 });
    });

    await check('隐藏哨兵（形变期间挪出窗口）放行，但不写进 lastSourceViewRect', () => {
        const { api, win } = newHarness({ width: 1000, height: 800 });
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        api.applySourceViewBounds({ x: 28, y: 162, width: 496, height: 551 });
        api.applySourceViewBounds({ x: -20000, y: -20000, width: 8, height: 8 });
        assert.deepStrictEqual(view.bounds, { x: -20000, y: -20000, width: 80, height: 80 });
        assert.deepStrictEqual(api.getFlags().lastRect, { x: 28, y: 162, width: 496, height: 551 }, '重开时不会按隐藏坐标打开');
    });

    await check('非法 rect 不落 bounds（返回 false）', () => {
        const { api, win } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        assert.strictEqual(api.applySourceViewBounds(null), false);
        assert.strictEqual(api.applySourceViewBounds({ x: 'a', y: 1, width: 2, height: 3 }), false);
        assert.strictEqual(view.bounds, null);
    });

    console.log('[source-view] Esc 兜底关闭');

    await check('页面焦点在视图里时 Esc 也能关面板，并通知画布', () => {
        const { api, win } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: true, visible: true });
        let prevented = 0;
        api.handleSourceEscapeKey({ preventDefault() { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
        assert.strictEqual(prevented, 1);
        assert.strictEqual(win.contentView.children.length, 0, 'Esc 后视图必须摘掉');
        const closed = win.sent.find((item) => item.channel === 'novai:source-view-closed');
        assert.ok(closed, '通知画布把面板收起');
        assert.strictEqual(closed.payload.open, false);
    });

    await check('面板没开时 Esc 不拦截、不通知', () => {
        const { api, win } = newHarness();
        let prevented = 0;
        api.handleSourceEscapeKey({ preventDefault() { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
        assert.strictEqual(prevented, 0);
        assert.strictEqual(win.sent.length, 0);
    });

    console.log('[source-view] 打开途中被关闭（用户报的场景）');

    await check('加载还没回来就关面板：返回 open:false，且视图不会留在窗口上', async () => {
        const { api, win, hooks } = newHarness();
        const view = makeView();
        hooks.createView = () => view;
        hooks.load = () => {
            // 模拟首屏（Pinterest 企业中心）加载期间用户点了 ×
            api.hideSourceView();
            return Promise.resolve(null);
        };
        const result = await api.openSourceView('pinterest', { x: 28, y: 162, width: 496, height: 551 });
        assert.strictEqual(result.open, false, '打开结果不能再报“已打开”');
        assert.strictEqual(result.superseded, true, '标记为被取代，前端不拿它覆盖当前状态');
        assert.strictEqual(result.source, null);
        assert.strictEqual(win.contentView.children.length, 0, '视图必须摘掉');
        assert.strictEqual(api.getFlags().visible, false);
    });

    await check('视图其实还挂着、本地 attached 是假 false 时重开：状态对齐并重新落 bounds', async () => {
        const { api, win, hooks } = newHarness();
        const view = makeView();
        win.contentView.children.push(view);
        api.setSourceView(view);
        api.setFlags({ attached: false, visible: false, source: 'pinterest' });
        hooks.createView = () => { throw new Error('不该重建视图'); };
        const result = await api.openSourceView('pinterest', { x: 60, y: 200, width: 420, height: 480 });
        assert.strictEqual(result.open, true);
        assert.strictEqual(api.getFlags().attached, true, 'attached 状态要对齐，否则后续 bounds 全被丢掉');
        assert.deepStrictEqual(view.bounds, { x: 60, y: 200, width: 420, height: 480 });
        assert.deepStrictEqual(win.contentView.children, [view], '不重复挂载');
    });

    await check('正常打开：视图挂上、bounds 对齐，返回 open:true', async () => {
        const { api, win, hooks } = newHarness();
        const view = makeView();
        hooks.createView = () => view;
        hooks.load = () => Promise.resolve(null);
        const result = await api.openSourceView('pinterest', { x: 28, y: 162, width: 496, height: 551 });
        assert.strictEqual(result.open, true);
        assert.strictEqual(result.source, 'pinterest');
        assert.deepStrictEqual(win.contentView.children, [view]);
        assert.deepStrictEqual(view.bounds, { x: 28, y: 162, width: 496, height: 551 });
    });

    await check('打开时没有 rect：用小块兜底 rect，不会整窗铺开', async () => {
        const { api, win, hooks } = newHarness({ width: 1000, height: 800 });
        const view = makeView();
        hooks.createView = () => view;
        await api.openSourceView('pinterest', undefined);
        assert.deepStrictEqual(view.bounds, { x: 536, y: 96, width: 440, height: 620 });
    });

    await check('打开时 rect 越界：夹回窗口内', async () => {
        const { api, win, hooks } = newHarness({ width: 1000, height: 800 });
        const view = makeView();
        hooks.createView = () => view;
        await api.openSourceView('pinterest', { x: -100, y: -100, width: 5000, height: 5000 });
        assert.deepStrictEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 800 });
    });

    await check('关闭后重开：复用同一个视图并重新挂回窗口', async () => {
        const { api, win, hooks } = newHarness();
        const view = makeView();
        hooks.createView = () => view;
        await api.openSourceView('pinterest', { x: 28, y: 162, width: 496, height: 551 });
        api.hideSourceView();
        assert.strictEqual(win.contentView.children.length, 0);
        const again = await api.openSourceView('pinterest', { x: 40, y: 170, width: 480, height: 500 });
        assert.strictEqual(again.open, true);
        assert.strictEqual(api.getSourceView(), view, '保活登录态：不重建视图');
        assert.deepStrictEqual(win.contentView.children, [view]);
        assert.deepStrictEqual(view.bounds, { x: 40, y: 170, width: 480, height: 500 });
        assert.strictEqual(view.visible, true);
    });

    console.log('');
    console.log('[source-view] ' + passed + ' 项断言全部通过');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
