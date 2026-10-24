#!/usr/bin/env node
/*
 * 公开链接分享（前端）Playwright 验收：画布页分享弹窗 + /c/{token} 只读分享页。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/share_links_e2e.cjs
 *
 * 后端接口尚未就绪，所有 /api/canvases/{id}/share-link 与 /api/share/** 都用 page.route 模拟，
 * 契约见 share-view.js 头注释。登录、权限、成员、画布读写走真实后端（默认 8898，auth-on）。
 * 截图落到 tests/artifacts/share-links/。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'admin12345';
const OUT_DIR = path.join(__dirname, 'artifacts', 'share-links');
const SHARE_HTML = fs.readFileSync(path.join(__dirname, '..', 'static', 'share.html'), 'utf8');

const NODES = [
    { id: 'simg', type: 'smart-image', x: 120, y: 120, title: 'Image', scale: 2, images: [{ url: '/static/images/logo.png', name: 'logo.png', kind: 'image', natural_w: 512, natural_h: 512 }] },
    { id: 'slabel', type: 'smart-label', x: 560, y: 130, w: 160, h: 38, text: '公开分享', labelStyle: 'solid', labelColor: '#4E79A7', labelFontSize: 13, labelDot: true },
    { id: 'stext', type: 'smart-text', x: 120, y: 520, w: 316, h: 194, text: '这是一张只读分享的画布。' },
    { id: 'sprompt', type: 'smart-prompt', x: 560, y: 380, w: 316, h: 180, text: '一张用于展示公开分享页的示意图' },
    { id: 'sgroup', type: 'smart-group', x: 960, y: 120, w: 340, h: 286, title: '示例分组', items: [] }
];
const CONNECTIONS = [
    { from: 'simg', to: 'sprompt', kind: 'flow' },
    { from: 'slabel', to: 'stext', kind: 'flow' }
];

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
    const password = 'share-pass-123';

    const adminApi = await request.newContext({ baseURL: BASE });
    const adminLogin = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (adminLogin.status() !== 200) throw new Error('管理员登录失败：' + adminLogin.status());

    async function createUser(username) {
        const inviteResponse = await adminApi.post('/api/admin/invites', { data: {} });
        if (inviteResponse.status() !== 200) throw new Error('邀请码创建失败：' + inviteResponse.status());
        const invite = (await inviteResponse.json()).invite.code;
        const api = await request.newContext({ baseURL: BASE });
        const register = await api.post('/api/auth/register', { data: { username: username, password: password, invite_code: invite } });
        if (register.status() !== 200) throw new Error('注册失败 ' + username + '：' + register.status());
        await api.dispose();
    }
    const memberName = 'share_a_' + stamp;
    const inviteeName = 'share_b_' + stamp;
    await createUser(memberName);
    await createUser(inviteeName);

    async function createCanvas(title) {
        const created = await adminApi.post('/api/canvases', { data: { title: title, kind: 'smart' } });
        if (created.status() !== 200) throw new Error('画布创建失败：' + created.status());
        const canvasId = (await created.json()).canvas.id;
        const put = await adminApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
            data: {
                title: title, icon: 'sparkles', nodes: NODES, connections: CONNECTIONS,
                viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'share-e2e'
            }
        });
        if (put.status() !== 200) throw new Error('画布初始化失败：' + put.status());
        return canvasId;
    }

    const canvasId = await createCanvas('分享链接验收画布');
    const cloneTargetId = await createCanvas('分享链接克隆目标');
    const shared = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', { data: { username: memberName, role: 'viewer' } });
    if (shared.status() !== 200) throw new Error('成员分享失败：' + shared.status());
    const canvasResponse = await adminApi.get('/api/canvases/' + encodeURIComponent(canvasId));
    const canvasDoc = (await canvasResponse.json()).canvas;
    results.canvasId = canvasId;

    const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});

    // ---- 画布页分享弹窗的 mock：GET/POST share-link ----
    const shareToken = 'tok_' + stamp;
    const shareState = { link: null, payloads: [] };
    function fulfillJSON(route, status, body) {
        return route.fulfill({ status: status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
    }
    async function routeShareLink(route) {
        const req = route.request();
        if (req.method() === 'GET') return fulfillJSON(route, 200, { link: shareState.link });
        if (req.method() !== 'POST') return fulfillJSON(route, 405, { detail: 'method not allowed' });
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
        shareState.payloads.push(body);
        const previous = shareState.link || {};
        const hasPassword = Object.prototype.hasOwnProperty.call(body, 'password')
            ? Boolean(body.password)
            : Boolean(previous.has_password);
        shareState.link = {
            token: previous.token || shareToken,
            url: previous.url || ('/c/' + shareToken),
            role: body.role || 'viewer',
            expires_in_days: body.expires_in_days === undefined ? 7 : body.expires_in_days,
            expires_at: 1793366400,
            has_password: hasPassword,
            allow_clone: Boolean(body.allow_clone),
            created_at: previous.created_at || 1792773000
        };
        return fulfillJSON(route, 200, { link: shareState.link });
    }

    async function openCanvasSession(username, userPassword, options) {
        const opts = options || {};
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
        const sessionLogin = await context.request.post(BASE + '/api/auth/login', { data: { username: username, password: userPassword || password } });
        if (sessionLogin.status() !== 200) throw new Error('登录失败 ' + username + '：' + sessionLogin.status());
        await context.route('**/api/canvases/*/share-link', opts.readonlyShareLink
            ? (route) => fulfillJSON(route, 403, { detail: '只有所有者或管理员可以管理分享链接' })
            : routeShareLink);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await page.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });
        await page.waitForTimeout(400);
        results.pageErrors.push(...errors);
        return { context, page, errors };
    }

    // ---- 公开分享页的 mock ----
    function publicPayload(overrides) {
        return Object.assign({
            canvas: canvasDoc,
            title: canvasDoc.title,
            owner_username: ADMIN_USER,
            allow_clone: false,
            role: 'viewer',
            authenticated: true,
            can_clone: true
        }, overrides || {});
    }

    async function openSharePage(token, options) {
        const opts = options || {};
        const context = await browser.newContext({
            viewport: { width: 1600, height: 1000 },
            deviceScaleFactor: 1,
            colorScheme: opts.colorScheme || 'dark'
        });
        let requirePassword = Boolean(opts.passwordRequired);
        let unlocked = false;
        let cloned = null;
        const apiState = { authRequired: Boolean(opts.authRequired), getCalls: 0, unlockCalls: [] };
        await context.route('**/api/share/**', async (route) => {
            const req = route.request();
            const pathname = new URL(req.url()).pathname;
            const match = /^\/api\/share\/([^/]+)(\/unlock|\/clone)?$/.exec(pathname);
            if (!match) return fulfillJSON(route, 404, { detail: 'not found' });
            const action = match[2] || '';
            if (action === '/unlock') {
                let body = {};
                try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
                apiState.unlockCalls.push(body);
                if (body.password === 'secret123') {
                    unlocked = true;
                    requirePassword = false;
                    return fulfillJSON(route, 200, { ok: true });
                }
                return fulfillJSON(route, 403, { code: 'BAD_PASSWORD', detail: '密码不正确' });
            }
            if (action === '/clone') {
                if (!publicPayload(opts.payload).allow_clone) return fulfillJSON(route, 403, { code: 'CLONE_NOT_ALLOWED' });
                cloned = cloneTargetId;
                return fulfillJSON(route, 201, { canvas_id: cloneTargetId });
            }
            apiState.getCalls += 1;
            if (opts.expired) return fulfillJSON(route, 410, { code: 'EXPIRED' });
            if (opts.notFound) return fulfillJSON(route, 404, { code: 'NOT_FOUND' });
            if (apiState.authRequired) {
                const cookie = req.headers()['cookie'] || '';
                if (!/novai_session=/.test(cookie)) return fulfillJSON(route, 401, { code: 'AUTH_REQUIRED' });
                apiState.authRequired = false;
            }
            if (requirePassword && !unlocked) return fulfillJSON(route, 401, { code: 'PASSWORD_REQUIRED' });
            return fulfillJSON(route, 200, publicPayload(opts.payload));
        });
        await context.route('**/c/**', (route) => {
            const pathname = new URL(route.request().url()).pathname;
            if (!pathname.startsWith('/c/')) return route.continue();
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SHARE_HTML });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => {
            errors.push(String(error));
            results.pageErrors.push('share-page: ' + String(error));
        });
        if (opts.authenticated !== false) {
            const login = await context.request.post(BASE + '/api/auth/login', { data: { username: opts.username || ADMIN_USER, password: opts.userPassword || ADMIN_PASS } });
            if (login.status() !== 200) throw new Error('分享页登录失败：' + login.status());
        }
        return { context, page, errors, apiState, getCloned: () => cloned };
    }

    let owner = null;
    let member = null;
    const contexts = [];
    try {
        owner = await openCanvasSession(ADMIN_USER, ADMIN_PASS);
        contexts.push(owner.context);

        // a) 打开分享弹窗：自动创建链接 + 结构 + 尺寸
        await owner.page.click('#collab-share-btn');
        await owner.page.waitForSelector('.share-modal', { state: 'visible', timeout: 8000 });
        await owner.page.waitForFunction(() => {
            const input = document.querySelector('.share-link-input');
            return input && input.value.indexOf('/c/') !== -1;
        }, { timeout: 8000 });
        await owner.page.waitForTimeout(250);
        const modal = await owner.page.evaluate(() => {
            const el = document.querySelector('.share-modal');
            const rect = el.getBoundingClientRect();
            return {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                right: rect.right, bottom: rect.bottom,
                vw: window.innerWidth, vh: window.innerHeight,
                title: document.querySelector('#share-modal-title').textContent,
                sub: document.querySelector('.share-modal-sub').textContent,
                link: document.querySelector('.share-link-input').value,
                note: document.querySelector('.share-modal-note').textContent,
                selects: document.querySelectorAll('.share-modal select').length,
                expiry: document.querySelector('.share-expiry-label').textContent,
                inviteVisible: !document.querySelector('#share-invite').hidden,
                count: document.querySelector('#share-member-count').textContent,
                permissionDisabled: document.querySelector('.share-select.is-readonly').disabled
            };
        });
        results.metrics = { modal };
        const linkPayload = shareState.payloads[0] || {};
        check('a1 share button opens centered modal', await owner.page.evaluate(() => window.NOVAI_COLLAB.shareModalOpen));
        check('a2 modal width 520-560 and inside viewport', modal.width >= 520 && modal.width <= 560
            && modal.x >= 0 && modal.y >= 0 && modal.right <= modal.vw && modal.bottom <= modal.vh, modal);
        check('a3 title uses canvas name', modal.title.indexOf('分享「分享链接验收画布」') === 0, modal.title);
        check('a4 subtitle mentions login', modal.sub === '持有链接并登录后可以加入画布。创建者可随时修改权限或关闭链接。', modal.sub);
        check('a5 auto POST default config', shareState.payloads.length === 1 && linkPayload.expires_in_days === 7 && linkPayload.password === null && linkPayload.allow_clone === false && linkPayload.role === 'viewer', shareState.payloads);
        check('a6 link row shows public url', /\/c\/tok_/.test(modal.link), modal.link);
        check('a7 two dropdowns, permission disabled, no native select', modal.selects === 0 && modal.permissionDisabled === true && modal.expiry === '7 天有效');
        check('a8 footer note exact', modal.note === '仅创建者可修改权限、移除成员和删除画布。当前画布上限 10 人。', modal.note);
        check('a9 owner sees invite row + member count', modal.inviteVisible && /成员 2 \/ 10/.test(modal.count), modal.count);
        check('a10 modal focused on open', await owner.page.evaluate(() => document.activeElement && document.activeElement.classList.contains('share-modal')));

        // 复制链接
        await owner.page.click('[data-action="share-copy"]');
        await owner.page.waitForFunction(() => Array.from(document.querySelectorAll('.collab-toast')).some((el) => /链接已复制/.test(el.textContent)), { timeout: 4000 });
        const clipboard = await owner.page.evaluate(() => navigator.clipboard.readText());
        check('a11 copy button copies absolute link + toast', clipboard === BASE + '/c/' + shareToken, clipboard);

        // 有效期：自绘菜单 → 30 天
        await owner.page.click('.share-expiry-btn');
        await owner.page.waitForSelector('.share-expiry-menu', { state: 'visible', timeout: 3000 });
        const optionCount = await owner.page.locator('.share-expiry-option').count();
        await owner.page.click('.share-expiry-option[data-days="30"]');
        await owner.page.waitForFunction(() => document.querySelector('.share-expiry-label').textContent === '30 天有效', { timeout: 4000 });
        check('a12 custom expiry menu has 4 options', optionCount === 4, optionCount);
        check('a13 change expiry POSTs 30 days', shareState.payloads.some((body) => body.expires_in_days === 30) && shareState.link.expires_in_days === 30, shareState.payloads);
        check('a14 expiry label updated', (await owner.page.textContent('.share-expiry-label')) === '30 天有效');

        // 允许克隆
        await owner.page.click('.share-clone-switch');
        await owner.page.waitForFunction(() => document.querySelector('.share-clone-switch').getAttribute('aria-checked') === 'true', { timeout: 4000 });
        check('a15 allow clone POSTs true', shareState.payloads.some((body) => body.allow_clone === true), shareState.payloads);

        // 密码：打开输入 → 失焦提交
        await owner.page.click('.share-password-switch');
        await owner.page.waitForSelector('.share-password-input', { state: 'visible', timeout: 3000 });
        await owner.page.fill('.share-password-input', 'secret123');
        await owner.page.click('.share-modal-heading h2');
        await owner.page.waitForFunction(() => document.querySelector('.share-password-switch').getAttribute('aria-checked') === 'true' && document.querySelector('.share-password-switch').disabled === false, { timeout: 5000 });
        check('a16 password blur POSTs password', shareState.payloads.some((body) => body.password === 'secret123') && shareState.link.has_password === true, shareState.payloads);

        // 开关打开时不要立刻弹「请输入访问密码」；密码框同样无边框
        await owner.page.click('.share-password-switch');
        await owner.page.waitForFunction(() => document.querySelector('.share-password-row').hidden === true, { timeout: 5000 });
        await owner.page.click('.share-password-switch');
        await owner.page.waitForFunction(() => document.querySelector('.share-password-row').hidden === false, { timeout: 5000 });
        await owner.page.waitForTimeout(700);
        const passwordOpenState = await owner.page.evaluate(() => {
            const input = document.querySelector('.share-password-input');
            const style = getComputedStyle(input);
            return {
                toast: Array.from(document.querySelectorAll('.collab-toast')).some((el) => /请输入访问密码/.test(el.textContent)),
                border: style.borderTopWidth + ' ' + style.borderRightWidth + ' ' + style.borderBottomWidth + ' ' + style.borderLeftWidth,
                outline: style.outlineStyle + ' ' + style.outlineWidth,
                shadow: style.boxShadow
            };
        });
        check('a16b opening password switch does not toast and input stays borderless',
            passwordOpenState.toast === false && passwordOpenState.border === '0px 0px 0px 0px'
            && passwordOpenState.outline.indexOf('none') === 0 && passwordOpenState.shadow === 'none', passwordOpenState);
        await owner.page.fill('.share-password-input', 'secret123');
        await owner.page.click('.share-modal-heading h2');
        await owner.page.waitForFunction(() => document.querySelector('.share-password-switch').getAttribute('aria-checked') === 'true', { timeout: 5000 });

        // 关闭重开：配置还在
        await owner.page.keyboard.press('Escape');
        await owner.page.waitForSelector('.share-modal', { state: 'hidden', timeout: 3000 });
        check('a17 Escape closes modal', !(await owner.page.evaluate(() => window.NOVAI_COLLAB.shareModalOpen)));
        await owner.page.click('#collab-share-btn');
        await owner.page.waitForSelector('.share-modal', { state: 'visible', timeout: 5000 });
        await owner.page.waitForFunction(() => /30 天有效/.test(document.querySelector('.share-expiry-label').textContent), { timeout: 5000 });
        const reopened = await owner.page.evaluate(() => ({
            expiry: document.querySelector('.share-expiry-label').textContent,
            clone: document.querySelector('.share-clone-switch').getAttribute('aria-checked'),
            password: document.querySelector('.share-password-switch').getAttribute('aria-checked')
        }));
        check('a18 reopened modal keeps config', reopened.expiry === '30 天有效' && reopened.clone === 'true' && reopened.password === 'true', reopened);

        // 邀请成员：Enter 提交 + 成员计数刷新
        const memberWait = owner.page.waitForResponse((response) => /\/api\/canvases\/[^/]+\/members$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 8000 });
        await owner.page.fill('.share-invite-input', inviteeName);
        await owner.page.press('.share-invite-input', 'Enter');
        const memberResponse = await memberWait;
        await owner.page.waitForFunction(() => /成员 3 \/ 10/.test(document.querySelector('#share-member-count').textContent), { timeout: 5000 });
        check('a19 invite POST 200 + count refresh', memberResponse.status() === 200 && (await owner.page.textContent('#share-member-count')) === '成员 3 / 10', memberResponse.status());

        // 明/暗截图
        await owner.page.mouse.move(900, 760);
        await owner.page.focus('.share-invite-input');
        await owner.page.waitForTimeout(2800); // 等 toast 散场，截图只留弹窗
        const inputStyles = await owner.page.evaluate(() => {
            const readEl = (el) => {
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return {
                    border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
                    outline: style.outlineStyle + ' ' + style.outlineWidth,
                    shadow: style.boxShadow,
                    radius: style.borderRadius,
                    height: Math.round(rect.height),
                    background: style.backgroundColor,
                    chevron: getComputedStyle(el, '::after').content,
                    focused: document.activeElement === el
                };
            };
            const read = (selector) => readEl(document.querySelector(selector));
            const overlay = getComputedStyle(document.querySelector('.share-overlay'));
            return {
                link: read('.share-link-input'),
                password: read('.share-password-input'),
                invite: read('.share-invite-input'),
                selects: Array.from(document.querySelectorAll('.share-select')).map(readEl),
                passwordVisible: !document.querySelector('.share-password-row').hidden,
                overlay: {
                    backdrop: overlay.backdropFilter || overlay.webkitBackdropFilter || '',
                    background: overlay.backgroundColor
                }
            };
        });
        const fields = [inputStyles.link, inputStyles.password, inputStyles.invite, ...inputStyles.selects];
        const noBorders = fields.every((item) => item.border.every((width) => width === '0px'));
        const noOutline = fields.every((item) => item.outline.indexOf('none') === 0);
        const noShadow = fields.every((item) => item.shadow === 'none');
        const radiusOk = fields.every((item) => item.radius === '8px');
        const heightOk = fields.every((item) => item.height >= 32 && item.height <= 36);
        const selectsHaveChevron = inputStyles.selects.every((item) => item.chevron && item.chevron !== 'none');
        check('a20 all modal inputs + dropdowns are borderless / outline-free / shadow-free',
            noBorders && noOutline && noShadow && radiusOk && heightOk && inputStyles.selects.length === 2 && selectsHaveChevron, inputStyles);
        check('a21 focused invite input only deepens background',
            inputStyles.invite.focused && inputStyles.invite.background !== inputStyles.link.background
            && inputStyles.passwordVisible, { focusBg: inputStyles.invite.background, restBg: inputStyles.link.background, passwordVisible: inputStyles.passwordVisible });
        const alphaMatch = /rgba?\(([^)]+)\)/.exec(inputStyles.overlay.background);
        const overlayAlpha = alphaMatch ? Number(alphaMatch[1].split(',')[3]) : 0;
        check('a22 overlay adds blur 20px + saturate 140% and 35-45% scrim',
            /blur\(20px\)/.test(inputStyles.overlay.backdrop) && /saturate\((1\.4|140%)\)/.test(inputStyles.overlay.backdrop)
            && overlayAlpha >= 0.35 && overlayAlpha <= 0.45, inputStyles.overlay);
        // 有效期下拉聚焦：只加深底色，不出描边
        await owner.page.focus('.share-expiry-btn');
        await owner.page.waitForTimeout(180);
        const selectFocus = await owner.page.evaluate(() => {
            const el = document.querySelector('.share-expiry-btn');
            const style = getComputedStyle(el);
            return {
                background: style.backgroundColor,
                border: style.borderTopWidth,
                outline: style.outlineStyle + ' ' + style.outlineWidth,
                shadow: style.boxShadow,
                focused: document.activeElement === el
            };
        });
        check('a24 expiry dropdown focus only deepens background', selectFocus.focused
            && selectFocus.background !== inputStyles.selects[1].background
            && selectFocus.border === '0px' && selectFocus.outline.indexOf('none') === 0 && selectFocus.shadow === 'none', selectFocus);
        await owner.page.focus('.share-invite-input');
        await owner.page.waitForTimeout(150);
        results.shots.modalLight = path.join(OUT_DIR, 'share-modal-light.png');
        await owner.page.screenshot({ path: results.shots.modalLight });
        await owner.page.evaluate(() => window.StudioTheme && window.StudioTheme.set('dark'));
        await owner.page.waitForTimeout(500);
        results.shots.modalDark = path.join(OUT_DIR, 'share-modal-dark.png');
        await owner.page.screenshot({ path: results.shots.modalDark });
        const darkOverlay = await owner.page.evaluate(() => {
            const style = getComputedStyle(document.querySelector('.share-overlay'));
            return { backdrop: style.backdropFilter || style.webkitBackdropFilter || '', background: style.backgroundColor };
        });
        const darkAlphaMatch = /rgba?\(([^)]+)\)/.exec(darkOverlay.background);
        const darkAlpha = darkAlphaMatch ? Number(darkAlphaMatch[1].split(',')[3]) : 0;
        check('a23 dark overlay keeps blur + 35-45% scrim',
            /blur\(20px\)/.test(darkOverlay.backdrop) && darkAlpha >= 0.35 && darkAlpha <= 0.45, { ...darkOverlay, alpha: darkAlpha });
        await owner.page.evaluate(() => window.StudioTheme && window.StudioTheme.set('light'));
        await owner.page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
        await owner.page.keyboard.press('Escape');

        // e) 非 owner：链接/开关只读，邀请隐藏，复制可用
        member = await openCanvasSession(memberName, undefined, { readonlyShareLink: true });
        contexts.push(member.context);
        await member.page.click('#collab-share-btn');
        await member.page.waitForSelector('.share-modal', { state: 'visible', timeout: 5000 });
        await member.page.waitForFunction(() => document.querySelector('.share-link-hint') && document.querySelector('.share-link-hint').textContent.length > 0, { timeout: 8000 });
        const readonly = await member.page.evaluate(() => ({
            invite: document.querySelector('#share-invite').hidden,
            expiryDisabled: document.querySelector('.share-expiry-btn').disabled,
            passwordDisabled: document.querySelector('.share-password-switch').disabled,
            cloneDisabled: document.querySelector('.share-clone-switch').disabled,
            copyDisabled: document.querySelector('[data-action="share-copy"]').disabled,
            closeText: document.querySelector('[data-action="share-close"]').textContent,
            linkValue: document.querySelector('.share-link-input').value,
            hint: (document.querySelector('.share-link-hint') || {}).textContent || ''
        }));
        /* 后端 GET /share-link 只允许 owner/admin（tests/test_share_links.py 明确 403），
           所以非 owner 前端只能只读展示、复制按钮禁用；这是与「可复制」需求的后端冲突。 */
        check('e1 non-owner controls readonly + invite hidden', readonly.invite && readonly.expiryDisabled && readonly.passwordDisabled && readonly.cloneDisabled, readonly);
        check('e2 non-owner gets clear readonly hint (link hidden by backend)', readonly.copyDisabled && /仅创建者或管理员/.test(readonly.hint), readonly);
        results.deviation = '后端 GET /api/canvases/{id}/share-link 对非 owner/admin 返回 403（tests/test_share_links.py:167），'
            + '非 owner 无法复制链接；前端按只读降级并提示，待后端放开成员 GET 后复制会自动可用。';
        await member.context.close();
        contexts.splice(contexts.indexOf(member.context), 1);

        // b/f) 公开页：未登录 → 登录页 next，登录后回到分享页
        const anon = await openSharePage(shareToken, { authenticated: false, authRequired: true, colorScheme: 'dark' });
        contexts.push(anon.context);
        await anon.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
        await anon.page.waitForURL((url) => /\/login\?next=/.test(url.toString()), { timeout: 10000 });
        const redirectUrl = new URL(anon.page.url());
        check('b1 logged-out share link redirects to login with next', decodeURIComponent(redirectUrl.searchParams.get('next') || '') === '/c/' + shareToken, anon.page.url());
        await anon.page.waitForSelector('#username', { state: 'visible', timeout: 10000 });
        await anon.page.fill('#username', ADMIN_USER);
        await anon.page.fill('#password', ADMIN_PASS);
        await anon.page.click('#submit');
        await anon.page.waitForURL((url) => new URL(url.toString()).pathname === '/c/' + shareToken, { timeout: 20000 });
        await anon.page.waitForSelector('.share-canvas-title', { state: 'visible', timeout: 20000 });
        await anon.page.waitForFunction(() => document.querySelectorAll('.share-node').length >= 5, { timeout: 8000 });
        check('b2 after login returns to share page and renders canvas', (await anon.page.textContent('.share-canvas-title')) === canvasDoc.title);
        await anon.context.close();
        contexts.splice(contexts.indexOf(anon.context), 1);

        // c/f) 登录用户公开页：只读渲染 + 明暗截图 + 克隆按钮隐藏
        for (const scheme of ['light', 'dark']) {
            const view = await openSharePage(shareToken, { colorScheme: scheme, payload: { allow_clone: false } });
            contexts.push(view.context);
            await view.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
            await view.page.waitForSelector('.share-canvas-title', { state: 'visible', timeout: 20000 });
            await view.page.waitForFunction(() => document.querySelectorAll('.share-node').length >= 5, { timeout: 8000 });
            await view.page.waitForFunction(() => {
                const imgs = Array.from(document.querySelectorAll('.share-node img'));
                return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
            }, { timeout: 8000 });
            const viewState = await view.page.evaluate(() => ({
                title: document.querySelector('.share-canvas-title').textContent,
                owner: document.querySelector('#shareOwner').textContent,
                footer: document.querySelector('#shareFoot').textContent.trim(),
                nodes: document.querySelectorAll('.share-node').length,
                links: document.querySelectorAll('.share-links path').length,
                cloneHidden: document.querySelector('#shareCloneBtn').hidden,
                toolbar: document.querySelectorAll('#createMenu, .canvas-toolbar, .image-node').length,
                stage: Boolean(document.querySelector('#shareStage'))
            }));
            check('c1 ' + scheme + ' share page renders read-only canvas', viewState.title === canvasDoc.title && viewState.nodes >= 5 && viewState.links === 2 && viewState.footer.indexOf('只读') !== -1, viewState);
            check('c2 ' + scheme + ' no editing toolbar/generate buttons', viewState.toolbar === 0);
            check('c3 ' + scheme + ' clone hidden when not allowed', viewState.cloneHidden === true);
            results.metrics['background_' + scheme] = await view.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
            if (scheme === 'light') results.shots.publicLight = path.join(OUT_DIR, 'share-public-light.png');
            else results.shots.publicDark = path.join(OUT_DIR, 'share-public-dark.png');
            await view.page.screenshot({ path: scheme === 'light' ? results.shots.publicLight : results.shots.publicDark });
            if (scheme === 'light') {
                // 滚轮缩放 / 拖拽平移 / 双击适配内容
                const transform0 = await view.page.evaluate(() => document.getElementById('shareWorld').style.transform);
                await view.page.mouse.move(800, 500);
                await view.page.mouse.wheel(0, -320);
                await view.page.waitForTimeout(220);
                const transformZoom = await view.page.evaluate(() => document.getElementById('shareWorld').style.transform);
                check('c4 wheel zooms share canvas', transformZoom !== transform0, { transform0, transformZoom });
                await view.page.mouse.move(760, 580);
                await view.page.mouse.down();
                await view.page.mouse.move(880, 660, { steps: 8 });
                await view.page.mouse.up();
                const transformPan = await view.page.evaluate(() => document.getElementById('shareWorld').style.transform);
                check('c5 drag pans share canvas', transformPan !== transformZoom, { transformZoom, transformPan });
                await view.page.mouse.dblclick(800, 520);
                await view.page.waitForTimeout(160);
                const transformFit = await view.page.evaluate(() => document.getElementById('shareWorld').style.transform);
                check('c6 dblclick fits content', transformFit !== transformPan, { transformPan, transformFit });
            }
            await view.context.close();
            contexts.splice(contexts.indexOf(view.context), 1);
        }
        check('c7 share page follows system light/dark', Boolean(results.metrics.background_light) && Boolean(results.metrics.background_dark)
            && results.metrics.background_light !== results.metrics.background_dark, results.metrics);

        // c) 密码：错密码提示 → 对密码进入
        const passwordGate = await openSharePage(shareToken, { colorScheme: 'dark', passwordRequired: true });
        contexts.push(passwordGate.context);
        await passwordGate.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
        await passwordGate.page.waitForSelector('#shareGate', { state: 'visible', timeout: 10000 });
        results.shots.password = path.join(OUT_DIR, 'share-password.png');
        await passwordGate.page.screenshot({ path: results.shots.password });
        check('d1 password gate shows', (await passwordGate.page.textContent('#shareGateTitle')) === '此画布需要密码');
        await passwordGate.page.fill('#sharePasswordInput', 'wrong-pass');
        await passwordGate.page.click('#sharePasswordForm button');
        await passwordGate.page.waitForSelector('#shareGateError', { state: 'visible', timeout: 5000 });
        check('d2 wrong password shows error', /密码不正确/.test(await passwordGate.page.textContent('#shareGateError')));
        await passwordGate.page.fill('#sharePasswordInput', 'secret123');
        await passwordGate.page.click('#sharePasswordForm button');
        await passwordGate.page.waitForSelector('.share-canvas-title', { state: 'visible', timeout: 10000 });
        await passwordGate.page.waitForTimeout(200);
        const unlockedTitle = await passwordGate.page.textContent('.share-canvas-title');
        check('d3 correct password renders canvas', unlockedTitle === canvasDoc.title, { unlockedTitle, expected: canvasDoc.title });
        await passwordGate.context.close();
        contexts.splice(contexts.indexOf(passwordGate.context), 1);
        check('d4 unlock called twice', passwordGate.apiState.unlockCalls.length === 2);

        // 过期 / 无效状态
        const expired = await openSharePage(shareToken, { colorScheme: 'dark', expired: true });
        contexts.push(expired.context);
        await expired.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
        await expired.page.waitForSelector('#shareMessage', { state: 'visible', timeout: 8000 });
        check('d5 expired state', (await expired.page.textContent('#shareMessageTitle')) === '链接已过期');
        await expired.context.close();
        contexts.splice(contexts.indexOf(expired.context), 1);

        const invalid = await openSharePage(shareToken, { colorScheme: 'dark', notFound: true });
        contexts.push(invalid.context);
        await invalid.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
        await invalid.page.waitForSelector('#shareMessage', { state: 'visible', timeout: 8000 });
        check('d6 invalid state', /链接无效或已被关闭/.test(await invalid.page.textContent('#shareMessageTitle')));
        await invalid.context.close();
        contexts.splice(contexts.indexOf(invalid.context), 1);

        // c/f) 克隆：登录 + allow_clone → 新画布
        const cloner = await openSharePage(shareToken, { colorScheme: 'light', payload: { allow_clone: true } });
        contexts.push(cloner.context);
        await cloner.page.goto(BASE + '/c/' + shareToken, { waitUntil: 'domcontentloaded' });
        await cloner.page.waitForSelector('#shareCloneBtn', { state: 'visible', timeout: 10000 });
        check('c4 clone button visible when authenticated + allow_clone', await cloner.page.isVisible('#shareCloneBtn'));
        await cloner.page.click('#shareCloneBtn');
        await cloner.page.waitForURL((url) => /\/static\/smart-canvas\.html\?id=/.test(url.toString()), { timeout: 15000 });
        await cloner.page.waitForSelector('.image-node', { state: 'visible', timeout: 20000 });
        await cloner.page.waitForTimeout(800);
        results.shots.clone = path.join(OUT_DIR, 'share-clone-result.png');
        await cloner.page.screenshot({ path: results.shots.clone });
        const clonedUrl = new URL(cloner.page.url());
        check('c5 clone POST 201 navigates to new canvas', clonedUrl.searchParams.get('id') === cloneTargetId, clonedUrl.search);
        check('c6 cloned canvas renders nodes', (await cloner.page.locator('.image-node').count()) >= 5, await cloner.page.locator('.image-node').count());
        await cloner.context.close();
        contexts.splice(contexts.indexOf(cloner.context), 1);

        // d) 遮罩点击关闭
        await owner.page.click('#collab-share-btn');
        await owner.page.waitForSelector('.share-modal', { state: 'visible', timeout: 5000 });
        await owner.page.mouse.click(40, 40);
        await owner.page.waitForSelector('.share-modal', { state: 'hidden', timeout: 3000 });
        check('f1 overlay click closes modal', !(await owner.page.evaluate(() => window.NOVAI_COLLAB.shareModalOpen)));

        check('g1 no page errors', results.pageErrors.length === 0, results.pageErrors);
        results.summary = { failed: failed };
        fs.writeFileSync(path.join(OUT_DIR, 'share-link-report.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ summary: results.summary, shots: results.shots }, null, 2));
        await browser.close();
        await adminApi.dispose();
        process.exit(failed ? 1 : 0);
    } catch (error) {
        console.error('[share-link-e2e] 失败：', error);
        results.error = String(error && error.stack || error);
        results.summary = { failed: failed + 1 };
        try { fs.writeFileSync(path.join(OUT_DIR, 'share-link-report.json'), JSON.stringify(results, null, 2)); } catch (e) {}
        await browser.close().catch(() => {});
        process.exit(2);
    }
})().catch((error) => {
    console.error('[share-link-e2e] 启动失败：', error);
    process.exit(2);
});
