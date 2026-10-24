#!/usr/bin/env node
/*
 * 「我的账户 + 忘记密码」Playwright 验收（1440×900，auth-on）。
 *
 *   NOVAI_BASE=http://127.0.0.1:8898 NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' \
 *       node tests/cloud_account_shots.cjs
 *
 * 前置：后端以 NOVAI_AUTH_ENABLED=1 + 管理员 admin/test-pass-123 跑在 8898，数据目录干净。
 * 产出：tests/artifacts/cloud-account/01..05*.png
 * 文件名不以 test_ 开头：tests/run-all.js 不会把它当测试跑。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'test-pass-123';
const NEW_PASS = process.env.NOVAI_RESET_PASSWORD || 'test-pass-456';
const OUT_DIR = path.join(__dirname, 'artifacts', 'cloud-account');

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
    const shot = async (name) => {
        const file = path.join(OUT_DIR, name);
        await page.screenshot({ path: file });
        return file;
    };

    // 0) 真实 HTTP（未登录、不带 text/html 的 Accept）：页面 302 到登录页，接口 401 JSON
    const anonymousPage = await context.request.get(BASE + '/account', { maxRedirects: 0 });
    const anonymousLocation = anonymousPage.headers()['location'] || '';
    result.checks.anonymous_page_status = anonymousPage.status();
    result.checks.anonymous_page_redirect_to_login = anonymousPage.status() === 302
        && anonymousLocation.indexOf('/login') === 0
        && anonymousLocation.indexOf('next=/account') >= 0;
    const anonymousApi = await context.request.get(BASE + '/api/auth/account', { maxRedirects: 0 });
    const anonymousApiBody = await anonymousApi.json().catch(() => ({}));
    result.checks.anonymous_account_api_status = anonymousApi.status();
    result.checks.anonymous_api_stays_401_json = anonymousApi.status() === 401
        && anonymousApiBody.code === 'unauthorized';

    // 1) 登录（顺带确认「忘记密码？」链接指向 /reset）
    await page.goto(BASE + '/login?next=/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.waitForFunction(() => {
        const row = document.getElementById('forgot-row');
        return row && !row.hidden;
    }, { timeout: 10000 });
    result.checks.login_forgot_link = (await page.getAttribute('#forgot-link', 'href')) === '/reset';
    result.screenshots.login = await shot('00-login-forgot.png');
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASS);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);

    // 2) 用户菜单里有「我的账户」
    await page.waitForSelector('#nv-user-pill', { state: 'visible', timeout: 30000 });
    await page.click('#nv-user-pill');
    await page.waitForSelector('.nv-um-panel[data-open="true"]', { timeout: 10000 });
    result.checks.menu_has_account = (await page.locator('[data-action="account"]').count()) > 0;
    result.checks.menu_account_text = (await page.textContent('[data-action="account"]')).trim();
    await page.waitForTimeout(350); // 等 0.14s 入场动画结束
    result.screenshots.menu = await shot('01-menu-panel.png');

    // 3) 点进我的账户
    await Promise.all([
        page.waitForURL(/\/account/, { timeout: 20000 }),
        page.click('[data-action="account"]'),
    ]);
    await page.waitForFunction(() => {
        const node = document.getElementById('username');
        return node && node.textContent.trim() && node.textContent.trim() !== '加载中…';
    }, { timeout: 20000 });
    await page.waitForTimeout(300);
    result.checks.account_url = page.url();
    result.checks.account_username = (await page.textContent('#username')).trim();
    result.checks.account_role = (await page.textContent('#role')).trim();
    result.checks.account_created_at = (await page.textContent('#created-at')).trim();
    result.checks.account_canvas_count = (await page.textContent('#canvas-count')).trim();
    result.checks.account_has_username_form = (await page.locator('#username-form').count()) > 0;
    result.checks.account_has_password_form = (await page.locator('#password-form').count()) > 0;
    result.screenshots.account = await shot('02-account.png');

    // 3.1 明暗主题：跟随 marvis 令牌（studio_theme=dark）
    await page.evaluate(() => localStorage.setItem('studio_theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const node = document.getElementById('username');
        return node && node.textContent.trim() !== '加载中…';
    }, { timeout: 20000 });
    result.checks.account_dark_theme = await page.evaluate(() => document.documentElement.classList.contains('studio-theme-dark'));
    await page.waitForTimeout(250);
    result.screenshots.account_dark = await shot('06-account-dark.png');
    await page.evaluate(() => localStorage.setItem('studio_theme', 'light'));

    // 4) /reset 页面（公开可访问）
    await page.goto(BASE + '/reset', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#reset-form', { state: 'visible' });
    result.checks.reset_notice = (await page.textContent('.notice')).trim();
    result.checks.reset_has_invite_hint = /邀请制/.test(result.checks.reset_notice) && /6 位重置码/.test(result.checks.reset_notice);
    result.screenshots.reset = await shot('03-reset.png');

    // 5) 管理后台用户列表出现「生成重置码」
    await page.goto(BASE + '/admin#users', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#user-rows [data-reset-code]', { timeout: 20000 });
    result.checks.admin_reset_code_button = (await page.locator('#user-rows [data-reset-code]').count()) > 0;
    result.screenshots.admin = await shot('04-admin-users.png');

    // 6) 真的生成一个码，再用 /reset 页面走完重置流程
    const generated = await page.evaluate(async (username) => {
        const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json();
        const response = await fetch('/api/admin/users/' + me.id + '/reset-code', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        });
        return { status: response.status, body: await response.json(), username: username };
    }, ADMIN_USER);
    result.checks.reset_code_status = generated.status;
    result.checks.reset_code_format = /^\d{6}$/.test(String(generated.body.code || ''));
    const code = String(generated.body.code || '');

    await page.goto(BASE + '/reset', { waitUntil: 'domcontentloaded' });
    await page.fill('#username', ADMIN_USER);
    await page.fill('#code', code);
    await page.fill('#new-password', NEW_PASS);
    await page.fill('#confirm-password', NEW_PASS);
    await page.click('#submit');
    await page.waitForSelector('#success:not([hidden])', { timeout: 20000 });
    result.checks.reset_success = true;
    result.screenshots.reset_success = await shot('05-reset-success.png');

    // 7) 新密码能登录（旧会话已被踢）
    await page.goto(BASE + '/login?next=/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASS);
    await page.click('#submit');
    await page.waitForTimeout(1500);
    result.checks.old_password_rejected = await page.locator('#alert:not([hidden])').count() > 0;

    await page.fill('#password', NEW_PASS);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
    result.checks.login_with_new_password = true;

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    const required = [
        'anonymous_page_redirect_to_login', 'anonymous_api_stays_401_json',
        'login_forgot_link', 'menu_has_account', 'account_has_username_form', 'account_has_password_form',
        'reset_has_invite_hint', 'admin_reset_code_button', 'reset_code_format',
        'reset_success', 'old_password_rejected', 'login_with_new_password',
    ];
    if (required.some((key) => !result.checks[key]) || pageErrors.length) process.exitCode = 1;
})().catch((error) => {
    console.error('[account-shots] 失败：', error);
    process.exit(1);
});
