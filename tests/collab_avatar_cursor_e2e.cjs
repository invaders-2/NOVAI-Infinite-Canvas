#!/usr/bin/env node
/*
 * 协作光标统色 + 自定义头像验收（8899，真实后端）
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/collab_avatar_cursor_e2e.cjs
 *
 * 两个账号上传不同头像 + 一个无头像账号，同开一张画布：
 *   - 所有远程光标箭头/名字标签同一个颜色（--info 蓝）；
 *   - 头像簇 / 成员面板 / 光标标签显示各自 /api/auth/avatar/... 头像；
 *   - 无头像账号回退首字；图片 404 时回退首字不裂图。
 * 截图：tests/artifacts/collab-ui/01-cursors-same-color.png、02-member-avatars.png
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8899';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'admin12345';
const OUT_DIR = path.join(__dirname, 'artifacts', 'collab-ui');
const AVATAR_A = path.join(__dirname, '..', 'static', 'images', 'logo.png');
const AVATAR_B = path.join(__dirname, '..', 'static', 'images', 'brands', 'xiaohongshu.png');
const NODES = [
    { id: 'av_img', type: 'smart-image', x: 240, y: 240, title: 'Image', scale: 2, images: [{ url: '/static/images/logo.png', name: 'logo.png', kind: 'image', natural_w: 512, natural_h: 512 }] },
    { id: 'av_text', type: 'smart-text', x: 640, y: 420, w: 300, h: 170, text: '协作头像验收画布' }
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
    const password = 'avatar-pass-123';
    const names = {
        a: 'anna_' + stamp,
        b: 'bella_' + stamp,
        c: 'cara_' + stamp
    };

    const adminApi = await request.newContext({ baseURL: BASE });
    const adminLogin = await adminApi.post('/api/auth/login', { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (adminLogin.status() !== 200) throw new Error('管理员登录失败：' + adminLogin.status());

    async function createUser(username) {
        const invite = (await (await adminApi.post('/api/admin/invites', { data: {} })).json()).invite.code;
        const api = await request.newContext({ baseURL: BASE });
        const register = await api.post('/api/auth/register', { data: { username: username, password: password, invite_code: invite } });
        if (register.status() !== 200) throw new Error('注册失败 ' + username + '：' + register.status());
        return api;
    }
    const apis = { a: await createUser(names.a), b: await createUser(names.b), c: await createUser(names.c) };

    async function uploadAvatar(api, filePath) {
        const response = await api.post(BASE + '/api/auth/avatar', {
            multipart: { file: { name: path.basename(filePath), mimeType: 'image/png', buffer: fs.readFileSync(filePath) } }
        });
        if (response.status() !== 200) throw new Error('头像上传失败：' + response.status());
        return (await response.json()).avatar_url;
    }
    const avatarA = await uploadAvatar(apis.a, AVATAR_A);
    const avatarB = await uploadAvatar(apis.b, AVATAR_B);
    check('a1 two accounts upload different avatars', /\/api\/auth\/avatar\//.test(avatarA) && /\/api\/auth\/avatar\//.test(avatarB) && avatarA !== avatarB, { avatarA, avatarB });

    const created = await adminApi.post('/api/canvases', { data: { title: '协作头像验收画布', kind: 'smart' } });
    const canvasId = (await created.json()).canvas.id;
    const put = await adminApi.put('/api/canvases/' + encodeURIComponent(canvasId), {
        data: { title: '协作头像验收画布', icon: 'sparkles', nodes: NODES, connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, base_updated_at: 0, client_id: 'avatar-e2e' }
    });
    if (put.status() !== 200) throw new Error('画布初始化失败：' + put.status());
    for (const username of [names.a, names.b, names.c]) {
        const shared = await adminApi.post('/api/canvases/' + encodeURIComponent(canvasId) + '/members', { data: { username: username, role: 'viewer' } });
        if (shared.status() !== 200) throw new Error('成员分享失败：' + shared.status());
    }

    const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
    async function openSession(api, username) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        await context.addCookies(await api.storageState().then((state) => state.cookies));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
        await page.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });
        await page.waitForTimeout(300);
        results.pageErrors.push(...errors.map((message) => username + ': ' + message));
        return { context, page, errors };
    }

    const ownerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await ownerContext.addCookies(await adminApi.storageState().then((state) => state.cookies));
    const ownerPage = await ownerContext.newPage();
    ownerPage.on('pageerror', (error) => results.pageErrors.push('owner: ' + String(error)));
    await ownerPage.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
    await ownerPage.waitForSelector('#collab-hud', { state: 'visible', timeout: 20000 });
    await ownerPage.waitForFunction(() => window.NOVAI_COLLAB && window.NOVAI_COLLAB.status === 'online', { timeout: 20000 });

    const sessions = [];
    const contexts = [ownerContext];
    try {
        for (const key of ['a', 'b', 'c']) {
            const session = await openSession(apis[key], names[key]);
            sessions.push(session);
            contexts.push(session.context);
        }
        await ownerPage.waitForFunction(() => window.NOVAI_COLLAB.users.length === 4, { timeout: 15000 });
        const presence = await ownerPage.evaluate(() => window.NOVAI_COLLAB.users.map((user) => ({
            name: user.username, avatar: user.avatar_url || '', color: user.color
        })));
        check('a2 presence carries avatar_url for avatar accounts', presence.some((user) => user.name === names.a && /\/api\/auth\/avatar\//.test(user.avatar))
            && presence.some((user) => user.name === names.b && /\/api\/auth\/avatar\//.test(user.avatar)), presence);
        check('a3 account without avatar has empty avatar_url', presence.some((user) => user.name === names.c && !user.avatar), presence);

        // 三个远端光标各就位
        const positions = [[720, 520], [1080, 640], [520, 760]];
        for (let index = 0; index < sessions.length; index += 1) {
            await sessions[index].page.mouse.move(positions[index][0] - 20, positions[index][1] - 20);
            await sessions[index].page.mouse.move(positions[index][0], positions[index][1], { steps: 8 });
        }
        await ownerPage.waitForFunction(() => document.querySelectorAll('.collab-remote-cursor').length === 3, { timeout: 8000 });
        await ownerPage.waitForTimeout(400);

        const cursors = await ownerPage.evaluate(() => Array.from(document.querySelectorAll('.collab-remote-cursor')).map((el) => {
            const nameBox = el.querySelector('.collab-cursor-name');
            const avatar = el.querySelector('.collab-cursor-avatar');
            const img = avatar && avatar.querySelector('img');
            return {
                userId: el.dataset.userId,
                color: getComputedStyle(el).color,
                arrowFill: getComputedStyle(el.querySelector('svg path')).fill,
                nameBg: nameBox ? getComputedStyle(nameBox).backgroundColor : '',
                nameText: nameBox ? nameBox.textContent.trim() : '',
                avatarSrc: img ? img.getAttribute('src') : '',
                avatarInitial: avatar ? (avatar.querySelector('.collab-avatar-initial') || {}).textContent || '' : ''
            };
        }));
        results.cursors = cursors;
        const colors = Array.from(new Set(cursors.map((cursor) => cursor.color)));
        const nameColors = Array.from(new Set(cursors.map((cursor) => cursor.nameBg)));
        check('b1 all remote cursor arrows share one color', colors.length === 1 && colors[0] === 'rgb(10, 132, 255)', colors);
        check('b2 cursor name labels share the same color', nameColors.length === 1 && nameColors[0] === 'rgb(10, 132, 255)', nameColors);
        check('b3 cursor label arrows use currentColor', cursors.every((cursor) => cursor.arrowFill === cursor.color), cursors);
        const avatarCursor = cursors.find((cursor) => cursor.nameText.includes(names.a));
        const plainCursor = cursors.find((cursor) => cursor.nameText.includes(names.c));
        check('b4 cursor labels show avatar + username', avatarCursor && /\/api\/auth\/avatar\//.test(avatarCursor.avatarSrc) && avatarCursor.nameText.includes(names.a), avatarCursor);
        check('b5 account without avatar falls back to initial in cursor label', plainCursor && !plainCursor.avatarSrc && plainCursor.avatarInitial.trim() === names.c.slice(0, 1).toUpperCase(), plainCursor);

        // 头像簇 + 成员面板头像
        const cluster = await ownerPage.evaluate(() => Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
            name: el.dataset.name || '',
            hasImage: el.classList.contains('has-image'),
            src: el.querySelector('img') ? el.querySelector('img').getAttribute('src') : '',
            initial: (el.querySelector('.collab-avatar-initial') || {}).textContent || ''
        })));
        const clusterA = cluster.find((item) => item.name === names.a);
        const clusterB = cluster.find((item) => item.name === names.b);
        const clusterC = cluster.find((item) => item.name === names.c);
        check('c1 avatar cluster shows custom avatars', clusterA && clusterA.hasImage && /\/api\/auth\/avatar\//.test(clusterA.src)
            && clusterB && clusterB.hasImage, { clusterA, clusterB });
        check('c2 avatar cluster falls back to initial without avatar', clusterC && !clusterC.hasImage && clusterC.initial.trim() === names.c.slice(0, 1).toUpperCase(), clusterC);

        await ownerPage.click('#collab-avatars');
        await ownerPage.waitForSelector('.collab-panel', { state: 'visible', timeout: 5000 });
        await ownerPage.waitForFunction(() => document.querySelectorAll('.collab-member').length === 4, { timeout: 8000 });
        const rows = await ownerPage.evaluate(() => Array.from(document.querySelectorAll('.collab-member')).map((el) => ({
            name: (el.querySelector('.collab-member-name span') || {}).textContent || '',
            hasImage: el.querySelector('.collab-member-avatar').classList.contains('has-image'),
            src: el.querySelector('.collab-member-avatar img') ? el.querySelector('.collab-member-avatar img').getAttribute('src') : '',
            initial: (el.querySelector('.collab-member-avatar .collab-avatar-initial') || {}).textContent || ''
        })));
        const rowA = rows.find((row) => row.name === names.a);
        const rowC = rows.find((row) => row.name === names.c);
        check('c3 member rows show avatar images', rowA && rowA.hasImage && /\/api\/auth\/avatar\//.test(rowA.src), rows);
        check('c4 member rows fall back to initial', rowC && !rowC.hasImage && rowC.initial.trim() === names.c.slice(0, 1).toUpperCase(), rowC);

        // 截图 1：三个光标同色 + 标签头像（把面板关掉）
        await ownerPage.click('.collab-panel-close');
        await ownerPage.mouse.move(1200, 760);
        await ownerPage.waitForTimeout(3200); // 等「加入协作」toast 散场
        results.shots.cursors = path.join(OUT_DIR, '01-cursors-same-color.png');
        await ownerPage.screenshot({ path: results.shots.cursors });

        // 截图 2：头像簇 + 成员面板头像
        await ownerPage.click('#collab-avatars');
        await ownerPage.waitForSelector('.collab-panel', { state: 'visible', timeout: 3000 });
        await ownerPage.waitForTimeout(900);
        results.shots.avatars = path.join(OUT_DIR, '02-member-avatars.png');
        await ownerPage.screenshot({ path: results.shots.avatars });

        // 破图回退（截图后再做）：把 A 的簇头像改成不存在的地址，img 应被移除、首字露出
        await ownerPage.evaluate((targetName) => {
            const avatar = Array.from(document.querySelectorAll('.collab-avatar')).find((el) => el.dataset.name === targetName);
            if (!avatar) return;
            const image = avatar.querySelector('img');
            if (image) image.src = '/api/auth/avatar/999999?broken=1';
        }, names.a).catch(() => {});
        await ownerPage.waitForTimeout(600);
        const brokenFallback = await ownerPage.evaluate((targetName) => {
            const avatar = Array.from(document.querySelectorAll('.collab-avatar')).find((el) => el.dataset.name === targetName);
            if (!avatar) return null;
            const initialEl = avatar.querySelector('.collab-avatar-initial');
            return {
                hasImg: Boolean(avatar.querySelector('img')),
                initial: ((initialEl && initialEl.textContent) || avatar.textContent || '').trim()
            };
        }, names.a);
        check('c5 broken avatar image falls back to initial', brokenFallback && !brokenFallback.hasImg && brokenFallback.initial === names.a.slice(0, 1).toUpperCase(), brokenFallback);

        check('d1 no page errors', results.pageErrors.length === 0, results.pageErrors);
        results.summary = { failed: failed };
        fs.writeFileSync(path.join(OUT_DIR, 'collab-avatar-report.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ summary: results.summary, shots: results.shots, cursors }, null, 2));
        await browser.close();
        await adminApi.dispose();
        for (const api of Object.values(apis)) await api.dispose();
        process.exit(failed ? 1 : 0);
    } catch (error) {
        console.error('[avatar-e2e] 失败：', error);
        results.error = String((error && error.stack) || error);
        results.summary = { failed: failed + 1 };
        try { fs.writeFileSync(path.join(OUT_DIR, 'collab-avatar-report.json'), JSON.stringify(results, null, 2)); } catch (e) {}
        await browser.close().catch(() => {});
        process.exit(2);
    }
})().catch((error) => {
    console.error('[avatar-e2e] 启动失败：', error);
    process.exit(2);
});
