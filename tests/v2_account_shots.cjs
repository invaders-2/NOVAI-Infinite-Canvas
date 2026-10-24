#!/usr/bin/env node
/*
 * V2 账户入口（侧栏底部）Playwright 验收（1600×1000，auth-on）：
 *   1) 左下账户行出现、右上无用户胶囊
 *   2) 点开菜单：四项（admin 有管理后台）、不裁切、Esc/点外部关闭、方向键不要求（Tab+Enter 可用）
 *   3) 三项跳转正确；退出登录 POST /api/auth/logout 后回 /login
 * 前置：NOVAI_BASE（默认 http://127.0.0.1:8899）以 auth-on 跑着。
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
    const welcome = page.locator('.wel .nv-btn.primary');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForSelector('.wel', { state: 'detached', timeout: 10000 });
    }
    await page.waitForSelector('.acct-row', { state: 'visible', timeout: 20000 });
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
    const result = { base: BASE, checks: {}, screenshots: {}, page_errors: [], requests: { logout: [] } };

    // ---------- auth-on：账户行 / 菜单 / 跳转 ----------
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (err) => result.page_errors.push('main: ' + String(err)));
    page.on('response', (res) => {
        if (res.url().endsWith('/api/auth/logout')) result.requests.logout.push(res.status());
    });
    await login(page);

    result.checks.account_row = await page.evaluate(() => {
        const row = document.querySelector('.acct-row');
        const avatar = row && row.querySelector('.acct-avatar');
        return {
            exists: !!row,
            text: row ? row.textContent.trim() : '',
            avatar_text: avatar ? avatar.textContent.trim() : '',
            aria_haspopup: row ? row.getAttribute('aria-haspopup') : null,
            aria_expanded: row ? row.getAttribute('aria-expanded') : null,
            user_menu_script: !!document.querySelector('script[src*="user-menu.js"]'),
            old_capsule: document.querySelectorAll('.nv-um-root').length,
        };
    });

    await page.hover('.sidebar');
    await page.waitForTimeout(420);
    result.screenshots.row = path.join(OUT_DIR, '10-v2-account-row.png');
    await page.screenshot({ path: result.screenshots.row });

    // 菜单：不裁切 + 四项 + 焦点
    await page.click('.acct-row');
    await page.waitForSelector('.acct-menu', { timeout: 10000 });
    await page.waitForTimeout(250);
    const menuBox = await page.locator('.acct-menu').boundingBox();
    result.checks.menu = await page.evaluate(() => {
        const menu = document.querySelector('.acct-menu');
        const row = document.querySelector('.acct-row');
        return {
            items: [...menu.querySelectorAll('.acct-item')].map((el) => el.textContent.trim()),
            inside_viewport: (() => { const r = menu.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })(),
            to_right_of_sidebar: (() => { const r = menu.getBoundingClientRect(); const s = document.querySelector('.sidebar').getBoundingClientRect(); return r.left >= s.right; })(),
            z_index: getComputedStyle(menu).zIndex,
            aria_expanded: row.getAttribute('aria-expanded'),
            focused: document.activeElement && document.activeElement.textContent.trim(),
            above_row: (() => { const r = menu.getBoundingClientRect(); const b = row.getBoundingClientRect(); return r.bottom <= b.bottom + 1; })(),
        };
    });
    result.checks.menu_box = menuBox && { x: Math.round(menuBox.x), y: Math.round(menuBox.y), w: Math.round(menuBox.width), h: Math.round(menuBox.height) };
    result.screenshots.menu = path.join(OUT_DIR, '11-v2-account-menu.png');
    await page.screenshot({ path: result.screenshots.menu });

    // Esc 关闭 + 焦点回按钮
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.acct-menu'), { timeout: 5000 });
    result.checks.esc_close = await page.evaluate(() => ({
        closed: !document.querySelector('.acct-menu'),
        focused_row: document.activeElement === document.querySelector('.acct-row'),
        aria_expanded: document.querySelector('.acct-row').getAttribute('aria-expanded'),
    }));

    // 键盘：focus + Enter 打开，Tab 能在菜单里移动
    await page.focus('.acct-row');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.acct-menu', { timeout: 5000 });
    const firstFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
    await page.keyboard.press('Tab');
    const secondFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
    result.checks.keyboard = { first: firstFocus, second: secondFocus };
    // 点空白关闭
    await page.mouse.click(1000, 300);
    await page.waitForFunction(() => !document.querySelector('.acct-menu'), { timeout: 5000 });
    result.checks.outside_close = true;

    // 跳转：我的账户 / 修改密码 / 管理后台
    async function clickItemAndWait(label, pattern) {
        await page.locator('.acct-row').click();
        await page.waitForSelector('.acct-menu', { timeout: 5000 });
        await Promise.all([
            page.waitForURL(pattern, { timeout: 20000 }),
            page.locator('.acct-item', { hasText: label }).click(),
        ]);
        const url = page.url();
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.acct-row', { state: 'visible', timeout: 20000 });
        return url;
    }
    result.checks.nav_account = await clickItemAndWait('我的账户', (u) => /\/account$/.test(u.toString()));
    result.checks.nav_password = await clickItemAndWait('修改密码', (u) => /\/account#password$/.test(u.toString()));
    result.checks.nav_admin = await clickItemAndWait('管理后台', (u) => /\/admin$/.test(u.toString()));
    await context.close();

    // ---------- auth-on：退出登录（独立 context，避免影响上面的断言） ----------
    const logoutContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const logoutPage = await logoutContext.newPage();
    logoutPage.on('pageerror', (err) => result.page_errors.push('logout: ' + String(err)));
    logoutPage.on('response', (res) => {
        if (res.url().endsWith('/api/auth/logout')) result.requests.logout.push(res.status());
    });
    await login(logoutPage);
    await logoutPage.click('.acct-row');
    await logoutPage.waitForSelector('.acct-menu', { timeout: 10000 });
    await Promise.all([
        logoutPage.waitForURL(/\/login/, { timeout: 20000 }),
        logoutPage.locator('.acct-item', { hasText: '退出登录' }).click(),
    ]);
    result.checks.logout_url = logoutPage.url();
    const meAfter = await logoutContext.request.get(BASE + '/api/auth/me');
    result.checks.logout_me_status = meAfter.status();
    await logoutContext.close();

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    const m = result.checks.menu;
    const ok = result.checks.account_row.exists
        && result.checks.account_row.old_capsule === 0
        && !result.checks.account_row.user_menu_script
        && m.items.length === 4
        && m.items.includes('管理后台')
        && m.inside_viewport && m.to_right_of_sidebar && m.above_row
        && result.checks.esc_close.closed && result.checks.esc_close.focused_row
        && result.checks.keyboard.first === '我的账户'
        && /\/account$/.test(result.checks.nav_account)
        && /\/account#password$/.test(result.checks.nav_password)
        && /\/admin$/.test(result.checks.nav_admin)
        && /\/login/.test(result.checks.logout_url)
        && result.requests.logout.includes(200)
        && result.checks.logout_me_status === 401
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[v2-account-shots] 失败：', error);
    process.exit(1);
});