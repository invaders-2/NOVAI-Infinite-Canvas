#!/usr/bin/env node
/*
 * 账户页 #password 锚点验收（auth-on）：
 *   1600×1000（页面不需要滚动）：直接 /account#password 密码区在视口内；/account 停在顶部；V2 菜单同位置。
 *   1280×760（页面需要滚动）：/account#password 与 V2 菜单「修改密码」都应滚到改密区顶部附近。
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
}

async function probe(page) {
    return page.evaluate(() => {
        const target = document.getElementById('password');
        const form = document.getElementById('password-form');
        const oldInput = document.getElementById('old-password');
        const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
        };
        return {
            hash: location.hash,
            scrollY: Math.round(window.scrollY),
            pageHeight: document.documentElement.scrollHeight,
            password: rect(target),
            form: rect(form),
            old_password: rect(oldInput),
            form_inside_section: !!(target && form && target.contains(form)),
            viewport: { w: window.innerWidth, h: window.innerHeight },
        };
    });
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
    const result = { base: BASE, checks: {}, screenshots: {}, page_errors: [] };

    // ---------- 1600×1000 ----------
    const wide = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await wide.newPage();
    page.on('pageerror', (err) => result.page_errors.push('wide: ' + String(err)));
    await login(page);

    await page.goto(BASE + '/account#password', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(1200);
    result.checks.wide_direct = await probe(page);
    result.screenshots.direct = path.join(OUT_DIR, '20-account-password-hash.png');
    await page.screenshot({ path: result.screenshots.direct });

    await page.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(1200);
    result.checks.wide_no_hash = await probe(page);
    result.screenshots.top = path.join(OUT_DIR, '21-account-top.png');
    await page.screenshot({ path: result.screenshots.top });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.acct-row', { state: 'visible', timeout: 30000 });
    await page.hover('.sidebar');
    await page.waitForTimeout(400);
    await page.click('.acct-row');
    await page.waitForSelector('.acct-menu', { timeout: 10000 });
    await Promise.all([
        page.waitForURL((url) => /\/account#password$/.test(url.toString()), { timeout: 20000 }),
        page.locator('.acct-item', { hasText: '修改密码' }).click(),
    ]);
    await page.waitForSelector('#password', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(1200);
    result.checks.wide_menu = await probe(page);
    result.screenshots.menu = path.join(OUT_DIR, '22-v2-menu-password-target.png');
    await page.screenshot({ path: result.screenshots.menu });
    await wide.close();

    // ---------- 1280×480：改密区在首屏之外，才看得出锚点有没有生效 ----------
    const small = await browser.newContext({ viewport: { width: 1280, height: 480 }, deviceScaleFactor: 1 });
    const sp = await small.newPage();
    sp.on('pageerror', (err) => result.page_errors.push('small: ' + String(err)));
    await login(sp);

    await sp.goto(BASE + '/account#password', { waitUntil: 'domcontentloaded' });
    await sp.waitForSelector('#password', { state: 'attached', timeout: 20000 });
    await sp.waitForTimeout(1200);
    result.checks.small_direct = await probe(sp);
    result.screenshots.small_direct = path.join(OUT_DIR, '23-account-password-hash-480.png');
    await sp.screenshot({ path: result.screenshots.small_direct });

    await sp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await sp.waitForSelector('.acct-row', { state: 'visible', timeout: 30000 });
    await sp.hover('.sidebar');
    await sp.waitForTimeout(400);
    await sp.click('.acct-row');
    await sp.waitForSelector('.acct-menu', { timeout: 10000 });
    await Promise.all([
        sp.waitForURL((url) => /\/account#password$/.test(url.toString()), { timeout: 20000 }),
        sp.locator('.acct-item', { hasText: '修改密码' }).click(),
    ]);
    await sp.waitForSelector('#password', { state: 'attached', timeout: 20000 });
    await sp.waitForTimeout(1200);
    result.checks.small_menu = await probe(sp);
    result.screenshots.small_menu = path.join(OUT_DIR, '24-v2-menu-password-target-480.png');
    await sp.screenshot({ path: result.screenshots.small_menu });
    await small.close();

    await browser.close();
    console.log(JSON.stringify(result, null, 2));

    const visible = (p) => p.password && p.password.top >= 0 && p.password.bottom <= p.viewport.h
        && p.form && p.form.top > 0 && p.form.bottom <= p.viewport.h && p.form_inside_section;
    const scrolled = (p) => p.password && p.password.bottom <= p.viewport.h
        && p.scrollY > 0 && p.scrollY >= p.pageHeight - p.viewport.h - 8
        && p.form && p.form.top > 0 && p.form.top < 320 && p.form_inside_section;
    const ok = visible(result.checks.wide_direct)
        && visible(result.checks.wide_menu)
        && result.checks.wide_no_hash.hash === ''
        && result.checks.wide_no_hash.scrollY === 0
        && scrolled(result.checks.small_direct)
        && scrolled(result.checks.small_menu)
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[account-hash] 失败：', error);
    process.exit(1);
});