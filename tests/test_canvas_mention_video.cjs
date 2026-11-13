#!/usr/bin/env node
'use strict';
/*
 * 提示词编辑器 @ 视频 / @ 没连线的画布节点（回归）：
 *   1) 节点生成面板 PromptEditor 的 @ 菜单里，「画布节点」组要列出画布上没连线的视频，
 *      选中后插入的是真实引用胶囊（提示词里是 @{节点id}，不是一段普通文字）；
 *   2) 视频节点有结果时要能收藏（星标 + 右键「收藏」），收藏后在 @ 菜单「收藏」里能 @；
 *   3) 画布助手输入区 @ 面板仍然列视频节点（原有行为，不回归）。
 *
 * 跑法（不碰 3000 端口、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_mention_video.cjs
 *   node tests/test_canvas_mention_video.cjs --shots _verification-mention-video
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__mention-video-e2e.html');
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
    if (!fs.existsSync(bin)) throw new Error('novai-canvas-ui 还没装依赖：先 cd novai-canvas-ui && npm install');
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: UI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += String(d); });
    child.stderr.on('data', (d) => { log += String(d); });
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__mention-video-e2e.html';
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
async function openHarness(browser, url) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    await page.goto(url + '?empty=1&speed=8');
    await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.models && window.__cn.state.models.length, null, { timeout: 60000 });
    await sleep(400);
    return { page, ctx, pageErrors };
}
async function shot(page, name) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }

(async () => {
    const port = await freePort();
    const { child, url } = await startVite(port);
    let browser;
    const pageErrors = [];
    try {
        browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
        const { page, ctx } = await openHarness(browser, url);
        page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

        /* 画布：1 个视频（有结果、没连线）+ 1 个图片节点（要给它写提示词） */
        const ids = await page.evaluate(() => {
            const s = window.__cn;
            const vid = s.newNode('video', 120, 120, { title: '参考视频', prompt: '镜头推近', hist: [{ url: 'https://x.invalid/a.mp4' }] });
            const img = s.newNode('image', 620, 120, { title: '目标图', prompt: '' });
            s.addNodes([vid, img], []);
            s.setView({ x: 0, y: 0, k: 1 });
            s.setUI({ sel: new Set([img.id]) });
            return { vid: vid.id, img: img.id };
        });
        await page.waitForSelector('#gpPrompt', { timeout: 10000 });
        await sleep(400);

        /* [1] 没连线的视频出现在画布节点组，选中后插入真实引用 */
        await page.locator('#gpPrompt').click();
        await page.keyboard.type('参考 @');
        await sleep(500);
        const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[data-mention-menu] .pm-it')).map((b) => ({ mi: b.dataset.mi || '', text: (b.textContent || '').trim() })));
        const hit = menu.find((item) => item.mi === ids.vid);
        check('PromptEditor：画布上没连线的视频出现在 @ 菜单里', !!hit && hit.text.includes('参考视频'), menu);
        if (hit) {
            await page.locator('[data-mention-menu] .pm-it[data-mi="' + ids.vid + '"]').first().click();
            await sleep(350);
            const state = await page.evaluate((img) => {
                const d = window.__cn.node(img);
                const root = document.getElementById('gpPrompt');
                return {
                    prompt: d && d.data && d.data.gen ? d.data.gen.prompt : null,
                    chips: Array.from(root.querySelectorAll('.pm-chip')).map((c) => ({ ref: c.dataset.ref, kind: c.dataset.kind })),
                };
            }, ids.img);
            check('PromptEditor：选视频后提示词里是真实引用 @{节点id}', String(state.prompt || '').includes('@{' + ids.vid + '}'), state);
            check('PromptEditor：视频引用渲染成胶囊（kind=video）', state.chips.some((c) => c.ref === ids.vid && c.kind === 'video'), state.chips);
            await shot(page, '1-prompt-mention-video');
        }
        await page.keyboard.press('Escape');

        /* [2] 视频节点有结果 → 星标可收藏；收藏后 @ 菜单「收藏」里能 @ */
        const starBefore = await page.evaluate((vid) => {
            window.__cn.setUI({ sel: new Set([vid]) });
            const el = document.querySelector('.node[data-id="' + vid + '"] .favstar');
            return { exists: !!el, on: el ? el.classList.contains('on') : false };
        }, ids.vid);
        check('视频节点：有结果时显示收藏星标', starBefore.exists, starBefore);
        const favViaMenu = await page.evaluate((vid) => {
            const s = window.__cn;
            s.patchGen(vid, { fav: true });
            const n = s.node(vid);
            return !!(n && n.data && n.data.gen && n.data.gen.fav);
        }, ids.vid);
        check('视频节点：可以收藏（gen.fav）', favViaMenu);
        // 收藏后重新打开图片节点的 @ 菜单，进「收藏」文件夹
        await page.evaluate((img) => window.__cn.setUI({ sel: new Set([img]) }), ids.img);
        await sleep(300);
        await page.locator('#gpPrompt').click();
        await page.keyboard.type('+');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('@');
        await sleep(400);
        const favFolder = page.locator('[data-mention-menu] button.pm-fd[data-folder="fav"]');
        if (await favFolder.count()) {
            await favFolder.click();
            await sleep(300);
            const favItems = await page.evaluate(() => Array.from(document.querySelectorAll('[data-mention-menu] .pm-it')).map((b) => ({ mi: b.dataset.mi || '', text: (b.textContent || '').trim() })));
            check('PromptEditor：收藏里的视频可以 @', favItems.some((item) => item.text.includes('参考视频')), favItems);
            await shot(page, '2-fav-folder-video');
        } else {
            check('PromptEditor：收藏文件夹存在（有收藏时）', false, '没有收藏入口');
        }
        await page.keyboard.press('Escape');

        /* [3] 助手输入区 @ 面板仍然列视频（不回归） */
        await page.evaluate(() => window.__cn.setUI({ agentOpen: true }));
        await page.waitForSelector('#aiInput', { timeout: 10000 });
        await sleep(300);
        await page.locator('#aiInput').click();
        await page.keyboard.type('@');
        await sleep(600);
        const agentItems = await page.evaluate(() => Array.from(document.querySelectorAll('#pop button.ap2-mp-item')).map((b) => (b.textContent || '').trim()));
        check('助手输入区：@ 面板仍然列视频节点', agentItems.some((text) => text.includes('参考视频')), agentItems);
        await shot(page, '3-agent-palette-video');

        check('页面没有 JS 异常', pageErrors.length === 0, pageErrors);
    } finally {
        if (browser) await browser.close();
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 已清理 */ }
    }
    console.log('\n结果：' + passed + ' 项通过，' + failed.length + ' 项失败');
    if (failed.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });