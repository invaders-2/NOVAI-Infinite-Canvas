#!/usr/bin/env node
/*
 * 公开链接分享：真实后端全链路验收（前端）。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/share_links_live.cjs
 *
 * 前置：auth-on 后端跑在 $NOVAI_BASE（默认 8898，数据目录干净，管理员 admin/admin12345）。
 * 覆盖：owner 自动建链接/改有效期/开关/密码/重开保配置 → 非 owner 只读 →
 *       未登录打开 /c/{token} 跳登录并回到分享页 → 密码错误/正确 → 只读渲染 →
 *       克隆到新画布 → 撤销/过期状态。截图落到 tests/artifacts/share-links/。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'admin12345';
const DATA_DIR = process.env.NOVAI_DATA_DIR || '/tmp/novai-share-test';
const OUT_DIR = path.join(__dirname, 'artifacts', 'share-links');

const NODES = [
    { id: 'liveimg', type: 'smart-image', x: 120, y: 120, title: 'Image', scale: 2, images: [{ url: '/static/images/logo.png', name: 'logo.png', kind: 'image', natural_w: 512, natural_h: 512 }] },
    { id: 'livelabel', type: 'smart-label', x: 560, y: 130, w: 160, h: 38, text: '公开分享', labelStyle: 'solid', labelColor: '#4E79A7', labelFontSize: 13, labelDot: true },
    { id: 'livetext', type: 'smart-text', x: 120, y: 520, w: 316, h: 194, text: '这是一张只读分享的画布。' },
    { id: 'liveprompt', type: 'smart-prompt', x: 560, y: 380, w: 316, h: 180, text: '一张用于展示公开分享页的示意图' },
    { id: 'livegroup', type: 'smart-group', x: 960, y: 120, w: 340, h: 286, title: '示例分组', items: [] }
];
const CONNECTIONS = [{ from: 'liveimg', to: 'liveprompt', kind: 'flow' }, { from: 'livelabel', to: 'livetext', kind: 'flow' }];

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
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = Date.now().toString(36);
    const viewerName = 'live_v_' + stamp;
    const password = 'live-pass-123';
    const sharePassword = 'secret123';

    const adminApi = await request.newContext({ baseURL: BASE });
    const adminLogin = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (adminLogin.status() !== 200) throw new Error('管理员登录失败：' + adminLogin.status());

    const invite = (await (await adminApi.post('/api/admin/invites', { data: {} })).json()).invite.code;
    const viewerApi = await request.newContext({ baseURL: BASE });
    const register = await viewerApi.post('/api/auth/register', { data: { username: viewerName, password: password, invite_code: invite } });
    if (register.status() !== 200) throw new Error('注册失败：' + register.status());

    const created = await adminApi.post('/api/canvases', { data: { title: '公开分享验收画布', kind: 'smart' } });
    const canvasId = (await created.json()).canvas.id;
    const put = await adminApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
        data: { title: '公开分享验收画布', icon: 'sparkles', nodes: NODES, connections: CONNECTIONS, viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'share-live' }
    });
    if (put.status() !== 200) throw new Error('画布初始化失败：' + put.status());
    const shared = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', { data: { username: viewerName, role: 'viewer' } });
    if (shared.status() !== 200) throw new Error('成员分享失败：' + shared.status());

    const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
    async function newLoggedInContext(username, userPassword, colorScheme) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: colorScheme || 'light' });
        const login = await context.request.post(BASE + '/api/auth/login', { data: { username: username, password: userPassword } });
        if (login.status() !== 200) throw new Error('登录失败 ' + username + '：' + login.status());
        return context;
    }
    async function openCanvas(context) {
        const page = await context.newPage();
        page.on('pageerror', (error) => results.pageErrors.push(String(error)));
        await page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await page.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });
        await page.waitForTimeout(400);
        return page;
    }

    const ownerContext = await newLoggedInContext(ADMIN_USER, ADMIN_PASS);
    const viewerContext = await newLoggedInContext(viewerName, password);
    try {
        const ownerPage = await openCanvas(ownerContext);
        await ownerPage.click('#collab-share-btn');
        await ownerPage.waitForSelector('.share-modal', { state: 'visible', timeout: 8000 });
        await ownerPage.waitForFunction(() => {
            const el = document.querySelector('.share-link-input');
            return el && /\/c\//.test(el.value);
        }, { timeout: 8000 });
        await ownerPage.waitForTimeout(200);
        const linkResponse = await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link');
        const linkBody = await linkResponse.json();
        const shareLink = linkBody.link;
        results.shareToken = shareLink.token;
        check('a1 owner auto-creates link on open', linkResponse.status() === 200 && shareLink && shareLink.token && shareLink.expires_in_days === 7 && !shareLink.has_password && !shareLink.allow_clone, shareLink);
        check('a2 modal shows real url', (await ownerPage.inputValue('.share-link-input')) === shareLink.url, await ownerPage.inputValue('.share-link-input'));

        // 有效期 30 天 + 允许克隆（真实 POST）
        const postPromise = ownerPage.waitForResponse((response) => /\/share-link$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 8000 });
        await ownerPage.click('.share-expiry-btn');
        await ownerPage.click('.share-expiry-option[data-days="30"]');
        const postResponse = await postPromise;
        await ownerPage.waitForFunction(() => document.querySelector('.share-expiry-label').textContent === '30 天有效', { timeout: 5000 });
        check('a3 expiry POST 200 + label 30 days', postResponse.status() === 200 && (await ownerPage.textContent('.share-expiry-label')) === '30 天有效', postResponse.status());

        await ownerPage.click('.share-clone-switch');
        await ownerPage.waitForFunction(() => document.querySelector('.share-clone-switch').getAttribute('aria-checked') === 'true', { timeout: 5000 });

        // 密码（失焦提交）
        await ownerPage.click('.share-password-switch');
        await ownerPage.waitForSelector('.share-password-input', { state: 'visible', timeout: 3000 });
        await ownerPage.fill('.share-password-input', sharePassword);
        await ownerPage.click('.share-modal-heading h2');
        await ownerPage.waitForFunction(() => document.querySelector('.share-password-switch').getAttribute('aria-checked') === 'true', { timeout: 8000 });
        const afterConfig = await (await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link')).json();
        check('a4 password + clone + expiry persisted on server',
            afterConfig.link.expires_in_days === 30 && afterConfig.link.has_password === true && afterConfig.link.allow_clone === true, afterConfig.link);

        // 已设密码后再改有效期：后端是整份覆盖，前端必须把已知密码带上，不能把密码冲掉
        const preserveWait = ownerPage.waitForResponse((response) => /\/share-link$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 8000 });
        await ownerPage.click('.share-expiry-btn');
        await ownerPage.click('.share-expiry-option[data-days="7"]');
        await preserveWait;
        await ownerPage.waitForFunction(() => document.querySelector('.share-expiry-label').textContent === '7 天有效', { timeout: 5000 });
        const afterPreserve = await (await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link')).json();
        check('a4b changing expiry keeps password', afterPreserve.link.expires_in_days === 7 && afterPreserve.link.has_password === true, afterPreserve.link);
        await ownerPage.click('.share-expiry-btn');
        await ownerPage.click('.share-expiry-option[data-days="30"]');
        await ownerPage.waitForFunction(() => document.querySelector('.share-expiry-label').textContent === '30 天有效', { timeout: 5000 });

        // 重开弹窗保配置
        await ownerPage.keyboard.press('Escape');
        await ownerPage.waitForSelector('.share-modal', { state: 'hidden', timeout: 3000 });
        await ownerPage.click('#collab-share-btn');
        await ownerPage.waitForSelector('.share-modal', { state: 'visible', timeout: 5000 });
        await ownerPage.waitForFunction(() => /30 天有效/.test(document.querySelector('.share-expiry-label').textContent), { timeout: 5000 });
        const reopened = await ownerPage.evaluate(() => ({
            expiry: document.querySelector('.share-expiry-label').textContent,
            clone: document.querySelector('.share-clone-switch').getAttribute('aria-checked'),
            password: document.querySelector('.share-password-switch').getAttribute('aria-checked')
        }));
        check('a5 reopened modal keeps config', reopened.expiry === '30 天有效' && reopened.clone === 'true' && reopened.password === 'true', reopened);
        await ownerPage.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
        await ownerPage.mouse.move(900, 760);
        await ownerPage.waitForTimeout(3000);
        results.shots.modal = path.join(OUT_DIR, 'share-live-modal.png');
        await ownerPage.screenshot({ path: results.shots.modal });

        // 非 owner（成员）：后端的 GET share-link 403 → 只读降级
        const viewerPage = await openCanvas(viewerContext);
        await viewerPage.click('#collab-share-btn');
        await viewerPage.waitForSelector('.share-modal', { state: 'visible', timeout: 8000 });
        await viewerPage.waitForFunction(() => {
            const hint = document.querySelector('.share-link-hint');
            return hint && !hint.hidden && hint.textContent.length > 0;
        }, { timeout: 8000 });
        const readonly = await viewerPage.evaluate(() => ({
            invite: document.querySelector('#share-invite').hidden,
            expiryDisabled: document.querySelector('.share-expiry-btn').disabled,
            passwordDisabled: document.querySelector('.share-password-switch').disabled,
            cloneDisabled: document.querySelector('.share-clone-switch').disabled,
            copyDisabled: document.querySelector('[data-action="share-copy"]').disabled,
            hint: document.querySelector('.share-link-hint').textContent
        }));
        check('e1 non-owner readonly + link hidden by backend', readonly.invite && readonly.expiryDisabled && readonly.passwordDisabled && readonly.cloneDisabled && readonly.copyDisabled, readonly);
        results.deviation = '真实后端 GET /api/canvases/{id}/share-link 对非 owner/admin 返回 403，非 owner 无法复制链接；前端只读降级并明确提示。';
        await viewerPage.keyboard.press('Escape');

        // 未登录打开 /c/{token} → 登录 → 回到分享页
        const anonContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
        const anonPage = await anonContext.newPage();
        anonPage.on('pageerror', (error) => results.pageErrors.push(String(error)));
        await anonPage.goto(BASE + '/c/' + shareLink.token, { waitUntil: 'domcontentloaded' });
        await anonPage.waitForURL((url) => /\/login\?next=/.test(url.toString()), { timeout: 15000 });
        const redirectUrl = new URL(anonPage.url());
        check('b1 logged-out /c link redirects to login with next', decodeURIComponent(redirectUrl.searchParams.get('next') || '') === '/c/' + shareLink.token, anonPage.url());
        await anonPage.waitForSelector('#username', { state: 'visible', timeout: 10000 });
        await anonPage.fill('#username', viewerName);
        await anonPage.fill('#password', password);
        await anonPage.click('#submit');
        await anonPage.waitForURL((url) => new URL(url.toString()).pathname === '/c/' + shareLink.token, { timeout: 25000 });
        await anonPage.waitForSelector('#shareGate', { state: 'visible', timeout: 15000 });
        results.shots.password = path.join(OUT_DIR, 'share-live-password.png');
        await anonPage.screenshot({ path: results.shots.password });
        check('b2 after login share page asks for password', (await anonPage.textContent('#shareGateTitle')) === '此画布需要密码');

        await anonPage.fill('#sharePasswordInput', 'wrong-password');
        await anonPage.click('#sharePasswordForm button');
        await anonPage.waitForSelector('#shareGateError', { state: 'visible', timeout: 8000 });
        check('b3 wrong password shows error', /密码不正确/.test(await anonPage.textContent('#shareGateError')));
        await anonPage.fill('#sharePasswordInput', sharePassword);
        await anonPage.click('#sharePasswordForm button');
        await anonPage.waitForSelector('.share-canvas-title', { state: 'visible', timeout: 15000 });
        await anonPage.waitForFunction(() => document.querySelectorAll('.share-node').length >= 5, { timeout: 8000 });
        await anonPage.waitForFunction(() => {
            const imgs = Array.from(document.querySelectorAll('.share-node img'));
            return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
        }, { timeout: 8000 });
        const rendered = await anonPage.evaluate(() => ({
            title: document.querySelector('.share-canvas-title').textContent,
            owner: document.querySelector('#shareOwner').textContent,
            nodes: document.querySelectorAll('.share-node').length,
            links: document.querySelectorAll('.share-links path').length,
            toolbar: document.querySelectorAll('#createMenu, .canvas-toolbar, .image-node').length,
            cloneHidden: document.querySelector('#shareCloneBtn').hidden
        }));
        check('b4 correct password renders read-only canvas', rendered.title === '公开分享验收画布' && rendered.nodes >= 5 && rendered.links === 2 && rendered.owner === ADMIN_USER && rendered.toolbar === 0, rendered);
        check('b5 clone button visible (authenticated + allow_clone)', rendered.cloneHidden === false, rendered);
        await anonPage.mouse.move(900, 760);
        await anonPage.waitForTimeout(500);
        results.shots.canvas = path.join(OUT_DIR, 'share-live-canvas.png');
        await anonPage.screenshot({ path: results.shots.canvas });

        // 后端自动把登录用户加为 viewer
        const perms = await (await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId) + '/permissions')).json();
        check('b6 backend added visitor as viewer member', perms.members.some((member) => member.username === viewerName && member.role === 'viewer'), perms.members);

        // 克隆 → 新画布
        await anonPage.click('#shareCloneBtn');
        await anonPage.waitForURL((url) => /\/static\/smart-canvas\.html\?id=/.test(url.toString()), { timeout: 20000 });
        await anonPage.waitForSelector('.image-node', { state: 'visible', timeout: 25000 });
        await anonPage.waitForTimeout(900);
        const clonedId = new URL(anonPage.url()).searchParams.get('id');
        results.clonedCanvasId = clonedId;
        results.shots.clone = path.join(OUT_DIR, 'share-live-clone.png');
        await anonPage.screenshot({ path: results.shots.clone });
        const clonedDoc = await (await viewerApi.get('/api/canvases/' + encodeURIComponent(clonedId))).json();
        const sourceDoc = await (await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId))).json();
        const nodeSignature = (nodes) => (nodes || []).map((node) => ({
            id: node.id, type: node.type, x: node.x, y: node.y,
            w: node.w, h: node.h, text: node.text, title: node.title
        }));
        check('c1 clone creates new canvas owned by visitor', clonedDoc.canvas && clonedDoc.canvas.title.indexOf('的副本') !== -1, clonedDoc.canvas && clonedDoc.canvas.title);
        check('c2 cloned content matches source',
            JSON.stringify(nodeSignature(clonedDoc.canvas.nodes)) === JSON.stringify(nodeSignature(sourceDoc.canvas.nodes)),
            { cloned: clonedDoc.canvas.nodes.length, source: sourceDoc.canvas.nodes.length });
        await anonContext.close();

        // 撤销 → 链接无效
        const revoked = await adminApi.delete('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link');
        check('d1 revoke link 200', revoked.status() === 200, revoked.status());
        await viewerPage.goto(BASE + '/c/' + shareLink.token, { waitUntil: 'domcontentloaded' });
        await viewerPage.waitForSelector('#shareMessage', { state: 'visible', timeout: 10000 });
        check('d2 revoked link shows invalid state', /链接无效或已被关闭/.test(await viewerPage.textContent('#shareMessageTitle')), await viewerPage.textContent('#shareMessageTitle'));

        // 重新创建 + 改成已过期 → 410
        const recreated = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link', { data: { expires_in_days: 7, password: null, allow_clone: false, role: 'viewer' } });
        const recreatedLink = (await recreated.json()).link;
        const expireScript = 'import sqlite3,sys; c=sqlite3.connect(' + JSON.stringify(path.join(DATA_DIR, 'data', 'users.db')) + '); c.execute("UPDATE canvas_share_links SET expires_at=1 WHERE token=?", (sys.argv[1],)); c.commit()';
        const { spawnSync } = require('child_process');
        const expired = spawnSync(path.join(__dirname, '..', 'venv', 'bin', 'python'), ['-c', expireScript, recreatedLink.token], { encoding: 'utf8' });
        if (expired.status !== 0) throw new Error('设置过期时间失败：' + expired.stderr);
        await viewerPage.goto(BASE + '/c/' + recreatedLink.token, { waitUntil: 'domcontentloaded' });
        await viewerPage.waitForSelector('#shareMessage', { state: 'visible', timeout: 10000 });
        check('d3 expired link shows expired state', (await viewerPage.textContent('#shareMessageTitle')) === '链接已过期', await viewerPage.textContent('#shareMessageTitle'));

        check('f1 no page errors', results.pageErrors.length === 0, results.pageErrors);
        results.summary = { failed: failed };
        fs.writeFileSync(path.join(OUT_DIR, 'share-link-live-report.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ summary: results.summary, shots: results.shots }, null, 2));
        await browser.close();
        await adminApi.dispose();
        await viewerApi.dispose();
        process.exit(failed ? 1 : 0);
    } catch (error) {
        console.error('[share-live] 失败：', error);
        results.error = String(error && error.stack || error);
        results.summary = { failed: failed + 1 };
        try { fs.writeFileSync(path.join(OUT_DIR, 'share-link-live-report.json'), JSON.stringify(results, null, 2)); } catch (e) {}
        await browser.close().catch(() => {});
        process.exit(2);
    }
})().catch((error) => {
    console.error('[share-live] 启动失败：', error);
    process.exit(2);
});
