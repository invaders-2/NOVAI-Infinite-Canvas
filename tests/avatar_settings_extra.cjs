#!/usr/bin/env node
/*
 * 补充验收：旧外壳设置入口的 API 设置门禁 + auth-off 下 V2 仍可见 API 设置。
 *   NOVAI_BASE=http://127.0.0.1:8897 node tests/avatar_settings_extra.cjs
 *   NOVAI_OFF_BASE=http://127.0.0.1:8896（auth-off 服务）同样可用
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8897';
const OFF_BASE = process.env.NOVAI_OFF_BASE || 'http://127.0.0.1:8896';
const ADMIN = { username: 'admin', password: 'admin12345' };
const MEMBER = { username: process.env.NOVAI_MEMBER || 'avatar_demo2', password: 'avatar-demo-123' };

async function login(page, account) {
    await page.goto(BASE + '/login?next=' + encodeURIComponent('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible' });
    await page.fill('#username', account.username);
    await page.fill('#password', account.password);
    await Promise.all([
        page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 30000 }),
        page.click('#submit'),
    ]);
}

(async () => {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        chromium.executablePath(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ].filter(Boolean);
    const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const result = { checks: {}, page_errors: [] };

    // ---------- 旧外壳 /legacy：成员看不到 API 设置，切过去回退；管理员照旧 ----------
    const legacy = async (account, key) => {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => result.page_errors.push(key + ': ' + String(e)));
        await login(page, account);
        await page.goto(BASE + '/legacy', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#settings-modal', { state: 'attached', timeout: 30000 });
        await page.waitForTimeout(1200);
        result.checks[key] = await page.evaluate(() => {
            if (typeof openSettingsModal !== 'function') return { error: 'openSettingsModal missing' };
            openSettingsModal();
            const tab = document.querySelector('.settings-tab[data-settings-tab="api-settings"]');
            const visible = tab && tab.style.display !== 'none' && !tab.hidden;
            switchSettingsTab('api-settings');
            const active = document.querySelector('.settings-tab.active');
            return {
                api_tab_visible: !!visible,
                active_after_switch: active ? active.dataset.settingsTab : '',
                hide_head: document.getElementById('settings-modal').classList.contains('settings-hide-head'),
            };
        });
        await ctx.close();
    };
    await legacy(MEMBER, 'legacy_member');
    await legacy(ADMIN, 'legacy_admin');

    // ---------- auth-off：本地单机模式，API 设置仍应可见 ----------
    const offCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const offPage = await offCtx.newPage();
    offPage.on('pageerror', (e) => result.page_errors.push('auth_off: ' + String(e)));
    await offPage.goto(OFF_BASE + '/', { waitUntil: 'domcontentloaded' });
    await offPage.waitForSelector('.nav-item', { state: 'visible', timeout: 30000 });
    const welcome = offPage.locator('.wel .nv-btn.primary');
    if (await welcome.count()) {
        await welcome.click();
        await offPage.waitForSelector('.wel', { state: 'detached', timeout: 10000 });
    }
    await offPage.hover('.sidebar');
    await offPage.waitForTimeout(380);
    await offPage.click('.sidebar .settings-toggle');
    await offPage.waitForSelector('.smodal', { timeout: 15000 });
    await offPage.waitForTimeout(400);
    result.checks.auth_off_tabs = (await offPage.locator('.smodal .tab').allTextContents()).map((s) => s.trim());
    await offCtx.close();

    await browser.close();
    console.log(JSON.stringify(result, null, 2));

    const m = result.checks;
    const ok = m.legacy_member && m.legacy_member.api_tab_visible === false
        && m.legacy_member.active_after_switch === 'general'
        && m.legacy_admin && m.legacy_admin.api_tab_visible === true
        && m.auth_off_tabs.includes('API 设置')
        && result.page_errors.length === 0;
    if (!ok) process.exitCode = 1;
})().catch((error) => {
    console.error('[avatar-settings-extra] 失败：', error);
    process.exit(1);
});
