#!/usr/bin/env node
'use strict';
/*
 * 画布「拖进来的图片」按格式分三档（task-5）：
 *   direct  —— png/jpg/jpeg/webp/gif 原字节上传（GIF 动图绝不能被转码，否则丢动画）；
 *   convert —— svg/bmp/avif 在浏览器里转 PNG 再上传（后端只按扩展名存，不转码就是「叫 .png 的坏文件」）；
 *   reject  —— tiff/heic 等浏览器解不了的格式，明确提示，不上传坏文件。
 * 判定抽在 canvas-next/imageUpload.ts 的纯函数里；addFiles 只负责接线（源码级断言这段接线还在）。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const up = load('novai-canvas-ui/src/canvas/canvas-next/imageUpload.ts');
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

/* ---------- [1] 三档判定 ---------- */
console.log('[1] planImageUpload 三档');
const cases = [
    ['a.png', 'image/png', 'direct'],
    ['a.jpg', 'image/jpeg', 'direct'],
    ['a.jpeg', 'image/jpeg', 'direct'],
    ['a.webp', 'image/webp', 'direct'],
    ['a.gif', 'image/gif', 'direct'],
    ['a.svg', 'image/svg+xml', 'convert'],
    ['a.bmp', 'image/bmp', 'convert'],
    ['a.bmp', 'image/x-ms-bmp', 'convert'],
    ['a.avif', 'image/avif', 'convert'],
    ['a.tiff', 'image/tiff', 'reject'],
    ['a.heic', 'image/heic', 'reject'],
    ['a.heif', 'image/heif', 'reject'],
    ['logo', 'image/svg+xml', 'convert'],
    ['noext', 'image/png', 'direct'],
    ['noext', 'image/tiff', 'reject'],
    ['bmp-no-mime.bmp', '', 'convert'],
    ['gif-no-mime.gif', '', 'direct'],
];
for (const [name, type, mode] of cases) {
    eq(up.planImageUpload({ name, type }).mode, mode, name + ' / ' + type + ' 应该是 ' + mode);
}

/* ---------- [2] 转码后扩展名换成 .png，GIF 原样 ---------- */
console.log('[2] 上传文件名');
eq(up.planImageUpload({ name: 'logo.svg', type: 'image/svg+xml' }).name, 'logo.png', 'SVG 转码后叫 logo.png');
eq(up.planImageUpload({ name: '图.bmp', type: 'image/bmp' }).name, '图.png', 'BMP 转码后保留基名');
eq(up.planImageUpload({ name: 'shot.avif', type: 'image/avif' }).name, 'shot.png', 'AVIF 转码后叫 shot.png');
eq(up.planImageUpload({ name: 'cat.gif', type: 'image/gif' }).name, 'cat.gif', 'GIF 文件名原样');
eq(up.planImageUpload({ name: 'cat.png', type: 'image/png' }).name, 'cat.png', 'PNG 文件名原样');
ok(!up.planImageUpload({ name: 'cat.gif', type: 'image/gif' }).name.endsWith('.png'), 'GIF 不能被改成 .png');
eq(up.planImageUpload({ name: 'a.tiff', type: 'image/tiff' }).format, 'TIFF', '拒绝提示里带格式名');
eq(up.planImageUpload({ name: 'a.heic', type: 'image/heic' }).format, 'HEIC', 'HEIC 提示里带格式名');

/* ---------- [3] 转换尺寸：限制长边 + 无固有尺寸兜底 ---------- */
console.log('[3] convertTargetSize');
eq(up.CONVERT_MAX_SIDE, 4096, '转码长边上限 4096');
eq(up.SVG_FALLBACK_SIDE, 2048, 'SVG 无尺寸兜底长边 2048');
eq(up.convertTargetSize(800, 600), { w: 800, h: 600 }, '普通图按原尺寸转');
eq(up.convertTargetSize(6000, 3000), { w: 4096, h: 2048 }, '超长边等比缩到 4096');
eq(up.convertTargetSize(300, 9000), { w: 137, h: 4096 }, '竖图同样按长边缩');
eq(up.convertTargetSize(300, 150, { sizeless: true }), { w: 2048, h: 1024 }, 'SVG 无固有尺寸 → 长边 2048 兜底');
eq(up.convertTargetSize(0, 0, { sizeless: true }), { w: 2048, h: 1024 }, '解不出宽高时也按 2048 兜底');
eq(up.convertTargetSize(0, 0, { sizeless: true }).w <= up.CONVERT_MAX_SIDE, true, '兜底尺寸也在上限内');

/* ---------- [4] SVG 无固有尺寸识别 ---------- */
console.log('[4] hasNoIntrinsicSize');
ok(up.hasNoIntrinsicSize({ name: 'a.svg', type: 'image/svg+xml' }, { naturalWidth: 300, naturalHeight: 150 }), 'SVG 默认 300×150 = 无固有尺寸');
ok(up.hasNoIntrinsicSize({ name: 'a.svg', type: 'image/svg+xml' }, { naturalWidth: 0, naturalHeight: 0 }), '解不出尺寸也算无固有尺寸');
ok(!up.hasNoIntrinsicSize({ name: 'a.png', type: 'image/png' }, { naturalWidth: 300, naturalHeight: 150 }), '恰好 300×150 的 PNG 不能当无尺寸');
ok(!up.hasNoIntrinsicSize({ name: 'a.svg', type: 'image/svg+xml' }, { naturalWidth: 512, naturalHeight: 256 }), '有 viewBox 的 SVG 用真实尺寸');

/* ---------- [5] addFiles 真的接了这三档 ---------- */
console.log('[5] addFiles 接线');
const actions = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/actions.ts'), 'utf8');
ok(/import \{ convertImageToPng, planImageUpload \} from "\.\/imageUpload"/.test(actions), 'addFiles 引用 imageUpload 的两个函数');
ok(/const plan = kind === "image" \? planImageUpload\(f\) : null;/.test(actions), '图片先过 planImageUpload');
ok(/plan\?\.mode === "reject"/.test(actions) && /暂不支持 \$\{plan\.format\} 格式/.test(actions), 'reject 档明确提示格式并 continue');
ok(/plan\?\.mode === "convert"/.test(actions) && /await convertImageToPng\(f\)/.test(actions), 'convert 档走浏览器转 PNG');
ok(/importAsset\(store\.state\.canvasId, dataUrl, uploadName\)/.test(actions), '上传用转换后的文件名（扩展名 .png）');
const addFilesBody = actions.slice(actions.indexOf('export async function addFiles'), actions.indexOf('if (made.length)'));
const convertAt = addFilesBody.indexOf('await convertImageToPng(f)');
const decodeAt = addFilesBody.indexOf('const wh = kind === "image"');
ok(convertAt > 0 && decodeAt > convertAt, '转码发生在读宽高/上传之前（后面读的是转好的 PNG）');

console.log('全部通过');
