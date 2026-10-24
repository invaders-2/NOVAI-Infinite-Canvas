#!/usr/bin/env node
/* auth 关闭时用户菜单必须零渲染（不注 DOM、不注样式，也不能有胶囊）。
 *   node tests/cloud_usermenu_off_check.cjs   （前置：auth-off 后端跑在 $NOVAI_BASE，默认 8898）
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
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const state = await page.evaluate(async () => {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const body = await response.json();
        return {
            auth_enabled: body.auth_enabled,
            pill: !!document.getElementById('nv-user-pill'),
            style: !!document.getElementById('nv-user-menu-style'),
            menu_nodes: document.querySelectorAll('.nv-um-root, .nv-um-backdrop, .nv-um-toast').length,
        };
    });
    const ok = state.auth_enabled === false && !state.pill && !state.style && state.menu_nodes === 0;
    console.log(JSON.stringify({ base: BASE, state, page_errors: pageErrors, zero_render: ok }, null, 2));
    await browser.close();
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[usermenu-off] 失败：', error);
    process.exit(1);
});
