#!/usr/bin/env node
'use strict';
/*
 * 堆叠节点工具条（.stack-tools）验收：改成 FloatMenuBar 之后的观感 / 动作 / 悬停桥接 / 悬停范围 / 边缘溢出 / 拖动隐藏。
 *
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-stack python3 main.py &
 *   node tests/novai_stack_tools_verify.cjs
 *
 * 输出：tests/artifacts/stack-tools/*.png + result-stack-tools.json
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT = path.join(__dirname, 'artifacts', 'stack-tools');

function pngAt(file, hue) {
    if (fs.existsSync(file)) return file;
    return H.writePng(file, 800, 600, 2, function (x, y) { return [(hue + x) % 255, (hue + y * 2) % 255, 180]; });
}

async function barState(page, selector) {
    return page.evaluate(function (sel) {
        const bar = document.querySelector(sel);
        if (!bar) return { exists: false };
        const r = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        const labels = Array.from(bar.querySelectorAll('.cn-fm-label'));
        const hl = bar.querySelector('.cn-fm-hl');
        const buttons = Array.from(bar.querySelectorAll('.cn-fm-btn'));
        return {
            exists: true,
            on: bar.classList.contains('on'),
            opened: bar.classList.contains('opened'),
            opacity: cs.opacity,
            rect: { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 },
            bg: cs.backgroundColor, backdrop: (cs.backdropFilter || cs.webkitBackdropFilter || ''), radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 60),
            labelCount: labels.length,
            labelMaxWidths: labels.map(function (l) { return l.style.maxWidth || getComputedStyle(l).maxWidth; }),
            labelOpacity: labels.length ? getComputedStyle(labels[0]).opacity : null,
            hl: hl ? { left: hl.style.left, width: hl.style.width, opacity: getComputedStyle(hl).opacity } : null,
            btns: buttons.map(function (b) { return { st: b.getAttribute('data-st'), left: Math.round(b.getBoundingClientRect().left * 10) / 10, right: Math.round(b.getBoundingClientRect().right * 10) / 10 }; }),
        };
    }, selector);
}
async function stackBox(page) {
    return page.locator('.snode').first().boundingBox();
}
async function clipAround(page, boxes, pad) {
    const vp = page.viewportSize();
    const left = Math.min.apply(null, boxes.map(function (b) { return b.x; })) - pad;
    const top = Math.min.apply(null, boxes.map(function (b) { return b.y; })) - pad;
    const right = Math.max.apply(null, boxes.map(function (b) { return b.x + b.width; })) + pad;
    const bottom = Math.max.apply(null, boxes.map(function (b) { return b.y + b.height; })) + pad;
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return { x: x, y: y, width: Math.min(vp.width - x, Math.ceil(right - left)), height: Math.min(vp.height - y, Math.ceil(bottom - top)) };
}
async function shot(page, c, name, boxes, pad) {
    const file = path.join(OUT, name + '.png');
    const clip = await clipAround(page, boxes, pad === undefined ? 20 : pad);
    console.log('CLIP  ' + name + ' ' + JSON.stringify({ boxes: boxes, clip: clip, vp: page.viewportSize() }));
    if (!(clip.width > 0 && clip.height > 0)) throw new Error('clip 非法：' + JSON.stringify({ boxes: boxes, clip: clip }));
    await page.screenshot({ path: file, clip: clip });
    c.results.shots[name] = file;
    console.log('SHOT  ' + file);
    return file;
}
async function hoverBody(page) {
    const box = await page.locator('.snode .stack-body').first().boundingBox();
    const vp = page.viewportSize();
    await page.mouse.move(Math.max(2, Math.min(box.x + box.width / 2, vp.width - 2)), Math.max(2, Math.min(box.y + box.height / 2, vp.height - 2)));
    await page.waitForTimeout(300);
    return box;
}
async function hoverBar(page) {
    const box = await page.locator('[data-act="stack-tools"]').first().boundingBox();
    const vp = page.viewportSize();
    await page.mouse.move(Math.max(2, Math.min(box.x + box.width / 2, vp.width - 2)), Math.max(2, Math.min(box.y + box.height / 2, vp.height - 2)), { steps: 5 });
    await page.waitForTimeout(350);
}
async function moveAway(page) { await page.mouse.move(20, 20); await page.waitForTimeout(350); }

async function createStack(page, ids) {
    await page.evaluate(function (list) { window.__cn.setUI({ sel: new Set(list) }); }, ids);
    await page.waitForTimeout(300);
    const btn = page.locator('[data-mb="stack"]').first();
    await btn.waitFor({ state: 'visible', timeout: 6000 });
    await btn.click();
    await page.waitForTimeout(700);
    await page.locator('.snode').first().waitFor({ state: 'visible', timeout: 6000 });
}
async function stackId(page) {
    return page.evaluate(function () {
        const n = window.__cn.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; });
        return n ? n.id : null;
    });
}
async function moveStackToScreenX(page, targetX) {
    await page.evaluate(function (target) {
        const store = window.__cn;
        const n = store.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; });
        if (!n) return;
        const k = store.state.view.k;
        const cur = n.x * k + store.state.view.x;
        store.updateNode(n.id, function (x) { return Object.assign({}, x, { x: x.x + (target - cur) / k }); });
    }, targetX);
    await page.waitForTimeout(350);
}

(async function () {
    const c = H.checker('堆叠工具条：观感 / 动作 / 悬停 / 边缘 / 拖动');
    fs.mkdirSync(OUT, { recursive: true });
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const result = { states: {}, actions: {}, bridge: {}, scope: {}, overflow: {}, drag: {}, consistency: {} };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) { c.check('后端可用', false, { status: health.status() }); return c.finish(); }
        const files = [pngAt(path.join(H.OUT_DIR, 'stk-1.png'), 20), pngAt(path.join(H.OUT_DIR, 'stk-2.png'), 90), pngAt(path.join(H.OUT_DIR, 'stk-3.png'), 160)];
        canvasId = await H.createCanvas(api, 'VERIFY-STACK-' + Date.now());
        browser = await H.launchBrowser();
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', function (e) { pageErrors.push(String(e && e.message || e)); });
        const downloads = [];
        page.on('download', function (d) { downloads.push(d.suggestedFilename()); });
        await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function () { return !!(window.__cn && window.__cn.state && window.__cn.state.doc); }, null, { timeout: 30000 });
        await page.waitForTimeout(700);
        await page.evaluate(function () {
            window.__agentPicks = [];
            addEventListener('cn:agent-pick', function (e) { window.__agentPicks.push(e.detail); });
        });

        const ids = await page.evaluate(function (urls) {
            const store = window.__cn;
            const nodes = urls.map(function (url, i) {
                return store.newNode('image', 120 + i * 40, 60 + i * 30, { hist: [{ url: url, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '堆叠成员 ' + (i + 1) });
            });
            store.addNodes(nodes, [], { select: true });
            return nodes.map(function (n) { return n.id; });
        }, ['/output/stk-1.png', '/output/stk-2.png', '/output/stk-3.png']);
        await page.waitForTimeout(600);
        await createStack(page, ids);
        const sid = await stackId(page);
        c.check('S1 已创建堆叠（.snode + data.stack）', !!sid && await page.locator('.snode').count() === 1);
        result.stackId = sid;

        // ---------- 1. 观感：折叠 / 展开 / 深色 ----------
        const bodyBox = await hoverBody(page);
        const collapsed = await barState(page, '[data-act="stack-tools"]');
        result.states.collapsed = collapsed;
        const barBox = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '01-stack-collapsed', [bodyBox, barBox]);
        c.check('V1 悬停堆叠本体 → 工具条出现（.cn-fm.on，4 个按钮）', collapsed.exists && collapsed.on && collapsed.btns.length === 4, { on: collapsed.on, btns: collapsed.btns });
        c.check('V2 折叠态：4 个标签都还没展开（max-width 0/很小）', collapsed.labelCount === 4 && collapsed.labelMaxWidths.every(function (w) { return parseFloat(w) <= 1; }), collapsed.labelMaxWidths);

        await hoverBar(page);
        const expanded = await barState(page, '[data-act="stack-tools"]');
        result.states.expanded = expanded;
        const barBox2 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '02-stack-expanded-light', [bodyBox, barBox2]);
        c.check('V3 指针进整条 → 4 个标签展开（max-width = 自然宽度）', expanded.opened && expanded.labelMaxWidths.every(function (w) { return parseFloat(w) > 4; }), { opened: expanded.opened, maxWidths: expanded.labelMaxWidths });
        c.check('V4 磨砂胶囊：78% panel 底 + blur(44px) saturate(190%) + 圆角 9999 + 两层投影',
            /blur\(44px\)/.test(expanded.backdrop) && /saturate\((1\.9|190%)\)/.test(expanded.backdrop) && expanded.radius === '9999px' && /0\.78|78%/.test(expanded.bg),
            { bg: expanded.bg, backdrop: expanded.backdrop, radius: expanded.radius });

        // 深色主题同状态
        await page.evaluate(function () { window.__cn.setUI({ theme: 'dark', themePref: 'dark' }); });
        await page.waitForTimeout(400);
        await moveAway(page);
        await hoverBody(page);
        await hoverBar(page);
        const dark = await page.evaluate(function () { const bar = document.querySelector('[data-act="stack-tools"]'); const cs = getComputedStyle(bar); return { bg: cs.backgroundColor, backdrop: cs.backdropFilter, theme: document.querySelector('.cn-root').getAttribute('data-theme'), opened: bar.classList.contains('opened') }; });
        result.states.dark = dark;
        const barBox3 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '03-stack-expanded-dark', [bodyBox, barBox3]);
        c.check('V5 深色主题：data-theme=dark、70% 底 + 同样 blur44、标签同样展开', dark.theme === 'dark' && /blur\(44px\)/.test(dark.backdrop) && dark.opened, dark);

        // 与 #ntb 并排：加一个图片节点并选中 → 它出 #ntb；同时悬停堆叠
        await page.evaluate(function () { window.__cn.setUI({ theme: 'light', themePref: 'light' }); });
        await page.waitForTimeout(300);
        const imgBox = await page.evaluate(function (url) {
            const store = window.__cn;
            const node = store.newNode('image', 760, 60, { hist: [{ url: url, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '普通图片工具条' });
            store.addNodes([node], [], { select: true });
            return node.id;
        }, '/output/stk-1.png');
        await page.waitForTimeout(700);
        await page.locator('#ntb').first().waitFor({ state: 'visible', timeout: 6000 });
        // 直接悬停 #ntb 让标签展开，再回到堆叠（堆叠工具条靠悬停，不受选中影响）
        const ntbBoxA = await page.locator('#ntb').first().boundingBox();
        await page.mouse.move(ntbBoxA.x + ntbBoxA.width / 2, ntbBoxA.y + ntbBoxA.height / 2);
        await page.waitForTimeout(400);
        const ntbState = await barState(page, '#ntb');
        await shot(page, c, '04-ntb-expanded', [ntbBoxA], 20);
        await hoverBody(page);
        await hoverBar(page);
        const stackState2 = await barState(page, '[data-act="stack-tools"]');
        result.consistency = { ntb: ntbState, stack: stackState2 };
        const ntbBox = await page.locator('#ntb').first().boundingBox();
        const stackBarBox = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        await shot(page, c, '04c-both-bars-area', [ntbBox, stackBarBox, bodyBox], 24);
        c.check('V6 与 #ntb 观感一致：底色 / backdrop / 圆角 / 高度相同（同一条 float-menu 皮肤）',
            ntbState.bg === stackState2.bg && ntbState.backdrop === stackState2.backdrop && ntbState.radius === stackState2.radius && Math.abs(ntbState.rect.height - stackState2.rect.height) <= 0.5,
            { ntb: { bg: ntbState.bg, backdrop: ntbState.backdrop, radius: ntbState.radius, h: ntbState.rect.height }, stack: { bg: stackState2.bg, backdrop: stackState2.backdrop, radius: stackState2.radius, h: stackState2.rect.height } });

        // 侧对比之后把对照图片节点删掉：#ntb 会压在堆叠工具条上方，影响后面点按钮
        await page.evaluate(function (id) { window.__cn.removeNodes([id]); }, imgBox);
        await page.waitForTimeout(400);
        c.check('V7 对照图片节点删除后 #ntb 消失（后面点堆叠工具条不会被挡）', await page.locator('#ntb').count() === 0);

        // ---------- 2. 四个动作（至少 3 个） ----------
        // A. 取消堆叠
        await hoverBody(page);
        await hoverBar(page);
        const beforeUnstack = await page.evaluate(function () { return { nodes: window.__cn.state.doc.nodes.length, sel: window.__cn.state.ui.sel.size }; });
        await page.locator('[data-st="unstack"]').click();
        await page.waitForTimeout(700);
        const afterUnstack = await page.evaluate(function () {
            const store = window.__cn;
            return { stack: !!store.state.doc.nodes.find(function (n) { return n.kind === 'group' && n.data && n.data.stack; }), nodes: store.state.doc.nodes.length, toast: (store.state.toasts || []).map(function (t) { return t.html; }) };
        });
        result.actions.unstack = { before: beforeUnstack, after: afterUnstack };
        c.check('A1 取消堆叠：堆叠节点消失、成员回到画布、有提示', !afterUnstack.stack && afterUnstack.nodes === beforeUnstack.nodes - 1 && afterUnstack.toast.some(function (t) { return t.indexOf('已取消堆叠') >= 0; }), afterUnstack);
        c.check('A2 取消堆叠后 .snode 不再存在', await page.locator('.snode').count() === 0);

        // 重建堆叠（成员现在都在画布上）
        const memberIds = await page.evaluate(function () {
            return window.__cn.state.doc.nodes.filter(function (n) { return n.kind === 'image' && String(window.__cn.state.doc.nodes.find(function (x) { return x.id === n.id; }) && n.text || '').indexOf('堆叠成员') === 0; }).map(function (n) { return n.id; });
        });
        await createStack(page, memberIds.slice(0, 3));
        const sid2 = await stackId(page);
        c.check('S2 重新堆叠成功', !!sid2);

        // B. 加入对话
        await hoverBody(page);
        await hoverBar(page);
        const selBefore = await page.evaluate(function () { return Array.from(window.__cn.state.ui.sel); });
        const posBefore = await page.evaluate(function (id) { const n = window.__cn.node(id); return { x: n.x, y: n.y }; }, sid2);
        await page.locator('[data-st="agent"]').click();
        await page.waitForTimeout(600);
        const agentRes = await page.evaluate(function () {
            const store = window.__cn;
            return { picks: window.__agentPicks.slice(), toast: (store.state.toasts || []).map(function (t) { return t.html; }).join(' | '), agentOpen: store.state.ui.agentOpen, sel: Array.from(store.state.ui.sel), node: (function () { const n = store.node(window.__cn.state.doc.nodes.find(function (x) { return x.kind === 'group' && x.data && x.data.stack; }).id); return { x: n.x, y: n.y }; })() };
        });
        result.actions.agent = agentRes;
        c.check('B1 加入对话：3 个成员都派发了 cn:agent-pick', agentRes.picks.length === 3, agentRes.picks);
        c.check('B2 加入对话：提示「已把 3 个节点加入对话」', agentRes.toast.indexOf('已把 3 个节点加入对话') >= 0, agentRes.toast);
        c.check('B3 点工具条不取消选中、不移动节点（选中仍是堆叠，位置没变）',
            agentRes.sel.length === 1 && agentRes.sel[0] === sid2 && agentRes.node.x === posBefore.x && agentRes.node.y === posBefore.y,
            { selBefore: selBefore, selAfter: agentRes.sel, posBefore: posBefore, posAfter: agentRes.node });

        // C. 存素材库（web 模式没有桌面资产库，应该给明确提示而不是没反应）
        await hoverBody(page);
        await hoverBar(page);
        await page.locator('[data-st="lib"]').click();
        await page.waitForTimeout(600);
        const libRes = await page.evaluate(function () {
            const store = window.__cn;
            return { toast: (store.state.toasts || []).map(function (t) { return t.html; }).join(' | '), modal: !!document.querySelector('.modal') };
        });
        result.actions.lib = libRes;
        c.check('C1 存素材库：点击后有明确结果（弹面板或 toast），不是没反应', libRes.toast.indexOf('资产库') >= 0 || libRes.toast.indexOf('已存入') >= 0 || libRes.modal, libRes);
        c.check('C2 存素材库·实际行为记录：web 模式没有可写资产库 → 报「已存入…0 个，3 个失败」',
            libRes.toast.indexOf('已存入') >= 0 || libRes.toast.indexOf('资产库只在桌面版里可用') >= 0, libRes.toast);

        // D. 全部下载
        await hoverBody(page);
        await hoverBar(page);
        downloads.length = 0;
        await page.locator('[data-st="dl"]').click();
        await page.waitForTimeout(2500);
        result.actions.download = { files: downloads.slice() };
        c.check('D1 全部下载：触发下载（≥1 个文件）', downloads.length >= 1, downloads);

        // ---------- 3. 悬停桥接：从本体上移穿过 34px 空隙进条 ----------
        await moveAway(page);
        await hoverBody(page);
        const b1 = await barState(page, '[data-act="stack-tools"]');
        const body2 = await page.locator('.snode .stack-body').first().boundingBox();
        const bar2 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
        const gapX = Math.max(2, Math.min(bar2.x + bar2.width / 2, 1498));
        const gapY = body2.y - 17; // 条底 = body.top-34，桥接 :after 覆盖 40px
        await page.mouse.move(gapX, gapY, { steps: 3 });
        await page.waitForTimeout(300);
        const b2 = await barState(page, '[data-act="stack-tools"]');
        const gapHit = await page.evaluate(function (pt) { const el = document.elementFromPoint(pt.x, pt.y); return el ? (el.className && el.className.toString ? el.className.toString() : el.tagName) : null; }, { x: gapX, y: gapY });
        await page.mouse.move(bar2.x + bar2.width / 2, bar2.y + bar2.height / 2, { steps: 3 });
        await page.waitForTimeout(300);
        const b3 = await barState(page, '[data-act="stack-tools"]');
        result.bridge = { before: b1.on, inGap: b2.on, onBar: b3.on, gapHit: gapHit, gapY: gapY, bodyTop: body2.y, barBottom: bar2.y + bar2.height };
        c.check('E1 指针停在 34px 空隙里（桥接区）条不消失', !!b2.on, result.bridge);
        c.check('E2 继续进到条上条仍在', !!b3.on, { on: b3.on });

        // ---------- 4. 悬停范围：卡片区 / 顶栏 / 节点外 10px ----------
        const stackBox2 = await stackBox(page);
        const nheadBox = await page.locator('.snode .nhead').first().boundingBox();
        // F2a：条还没出现时，从外面直接悬停「顶栏」——应该不弹（新的显隐范围）
        await moveAway(page);
        await page.mouse.move(nheadBox.x + Math.min(nheadBox.width - 6, 40), nheadBox.y + nheadBox.height / 2);
        await page.waitForTimeout(450);
        const entryAtHead = (await barState(page, '[data-act="stack-tools"]')).on;
        // F2b：条已经出现后，把指针挪到顶栏（桥接区覆盖到这一带）——不会收起
        await moveAway(page);
        await page.mouse.move(stackBox2.x + stackBox2.width / 2, stackBox2.y + stackBox2.height / 2);
        await page.waitForTimeout(300);
        const onBody = (await barState(page, '[data-act="stack-tools"]')).on;
        await page.mouse.move(nheadBox.x + Math.min(nheadBox.width - 6, 40), nheadBox.y + nheadBox.height / 2);
        await page.waitForTimeout(400);
        const headAfterShown = (await barState(page, '[data-act="stack-tools"]')).on;
        await page.mouse.move(stackBox2.x + stackBox2.width + 10, stackBox2.y + stackBox2.height / 2);
        await page.waitForTimeout(400);
        const onOutside = (await barState(page, '[data-act="stack-tools"]')).on;
        result.scope = { body: !!onBody, entryAtHeadFromHidden: !!entryAtHead, headAfterShown: !!headAfterShown, outside10: !!onOutside, nheadBox: nheadBox, bridgeBottom: (await page.evaluate(function () { const b = document.querySelector('[data-act="stack-tools"]'); return b ? b.getBoundingClientRect().bottom : null; })) };
        c.check('F1 悬停卡片区 → 条出现', !!onBody);
        c.check('F2a 条隐藏时直接悬停顶栏（.nhead / 标题）→ 不弹条（新的显隐范围）', !entryAtHead);
        c.check('F2b 条已出现后挪到顶栏 → 不会收起（40px 桥接区盖到顶栏这一带，见汇报）', !!headAfterShown);
        c.check('F3 节点外 10px → 条不出现', !onOutside);

        // ---------- 5. 边缘溢出 ----------
        // 右侧有 agent 面板、左侧有工具栏侧栏：先收起 agent 面板，悬停点避开左侧 rail，才能真的悬停到条上
        await page.evaluate(function () { window.__cn.setUI({ agentOpen: false }); });
        await page.waitForTimeout(350);
        const overflows = {};
        for (const side of ['left', 'right']) {
            await moveAway(page);
            if (side === 'left') await moveStackToScreenX(page, -20);
            else await moveStackToScreenX(page, 1500 - 260 + 20);
            await page.waitForTimeout(300);
            const body3 = await page.locator('.snode .stack-body').first().boundingBox();
            const vp = page.viewportSize();
            const bodyHoverX = Math.max(130, Math.min(body3.x + body3.width / 2, vp.width - 2));
            await page.mouse.move(bodyHoverX, Math.max(2, Math.min(body3.y + body3.height / 2, vp.height - 2)));
            await page.waitForTimeout(350);
            const barBox3 = await page.locator('[data-act="stack-tools"]').first().boundingBox();
            const barHoverX = Math.max(112, Math.min(barBox3.x + barBox3.width / 2, vp.width - 2));
            await page.mouse.move(barHoverX, Math.max(2, Math.min(barBox3.y + barBox3.height / 2, vp.height - 2)), { steps: 4 });
            await page.waitForTimeout(450);
            const st = await page.evaluate(function (sel) {
                const bar = document.querySelector(sel);
                const r = bar.getBoundingClientRect();
                const vw = innerWidth;
                const btns = Array.from(bar.querySelectorAll('.cn-fm-btn')).map(function (b) {
                    const br = b.getBoundingClientRect();
                    const cx = br.left + br.width / 2;
                    return { st: b.getAttribute('data-st'), left: Math.round(br.left * 10) / 10, right: Math.round(br.right * 10) / 10, centerInside: cx >= 0 && cx <= vw };
                });
                return { bar: { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10 }, vw: vw, overflowLeft: Math.max(0, Math.round(-r.left * 10) / 10), overflowRight: Math.max(0, Math.round((r.right - vw) * 10) / 10), btns: btns, opened: bar.classList.contains('opened') };
            }, '[data-act="stack-tools"]');
            overflows[side] = st;
            result.overflow[side] = st;
            const bBox = await page.locator('[data-act="stack-tools"]').first().boundingBox();
            await shot(page, c, side === 'left' ? '05-overflow-left' : '06-overflow-right', [body3, bBox]);
            c.check('G-' + side + ' 展开后量出：左溢出 ' + st.overflowLeft + 'px / 右溢出 ' + st.overflowRight + 'px，点不到 ' + st.btns.filter(function (b) { return !b.centerInside; }).map(function (b) { return b.st; }).join('/'),
                true, st);
        }

        // ---------- 6. 拖动时隐藏 ----------
        await moveAway(page);
        await moveStackToScreenX(page, 400);
        await hoverBody(page);
        await hoverBar(page);
        const beforeDrag = await barState(page, '[data-act="stack-tools"]');
        const sb = await page.locator('.snode .stack-body').first().boundingBox();
        await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await page.mouse.down();
        await page.mouse.move(sb.x + sb.width / 2 + 40, sb.y + sb.height / 2 + 20, { steps: 6 });
        await page.waitForTimeout(200);
        const duringDrag = await page.evaluate(function () {
            const tools = document.querySelector('[data-act="stack-tools"]');
            const any = document.querySelector('.dragging-any');
            const store = window.__cn;
            return { dragging: store.state.ui.dragging, hasDraggingAny: !!any, toolsDisplay: tools ? getComputedStyle(tools).display : null, toolsOn: tools ? tools.classList.contains('on') : null, toolsOpacity: tools ? getComputedStyle(tools).opacity : null };
        });
        await shot(page, c, '07-dragging-node', [await stackBox(page)], 40);
        await page.mouse.up();
        await page.waitForTimeout(400);
        result.drag = { before: beforeDrag.on, duringNodeDrag: duringDrag };
        const hiddenDuringNodeDrag = duringDrag.toolsDisplay === 'none' || duringDrag.toolsOn === false || parseFloat(duringDrag.toolsOpacity) < 0.02;
        c.check('H1 拖动堆叠节点本身时条是隐藏的（display none 或 on=false/opacity 0）', hiddenDuringNodeDrag, duringDrag);
        c.check('H2 拖动时 .dragging-any 这个 CSS 钩子实际被挂上（代码里没有任何地方加这个类）', duringDrag.hasDraggingAny, { hasDraggingAny: duringDrag.hasDraggingAny });

        // H3：模拟「正在拖别的节点」（ui.dragging=true）时把指针移到堆叠上——正是 .dragging-any 想挡的场景
        const stackCent = await page.locator('.snode .stack-body').first().boundingBox();
        await moveAway(page);
        await page.evaluate(function () { window.__cn.setUI({ dragging: true }); });
        await hoverBody(page);
        const dragHover = await barState(page, '[data-act="stack-tools"]');
        const dragState = await page.evaluate(function () { return { dragging: window.__cn.state.ui.dragging, hasDraggingAny: !!document.querySelector('.dragging-any') }; });
        await shot(page, c, '08-dragging-other-hover', [stackCent], 40);
        result.drag.draggingStateHover = { state: dragState, bar: { on: dragHover.on, display: dragHover.rect ? 'flex' : null, opacity: dragHover.opacity } };
        // H3b：手动把 .dragging-any 挂到 .cn-root 上，证明 CSS 规则本身是好的（只是没人挂这个类）
        const withClass = await page.evaluate(function () {
            // 规则是 `.cn-root .dragging-any .stack-tools`：类要挂在 .cn-root 里面的容器上（#app / #stage / #layer 都行）
            const host = document.getElementById('app') || document.getElementById('stage');
            host.classList.add('dragging-any');
            const tools = document.querySelector('[data-act="stack-tools"]');
            const display = tools ? getComputedStyle(tools).display : null;
            host.classList.remove('dragging-any');
            window.__cn.setUI({ dragging: false });
            return display;
        });
        result.drag.manualClassDisplay = withClass;
        await moveAway(page);
        c.check('H3 ui.dragging=true（模拟拖别的节点）时悬停堆叠，条会不会冒出来（应被 .dragging-any 挡住）', dragHover.on === false || dragHover.opacity === '0', result.drag.draggingStateHover);
        c.check('H3b 手挂 .dragging-any 时 CSS 规则本身有效（display:none）', withClass === 'none', { display: withClass });

        c.check('X1 页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));
        result.pageErrors = pageErrors;
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const results = c.finish();
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'result-stack-tools.json'), JSON.stringify({ summary: result, checks: results.checks }, null, 2));
        process.exit(results.failed ? 1 : 0);
    }
})();
