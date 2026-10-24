#!/usr/bin/env node
/*
 * V2 画布列表「权限」入口 Playwright 验收（1600×1000，auth-on）：
 *   1) 卡片「…」菜单在「复制画布」后出现「权限」（顺序：重命名 / 复制画布 / 权限 / 删除）
 *   2) 点「权限」懒加载 canvas-perms.css/js 并弹出旧权限弹窗（成员 / 归属 / 分段按钮）
 *   3) 点「可编辑」→ PATCH 200、toast、active 切换
 * 前置：NOVAI_BASE（默认 http://127.0.0.1:8899）后端以 auth-on 跑着，且已有一个非 admin 用户。
 * 测试会临时建一张画布并共享给该用户，结束前把成员移除、画布彻底删除。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8899';
const USER = process.env.NOVAI_USER || 'admin';
const PASS = process.env.NOVAI_PASS || 'admin12345';
const OUT_DIR = path.join(__dirname, 'artifacts', 'v2-perms');
const TITLE = 'V2 权限验收 ' + Date.now();

async function login(page) {
    await page.goto(BASE + '/login?next=' + encodeURIComponent('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
    await page.waitForSelector('.nav-item', { state: 'visible', timeout: 30000 });
    // 首次访问的欢迎页盖住整个外壳，先关掉（「开始使用」本来就会切到画布页）
    const welcome = page.locator('.wel .nv-btn.primary');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForSelector('.wel', { state: 'detached', timeout: 10000 });
    }
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        chromium.executablePath(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ].filter(Boolean);
    const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const result = { base: BASE, title: TITLE, checks: {}, screenshots: {}, page_errors: [] };
    page.on('pageerror', (err) => result.page_errors.push(String(err)));

    await login(page);

    const me = await (await context.request.get(BASE + '/api/auth/me')).json();
    const usersBody = await (await context.request.get(BASE + '/api/admin/users')).json();
    const other = (usersBody.users || []).find((u) => u.id !== me.id && u.status === 'active');
    if (!other) throw new Error('没有可共享的第二个用户，无法验证角色切换');

    const made = await (await context.request.post(BASE + '/api/canvases', {
        data: { title: TITLE, icon: '🧩' },
    })).json();
    const canvasId = made.canvas.id;
    result.canvas_id = canvasId;
    const shared = await context.request.post(BASE + '/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
        data: { username: other.username, role: 'viewer' },
    });
    result.checks.setup_share = shared.status();
    if (shared.status() !== 200) throw new Error('共享成员准备失败：' + shared.status());

    // ---- V2 画布列表（刷新一次，让新建的画布出现在列表里） ----
    await page.reload({ waitUntil: 'domcontentloaded' });
    const card = page.locator('.cl-card').filter({ hasText: TITLE }).first();
    await card.waitFor({ state: 'visible', timeout: 20000 });
    await card.hover();
    await card.locator('.cl-more').click();
    const menu = card.locator('.nv-menu');
    await menu.waitFor({ state: 'visible', timeout: 10000 });
    result.checks.menu_items = await menu.locator('.nv-menu-item').allTextContents();
    result.checks.menu_items = result.checks.menu_items.map((text) => text.trim());
    result.checks.menu_has_perms = result.checks.menu_items.includes('权限');
    result.screenshots.menu = path.join(OUT_DIR, '01-v2-card-menu-perms.png');
    await page.waitForTimeout(300);
    await page.screenshot({ path: result.screenshots.menu });

    // ---- 点「权限」：懒加载脚本 + 弹窗 ----
    await menu.locator('.nv-menu-item', { hasText: '权限' }).click();
    await page.waitForSelector('.perm-overlay .perm-modal', { timeout: 15000 });
    await page.waitForSelector('.perm-member', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(400);
    result.checks.assets_loaded = await page.evaluate(() => ({
        script_once: document.querySelectorAll('script[src*="canvas-perms.js"]').length,
        css_once: document.querySelectorAll('link[href*="canvas-perms.css"]').length,
        api: typeof (window.NOVAI_CANVAS_PERMS || {}).open === 'function',
    }));
    result.checks.modal_title = (await page.textContent('#permTitle')).trim();
    result.checks.modal_owner = (await page.textContent('.perm-owner b')).trim();
    result.checks.modal_my_role = (await page.textContent('.perm-chip')).trim();
    result.checks.modal_members = await page.locator('.perm-member').count();
    result.checks.seg_buttons = await page.locator('.perm-role-seg .perm-seg-btn').count();
    result.checks.member_role = await page.getAttribute('.perm-role-seg', 'data-current');
    result.screenshots.modal = path.join(OUT_DIR, '02-v2-perms-modal.png');
    await page.screenshot({ path: result.screenshots.modal });
    result.checks.overlay_scrim = await page.evaluate(() => {
        const overlay = document.querySelector('.perm-overlay');
        return overlay ? getComputedStyle(overlay).backgroundColor : null;
    });

    // ---- 改成「可编辑」：PATCH 200 + toast + active ----
    const patch = page.waitForResponse((res) =>
        /\/members\/\d+$/.test(res.url()) && res.request().method() === 'PATCH', { timeout: 15000 });
    await page.click('.perm-role-seg .perm-seg-btn[data-role="editor"]');
    const patchResponse = await patch;
    result.checks.patch_status = patchResponse.status();
    await page.waitForFunction(() => {
        const toast = document.querySelector('.perm-toast.show');
        return toast && /角色已更新/.test(toast.textContent);
    }, { timeout: 15000 });
    result.checks.toast = (await page.textContent('.perm-toast.show')).trim();
    await page.waitForSelector('.perm-role-seg[data-current="editor"]', { timeout: 15000 });
    result.checks.editor_active = await page.getAttribute('.perm-role-seg .perm-seg-btn[data-role="editor"]', 'aria-pressed');
    result.checks.viewer_inactive = await page.getAttribute('.perm-role-seg .perm-seg-btn[data-role="viewer"]', 'aria-pressed');
    result.screenshots.editor = path.join(OUT_DIR, '03-v2-perms-role-editor.png');
    await page.waitForTimeout(200);
    await page.screenshot({ path: result.screenshots.editor });

    // ---- 暗色主题：同样的入口 + 遮罩 ----
    const darkCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await darkCtx.addInitScript(() => { try { localStorage.setItem('studio_theme', 'dark'); } catch (e) {} });
    const darkPage = await darkCtx.newPage();
    darkPage.on('pageerror', (err) => result.page_errors.push('dark: ' + String(err)));
    await login(darkPage);
    const darkCard = darkPage.locator('.cl-card').filter({ hasText: TITLE }).first();
    await darkCard.waitFor({ state: 'visible', timeout: 20000 });
    await darkCard.hover();
    await darkCard.locator('.cl-more').click();
    await darkCard.locator('.nv-menu-item', { hasText: '权限' }).click();
    await darkPage.waitForSelector('.perm-overlay .perm-modal', { timeout: 15000 });
    await darkPage.waitForTimeout(400);
    result.checks.dark_theme = await darkPage.evaluate(() => document.documentElement.classList.contains('theme-dark'));
    result.checks.dark_overlay_scrim = await darkPage.evaluate(() => getComputedStyle(document.querySelector('.perm-overlay')).backgroundColor);
    result.screenshots.modal_dark = path.join(OUT_DIR, '06-v2-perms-modal-dark.png');
    await darkPage.screenshot({ path: result.screenshots.modal_dark });
    await darkCtx.close();

    // ---- 旧列表回归：static/canvas-list.html 的权限弹窗 ----
    const legacyCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const legacyPage = await legacyCtx.newPage();
    legacyPage.on('pageerror', (err) => result.page_errors.push('legacy: ' + String(err)));
    await legacyPage.goto(BASE + '/login?next=' + encodeURIComponent('/static/canvas-list.html'), { waitUntil: 'domcontentloaded' });
    await legacyPage.waitForSelector('#username', { state: 'visible' });
    await legacyPage.fill('#username', USER);
    await legacyPage.fill('#password', PASS);
    await Promise.all([
        legacyPage.waitForURL((url) => /canvas-list\.html/.test(url.toString()), { timeout: 30000 }),
        legacyPage.click('#submit'),
    ]);
    await legacyPage.waitForSelector('.project-card', { state: 'visible', timeout: 20000 });
    await legacyPage.click('.card-more-btn');
    await legacyPage.waitForSelector('.card-more-menu.active', { timeout: 10000 });
    result.checks.legacy_menu_perms = (await legacyPage.textContent('[data-action="permissions"]')).trim();
    await legacyPage.click('[data-action="permissions"]');
    await legacyPage.waitForSelector('.perm-overlay .perm-modal', { timeout: 15000 });
    await legacyPage.waitForTimeout(400);
    result.checks.legacy_overlay_scrim = await legacyPage.evaluate(() => getComputedStyle(document.querySelector('.perm-overlay')).backgroundColor);
    result.screenshots.legacy = path.join(OUT_DIR, '07-legacy-list-perms.png');
    await legacyPage.screenshot({ path: result.screenshots.legacy });
    await legacyCtx.close();

    // ---- 还原数据 ----
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.perm-overlay'), { timeout: 5000 });
    result.checks.esc_closes_modal = true;
    await context.request.delete(BASE + '/api/canvases/' + encodeURIComponent(canvasId) + '/members/' + other.id);
    await context.request.delete(BASE + '/api/canvases/' + encodeURIComponent(canvasId) + '/purge');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.cl-card', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(600);
    result.screenshots.list = path.join(OUT_DIR, '04-v2-canvas-list.png');
    await page.screenshot({ path: result.screenshots.list });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    const scrimOk = /rgba\(0, 0, 0, (0\.42|0\.58)\)/.test(result.checks.overlay_scrim || '');
    const darkScrimOk = /rgba\(0, 0, 0, 0\.58\)/.test(result.checks.dark_overlay_scrim || '');
    const legacyOk = /rgba\(0, 0, 0, 0\.38\)/.test(result.checks.legacy_overlay_scrim || '');
    const ok = result.checks.menu_has_perms
        && result.checks.assets_loaded.api
        && result.checks.modal_members > 0
        && result.checks.patch_status === 200
        && result.checks.editor_active === 'true'
        && scrimOk && darkScrimOk && legacyOk
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[v2-perms-shots] 失败：', error);
    process.exit(1);
});