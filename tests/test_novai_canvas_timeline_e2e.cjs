#!/usr/bin/env node
'use strict';
/*
 * 剪辑时间线：连线入轨 + 专业化 UI 的无头验收。
 *
 * 复现用户报的问题：把视频节点输出口连线到「剪辑时间线」节点，以前只画了一条线，
 * 时间线里一个片段都没有、画面全黑。现在连线 = 素材入轨（片段 + 来源连线一起产生），
 * 断开连线 = 移除该来源的片段。
 *
 * 跑法（不碰 3000、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_novai_canvas_timeline_e2e.cjs
 *   node tests/test_novai_canvas_timeline_e2e.cjs --shots _verification-timeline-pro
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__tl-e2e.html');
const MEDIA_DIR = path.join(UI_DIR, 'public', '__tl-e2e');
const PAGE_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><style>html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/src/canvas/canvas-next/dev/main.tsx"></script></body></html>\n';
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(ROOT, process.argv[shotsArg + 1]) : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
function check(name, ok, detail) {
    if (ok) { passed += 1; console.log('PASS  ' + name); }
    else { failed.push(name); console.log('FAIL  ' + name + (detail === undefined ? '' : '  ::  ' + JSON.stringify(detail))); }
}
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    });
}
function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (error) { return ''; } })(),
        path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error('找不到可用的 Chromium：设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return found;
}
async function startVite(port) {
    const bin = path.join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: UI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__tl-e2e.html';
    for (let i = 0; i < 160; i += 1) {
        await sleep(250);
        if (child.exitCode !== null) throw new Error('vite 起不来（exit ' + child.exitCode + '）：\n' + log);
        try { const res = await fetch(url); if (res.ok && (await res.text()).includes('id="root"')) return { child, url }; } catch (error) { /* 还在启动 */ }
    }
    child.kill('SIGTERM');
    throw new Error('vite 等待超时：\n' + log);
}
function stopVite(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } resolve(); }, 3000); });
}

/** 从节点输出口拖一条线到时间线节点 */
async function connectToTimeline(page, fromId, toId) {
    const port = await page.locator('[data-id="' + fromId + '"] .pz.out').first().boundingBox();
    const target = await page.locator('[data-id="' + toId + '"] .nbody').first().boundingBox();
    if (!port || !target) throw new Error('连线目标不可见：' + fromId);
    // 落点夹在视口里：时间线节点可能有一部分在屏幕外
    const tx = Math.min(1260, Math.max(20, target.x + target.width / 2));
    const ty = Math.min(880, Math.max(20, target.y + target.height / 2));
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(port.x + port.width / 2 + 40, port.y + port.height / 2 + 20, { steps: 4 });
    await page.mouse.move(tx, ty, { steps: 14 });
    await page.mouse.up();
    await sleep(260);
}

/** 预览画布上不是纯黑（真的画出了画面） */
async function previewLit(page) {
    return page.evaluate(() => {
        const c = document.querySelector('.tle-screen');
        if (!c) return -1;
        const g = c.getContext('2d');
        const { data } = g.getImageData(0, 0, c.width, c.height);
        let lit = 0;
        for (let i = 0; i < data.length; i += 4 * 97) if (data[i] + data[i + 1] + data[i + 2] > 40) lit += 1;
        return lit;
    });
}
async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

(async () => {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    for (const [src, dst] of [['static/images/templates/product-video.mp4', 'sample.mp4'], ['static/images/market/showcase-kling.mp4', 'kling.mp4']]) {
        fs.copyFileSync(path.join(ROOT, src), path.join(MEDIA_DIR, dst));
    }
    let vite = null; let browser = null;
    try {
        const port = await freePort();
        const started = await startVite(port); vite = started.child;
        browser = await chromium.launchPersistentContext('/tmp/tl-e2e-' + Date.now(), { headless: true, executablePath: chromiumExecutable(), viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, args: ['--autoplay-policy=no-user-gesture-required'] });
        const page = browser.pages()[0] || await browser.newPage();
        const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(started.url + '?empty=1', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.__cn, null, { timeout: 30000 });
        await page.waitForSelector('.cn-root', { timeout: 30000 });
        await sleep(600);

        // 注入素材节点 + 一条空的剪辑时间线
        const ids = await page.evaluate(() => {
            const st = window.__cn;
            const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
            const g = cv.getContext('2d'); g.fillStyle = '#2f6f8f'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif'; g.fillText('STILL', 190, 270);
            const imgUrl = cv.toDataURL('image/png');
            const sr = 8000; const n = sr * 2; const buf = new ArrayBuffer(44 + n * 2); const dv = new DataView(buf);
            const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
            ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * 2, true);
            for (let i = 0; i < n; i += 1) { const v = Math.sin((i / sr) * 2 * Math.PI * 220) * 0.6 * (1 - i / n); dv.setInt16(44 + i * 2, v * 32767, true); }
            let bin = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
            const wavUrl = 'data:audio/wav;base64,' + btoa(bin);
            const img = st.newNode('image', 30, 30, { title: '静帧', uploaded: true, hist: [{ url: imgUrl, w: 640, h: 480 }] });
            const vid = st.newNode('video', 30, 300, { title: '短片', uploaded: true, hist: [{ url: '/static/novai-canvas/__tl-e2e/sample.mp4', dur: 6, w: 1280, h: 720 }] });
            const vid2 = st.newNode('video', 30, 520, { title: '空镜', uploaded: true, hist: [{ url: '/static/novai-canvas/__tl-e2e/kling.mp4', dur: 5, w: 1280, h: 720 }] });
            const aud = st.newNode('audio', 30, 740, { title: '配乐', uploaded: true, hist: [{ url: wavUrl, dur: 2 }] });
            const tl = { id: 'tl-e2e', kind: 'timeline', x: 330, y: 30, w: 720, h: 600, text: '剪辑时间线', clips: [] };
            st.addNodes([img, vid, vid2, aud, tl], [], { select: false });
            // 空画布会被自适应放大，先固定视口，保证四个节点和时间线都在 1280×900 里
            st.setView({ x: 24, y: 16, k: 0.52 });
            return { img: img.id, vid: vid.id, vid2: vid2.id, aud: aud.id, tl: tl.id };
        });
        await sleep(700);
        const clipsOf = () => page.evaluate((id) => (window.__cn.node(id).clips || []).length, ids.tl);
        const edgesTo = () => page.evaluate((id) => window.__cn.state.doc.edges.filter((e) => e.to === id).length, ids.tl);

        check('初始时间线是空的', (await clipsOf()) === 0);
        await shot(page, '0-empty');

        // ① 用户报的那条路：视频节点连线 → 时间线
        await connectToTimeline(page, ids.vid, ids.tl);
        check('视频节点连线进时间线 → 片段 +1', (await clipsOf()) === 1, await clipsOf());
        check('连线保留在画布上（来源关系）', (await edgesTo()) === 1, await edgesTo());
        await sleep(900);
        const lit = await previewLit(page);
        check('预览画面真的出画了（非纯黑）', lit > 40, lit);

        // ② 图片 / 第二段视频 / 音频也连进去
        await connectToTimeline(page, ids.img, ids.tl);
        await connectToTimeline(page, ids.vid2, ids.tl);
        await connectToTimeline(page, ids.aud, ids.tl);
        check('4 个来源都在时间线里（画面 3 段 + 音频 1 段）', (await clipsOf()) === 4, await clipsOf());
        check('三条来源连线', (await edgesTo()) === 4, await edgesTo());
        const kinds = await page.evaluate((id) => (window.__cn.node(id).clips || []).map((c) => (c.type === 'subtitle' ? 'sub' : c.mediaKind)), ids.tl);
        check('音频落到音频轨', kinds.filter((k) => k === 'audio').length === 1, kinds);
        await sleep(1400);
        const ui = await page.evaluate(() => ({
            filmstrip: document.querySelectorAll('.tle-clip .tle-fs i').length,
            waves: document.querySelectorAll('.tle-clip .tle-wavewrap canvas').length,
            timecode: (document.querySelector('.tle-time') || {}).textContent || '',
            clipsShown: document.querySelectorAll('.tle-clip').length,
        }));
        check('片段里有胶片缩略图', ui.filmstrip >= 2, ui.filmstrip);
        check('音频片段画出真实波形', ui.waves >= 1, ui.waves);
        check('时间码是 MM:SS:FF', /^\d{2}:\d{2}:\d{2}/.test(ui.timecode), ui.timecode);
        await shot(page, '1-clips-filmstrip-wave');

        // ③ 多选：点第一段，shift 点第二段
        const boxes = await page.locator('.tle-clip').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { id: e.dataset.clip, x: b.x + 20, y: b.y + b.height / 2 }; }));
        await page.mouse.click(boxes[0].x, boxes[0].y);
        await page.keyboard.down('Shift');
        await page.mouse.click(boxes[1].x, boxes[1].y);
        await page.keyboard.up('Shift');
        await sleep(200);
        const onCount = await page.evaluate(() => document.querySelectorAll('.tle-clip.on').length);
        check('多选：两段同时选中', onCount === 2, onCount);
        await shot(page, '2-multi-select');

        // ④ 轨道显隐：隐藏画面轨 → 预览变黑；恢复后重新出画
        await page.click('[data-tl="track-video"]');
        await sleep(700);
        const hiddenLit = await previewLit(page);
        check('隐藏画面轨后预览变黑', hiddenLit >= 0 && hiddenLit <= 12, hiddenLit);
        await shot(page, '3-track-hidden');
        await page.click('[data-tl="track-video"]');
        await sleep(900);
        check('恢复画面轨后重新出画', (await previewLit(page)) > 40);

        // ⑤ 断开连线 = 移除该来源的片段（⌘Z 可一起回来）
        const edgeId = await page.evaluate((id) => (window.__cn.state.doc.edges.find((e) => e.to === id) || {}).id, ids.tl);
        const before = await clipsOf();
        await page.evaluate((eid) => window.__cn.removeEdge(eid), edgeId);
        await sleep(200);
        check('删掉一条来源连线 → 少一段片段', (await clipsOf()) === before - 1, { before, now: await clipsOf() });

        // ⑥ 区间循环：I / O 设点后循环按钮可用
        await page.locator('.tle').focus();
        await page.keyboard.press('i');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.keyboard.press('o');
        await sleep(150);
        const ioText = await page.evaluate(() => { const b = document.querySelector('[data-tl="io"]'); return b ? b.textContent : ''; });
        // MM:SS:FF：出点 2 秒 = 00:02:00（2 秒 0 帧）
        check('I / O 设出 2 秒区间并在工具条显示', /00:00:00.*00:02:00/.test(ioText.replace(/\s+/g, ' ')), ioText);
        const rangeShown = await page.evaluate(() => !!document.querySelector('.tle-io'));
        check('刻度尺上画出区间带', rangeShown);
        await shot(page, '4-in-out-loop');

        check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 3));

        console.log('\n' + (failed.length ? 'FAILED: ' + failed.join(' | ') : 'ALL PASS') + '  (' + passed + ' passed, ' + failed.length + ' failed)');
        if (SHOTS) console.log('截图目录：' + SHOTS);
        process.exitCode = failed.length ? 1 : 0;
    } finally {
        if (browser) await browser.close().catch(() => undefined);
        await stopVite(vite);
        try { fs.rmSync(MEDIA_DIR, { recursive: true, force: true }); const pub = path.dirname(MEDIA_DIR); if (fs.existsSync(pub) && fs.readdirSync(pub).length === 0) fs.rmdirSync(pub); } catch (error) { /* 清理失败不影响结论 */ }
        try { fs.rmSync(PAGE_FILE, { force: true }); } catch (error) { /* ignore */ }
    }
})().catch((error) => { console.error(error); process.exit(1); });
