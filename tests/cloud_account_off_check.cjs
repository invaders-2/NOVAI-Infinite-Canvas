#!/usr/bin/env node
/* auth 关闭时：/account 与 /reset 必须不存在，菜单不出现「我的账户」。
 *   NOVAI_BASE=http://127.0.0.1:8898 NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' \
 *       node tests/cloud_account_off_check.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8898';

(async () => {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        chromium.executablePath(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ].filter(Boolean);
    const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const accountResponse = await page.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    const resetResponse = await page.goto(BASE + '/reset', { waitUntil: 'domcontentloaded' });

    // auth 关闭时登录页的「忘记密码？」必须收起来（页面仍可访问，但链接无意义）
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const forgotHidden = await page.evaluate(() => {
        const row = document.getElementById('forgot-row');
        return !!row && row.hidden === true;
    });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const state = await page.evaluate(async () => {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const body = await response.json();
        return {
            auth_enabled: body.auth_enabled,
            pill: !!document.getElementById('nv-user-pill'),
            account_entry: !!document.querySelector('[data-action="account"]'),
            body_mentions_account: document.body.innerText.indexOf('我的账户') >= 0,
        };
    });

    const result = {
        base: BASE,
        account_status: accountResponse ? accountResponse.status() : null,
        reset_status: resetResponse ? resetResponse.status() : null,
        state,
        forgot_link_hidden: forgotHidden,
        page_errors: pageErrors,
    };
    const ok = result.account_status === 404 && result.reset_status === 404
        && forgotHidden
        && state.auth_enabled === false && !state.pill && !state.account_entry && !state.body_mentions_account;
    result.ok = ok;
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    if (!ok || pageErrors.length) process.exitCode = 1;
})().catch((error) => {
    console.error('[account-off] 失败：', error);
    process.exit(1);
});
