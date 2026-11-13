#!/usr/bin/env node
/*
 * 界面缩放 / 窗口尺寸验收（手动跑，需真实后端 + Playwright + Chrome）：
 *   S1. 1366x768 / 1920x1080 / 2560x1440 / 3840x2160 × dpr 1/1.25/1.5 打开 /v2：
 *       --studio-ui-scale=1、StudioScale.getScale()=1、body transform=none、没有 studio-ui-scaled class；
 *   S2. 启动过程没有放大再缩回的跳变：整个加载期 --studio-ui-scale 只出现过 1；
 *   S3. 画布页在 1366x768 / 1080p@125% / 2K / 4K 下 #tr 与窗口三键保持 8px 间距（scale=1）。
 *
 * 跑法：
 *   NOVAI_PORT=3956 NOVAI_DATA_DIR=/tmp/novai-scale venv/bin/python main.py &
 *   BASE=http://127.0.0.1:3956 CANVAS=<画布 id> NODE_PATH=/Users/wepingli/node_modules node tests/theme_scale_verify.cjs
 * 截图写到 SHOT（默认 /tmp/novai-scale-shots）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:3956';
const CANVAS = process.env.CANVAS || '';
const SHOT = process.env.SHOT || '/tmp/novai-scale-shots';
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + label); return; }
    fails.push(label + (extra ? ' -> ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + label + (extra ? ' -> ' + JSON.stringify(extra) : ''));
};

const RECORD_SCALE = () => {
    window.__scaleHistory = [];
    try {
        const orig = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
            if (name === '--studio-ui-scale') window.__scaleHistory.push(String(value));
            return orig.call(this, name, value, priority);
        };
    } catch (e) {}
};

async function checkShell(browser, width, height, dpr) {
    const label = width + 'x' + height + '@dpr' + dpr;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    await ctx.addInitScript(() => { try { localStorage.setItem('novai-visited', '1'); } catch (e) {} });
    await ctx.addInitScript(RECORD_SCALE);
    const page = await ctx.newPage();
    await page.goto(BASE + '/v2', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell', { timeout: 20000 });
    const samples = [];
    for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(120);
        samples.push(await page.evaluate(() => Number((getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale') || '').trim() || 0)));
    }
    const result = await page.evaluate(() => ({
        scaleVar: Number((getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale') || '').trim()),
        getScale: window.StudioScale ? window.StudioScale.getScale() : null,
        transform: getComputedStyle(document.body).transform,
        scaledClass: document.documentElement.classList.contains('studio-ui-scaled'),
        history: window.__scaleHistory || [],
        inner: [innerWidth, innerHeight],
        overflowX: document.documentElement.scrollWidth - innerWidth,
        bodyOverflowX: document.body.scrollWidth - innerWidth,
    }));
    if (width === 1366 && height === 768 && dpr === 1) await page.screenshot({ path: SHOT + '/shell-1366x768-dpr1.png' });
    await ctx.close();
    ok(result.scaleVar === 1, 'S1 ' + label + ' --studio-ui-scale=1', result.scaleVar);
    ok(result.getScale === 1, 'S1 ' + label + ' StudioScale.getScale()=1', result.getScale);
    ok(result.transform === 'none', 'S1 ' + label + ' body transform=none', result.transform);
    ok(result.scaledClass === false, 'S1 ' + label + ' 没有 studio-ui-scaled class');
    ok(result.overflowX <= 1 && result.bodyOverflowX <= 1, 'S1 ' + label + ' 100% 下没有横向溢出', { root: result.overflowX, body: result.bodyOverflowX });
    const seen = result.history.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    ok(seen.length > 0 && seen.every((v) => Math.abs(v - 1) < 1e-6), 'S2 ' + label + ' 启动期只出现 scale=1（无放大再缩回）', seen);
    ok(samples.every((v) => Math.abs(v - 1) < 1e-6), 'S2 ' + label + ' 加载后采样全部 scale=1', samples);
    return result;
}

async function checkCanvasSpacing(browser, width, height, dpr, canvasId) {
    const label = 'canvas ' + width + 'x' + height + '@dpr' + dpr;
    const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: dpr,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pywebview',
    });
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        window.pywebview = { api: {} };
        try { localStorage.setItem('novai-visited', '1'); } catch (e) {}
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId) + '&debugGen=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.cn-root', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.postMessage({ type: 'novai:canvas-chrome', left: 0, right: 112, top: 16 }, '*'));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'mock-win-controls';
        d.style.cssText = 'position:fixed;top:16px;right:16px;height:40px;z-index:99999;display:flex;align-items:center;gap:4px;pointer-events:none;box-sizing:content-box';
        for (const t of ['—', '□', '×']) {
            const b = document.createElement('button');
            b.textContent = t;
            b.style.cssText = 'width:32px;height:32px;border:0;border-radius:9px;background:rgba(255,255,255,.2);color:#fff;font:14px/1 system-ui;box-sizing:border-box';
            d.appendChild(b);
        }
        document.body.appendChild(d);
    });
    const data = await page.evaluate(() => {
        const tr = document.querySelector('#tr');
        const win = document.querySelector('#mock-win-controls');
        if (!tr || !win) return null;
        const a = tr.getBoundingClientRect();
        const b = win.getBoundingClientRect();
        return {
            tr: { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
            win: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
            gap: b.left - a.right,
            scale: Number((getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale') || '1').trim()),
            transform: getComputedStyle(document.body).transform,
        };
    });
    if (width === 1366 && dpr === 1) await page.screenshot({ path: SHOT + '/canvas-1366x768-dpr1.png' });
    await ctx.close();
    ok(!!data, label + ' #tr / 三键都存在');
    if (data) {
        ok(data.scale === 1, label + ' scale=1');
        ok(data.transform === 'none', label + ' body transform=none', data.transform);
        ok(data.gap >= 8, label + ' #tr 与窗口三键间距 ≥ 8px', data.gap);
        ok(data.win.right <= width - 16 && data.tr.right <= data.win.left, label + ' 三键与 #tr 都在窗口内', { tr: data.tr, win: data.win });
    }
}

(async () => {
    if (!CANVAS) { console.error('缺少 CANVAS（画布 id）'); process.exit(2); }
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const sizes = [[1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]];
    const dprs = [1, 1.25, 1.5];
    for (const [w, h] of sizes) {
        console.log('\n[' + w + 'x' + h + ']');
        for (const dpr of dprs) await checkShell(browser, w, h, dpr);
    }
    for (const [w, h, dpr] of [[1366, 768, 1], [1920, 1080, 1.25], [2560, 1440, 1.5], [3840, 2160, 1.5]]) {
        console.log('\n[画布三键间距]');
        await checkCanvasSpacing(browser, w, h, dpr, CANVAS);
    }
    await browser.close();
    console.log('\n截图：' + SHOT);
    if (fails.length) {
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach((f) => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项）');
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(1); });
