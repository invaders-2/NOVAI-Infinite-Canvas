#!/usr/bin/env node
'use strict';
/*
 * 复现 + 量化：「生成中」工具条悬停「× 停止」时，灰色滑块 .cn-fm-hl 与按钮（以及指针下那颗按钮）的偏差。
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-hl-verify python3 main.py &
 *   node tests/novai_toolbar_highlight_probe.cjs
 *
 * 手法：拦截 /api/canvas-image-tasks 返回永远 running 的任务 → 节点进入真实生成态；
 *       页面里装采样器：hover 后按 0/60/200/600ms 采「滑块 vs 指针下那颗按钮」的几何差；
 *       对比组：有结果的图片节点（12 项工具条）直接落按钮 / 落空位后滑入另一颗。
 * 输出：tests/artifacts/toolbar-hl/*.png + result-toolbar-hl.json
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT = path.join(__dirname, 'artifacts', process.env.NOVAI_HL_OUT || 'toolbar-hl');

const PAGE_HELPERS = String.raw`
window.__hlProbe = (() => {
  const num = (v) => Math.round(v * 100) / 100;
  if (!window.__hlPointerHooked) {
    window.__hlPointerHooked = true;
    window.__hlPx = null; window.__hlPy = null;
    addEventListener('pointermove', (e) => { window.__hlPx = e.clientX; window.__hlPy = e.clientY; }, true);
    addEventListener('pointerover', (e) => { window.__hlPx = e.clientX; window.__hlPy = e.clientY; }, true);
  }
  function localScale(menu) {
    let scale = 1;
    for (let node = menu; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      const zoom = parseFloat(cs.zoom);
      if (zoom > 0) scale *= zoom;
      const transform = cs.transform;
      if (transform && transform !== 'none') {
        const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
        if (values.length >= 4) scale *= Math.hypot(values[0], values[1]) || 1;
      }
      const own = cs.scale;
      if (own && own !== 'none') { const ownScale = Math.abs(parseFloat(own)); if (ownScale > 0) scale *= ownScale; }
    }
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }
  const labelOf = (btn) => btn ? btn.querySelector(':scope > .cn-fm-label') : null;
  function natural(span, scale) {
    if (!span) return 0;
    try { const r = document.createRange(); r.selectNodeContents(span); return r.getBoundingClientRect().width / scale; }
    catch (e) { return (span.scrollWidth || 0) / scale; }
  }
  function growth(btn, scale) {
    const span = labelOf(btn); if (!span) return 0;
    const rendered = span.getBoundingClientRect().width / scale + (parseFloat(getComputedStyle(span).marginLeft) || 0);
    return Math.max(0, natural(span, scale) + 5 - rendered);
  }
  function metricsFor(menu, btn, scale) {
    if (!btn || !menu) return null;
    const menuRect = menu.getBoundingClientRect();
    const rect = btn.getBoundingClientRect();
    const buttons = Array.from(menu.querySelectorAll(':scope > .cn-fm-btn'));
    let shift = 0;
    for (const item of buttons) { if (item === btn) break; shift += growth(item, scale); }
    const PAD_X = 6, HL_INSET = 3;
    // 复刻修复后的算法：clamp 的可用宽度按「展开后的总宽」（= 当前宽 + 所有按钮剩余成长量，再夹 max-width）
    let totalGrowth = 0;
    for (const item of buttons) totalGrowth += growth(item, scale);
    const maxW = parseFloat(getComputedStyle(menu).maxWidth) || Infinity;
    const finalW = Math.min(menu.clientWidth + totalGrowth, maxW);
    const innerW = Math.max(0, finalW - PAD_X * 2);
    const width = Math.min(Math.max(rect.width / scale + growth(btn, scale) - HL_INSET * 2, 0), innerW);
    const rawLeft = (rect.left - menuRect.left) / scale + shift + HL_INSET;
    const left = Math.min(Math.max(rawLeft, PAD_X), Math.max(PAD_X, finalW - PAD_X - width));
    return {
      tb: btn.getAttribute('data-tb') || btn.getAttribute('data-tk') || btn.getAttribute('data-k') || '?',
      rect: { left: num(rect.left), width: num(rect.width), height: num(rect.height), top: num(rect.top) },
      relLeft: num(rect.left - menuRect.left),
      growth: num(growth(btn, scale)),
      shift: num(shift),
      correct: { left: num(left), width: num(width), rawLeft: num(rawLeft), clamped: Math.abs(left - rawLeft) > 0.01 },
      finalW: num(finalW), totalGrowth: num(totalGrowth), maxW: Number.isFinite(maxW) ? num(maxW) : null,
    };
  }
  function snapshot(label, t0, targetSelector) {
    const menu = document.querySelector('#ntb');
    const hl = menu && menu.querySelector('.cn-fm-hl');
    const est = menu && menu.querySelector('.est');
    const scale = menu ? localScale(menu) : 1;
    const menuRect = menu ? menu.getBoundingClientRect() : null;
    const buttons = menu ? Array.from(menu.querySelectorAll(':scope > .cn-fm-btn')) : [];
    const px = window.__hlPx, py = window.__hlPy;
    const under = (px != null && py != null) ? (buttons.find((b) => { const r = b.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom; }) || null) : null;
    const target = menu && targetSelector ? menu.querySelector(targetSelector) : null;
    const hlRect = hl ? hl.getBoundingClientRect() : null;
    const actual = metricsFor(menu, under, scale);
    const targetMetrics = metricsFor(menu, target, scale);
    const span = labelOf(under);
    const hlInline = hl ? { left: parseFloat(hl.style.left || '0'), top: parseFloat(hl.style.top || '0'), width: parseFloat(hl.style.width || '0'), height: parseFloat(hl.style.height || '0'), opacity: hl.style.opacity } : null;
    const hlCss = hl ? { left: getComputedStyle(hl).left, width: getComputedStyle(hl).width, top: getComputedStyle(hl).top, height: getComputedStyle(hl).height, opacity: getComputedStyle(hl).opacity } : null;
    return {
      label, t: num(performance.now() - t0),
      opened: menu ? menu.classList.contains('opened') : null,
      pointer: { x: px == null ? null : num(px), y: py == null ? null : num(py) },
      dpr: window.devicePixelRatio,
      transform: menu ? getComputedStyle(menu).transform : null,
      zoom: menu ? getComputedStyle(menu).zoom : null,
      bar: menuRect ? { left: num(menuRect.left), width: num(menuRect.width), clientWidth: menu.clientWidth, offsetWidth: menu.offsetWidth } : null,
      marginLeft: menu ? (menu.style.marginLeft || '') : null,
      menuMaxWidth: menu ? getComputedStyle(menu).maxWidth : null,
      menuMaxWidthParsed: menu ? parseFloat(getComputedStyle(menu).maxWidth) : null,
      hl: { inline: hlInline, css: hlCss, rect: hlRect ? { left: num(hlRect.left), width: num(hlRect.width), right: num(hlRect.right), top: num(hlRect.top), height: num(hlRect.height) } : null },
      actual,
      target: targetMetrics,
      labelInlineMaxWidth: span ? (span.style.maxWidth || '') : null,
      underTb: actual ? actual.tb : null,
      delta: (actual && hlRect) ? { left: num(hlRect.left - (menuRect.left + actual.correct.left)), width: num(hlRect.width - actual.correct.width) } : null,
    };
  }
  return {
    before(targetSelector) { return snapshot('before', performance.now(), targetSelector); },
    start(targetSelector) {
      const t0 = performance.now();
      window.__hlSamples = [];
      const push = (label) => { try { window.__hlSamples.push(snapshot(label, t0, targetSelector)); } catch (error) { window.__hlSamples.push({ label, error: String(error) }); } };
      [0, 60, 200, 600].forEach((delay) => setTimeout(() => push('t' + delay), delay));
      return t0;
    },
    read() { return window.__hlSamples || []; },
    diagnose() {
      const menu = document.querySelector('#ntb');
      const cs = getComputedStyle(menu);
      return { maxWidthComputed: cs.maxWidth, parseFloatMaxWidth: parseFloat(cs.maxWidth), clientWidth: menu.clientWidth, offsetWidth: menu.offsetWidth, transition: cs.transitionProperty + ' ' + cs.transitionDuration };
    },
  };
})();
`;

const installProbe = (page) => page.evaluate(PAGE_HELPERS);
const grid = (row) => {
    const act = row.actual, hl = row.hl;
    const d = row.delta;
    return [
        row.label.padEnd(6),
        't=' + String(row.t).padStart(6),
        row.opened ? 'OPEN' : '----',
        'under=' + (row.underTb || '-').padEnd(8),
        'ptr=' + (row.pointer.x == null ? '-' : Math.round(row.pointer.x)),
        act ? ('btn.relL=' + act.relLeft + ' W=' + act.rect.width) : 'btn=?',
        act ? ('correct[L=' + act.correct.left + ' W=' + act.correct.width + (act.correct.clamped ? ' CLAMPED' : '') + ']') : '',
        hl.rect ? ('hl[relL=' + Math.round((hl.rect.left - (row.bar.left)) * 10) / 10 + ' W=' + hl.rect.width + ']') : 'hl=?',
        d ? ('ΔL=' + d.left + ' ΔW=' + d.width + (Math.abs(d.left) > 1.5 || Math.abs(d.width) > 1.5 ? ' ←偏' : ' ok')) : '',
        'marginL=' + (row.marginLeft || '-'),
    ].filter(Boolean).join(' | ');
};

async function hoverAt(page, x, y, steps) {
    await page.mouse.move(x, y, steps ? { steps } : undefined);
}
async function moveAway(page) {
    await page.mouse.move(20, 20);
    await page.waitForTimeout(500);
}
async function sampleSingle(page, selector, label) {
    await moveAway(page);
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error('找不到 ' + selector);
    const before = await page.evaluate((sel) => window.__hlProbe.before(sel), selector);
    await page.evaluate((sel) => window.__hlProbe.start(sel), selector);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1100);
    return { label, selector, before, samples: await page.evaluate(() => window.__hlProbe.read()) };
}
async function sampleSlide(page, fromSelector, toSelector, steps, label) {
    await moveAway(page);
    const from = await page.locator(fromSelector).first().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.waitForTimeout(900); // 先让第一颗冻结（正常用户也会先悬停一颗）
    const to = await page.locator(toSelector).first().boundingBox();
    await page.evaluate((sel) => window.__hlProbe.start(sel), toSelector);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps });
    await page.waitForTimeout(1000);
    return { label, selector: toSelector, samples: await page.evaluate(() => window.__hlProbe.read()) };
}
/** 工具条的 left 会在展开/补偿归零时二次移动：反复「量当前位置 → 移过去 → 确认指针真的落在这颗按钮上」 */
async function hoverStable(page, selector, tries = 6) {
    const wanted = (selector.match(/data-tb="([^"]+)"/) || [])[1];
    for (let i = 0; i < tries; i += 1) {
        const box = await page.locator(selector).first().boundingBox();
        if (!box) throw new Error('找不到 ' + selector + ' 的位置');
        const vw = page.viewportSize().width;
        const x = Math.min(box.x + box.width / 2, vw - 2);
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.waitForTimeout(220);
        const snap = await page.evaluate((sel) => window.__hlProbe.before(sel), selector);
        if (snap && snap.underTb === wanted) return snap;
    }
    throw new Error('悬停不稳，没能落在 ' + selector + ' 上');
}
/** 指针已经停稳后开启采样（不再移动），用于窄视口 clamp 回归 */
async function sampleStationary(page, selector) {
    await page.evaluate((sel) => window.__hlProbe.start(sel), selector);
    await page.waitForTimeout(800);
    return page.evaluate(() => window.__hlProbe.read());
}

async function shotTimeline(page, selector, prefix) {
    const box = await page.locator('#ntb').first().boundingBox();
    const clip = { x: Math.max(0, Math.floor(box.x - 24)), y: Math.max(0, Math.floor(box.y - 24)), width: Math.ceil(box.width + 48), height: Math.ceil(box.height + 48) };
    const files = [];
    for (const delay of [0, 60, 200, 600]) {
        await moveAway(page);
        const btn = await page.locator(selector).first().boundingBox();
        await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
        if (delay) await page.waitForTimeout(delay);
        const file = path.join(OUT, prefix + '-' + String(delay).padStart(3, '0') + 'ms.png');
        await page.screenshot({ path: file, clip });
        files.push(file);
        console.log('SHOT  ' + file);
    }
    return files;
}

(async () => {
    const c = H.checker('工具条灰底滑块偏差（复现 + 量化）');
    fs.mkdirSync(OUT, { recursive: true });
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const result = { groups: [], notes: {} };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) { c.check('后端 ' + H.BASE + ' 可用', false, { status: health.status() }); return c.finish(); }
        const realConfig = await health.json();
        const provider = { id: 'fake', name: 'Fake', base_url: 'http://127.0.0.1:9/v1', protocol: 'openai', enabled: true, primary: true, has_key: true, image_models: ['gpt-image-1'], chat_models: [], video_models: [], audio_models: [] };
        const config = Object.assign({}, realConfig, { api_providers: [provider], image_models: ['gpt-image-1'], image_model: 'gpt-image-1' });

        canvasId = await H.createCanvas(api, 'VERIFY-HL-' + Date.now());
        browser = await H.launchBrowser();
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));
        await page.route('**/api/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(config) }));
        await page.route('**/api/canvas-image-tasks', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'hang-1' }) }));
        await page.route('**/api/canvas-image-tasks/hang-1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running' }) }));
        await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window.__cn && window.__cn.state && window.__cn.state.doc), null, { timeout: 30000 });
        await page.waitForTimeout(700);
        await installProbe(page);

        /* 生成中的节点（真实 running 态） */
        const runId = await page.evaluate(() => {
            const store = window.__cn;
            const node = store.newNode('image', 200, 160, { prompt: '滑块宽度验证用的提示词', title: '生成中滑块验证图' });
            store.addNodes([node], [], { select: true });
            return node.id;
        });
        await page.waitForTimeout(800);
        await page.locator('[data-p="send"]').first().click();
        await page.waitForFunction(() => document.querySelector('#ntb .est[data-running="1"]') !== null, null, { timeout: 15000 });
        await page.waitForTimeout(500);
        c.check('R1 节点进入真实生成态（工具条 = 生成中 + 停止）', await page.locator('#ntb .est[data-running="1"]').count() === 1 && await page.locator('#ntb [data-tb="stop"]').count() === 1);
        c.check('R2 .est 是裸 span、不在 buttonsOf 里', await page.locator('#ntb .est.cn-fm-btn').count() === 0);
        result.notes.runId = runId;

        // 截图 4 个时点（直接在折叠态悬停到按钮上）
        result.screenshots = { running: await shotTimeline(page, '#ntb [data-tb="stop"]', '01-running-hover-stop') };

        // A. 直接落在停止按钮上（Boss 的路径）
        result.groups.push(await sampleSingle(page, '#ntb [data-tb="stop"]', 'A 生成中·直接落停止'));
        result.notes.diagRunning = await page.evaluate(() => window.__hlProbe.diagnose());

        // D. 先落在「生成中」徽标上，等展开完，再移入停止
        await moveAway(page);
        const badge = await page.locator('#ntb .est').first().boundingBox();
        await page.mouse.move(badge.x + badge.width / 2, badge.y + badge.height / 2);
        await page.waitForTimeout(400);
        const stop2 = await page.locator('#ntb [data-tb="stop"]').first().boundingBox();
        await page.evaluate(() => window.__hlProbe.start('#ntb [data-tb="stop"]'));
        await page.mouse.move(stop2.x + stop2.width / 2, stop2.y + stop2.height / 2, { steps: 6 });
        await page.waitForTimeout(900);
        result.groups.push({ label: 'D 生成中·先落徽标再移入', selector: '#ntb [data-tb="stop"]', samples: await page.evaluate(() => window.__hlProbe.read()) });
        result.screenshots.runningViaBadge = await shotTimeline(page, '#ntb [data-tb="stop"]', '03-running-via-badge');

        // R. prefers-reduced-motion: reduce：没有过渡，展开瞬时完成，A 组应当直接正确
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(300);
        result.groups.push(await sampleSingle(page, '#ntb [data-tb="stop"]', 'R 生成中·无动画(reduced-motion)'));
        await page.emulateMedia({ reducedMotion: null });

        /* 普通 12 项工具条 */
        const normalId = await page.evaluate(() => {
            const store = window.__cn;
            const node = store.newNode('image', 620, 160, { hist: [{ url: '/output/hl-seed.png', w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '普通工具条对照图' });
            store.addNodes([node], [], { select: true });
            return node.id;
        });
        await page.waitForTimeout(900);
        c.check('N1 对照组是普通 12 项图片工具条', await page.locator('#ntb [data-tb="lossless"]').count() === 1 && await page.locator('#ntb .est').count() === 0);
        result.notes.normalId = normalId;
        result.groups.push(await sampleSingle(page, '#ntb [data-tb="adjust"]', 'B 普通·直接落中间'));
        result.notes.diagNormal = await page.evaluate(() => window.__hlProbe.diagnose());
        result.groups.push(await sampleSingle(page, '#ntb [data-tb="full"]', 'C 普通·直接落最后一颗'));
        result.groups.push(await sampleSlide(page, '#ntb [data-tb="full"]', '#ntb [data-tb="lib"]', 10, 'E 普通·从最后一颗滑到素材库'));
        result.screenshots.normal = await shotTimeline(page, '#ntb [data-tb="adjust"]', '02-normal-hover-middle');
        // 普通条「最后一颗」截图
        await moveAway(page);
        const lastBox = await page.locator('#ntb [data-tb="full"]').first().boundingBox();
        await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
        await page.waitForTimeout(700);
        result.screenshots.normalLast = await (async () => {
            const bar = await page.locator('#ntb').first().boundingBox();
            const clip = { x: Math.max(0, Math.floor(bar.x - 24)), y: Math.max(0, Math.floor(bar.y - 24)), width: Math.ceil(bar.width + 48), height: Math.ceil(bar.height + 48) };
            const file = path.join(OUT, '05-normal-hover-last.png');
            await page.screenshot({ path: file, clip });
            console.log('SHOT  ' + file);
            return file;
        })();

        /* F. 回归重点：窄视口 → 12 项条被 max-width 截断，末尾按钮溢出，滑块必须夹在胶囊内
           做法：先悬停第一颗让条展开（位置稳定），再移到一颗「本身会溢出胶囊」的按钮（下载 dl）上 */
        await page.setViewportSize({ width: 900, height: 950 });
        await page.evaluate((id) => window.__cn.updateNode(id, (n) => ({ ...n, x: 0 })), normalId);
        await page.waitForTimeout(900);
        await moveAway(page);
        const firstBox = await page.locator('#ntb [data-tb="crop"]').first().boundingBox();
        await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
        await page.waitForTimeout(600); // 展开完成
        await hoverStable(page, '#ntb [data-tb="dl"]');
        result.notes.narrow = { viewport: 900, bar: await page.locator('#ntb').first().boundingBox(), dlButton: await page.locator('#ntb [data-tb="dl"]').first().boundingBox() };
        result.groups.push({ label: 'F 普通·窄视口(900)截断时落会溢出的「下载」', selector: '#ntb [data-tb="dl"]', samples: await sampleStationary(page, '#ntb [data-tb="dl"]') });
        {
            const bar = await page.locator('#ntb').first().boundingBox();
            const vp = page.viewportSize();
            // 窄视口：直接从 0 截到视口右缘，才能同时看到「胶囊内边的滑块」和「溢出胶囊的按钮」
            const clip = { x: 0, y: Math.max(0, Math.floor(bar.y - 24)), width: Math.min(vp.width, 900), height: Math.ceil(bar.height + 48) };
            const file = path.join(OUT, '06-narrow-clamp-last.png');
            await page.screenshot({ path: file, clip });
            console.log('SHOT  ' + file);
            result.screenshots.narrow = file;
        }
        await page.screenshot({ path: path.join(OUT, '04-normal-toolbar-full.png') });

        /* G. 稳定的对照截图：恢复宽视口 → 条展开后分别悬停「中间(调色)」和「末尾(全屏)」 */
        await page.setViewportSize({ width: 1500, height: 950 });
        await page.waitForTimeout(700);
        await moveAway(page);
        {
            const first = await page.locator('#ntb [data-tb="crop"]').first().boundingBox();
            await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
            await page.waitForTimeout(600); // 展开完成，位置稳定
        }
        const barShot = async (name) => {
            const bar = await page.locator('#ntb').first().boundingBox();
            const clip = { x: Math.max(0, Math.floor(bar.x - 24)), y: Math.max(0, Math.floor(bar.y - 24)), width: Math.ceil(bar.width + 48), height: Math.ceil(bar.height + 48) };
            const file = path.join(OUT, name);
            await page.screenshot({ path: file, clip });
            console.log('SHOT  ' + file);
            return file;
        };
        await hoverStable(page, '#ntb [data-tb="adjust"]');
        result.screenshots.normalMiddleStable = await barShot('07-normal-middle-stable.png');
        await hoverStable(page, '#ntb [data-tb="full"]');
        result.screenshots.normalLastStable = await barShot('08-normal-last-stable.png');

        /* ---------- 断言：修复后 200/600ms 必须归零 ---------- */
        const rowOf = (group, label) => (group.samples || []).find((row) => row.label === label);
        // 指针停稳后（200/600ms）必须对上；指针已经不在任何按钮上时（under=null）滑块会被隐藏，算合格
        const deltaOk = (row) => {
            if (!row) return false;
            if (row.delta) return Math.abs(row.delta.left) <= (row.label === 't200' ? 5 : 1) && Math.abs(row.delta.width) <= (row.label === 't200' ? 2 : 1);
            // 指针已经不在按钮上：滑块淡出中（opacity→0）也算合格，只要不是「亮着却错位」
            return !row.underTb && row.hl && row.hl.css && parseFloat(row.hl.css.opacity) < 0.02;
        };
        const byLabel = (label) => result.groups.find((group) => group.label.indexOf(label) === 0);
        const A = byLabel('A '), B = byLabel('B '), C = byLabel('C '), D = byLabel('D '), E = byLabel('E '), F = byLabel('F '), R = byLabel('R ');
        const checkAt = (group, label, at, name) => {
            const row = rowOf(group, at);
            c.check(name + ' · ' + at + ' Δleft=' + (row && row.delta ? row.delta.left : 'null') + ' Δwidth=' + (row && row.delta ? row.delta.width : 'null'), deltaOk(row), row && row.delta);
        };
        checkAt(A, 'A', 't200', 'A 生成中·直接落停止');
        checkAt(A, 'A', 't600', 'A 生成中·直接落停止');
        checkAt(D, 'D', 't200', 'D 生成中·先落徽标再移入');
        checkAt(D, 'D', 't600', 'D 生成中·先落徽标再移入');
        checkAt(R, 'R', 't200', 'R 无动画(reduced-motion)');
        checkAt(R, 'R', 't600', 'R 无动画(reduced-motion)');
        checkAt(B, 'B', 't200', 'B 普通·直接落中间');
        checkAt(B, 'B', 't600', 'B 普通·直接落中间');
        checkAt(C, 'C', 't200', 'C 普通·直接落最后一颗');
        checkAt(C, 'C', 't600', 'C 普通·直接落最后一颗');
        checkAt(E, 'E', 't600', 'E 普通·从最后一颗滑到素材库');
        // A 组不能是「冻结了一个碰巧正确的值」：200ms 与 600ms 的 inline left 都应等于最终 62
        const a200 = rowOf(A, 't200'), a600 = rowOf(A, 't600');
        c.check('A 组 200ms/600ms 的 inline left 都等于最终值（62）且不再变化',
            !!a200 && !!a600 && parseFloat(a200.hl.inline.left) === parseFloat(a600.hl.inline.left) && Math.abs(parseFloat(a600.hl.inline.left) - 62) <= 1,
            { t200: a200 && a200.hl.inline.left, t600: a600 && a600.hl.inline.left });
        // F 组：截断场景下高亮必须留在胶囊内边距盒里（右缘 ≤ 条右缘 - 6）
        const f600 = rowOf(F, 't600');
        const fInside = !!f600 && !!f600.hl.rect && !!f600.bar && f600.hl.rect.right <= (f600.bar.left + f600.bar.width) - 6 + 1;
        c.check('F 窄视口截断时：滑块右缘留在胶囊内（≤ 条右缘-6），没有在圆角处露头', fInside, f600 ? { hlRight: f600.hl.rect && f600.hl.rect.right, barRight: f600.bar.left + f600.bar.width } : null);
        c.check('F 窄视口截断时：悬停的「下载」确实被 clamp 夹住（rawLeft > 上限）', !!(f600 && f600.actual && f600.actual.correct && f600.actual.correct.clamped) && f600.underTb === 'dl', f600 && { under: f600.underTb, correct: f600.actual && f600.actual.correct });
        c.check('F 窄视口下条确实被 max-width 截断（条宽 ≤ 900-24+1）', !!f600 && !!f600.bar && f600.bar.width <= 900 - 24 + 1, f600 && f600.bar);

        /* 打印 */
        const table = { groups: result.groups };
        console.log('');
        console.log('--- Δ(left/width) 汇总（相对于修复后公式的正确位置）---');
        for (const group of result.groups) {
            const parts = ['t0', 't60', 't200', 't600'].map((label) => {
                const row = rowOf(group, label);
                return row && row.delta ? (label + ' ΔL=' + row.delta.left + 'ΔW=' + row.delta.width) : (label + ' -');
            });
            console.log(group.label.padEnd(34) + parts.join(' | '));
        }
        for (const group of result.groups) {
            console.log('');
            console.log('===== ' + group.label + '  ' + group.selector + ' =====');
            for (const row of (group.before ? [group.before] : []).concat(group.samples)) console.log(grid(row));
        }
        console.log('');
        console.log('DIAG running:', JSON.stringify(result.notes.diagRunning));
        console.log('DIAG normal :', JSON.stringify(result.notes.diagNormal));
        fs.writeFileSync(path.join(OUT, 'result-toolbar-hl.json'), JSON.stringify({ table, notes: result.notes, checks: c.results.checks }, null, 2));
        c.results.table = table;
        c.check('X1 页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const results = c.finish();
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'result-checks.json'), JSON.stringify(results, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
