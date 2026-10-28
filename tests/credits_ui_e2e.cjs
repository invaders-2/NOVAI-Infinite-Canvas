#!/usr/bin/env node
/*
 * 积分 UI 验收（Playwright，1600×1000）
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/credits_ui_e2e.cjs
 *
 * 默认自己拉起 tests/credits_mock_server.cjs（auth-on:8893 / auth-off:8894），
 * 也可以用 NOVAI_BASE 指向已经跑着的 mock 服务（auth-off 用 NOVAI_BASE_OFF）。
 *
 * 覆盖：
 *   1. 画布右上角积分胶囊：余额格式、暗/亮主题、窄屏单行、不压用户胶囊
 *   2. 胶囊 popover：余额 + 管理员分配 + 最近 5 条流水 + 关闭
 *   3. SSE 推送后数字实时变（不刷新页面），popover 里的余额同时变
 *   4. V2 侧栏账户菜单：展开有「积分 x / 管理员分配」，收起不占位
 *   5. 账户页积分卡片：余额、USD 等值、最近 20 条流水、空状态
 *   6. 管理后台：积分列 + 行内分配、分配成功刷新行余额 + toast、余额不足显示后端 detail
 *   7. 节点生成（全量后付费）：提交提示「生成后按实际用量扣费 · 预计约 X」/ 完成「已扣 X · 余额 Y」（可为负）/
 *      0 余额图片·文本·视频可提交且无「积分不足」/ 流式穿透 + 结算 / 失败「未产生扣费」
 *   8. auth-off：不渲染、不开 SSE、只探测一次
 *
 * 截图：tests/artifacts/credits-ui/*.png；报告：tests/artifacts/credits-ui/credits-ui-report.json
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, request } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'artifacts', 'credits-ui');
const REPORT = path.join(OUT_DIR, 'credits-ui-report.json');
const PORT_ON = Number(process.env.CREDITS_MOCK_PORT || 8893);
const PORT_OFF = Number(process.env.CREDITS_MOCK_PORT_OFF || 8894);
const BASE = process.env.NOVAI_BASE || ('http://127.0.0.1:' + PORT_ON);
const BASE_OFF = process.env.NOVAI_BASE_OFF || ('http://127.0.0.1:' + PORT_OFF);
const ADMIN = { username: 'admin', password: 'admin12345' };
const MEMBER = { username: 'member', password: 'member-pass-123' };
const VIEWPORT = { width: 1600, height: 1000 };

const results = { base: BASE, baseOff: BASE_OFF, startedAt: new Date().toISOString(), checks: {}, metrics: {}, shots: {}, pageErrors: [] };
let failed = 0;
const children = [];

function check(name, ok, detail) {
    if (ok) {
        results.checks[name] = true;
        console.log('PASS  ' + name);
    } else {
        failed += 1;
        results.checks[name] = { failed: true, detail: detail === undefined ? null : detail };
        console.log('FAIL  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
    }
}

function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (error) { return ''; } })(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

async function waitForServer(base, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    while (Date.now() < deadline) {
        try {
            const response = await fetch(base + '/__mock/state');
            if (response.ok) return true;
        } catch (error) { /* 还没起来 */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

async function startMock(port, auth) {
    const child = spawn(process.execPath, [path.join(__dirname, 'credits_mock_server.cjs'), '--port', String(port), '--auth', auth], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => process.stdout.write('[mock:' + port + '] ' + chunk));
    child.stderr.on('data', (chunk) => process.stderr.write('[mock:' + port + '] ' + chunk));
    children.push(child);
    const ready = await waitForServer('http://127.0.0.1:' + port);
    if (!ready) throw new Error('mock 服务没起来：' + port);
}

async function stopMocks() {
    for (const child of children) {
        try { child.kill('SIGTERM'); } catch (error) { /* 已退出 */ }
    }
}

async function resetMock(base) {
    await fetch(base + '/__mock/reset', { method: 'POST' });
}

async function mockConfig(base, body) {
    await fetch(base + '/__mock/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function mockBalance(base, balance, userId) {
    await fetch(base + '/__mock/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: balance, userId: userId || 2 })
    });
}

function readText(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.textContent || '').trim() : null;
    }, selector);
}

async function waitText(page, value, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
        if ((await readText(page, '#collab-credits-num')) === value) return true;
        await page.waitForTimeout(80);
    }
    return false;
}

/* 轮询提示条文字：返回 [{at, text}]，直到出现预期的最后一条或超时 */
async function watchToasts(page, untilText, timeoutMs) {
    const samples = [];
    const deadline = Date.now() + (timeoutMs || 6000);
    const startedAt = Date.now();
    while (Date.now() < deadline) {
        const text = await page.evaluate(() => {
            const el = document.querySelector('[data-credits-toast]');
            return el ? String(el.innerText || '').trim() : null;
        });
        if (text && (!samples.length || samples[samples.length - 1].text !== text)) {
            samples.push({ at: Date.now() - startedAt, text: text });
        }
        if (untilText && text && text.indexOf(untilText) >= 0) break;
        await page.waitForTimeout(60);
    }
    return samples;
}

async function waitForToastText(page, needle, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        const text = await page.evaluate(() => {
            const el = document.querySelector('[data-credits-toast]');
            return el ? String(el.innerText || '').trim() : null;
        });
        if (text && text.indexOf(needle) >= 0) return text;
        await page.waitForTimeout(60);
    }
    return null;
}

async function loginContext(browser, user, options) {
    const context = await browser.newContext({ viewport: (options && options.viewport) || VIEWPORT, deviceScaleFactor: 1 });
    if (options && typeof options.init === 'function') await context.addInitScript(options.init);
    const login = await context.request.post(BASE + '/api/auth/login', { data: { username: user.username, password: user.password } });
    if (login.status() !== 200) throw new Error('登录失败：' + user.username + ' ' + login.status());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = String(message.text());
        if (/WebSocket connection|Failed to load resource/.test(text)) return;   /* mock 不实现 WS / 部分静态资源 */
        errors.push('console: ' + text);
    });
    return { context, page, errors };
}

async function shot(page, name) {
    const file = path.join(OUT_DIR, name + '.png');
    await page.screenshot({ path: file });
    results.shots[name] = file;
    return file;
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const startedByUs = !process.env.NOVAI_BASE;
    if (startedByUs) {
        await startMock(PORT_ON, 'on');
        await startMock(PORT_OFF, 'off');
    }
    const executablePath = chromiumExecutable();
    const browser = await chromium.launch(executablePath ? { executablePath: executablePath } : {});

    try {
        /* ───────────────────────────────────────────── 1. 画布右上角胶囊 + popover + SSE */
        await resetMock(BASE);
        const hud = await loginContext(browser, MEMBER);
        await hud.page.goto(BASE + '/static/smart-canvas.html?id=credits-ui-e2e', { waitUntil: 'domcontentloaded' });
        await hud.page.waitForSelector('#collab-credits-btn', { state: 'visible', timeout: 20000 });
        const hudState = await hud.page.evaluate(() => {
            const btn = document.querySelector('#collab-credits-btn');
            const avatars = document.querySelector('#collab-avatars');
            const share = document.querySelector('#collab-share-btn');
            const rect = btn.getBoundingClientRect();
            const hud = document.querySelector('#collab-hud').getBoundingClientRect();
            const userPill = document.getElementById('nv-user-pill');
            return {
                label: btn.textContent.trim(),
                aria: btn.getAttribute('aria-label'),
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                hud: { x: hud.x, y: hud.y, w: hud.width, h: hud.height },
                shareRect: (() => { const r = share.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
                avatarsRect: (() => { const r = avatars.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
                userPill: userPill ? (() => { const r = userPill.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
                global: window.NOVAI_CREDITS ? window.NOVAI_CREDITS.state : null,
                sse: window.NOVAI_CREDITS ? window.NOVAI_CREDITS.__debug().sse : -1
            };
        });
        results.metrics.hud = hudState;
        check('HUD 胶囊渲染', hudState.label === '12.50', hudState.label);
        check('HUD 胶囊 aria-label 带余额', hudState.aria === '我的积分：12.50', hudState.aria);
        check('信用卡片挂在协作胶囊里', hudState.hud.w <= 600 && hudState.rect.x > hudState.avatarsRect.x);
        check('胶囊在分享按钮右边（不与成员/分享重叠）',
            hudState.rect.x >= hudState.shareRect.x + hudState.shareRect.w - 1, { pill: hudState.rect, share: hudState.shareRect });
        check('不压右上角用户胶囊', !hudState.userPill || hudState.rect.x + hudState.rect.w <= hudState.userPill.x, hudState.userPill);
        check('SSE 已连上', hudState.sse === 1, hudState.sse);
        await shot(hud.page, '01-hud-balance');

        /* popover：余额 + 管理员分配 + 最近 5 条 + 关闭 */
        await hud.page.click('#collab-credits-btn');
        await hud.page.waitForSelector('#collab-credits-pop:not([hidden])', { timeout: 5000 });
        await hud.page.waitForTimeout(350);
        const popover = await hud.page.evaluate(() => {
            const pop = document.querySelector('#collab-credits-pop');
            const rect = pop.getBoundingClientRect();
            return {
                text: pop.innerText,
                balance: document.querySelector('#collab-credits-balance').textContent.trim(),
                rows: [...pop.querySelectorAll('.collab-credits-row')].map((row) => row.innerText.replace(/\n/g, ' ')),
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                inViewport: rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= window.innerWidth && rect.y + rect.height <= window.innerHeight,
                bg: getComputedStyle(pop).backgroundColor
            };
        });
        results.metrics.popover = popover;
        check('popover 显示余额', popover.balance === '12.50', popover.balance);
        check('popover 说明是管理员分配', popover.text.indexOf('管理员分配') >= 0);
        check('popover 最多 5 条流水', popover.rows.length === 5, popover.rows);
        check('popover 流水含 +/- 与备注', popover.rows.some((row) => row.indexOf('+') >= 0) && popover.rows.some((row) => row.indexOf('−') >= 0), popover.rows);
        check('popover 在视口内', popover.inViewport, popover.rect);
        await shot(hud.page, '02-hud-popover');

        /* SSE 推送：数字实时变化，popover 同步 */
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 9.5 })
        });
        check('SSE 推送后胶囊数字实时变', await waitText(hud.page, '9.50'), await readText(hud.page, '#collab-credits-num'));
        check('popover 余额同步更新', (await readText(hud.page, '#collab-credits-balance')) === '9.50');
        await hud.page.click('#collab-credits-close');
        check('关闭按钮能关掉 popover', await hud.page.evaluate(() => document.querySelector('#collab-credits-pop').hidden));

        /* 暗色主题 */
        await hud.page.evaluate(() => localStorage.setItem('studio_theme', 'dark'));
        await hud.page.reload({ waitUntil: 'domcontentloaded' });
        await hud.page.waitForSelector('#collab-credits-btn', { state: 'visible', timeout: 20000 });
        await hud.page.click('#collab-credits-btn');
        await hud.page.waitForTimeout(400);
        const dark = await hud.page.evaluate(() => {
            const pop = document.querySelector('#collab-credits-pop');
            const pill = document.querySelector('#collab-credits-btn');
            return {
                html: document.documentElement.className,
                popBg: getComputedStyle(pop).backgroundColor,
                popColor: getComputedStyle(pop).color,
                pillColor: getComputedStyle(pill).color
            };
        });
        results.metrics.dark = dark;
        check('暗色主题下 popover 用实底（可读）', /rgba\(24, 24, 24, 0\.95\)|rgb\(24, 24, 24\)/.test(dark.popBg), dark.popBg);
        check('暗色主题下胶囊文字可见', dark.pillColor !== 'rgb(0, 0, 0)', dark.pillColor);
        await shot(hud.page, '02b-hud-popover-dark');
        await hud.page.evaluate(() => localStorage.removeItem('studio_theme'));

        /* 窄屏：胶囊和成员/分享保持一行 */
        await hud.page.setViewportSize({ width: 480, height: 900 });
        await hud.page.reload({ waitUntil: 'domcontentloaded' });
        await hud.page.waitForSelector('#collab-credits-btn', { state: 'visible', timeout: 20000 });
        await hud.page.waitForTimeout(300);
        const narrow = await hud.page.evaluate(() => {
            const hud = document.querySelector('#collab-hud');
            const rect = hud.getBoundingClientRect();
            const items = [...hud.children].filter((el) => el.getBoundingClientRect().width > 0);
            const centers = items.map((el) => {
                const r = el.getBoundingClientRect();
                return Math.round(r.y + r.height / 2);
            });
            return {
                width: rect.width,
                height: rect.height,
                right: rect.right,
                oneRow: Math.max.apply(null, centers) - Math.min.apply(null, centers) <= 4,
                withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
                items: items.map((el) => el.className)
            };
        });
        results.metrics.narrow = narrow;
        check('窄屏 HUD 单行不换行', narrow.oneRow && narrow.height <= 44, narrow);
        check('窄屏 HUD 不出界', narrow.withinViewport, narrow);
        await shot(hud.page, '01b-hud-narrow');

        /* 节点生成：预计 / 已扣 / 402 / 流式 */
        await hud.page.setViewportSize(VIEWPORT);
        await hud.page.reload({ waitUntil: 'domcontentloaded' });
        await hud.page.waitForSelector('#collab-credits-btn', { state: 'visible', timeout: 20000 });
        await waitText(hud.page, '9.50');
        await hud.page.evaluate(() => {
            window.__creditGen = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'hello credits', max_tokens: 100 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const toasts = await watchToasts(hud.page, '已扣', 6000);
        results.metrics.toasts = toasts;
        const notice = toasts.find((item) => item.text.indexOf('生成后按实际用量扣费') >= 0);
        const spent = toasts.find((item) => item.text.indexOf('已扣') >= 0);
        check('提交时提示「生成后按实际用量扣费 · 预计约 X 积分」',
            Boolean(notice) && notice.text === '生成后按实际用量扣费 · 预计约 0.01 积分', toasts);
        check('不再显示「本次预计消耗」预扣文案', toasts.every((item) => item.text.indexOf('本次预计消耗') < 0), toasts);
        check('生成完成提示「已扣 X · 余额 Y」（2 位小数）',
            Boolean(spent) && spent.text === '已扣 0.01 积分 · 余额 9.49', spent);
        check('后付费提示在请求返回前出现', Boolean(notice && spent) && notice.at < spent.at, { notice: notice && notice.at, spent: spent && spent.at });
        const gen = await hud.page.evaluate(() => window.__creditGen);
        check('生成响应带 credits 且 mode=postpaid',
            gen.status === 200 && Boolean(gen.body.credits) && gen.body.credits.mode === 'postpaid', gen);
        check('HUD 随扣费实时减少', await waitText(hud.page, '9.49'), await readText(hud.page, '#collab-credits-num'));
        await shot(hud.page, '06-generation-spent');

        /* 再次触发一次，截「后付费提示」那一帧 */
        await hud.page.evaluate(() => {
            window.__creditGen2 = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'second run', max_tokens: 100 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const noticeText = await waitForToastText(hud.page, '生成后按实际用量扣费', 4000);
        await shot(hud.page, '06b-generation-notice');
        await hud.page.evaluate(() => window.__creditGen2);
        check('第二次生成也显示后付费提示', noticeText === '生成后按实际用量扣费 · 预计约 0.01 积分', noticeText);

        /* 任务轮询：响应里带 credits 时补「实际扣多少」 */
        const beforeTask = toasts.length;
        await hud.page.evaluate(() => fetch('/api/tasks/task-credit-check').then((response) => response.json()));
        const taskToasts = await watchToasts(hud.page, '已扣 0.1 积分', 5000);
        check('任务轮询拿到 credits 后提示实际扣费', taskToasts.some((item) => item.text === '已扣 0.10 积分 · 余额 9.38'), taskToasts);
        check('HUD 同步任务扣费', await waitText(hud.page, '9.38'), await readText(hud.page, '#collab-credits-num'));

        /* 欠费上限 0.01：0 余额时文本/小额（预计 ≤ 0.01）能提交；图片/视频这类预计 > 0.01 的 402 */
        await mockConfig(BASE, { prices: { text: 0.01 } });
        await mockBalance(BASE, 0);
        await waitText(hud.page, '0');
        await hud.page.evaluate(() => {
            window.__zeroText = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'zero balance text', max_tokens: 16 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const textZeroToasts = await watchToasts(hud.page, '余额 -0.01', 8000);
        const zeroText = await hud.page.evaluate(() => window.__zeroText);
        check('0 余额文本（预计 0.01 ≤ 0.01）提交成功', zeroText.status === 200, zeroText);
        check('0 余额文本完成后扣成负余额（-0.01，2 位小数）',
            textZeroToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 -0.01'), textZeroToasts);
        check('HUD 显示负余额（-0.01）', await waitText(hud.page, '-0.01'), await readText(hud.page, '#collab-credits-num'));
        await shot(hud.page, '06c-zero-balance-text');

        /* 小额图片（预计 0.01 ≤ 0.01）也能提交：欠费上限 0.01，先把余额重置到 0 */
        await mockConfig(BASE, { prices: { text: 0.01, image: 0.01 } });
        await mockBalance(BASE, 0);
        await waitText(hud.page, '0');
        await hud.page.evaluate(() => {
            window.__zeroSmallImage = fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-image', prompt: 'tiny image', n: 1 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const smallImageToasts = await watchToasts(hud.page, '余额 -0.01', 8000);
        const zeroSmallImage = await hud.page.evaluate(() => window.__zeroSmallImage);
        check('0 余额小额图片（预计 0.01 ≤ 0.01）提交成功', zeroSmallImage.status === 200, zeroSmallImage);
        check('小额图片完成后扣成负余额（-0.01）',
            smallImageToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 -0.01'), smallImageToasts);
        await shot(hud.page, '06d-zero-balance-small-image');

        /* 图片（预计 0.10 > 余额+0.01）→ 402 + 欠费上限文案 */
        await mockConfig(BASE, { prices: { text: 0.01 } });
        await hud.page.evaluate(() => {
            window.__zeroImage = fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-image', prompt: 'zero balance image', n: 1 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const imageLimitToasts = await watchToasts(hud.page, '可欠费', 8000);
        const zeroImage = await hud.page.evaluate(() => window.__zeroImage);
        check('0 余额图片（预计 0.10 > 0.01）返回 402',
            zeroImage.status === 402 && zeroImage.body && zeroImage.body.code === 'INSUFFICIENT_CREDITS', zeroImage);
        check('图片 402 文案「积分不足：本次预计 0.10 积分，当前 -0.01 积分（可欠费 0.01 积分）」',
            imageLimitToasts.some((item) => item.text === '积分不足：本次预计 0.10 积分，当前 -0.01 积分（可欠费 0.01 积分）'), imageLimitToasts);
        check('图片 402 不扣费（余额仍 -0.01）', (await readText(hud.page, '#collab-credits-num')) === '-0.01', await readText(hud.page, '#collab-credits-num'));
        await shot(hud.page, '06d-zero-balance-402');

        /* 视频（预计 10）同样 402，文案带本次预计与当前余额 */
        await hud.page.evaluate(() => {
            window.__zeroVideo = fetch('/api/canvas-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-video', duration: 5 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const videoLimitToasts = await watchToasts(hud.page, '本次预计 1.55', 8000);
        const zeroVideo = await hud.page.evaluate(() => window.__zeroVideo);
        check('0 余额视频（预计 1.55 > 0.01）返回 402', zeroVideo.status === 402, zeroVideo);
        check('视频 402 文案带预计 1.55 与当前余额',
            videoLimitToasts.some((item) => item.text === '积分不足：本次预计 1.55 积分，当前 -0.01 积分（可欠费 0.01 积分）'), videoLimitToasts);
        check('视频 402 不扣费', (await readText(hud.page, '#collab-credits-num')) === '-0.01', await readText(hud.page, '#collab-credits-num'));
        await mockConfig(BASE, { prices: {} });

        /* 流式：响应体不被拦截破坏，结束后提示结算 */
        await mockBalance(BASE, 5);
        await waitText(hud.page, '5.00');
        const streamResult = await hud.page.evaluate(async () => {
            const response = await fetch('/api/canvas-llm/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'stream me' })
            });
            const text = await response.text();
            return { status: response.status, text: text };
        });
        check('流式响应原样透传（能读到 delta/done）', streamResult.status === 200 &&
            streamResult.text.indexOf('"type":"done"') >= 0 &&
            streamResult.text.indexOf('积分流式验收通过') >= 0, streamResult.text.slice(0, 160));
        const streamToasts = await watchToasts(hud.page, '余额 4.99', 6000);
        check('流式结束后提示结算扣费', streamToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 4.99'), streamToasts);
        check('流式也不显示「本次预计消耗」', streamToasts.every((item) => item.text.indexOf('本次预计消耗') < 0), streamToasts);
        check('HUD 随流式结算减少', await waitText(hud.page, '4.99'), await readText(hud.page, '#collab-credits-num'));

        /* 积分格式：固定 2 位小数（0.01 步进），负余额正常 */
        const formats = await hud.page.evaluate(() => {
            const f = window.NOVAI_CREDITS.format;
            return {
                '0.01': f(0.01),
                '0.09': f(0.09),
                '1.3': f(1.3),
                '1.30': f(1.3),
                '12.5': f(12.5),
                '100': f(100),
                '97.4699': f(97.4699),
                '0.009': f(0.009),
                '-0.09': f(-0.09),
                '0.5': f(0.5)
            };
        });
        results.metrics.formats = formats;
        check('固定 2 位小数（0.01 / 0.09 / 1.30 / 12.50 / 100.00）',
            formats['0.01'] === '0.01' && formats['0.09'] === '0.09' && formats['1.3'] === '1.30' &&
            formats['12.5'] === '12.50' && formats['100'] === '100.00', formats);
        check('四舍五入到 2 位（97.4699→97.47 / 0.009→0.01）',
            formats['97.4699'] === '97.47' && formats['0.009'] === '0.01', formats);
        check('负余额格式（-0.09）', formats['-0.09'] === '-0.09', formats);
        check('始终保留两位（1.30 / 0.50）', formats['1.30'] === '1.30' && formats['0.5'] === '0.50', formats);

        /* 固定 2 位：文本 0.01 / 视频 1.55 / 音频 0.01，余额都按分展示 */
        await mockConfig(BASE, { prices: { text: 0.01, video: 1.55, audio: 0.01 } });
        await mockBalance(BASE, 12.47);
        check('HUD 显示 12.47（2 位小数）', await waitText(hud.page, '12.47'), await readText(hud.page, '#collab-credits-num'));
        await hud.page.evaluate(() => {
            window.__smallText = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'cent charge', max_tokens: 16 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const smallToasts = await watchToasts(hud.page, '余额 12.46', 6000);
        check('后付费提示带参考价 0.01',
            smallToasts.some((item) => item.text === '生成后按实际用量扣费 · 预计约 0.01 积分'), smallToasts);
        check('完成提示「已扣 0.01 积分 · 余额 12.46」', smallToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 12.46'), smallToasts);
        await hud.page.evaluate(() => window.__smallText);
        check('扣 0.01 后 HUD 数字确实变化（12.47 → 12.46）', await waitText(hud.page, '12.46'), await readText(hud.page, '#collab-credits-num'));
        await shot(hud.page, '06d-small-deduction');
        await hud.page.click('#collab-credits-btn');
        await hud.page.waitForSelector('#collab-credits-pop:not([hidden])', { timeout: 5000 });
        await hud.page.waitForTimeout(350);
        const popoverSmall = await hud.page.evaluate(() => ({
            balance: document.querySelector('#collab-credits-balance').textContent.trim(),
            firstAmount: (document.querySelector('.collab-credits-row-amt') || {}).textContent || ''
        }));
        check('popover 余额与流水都显示 2 位小数（12.46 / −0.01）',
            popoverSmall.balance === '12.46' && popoverSmall.firstAmount.trim() === '−0.01', popoverSmall);
        await shot(hud.page, '06e-popover-precision');
        await hud.page.click('#collab-credits-close');

        await hud.page.evaluate(() => {
            window.__video372 = fetch('/api/canvas-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'video 1.3', duration: 5 })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const videoToasts = await watchToasts(hud.page, '余额 10.91', 6000);
        check('视频扣费 1.55（余额 10.91）', videoToasts.some((item) => item.text === '已扣 1.55 积分 · 余额 10.91'), videoToasts);
        await hud.page.evaluate(() => window.__video372);

        await hud.page.evaluate(() => {
            window.__audio065 = fetch('/api/canvas-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'audio 0.01' })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const audioToasts = await watchToasts(hud.page, '余额 10.90', 6000);
        check('音频扣费 0.01（余额 10.90）', audioToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 10.90'), audioToasts);
        await hud.page.evaluate(() => window.__audio065);

        /* TTS 走同一套后付费通路（/api/canvas-tts） */
        await hud.page.evaluate(() => {
            window.__tts = fetch('/api/canvas-tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'tts-1', input: '后付费语音验收', voice: 'alloy', response_format: 'wav' })
            }).then(async (response) => ({ status: response.status, body: await response.json() }));
        });
        const ttsToasts = await watchToasts(hud.page, '余额 10.89', 6000);
        const ttsResult = await hud.page.evaluate(() => window.__tts);
        check('TTS 提交时提示生成后扣费', ttsToasts.some((item) => item.text.indexOf('生成后按实际用量扣费') >= 0), ttsToasts);
        check('TTS 响应 mode=postpaid 且完成后扣费 0.01（余额 10.89）',
            ttsResult.status === 200 && ttsResult.body.credits && ttsResult.body.credits.mode === 'postpaid' &&
            ttsToasts.some((item) => item.text === '已扣 0.01 积分 · 余额 10.89'), { toasts: ttsToasts, body: ttsResult.body });
        await hud.page.evaluate(() => window.__tts);

        /* 生成失败：不预扣，所以提示「未产生扣费」 */
        await hud.page.evaluate(() => {
            window.__failGen = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mock-chat', message: 'fail case', fail: true })
            }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
        });
        const failToasts = await watchToasts(hud.page, '生成失败', 6000);
        const failGen = await hud.page.evaluate(() => window.__failGen);
        check('失败响应是 500', failGen.status === 500, failGen);
        check('失败提示「生成失败，未产生扣费」', failToasts.some((item) => item.text === '生成失败，未产生扣费'), failToasts);
        check('失败提示不出现「积分不足」', failToasts.every((item) => item.text.indexOf('积分不足') < 0), failToasts);
        await shot(hud.page, '06f-generation-failed');

        /* Agent：没有单一价目，只提示后付费、不显示预扣数字 */
        await hud.page.evaluate(() => {
            window.__agentRun = fetch('/api/agent/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ goal: '做一张电商海报', canvas_id: 'credits-e2e' })
            }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
        });
        const agentNotice = await waitForToastText(hud.page, '生成后按实际用量扣费', 4000);
        const agentRun = await hud.page.evaluate(() => window.__agentRun);
        check('Agent 提交也提示后付费', agentNotice === '生成后按实际用量扣费', agentNotice);
        check('Agent 不显示预估数字', String(agentNotice).indexOf('预计约') < 0, agentNotice);
        check('Agent 请求正常返回', agentRun.status === 200, agentRun);
        await mockConfig(BASE, { prices: {} });
        results.pageErrors.push(...hud.errors);
        check('画布页无 JS 报错', hud.errors.length === 0, hud.errors.slice(0, 3));
        await hud.context.close();

        /* ───────────────────────────────────────────── 2. V2 侧栏账户菜单 */
        await resetMock(BASE);
        const shell = await loginContext(browser, MEMBER, {
            init: () => { try { localStorage.setItem('novai-visited', '1'); } catch (error) { /* ignore */ } }
        });
        await shell.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await shell.page.waitForSelector('.acct-row', { state: 'visible', timeout: 25000 });
        await shell.page.waitForTimeout(600);
        const closedState = await shell.page.evaluate(() => ({
            acctCredits: document.querySelectorAll('.acct-credits').length,
            balance: window.NOVAI_CREDITS ? window.NOVAI_CREDITS.balance : null
        }));
        check('侧栏收起时不占位（菜单没开就没有积分行）', closedState.acctCredits === 0, closedState);
        check('V2 页面读到余额', closedState.balance === 12.5, closedState.balance);
        await shell.page.hover('.sidebar');
        await shell.page.waitForTimeout(450);
        await shell.page.click('.acct-row');
        await shell.page.waitForSelector('.acct-menu', { timeout: 5000 });
        await shell.page.waitForTimeout(300);
        const menu = await shell.page.evaluate(() => {
            const el = document.querySelector('.acct-credits');
            const menuEl = document.querySelector('.acct-menu');
            const rect = menuEl.getBoundingClientRect();
            return {
                text: el ? el.innerText.replace(/\n/g, ' ') : null,
                value: el ? el.querySelector('.acct-credits-value').textContent.trim() : null,
                note: el ? el.querySelector('.acct-credits-note').textContent.trim() : null,
                visible: el ? el.getBoundingClientRect().height > 0 : false,
                menuRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
            };
        });
        results.metrics.sidebar = menu;
        check('侧栏账户菜单显示「积分 12.50」', menu.visible && menu.value === '积分 12.50', menu);
        check('侧栏小字「管理员分配」', menu.note === '管理员分配', menu.note);
        await shot(shell.page, '03-sidebar-menu');

        /* SSE：侧栏菜单里的余额也实时变 */
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 21.5 })
        });
        await shell.page.waitForTimeout(500);
        const menuAfter = await readText(shell.page, '.acct-credits-value');
        check('侧栏余额随 SSE 更新', menuAfter === '积分 21.50', menuAfter);
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 97.49 })
        });
        await shell.page.waitForTimeout(500);
        check('侧栏余额显示 2 位小数（97.49）', (await readText(shell.page, '.acct-credits-value')) === '积分 97.49', await readText(shell.page, '.acct-credits-value'));
        await shot(shell.page, '03b-sidebar-menu-decimals');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 0.09 })
        });
        await shell.page.waitForTimeout(500);
        check('侧栏余额显示 2 位小数（0.09）', (await readText(shell.page, '.acct-credits-value')) === '积分 0.09', await readText(shell.page, '.acct-credits-value'));
        results.pageErrors.push(...shell.errors);
        check('V2 外壳无 JS 报错', shell.errors.length === 0, shell.errors.slice(0, 3));
        await shell.context.close();

        /* ───────────────────────────────────────────── 3. 账户页 */
        await resetMock(BASE);
        const account = await loginContext(browser, MEMBER);
        await account.page.goto(BASE + '/static/account.html', { waitUntil: 'domcontentloaded' });
        await account.page.waitForTimeout(1200);
        const accountState = await account.page.evaluate(() => {
            const card = document.querySelector('#credits');
            return {
                balance: document.querySelector('#credits-balance').textContent.trim(),
                usd: document.querySelector('#credits-usd').textContent.trim(),
                hint: document.querySelector('#credits-hint').textContent.trim(),
                rows: document.querySelectorAll('.credit-row').length,
                firstRow: (document.querySelector('.credit-row') || {}).innerText || '',
                cardVisible: Boolean(card) && card.getBoundingClientRect().height > 0,
                types: [...document.querySelectorAll('.credit-row-main b')].map((el) => el.textContent.trim()),
                balances: [...document.querySelectorAll('.credit-row-balance')].map((el) => el.textContent.trim()),
                amounts: [...document.querySelectorAll('.credit-row-amount')].map((el) => el.textContent.trim())
            };
        });
        results.metrics.account = accountState;
        check('账户页积分卡片可见', accountState.cardVisible);
        check('账户页余额 12.50', accountState.balance === '12.50', accountState.balance);
        check('账户页 USD 等值 ≈ $1.25', accountState.usd === '≈ $1.25', accountState.usd);
        check('账户页流水 20 条上限（此例 8 条）', accountState.rows === 8, accountState.rows);
        check('账户页流水显示 2 位小数金额（−0.01 / +0.02）',
            accountState.amounts.indexOf('−0.01') >= 0 && accountState.amounts.indexOf('+0.02') >= 0, accountState.amounts);
        check('账户页流水含类型/余额', accountState.types.indexOf('管理员分配') >= 0 && accountState.balances[0].indexOf('余额') === 0, accountState);
        await shot(account.page, '04-account-credits');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 97.49 })
        });
        await account.page.waitForTimeout(600);
        check('账户页余额随 SSE 更新且保留 2 位（97.49）', (await readText(account.page, '#credits-balance')) === '97.49', await readText(account.page, '#credits-balance'));
        check('账户页 USD 等值跟着 97.49（≈ $9.75）', (await readText(account.page, '#credits-usd')) === '≈ $9.75', await readText(account.page, '#credits-usd'));
        await shot(account.page, '04b-account-credits-decimals');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 0.09 })
        });
        await account.page.waitForTimeout(600);
        check('账户页余额显示 2 位小数（0.09 / ≈ $0.01）',
            (await readText(account.page, '#credits-balance')) === '0.09' &&
            (await readText(account.page, '#credits-usd')) === '≈ $0.01',
            { balance: await readText(account.page, '#credits-balance'), usd: await readText(account.page, '#credits-usd') });
        await shot(account.page, '04c-account-precision');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: -0.09 })
        });
        await account.page.waitForTimeout(600);
        check('账户页显示负余额（-0.09 / ≈ -$0.01）',
            (await readText(account.page, '#credits-balance')) === '-0.09' &&
            (await readText(account.page, '#credits-usd')) === '≈ -$0.01',
            { balance: await readText(account.page, '#credits-balance'), usd: await readText(account.page, '#credits-usd') });
        await shot(account.page, '04d-account-negative');
        results.pageErrors.push(...account.errors);
        check('账户页无 JS 报错', account.errors.length === 0, account.errors.slice(0, 3));
        await account.context.close();

        /* 账户页空状态：admin 没有流水 */
        const empty = await loginContext(browser, ADMIN);
        await empty.page.goto(BASE + '/static/account.html', { waitUntil: 'domcontentloaded' });
        await empty.page.waitForTimeout(1000);
        const emptyState = await empty.page.evaluate(() => ({
            balance: document.querySelector('#credits-balance').textContent.trim(),
            empty: (document.querySelector('.credit-empty') || {}).textContent || ''
        }));
        check('账户页空状态', emptyState.balance === '100.00' && emptyState.empty.indexOf('还没有积分记录') >= 0, emptyState);
        await empty.context.close();

        /* ───────────────────────────────────────────── 4. 管理后台分配 */
        await resetMock(BASE);
        const admin = await loginContext(browser, ADMIN);
        await admin.page.goto(BASE + '/static/admin.html#users', { waitUntil: 'domcontentloaded' });
        await admin.page.waitForSelector('#user-rows [data-credit-balance]', { timeout: 10000 });
        const adminState = await admin.page.evaluate(() => ({
            headers: [...document.querySelectorAll('#panel-users th')].map((th) => th.textContent.trim()),
            balances: [...document.querySelectorAll('[data-credit-balance]')].map((el) => el.textContent.trim()),
            assignButtons: document.querySelectorAll('[data-credit-user]').length
        }));
        results.metrics.admin = adminState;
        check('用户表有积分列', adminState.headers.indexOf('积分') >= 0, adminState.headers);
        check('积分列显示余额', adminState.balances.join(',') === '100.00,12.50', adminState.balances);
        check('每行有分配按钮', adminState.assignButtons === 2, adminState.assignButtons);
        await admin.page.click('[data-credit-user="2"]');
        await admin.page.waitForTimeout(300);
        const modal = await admin.page.evaluate(() => ({
            hidden: document.querySelector('#credits-modal').hidden,
            desc: document.querySelector('#credits-desc').innerText.replace(/\n/g, ' '),
            current: document.querySelector('#credits-current').textContent.trim()
        }));
        check('分配弹窗显示当前余额', !modal.hidden && modal.current === '12.50 积分', modal);
        await admin.page.fill('#credits-delta', '25');
        await admin.page.fill('#credits-note', '验收加分');
        await shot(admin.page, '05-admin-assign');
        await admin.page.click('#credits-confirm');
        await admin.page.waitForTimeout(600);
        const assigned = await admin.page.evaluate(() => ({
            hidden: document.querySelector('#credits-modal').hidden,
            balance: document.querySelector('[data-credit-balance="2"]').textContent.trim(),
            toast: document.querySelector('#toast').textContent.trim()
        }));
        check('分配成功后关闭弹窗并刷新行余额', assigned.hidden && assigned.balance === '37.50', assigned);
        check('分配成功 toast', /已为 member 增加 25\.00 积分，余额 37\.50/.test(assigned.toast), assigned.toast);

        await admin.page.click('[data-credit-user="2"]');
        await admin.page.waitForTimeout(250);
        await admin.page.fill('#credits-delta', '-1000');
        await admin.page.click('#credits-confirm');
        await admin.page.waitForTimeout(500);
        const insufficient = await admin.page.evaluate(() => ({
            errorHidden: document.querySelector('#credits-error').hidden,
            error: document.querySelector('#credits-error').textContent.trim(),
            modalHidden: document.querySelector('#credits-modal').hidden,
            balance: document.querySelector('[data-credit-balance="2"]').textContent.trim()
        }));
        check('余额不足显示后端 detail 且弹窗不关', !insufficient.errorHidden && !insufficient.modalHidden &&
            /余额不足/.test(insufficient.error), insufficient);
        check('余额不足时行余额不变', insufficient.balance === '37.50', insufficient.balance);
        await shot(admin.page, '05b-admin-assign-insufficient');
        await admin.page.click('#credits-cancel');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 97.49 })
        });
        await admin.page.reload({ waitUntil: 'domcontentloaded' });
        await admin.page.waitForSelector('#user-rows [data-credit-balance="2"]', { timeout: 10000 });
        check('admin 用户表显示 2 位小数（97.49）', (await readText(admin.page, '[data-credit-balance="2"]')) === '97.49', await readText(admin.page, '[data-credit-balance="2"]'));
        await shot(admin.page, '05c-admin-credits-decimals');
        await fetch(BASE + '/__mock/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 2, balance: 0.09 })
        });
        await admin.page.reload({ waitUntil: 'domcontentloaded' });
        await admin.page.waitForSelector('#user-rows [data-credit-balance="2"]', { timeout: 10000 });
        check('admin 用户表显示 2 位小数（0.09）', (await readText(admin.page, '[data-credit-balance="2"]')) === '0.09', await readText(admin.page, '[data-credit-balance="2"]'));
        await admin.page.click('[data-credit-user="2"]');
        await admin.page.waitForTimeout(300);
        check('admin 分配弹窗显示 2 位小数（0.09 积分）', (await readText(admin.page, '#credits-current')) === '0.09 积分', await readText(admin.page, '#credits-current'));
        await shot(admin.page, '05d-admin-precision');
        await admin.page.click('#credits-cancel');
        results.pageErrors.push(...admin.errors);
        check('管理后台无 JS 报错', admin.errors.length === 0, admin.errors.slice(0, 3));
        await admin.context.close();

        /* 用户列表不带 credits 时的兜底：显示 —，分配后回填 */
        await mockConfig(BASE, { adminCreditsInList: false });
        await resetMock(BASE);
        await mockConfig(BASE, { adminCreditsInList: false });
        const admin2 = await loginContext(browser, ADMIN);
        await admin2.page.goto(BASE + '/static/admin.html#users', { waitUntil: 'domcontentloaded' });
        await admin2.page.waitForSelector('#user-rows [data-credit-balance]', { timeout: 10000 });
        const unknown = await admin2.page.evaluate(() => ({
            first: document.querySelector('[data-credit-balance="2"]') ? document.querySelector('[data-credit-balance="2"]').textContent.trim() : null,
            cls: document.querySelector('#user-rows [data-credit-balance="2"]').className
        }));
        check('列表没有余额字段时显示 — 兜底', unknown.first === '—' && unknown.cls.indexOf('is-unknown') >= 0, unknown);
        await admin2.page.click('[data-credit-user="2"]');
        await admin2.page.waitForTimeout(250);
        const unknownModal = await readText(admin2.page, '#credits-current');
        check('余额未知时弹窗如实标注', unknownModal === '—（分配后返回）', unknownModal);
        await admin2.page.fill('#credits-delta', '8');
        await admin2.page.click('#credits-confirm');
        await admin2.page.waitForTimeout(500);
        check('分配后回填行余额', (await readText(admin2.page, '[data-credit-balance="2"]')) === '20.50', await readText(admin2.page, '[data-credit-balance="2"]'));
        await admin2.context.close();
        await mockConfig(BASE, { adminCreditsInList: true });

        /* ───────────────────────────────────────────── 5. auth-off：静默 */
        const off = await loginContext(browser, MEMBER);
        const offRequests = [];
        off.page.on('request', (request) => {
            if (request.url().indexOf('/api/credits') >= 0) offRequests.push(new URL(request.url()).pathname);
        });
        await off.page.goto(BASE_OFF + '/static/smart-canvas.html?id=credits-off', { waitUntil: 'domcontentloaded' });
        await off.page.waitForTimeout(2500);
        const offState = await off.page.evaluate(() => ({
            creditsGlobal: window.NOVAI_CREDITS ? window.NOVAI_CREDITS.state : null,
            collabDom: document.querySelectorAll('[id^="collab-"]').length,
            pill: Boolean(document.querySelector('#collab-credits-btn')),
            toasts: Boolean(document.querySelector('#credits-toasts'))
        }));
        results.metrics.authOff = { state: offState, requests: offRequests };
        check('auth-off 不渲染积分 UI', !offState.pill && offState.creditsGlobal.available === false, offState);
        check('auth-off 不挂协作 HUD', offState.collabDom === 0, offState.collabDom);
        check('auth-off 不弹任何积分提示', !offState.toasts);
        check('auth-off 只探测一次 /api/credits/me', offRequests.filter((item) => item === '/api/credits/me').length === 1, offRequests);
        check('auth-off 不开 SSE', offRequests.filter((item) => item === '/api/credits/stream').length === 0, offRequests);
        check('auth-off 不调价目接口', offRequests.filter((item) => item === '/api/credits/price').length === 0, offRequests);
        await shot(off.page, '07-auth-off');
        results.pageErrors.push(...off.errors);
        check('auth-off 页面无 JS 报错', off.errors.length === 0, off.errors.slice(0, 3));
        await off.context.close();
    } catch (error) {
        failed += 1;
        results.fatal = String((error && error.stack) || error);
        console.error('FATAL ' + results.fatal);
    } finally {
        await browser.close();
        if (startedByUs) await stopMocks();
        results.finishedAt = new Date().toISOString();
        results.failed = failed;
        fs.writeFileSync(REPORT, JSON.stringify(results, null, 2));
        console.log('');
        console.log('[credits-ui] ' + (failed ? failed + ' 项失败' : '全部通过') + ' · 截图 ' + Object.keys(results.shots).length + ' 张 → ' + OUT_DIR);
        process.exit(failed ? 1 : 0);
    }
})().catch(async (error) => {
    console.error(error);
    await stopMocks();
    process.exit(1);
});
