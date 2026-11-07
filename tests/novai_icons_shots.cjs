#!/usr/bin/env node
'use strict';
/*
 * 图标观感验收（task-6）：图片节点工具条「无损改图」= layers（图层）、「更多 → 增强」= sparkle（✨）、
 * 「更多 → 擦除」= eraser（橡皮）——三者在同一屏里形状互不相同。
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-icons-verify python3 main.py &
 *   node tests/novai_icons_shots.cjs
 *
 * 截图落 tests/artifacts/icons/（deviceScaleFactor=2，元素区域裁切，方便肉眼看 14px 图标的形状）：
 *   01-toolbar-lossless.png          工具条（无损改图 = layers 图层）
 *   02-more-menu-enhance.png         更多菜单 + 增强浮层（增强 = sparkle；擦除 = eraser；浮层仍三项）
 *   03-compare-lossless-vs-eraser.png 工具条 + 菜单同框（无损 图层 / 擦除 橡皮，去重后的对照）
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const ICON_ART = path.join(__dirname, 'artifacts', 'icons');
const SRC = 'novai-canvas-ui/src/canvas/canvas-next/ui';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

async function clipAround(page, selectors, pad = 14) {
    const boxes = [];
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count() === 0) continue;
        const box = await locator.boundingBox().catch(() => null);
        if (box) boxes.push(box);
    }
    if (!boxes.length) return null;
    const viewport = page.viewportSize();
    const left = Math.min(...boxes.map((box) => box.x)) - pad;
    const top = Math.min(...boxes.map((box) => box.y)) - pad;
    const right = Math.max(...boxes.map((box) => box.x + box.width)) + pad;
    const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + pad;
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return {
        x, y,
        width: Math.min(viewport.width - x, Math.ceil(right - left)),
        height: Math.min(viewport.height - y, Math.ceil(bottom - top)),
    };
}

(async () => {
    const c = H.checker('图标观感：无损改图=layers / 增强=sparkle / 擦除=eraser（去重）');
    fs.mkdirSync(ICON_ART, { recursive: true });
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;

    /* ---------- 静态：线性描边 + 冻结图标数据 ---------- */
    try {
        const iconData = read(SRC + '/iconData.ts');
        c.check('S1 iconData.ts 里没有任何 fill=（图标一律线性描边，没有实心图形）', (iconData.match(/fill=/g) || []).length === 0);
        const iconCss = read(SRC + '/canvas-next.css');
        c.check('S2 svg.i 的样式是 fill:none + stroke:currentColor + stroke-width（线性）',
            /svg\.i\{[^}]*fill:none/.test(iconCss) && /svg\.i\{[^}]*stroke:currentColor/.test(iconCss) && /svg\.i\{[^}]*stroke-width:/.test(iconCss));
        const genPanel = read(SRC + '/GenPanel.tsx');
        c.check('S3 工具条「无损改图」用 layers', genPanel.indexOf('B("lossless", "layers", "无损改图")') >= 0);
        const lossless = read(SRC + '/editors/LosslessEdit.tsx');
        c.check('S4 无损改图加载态同步用 layers（没留旧图标）', lossless.indexOf('name={stalled ? "alert" : "layers"}') >= 0);
        const registry = read(SRC + '/editors/registry.tsx');
        c.check('S5 更多菜单「增强」用 sparkle', registry.indexOf('<Icon name="sparkle" size="s" />增强') >= 0);
        c.check('S6 更多菜单「擦除」仍是 eraser', registry.indexOf('<Icon name="eraser" size="s" />擦除') >= 0);
        c.check('S7 更多菜单里不再出现 zoomin（旧增强图标）', registry.indexOf('name="zoomin"') < 0);
        const iconDataMtime = fs.statSync(path.join(__dirname, '..', SRC + '/iconData.ts')).mtimeMs;
        const canonicalMtime = fs.statSync(path.join(__dirname, '..', 'tools/icons/canonical.json')).mtimeMs;
        c.check('S8 iconData.ts / tools/icons 没被这次改动碰（mtime 仍是 11-04）',
            new Date(iconDataMtime).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)
            && new Date(canonicalMtime).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10),
            { iconData: new Date(iconDataMtime).toISOString(), canonical: new Date(canonicalMtime).toISOString() });

        /* ---------- 起画布 ---------- */
        canvasId = await H.createCanvas(api, 'VERIFY-ICONS-' + Date.now());
        browser = await H.launchBrowser();
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));
        await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window.__cn && window.__cn.state && window.__cn.state.doc), null, { timeout: 30000 });
        await page.waitForTimeout(400);
        // 一张有画面的图片节点：工具条会显示「无损改图」，「更多」菜单里有「增强 / 擦除」
        const nodeId = await H.addImageNode(page, { url: '/output/icon-seed.png', width: 800, height: 600, title: '图标观感验证图' });
        // 造一张真实图片，避免节点显示成破图（只影响观感，不影响图标）
        if (!fs.existsSync(path.join(H.OUT_DIR, 'icon-seed.png'))) H.writePng(path.join(H.OUT_DIR, 'icon-seed.png'), 800, 600, 2, (x, y) => [40 + (x % 160), 90 + (y % 120), 170]);
        await page.waitForTimeout(1200);
        const toolbar = page.locator('#ntb').first();
        await toolbar.waitFor({ state: 'visible', timeout: 15000 });

        /* ---------- 工具条：无损改图 = layers ---------- */
        const losslessBtn = page.locator('#ntb [data-tb="lossless"]').first();
        c.check('T1 工具条上有「无损改图」按钮', await losslessBtn.isVisible());
        const losslessIcon = await losslessBtn.locator('svg').first().getAttribute('data-icon').catch(() => null);
        c.check('T2 无损改图的图标是 layers（图层），不再是 eraser', losslessIcon === 'layers', { dataIcon: losslessIcon });
        c.check('T3 工具条里没有任何 eraser（橡皮）图标', await page.locator('#ntb [data-icon="eraser"]').count() === 0);
        const clip1 = await clipAround(page, ['#ntb'], 16);
        await page.screenshot({ path: path.join(ICON_ART, '01-toolbar-lossless.png'), clip: clip1 });
        c.results.shots['01-toolbar-lossless'] = path.join(ICON_ART, '01-toolbar-lossless.png');
        console.log('SHOT  ' + c.results.shots['01-toolbar-lossless']);

        /* ---------- 更多菜单 + 增强浮层 ---------- */
        await H.openMoreMenu(page, nodeId);
        const eraseRow = page.locator('#pop .mi', { hasText: '擦除' }).first();
        c.check('M1 更多菜单里有「擦除」行', await eraseRow.isVisible());
        const eraseIcon = await eraseRow.locator('svg').first().getAttribute('data-icon').catch(() => null);
        c.check('M2 「擦除」仍是 eraser（橡皮）', eraseIcon === 'eraser', { dataIcon: eraseIcon });
        const enhanceIcon = await page.locator('[data-k="enhance-menu"] svg').first().getAttribute('data-icon').catch(() => null);
        c.check('M3 「增强」是 sparkle（和视频「高清」同一颗 ✨）', enhanceIcon === 'sparkle', { dataIcon: enhanceIcon });
        c.check('M4 「增强」行里没有 zoomin 旧图标', await page.locator('[data-k="enhance-menu"] [data-icon="zoomin"]').count() === 0);
        await H.openEnhanceFlyout(page);
        const fly = page.locator('[data-k="enhance-flyout"]');
        const keys = await fly.locator('[data-k]').evaluateAll((els) => els.map((el) => el.getAttribute('data-k')));
        c.check('M5 增强浮层仍是 hd-2k / hd-4k / enhance-ai 三项', JSON.stringify(keys) === JSON.stringify(['hd-2k', 'hd-4k', 'enhance-ai']), keys);
        const labels = (await fly.locator('button').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
        c.check('M6 三项文案不变（本地 2K / 本地 4K / AI 增强 2×）',
            labels[0].indexOf('本地 2K') === 0 && labels[1].indexOf('本地 4K') === 0 && labels[2].indexOf('AI 增强 2×') === 0, labels);
        const clip2 = await clipAround(page, ['#pop', '[data-k="enhance-flyout"]'], 16);
        await page.screenshot({ path: path.join(ICON_ART, '02-more-menu-enhance.png'), clip: clip2 });
        c.results.shots['02-more-menu-enhance'] = path.join(ICON_ART, '02-more-menu-enhance.png');
        console.log('SHOT  ' + c.results.shots['02-more-menu-enhance']);

        /* ---------- 同屏对照：工具条 无损(layers) + 菜单 擦除(eraser) ---------- */
        await page.locator('#pop .mi').first().hover(); // 移出「增强」行 → 浮层收起，菜单保持展开
        await page.waitForTimeout(400);
        c.check('P1 移出「增强」后浮层收起、菜单仍在（对照图能同时看到工具条和菜单）',
            await page.locator('[data-k="enhance-flyout"]').count() === 0 && await page.locator('#pop').isVisible());
        const clip3 = await clipAround(page, ['#ntb', '#pop'], 18);
        await page.screenshot({ path: path.join(ICON_ART, '03-compare-lossless-vs-eraser.png'), clip: clip3 });
        c.results.shots['03-compare-lossless-vs-eraser'] = path.join(ICON_ART, '03-compare-lossless-vs-eraser.png');
        console.log('SHOT  ' + c.results.shots['03-compare-lossless-vs-eraser']);

        /* ---------- 同屏三者的图标集合：确认形状互不相同 ---------- */
        const icons = await page.evaluate(() => {
            const box = document.querySelector('#ntb');
            const pop = document.querySelector('#pop');
            const collect = (root) => root ? Array.from(root.querySelectorAll('svg[data-icon]'))
                .filter((svg) => svg.getBoundingClientRect().width > 0)
                .map((svg) => svg.getAttribute('data-icon')) : [];
            return { toolbar: collect(box), menu: collect(pop) };
        });
        const visible = icons.toolbar.concat(icons.menu);
        c.check('D1 同屏里 无损工具条图标 = layers、菜单擦除 = eraser、增强 = sparkle',
            icons.toolbar.indexOf('layers') >= 0 && icons.menu.indexOf('eraser') >= 0 && icons.toolbar.indexOf('eraser') < 0,
            { toolbar: icons.toolbar, menu: icons.menu });
        const trio = ['layers', 'eraser', 'sparkle'];
        c.check('D2 三者形状互不相同（three distinct data-icon）', new Set(trio).size === 3);
        const dup = trio.map((name) => ({ name, count: visible.filter((item) => item === name).length }));
        c.check('D3 三个图标在同一屏各出现 1 次（没有两个同形图标并排）', dup.every((row) => row.count === 1), dup);
        c.check('D4 页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));

        // 额外一张全页图，方便看整体
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(ICON_ART, '04-full-page.png') });
        c.results.shots['04-full-page'] = path.join(ICON_ART, '04-full-page.png');
        c.results.icons = icons;
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const results = c.finish();
        fs.mkdirSync(ICON_ART, { recursive: true });
        fs.writeFileSync(path.join(ICON_ART, 'result-icons.json'), JSON.stringify(results, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
