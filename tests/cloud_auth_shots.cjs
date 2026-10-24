#!/usr/bin/env node
/*
 * 登录页 + 登录后首页截图（1440×900），产出到 tests/artifacts/cloud-auth/。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/cloud_auth_shots.cjs
 *
 * 前置：后端已用 NOVAI_AUTH_ENABLED=1 + 引导管理员跑在 8899。
 * 文件名故意不以 test_ 开头：tests/run-all.js 只挑 test_*.js，不会把它当测试跑。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8899';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'test-pass-123';
const OUT_DIR = path.join(__dirname, 'artifacts', 'cloud-auth');

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 本机 Playwright 1.63 期望 chromium-1248，缓存里实际是 1223：显式挑一个存在的 Chromium，
    // 避免下载新浏览器（不新增任何依赖）。
    const chromiumCandidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        chromium.executablePath(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ].filter(Boolean);
    const executablePath = chromiumCandidates.find((candidate) => fs.existsSync(candidate));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    // 1) 未登录访问首页 → 302 到 /login?next=%2F
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 20000 });
    await page.waitForSelector('#auth-form', { state: 'visible' });
    const loginShot = path.join(OUT_DIR, 'login.png');
    await page.screenshot({ path: loginShot });

    // 2) 管理员登录 → 回到首页
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASS);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
    await page.waitForTimeout(4500);
    const homeShot = path.join(OUT_DIR, 'home.png');
    await page.screenshot({ path: homeShot });

    const me = await page.evaluate(async () => {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        return { status: response.status, body: await response.json() };
    });

    const result = {
        base: BASE,
        login_url: BASE + '/login',
        login_screenshot: loginShot,
        home_screenshot: homeShot,
        page_errors: errors,
        me,
    };
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    if (errors.length) process.exitCode = 1;
})().catch((error) => {
    console.error('[shots] 失败：', error);
    process.exit(1);
});
