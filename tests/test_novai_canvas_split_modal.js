#!/usr/bin/env node
'use strict';
/**
 * 智能画布BEAT（canvas-next）的「拆分图层」：工具条入口 → 全屏编辑对话框（和无损改图 / 调色同一套壳）
 * → 保存时上传承合图 → 源图右边建普通图片节点 + 连线。
 * 只读源码 / 构建产物做断言，不需要跑浏览器。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui';

/* ---------- 工具条入口：打开弹窗，不再建「拆分结果」节点 ---------- */
const gen = read(ui + '/GenPanel.tsx');
const imgRow = gen.split('\n').find((l) => l.includes('B("crop"') && l.includes('B("more"'));
assert(imgRow, '找到图片节点工具条那一行');
assert(imgRow.includes('B("split", "layers", "拆分图层"'), '工具条仍保留「拆分图层」按钮');
assert(!gen.includes('startSplitNode(ctl, id, mode)'), 'splitMenu 不再调用 startSplitNode');
assert(gen.includes('openSplitEditor(id, mode)'), 'splitMenu 改为打开拆分弹窗');

/* ---------- 宿主层：对话框挂进 Editors ---------- */
const editors = read(ui + '/Editors.tsx');
assert(editors.includes('SplitEditorLayer'), 'Editors 里渲染 SplitEditorLayer');

const se = read(ui + '/editors/SplitEditor.tsx');
assert(se.includes('"/static/tools/split-layers/index.html"'), 'iframe 指向内置拆分编辑器');
assert(se.includes('?embed=1&inline=1&theme='), 'iframe 带 embed / inline / theme 参数');
assert(se.includes('encodeURIComponent'), 'theme 进 iframe 前编码');
assert(se.includes('"novai-split-editor"') && se.includes('"novai-split-host"'), '双向 postMessage 的 source 常量');
assert(se.includes('type: "init"') && se.includes('image: prepared.image'), 'ready 后发 init（源图 / 尺寸 / 模式 / 接口）');
assert(se.includes('apiPath: API_PATH') && se.includes('/api/canvas/split'), '接口走 /api/canvas/split');
assert(se.includes('d.type === "save"'), '处理工具页 save');
assert(se.includes('d.type === "close"'), '处理工具页 close');
assert(se.includes('importAsset'), '保存时把合成图上传成素材（不把 data URL 写进文档）');
assert(se.includes('uid("e")') && se.includes('from: live.id'), '结果节点接一条源图 → 结果的连线');
assert(se.includes('e.key === "Escape"'), 'Esc 关闭弹窗');

/* ---------- 对话框外壳与 CSS ---------- */
assert(se.includes('className="ie-scrim"') && se.includes('className="ie-dialog split"'), '复用无损改图 / 调色的对话框壳');
const css = read(ui + '/editors/editors.css');
assert(css.includes('.cn-root .ie-dialog.split{position:relative;width:1100px;height:800px;'), '拆分弹窗默认 1100×800（不铺满）');
assert(css.includes('max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);'), '弹窗最大不超过视口 - 32');
assert(css.includes('.cn-root .ie-resize{'), '右下角有尺寸把手');
assert(se.includes('onPointerDown={startResize}'), '把手接到拖动改尺寸');
assert(se.includes('DEFAULT_SIZE = { w: 1100, h: 800 }') && se.includes('MIN_SIZE = { w: 900, h: 620 }'), '默认 / 最小尺寸常量');
assert(se.includes('localStorage.setItem(SIZE_KEY'), '松手后记住用户调过的尺寸');
assert(se.includes('JSON.parse(localStorage.getItem(SIZE_KEY)'), '下次打开沿用上次尺寸');
assert(se.includes('clampSize(from.w + (ev.clientX - startX)'), '拖动右下角按位移改宽高');
assert(se.includes('addEventListener("resize", onResize)'), '浏览器窗口变小时把弹窗收回可视区');

/* ---------- 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.js');
assert(built.includes('拆分完成，结果已放到画布上的新节点'), '构建产物包含拆分弹窗保存提示');
assert(built.includes('拆完点编辑器里的「保存」'), '构建产物包含拆分弹窗头部提示');
const builtCss = read('static/novai-canvas/canvas.css');
assert(builtCss.includes('.ie-dialog.split'), '构建产物 CSS 包含拆分弹窗尺寸');

console.log('[PASS] 拆分图层：工具条入口 / 可调尺寸弹窗 / init·save·close 协议 / 上传后新节点连线 / 构建产物');
