#!/usr/bin/env node
/*
 * V2 画布列表 auth-off 验收：菜单里不得出现「权限」，也不得加载 canvas-perms 资源。
 *   NOVAI_BASE=http://127.0.0.1:8896 node tests/v2_perms_off_check.cjs
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
    const page = await context.newPage();
    const result = { base: BASE, checks: {}, screenshots: {}, page_errors: [] };
    page.on('pageerror', (err) => result.page_errors.push(String(err)));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-item', { state: 'visible', timeout: 30000 });
    const welcome = page.locator('.wel .nv-btn.primary');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForSelector('.wel', { state: 'detached', timeout: 10000 });
    }
    await page.waitForSelector('.cl-card', { state: 'visible', timeout: 20000 });
    result.checks.auth_me = await page.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        return (await res.json()).auth_enabled;
    });

    const card = page.locator('.cl-card').first();
    await card.hover();
    await card.locator('.cl-more').click();
    const menu = card.locator('.nv-menu');
    await menu.waitFor({ state: 'visible', timeout: 10000 });
    result.checks.menu_items = (await menu.locator('.nv-menu-item').allTextContents()).map((text) => text.trim());
    result.checks.menu_has_perms = result.checks.menu_items.includes('权限');
    result.checks.perms_assets = await page.evaluate(() => ({
        script: document.querySelectorAll('script[src*="canvas-perms.js"]').length,
        css: document.querySelectorAll('link[href*="canvas-perms.css"]').length,
        api: !!window.NOVAI_CANVAS_PERMS,
    }));
    await page.waitForTimeout(300);
    result.screenshots.menu = path.join(OUT_DIR, '05-v2-menu-auth-off.png');
    await page.screenshot({ path: result.screenshots.menu });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();

    const hidden = !result.checks.menu_has_perms
        && result.checks.perms_assets.script === 0
        && result.checks.perms_assets.css === 0
        && !result.checks.perms_assets.api
        && result.checks.auth_me === false
        && result.page_errors.length === 0;
    result.checks.auth_off_hidden = hidden;
    if (!hidden) process.exitCode = 1;
})().catch((error) => {
    console.error('[v2-perms-off] 失败：', error);
    process.exit(1);
});
