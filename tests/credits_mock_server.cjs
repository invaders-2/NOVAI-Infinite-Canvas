#!/usr/bin/env node
/*
 * 积分 UI 验收用的零依赖 mock 后端（不需要 npm install / 不需要真实模型）
 *
 *   node tests/credits_mock_server.cjs --port 8893 [--auth on|off]
 *
 * 用途：给 tests/credits_ui_e2e.cjs 提供「登录 + 积分 + 生成 + SSE」的可控环境，
 * 静态文件直接读仓库里的 static/（改完前端不用重启服务）。
 *
 * 覆盖的后端契约（与 server/credits/api.py 对齐）：
 *   GET  /api/credits/me
 *   GET  /api/credits/transactions?limit=
 *   GET  /api/credits/price
 *   GET  /api/credits/stream          （SSE：先推一次余额，之后余额变化就推）
 *   POST /api/admin/users/{id}/credits
 *   生成接口：/api/generate、/api/canvas-llm、/api/canvas-llm/stream、/api/canvas-video、
 *            /api/canvas-image-tasks、/api/tasks/{id}（响应里带 credits / 余额不足回 402）
 *
 * 控制面（只有测试脚本用）：
 *   GET  /__mock/state                       当前余额/流水/请求记录
 *   POST /__mock/reset                       重置为初始数据
 *   POST /__mock/balance    {balance, userId}
 *   POST /__mock/config     {adminCreditsInList, priceDelayMs, genDelayMs, transactions}
 *   POST /__mock/leak       {balance, userId} 只推 SSE 不落库（验证「实时刷新」）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'static');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const PORT = Number(process.env.CREDITS_MOCK_PORT || argOf('--port', 8893));
const AUTH_MODE = String(argOf('--auth', process.env.CREDITS_MOCK_AUTH || 'on')).toLowerCase();

const USERS = [
    { id: 1, username: 'admin', password: 'admin12345', role: 'admin' },
    { id: 2, username: 'member', password: 'member-pass-123', role: 'user' }
];
const USERNAME_BY_ID = USERS.reduce((map, user) => { map[user.id] = user.username; return map; }, {});

let state = {};

function now() {
    return Math.floor(Date.now() / 1000);
}

function round(value, digits) {
    const factor = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(Number(value || 0) * factor) / factor;
}

function seedTransactions(balance) {
    const base = now() - 600;
    return [
        /* 分位流水：验证 2 位小数展示（正负各一条） */
        { id: 8, delta: 0.02, balance_after: 12.52, kind: 'refund', note: '多退少补', created_at: base + 420 },
        { id: 7, delta: -0.01, balance_after: 12.5, kind: 'charge', note: 'estimate', created_at: base + 360 },
        { id: 6, delta: -2.5, balance_after: 12.5, kind: 'charge', note: 'estimate', created_at: base + 300 },
        { id: 5, delta: -5, balance_after: 15, kind: 'charge', note: 'estimate', created_at: base + 240 },
        { id: 4, delta: -1.5, balance_after: 20, kind: 'charge', note: 'upstream:cost', created_at: base + 180 },
        { id: 3, delta: -4, balance_after: 21.5, kind: 'charge', note: 'estimate', created_at: base + 120 },
        { id: 2, delta: 3, balance_after: 25.5, kind: 'refund', note: '任务失败自动退款', created_at: base + 60 },
        { id: 1, delta: 22.5, balance_after: 22.5, kind: 'admin_adjust', note: '邀请奖励', created_at: base }
    ];
}

function resetState() {
    state = {
        auth: AUTH_MODE !== 'off',
        adminCreditsInList: true,
        priceDelayMs: 120,
        genDelayMs: 220,
        prices: {},
        postpaid: true,
        /* 与后端 CREDIT_OVERDRAFT_LIMIT 一致：发起时 balance + 0.01 < 预计价 → 402 */
        overdraftLimit: 0.01,
        balances: { 1: 100, 2: 12.5 },
        transactions: { 1: [], 2: seedTransactions() },
        nextTransactionId: 100,
        nextChargeId: 500,
        nextTaskId: 1,
        sseClients: new Set(),
        requests: [],
        sessions: new Map()
    };
}

resetState();

function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (error) { resolve({}); }
        });
        req.on('close', () => resolve({}));
    });
}

function sessionUser(req) {
    if (!state.auth) return null;
    const cookie = String(req.headers.cookie || '');
    const match = /novai_mock_session=([^;]+)/.exec(cookie);
    if (!match) return null;
    const id = Number(decodeURIComponent(match[1]));
    if (!USERNAME_BY_ID[id]) return null;
    return USERS.find((user) => user.id === id) || null;
}

function authPayload(user) {
    return {
        auth_enabled: true,
        id: user.id,
        username: user.username,
        role: user.role,
        avatar_url: '',
        status: 'active',
        created_at: now() - 86400
    };
}

function balanceOf(userId) {
    return round(state.balances[String(userId)] || 0, 6);
}

function pushBalance(userId, balance) {
    const payload = 'data: ' + JSON.stringify({ type: 'balance', balance: round(balance, 6) }) + '\n\n';
    state.sseClients.forEach((client) => {
        if (String(client.userId) !== String(userId)) return;
        try { client.res.write(payload); } catch (error) { /* 连接已断 */ }
    });
}

function recordTransaction(userId, delta, balanceAfter, kind, note) {
    const list = state.transactions[String(userId)] || (state.transactions[String(userId)] = []);
    state.nextTransactionId += 1;
    list.unshift({
        id: state.nextTransactionId,
        delta: round(delta, 6),
        balance_after: round(balanceAfter, 6),
        kind: kind,
        note: note || '',
        created_at: now()
    });
}

function charge(userId, price, meta) {
    const balance = balanceOf(userId);
    if (balance + 1e-9 < price) return { ok: false, estimate: price, balance: balance };
    const after = round(balance - price, 6);
    state.balances[String(userId)] = after;
    state.nextChargeId += 1;
    recordTransaction(userId, -price, after, 'charge', 'estimate');
    pushBalance(userId, after);
    return {
        ok: true,
        credits: {
            estimate: round(price, 6),
            price: round(price, 6),
            balance_after: after,
            cost_usd: round(price * 0.1 / 1.3, 6),
            price_usd: round(price * 0.1, 6),
            profit_usd: round(price * 0.1 - price * 0.1 / 1.3, 6),
            pricing_fallback: false,
            actual: true,
            charge_id: state.nextChargeId,
            status: 'settled'
        }
    };
}

function priceFor(query) {
    const kind = String(query.kind || '').toLowerCase();
    const rows = Math.max(1, Math.round(Number(query.rows || 1) || 1));
    /* 后端取整改 ceil、按 0.01 步进：文本 0.01 / 图片 0.10 / 视频 1.55 / 音频(TTS) 0.01 */
    let base = 0.1;
    if (kind === 'video') base = 1.55;
    else if (kind === 'audio') base = 0.01;
    else if (kind === 'text' || kind === 'chat') base = 0.01;
    else if (kind === 'table') base = 0.1;
    if (state.prices && state.prices[kind] !== undefined) base = Number(state.prices[kind]);
    /* 全量后付费时 price=0、estimated_price 给参考价；金额一律 2 位小数 */
    const price = round(base * rows, 2);
    const cost = round(price / 1.3, 2);
    const postpaid = state.postpaid !== false;
    return {
        cost: cost,
        price: postpaid ? 0 : price,
        estimated_price: price,
        postpaid: postpaid,
        currency: 'credit',
        usd: { cost: round(cost * 0.1, 6), price: round(price * 0.1, 6), profit: round((price - cost) * 0.1, 6) },
        matched_spec: 'mock-default',
        pricing_fallback: false,
        unmapped: [],
        mode: postpaid ? 'postpaid' : 'prepaid',
        model: String(query.model || 'mock-image'),
        requested_model: String(query.model || 'mock-image'),
        kind: kind || 'image',
        tier: 'gold',
        unit: 'per_call',
        quantity: rows,
        usd_per_credit: 0.1,
        markup: 1.3
    };
}

function generationKind(pathname) {
    if (/\/canvas-llm|\/chat/.test(pathname)) return 'text';
    if (/\/canvas-audio|\/audio|\/music/.test(pathname)) return 'audio';
    if (/\/canvas-video|\/video/.test(pathname)) return 'video';
    if (/\/canvas-image-tasks|\/generate/.test(pathname)) return 'image';
    return 'image';
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

function serveFile(res, filePath) {
    fs.readFile(filePath, (error, data) => {
        if (error) { json(res, 404, { detail: 'not found', path: filePath }); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Content-Length': data.length
        });
        res.end(data);
    });
}

function serveStatic(res, pathname) {
    const decoded = decodeURIComponent(pathname);
    const relative = decoded.replace(/^\/static\/?/, '');
    const target = path.resolve(STATIC_DIR, relative);
    if (!target.startsWith(STATIC_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        json(res, 404, { detail: 'not found', path: decoded });
        return;
    }
    serveFile(res, target);
}

function sseStream(req, res, user) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('data: ' + JSON.stringify({ type: 'balance', balance: balanceOf(user.id) }) + '\n\n');
    const client = { res: res, userId: user.id };
    state.sseClients.add(client);
    const timer = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (error) { /* 连接已断 */ }
    }, 15000);
    req.on('close', () => {
        clearInterval(timer);
        state.sseClients.delete(client);
    });
}

/* 全量后付费：生成完成后按实际价格扣（允许扣成负数），返回契约里的 credits */
function settlePostpaid(userId, price) {
    const after = round(balanceOf(userId) - price, 6);
    state.balances[String(userId)] = after;
    state.nextChargeId += 1;
    recordTransaction(userId, -price, after, 'charge', 'postpaid');
    pushBalance(userId, after);
    return {
        estimate: round(price, 6),
        price: round(price, 6),
        balance_after: after,
        cost_usd: round(price * 0.1 / 1.3, 6),
        price_usd: round(price * 0.1, 6),
        profit_usd: round(price * 0.1 - price * 0.1 / 1.3, 6),
        pricing_fallback: false,
        actual: true,
        charge_id: state.nextChargeId,
        status: 'settled',
        mode: 'postpaid'
    };
}

function quoteAmount(quote) {
    return Number(quote && quote.estimated_price != null ? quote.estimated_price : (quote && quote.price)) || 0;
}

function canSubmit(userId, amount) {
    return balanceOf(userId) + Number(state.overdraftLimit || 0) + 1e-9 >= amount;
}

function insufficientPayload(userId, amount) {
    return {
        code: 'INSUFFICIENT_CREDITS',
        detail: '积分不足',
        estimate: round(amount, 6),
        balance: balanceOf(userId)
    };
}

/* 统一的生成完成响应：postpaid 生成后扣（可为负），legacy 仍预扣/402 */
function finishGeneration(res, user, quote, buildOk) {
    const amount = quoteAmount(quote);
    const payload = typeof buildOk === 'function' ? buildOk() : {};
    if (state.postpaid !== false) {
        if (!canSubmit(user.id, amount)) {
            setTimeout(() => json(res, 402, insufficientPayload(user.id, amount)), Math.max(0, Math.min(state.genDelayMs, 150)));
            return;
        }
        setTimeout(() => {
            json(res, 200, Object.assign({}, payload, { credits: settlePostpaid(user.id, amount) }));
        }, Math.max(0, state.genDelayMs));
        return;
    }
    const result = charge(user.id, amount);
    setTimeout(() => {
        if (!result.ok) {
            json(res, 402, {
                code: 'INSUFFICIENT_CREDITS', detail: '积分不足',
                estimate: result.estimate, balance: result.balance
            });
            return;
        }
        json(res, 200, Object.assign({}, payload, { credits: result.credits }));
    }, Math.max(0, state.genDelayMs));
}

function streamGeneration(req, res, user, height) {
    let failed = false;
    if (state.postpaid !== false && !canSubmit(user.id, height)) {
        json(res, 402, insufficientPayload(user.id, height));
        return;
    }
    if (state.postpaid === false) {
        const result = charge(user.id, height);
        if (!result.ok) {
            json(res, 402, insufficientPayload(user.id, result.estimate));
            return;
        }
    }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    send({ type: 'meta', model: 'mock-chat', provider: 'mock' });
    let text = '';
    const parts = ['积分', '流式', '验收', '通过'];
    let index = 0;
    const timer = setInterval(() => {
        if (index >= parts.length) {
            clearInterval(timer);
            /* 后付费：流结束才扣（扣完再发 done，余额 SSE 与流结束几乎同时到） */
            if (state.postpaid !== false && !failed) settlePostpaid(user.id, height);
            send({ type: 'done', text: text });
            setTimeout(() => res.end(), 40);
            return;
        }
        text += parts[index];
        send({ type: 'delta', delta: parts[index] });
        index += 1;
    }, 60);
    req.on('close', () => { failed = true; clearInterval(timer); });
}

async function handleMock(req, res, pathname) {
    if (pathname === '/__mock/state') {
        json(res, 200, {
            balances: state.balances,
            transactions: state.transactions,
            requests: state.requests.slice(-400),
            auth: state.auth,
            adminCreditsInList: state.adminCreditsInList,
            sseClients: state.sseClients.size
        });
        return true;
    }
    if (pathname === '/__mock/reset') {
        resetState();
        json(res, 200, { ok: true, balances: state.balances });
        return true;
    }
    if (pathname === '/__mock/balance') {
        const body = await readBody(req);
        const userId = Number(body.userId || 2);
        state.balances[String(userId)] = round(Number(body.balance) || 0, 6);
        pushBalance(userId, state.balances[String(userId)]);
        json(res, 200, { ok: true, balance: state.balances[String(userId)] });
        return true;
    }
    if (pathname === '/__mock/leak') {
        const body = await readBody(req);
        pushBalance(Number(body.userId || 2), Number(body.balance) || 0);
        json(res, 200, { ok: true });
        return true;
    }
    if (pathname === '/__mock/config') {
        const body = await readBody(req);
        if (typeof body.adminCreditsInList === 'boolean') state.adminCreditsInList = body.adminCreditsInList;
        if (typeof body.priceDelayMs === 'number') state.priceDelayMs = body.priceDelayMs;
        if (typeof body.genDelayMs === 'number') state.genDelayMs = body.genDelayMs;
        if (Array.isArray(body.transactions)) state.transactions['2'] = body.transactions;
        if (body.prices && typeof body.prices === 'object') state.prices = body.prices;
        if (typeof body.postpaid === 'boolean') state.postpaid = body.postpaid;
        if (typeof body.postpaidAudio === 'boolean') state.postpaid = body.postpaidAudio;
        json(res, 200, {
            ok: true,
            postpaid: state.postpaid,
            adminCreditsInList: state.adminCreditsInList,
            priceDelayMs: state.priceDelayMs,
            genDelayMs: state.genDelayMs,
            prices: state.prices
        });
        return true;
    }
    return false;
}

async function handleApi(req, res, pathname, query) {
    const method = req.method || 'GET';
    const user = sessionUser(req);

    if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody(req);
        const found = USERS.find((item) => item.username === String(body.username || '') && item.password === String(body.password || ''));
        if (!state.auth) { json(res, 403, { detail: '登录体系未启用', code: 'auth_disabled' }); return; }
        if (!found) { json(res, 401, { detail: '用户名或密码不正确', code: 'bad_credentials' }); return; }
        res.setHeader('Set-Cookie', 'novai_mock_session=' + found.id + '; Path=/; HttpOnly; SameSite=Lax');
        json(res, 200, { user: authPayload(found) });
        return;
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
        res.setHeader('Set-Cookie', 'novai_mock_session=; Path=/; Max-Age=0');
        json(res, 200, { ok: true });
        return;
    }
    if (pathname === '/api/auth/me') {
        if (!state.auth) { json(res, 200, { auth_enabled: false, id: null, username: null, role: null }); return; }
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        json(res, 200, authPayload(user));
        return;
    }
    if (pathname === '/api/auth/account') {
        if (!state.auth) { json(res, 403, { detail: '登录体系未启用', code: 'auth_disabled' }); return; }
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const payload = authPayload(user);
        payload.created_at = now() - 86400;
        json(res, 200, { user: payload, canvas_count: 3 });
        return;
    }

    if (pathname === '/api/credits/me') {
        if (!state.auth) {
            json(res, 200, {
                balance: 0, unit: 'credit', usd_per_credit: 0.1, markup: 1.3, tier: 'gold',
                enabled: false, auth_enabled: false, note: '登录体系未启用，积分不扣费'
            });
            return;
        }
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        json(res, 200, {
            balance: balanceOf(user.id),
            unit: 'credit',
            usd_per_credit: 0.1,
            markup: 1.3,
            tier: 'gold',
            enabled: true,
            auth_enabled: true
        });
        return;
    }
    if (pathname === '/api/credits/transactions') {
        if (!state.auth) { json(res, 200, { enabled: false, balance: 0, transactions: [] }); return; }
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const limit = Math.max(1, Math.min(200, Number(query.get('limit') || 50) || 50));
        const list = (state.transactions[String(user.id)] || []).slice(0, limit);
        json(res, 200, { enabled: true, balance: balanceOf(user.id), transactions: list });
        return;
    }
    if (pathname === '/api/credits/stream') {
        if (!state.auth) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write('data: ' + JSON.stringify({ type: 'credits_disabled' }) + '\n\n');
            res.end();
            return;
        }
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        sseStream(req, res, user);
        return;
    }
    if (pathname === '/api/credits/price') {
        if (state.auth && !user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const payload = priceFor({
            kind: query.get('kind') || '',
            model: query.get('model') || '',
            rows: query.get('rows') || '1',
            width: query.get('width') || '',
            height: query.get('height') || '',
            duration: query.get('duration') || ''
        });
        const delay = Math.max(0, state.priceDelayMs);
        setTimeout(() => json(res, 200, payload), delay);
        return;
    }

    if (method === 'POST' && /^\/api\/admin\/users\/\d+\/credits$/.test(pathname)) {
        if (!user || user.role !== 'admin') { json(res, 401, { detail: '需要管理员权限', code: 'forbidden' }); return; }
        const body = await readBody(req);
        const userId = Number(pathname.split('/')[4]);
        const delta = Number(body.delta);
        if (!isFinite(delta) || Math.abs(delta) < 1e-9) {
            json(res, 400, { detail: 'delta 必须是非 0 的有限数字', code: 'invalid_delta' });
            return;
        }
        if (!state.balances[String(userId)] && USERNAME_BY_ID[userId] !== undefined) state.balances[String(userId)] = 0;
        if (USERNAME_BY_ID[userId] === undefined) { json(res, 404, { detail: '用户不存在', code: 'user_not_found' }); return; }
        const current = balanceOf(userId);
        const after = round(current + delta, 6);
        if (after < 0) {
            json(res, 400, {
                detail: '余额不足：当前 ' + current.toFixed(2) + '，无法扣减 ' + Math.abs(delta).toFixed(2),
                code: 'INSUFFICIENT_BALANCE',
                balance: current,
                delta: delta
            });
            return;
        }
        state.balances[String(userId)] = after;
        recordTransaction(userId, delta, after, 'admin_adjust', String(body.note || ''));
        pushBalance(userId, after);
        json(res, 200, { balance: after, delta: delta, user_id: userId, transaction_id: state.nextTransactionId });
        return;
    }
    if (pathname === '/api/admin/users') {
        if (!user || user.role !== 'admin') { json(res, 401, { detail: '需要管理员权限', code: 'forbidden' }); return; }
        const users = USERS.map((item) => {
            const payload = authPayload(item);
            payload.canvas_count = item.id === 1 ? 4 : 2;
            if (state.adminCreditsInList) payload.credits = balanceOf(item.id);
            return payload;
        });
        json(res, 200, { users: users, stats: { users: users.length, active_invites: 2, new_today: 1 } });
        return;
    }
    if (pathname === '/api/admin/invites') {
        if (!user || user.role !== 'admin') { json(res, 401, { detail: '需要管理员权限', code: 'forbidden' }); return; }
        json(res, 200, { invites: [] });
        return;
    }

    /* Agent 一次跑多步、没有单一价目：前端只提示后付费，这里返回 ok（内部生成各自计费） */
    if (method === 'POST' && pathname === '/api/agent/run') {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        await readBody(req);
        setTimeout(() => json(res, 200, { ok: true, run_id: 'mock-agent-run' }), Math.max(0, state.genDelayMs));
        return;
    }

    /* ── 生成接口：后付费，响应带 credits（legacy 预扣路径保留） ── */
    if (method === 'POST' && /^\/api\/(canvas-llm|chat)$/.test(pathname)) {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const body = await readBody(req);
        const kind = generationKind(pathname);
        const quote = priceFor({ kind: kind, model: body.model || '', rows: body.n || body.count || 1 });
        if (body.fail) {
            setTimeout(() => json(res, 500, { detail: 'mock 上游失败' }), Math.max(0, state.genDelayMs));
            return;
        }
        finishGeneration(res, user, quote, () => ({ text: 'mock reply', model: body.model || 'mock-chat' }));
        return;
    }
    if (method === 'POST' && pathname === '/api/canvas-llm/stream') {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        await readBody(req);
        streamGeneration(req, res, user, quoteAmount(priceFor({ kind: 'text' })));
        return;
    }
    if (method === 'POST' && /^\/api\/(canvas-video|video)$/.test(pathname)) {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const body = await readBody(req);
        const quote = priceFor({ kind: 'video', model: body.model || '' });
        finishGeneration(res, user, quote, () => ({ urls: [] }));
        return;
    }
    if (method === 'POST' && /^\/api\/(canvas-audio|canvas-audio-split|canvas-tts|audio|music|tts)$/.test(pathname)) {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const body = await readBody(req);
        const kind = /split/.test(pathname) ? 'text' : 'audio';
        const quote = priceFor({ kind: kind, model: body.model || '' });
        finishGeneration(res, user, quote, () => ({ urls: [], audio: 'mock-audio' }));
        return;
    }
    if (method === 'POST' && /^\/api\/(generate|canvas-image-tasks|ms\/generate)$/.test(pathname)) {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const body = await readBody(req);
        const quote = priceFor({ kind: 'image', model: body.model || '', rows: body.n || body.count || 1 });
        finishGeneration(res, user, quote, () => ({ task_id: 'mock-task-' + (state.nextTaskId++), images: [] }));
        return;
    }
    if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
        if (!user) { json(res, 401, { detail: '未登录或会话已过期', code: 'unauthorized' }); return; }
        const quote = priceFor({ kind: 'image' });
        const amount = quoteAmount(quote);
        const credits = state.postpaid !== false
            ? settlePostpaid(user.id, amount)
            : (function () {
                const result = charge(user.id, amount);
                return result.ok ? result.credits : { estimate: amount, price: 0, balance_after: balanceOf(user.id), status: 'failed' };
            })();
        json(res, 200, {
            task_id: pathname.split('/').pop(),
            status: 'succeeded',
            credits: credits
        });
        return;
    }

    if (pathname === '/api/canvases') {
        json(res, 200, { canvases: [] });
        return;
    }
    if (/^\/api\/canvases\/[^/]+$/.test(pathname)) {
        json(res, 200, {
            canvas: {
                id: decodeURIComponent(pathname.split('/').pop()),
                title: '积分验收画布',
                kind: 'smart',
                nodes: [],
                connections: [],
                viewport: { x: 0, y: 0, scale: 1 },
                settings: {},
                created_at: now() - 3600,
                updated_at: now() - 60
            }
        });
        return;
    }
    if (pathname === '/api/version' || pathname === '/api/config' || pathname === '/api/workflows') {
        json(res, 200, { version: '1.0.136', providers: [], workflows: [] });
        return;
    }

    json(res, 200, {});
}

const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1:' + PORT);
    const pathname = parsed.pathname;
    if (pathname.startsWith('/__mock/')) {
        state.requests.push({ method: req.method, path: pathname });
        handleMock(req, res, pathname).then((handled) => {
            if (!handled) json(res, 404, { detail: 'mock route not found' });
        }).catch((error) => json(res, 500, { detail: String(error && error.message) }));
        return;
    }
    state.requests.push({ method: req.method, path: pathname, query: parsed.search });
    if (pathname.startsWith('/api/')) {
        handleApi(req, res, pathname, parsed.searchParams).catch((error) => {
            json(res, 500, { detail: String(error && error.message) });
        });
        return;
    }
    if (pathname === '/' || pathname === '/v2' || pathname === '/v2/') {
        serveFile(res, path.join(STATIC_DIR, 'v2', 'index.html'));
        return;
    }
    if (pathname === '/account' || pathname === '/account.html') {
        serveFile(res, path.join(STATIC_DIR, 'account.html'));
        return;
    }
    if (pathname === '/admin' || pathname === '/admin.html') {
        serveFile(res, path.join(STATIC_DIR, 'admin.html'));
        return;
    }
    if (pathname.startsWith('/static/')) {
        serveStatic(res, pathname);
        return;
    }
    json(res, 404, { detail: 'not found', path: pathname });
});

server.on('upgrade', (req, socket) => {
    /* 没有协作 WS 实现：直接断开，页面按「协作离线」继续跑，不影响积分 HUD 验收 */
    socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('[credits-mock] http://127.0.0.1:' + PORT + ' auth=' + (state.auth ? 'on' : 'off'));
});
