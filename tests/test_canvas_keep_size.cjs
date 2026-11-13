#!/usr/bin/env node
'use strict';
/*
 * 用户拖大的节点不能被「生成 / 结果写回 / 换比例」缩回 360×640 的默认最大盒。
 *
 * 复现：把图片节点拖到 900×450（比例 16:9=节点参数比例），点生成；
 * 旧逻辑在开跑占位和结果写回时都套 fitMediaBox(…, 360×640)，节点立刻变成 360 宽。
 * 现在占位 / 结果 / 新结果节点 / 换比例都走 refitNodeBox：同比例原样保留，换方向按面积保持块头。
 *
 * 跑法（不碰 3000、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_keep_size.cjs
 *   node tests/test_canvas_keep_size.cjs --shots _verification-keep-size
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__keep-size-e2e.html');
const PAGE_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><style>html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}</style></head>\n<body><div id="root"></div><script type="module" src="/src/canvas/canvas-next/dev/main.tsx"></script></body></html>\n';
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
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: UI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__keep-size-e2e.html';
    for (let i = 0; i < 160; i += 1) {
        await sleep(250);
        if (child.exitCode !== null) throw new Error('vite 起不来（exit ' + child.exitCode + '）：\n' + log);
        try { const res = await fetch(url); if (res.ok && (await res.text()).includes('id="root"')) return { child, url }; } catch (error) { /* 还在启动 */ }
    }
    child.kill('SIGTERM');
    throw new Error('vite 等待超时：\n' + log);
}
function stopVite(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } resolve(); }, 3000); });
}

(async () => {
    const port = await freePort();
    const { child, url } = await startVite(port);
    let browser;
    try {
        browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
        await page.goto(url + '?empty=1&speed=8');
        await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.loaded && window.__cn.state.models, null, { timeout: 60000 });

        // 一个 800×450（16:9）的图片节点：先选 16:9 比例，再像用户拖拽那样把尺寸改大
        const id = await page.evaluate(() => {
            const s = window.__cn;
            const n = s.newNode('image', 120, 120, { title: '拖大的节点', prompt: '一只白色咖啡杯，浅灰背景', w: 800, h: 450 });
            s.addNodes([n]);
            s.patchGen(n.id, (g) => ({ params: { ...g.params, ratio: '16:9' } }));
            s.updateNode(n.id, (x) => ({ ...x, w: 800, h: 450 }));
            s.setUI({ sel: new Set([n.id]), agentOpen: false });
            s.set({ view: { x: 80, y: 120, k: 1 } });
            window.__keepId = n.id;
            const cur = s.node(n.id);
            return { id: n.id, w: cur.w, h: cur.h };
        });
        check('拖大后尺寸就是 800×450', id.w === 800 && id.h === 450, id);
        await sleep(500);
        const before = await page.evaluate(() => { const n = window.__cn.node(window.__keepId); return { w: n.w, h: n.h }; });
        check('选中后（面板打开）尺寸没有被改', before.w === 800 && before.h === 450, before);

        const send = page.locator('[data-p="send"]').first();
        await send.waitFor({ timeout: 20000 });
        await send.click();
        await sleep(250);
        const running = await page.evaluate(() => { const n = window.__cn.node(window.__keepId); return { w: n.w, h: n.h, running: !!window.__cn.state.runtime[window.__keepId] }; });
        check('点生成的一瞬间（占位）保持 800 宽', running.w === 800, running);

        // 等 mock 结果写回
        await page.waitForFunction(() => {
            const s = window.__cn; const n = s.node(window.__keepId);
            return n && !s.state.runtime[window.__keepId] && (n.data.gen.hist || []).length > 0;
        }, null, { timeout: 30000 });
        await sleep(400);
        const after = await page.evaluate(() => { const n = window.__cn.node(window.__keepId); const o = n.data.gen.hist[n.data.gen.hi]; return { w: n.w, h: n.h, srcW: o && o.w, srcH: o && o.h, area: n.w * n.h }; });
        check('结果写回后宽度不再被缩到 360', after.w > 500, after);
        check('结果写回后面积保持用户块头（±8%）', Math.abs(after.area - 800 * 450) <= 800 * 450 * 0.08, after);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, 'keep-size-after-result.png') });
            console.log('截图目录：' + SHOTS);
        }

        check('页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
    } finally {
        if (browser) await browser.close();
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 已清理 */ }
    }
    console.log('\n结果：' + passed + ' 项通过，' + failed.length + ' 项失败');
    if (failed.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
