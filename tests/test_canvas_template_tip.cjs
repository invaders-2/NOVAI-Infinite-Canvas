#!/usr/bin/env node
'use strict';
/*
 * 模板面板 + 引导卡（.tpl-tip）的定位：
 *   空画布点顶部工具行的「模板」→ 面板与引导卡必须作为**一个整体**落在视口内：
 *     1) tip.left ≈ panel.left（±2px，左缘对齐）
 *     2) tip 与 panel 矩形不相交（引导卡在面板上方或下方，不压面板）
 *     3) tip 完整在视口 [0, innerWidth] × [0, innerHeight] 内
 *     4) panel 完整在视口内
 *   矮窗口（500 面板 + 引导卡 > 视口）是重点：面板优先完整可见，高度按实收窄。
 *
 * 跑法（不碰 3000 端口、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_template_tip.cjs
 *   node tests/test_canvas_template_tip.cjs --shots _verification-template-tip
 * 退出码 0 = 全绿，1 = 有断言失败。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__tpl-tip-e2e.html');
const PAGE_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><style>html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}</style></head>\n<body><div id="root"></div><script type="module" src="/src/canvas/canvas-next/dev/main.tsx"></script></body></html>\n';
/* 宿主把画布框（.cn-root）给的比窗口更高：桌面 WebContentsView / 外层 iframe / 带滚动外壳都会这样，
   正是用户截图那一档（面板被顶到折线以下、只剩引导卡留在视口里）。 */
const TALL_PAGE_FILE = path.join(UI_DIR, '__tpl-tip-tall-e2e.html');
const TALL_PAGE_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><style>html,body{height:100%;width:100%;margin:0;overflow:hidden}#root{width:100%;height:1124px}</style></head>\n<body><div id="root"></div><script type="module" src="/src/canvas/canvas-next/dev/main.tsx"></script></body></html>\n';

const WINDOWS = [
    { width: 1674, height: 626, name: 'user-1674x626' },
    { width: 1440, height: 900, name: 'laptop-1440x900' },
    { width: 2128, height: 796, name: 'preview-2128x796' },
    { width: 1280, height: 620, name: 'short-1280x620' },
    { width: 1674, height: 626, tall: true, name: 'host-frame-taller-than-window-1674x626' },
    { width: 1674, height: 626, dismiss: true, name: 'short-1674x626-after-dismiss' },
];
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(ROOT, process.argv[shotsArg + 1]) : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
function check(name, ok, detail) {
    if (ok) { passed += 1; console.log('PASS  ' + name); }
    else { failed.push(name); console.log('FAIL  ' + name + (detail === undefined ? '' : '  ::  ' + JSON.stringify(detail))); }
}
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    });
}
function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (error) { return ''; } })(),
        path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error('找不到可用的 Chromium：设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return found;
}
async function startVite(port) {
    const bin = path.join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(bin)) throw new Error('novai-canvas-ui 还没装依赖：先 cd novai-canvas-ui && npm install');
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    fs.writeFileSync(TALL_PAGE_FILE, TALL_PAGE_HTML);
    const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: UI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += String(d); });
    child.stderr.on('data', (d) => { log += String(d); });
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__tpl-tip-e2e.html';
    const tallUrl = 'http://127.0.0.1:' + port + '/static/novai-canvas/__tpl-tip-tall-e2e.html';
    for (let i = 0; i < 160; i += 1) {
        await sleep(250);
        if (child.exitCode !== null) throw new Error('vite 起不来（exit ' + child.exitCode + '）：\n' + log);
        try {
            const res = await fetch(url);
            const tallRes = await fetch(tallUrl);
            if (res.ok && (await res.text()).includes('id="root"') && tallRes.ok && (await tallRes.text()).includes('id="root"')) return { child, url, tallUrl };
        } catch (error) { /* 还在启动 */ }
    }
    child.kill('SIGTERM');
    throw new Error('vite 等待超时：\n' + log);
}
function stopVite(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } resolve(); }, 3000);
    });
}

/** 量 .cn-root / 锚点 / .tpl-wrap / .tpl / .tpl-tip，附上 wrap 的内联定位（= useAnchorPos 的结果） */
async function measure(page) {
    return page.evaluate(() => {
        const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
        };
        const wrap = document.querySelector('.tpl-wrap');
        const tip = document.querySelector('[data-tpl-tip]');
        const panel = document.querySelector('[data-tpl-panel]');
        const root = document.querySelector('.cn-root');
        const anchor = document.querySelector('[data-drawer="templates"]');
        return {
            window: { width: innerWidth, height: innerHeight },
            root: rect(root),
            anchor: rect(anchor),
            wrap: rect(wrap),
            wrapStyle: wrap ? { left: wrap.style.left, top: wrap.style.top, height: wrap.style.height, visibility: wrap.style.visibility } : null,
            panel: rect(panel),
            tip: rect(tip),
            tipBottomCss: tip ? getComputedStyle(tip).bottom : null,
            tipText: tip ? (tip.textContent || '').trim().slice(0, 12) : null,
        };
    });
}

async function runWindow(browser, url, win) {
    const ctx = await browser.newContext({ viewport: { width: win.width, height: win.height } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    await page.goto(url + '?empty=1&speed=8');
    await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.models && window.__cn.state.models.length, null, { timeout: 60000 });
    await sleep(500);
    // 用户路径：空画布顶部工具行的「模板」按钮
    await page.locator('[data-flow="tpl"]').click();
    await page.waitForSelector('[data-tpl-panel]', { timeout: 10000 });
    await page.waitForSelector('[data-tpl-tip]', { timeout: 10000 });
    await sleep(600);
    // 面板入场动画（tplIn .15s：translate(-8px) scale(.95)）要收干净再量，否则量到的是动画首帧
    await page.evaluate(() => { document.querySelectorAll('.tpl, .tpl-tip').forEach((el) => { try { el.getAnimations().forEach((a) => a.finish()); } catch (error) { /* 没有动画 */ } }); });
    // 版式定稿（字体 / 缩略图）后再量：等两帧矩形一致
    let prev = '';
    for (let i = 0; i < 40; i += 1) {
        const now = await page.evaluate(() => JSON.stringify(['.tpl-wrap', '.tpl', '[data-tpl-tip]'].map((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
        })));
        if (now === prev) break;
        prev = now;
        await sleep(120);
    }

    const m = await measure(page);
    const { window: vp, panel, tip } = m;
    console.log('\n== ' + win.name + '  (' + vp.width + 'x' + vp.height + ')');
    console.log('   innerWidth/innerHeight = ' + vp.width + '/' + vp.height);
    console.log('   cn-root   = ' + JSON.stringify(m.root));
    console.log('   anchor(模板按钮) = ' + JSON.stringify(m.anchor));
    console.log('   .tpl-wrap = ' + JSON.stringify(m.wrap) + '  inline=' + JSON.stringify(m.wrapStyle));
    console.log('   .tpl      = ' + JSON.stringify(panel));
    console.log('   .tpl-tip  = ' + JSON.stringify(tip) + '  css.bottom=' + m.tipBottomCss + '  text=' + JSON.stringify(m.tipText));

    const pad = 0.5;
    const pad0 = 0.5;
    const inView = (r) => !!r && r.left >= -pad && r.top >= -pad && r.right <= vp.width + pad && r.bottom <= vp.height + pad;
    const overlap = (a, b) => !!a && !!b && a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;

    if (win.dismiss) {
        // 点「知道了」关掉引导卡：面板要长回 500 且仍然完整在视口内（定位跟着重算）
        await page.locator('[data-tpl-tip-dismiss]').click();
        await sleep(400);
        const after = await measure(page);
        const stillPanel = after.panel;
        check(win.name + '：关掉引导卡后面板长回 500，且仍完整在视口内', !!stillPanel
            && Math.abs(stillPanel.height - 500) <= 1
            && stillPanel.top >= -pad0 && stillPanel.bottom <= vp.height + pad0
            && !after.tip, { panel: stillPanel, tipGone: !after.tip, viewport: vp });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, win.name + '.png') });
    }

    check(win.name + '：模板面板已定位（不是 hidden / 0 尺寸）', !!panel && panel.width > 0 && panel.height > 0 && m.wrapStyle && m.wrapStyle.visibility !== 'hidden', { panel, wrapStyle: m.wrapStyle });
    check(win.name + '：引导卡左缘与面板左缘对齐（±2px）', !!tip && !!panel && Math.abs(tip.left - panel.left) <= 2, { tipLeft: tip && tip.left, panelLeft: panel && panel.left });
    check(win.name + '：引导卡与面板不相交', !!tip && !!panel && !overlap(tip, panel), { tip, panel });
    check(win.name + '：引导卡完整在视口内', inView(tip), { tip, viewport: vp });
    check(win.name + '：面板完整在视口内', inView(panel), { panel, viewport: vp });
    check(win.name + '：引导卡高度 >= 150（没被压扁）', !!tip && tip.height >= 150, { tipHeight: tip && tip.height });
    check(win.name + '：面板宽度仍是 500（没被横向破坏）', !!panel && Math.abs(panel.width - 500) <= 1, { panelWidth: panel && panel.width });
    check(win.name + '：无页面异常', pageErrors.length === 0, pageErrors);

    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, win.name + '.png') });
    }
    const evidence = { window: win, viewport: vp, root: m.root, anchor: m.anchor, wrap: m.wrap, wrapStyle: m.wrapStyle, panel, tip, tipText: m.tipText, pageErrors };
    await ctx.close();
    return evidence;
}

/** 每档窗口单独起一个无头 Chromium（跑完就关）：画布页很吃内存，连续 6 个 context 会把 renderer 拖崩
 *  （Target crashed）。偶发崩溃时整档重跑一次，断言计数回滚。 */
async function runWindowStable(url, win) {
    const passedBefore = passed;
    const failedBefore = failed.slice();
    for (let attempt = 1; ; attempt += 1) {
        let browser = null;
        try {
            browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
            return await runWindow(browser, url, win);
        } catch (error) {
            passed = passedBefore;
            failed.length = 0;
            failedBefore.forEach((name) => failed.push(name));
            if (attempt >= 3) throw error;
            console.log('   [retry] ' + win.name + ' 第 ' + attempt + ' 次跑挂了：' + ((error && error.message) || error));
            await sleep(600);
        } finally {
            if (browser) await browser.close().catch(() => undefined);
        }
    }
}

async function main() {
    const port = await freePort();
    const { child, url, tallUrl } = await startVite(port);
    const evidence = { startedAt: new Date().toISOString(), url, tallUrl, windows: {} };
    try {
        for (const win of WINDOWS) evidence.windows[win.name] = await runWindowStable(win.tall ? tallUrl : url, win);
    } finally {
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 本来就没有 */ }
        try { fs.unlinkSync(TALL_PAGE_FILE); } catch (error) { /* 本来就没有 */ }
    }
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'rects.json'), JSON.stringify(evidence, null, 2) + '\n');
        console.log('\n证据 / 截图写到 ' + SHOTS);
    }
    console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' 项 / 共 ' + (passed + failed.length) + ' 项' : 'ALL PASS (' + passed + ' 项)'));
    if (failed.length) { failed.forEach((name) => console.log('  - ' + name)); process.exit(1); }
}
main().catch((error) => { console.error(error); process.exit(1); });
