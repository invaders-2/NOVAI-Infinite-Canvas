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
// 用户拖大的节点：占位 / 结果 / 新结果节点都按「保留块头」的 refit，不再套 360×640 的默认最大盒
assert(!engine.includes('fitMediaBox(node.w, want') && !engine.includes('fitMediaBox(n.w, o.w'), '占位与结果写回不再用默认最大盒硬缩');
assert((engine.match(/refitNodeBox\(/g) || []).length >= 4, '占位 / 结果 / 换新节点都走 refitNodeBox');
const store = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/store.ts'), 'utf8');
assert(store.includes('refitNodeBox(next, want'), '换比例也只改高度、不缩回默认最大盒');
const registry = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx'), 'utf8');
assert(registry.includes('fitMediaBox('), '图片编辑结果也按真实比例摆正');

// 上传 / 联网搜图 / 助手参考素材：新建节点宽 240 起步，太扁就放大宽度，绝不靠夹高度压比例
eq(fit.fitSourceBox(4, 3), { w: 240, h: 180 }, '4:3 上传图 240×180');
eq(fit.fitSourceBox(9, 16), { w: 240, h: 427 }, '9:16 上传图按比例变高');
const flat = fit.fitSourceBox(1676, 350);
eq(flat, { w: 479, h: 100 }, '4.79:1 分镜长图：宽度放大到 479，而不是 240×100 被裁');
assert(near(flat.w / flat.h, 1676 / 350), '4.79:1 摆正后比例不变');
eq(fit.fitSourceBox(2048, 512), { w: 400, h: 100 }, '4:1 横图宽度放大');
eq(fit.fitSourceBox(1, 5), { w: 128, h: 640 }, '5:1 超高图按高度收宽度');
eq(fit.fitSourceBox(10000, 100), { w: 480, h: 5 }, '100:1 超宽长图收起宽度（高只剩取整误差）');
eq(fit.fitSourceBox(0, 100), null, '源图宽 0 → 不处理');
eq(fit.fitSourceBox(100, NaN), null, '源图高 NaN → 不处理');

// 已有节点换源图（切版本 / 老节点纠偏）：宽度不动，只按源图比例改高度
eq(fit.refitNodeBox({ w: 240, h: 240 }, 1676, 350), { w: 240, h: 50 }, '240×240 的老参考图节点改成 240×50');
eq(fit.refitNodeBox({ w: 600, h: 600 }, 1, 1), { w: 600, h: 600 }, '方形图不动');
eq(fit.refitNodeBox({ w: 240, h: 520 }, 480, 9724), { w: 32, h: 640 }, '1:20 超高图按现高收宽度');
// 用户拖大的节点不再被「结果 / 换比例」缩回 360×640：同比例原样保留，换方向也保持块头（面积不变）
eq(fit.refitNodeBox({ w: 800, h: 450 }, 16, 9), { w: 800, h: 450 }, '800×450 的 16:9 节点出同比例结果时原样保留');
eq(fit.refitNodeBox({ w: 800, h: 450 }, 9, 16), { w: 450, h: 800 }, '800×450 换成 9:16 结果按面积换算，不缩回 360 宽');
eq(fit.refitNodeBox({ w: 900, h: 300 }, 9, 16), { w: 390, h: 693 }, '900×300 换成 9:16 保持面积（390×693）');

// 接线：所有「素材落成节点」的入口都用同一套等比盒子，不再有单边 clamp
const sources = {
    'actions.ts': fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/actions.ts'), 'utf8'),
    'agent/webImages.ts': fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/webImages.ts'), 'utf8'),
    'ui/sourceDrop.ts': fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/sourceDrop.ts'), 'utf8'),
    'homeSeed.ts': fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/homeSeed.ts'), 'utf8'),
};
for (const [name, code] of Object.entries(sources)) {
    assert(code.includes('fitSourceBox('), name + ' 用 fitSourceBox 定新节点尺寸');
    assert(!code.includes('Math.max(100, Math.min(520'), name + ' 不再用单边 clamp 压比例');
}
const menus = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/menus.tsx'), 'utf8');
assert(menus.includes('refitNodeBox('), '切换版本按该版本真实比例摆正');
const repair = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/mediaBoxRepair.ts'), 'utf8');
assert(repair.includes('refitNodeBox(') && repair.includes('needsAgentRefFit'), '老画布助手参考图节点按真实像素纠偏');
const app = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/CanvasApp.tsx'), 'utf8');
assert(app.includes('repairAgentRefBoxes(store)'), '载入画布后执行一次纠偏');

assert(app.includes('repairSkewedMediaBoxes(store)'), '载入画布后摆正被压歪的媒体节点');
const rep = load('novai-canvas-ui/src/canvas/canvas-next/mediaBoxRepair.ts');
const vid = (w, h, sw, sh) => ({ id: 'v', kind: 'video', x: 0, y: 0, w, h, text: '', data: { gen: { hist: [{ url: '/a.mp4', w: sw, h: sh }], hi: 0 } } });
const fixed = rep.skewedMediaBox(vid(800, 720, 1280, 720));
assert(fixed && near(fixed.w / fixed.h, 16 / 9), '800×720 的 16:9 视频摆回 16:9');
eq(rep.skewedMediaBox(vid(800, 450, 1280, 720)), null, '比例正确不动');
eq(rep.skewedMediaBox(vid(800, 720, 0, 0)), null, '没有真实像素不动');
console.log('[PASS] 生成结果 / 上传 / 参考素材按真实比例排版（9:16、16:9、4.79:1、1:20 与最大盒）');
