#!/usr/bin/env node
/* auth 关闭时协作客户端必须零渲染、零连接（不注入 DOM / 样式 / WebSocket）。
 *
 *   NODE_PATH='/Users/wepingli/Desktop/OpenArc OS/node_modules' node tests/collab_off_check.cjs
 *   前置：auth-off 后端跑在 $NOVAI_BASE（默认 8896）。
 *
 * 注意：智能画布本来就有素材库同步的 /ws/stats 连接，与本协作无关；
 * 本检查只断言没有 /ws/canvas/* 连接，且没有任何 .collab-* DOM。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:8896';

function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (e) { return ''; } })(),
        path.join(require('os').homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

(async () => {
    const executablePath = chromiumExecutable();
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const sockets = [];
    const errors = [];
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(BASE + '/static/smart-canvas.html?id=collab-off-check', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const state = await page.evaluate(async () => {
        const me = await fetch('/api/auth/me').then((response) => response.json()).catch(() => null);
        return {
            auth_enabled: me && me.auth_enabled,
            collab_global: typeof window.NOVAI_COLLAB,
            collab_dom: document.querySelectorAll('[id^="collab-"], .collab-hud, .collab-avatar, .collab-panel, .collab-remote-cursor, .collab-readonly-banner, .collab-toast, .collab-cursor-layer').length,
            style_tag: Boolean(document.getElementById('collab-style')),
            hud_visible: (() => {
                const el = document.getElementById('collab-hud');
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            })()
        };
    });
    const collabSockets = sockets.filter((url) => /\/ws\/canvas\//.test(url));
    const result = {
        base: BASE,
        state: state,
        allSockets: sockets,
        collabSockets: collabSockets,
        pageErrors: errors,
        zero_render: state.auth_enabled === false
            && state.collab_global === 'undefined'
            && state.collab_dom === 0
            && !state.style_tag
            && !state.hud_visible
            && collabSockets.length === 0
    };
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    process.exit(result.zero_render ? 0 : 1);
})().catch((error) => {
    console.error('[collab-off] 失败：', error);
    process.exit(2);
});
