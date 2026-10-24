#!/usr/bin/env node
/*
 * 画布实时协作 Playwright 验收（1600×1000，auth-on：owner + editor + viewer）
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/collab_e2e.cjs
 *
 * 前置：后端以 NOVAI_AUTH_ENABLED=1 + 管理员跑在 $NOVAI_BASE（默认 8898，数据目录干净）。
 * 每次会新建 3 个用户，建议服务端带 NOVAI_REGISTER_IP_LIMIT=1000，否则重跑会撞注册限流 429。
 * 自建用户 / 画布 / 分享关系，重复执行不会撞名；截图落到 tests/artifacts/collab-ui/。
 *
 * 覆盖：presence 头像簇与人数、节点拖动/新建/删除同步、远程光标、viewer 只读横幅与
 * 编辑拦截、分享弹窗（owner 可编辑 / viewer 只读）、空闲无补丁回环、加入/离开 toast。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'test-pass-123';
const OUT_DIR = path.join(__dirname, 'artifacts', 'collab-ui');
const INPUT_NODES = [
    { id: 'n_a', type: 'smart-label', x: 180, y: 220, w: 140, h: 40, text: '协作节点 A', labelStyle: 'solid', labelColor: '#4E79A7', labelFontSize: 13, labelDot: true, labelIcon: '', images: [] },
    { id: 'n_b', type: 'smart-label', x: 620, y: 340, w: 140, h: 40, text: '协作节点 B', labelStyle: 'solid', labelColor: '#76B7B2', labelFontSize: 13, labelDot: true, labelIcon: '', images: [] }
];
const INPUT_CONNECTIONS = [{ from: 'n_a', to: 'n_b', kind: 'flow' }]; // 旧画布连线没有 id，协议键由两端各自推导

const results = { base: BASE, checks: {}, shots: {}, pageErrors: [] };
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
        (() => { try { return chromium.executablePath(); } catch (e) { return ''; } })(),
        path.join(require('os').homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = Date.now().toString(36);
    const ownerName = 'alice_e2e_' + stamp;
    const editorName = 'bob_e2e_' + stamp;
    const viewerName = 'carol_e2e_' + stamp;
    const password = 'collab-pass-123';

    const adminApi = await request.newContext({ baseURL: BASE });
    const adminLogin = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (adminLogin.status() !== 200) throw new Error('管理员登录失败：' + adminLogin.status());

    async function createUser(username) {
        const inviteResponse = await adminApi.post('/api/admin/invites', { data: {} });
        if (inviteResponse.status() !== 200) throw new Error('邀请码创建失败：' + inviteResponse.status());
        const invite = (await inviteResponse.json()).invite.code;
        const api = await request.newContext({ baseURL: BASE });
        const register = await api.post('/api/auth/register', {
            data: { username: username, password: password, invite_code: invite }
        });
        if (register.status() !== 200) throw new Error('注册失败 ' + username + '：' + register.status());
        await api.dispose();
    }
    await createUser(ownerName);
    await createUser(editorName);
    await createUser(viewerName);

    const ownerApi = await request.newContext({ baseURL: BASE });
    await ownerApi.post('/api/auth/login', { data: { username: ownerName, password: password } });
    const created = await ownerApi.post('/api/canvases', { data: { title: '协作验收画布', kind: 'smart' } });
    const createdBody = await created.json();
    const canvasId = createdBody.canvas.id;
    const put = await ownerApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
        data: {
            title: '协作验收画布', icon: 'sparkles', nodes: INPUT_NODES, connections: INPUT_CONNECTIONS,
            viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'collab-e2e'
        }
    });
    if (put.status() !== 200) throw new Error('画布初始化失败：' + put.status());
    for (const [username, role] of [[editorName, 'editor'], [viewerName, 'viewer']]) {
        const shared = await ownerApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
            data: { username: username, role: role }
        });
        if (shared.status() !== 200) throw new Error('分享失败 ' + username + '：' + shared.status());
    }
    results.canvasId = canvasId;
    results.users = { owner: ownerName, editor: editorName, viewer: viewerName };

    const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});

    async function openSession(username) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        const login = await context.request.post(BASE + '/api/auth/login', { data: { username: username, password: password } });
        if (login.status() !== 200) throw new Error('登录失败 ' + username + '：' + login.status());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await page.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });
        await page.waitForTimeout(600);
        results.pageErrors.push(...errors);
        return { context, page, errors };
    }
    const docOf = (page) => page.evaluate(() => window.SmartCanvasCollab.getDoc());
    const posOf = (doc, id) => { const node = (doc.nodes || []).find((item) => item.id === id); return node ? { x: node.x, y: node.y } : null; };
    async function centerOf(page, selector) {
        const box = await page.locator(selector).first().boundingBox();
        if (!box) throw new Error('找不到元素 ' + selector);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    try {
        const owner = await openSession(ownerName);
        const editor = await openSession(editorName);

        // a) presence / avatar cluster（B 加入后 A 收到 presence）
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 5000 });
        const presence = await owner.page.evaluate(() => ({
            names: window.NOVAI_COLLAB.users.map((user) => user.username),
            avatars: document.querySelectorAll('.collab-avatar').length,
            countText: document.getElementById('collab-member-count').textContent
        }));
        check('a1 owner avatar cluster shows 2 users', presence.avatars === 2 && presence.countText === '2 人' && presence.names.length === 2, presence);
        const editorPresence = await editor.page.evaluate(() => ({
            names: window.NOVAI_COLLAB.users.map((user) => user.username),
            role: window.NOVAI_COLLAB.role
        }));
        check('a2 editor receives presence and role', editorPresence.role === 'editor' && editorPresence.names.length === 2, editorPresence);

        // 第三个人（viewer）加入后，先把「头像簇 + 人数」定格下来；此时还没有远程光标
        const viewer = await openSession(viewerName);
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 3, { timeout: 5000 });
        await owner.page.waitForTimeout(2800); // 等 carol 加入的 toast 消失，避免截图里堆着提示
        results.shots.avatars = path.join(OUT_DIR, '01-avatars.png');
        await owner.page.screenshot({ path: results.shots.avatars });

        // b) drag sync
        const beforeDrag = posOf(await docOf(editor.page), 'n_a');
        const dragFrom = await centerOf(owner.page, '.image-node[data-id="n_a"]');
        await owner.page.mouse.move(dragFrom.x, dragFrom.y);
        await owner.page.mouse.down();
        await owner.page.mouse.move(dragFrom.x + 110, dragFrom.y + 70, { steps: 12 });
        await owner.page.mouse.up();
        let dragSynced = false;
        try {
            await editor.page.waitForFunction(({ id, x, y }) => {
                const doc = window.SmartCanvasCollab.getDoc();
                const node = (doc.nodes || []).find((item) => item.id === id);
                return node && (Math.abs(node.x - x) > 40 || Math.abs(node.y - y) > 40);
            }, { id: 'n_a', x: beforeDrag.x, y: beforeDrag.y }, { timeout: 1500 });
            dragSynced = true;
        } catch (e) { /* 失败在下面统一记录 */ }
        const afterDrag = posOf(await docOf(editor.page), 'n_a');
        check('b1 editor sees dragged node within 1s', dragSynced, { beforeDrag, afterDrag });

        // c) create + delete
        const nodeCount = (await docOf(owner.page)).nodes.length;
        await owner.page.mouse.dblclick(1100, 460);
        await owner.page.waitForSelector('#createMenu.open', { timeout: 3000 });
        await owner.page.click('#createMenu [data-create-type="label"]');
        let createdSynced = false;
        try {
            await editor.page.waitForFunction((count) => window.SmartCanvasCollab.getDoc().nodes.length === count + 1, nodeCount, { timeout: 3000 });
            createdSynced = true;
        } catch (e) {}
        check('c1 editor sees newly created node', createdSynced, { before: nodeCount, after: (await docOf(editor.page)).nodes.length });
        const ownerDoc = await docOf(owner.page);
        const newNode = ownerDoc.nodes.find((node) => !['n_a', 'n_b'].includes(node.id));
        check('c2 new node exists in owner doc', Boolean(newNode));
        if (newNode) {
            await owner.page.click('.image-node[data-id="' + newNode.id + '"]', { position: { x: 18, y: 18 } });
            await owner.page.keyboard.press('Delete');
            let deletedSynced = false;
            try {
                await editor.page.waitForFunction((count) => window.SmartCanvasCollab.getDoc().nodes.length === count, nodeCount, { timeout: 3000 });
                deletedSynced = true;
            } catch (e) {}
            check('c3 editor sees node deleted', deletedSynced, { nodes: (await docOf(editor.page)).nodes.length });
        }

        // c4-c6 连线同步（旧数据没有 id，靠 from->to::kind 稳定键对齐）
        const connCount = async (page) => (await docOf(page)).connections.length;
        check('c4 both sides see seeded id-less connection', (await connCount(owner.page)) === 1 && (await connCount(editor.page)) === 1);
        await owner.page.locator('.conn-hit').first().click({ force: true });
        let connRemoved = false;
        try {
            await editor.page.waitForFunction(() => window.SmartCanvasCollab.getDoc().connections.length === 0, { timeout: 3000 });
            connRemoved = true;
        } catch (e) {}
        check('c5 editor sees connection removed', connRemoved);
        await owner.page.evaluate(() => window.SmartCanvasCollab.applyPatch({ connections: { add: [{ from: 'n_a', to: 'n_b', kind: 'flow' }] } }));
        let connAdded = false;
        try {
            await editor.page.waitForFunction(() => window.SmartCanvasCollab.getDoc().connections.length === 1, { timeout: 3000 });
            connAdded = true;
        } catch (e) {}
        check('c6 editor sees connection added', connAdded);
        await owner.page.evaluate(() => window.SmartCanvasCollab.applyPatch({ title: '协作验收画布 · 已同步' }));
        let titleSynced = false;
        try {
            await editor.page.waitForFunction(() => window.SmartCanvasCollab.getDoc().title === '协作验收画布 · 已同步' && /已同步/.test(document.title), { timeout: 3000 });
            titleSynced = true;
        } catch (e) {}
        check('c7 editor sees title change', titleSynced);

        // d) remote cursor
        const editorId = await editor.page.evaluate(() => window.NOVAI_COLLAB.selfId);
        await editor.page.mouse.move(820, 520);
        await editor.page.mouse.move(880, 560, { steps: 6 });
        let cursorVisible = false;
        try {
            await owner.page.waitForFunction((userId) => {
                const el = document.querySelector('.collab-remote-cursor[data-user-id="' + userId + '"]');
                return el && /translate3d/.test(el.style.transform || '');
            }, editorId, { timeout: 3000 });
            cursorVisible = true;
        } catch (e) {}
        const cursorName = await owner.page.evaluate(() => {
            const el = document.querySelector('.collab-remote-cursor .collab-cursor-name span');
            return el ? el.textContent : '';
        });
        check('d1 owner sees editor cursor with name', cursorVisible && cursorName === editorName, { cursorName });
        await editor.page.mouse.move(780, 600);
        await editor.page.mouse.move(840, 640, { steps: 8 });
        await owner.page.waitForTimeout(300);
        results.shots.remoteCursor = path.join(OUT_DIR, '03-remote-cursor.png');
        await owner.page.screenshot({ path: results.shots.remoteCursor });

        // e) viewer
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 3, { timeout: 5000 });
        const viewerState = await viewer.page.evaluate(() => ({
            role: window.NOVAI_COLLAB.role,
            readonly: window.SmartCanvasCollab.isReadOnly(),
            banner: (document.getElementById('collab-readonly-banner') || {}).textContent || '',
            avatars: document.querySelectorAll('.collab-avatar').length
        }));
        check('e1 viewer gets readonly bridge', viewerState.role === 'viewer' && viewerState.readonly === true, viewerState);
        check('e2 viewer banner shows owner', /只读/.test(viewerState.banner) && viewerState.banner.includes(ownerName), viewerState.banner);

        const viewerBefore = posOf(await docOf(viewer.page), 'n_a');
        const viewerDrag = await centerOf(viewer.page, '.image-node[data-id="n_a"]');
        await viewer.page.mouse.move(viewerDrag.x, viewerDrag.y);
        await viewer.page.mouse.down();
        await viewer.page.mouse.move(viewerDrag.x + 130, viewerDrag.y + 90, { steps: 10 });
        await viewer.page.mouse.up();
        await viewer.page.waitForTimeout(900);
        const viewerAfter = posOf(await docOf(viewer.page), 'n_a');
        const viewerStats = await viewer.page.evaluate(() => window.NOVAI_COLLAB.stats);
        check('e3 viewer cannot drag node', viewerBefore && viewerAfter && viewerBefore.x === viewerAfter.x && viewerBefore.y === viewerAfter.y, { viewerBefore, viewerAfter });
        check('e4 viewer sends no patch', viewerStats.sentPatches === 0, viewerStats);

        const ownerBeforeViewer = posOf(await docOf(owner.page), 'n_a');
        await viewer.page.mouse.dblclick(1100, 460);
        await viewer.page.waitForTimeout(400);
        check('e5 viewer cannot open create menu', (await viewer.page.locator('#createMenu.open').count()) === 0);
        const viewerNodeCount = (await docOf(viewer.page)).nodes.length;
        await viewer.page.evaluate(() => window.zoomBarCreate('label'));
        await viewer.page.waitForTimeout(400);
        check('e6 viewer cannot create node', (await docOf(viewer.page)).nodes.length === viewerNodeCount, { before: viewerNodeCount });
        const ownerAfterViewer = posOf(await docOf(owner.page), 'n_a');
        check('e7 viewer does not affect owner doc', JSON.stringify(ownerBeforeViewer) === JSON.stringify(ownerAfterViewer), { ownerBeforeViewer, ownerAfterViewer });

        // f) idle: no diff loop / patch storm
        const idleBefore = await owner.page.evaluate(() => window.NOVAI_COLLAB.stats.sentPatches);
        await owner.page.waitForTimeout(900);
        const idleAfter = await owner.page.evaluate(() => window.NOVAI_COLLAB.stats.sentPatches);
        check('f1 idle sends no patches', idleAfter === idleBefore, { idleBefore, idleAfter });

        // g) collab popover: owner editable, viewer read-only（头像簇开成员面板；分享按钮已改为分享弹窗）
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 8000 });
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length >= 3, { timeout: 8000 });
        check('g1 owner sees editable collab panel',
            (await owner.page.locator('.collab-panel-invite:not([hidden])').count()) === 1
            && (await owner.page.locator('.collab-role-btn').count()) > 0);
        await owner.page.waitForTimeout(250);
        results.shots.sharePanel = path.join(OUT_DIR, '02-share-panel.png');
        await owner.page.screenshot({ path: results.shots.sharePanel });
        await owner.page.keyboard.press('Escape');
        await owner.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });

        await viewer.page.click('#collab-avatars');
        await viewer.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 8000 });
        await viewer.page.waitForFunction(() => document.querySelectorAll('.collab-member').length >= 3, { timeout: 8000 });
        check('g2 viewer sees read-only collab panel',
            (await viewer.page.locator('.collab-panel-invite:not([hidden])').count()) === 0
            && (await viewer.page.locator('.collab-role-btn').count()) === 0
            && (await viewer.page.locator('.collab-member-remove').count()) === 0);
        await viewer.page.click('.collab-panel-close');
        await viewer.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });

        results.shots.readonlyBanner = path.join(OUT_DIR, '04-readonly-banner.png');
        await viewer.page.screenshot({ path: results.shots.readonlyBanner });

        // h) leave toast
        await editor.context.close();
        let leaveToast = false;
        try {
            await owner.page.waitForFunction((name) => {
                return Array.from(document.querySelectorAll('.collab-toast')).some((el) => el.textContent.includes(name) && el.textContent.includes('离开了协作'));
            }, editorName, { timeout: 5000 });
            leaveToast = true;
        } catch (e) {}
        check('h1 owner gets leave toast', leaveToast);
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 5000 });
        check('h2 avatar count back to 2', (await owner.page.evaluate(() => document.querySelectorAll('.collab-avatar').length)) === 2);

        // 额外 1：超过 5 人时头像簇折叠成 +N（在线 6 人 = 5 个头像 + +1）
        const extraNames = [];
        for (let index = 0; index < 4; index += 1) {
            const extraName = 'e2e_extra_' + index + '_' + stamp;
            await createUser(extraName);
            const shared = await ownerApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
                data: { username: extraName, role: 'viewer' }
            });
            if (shared.status() !== 200) throw new Error('额外成员分享失败：' + shared.status());
            extraNames.push(extraName);
        }
        const extras = [];
        for (const extraName of extraNames) extras.push(await openSession(extraName));
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 6, { timeout: 10000 });
        const cluster = await owner.page.evaluate(() => ({
            avatars: document.querySelectorAll('.collab-avatar').length,
            more: (document.querySelector('.collab-more') || {}).textContent || '',
            countText: document.getElementById('collab-member-count').textContent
        }));
        check('j1 six online users collapse to 5 avatars + +1', cluster.avatars === 5 && cluster.more === '+1' && cluster.countText === '6 人', cluster);
        for (const extra of extras) await extra.context.close();
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 8000 });

        // 额外 2：断线后指数退避自动重连
        const reconnectsBefore = await owner.page.evaluate(() => window.NOVAI_COLLAB.stats.reconnects);
        await owner.page.evaluate(() => window.NOVAI_COLLAB._socket().close(4000, 'e2e-reconnect'));
        let sawReconnecting = false;
        try {
            await owner.page.waitForFunction(() => window.NOVAI_COLLAB.status === 'reconnecting', { timeout: 3000 });
            sawReconnecting = true;
        } catch (e) {}
        let backOnline = false;
        try {
            await owner.page.waitForFunction(() => window.NOVAI_COLLAB.status === 'online', { timeout: 10000 });
            backOnline = true;
        } catch (e) {}
        const reconnectsAfter = await owner.page.evaluate(() => window.NOVAI_COLLAB.stats.reconnects);
        check('j2 auto reconnect after socket drop', sawReconnecting && backOnline && reconnectsAfter > reconnectsBefore, { sawReconnecting, reconnectsBefore, reconnectsAfter });

        // 额外 3：无权限用户拿到明确提示，且不无限重连
        const strangerName = 'e2e_stranger_' + stamp;
        await createUser(strangerName);
        const strangerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await strangerContext.request.post(BASE + '/api/auth/login', { data: { username: strangerName, password: password } });
        const strangerPage = await strangerContext.newPage();
        await strangerPage.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await strangerPage.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await strangerPage.waitForTimeout(2600);
        const strangerState = await strangerPage.evaluate(() => ({
            status: window.NOVAI_COLLAB.status,
            reconnects: window.NOVAI_COLLAB.stats.reconnects,
            toasts: Array.from(document.querySelectorAll('.collab-toast')).map((el) => el.textContent)
        }));
        check('j3 no permission => offline, no retry, clear toast',
            strangerState.status === 'offline' && strangerState.reconnects === 0 && strangerState.toasts.some((text) => /权限|画布/.test(text)),
            strangerState);
        await strangerContext.close();

        // i) 房间满：会话本身有权限，但 10 个连接已占满，新连接应收到 4409 且不重连
        const collabSocketUrl = await owner.page.evaluate(() => window.NOVAI_COLLAB._socket().url);
        const fillResult = await owner.page.evaluate(async (url) => {
            window.__collabFill = [];
            for (let index = 0; index < 12; index += 1) window.__collabFill.push(new WebSocket(url));
            await new Promise((resolve) => setTimeout(resolve, 600));
            return { opened: window.__collabFill.filter((socket) => socket.readyState === WebSocket.OPEN).length };
        }, collabSocketUrl);
        check('j4 fill room sockets', fillResult.opened >= 5, fillResult);
        await owner.page.waitForTimeout(300);
        const fullContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await fullContext.request.post(BASE + '/api/auth/login', { data: { username: ownerName, password: password } });
        const fullPage = await fullContext.newPage();
        const fullErrors = [];
        fullPage.on('pageerror', (error) => fullErrors.push(String(error)));
        await fullPage.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await fullPage.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await fullPage.waitForTimeout(2200);
        const fullState = await fullPage.evaluate(() => ({
            status: window.NOVAI_COLLAB.status,
            reconnects: window.NOVAI_COLLAB.stats.reconnects,
            toasts: Array.from(document.querySelectorAll('.collab-toast')).map((el) => el.textContent)
        }));
        check('i1 room full => offline + no retry + clear toast',
            fullState.status === 'offline' && fullState.reconnects === 0 && fullState.toasts.some((text) => /房间已满/.test(text)),
            fullState);
        check('i2 room-full page has no errors', fullErrors.length === 0, fullErrors);
        await fullContext.close();
        await owner.page.evaluate(() => {
            (window.__collabFill || []).forEach((socket) => { try { socket.close(); } catch (e) {} });
            window.__collabFill = [];
        });
        await owner.page.waitForTimeout(400);

        check('k1 no page errors', results.pageErrors.length === 0, results.pageErrors);
        results.summary = { failed: failed };
        console.log(JSON.stringify(results, null, 2));
        await browser.close();
        await adminApi.dispose();
        await ownerApi.dispose();
        process.exit(failed ? 1 : 0);
    } catch (error) {
        console.error('[collab-e2e] 失败：', error);
        await browser.close().catch(() => {});
        process.exit(2);
    }
})().catch((error) => {
    console.error('[collab-e2e] 启动失败：', error);
    process.exit(2);
});
