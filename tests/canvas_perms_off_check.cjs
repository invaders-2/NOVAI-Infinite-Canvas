#!/usr/bin/env node
/* auth-off 时画布列表不得出现「权限」入口/共享标记。
 *   NOVAI_BASE=http://127.0.0.1:8896 node tests/canvas_perms_off_check.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8896';

(async () => {
    const created = await fetch(BASE + '/api/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'auth-off canvas' }),
    });
    const createdBody = await created.json();
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
    await page.goto(BASE + '/static/canvas-list.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.project-card', { state: 'visible', timeout: 20000 });
    await page.click('.card-more-btn');
    await page.waitForSelector('.card-more-menu.active', { timeout: 10000 });
    const state = await page.evaluate(() => ({
        permissions_items: document.querySelectorAll('[data-action="permissions"]').length,
        share_badges: document.querySelectorAll('.card-share-badge').length,
        perms_script_loaded: !!window.NOVAI_CANVAS_PERMS,
    }));
    const ok = created.ok && state.permissions_items === 0 && state.share_badges === 0;
    console.log(JSON.stringify({ base: BASE, canvas_id: createdBody.canvas && createdBody.canvas.id, state, page_errors: pageErrors, auth_off_hidden: ok }, null, 2));
    await browser.close();
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[canvas-perms-off] 失败：', error);
    process.exit(1);
});
