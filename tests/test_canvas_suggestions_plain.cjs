#!/usr/bin/env node
'use strict';
/*
 * 下一步建议只用文字给（不做按钮）：?debugSuggestions=1 注入一条带 3 条建议的助手消息，
 * 断言面板里 [data-suggestions] 内没有按钮、有「下一步建议」小标题和 3 行纯文字。
 *
 * 跑法（不碰 3000、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_suggestions_plain.cjs
 *   node tests/test_canvas_suggestions_plain.cjs --shots _verification-suggestions-plain
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__sugg-e2e.html');
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
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__sugg-e2e.html';
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
        await page.goto(url + '?empty=1&speed=8&debugSuggestions=1');
        await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.models, null, { timeout: 60000 });
        await page.evaluate(() => window.__cn.setUI({ agentOpen: true }));
        await page.waitForSelector('[data-suggestions]', { timeout: 15000 });
        await sleep(400);
        const state = await page.evaluate(() => {
            const box = document.querySelector('[data-suggestions]');
            const styles = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth, cursor: s.cursor }; };
            return {
                buttons: box.querySelectorAll('button').length,
                items: Array.from(box.querySelectorAll('.ap2-sug-text')).map((el) => ({ text: (el.textContent || '').trim(), style: styles(el) })),
                heading: (box.querySelector('.ap2-sugs-hd') || {}).textContent || '',
                boxStyle: styles(box),
                html: box.outerHTML.slice(0, 500),
            };
        });
        check('下一步建议：容器里没有按钮', state.buttons === 0, state.buttons);
        check('下一步建议：有「下一步建议」小标题', state.heading.includes('下一步建议'), state.heading);
        check('下一步建议：3 条建议渲染成纯文字', state.items.length === 3 && state.items.every((item) => item.text), state.items);
        check('下一步建议：文字没有按钮底色 / 描边', state.items.every((item) => item.style.bg === 'rgba(0, 0, 0, 0)' && item.style.border === '0px'), state.items[0] && state.items[0].style);
        check('页面没有 JS 异常', pageErrors.length === 0, pageErrors);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.locator('[data-suggestions]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(SHOTS, 'suggestions-plain.png') });
            console.log('截图：' + path.join(SHOTS, 'suggestions-plain.png'));
        }
    } finally {
        if (browser) await browser.close();
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 已清理 */ }
    }
    console.log('\n结果：' + passed + ' 项通过，' + failed.length + ' 项失败');
    if (failed.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
