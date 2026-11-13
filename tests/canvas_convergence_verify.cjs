#!/usr/bin/env node
/*
 * 产品收敛验收（手动跑，需真实后端 + Playwright + Chrome）：
 *   ① 首页新建直接开 /static/canvas.html（kind=classic / icon 🧩 / 标题「智能画布 HH:MM」）；
 *   ② 画布列表大标题「智能画布」，新建不再弹二选一；
 *   ③ 列表 badge：classic「智能画布」/ smart「旧版」，历史 smart 仍打开 /static/smart-canvas.html；
 *   ④ 素材库分类「智能画布」/「旧版智能画布」；首页 / 列表 / 素材库都没有 BEAT 字样；
 *   ⑤ 旧版回退壳 /static/canvas-list.html 点「开始创作」也直接建 classic 并跳 canvas.html。
 *
 * 跑法：
 *   NOVAI_PORT=3955 NOVAI_DATA_DIR=/tmp/novai-converge venv/bin/python main.py &
 *   BASE=http://127.0.0.1:3955 NODE_PATH=/Users/wepingli/node_modules node tests/canvas_convergence_verify.cjs
 * 截图写到 SHOT（默认 /tmp/novai-converge-shots）。
 */
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:3955';
const SHOT = process.env.SHOT || '/tmp/novai-converge-shots';
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0;
const fails = [];
const ok = (c, l, extra) => {
    if (c) { pass++; console.log('  ✓ ' + l); return; }
    fails.push(l + (extra ? ' -> ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + l + (extra ? ' -> ' + JSON.stringify(extra) : ''));
};
const hasBeat = async (page) => (await page.evaluate(() => document.body.innerText)).includes('BEAT');
const nav = async (page, text) => { await page.getByText(text, { exact: true }).first().click(); await page.waitForTimeout(600); };
const waitCanvasFrame = async (page, file) => page.waitForFunction((f) => {
    const iframe = document.querySelector('#frame-canvas');
    const s = iframe && iframe.getAttribute('src');
    return !!s && s.includes(f);
}, file, { timeout: 15000 });

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('novai-visited', '1'); } catch (e) {} });

    console.log('[A] 首页：默认 classic，无 BEAT');
    const home = await ctx.newPage();
    const created = [];
    home.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/canvases')) { try { created.push(JSON.parse(r.postData() || '{}')); } catch (e) {} } });
    await home.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await home.waitForTimeout(2000);
    await nav(home, '首页');
    await home.waitForSelector('.hp-new', { timeout: 15000 });
    ok(!(await hasBeat(home)), '首页没有 BEAT 字样');
    await home.screenshot({ path: SHOT + '/home.png' });
    await home.click('.hp-new');
    await waitCanvasFrame(home, '/static/canvas.html');
    await home.waitForTimeout(300);
    const homeBody = created[created.length - 1] || {};
    ok(homeBody.kind === 'classic', '首页新建 kind=classic', homeBody.kind);
    ok(homeBody.icon === '🧩', '首页新建 icon=🧩', homeBody.icon);
    ok(/^智能画布 \d{2}:\d{2}$/.test(String(homeBody.title || '')), '标题「智能画布 HH:MM」', homeBody.title);
    const homeFrame = home.frames().find((f) => f.url().includes('/static/canvas.html'));
    ok(!!homeFrame && (await homeFrame.title()) === '智能画布', '打开 canvas.html，页面 title=智能画布', homeFrame && await homeFrame.title());
    await home.screenshot({ path: SHOT + '/home-created-canvas.png' });

    console.log('[B] 画布列表：标题 / badge / 历史 smart');
    const list = await ctx.newPage();
    await list.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await list.waitForTimeout(1500);
    await nav(list, '画布');
    await list.waitForSelector('.cl-hero h1', { timeout: 15000 });
    await list.waitForTimeout(500);
    ok((await list.textContent('.cl-hero h1')) === '智能画布', '大标题是「智能画布」', await list.textContent('.cl-hero h1'));
    ok(!(await hasBeat(list)), '画布列表没有 BEAT 字样');
    ok(!(await list.evaluate(() => document.body.innerText)).includes('AI 驱动的智能工作流'), '新建入口不再出现旧智能画布选项');
    await list.screenshot({ path: SHOT + '/canvas-list.png' });
    const smartCard = list.locator('.cl-card', { hasText: '历史智能画布' }).first();
    ok((await smartCard.count()) === 1, '历史 smart 画布出现在列表');
    const badge = await smartCard.locator('.nv-badge').first().textContent();
    ok(String(badge || '').trim() === '旧版', '历史 smart 画布 badge 是「旧版」', badge);
    await smartCard.locator('.cl-prev').first().click();
    await waitCanvasFrame(list, '/static/smart-canvas.html');
    ok(true, '历史 smart 画布仍能打开 /static/smart-canvas.html');
    await list.screenshot({ path: SHOT + '/canvas-list-smart-opened.png' });

    console.log('[C] 新建画布：直接建 classic');
    const create = await ctx.newPage();
    const created2 = [];
    create.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/canvases')) { try { created2.push(JSON.parse(r.postData() || '{}')); } catch (e) {} } });
    await create.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await create.waitForTimeout(1500);
    await nav(create, '画布');
    await create.waitForSelector('.cl-bar', { timeout: 15000 });
    await create.waitForTimeout(500);
    await create.locator('.cl-bar button.nv-btn.primary', { hasText: '新建画布' }).first().click();
    await waitCanvasFrame(create, '/static/canvas.html');
    await create.waitForTimeout(400);
    const body2 = created2[created2.length - 1] || {};
    ok(body2.kind === 'classic' && body2.icon === '🧩' && /^智能画布 \d{2}:\d{2}$/.test(String(body2.title || '')), '点「新建画布」直接建 classic（不再二选一）', body2);
    ok(!(await create.evaluate(() => !!document.querySelector('.cl-scrim'))), '没有弹出选择器');
    const cf = create.frames().find((f) => f.url().includes('/static/canvas.html'));
    ok(!!cf && (await cf.title()) === '智能画布', '直接打开 /static/canvas.html（title=智能画布）', cf && await cf.title());
    await create.screenshot({ path: SHOT + '/canvas-created.png' });

    console.log('[D] 素材库分类');
    const assets = await ctx.newPage();
    await assets.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await assets.waitForTimeout(1500);
    await nav(assets, '素材库');
    await assets.waitForSelector('.am-tr.par', { timeout: 15000 });
    await assets.waitForTimeout(800);
    const catText = await assets.evaluate(() => [...document.querySelectorAll('.am-tr.par')].map((b) => b.innerText.trim()));
    ok(catText.some((t) => t.includes('智能画布')), '素材库分类显示「智能画布」', catText);
    ok(catText.some((t) => t.includes('旧版智能画布')), '素材库分类显示「旧版智能画布」', catText);
    ok(!(await hasBeat(assets)), '素材库没有 BEAT 字样');
    await assets.screenshot({ path: SHOT + '/assets.png' });

    console.log('[E] 旧版回退壳 canvas-list.html');
    const legacy = await ctx.newPage();
    const created3 = [];
    legacy.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/canvases')) { try { created3.push(JSON.parse(r.postData() || '{}')); } catch (e) {} } });
    await legacy.goto(BASE + '/static/canvas-list.html', { waitUntil: 'domcontentloaded' });
    await legacy.waitForSelector('.hero-title', { timeout: 20000 });
    await legacy.waitForTimeout(1200);
    ok((await legacy.textContent('.hero-title')).trim() === '智能画布', '旧版列表大标题「智能画布」');
    ok(!(await hasBeat(legacy)), '旧版列表没有 BEAT 字样');
    await legacy.click('#btnStartCreate');
    await legacy.waitForURL(/\/static\/canvas\.html/, { timeout: 20000 });
    await legacy.waitForTimeout(1000);
    const body3 = created3[created3.length - 1] || {};
    ok(body3.kind === 'classic' && body3.icon === '🧩' && /^智能画布 \d{2}:\d{2}$/.test(String(body3.title || '')), '旧版列表「开始创作」直接建 classic', body3);
    ok((await legacy.title()) === '智能画布', '旧版列表打开的 canvas.html title=智能画布', await legacy.title());
    await legacy.screenshot({ path: SHOT + '/legacy-created-canvas.png' });

    await browser.close();
    console.log('\n截图：' + SHOT);
    if (fails.length) {
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach((f) => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项）');
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(1); });
