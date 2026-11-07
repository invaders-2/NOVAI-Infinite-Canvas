#!/usr/bin/env node
'use strict';
/*
 * 「智能画布BEAT」节点工具栏 Dock 观感验收（手动跑，不进 run-all）：
 *   同一条流程跑两遍，输出可对比的几何读数 + 截图：
 *     node tests/novai_dock_toolbar_shots.cjs before   # 旧观感基线（改之前先截）
 *     node tests/novai_dock_toolbar_shots.cjs after    # 新观感 + 逐条断言
 *
 * 后端必须是独立实例（不要碰 3000 的日常实例）：
 *   cd NOVAI-v16 && NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-dock-verify python3 main.py
 *   NOVAI_PORT=3921 NOVAI_DATA_DIR=/tmp/novai-dock-verify node tests/novai_dock_toolbar_shots.cjs before
 *
 * 输出：tests/artifacts/dock-verify/<mode>/*.png + geometry.json；after 另写 ../result.json
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const MODE = (process.argv[2] || process.env.NOVAI_DOCK_MODE || 'before').toLowerCase();
if (MODE !== 'before' && MODE !== 'after' && MODE !== 'variants' && MODE !== 'noslot') {
    console.error('用法：node tests/novai_dock_toolbar_shots.cjs [before|after|variants|noslot]');
    process.exit(2);
}
const ROOT = path.join(__dirname, 'artifacts', 'dock-verify');
/** 试跑用后缀（NOVAI_DOCK_SUFFIX=-dryrun）：别把半成品构建的结果写进正式 before/after 目录 */
const SUFFIX = process.env.NOVAI_DOCK_SUFFIX || '';
const OUT = path.join(ROOT, MODE + SUFFIX);

/** 几何 / 交互期望（solid 与 glass 两版共用，不改） */
const DOCK = { radius: '14px', padding: '7px', gap: '4px', height: 50, button: 36, hlAlpha: 0.12 };
/**
 * 玻璃版期望（定稿 V2：74% 底 + 6% 白雾层 / 80% 底 + 4% 白雾层）：
 *   background: linear-gradient(rgba(255,255,255,fog), rgba(255,255,255,fog)),
 *               color-mix(in srgb, 基色 alpha, transparent);
 *   backdrop-filter: blur(44px) saturate(190%)
 */
const GLASS = {
    lightBase: [17, 17, 17],
    darkBase: [28, 28, 30],
    lightAlpha: 0.74,
    darkAlpha: 0.80,
    lightFog: 0.06,
    darkFog: 0.04,
    alphaTol: 0.02,
    blur: /blur\(44px\)/,
    saturate: /saturate\((1\.9|190%)\)/,
    veil: /linear-gradient/,
    // 压在画布上（点阵底 ≈ rgb(236,236,238)，白 6% 雾 + 74% #111）的实测观测值
    lightOnCanvas: [86, 86, 87],
    onCanvasTol: 4,
    textContrast: 4.5,
    iconContrast: 3,
    // variants 里 V2 的渗透读数（浅 −23/−25/−2、深 +23/+21/+40），after 复跑用来对账
    penetrationTol: 14,
};
const LABEL = { fontSize: '13px', fontWeight: '500' };

/* ---------------- 截图 / 裁剪 ---------------- */
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
/** 截图登记表：最后原样写进 geometry.shots，像素采样也按名字取图 */
const SHOTS = {};
/** 每张裁剪图的 clip 原点（取像素时要减掉，否则整页坐标对不上） */
const SHOT_CLIPS = {};
function clipAround(page, boxes, pad) {
    const vp = page.viewportSize();
    const valid = (boxes || []).filter(Boolean);
    if (!valid.length) return { x: 0, y: 0, width: vp.width, height: vp.height };
    const left = Math.min.apply(null, valid.map((b) => b.x)) - pad;
    const top = Math.min.apply(null, valid.map((b) => b.y)) - pad;
    const right = Math.max.apply(null, valid.map((b) => b.x + b.width)) + pad;
    const bottom = Math.max.apply(null, valid.map((b) => b.y + b.height)) + pad;
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return {
        x: x, y: y,
        width: Math.max(1, Math.min(vp.width - x, Math.ceil(right - left))),
        height: Math.max(1, Math.min(vp.height - y, Math.ceil(bottom - top))),
    };
}
async function shot(page, name, boxes, pad) {
    ensureDir(OUT);
    const file = path.join(OUT, name + '.png');
    let clip = clipAround(page, boxes, pad === undefined ? 28 : pad);
    const vp = page.viewportSize();
    if (clip.x >= vp.width || clip.y >= vp.height) {
        // 目标被算到视口外（条按 -9999 隐藏）：退回整页截图，别让一次裁剪失败打断整轮
        console.log('WARN  ' + name + ' 的裁剪区在视口外，改截整页 ' + JSON.stringify(clip));
        clip = { x: 0, y: 0, width: vp.width, height: vp.height };
    }
    await page.screenshot({ path: file, clip: clip });
    SHOTS[path.basename(name, '.png')] = file;
    SHOT_CLIPS[path.basename(name, '.png')] = clip;
    console.log('SHOT  ' + path.relative(path.join(__dirname, '..'), file) + '  clip=' + JSON.stringify(clip));
    return file;
}
async function fullShot(page, name) {
    ensureDir(OUT);
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file });
    SHOTS[path.basename(name, '.png')] = file;
    console.log('SHOT  ' + path.relative(path.join(__dirname, '..'), file));
    return file;
}

/* ---------------- 极简 PNG 解码（只为量「滑块 / 底色」的实际像素） ---------------- */
function decodePng(file) {
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG：' + file);
    let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (bitDepth !== 8) throw new Error('只支持 8bit PNG（实际 ' + bitDepth + '）');
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (!channels) throw new Error('只支持 RGB/RGBA PNG（实际 colorType ' + colorType + '）');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    for (let y = 0; y < height; y += 1) {
        const ft = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x += 1) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= channels ? prev[x - channels] : 0;
            let v = line[x];
            if (ft === 1) v += a;
            else if (ft === 2) v += b;
            else if (ft === 3) v += (a + b) >> 1;
            else if (ft === 4) v += paeth(a, b, c);
            cur[x] = v & 0xff;
        }
    }
    const pixel = (x, y) => {
        const px = Math.max(0, Math.min(width - 1, Math.round(x)));
        const py = Math.max(0, Math.min(height - 1, Math.round(y)));
        const i = py * stride + px * channels;
        return [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
    };
    return { width, height, pixel };
}
function luminance(rgb) {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------------- 构建指纹（截图到底量的是哪一版产物） ---------------- */
function buildFingerprint() {
    const root = path.join(__dirname, '..');
    const hash = (p) => {
        try { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch (e) { return null; }
    };
    // 仓库已把 openarc-canvas-ui / static/openarc-canvas 改名为 novai-canvas-ui / static/novai-canvas
    const buildDir = fs.existsSync(path.join(root, 'static', 'novai-canvas', 'canvas.css'))
        ? path.join(root, 'static', 'novai-canvas')
        : path.join(root, 'static', 'openarc-canvas');
    const cssPath = path.join(buildDir, 'canvas.css');
    let version = null;
    try {
        const html = fs.readFileSync(path.join(root, 'static', 'canvas.html'), 'utf8');
        const m = html.match(/canvas\.css\?v=([0-9.]+)/);
        version = m ? m[1] : null;
    } catch (e) { /* 忽略 */ }
    let mtime = null;
    try { mtime = fs.statSync(cssPath).mtime.toISOString(); } catch (e) { /* 忽略 */ }
    return {
        css: hash(cssPath),
        js: hash(path.join(buildDir, 'canvas.js')),
        canvasHtmlVersion: version,
        cssMtime: mtime,
    };
}

/* ---------------- 页面内读数 ---------------- */
function readBar(sel) {
    const attrNames = ['data-tb', 'data-mb', 'data-gt', 'data-st'];
    const attrOf = (el) => attrNames.find((a) => el.hasAttribute(a)) || null;
    const num = (v) => Math.round(v * 100) / 100;
    const bar = document.querySelector(sel);
    if (!bar) return { selector: sel, exists: false };
    const root = bar.closest('.cn-root');
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    const buttons = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn')).map((btn) => {
        const b = btn.getBoundingClientRect();
        const sp = btn.querySelector(':scope > .cn-fm-label');
        const s = sp ? getComputedStyle(sp) : null;
        const attr = attrOf(btn);
        return {
            attr: attr, key: attr ? btn.getAttribute(attr) : null,
            offsetW: btn.offsetWidth, offsetH: btn.offsetHeight,
            disabled: !!btn.disabled,
            rect: { left: num(b.left), top: num(b.top), width: num(b.width), height: num(b.height), cx: num(b.left + b.width / 2) },
            label: sp ? {
                text: (sp.textContent || '').trim(),
                opacity: num(parseFloat(s.opacity)),
                fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
                display: s.display,
                maxWidth: s.maxWidth, inlineMaxWidth: sp.style.maxWidth || '',
                width: num(sp.getBoundingClientRect().width),
            } : null,
        };
    });
    const hl = bar.querySelector('.cn-fm-hl');
    const hlCs = hl ? getComputedStyle(hl) : null;
    const hr = hl ? hl.getBoundingClientRect() : null;
    // 空图片节点的单颗上传条不是 .cn-fm-btn（.ib），单独收一份「条里所有 button」的读数
    const innerButtons = Array.from(bar.querySelectorAll('button')).map((btn) => {
        const s2 = getComputedStyle(btn);
        return {
            className: String(btn.className || ''),
            key: btn.getAttribute('data-tb') || btn.getAttribute('data-mb') || '',
            text: (btn.textContent || '').trim(),
            offsetW: btn.offsetWidth, offsetH: btn.offsetHeight,
            color: s2.color, fontSize: s2.fontSize, fontWeight: s2.fontWeight,
            bg: s2.backgroundColor, border: s2.borderTopWidth, radius: s2.borderRadius,
        };
    });
    const stage = document.elementFromPoint(1, 1);
    return {
        selector: sel,
        exists: true,
        theme: root ? root.getAttribute('data-theme') : null,
        on: bar.classList.contains('on'),
        opened: bar.classList.contains('opened'),
        opacity: num(parseFloat(cs.opacity)),
        visual: { left: num(r.left), top: num(r.top), width: num(r.width), height: num(r.height), cx: num(r.left + r.width / 2), cy: num(r.top + r.height / 2) },
        css: {
            backgroundColor: cs.backgroundColor,
            borderRadius: cs.borderRadius,
            padding: cs.padding,
            gap: cs.gap,
            borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
            borderStyle: cs.borderTopStyle,
            offsetWidth: bar.offsetWidth,
            offsetHeight: bar.offsetHeight,
            boxShadow: cs.boxShadow,
            backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
            backdropFilter: cs.backdropFilter || '',
            webkitBackdropFilter: cs.webkitBackdropFilter || '',
            backgroundImage: cs.backgroundImage || '',
            maxWidth: cs.maxWidth,
            transform: cs.transform,
            marginLeft: bar.style.marginLeft || '',
            scale: cs.scale,
            overflow: cs.overflow,
            overflowX: cs.overflowX,
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            whiteSpace: cs.whiteSpace,
        },
        innerButtons: innerButtons,
        counts: bar.querySelectorAll('.cn-fm-count').length,
        separators: bar.querySelectorAll('.vsep').length,
        buttons: buttons,
        labelCount: bar.querySelectorAll('.cn-fm-label').length,
        expandedLabelCount: buttons.filter((b) => b.label && parseFloat(b.label.maxWidth) > 0.5).length,
        hl: hl ? {
            exists: true,
            opacity: num(parseFloat(hlCs.opacity)),
            bg: hlCs.backgroundColor,
            radius: hlCs.borderRadius,
            rect: { left: num(hr.left), top: num(hr.top), width: num(hr.width), height: num(hr.height) },
            inline: { left: hl.style.left || '', top: hl.style.top || '', width: hl.style.width || '', height: hl.style.height || '', opacity: hl.style.opacity || '' },
        } : { exists: false },
        page: {
            theme: root ? root.getAttribute('data-theme') : null,
            rootBg: root ? getComputedStyle(root).backgroundColor : null,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            stageBg: (() => { const el = document.querySelector('#stage') || document.querySelector('#app'); return el ? getComputedStyle(el).backgroundColor : null; })(),
            hitAt1: stage ? String(stage.className || stage.tagName) : null,
        },
    };
}

async function moveAway(page) { await page.mouse.move(20, 20); }
async function read(page, sel) { return page.evaluate(readBar, sel); }
async function middleButton(page, sel) {
    return page.evaluate((s) => {
        const attrNames = ['data-tb', 'data-mb', 'data-gt', 'data-st'];
        const bar = document.querySelector(s);
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const btns = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn')).filter((b) => !b.disabled);
        if (!btns.length) return null;
        let best = null;
        for (const b of btns) {
            const br = b.getBoundingClientRect();
            const d = Math.abs(br.left + br.width / 2 - cx);
            if (!best || d < best.d) best = { d: d, btn: b, rect: { left: br.left, top: br.top, width: br.width, height: br.height } };
        }
        const attr = attrNames.find((a) => best.btn.hasAttribute(a)) || null;
        return { attr: attr, key: attr ? best.btn.getAttribute(attr) : null, rect: best.rect, barCx: cx };
    }, sel);
}
async function buttonBox(page, sel) {
    const box = await page.locator(sel).first().boundingBox();
    return box;
}
/** 反复「量位置 → 移过去 → 确认指针真落在目标上」：展开会把条往左挪、标签还会继续长 */
async function hoverStable(page, sel, tries) {
    const want = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => el.hasAttribute(a)) || null;
        return { attr: attr, key: attr ? el.getAttribute(attr) : null };
    }, sel);
    if (!want) throw new Error('找不到按钮：' + sel);
    let last = null;
    for (let i = 0; i < (tries || 8); i += 1) {
        const box = await buttonBox(page, sel);
        if (!box) throw new Error('按钮没有位置：' + sel);
        const vp = page.viewportSize();
        const x = Math.max(2, Math.min(box.x + box.width / 2, vp.width - 2));
        const y = Math.max(2, Math.min(box.y + box.height / 2, vp.height - 2));
        await page.mouse.move(x, y, { steps: i ? 2 : 6 });
        await page.waitForTimeout(260);
        last = await page.evaluate(({ s, px, py }) => {
            const bar = document.querySelector(s);
            if (!bar) return null;
            for (const btn of bar.querySelectorAll(':scope > .cn-fm-btn')) {
                const r = btn.getBoundingClientRect();
                if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                    const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => btn.hasAttribute(a)) || null;
                    return { attr: attr, key: attr ? btn.getAttribute(attr) : null };
                }
            }
            return null;
        }, { s: sel, px: x, py: y });
        if (last && last.key === want.key) return { x: x, y: y, want: want };
    }
    return { x: null, y: null, want: want, landed: last };
}

/* ---------------- 场景 ---------------- */
function seedPng(file, hue) {
    if (fs.existsSync(file)) return file;
    return H.writePng(file, 800, 600, 2, function (x, y) { return [(hue + x) % 255, (hue + y * 2) % 255, 190]; });
}

/** 按「屏幕坐标」放节点：画布会被 fitTo / 平移，写死 doc 坐标容易落到视口外 */
async function addNodeAtScreen(page, kind, screenX, screenY, extra) {
    return page.evaluate(({ kind, sx, sy, extra }) => {
        const store = window.__cn;
        const v = store.state.view;
        // 便签不是生成类节点，newNode() 只接受 text/image/video/audio：按 homeSeed 的写法直接落一个字面量节点
        if (kind === 'note') {
            const id = 'note-' + Math.random().toString(36).slice(2, 9);
            store.addNodes([{ id: id, kind: 'note', x: Math.round((sx - v.x) / v.k), y: Math.round((sy - v.y) / v.k), w: 220, h: 160, text: (extra && extra.text) || '' }], [], { select: false });
            return id;
        }
        const node = store.newNode(kind, (sx - v.x) / v.k, (sy - v.y) / v.k, extra || {});
        store.addNodes([node], [], { select: false });
        return node.id;
    }, { kind: kind, sx: screenX, sy: screenY, extra: extra || null });
}

async function addImageAt(page, url, x, y, title) {
    return page.evaluate(({ url, x, y, title }) => {
        const store = window.__cn;
        const node = store.newNode('image', x, y, { hist: [{ url: url, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: title });
        store.addNodes([node], [], { select: false });
        return node.id;
    }, { url, x, y, title });
}

/** 单节点工具条 #ntb：折叠 → 悬停正中那颗 → 移开 */
async function captureNtb(page, prefix, geometry) {
    const ids = await page.evaluate(() => Array.from(window.__cn.state.doc.nodes).filter((n) => n.kind === 'image').map((n) => n.id));
    await page.evaluate((id) => window.__cn.setUI({ sel: new Set([id]) }), ids[0]);
    await page.waitForTimeout(500);
    await moveAway(page);
    await page.waitForTimeout(350);
    await page.locator('#ntb').first().waitFor({ state: 'visible', timeout: 8000 });

    const collapsed = await read(page, '#ntb');
    geometry[prefix + '.ntb.collapsed'] = collapsed;
    const box0 = await page.locator('#ntb').first().boundingBox();
    await shot(page, prefix + '-01-ntb-collapsed', [box0], 34);

    const mid = await middleButton(page, '#ntb');
    geometry[prefix + '.ntb.middle'] = mid;
    const midSel = '#ntb [' + mid.attr + '="' + mid.key + '"]';
    const hover = await hoverStable(page, midSel);
    await page.waitForTimeout(420);
    const expanded = await read(page, '#ntb');
    const under = await page.evaluate(({ s, x, y }) => {
        const bar = document.querySelector(s);
        if (!bar || x == null) return null;
        for (const btn of bar.querySelectorAll(':scope > .cn-fm-btn')) {
            const r = btn.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => btn.hasAttribute(a)) || null;
                return { attr: attr, key: attr ? btn.getAttribute(attr) : null };
            }
        }
        return null;
    }, { s: '#ntb', x: hover.x, y: hover.y });
    expanded.pointer = { x: hover.x, y: hover.y, under: under, want: hover.want };
    // 谁挂着 is-open 要在悬停当场记下来（断言块在整轮末尾跑，那时指针早就不在条上了）
    expanded.isOpenKey = await page.evaluate(() => {
        const b = document.querySelector('#ntb > .cn-fm-btn.is-open');
        return b ? b.getAttribute('data-tb') : null;
    });
    geometry[prefix + '.ntb.hover'] = expanded;
    const box1 = await page.locator('#ntb').first().boundingBox();
    await shot(page, prefix + '-02-ntb-hover-middle', [box0, box1], 34);
    geometry.shots.lightHoverFull = await fullShot(page, prefix + '-02b-fullpage-hover');

    await moveAway(page);
    await page.waitForTimeout(400);
    const away = await read(page, '#ntb');
    geometry[prefix + '.ntb.movedAway'] = away;
    const box2 = await page.locator('#ntb').first().boundingBox();
    await shot(page, prefix + '-03-ntb-moved-away', [box0, box2], 34);
    return { midKey: mid.key, midAttr: mid.attr, midSel: midSel, collapsed: collapsed, expanded: expanded, away: away, hover: hover, under: under };
}

/** 多选条 #multibar */
async function captureMultibar(page, prefix, geometry) {
    const ids = await page.evaluate(() => Array.from(window.__cn.state.doc.nodes).filter((n) => n.kind === 'image').map((n) => n.id));
    await page.evaluate((list) => window.__cn.setUI({ sel: new Set(list) }), ids.slice(0, 2));
    await page.waitForTimeout(600);
    await moveAway(page);
    await page.waitForTimeout(350);
    await page.locator('#multibar').first().waitFor({ state: 'visible', timeout: 8000 });
    const collapsed = await read(page, '#multibar');
    geometry[prefix + '.multibar.collapsed'] = collapsed;
    const box0 = await page.locator('#multibar').first().boundingBox();
    await shot(page, prefix + '-04-multibar-collapsed', [box0], 40);

    const mid = await middleButton(page, '#multibar');
    const midSel = '#multibar [' + mid.attr + '="' + mid.key + '"]';
    const hover = await hoverStable(page, midSel);
    await page.waitForTimeout(420);
    const expanded = await read(page, '#multibar');
    expanded.pointer = { x: hover.x, y: hover.y, under: hover.landed || null, want: hover.want };
    geometry[prefix + '.multibar.hover'] = expanded;
    const box1 = await page.locator('#multibar').first().boundingBox();
    await shot(page, prefix + '-05-multibar-hover', [box0, box1], 40);
    await moveAway(page);
    await page.waitForTimeout(300);
    return { midKey: mid.key, midAttr: mid.attr, collapsed: collapsed, expanded: expanded, hover: hover };
}

/** 组工具条：[data-gt-tools]（先选中 2 个节点点「分组」） */
async function captureGroupTools(page, prefix, geometry) {
    await moveAway(page);
    await page.waitForTimeout(250);
    const ids = await page.evaluate(() => Array.from(window.__cn.state.doc.nodes).filter((n) => n.kind === 'image').map((n) => n.id));
    await page.evaluate((list) => window.__cn.setUI({ sel: new Set(list) }), ids.slice(0, 2));
    await page.waitForTimeout(500);
    const grp = page.locator('#multibar [data-mb="group"]').first();
    await grp.waitFor({ state: 'visible', timeout: 8000 });
    await grp.click();
    await page.waitForTimeout(900);
    const barSel = '[data-gt-tools]';
    const ok = await page.locator(barSel).count();
    geometry[prefix + '.groupTools.exists'] = { count: ok };
    if (!ok) {
        geometry[prefix + '.groupTools.skip'] = '点了分组但没出现 [data-gt-tools]（记录原因，不截图）';
        return { exists: false };
    }
    await moveAway(page);
    await page.waitForTimeout(300);
    const collapsed = await read(page, barSel);
    geometry[prefix + '.groupTools.collapsed'] = collapsed;
    const box0 = await page.locator(barSel).first().boundingBox();
    await shot(page, prefix + '-06-group-tools-collapsed', [box0], 36);

    const mid = await middleButton(page, barSel);
    const midSel = barSel + ' [' + mid.attr + '="' + mid.key + '"]';
    const hover = await hoverStable(page, midSel);
    await page.waitForTimeout(420);
    const expanded = await read(page, barSel);
    expanded.pointer = { x: hover.x, y: hover.y, under: hover.landed || null, want: hover.want };
    geometry[prefix + '.groupTools.hover'] = expanded;
    const box1 = await page.locator(barSel).first().boundingBox();
    await shot(page, prefix + '-07-group-tools-hover', [box0, box1], 36);
    await moveAway(page);
    await page.waitForTimeout(300);
    return { exists: true, midKey: mid.key, midAttr: mid.attr, collapsed: collapsed, expanded: expanded };
}

/** 堆叠工具条：先悬停堆叠本体让它出现，再悬停条 */
async function captureStackTools(page, prefix, geometry) {
    await moveAway(page);
    await page.waitForTimeout(250);
    const ids = await page.evaluate(() => {
        const store = window.__cn;
        const grouped = new Set(store.state.doc.nodes.filter((n) => n.kind === 'group').flatMap((n) => n.children || []));
        return store.state.doc.nodes.filter((n) => {
            const hist = n.data && n.data.gen && n.data.gen.hist;
            return n.kind === 'image' && !grouped.has(n.id) && Array.isArray(hist) && hist.length > 0;
        }).map((n) => n.id);
    });
    // 用最后两张（前两张已经进分组了）——不够就现加
    let list = ids.slice(-2);
    if (list.length < 2) {
        const url = await page.evaluate(() => {
            const n = Array.from(window.__cn.state.doc.nodes).find((x) => x.kind === 'image');
            return n && n.data && n.data.gen && n.data.gen.hist && n.data.gen.hist[0] ? n.data.gen.hist[0].url : '/output/dock-c.png';
        });
        for (let i = list.length; i < 2; i += 1) list.push(await addImageAt(page, url, 120 + i * 360, 520, '堆叠成员 ' + (i + 1)));
        await page.waitForTimeout(400);
    }
    await page.evaluate((l) => window.__cn.setUI({ sel: new Set(l) }), list);
    await page.waitForTimeout(500);
    const stackBtn = page.locator('#multibar [data-mb="stack"]').first();
    await stackBtn.waitFor({ state: 'visible', timeout: 8000 });
    await stackBtn.click();
    await page.waitForTimeout(900);
    const snode = await page.locator('.snode').count();
    geometry[prefix + '.stackTools.exists'] = { snodes: snode };
    if (!snode) {
        geometry[prefix + '.stackTools.skip'] = '点了「堆叠」但没出现 .snode（记录原因）';
        return { exists: false };
    }
    // 悬停堆叠本体 → 条出现
    const body = await page.locator('.snode .stack-body').first().boundingBox();
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 4 });
    await page.waitForTimeout(420);
    const barSel = '[data-act="stack-tools"]';
    if (!(await page.locator(barSel).count())) {
        geometry[prefix + '.stackTools.skip'] = '悬停堆叠体后仍没有 [data-act="stack-tools"]';
        return { exists: false };
    }
    const collapsed = await read(page, barSel);
    geometry[prefix + '.stackTools.collapsed'] = collapsed;
    const box0 = await page.locator(barSel).first().boundingBox();
    await shot(page, prefix + '-08-stack-tools-collapsed', [body, box0], 30);

    const mid = await middleButton(page, barSel);
    const midSel = barSel + ' [' + mid.attr + '="' + mid.key + '"]';
    const midBox = await buttonBox(page, midSel);
    await page.mouse.move(midBox.x + midBox.width / 2, midBox.y + midBox.height / 2, { steps: 4 });
    await page.waitForTimeout(420);
    const expanded = await read(page, barSel);
    const landed = await page.evaluate(({ s, px, py }) => {
        const bar = document.querySelector(s);
        if (!bar) return null;
        for (const btn of bar.querySelectorAll(':scope > .cn-fm-btn')) {
            const r = btn.getBoundingClientRect();
            if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => btn.hasAttribute(a)) || null;
                return { attr: attr, key: attr ? btn.getAttribute(attr) : null };
            }
        }
        return null;
    }, { s: barSel, px: midBox.x + midBox.width / 2, py: midBox.y + midBox.height / 2 });
    expanded.pointer = { under: landed, want: { attr: mid.attr, key: mid.key } };
    geometry[prefix + '.stackTools.hover'] = expanded;
    const box1 = await page.locator(barSel).first().boundingBox();
    await shot(page, prefix + '-09-stack-tools-hover', [body, box0, box1], 30);
    return { exists: true, midKey: mid.key, midAttr: mid.attr, collapsed: collapsed, expanded: expanded };
}

/** 空图片节点的单颗「上传」条：#ntb.ntb-empty-upload 也必须是 dock 皮肤 */
async function captureEmptyUpload(page, prefix, geometry) {
    await moveAway(page);
    await page.waitForTimeout(250);
    const id = await addNodeAtScreen(page, 'image', 950, 470, {});
    await page.evaluate((nid) => window.__cn.setUI({ sel: new Set([nid]) }), id);
    await page.waitForTimeout(900);
    const sel = '#ntb.ntb-empty-upload';
    const count = await page.locator(sel).count();
    geometry[prefix + '.emptyUpload.exists'] = { count: count };
    if (!count) {
        geometry[prefix + '.emptyUpload.skip'] = '最近加的空图片节点没有出现 #ntb.ntb-empty-upload';
        return { exists: false };
    }
    await moveAway(page);
    await page.waitForTimeout(350);
    const bar = await read(page, '#ntb');
    bar.isEmptyUpload = true;
    geometry[prefix + '.emptyUpload'] = bar;
    const box = await page.locator(sel).first().boundingBox();
    geometry.shots.emptyUpload = await shot(page, prefix + '-10-empty-upload-bar', [box], 34);
    return { exists: true, id: id, bar: bar };
}

/** 节点贴左 / 右边缘：悬停展开后整条不能溢出视口 */
async function captureEdges(page, prefix, nodeId, geometry) {
    const vp = page.viewportSize();
    const out = {};
    for (const side of ['left', 'right']) {
        await moveAway(page);
        await page.waitForTimeout(250);
        await page.evaluate(({ id, side, vpW }) => {
            const store = window.__cn;
            const n = store.node(id);
            if (!n) return;
            const k = store.state.view.k;
            const cur = n.x * k + store.state.view.x;
            const target = side === 'left' ? 6 : vpW - n.w * k - 6;
            store.updateNode(id, (x) => Object.assign({}, x, { x: x.x + (target - cur) / k }));
            store.setUI({ sel: new Set([id]) });
        }, { id: nodeId, side: side, vpW: vp.width });
        await page.waitForTimeout(700);
        const mid = await middleButton(page, '#ntb');
        const midSel = '#ntb [' + mid.attr + '="' + mid.key + '"]';
        await hoverStable(page, midSel);
        await page.waitForTimeout(450);
        const bar = await read(page, '#ntb');
        const r = bar.visual;
        out[side] = {
            bar: { left: r.left, right: Math.round((r.left + r.width) * 100) / 100, width: r.width },
            vp: vp,
            overflowLeft: Math.max(0, Math.round(-r.left * 100) / 100),
            overflowRight: Math.max(0, Math.round((r.left + r.width - vp.width) * 100) / 100),
            expandedLabelCount: bar.expandedLabelCount,
            buttonsInsideViewport: bar.buttons.every((x) => x.rect.left >= -0.5 && x.rect.left + x.rect.width <= vp.width + 0.5),
            marginLeft: bar.css.marginLeft,
        };
        geometry[prefix + '.edge.' + side] = bar;
        const box = await page.locator('#ntb').first().boundingBox();
        geometry.shots['edge' + side] = await shot(page, prefix + (side === 'left' ? '-11-edge-left-hover' : '-12-edge-right-hover'), [box], 30);
        await moveAway(page);
        await page.waitForTimeout(300);
    }
    return out;
}

/** ≤760px 视口：只显图标、按钮 32×32、容器 padding 6、不能横向滚动截断圆角 */
async function captureNarrow(browser, canvasId, prefix, geometry) {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(H.BASE + '/static/canvas.html?id=' + encodeURIComponent(canvasId), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__cn && window.__cn.state && window.__cn.state.doc), null, { timeout: 30000 });
    await page.waitForTimeout(700);
    const id = await addImageAt(page, '/output/dock-a.png', 60, 320, '窄视口 Dock 图');
    await page.waitForTimeout(400);
    await page.evaluate((nid) => window.__cn.setUI({ sel: new Set([nid]) }), id);
    await page.waitForTimeout(700);
    await moveAway(page);
    await page.waitForTimeout(400);
    await page.locator('#ntb').first().waitFor({ state: 'visible', timeout: 8000 });
    const collapsed = await read(page, '#ntb');
    geometry[prefix + '.narrow.collapsed'] = collapsed;
    const box0 = await page.locator('#ntb').first().boundingBox();
    geometry.shots.narrowCollapsed = await shot(page, prefix + '-13-narrow-700-collapsed', [box0], 30);

    const mid = await middleButton(page, '#ntb');
    const midSel = '#ntb [' + mid.attr + '="' + mid.key + '"]';
    await hoverStable(page, midSel);
    await page.waitForTimeout(450);
    const expanded = await read(page, '#ntb');
    geometry[prefix + '.narrow.hover'] = expanded;
    const box1 = await page.locator('#ntb').first().boundingBox();
    geometry.shots.narrowHover = await shot(page, prefix + '-14-narrow-700-hover', [box0, box1], 30);
    const inner = await page.evaluate((s) => {
        const bar = document.querySelector(s);
        const r = bar.getBoundingClientRect();
        const btns = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn')).map((b) => { const br = b.getBoundingClientRect(); return { left: br.left, right: br.right, w: br.width, h: br.height }; });
        return {
            radius: getComputedStyle(bar).borderRadius,
            clipRect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            firstLeft: btns.length ? btns[0].left : null,
            lastRight: btns.length ? btns[btns.length - 1].right : null,
            allInside: btns.every((b) => b.left >= r.left - 0.5 && b.right <= r.right + 0.5),
        };
    }, '#ntb');
    geometry[prefix + '.narrow.clip'] = inner;
    await ctx.close();
    return { collapsed: collapsed, expanded: expanded, clip: inner, pageErrors: errors };
}


/** 折叠态几何不变量：每颗按钮 36×36（含小标按钮），图标中心与按钮中心偏差 */
async function captureInvariants(page, barSel, prefix, geometry) {
    const data = await page.evaluate((s) => {
        const bar = document.querySelector(s);
        if (!bar) return null;
        const barRect = bar.getBoundingClientRect();
        const round = (v) => Math.round(v * 100) / 100;
        const btns = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn')).map((btn) => {
            const r = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg.i');
            const sr = svg ? svg.getBoundingClientRect() : null;
            const cs = getComputedStyle(btn);
            const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => btn.hasAttribute(a)) || null;
            return {
                key: attr ? btn.getAttribute(attr) : null,
                offsetW: btn.offsetWidth,
                offsetH: btn.offsetHeight,
                justify: cs.justifyContent,
                columnGap: cs.columnGap,
                children: Array.from(btn.children).map((c) => {
                    const cr = c.getBoundingClientRect();
                    return { cls: String((c.className && c.className.baseVal !== undefined) ? c.className.baseVal : (c.className || c.tagName)), w: round(cr.width), left: round(cr.left), display: getComputedStyle(c).display, maxWidth: getComputedStyle(c).maxWidth };
                }),
                hasBgdot: !!btn.querySelector('.bgdot'),
                hasTagmini: !!btn.querySelector('.tagmini'),
                padding: cs.padding,
                gap: cs.columnGap,
                isOpen: btn.classList.contains('is-open'),
                btn: { cx: round(r.left + r.width / 2), cy: round(r.top + r.height / 2), w: round(r.width), h: round(r.height) },
                icon: sr ? { w: round(sr.width), h: round(sr.height), cx: round(sr.left + sr.width / 2), cy: round(sr.top + sr.height / 2) } : null,
                iconDelta: sr ? { x: round(sr.left + sr.width / 2 - (r.left + r.width / 2)), y: round(sr.top + sr.height / 2 - (r.top + r.height / 2)) } : null,
                // 复合控件（palette 图标 + 当前色点）在折叠态按「整组居中」验收：色点是节点底色状态，不能丢
                // 角标（tagmini）是绝对定位、不占流，不算进整组
                groupDelta: (() => {
                    const flow = Array.from(btn.children).filter((c) => {
                        if (c === btn.querySelector(':scope > .cn-fm-label')) return false;
                        const st = getComputedStyle(c);
                        return st.position !== 'absolute' && st.display !== 'none';
                    });
                    if (!flow.length) return null;
                    let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
                    flow.forEach((c) => { const cr = c.getBoundingClientRect(); l = Math.min(l, cr.left); t = Math.min(t, cr.top); rr = Math.max(rr, cr.right); b = Math.max(b, cr.bottom); });
                    return { x: round((l + rr) / 2 - (r.left + r.width / 2)), y: round((t + b) / 2 - (r.top + r.height / 2)) };
                })(),
            };
        });
        return { bar: { left: round(barRect.left), top: round(barRect.top), width: round(barRect.width), height: round(barRect.height) }, buttons: btns };
    }, barSel);
    if (!data) {
        geometry[prefix + '.invariants'] = { missing: true };
        return { exists: false };
    }
    geometry[prefix + '.invariants'] = data;
    return { exists: true, bar: data.bar, buttons: data.buttons };
}

/**
 * 禁用守卫：同一颗正常按钮，先正常悬停（对照：应展开），再把它的 disabled 属性设成 true 原样悬停，
 * 断言不展开、滑块不亮；复位后再悬停一次确认恢复（证明测的是 disabled 分支，而不是按钮本身坏了）。
 */
async function captureDisabled(page, prefix, geometry) {
    await moveAway(page);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
        const store = window.__cn;
        const n = store.state.doc.nodes.find((x) => x.kind === 'image' && x.data && x.data.gen && (x.data.gen.hist || []).length);
        if (n) store.setUI({ sel: new Set([n.id]) });
    });
    await page.waitForTimeout(800);
    await moveAway(page);
    await page.waitForTimeout(350);
    const keys = await page.evaluate(() => Array.from(document.querySelectorAll('#ntb > .cn-fm-btn')).map((b) => b.getAttribute('data-tb')));
    if (!keys.length) {
        geometry[prefix + '.disabled'] = { missing: true, reason: '没有可见的 #ntb 按钮' };
        return { exists: false };
    }
    const key = keys.indexOf('adjust') >= 0 ? 'adjust' : keys[0];
    const sel = '#ntb [data-tb="' + key + '"]';
    const boxOf = async () => page.locator(sel).first().boundingBox({ timeout: 6000 }).catch(() => null);
    const stateOf = async () => {
        const bar = await read(page, '#ntb');
        const target = bar.buttons.find((x) => x.key === key) || null;
        const isOpen = await page.evaluate((s) => { const b = document.querySelector(s); return b ? b.classList.contains('is-open') : null; }, sel);
        return { target: target, isOpen: isOpen, hlOpacity: bar.hl ? bar.hl.opacity : null };
    };

    // 对照：正常悬停 → 应该展开（位置在展开过程中会动，最多试 5 次直到指针真的落在这颗上）
    const hoverThis = async () => {
        for (let i = 0; i < 5; i += 1) {
            const box = await boxOf();
            if (!box) return null;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: i ? 2 : 6 });
            await page.waitForTimeout(i ? 260 : 420);
            const openKey = await page.evaluate(() => { const b = document.querySelector('#ntb > .cn-fm-btn.is-open'); return b ? b.getAttribute('data-tb') : null; });
            if (openKey === key) return box;
        }
        return null;
    };
    let box = await hoverThis();
    const controlOpen = await stateOf();
    geometry.shots.disabledControl = await shot(page, prefix + '-15a-control-open', [await boxOf()], 34);
    await moveAway(page);
    await page.waitForTimeout(350);

    // 设 disabled → 原样悬停 300ms → 不应该展开
    await page.evaluate((s) => { const b = document.querySelector(s); if (b) b.disabled = true; }, sel);
    box = await boxOf();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(300);
    const disabledState = await stateOf();
    const stillDisabled = await page.evaluate((s) => { const b = document.querySelector(s); return b ? b.disabled : null; }, sel);
    const disabledShotBox = await boxOf();
    if (disabledShotBox) geometry.shots.disabledHover = await shot(page, prefix + '-15b-disabled-hover', [disabledShotBox], 34);
    await moveAway(page);
    await page.waitForTimeout(350);

    // 复位 → 再悬停一次应该恢复展开
    await page.evaluate((s) => { const b = document.querySelector(s); if (b) b.disabled = false; }, sel);
    await moveAway(page);
    await page.waitForTimeout(250);
    box = await hoverThis();
    const restored = await stateOf();
    await moveAway(page);
    await page.waitForTimeout(300);

    geometry[prefix + '.disabled'] = { key: key, control: controlOpen, disabled: disabledState, restored: restored, stillDisabled: stillDisabled };
    return { exists: true, key: key, control: controlOpen, disabled: disabledState, restored: restored, stillDisabled: stillDisabled };
}

/** 带小标的折叠按钮：图片节点开颜色标记（tagmini）、有结果的文本节点（bgdot）各量一次 36×36 + 图标居中 */
async function captureAdornments(page, imageId, prefix, geometry) {
    await page.evaluate(({ id }) => {
        const store = window.__cn;
        store.patchGen(id, { tag: 'red', pinned: true }, { history: false });
        store.setUI({ sel: new Set([id]) });
    }, { id: imageId });
    await page.waitForTimeout(800);
    await moveAway(page);
    await page.waitForTimeout(400);
    const tagBar = await captureInvariants(page, '#ntb', prefix + '.tagBar', geometry);
    const tagBox = await page.locator('#ntb').first().boundingBox({ timeout: 6000 }).catch(() => null);
    if (tagBox) geometry.shots.tagBar = await shot(page, prefix + '-15c-tag-bar', [tagBox], 34);

    // 有结果的文本节点：工具条 = 背景色(bgdot) / 标记 / 复制 / 素材库 / 全屏（空文本节点没有工具条）
    const textId = await addNodeAtScreen(page, 'text', 1000, 640, { hist: [{ text: '背景色小标几何验证', meta: { model: 'seed' } }], hi: 0, title: '小标验证文本' });
    await page.waitForTimeout(500);
    await page.evaluate(({ id }) => window.__cn.setUI({ sel: new Set([id]) }), { id: textId });
    await page.waitForTimeout(800);
    await moveAway(page);
    await page.waitForTimeout(400);
    const textBar = await page.locator('#ntb').count()
        ? await captureInvariants(page, '#ntb', prefix + '.textBar', geometry)
        : { exists: false };
    const textBox = await page.locator('#ntb').first().boundingBox({ timeout: 6000 }).catch(() => null);
    if (textBox) geometry.shots.textBar = await shot(page, prefix + '-15d-text-bar-bgdot', [textBox], 34);
    return { tagBar: tagBar, textBar: textBar };
}

/** 横向扫掠：指针从 #ntb 左端匀速走到右端，记录 is-open 序列 / 开关次数 / left 抖动 */
async function captureSweep(page, prefix, geometry) {
    await moveAway(page);
    await page.waitForTimeout(400);
    const box = await page.locator('#ntb').first().boundingBox();
    if (!box) {
        geometry[prefix + '.sweep'] = { missing: true };
        return { exists: false };
    }
    const y = box.y + box.height / 2;
    const x0 = box.x + 3;
    const x1 = box.x + box.width - 3;
    const N = 46;
    const samples = [];
    for (let i = 0; i <= N; i += 1) {
        const x = x0 + ((x1 - x0) * i) / N;
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        const s = await page.evaluate((sel) => {
            const bar = document.querySelector(sel);
            if (!bar) return null;
            const r = bar.getBoundingClientRect();
            const open = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn.is-open')).map((b) => {
                const attr = ['data-tb', 'data-mb', 'data-gt', 'data-st'].find((a) => b.hasAttribute(a)) || null;
                return attr ? b.getAttribute(attr) : '?';
            });
            const hl = bar.querySelector('.cn-fm-hl');
            return {
                on: bar.classList.contains('on'),
                open: open,
                left: Math.round(r.left * 100) / 100,
                width: Math.round(r.width * 100) / 100,
                marginLeft: bar.style.marginLeft || '',
                hlOpacity: hl ? getComputedStyle(hl).opacity : null,
            };
        }, '#ntb');
        samples.push(Object.assign({ i: i, x: Math.round(x * 10) / 10 }, s || { missing: true }));
        if (i === Math.round(N / 2)) {
            geometry.shots.sweepMid = await shot(page, prefix + '-16-sweep-mid', [box], 36);
        }
    }
    // 序列 / 开关次数 / 抖动分析
    const openSeq = samples.map((s) => (s.open && s.open.length ? s.open[0] : null));
    const switches = [];
    let prev = null;
    openSeq.forEach((k) => { if (k && k !== prev) { switches.push(k); prev = k; } });
    const dup = switches.filter((k, idx) => switches.indexOf(k) !== idx);
    const maxOpen = Math.max.apply(null, samples.map((s) => (s.open || []).length));
    const onAlways = samples.every((s) => s.on === true);
    const deltas = [];
    for (let i = 1; i < samples.length; i += 1) deltas.push(Math.round((samples[i].left - samples[i - 1].left) * 100) / 100);
    const reversals = [];
    for (let i = 1; i < deltas.length; i += 1) {
        if (Math.abs(deltas[i]) > 1 && Math.abs(deltas[i - 1]) > 1 && Math.sign(deltas[i]) !== Math.sign(deltas[i - 1])) {
            reversals.push({ at: samples[i].i, d1: deltas[i - 1], d2: deltas[i], open: samples[i].open });
        }
    }
    // 「连续 3 帧方向反复」（锯齿）才算抖：reversals 里相邻两条间隔 ≤2 帧
    const zigzag = reversals.filter((r, i) => i > 0 && r.at - reversals[i - 1].at <= 2);
    const summary = {
        samples: samples.length,
        switchSeq: switches,
        switchCount: switches.length,
        duplicateOpens: dup,
        maxOpenAtOnce: maxOpen,
        onAlways: onAlways,
        leftFirst: samples[0].left,
        leftLast: samples[samples.length - 1].left,
        leftReversals: reversals,
        zigzagFrames: zigzag,
        leftSeries: samples.map((s) => s.left),
        widthSeries: samples.map((s) => s.width),
    };
    geometry[prefix + '.sweep'] = { summary: summary, samples: samples };
    console.log('READ  sweep 开关序列=' + JSON.stringify(switches) + ' 抖动帧=' + zigzag.length + ' left反向=' + reversals.length);
    geometry.shots.sweepEnd = await shot(page, prefix + '-17-sweep-end', [await page.locator('#ntb').first().boundingBox()], 36);
    await moveAway(page);
    await page.waitForTimeout(400);
    return { exists: true, summary: summary };
}

/**
 * 磨砂证据（专门的干净画布，场景与 variants 的 V2 完全一致，渗透读数才能对账）：
 *   a) dock 压在画布点阵上（空区）
 *   b) dock 压在彩色图片右边缘（一半在图上、一半在画布上）
 */
async function setupGlassScene(page) {
    const urlA = '/output/dock-a.png';
    const urlB = '/output/dock-b.png';
    await page.evaluate(() => { try { window.__cn.setUI({ agentOpen: false }); } catch (err) { /* 忽略 */ } });
    await page.waitForTimeout(500);
    const imgId = await addNodeAtScreen(page, 'image', 620, 380, { hist: [{ url: urlA, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃·彩色底板' });
    const overId = await addNodeAtScreen(page, 'image', 760, 500, { hist: [{ url: urlB, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃·压图节点' });
    await page.waitForTimeout(700);
    const imgBox = await page.locator('.node[data-id="' + imgId + '"]').first().boundingBox({ timeout: 8000 }).catch(() => null);
    await page.evaluate(({ id }) => window.__cn.setUI({ sel: new Set([id]) }), { id: overId });
    await page.waitForTimeout(800);
    await moveAway(page);
    await page.waitForTimeout(350);
    if (imgBox) {
        for (let i = 0; i < 5; i += 1) {
            const bar = await page.locator('#ntb').first().boundingBox({ timeout: 8000 }).catch(() => null);
            if (!bar) break;
            const dx = (imgBox.x + imgBox.width) - (bar.x + bar.width / 2);
            if (Math.abs(dx) < 2) break;
            await shiftNodeByScreenDx(page, overId, dx);
            await page.waitForTimeout(320);
        }
    }
    const gridId = await addNodeAtScreen(page, 'image', 260, 300, { hist: [{ url: urlB, w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃·点阵场景' });
    await page.waitForTimeout(700);
    const gridBox = await page.locator('.node[data-id="' + gridId + '"]').first().boundingBox({ timeout: 8000 }).catch(() => null);
    return { imgId: imgId, overId: overId, gridId: gridId, imgBox: imgBox, gridBox: gridBox };
}
/** 同一颗 dock 分别在点阵底 / 彩色图片边缘各量一次 + 截一张 */
async function shotGlassPair(page, scene, theme, geometry) {
    const pick = async (id) => {
        await page.evaluate(({ id }) => window.__cn.setUI({ sel: new Set([id]) }), { id: id });
        await page.waitForTimeout(750);
        await moveAway(page);
        await page.waitForTimeout(400);
    };
    const capture = async (sceneName, boxes, pad, pixelKey, shotKey) => {
        const probe = await dockProbe(page);
        if (!probe) return null;
        const dockBox = { x: probe.rect.left, y: probe.rect.top, width: probe.rect.width, height: probe.rect.height };
        const shotInfo = await shotTo(page, OUT, theme + '-' + sceneName, (boxes || []).concat([dockBox]), pad);
        geometry.shots[shotKey] = shotInfo.file;
        let pixel = null;
        try {
            const img = decodePng(shotInfo.file);
            pixel = img.pixel(probe.sample.x - shotInfo.clip.x, probe.sample.y - shotInfo.clip.y).slice(0, 3);
            geometry.contrast[theme + '.' + pixelKey] = pixel;
        } catch (err) { geometry.contrast[theme + '.' + pixelKey + 'Error'] = String(err && err.message || err); }
        return { probe: probe, pixel: pixel, shot: shotInfo.file };
    };
    await pick(scene.gridId);
    const grid = await capture('20-glass-over-grid', scene.gridBox ? [{ x: scene.gridBox.x, y: scene.gridBox.y - 70, width: scene.gridBox.width, height: 40 }] : null, 90, 'glassGridPixel', theme === 'light' ? 'glassGrid' : 'glassDarkGrid');
    geometry[theme + '.glass.grid'] = await read(page, '#ntb');
    await pick(scene.overId);
    const over = await capture('21-glass-over-image', scene.imgBox ? [{ x: scene.imgBox.x, y: scene.imgBox.y, width: scene.imgBox.width, height: scene.imgBox.height }] : null, 20, 'glassOverImagePixel', theme === 'light' ? 'glassOverImage' : 'glassDarkOverImage');
    geometry[theme + '.glass.overImage'] = await read(page, '#ntb');
    return { grid: grid, overImage: over };
}
/** 用两张干净画布（浅/深）跑磨砂证据，避免主流程里已有节点/发电面板干扰取样点 */
async function captureGlassEvidenceScenes(api, browser, geometry) {
    const canvases = [];
    const out = {};
    try {
        const cLight = await H.createCanvas(api, 'VERIFY-GLASS-EVIDENCE-LIGHT-' + Date.now());
        canvases.push(cLight);
        const light = await H.openCanvasPage(browser, cLight);
        light.page.setDefaultTimeout(8000);
        await light.page.evaluate(() => { try { localStorage.removeItem('studio_theme'); localStorage.removeItem('openarc-canvas-theme'); } catch (err) { /* 忽略 */ } });
        const sceneLight = await setupGlassScene(light.page);
        out.light = await shotGlassPair(light.page, sceneLight, 'light', geometry);
        out.lightPageErrors = light.pageErrors;

        const cDark = await H.createCanvas(api, 'VERIFY-GLASS-EVIDENCE-DARK-' + Date.now());
        canvases.push(cDark);
        const dark = await H.openCanvasPage(browser, cDark, {
            beforeGoto: async (p) => { await p.addInitScript(() => { try { localStorage.setItem('studio_theme', 'dark'); localStorage.setItem('openarc-canvas-theme', 'dark'); } catch (err) { /* 忽略 */ } }); },
        });
        dark.page.setDefaultTimeout(8000);
        const sceneDark = await setupGlassScene(dark.page);
        out.dark = await shotGlassPair(dark.page, sceneDark, 'dark', geometry);
        out.darkPageErrors = dark.pageErrors;
    } finally {
        for (const id of canvases) { try { await H.deleteCanvas(api, id); } catch (err) { /* 忽略 */ } }
    }
    return out;
}

/* ---------------- 断言工具 ---------------- */
/**
 * 解析 getComputedStyle 的底色：
 *   - `rgb(17, 17, 17)` / `rgba(17, 17, 17, 0.78)`
 *   - `color(srgb 0.0667 0.0667 0.0667 / 0.78)`（color-mix 合成后的计算值）
 * 返回 { r, g, b, a }（0~255 + 0~1），无法解析返回 null。
 */
function parseColor(value) {
    const text = String(value || '').trim();
    const rgb = text.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
        const parts = rgb[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    const srgb = text.match(/color\(srgb\s+([^)]+)\)/);
    if (srgb) {
        const parts = srgb[1].split(/[\s\/]+/).filter(Boolean).map(Number);
        if (parts.length >= 3) {
            return {
                r: Math.round(parts[0] * 255), g: Math.round(parts[1] * 255), b: Math.round(parts[2] * 255),
                a: parts.length > 3 ? parts[3] : 1,
            };
        }
    }
    if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    return null;
}
/** 半透明底色叠在某个背景上之后的实际观感色 */
function compositeOver(base, bg) {
    const a = base.a;
    return [
        Math.round(base.r * a + bg[0] * (1 - a)),
        Math.round(base.g * a + bg[1] * (1 - a)),
        Math.round(base.b * a + bg[2] * (1 - a)),
    ];
}
/** 白字 / 白图标（折叠态 rgba(255,255,255,.7)）压在「底 + 雾层」合成色上的对比度 */
function glassReadability(base, fog) {
    const veil = fog || 0;
    const cases = [
        { name: '白画布', bg: [255, 255, 255] },
        { name: '纯黑画布', bg: [0, 0, 0] },
        { name: '亮色图片(255,255,0)', bg: [255, 255, 0] },
        { name: '亮色图片(240,240,255)', bg: [240, 240, 255] },
    ];
    return cases.map((item) => {
        const under = compositeOver(base, item.bg);
        // 雾层是叠在底之上的半透明白：c = veil*255 + (1-veil)*under
        const composited = under.map((c) => Math.round(veil * 255 + (1 - veil) * c));
        const white = contrast([255, 255, 255], composited);
        const icon = contrast(compositeOver({ r: 255, g: 255, b: 255, a: 0.7 }, composited), composited);
        return { on: item.name, background: item.bg, composited: composited, under: under, fog: veil, whiteTextContrast: white, whiteIconContrast: icon };
    });
}
/** 玻璃底：alpha < 1、基色对得上、backdrop-filter 带 blur + saturate */
function glassOf(bar, baseRgb, alpha, fog) {
    const bg = parseColor(bar.css.backgroundColor);
    const bf = bar.css.backdropFilter || '';
    const wbf = bar.css.webkitBackdropFilter || '';
    const img = bar.css.backgroundImage || '';
    const veil = fog === undefined ? 0 : fog;
    const alphaOk = !!bg && bg.a > 0 && bg.a < 1 && Math.abs(bg.a - alpha) <= GLASS.alphaTol;
    const baseOk = !!bg && Math.abs(bg.r - baseRgb[0]) <= 2 && Math.abs(bg.g - baseRgb[1]) <= 2 && Math.abs(bg.b - baseRgb[2]) <= 2;
    const bfOk = GLASS.blur.test(bf) && GLASS.saturate.test(bf);
    const wbfOk = !wbf || (GLASS.blur.test(wbf) && GLASS.saturate.test(wbf));
    // 雾层：background-image 里要有 linear-gradient，颜色是 rgba(255,255,255,~fog)
    const veilMatch = img.match(/rgba?\(255,\s*255,\s*255,\s*([0-9.]+)\)/);
    const veilAlpha = veilMatch ? Number(veilMatch[1]) : (veil ? null : 0);
    const veilOk = veil > 0
        ? (GLASS.veil.test(img) && veilAlpha !== null && Math.abs(veilAlpha - veil) <= 0.015)
        : !GLASS.veil.test(img);
    const overWhite = bg
        ? compositeOver(bg, [255, 255, 255]).map((c) => Math.round(veil * 255 + (1 - veil) * c))
        : null;
    return {
        raw: bar.css.backgroundColor,
        backgroundImage: img,
        parsed: bg,
        alpha: bg ? bg.a : null,
        base: bg ? [bg.r, bg.g, bg.b] : null,
        alphaOk: alphaOk,
        baseOk: baseOk,
        veilAlpha: veilAlpha,
        veilOk: veilOk,
        backdropFilter: bf,
        webkitBackdropFilter: wbf,
        blurOk: GLASS.blur.test(bf) && (!wbf || GLASS.blur.test(wbf)),
        saturateOk: GLASS.saturate.test(bf) && (!wbf || GLASS.saturate.test(wbf)),
        backdropOk: bfOk && wbfOk,
        overWhite: overWhite,
        readability: bg ? glassReadability(bg, veil) : null,
    };
}
function isNearWhite(color, tol) {
    const c = parseColor(color);
    if (!c) return false;
    return c.r >= 255 - tol && c.g >= 255 - tol && c.b >= 255 - tol;
}
function sameSkin(a, b) {
    if (!a || !b || !a.exists || !b.exists) return { ok: false, detail: { a: a && a.exists, b: b && b.exists } };
    const detail = {
        ntb: { bg: a.css.backgroundColor, radius: a.css.borderRadius, h: a.css.offsetHeight },
        other: { bg: b.css.backgroundColor, radius: b.css.borderRadius, h: b.css.offsetHeight },
    };
    const ok = a.css.backgroundColor === b.css.backgroundColor && a.css.borderRadius === b.css.borderRadius && Math.abs(a.css.offsetHeight - b.css.offsetHeight) <= 0.5;
    return { ok: ok, detail: detail };
}


/* =====================================================================================
 * 玻璃三档形态预览（variants 模式，不改源码、不重建，只 addStyleTag 注入覆盖样式）
 *   node tests/novai_dock_toolbar_shots.cjs variants
 * 输出：tests/artifacts/dock-verify/variants/{v1,v2,v3}/*.png + variants.json
 * ===================================================================================== */
const VARIANT_DIR = path.join(ROOT, 'variants');
const VARIANTS = {
    v1: {
        label: 'V1 现状：浅 #111 78% / 深 #1c1c1e 82%，无雾层',
        light: 'color-mix(in srgb, rgb(17,17,17) 78%, transparent)',
        dark: 'color-mix(in srgb, rgb(28,28,30) 82%, transparent)',
        lightAlpha: 0.78, darkAlpha: 0.82, lightFog: 0, darkFog: 0,
        lightBase: [17, 17, 17], darkBase: [28, 28, 30],
    },
    v2: {
        label: 'V2 加雾：浅 白 6% 雾层 + #111 74% / 深 白 4% + #1c1c1e 80%',
        light: 'linear-gradient(rgba(255,255,255,.06),rgba(255,255,255,.06)), color-mix(in srgb, rgb(17,17,17) 74%, transparent)',
        dark: 'linear-gradient(rgba(255,255,255,.04),rgba(255,255,255,.04)), color-mix(in srgb, rgb(28,28,30) 80%, transparent)',
        lightAlpha: 0.74, darkAlpha: 0.80, lightFog: 0.06, darkFog: 0.04,
        lightBase: [17, 17, 17], darkBase: [28, 28, 30],
    },
    v3: {
        label: 'V3 更透：浅 #111 68% / 深 #1c1c1e 76%，无雾层',
        light: 'color-mix(in srgb, rgb(17,17,17) 68%, transparent)',
        dark: 'color-mix(in srgb, rgb(28,28,30) 76%, transparent)',
        lightAlpha: 0.68, darkAlpha: 0.76, lightFog: 0, darkFog: 0,
        lightBase: [17, 17, 17], darkBase: [28, 28, 30],
    },
};
function variantCss(v) {
    return '.cn-root .cn-fm, .cn-root #ntb.cn-fm { background: ' + v.light + ' !important; }\n' +
        '.cn-root[data-theme="dark"] .cn-fm, .cn-root[data-theme="dark"] #ntb.cn-fm { background: ' + v.dark + ' !important; }';
}
async function applyVariantCss(page, css) {
    await page.evaluate(({ css }) => {
        let el = document.getElementById('dock-variant-css');
        if (!el) { el = document.createElement('style'); el.id = 'dock-variant-css'; document.head.appendChild(el); }
        el.textContent = css;
    }, { css: css });
    await page.waitForTimeout(160);
}
async function shotTo(page, dir, name, boxes, pad) {
    ensureDir(dir);
    const file = path.join(dir, name + '.png');
    let clip = clipAround(page, boxes, pad === undefined ? 30 : pad);
    const vp = page.viewportSize();
    if (clip.x >= vp.width || clip.y >= vp.height) clip = { x: 0, y: 0, width: vp.width, height: vp.height };
    await page.screenshot({ path: file, clip: clip });
    console.log('SHOT  ' + path.relative(path.join(__dirname, '..'), file) + '  clip=' + JSON.stringify(clip));
    return { file: file, clip: clip };
}
/** 量 dock 的取样点：按钮 1/2 之间的缝（避开图标和文字） */
async function dockProbe(page) {
    return page.evaluate(() => {
        const bar = document.querySelector('#ntb');
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        const btns = Array.from(bar.querySelectorAll(':scope > .cn-fm-btn')).map((b) => b.getBoundingClientRect());
        const first = btns[0], second = btns[1];
        const sampleX = (first && second) ? Math.round(first.right + (second.left - first.right) / 2) : Math.round(r.left + r.width / 2);
        const root = bar.closest('.cn-root');
        return {
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            sample: { x: sampleX, y: Math.round(r.top + r.height / 2) },
            outside: { x: sampleX, y: Math.round(r.top - 12) },
            insidePadding: { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) },
            backgroundColor: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            backdropFilter: cs.backdropFilter,
            theme: root ? root.getAttribute('data-theme') : null,
            buttons: btns.length,
        };
    });
}
async function shiftNodeByScreenDx(page, id, dx) {
    await page.evaluate(({ id, dx }) => {
        const store = window.__cn;
        const k = store.state.view.k || 1;
        store.updateNode(id, (n) => Object.assign({}, n, { x: n.x + dx / k }));
    }, { id: id, dx: dx });
}
/** 按变体参数算「期望合成色」，与实测像素比；顺带算白字/白图标对比度 */
function analyzePixel(variant, theme, probe, inside, outside) {
    const alpha = theme === 'dark' ? variant.darkAlpha : variant.lightAlpha;
    const base = theme === 'dark' ? variant.darkBase : variant.lightBase;
    const fog = (theme === 'dark' ? variant.darkFog : variant.lightFog) || 0;
    const composed = base.map((c, i) => c * alpha + outside[i] * (1 - alpha));
    const expected = composed.map((c) => Math.round(fog * 255 + (1 - fog) * c));
    const deviation = [0, 1, 2].map((i) => inside[i] - expected[i]);
    return {
        probe: probe,
        inside: inside.slice(0, 3),
        outside: outside.slice(0, 3),
        expected: expected,
        deviation: deviation,
        maxAbsDeviation: Math.max.apply(null, deviation.map(Math.abs)),
        whiteTextContrast: contrast([255, 255, 255], inside),
        whiteIconContrast: contrast(compositeOver({ r: 255, g: 255, b: 255, a: 0.7 }, inside), inside),
    };
}
async function measureScene(page, variant, theme, dir, sceneName, boxes, pad) {
    const probe = await dockProbe(page);
    if (!probe) return null;
    const shot = await shotTo(page, dir, sceneName, boxes || [{ x: probe.rect.left, y: probe.rect.top, width: probe.rect.width, height: probe.rect.height }], pad);
    const img = decodePng(shot.file);
    const at = (pt) => img.pixel(pt.x - shot.clip.x, pt.y - shot.clip.y);
    const inside = at(probe.sample);
    const outside = at(probe.outside);
    const result = analyzePixel(variant, theme, probe, inside, outside);
    result.insidePadding = at(probe.insidePadding).slice(0, 3);
    result.shot = path.relative(path.join(__dirname, '..'), shot.file);
    // 取样点必须真的落在 dock 上：浅色主题 dock 是深色（亮度低），拿去和 12px 外的背景比，差太小说明被面板挡住了
    const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const insideLum = lum(inside);
    const outsideLum = lum(outside);
    result.sampleLooksLikeDock = Math.abs(insideLum - outsideLum) > 0.08 || insideLum < 0.35;
    if (!result.sampleLooksLikeDock) result.warn = '取样点可能没落在 dock 上（inside≈outside：面板遮挡或 dock 不可见）';
    if (!result.sampleLooksLikeDock) console.log('WARN  ' + theme + ' ' + sceneName + ' 取样点可疑 inside=' + JSON.stringify(inside.slice(0, 3)) + ' outside=' + JSON.stringify(outside.slice(0, 3)));
    return result;
}

async function runVariants() {
    ensureDir(VARIANT_DIR);
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasLight = '';
    let canvasDark = '';
    let browser = null;
    const out = { mode: 'variants', generatedAt: new Date().toISOString(), base: H.BASE, build: buildFingerprint(), variants: {}, notes: {} };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) throw new Error('后端不可用：' + H.BASE);
        canvasLight = await H.createCanvas(api, 'VERIFY-GLASS-LIGHT-' + Date.now());
        canvasDark = await H.createCanvas(api, 'VERIFY-GLASS-DARK-' + Date.now());
        const pngs = ['dock-a', 'dock-b'].map((n, i) => seedPng(path.join(H.OUT_DIR, n + '.png'), [20, 90][i]));
        out.notes.fixtures = pngs;
        browser = await H.launchBrowser();

        /** 搭同一套场景：彩色底板 + 压图节点（dock 中心对准底板右边缘）+ 点阵空区的独立节点 */
        const setupScene = async (page) => {
            await page.evaluate(() => { try { window.__cn.setUI({ agentOpen: false }); } catch (err) { /* 忽略 */ } });
            await page.waitForTimeout(500);
            // 位置要避开发电面板 #gp：它贴在节点下方，放不下会被推到画布底部，可能盖住 dock
            //   彩色底板：右中；压图节点：dock 对准底板右边缘，且 #gp 仍能落在视口内
            //   点阵场景节点：左上空白区（dock 在 y≈250，四周没有别的节点）
            const imgId = await addNodeAtScreen(page, 'image', 620, 380, { hist: [{ url: '/output/dock-a.png', w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃变体·彩色底板' });
            const overId = await addNodeAtScreen(page, 'image', 760, 500, { hist: [{ url: '/output/dock-b.png', w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃变体·压图节点' });
            await page.waitForTimeout(700);
            const imgBox = await page.locator('.node[data-id="' + imgId + '"]').first().boundingBox({ timeout: 8000 }).catch(() => null);
            await page.evaluate((id) => window.__cn.setUI({ sel: new Set([id]) }), overId);
            await page.waitForTimeout(800);
            await moveAway(page);
            await page.waitForTimeout(350);
            if (imgBox) {
                for (let i = 0; i < 5; i += 1) {
                    const bar = await page.locator('#ntb').first().boundingBox({ timeout: 8000 }).catch(() => null);
                    if (!bar) break;
                    const dx = (imgBox.x + imgBox.width) - (bar.x + bar.width / 2);
                    if (Math.abs(dx) < 2) break;
                    await shiftNodeByScreenDx(page, overId, dx);
                    await page.waitForTimeout(320);
                }
            }
            const gridId = await addNodeAtScreen(page, 'image', 260, 300, { hist: [{ url: '/output/dock-b.png', w: 800, h: 600, meta: { model: 'seed' } }], hi: 0, title: '玻璃变体·点阵场景' });
            await page.waitForTimeout(700);
            return { imgId: imgId, overId: overId, gridId: gridId, imgBox: imgBox };
        };
        const select = async (page, id) => {
            await page.evaluate(({ id }) => window.__cn.setUI({ sel: new Set([id]) }), { id: id });
            await page.waitForTimeout(700);
            await moveAway(page);
            await page.waitForTimeout(400);
        };

        const light = await H.openCanvasPage(browser, canvasLight);
        light.page.setDefaultTimeout(8000);
        await light.page.evaluate(() => { try { localStorage.removeItem('studio_theme'); localStorage.removeItem('openarc-canvas-theme'); } catch (err) { /* 忽略 */ } });
        const lightScene = await setupScene(light.page);
        const dark = await H.openCanvasPage(browser, canvasDark, {
            beforeGoto: async (p) => { await p.addInitScript(() => { try { localStorage.setItem('studio_theme', 'dark'); localStorage.setItem('openarc-canvas-theme', 'dark'); } catch (err) { /* 忽略 */ } }); },
        });
        dark.page.setDefaultTimeout(8000);
        const darkScene = await setupScene(dark.page);
        const darkTheme = await dark.page.evaluate(() => { const r = document.querySelector('.cn-root'); return r ? r.getAttribute('data-theme') : null; });
        out.notes.darkTheme = darkTheme;

        for (const key of Object.keys(VARIANTS)) {
            const v = VARIANTS[key];
            const dir = path.join(VARIANT_DIR, key);
            ensureDir(dir);
            const record = { label: v.label, css: { light: v.light, dark: v.dark }, params: { lightAlpha: v.lightAlpha, darkAlpha: v.darkAlpha, lightFog: v.lightFog, darkFog: v.darkFog } };

            // ---- 浅色 ----
            await applyVariantCss(light.page, variantCss(v));
            await select(light.page, lightScene.gridId);
            record.lightGrid = await measureScene(light.page, v, 'light', dir, 'light-grid', null, 90);
            await select(light.page, lightScene.overId);
            record.lightOverImage = await measureScene(light.page, v, 'light', dir, 'light-over-image', null, 30);

            // ---- 深色 ----
            await applyVariantCss(dark.page, variantCss(v));
            await select(dark.page, darkScene.gridId);
            record.darkGrid = await measureScene(dark.page, v, 'dark', dir, 'dark-grid', null, 90);
            await select(dark.page, darkScene.overId);
            record.darkOverImage = await measureScene(dark.page, v, 'dark', dir, 'dark-over-image', null, 30);

            // ---- 渗透 delta（同一档 CSS，压强色区 vs 压纯画布）与判据 ----
            const delta = (a, b) => (a && b) ? [0, 1, 2].map((i) => b.inside[i] - a.inside[i]) : null;
            record.penetrationLight = delta(record.lightGrid, record.lightOverImage);
            record.penetrationDark = delta(record.darkGrid, record.darkOverImage);
            const allScenes = [record.lightGrid, record.lightOverImage, record.darkGrid, record.darkOverImage].filter(Boolean);
            record.allSamplesValid = allScenes.every((s) => s.sampleLooksLikeDock !== false);
            if (!record.allSamplesValid) console.log('WARN  ' + key + ' 至少一个取样点可疑，见各 scene 的 warn');
            record.minWhiteTextContrast = Math.min.apply(null, allScenes.map((s) => s.whiteTextContrast));
            record.minWhiteIconContrast = Math.min.apply(null, allScenes.map((s) => s.whiteIconContrast));
            record.avgMaxDeviation = Math.round(allScenes.reduce((acc, s) => acc + s.maxAbsDeviation, 0) / allScenes.length * 10) / 10;
            out.variants[key] = record;
            console.log('READ  ' + key + ' 渗透(light浅=强色区-点阵)=' + JSON.stringify(record.penetrationLight) +
                ' 渗透(dark)=' + JSON.stringify(record.penetrationDark) +
                ' 白字最低=' + record.minWhiteTextContrast + ' 白图标最低=' + record.minWhiteIconContrast);
        }

        // 一句话建议：能被背后颜色明显染色（渗透 delta 大）且白字/白图标仍够对比，才算「磨砂但不糊成灰块」
        const score = (r) => {
            const pen = Math.max.apply(null, (r.penetrationLight || [0, 0, 0]).map(Math.abs));
            const visible = pen >= 12 ? 2 : pen >= 6 ? 1 : 0;
            const readable = r.minWhiteTextContrast >= 4.5 && r.minWhiteIconContrast >= 3 ? 2 : 0;
            return visible + readable;
        };
        out.notes.autoScore = Object.keys(out.variants).map((k) => ({ variant: k, score: score(out.variants[k]), penetrationLight: out.variants[k].penetrationLight, minWhiteTextContrast: out.variants[k].minWhiteTextContrast }));
        // 人工结论（读数 + 截图一起看）：
        //   V2 把"雾面"做出来了（浅色 dock 内部 66→86），同时压彩图还有 23~25 的色偏渗透，白字 7.33:1 够读；
        //   V1 最瓷实、雾感最弱；V3 渗透最强但压白画布被冲淡到 90，最接近"灰块"。
        out.judgement = 'V2（白色雾层 6%/4% + 基色 74%/80%）最像磨砂玻璃、又没糊成灰块：压白画布时 dock 内部从 V1 的 rgb(66,66,67) 抬到 rgb(86,86,87)（有雾面奶感），压彩色图片仍保留 23~25 个通道的色偏渗透，白字对比度最低 7.33:1；V1 最"瓷实"、雾感最弱；V3 渗透最强（30~33）但压白画布被冲淡到 rgb(90,90,91)，最接近"灰块"。';
        out.recommendation = 'v2';
        out.recommendationNote = '要更强的"透"就取 V3（渗透 30~33），要更稳的深色玻璃就取 V1；V2 是两者之间唯一带明显雾层的一档。';
        out.buildAtEnd = buildFingerprint();
        out.buildChangedDuringRun = JSON.stringify(out.build) !== JSON.stringify(out.buildAtEnd);
        ensureDir(VARIANT_DIR);
        fs.writeFileSync(path.join(VARIANT_DIR, 'variants.json'), JSON.stringify(out, null, 2));
        console.log('WRITE ' + path.join(VARIANT_DIR, 'variants.json'));
        console.log('[variants] 完成：' + Object.keys(out.variants).join(' / ') + ' → ' + path.relative(path.join(__dirname, '..'), VARIANT_DIR));
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasLight);
        await H.deleteCanvas(api, canvasDark);
        await api.dispose();
    }
}


/* =====================================================================================
 * 空节点恢复干净（noslot 模式，task-10：无光晕 / 无角标 / 运行不再被「素材位」拦）
 *   node tests/novai_dock_toolbar_shots.cjs noslot
 * 输出：tests/artifacts/dock-verify/after-no-slot/*.png + result-noslot.json
 * ===================================================================================== */
const NOSLOT_DIR = path.join(ROOT, 'after-no-slot');

/** 读空节点的「干净度」：有没有 is-slot / 角标 / 26px 光晕 / 空上传 dock / 选中态 */
async function probeSlotState(page) {
    return page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.node'));
        const bodies = nodes.map((n) => n.querySelector('.nbody')).filter(Boolean);
        const shadowOf = (el) => (el ? getComputedStyle(el).boxShadow : null);
        const selBodies = Array.from(document.querySelectorAll('.node.sel .nbody'));
        return {
            nodeCount: nodes.length,
            nodeClasses: nodes.map((n) => String(n.className || '')),
            slotSelectors: {
                isSlot: document.querySelectorAll('.is-slot').length,
                slotBadge: document.querySelectorAll('.slot-badge').length,
                dataSlot: document.querySelectorAll('[data-slot]').length,
            },
            slotTextHits: nodes.filter((n) => /在此填写|在此替换/.test(n.textContent || '')).map((n) => ({ cls: String(n.className || ''), text: (n.textContent || '').trim().slice(0, 60) })),
            dataSlotDetails: Array.from(document.querySelectorAll('[data-slot]')).slice(0, 12).map((el) => ({ tag: el.tagName, cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ''), slot: el.getAttribute('data-slot'), outer: (el.outerHTML || '').slice(0, 100) })),
            slotInsideNodes: document.querySelectorAll('.node [data-slot], .node[data-slot]').length,
            bodyShadows: bodies.map((b) => shadowOf(b)),
            bodyHalo26: bodies.some((b) => /26px/.test(shadowOf(b) || '')),
            ntbEmptyUpload: !!document.querySelector('#ntb.ntb-empty-upload'),
            ntbCount: document.querySelectorAll('#ntb').length,
            selIds: Array.from(document.querySelectorAll('.node.sel')).map((n) => n.getAttribute('data-id')),
            selBodyStyles: selBodies.map((b) => ({ shadow: getComputedStyle(b).boxShadow, borderTopWidth: getComputedStyle(b).borderTopWidth, outlineWidth: getComputedStyle(b).outlineWidth })),
            theme: (() => { const r = document.querySelector('.cn-root'); return r ? r.getAttribute('data-theme') : null; })(),
        };
    });
}

async function runNoSlot() {
    ensureDir(NOSLOT_DIR);
    const api = await request.newContext({ baseURL: H.BASE });
    let browser = null;
    const canvases = [];
    const out = { mode: 'noslot', generatedAt: new Date().toISOString(), base: H.BASE, build: buildFingerprint(), checks: [], shots: {}, data: {}, notes: {} };
    const record = (name, ok, detail) => {
        out.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? null : detail });
        console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
        return ok;
    };
    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) throw new Error('后端不可用：' + H.BASE);
        const realConfig = await health.json();
        // 给一个假图片模型：让「运行到此 / 一键运行」在这张空画布上真的能走进去（否则会被「没有可用模型」提前挡掉）
        const provider = { id: 'fake', name: 'Fake', base_url: 'http://127.0.0.1:9/v1', protocol: 'openai', enabled: true, primary: true, has_key: true, image_models: ['gpt-image-1'], chat_models: [], video_models: [], audio_models: [] };
        const config = Object.assign({}, realConfig, { api_providers: [provider], image_models: ['gpt-image-1'], image_model: 'gpt-image-1' });
        browser = await H.launchBrowser();

        const sceneOf = async (theme) => {
            const canvasId = await H.createCanvas(api, 'VERIFY-NOSLOT-' + theme + '-' + Date.now());
            canvases.push(canvasId);
            const mock = async (p) => {
                await p.route('**/api/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(config) }));
                if (theme === 'dark') await p.addInitScript(() => { try { localStorage.setItem('studio_theme', 'dark'); localStorage.setItem('openarc-canvas-theme', 'dark'); } catch (e) { /* 忽略 */ } });
            };
            const opened = await H.openCanvasPage(browser, canvasId, { beforeGoto: mock });
            const page = opened.page;
            page.setDefaultTimeout(8000);
            if (theme === 'light') await page.evaluate(() => { try { localStorage.removeItem('studio_theme'); localStorage.removeItem('openarc-canvas-theme'); } catch (e) { /* 忽略 */ } });
            await page.evaluate(() => { try { window.__cn.setUI({ agentOpen: false }); } catch (e) { /* 忽略 */ } });
            await page.waitForTimeout(400);
            const textId = await addNodeAtScreen(page, 'text', 380, 330, {});
            const imageId = await addNodeAtScreen(page, 'image', 760, 330, {});
            await page.waitForTimeout(900);
            await page.evaluate(() => window.__cn.setUI({ sel: new Set() }));
            await page.waitForTimeout(500);
            return { page: page, textId: textId, imageId: imageId, pageErrors: opened.pageErrors };
        };

        for (const theme of ['light', 'dark']) {
            const scene = await sceneOf(theme);
            const page = scene.page;
            const from = theme === 'light' ? 'light' : 'dark';
            // ---- 1) 干净度：没有 is-slot / 角标 / 26px 光晕 ----
            const idle = await probeSlotState(page);
            out.data[from + '.idle'] = idle;
            record(from.toUpperCase() + '1 两颗空节点都在（文本 + 图片）', idle.nodeCount >= 2, { nodeCount: idle.nodeCount, classes: idle.nodeClasses, theme: idle.theme });
            record(from.toUpperCase() + '2 节点里没有 .is-slot / .slot-badge / [data-slot]', idle.slotSelectors.isSlot === 0 && idle.slotSelectors.slotBadge === 0 && idle.slotInsideNodes === 0, Object.assign({}, idle.slotSelectors, { insideNodes: idle.slotInsideNodes, dataSlotDetails: idle.dataSlotDetails }));
            record(from.toUpperCase() + '3 节点里没有「在此填写 / 在此替换」文案', idle.slotTextHits.length === 0, idle.slotTextHits);
            record(from.toUpperCase() + '4 .nbody 的 box-shadow 不含 26px 光晕', !idle.bodyHalo26, { shadows: idle.bodyShadows });

            const textBox = await page.locator('.node[data-id="' + scene.textId + '"]').first().boundingBox({ timeout: 8000 }).catch(() => null);
            const imgBox = await page.locator('.node[data-id="' + scene.imageId + '"]').first().boundingBox({ timeout: 8000 }).catch(() => null);
            out.shots[from + 'Full'] = (await shotTo(page, NOSLOT_DIR, theme + '-01-noslot-fullpage', null, 0)).file;
            out.shots[from + 'Nodes'] = (await shotTo(page, NOSLOT_DIR, theme + '-02-noslot-nodes', [textBox, imgBox].filter(Boolean), 30)).file;

            // ---- 2) 对照：空图片节点选中后仍有单按钮「上传」dock（V2 玻璃）----
            await page.evaluate(({ id }) => window.__cn.setUI({ sel: new Set([id]) }), { id: scene.imageId });
            await page.waitForTimeout(700);
            await moveAway(page);
            await page.waitForTimeout(350);
            const withSel = await probeSlotState(page);
            out.data[from + '.selected'] = withSel;
            const uploadBar = await read(page, '#ntb');
            out.data[from + '.uploadBar'] = uploadBar;
            const uploadGlass = glassOf(uploadBar, theme === 'dark' ? GLASS.darkBase : GLASS.lightBase, theme === 'dark' ? GLASS.darkAlpha : GLASS.lightAlpha, theme === 'dark' ? GLASS.darkFog : GLASS.lightFog);
            out.data[from + '.uploadGlass'] = uploadGlass;
            record(from.toUpperCase() + '5 空图片选中 → #ntb.ntb-empty-upload 仍在', withSel.ntbEmptyUpload === true, { ntbCount: withSel.ntbCount, ntbClass: uploadBar && uploadBar.css ? uploadBar.css.backgroundColor : null });
            record(from.toUpperCase() + '6 该上传条是 V2 玻璃（半透明 + 白雾 + blur44）', uploadGlass.alphaOk && uploadGlass.baseOk && uploadGlass.veilOk && uploadGlass.backdropOk, { raw: uploadGlass.raw, backgroundImage: uploadGlass.backgroundImage, veilAlpha: uploadGlass.veilAlpha, backdropFilter: uploadGlass.backdropFilter });
            const selOk = withSel.selIds.length === 1 && withSel.selIds[0] === scene.imageId && (withSel.selBodyStyles[0] ? parseFloat(withSel.selBodyStyles[0].borderTopWidth) <= 2 : false);
            record(from.toUpperCase() + '7 节点选中态正常（.node.sel 只有这一颗，描边 ≤2px）', selOk, { selIds: withSel.selIds, styles: withSel.selBodyStyles });
            const dockBox = await page.locator('#ntb').first().boundingBox({ timeout: 8000 }).catch(() => null);
            out.shots[from + 'Upload'] = (await shotTo(page, NOSLOT_DIR, theme + '-03-empty-upload-dock', [dockBox].filter(Boolean), 40)).file;

            // ---- 3) 运行不再被「素材位」拦：右键「运行到此」 ----
            const nodeSel = '.node[data-id="' + scene.imageId + '"]';
            const selBefore = await page.evaluate(() => Array.from(window.__cn.state.ui.sel));
            await page.locator(nodeSel).first().click({ button: 'right' }).catch(() => null);
            await page.waitForTimeout(400);
            const runup = page.locator('[data-k="runup"]').first();
            const runupVisible = await runup.count();
            let runupDisabled = null;
            if (runupVisible) {
                runupDisabled = await runup.evaluate((el) => !!el.disabled).catch(() => null);
                await runup.click({ force: true }).catch(() => null);
            }
            await page.waitForTimeout(1500);
            const afterRunup = await page.evaluate(() => ({
                toasts: (window.__cn.state.toasts || []).map((t) => String(t.html || t.text || '')),
                sel: Array.from(window.__cn.state.ui.sel),
                selCount: document.querySelectorAll('.node.sel').length,
                slotBadges: document.querySelectorAll('.slot-badge').length,
            }));
            out.data[from + '.runup'] = { runupVisible: runupVisible, runupDisabled: runupDisabled, toasts: afterRunup.toasts, selBefore: selBefore, selAfter: afterRunup.sel };
            const toastText = (afterRunup.toasts || []).join(' | ');
            record(from.toUpperCase() + '8 「运行到此」不再弹「素材位没填」提示', toastText.indexOf('素材位') < 0, { toasts: afterRunup.toasts, runupVisible: runupVisible, runupDisabled: runupDisabled });
            record(from.toUpperCase() + '9 没有因素材位改选中（选中集合不变）', JSON.stringify(afterRunup.sel) === JSON.stringify(selBefore) && afterRunup.slotBadges === 0, { before: selBefore, after: afterRunup.sel, slotBadges: afterRunup.slotBadges });
            out.shots[from + 'Runup'] = (await shotTo(page, NOSLOT_DIR, theme + '-04-after-runup', null, 0)).file;

            // ---- 4) 一键运行（多选两颗空节点）也不被素材位拦 ----
            await page.evaluate(({ a, b }) => window.__cn.setUI({ sel: new Set([a, b]) }), { a: scene.textId, b: scene.imageId });
            await page.waitForTimeout(600);
            await moveAway(page);
            await page.waitForTimeout(300);
            const runBtn = page.locator('#multibar [data-mb="run"]').first();
            let multiRunOk = null;
            if (await runBtn.count()) {
                multiRunOk = await runBtn.evaluate((el) => !el.disabled).catch(() => null);
                if (multiRunOk) await runBtn.click({ force: true }).catch(() => null);
            }
            await page.waitForTimeout(1500);
            const multiToasts = await page.evaluate(() => (window.__cn.state.toasts || []).map((t) => String(t.html || t.text || '')));
            out.data[from + '.multiRun'] = { clicked: multiRunOk, toasts: multiToasts };
            record(from.toUpperCase() + '10 「一键运行」也不弹「素材位没填」提示', multiToasts.join(' | ').indexOf('素材位') < 0, { clicked: multiRunOk, toasts: multiToasts });

            out.data[from + '.pageErrors'] = scene.pageErrors;
        }

        // 汇总 + 对照
        const all = out.checks;
        out.failed = all.filter((c) => !c.ok).length;
        out.passed = out.failed === 0;
        out.notes.compare = '旧版（task-9 之前）：空节点带 is-slot 光晕 + 左上角「在此填写/在此替换」角标（见 tests/artifacts/dock-verify/after/dark-00-fullpage.png 顶部的「在此替换」）；新版：同样的空节点没有任何光晕与角标，只剩标题栏和空状态图标。';
        out.buildAtEnd = buildFingerprint();
        out.buildChangedDuringRun = out.build.css !== out.buildAtEnd.css || out.build.js !== out.buildAtEnd.js;
        fs.writeFileSync(path.join(NOSLOT_DIR, 'result-noslot.json'), JSON.stringify(out, null, 2));
        console.log('WRITE ' + path.join(NOSLOT_DIR, 'result-noslot.json'));
        console.log('[noslot] ' + (out.passed ? '全部 PASS' : out.failed + ' 条 FAIL') + ' / ' + all.length + ' 条');
    } finally {
        if (browser) await browser.close().catch(() => null);
        for (const id of canvases) { try { await H.deleteCanvas(api, id); } catch (err) { /* 忽略 */ } }
        await api.dispose();
    }
}

(async function () {
    if (MODE === 'variants') { await runVariants(); return; }
    if (MODE === 'noslot') { await runNoSlot(); return; }
    ensureDir(OUT);
    const c = H.checker('Dock 工具栏观感（' + MODE + '）');
    const api = await request.newContext({ baseURL: H.BASE });
    let canvasId = '';
    let browser = null;
    const geometry = { mode: MODE, base: H.BASE, capturedAt: new Date().toISOString(), shots: {}, notes: {}, bars: {}, checks: {}, contrast: {} };
    geometry.buildAtStart = buildFingerprint();
    const result = { mode: MODE, generatedAt: new Date().toISOString(), base: H.BASE, checks: [], groups: {} };
    const record = (group, name, ok, detail) => {
        const row = { group: group, name: name, ok: !!ok, detail: detail === undefined ? null : detail };
        result.checks.push(row);
        console.log((ok ? 'PASS  ' : 'FAIL  ') + '[' + group + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
        return row;
    };

    try {
        const health = await api.get('/api/config');
        if (health.status() !== 200) { c.check('后端 ' + H.BASE + ' 可用', false, { status: health.status() }); throw new Error('后端不可用：' + H.BASE); }
        canvasId = await H.createCanvas(api, 'VERIFY-DOCK-' + MODE + '-' + Date.now());
        const pngs = ['dock-a', 'dock-b', 'dock-c'].map((n, i) => seedPng(path.join(H.OUT_DIR, n + '.png'), [20, 90, 160][i]));
        browser = await H.launchBrowser();

        /* ===== 浅色主题 ===== */
        const light = await H.openCanvasPage(browser, canvasId);
        const page = light.page;
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(20000);
        geometry.pageErrors = light.pageErrors;
        const urls = ['/output/dock-a.png', '/output/dock-b.png', '/output/dock-c.png'];
        const ids = [];
        ids.push(await addImageAt(page, urls[0], 120, 200, 'Dock 验收图 A'));
        ids.push(await addImageAt(page, urls[1], 520, 200, 'Dock 验收图 B'));
        ids.push(await addImageAt(page, urls[2], 920, 200, 'Dock 验收图 C'));
        ids.push(await addImageAt(page, urls[1], 120, 540, 'Dock 验收图 D'));
        ids.push(await addImageAt(page, urls[2], 520, 540, 'Dock 验收图 E'));
        await page.waitForTimeout(900);
        geometry.ids = ids;
        geometry.shots.fullpageLight = await fullShot(page, '00-fullpage-light');

        const ntb = await captureNtb(page, 'light', geometry);
        geometry.bars.ntb = ntb;
        const ntbInv = await captureInvariants(page, '#ntb', 'light', geometry);
        const sweep = await captureSweep(page, 'light', geometry);
        const empty = await captureEmptyUpload(page, 'light', geometry);
        const edges = await captureEdges(page, 'light', ids[2], geometry);
        const disabled = await captureDisabled(page, 'light', geometry);
        const adorn = await captureAdornments(page, ids[0], 'light', geometry);

        // 折叠态 / 展开态的关键读数（两种模式都记录；after 里逐条断言）
        const b = ntb.collapsed, e = ntb.expanded, away = ntb.away;
        const hoveredBtn = e.buttons.find((x) => x.key === ntb.midKey);
        const others = e.buttons.filter((x) => x.key !== ntb.midKey);
        geometry.summaryLight = {
            collapsed: { bg: b.css.backgroundColor, radius: b.css.borderRadius, padding: b.css.padding, gap: b.css.gap, height: b.css.offsetHeight, border: b.css.borderWidth, buttons: b.buttons.map((x) => x.offsetW + 'x' + x.offsetH), expandedLabels: b.expandedLabelCount, labels: b.labelCount, cx: b.visual.cx },
            hover: { opened: e.opened, expandedLabels: e.expandedLabelCount, labels: e.labelCount, cx: e.visual.cx, hovered: hoveredBtn ? { key: hoveredBtn.key, offsetW: hoveredBtn.offsetW, label: hoveredBtn.label } : null, othersExpanded: others.filter((x) => x.label && parseFloat(x.label.maxWidth) > 0.5).map((x) => x.key), hl: { bg: e.hl.bg, opacity: e.hl.opacity, rect: e.hl.rect } },
            movedAway: { expandedLabels: away.expandedLabelCount, hlOpacity: away.hl.opacity, marginLeft: away.css.marginLeft, cx: away.visual.cx },
        };

        const mb = await captureMultibar(page, 'light', geometry);
        geometry.bars.multibar = mb;
        const mbInv = await captureInvariants(page, '#multibar', 'light', geometry);
        const gt = await captureGroupTools(page, 'light', geometry);
        geometry.bars.groupTools = gt;
        const st = await captureStackTools(page, 'light', geometry);
        geometry.bars.stackTools = st;
        geometry.glassEvidence = await captureGlassEvidenceScenes(api, browser, geometry);
        geometry.shots.fullpageLightFinal = await fullShot(page, '00b-fullpage-light-final');
        const narrow = await captureNarrow(browser, canvasId, 'light', geometry);
        geometry.narrowPageErrors = narrow.pageErrors;

        // 归一化一份 before/after 可直接对照的读数
        geometry.extra = {
            emptyUpload: empty && empty.exists ? {
                bg: empty.bar.css.backgroundColor,
                radius: empty.bar.css.borderRadius,
                height: empty.bar.css.offsetHeight,
                border: empty.bar.css.borderWidth,
                button: (empty.bar.innerButtons[0] || {}).offsetW + 'x' + (empty.bar.innerButtons[0] || {}).offsetH,
                buttonColor: (empty.bar.innerButtons[0] || {}).color,
                buttonText: (empty.bar.innerButtons[0] || {}).text,
                buttonRadius: (empty.bar.innerButtons[0] || {}).radius,
                padding: empty.bar.css.padding,
            } : { missing: true },
            narrow: narrow ? {
                bg: narrow.collapsed.css.backgroundColor,
                radius: narrow.collapsed.css.borderRadius,
                height: narrow.collapsed.css.offsetHeight,
                padding: narrow.collapsed.css.padding,
                buttons: narrow.collapsed.buttons.map((x) => x.offsetW + 'x' + x.offsetH),
                labelsExpanded: narrow.collapsed.expandedLabelCount,
                labelMaxWidths: narrow.collapsed.buttons.map((x) => (x.label ? x.label.maxWidth : null)),
                overflowX: narrow.collapsed.css.overflowX,
                scrollCollapsed: narrow.collapsed.css.scrollWidth + '/' + narrow.collapsed.css.clientWidth,
                scrollHover: narrow.expanded.css.scrollWidth + '/' + narrow.expanded.css.clientWidth,
                buttonsInsideClip: narrow.clip.allInside,
                clip: narrow.clip.clipRect,
            } : { missing: true },
            edges: {
                left: edges.left ? { overflowLeft: edges.left.overflowLeft, expandedLabels: edges.left.expandedLabelCount, marginLeft: edges.left.marginLeft, buttonsInside: edges.left.buttonsInsideViewport } : null,
                right: edges.right ? { overflowRight: edges.right.overflowRight, expandedLabels: edges.right.expandedLabelCount, marginLeft: edges.right.marginLeft, buttonsInside: edges.right.buttonsInsideViewport } : null,
            },
            invariants: {
                ntb: ntbInv.exists ? {
                    sizes: ntbInv.buttons.map((x) => x.offsetW + 'x' + x.offsetH),
                    iconDeltas: ntbInv.buttons.map((x) => x.iconDelta),
                    adornmentButtons: ntbInv.buttons.filter((x) => x.hasBgdot || x.hasTagmini).map((x) => ({ key: x.key, size: x.offsetW + 'x' + x.offsetH, iconDelta: x.iconDelta })),
                } : { missing: true },
                multibar: mbInv.exists ? { sizes: mbInv.buttons.map((x) => x.offsetW + 'x' + x.offsetH), iconDeltas: mbInv.buttons.map((x) => x.iconDelta) } : { missing: true },
                tagBar: adorn.tagBar.exists ? {
                    sizes: adorn.tagBar.buttons.map((x) => x.offsetW + 'x' + x.offsetH),
                    adornment: adorn.tagBar.buttons.filter((x) => x.hasTagmini).map((x) => ({ key: x.key, size: x.offsetW + 'x' + x.offsetH, iconDelta: x.iconDelta })),
                } : { missing: true },
                textBar: adorn.textBar.exists ? {
                    sizes: adorn.textBar.buttons.map((x) => x.offsetW + 'x' + x.offsetH),
                    adornment: adorn.textBar.buttons.filter((x) => x.hasBgdot).map((x) => ({ key: x.key, size: x.offsetW + 'x' + x.offsetH, iconDelta: x.iconDelta })),
                } : { missing: true },
            },
            disabled: disabled.exists ? {
                button: disabled.key,
                controlIsOpen: disabled.control.isOpen,
                controlLabelMaxWidth: disabled.control.target && disabled.control.target.label && disabled.control.target.label.maxWidth,
                disabledIsOpen: disabled.disabled.isOpen,
                disabledLabelMaxWidth: disabled.disabled.target && disabled.disabled.target.label && disabled.disabled.target.label.maxWidth,
                disabledLabelOpacity: disabled.disabled.target && disabled.disabled.target.label && disabled.disabled.target.label.opacity,
                disabledHlOpacity: disabled.disabled.hlOpacity,
                restoredIsOpen: disabled.restored.isOpen,
            } : { missing: true },
            sweep: sweep.exists ? {
                switchSeq: sweep.summary.switchSeq,
                switchCount: sweep.summary.switchCount,
                duplicateOpens: sweep.summary.duplicateOpens,
                maxOpenAtOnce: sweep.summary.maxOpenAtOnce,
                onAlways: sweep.summary.onAlways,
                zigzagFrames: sweep.summary.zigzagFrames.length,
                leftReversals: sweep.summary.leftReversals.length,
                leftFirst: sweep.summary.leftFirst,
                leftLast: sweep.summary.leftLast,
            } : { missing: true },
            skin: {
                ntb: { bg: b.css.backgroundColor, radius: b.css.borderRadius, height: b.css.offsetHeight, border: b.css.borderWidth, gap: b.css.gap, padding: b.css.padding, button: b.buttons[0] ? b.buttons[0].offsetW + 'x' + b.buttons[0].offsetH : null },
                multibar: mb.collapsed ? { bg: mb.collapsed.css.backgroundColor, radius: mb.collapsed.css.borderRadius, height: mb.collapsed.css.offsetHeight, button: mb.collapsed.buttons[0] ? mb.collapsed.buttons[0].offsetW + 'x' + mb.collapsed.buttons[0].offsetH : null } : null,
                groupTools: gt.exists ? { bg: gt.collapsed.css.backgroundColor, radius: gt.collapsed.css.borderRadius, height: gt.collapsed.css.offsetHeight } : null,
                stackTools: st.exists ? { bg: st.collapsed.css.backgroundColor, radius: st.collapsed.css.borderRadius, height: st.collapsed.css.offsetHeight } : null,
            },
            expand: {
                expandedLabelCount: e.expandedLabelCount,
                hoveredButtonWidth: hoveredBtn ? hoveredBtn.offsetW : null,
                hoveredLabel: hoveredBtn && hoveredBtn.label ? { fontSize: hoveredBtn.label.fontSize, fontWeight: hoveredBtn.label.fontWeight, color: hoveredBtn.label.color, opacity: hoveredBtn.label.opacity } : null,
                hlBg: e.hl.bg,
                hlInsetLeft: e.hl.rect && hoveredBtn ? Math.round((e.hl.rect.left - hoveredBtn.rect.left) * 100) / 100 : null,
                hlDeltaWidth: e.hl.rect && hoveredBtn ? Math.round((e.hl.rect.width - hoveredBtn.rect.width) * 100) / 100 : null,
                centerDelta: Math.round((e.visual.cx - b.visual.cx) * 100) / 100,
                afterMoveAway: { expandedLabelCount: away.expandedLabelCount, hlOpacity: away.hl.opacity, marginLeft: away.css.marginLeft },
            },
        };

        /* ===== 深色主题：localStorage studio_theme=dark 再加载 ===== */
        const dark = await H.openCanvasPage(browser, canvasId, {
            beforeGoto: async (p) => { await p.addInitScript(() => { try { localStorage.setItem('studio_theme', 'dark'); localStorage.setItem('novai-canvas-theme', 'dark'); } catch (err) { /* 忽略 */ } }); },
        });
        const dpage = dark.page;
        dpage.setDefaultTimeout(8000);
        dpage.setDefaultNavigationTimeout(20000);
        await dpage.waitForTimeout(600);
        const themeNow = await dpage.evaluate(() => { const r = document.querySelector('.cn-root'); return { attr: r ? r.getAttribute('data-theme') : null, studio: localStorage.getItem('studio_theme') }; });
        geometry.darkTheme = themeNow;
        const durl = '/output/dock-a.png';
        const did = await addImageAt(dpage, durl, 240, 260, '深色主题 Dock 图');
        await dpage.waitForTimeout(700);
        // 选中 → #ntb；先量深色下页面底色，再悬停
        await dpage.evaluate((id) => window.__cn.setUI({ sel: new Set([id]) }), did);
        await dpage.waitForTimeout(600);
        await moveAway(dpage);
        await dpage.waitForTimeout(400);
        const dCollapsed = await read(dpage, '#ntb');
        geometry['dark.ntb.collapsed'] = dCollapsed;
        const dbox0 = await dpage.locator('#ntb').first().boundingBox();
        geometry.shots.darkCollapsed = await shot(dpage, 'dark-01-ntb-collapsed', [dbox0], 40);
        geometry.shots.darkCollapsedFull = await fullShot(dpage, 'dark-01b-fullpage-collapsed');
        const dmid = await middleButton(dpage, '#ntb');
        const dmidSel = '#ntb [' + dmid.attr + '="' + dmid.key + '"]';
        const dhover = await hoverStable(dpage, dmidSel);
        await dpage.waitForTimeout(420);
        const dExpanded = await read(dpage, '#ntb');
        geometry['dark.ntb.hover'] = dExpanded;
        const dbox1 = await dpage.locator('#ntb').first().boundingBox();
        geometry.shots.darkHover = await shot(dpage, 'dark-02-ntb-hover-middle', [dbox0, dbox1], 40);
        geometry.shots.darkFull = await fullShot(dpage, 'dark-00-fullpage');

        // 像素级对比度：dock 底色 vs 它周围背景（深色下最怕和 #000 糊在一起）
        // shot() 出的是裁剪图，不能直接拿视口坐标取像素：这里统一用整页截图（1 视口 px = 1 图 px）
        try {
            const img = decodePng(geometry.shots.darkCollapsedFull);
            const bar = dCollapsed.visual;
            const inside = img.pixel(bar.left + bar.width / 2, bar.top + bar.height / 2);
            const leftBg = img.pixel(bar.left - 8, bar.top + bar.height / 2);
            const aboveBg = img.pixel(bar.left + bar.width / 2, bar.top - 8);
            geometry.contrast.dark = {
                inside: inside, leftBg: leftBg, aboveBg: aboveBg,
                ratioVsLeft: contrast(inside, leftBg), ratioVsAbove: contrast(inside, aboveBg),
                channelDelta: { left: [inside[0] - leftBg[0], inside[1] - leftBg[1], inside[2] - leftBg[2]] },
            };
            console.log('READ  dark contrast  ' + JSON.stringify(geometry.contrast.dark));
        } catch (err) {
            geometry.contrast.darkError = String(err && err.message || err);
            console.log('READ  dark contrast 解码失败：' + geometry.contrast.darkError);
        }
        // 滑块实际像素（浅色页）：白色 12% 叠在 17,17,17 上 ≈ (45,45,45)
        try {
            const imgL = decodePng(geometry.shots.lightHoverFull);
            const hl = e.hl.rect;
            geometry.contrast.hlPixel = imgL.pixel(hl.left + hl.width / 2, hl.top + hl.height / 2);
            geometry.contrast.dockPixel = imgL.pixel(e.visual.left + 4, e.visual.top + e.visual.height / 2);
            // 白色 12% 叠在 #111 上 ≈ (45,45,45)
            geometry.contrast.hlBlendExpect = [45, 45, 45];
            geometry.contrast.hlPixelDelta = geometry.contrast.hlPixel.slice(0, 3).map((v, i) => v - 45);
        } catch (err) {
            geometry.contrast.lightError = String(err && err.message || err);
        }
        geometry.darkPageErrors = dark.pageErrors;
        geometry.extra.dark = {
            theme: themeNow, bg: dCollapsed.css.backgroundColor, height: dCollapsed.css.offsetHeight, radius: dCollapsed.css.borderRadius,
            expandedLabelCount: dExpanded.expandedLabelCount,
            backdropFilter: dCollapsed.css.backdropFilter, webkitBackdropFilter: dCollapsed.css.webkitBackdropFilter,
            glass: glassOf(dCollapsed, GLASS.darkBase, GLASS.darkAlpha, GLASS.darkFog),
        };
        geometry.extra.glassLight = glassOf(ntb.collapsed, GLASS.lightBase, GLASS.lightAlpha, GLASS.lightFog);
        if (empty && empty.exists) geometry.extra.glassEmptyUpload = glassOf(empty.bar, GLASS.lightBase, GLASS.lightAlpha, GLASS.lightFog);

        /* ===== 断言（after 才判 PASS/FAIL；before 只记录读数） ===== */
        if (MODE === 'after') {
            const eq = (a, b) => String(a) === String(b);
            /* A. #ntb 容器 */
            const lightGlass = glassOf(b, GLASS.lightBase, GLASS.lightAlpha, GLASS.lightFog);
            record('A.#ntb容器', 'A1 底是半透明 color-mix(#111 74%) + 白 6% 雾层（alpha<1、基色 #111、background-image 带白雾渐变）', lightGlass.alphaOk && lightGlass.baseOk && lightGlass.veilOk, { raw: lightGlass.raw, alpha: lightGlass.alpha, base: lightGlass.base, backgroundImage: lightGlass.backgroundImage, veilAlpha: lightGlass.veilAlpha, theme: b.page.theme });
            record('A.#ntb容器', 'A2 border-radius = 14px', eq(b.css.borderRadius, DOCK.radius), { want: DOCK.radius, got: b.css.borderRadius });
            record('A.#ntb容器', 'A3 padding = 7px', eq(b.css.padding, DOCK.padding), { want: DOCK.padding, got: b.css.padding });
            record('A.#ntb容器', 'A4 gap = 4px', eq(b.css.gap, DOCK.gap), { want: DOCK.gap, got: b.css.gap });
            record('A.#ntb容器', 'A5 offsetHeight = 50', eq(b.css.offsetHeight, DOCK.height), { want: DOCK.height, got: b.css.offsetHeight });
            record('A.#ntb容器', 'A6 border-width 四边全 0', b.css.borderWidth.every((w) => parseFloat(w) === 0), { got: b.css.borderWidth });

            /* B. 折叠态按钮 */
            const sizes = b.buttons.map((x) => x.offsetW + 'x' + x.offsetH);
            record('B.折叠态按钮', 'B1 全部按钮 36×36', b.buttons.length > 0 && b.buttons.every((x) => x.offsetW === DOCK.button && x.offsetH === DOCK.button), { want: DOCK.button + 'x' + DOCK.button, got: sizes });
            record('B.折叠态按钮', 'B2 折叠态没有任何标签展开', b.expandedLabelCount === 0, { expandedLabelCount: b.expandedLabelCount, labelCount: b.labelCount });

            /* C. 悬停正中那颗 */
            // 不用 elementFromPoint 读指针（展开过程中几何会动，读到的 under 常是 null）：看悬停当场记录下来的 is-open 按钮
            const openKey = e.isOpenKey === undefined ? null : e.isOpenKey;
            const hoverOk = openKey === ntb.midKey;
            record('C.悬停正中间', 'C1 悬停后 is-open 的正是正中间那颗（' + ntb.midAttr + '=' + ntb.midKey + '）', hoverOk, { openKey: openKey, midKey: ntb.midKey, pointer: e.pointer });
            record('C.悬停正中间', 'C2 该按钮展开后宽度 > 36', !!hoveredBtn && hoveredBtn.offsetW > DOCK.button, { got: hoveredBtn && hoveredBtn.offsetW, width: hoveredBtn && hoveredBtn.rect.width });
            record('C.悬停正中间', 'C3 它自己的 .cn-fm-label opacity = 1', !!hoveredBtn && hoveredBtn.label && hoveredBtn.label.opacity === 1, { got: hoveredBtn && hoveredBtn.label });
            record('C.悬停正中间', 'C4 标签 font-size = 13px', !!hoveredBtn && hoveredBtn.label && hoveredBtn.label.fontSize === LABEL.fontSize, { want: LABEL.fontSize, got: hoveredBtn && hoveredBtn.label && hoveredBtn.label.fontSize });
            record('C.悬停正中间', 'C5 标签 font-weight = 500', !!hoveredBtn && hoveredBtn.label && hoveredBtn.label.fontWeight === LABEL.fontWeight, { want: LABEL.fontWeight, got: hoveredBtn && hoveredBtn.label && hoveredBtn.label.fontWeight });
            record('C.悬停正中间', 'C6 标签颜色近白', !!hoveredBtn && hoveredBtn.label && isNearWhite(hoveredBtn.label.color, 12), { got: hoveredBtn && hoveredBtn.label && hoveredBtn.label.color });
            const otherLabels = others.filter((x) => x.label);
            record('C.悬停正中间', 'C7 其它标签 max-width 全为 0', otherLabels.length > 0 && otherLabels.every((x) => parseFloat(x.label.maxWidth) === 0), { got: otherLabels.map((x) => x.key + ':' + x.label.maxWidth) });
            record('C.悬停正中间', 'C8 其它标签 opacity 全为 0', otherLabels.every((x) => x.label.opacity === 0), { got: otherLabels.map((x) => x.key + ':' + x.label.opacity) });
            record('C.悬停正中间', 'C9 只有一颗标签展开（expandedLabelCount = 1）', e.expandedLabelCount === 1, { expandedLabelCount: e.expandedLabelCount, labelCount: e.labelCount });

            /* D. 滑块 */
            const hlc = parseColor(e.hl.bg);
            const hlColorOk = !!hlc && hlc.r === 255 && hlc.g === 255 && hlc.b === 255 && Math.abs(hlc.a - DOCK.hlAlpha) <= 0.02;
            record('D.滑块', 'D1 .cn-fm-hl backgroundColor ≈ rgba(255,255,255,0.12)', hlColorOk, { want: 'rgba(255, 255, 255, 0.12)', got: e.hl.bg, parsed: hlc });
            record('D.滑块', 'D2 滑块 opacity = 1（悬停时可见）', e.hl.opacity === 1, { got: e.hl.opacity });
            const dLeft = hoveredBtn && e.hl.exists ? Math.round((e.hl.rect.left - hoveredBtn.rect.left) * 100) / 100 : null;
            const dWidth = hoveredBtn && e.hl.exists ? Math.round((e.hl.rect.width - hoveredBtn.rect.width) * 100) / 100 : null;
            record('D.滑块', 'D3 左边界与悬停按钮左边界差 ≤ 2px', dLeft !== null && Math.abs(dLeft) <= 2, { deltaLeft: dLeft, hlLeft: e.hl.rect && e.hl.rect.left, btnLeft: hoveredBtn && hoveredBtn.rect.left });
            record('D.滑块', 'D4 宽度与悬停按钮宽度差 ≤ 4px', dWidth !== null && Math.abs(dWidth) <= 4, { deltaWidth: dWidth, hlWidth: e.hl.rect && e.hl.rect.width, btnWidth: hoveredBtn && hoveredBtn.rect.width });
            record('D.滑块', 'D5 滑块高度不超出容器（≤ 容器高）', e.hl.rect && e.hl.rect.height <= e.visual.height + 0.5, { hlHeight: e.hl.rect && e.hl.rect.height, barHeight: e.visual.height });

            /* E. 视觉中心补偿 */
            const centerDelta = e.visual.cx - b.visual.cx;
            record('E.中心补偿', 'E1 #ntb 整条视觉中心展开前后偏移 ≤ 2px', Math.abs(centerDelta) <= 2, { collapsedCx: b.visual.cx, hoverCx: e.visual.cx, delta: Math.round(centerDelta * 100) / 100, marginLeft: e.css.marginLeft });
            const awayLabels = away.buttons.filter((x) => x.label);
            record('E.中心补偿', 'E2 移开指针 300ms 后所有标签 max-width 归 0', away.expandedLabelCount === 0 && awayLabels.every((x) => parseFloat(x.label.maxWidth) === 0), { expandedLabelCount: away.expandedLabelCount, got: awayLabels.map((x) => x.key + ':' + x.label.maxWidth) });
            record('E.中心补偿', 'E3 移开指针后滑块 opacity 归 0', away.hl.opacity === 0, { got: away.hl.opacity });
            record('E.中心补偿', 'E4 收起后 margin-left 补偿归零', !away.css.marginLeft || parseFloat(away.css.marginLeft) === 0, { got: away.css.marginLeft });

            /* F. 同一套皮肤 */
            const mbExpanded = mb.expanded;
            record('F.同一套皮肤', 'F1 #multibar 与 #ntb 同底色 / 同圆角 / 同高', sameSkin(b, mbExpanded).ok, sameSkin(b, mbExpanded).detail);
            if (gt.exists) record('F.同一套皮肤', 'F2 组工具条与 #ntb 同底色 / 同圆角 / 同高', sameSkin(b, gt.expanded).ok, sameSkin(b, gt.expanded).detail);
            else record('F.同一套皮肤', 'F2 组工具条与 #ntb 同底色 / 同圆角 / 同高', false, { skipped: '没做出组工具条' });
            if (st.exists) record('F.同一套皮肤', 'F3 堆叠工具条与 #ntb 同底色 / 同圆角 / 同高', sameSkin(b, st.expanded).ok, sameSkin(b, st.expanded).detail);
            else record('F.同一套皮肤', 'F3 堆叠工具条与 #ntb 同底色 / 同圆角 / 同高', false, { skipped: '没做出堆叠工具条' });

            /* G. 深色主题 */
            const darkBar = dCollapsed;
            record('G.深色主题', 'G1 studio_theme=dark 后 data-theme = dark', themeNow.attr === 'dark' && themeNow.studio === 'dark', themeNow);
            const darkGlass = glassOf(darkBar, GLASS.darkBase, GLASS.darkAlpha, GLASS.darkFog);
            record('G.深色主题', 'G2 玻璃基色：浅主题 #111 / 深主题 #1c1c1e（合成后的 paint 色，alpha 见 G6）', lightGlass.baseOk && darkGlass.baseOk, { light: lightGlass.base, dark: darkGlass.base, lightRaw: lightGlass.raw, darkRaw: darkGlass.raw });
            // 对比度用 computed style 判：dock 底色 vs .cn-root 底色逐通道差（截图取样点不可靠，只留图肉眼确认）
            // 半透明底按半透明底算：把 dock 的基色按 alpha 合成到 .cn-root 底色上，再比通道差
            const rootRgb = parseColor(darkBar.page.rootBg);
            const darkComposited = darkGlass.parsed && rootRgb
                ? compositeOver(darkGlass.parsed, [rootRgb.r, rootRgb.g, rootRgb.b]).map((c) => Math.round(GLASS.darkFog * 255 + (1 - GLASS.darkFog) * c))
                : null;
            const darkDelta = darkComposited && rootRgb ? Math.max(Math.abs(darkComposited[0] - rootRgb.r), Math.abs(darkComposited[1] - rootRgb.g), Math.abs(darkComposited[2] - rootRgb.b)) : null;
            record('G.深色主题', 'G3 深色下 dock 合成底色与 .cn-root 底色逐通道差 ≥ 8（不糊在黑底里）', darkDelta !== null && darkDelta >= 8, { dockRaw: darkBar.css.backgroundColor, dockComposited: darkComposited, root: darkBar.page.rootBg, maxChannelDelta: darkDelta, bodyBg: darkBar.page.bodyBg });
            record('G.深色主题', 'G4 深色下悬停：该颗展开、其余收起', (() => { const hb = dExpanded.buttons.find((x) => x.key === dmid.key); return dExpanded.expandedLabelCount === 1 && !!hb && hb.offsetW > DOCK.button; })(), { expandedLabelCount: dExpanded.expandedLabelCount, hoveredW: dExpanded.buttons.find((x) => x.key === dmid.key) && dExpanded.buttons.find((x) => x.key === dmid.key).offsetW });

            /* G. 玻璃质感（backdrop-filter / alpha / 可读性） */
            record('G.深色主题', 'G5 backdrop-filter 仍含 blur(44px) + saturate(190%)（浅/深都查，-webkit- 也查）', lightGlass.backdropOk && darkGlass.backdropOk, {
                light: { backdropFilter: lightGlass.backdropFilter, webkit: lightGlass.webkitBackdropFilter, blurOk: lightGlass.blurOk, saturateOk: lightGlass.saturateOk },
                dark: { backdropFilter: darkGlass.backdropFilter, webkit: darkGlass.webkitBackdropFilter, blurOk: darkGlass.blurOk, saturateOk: darkGlass.saturateOk },
            });
            record('G.深色主题', 'G6 V2 定稿：底 alpha 浅 0.74 / 深 0.80（±0.02），白雾层 6% / 4%（±1.5%）',
                lightGlass.alphaOk && darkGlass.alphaOk
                && Math.abs(lightGlass.alpha - GLASS.lightAlpha) <= GLASS.alphaTol && Math.abs(darkGlass.alpha - GLASS.darkAlpha) <= GLASS.alphaTol
                && lightGlass.veilOk && darkGlass.veilOk
                && Math.abs((lightGlass.veilAlpha || 0) - GLASS.lightFog) <= 0.015 && Math.abs((darkGlass.veilAlpha || 0) - GLASS.darkFog) <= 0.015, {
                light: { raw: lightGlass.raw, alpha: lightGlass.alpha, wantAlpha: GLASS.lightAlpha, backgroundImage: lightGlass.backgroundImage, veilAlpha: lightGlass.veilAlpha, wantVeil: GLASS.lightFog },
                dark: { raw: darkGlass.raw, alpha: darkGlass.alpha, wantAlpha: GLASS.darkAlpha, backgroundImage: darkGlass.backgroundImage, veilAlpha: darkGlass.veilAlpha, wantVeil: GLASS.darkFog },
            });
            const readabilityOk = (list) => !!list && list.every((x) => x.whiteTextContrast >= GLASS.textContrast && x.whiteIconContrast >= GLASS.iconContrast);
            // 压在画布上的实测像素（专用证据画布，取样点 = 按钮缝中间）应与 variants V2 的 rgb(86,86,87) 对齐
            const gridPixel = geometry.contrast['light.glassGridPixel'] || null;
            const onCanvasOk = !!gridPixel && gridPixel.every((c, i) => Math.abs(c - GLASS.lightOnCanvas[i]) <= GLASS.onCanvasTol);
            record('G.深色主题', 'G7 可读性：白字 ≥4.5、白图标 ≥3（合成到 白画布 / 纯黑 / 亮图 上），且压画布实测 ≈ rgb(86,86,87)',
                readabilityOk(lightGlass.readability) && readabilityOk(darkGlass.readability) && onCanvasOk, {
                lightOverWhitePixel: gridPixel,
                wantOnCanvas: GLASS.lightOnCanvas,
                mathOverWhite: lightGlass.overWhite,
                light: lightGlass.readability,
                dark: darkGlass.readability,
                thresholds: { text: GLASS.textContrast, icon: GLASS.iconContrast },
            });

            /* H. 空图片节点的单颗「上传」条 */
            if (empty.exists) {
                const eb = empty.bar;
                const ib = eb.innerButtons[0] || {};
                record('H.空图片上传条', 'H1 #ntb.ntb-empty-upload 存在（单颗上传条）', true, { buttonText: ib.text, buttonClass: ib.className });
                const emptyGlass = glassOf(eb, GLASS.lightBase, GLASS.lightAlpha, GLASS.lightFog);
                record('H.空图片上传条', 'H2 同样是 V2 磨砂玻璃底（74% 底 + 6% 白雾 + blur(44px) saturate(190%)）', emptyGlass.alphaOk && emptyGlass.baseOk && emptyGlass.backdropOk && emptyGlass.veilOk, { raw: emptyGlass.raw, alpha: emptyGlass.alpha, base: emptyGlass.base, backgroundImage: emptyGlass.backgroundImage, veilAlpha: emptyGlass.veilAlpha, backdropFilter: emptyGlass.backdropFilter, webkit: emptyGlass.webkitBackdropFilter });
                record('H.空图片上传条', 'H3 圆角 14px', eq(eb.css.borderRadius, DOCK.radius), { want: DOCK.radius, got: eb.css.borderRadius });
                record('H.空图片上传条', 'H4 offsetHeight = 50', eq(eb.css.offsetHeight, DOCK.height), { want: DOCK.height, got: eb.css.offsetHeight });
                record('H.空图片上传条', 'H5 内部按钮高 36', ib.offsetH === DOCK.button, { want: DOCK.button, got: ib.offsetH, w: ib.offsetW });
                record('H.空图片上传条', 'H6 按钮文字近白', isNearWhite(ib.color, 12), { got: ib.color });
                record('H.空图片上传条', 'H7 border-width 四边全 0', eb.css.borderWidth.every((w) => parseFloat(w) === 0), { got: eb.css.borderWidth });
            } else {
                record('H.空图片上传条', 'H1 #ntb.ntb-empty-upload 存在（单颗上传条）', false, { skipped: geometry['light.emptyUpload.skip'] || empty });
            }

            /* I. ≤760px 视口 */
            if (narrow) {
                const nc = narrow.collapsed, nh = narrow.expanded;
                record('I.窄视口700', 'I1 按钮 32×32', nc.buttons.length > 0 && nc.buttons.every((x) => x.offsetW === 32 && x.offsetH === 32), { want: '32x32', got: nc.buttons.map((x) => x.offsetW + 'x' + x.offsetH) });
                record('I.窄视口700', 'I2 容器 padding = 6px', /^6px( 6px){0,3}$/.test(String(nc.css.padding).trim()), { want: '6px', got: nc.css.padding });
                record('I.窄视口700', 'I3 只显图标：.cn-fm-label display = none', nc.buttons.every((x) => !x.label || x.label.display === 'none'), { got: nc.buttons.map((x) => x.key + ':' + (x.label ? x.label.display : '-')) });
                record('I.窄视口700', 'I3b 标签 max-width 也都是 0', nc.buttons.every((x) => !x.label || parseFloat(x.label.maxWidth) === 0), { got: nc.buttons.map((x) => x.key + ':' + (x.label ? x.label.maxWidth : '-')) });
                record('I.窄视口700', 'I4 折叠态不横向滚动（scrollWidth ≤ clientWidth）', nc.css.scrollWidth <= nc.css.clientWidth + 1, { scrollWidth: nc.css.scrollWidth, clientWidth: nc.css.clientWidth, overflowX: nc.css.overflowX });
                record('I.窄视口700', 'I5 按钮都在条内（圆角不被截断）', narrow.clip.allInside, narrow.clip);
                record('I.窄视口700', 'I6 悬停后也不溢出（scrollWidth ≤ clientWidth）', nh.css.scrollWidth <= nh.css.clientWidth + 1, { scrollWidth: nh.css.scrollWidth, clientWidth: nh.css.clientWidth });
                record('I.窄视口700', 'I7 条宽 < 视口宽 - 16（700-16=684）', nc.visual.width < 684, { barWidth: nc.visual.width, viewport: 700 });
            } else {
                record('I.窄视口700', 'I1 按钮 32×32', false, { skipped: '窄视口场景没跑起来' });
            }

            /* J. 节点贴左右边缘 */
            const edgeLeft = edges.left, edgeRight = edges.right;
            record('J.边缘', 'J1 贴左边缘悬停展开：左溢出 = 0', !!edgeLeft && edgeLeft.overflowLeft === 0, edgeLeft ? { overflowLeft: edgeLeft.overflowLeft, bar: edgeLeft.bar, vp: edgeLeft.vp, marginLeft: edgeLeft.marginLeft } : null);
            record('J.边缘', 'J2 贴右边缘悬停展开：右溢出 = 0', !!edgeRight && edgeRight.overflowRight === 0, edgeRight ? { overflowRight: edgeRight.overflowRight, bar: edgeRight.bar, vp: edgeRight.vp, marginLeft: edgeRight.marginLeft } : null);
            record('J.边缘', 'J3 边缘处展开后仍只有悬停那颗长出来', !!edgeLeft && edgeLeft.expandedLabelCount === 1 && !!edgeRight && edgeRight.expandedLabelCount === 1, { left: edgeLeft && edgeLeft.expandedLabelCount, right: edgeRight && edgeRight.expandedLabelCount });
            record('J.边缘', 'J4 边缘处所有按钮都落在视口内', !!edgeLeft && edgeLeft.buttonsInsideViewport && !!edgeRight && edgeRight.buttonsInsideViewport, { left: edgeLeft && edgeLeft.buttonsInsideViewport, right: edgeRight && edgeRight.buttonsInsideViewport });

            /* K. 折叠态几何不变量 */
            [
                { name: '#ntb', data: ntbInv },
                { name: '#multibar', data: mbInv },
                { name: '#ntb 图片条（开了颜色标记 tagmini）', data: adorn.tagBar },
                { name: '#ntb 文本条（背景色 bgdot）', data: adorn.textBar },
            ].forEach((item) => {
                if (!item.data.exists) { record('K.折叠态几何', 'K1 ' + item.name + ' 每颗按钮 36.000×36.000', false, { skipped: '没读到按钮' }); return; }
                const btns = item.data.buttons;
                const bad = btns.filter((x) => x.offsetW !== DOCK.button || x.offsetH !== DOCK.button).map((x) => ({ key: x.key, size: x.offsetW + 'x' + x.offsetH, bgdot: x.hasBgdot, tagmini: x.hasTagmini }));
                record('K.折叠态几何', 'K1 ' + item.name + ' 每颗按钮 36.000×36.000（含小标按钮）', btns.length > 0 && bad.length === 0, { total: btns.length, bad: bad });
                // bgdot（palette 图标 + 当前色点）是复合控件：折叠态按「整组居中」验收（lead 已拍板），其余按图标中心
                const centering = btns.map((x) => {
                    const mode = x.hasBgdot && x.groupDelta ? 'group' : 'icon';
                    const delta = mode === 'group' ? x.groupDelta : x.iconDelta;
                    return { key: x.key, mode: mode, delta: delta, iconDeltaX: x.iconDelta ? x.iconDelta.x : null };
                });
                const deltas = centering.filter((x) => x.delta).map((x) => x.delta);
                const maxX = deltas.length ? Math.max.apply(null, deltas.map((d) => Math.abs(d.x))) : null;
                const maxY = deltas.length ? Math.max.apply(null, deltas.map((d) => Math.abs(d.y))) : null;
                record('K.折叠态几何', 'K2 ' + item.name + ' 图标中心与按钮中心偏差 ≤0.5px（bgdot 那颗按「图标+色点整组」）', deltas.length > 0 && maxX <= 0.5 && maxY <= 0.5, { maxDeltaX: maxX, maxDeltaY: maxY, centering: centering });
            });
            const tagBtns = adorn.tagBar.exists ? adorn.tagBar.buttons.filter((x) => x.hasTagmini) : [];
            const bgdBtns = adorn.textBar.exists ? adorn.textBar.buttons.filter((x) => x.hasBgdot) : [];
            const adornsAll = tagBtns.concat(bgdBtns);
            const adornOk = adornsAll.every((x) => {
                if (x.offsetW !== DOCK.button || x.offsetH !== DOCK.button) return false;
                const delta = x.hasBgdot && x.groupDelta ? x.groupDelta : x.iconDelta;
                return !!delta && Math.abs(delta.x) <= 0.5 && Math.abs(delta.y) <= 0.5;
            });
            record('K.折叠态几何', 'K3 带小标的两颗也是 36x36 且居中（图片条 tagmini 按图标 / 文本条 bgdot 按整组）', adornsAll.length >= 2 && adornOk, { got: adornsAll.map((x) => ({ key: x.key, size: x.offsetW + 'x' + x.offsetH, iconDelta: x.iconDelta, groupDelta: x.groupDelta, judge: x.hasBgdot ? 'group' : 'icon', bgdot: x.hasBgdot, tagmini: x.hasTagmini })) });

            /* L. 禁用按钮 */
            if (disabled.exists) {
                const ctl = disabled.control, off = disabled.disabled, back = disabled.restored;
                record('L.禁用按钮', 'L1 对照组：同一颗按钮（' + disabled.key + '）正常悬停会展开', !!ctl && ctl.isOpen === true && !!ctl.target && !!ctl.target.label && parseFloat(ctl.target.label.maxWidth) > 0, { control: ctl && { isOpen: ctl.isOpen, maxWidth: ctl.target && ctl.target.label && ctl.target.label.maxWidth } });
                record('L.禁用按钮', 'L2 置 disabled=true 后悬停，不挂 is-open', !!off && off.isOpen === false, { key: disabled.key, isOpen: off && off.isOpen, stillDisabled: disabled.stillDisabled });
                record('L.禁用按钮', 'L3 禁用态标签 max-width = 0 且 opacity = 0', !!off && !!off.target && !!off.target.label && parseFloat(off.target.label.maxWidth) === 0 && off.target.label.opacity === 0, { got: off && off.target && off.target.label });
                record('L.禁用按钮', 'L4 禁用态滑块 opacity = 0（不亮底）', !!off && off.hlOpacity === 0, { got: off && off.hlOpacity });
                record('L.禁用按钮', 'L5 复位 disabled=false 后同一颗重新展开（证明 L2-L4 测的是 disabled 分支）', !!back && back.isOpen === true && !!back.target && !!back.target.label && parseFloat(back.target.label.maxWidth) > 0, { restored: back && { isOpen: back.isOpen, maxWidth: back.target && back.target.label && back.target.label.maxWidth } });
            } else {
                record('L.禁用按钮', 'L1 对照组：同一颗按钮正常悬停会展开', false, { skipped: (geometry['light.disabled'] || {}).reason || null });
            }

            /* M. 横向扫掠稳定性 */
            if (sweep.exists) {
                const sw = sweep.summary;
                record('M.扫掠', 'M1 每颗按钮最多成为 is-open 一次（无来回抖）', sw.duplicateOpens.length === 0, { switchSeq: sw.switchSeq, duplicateOpens: sw.duplicateOpens, switchCount: sw.switchCount });
                record('M.扫掠', 'M2 全程 #ntb 不消失（.cn-fm.on 恒为 true）', sw.onAlways, { samples: sw.samples, onAlways: sw.onAlways });
                record('M.扫掠', 'M3 任意时刻最多只有 1 颗 is-open', sw.maxOpenAtOnce <= 1, { maxOpenAtOnce: sw.maxOpenAtOnce });
                record('M.扫掠', 'M4 无锯齿抖动（连续帧 left 方向反转 0 次）', sw.zigzagFrames.length === 0, { zigzagFrames: sw.zigzagFrames, leftReversals: sw.leftReversals });
            } else {
                record('M.扫掠', 'M1 每颗按钮最多成为 is-open 一次（无来回抖）', false, { skipped: '扫掠没跑起来' });
            }

            /* P. 背景渗透（和 variants V2 的读数对账） */
            const pix = (k) => (geometry.contrast[k] ? geometry.contrast[k].slice(0, 3) : null);
            const deltaOf = (over, grid) => (over && grid) ? [0, 1, 2].map((i) => over[i] - grid[i]) : null;
            const penLight = deltaOf(pix('light.glassOverImagePixel'), pix('light.glassGridPixel'));
            const penDark = deltaOf(pix('dark.glassOverImagePixel'), pix('dark.glassGridPixel'));
            let wantLight = [-23, -25, -2];
            let wantDark = [23, 21, 40];
            try {
                const vjPath = path.join(ROOT, 'variants', 'variants.json');
                if (fs.existsSync(vjPath)) {
                    const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
                    if (vj.variants && vj.variants.v2) {
                        wantLight = vj.variants.v2.penetrationLight || wantLight;
                        wantDark = vj.variants.v2.penetrationDark || wantDark;
                    }
                }
            } catch (err) { /* 没有 variants 读数就用常量 */ }
            const near = (got, want) => !!got && got.every((v, i) => Math.abs(v - want[i]) <= GLASS.penetrationTol);
            record('P.渗透', 'P1 浅色：dock 压彩图 vs 压点阵的内部差（渗透）≈ variants V2 读数（±14）', near(penLight, wantLight), { got: penLight, want: wantLight, tolerance: GLASS.penetrationTol, pixels: { grid: pix('light.glassGridPixel'), overImage: pix('light.glassOverImagePixel') } });
            record('P.渗透', 'P2 深色：dock 压彩图 vs 压黑画布的内部差（渗透）≈ variants V2 读数（±14）', near(penDark, wantDark), { got: penDark, want: wantDark, tolerance: GLASS.penetrationTol, pixels: { grid: pix('dark.glassGridPixel'), overImage: pix('dark.glassOverImagePixel') } });
            geometry.extra.glassPenetration = { light: penLight, dark: penDark, wantLight: wantLight, wantDark: wantDark };
        } else {
            result.checks.push({ group: 'before', name: '基线读数（旧观感，不判 PASS/FAIL）', ok: null, detail: geometry.summaryLight });
        }

        // 数值对照：before（旧玻璃胶囊）→ after，以及 after-solid（实底 dock）→ after-glass（磨砂玻璃 dock）
        try {
            const flatten = (obj, prefix, out) => {
                for (const key of Object.keys(obj || {})) {
                    const value = obj[key];
                    const full = prefix ? prefix + '.' + key : key;
                    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
                    else out[full] = value;
                }
                return out;
            };
            const aflat = flatten(geometry.extra || {}, '', {});
            const buildSection = (title, leftLabel, rightLabel, leftGeo) => {
                const lflat = flatten(leftGeo.extra || {}, '', {});
                const keys = Array.from(new Set(Object.keys(lflat).concat(Object.keys(aflat))));
                const rows = keys.map((key) => ({
                    metric: key,
                    left: lflat[key] === undefined ? null : lflat[key],
                    right: aflat[key] === undefined ? null : aflat[key],
                    changed: JSON.stringify(lflat[key]) !== JSON.stringify(aflat[key]),
                }));
                const groups = {};
                rows.forEach((row) => { const g = row.metric.split('.')[0]; (groups[g] = groups[g] || []).push(row); });
                const md = ['## ' + title, ''];
                for (const g of Object.keys(groups)) {
                    md.push('### ' + g, '', '| 读数 | ' + leftLabel + ' | ' + rightLabel + ' | 变化 |', '| --- | --- | --- | --- |');
                    groups[g].forEach((row) => md.push('| ' + row.metric.split('.').slice(1).join('.') + ' | ' + JSON.stringify(row.left) + ' | ' + JSON.stringify(row.right) + ' | ' + (row.changed ? '改' : '—') + ' |'));
                    md.push('');
                }
                return { rows: rows, md: md };
            };
            const md = [
                '# 工具栏 Dock 改造 · 数值对照（before → solid → glass）',
                '',
                '生成时间：' + new Date().toISOString(),
                '',
                '被测构建：' + JSON.stringify(geometry.buildAtStart),
                '',
                '说明：',
                '',
                '- 「背景色」按钮 = palette 图标 + 当前色点（bgdot）复合控件。折叠态按「图标 + 色点整组居中」验收：图标本身偏左 7.5px 是刻意取舍（色点表示节点当前底色，挪成角标展开态会跑到标签右端、隐藏又丢状态），lead 已批准。',
                '- 「标记」按钮的 tagmini 是绝对定位角标，不占布局，仍按图标中心验收（实测 0.00px）。',
                '- 玻璃版定稿 V2：background = linear-gradient(白 6%/4% 雾层) + color-mix(浅 #111 @0.74 / 深 #1c1c1e @0.80)，backdrop-filter blur(44px) saturate(190%)；几何/交互与实底版完全一致。',
                '- 留档：实底版在 after-solid/ + result-solid.json；V1 玻璃（78%/82%，无雾层）在 after-v1/ + result-v1.json；V2 玻璃在 after/ + result.json。',
                '',
            ];
            const beforePath = path.join(ROOT, 'before', 'geometry.json');
            if (fs.existsSync(beforePath)) {
                const section = buildSection('before（旧玻璃胶囊 38 高 / 9999 圆角 / 整条展开）→ after', 'before（旧）', 'after（测）', JSON.parse(fs.readFileSync(beforePath, 'utf8')));
                result.comparison = section.rows;
                md.push(...section.md);
            }
            const solidPath = path.join(ROOT, 'after-solid', 'geometry.json');
            if (fs.existsSync(solidPath)) {
                const section = buildSection('after-solid（实底 #111）→ after（玻璃定稿 V2）', 'solid（实底）', 'V2（磨砂玻璃）', JSON.parse(fs.readFileSync(solidPath, 'utf8')));
                result.comparisonSolidGlass = section.rows;
                md.push(...section.md);
            }
            const v1Path = path.join(ROOT, 'after-v1', 'geometry.json');
            if (fs.existsSync(v1Path)) {
                const section = buildSection('after-v1（玻璃 78%/82%，无雾层）→ after（玻璃定稿 V2 74%/80% + 白雾）', 'V1（78%，无雾）', 'V2（74% + 雾）', JSON.parse(fs.readFileSync(v1Path, 'utf8')));
                result.comparisonV1V2 = section.rows;
                md.push(...section.md);
            }
            md.push('## 数据可信度', '');
            md.push('- after：构建指纹前后一致（buildChangedDuringRun=' + geometry.buildChangedDuringRun + '），全部截图 + 断言出自同一版产物。');
            md.push('- before：主场景（#ntb / #multibar / 组工具条 / 堆叠工具条 / 深色）来自旧构建快照（/tmp/openarc-canvas-before-snapshot）；before 的「窄视口 700」段当时撞上构建切换，读到的是中间版，不能当旧基线。');
            md.push('');
            if (MODE === 'after') {
                fs.writeFileSync(path.join(ROOT, 'comparison' + SUFFIX + '.md'), md.join('\n'));
                console.log('WRITE ' + path.join(ROOT, 'comparison' + SUFFIX + '.md') + '（before→after ' + (result.comparison || []).length + ' 条 / solid→glass ' + (result.comparisonSolidGlass || []).length + ' 条）');
            }
        } catch (err) {
            console.log('READ  数值对照表失败：' + String(err && err.message || err));
            result.comparisonError = String(err && err.message || err);
        }

        c.check('页面无 JS 异常', light.pageErrors.length === 0, light.pageErrors.slice(0, 5));
        c.check('深色页面无 JS 异常', dark.pageErrors.length === 0, dark.pageErrors.slice(0, 5));
    } catch (error) {
        c.check('脚本执行未抛异常', false, String(error && error.stack || error));
        result.error = String(error && error.stack || error);
    } finally {
        if (browser) await browser.close().catch(() => null);
        await H.deleteCanvas(api, canvasId);
        await api.dispose();
        const summary = c.finish();
        geometry.buildAtEnd = buildFingerprint();
        // 只按构建产物（css / js 的 sha256）判「构建是否动了」；canvas.html 的 ?v= 是缓存串，
        // 并行会话可能只改它而产物不变，单独记成 htmlVersionChanged，不算产物变更。
        geometry.buildChangedDuringRun = geometry.buildAtStart.css !== geometry.buildAtEnd.css || geometry.buildAtStart.js !== geometry.buildAtEnd.js;
        geometry.htmlVersionChanged = geometry.buildAtStart.canvasHtmlVersion !== geometry.buildAtEnd.canvasHtmlVersion;
        if (geometry.buildChangedDuringRun) {
            geometry.notes.buildChangedDuringRun = '构建产物在本次运行过程中被替换：早期截图来自 ' + JSON.stringify(geometry.buildAtStart) + '，后期来自 ' + JSON.stringify(geometry.buildAtEnd);
            console.log('WARN  构建产物在本次运行中途被替换（早期场景可能来自上一版）');
        }
        if (geometry.htmlVersionChanged) {
            geometry.notes.htmlVersionChanged = 'canvas.html 的 ?v= 在运行中被并行会话改写：' + geometry.buildAtStart.canvasHtmlVersion + ' → ' + geometry.buildAtEnd.canvasHtmlVersion + '（css/js sha256 未变：' + geometry.buildAtStart.css + ' / ' + geometry.buildAtStart.js + '）';
            console.log('WARN  canvas.html 的 ?v= 中途变了（css/js 未变）');
        }
        geometry.shots = Object.assign({}, SHOTS, geometry.shots);
        geometry.checks = summary.checks;
        geometry.failures = summary.failures;
        ensureDir(OUT);
        fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify(geometry, null, 2));
        result.geometry = geometry;
        result.failed = result.checks.filter((x) => x.ok === false).length;
        result.passed = result.failed === 0;
        result.failures = result.checks.filter((x) => x.ok === false);
        result.shots = geometry.shots;
        result.contrast = geometry.contrast;
        result.notes = geometry.notes;
        result.bgdotGroupCentering = '背景色按钮（palette 图标 + bgdot）折叠态按整组居中验收，图标本身偏左 7.5px 为刻意取舍（lead 已批准）；tagmini 角标不占布局，按图标中心验收。';
        if (MODE === 'after' && !SUFFIX) fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(result, null, 2));
        const lines = result.checks.map((x) => '[' + (x.ok === null ? 'READ' : x.ok ? 'PASS' : 'FAIL') + '] ' + x.group + ' · ' + x.name + (x.ok === false ? '  ' + JSON.stringify(x.detail) : ''));
        fs.writeFileSync(path.join(OUT, 'checks.txt'), lines.join('\n') + '\n');
        console.log('');
        console.log(MODE === 'after'
            ? '[dock] ' + (result.failed ? result.failed + ' 条 FAIL' : '全部 PASS')
            : '[dock] before 基线已记录 → ' + path.relative(path.join(__dirname, '..'), OUT) + (summary.failed ? '（脚本自检 ' + summary.failed + ' 条失败）' : ''));
        process.exit(result.failed || summary.failed ? 1 : 0);
    }
})();
