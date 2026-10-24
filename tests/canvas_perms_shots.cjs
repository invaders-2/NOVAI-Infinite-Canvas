#!/usr/bin/env node
/*
 * M3 画布权限 Playwright 验收（1440×900，auth-on）：
 *   1) bob（被共享 editor）的画布列表：卡片「可编辑」标记
 *   2) alice（owner）的卡片「…」菜单：含「权限」
 *   3) alice 的权限弹窗：归属/成员/角色下拉/移除/添加
 *   4) bob 打开同一弹窗：只读视图（无添加/移除）
 * 前置：tests/canvas_perms_smoke.sh 已在同一后端跑过并留下 alice/bob + 共享画布。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8897';
const OUT_DIR = path.join(__dirname, 'artifacts', 'canvas-perms');

async function login(page, username, password, next) {
    await page.goto(BASE + '/login?next=' + encodeURIComponent(next), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', username);
    await page.fill('#password', password);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
    await page.waitForSelector('.project-card', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(600);
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
    const result = { base: BASE, screenshots: {}, checks: {}, page_errors: [] };

    // ---- bob：卡片上应出现「可编辑」共享标记 ----
    const bobContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const bobPage = await bobContext.newPage();
    bobPage.on('pageerror', (err) => result.page_errors.push('bob: ' + String(err)));
    await login(bobPage, 'bob', 'bob-pass-123', '/static/canvas-list.html');
    await bobPage.waitForSelector('.card-share-badge', { state: 'visible', timeout: 15000 });
    result.checks.shared_badge = (await bobPage.textContent('.card-share-badge')).trim();
    result.screenshots.list = path.join(OUT_DIR, '01-list-shared-badge.png');
    await bobPage.screenshot({ path: result.screenshots.list });

    // bob 打开权限弹窗：只读视图
    await bobPage.click('.card-more-btn');
    await bobPage.waitForSelector('.card-more-menu.active', { timeout: 10000 });
    result.checks.bob_menu_permissions = await bobPage.locator('[data-action="permissions"]').count();
    await bobPage.click('[data-action="permissions"]');
    await bobPage.waitForSelector('.perm-overlay .perm-modal', { timeout: 15000 });
    await bobPage.waitForTimeout(300);
    result.checks.bob_modal_readonly = (await bobPage.locator('.perm-add').count()) === 0;
    result.screenshots.readonly = path.join(OUT_DIR, '04-permissions-readonly.png');
    await bobPage.screenshot({ path: result.screenshots.readonly });
    await bobContext.close();

    // ---- alice（owner）：菜单 + 可编辑弹窗 ----
    const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await aliceContext.newPage();
    page.on('pageerror', (err) => result.page_errors.push('alice: ' + String(err)));
    await login(page, 'alice', 'alice-pass-123', '/static/canvas-list.html');

    await page.click('.card-more-btn');
    await page.waitForSelector('.card-more-menu.active', { timeout: 10000 });
    result.checks.menu_has_permissions = await page.locator('[data-action="permissions"]').count();
    result.checks.menu_permissions_text = (await page.textContent('[data-action="permissions"]')).trim();
    await page.waitForTimeout(250);
    result.screenshots.menu = path.join(OUT_DIR, '02-card-menu.png');
    await page.screenshot({ path: result.screenshots.menu });

    await page.click('[data-action="permissions"]');
    await page.waitForSelector('.perm-overlay .perm-modal', { timeout: 15000 });
    await page.waitForSelector('.perm-member', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(300);
    result.checks.modal_owner = (await page.textContent('.perm-owner b')).trim();
    result.checks.modal_my_role = (await page.textContent('.perm-chip')).trim();
    result.checks.modal_member = (await page.textContent('.perm-member .perm-name')).trim();
    result.checks.modal_member_role = await page.inputValue('.perm-role');
    result.screenshots.modal = path.join(OUT_DIR, '03-permissions-modal.png');
    await page.screenshot({ path: result.screenshots.modal });

    // 改角色立即生效（弹窗内操作 + toast）
    await page.selectOption('.perm-role', 'viewer');
    await page.waitForFunction(() => {
        const toast = document.querySelector('.perm-toast.show');
        return toast && /角色已更新/.test(toast.textContent);
    }, { timeout: 15000 });
    result.checks.role_change_toast = true;
    result.checks.role_after_change = await page.inputValue('.perm-role');
    await page.selectOption('.perm-role', 'editor');
    await page.waitForTimeout(400);
    result.checks.role_after_restore = await page.inputValue('.perm-role');

    // Esc 关闭弹窗
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.perm-overlay'), { timeout: 5000 });
    result.checks.esc_closes_modal = true;

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    if (!result.checks.menu_has_permissions || !result.checks.modal_member || !result.checks.bob_modal_readonly) {
        process.exitCode = 1;
    }
})().catch((error) => {
    console.error('[canvas-perms-shots] 失败：', error);
    process.exit(1);
});
