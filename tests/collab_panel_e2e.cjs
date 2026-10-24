#!/usr/bin/env node
/*
 * 协作面板（紧凑 popover）Playwright 验收（1600×1000，auth-on）
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/collab_panel_e2e.cjs
 *
 * 前置：auth-on 后端跑在 $NOVAI_BASE（默认 8898，数据目录干净，管理员 admin/admin12345）。
 * 自建用户 / 画布 / 分享关系，重复执行不撞名；截图落到 tests/artifacts/collab-ui/。
 *
 * 覆盖：头像簇与分享按钮开关面板、弹层尺寸/位置（≤70vh、360–400 宽、视口内）、
 * 成员行/在线点/角色显示、owner 改角色 PATCH 200、移除 DELETE 200、邀请 POST 200 且被邀请者能开画布、
 * 非 owner 角色/移除只读、Esc/点外部关闭、resize 重算、成员多时列表内滚动。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'admin12345';
const OUT_DIR = path.join(__dirname, 'artifacts', 'collab-ui');
const REPORT = path.join(OUT_DIR, 'collab-panel-report.json');
const NODES = [
    { id: 'p_a', type: 'smart-label', x: 240, y: 260, w: 150, h: 40, text: '协作面板验收 A', labelStyle: 'solid', labelColor: '#4E79A7', labelFontSize: 13, labelDot: true, labelIcon: '', images: [] },
    { id: 'p_b', type: 'smart-label', x: 640, y: 380, w: 150, h: 40, text: '协作面板验收 B', labelStyle: 'solid', labelColor: '#76B7B2', labelFontSize: 13, labelDot: true, labelIcon: '', images: [] }
];

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
        (() => { try { return chromium.executablePath(); } catch (e) { return ''; } })(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = Date.now().toString(36);
    const password = 'panel-pass-123';
    const memberName = 'panel_a_' + stamp;
    const inviteeName = 'panel_b_' + stamp;
    const extraNames = Array.from({ length: 8 }, (_, index) => 'panel_x' + index + '_' + stamp);

    const adminApi = await request.newContext({ baseURL: BASE });
    const login = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (login.status() !== 200) throw new Error('管理员登录失败：' + login.status());

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
    for (const username of [memberName, inviteeName, ...extraNames]) await createUser(username);

    const created = await adminApi.post('/api/canvases', { data: { title: '协作面板验收画布', kind: 'smart' } });
    if (created.status() !== 200) throw new Error('画布创建失败：' + created.status());
    const canvasId = (await created.json()).canvas.id;
    const put = await adminApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
        data: {
            title: '协作面板验收画布', icon: 'sparkles', nodes: NODES, connections: [],
            viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'collab-panel'
        }
    });
    if (put.status() !== 200) throw new Error('画布初始化失败：' + put.status());
    const shared = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
        data: { username: memberName, role: 'viewer' }
    });
    if (shared.status() !== 200) throw new Error('初始成员分享失败：' + shared.status());
    results.canvasId = canvasId;

    const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});

    async function openSession(username, userPassword) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        const sessionLogin = await context.request.post(BASE + '/api/auth/login', {
            data: { username: username, password: userPassword || password }
        });
        if (sessionLogin.status() !== 200) throw new Error('登录失败 ' + username + '：' + sessionLogin.status());
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

    const panelBox = (page) => page.evaluate(() => {
        const panel = document.querySelector('.collab-panel');
        if (!panel) return null;
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const list = panel.querySelector('.collab-panel-members');
        return {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            right: rect.right, bottom: rect.bottom,
            vw: window.innerWidth, vh: window.innerHeight,
            maxHeight: style.maxHeight,
            listScroll: list ? list.scrollHeight : 0,
            listClient: list ? list.clientHeight : 0,
            roleCount: panel.querySelectorAll('.collab-role-btn').length,
            removeCount: panel.querySelectorAll('.collab-member-remove').length,
            inviteHidden: panel.querySelector('.collab-panel-invite').hidden,
            header: panel.querySelector('.collab-panel-online').textContent.trim(),
            title: panel.querySelector('#collab-panel-title').textContent.trim(),
            note: panel.querySelector('.collab-panel-note').textContent.trim()
        };
    });
    const rowsOf = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.collab-member')).map((el) => ({
        uid: el.dataset.uid,
        role: el.dataset.role,
        name: el.querySelector('.collab-member-name span').textContent,
        you: Boolean(el.querySelector('.collab-member-you')),
        online: el.querySelector('.collab-member-dot').dataset.online,
        roleText: (el.querySelector('.collab-role-text') || {}).textContent || '',
        activeRole: (el.querySelector('.collab-role-btn.is-active') || {}).dataset ? el.querySelector('.collab-role-btn.is-active').dataset.role : '',
        remove: el.querySelectorAll('.collab-member-remove').length
    })));

    let owner = null;
    const extraPages = [];
    try {
        owner = await openSession(ADMIN_USER, ADMIN_PASS);
        const member = await openSession(memberName);
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 8000 });

        // a) 头像簇打开面板 + 尺寸/位置/结构
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 5000 });
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 2, { timeout: 5000 });
        await owner.page.waitForTimeout(250);
        const box = await panelBox(owner.page);
        results.metrics.firstOpen = box;
        check('a1 avatar cluster opens panel', Boolean(box) && await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen));
        check('a2 panel width within 360-400px', box && box.width >= 360 && box.width <= 400, box && box.width);
        check('a3 panel height within 70vh and 520px', box && box.height <= Math.round(box.vh * 0.7) && box.height <= 520, box && { height: box.height, limit: Math.round(box.vh * 0.7) });
        check('a4 panel fully inside viewport', box && box.x >= 0 && box.y >= 0 && box.right <= box.vw && box.bottom <= box.vh, box && { x: box.x, y: box.y, right: box.right, bottom: box.bottom, vw: box.vw, vh: box.vh });
        check('a5 panel anchored below HUD', box && box.y >= 52, box && box.y);
        check('a6 header title/online count/note', box && box.title === '协作' && box.header === '2 人在线' && box.note === '仅创建者可修改角色与移除成员；每张画布上限 10 人。', box && { title: box.title, header: box.header, note: box.note });
        const clusterA11y = await owner.page.evaluate(() => {
            const el = document.getElementById('collab-avatars');
            return {
                cursor: getComputedStyle(el).cursor,
                role: el.getAttribute('role'),
                tabindex: el.getAttribute('tabindex'),
                expanded: el.getAttribute('aria-expanded'),
                haspopup: el.getAttribute('aria-haspopup'),
                label: el.getAttribute('aria-label')
            };
        });
        check('a7 avatar cluster is clickable button with aria state',
            clusterA11y.cursor === 'pointer' && clusterA11y.role === 'button' && clusterA11y.tabindex === '0'
            && clusterA11y.expanded === 'true' && clusterA11y.haspopup === 'dialog' && /\d+ 人在线/.test(clusterA11y.label),
            clusterA11y);
        // 点开面板后鼠标仍停在头像上：面板打开期间头像 tooltip 必须隐藏，否则会顶到视口上沿被裁
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-toast').length === 0, { timeout: 6000 }).catch(() => {});
        const hoverTooltip = await owner.page.evaluate(() => {
            const avatar = document.querySelector('.collab-avatar');
            const hud = document.getElementById('collab-hud');
            const after = getComputedStyle(avatar, '::after');
            return { hudOpen: hud.classList.contains('is-panel-open'), opacity: after.opacity, visibility: after.visibility };
        });
        check('a8 open panel hides avatar tooltip while still hovered',
            hoverTooltip.hudOpen && hoverTooltip.opacity === '0' && hoverTooltip.visibility === 'hidden', hoverTooltip);
        results.shots.tooltip = path.join(OUT_DIR, 'collab-panel-08-avatar-hover-no-tooltip.png');
        await owner.page.screenshot({ path: results.shots.tooltip });

        // b) 成员行：头像/姓名/你/在线点/角色/移除
        const rows = await rowsOf(owner.page);
        const selfRow = rows.find((row) => row.you);
        const memberRow = rows.find((row) => row.name === memberName);
        check('b1 self row marked 你 + creator role', selfRow && selfRow.name === ADMIN_USER && selfRow.roleText === '创建者' && selfRow.role === 'owner' && selfRow.remove === 0, selfRow);
        check('b2 member row online dot + viewer seg + remove', memberRow && memberRow.online === '1' && memberRow.activeRole === 'viewer' && memberRow.remove === 1 && !memberRow.you, memberRow);
        check('b3 editor segment offered for member', rows.filter((row) => row.role !== 'owner').every((row) => row.activeRole), rows);

        // c) 头像簇开关成员面板；再点/点外部/Esc 关闭（分享按钮现在开的是分享弹窗）
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });
        check('c1 clicking avatar cluster closes panel', !(await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen)));
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        check('c2 clicking avatar cluster opens panel', await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen));
        await owner.page.mouse.click(700, 640);
        await owner.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });
        check('c3 outside click closes panel', !(await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen)));
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        await owner.page.keyboard.press('Escape');
        await owner.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });
        check('c4 Escape closes panel', !(await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen)));
        await owner.page.focus('#collab-avatars');
        await owner.page.keyboard.press('Enter');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        check('c5 keyboard Enter on avatar cluster opens panel', await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen));
        await owner.page.keyboard.press('Escape');
        await owner.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });
        // 关闭状态：tooltip 落在头像下方，靠近视口顶部也不会被裁掉
        await owner.page.hover('.collab-avatar');
        await owner.page.waitForTimeout(260);
        const closedTip = await owner.page.evaluate(() => {
            const avatar = document.querySelector('.collab-avatar');
            const after = getComputedStyle(avatar, '::after');
            return {
                top: after.top, opacity: after.opacity, visibility: after.visibility,
                avatarHeight: avatar.getBoundingClientRect().height
            };
        });
        // 绝对定位的 bottom:auto 会被浏览器解析成负值，只看 top 是否落在头像底边之下
        check('c7 avatar tooltip sits below avatar when panel closed',
            closedTip.visibility === 'visible' && closedTip.opacity === '1' && parseFloat(closedTip.top) >= closedTip.avatarHeight,
            closedTip);
        const hudTooltips = await owner.page.evaluate(() => {
            const share = document.getElementById('collab-share-btn');
            const status = document.getElementById('collab-status');
            return {
                shareCss: getComputedStyle(share, '::after').content,
                statusCss: getComputedStyle(status, '::after').content,
                shareTitle: share.title,
                statusTitle: status.title
            };
        });
        check('c8 share/status tooltips are native title only (cannot be CSS-clipped)',
            hudTooltips.shareCss === 'none' && hudTooltips.statusCss === 'none'
            && Boolean(hudTooltips.shareTitle) && Boolean(hudTooltips.statusTitle), hudTooltips);
        await owner.page.mouse.move(900, 760);

        // d) owner 改角色 → PATCH 200 + UI 更新
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 2, { timeout: 5000 });
        const patchWait = owner.page.waitForResponse((response) => /\/members\/\d+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PATCH', { timeout: 8000 });
        await owner.page.click('.collab-member[data-role="viewer"] .collab-role-btn[data-role="editor"]');
        const patchResponse = await patchWait;
        await owner.page.waitForFunction(() => document.querySelector('.collab-member[data-role="editor"] .collab-role-btn.is-active[data-role="editor"]') !== null, { timeout: 5000 });
        const patchBody = await patchResponse.json();
        check('d1 role change => PATCH 200', patchResponse.status() === 200, patchResponse.status());
        check('d2 role change refreshes row to editor', patchBody.permissions.members.some((item) => item.username === memberName && item.role === 'editor'), patchBody.permissions);

        // e) 移除成员 → DELETE 200 + 列表刷新
        const removeWait = owner.page.waitForResponse((response) => /\/members\/\d+$/.test(new URL(response.url()).pathname) && response.request().method() === 'DELETE', { timeout: 8000 });
        await owner.page.click('.collab-member[data-role="editor"] .collab-member-remove');
        const removeResponse = await removeWait;
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 1, { timeout: 5000 });
        const rowsAfterRemove = await rowsOf(owner.page);
        check('e1 remove member => DELETE 200', removeResponse.status() === 200, removeResponse.status());
        check('e2 member disappears from list', rowsAfterRemove.length === 1 && rowsAfterRemove[0].role === 'owner', rowsAfterRemove);
        await member.context.close();

        // f) 邀请新用户 → POST 200 + 列表刷新 + 被邀请者能打开画布
        const postWait = owner.page.waitForResponse((response) => /\/api\/canvases\/[^/]+\/members$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 8000 });
        await owner.page.fill('.collab-invite-input', inviteeName);
        await owner.page.press('.collab-invite-input', 'Enter');
        const postResponse = await postWait;
        await owner.page.waitForFunction((name) => Array.from(document.querySelectorAll('.collab-member')).some((el) => el.textContent.includes(name)), inviteeName, { timeout: 5000 });
        const rowsAfterInvite = await rowsOf(owner.page);
        const inviteeRow = rowsAfterInvite.find((row) => row.name === inviteeName);
        check('f1 invite => POST 200', postResponse.status() === 200, postResponse.status());
        check('f2 invited member appears as viewer', inviteeRow && inviteeRow.role === 'viewer' && inviteeRow.activeRole === 'viewer', inviteeRow);
        check('f3 invite input cleared after submit', (await owner.page.inputValue('.collab-invite-input')) === '');

        const invitee = await openSession(inviteeName);
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 8000 });
        const inviteeState = await invitee.page.evaluate(() => ({
            role: window.NOVAI_COLLAB.role,
            readonly: window.SmartCanvasCollab.isReadOnly(),
            online: window.NOVAI_COLLAB.status
        }));
        check('f4 invited member can open canvas', inviteeState.role === 'viewer' && inviteeState.online === 'online', inviteeState);

        // g) 非 owner：角色/移除只读
        await invitee.page.click('#collab-avatars');
        await invitee.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 5000 });
        await invitee.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 2, { timeout: 5000 });
        const inviteeBox = await panelBox(invitee.page);
        const inviteeRows = await rowsOf(invitee.page);
        const inviteeSelf = inviteeRows.find((row) => row.you);
        check('g1 non-owner has no role segments / remove buttons', inviteeBox && inviteeBox.roleCount === 0 && inviteeBox.removeCount === 0, inviteeBox && { roleCount: inviteeBox.roleCount, removeCount: inviteeBox.removeCount });
        check('g2 non-owner sees invite hidden', inviteeBox && inviteeBox.inviteHidden === true, inviteeBox && inviteeBox.inviteHidden);
        check('g3 non-owner sees readonly role text', inviteeSelf && inviteeSelf.roleText === '仅查看' && inviteeRows.find((row) => row.role === 'owner').roleText === '创建者', inviteeRows);
        await invitee.page.mouse.move(900, 760); // 挪开鼠标，别让头像 tooltip 进截图
        await invitee.page.waitForTimeout(2800); // 等「加入协作」toast 散场
        await invitee.page.screenshot({ path: path.join(OUT_DIR, 'collab-panel-04-readonly.png') });
        results.shots.readonly = path.join(OUT_DIR, 'collab-panel-04-readonly.png');
        await invitee.page.click('.collab-panel-close');
        await invitee.page.waitForSelector('.collab-panel', { state: 'hidden', timeout: 3000 });

        // h) 浅色 / 暗色截图
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB.users.length === 2, { timeout: 8000 });
        if (!(await owner.page.evaluate(() => window.NOVAI_COLLAB.panelOpen))) {
            await owner.page.click('#collab-avatars');
        }
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        await owner.page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
        await owner.page.mouse.move(900, 760);
        await owner.page.waitForTimeout(3000); // 等操作 toast 散场，截图只保留面板本身
        results.shots.light = path.join(OUT_DIR, 'collab-panel-01-light.png');
        await owner.page.screenshot({ path: results.shots.light });
        await owner.page.evaluate(() => window.StudioTheme && window.StudioTheme.set('dark'));
        await owner.page.waitForTimeout(600);
        results.shots.dark = path.join(OUT_DIR, 'collab-panel-02-dark.png');
        await owner.page.screenshot({ path: results.shots.dark });
        const darkBox = await panelBox(owner.page);
        const darkColors = await owner.page.evaluate(() => {
            const panel = document.querySelector('.collab-panel');
            return {
                panelBg: getComputedStyle(panel).backgroundColor,
                text: getComputedStyle(document.querySelector('.collab-member-name')).color,
                pageBg: getComputedStyle(document.body).backgroundColor
            };
        });
        check('h1 dark theme panel uses elevated surface', darkBox && darkColors.panelBg !== darkColors.pageBg, darkColors);
        await owner.page.evaluate(() => window.StudioTheme && window.StudioTheme.set('light'));
        await owner.page.waitForTimeout(300);
        await owner.page.keyboard.press('Escape');

        // i) 成员多时列表内滚动（10 人 = 创建者 + 9 成员）
        for (const username of extraNames) {
            const add = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
                data: { username: username, role: 'viewer' }
            });
            if (add.status() !== 200) throw new Error('批量分享失败 ' + username + '：' + add.status());
        }
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 10, { timeout: 8000 });
        await owner.page.waitForTimeout(350);
        const scrollBox = await panelBox(owner.page);
        results.metrics.manyMembers = scrollBox;
        check('i1 ten members listed', (await rowsOf(owner.page)).length === 10);
        check('i2 panel stays <=70vh with many members', scrollBox && scrollBox.height <= Math.round(scrollBox.vh * 0.7), scrollBox && { height: scrollBox.height, vh: scrollBox.vh });
        check('i3 member list scrolls inside panel', scrollBox && scrollBox.listScroll > scrollBox.listClient, scrollBox && { scroll: scrollBox.listScroll, client: scrollBox.listClient });
        const scrollRows = await rowsOf(owner.page);
        check('i4 online dots come from presence (invitee online, extras offline)',
            scrollRows.find((row) => row.name === inviteeName).online === '1'
            && scrollRows.filter((row) => /^panel_x/.test(row.name)).every((row) => row.online === '0'), scrollRows);
        await owner.page.mouse.move(900, 760);
        await owner.page.waitForTimeout(300);
        await owner.page.screenshot({ path: path.join(OUT_DIR, 'collab-panel-03-scroll.png') });
        results.shots.scroll = path.join(OUT_DIR, 'collab-panel-03-scroll.png');

        // j) resize 后面板仍在视口内
        await owner.page.setViewportSize({ width: 1200, height: 820 });
        await owner.page.waitForTimeout(350);
        const resized = await panelBox(owner.page);
        check('j1 resized viewport keeps panel inside', resized && resized.x >= 0 && resized.right <= resized.vw && resized.bottom <= resized.vh, resized);
        await owner.page.setViewportSize({ width: 1600, height: 1000 });
        await owner.page.waitForTimeout(250);

        // l) 只有自己时的空状态
        const solo = await adminApi.post('/api/canvases', { data: { title: '协作面板单人画布', kind: 'smart' } });
        const soloId = (await solo.json()).canvas.id;
        await owner.page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(soloId), { waitUntil: 'domcontentloaded' });
        await owner.page.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await owner.page.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });
        await owner.page.click('#collab-avatars');
        await owner.page.waitForSelector('.collab-panel', { state: 'visible', timeout: 5000 });
        await owner.page.waitForFunction(() => document.querySelectorAll('.collab-member').length === 1, { timeout: 5000 });
        const emptyHint = await owner.page.textContent('.collab-panel-empty').catch(() => '');
        const soloRows = await rowsOf(owner.page);
        check('l1 solo canvas shows invite hint', /目前只有你在画布上，邀请成员一起协作/.test(emptyHint) && soloRows.length === 1 && soloRows[0].you === true, { emptyHint, soloRows });
        await owner.page.mouse.move(900, 760);
        await owner.page.waitForTimeout(300);
        await owner.page.screenshot({ path: path.join(OUT_DIR, 'collab-panel-05-solo.png') });
        results.shots.solo = path.join(OUT_DIR, 'collab-panel-05-solo.png');

        check('k1 no page errors across both contexts', results.pageErrors.length === 0, results.pageErrors);
        await invitee.context.close();
        await owner.context.close();
        results.summary = { failed: failed };
        fs.writeFileSync(REPORT, JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ summary: results.summary, shots: results.shots, metrics: results.metrics }, null, 2));
        await browser.close();
        await adminApi.dispose();
        process.exit(failed ? 1 : 0);
    } catch (error) {
        console.error('[collab-panel-e2e] 失败：', error);
        results.error = String(error && error.stack || error);
        results.summary = { failed: failed + 1 };
        try { fs.writeFileSync(REPORT, JSON.stringify(results, null, 2)); } catch (e) {}
        await browser.close().catch(() => {});
        process.exit(2);
    }
})().catch((error) => {
    console.error('[collab-panel-e2e] 启动失败：', error);
    process.exit(2);
});
