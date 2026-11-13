#!/usr/bin/env node
'use strict';
/*
 * 连线出线侧：渲染时按「目标中心在源节点哪一侧」就近算，不信任数据里的 fromSide。
 *
 * 复现：排版时写过 fromSide:"left"，之后节点被拖到目标左边，线还从左侧甩出去、绕一大圈穿过画布
 * （截图里那条大弧线）。修复后渲染用当前几何，和拖动中的临时绘制共用 edgeGeometry。
 *
 * 跑法（不碰 3000、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_edge_side.cjs
 *   node tests/test_canvas_edge_side.cjs --shots _verification-edge-side
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__edge-side-e2e.html');
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
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__edge-side-e2e.html';
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

/** 读第一条边的 path d，拆成 { start, c1, c2, end } */
async function readEdge(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#edges path.e');
        if (!el) return null;
        const d = el.getAttribute('d') || '';
        const nums = d.match(/-?\d+(?:\.\d+)?/g) || [];
        const n = nums.map(Number);
        return { d, start: { x: n[0], y: n[1] }, c1: { x: n[2], y: n[3] }, c2: { x: n[4], y: n[5] }, end: { x: n[6], y: n[7] } };
    });
}

(async () => {
    const port = await freePort();
    const { child, url } = await startVite(port);
    let browser;
    try {
        browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
        await page.goto(url + '?empty=1&speed=8');
        await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.loaded && window.__cn.state.models, null, { timeout: 60000 });

        // 源在左、目标在右，但数据里残留 fromSide:"left"（排版后节点被拖动过的那种）
        const ids = await page.evaluate(() => {
            const s = window.__cn;
            const color = (label) => { const c = document.createElement('canvas'); c.width = 480; c.height = 360; const g = c.getContext('2d'); g.fillStyle = '#4062bb'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#fff'; g.font = 'bold 32px sans-serif'; g.fillText(label, 120, 190); return c.toDataURL('image/png'); };
            const a = s.newNode('image', 0, 0, { title: '参考视频 2', w: 240, h: 240, uploaded: true, hist: [{ url: color('A'), w: 480, h: 360 }] });
            const b = s.newNode('image', 700, 320, { title: '视频D', w: 240, h: 240, uploaded: true, hist: [{ url: color('B'), w: 480, h: 360 }] });
            s.addNodes([a, b]);
            const e = s.addEdge(a.id, b.id);
            s.mutate((d) => ({ ...d, edges: d.edges.map((x) => (x.id === e.id ? { ...x, fromSide: 'left' } : x)) }));
            s.set({ view: { x: 120, y: 140, k: 1 } });
            window.__edgeIds = { a: a.id, b: b.id, e: e.id };
            return window.__edgeIds;
        });
        await sleep(500);
        const first = await readEdge(page);
        check('源在目标左侧：线从源节点右边出去（不再绕大圈）', !!first && first.c1.x > first.start.x, first);
        check('源在目标左侧：起点落在源节点右边缘', !!first && Math.abs(first.start.x - 240) < 1, first && first.start);
        check('源在目标左侧：终点落在目标节点左侧', !!first && Math.abs(first.end.x - 700) < 1, first && first.end);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, 'edge-forward.png') });
        }

        // 把源拖到目标右边：出线侧要跟着当前几何变成「左」，不用等排版重算
        await page.evaluate(() => { const s = window.__cn; s.updateNode(window.__edgeIds.a, (n) => ({ ...n, x: 1200, y: 0 })); });
        await sleep(400);
        const back = await readEdge(page);
        check('源在目标右侧：线改从源节点左边出去', !!back && back.c1.x < back.start.x, back);
        check('源在目标右侧：终点仍落在目标节点左侧', !!back && Math.abs(back.end.x - 700) < 1, back && back.end);
        if (SHOTS) {
            await page.screenshot({ path: path.join(SHOTS, 'edge-backward.png') });
            console.log('截图目录：' + SHOTS);
        }

        check('页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
        console.log('边 id：' + ids.e);
    } finally {
        if (browser) await browser.close();
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 已清理 */ }
    }
    console.log('\n结果：' + passed + ' 项通过，' + failed.length + ' 项失败');
    if (failed.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
