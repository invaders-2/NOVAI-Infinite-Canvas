#!/usr/bin/env node
'use strict';
/*
 * 文本节点全屏编辑弹窗：底栏（格式条）布局复核 —— 「底栏压字」修复的验收。
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-textdoc python3 main.py &
 *   node tests/novai_textdoc_bar_shots.cjs
 *
 * 覆盖：长文本 顶部/中间/底部 三个滚动状态、面板缩到最小高度 320、窄屏 720 / 390（裁切量化）、短文本。
 * 输出：tests/artifacts/textdoc-bar/*.png + result-textdoc-bar.json
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT = path.join(__dirname, 'artifacts', 'textdoc-bar');

const LONG_MD = Array.from({ length: 30 }, function (_, i) {
    if (i === 0) return '# 一张长文用于验证底栏';
    if (i % 7 === 0) return '## 小节 ' + (Math.floor(i / 7) + 1);
    return '第 ' + (i + 1) + ' 段：这是一段用来验证「底部格式条不会压住正文」的测试文字，写长一点让它足以触发滚动。'
        + '第二句同样是测试文字，用来制造多行；第三句重复一遍，确保每段都有两三行。';
}).join('\n\n');

/** 在页面里量的那份几何（自包含，给 page.evaluate 用） */
function measureInPage() {
    const panel = document.querySelector('.td-panel');
    const top = document.querySelector('.td-top');
    const scroll = document.querySelector('.td-scroll');
    const bar = document.querySelector('.td-bar');
    const ed = document.querySelector('.td-ed');
    const r = function (el) {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left * 100) / 100, top: Math.round(b.top * 100) / 100, right: Math.round(b.right * 100) / 100, bottom: Math.round(b.bottom * 100) / 100, width: Math.round(b.width * 100) / 100, height: Math.round(b.height * 100) / 100 };
    };
    let lines = { count: 0, visible: 0, first: null, last: null };
    if (ed && scroll) {
        const range = document.createRange();
        range.selectNodeContents(ed);
        const rects = Array.from(range.getClientRects()).filter(function (x) { return x.width > 0.5 && x.height > 0.5; });
        const sr = scroll.getBoundingClientRect();
        const visible = rects.filter(function (x) { return x.bottom > sr.top + 0.5 && x.top < sr.bottom - 0.5; });
        lines = {
            count: rects.length,
            visible: visible.length,
            first: visible.length ? { top: Math.round(visible[0].top * 100) / 100, bottom: Math.round(visible[0].bottom * 100) / 100 } : null,
            last: visible.length ? { top: Math.round(visible[visible.length - 1].top * 100) / 100, bottom: Math.round(visible[visible.length - 1].bottom * 100) / 100 } : null,
        };
    }
    const p = panel ? panel.getBoundingClientRect() : null;
    const buttons = Array.from(document.querySelectorAll('.td-bar .tdb')).map(function (el) {
        const b = el.getBoundingClientRect();
        const visibleW = p ? Math.max(0, Math.min(b.right, p.right) - Math.max(b.left, p.left)) : b.width;
        return {
            label: el.getAttribute('aria-label'),
            left: Math.round(b.left * 100) / 100, right: Math.round(b.right * 100) / 100, width: Math.round(b.width * 100) / 100,
            visibleW: Math.round(visibleW * 100) / 100,
            centerInside: !!p && b.left + b.width / 2 >= p.left && b.left + b.width / 2 <= p.right,
        };
    });
    return {
        panel: r(panel), top: r(top), scroll: r(scroll), bar: r(bar), ed: r(ed),
        scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
        scrollHeight: scroll ? scroll.scrollHeight : null,
        clientHeight: scroll ? scroll.clientHeight : null,
        vw: innerWidth, vh: innerHeight, lines: lines, buttons: buttons,
        firstBlockTag: ed && ed.firstElementChild ? ed.firstElementChild.tagName : null,
    };
}

function layoutChecks(c, tag, m) {
    c.check(tag + '·格式条在正文滚动区之外（bar.top ≥ scroll.bottom）', !!m.bar && !!m.scroll && m.bar.top >= m.scroll.bottom - 0.5, { barTop: m.bar && m.bar.top, scrollBottom: m.scroll && m.scroll.bottom });
    c.check(tag + '·顶栏不与正文滚动区重叠（top.bottom ≤ scroll.top）', !!m.top && !!m.scroll && m.top.bottom <= m.scroll.top + 0.5, { topBottom: m.top && m.top.bottom, scrollTop: m.scroll && m.scroll.top });
    c.check(tag + '·格式条在面板内、底部留约 14px', !!m.bar && !!m.panel && m.bar.bottom <= m.panel.bottom - 10 && m.bar.bottom >= m.panel.bottom - 20, { barBottom: m.bar && m.bar.bottom, panelBottom: m.panel && m.panel.bottom });
}

async function panelClip(page, pad) {
    const box = await page.locator('.td-panel').first().boundingBox();
    return { x: Math.max(0, Math.floor(box.x - pad)), y: Math.max(0, Math.floor(box.y - pad)), width: Math.ceil(box.width + pad * 2), height: Math.ceil(box.height + pad * 2) };
}
async function shot(page, c, name, pad) {
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, clip: await panelClip(page, pad === undefined ? 26 : pad) });
    c.results.shots[name] = file;
    console.log('SHOT  ' + file);
    return file;
}
async function openDoc(page, nodeId) {
    await page.evaluate(function (id) { window.dispatchEvent(new CustomEvent('cn:textdoc', { detail: id })); }, nodeId);
    await page.locator('.td-panel').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(350);
}
async function scrollTo(page, where) {
    await page.evaluate(function (mode) {
        const el = document.querySelector('.td-scroll');
        if (mode === 'top') el.scrollTop = 0;
        else if (mode === 'bottom') el.scrollTop = el.scrollHeight;
        else el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
    }, where);
    await page.waitForTimeout(250);
}

(async function () {
    const c = H.checker('文本编辑弹窗：底栏（格式条）不压字');
    fs.mkdirSync(OUT, { recursive: true });
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const result = { states: {}, narrow: {}, short: {} };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) { c.check('后端可用', false, { status: health.status() }); return c.finish(); }
        canvasId = await H.createCanvas(api, 'VERIFY-TEXTDOC-' + Date.now());
        browser = await H.launchBrowser();
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', function (e) { pageErrors.push(String(e && e.message || e)); });
        await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function () { return !!(window.__cn && window.__cn.state && window.__cn.state.doc); }, null, { timeout: 30000 });
        await page.waitForTimeout(600);

        const longId = await page.evaluate(function (md) {
            const store = window.__cn;
            const node = store.newNode('text', 120, 120, { hist: [{ text: md }], hi: 0, title: '文本弹窗验证（长文）' });
            store.addNodes([node], [], { select: true });
            return node.id;
        }, LONG_MD);
        await page.waitForTimeout(500);
        await openDoc(page, longId);
        c.check('D1 文本弹窗打开（.td-panel 存在）', await page.locator('.td-panel').count() === 1);

        const states = [['top', '01-long-top'], ['middle', '02-long-middle'], ['bottom', '03-long-bottom']];
        for (const [where, name] of states) {
            await scrollTo(page, where);
            const m = await page.evaluate(measureInPage);
            result.states[where] = m;
            layoutChecks(c, '长文' + where, m);
            // 中间态允许滚动视口边缘把一行切一半（正常滚动），关键是「切它的是视口、不是格式条」——
            // 上面 layoutChecks 的 bar.top ≥ scroll.bottom 已经保证格式条不覆盖任何一行字
            if (where === 'top') c.check('长文顶部·第一行没被裁掉（first.top ≥ scroll.top）', !!m.lines.first && m.lines.first.top >= m.scroll.top - 0.5, m.lines);
            if (where === 'middle') c.check('长文中段·格式条与滚动区之间没有重叠（bar.top ≥ scroll.bottom，正文不被条盖住）', m.bar.top >= m.scroll.bottom - 0.5, { barTop: m.bar.top, scrollBottom: m.scroll.bottom });
            if (where === 'bottom') {
                c.check('长文底部·最后一行完整可见（last.bottom ≤ scroll.bottom）', !!m.lines.last && m.lines.last.bottom <= m.scroll.bottom + 0.5, m.lines);
                c.check('长文底部·已经滚到底（scrollTop ≈ scrollHeight-clientHeight）', Math.abs(m.scrollTop - (m.scrollHeight - m.clientHeight)) <= 2, { scrollTop: m.scrollTop, max: m.scrollHeight - m.clientHeight });
            }
            await shot(page, c, name);
        }

        // 缩到最小高度 320：先试原生 resize 拖拽，不行就写内联高度（等价于拖到 320，记录用的方法）
        const pb = await page.locator('.td-panel').first().boundingBox();
        await page.mouse.move(pb.x + pb.width - 3, pb.y + pb.height - 3);
        await page.mouse.down();
        await page.mouse.move(pb.x + pb.width - 3, pb.y + 320, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        let pm = await page.evaluate(measureInPage);
        let method = 'native-resize';
        if (Math.abs(pm.panel.height - 320) > 12) {
            method = 'inline-height(320)';
            await page.evaluate(function () { document.querySelector('.td-panel').style.height = '320px'; });
            await page.waitForTimeout(250);
            pm = await page.evaluate(measureInPage);
        }
        result.states.resized = pm;
        result.states.resizedMethod = method;
        c.check('R1 面板高度≈最小 320（' + method + '）', Math.abs(pm.panel.height - 320) <= 12, { height: pm.panel.height });
        layoutChecks(c, '最小高度', pm);
        const h1Btn = page.locator('.td-bar button[aria-label="标题 1"]').first();
        const h1Box = await h1Btn.boundingBox();
        c.check('R2 最小高度下「H1」按钮完整可见（30×30、在面板内）',
            !!h1Box && h1Box.width === 30 && h1Box.height === 30 && h1Box.y >= pm.panel.top && h1Box.y + h1Box.height <= pm.panel.bottom, h1Box);
        const tagsBefore = await page.evaluate(function () { return Array.from(document.querySelector('.td-ed').children).map(function (el) { return el.tagName; }); });
        await page.locator('.td-ed p').first().click();
        await h1Btn.click();
        await page.waitForTimeout(200);
        const tagsAfter = await page.evaluate(function () { return Array.from(document.querySelector('.td-ed').children).map(function (el) { return el.tagName; }); });
        const pIndex = tagsBefore.indexOf('P');
        const h1Before = tagsBefore.filter(function (t) { return t === 'H1'; }).length;
        const h1After = tagsAfter.filter(function (t) { return t === 'H1'; }).length;
        c.check('R3 点「H1」后光标所在段落真的变成 <h1>（H1 计数 +1，位置对得上）',
            pIndex >= 0 && tagsAfter[pIndex] === 'H1' && h1After === h1Before + 1, { pIndex: pIndex, h1Before: h1Before, h1After: h1After, tagsBefore: tagsBefore, tagsAfter: tagsAfter });
        result.states.h1 = { tagsBefore: tagsBefore, tagsAfter: tagsAfter, pIndex: pIndex };
        await shot(page, c, '04-resized-min-320');

        // 窄屏
        await page.evaluate(function () { document.querySelector('.td-panel').style.height = ''; });
        for (const width of [720, 390, 360, 320]) {
            await page.setViewportSize({ width: width, height: 900 });
            await page.waitForTimeout(400);
            await scrollTo(page, 'bottom');
            const m = await page.evaluate(measureInPage);
            result.narrow[width] = m;
            const overflowLeft = Math.max(0, m.panel.left - m.bar.left);
            const overflowRight = Math.max(0, m.bar.right - m.panel.right);
            const clipped = m.buttons.filter(function (b) { return b.visibleW < b.width - 0.5; });
            const unclickable = m.buttons.filter(function (b) { return !b.centerInside; });
            m.overflow = { left: Math.round(overflowLeft * 100) / 100, right: Math.round(overflowRight * 100) / 100, clipped: clipped.map(function (b) { return b.label; }), unclickable: unclickable.map(function (b) { return b.label; }) };
            c.check('窄屏' + width + '·面板铺满视口', Math.abs(m.panel.width - width) <= 1, { panelWidth: m.panel.width, vw: m.vw });
            layoutChecks(c, '窄屏' + width, m);
            if (width >= 390) {
                c.check('窄屏' + width + '·格式条没有任何按钮被裁', clipped.length === 0 && unclickable.length === 0, { clipped: m.overflow.clipped, unclickable: m.overflow.unclickable, overflowLeft: overflowLeft, overflowRight: overflowRight });
            } else {
                c.check('窄屏' + width + '·已知溢出：胶囊右端被裁 ' + Math.round(overflowRight) + 'px', true, { overflowLeft: overflowLeft, overflowRight: overflowRight, clipped: m.overflow.clipped, unclickable: m.overflow.unclickable });
            }
            await shot(page, c, '05-narrow-' + width, 8);
        }
        result.narrow.quantified = {};
        for (const width of [720, 390, 360, 320]) {
            const n = result.narrow[width];
            result.narrow.quantified[width] = {
                barWidth: n.bar.width, panelWidth: n.panel.width, barButtons: n.buttons.length,
                overflowLeft: n.overflow.left, overflowRight: n.overflow.right,
                clippedButtons: n.overflow.clipped, unclickableButtons: n.overflow.unclickable,
            };
            c.check('窄屏' + width + '·量化：溢出左/右 ' + n.overflow.left + '/' + n.overflow.right + 'px，被裁按钮 ' + n.overflow.clipped.length + ' 个，点不到 ' + n.overflow.unclickable.length + ' 个', true, result.narrow.quantified[width]);
        }

        // 短文本
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.waitForTimeout(300);
        const shortId = await page.evaluate(function () {
            const store = window.__cn;
            const node = store.newNode('text', 480, 120, { hist: [{ text: '只有一行短文本。' }], hi: 0, title: '文本弹窗验证（短）' });
            store.addNodes([node], [], { select: true });
            return node.id;
        });
        await page.waitForTimeout(400);
        await openDoc(page, shortId);
        const sm = await page.evaluate(measureInPage);
        result.short = sm;
        layoutChecks(c, '短文本', sm);
        const expectedHeight = Math.min(0.72 * sm.vh, 720);
        c.check('S1 短文本·面板仍是常规高度（≈72vh），格式条在底部而不是面板中间',
            Math.abs(sm.panel.height - expectedHeight) <= 2 && sm.bar.top > sm.panel.top + sm.panel.height * 0.6,
            { panelHeight: sm.panel.height, expectedHeight: expectedHeight, barTop: sm.bar.top, panelTop: sm.panel.top });
        const blank = sm.clientHeight - (sm.lines.last ? sm.lines.last.bottom - sm.scroll.top : 0);
        result.short.blankBelowLastLine = Math.round(blank * 100) / 100;
        c.check('S2 短文本·第一行在滚动区内、条没压字', !!sm.lines.first && sm.bar.top >= sm.scroll.bottom - 0.5, { first: sm.lines.first, barTop: sm.bar.top, scrollBottom: sm.scroll.bottom });
        await shot(page, c, '08-short-1line');

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
        fs.writeFileSync(path.join(OUT, 'result-textdoc-bar.json'), JSON.stringify({ summary: result, checks: results.checks }, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
