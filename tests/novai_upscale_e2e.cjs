#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT 图片「更多 → 增强 → 本地 2K」真实链路 e2e（真后端 + 真 Real-ESRGAN）。
 *
 *   # 1. 独立数据目录 + 把超分运行时放进数据目录（_models_path 优先读数据目录）
 *   mkdir -p /tmp/novai-verify-hd/assets/models && cp -R assets/models/realesrgan-ncnn-vulkan /tmp/novai-verify-hd/assets/models/
 *   # 2. 起真后端
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-verify-hd python3 main.py &
 *   # 3. 跑
 *   node tests/novai_upscale_e2e.cjs
 *
 * 断言：浮层三项 → 点「本地 2K」→ POST /api/image/upscale {url,target:"2k"} 200 →
 *       节点多一个历史版本、长边 2048、hi 指到新版本、输出文件真实落盘且像素 2048×1536、
 *       浏览器能加载到 2048px 的图、原图没被改写。截图落 tests/artifacts/upscale/。
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const SRC = 'verify_src.png';
const SRC_W = 800;
const SRC_H = 600;

function seedPixel(x, y) {
    const band = (x + y) % 96;
    return [40 + (x % 120), 70 + (y % 90), 120 + band, 255].slice(0, 3);
}

(async () => {
    const c = H.checker('本地超分真实链路（真后端 /api/image/upscale + Real-ESRGAN）');
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) {
            c.check('后端 ' + H.BASE + ' 可用', false, { status: health.status() });
            return c.finish();
        }
        const runtime = await (await api.get('/api/image/upscale/runtime')).json();
        c.check('运行时已安装（installed=true，数据目录里有 realesrgan-ncnn-vulkan）', runtime.installed === true, runtime);

        const srcFile = path.join(H.OUT_DIR, SRC);
        if (!fs.existsSync(srcFile) || H.readPngInfo(srcFile).width !== SRC_W) H.writePng(srcFile, SRC_W, SRC_H, 2, seedPixel);
        const srcInfo = H.readPngInfo(srcFile);
        c.check('种子图真实存在且为 800×600', srcInfo.width === SRC_W && srcInfo.height === SRC_H, srcInfo);

        canvasId = await H.createCanvas(api, 'VERIFY-HD-2K-' + Date.now());
        browser = await H.launchBrowser();
        const { page, pageErrors } = await H.openCanvasPage(browser, canvasId);
        const nodeId = await H.addImageNode(page, { url: '/output/' + SRC, width: SRC_W, height: SRC_H, title: '超分验证图' });
        await page.waitForTimeout(600);

        const before = await H.nodeGen(page, nodeId);
        c.check('初始节点只有 1 个历史版本', before.hist.length === 1, { hist: before.hist.length, hi: before.hi });
        const nodeEl = page.locator('.node[data-id="' + nodeId + '"]').first();
        await page.mouse.click(400, 300); // 点空白处取消选中：节点下方不再压着生成面板，截图能看清版本标记
        await page.waitForTimeout(400);
        await c.shot(page, '01-before-full');
        await nodeEl.screenshot({ path: path.join(H.ART_DIR, '01-before-node.png') }).catch(() => null);
        c.results.shots['01-before-node'] = path.join(H.ART_DIR, '01-before-node.png');

        await H.openMoreMenu(page, nodeId);
        c.check('「更多」菜单里出现「增强」行（data-k=enhance-menu）', await page.locator('[data-k="enhance-menu"]').isVisible());
        await H.openEnhanceFlyout(page);
        const fly = page.locator('[data-k="enhance-flyout"]');
        const keys = await fly.locator('[data-k]').evaluateAll((els) => els.map((el) => el.getAttribute('data-k')));
        c.check('二级浮层恰好是 hd-2k / hd-4k / enhance-ai 三项', JSON.stringify(keys) === JSON.stringify(['hd-2k', 'hd-4k', 'enhance-ai']), keys);
        const labels = (await fly.locator('button').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
        c.check('三项文案 = 本地 2K / 本地 4K / AI 增强 2×', labels[0].indexOf('本地 2K') === 0 && labels[1].indexOf('本地 4K') === 0 && labels[2].indexOf('AI 增强 2×') === 0, labels);
        // 悬停状态下手不抖：把指针停在「本地 2K」上再截图（菜单入场动画期间偶发 pointerleave 会把子浮层关掉）
        await page.locator('[data-k="hd-2k"]').hover({ timeout: 15000 });
        await fly.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(250);
        c.check('截图前浮层仍在（三项可点）', await page.locator('[data-k="hd-2k"]').isVisible());
        await c.shot(page, '02-enhance-flyout');

        const responsePromise = page.waitForResponse((response) => response.url().indexOf('/api/image/upscale') >= 0
            && response.url().indexOf('/runtime') < 0 && response.request().method() === 'POST', { timeout: 180000 });
        const startedAt = Date.now();
        await fly.locator('[data-k="hd-2k"]').click();
        const response = await responsePromise;
        const body = await response.json();
        const requestBody = JSON.parse(response.request().postData() || '{}');
        c.check('POST /api/image/upscale 的请求体是 {url:"/output/verify_src.png", target:"2k"}',
            requestBody.url === '/output/' + SRC && requestBody.target === '2k', requestBody);
        c.check('接口返回 200', response.status() === 200, { status: response.status() });

        const after = await H.waitNodeHist(page, nodeId, 2, 180000);
        const newest = after.hist[1];
        c.check('节点历史版本从 1 变 2（原图保留在历史里）', after.hist.length === 2, { hist: after.hist.map((row) => row.url) });
        c.check('hi 指到新版本', after.hi === 1, { hi: after.hi });
        c.check('新版本长边 = 2048（2K）', Math.max(newest.w, newest.h) === 2048, { w: newest.w, h: newest.h });
        c.check('新版本短边 = 1536（4:3 不变形）', Math.min(newest.w, newest.h) === 1536, { w: newest.w, h: newest.h });
        c.check('新版本 url 指向后端落的 hd_*.png（/assets/output/ 或 /output/）', /^\/(assets\/)?output\/hd_[0-9a-f]+\.png$/.test(String(newest.url || '')), newest.url);

        const outFile = H.fileForUrl(newest.url) || '';
        const outExists = fs.existsSync(outFile);
        const outInfo = outExists ? H.readPngInfo(outFile) : null;
        c.check('输出文件真实落盘（' + outFile + '）', outExists && outInfo.bytes > 10240, outInfo);
        c.check('输出文件像素 2048×1536（PNG 头实测）', !!outInfo && outInfo.width === 2048 && outInfo.height === 1536, outInfo);
        c.check('后端返回的 width/height 与文件一致', body.width === (outInfo && outInfo.width) && body.height === (outInfo && outInfo.height), { body: { width: body.width, height: body.height }, file: outInfo });
        c.check('method = ai-blend（真跑 4× 模型再与 LANCZOS 基线混合）', body.method === 'ai-blend', { method: body.method, elapsed_ms: body.elapsed_ms });
        c.check('skipped = false（不是原图直接指回）', body.skipped !== true, { skipped: body.skipped });
        c.check('elapsed_ms 是正数', Number(body.elapsed_ms) > 0, { elapsed_ms: body.elapsed_ms });

        const natural = await page.evaluate((url) => new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
            image.onerror = () => resolve(null);
            image.src = url;
        }), newest.url);
        c.check('浏览器能加载到 2048×1536 的新图', !!natural && natural.w === 2048 && natural.h === 1536, natural);

        const srcAfter = H.readPngInfo(srcFile);
        c.check('原图文件仍是 800×600（没被就地覆盖）', srcAfter.width === SRC_W && srcAfter.height === SRC_H, srcAfter);
        c.check('节点显示的是新版本（node.url == 新版本 url）', after.url === newest.url, { nodeUrl: after.url, newest: newest.url });

        const toast = await H.waitToast(page, '本地超分 2K完成', 15000).catch(() => '');
        c.check('完成提示是「本地超分 2K完成…」', toast.indexOf('本地超分 2K完成') >= 0, toast);
        c.check('全程耗时 < 180 秒', Date.now() - startedAt < 180000, { ms: Date.now() - startedAt });

        // 取消选中再截图：不然节点下方会压着生成面板，看不清「‹ 2/2 ›」版本标记
        await page.mouse.click(400, 300);
        await page.waitForTimeout(400);
        await c.shot(page, '03-after-full');
        await nodeEl.screenshot({ path: path.join(H.ART_DIR, '04-after-node.png') }).catch(() => null);
        c.results.shots['04-after-node'] = path.join(H.ART_DIR, '04-after-node.png');
        c.check('页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));

        c.results.canvasId = canvasId;
        c.results.output = { url: newest.url, file: outFile, width: outInfo && outInfo.width, height: outInfo && outInfo.height, method: body.method, elapsed_ms: body.elapsed_ms };
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const results = c.finish();
        fs.mkdirSync(H.ART_DIR, { recursive: true });
        fs.writeFileSync(path.join(H.ART_DIR, 'result-real-chain.json'), JSON.stringify(results, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
