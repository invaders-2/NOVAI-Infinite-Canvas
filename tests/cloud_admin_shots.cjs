#!/usr/bin/env node
/*
 * 管理后台两屏截图（邀请码 / 用户），1440×900，产出到 tests/artifacts/cloud-admin/。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/cloud_admin_shots.cjs
 *
 * 前置：后端以 NOVAI_AUTH_ENABLED=1 + 管理员 admin/test-pass-123 跑在 8899，
 *      且已存在用户（先跑 tests/cloud_admin_smoke.sh 造数据）。
 * 文件名不以 test_ 开头：tests/run-all.js 只挑 test_*.js。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8899';
const ADMIN_USER = process.env.NOVAI_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.NOVAI_ADMIN_PASSWORD || 'test-pass-123';
const OUT_DIR = path.join(__dirname, 'artifacts', 'cloud-admin');

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
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto(BASE + '/login?next=/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASS);
    await Promise.all([
        page.waitForURL(/\/admin/, { timeout: 30000 }),
        page.click('#submit'),
    ]);
    await page.waitForSelector('#invite-rows tr', { state: 'visible' });
    await page.waitForFunction(() => {
        const el = document.getElementById('stat-users');
        return el && el.textContent !== '–';
    }, { timeout: 20000 });

    // 邀请码屏：先生成一个码，让“生成后可一键复制”的状态也进截图
    await page.click('#create-invite');
    await page.waitForSelector('#generated:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(600);
    const invitesShot = path.join(OUT_DIR, '01-admin-invites.png');
    await page.screenshot({ path: invitesShot });

    // 用户屏
    await page.click('[data-tab="users"]');
    await page.waitForSelector('#user-rows tr', { state: 'visible' });
    await page.waitForTimeout(800);
    const usersShot = path.join(OUT_DIR, '02-admin-users.png');
    await page.screenshot({ path: usersShot });

    const counts = await page.evaluate(() => ({
        users: document.querySelectorAll('#user-rows tr').length,
        invites: document.querySelectorAll('#invite-rows tr').length,
        stats: {
            users: document.getElementById('stat-users').textContent,
            invites: document.getElementById('stat-invites').textContent,
            today: document.getElementById('stat-today').textContent,
        },
    }));

    console.log(JSON.stringify({
        base: BASE,
        invites_screenshot: invitesShot,
        users_screenshot: usersShot,
        counts,
        page_errors: errors,
    }, null, 2));

    await browser.close();
    if (errors.length) process.exitCode = 1;
})().catch((error) => {
    console.error('[admin-shots] 失败：', error);
    process.exit(1);
});
