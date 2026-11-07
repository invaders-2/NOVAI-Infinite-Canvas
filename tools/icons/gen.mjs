#!/usr/bin/env node
// 生成图标 canonical：业务名 → lucide 官方路径。
// 用法：node tools/icons/gen.mjs（可重复运行，输出稳定）
// 产出：tools/icons/canonical.json + web/src/lib/icons.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const LUCIDE_PKG = path.join(ROOT, 'novai-canvas-ui/node_modules/lucide-react');
const LUCIDE_DIR = path.join(LUCIDE_PKG, 'dist/esm/icons');
const OUT_JSON = path.join(HERE, 'canonical.json');
const OUT_JS = path.join(ROOT, 'web/src/lib/icons.js');

// 业务名 → lucide kebab 名：现有 ICONS 全部 key + 原三份 EXTRA 合并后的 key
const MAP = {
    alert: 'circle-alert',
    arrow: 'arrow-right',
    arrowdown: 'arrow-down',
    arrowdr: 'arrow-down-right',
    arrowl: 'arrow-left',
    arrowr: 'arrow-right',
    arrowup: 'arrow-up',
    back: 'arrow-left',
    badge: 'badge-check',
    bag: 'shopping-bag',
    bg: 'image',
    bolt: 'zap',
    book: 'book',
    box: 'box',
    brain: 'brain',
    brush: 'paintbrush',
    bulb: 'lightbulb',
    canvas: 'layout-dashboard',
    chat: 'message-circle',
    check: 'check',
    chev: 'chevron-down',
    chevr: 'chevron-right',
    chevl: 'chevron-left',
    chevu: 'chevron-up',
    circle: 'circle',
    clip: 'paperclip',
    clip2: 'paperclip',
    clock: 'clock',
    close: 'x',
    cloud: 'cloud',
    cloudown: 'cloud-download',
    code: 'code-xml',
    coins: 'coins',
    copy: 'copy',
    cpu: 'cpu',
    crop: 'crop',
    cube: 'boxes',
    cursor: 'mouse-pointer',
    dice: 'dice-5',
    doc: 'file-text',
    download: 'download',
    edit3: 'pencil',
    eraser: 'eraser',
    expand: 'maximize-2',
    ext: 'external-link',
    eye: 'eye',
    eyeoff: 'eye-off',
    face: 'smile',
    file: 'file',
    film: 'film',
    fit: 'scan',
    flip: 'flip-horizontal',
    folder: 'folder',
    folderplus: 'folder-plus',
    globe: 'globe',
    globe2: 'earth',
    grid: 'layout-grid',
    grid9: 'grid-3x3',
    grip: 'grip-vertical',
    group: 'group',
    hand: 'hand',
    hash: 'hash',
    hd: 'monitor',
    history: 'history',
    history2: 'history',
    home: 'house',
    image: 'image',
    key: 'key-round',
    keyboard: 'keyboard',
    lasso: 'lasso',
    layers: 'layers',
    library: 'library',
    link: 'link',
    list: 'list',
    listcheck: 'list-checks',
    locate: 'locate',
    lock: 'lock',
    logout: 'log-out',
    maximize: 'maximize',
    maxwin: 'square',
    merge: 'merge',
    mic: 'mic',
    minus: 'minus',
    minwin: 'minus',
    monitor: 'monitor',
    moon: 'moon',
    more: 'ellipsis',
    mouse: 'mouse',
    msg: 'message-circle',
    music: 'music',
    newchat: 'square-pen',
    optimize: 'wand-sparkles',
    palette: 'palette',
    pano: 'gallery-horizontal',
    paste: 'clipboard-paste',
    pause: 'pause',
    pen: 'pen',
    pencil: 'pencil',
    pin: 'pin',
    play: 'play',
    plug: 'plug',
    plus: 'plus',
    qr: 'qr-code',
    radar: 'radar',
    redo: 'redo-2',
    refresh: 'refresh-cw',
    refresh2: 'refresh-cw',
    rotate: 'rotate-cw',
    ruler: 'ruler',
    save: 'save',
    scissors: 'scissors',
    search: 'search',
    send: 'send',
    server: 'server',
    settings: 'settings',
    shield: 'shield',
    size: 'move-horizontal',
    sliders: 'sliders-horizontal',
    spark: 'sparkle',
    sparkles: 'sparkles',
    split: 'split',
    square: 'square',
    square2: 'square',
    star: 'star',
    stop: 'square',
    sun: 'sun',
    sunm: 'sun',
    table: 'table',
    tag: 'tag',
    target: 'target',
    terminal: 'terminal',
    tpl: 'layout-template',
    trash: 'trash-2',
    type: 'type',
    undo: 'undo-2',
    up: 'arrow-up',
    upload: 'upload',
    user: 'user',
    video: 'video',
    video2: 'video',
    volume: 'volume-2',
    wallet: 'wallet',
    wand2: 'wand-sparkles',
    wifi: 'wifi',
    winmax: 'square',
    winmin: 'minus',
    workflow: 'workflow',
    x: 'x',
    zoomin: 'zoom-in',
    zoomout: 'zoom-out',
};

// lucide kebab 名 → 动画分类（与 static/css/nv-icons.css 的具名映射保持一致）
const ANIM_GROUPS = {
    rotate: ['plus', 'x', 'sun', 'moon'],
    spin: ['refresh-cw', 'rotate-cw', 'history', 'loader', 'loader-circle', 'sync', 'settings', 'settings-2'],
    bounceY: ['arrow-up', 'chevron-up', 'upload', 'send', 'share', 'share-2', 'external-link', 'arrow-down', 'chevron-down', 'download'],
    slideX: ['arrow-left', 'chevron-left', 'undo-2', 'arrow-right', 'chevron-right', 'redo-2'],
    wiggle: ['trash-2', 'trash', 'key-round', 'keyboard', 'scissors', 'pin', 'hand', 'mic', 'mouse-pointer'],
    pop: ['star', 'sparkles', 'sparkle', 'zap', 'badge-check', 'copy', 'folder', 'folder-plus', 'image', 'film', 'camera', 'book', 'layout-grid', 'grid-3x3'],
    blink: ['eye', 'eye-off'],
    draw: ['check', 'link', 'pencil', 'pen', 'search', 'type', 'hash', 'code', 'code-xml', 'paperclip'],
    tilt: ['box', 'boxes', 'layers', 'layout-dashboard', 'table', 'group', 'flip-horizontal'],
};

const ANIM_BY_LUCIDE = {};
for (const [anim, names] of Object.entries(ANIM_GROUPS)) {
    for (const n of names) ANIM_BY_LUCIDE[n] = anim;
}

const ATTR_ORDER = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];

function escapeAttr(v) {
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function sortAttrs(a, b) {
    const ia = ATTR_ORDER.indexOf(a);
    const ib = ATTR_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function readIconNode(kebab) {
    const file = path.join(LUCIDE_DIR, kebab + '.js');
    if (!fs.existsSync(file)) {
        throw new Error('lucide 图标不存在: ' + kebab + '（先确认 lucide-react 已安装）');
    }
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/createLucideIcon\(\s*"[^"]+",\s*(\[[\s\S]*?\])\s*\);/);
    if (!m) throw new Error('无法解析 lucide 图标源码: ' + kebab);
    return Function('"use strict"; return (' + m[1] + ');')();
}

function renderNode([tag, attrs]) {
    // lucide 的 key / palette / tag 用 r=.5 + fill=currentColor 画实心点；全站图标只允许描边，改成 1px 描边点
    if (tag === 'circle' && attrs.fill === 'currentColor' && Number(attrs.r) <= 1) {
        return '<path d="M' + attrs.cx + ' ' + attrs.cy + 'h.01"/>';
    }
    // 丢掉 lucide 自带的 fill/stroke 表现属性：全站图标统一由 CSS 控制线性描边
    const keys = Object.keys(attrs).filter(k => k !== 'key' && k !== 'fill' && k !== 'stroke').sort(sortAttrs);
    const body = keys.map(k => ' ' + k + '="' + escapeAttr(attrs[k]) + '"').join('');
    return '<' + tag + body + '/>';
}

function renderIcon(node) {
    return node.map(renderNode).join('');
}

const version = JSON.parse(fs.readFileSync(path.join(LUCIDE_PKG, 'package.json'), 'utf8')).version;
const names = Object.keys(MAP).sort();

const icons = names.map(name => {
    const lucide = MAP[name];
    const paths = renderIcon(readIconNode(lucide));
    return { name, lucide, anim: ANIM_BY_LUCIDE[lucide] || 'default', paths };
});

const canonical = {
    generatedBy: 'tools/icons/gen.mjs',
    source: 'lucide-react@' + version,
    icons,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(canonical, null, 4) + '\n');

const iconLines = icons.map(it => '    ' + JSON.stringify(it.name) + ': ' + JSON.stringify(it.paths)).join(',\n');
const animLines = icons.map(it => '    ' + JSON.stringify(it.name) + ': ' + JSON.stringify(it.anim)).join(',\n');

const js = '// 由 tools/icons/gen.mjs 生成，勿手改；数据源 lucide-react@' + version + '（线性描边 24×24）\n' +
    'export const ICONS = {\n' + iconLines + '\n};\n\n' +
    '// 图标默认动效分类，对应 static/css/nv-icons.css 的具名映射\n' +
    'export const ICON_ANIM = {\n' + animLines + '\n};\n';

fs.writeFileSync(OUT_JS, js);

console.log('canonical: ' + icons.length + ' 个图标 -> tools/icons/canonical.json');
console.log('ICONS/ICON_ANIM -> web/src/lib/icons.js');
