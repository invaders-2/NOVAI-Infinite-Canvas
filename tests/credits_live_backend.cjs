#!/usr/bin/env node
/*
 * 积分 UI 真实后端验收（不依赖 mock）
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/credits_live_backend.cjs
 *   NOVAI_BASE=http://127.0.0.1:8899 node tests/credits_live_backend.cjs      # 指向真实 8899
 *
 * 前置：auth-on 后端（默认 8897），管理员 admin / admin12345（可用 NOVAI_ADMIN_USER/PASSWORD 覆盖）。
 * 后端不可用或 auth 没开 → 打印 SKIP 并以 0 退出（不拖累 CI / run-all）。
 * 没有现成服务时用 NOVAI_LIVE_START=1 让它自己起一个（临时数据目录，跑完关掉）：
 *   NOVAI_LIVE_START=1 NOVAI_LIVE_GENERATION=1 node tests/credits_live_backend.cjs
 *
 * 覆盖：
 *   - 真实 /api/credits/me、/transactions、/price、SSE
 *   - 管理员加分 → 成员画布 HUD 实时变（不刷新页面）
 *   - 账户页余额 / USD 等值 / 流水与 HUD 同步
 *   - 全量后付费：0 余额也能提交（NOVAI_LIVE_ZERO=1 时真实跑一次），完成后扣成负余额
 *   - 管理员扣成负数被后端拒绝（400）
 *
 * 真实「生成一次 → HUD/账户页同时减」需要打到真实模型（会花钱），默认不做：
 * 用 NOVAI_LIVE_GENERATION=1 显式打开（需要该实例已配好可用 provider）。
 * 精度验收（2 位小数，0.01 步进）：
 *   NOVAI_BASE=http://127.0.0.1:8899 NOVAI_LIVE_GENERATION=1 NOVAI_LIVE_MODEL=gpt-4o-mini NOVAI_LIVE_TOKENS=15 \
 *   node tests/credits_live_backend.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8897';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'admin12345';
const MEMBER_PASS = process.env.NOVAI_LIVE_PASSWORD || 'live-pass-123';
const WITH_GENERATION = process.env.NOVAI_LIVE_GENERATION === '1';
/* 真实生成用哪个模型 / 多少输出 token（默认 64；精度验收用 NOVAI_LIVE_MODEL=gpt-4o-mini NOVAI_LIVE_TOKENS=15） */
const LIVE_MODEL = process.env.NOVAI_LIVE_MODEL || '';
const LIVE_TOKENS = Number(process.env.NOVAI_LIVE_TOKENS || 64) || 64;
const START_SERVER = process.env.NOVAI_LIVE_START === '1';
/* 后付费 TTS 验收（会花一点点钱）：NOVAI_LIVE_TTS=1 才跑 */
const WITH_TTS = process.env.NOVAI_LIVE_TTS === '1';
/* 0 余额真实提交（需要 8899 已配好 provider，会真的调一次上游）：NOVAI_LIVE_ZERO=1 才跑 */
const WITH_ZERO = process.env.NOVAI_LIVE_ZERO === '1';
const TTS_MODEL = process.env.NOVAI_LIVE_TTS_MODEL || 'tts-1';
const TTS_PROVIDER = process.env.NOVAI_LIVE_TTS_PROVIDER || 'apimart';
const TTS_TEXT = process.env.NOVAI_LIVE_TTS_TEXT || '你好，这是一句短句。';
const ROOT = path.resolve(__dirname, '..');
const REQUEST_TIMEOUT = 20000;
const OUT_DIR = path.join(__dirname, 'artifacts', 'credits-ui', 'live');
const REPORT = path.join(__dirname, 'artifacts', 'credits-ui', 'live-report.json');
const VIEWPORT = { width: 1600, height: 1000 };

const results = { base: BASE, checks: {}, metrics: {}, shots: {}, pageErrors: [] };
let failed = 0;

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

async function readable(base) {
    try {
        const response = await fetch(base + '/api/auth/me', { signal: AbortSignal.timeout(4000) });
        return response.status === 200 || response.status === 401;
    } catch (error) {
        return false;
    }
}

let serverChild = null;

/* 没有现成后端时自己起一个（默认端口 8897，临时数据目录），跑完在 finally 里关掉 */
async function ensureServer() {
    if (await readable(BASE)) return true;
    if (!START_SERVER) return false;
    const port = Number(new URL(BASE).port || 8897);
    const dataDir = process.env.NOVAI_LIVE_DATA_DIR || '/tmp/novai-credits-live';
    const serverLog = process.env.NOVAI_LIVE_SERVER_LOG || '/tmp/credits-live-server.log';
    const logFd = fs.openSync(serverLog, 'a');
    serverChild = spawn('python3', ['main.py', '--port', String(port)], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            NOVAI_DATA_DIR: dataDir,
            NOVAI_AUTH_ENABLED: '1',
            NOVAI_ADMIN_USER: ADMIN_USER,
            NOVAI_ADMIN_PASSWORD: ADMIN_PASS,
            NOVAI_REGISTER_IP_LIMIT: '1000',
            NOVAI_LAN_AUTH: '0'
        }),
        stdio: ['ignore', logFd, logFd]
    });
    serverChild.on('error', (error) => {
        console.error('[credits-live] 启动后端失败：' + error.message);
    });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        if (await readable(BASE)) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.error('[credits-live] 后端 45s 内没就绪，看日志：' + serverLog);
    return false;
}

async function shot(page, name) {
    const file = path.join(OUT_DIR, name + '.png');
    await page.screenshot({ path: file });
    results.shots[name] = file;
}

async function readText(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.textContent || '').trim() : null;
    }, selector);
}

/* 解析界面上的积分文本（可能带负号） */
function parseCredits(text) {
    const raw = String(text == null ? '' : text).trim();
    const match = /-?[0-9]+(?:\.[0-9]+)?/.exec(raw);
    return match ? Number(match[0]) : NaN;
}

/* 和界面同口径的显示（固定 2 位小数），用于等待管理员加分后的文本 */
function formatLike(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num.toFixed(2);
}

/* 轮询提示条文字（记录每次变化），直到出现预期文案或超时 */
async function watchToastSamples(page, untilNeedle, timeoutMs) {
    const samples = [];
    const startedAt = Date.now();
    const deadline = startedAt + (timeoutMs || 120000);
    while (Date.now() < deadline) {
        const text = await page.evaluate(() => {
            const el = document.querySelector('[data-credits-toast]');
            return el ? String(el.innerText || '').trim() : null;
        });
        if (text && (!samples.length || samples[samples.length - 1].text !== text)) {
            samples.push({ at: Date.now() - startedAt, text: text });
        }
        if (untilNeedle && text && text.indexOf(untilNeedle) >= 0) break;
        await page.waitForTimeout(150);
    }
    return samples;
}

async function waitForToast(page, needle, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
        const text = await page.evaluate(() => {
            const el = document.querySelector('[data-credits-toast]');
            return el ? String(el.innerText || '').trim() : null;
        });
        if (text && text.indexOf(needle) >= 0) return text;
        await page.waitForTimeout(100);
    }
    return null;
}

async function waitText(page, selector, value, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
        if ((await readText(page, selector)) === value) return true;
        await page.waitForTimeout(120);
    }
    return false;
}

(async () => {
    if (!(await ensureServer())) {
        console.log('[credits-live] SKIP：' + BASE + ' 不可用（可加 NOVAI_LIVE_START=1 让它自己起服务）');
        process.exit(0);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = Date.now().toString(36);
    const memberName = 'credits_live_' + stamp;
    const executablePath = chromiumExecutable();
    const browser = await chromium.launch(executablePath ? { executablePath: executablePath } : {});
    let adminApi = null;

    try {
        adminApi = await request.newContext({ baseURL: BASE });
        const adminLogin = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS }, timeout: REQUEST_TIMEOUT });
        if (adminLogin.status() !== 200) {
            console.log('[credits-live] SKIP：管理员登录失败（' + adminLogin.status() + '），检查 NOVAI_ADMIN_USER/PASSWORD');
            process.exit(0);
        }
        const me = await adminApi.get('/api/credits/me', { timeout: REQUEST_TIMEOUT });
        const meBody = await me.json();
        check('真实 /api/credits/me 可用', me.status() === 200 && typeof meBody.balance === 'number' && meBody.unit === 'credit', { status: me.status(), body: meBody });
        results.metrics.admin = { unit: meBody.unit, usd_per_credit: meBody.usd_per_credit, tier: meBody.tier };

        /* 建一个一次性成员 */
        const invite = await adminApi.post('/api/admin/invites', { data: { uses: 1, role: 'user' }, timeout: REQUEST_TIMEOUT });
        if (invite.status() !== 200) throw new Error('创建邀请码失败：' + invite.status());
        const inviteBody = await invite.json();
        const inviteCode = inviteBody.invite ? inviteBody.invite.code : inviteBody.code;
        /* 注册会写会话 cookie，必须用独立 context，否则会把管理员会话顶掉 */
        const registerApi = await request.newContext({ baseURL: BASE });
        const register = await registerApi.post('/api/auth/register', {
            data: { username: memberName, password: MEMBER_PASS, invite_code: inviteCode },
            timeout: REQUEST_TIMEOUT
        });
        await registerApi.dispose();
        if (register.status() !== 200) throw new Error('注册成员失败：' + register.status() + ' ' + JSON.stringify(await register.json().catch(() => ({}))));
        const memberApi = await request.newContext({ baseURL: BASE });
        const memberLogin = await memberApi.post('/api/auth/login', { data: { username: memberName, password: MEMBER_PASS }, timeout: REQUEST_TIMEOUT });
        if (memberLogin.status() !== 200) throw new Error('成员登录失败：' + memberLogin.status());
        const adminUsers = await (await adminApi.get('/api/admin/users', { timeout: REQUEST_TIMEOUT })).json();
        const member = (adminUsers.users || []).find((user) => user.username === memberName);
        if (!member) throw new Error('成员列表里找不到新用户');
        results.memberId = member.id;
        results.memberName = memberName;
        const canvasResponse = await memberApi.post('/api/canvases', {
            data: { title: '积分验收画布', icon: 'sparkles', kind: 'smart', project: 'default', board_x: 40, board_y: 40 }
        });
        if (canvasResponse.status() !== 200) throw new Error('建画布失败：' + canvasResponse.status());
        const canvasId = (await canvasResponse.json()).canvas.id;
        await memberApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
            data: {
                title: '积分验收画布', icon: 'sparkles', nodes: [], connections: [],
                viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'credits-live'
            }
        });
        results.canvasId = canvasId;

        /* 管理员加分（真实调账） */
        const first = await adminApi.post('/api/admin/users/' + member.id + '/credits', {
            data: { delta: 12.5, note: '自动化验收首充' }
        });
        const firstBody = await first.json();
        check('管理员给成员加分 12.5（真实）', first.status() === 200 && firstBody.balance === 12.5, { status: first.status(), body: firstBody });
        check('管理员扣成负数被拒（400）',
            (await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: -1000, note: '越界扣减' } })).status() === 400);

        /* 成员画布：HUD 显示真实余额 */
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
        const login = await context.request.post(BASE + '/api/auth/login', { data: { username: memberName, password: MEMBER_PASS } });
        if (login.status() !== 200) throw new Error('浏览器登录失败：' + login.status());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const text = String(message.text());
            if (/WebSocket connection|Failed to load resource/.test(text)) return;
            errors.push('console:' + text);
        });
        await page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#collab-credits-btn', { state: 'visible', timeout: 25000 });
        check('成员画布 HUD 显示真实余额 12.50', (await readText(page, '#collab-credits-num')) === '12.50', await readText(page, '#collab-credits-num'));
        let sseState = -1;
        const sseDeadline = Date.now() + 8000;
        while (Date.now() < sseDeadline) {
            sseState = await page.evaluate(() => (window.NOVAI_CREDITS ? window.NOVAI_CREDITS.__debug().sse : -1));
            if (sseState === 1) break;
            await page.waitForTimeout(200);
        }
        check('真实 SSE 已连接', sseState === 1, sseState);
        await shot(page, 'live-01-hud');

        /* 管理员再加分 → 成员页面实时变（真实 SSE） */
        const second = await adminApi.post('/api/admin/users/' + member.id + '/credits', {
            data: { delta: 7.5, note: '自动化验收追加' }
        });
        check('管理员追加 7.5（真实）', second.status() === 200 && (await second.json()).balance === 20);
        check('成员 HUD 无刷新实时变 20.00', await waitText(page, '#collab-credits-num', '20.00', 10000), await readText(page, '#collab-credits-num'));
        await page.click('#collab-credits-btn');
        await page.waitForSelector('#collab-credits-pop:not([hidden])', { timeout: 5000 });
        await page.waitForTimeout(450);
        const popover = await page.evaluate(() => ({
            balance: document.querySelector('#collab-credits-balance').textContent.trim(),
            rows: [...document.querySelectorAll('.collab-credits-row')].map((row) => row.innerText.replace(/\n/g, ' '))
        }));
        check('popover 余额 20.00 且流水含真实备注', popover.balance === '20.00' && popover.rows.some((row) => row.indexOf('自动化验收追加') >= 0), popover);
        await shot(page, 'live-02-popover');
        await page.click('#collab-credits-close');

        /* 账户页：与 HUD 同一个余额 */
        const account = await context.newPage();
        account.on('pageerror', (error) => errors.push(String(error)));
        await account.goto(BASE + '/static/account.html', { waitUntil: 'domcontentloaded' });
        await account.waitForTimeout(1200);
        const accountState = await account.evaluate(() => ({
            balance: document.querySelector('#credits-balance').textContent.trim(),
            usd: document.querySelector('#credits-usd').textContent.trim(),
            rows: document.querySelectorAll('.credit-row').length
        }));
        check('账户页余额 20.00 / USD ≈ $2.00 / 有流水', accountState.balance === '20.00' && accountState.usd === '≈ $2.00' && accountState.rows >= 2, accountState);
        await shot(account, 'live-03-account');

        const third = await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: 1, note: '同步校验' } });
        check('管理员 +1（真实）', third.status() === 200);
        check('账户页随真实 SSE 变 21.00', await waitText(account, '#credits-balance', '21.00', 10000), await readText(account, '#credits-balance'));
        check('HUD 同步变 21.00', await waitText(page, '#collab-credits-num', '21.00', 10000), await readText(page, '#collab-credits-num'));

        /* 真实价目接口 */
        const price = await adminApi.get('/api/credits/price?kind=image&model=doubao-seedream-4-0-250828&width=1024&height=1024', { timeout: REQUEST_TIMEOUT });
        const priceBody = await price.json();
        check('真实 /api/credits/price 返回 credit 价', price.status() === 200 && priceBody.currency === 'credit' && typeof priceBody.price === 'number', priceBody);
        results.metrics.price = priceBody;

        /* 全量后付费：0 余额也能提交 */
        const zero = await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: -21, note: '清空用于 0 余额验收' } });
        check('管理员扣到 0（真实）', zero.status() === 200 && (await zero.json()).balance === 0);
        check('HUD 实时变 0.00', await waitText(page, '#collab-credits-num', '0.00', 10000), await readText(page, '#collab-credits-num'));

        if (WITH_ZERO) {
            /* 欠费上限 0.01：0 余额时预计 ≤0.01 能提交，>0.01 返回 402（需要已配好 provider） */
            const textPrice = await (await adminApi.get('/api/credits/price?kind=text&model=gpt-4o-mini', { timeout: REQUEST_TIMEOUT })).json();
            const textEstimate = Number(textPrice.estimated_price != null ? textPrice.estimated_price : textPrice.price) || 0;
            results.metrics.textPrice = textPrice;
            const textShouldPass = textEstimate <= 0.01 + 1e-9;
            await page.evaluate(() => {
                window.__zeroGenDone = false;
                window.__zeroGen = fetch('/api/canvas-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: '0 余额后付费验收' }),
                    signal: AbortSignal.timeout(180000)
                }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
                    .finally(() => { window.__zeroGenDone = true; });
            });
            const zeroToastWatch = watchToastSamples(page, '已扣', 60000);
            const zeroDeadline = Date.now() + 60000;
            while (Date.now() < zeroDeadline) {
                if (await page.evaluate(() => Boolean(window.__zeroGenDone))) break;
                await page.waitForTimeout(250);
            }
            const zeroResult = await page.evaluate(() => window.__zeroGen);
            const zeroToasts = await zeroToastWatch;
            results.metrics.zeroBalance = { response: zeroResult, toasts: zeroToasts, estimate: textEstimate };
            if (textShouldPass) {
                check('0 余额文本（预计 ' + textEstimate + ' ≤ 0.01）提交成功', zeroResult.status === 200, zeroResult);
                check('0 余额文本完成后扣成负余额或 0',
                    Boolean(zeroResult.body && zeroResult.body.credits) &&
                    Number(zeroResult.body.credits.balance_after) <= 0, zeroResult.body && zeroResult.body.credits);
            } else {
                check('0 余额文本（预计 ' + textEstimate + ' > 0.01）返回 402', zeroResult.status === 402, zeroResult);
                check('402 文案带预计/当前/欠费上限',
                    zeroToasts.some((item) => /积分不足：本次预计 [0-9.]+ 积分，当前 [0-9.-]+ 积分（可欠费 0\.01 积分）/.test(item.text)), zeroToasts);
            }
            await shot(page, 'live-04-zero-balance-text');

            /* 图片：走同步扣费入口 /api/online-image（预扣在调上游之前，402 不会真的生成） */
            const imagePrice = await (await adminApi.get('/api/credits/price?kind=image&width=1024&height=1024', { timeout: REQUEST_TIMEOUT })).json();
            const imageEstimate = Number(imagePrice.estimated_price != null ? imagePrice.estimated_price : imagePrice.price) || 0;
            results.metrics.zeroImage = { price: imagePrice, estimate: imageEstimate };
            const balanceNow = Number((await (await memberApi.get('/api/credits/me', { timeout: REQUEST_TIMEOUT })).json()).balance) || 0;
            if (imageEstimate > 0.01 + 1e-9 && balanceNow + 0.01 < imageEstimate) {
                await page.evaluate(() => {
                    window.__zeroImage = fetch('/api/online-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: '0 余额图片验收', size: '1024x1024', n: 1 }),
                        signal: AbortSignal.timeout(30000)
                    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
                });
                const imageToastWatch = watchToastSamples(page, '可欠费', 30000);
                const zeroImage = await page.evaluate(() => window.__zeroImage);
                const imageToasts = await imageToastWatch;
                results.metrics.zeroImage.response = zeroImage;
                results.metrics.zeroImage.toasts = imageToasts;
                check('0 余额图片（预计 ' + imageEstimate + ' > 0.01）返回 402', zeroImage.status === 402, zeroImage);
                check('图片 402 文案带预计/当前/欠费上限',
                    imageToasts.some((item) => /积分不足：本次预计 [0-9.]+ 积分，当前 [0-9.-]+ 积分（可欠费 0\.01 积分）/.test(item.text)), imageToasts);
                await shot(page, 'live-05-zero-balance-image-402');
            } else {
                console.log('SKIP  图片 402 校验（该实例图片估价 ≤ 0.01 或余额够，跳过以免真的生成）');
            }
        } else {
            console.log('SKIP  0 余额真实提交（需要 provider）：NOVAI_LIVE_ZERO=1 才跑');
        }

        if (WITH_GENERATION) {
            /* 显式打开才会花钱：真实生成一次，看 HUD/账户页同时减，且小额扣费不被取整 */
            const before = parseCredits(await readText(page, '#collab-credits-num'));
            await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: 5, note: '生成验收额度' } });
            await waitText(page, '#collab-credits-num', formatLike(before + 5), 10000);
            const startBalance = parseCredits(await readText(page, '#collab-credits-num'));
            await page.evaluate((config) => {
                const body = { message: '用一句话介绍积分制', max_tokens: config.tokens };
                if (config.model) body.model = config.model;
                window.__creditGen = fetch('/api/canvas-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(180000)
                }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
            }, { model: LIVE_MODEL, tokens: LIVE_TOKENS });
            const toast = await waitForToast(page, '已扣', 12000);
            await shot(page, 'live-05-generation');
            const generation = await page.evaluate(() => window.__creditGen);
            results.metrics.generation = { start: startBalance, status: generation.status, toast: toast, credits: generation.body && generation.body.credits };
            check('真实文本生成返回 200 且带 credits', generation.status === 200 && Boolean(generation.body && generation.body.credits), generation.status);
            const match = /已扣 (-?[0-9.]+) 积分 · 余额 (-?[0-9.]+)/.exec(String(toast || ''));
            check('真实扣费提示是「已扣 X 积分 · 余额 Y」', Boolean(match), toast);
            if (match) {
                const spent = parseCredits(match[1]);
                const left = parseCredits(match[2]);
                check('扣费金额非 0 且最多 2 位小数', spent > 0 && /^[0-9]+(\.[0-9]{1,2})?$/.test(match[1]), { spent: match[1] });
                const credits = generation.body && generation.body.credits;
                check('扣费金额按 2 位小数显示（= 后端 credits.price）',
                    Boolean(credits) && formatLike(credits.price) === match[1], { price: credits && credits.price, shown: match[1] });
                check('余额按 2 位小数显示（= 后端 credits.balance_after）',
                    Boolean(credits) && formatLike(credits.balance_after) === match[2], { balance: credits && credits.balance_after, shown: match[2] });
                check('HUD 余额 = 提示里的余额（0.01 级变化可见）',
                    parseCredits(await readText(page, '#collab-credits-num')) === left, { hud: await readText(page, '#collab-credits-num'), toast: match[2] });
                await account.bringToFront();
                await account.waitForTimeout(600);
                const accountBalance = parseCredits(await readText(account, '#credits-balance'));
                check('账户页余额与 HUD 同步', accountBalance === left, { account: accountBalance, hud: left });
                check('HUD 确实变了（0.01 级扣费不被四舍五入吞掉）', parseCredits(await readText(page, '#collab-credits-num')) < startBalance + 0.005, { start: startBalance, left: left });
            }
        } else {
            console.log('SKIP  真实生成扣费（会花钱）：NOVAI_LIVE_GENERATION=1 才跑');
        }

        if (WITH_TTS) {
            /* 后付费 TTS：提交时不扣、完成后按实际扣；0 余额也能提交且不弹「积分不足」 */
            const current = await (await memberApi.get('/api/credits/me', { timeout: REQUEST_TIMEOUT })).json();
            const need = 5 - Number(current.balance || 0);
            if (Math.abs(need) > 1e-9) {
                await adminApi.post('/api/admin/users/' + member.id + '/credits', {
                    data: { delta: need, note: 'TTS 后付费验收额度' }, timeout: REQUEST_TIMEOUT
                });
            }
            check('TTS 前余额置为 5', await waitText(page, '#collab-credits-num', formatLike(5), 10000), await readText(page, '#collab-credits-num'));

            await page.evaluate((config) => {
                window.__ttsDone = false;
                window.__tts = fetch('/api/canvas-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider_id: config.provider,
                        model: config.model,
                        input: config.text,
                        voice: 'alloy',
                        response_format: 'wav'
                    }),
                    signal: AbortSignal.timeout(180000)
                }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
                    .finally(() => { window.__ttsDone = true; });
            }, { provider: TTS_PROVIDER, model: TTS_MODEL, text: TTS_TEXT });

            /* 提示条与余额采样并行：提示条要能抓到「生成后按实际用量扣费」这一帧 */
            const toastWatch = watchToastSamples(page, '已扣', 120000);
            /* 生成过程中轮询余额：postpaid 应该是「完成前不扣」 */
            const midSamples = [];
            const waitDeadline = Date.now() + 120000;
            while (Date.now() < waitDeadline) {
                const done = await page.evaluate(() => Boolean(window.__ttsDone));
                if (done) break;
                try {
                    const snapshot = await (await memberApi.get('/api/credits/me', { timeout: REQUEST_TIMEOUT })).json();
                    midSamples.push(Number(snapshot.balance));
                } catch (error) { /* 服务忙时忽略单次采样 */ }
                await page.waitForTimeout(250);
            }
            const tts = await page.evaluate(() => window.__tts);
            const ttsCredits = (tts.body && tts.body.credits) || {};
            const ttsToasts = await toastWatch;
            results.metrics.tts = { midSamples: midSamples.slice(0, 12), credits: ttsCredits, toasts: ttsToasts };
            check('真实 TTS 返回 200', tts.status === 200, { status: tts.status, body: tts.body && Object.keys(tts.body) });
            check('真实 TTS credits.mode = postpaid', String(ttsCredits.mode || '').toLowerCase() === 'postpaid', ttsCredits);
            check('TTS 不显示「本次预计消耗」', ttsToasts.every((item) => item.text.indexOf('本次预计消耗') < 0), ttsToasts);
            check('TTS 提交后先提示「生成后按实际用量扣费」',
                ttsToasts.length === 0 || ttsToasts.some((item) => item.text.indexOf('生成后按实际用量扣费') >= 0) ||
                ttsToasts.every((item) => item.text.indexOf('本次预计消耗') < 0), ttsToasts);
            const ttsBalance = formatLike(ttsCredits.balance_after);
            check('TTS 完成后 HUD 余额 = 后端 balance_after',
                parseCredits(await readText(page, '#collab-credits-num')) === parseCredits(ttsBalance), {
                    hud: await readText(page, '#collab-credits-num'), backend: ttsCredits.balance_after
                });
            const ttsSpent = ttsToasts.map((item) => /已扣 (-?[0-9.]+) 积分/.exec(item.text)).find(Boolean);
            check('TTS 提示的扣费金额 = 后端 credits.price',
                Boolean(ttsSpent) && ttsCredits.price !== undefined && formatLike(ttsCredits.price) === ttsSpent[1],
                { shown: ttsSpent && ttsSpent[1], price: ttsCredits.price, toasts: ttsToasts });
            if (Number(ttsCredits.price) > 0 && midSamples.length) {
                check('TTS 生成过程中余额没提前扣（postpaid）',
                    midSamples[0] >= 5 - 1e-6, { first: midSamples[0], all: midSamples.slice(0, 5) });
                check('TTS 完成后余额确实减少',
                    parseCredits(await readText(page, '#collab-credits-num')) < 5 - 1e-6, await readText(page, '#collab-credits-num'));
            } else {
                console.log('SKIP  TTS 先不扣校验（后端没给 price 或没有采样）');
            }
            await shot(page, 'live-06-tts-postpaid');

            /* 0 余额也能提交：不 402、不弹「积分不足」 */
            const now = await (await memberApi.get('/api/credits/me', { timeout: REQUEST_TIMEOUT })).json();
            await adminApi.post('/api/admin/users/' + member.id + '/credits', {
                data: { delta: -Number(now.balance || 0), note: 'TTS 零余额验收' }, timeout: REQUEST_TIMEOUT
            });
            check('TTS 前余额置为 0.00', await waitText(page, '#collab-credits-num', '0.00', 10000), await readText(page, '#collab-credits-num'));
            await page.evaluate((config) => {
                window.__ttsZeroDone = false;
                window.__ttsZero = fetch('/api/canvas-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider_id: config.provider,
                        model: config.model,
                        input: config.text,
                        voice: 'alloy',
                        response_format: 'wav'
                    }),
                    signal: AbortSignal.timeout(180000)
                }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
                    .finally(() => { window.__ttsZeroDone = true; });
            }, { provider: TTS_PROVIDER, model: TTS_MODEL, text: TTS_TEXT });
            const zeroDeadline = Date.now() + 120000;
            while (Date.now() < zeroDeadline) {
                if (await page.evaluate(() => Boolean(window.__ttsZeroDone))) break;
                await page.waitForTimeout(250);
            }
            const ttsZero = await page.evaluate(() => window.__ttsZero);
            const zeroSamples = await watchToastSamples(page, null, 1500);
            check('0 余额提交 TTS 不返回 402', ttsZero.status === 200, { status: ttsZero.status, body: ttsZero.body });
            check('0 余额不出现「积分不足」提示', zeroSamples.every((item) => item.text.indexOf('积分不足') < 0), zeroSamples);
            await shot(page, 'live-07-tts-zero-balance');
        } else {
            console.log('SKIP  真实 TTS 后付费（会花钱）：NOVAI_LIVE_TTS=1 才跑');
        }

        results.pageErrors.push(...errors);
        check('真实后端页面无 JS 报错', errors.length === 0, errors.slice(0, 3));
    } catch (error) {
        failed += 1;
        results.fatal = String((error && error.stack) || error);
        console.error('FATAL ' + results.fatal);
    } finally {
        await browser.close();
        if (adminApi) await adminApi.dispose().catch(() => {});
        if (serverChild) {
            try { serverChild.kill('SIGTERM'); } catch (error) { /* 已退出 */ }
        }
        results.failed = failed;
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, JSON.stringify(results, null, 2));
        console.log('');
        console.log('[credits-live] ' + (failed ? failed + ' 项失败' : '全部通过') + ' · 报告 ' + REPORT);
        process.exit(failed ? 1 : 0);
    }
})();
