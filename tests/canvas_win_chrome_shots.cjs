#!/usr/bin/env node
/*
 * 图片大图（StudioLightbox）行为验收 + Windows 三键不重叠（手动/CI 可选，需真实后端）。
 *
 * 跑法：
 *   NOVAI_BASE=http://127.0.0.1:3953 NOVAI_CANVAS=<画布 id> node tests/canvas_win_chrome_shots.cjs
 * 依赖：playwright（NODE_PATH 指到装了 playwright 的目录）+ 系统 Chrome（channel: chrome）。
 *
 * 场景：
 *   windows —— UA 带 pywebview、navigator.platform=Win32，注入 novai:canvas-chrome right=112，
 *              再按 web/src/shell/CanvasChrome.vue 的 .cc-win / .cc-btn 几何画一组假三键；
 *              打开「助手全屏 → 图片大图」后断言：
 *              ① DOM 里没有 studio-lb-close / 关闭按钮；② 窗口三键区域没有任何大图按钮；
 *              ③ 点图片本体不关；④ 点信息栏不关；⑤ 左右切换仍可用；
 *              ⑥ 点空白处关闭；⑦ Esc 仍关闭。
 *   mac / plain —— 同样没有关闭按钮、点空白关闭；不挂 has-win-controls。
 *
 * 另外测量 body 直挂的 .md-lb-x 与 .lightbox .close 的三键让位（这两处保留）。
 * 截图写到 NOVAI_SHOT_DIR（默认 /tmp/novai-win-lightbox-shots）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:3953';
const CANVAS = process.env.NOVAI_CANVAS || '';
const SHOT_DIR = process.env.NOVAI_SHOT_DIR || '/tmp/novai-win-lightbox-shots';
const VIEWPORT = { width: 1280, height: 800 };
const UI = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pywebview', viewport: VIEWPORT };

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fails.push(label + (extra ? ' -> ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + label + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
};
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const lbOpen = (page) => page.evaluate(() => document.querySelectorAll('.studio-lb').length);
const waitClosed = async (page) => page.waitForFunction(() => document.querySelectorAll('.studio-lb').length === 0, null, { timeout: 5000 });
const waitOpen = async (page) => page.waitForSelector('.studio-lb', { state: 'visible', timeout: 10000 });

async function openLightbox(page) {
  await page.waitForSelector('[data-review-node="dbg1"]', { timeout: 15000 });
  await page.click('#aFull');
  await page.waitForFunction(() => document.querySelector('#agent')?.classList.contains('full'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.click('[data-review-node="dbg1"]');
  await waitOpen(page);
  await page.waitForTimeout(400);
}

async function measureChromeInsets(page) {
  const md = await page.evaluate(() => {
    const box = document.createElement('div');
    box.className = 'md-lb';
    const x = document.createElement('button');
    x.className = 'md-lb-x';
    box.appendChild(x);
    document.body.appendChild(box);
    const r = x.getBoundingClientRect();
    const out = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cssRight: getComputedStyle(x).right };
    box.remove();
    return out;
  });
  const lbClose = await page.evaluate(() => {
    const root = document.querySelector('.cn-root');
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    const c = document.createElement('button');
    c.className = 'close';
    lb.appendChild(c);
    root.appendChild(lb);
    const r = c.getBoundingClientRect();
    const out = { cssRight: getComputedStyle(c).right, left: r.left, right: r.right };
    lb.remove();
    return out;
  });
  return { md, lbClose };
}

async function openScenario(browser, name, chrome) {
  console.log('\n[' + name + ']');
  const ctx = await browser.newContext(UI);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    window.pywebview = { api: {} };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror] ' + String(e.message).slice(0, 200)));
  await page.goto(BASE + '/static/canvas.html?id=' + encodeURIComponent(CANVAS) + '&debugGen=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cn-root', { timeout: 20000 });
  await page.waitForTimeout(2200);
  if (chrome) {
    await page.evaluate((c) => window.postMessage({ type: 'novai:canvas-chrome', left: c.left, right: c.right, top: c.top }, '*'), chrome);
    await page.waitForTimeout(400);
  }
  if (name === 'windows') {
    // 照 CanvasChrome.vue：.cc-win fixed top16 right16 height40 display:flex gap4；.cc-btn 32x32
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'mock-win-controls';
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText = 'position:fixed;top:16px;right:16px;height:40px;z-index:99999;display:flex;align-items:center;gap:4px;pointer-events:none;box-sizing:content-box';
      for (const t of ['—', '□', '×']) {
        const b = document.createElement('button');
        b.textContent = t;
        b.style.cssText = 'width:32px;height:32px;border:0;border-radius:9px;background:rgba(255,255,255,.2);color:#fff;font:14px/1 system-ui;box-sizing:border-box';
        d.appendChild(b);
      }
      document.body.appendChild(d);
    });
  }
  await page.keyboard.press('Control+J');
  await openLightbox(page);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });

  // ① 没有关闭按钮
  const closeCount = await page.evaluate(() => document.querySelectorAll('.studio-lb-close, .studio-lb [aria-label="关闭"]').length);
  ok(closeCount === 0, '① 大图里没有 studio-lb-close / 关闭按钮', closeCount);
  ok((await lbOpen(page)) === 1, '大图已打开');

  // ② Windows 三键区域没有大图按钮（上一轮的关闭按钮已删，左右切换在垂直居中）
  if (name === 'windows') {
    const overlap = await page.evaluate(() => {
      const win = document.querySelector('#mock-win-controls').getBoundingClientRect();
      return [...document.querySelectorAll('.studio-lb button')].filter((b) => {
        if (b.getClientRects().length === 0) return false;
        const r = b.getBoundingClientRect();
        return r.left < win.right && win.left < r.right && r.top < win.bottom && win.top < r.bottom;
      }).map((b) => b.getAttribute('aria-label') || b.className);
    });
    ok(overlap.length === 0, '② 窗口三键区域没有大图按钮重叠', overlap);
    const winClass = await page.evaluate(() => document.querySelector('.cn-root').classList.contains('has-win-controls'));
    ok(winClass === true, 'has-win-controls 已挂上（Windows 外壳）');
  }

  // ③ 点图片本体不关闭
  await page.click('.studio-lb-stage img');
  await page.waitForTimeout(250);
  ok((await lbOpen(page)) === 1, '③ 点图片本体不关闭', await lbOpen(page));

  // ④ 点信息栏不关闭
  await page.click('.studio-lb-bar');
  await page.waitForTimeout(250);
  ok((await lbOpen(page)) === 1, '④ 点信息栏不关闭', await lbOpen(page));

  // ⑤ 左右切换仍可用
  const before = await page.textContent('.studio-lb-count');
  await page.click('.studio-lb-nav.next');
  await page.waitForTimeout(250);
  const after = await page.textContent('.studio-lb-count');
  ok((await lbOpen(page)) === 1 && before !== after && /2 \/ 3/.test(String(after)), '⑤「下一张」切换且不关闭', { before, after });

  // ⑥ 点空白处关闭（左上角 padding 空处，不在图片 / 信息栏 / 切换按钮上）
  await page.mouse.click(12, 10);
  await waitClosed(page);
  ok((await lbOpen(page)) === 0, '⑥ 点空白处关闭');
  if (name === 'windows') await page.screenshot({ path: path.join(SHOT_DIR, name + '-closed.png') });

  // ⑦ Esc 仍关闭
  await page.click('[data-review-node="dbg1"]');
  await waitOpen(page);
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await waitClosed(page);
  ok((await lbOpen(page)) === 0, '⑦ Esc 关闭');

  // 其它查看器（.md-lb-x / .lightbox .close）的三键让位仍在
  const insets = await measureChromeInsets(page);
  if (name === 'windows') {
    ok(insets.md.cssRight === '130px', '.md-lb-x 仍右内缩 130px', insets.md.cssRight);
    ok(insets.lbClose.cssRight === '132px', '.lightbox .close 仍右内缩 132px', insets.lbClose.cssRight);
  } else {
    ok(insets.md.cssRight === '18px', '.md-lb-x 普通条件仍是 18px', insets.md.cssRight);
    ok(insets.lbClose.cssRight === '20px', '.lightbox .close 普通条件仍是 20px', insets.lbClose.cssRight);
    const rootClass = await page.evaluate(() => document.querySelector('.cn-root').classList.contains('has-win-controls'));
    ok(rootClass === false, 'has-win-controls 不生效（mac / 普通浏览器）');
  }

  await ctx.close();
}

async function checkCanvasTopBars(browser, name, chrome) {
  const isMac = name === 'mac';
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: isMac ? 2 : 1,
    userAgent: isMac
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pywebview'
      : UI.userAgent,
  });
  await ctx.addInitScript((mac) => {
    Object.defineProperty(navigator, 'platform', { get: () => (mac ? 'MacIntel' : 'Win32') });
    window.pywebview = { api: {} };
    try { localStorage.setItem('novai-visited', '1'); } catch (e) {}
  }, isMac);
  const page = await ctx.newPage();
  await page.goto(BASE + '/static/canvas.html?id=' + encodeURIComponent(CANVAS) + '&debugGen=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cn-root', { timeout: 20000 });
  await page.waitForTimeout(1600);
  await page.evaluate((c) => window.postMessage({ type: 'novai:canvas-chrome', left: c.left, right: c.right, top: c.top }, '*'), chrome);
  await page.waitForTimeout(400);
  // 假窗口按钮：mac 原生红绿灯（12px 圆、左 7 / 顶 20 → 中心 26）；windows 右上三键（32px、right 16 / top 16）
  await page.evaluate((mac) => {
    const d = document.createElement('div');
    d.id = 'mock-shell-controls';
    if (mac) {
      // 12px 按钮 + 8px 间距、左缘 20：三灯右缘 = 20+36+16 = 72，中心 y=20+6=26（对齐 TapNow / trafficLightPosition x=20）
      d.style.cssText = 'position:fixed;top:20px;left:20px;height:12px;z-index:99999;display:flex;align-items:center;gap:8px;pointer-events:none';
      for (let i = 0; i < 3; i += 1) { const b = document.createElement('span'); b.style.cssText = 'display:block;width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,.5)'; d.appendChild(b); }
    } else {
      d.style.cssText = 'position:fixed;top:16px;right:16px;height:40px;z-index:99999;display:flex;align-items:center;gap:4px;pointer-events:none';
      for (const t of ['—', '□', '×']) { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'width:32px;height:32px;border:0;border-radius:9px;background:rgba(255,255,255,.2);color:#fff;font:14px/1 system-ui'; d.appendChild(b); }
    }
    document.body.appendChild(d);
  }, isMac);
  const data = await page.evaluate(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, centerY: (r.top + r.bottom) / 2 }; };
    const ctl = document.querySelector('#mock-shell-controls');
    const c = ctl.getBoundingClientRect();
    return {
      tl: rect('#tl'), tr: rect('#tr'),
      controls: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, centerY: (c.top + c.bottom) / 2 },
      chromeTop: getComputedStyle(document.querySelector('.cn-root')).getPropertyValue('--cn-chrome-top'),
      scale: Number((getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale') || '1').trim()),
    };
  });
  await page.screenshot({ path: path.join(SHOT_DIR, 'topbars-' + name + '.png') });
  ok(!!data.tl && !!data.tr, name + ' #tl/#tr 存在', data);
  if (data.tl && data.tr) {
    const expectedTop = isMac ? 12 : 16;
    ok(data.chromeTop.trim() === expectedTop + 'px', name + ' --cn-chrome-top=' + expectedTop + 'px', data.chromeTop);
    ok(Math.round(data.tl.top) === expectedTop && Math.round(data.tr.top) === expectedTop, name + ' #tl/#tr top=' + expectedTop, { tl: data.tl.top, tr: data.tr.top });
    ok(Math.round(data.tl.centerY) === expectedTop + 20 && Math.round(data.tr.centerY) === expectedTop + 20, name + ' pill 中心=' + (expectedTop + 20), { tl: data.tl.centerY, tr: data.tr.centerY });
    ok(data.scale === 1, name + ' 页面缩放=1', data.scale);
    if (isMac) {
      ok(data.tl.left >= data.controls.right + 8, 'mac 顶栏让开红绿灯（left ≥ 灯右缘+8）', { tlLeft: data.tl.left, lightsRight: data.controls.right });
      ok(!(data.tl.left < data.controls.right && data.tl.top < data.controls.bottom && data.controls.top < data.tl.bottom), 'mac 顶栏与红绿灯不重叠');
    } else {
      ok(data.tr.right <= data.controls.left - 8, 'windows #tr 与三键间距 ≥8px', { trRight: data.tr.right, controlsLeft: data.controls.left });
    }
  }
  await ctx.close();
}

(async () => {
  if (!CANVAS) { console.error('缺少 NOVAI_CANVAS（画布 id）'); process.exit(2); }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await openScenario(browser, 'windows', { left: 0, right: 112, top: 16 });
    await openScenario(browser, 'mac', { left: 84, right: 0, top: 12 });
    await openScenario(browser, 'plain', null);
    await checkCanvasTopBars(browser, 'mac', { left: 84, right: 0, top: 12 });
    await checkCanvasTopBars(browser, 'windows', { left: 0, right: 112, top: 16 });
  } finally {
    await browser.close();
  }
  console.log('\n截图目录：' + SHOT_DIR);
  if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
  }
  console.log('全部通过（' + pass + ' 项）');
})().catch((err) => { console.error('测试异常：', err && err.stack || err); process.exit(1); });
