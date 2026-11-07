'use strict';
/*
 * 智能画布BEAT「增强 → 本地 2K/4K」验收用的小工具（不上测试 runner，手动跑）：
 *   - 极简 PNG 写/读（zlib 自带，不引第三方依赖）
 *   - playwright 浏览器定位（本机只装了 chromium-1223，playwright 1.64 默认要 1248，所以按候选路径找）
 *   - 画布创建/删除、加图片节点、开「更多 → 增强」浮层、读回节点 gen.hist
 * 约定：后端用独立端口 + 独立数据目录（NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-verify-hd）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:3921';
const DATA_DIR = process.env.NOVAI_DATA_DIR || '/tmp/novai-verify-hd';
const OUT_DIR = path.join(DATA_DIR, 'output');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
/** 画布里的 /output/... 与 /assets/... 分别落在数据目录的这两个根（与后端 output_file_from_url 一致） */
function fileForUrl(url) {
    const clean = String(url || '').split('?')[0];
    if (clean.indexOf('/assets/') === 0) return path.join(DATA_DIR, clean.slice(1));
    if (clean.indexOf('/output/') === 0) return path.join(DATA_DIR, clean.slice(1));
    return null;
}
const ART_DIR = path.join(__dirname, 'artifacts', 'upscale');

/* ---------------- 极简 PNG ---------------- */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();
function crc32(buffer) {
    let c = -1;
    for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}
/** colorType: 2 = RGB / 6 = RGBA；pixel(x,y) 返回 [r,g,b] 或 [r,g,b,a] */
function pngBuffer(width, height, colorType, pixel) {
    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * stride] = 0;
        for (let x = 0; x < width; x += 1) {
            const p = pixel(x, y);
            const at = y * stride + 1 + x * channels;
            raw[at] = p[0]; raw[at + 1] = p[1]; raw[at + 2] = p[2];
            if (channels === 4) raw[at + 3] = p[3];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}
function writePng(file, width, height, colorType, pixel) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pngBuffer(width, height, colorType, pixel));
    return file;
}
/** 读 PNG 头：宽高 + 色彩类型（6 = RGBA 带 alpha 通道） */
function readPngInfo(file) {
    const buf = fs.readFileSync(file);
    const signature = buf.subarray(0, 8).toString('hex');
    if (signature !== '89504e470d0a1a0a') throw new Error('不是 PNG：' + file);
    return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

/* ---------------- 浏览器 ---------------- */
function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (error) { return ''; } })(),
        path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error('找不到可用的 Chromium：设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return found;
}
function launchBrowser() {
    return chromium.launch({ executablePath: chromiumExecutable(), headless: true });
}

/* ---------------- 断言 ---------------- */
function checker(title) {
    const results = { title, checks: {}, failures: [], shots: {}, pageErrors: [] };
    let failed = 0;
    const check = (name, ok, detail) => {
        results.checks[name] = ok ? true : { failed: true, detail: detail === undefined ? null : detail };
        if (ok) console.log('PASS  ' + name);
        else { failed += 1; results.failures.push(name); console.log('FAIL  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
        return ok;
    };
    const shot = async (page, name, options = {}) => {
        fs.mkdirSync(ART_DIR, { recursive: true });
        const file = path.join(ART_DIR, name + '.png');
        await page.screenshot({ path: file, ...options });
        results.shots[name] = file;
        console.log('SHOT  ' + file);
        return file;
    };
    const finish = () => {
        results.failed = failed;
        results.passed = failed === 0;
        fs.mkdirSync(ART_DIR, { recursive: true });
        console.log('');
        console.log('[' + (failed ? 'FAIL' : 'PASS') + '] ' + title + '：' + (failed ? failed + ' 条失败' : '全部通过'));
        return results;
    };
    return { check, shot, finish, results, failed: () => failed };
}

/* ---------------- 画布 ---------------- */
async function createCanvas(api, title) {
    const created = await api.post('/api/canvases', { data: { title: title, kind: 'classic' } });
    if (created.status() !== 200) throw new Error('画布创建失败：' + created.status());
    return (await created.json()).canvas.id;
}
async function deleteCanvas(api, canvasId) {
    if (!canvasId) return;
    await api.delete('/api/canvases/' + encodeURIComponent(canvasId)).catch(() => null);
}
async function openCanvasPage(browser, canvasId, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push('console: ' + message.text()); });
    // 有些 mock 必须在首屏请求之前就挂上（例如 /api/config 决定模型列表），所以先进 beforeGoto 再导航
    if (typeof options.beforeGoto === 'function') await options.beforeGoto(page);
    await page.goto(BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const store = window.__cn;
        return !!(store && store.state && store.state.doc);
    }, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    return { context, page, pageErrors };
}
/** 往画布里加一个带画面的图片节点（模拟用户已有的一张 800×600 图） */
async function addImageNode(page, { url, width, height, title }) {
    return page.evaluate(({ url, width, height, title }) => {
        const store = window.__cn;
        const node = store.newNode('image', 180, 140, {
            hist: [{ url: url, w: width, h: height, meta: { model: 'seed', at: Date.now() } }],
            hi: 0,
            title: title || '超分验证图',
        });
        store.addNodes([node], [], { select: true });
        return node.id;
    }, { url, width, height, title });
}
async function nodeGen(page, nodeId) {
    return page.evaluate((id) => {
        const node = window.__cn.node(id);
        if (!node) return null;
        const gen = (node.data && node.data.gen) || {};
        return { id: node.id, kind: node.kind, url: node.url, w: node.w, h: node.h, hist: gen.hist || [], hi: gen.hi, title: gen.title };
    }, nodeId);
}
async function waitNodeHist(page, nodeId, length, timeout = 20000) {
    await page.waitForFunction(({ id, len }) => {
        const node = window.__cn.node(id);
        const gen = node && node.data && node.data.gen;
        return !!(gen && Array.isArray(gen.hist) && gen.hist.length === len);
    }, { id: nodeId, len: length }, { timeout });
    return nodeGen(page, nodeId);
}
/** 选中节点 → 点工具条「更多」→ 等菜单出现（addNodes({select:true}) 后工具条已经在了，不重复点节点） */
async function openMoreMenu(page, nodeId) {
    const node = page.locator('.node[data-id="' + nodeId + '"]').first();
    await node.waitFor({ state: 'visible', timeout: 15000 });
    const more = page.locator('#ntb [data-tb="more"]').first();
    if (!(await more.isVisible().catch(() => false))) {
        await node.click({ force: true }).catch(() => null);
        await page.waitForTimeout(400);
    }
    if (!(await more.isVisible().catch(() => false))) {
        await page.evaluate((id) => {
            const el = document.querySelector('.node[data-id="' + id + '"]');
            if (el) window.dispatchEvent(new CustomEvent('cn:editor', { detail: { kind: 'more', id: id, anchor: el } }));
        }, nodeId);
    }
    await more.waitFor({ state: 'visible', timeout: 10000 });
    await more.click();
    await page.locator('[data-k="enhance-menu"]').waitFor({ state: 'visible', timeout: 10000 });
}
/** 悬停「增强」→ 等二级浮层 */
async function openEnhanceFlyout(page) {
    await page.locator('[data-k="enhance-menu"]').hover();
    await page.locator('[data-k="enhance-flyout"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(200);
}
async function toastText(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((el) => el.textContent || '').join(' | '));
}
async function waitToast(page, text, timeout = 10000) {
    await page.waitForFunction((wanted) => {
        const nodes = Array.from(document.querySelectorAll('#toasts .toast'));
        return nodes.some((el) => (el.textContent || '').indexOf(wanted) >= 0);
    }, text, { timeout });
    return toastText(page);
}

module.exports = {
    BASE, DATA_DIR, OUT_DIR, ASSETS_DIR, ART_DIR, fileForUrl,
    pngBuffer, writePng, readPngInfo,
    chromiumExecutable, launchBrowser, checker,
    createCanvas, deleteCanvas, openCanvasPage, addImageNode, nodeGen, waitNodeHist,
    openMoreMenu, openEnhanceFlyout, toastText, waitToast,
};
