#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT「增强」菜单的确定性验收（全部用 page.route 模拟接口，不依赖真外网 / 真模型）：
 *
 *   场景 A（验收项 4）下载轮询：运行时未安装 → 弹下载窗 → 下载 → 进度 10/55/100 → 装好自动关窗并接着超分 → 节点写回新版本
 *   场景 B（验收项 5）skipped：/api/image/upscale 返回 skipped:true → 只提示「原图已经达到这个精度，不用再放大」，不新增历史版本
 *   场景 C（验收项 6）AI 增强：点 "enhance-ai" 走在线图片编辑（/api/canvas-image-tasks），不打 /api/image/upscale
 *   场景 D（验收项 7）抠图回归：/output 直传、dataURL 归一上传、外链读不到时的提示文案（localMattingPath → localMediaPath 重构后不变糟）
 *   场景 E（task-3 修复）失败后重试成功：旧错误横幅必须被清掉，不能和新版本同时挂着
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-verify-hd python3 main.py &
 *   node tests/novai_upscale_mock_e2e.cjs                     # 正常跑：全部要绿
 *   node tests/novai_upscale_mock_e2e.cjs --replay-old-fix   # 回放修复前：场景 E 应当变红（退出 0 表示「按预期变红」）
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

/** 回放模式：把「成功时清 err」这一行的效果在页面里干掉，用来证明新断言在修复前是红的 */
const REPLAY_OLD_FIX = process.argv.includes('--replay-old-fix');

const MOCK_HD = '/assets/output/mock_hd_2k.png';
const MOCK_AI = '/assets/output/mock_ai_2x.png';
const MOCK_CUT = '/assets/output/mock_cutout.png';
const MOCK_UPLOAD = '/assets/mock_upload.png';

const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
});

function writeMockFiles() {
    const outRoot = path.join(H.ASSETS_DIR, 'output');
    if (!fs.existsSync(path.join(outRoot, 'mock_hd_2k.png'))) {
        H.writePng(path.join(outRoot, 'mock_hd_2k.png'), 2048, 1536, 2, (x, y) => [30 + (x % 200), 60 + (y % 180), 150]);
    }
    if (!fs.existsSync(path.join(outRoot, 'mock_ai_2x.png'))) {
        H.writePng(path.join(outRoot, 'mock_ai_2x.png'), 1600, 1200, 2, (x, y) => [160, 40 + (y % 160), 60 + (x % 120)]);
    }
    if (!fs.existsSync(path.join(outRoot, 'mock_cutout.png'))) {
        H.writePng(path.join(outRoot, 'mock_cutout.png'), 800, 600, 6, (x, y) => {
            const dx = (x - 400) / 300, dy = (y - 300) / 220;
            const inside = dx * dx + dy * dy < 1;
            return inside ? [240, 200, 90, 255] : [0, 0, 0, 0];
        });
    }
    if (!fs.existsSync(path.join(H.ASSETS_DIR, 'mock_upload.png'))) {
        H.writePng(path.join(H.ASSETS_DIR, 'mock_upload.png'), 800, 600, 2, (x, y) => [90, 90 + (y % 90), 90 + (x % 90)]);
    }
    return {
        hd: path.join(outRoot, 'mock_hd_2k.png'),
        ai: path.join(outRoot, 'mock_ai_2x.png'),
        cut: path.join(outRoot, 'mock_cutout.png'),
    };
}

/* ---------------- 场景 A：下载轮询 ---------------- */
async function scenarioDownload(c) {
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const state = { statusCalls: 0, downloadHits: 0, upscaleHits: 0, upscaleBody: null };
    try {
        canvasId = await H.createCanvas(api, 'VERIFY-MOCK-DL-' + Date.now());
        browser = await H.launchBrowser();
        const { page, pageErrors } = await H.openCanvasPage(browser, canvasId);

        await page.route(/\/api\/image\/upscale\/runtime\/download$/, async (route) => {
            state.downloadHits += 1;
            return json(route, { ok: true, task_id: 'upscale_runtime_download' });
        });
        await page.route(/\/api\/image\/upscale\/runtime$/, async (route) => {
            state.statusCalls += 1;
            const progress = [10, 55, 100];
            const index = state.statusCalls - 2;
            if (state.statusCalls === 1) return json(route, { installed: false, downloading: false, progress: 0, message: '未安装', platform: 'macos' });
            if (index < progress.length) return json(route, { installed: false, downloading: true, progress: progress[index], message: '正在下载…' + progress[index] + '%', platform: 'macos' });
            return json(route, { installed: true, downloading: false, progress: 100, message: '已安装', platform: 'macos' });
        });
        await page.route(/\/api\/image\/upscale$/, async (route) => {
            state.upscaleHits += 1;
            try { state.upscaleBody = JSON.parse(route.request().postData() || '{}'); } catch (error) { state.upscaleBody = null; }
            return json(route, { url: MOCK_HD, name: '高清放大_mock.png', kind: 'image', mime: 'image/png', method: 'ai-blend', width: 2048, height: 1536, source_width: 800, source_height: 600, target: '2k', skipped: false, elapsed_ms: 1234 });
        });

        const nodeId = await H.addImageNode(page, { url: '/output/verify_src.png', width: 800, height: 600, title: '下载链路验证图' });
        await page.waitForTimeout(400);
        await H.openMoreMenu(page, nodeId);
        await H.openEnhanceFlyout(page);
        await page.locator('[data-k="hd-2k"]').click();

        const modalButton = page.locator('[data-k="hd-download"]');
        await modalButton.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(350); // 等弹层入场动画（popIn）走完再截图，否则会拍到 opacity 0 的首帧
        c.check('A1 运行时没装时先弹「本地超分组件」下载窗（不是直接报错）', await modalButton.isVisible());
        const modalText = await page.locator('#modal .modal').innerText();
        c.check('A2 下载窗标题「本地超分组件」+ 说明含「约 50 MB」', modalText.indexOf('本地超分组件') >= 0 && modalText.indexOf('50 MB') >= 0, modalText.slice(0, 160));
        c.check('A3 弹窗时还没去打超分接口', state.upscaleHits === 0, { upscaleHits: state.upscaleHits });
        await c.shot(page, '05-download-modal');
        c.results.shots['05-download-modal'] = path.join(H.ART_DIR, '05-download-modal.png');

        await modalButton.click();
        c.check('A4 点「下载并超分」发出 POST /api/image/upscale/runtime/download', state.downloadHits === 1, { hits: state.downloadHits });

        const waitBar = async (pct) => page.waitForFunction((wanted) => {
            const bar = document.querySelector('.mbd .mm-bar i');
            return !!bar && bar.style.width === wanted;
        }, pct + '%', { timeout: 20000 });
        await waitBar(10);
        const meta10 = await page.locator('.mbd .mm-meta').innerText();
        c.check('A5 进度条推进到 10% 且文案来自后端 message', meta10.indexOf('正在下载…10%') >= 0, meta10);
        c.check('A6 下载中显示「后台继续」而不是下载按钮', await page.locator('.mbd .btn', { hasText: '后台继续' }).count() === 1);
        await waitBar(55);
        await c.shot(page, '06-download-progress');
        c.results.shots['06-download-progress'] = path.join(H.ART_DIR, '06-download-progress.png');
        const meta55 = await page.locator('.mbd .mm-meta').innerText();
        c.check('A7 进度条推进到 55%', meta55.indexOf('正在下载…55%') >= 0, meta55);
        await waitBar(100);

        await modalButton.waitFor({ state: 'hidden', timeout: 20000 });
        c.check('A8 装好后弹窗自动关闭', !(await modalButton.isVisible().catch(() => false)));
        const toastReady = await H.waitToast(page, '本地超分组件已就绪', 15000).catch(() => '');
        c.check('A9 提示「本地超分组件已就绪，开始超分」', toastReady.indexOf('本地超分组件已就绪') >= 0, toastReady);
        c.check('A10 状态轮询共 ' + state.statusCalls + ' 次（1 次预检 + 4 次轮询）', state.statusCalls === 5, { statusCalls: state.statusCalls });

        const after = await H.waitNodeHist(page, nodeId, 2, 20000);
        c.check('A11 装好后自动接着超分：只发了一次 POST /api/image/upscale', state.upscaleHits === 1, { hits: state.upscaleHits, body: state.upscaleBody });
        c.check('A12 超分请求体是 {url:"/output/verify_src.png", target:"2k"}', !!state.upscaleBody && state.upscaleBody.url === '/output/verify_src.png' && state.upscaleBody.target === '2k', state.upscaleBody);
        c.check('A13 节点写回新版本（长边 2048）', Math.max(after.hist[1].w, after.hist[1].h) === 2048, { w: after.hist[1].w, h: after.hist[1].h });
        const toastDone = await H.waitToast(page, '本地超分 2K完成', 15000).catch(() => '');
        c.check('A14 完成提示「本地超分 2K完成…」', toastDone.indexOf('本地超分 2K完成') >= 0, toastDone);
        c.check('A15 页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));
        await c.shot(page, '07-after-download-upscale');
        c.results.shots['07-after-download-upscale'] = path.join(H.ART_DIR, '07-after-download-upscale.png');
    } catch (error) {
        c.check('场景 A 执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        c.results.scenarioA = state;
    }
}

/* ---------------- 场景 B：skipped ---------------- */
async function scenarioSkipped(c) {
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const state = { upscaleHits: 0, body: null };
    try {
        canvasId = await H.createCanvas(api, 'VERIFY-MOCK-SKIP-' + Date.now());
        browser = await H.launchBrowser();
        const { page } = await H.openCanvasPage(browser, canvasId);
        await page.route(/\/api\/image\/upscale\/runtime$/, (route) => json(route, { installed: true, downloading: false, progress: 100, message: '已安装', platform: 'macos' }));
        await page.route(/\/api\/image\/upscale$/, async (route) => {
            state.upscaleHits += 1;
            try { state.body = JSON.parse(route.request().postData() || '{}'); } catch (error) { state.body = null; }
            return json(route, { url: '/output/verify_src.png', name: 'verify_src.png', kind: 'image', mime: 'image/png', width: 800, height: 600, source_width: 800, source_height: 600, target: '2k', skipped: true, elapsed_ms: 12 });
        });
        const nodeId = await H.addImageNode(page, { url: '/output/verify_src.png', width: 800, height: 600, title: 'skipped 验证图' });
        await page.waitForTimeout(400);
        const before = await H.nodeGen(page, nodeId);
        await H.openMoreMenu(page, nodeId);
        await H.openEnhanceFlyout(page);
        await page.locator('[data-k="hd-2k"]').click();

        const toast = await H.waitToast(page, '原图已经达到这个精度', 15000).catch(() => '');
        c.check('B1 提示「原图已经达到这个精度，不用再放大」', toast.indexOf('原图已经达到这个精度，不用再放大') >= 0, toast);
        c.check('B2 弹的是提示而不是错误（没有「失败」「不支持」字样）', toast.indexOf('失败') < 0 && toast.indexOf('不支持') < 0, toast);
        const after = await H.nodeGen(page, nodeId);
        c.check('B3 不新增历史版本（仍是 1 条）', after.hist.length === before.hist.length && after.hist.length === 1, { before: before.hist.length, after: after.hist.length });
        c.check('B4 节点当前画面仍是原图', after.url === '/output/verify_src.png', after.url);
        c.check('B5 hi 没动', after.hi === 0, { hi: after.hi });
        c.check('B6 请求体 target=2k', !!state.body && state.body.target === '2k', state.body);
        c.check('B7 没有弹下载窗', await page.locator('[data-k="hd-download"]').count() === 0);
        await c.shot(page, '08-skipped-toast');
        c.results.shots['08-skipped-toast'] = path.join(H.ART_DIR, '08-skipped-toast.png');
    } catch (error) {
        c.check('场景 B 执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
    }
}

/* ---------------- 场景 C：AI 增强 2× 仍走在线 ---------------- */
async function scenarioAiEnhance(c, realConfig) {
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const state = { imageTasks: 0, upscaleHits: 0, taskBody: null, polled: 0 };
    try {
        const provider = {
            id: 'fake', name: 'Fake', base_url: 'http://127.0.0.1:9/v1', protocol: 'openai',
            enabled: true, primary: true, has_key: true,
            image_models: ['gpt-image-1'], chat_models: [], video_models: [], audio_models: [],
        };
        const config = Object.assign({}, realConfig, { api_providers: [provider], image_models: ['gpt-image-1'], image_model: 'gpt-image-1' });
        canvasId = await H.createCanvas(api, 'VERIFY-MOCK-AI-' + Date.now());
        browser = await H.launchBrowser();
        // /api/config 决定模型列表，必须在首屏请求之前就拦下
        const { page } = await H.openCanvasPage(browser, canvasId, {
            beforeGoto: async (target) => { await target.route('**/api/config', (route) => json(route, config)); },
        });
        await page.route(/\/api\/image\/upscale$/, (route) => { state.upscaleHits += 1; return json(route, { url: MOCK_HD, width: 2048, height: 1536, skipped: false, method: 'ai-blend' }); });
        await page.route('**/api/canvas-image-tasks', async (route) => {
            state.imageTasks += 1;
            try { state.taskBody = JSON.parse(route.request().postData() || '{}'); } catch (error) { state.taskBody = null; }
            return json(route, { task_id: 'ai_task_1' });
        });
        await page.route('**/api/canvas-image-tasks/ai_task_1', (route) => {
            state.polled += 1;
            return json(route, { status: 'succeeded', result: { images: [{ url: MOCK_AI, width: 1600, height: 1200 }] } });
        });

        const nodeId = await H.addImageNode(page, { url: '/output/verify_src.png', width: 800, height: 600, title: 'AI 增强验证图' });
        await page.waitForTimeout(800);
        const models = await page.evaluate(() => (window.__cn.state.models || []).map((model) => model.id));
        c.check('C0 拦截 /api/config 后页面拿到一个可用图片模型（保证在线编辑真的能发出去）', models.length > 0, models);
        await H.openMoreMenu(page, nodeId);
        await H.openEnhanceFlyout(page);
        await page.locator('[data-k="enhance-ai"]').click();

        const after = await H.waitNodeHist(page, nodeId, 2, 30000);
        c.check('C1 点「AI 增强 2×」打到在线图片编辑接口 /api/canvas-image-tasks', state.imageTasks === 1, { imageTasks: state.imageTasks });
        c.check('C2 没有误打本地超分接口 /api/image/upscale', state.upscaleHits === 0, { upscaleHits: state.upscaleHits });
        const body = state.taskBody || {};
        c.check('C3 请求体带在线模型与增强提示词', String(body.prompt || '').indexOf('高清增强') >= 0 && body.model === 'gpt-image-1' && body.provider_id === 'fake', { prompt: String(body.prompt || '').slice(0, 80), model: body.model, provider: body.provider_id });
        c.check('C4 参考图是节点当前原图', Array.isArray(body.reference_images) && body.reference_images[0] && body.reference_images[0].url === '/output/verify_src.png', body.reference_images);
        c.check('C5 轮询任务拿结果', state.polled >= 1, { polled: state.polled });
        c.check('C6 新版本长边 1600 且 model 标记为「增强」', after.hist[1].w === 1600 && after.hist[1].meta && after.hist[1].meta.model === '增强', { w: after.hist[1].w, h: after.hist[1].h, meta: after.hist[1].meta });
        const toast = await H.waitToast(page, '增强完成', 15000).catch(() => '');
        c.check('C7 完成提示仍是「增强完成…」（与改之前一致）', toast.indexOf('增强完成') >= 0, toast);
        await c.shot(page, '09-ai-enhance');
        c.results.shots['09-ai-enhance'] = path.join(H.ART_DIR, '09-ai-enhance.png');
    } catch (error) {
        c.check('场景 C 执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
    }
}

/* ---------------- 场景 D：抠图回归（localMediaPath 重构） ---------------- */
async function scenarioMatting(c, mockFiles) {
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const state = { mattingBodies: [], uploads: 0 };
    try {
        canvasId = await H.createCanvas(api, 'VERIFY-MOCK-CUTOUT-' + Date.now());
        browser = await H.launchBrowser();
        const { page } = await H.openCanvasPage(browser, canvasId);
        await page.route('**/api/matting/model/status', (route) => json(route, {
            downloaded: true, model_size: '349 MB', model_size_mb: 349, downloading: false, verifying: false,
            progress: 100, downloaded_mb: 349.1, total_mb: 349.1, speed_mbps: 0, eta_seconds: 0,
            attempt: 0, retrying: false, hint: '', cancelled: false, error: '', load_error: '', runtime_ready: true, available: true,
        }));
        await page.route('**/api/image/matting', async (route) => {
            try { state.mattingBodies.push(JSON.parse(route.request().postData() || '{}')); } catch (error) { state.mattingBodies.push(null); }
            return json(route, { url: MOCK_CUT, name: '抠图_mock.png', kind: 'image', mime: 'image/png', width: 800, height: 600 });
        });
        await page.route('**/api/ai/upload-base64', async (route) => {
            state.uploads += 1;
            return json(route, { files: [{ url: MOCK_UPLOAD, name: '抠图原图.png', kind: 'image' }] });
        });
        await page.route('https://example.invalid/**', (route) => route.abort());

        // D1：/output 本地文件直传
        const localId = await H.addImageNode(page, { url: '/output/verify_src.png', width: 800, height: 600, title: '抠图-本地文件' });
        await page.waitForTimeout(400);
        await H.openMoreMenu(page, localId);
        await page.locator('[data-k="cutout"]').click();
        const localAfter = await H.waitNodeHist(page, localId, 2, 30000);
        const body1 = state.mattingBodies[0] || {};
        c.check('D1 本地文件：POST /api/image/matting {url:"/output/verify_src.png", mode:"local"}', body1.url === '/output/verify_src.png' && body1.mode === 'local', body1);
        c.check('D2 本地文件：产出新版本，url 指向透明 PNG', /mock_cutout\.png$/.test(String(localAfter.hist[1].url || '')), localAfter.hist[1].url);
        const cutInfo = H.readPngInfo(path.join(H.ASSETS_DIR, 'output', 'mock_cutout.png'));
        c.check('D3 抠图结果文件是 RGBA（colorType 6，带 alpha 通道）', cutInfo.colorType === 6, cutInfo);
        const natural = await page.evaluate((url) => new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
            image.onerror = () => resolve(null);
            image.src = url;
        }), localAfter.hist[1].url);
        c.check('D4 浏览器能加载抠图结果 800×600', !!natural && natural.w === 800 && natural.h === 600, natural);
        const cutToast = await H.waitToast(page, '抠图完成', 15000).catch(() => '');
        c.check('D5 抠图完成提示仍是「抠图完成…」', cutToast.indexOf('抠图完成') >= 0, cutToast);
        await c.shot(page, '10-cutout-local');
        c.results.shots['10-cutout-local'] = path.join(H.ART_DIR, '10-cutout-local.png');

        // D2：dataURL 源图仍先上传资源库再抠图
        const dataUrl = 'data:image/png;base64,' + H.pngBuffer(40, 30, 2, (x, y) => [x, y, 100]).toString('base64');
        const dataId = await H.addImageNode(page, { url: dataUrl, width: 40, height: 30, title: '抠图-dataURL' });
        await page.waitForTimeout(400);
        const uploadsBefore = state.uploads;
        await H.openMoreMenu(page, dataId);
        await page.locator('[data-k="cutout"]').click();
        const dataAfter = await H.waitNodeHist(page, dataId, 2, 30000);
        const body2 = state.mattingBodies[1] || {};
        c.check('D6 dataURL：先走 /api/ai/upload-base64 归一成资源库地址', state.uploads === uploadsBefore + 1, { uploads: state.uploads });
        c.check('D7 dataURL：抠图接口收到归一后的 /assets 地址而不是 data:', body2.url === MOCK_UPLOAD && body2.mode === 'local', body2);
        c.check('D8 dataURL：同样产出新版本', /mock_cutout\.png$/.test(String(dataAfter.hist[1].url || '')), dataAfter.hist[1].url);

        // D3：外链读不到时提示文案（与重构前逐字一致）
        const extId = await H.addImageNode(page, { url: 'https://example.invalid/pic.png', width: 800, height: 600, title: '抠图-外链' });
        await page.waitForTimeout(400);
        const extBefore = await H.nodeGen(page, extId);
        const mattingBefore = state.mattingBodies.length;
        await H.openMoreMenu(page, extId);
        await page.locator('[data-k="cutout"]').click();
        const extToast = await H.waitToast(page, '就能本地抠图', 15000).catch(() => '');
        c.check('D9 外链读不到时提示仍是「先把图片下载到本地再拖进画布，就能本地抠图」', extToast.indexOf('这张图在外部服务器上、浏览器读不到') >= 0 && extToast.indexOf('就能本地抠图') >= 0, extToast);
        const extAfter = await H.nodeGen(page, extId);
        c.check('D10 外链失败不新增历史版本、不打抠图接口', extAfter.hist.length === extBefore.hist.length && state.mattingBodies.length === mattingBefore, { before: extBefore.hist.length, after: extAfter.hist.length, mattingCalls: state.mattingBodies.length - mattingBefore });
        await c.shot(page, '11-cutout-external-error');
        c.results.shots['11-cutout-external-error'] = path.join(H.ART_DIR, '11-cutout-external-error.png');
        c.results.mattingBodies = state.mattingBodies;
    } catch (error) {
        c.check('场景 D 执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
    }
}

/* ---------------- 场景 E：失败后重试成功要清掉旧错误横幅（task-3 修复的回归保护） ---------------- */
async function scenarioStaleError(c, options = {}) {
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const state = { calls: 0 };
    try {
        canvasId = await H.createCanvas(api, 'VERIFY-MOCK-STALE-' + Date.now());
        browser = await H.launchBrowser();
        const { page } = await H.openCanvasPage(browser, canvasId);
        await page.route(/\/api\/image\/upscale\/runtime$/, (route) => json(route, { installed: true, downloading: false, progress: 100, message: '已安装', platform: 'macos' }));
        await page.route(/\/api\/image\/upscale$/, (route) => {
            state.calls += 1;
            if (state.calls === 1) return json(route, { detail: '高清放大失败：模拟磁盘满' }, 500);
            return json(route, { url: MOCK_HD, name: '高清放大_mock.png', kind: 'image', mime: 'image/png', method: 'ai-blend', width: 2048, height: 1536, source_width: 800, source_height: 600, target: '2k', skipped: false, elapsed_ms: 900 });
        });
        if (options.replayOldFix) {
            // 只把「patchGen({err: undefined})」这条清错补丁吃掉，其它照旧 —— 等价于修复前的代码路径
            await page.evaluate(() => {
                const store = window.__cn;
                const original = store.patchGen.bind(store);
                store.patchGen = (id, patch, opts) => {
                    const onlyClearsError = patch && typeof patch === 'object' && Object.keys(patch).length === 1
                        && Object.prototype.hasOwnProperty.call(patch, 'err') && patch.err === undefined;
                    return onlyClearsError ? undefined : original(id, patch, opts);
                };
            });
        }

        const nodeId = await H.addImageNode(page, { url: '/output/verify_src.png', width: 800, height: 600, title: '错误后重试验证图' });
        await page.waitForTimeout(400);

        // 第一次：后端 500 → 节点出现错误横幅
        await H.openMoreMenu(page, nodeId);
        await H.openEnhanceFlyout(page);
        await page.locator('[data-k="hd-2k"]').click();
        await page.waitForFunction((id) => {
            const node = window.__cn.node(id);
            return !!(node && node.data && node.data.gen && node.data.gen.err);
        }, nodeId, { timeout: 20000 });
        const errAfterFail = await page.evaluate((id) => window.__cn.node(id).data.gen.err, nodeId);
        const shotPrefix = options.replayOldFix ? 'replay-' : '';
        c.check('E1 第一次超分失败后节点记下了错误（gen.err 非空）', !!errAfterFail, errAfterFail);
        c.check('E2 失败后错误横幅在节点上可见', await page.locator('[data-nerr-text]').count() === 1, await page.locator('[data-nerr-text]').allInnerTexts());
        await c.shot(page, shotPrefix + '12-stale-error-after-failure');
        c.results.shots[shotPrefix + '12-stale-error-after-failure'] = path.join(H.ART_DIR, shotPrefix + '12-stale-error-after-failure.png');

        // 等第一次失败的 toast 自己消失（toast 存活 2.6s；节点上的错误横幅不受影响），
        // 这样后面才能干净地断言「成功提示里没有旧错误文案」。
        await page.waitForFunction(() => !Array.from(document.querySelectorAll('#toasts .toast'))
            .some((el) => (el.textContent || '').indexOf('模拟磁盘满') >= 0), null, { timeout: 10000 });

        // 第二次：后端 200 → 新版本出现，且旧错误横幅要被清掉
        await page.waitForTimeout(400);
        await H.openMoreMenu(page, nodeId);
        await H.openEnhanceFlyout(page);
        await page.locator('[data-k="hd-2k"]').click();
        const after = await H.waitNodeHist(page, nodeId, 2, 20000);
        const errAfterSuccess = await page.evaluate((id) => {
            const node = window.__cn.node(id);
            return node && node.data && node.data.gen ? node.data.gen.err : 'NO_GEN';
        }, nodeId);
        const bannerCount = await page.locator('[data-nerr-text]').count();
        c.check('E3 第二次超分成功、节点多出新版本（hist=2、长边 2048）', after.hist.length === 2 && Math.max(after.hist[1].w, after.hist[1].h) === 2048, { hist: after.hist.length, w: after.hist[1].w, h: after.hist[1].h });
        c.check('E4 成功后 gen.err 已清空（不是上次的旧文案）', !errAfterSuccess, errAfterSuccess);
        c.check('E5 成功后节点上的错误横幅消失', bannerCount === 0, { bannerCount: bannerCount });
        const toast = await H.waitToast(page, '本地超分 2K完成', 15000).catch(() => '');
        c.check('E6 成功提示是「本地超分 2K完成…」而不是旧错误文案', toast.indexOf('本地超分 2K完成') >= 0 && toast.indexOf('模拟磁盘满') < 0, toast);
        await c.shot(page, shotPrefix + '13-after-retry');
        c.results.shots[shotPrefix + '13-after-retry'] = path.join(H.ART_DIR, shotPrefix + '13-after-retry.png');
        c.results.scenarioE = { replayOldFix: !!options.replayOldFix, errAfterFail: errAfterFail, errAfterSuccess: errAfterSuccess, bannerCount: bannerCount };
    } catch (error) {
        c.check('场景 E 执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
    }
}

(async () => {
    const c = H.checker('增强菜单确定性验收（下载轮询 / skipped / AI 增强 / 抠图回归 / 失败后重试清错）');
    const api = await request.newContext({ baseURL: H.BASE });
    let realConfig = {};
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) {
            c.check('后端 ' + H.BASE + ' 可用', false, { status: health.status() });
            return c.finish();
        }
        realConfig = await health.json();
    } finally {
        await api.dispose();
    }
    c.check('种子图存在（真实数据都在独立数据目录 /tmp/novai-verify-hd）', fs.existsSync(path.join(H.OUT_DIR, 'verify_src.png')), H.OUT_DIR);
    const mockFiles = writeMockFiles();
    c.check('mock 结果图已生成（2048×1536 / 1600×1200 / RGBA 抠图）',
        H.readPngInfo(mockFiles.hd).width === 2048 && H.readPngInfo(mockFiles.ai).width === 1600 && H.readPngInfo(mockFiles.cut).colorType === 6,
        { hd: H.readPngInfo(mockFiles.hd), ai: H.readPngInfo(mockFiles.ai), cut: H.readPngInfo(mockFiles.cut) });

    if (REPLAY_OLD_FIX) {
        // 回放修复前逻辑：只跑场景 E，预期 E4/E5 变红（证明这组断言是那一行修复的回归保护）
        c.check('回放模式：只跑场景 E（把清 err 的补丁吃掉，模拟修复前）', true);
        await scenarioStaleError(c, { replayOldFix: true });
        const results = c.finish();
        results.replayOldFix = true;
        fs.mkdirSync(H.ART_DIR, { recursive: true });
        fs.writeFileSync(path.join(H.ART_DIR, 'result-replay-old-fix.json'), JSON.stringify(results, null, 2));
        console.log('');
        console.log(results.failed ? '结果：模拟修复前 → 场景 E 变红（' + results.failed + ' 条），回归保护有效' : '结果：模拟修复前仍然全绿 → 这组断言测不到该修复');
        process.exit(results.failed ? 0 : 1);
    }
    await scenarioDownload(c);
    await scenarioSkipped(c);
    await scenarioAiEnhance(c, realConfig);
    await scenarioMatting(c, mockFiles);
    await scenarioStaleError(c, {});

    const results = c.finish();
    fs.mkdirSync(H.ART_DIR, { recursive: true });
    fs.writeFileSync(path.join(H.ART_DIR, 'result-mock.json'), JSON.stringify(results, null, 2));
    process.exit(results.failed ? 1 : 0);
})();
