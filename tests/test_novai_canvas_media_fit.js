#!/usr/bin/env node
'use strict';
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
    new Function('module', 'exports', 'require', result.outputText ? result.outputText : result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const fit = load('novai-canvas-ui/src/canvas/canvas-next/mediaFit.ts');
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const near = (a, b) => Math.abs(a - b) < 0.02;

// 真实比例 → 节点尺寸（宽度沿用节点当前宽度，高度按比例）
eq(fit.fitMediaBox(240, 1, 1), { w: 240, h: 240 }, '1:1');
eq(fit.fitMediaBox(240, 9, 16), { w: 240, h: 427 }, '9:16 竖图不再被塞成方框');
eq(fit.fitMediaBox(320, 16, 9), { w: 320, h: 180 }, '16:9');
eq(fit.fitMediaBox(320, 21, 9), { w: 320, h: 137 }, '21:9');
eq(fit.fitMediaBox(240, 3, 4), { w: 240, h: 320 }, '3:4');

// 超过最大盒：宽高同时缩，比例不能变
const tall = fit.fitMediaBox(400, 9, 16);
eq(tall, { w: 360, h: 640 }, '9:16 超过最大盒时两边一起缩');
assert(near(tall.w / tall.h, 9 / 16), '9:16 缩放后比例仍是 9:16');
eq(fit.fitMediaBox(800, 1, 1), { w: 360, h: 360 }, '1:1 超过最大宽时两边一起缩');
const wide = fit.fitMediaBox(800, 16, 9);
eq(wide, { w: 360, h: 203 }, '16:9 超过最大宽时两边一起缩');
assert(near(wide.w / wide.h, 16 / 9), '16:9 缩放后比例仍是 16:9');
const tall31 = fit.fitMediaBox(300, 1, 3);
eq(tall31, { w: 213, h: 640 }, '1:3 超高时按高度收');
assert(tall31.h <= fit.MEDIA_FIT_MAX.h && tall31.w <= fit.MEDIA_FIT_MAX.w, '不超过最大盒');

// 自定义最大盒 + 非法输入
eq(fit.fitMediaBox(400, 9, 16, { w: 500, h: 500 }), { w: 281, h: 500 }, '自定义最大盒');
eq(fit.fitMediaBox(240, 0, 100), null, '宽 0 → 不处理');
eq(fit.fitMediaBox(240, 100, 0), null, '高 0 → 不处理');
eq(fit.fitMediaBox(240, NaN, 100), null, 'NaN → 不处理');
eq(fit.fitMediaBox(0, 9, 16), { w: 360, h: 640 }, '没有宽度时用最大盒宽度起算');

// engine 接线：生成结果 / 占位 / 批量都走同一个等比盒子；缺 w/h 时解码真实像素
const engine = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
assert(engine.includes('fitMediaBox('), 'engine 使用共享等比盒子');
assert(engine.includes('naturalWidth') && engine.includes('naturalHeight'), '缺 w/h 时用 naturalWidth/naturalHeight 兜底');
assert(engine.includes('decodeImageSize') && engine.includes('decodeVideoSize'), '图片 / 视频封面都有解码兜底');
assert(engine.includes('const boxOf =') && engine.includes('const wantBox ='), '批量占位与生成中占位也按比例');
assert(!engine.includes('clamp(n.w / want, 100, 520)') && !engine.includes('clamp((n.w * o.h) / o.w, 100, 520)'), '不再用单边 clamp 压比例');
const registry = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx'), 'utf8');
assert(registry.includes('fitMediaBox('), '图片编辑结果也按真实比例摆正');

console.log('[PASS] 生成结果 / 占位 / 批量图片节点按真实比例排版（9:16、16:9、21:9、1:1 与最大盒）');
