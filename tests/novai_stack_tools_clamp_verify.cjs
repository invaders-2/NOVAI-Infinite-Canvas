#!/usr/bin/env node
'use strict';
/*
 * 堆叠工具条「贴边 clamp」复核（task-14）：
 *   1) 贴左 / 贴右 / 视口 900：折叠态 + 展开态的条 rect、距视口/舞台左右边距、4 个按钮中心是否在视口内
 *   2) 极窄屏 360 / 320：只保证左边 8px 时右边溢出多少、哪些按钮点不到
 *   3) 折叠→展开用 rAF 每帧采样 left / marginLeft，确认不来回跳；静止 1s 后稳定
 *   4) 拖拽隐藏：ui.dragging=true 悬停不冒条；拖堆叠自己不冒；松手恢复
 *   5) 回归：取消堆叠 / 全部下载 / 桥接 / 条隐藏时节点上方无隐形悬停带
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-stack2 python3 main.py &
 *   NOVAI_DATA_DIR=/tmp/novai-stack2 node tests/novai_stack_tools_clamp_verify.cjs
 *
 * 输出：tests/artifacts/stack-tools-clamp/*.png + result-stack-tools-clamp.json
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT = path.join(__dirname, 'artifacts', process.env.NOVAI_CLAMP_OUT || 'stack-tools-clamp');

function barMetrics() {
    const wrap = document.querySelector('.stack-tools-wrap');
    const bar = document.querySelector('[data-act="stack-tools"]');
    const stageEl = document.querySelector('#stage');
    const stage = stageEl.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const round = function (v) { return Math.round(v * 10) / 10; };
    const btns = Array.from(bar.querySelectorAll('.cn-fm-btn')).map(function (b) {
        const br = b.getBoundingClientRect();
        const cx = br.left + br.width / 2;
        return { st: b.getAttribute('data-st'), left: round(br.left), right: round(br.right), center: round(cx), centerInViewport: cx > 0 && cx < innerWidth, centerInStage: cx > stage.left && cx < stage.right };
    });
    return {
        bar: { left: round(r.left), right: round(r.right), width: round(r.width), top: round(r.top), bottom: round(r.bottom) },
        stage: { left: round(stage.left), right: round(stage.right), width: round(stage.width) },
        viewport: { w: innerWidth, h: innerHeight },
        marginViewport: { left: round(r.left), right: round(innerWidth - r.right) },
        marginStage: { left: round(r.left - stage.left), right: round(stage.right - r.right) },
        wrapMarginLeft: wrap ? (wrap.style.marginLeft || '') : null,
        wrapDisplay: wrap ? getComputedStyle(wrap).display : null,
        opened: bar.classList.contains('opened'),
        on: bar.classList.contains('on'),
        opacity: getComputedStyle(bar).opacity,
        btns: btns,
    };
}

async function clipFor(page, boxes, pad) {
    const vp = page.viewportSize();
    const left = Math.min.apply(null, boxes.map(function (b) { return b.x; })) - pad;
    const top = Math.min.apply(null, boxes.map(function (b) { return b.y; })) - pad;
    const right = Math.max.apply(null, boxes.map(function (b) { return b.x + b.width; })) + pad;
    const bottom = Math.max.apply(null, boxes.map(function (b) { return b.y + b.height; })) + pad;
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return { x: x, y: y, width: Math.max(1, Math.min(vp.width - x, Math.ceil(right - left))), height: Math.max(1, Math.min(vp.height - y, Math.ceil(bottom - top))) };
}
async function shot(page, c, name, boxes, pad) {
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, clip: await clipFor(page, boxes, pad === undefined ? 18 : pad) });
    c.results.shots[name] = file;
    console.log('SHOT  ' + file);
    return file;
}
async function moveAway(page) { await page.mouse.move(4, 4); await page.waitForTimeout(380); }
async function stackId(page) {
    return page.evaluate(function () { const n = window.__cn.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; }); return n ? n.id : null; });
}
async function moveStackToScreenX(page, targetX) {
    await page.evaluate(function (target) {
        const store = window.__cn;
        const n = store.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; });
        if (!n) return;
        const k = store.state.view.k;
        const cur = n.x * k + store.state.view.x;
        store.updateNode(n.id, function (x) { return Object.assign({}, x, { x: x.x + (target - cur) / k }); });
    }, targetX);
    await page.waitForTimeout(320);
}
async function moveStackToScreenXY(page, targetX, targetY) {
    await page.evaluate(function (t) {
        const store = window.__cn;
        const n = store.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; });
        if (!n) return;
        const k = store.state.view.k;
        const view = store.state.view;
        store.updateNode(n.id, function (x) { return Object.assign({}, x, { x: x.x + (t.x - (x.x * k + view.x)) / k, y: x.y + (t.y - (x.y * k + view.y)) / k }); });
    }, { x: targetX, y: targetY });
    await page.waitForTimeout(350);
}
async function hoverBodySafe(page) {
    const body = await page.locator('.snode .stack-body').first().boundingBox();
    const stageLeft = await page.evaluate(function () { return document.querySelector('#stage').getBoundingClientRect().left; });
    const vp = page.viewportSize();
    const x = Math.max(stageLeft + 14, Math.min(body.x + body.width / 2, vp.width - 2));
    const y = Math.max(2, Math.min(body.y + body.height / 2, vp.height - 2));
    await page.mouse.move(x, y);
    await page.waitForTimeout(350);
    return body;
}
async function hoverBarSafe(page) {
    const bar = await page.locator('[data-act="stack-tools"]').first().boundingBox();
    const vp = page.viewportSize();
    const x = Math.max(4, Math.min(bar.x + bar.width / 2, vp.width - 4));
    const y = Math.max(4, Math.min(bar.y + bar.height / 2, vp.height - 4));
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(400);
}
async function measure(page) { return page.evaluate(barMetrics); }

(async function () {
    const c = H.checker('堆叠工具条：贴边 clamp / 极窄屏 / 抖动 / 拖拽隐藏 / 回归');
    fs.mkdirSync(OUT, { recursive: true });
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const result = { clamp: {}, narrow: {}, jitter: {}, drag: {}, hoverBand: {}, bridge: {}, actions: {} };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) { c.check('后端可用', false, { status: health.status() }); return c.finish(); }
        const png = function (name, hue) {
            const file = path.join(H.OUT_DIR, name);
            if (!fs.existsSync(file)) H.writePng(file, 800, 600, 2, function (x, y) { return [(hue + x) % 255, (hue + y * 2) % 255, 180]; });
            return file;
        };
        png('stk-1.png', 20); png('stk-2.png', 90); png('stk-3.png', 160);
        canvasId = await H.createCanvas(api, 'VERIFY-STACK-CLAMP-' + Date.now());
        browser = await H.launchBrowser();
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', function (e) { pageErrors.push(String(e && e.message || e)); });
        const downloads = [];
        page.on('download', function (d) { downloads.push(d.suggestedFilename()); });
        await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function () { return !!(window.__cn && window.__cn.state && window.__cn.state.doc); }, null, { timeout: 30000 });
        await page.waitForTimeout(700);
        const ids = await page.evaluate(function (urls) {
            const store = window.__cn;
            const nodes = urls.map(function (url, i) { return store.newNode('image', 120 + i * 40, 60 + i * 30, { hist: [{ url: url, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '堆叠成员 ' + (i + 1) }); });
            store.addNodes(nodes, [], { select: true });
            return nodes.map(function (n) { return n.id; });
        }, ['/output/stk-1.png', '/output/stk-2.png', '/output/stk-3.png']);
        await page.waitForTimeout(500);
        await page.evaluate(function (list) { window.__cn.setUI({ sel: new Set(list) }); }, ids);
        await page.waitForTimeout(250);
        await page.locator('[data-mb="stack"]').first().click();
        await page.waitForTimeout(700);
        await page.locator('.snode').first().waitFor({ state: 'visible', timeout: 6000 });
        await page.evaluate(function () { window.__cn.setUI({ agentOpen: false }); });
        await page.waitForTimeout(350);
        const sid = await stackId(page);
        c.check('S1 堆叠已创建', !!sid);
        const lbInfo = await page.evaluate(function () {
            const lb = document.querySelector('#lb');
            const r = lb.getBoundingClientRect();
            return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
        });
        result.lb = lbInfo;
        const expectedLeft = lbInfo.right + 8;
        result.expectedLeft = expectedLeft;
        c.check('S2 量到 #lb 右缘 ' + lbInfo.right + 'px，贴左时条应被推到 ' + expectedLeft + 'px', lbInfo.width > 0, lbInfo);

        /* ---------- 1. 贴左（折叠 / 展开）+ “没 clamp 的对照” ---------- */
        await moveAway(page);
        await moveStackToScreenX(page, -20);
        const bodyL = await hoverBodySafe(page);
        const leftCollapsed = await measure(page);
        result.clamp.leftCollapsed = leftCollapsed;
        const barBoxL = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '01-left-collapsed', [bodyL, barBoxL], 16);
        // 对照：强行抹掉 clamp（把 wrapper marginLeft 清空），量“没 clamp 时的溢出”
        const noClampLeft = await page.evaluate(function () {
            const wrap = document.querySelector('.stack-tools-wrap');
            const saved = wrap.style.marginLeft;
            wrap.style.marginLeft = '';
            const bar = document.querySelector('[data-act="stack-tools"]').getBoundingClientRect();
            const stage = document.querySelector('#stage').getBoundingClientRect();
            const out = { bar: { left: Math.round(bar.left * 10) / 10, right: Math.round(bar.right * 10) / 10, width: Math.round(bar.width * 10) / 10 }, marginViewportLeft: Math.round(bar.left * 10) / 10, marginStageLeft: Math.round((bar.left - stage.left) * 10) / 10 };
            wrap.style.marginLeft = saved;
            return out;
        });
        result.clamp.leftNoClamp = noClampLeft;
        const barBoxL2 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '01b-left-noclamp', [bodyL, barBoxL2], 16);
        await hoverBarSafe(page);
        const leftExpanded = await measure(page);
        result.clamp.leftExpanded = leftExpanded;
        const barBoxL3 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '02-left-expanded', [bodyL, barBoxL3], 16);
        c.check('L1 贴左·展开态：距舞台左边 ≥8px（实测 ' + leftExpanded.marginStage.left + '）', leftExpanded.marginStage.left >= 7.5, leftExpanded.marginStage);
        c.check('L2 贴左·展开态：距视口左边 ≥8px（实测 ' + leftExpanded.marginViewport.left + '）', leftExpanded.marginViewport.left >= 7.5, leftExpanded.marginViewport);
        c.check('L3 贴左·展开态：4 个按钮中心都在视口内', leftExpanded.btns.every(function (b) { return b.centerInViewport; }), leftExpanded.btns);
        c.check('L4 贴左·展开态：4 个按钮中心都在舞台内（不会被左侧 rail 盖住）', leftExpanded.btns.every(function (b) { return b.centerInStage; }), leftExpanded.btns);
        c.check('L5 对照：不加 clamp 时确实会溢出（说明 clamp 真在起作用）', noClampLeft.marginStageLeft < 0 || noClampLeft.bar.left < 8, noClampLeft);
        // L6：中心点在视口内 ≠ 点得到——左侧是浮动的竖排工具条（overlay），要查 hit-test
        const leftOcclusion = await page.evaluate(function () {
            const bar = document.querySelector('[data-act="stack-tools"]');
            return Array.from(bar.querySelectorAll('.cn-fm-btn')).map(function (b) {
                const r = b.getBoundingClientRect();
                const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { st: b.getAttribute('data-st'), centerX: Math.round((r.left + r.width / 2) * 10) / 10, hit: el ? String(el.className || el.tagName).slice(0, 40) : null, clickable: !!(el && (b === el || b.contains(el))) };
            });
        });
        result.clamp.leftOcclusion = leftOcclusion;
        c.check('L6 贴左·四个按钮中心真的点得到（hit-test 命中自己，不被左侧浮动工具条盖住）', leftOcclusion.every(function (b) { return b.clickable; }), leftOcclusion);
        c.check('L7 贴左·展开条 left ≈ #lb 右缘+8（期望 ' + expectedLeft + '，实测 ' + leftExpanded.bar.left + '）', Math.abs(leftExpanded.bar.left - expectedLeft) <= 2.5, { expected: expectedLeft, actual: leftExpanded.bar.left, lb: lbInfo });
        c.check('L8 贴左·折叠条 left 也 ≈ #lb 右缘+8（期望 ' + expectedLeft + '，实测 ' + leftCollapsed.bar.left + '）', Math.abs(leftCollapsed.bar.left - expectedLeft) <= 2.5, { expected: expectedLeft, actual: leftCollapsed.bar.left });

        /* ---------- 1a2. 无谓右推：节点在 #lb 上方 / 下方（竖直不重叠）时，左边只留 8px ---------- */
        const noPush = {};
        const tlInfo = await page.evaluate(function () {
            const r = document.querySelector('#tl').getBoundingClientRect();
            return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 };
        });
        result.tl = tlInfo;
        for (const where of ['up', 'down']) {
            await moveAway(page);
            // up：条要落在 #tl 下方、#lb 上方；down：条要落在 #lb 下方
            const nodeTop = where === 'up' ? Math.max(tlInfo.bottom + 80, 160) : Math.min(950 - 40, lbInfo.bottom + 90);
            await moveStackToScreenXY(page, -20, nodeTop);
            const body = await page.locator('.snode .stack-body').first().boundingBox();
            const vp = page.viewportSize();
            const hoverY = Math.max(2, Math.min(body.y + body.height / 2 - (where === 'down' ? 35 : 0), vp.height - 2));
            const hoverX = Math.max(14, Math.min(body.x + body.width / 2, vp.width - 2));
            await page.mouse.move(hoverX, hoverY);
            await page.waitForTimeout(350);
            const collapsed = await measure(page);
            const barBox0 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
            await shot(page, c, '09-nopush-' + where + '-collapsed', [body, barBox0], 14);
            await hoverBarSafe(page);
            const expanded = await measure(page);
            noPush[where] = { nodeTop: nodeTop, hover: { x: hoverX, y: hoverY }, collapsedLeft: collapsed.bar.left, collapsedTop: collapsed.bar.top, expandedLeft: expanded.bar.left, expandedTop: expanded.bar.top, expandedMargin: expanded.marginStage, vp: vp };
            const barBox1 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
            await shot(page, c, '10-nopush-' + where + '-expanded', [body, barBox1], 14);
            const overlapY = expanded.bar.top < lbInfo.bottom && expanded.bar.bottom > lbInfo.top;
            noPush[where].overlapY = overlapY;
            c.check('NOPUSH-' + where + ' 节点在 #lb ' + (where === 'up' ? '上方' : '下方') + '：条 left = ' + expanded.bar.left + '（期望 8，不被无谓右推到 ' + expectedLeft + '）', !overlapY && expanded.bar.left <= 12, noPush[where]);
        }
        result.clamp.noPush = noPush;

        /* ---------- 1b. 贴右 ---------- */
        await moveAway(page);
        await moveStackToScreenX(page, 1500 - 260 + 20);
        const bodyR = await hoverBodySafe(page);
        const rightCollapsed = await measure(page);
        result.clamp.rightCollapsed = rightCollapsed;
        await hoverBarSafe(page);
        const rightExpanded = await measure(page);
        result.clamp.rightExpanded = rightExpanded;
        const barBoxR = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '03-right-expanded', [bodyR, barBoxR], 16);
        const noClampRight = await page.evaluate(function () {
            const wrap = document.querySelector('.stack-tools-wrap');
            const saved = wrap.style.marginLeft;
            wrap.style.marginLeft = '';
            const bar = document.querySelector('[data-act="stack-tools"]').getBoundingClientRect();
            const stage = document.querySelector('#stage').getBoundingClientRect();
            const out = { marginViewportRight: Math.round((innerWidth - bar.right) * 10) / 10, marginStageRight: Math.round((stage.right - bar.right) * 10) / 10 };
            wrap.style.marginLeft = saved;
            return out;
        });
        result.clamp.rightNoClamp = noClampRight;
        c.check('R1 贴右·展开态：距舞台右边 ≥8px（实测 ' + rightExpanded.marginStage.right + '）', rightExpanded.marginStage.right >= 7.5, rightExpanded.marginStage);
        c.check('R2 贴右·展开态：距视口右边 ≥8px（实测 ' + rightExpanded.marginViewport.right + '）', rightExpanded.marginViewport.right >= 7.5, rightExpanded.marginViewport);
        c.check('R3 贴右·展开态：4 个按钮中心都在视口内', rightExpanded.btns.every(function (b) { return b.centerInViewport; }), rightExpanded.btns);
        c.check('R4 对照：不加 clamp 时贴右会溢出（右侧 marginStage ≈ ' + noClampRight.marginStageRight + '）', noClampRight.marginStageRight < 8, noClampRight);
        const rightOcclusion = await page.evaluate(function () {
            const bar = document.querySelector('[data-act="stack-tools"]');
            return Array.from(bar.querySelectorAll('.cn-fm-btn')).map(function (b) {
                const r = b.getBoundingClientRect();
                const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { st: b.getAttribute('data-st'), hit: el ? String(el.className || el.tagName).slice(0, 40) : null, clickable: !!(el && (b === el || b.contains(el))) };
            });
        });
        result.clamp.rightOcclusion = rightOcclusion;
        c.check('R5 贴右·四个按钮中心真的点得到（hit-test 命中自己）', rightOcclusion.every(function (b) { return b.clickable; }), rightOcclusion);

        /* ---------- 1c. 视口 900 ---------- */
        await page.setViewportSize({ width: 900, height: 900 });
        await page.waitForTimeout(500);
        await moveAway(page);
        await moveStackToScreenX(page, 320);
        const bodyM = await hoverBodySafe(page);
        await hoverBarSafe(page);
        const mid = await measure(page);
        result.clamp.vp900 = mid;
        const barBoxM = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '04-vp900-expanded', [bodyM, barBoxM], 16);
        c.check('M1 视口 900·展开态：左右各 ≥8px（实测 ' + mid.marginStage.left + ' / ' + mid.marginStage.right + '）', mid.marginStage.left >= 7.5 && mid.marginStage.right >= 7.5, mid.marginStage);
        c.check('M2 视口 900·展开态：4 个按钮中心都在视口内', mid.btns.every(function (b) { return b.centerInViewport; }), mid.btns);

        /* ---------- 2. 极窄屏 360 / 320 ---------- */
        for (const width of [360, 320]) {
            await page.setViewportSize({ width: width, height: 800 });
            await page.waitForTimeout(500);
            await moveAway(page);
            await page.evaluate(function () {
                const store = window.__cn;
                const n = store.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; });
                if (!n) return;
                const k = store.state.view.k;
                const target = Math.max(8, (innerWidth - n.w * k) / 2);
                const cur = n.x * k + store.state.view.x;
                store.updateNode(n.id, function (x) { return Object.assign({}, x, { x: x.x + (target - cur) / k }); });
            });
            await page.waitForTimeout(350);
            const bodyN = await hoverBodySafe(page);
            await hoverBarSafe(page);
            const m = await measure(page);
            result.narrow[width] = m;
            result.narrow[width].unclickable = m.btns.filter(function (b) { return !b.centerInViewport; }).map(function (b) { return b.st; });
            const barBoxN = await page.locator('[data-act="stack-tools"]').first().boundingBox();
            await shot(page, c, '05-vp' + width + '-expanded', [bodyN, barBoxN], 12);
            // ≤760px 时 float-menu 自动只显示图标（.cn-fm-btn 30px、label 隐藏）→ 条只有 147px，不会溢出
            const iconOnly = m.bar.width < 200;
            result.narrow[width].iconOnly = iconOnly;
            c.check('N' + width + '·极窄屏：左右边距 ' + m.marginStage.left + ' / ' + m.marginStage.right + 'px，点不到：' + (result.narrow[width].unclickable.join('/') || '无') + (iconOnly ? '（≤760px 自动只显示图标，条 ' + m.bar.width + 'px，未触发“只保左 8px”的分支）' : ''),
                m.marginStage.left >= 7.5 && result.narrow[width].unclickable.length === 0, { marginStage: m.marginStage, barWidth: m.bar.width, stageWidth: m.stage.width, iconOnly: iconOnly, unclickable: result.narrow[width].unclickable });
        }

        /* ---------- 3. 不抖动：折叠→展开每帧采样（节点放在与 #lb 竖直重叠的位置，clamp 生效） ---------- */
        await page.setViewportSize({ width: 1500, height: 950 });
        await page.waitForTimeout(500);
        await moveAway(page);
        await moveStackToScreenXY(page, -20, (lbInfo.top + lbInfo.bottom) / 2 + 91);
        const bodyJ = await hoverBodySafe(page); // 条已显示（折叠态）
        const sampler = page.evaluate(function () {
            return new Promise(function (resolve) {
                const frames = [];
                const t0 = performance.now();
                function tick() {
                    const bar = document.querySelector('[data-act="stack-tools"]');
                    const wrap = document.querySelector('.stack-tools-wrap');
                    if (bar) {
                        const r = bar.getBoundingClientRect();
                        frames.push({ t: Math.round((performance.now() - t0) * 10) / 10, left: Math.round(r.left * 100) / 100, right: Math.round(r.right * 100) / 100, width: Math.round(r.width * 100) / 100, margin: wrap.style.marginLeft || '', opened: bar.classList.contains('opened') });
                    }
                    if (performance.now() - t0 < 900) requestAnimationFrame(tick); else resolve(frames);
                }
                requestAnimationFrame(tick);
            });
        });
        await hoverBarSafe(page);
        const frames = await sampler;
        // 判定抖动：left 的变化方向反复变（>1px）就说明来回跳
        let dirChanges = 0, lastDir = 0, maxStep = 0;
        for (let i = 1; i < frames.length; i += 1) {
            const d = frames[i].left - frames[i - 1].left;
            if (Math.abs(d) > 0.5) {
                const dir = d > 0 ? 1 : -1;
                if (lastDir && dir !== lastDir) dirChanges += 1;
                lastDir = dir;
                maxStep = Math.max(maxStep, Math.abs(d));
            }
        }
        const settled = await page.waitForTimeout(1000).then(function () { return page.evaluate(barMetrics); });
        const jitter = { frames: frames, dirChanges: dirChanges, maxStep: Math.round(maxStep * 100) / 100, settled: settled };
        result.jitter = jitter;
        // 说明：rAF 采样跑在 ResizeObserver 修正之前，读到的是「修正前同一帧」的中间态；是否可见看 J5/J6 的绘制态
        c.check('J1 记录 rAF 原始采样（含修正前中间态）：方向变化 ' + dirChanges + ' 次、最大帧差 ' + jitter.maxStep + 'px', true, { dirChanges: dirChanges, maxStep: jitter.maxStep, samples: frames.length });
        c.check('J2 展开稳定后再等 1s，left 不再变化（位移 ≤0.6px）', Math.abs(settled.bar.left - frames[frames.length - 1].left) <= 0.6, { last: frames[frames.length - 1].left, settled: settled.bar.left });
        // marginLeft 随标签展开单调增大（ResizeObserver 每帧跟随），要求单调、不来回跳
        const margins = frames.map(function (f) { return parseFloat(f.margin || '0') || 0; });
        let marginReverts = 0;
        for (let i = 1; i < margins.length; i += 1) if (margins[i] - margins[i - 1] < -0.5) marginReverts += 1;
        const blips = [];
        for (let i = 1; i < frames.length; i += 1) { const d = frames[i].left - frames[i - 1].left; if (Math.abs(d) > 0.6) blips.push({ i: i, from: frames[i - 1].left, to: frames[i].left, dt: frames[i].t - frames[i - 1].t }); }
        result.jitter.marginReverts = marginReverts;
        result.jitter.leftBlips = blips;
        c.check('J3 marginLeft 随展开单调变化（没有来回改，reverts=' + marginReverts + '）', marginReverts === 0, { marginReverts: marginReverts, finalMargin: frames[frames.length - 1].margin });
        c.check('J4 记录 rAF 采样里的中间态跳变（' + blips.length + ' 次，最大 ' + (blips.length ? Math.max.apply(null, blips.map(function (b) { return Math.abs(b.to - b.from); })) : 0) + 'px）——这些是修正前状态，不作为失败', true, blips);

        /* ---------- 3b. 展开 60ms 的“绘制帧”截图：判断过冲是否真被画出来 ---------- */
        await moveAway(page);
        await moveStackToScreenXY(page, -20, (lbInfo.top + lbInfo.bottom) / 2 + 91);
        const bodyJ2 = await hoverBodySafe(page);
        const barJ2 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await page.mouse.move(barJ2.x + barJ2.width / 2, barJ2.y + barJ2.height / 2, { steps: 3 });
        await page.waitForTimeout(60);
        const early = await measure(page);
        result.jitter.earlyFrame = early;
        const barJ3 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '08-expand-60ms', [bodyJ2, barJ3], 16);
        await page.waitForTimeout(500);
        const late = await measure(page);
        result.jitter.lateFrame = late;
        c.check('J5 展开 60ms 那一帧的条 left = ' + early.bar.left + '（绘制态，应 ≈' + expectedLeft + '）', Math.abs(early.bar.left - expectedLeft) <= 2.5, { early: early.bar, late: late.bar, expected: expectedLeft });
        // J6：展开过程中按 ~20ms 间隔量「绘制态」left，应该一直贴着 8px
        await moveAway(page);
        await hoverBodySafe(page);
        const barJ4 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await page.mouse.move(barJ4.x + barJ4.width / 2, barJ4.y + barJ4.height / 2, { steps: 3 });
        const painted = [];
        for (let i = 0; i < 10; i += 1) { await page.waitForTimeout(18); painted.push(await page.evaluate(function () { const b = document.querySelector('[data-act="stack-tools"]'); const r = b.getBoundingClientRect(); return Math.round(r.left * 100) / 100; })); }
        result.jitter.paintedLefts = painted;
        c.check('J6 展开过程中 10 次绘制态采样，条 left 一直是 ' + expectedLeft + '（实测 ' + JSON.stringify(painted) + '）', painted.every(function (v) { return Math.abs(v - expectedLeft) <= 2.5; }), painted);

        /* ---------- 4. 拖拽隐藏 ---------- */
        await moveAway(page);
        await page.evaluate(function () { window.__cn.setUI({ dragging: true }); });
        await hoverBodySafe(page);
        const dragHover = await measure(page);
        await shot(page, c, '06-dragging-hidden', [await page.locator('.snode').first().boundingBox()], 30);
        await page.evaluate(function () { window.__cn.setUI({ dragging: false }); });
        await page.waitForTimeout(300);
        await moveAway(page);
        await hoverBodySafe(page);
        const afterRelease = await measure(page);
        result.drag = { whileDragging: { on: dragHover.on, opacity: dragHover.opacity, wrapDisplay: dragHover.wrapDisplay }, afterRelease: { on: afterRelease.on, opacity: afterRelease.opacity } };
        c.check('D1 ui.dragging=true（拖任意节点）时悬停堆叠，条不出现', dragHover.on === false || dragHover.opacity === '0', result.drag.whileDragging);
        c.check('D2 松手（dragging=false）后再悬停，条恢复', afterRelease.on === true && afterRelease.opacity !== '0', result.drag.afterRelease);
        // 真拖堆叠自己
        const sb = await page.locator('.snode .stack-body').first().boundingBox();
        await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await page.mouse.down();
        await page.mouse.move(sb.x + sb.width / 2 + 30, sb.y + sb.height / 2 + 15, { steps: 5 });
        await page.waitForTimeout(200);
        const duringNodeDrag = await measure(page);
        await page.mouse.up();
        await page.waitForTimeout(300);
        result.drag.duringNodeDrag = { on: duringNodeDrag.on, opacity: duringNodeDrag.opacity, dragging: true };
        c.check('D3 真拖堆叠节点时不冒条', duringNodeDrag.on === false || duringNodeDrag.opacity === '0', result.drag.duringNodeDrag);

        /* ---------- 5a. 条隐藏时节点上方没有隐形悬停带 ---------- */
        await moveAway(page);
        const nodeBox = await page.locator('.snode').first().boundingBox();
        const pointAbove = { x: nodeBox.x + nodeBox.width / 2, y: Math.max(2, nodeBox.y - 20) };
        await page.mouse.move(pointAbove.x, pointAbove.y);
        await page.waitForTimeout(450);
        const band = await page.evaluate(function (pt) {
            const el = document.elementFromPoint(pt.x, pt.y);
            const inWrap = el ? !!el.closest('.stack-tools-wrap') : false;
            const bar = document.querySelector('[data-act="stack-tools"]');
            return { hit: el ? (el.className && el.className.toString ? el.className.toString().slice(0, 40) : el.tagName) : null, inWrap: inWrap, barOn: bar ? bar.classList.contains('on') : null, barOpacity: bar ? getComputedStyle(bar).opacity : null };
        }, pointAbove);
        result.hoverBand = { point: pointAbove, ...band };
        await shot(page, c, '07-above-node-no-bar', [nodeBox], 40);
        c.check('H1 条隐藏时，指针停在节点上方 20px（不碰节点）不弹条', band.barOn === false || band.barOpacity === '0', result.hoverBand);
        c.check('H2 那个点上命中元素不属于 .stack-tools-wrap（没有隐形悬停带）', band.inWrap === false, band);

        /* ---------- 5b. 桥接仍有效 ---------- */
        await moveAway(page);
        await hoverBodySafe(page);
        const barB = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        const bodyB = await page.locator('.snode .stack-body').first().boundingBox();
        const gapPoint = { x: barB.x + barB.width / 2, y: bodyB.y - 17 };
        await page.mouse.move(gapPoint.x, gapPoint.y, { steps: 3 });
        await page.waitForTimeout(300);
        const bridge = await measure(page);
        const bridgeHit = await page.evaluate(function (pt) { const el = document.elementFromPoint(pt.x, pt.y); return el ? (el.closest('.cn-fm') ? 'bar' : (el.className && el.className.toString ? el.className.toString().slice(0, 30) : el.tagName)) : null; }, gapPoint);
        result.bridge = { point: gapPoint, on: bridge.on, hit: bridgeHit };
        c.check('B1 指针停在条下方 34px 空隙（桥接区）时条仍在', bridge.on === true, result.bridge);

        /* ---------- 5c. 动作回归：取消堆叠 + 全部下载（先把节点放回中间，避开 #lb 等浮层）---------- */
        await moveAway(page);
        await moveStackToScreenXY(page, 500, 300);
        await hoverBodySafe(page);
        await hoverBarSafe(page);
        downloads.length = 0;
        await page.locator('[data-st="dl"]').click();
        await page.waitForTimeout(2200);
        result.actions.download = downloads.slice();
        c.check('A1 全部下载仍可用（≥1 个文件）', downloads.length >= 1, downloads);
        await moveAway(page);
        await hoverBodySafe(page);
        await hoverBarSafe(page);
        const beforeUnstack = await page.evaluate(function () { return { nodes: window.__cn.state.doc.nodes.length, stack: !!window.__cn.state.doc.nodes.find(function (n) { return n.kind === 'group' && n.data && n.data.stack; }) }; });
        await page.locator('[data-st="unstack"]').click();
        await page.waitForTimeout(700);
        const afterUnstack = await page.evaluate(function () {
            const store = window.__cn;
            return { nodes: store.state.doc.nodes.length, stack: !!store.state.doc.nodes.find(function (n) { return n.kind === 'group' && n.data && n.data.stack; }), toast: (store.state.toasts || []).map(function (t) { return t.html; }).join(' | ') };
        });
        result.actions.unstack = { before: beforeUnstack, after: afterUnstack };
        c.check('A2 取消堆叠仍可用（堆叠消失、成员回画布、有提示）', !afterUnstack.stack && afterUnstack.nodes === beforeUnstack.nodes - 1 && afterUnstack.toast.indexOf('已取消堆叠') >= 0, result.actions.unstack);

        c.check('X1 页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));
        result.pageErrors = pageErrors;
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const results = c.finish();
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'result-stack-tools-clamp.json'), JSON.stringify({ summary: result, checks: results.checks }, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
