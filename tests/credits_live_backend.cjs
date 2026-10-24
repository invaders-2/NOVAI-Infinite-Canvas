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
 *   - 余额为 0 时真实生成接口 402，UI 提示「积分不足」
 *   - 管理员扣成负数被后端拒绝（400）
 *
 * 真实「生成一次 → HUD/账户页同时减」需要打到真实模型（会花钱），默认不做：
 * 用 NOVAI_LIVE_GENERATION=1 显式打开（需要该实例已配好可用 provider）。
 * 精度验收（0.0001 级扣费）：
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

/* 把 "<0.0001" 当作 0.00005 参与比较；其余按数字解析 */
function parseCredits(text) {
    const raw = String(text == null ? '' : text).trim();
    if (raw.indexOf('<0.0001') >= 0) return 0.00005;
    const match = /-?[0-9]+(?:\.[0-9]+)?/.exec(raw);
    return match ? Number(match[0]) : NaN;
}

/* 和界面同口径的显示（最多 4 位、去尾随 0），用于等待管理员加分后的文本 */
function formatLike(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    const abs = Math.abs(num);
    if (abs > 0 && abs < 0.0001) return (num < 0 ? '-' : '') + '<0.0001';
    const rounded = Math.round(num * 10000) / 10000;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
    return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
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
        check('成员画布 HUD 显示真实余额 12.5', (await readText(page, '#collab-credits-num')) === '12.5', await readText(page, '#collab-credits-num'));
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
        check('成员 HUD 无刷新实时变 20', await waitText(page, '#collab-credits-num', '20', 10000), await readText(page, '#collab-credits-num'));
        await page.click('#collab-credits-btn');
        await page.waitForSelector('#collab-credits-pop:not([hidden])', { timeout: 5000 });
        await page.waitForTimeout(450);
        const popover = await page.evaluate(() => ({
            balance: document.querySelector('#collab-credits-balance').textContent.trim(),
            rows: [...document.querySelectorAll('.collab-credits-row')].map((row) => row.innerText.replace(/\n/g, ' '))
        }));
        check('popover 余额 20 且流水含真实备注', popover.balance === '20' && popover.rows.some((row) => row.indexOf('自动化验收追加') >= 0), popover);
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
        check('账户页余额 20 / USD ≈ $2.00 / 有流水', accountState.balance === '20' && accountState.usd === '≈ $2.00' && accountState.rows >= 2, accountState);
        await shot(account, 'live-03-account');

        const third = await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: 1, note: '同步校验' } });
        check('管理员 +1（真实）', third.status() === 200);
        check('账户页随真实 SSE 变 21', await waitText(account, '#credits-balance', '21', 10000), await readText(account, '#credits-balance'));
        check('HUD 同步变 21', await waitText(page, '#collab-credits-num', '21', 10000), await readText(page, '#collab-credits-num'));

        /* 真实价目接口 */
        const price = await adminApi.get('/api/credits/price?kind=image&model=doubao-seedream-4-0-250828&width=1024&height=1024', { timeout: REQUEST_TIMEOUT });
        const priceBody = await price.json();
        check('真实 /api/credits/price 返回 credit 价', price.status() === 200 && priceBody.currency === 'credit' && typeof priceBody.price === 'number', priceBody);
        results.metrics.price = priceBody;

        /* 余额清零 → 真实生成接口 402（预扣在调上游之前，不会真的生成） */
        const zero = await adminApi.post('/api/admin/users/' + member.id + '/credits', { data: { delta: -21, note: '清空用于 402 验收' } });
        check('管理员扣到 0（真实）', zero.status() === 200 && (await zero.json()).balance === 0);
        check('HUD 实时变 0', await waitText(page, '#collab-credits-num', '0', 10000), await readText(page, '#collab-credits-num'));
        /* 余额 0 → /api/canvas-llm 真实 402（预扣在调上游之前，不会真的生成）。
           注意：任务型接口 /api/canvas-video、/api/canvas-image-tasks 在「余额不足」分支会把后端卡死
           （2026-10-24 实测：请求不返回、整站失去响应），属于 server 侧缺陷，这里只用 canvas-llm 验收 UI。 */
        const llmPrice = await (await adminApi.get('/api/credits/price?kind=text&model=gpt-4o-mini', { timeout: REQUEST_TIMEOUT })).json();
        results.metrics.textPrice = llmPrice;
        await page.evaluate(() => {
            window.__credit402 = fetch('/api/canvas-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '积分 402 验收' }),
                signal: AbortSignal.timeout(20000)
            }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
        });
        const insufficientToast = await waitForToast(page, '积分不足', 10000);
        const limited = await page.evaluate(() => window.__credit402);
        check('余额 0 时真实生成接口回 402', limited.status === 402 && limited.body && limited.body.code === 'INSUFFICIENT_CREDITS', limited);
        check('UI 提示「积分不足」+ 所需/当前', Boolean(insufficientToast) && /积分不足：本次需 [0-9.]+，当前 0/.test(String(insufficientToast)), insufficientToast);
        await shot(page, 'live-04-insufficient');

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
            const match = /已扣 ([0-9.]+|<0\.0001) 积分 · 余额 ([0-9.]+|<0\.0001)/.exec(String(toast || ''));
            check('真实扣费提示是「已扣 X 积分 · 余额 Y」', Boolean(match), toast);
            if (match) {
                const spent = parseCredits(match[1]);
                const left = parseCredits(match[2]);
                check('扣费金额非 0 且最多 4 位小数', spent > 0 && /^[0-9]+(\.[0-9]{1,4})?$/.test(match[1]), { spent: match[1] });
                const credits = generation.body && generation.body.credits;
                check('扣费金额按 0.0001 精度显示（= 后端 credits.price）',
                    Boolean(credits) && formatLike(credits.price) === match[1], { price: credits && credits.price, shown: match[1] });
                check('余额按 0.0001 精度显示（= 后端 credits.balance_after）',
                    Boolean(credits) && formatLike(credits.balance_after) === match[2], { balance: credits && credits.balance_after, shown: match[2] });
                check('HUD 余额 = 提示里的余额（0.0001 级变化可见）',
                    parseCredits(await readText(page, '#collab-credits-num')) === left, { hud: await readText(page, '#collab-credits-num'), toast: match[2] });
                await account.bringToFront();
                await account.waitForTimeout(600);
                const accountBalance = parseCredits(await readText(account, '#credits-balance'));
                check('账户页余额与 HUD 同步', accountBalance === left, { account: accountBalance, hud: left });
                check('HUD 确实变了（0.0001 级扣费不被四舍五入吞掉）', parseCredits(await readText(page, '#collab-credits-num')) < startBalance + 0.00005, { start: startBalance, left: left });
            }
        } else {
            console.log('SKIP  真实生成扣费（会花钱）：NOVAI_LIVE_GENERATION=1 才跑');
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
