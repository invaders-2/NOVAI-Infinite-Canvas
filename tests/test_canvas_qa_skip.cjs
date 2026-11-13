#!/usr/bin/env node
'use strict';
/*
 * 问答卡「跳过这题」不能把整页提交掉。
 *
 * Hexta 问卷的根节点是原生 <form>：跳过最后一题 / 末题回车都会 requestSubmit，
 * 默认的 GET 提交会把画布地址里的 ?canvas= / ?id= 冲掉，页面变成「没有指定要打开的画布」。
 * 这里用 ?debugQa=1 的两题问答卡复现：连点两次「跳过这题」，断言页面没有重载、URL 没变、卡片正常收尾；
 * 再单独验一次末题输入框回车（隐式提交）同样不跳走。
 *
 * 跑法（不碰 3000、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_qa_skip.cjs
 *   node tests/test_canvas_qa_skip.cjs --shots _verification-qa-skip
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__qa-skip-e2e.html');
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
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__qa-skip-e2e.html';
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

/** 打开带两题问答卡的画布：等面板卡片出现并打一个「没有重载」的哨兵 */
async function openQaCard(page, base) {
    await page.goto(base + '?empty=1&debugQa=1');
    await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.models, null, { timeout: 60000 });
    await page.evaluate(() => { window.__cn.setUI({ agentOpen: true }); window.__qaSentinel = 'alive'; });
    await page.waitForSelector('[data-qa="open"] [data-slot="questionnaire-skip"]', { timeout: 20000 });
    await sleep(400);
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

        await openQaCard(page, url);
        const skip = page.locator('[data-qa="open"] [data-slot="questionnaire-skip"]');

        // 第 1 题跳过：只应切到下一题，不能提交表单
        await skip.click();
        await sleep(700);
        const afterFirst = await page.evaluate(() => ({
            sentinel: window.__qaSentinel === 'alive',
            href: location.href,
            status: document.querySelector('[data-qa]')?.getAttribute('data-qa') || '',
            empty: document.body.innerText.includes('没有指定要打开的画布'),
            activeIndex: Array.from(document.querySelectorAll('[data-slot="questionnaire-item"]')).findIndex((el) => el.hasAttribute('data-active')),
        }));
        check('跳过第 1 题：页面没有重载', afterFirst.sentinel, afterFirst);
        check('跳过第 1 题：画布地址没被表单提交改写', afterFirst.href === url + '?empty=1&debugQa=1', afterFirst.href);
        check('跳过第 1 题：没有出现「没有指定要打开的画布」', afterFirst.empty === false);
        check('跳过第 1 题：切到第 2 题，卡片还开着', afterFirst.status === 'open' && afterFirst.activeIndex === 1, afterFirst);

        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.locator('[data-qa="open"]').scrollIntoViewIfNeeded();
            await page.locator('[data-qa="open"]').screenshot({ path: path.join(SHOTS, 'qa-skip-second-question.png') });
        }

        // 第 2 题（最后一题）跳过：会走 form.requestSubmit，必须被接住并收尾，不能导航
        await skip.click();
        await page.waitForSelector('[data-qa="answered"]', { timeout: 10000 }).catch(() => undefined);
        const afterLast = await page.evaluate(() => ({
            sentinel: window.__qaSentinel === 'alive',
            href: location.href,
            status: document.querySelector('[data-qa]')?.getAttribute('data-qa') || '',
            empty: document.body.innerText.includes('没有指定要打开的画布'),
        }));
        check('跳过最后一题：页面没有重载', afterLast.sentinel, afterLast);
        check('跳过最后一题：画布地址没被表单提交改写', afterLast.href === url + '?empty=1&debugQa=1', afterLast.href);
        check('跳过最后一题：没有出现「没有指定要打开的画布」', afterLast.empty === false);
        check('跳过最后一题：卡片正常收尾（已回答）', afterLast.status === 'answered', afterLast);

        // 末题输入框回车：隐式提交同样不能导航（重新加载一张卡）
        await openQaCard(page, url);
        await page.locator('[data-qa="open"] [data-slot="questionnaire-skip"]').click();
        await sleep(500);
        const input = page.locator('[data-slot="questionnaire-item"][data-active] [data-slot="questionnaire-input"]');
        await input.click();
        await page.keyboard.type('你来决定');
        await page.keyboard.press('Enter');
        await sleep(1200);
        const afterEnter = await page.evaluate(() => ({
            sentinel: window.__qaSentinel === 'alive',
            href: location.href,
            empty: document.body.innerText.includes('没有指定要打开的画布'),
        }));
        check('末题回车：页面没有重载', afterEnter.sentinel, afterEnter);
        check('末题回车：画布地址没被表单提交改写', afterEnter.href === url + '?empty=1&debugQa=1', afterEnter.href);
        check('末题回车：没有出现「没有指定要打开的画布」', afterEnter.empty === false);

        check('页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
        if (SHOTS) console.log('截图目录：' + SHOTS);
    } finally {
        if (browser) await browser.close();
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 已清理 */ }
    }
    console.log('\n结果：' + passed + ' 项通过，' + failed.length + ' 项失败');
    if (failed.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
