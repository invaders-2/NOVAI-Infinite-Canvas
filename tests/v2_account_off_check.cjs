#!/usr/bin/env node
/*
 * auth-off：V2 侧栏账户行必须整行隐藏（零 DOM），右上也不能有旧胶囊。
 *   NOVAI_BASE=http://127.0.0.1:8896 node tests/v2_account_off_check.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8896';
const OUT_DIR = path.join(__dirname, 'artifacts', 'v2-perms');

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
    await context.addInitScript(() => { try { localStorage.setItem('novai-visited', '1'); } catch (e) {} });
    const page = await context.newPage();
    const result = { base: BASE, checks: {}, screenshots: {}, page_errors: [] };
    page.on('pageerror', (err) => result.page_errors.push(String(err)));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1200);

    result.checks = await page.evaluate(() => ({
        auth_me: null,
        acct_row: document.querySelectorAll('.acct-row').length,
        acct_menu: document.querySelectorAll('.acct-menu').length,
        old_capsule: document.querySelectorAll('.nv-um-root').length,
        user_menu_script: !!document.querySelector('script[src*="user-menu.js"]'),
        sidebar_settings: !!document.querySelector('.sidebar .settings-toggle'),
    }));
    const me = await context.request.get(BASE + '/api/auth/me');
    result.checks.auth_me = (await me.json()).auth_enabled;

    await page.hover('.sidebar');
    await page.waitForTimeout(420);
    result.screenshots.row = path.join(OUT_DIR, '12-v2-account-authoff.png');
    await page.screenshot({ path: result.screenshots.row });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    const ok = result.checks.auth_me === false
        && result.checks.acct_row === 0
        && result.checks.acct_menu === 0
        && result.checks.old_capsule === 0
        && !result.checks.user_menu_script
        && result.checks.sidebar_settings
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[v2-account-off] 失败：', error);
    process.exit(1);
});
