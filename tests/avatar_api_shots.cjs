#!/usr/bin/env node
/*
 * 头像 + API 设置权限验收（1600×1000，auth-on）。
 *   成员：账户页换头像 → 保存 → 刷新仍在；V2 侧栏、画布左轨显示；设置页没有 API 设置 tab，强制跳转回退。
 *   管理员：/admin 列表头像、给成员换头像；V2 设置里有 API 设置；侧栏显示自己的头像。
 * 前置：NOVAI_BASE（默认 8897）用新后端 + demo 数据目录跑着；/tmp/avatar-*.png 已生成。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8897';
const ADMIN = { username: 'admin', password: 'admin12345' };
const MEMBER = { username: process.env.NOVAI_MEMBER || 'avatar_demo2', password: 'avatar-demo-123' };
const OUT = path.join(__dirname, 'artifacts', 'avatar-api');

async function login(page, account) {
    await page.goto(BASE + '/login?next=' + encodeURIComponent('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', account.username);
    await page.fill('#password', account.password);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
    const welcome = page.locator('.wel .nv-btn.primary');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForSelector('.wel', { state: 'detached', timeout: 10000 });
    }
    await page.waitForSelector('.nav-item', { state: 'visible', timeout: 30000 });
}

async function openSettings(page) {
    await page.hover('.sidebar');
    await page.waitForTimeout(380);
    await page.click('.sidebar .settings-toggle');
    await page.waitForSelector('.smodal', { timeout: 15000 });
    await page.waitForTimeout(350);
}

async function tabLabels(page) {
    return (await page.locator('.smodal .tab').allTextContents()).map((s) => s.trim());
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        chromium.executablePath(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ].filter(Boolean);
    const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const result = { base: BASE, checks: {}, screenshots: {}, page_errors: [] };

    const memberCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const adminCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

    const memberPage = await memberCtx.newPage();
    const adminPage = await adminCtx.newPage();
    memberPage.on('pageerror', (e) => result.page_errors.push('member: ' + String(e)));
    adminPage.on('pageerror', (e) => result.page_errors.push('admin: ' + String(e)));

    // ---------- 成员：账户页上传头像 ----------
    await login(memberPage, MEMBER);
    const me = await (await memberCtx.request.get(BASE + '/api/auth/me')).json();
    result.checks.member = { id: me.id, username: me.username, role: me.role };
    // 让用例可重复：先清掉这个成员已有的头像
    await memberCtx.request.delete(BASE + '/api/auth/avatar');
    await memberPage.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await memberPage.waitForSelector('#avatar', { state: 'visible' });
    await memberPage.waitForTimeout(600);
    result.checks.member_before = await memberPage.evaluate(() => ({
        has_img: !!document.querySelector('#avatar img'),
        text: (document.querySelector('#avatar').textContent || '').trim(),
        remove_hidden: document.querySelector('#avatar-remove').hidden,
    }));

    const [memberChooser] = await Promise.all([
        memberPage.waitForEvent('filechooser'),
        memberPage.click('#avatar-pick'),
    ]);
    await memberChooser.setFiles('/tmp/avatar-a.png');
    await memberPage.waitForSelector('#avatar-save:not([hidden])', { timeout: 10000 });
    result.checks.member_preview = await memberPage.evaluate(() => ({
        has_img: !!document.querySelector('#avatar img'),
        src_blob: (document.querySelector('#avatar img') || {}).src || '',
    }));
    await memberPage.click('#avatar-save');
    await memberPage.waitForFunction(() => {
        const box = document.getElementById('toast');
        return box && box.getAttribute('data-show') === 'true' && /头像已更新/.test(box.textContent);
    }, { timeout: 20000 });
    await memberPage.waitForFunction(() => {
        const img = document.querySelector('#avatar img');
        return img && /\/api\/auth\/avatar\//.test(img.getAttribute('src') || '');
    }, { timeout: 20000 });
    result.checks.member_saved_src = await memberPage.getAttribute('#avatar img', 'src');
    result.screenshots.member_account = path.join(OUT, '31-member-account-avatar.png');
    await memberPage.screenshot({ path: result.screenshots.member_account });

    await memberPage.reload({ waitUntil: 'domcontentloaded' });
    await memberPage.waitForSelector('#avatar', { state: 'visible' });
    await memberPage.waitForTimeout(800);
    result.checks.member_after_reload = await memberPage.evaluate(() => ({
        has_img: !!document.querySelector('#avatar img'),
        src: (document.querySelector('#avatar img') || {}).getAttribute ? document.querySelector('#avatar img').getAttribute('src') : '',
        remove_hidden: document.querySelector('#avatar-remove').hidden,
    }));

    // ---------- 成员：V2 侧栏头像 + 设置页没有 API 设置 ----------
    await memberPage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await memberPage.waitForSelector('.acct-avatar img', { timeout: 20000 });
    result.checks.member_sidebar_src = await memberPage.getAttribute('.acct-avatar img', 'src');
    await memberPage.screenshot({ path: path.join(OUT, '32-member-sidebar.png') });

    await openSettings(memberPage);
    result.checks.member_tabs = await tabLabels(memberPage);
    result.checks.member_has_api_tab = result.checks.member_tabs.includes('API 设置');
    result.screenshots.member_settings = path.join(OUT, '33-member-settings.png');
    await memberPage.screenshot({ path: result.screenshots.member_settings });
    // 强制 navigate 到 api-settings（画布齿轮走的就是这条路），应回退到「通用」
    await memberPage.evaluate(() => window.postMessage({ type: 'navigate', route: 'api-settings' }, location.origin));
    await memberPage.waitForTimeout(700);
    result.checks.member_forced_tab = await memberPage.evaluate(() => ({
        active: (document.querySelector('.smodal .tab.is-on') || {}).textContent ? document.querySelector('.smodal .tab.is-on').textContent.trim() : '',
        tabs: [...document.querySelectorAll('.smodal .tab')].map((el) => el.textContent.trim()),
        has_api_panel: !!document.querySelector('.smodal .c-frame') || /API 设置/.test((document.querySelector('.smodal .c-head') || {}).textContent || ''),
    }));
    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(300);

    // ---------- 成员：画布左轨账户头像 ----------
    let canvasId = process.env.NOVAI_CANVAS_ID || '';
    if (!canvasId) {
        try {
            const made = await (await memberCtx.request.post(BASE + '/api/canvases', { data: { title: '头像验收画布', project: 'default' } })).json();
            canvasId = made.canvas && made.canvas.id;
        } catch (e) { canvasId = ''; }
    }
    result.checks.canvas_id = canvasId || null;
    if (canvasId) {
        await memberPage.goto(BASE + '/static/smart-canvas.html?id=' + encodeURIComponent(canvasId) + '&project=default', { waitUntil: 'domcontentloaded' });
        await memberPage.waitForSelector('.nv-um-rail-btn', { timeout: 25000 });
    }
    await memberPage.waitForTimeout(800);
    result.checks.member_rail = await memberPage.evaluate(() => {
        const pill = document.querySelector('.nv-um-rail-btn');
        const img = pill && pill.querySelector('img');
        return { has_img: !!img, src: img ? img.getAttribute('src') : '', text: pill ? pill.textContent.trim() : '' };
    });
    if (canvasId) await memberPage.screenshot({ path: path.join(OUT, '34-member-canvas-rail.png') });

    // ---------- 管理员：列表头像 + 给成员换头像 + 自己头像 ----------
    await login(adminPage, ADMIN);
    await adminPage.goto(BASE + '/admin#users', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForSelector('#user-rows tr', { timeout: 20000 });
    await adminPage.waitForTimeout(800);
    const memberRowSelector = '#user-rows tr:has-text("' + MEMBER.username + '")';
    result.checks.admin_list_before = await adminPage.evaluate((name) => {
        const row = [...document.querySelectorAll('#user-rows tr')].find((tr) => tr.textContent.includes(name));
        const img = row && row.querySelector('.avatar img');
        return { row: !!row, has_img: !!img, src: img ? img.getAttribute('src') : '' };
    }, MEMBER.username);

    const [adminChooser] = await Promise.all([
        adminPage.waitForEvent('filechooser'),
        adminPage.click(memberRowSelector + ' [data-avatar-user]'),
    ]);
    await adminChooser.setFiles('/tmp/avatar-b.png');
    await adminPage.waitForFunction(() => {
        const box = document.getElementById('toast');
        return box && /头像已更新/.test(box.textContent);
    }, { timeout: 20000 });
    await adminPage.waitForTimeout(900);
    result.checks.admin_list_after = await adminPage.evaluate((name) => {
        const row = [...document.querySelectorAll('#user-rows tr')].find((tr) => tr.textContent.includes(name));
        const img = row && row.querySelector('.avatar img');
        return { has_img: !!img, src: img ? img.getAttribute('src') : '' };
    }, MEMBER.username);

    // 管理员给自己也换一个，截图里两侧都有真实头像
    await adminPage.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForSelector('#avatar-pick', { state: 'visible' });
    const [adminSelfChooser] = await Promise.all([
        adminPage.waitForEvent('filechooser'),
        adminPage.click('#avatar-pick'),
    ]);
    await adminSelfChooser.setFiles('/tmp/avatar-admin.png');
    await adminPage.waitForSelector('#avatar-save:not([hidden])', { timeout: 10000 });
    await adminPage.click('#avatar-save');
    await adminPage.waitForFunction(() => {
        const box = document.getElementById('toast');
        return box && box.getAttribute('data-show') === 'true' && /头像已更新/.test(box.textContent);
    }, { timeout: 20000 });
    await adminPage.waitForFunction(() => {
        const img = document.querySelector('#avatar img');
        return img && /\/api\/auth\/avatar\//.test(img.getAttribute('src') || '');
    }, { timeout: 20000 });

    await adminPage.goto(BASE + '/admin#users', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForSelector('#user-rows tr', { timeout: 20000 });
    await adminPage.waitForTimeout(1000);
    result.checks.admin_list_avatars = await adminPage.evaluate(() => [...document.querySelectorAll('#user-rows tr')].map((tr) => {
        const name = (tr.querySelector('b') || {}).textContent || '';
        const img = tr.querySelector('.avatar img');
        return { name: name.trim(), has_img: !!img, src: img ? img.getAttribute('src') : '' };
    }));
    result.screenshots.admin_list = path.join(OUT, '30-admin-avatars.png');
    await adminPage.screenshot({ path: result.screenshots.admin_list });

    // 成员侧应看到管理员换掉的新头像（版本号变了）
    await memberPage.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await memberPage.waitForSelector('#avatar img', { timeout: 20000 });
    await memberPage.waitForTimeout(600);
    result.checks.member_src_after_admin = await memberPage.getAttribute('#avatar img', 'src');

    // ---------- 管理员 / 成员：V2 设置页 ----------
    await adminPage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForSelector('.acct-avatar img', { timeout: 20000 });
    result.checks.admin_sidebar_src = await adminPage.getAttribute('.acct-avatar img', 'src');
    await openSettings(adminPage);
    result.checks.admin_tabs = await tabLabels(adminPage);
    result.checks.admin_has_api_tab = result.checks.admin_tabs.includes('API 设置');
    await adminPage.locator('.smodal .tab', { hasText: 'API 设置' }).click();
    await adminPage.waitForTimeout(1200);
    result.checks.admin_api_panel = await adminPage.evaluate(() => {
        const on = (document.querySelector('.smodal .tab.is-on') || {}).textContent || '';
        const content = document.querySelector('.smodal .content') || document.body;
        return { active: on.trim(), rendered: content.textContent.length > 40, has_frame: !!document.querySelector('.smodal .c-frame') };
    });
    result.screenshots.admin_settings = path.join(OUT, '35-admin-settings-api.png');
    await adminPage.screenshot({ path: result.screenshots.admin_settings });

    await memberCtx.close();
    await adminCtx.close();
    await browser.close();
    console.log(JSON.stringify(result, null, 2));

    const m = result.checks;
    const ok = m.member && m.member.role !== 'admin'
        && m.member_before.has_img === false
        && m.member_preview.has_img
        && /\/api\/auth\/avatar\/\d+\?v=/.test(m.member_saved_src || '')
        && m.member_after_reload.has_img
        && /\/api\/auth\/avatar\//.test(m.member_after_reload.src || '')
        && /\/api\/auth\/avatar\/\d+/.test(m.member_sidebar_src || '')
        && !m.member_has_api_tab && !m.member_forced_tab.has_api_panel && m.member_forced_tab.active && m.member_forced_tab.active !== 'API 设置'
        && (m.member_rail ? (m.member_rail.has_img && /\/api\/auth\/avatar\//.test(m.member_rail.src || '')) : !m.canvas_id)
        && m.admin_list_after.has_img && /\/api\/auth\/avatar\/\d+/.test(m.admin_list_after.src || '')
        && m.admin_list_after.src !== m.admin_list_before.src
        && m.member_src_after_admin !== m.member_saved_src
        && /\/api\/auth\/avatar\/\d+/.test(m.admin_sidebar_src || '')
        && m.admin_has_api_tab && m.admin_api_panel.active === 'API 设置' && m.admin_api_panel.rendered
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[avatar-api] 失败：', error);
    process.exit(1);
});