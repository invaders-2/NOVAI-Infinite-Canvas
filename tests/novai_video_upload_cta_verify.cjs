#!/usr/bin/env node
'use strict';
/*
 * 空视频节点的「上传」单按钮条验收（手动跑，不进 run-all）：
 *   cd NOVAI-v16 && NOVAI_PORT=3933 NOVAI_DATA_DIR=/tmp/novai-verify-vup python3 main.py
 *   NOVAI_BASE=http://127.0.0.1:3933 NOVAI_DATA_DIR=/tmp/novai-verify-vup \
 *     node tests/novai_video_upload_cta_verify.cjs
 *
 * 验的东西：
 *   1. 空视频节点单选 → #ntb.ntb-empty-upload 一颗「上传」，tip / aria / data-tip = 上传视频，data-tb=upload
 *   2. 点它 → 文件选择只筛视频（input.accept === 'video/*'）
 *   3. CDP DOM.setFileInputFiles 塞真实小 mp4 → 成为当前版本（hist 增长、时长 / 封面角标出现、工具条换成有结果那套）
 *   4. 再塞一次 → 版本条 2/2
 *   5. 空文本 / 空音频不挂工具条；空图片仍是「上传图片」且 accept 保持全量
 *   6. 类型守卫：视频塞进图片节点 → toast 说人话、节点一个版本都不写
 *
 * 输出：tests/artifacts/video-upload-cta/*.png + result.json
 */
const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const BASE = process.env.NOVAI_BASE || 'http://127.0.0.1:3933';
const ART = path.join(__dirname, 'artifacts', 'video-upload-cta');
const MP4 = process.env.NOVAI_TEST_MP4 || '/tmp/vup-media/clip.mp4';

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

async function main() {
    if (!fs.existsSync(MP4)) throw new Error('缺少测试视频：' + MP4 + '（先跑 ffmpeg 生成）');
    fs.mkdirSync(ART, { recursive: true });
    fs.mkdirSync('/tmp/vup-media', { recursive: true });
    // 两张真 png：一张做图片节点的当前版本，另一张走「替换」换上去
    H.writePng('/tmp/vup-media/pic-a.png', 320, 240, 2, (x, y) => [47 + (x % 64), 111, 237 - (y % 64)]);
    H.writePng('/tmp/vup-media/pic-b.png', 800, 600, 2, (x, y) => [237, 111 + (y % 64), 47 + (x % 64)]);
    const api = await request.newContext({ baseURL: BASE });
    const canvasId = await H.createCanvas(api, 'VERIFY-视频节点上传-' + Date.now());

    // 全新 profile（--user-data-dir）：不复用缓存与登录态
    const profile = fs.mkdtempSync('/tmp/vup-chrome-');
    const ctx = await chromium.launchPersistentContext(profile, {
        headless: true,
        executablePath: H.chromiumExecutable(),
        viewport: { width: 1500, height: 950 },
        deviceScaleFactor: 1,
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Page.enable');

    const shot = async (name, clip) => {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
        const file = path.join(ART, name + '.png');
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        console.log('SHOT  ' + file);
        return file;
    };
    const nodeBox = async (id) => page.evaluate((nid) => {
        const el = document.querySelector('.node[data-id="' + nid + '"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 90), y: Math.max(0, r.top - 90), width: Math.min(1500, r.width + 180), height: Math.min(950, r.height + 240) };
    }, id);

    await page.goto(BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__cn && window.__cn.state && window.__cn.state.doc), null, { timeout: 30000 });
    await page.waitForTimeout(500);

    const ids = await page.evaluate(() => {
        const s = window.__cn;
        const mk = (kind, x, y, w, h) => { const n = s.newNode(kind, x, y, { w, h }); s.addNodes([n], [], { select: false }); return n.id; };
        const out = {
            video: mk('video', 80, 150, 320, 180),
            image: mk('image', 560, 150, 240, 240),
            text: mk('text', 900, 150, 280, 200),
            audio: mk('audio', 900, 470, 320, 120),
        };
        s.setView({ x: 0, y: 0, k: 1 });
        return out;
    });
    await page.waitForTimeout(400);

    /* ---------- 1. 空视频节点单选 ---------- */
    await page.click('.node[data-id="' + ids.video + '"] .nhead', { force: true });
    await page.waitForTimeout(500);
    const sel = await page.evaluate(() => [...window.__cn.state.ui.sel]);
    check('C0 空视频节点单选成功', sel.length === 1 && sel[0] === ids.video, { sel });

    await page.locator('#ntb.ntb-empty-upload').first().waitFor({ state: 'visible', timeout: 8000 });
    const dock = await page.evaluate(() => {
        const bar = document.querySelector('#ntb.ntb-empty-upload');
        if (!bar) return null;
        const cs = getComputedStyle(bar);
        const btns = Array.from(bar.querySelectorAll('button'));
        const b = btns[0];
        const bs = b ? getComputedStyle(b) : null;
        const svg = b ? b.querySelector('svg') : null;
        const svgCs = svg ? getComputedStyle(svg) : null;
        return {
            id: bar.id, className: bar.className,
            height: cs.height, padding: cs.padding, radius: cs.borderRadius, borderWidth: cs.borderTopWidth,
            background: cs.backgroundColor, backgroundImage: cs.backgroundImage,
            backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
            boxShadow: cs.boxShadow,
            buttonCount: btns.length,
            buttonText: b ? (b.textContent || '').trim() : null,
            buttonClass: b ? b.className : null,
            dataTb: b ? b.getAttribute('data-tb') : null,
            dataTip: b ? b.getAttribute('data-tip') : null,
            ariaLabel: b ? b.getAttribute('aria-label') : null,
            title: b ? b.getAttribute('title') : null,
            buttonHeight: bs ? bs.height : null,
            buttonRadius: bs ? bs.borderRadius : null,
            buttonFontSize: bs ? bs.fontSize : null,
            buttonColor: bs ? bs.color : null,
            buttonBg: bs ? bs.backgroundColor : null,
            iconW: svgCs ? svgCs.width : null,
            svgCount: b ? b.querySelectorAll('svg').length : 0,
            dataTbCount: bar.querySelectorAll('[data-tb]').length,
        };
    });
    const box = await nodeBox(ids.video);
    const barBox = await page.evaluate(() => { const r = document.querySelector('#ntb.ntb-empty-upload').getBoundingClientRect(); return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 24), width: r.width + 48, height: r.height + 48 }; });
    const shots = {};
    shots.emptyVideo = await shot('01-empty-video-dock', box);
    shots.dockCloseup = await shot('02-empty-upload-dock', barBox);

    check('C1 空视频节点出现 #ntb.ntb-empty-upload', !!dock && dock.className.includes('ntb-empty-upload'), dock && dock.className);
    check('C2 单颗按钮、文字「上传」', dock.buttonCount === 1 && dock.buttonText === '上传' && dock.dataTb === 'upload', { buttonCount: dock.buttonCount, buttonText: dock.buttonText, dataTb: dock.dataTb });
    check('C3 tip / aria / data-tip 都是「上传视频」（不再挂原生 title，避免和 CSS 提示重复弹层）', dock.dataTip === '上传视频' && dock.ariaLabel === '上传视频' && dock.title === null, { dataTip: dock.dataTip, ariaLabel: dock.ariaLabel, title: dock.title });
    check('C4 沿用 #ntb.ntb-empty-upload 外观：50 高 / padding 7 / 圆角 14 / 无 border / blur(44px) saturate(190%) / 两层柔和投影',
        dock.height === '50px' && dock.padding === '7px' && dock.radius === '14px' && dock.borderWidth === '0px' &&
        /blur\(44px\)/.test(dock.backdrop) && /saturate\(1\.9|190%\)/.test(dock.backdrop) && (dock.boxShadow.match(/rgba?\(/g) || []).length >= 2,
        { height: dock.height, padding: dock.padding, radius: dock.radius, borderWidth: dock.borderWidth, backdrop: dock.backdrop, boxShadow: dock.boxShadow });
    check('C5 按钮尺寸 = 36 高 / 圆角 8 / 13px 白字 / 图标线性描边 15px',
        dock.buttonHeight === '36px' && dock.buttonRadius === '8px' && dock.buttonFontSize === '13px' && dock.iconW === '15px' && dock.svgCount === 1,
        { h: dock.buttonHeight, r: dock.buttonRadius, fs: dock.buttonFontSize, color: dock.buttonColor, icon: dock.iconW, svg: dock.svgCount });

    // 深色主题：同一颗按钮走老的深色玻璃规则（本次没改 CSS），补一张截图证明没走样
    await page.evaluate(() => window.__cn.setUI({ theme: 'dark' }));
    await page.waitForTimeout(400);
    shots.dark = await shot('07-empty-video-dock-dark', await nodeBox(ids.video));
    await page.evaluate(() => window.__cn.setUI({ theme: 'light' }));
    await page.waitForTimeout(300);

    /* ---------- 2. 点它 → 文件选择只筛视频 ---------- */
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    await page.click('#ntb [data-tb="upload"]');
    const chooser = await chooserPromise;
    const chooserFired = !!chooser && typeof chooser.setFiles === 'function';
    const accept = await page.evaluate(() => document.querySelector('.cn-root > input[type="file"]').accept);
    check('C6 点「上传」会弹出文件选择框', chooserFired, { filechooserEvent: chooserFired });
    check('C7 空视频节点的文件选择只筛视频（accept = video/*）', accept === 'video/*', { accept });
    if (chooserFired) await chooser.setFiles([]).catch(() => undefined);
    await page.waitForTimeout(300);

    /* ---------- 3. CDP 真上传一条 mp4 ---------- */
    const setFileInputFiles = async (file) => {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.cn-root > input[type="file"]' });
        if (!nodeId) throw new Error('没找到文件 input');
        await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId });
    };
    await setFileInputFiles(MP4);
    await page.waitForFunction((id) => {
        const n = window.__cn.node(id);
        const g = n && n.data && n.data.gen;
        return !!(g && Array.isArray(g.hist) && g.hist.length === 1);
    }, ids.video, { timeout: 20000 });
    await page.waitForTimeout(900);
    const after1 = await page.evaluate((id) => {
        const n = window.__cn.node(id);
        const g = n.data.gen;
        const el = document.querySelector('.node[data-id="' + id + '"]');
        const vdur = el.querySelector('[data-vdur]');
        const ph = el.querySelector('.ph');
        return {
            kind: n.kind, hist: g.hist, hi: g.hi, uploaded: !!g.uploaded,
            w: n.w, h: n.h,
            vdurText: vdur ? vdur.textContent : null,
            placeholder: ph ? ph.textContent : null,
            hasVideoEl: !!el.querySelector('video'),
            posterImg: el.querySelector('img') ? el.querySelector('img').getAttribute('src') : null,
            posterLoaded: (() => { const im = el.querySelector('img'); return !!(im && im.complete && im.naturalWidth > 0); })(),
            toolbarBtns: [...document.querySelectorAll('#ntb [data-tb]')].map((b) => b.getAttribute('data-tb')),
            emptyDockStill: !!document.querySelector('#ntb.ntb-empty-upload'),
        };
    }, ids.video);
    shots.uploaded = await shot('03-video-uploaded', await nodeBox(ids.video));
    const v0 = after1.hist[0] || {};
    check('C8 选中的视频成为这个节点的当前版本（hist=1、hi=0、uploaded、有 url / 宽高 / 时长）',
        after1.hist.length === 1 && after1.hi === 0 && after1.uploaded && !!v0.url && v0.w === 320 && v0.h === 180 && Number(v0.dur) > 0,
        { hist: after1.hist.length, hi: after1.hi, uploaded: after1.uploaded, url: v0.url, w: v0.w, h: v0.h, dur: v0.dur, box: { w: after1.w, h: after1.h } });
    check('C9 仍走老的 VideoBody：时长角标出现、封面帧出图、空占位文案消失、工具条换成有结果那套（trim / smartclip / frame ...）',
        !!after1.vdurText && after1.placeholder === null && after1.posterLoaded && after1.toolbarBtns.includes('trim') && after1.toolbarBtns.includes('frame') && after1.emptyDockStill === false,
        { vdurText: after1.vdurText, placeholder: after1.placeholder, posterLoaded: after1.posterLoaded, toolbarBtns: after1.toolbarBtns, emptyDockStill: after1.emptyDockStill, posterImg: after1.posterImg });

    /* ---------- 4. 再传一条：追加成新版本 ---------- */
    await setFileInputFiles(MP4);
    await page.waitForFunction((id) => {
        const n = window.__cn.node(id);
        const g = n && n.data && n.data.gen;
        return !!(g && Array.isArray(g.hist) && g.hist.length === 2);
    }, ids.video, { timeout: 20000 });
    await page.waitForTimeout(800);
    const after2 = await page.evaluate((id) => {
        const n = window.__cn.node(id); const g = n.data.gen;
        const el = document.querySelector('.node[data-id="' + id + '"]');
        const vnum = el.querySelector('.vstrip .vnum');
        return { hist: g.hist.length, hi: g.hi, versionLabel: vnum ? vnum.textContent : null };
    }, ids.video);
    shots.versions = await shot('04-video-versions', await nodeBox(ids.video));
    check('C10 再传一条是当前版本（hist=2、hi=1、版本条 2/2）', after2.hist === 2 && after2.hi === 1 && after2.versionLabel === '2/2', after2);

    /* ---------- 5. 空图片 / 空文本 / 空音频 ---------- */
    await page.click('.node[data-id="' + ids.image + '"] .nhead', { force: true });
    await page.waitForTimeout(500);
    await page.locator('#ntb.ntb-empty-upload').first().waitFor({ state: 'visible', timeout: 8000 });
    const imgDock = await page.evaluate(() => {
        const b = document.querySelector('#ntb.ntb-empty-upload button');
        const bar = document.querySelector('#ntb.ntb-empty-upload');
        return { text: b.textContent.trim(), tip: b.getAttribute('data-tip'), aria: b.getAttribute('aria-label'), tb: b.getAttribute('data-tb'), count: bar.querySelectorAll('button').length };
    });
    check('C11 空图片节点仍是「上传图片」（tip / aria 同步，data-tb=upload 不变）',
        imgDock.text === '上传' && imgDock.tip === '上传图片' && imgDock.aria === '上传图片' && imgDock.tb === 'upload' && imgDock.count === 1, imgDock);

    // 图片节点的「上传」仍是默认全量类型（收窄只发生在空视频节点）
    const imgChooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    await page.click('#ntb [data-tb="upload"]');
    const imgChooser = await imgChooserPromise;
    const imgChooserFired = !!imgChooser && typeof imgChooser.setFiles === 'function';
    const imgAccept = await page.evaluate(() => document.querySelector('.cn-root > input[type="file"]').accept);
    check('C12 空图片节点的文件选择也只筛图片（accept = image/*，和空视频的 video/* 对称）', imgAccept === 'image/*', { accept: imgAccept });
    // 关掉刚刚弹出的选择框（Playwright 会拦下它），否则 CDP 塞文件不会触发 change
    let dismissErr = null;
    if (imgChooserFired) { try { await imgChooser.setFiles([]); } catch (e) { dismissErr = String((e && e.message) || e); } }
    await page.waitForTimeout(300);

    // 类型守卫：把 mp4 塞进图片节点 → 说人话并跳过（提示必须当场读到，toast 5s 后自己消失）
    await setFileInputFiles(MP4);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#toasts .toast')).some((el) => (el.textContent || '').includes('放不进图片节点：这里只收图片')), null, { timeout: 8000 }).catch(() => undefined);
    const guard = await page.evaluate((id) => {
        const n = window.__cn.node(id);
        const input = document.querySelector('.cn-root > input[type="file"]');
        return {
            hist: n.data.gen.hist.length,
            kind: n.kind,
            toasts: Array.from(document.querySelectorAll('#toasts .toast')).map((el) => el.textContent || ''),
            storeToasts: ((window.__cn.state || {}).toasts || []).map((t) => t.html),
            inputAcceptAfterUse: input ? input.accept : null,
        };
    }, ids.image);
    shots.guard = await shot('05-image-node-guard-toast', await nodeBox(ids.image));
    check('C13 上传类型守卫：视频塞不进图片节点（toast「放不进图片节点：这里只收图片」、节点没被写坏、选择框复位成全量）',
        guard.hist === 0 && guard.kind === 'image' &&
        guard.toasts.concat(guard.storeToasts).some((t) => t.includes('放不进图片节点：这里只收图片')) &&
        /^image\/\*,video\/\*,audio\/\*,/.test(guard.inputAcceptAfterUse || ''),
        { ...guard, imgChooserFired, dismissErr });

    /* ---------- 「替换」路径 ---------- */
    const PNG_A = '/tmp/vup-media/pic-a.png';
    const PNG_B = '/tmp/vup-media/pic-b.png';
    // 图片节点的当前版本：走它自己的「上传」（accept 已收窄成 image/*）
    const unread = () => page.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((el) => el.textContent || ''));
    const imgGen = () => page.evaluate((id) => {
        const g = window.__cn.node(id).data.gen;
        return { n: g.hist.length, hi: g.hi, url: (g.hist[g.hi] || {}).url || null, w: (g.hist[g.hi] || {}).w, h: (g.hist[g.hi] || {}).h };
    }, ids.image);
    const openReplaceMenu = async () => {
        const btn = page.locator('.node[data-id="' + ids.image + '"] .node-replace').first();
        if (await btn.isVisible().catch(() => false)) await btn.click({ force: true }).catch(() => undefined);
        else await page.evaluate((id) => { const el = document.querySelector('.node[data-id="' + id + '"] .node-replace'); if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }, ids.image);
        await page.locator('[data-k="rep-up"]').first().waitFor({ state: 'visible', timeout: 8000 });
    };
    const chooseRepUp = async () => {
        // 点「上传文件」会打开选择框：先接住再关掉，文件随后用 CDP 塞，才能真正走 addFiles 的 replace 分支
        const ch = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
        await page.locator('[data-k="rep-up"]').first().click();
        const c = await ch; if (c) await c.setFiles([]).catch(() => undefined);
        await page.waitForTimeout(250);
    };

    const chImg2 = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    await page.click('#ntb [data-tb="upload"]');
    const imgChooser2 = await chImg2; if (imgChooser2) await imgChooser2.setFiles([]).catch(() => undefined);
    await page.waitForTimeout(250);
    await setFileInputFiles(PNG_A);
    await page.waitForFunction((id) => { const g = window.__cn.node(id).data.gen; return g.hist.length === 1; }, ids.image, { timeout: 20000 });
    await page.waitForTimeout(400);
    const imgA = await imgGen();
    check('C15 空图片节点的「上传」收窄后仍能传图片：png 成为当前版本（hist=1、hi=0、有 url / 宽高）',
        imgA.n === 1 && imgA.hi === 0 && !!imgA.url && imgA.w === 320 && imgA.h === 240, imgA);

    // 1) 替换 → 上传文件 → mp4：必须被拒，当前版本一动不动
    await openReplaceMenu(); await chooseRepUp();
    const beforeReplace = await unread();
    await setFileInputFiles(MP4);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#toasts .toast')).some((el) => (el.textContent || '').includes('不能把视频替换进图片节点：这里只收图片')), null, { timeout: 8000 }).catch(() => undefined);
    const rejUp = await imgGen();
    const rejUpToasts = await unread();
    shots.replaceGuard = await shot('08-image-replace-guard-toast', await nodeBox(ids.image));
    check('C16 「替换 → 上传文件」把 mp4 塞进图片节点：被拒 + 文案「不能把视频替换进图片节点：这里只收图片」+ 当前版本不变',
        rejUp.n === 1 && rejUp.hi === 0 && rejUp.url === imgA.url &&
        rejUpToasts.some((t) => t.includes('不能把视频替换进图片节点：这里只收图片')),
        { before: imgA, after: rejUp, toasts: rejUpToasts, toastsBefore: beforeReplace });

    // 2) 替换 → 点画布上的视频节点：同样被拒（拖/点节点这条入口）
    await openReplaceMenu();
    await page.locator('[data-k="rep-pick"]').first().click();
    await page.waitForTimeout(300);
    await page.click('.node[data-id="' + ids.video + '"] .nhead', { force: true });
    await page.waitForTimeout(700);
    const rejPick = await imgGen();
    const rejPickToasts = await unread();
    check('C17 「替换 → 点画布上的视频节点」：被拒 + 文案 + 当前版本不变',
        rejPick.n === 1 && rejPick.hi === 0 && rejPick.url === imgA.url &&
        rejPickToasts.some((t) => t.includes('不能把视频替换进图片节点：这里只收图片')),
        { after: rejPick, toasts: rejPickToasts });

    // 3) 替换 → 上传文件 → png：成功，只换当前版本（先把图片节点重新选中，「替换」钮才亮着）
    await page.click('.node[data-id="' + ids.image + '"] .nhead', { force: true });
    await page.waitForTimeout(350);
    await openReplaceMenu(); await chooseRepUp();
    await setFileInputFiles(PNG_B);
    // 素材上传后会重命名为 ai_ref_*.png，认不出原文件名：按「当前版本 url 变了」等，别等文件名
    await page.waitForFunction(({ id, prev }) => {
        const g = window.__cn.node(id).data.gen;
        const url = (g.hist[g.hi] || {}).url || '';
        return g.hist.length === 1 && g.hi === 0 && !!url && url !== prev;
    }, { id: ids.image, prev: imgA.url }, { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    const repOk = await imgGen();
    const repOkToasts = await unread();
    shots.replaceOk = await shot('09-image-replace-success', await nodeBox(ids.image));
    check('C18 「替换 → 上传文件」换一张 800×600 的 png：替换成功（当前版本 url 变了、尺寸跟着换、hist 仍 1、hi 仍 0）',
        repOk.n === 1 && repOk.hi === 0 && !!repOk.url && repOk.url !== imgA.url && repOk.w === 800 && repOk.h === 600 &&
        repOkToasts.some((t) => t.includes('已替换')),
        { before: imgA, after: repOk, toasts: repOkToasts });

    for (const [key, id] of [['text', ids.text], ['audio', ids.audio]]) {
        await page.evaluate((nid) => window.__cn.setUI({ sel: new Set([nid]) }), id);
        await page.waitForTimeout(450);
        const count = await page.locator('#ntb').count();
        const emptyDock = await page.locator('#ntb.ntb-empty-upload').count();
        check('C14 空' + (key === 'text' ? '文本' : '音频') + '节点仍不挂浮动工具条', count === 0 && emptyDock === 0, { ntb: count, emptyDock });
    }
    await page.evaluate((nid) => window.__cn.setUI({ sel: new Set([nid]) }), ids.video);
    await page.waitForTimeout(400);
    shots.textAudio = await shot('06-text-audio-no-toolbar', { x: 880, y: 60, width: 460, height: 520 });

    const failures = checks.filter((c) => !c.ok);
    const result = {
        canvasId, base: BASE, mp4: MP4, profile,
        checks, failed: failures.length, passed: checks.length - failures.length,
        pageErrors: pageErrors.slice(0, 12), shots,
    };
    fs.writeFileSync(path.join(ART, 'result.json'), JSON.stringify(result, null, 2));
    console.log('');
    console.log((failures.length ? '[FAIL]' : '[PASS]') + ' 空视频节点「上传」单按钮条：' + (checks.length - failures.length) + '/' + checks.length + ' 条通过');
    if (pageErrors.length) console.log('页面错误：' + JSON.stringify(pageErrors.slice(0, 6)));
    await ctx.close();
    await api.delete('/api/canvases/' + encodeURIComponent(canvasId)).catch(() => null);
    await api.dispose();
    if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
