#!/usr/bin/env node
/*
 * 比例 / 分辨率 UI 统一验收截图（1440×900，深色）：
 *   图片节点点开「比例」弹层（[data-p=ratio]）+ 视频节点点开参数弹层（[data-p=vset]）。
 * 后端不真跑：page.route 拦截 /api/**，返回一份含 1 个图片节点 + 1 个视频节点的画布和模型清单。
 *
 *   node tests/ui_ratio_unify_shots.cjs before|after
 * 产物：NOVAI-v16/_ui-ratio-unify/{phase}-image.png / {phase}-video.png
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PHASE = process.argv[2] === 'after' ? 'after' : 'before';
const BASE = process.env.NOVAI_DEV_URL || process.env.OPENARC_DEV_URL || 'http://127.0.0.1:5173';
const PAGE_URL = BASE + '/static/novai-canvas/?id=ratio-unify-e2e';
const OUT_DIR = path.join(__dirname, '..', '_ui-ratio-unify');

const IMAGE_MODEL = 'gemini-3-pro-image-preview';
const VIDEO_MODEL = 'seedance-2.0';
const NODE_PARAMS = (id, params) => ({ id, text: '', data: { gen: { title: id, prompt: '', params, hist: [], hi: 0, order: [] } } });
const CANVAS = {
    title: '比例分辨率统一验收',
    icon: '🧩',
    updated_at: 1,
    viewport: { x: 0, y: 0, scale: 1 },
    connections: [],
    comments: [],
    settings: {},
    nodes: [
        {
            ...NODE_PARAMS('img1', { model: 'comfly::' + IMAGE_MODEL, ratio: '16:9', size: '2K', count: 1, search: false, style: '无', camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 1 } }),
            kind: 'image', x: 80, y: 120, w: 320, h: 300,
        },
        {
            ...NODE_PARAMS('vid1', { model: 'comfly::' + VIDEO_MODEL, mode: '文生视频', ratio: '16:9', res: '720p', dur: 5, sound: false, times: 1 }),
            kind: 'video', x: 520, y: 120, w: 400, h: 225,
        },
    ],
};
const CONFIG = {
    chat_model: '',
    api_providers: [{
        id: 'comfly', name: 'comfly', protocol: 'openai', enabled: true, has_key: true,
        chat_models: [], image_models: [IMAGE_MODEL], video_models: [VIDEO_MODEL], audio_models: [],
    }],
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    await context.addInitScript(() => {
        localStorage.setItem('studio_theme', 'dark');
        localStorage.setItem('canvas_theme', 'dark');
    });
    const page = await context.newPage();
    const result = { phase: PHASE, url: PAGE_URL, screenshots: {}, checks: {}, pageErrors: [], apiCalls: [] };
    page.on('pageerror', (err) => result.pageErrors.push(String(err)));

    await page.route('**/api/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname;
        result.apiCalls.push(req.method() + ' ' + p);
        if (p === '/api/config') return json(route, CONFIG);
        if (p === '/api/model-caps') return json(route, { items: [] });
        if (p === '/api/canvases') return json(route, { canvases: [] });
        if (p.startsWith('/api/canvases/')) {
            if (req.method() === 'PUT') return json(route, { ok: true, canvas: { ...CANVAS, updated_at: 2 } });
            return json(route, { canvas: CANVAS });
        }
        return json(route, {});
    });

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-id="img1"]', { timeout: 20000 });
    await page.waitForSelector('[data-id="vid1"]', { timeout: 20000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(400);

    const select = async (id) => {
        await page.evaluate((nodeId) => {
            const store = window.__cn;
            store.setUI({ sel: new Set([nodeId]), edge: null, pick: null, preview: false });
            store.setView({ x: 0, y: 0, k: 1 });
        }, id);
        await page.waitForTimeout(300);
    };
    const shot = async (file) => {
        const target = path.join(OUT_DIR, PHASE + '-' + file + '.png');
        result.checks[file + '_pop'] = await page.evaluate(() => {
            const pop = document.getElementById('pop');
            if (!pop) return null;
            const r = pop.getBoundingClientRect(); const cs = getComputedStyle(pop);
            return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opacity: cs.opacity, transform: cs.transform, anim: cs.animationName + ' ' + cs.animationDuration + ' ' + cs.animationPlayState };
        });
        await page.screenshot({ path: target, animations: 'disabled' });
        result.screenshots[file] = target;
    };
    const closePop = async () => {
        await page.keyboard.press('Escape');
        await page.waitForSelector('#pop', { state: 'detached', timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(150);
    };

    // ---- 图片节点 → 比例弹层 ----
    await select('img1');
    await page.waitForSelector('#gp [data-p="ratio"]', { state: 'visible', timeout: 8000 });
    await page.click('#gp [data-p="ratio"]');
    await page.waitForSelector('#pop', { state: 'visible', timeout: 8000 });
    await page.waitForTimeout(350);
    result.checks.image_titles = await page.$$eval('#pop .mh', (els) => els.map((el) => el.textContent.trim()));
    result.checks.image_cells = await page.$$eval('#pop .mh', (els) => els.map((el) => {
        const box = el.nextElementSibling;
        if (!box) return null;
        const btns = [...box.querySelectorAll('button')];
        return { cls: box.className, cols: getComputedStyle(box).gridTemplateColumns, n: btns.length, height: btns[0] ? Math.round(btns[0].getBoundingClientRect().height) : 0, texts: btns.map((b) => b.textContent.trim()) };
    }));
    await shot('image');
    await closePop();

    // ---- 视频节点 → 参数弹层（vset）----
    await select('vid1');
    await page.waitForSelector('#gp [data-p="vset"]', { state: 'visible', timeout: 8000 });
    await page.click('#gp [data-p="vset"]');
    await page.waitForSelector('#pop [data-vset]', { state: 'visible', timeout: 8000 });
    await page.waitForTimeout(350);
    result.checks.video_titles = await page.$$eval('#pop .mh', (els) => els.map((el) => el.textContent.trim()));
    result.checks.video_cells = await page.$$eval('#pop .mh', (els) => els.map((el) => {
        const box = el.nextElementSibling;
        if (!box) return null;
        const btns = [...box.querySelectorAll('button')];
        return { cls: box.className, cols: getComputedStyle(box).gridTemplateColumns, n: btns.length, height: btns[0] ? Math.round(btns[0].getBoundingClientRect().height) : 0, texts: btns.map((b) => b.textContent.trim()) };
    }));
    result.checks.video_draft = await page.$$eval('#pop [data-p="vdraft"], #pop [data-vopt="draft"]', (els) => els.map((el) => ({ p: el.getAttribute('data-p'), vopt: el.getAttribute('data-vopt'), text: el.textContent.trim(), box: el.className })));
    await shot('video');
    await closePop();

    await context.close();
    await browser.close();
    console.log(JSON.stringify(result, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
