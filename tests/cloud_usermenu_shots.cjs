#!/usr/bin/env node
/*
 * C 端用户菜单 Playwright 验收（1440×900，auth-on）：
 *   登录 → 右上胶囊 → 面板 → 改密码弹窗 → 改密成功 → 退出 → /login
 *   再用新密码进 smart-canvas，截一次胶囊；顺带确认 canvas-list 也注入了菜单。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/cloud_usermenu_shots.cjs
 *
 * 前置：后端以 NOVAI_AUTH_ENABLED=1 + 管理员 admin/test-pass-123 跑在 8899，数据目录干净。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8899';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const OLD_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'test-pass-123';
const NEW_PASS = process.env.NOVAI_NEW_PASSWORD || 'test-pass-456';
const OUT_DIR = path.join(__dirname, 'artifacts', 'cloud-usermenu');

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const result = { base: BASE, screenshots: {}, checks: {}, page_errors: pageErrors };

    // 1) 登录进入首页
    await page.goto(BASE + '/login?next=/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', OLD_PASS);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);

    // 2) 胶囊出现 → 点开面板
    await page.waitForSelector('#nv-user-pill', { state: 'visible', timeout: 30000 });
    result.checks.pill_on_index = true;
    result.checks.pill_text = (await page.textContent('#nv-user-pill')).trim();
    await page.click('#nv-user-pill');
    await page.waitForSelector('.nv-um-panel[data-open="true"]', { timeout: 10000 });
    result.checks.role_text = (await page.textContent('.nv-um-head-role')).trim();
    result.checks.has_admin_entry = await page.locator('[data-action="admin"]').count() > 0;
    await page.waitForTimeout(350); // 等 0.14s 入场动画结束，避免截到半透明中间态
    result.screenshots.panel = path.join(OUT_DIR, '01-menu-panel.png');
    await page.screenshot({ path: result.screenshots.panel });

    // 2.1 键盘：Esc 关面板
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
        const panel = document.querySelector('.nv-um-panel');
        return panel && panel.getAttribute('data-open') === 'false';
    }, { timeout: 5000 });
    result.checks.esc_closes_panel = true;
    await page.click('#nv-user-pill');
    await page.waitForSelector('.nv-um-panel[data-open="true"]', { timeout: 10000 });

    // 3) 修改密码弹窗
    await page.click('[data-action="password"]');
    await page.waitForSelector('.nv-um-backdrop:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(150);
    result.checks.modal_focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    result.screenshots.modal = path.join(OUT_DIR, '02-password-modal.png');
    await page.screenshot({ path: result.screenshots.modal });

    // 3.1 键盘：Esc 关弹窗后重新打开
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
        const modal = document.querySelector('.nv-um-backdrop');
        return modal && modal.hidden === true;
    }, { timeout: 5000 });
    result.checks.esc_closes_modal = true;
    await page.click('#nv-user-pill');
    await page.waitForSelector('.nv-um-panel[data-open="true"]', { timeout: 10000 });
    await page.click('[data-action="password"]');
    await page.waitForSelector('.nv-um-backdrop:not([hidden])', { timeout: 10000 });

    // 4) 改密码成功（Enter 提交）
    await page.fill('#nv-um-old', OLD_PASS);
    await page.fill('#nv-um-new', NEW_PASS);
    await page.fill('#nv-um-confirm', NEW_PASS);
    await page.focus('#nv-um-confirm');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
        const toast = document.querySelector('.nv-um-toast');
        return toast && toast.getAttribute('data-show') === 'true' && /密码已修改/.test(toast.textContent);
    }, { timeout: 15000 });
    result.checks.password_changed_toast = true;
    result.checks.still_logged_in = await page.evaluate(async () => {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const data = await response.json();
        return response.status === 200 && data.auth_enabled === true && data.username === 'admin';
    });
    result.screenshots.changed = path.join(OUT_DIR, '03-password-changed.png');
    await page.screenshot({ path: result.screenshots.changed });

    // 5) 退出登录 → /login
    await page.click('#nv-user-pill');
    await page.waitForSelector('.nv-um-panel[data-open="true"]', { timeout: 10000 });
    await Promise.all([
        page.waitForURL(/\/login/, { timeout: 20000 }),
        page.click('[data-action="logout"]'),
    ]);
    result.checks.logout_url = page.url();

    // 6) 新密码登录 → smart-canvas 上的胶囊
    await page.goto(BASE + '/login?next=/static/smart-canvas.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', NEW_PASS);
    await Promise.all([
        page.waitForURL(/smart-canvas\.html/, { timeout: 30000 }),
        page.click('#submit'),
    ]);
    await page.waitForSelector('#nv-user-pill', { state: 'visible', timeout: 30000 });
    result.checks.pill_on_smart_canvas = true;
    await page.waitForTimeout(2500);
    result.screenshots.smart_canvas = path.join(OUT_DIR, '04-smart-canvas.png');
    await page.screenshot({ path: result.screenshots.smart_canvas });

    // 7) canvas-list 也注入（不截图）
    await page.goto(BASE + '/static/canvas-list.html', { waitUntil: 'domcontentloaded' });
    try {
        await page.waitForSelector('#nv-user-pill', { state: 'visible', timeout: 20000 });
        result.checks.pill_on_canvas_list = true;
    } catch (error) {
        result.checks.pill_on_canvas_list = false;
    }

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    if (!result.checks.pill_on_index || !result.checks.password_changed_toast || !result.checks.still_logged_in) {
        process.exitCode = 1;
    }
})().catch((error) => {
    console.error('[usermenu-shots] 失败：', error);
    process.exit(1);
});
