#!/usr/bin/env node
/*
 * task-52：全屏查看器里的「对比原图」。
 *   原图 = 生成前的那张图：来源节点（点「生成」的那个节点）的当前结果 → 其它上游输入图
 *   → 最后才退回历史第一版；视频 / 音频 / 提示词不显示这个按钮；两侧标「原图 / 当前」，不画线框。
 * 对比入口浮在图片包围盒右下角（.lb-stage .lb-cmp-btn + data-lb="compare"）：
 *   非对比态按 stage / img 的矩形把按钮量到图片包围盒右下角内侧 10px（夹在舞台内），
 *   对比态就渲染在同一个 .lb-stage 里（.lb-cmp 吃同一套 transform，缩放 / 平移 / 双击全复用 lightboxZoom）。
 *   右侧信息栏只剩分辨率 / 模型 / 日期 + 版本行。
 *   所以下面的接线断言按新结构切源码——锚点用 data-lb / lb-* 具名标记，不用函数签名；
 *   纯逻辑（原图优先级）那一截一条都不动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
  const r = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}
const cmp = load('novai-canvas-ui/src/canvas/canvas-next/ui/compareSource.ts');

// ---- 优先级：生成前的来源图 → 其它上游输入图 → 最后才第一版 ----
const three = [{ url: '/v1.png' }, { url: '/v2.png' }, { url: '/v3.png' }];
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, source: '/pre.png' }), { original: '/pre.png', current: '/v3.png', from: 'source' }, '有来源图：原图是点「生成」的那个节点的结果，不是第一版');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, source: '/pre.png', inputs: ['/ref.png'] }), { original: '/pre.png', current: '/v3.png', from: 'source' }, '来源图优先于其它上游输入图');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, inputs: ['/ref.png'] }), { original: '/ref.png', current: '/v3.png', from: 'input' }, '没有来源图：上游输入图优先于第一版');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, source: '/v3.png', inputs: ['/ref.png'] }), { original: '/ref.png', current: '/v3.png', from: 'input' }, '来源图就是当前图：不算可比，退到上游输入图');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, source: '', inputs: ['/v3.png', '/ref.png'] }), { original: '/ref.png', current: '/v3.png', from: 'input' }, '来源图为空：退到上游输入图，跳过等于当前图的');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2, source: '/v3.png', inputs: ['/v3.png'] }), { original: '/v1.png', current: '/v3.png', from: 'version' }, '来源图和输入图都不可比：退回第一版');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 2 }), { original: '/v1.png', current: '/v3.png', from: 'version' }, '什么都没有：退回第一版');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 1 }), { original: '/v1.png', current: '/v2.png', from: 'version' }, '看第二版且没有来源图：退回第一版');
assert.strictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 0 }), null, '正在看第一版且没有来源图/上游图：没有可比的原图');

// ---- 只有一版：退回上游参考图 / 输入图 ----
const one = [{ url: '/only.png' }];
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: one, hi: 0, inputs: ['/ref.png'] }), { original: '/ref.png', current: '/only.png', from: 'input' }, '只有一版：原图用上游参考图');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: three, hi: 0, inputs: ['/ref.png'] }), { original: '/ref.png', current: '/v1.png', from: 'input' }, '看第一版时退回输入图');
assert.strictEqual(cmp.compareOriginal({ kind: 'image', hist: one, hi: 0, inputs: [] }), null, '只有一版又没有上游图：没有可比的原图');
assert.strictEqual(cmp.compareOriginal({ kind: 'image', hist: one, hi: 0, inputs: ['/only.png'] }), null, '上游图就是当前图时不算可比');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: one, hi: 0, inputs: [undefined, '', '/ref2.png'] }), { original: '/ref2.png', current: '/only.png', from: 'input' }, '跳过空的输入地址');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: [{ frame: '/cover.jpg' }], hi: 0, inputs: ['/ref.png'] }), { original: '/ref.png', current: '/cover.jpg', from: 'input' }, '版本只有封面帧（frame）也算当前图');
assert.deepStrictEqual(cmp.compareOriginal({ kind: 'image', hist: one, hi: 0, source: '/pre.png' }), { original: '/pre.png', current: '/only.png', from: 'source' }, '只有一版也先看来源图');

// ---- 视频 / 音频 / 提示词：不显示按钮 ----
assert.strictEqual(cmp.compareOriginal({ kind: 'video', hist: three, hi: 2 }), null, '视频没有对比原图');
assert.strictEqual(cmp.compareOriginal({ kind: 'audio', hist: [{ url: '/a.mp3' }], hi: 0, inputs: ['/ref.png'] }), null, '音频没有对比原图');
assert.strictEqual(cmp.compareOriginal({ kind: 'text', hist: [{ text: 'x' }], hi: 0 }), null, '提示词/文本没有对比原图');
assert.strictEqual(cmp.compareOriginal({ kind: 'video', hist: three, hi: 2, source: '/pre.png', inputs: ['/ref.png'] }), null, '非图片节点即使有来源图也不显示');
assert.strictEqual(cmp.compareOriginal({ kind: 'image', hist: [], hi: 0, inputs: ['/ref.png'] }), null, '没有结果的节点不显示');

// ---- 接线：全屏查看器的布局（左上返回 / 右侧信息栏 / 底部工具条）+ 对比原图 ----
const chrome = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Chrome.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
const lbZoom = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/lightboxZoom.ts'), 'utf8');
// 对比态复用同一套缩放：imgRef 放宽到 HTMLElement，量尺寸时自然像素从包裹层里的 <img> 取
assert.ok(lbZoom.includes('const imgRef = useRef<HTMLElement | null>(null);'), 'imgRef 放宽到 HTMLElement（普通态 <img>、对比态 .lb-cmp）');
assert.ok(lbZoom.includes('const img = el instanceof HTMLImageElement ? el : el.querySelector("img");'), 'measure 的自然尺寸从包裹层里的 <img> 取');
assert.ok(lbZoom.includes('const assignImg = useCallback((el: HTMLElement | null) => { imgRef.current = el; }, []);'), 'assignImg 供外部按元素挂 ref');
assert.ok(lbZoom.includes('s: view.s,'), 'useLbZoom 暴露当前倍率给 --lb-z');

// 按锚点切源码。锚点找不到就直接失败：旧版那种“indexOf 成 -1 → 切成空串 → 断言恒真”必须杜绝。
function sliceBetween(src, from, to, label) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, label + '：源码里找不到起点 ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, label + '：源码里找不到终点 ' + to);
  return src.slice(a, b + to.length);
}
// 从一个 <div 起按真实嵌套配对自己的闭合，不靠猜字符串边界
function sliceDiv(src, from, label) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, label + '：源码里找不到 ' + from);
  const re = /<\/div>|<div\b/g;
  re.lastIndex = a;
  let depth = 0, m;
  while ((m = re.exec(src))) {
    if (m[0] === '</div>') { if (--depth === 0) return src.slice(a, m.index + 6); }
    else depth++;
  }
  throw new Error(label + '：div 没有闭合，切片不可靠');
}

assert.ok(chrome.includes('import { compareOriginal } from "./compareSource";'), '全屏查看用对比原图纯逻辑');

// 只有图片节点才算得出原图：视频 / 音频 / 提示词拿不到对比（按钮连数据都没有）
const compareMemo = sliceBetween(chrome, 'const compare = useMemo(() => {', '}, [node, gen, doc]);', 'compare 的 useMemo');
assert.ok(compareMemo.includes('node.kind !== "image"') && compareMemo.includes('return null'), '非图片节点（视频 / 音频 / 提示词）算不出原图');
assert.ok(compareMemo.includes('expandGroupInputs(doc, inputsOf(doc, node.id))'), '原图候选包含上游参考图 / 输入图');
assert.ok(compareMemo.includes('sourceNodeId'), '来源节点从新节点的 data.sourceNodeId 读（regenAsNew 写入）');
assert.ok(compareMemo.includes('doc.nodes.find((x) => x.id === sid)') && compareMemo.includes('outOf(from)?.url || outOf(from)?.frame'), '按 sourceNodeId 找节点并取它的当前结果（图 / 封面帧）');
assert.ok(compareMemo.includes('compareOriginal({ kind: node.kind, hist: gen.hist, hi: gen.hi, inputs, source })'), '来源节点的当前结果作为 source 传给纯逻辑');
assert.ok(chrome.includes('const comparing = cmp && !!compare;'), '可比时才进对比模式');

// 左上返回钮：关窗后回到画布上的这个节点
assert.ok(chrome.includes('<button className="lb-back" data-lb="back" title="返回画布"'), '左上返回钮（.lb-back / data-lb=back）');
assert.ok(chrome.includes('close(); setTimeout(() => ctl.focusNode(node.id), 170);'), '返回 = 关窗并回到画布上的该节点');

// 右侧信息栏：分辨率 / 模型 / 日期 + 版本行（「对比原图」已挪到图片右下角，不在信息栏）
assert.ok(chrome.includes('{comparing ? null : <div className="lb-info"'), '对比态隐藏信息栏');
const info = sliceDiv(chrome, '<div className="lb-info"', 'lb-info');
assert.ok(info.includes('"--lb-x"') && info.includes('"--lb-y"'), '信息栏位置交给 --lb-x / --lb-y（由 JS 按图片包围盒算）');
assert.ok(info.includes('data-lb="res"') && info.includes('data-lb="model"') && info.includes('data-lb="date"'), '信息栏三组：分辨率 / 模型 / 日期');
assert.ok(info.includes('版本 {g.hi + 1}/{g.hist.length}') && info.includes('data-lb="prev"') && info.includes('data-lb="next"'), '信息栏有「版本 n/m」+ ‹ › 翻页');
const acts = sliceDiv(chrome, '<div className="lb-acts"', 'lb-acts');
assert.ok(!acts.includes('data-lb="compare"') && !acts.includes('compareBtn'), '信息栏操作区里已经没有「对比原图」');
assert.ok(acts.includes('版本 {g.hi + 1}/{g.hist.length}'), '信息栏操作区只剩版本行，不会因为少了对比入口而空着（单版本时整块不渲染）');
assert.ok(chrome.includes('{showVer ? <div className="lb-acts">'), '版本行还在时整块 .lb-acts 才渲染');
// 信息栏贴图片右边缘 + 48，夹在「视口中线 + 150」和「视口宽 - 280」之间；顶部与图片对齐且不低于 64
assert.ok(chrome.includes('Math.max(vw * .5 + 150, Math.min(r.right + 48, vw - 280))'), '信息栏 left 跟着图片包围盒右边缘，并夹在视口内不压住图片');
assert.ok(chrome.includes('Math.max(64, r.top)'), '信息栏 top 与图片顶部对齐，且不低于 64');

// 「对比原图」贴在图片包围盒右下角：量 stage / img 矩形算 corner，缩放 / 平移 / resize 后重量
const cornerEffect = sliceBetween(chrome, 'const measureCorner = useCallback(', '}, []);', 'measureCorner');
assert.ok(cornerEffect.includes('stage.getBoundingClientRect()') && cornerEffect.includes('img.getBoundingClientRect()'), '按舞台和图片的真实矩形算按钮位置（不是舞台角落）');
assert.ok(cornerEffect.includes('s.right - i.right + 10') && cornerEffect.includes('s.bottom - i.bottom + 10'), '按钮距图片右边缘 / 下边缘各 10px');
assert.ok(cornerEffect.includes('s.width - btn.offsetWidth - 10') && cornerEffect.includes('s.height - btn.offsetHeight - 10'), '图片右下角超出舞台时把按钮夹回舞台内（不被 overflow:hidden 裁掉）');
assert.ok(chrome.includes('useLayoutEffect(() => { measureCorner(); });'), '每次重渲染（缩放 / 平移 / 换版本）都重量一次');
assert.ok(chrome.includes('addEventListener("resize", measureCorner)') && chrome.includes('removeEventListener("resize", measureCorner)'), '窗口 resize 时也重量');

// 底部工具条：放到画布 / 下载 / 收藏 / 放大时的百分比 chip
const tools = sliceDiv(chrome, '<div className="lb-tools">', 'lb-tools');
assert.ok(tools.includes('data-lb="apply"') && tools.includes('data-lb="dl"') && tools.includes('data-lb="fav"'), '工具条顺序：放到画布 / 下载 / 收藏');
assert.ok(tools.includes('extractCurrentVersion(ctl.store, node.id)'), '「放到画布」仍然走 extractCurrentVersion');
assert.ok(tools.includes('patchGen(node.id, { fav: !fav })') && tools.includes('aria-pressed={fav}'), '收藏切换 genOf(node).fav 并带 aria-pressed');
assert.ok(!tools.includes('data-lb="compare"'), '「对比原图」不在底部工具条里');
assert.ok(!chrome.includes('comparing ? null : <div className="lb-tools"'), '对比态保留底部工具条');
assert.ok(tools.includes('className="lb-pct" data-lb="zoom"') && tools.includes('zoom.pct > 100') && !tools.includes('!comparing && zoom.pct'), '缩放百分比 chip 只在放大（>100%）时出现，对比态同样显示');
assert.ok(tools.indexOf('data-lb="zoom"') > tools.indexOf('data-lb="fav"'), '缩放百分比 chip 在工具条最右侧');

// 按钮渲染在图片舞台里：浮在图片右下角，而不是信息栏
const stage = sliceDiv(chrome, '<div className={zoom.stageClass}', 'lb-stage');
assert.ok(stage.includes('data-lb="view"') && stage.includes('style={zoom.imgStyle}'), '图片舞台里有缩放 / 平移后的 <img>');
assert.ok(stage.includes('{node.kind === "image" ? compareBtn(comparing ? undefined : (corner || undefined)) : null}'), '「对比原图」渲染在 .lb-stage 内部：普通态用量到的 corner，对比态用舞台胶囊位（只有图片节点有）');
assert.ok(!stage.includes('lb-info'), '图片舞台里不塞信息栏');

// 「对比原图」按钮本身：稳定的具名锚点，不拿函数签名当锚点
const btn = sliceBetween(chrome, 'const compareBtn = (at?:', '</button>;', 'compareBtn');
assert.ok(btn.includes('className="lb-cmp-btn"') && btn.includes('data-lb="compare"'), '按钮带稳定的 lb-cmp-btn / data-lb=compare 锚点');
assert.ok(btn.includes('aria-pressed={comparing}'), '按钮是可切换的（aria-pressed 反映对比态）');
assert.ok(btn.includes('disabled={!compare}') && btn.includes('没有可比的原图'), '没有原图时按钮禁用并提示');
assert.ok(btn.includes('拖动分割线对比生成前的原图') && btn.includes('拖动分割线对比第一版'), '按钮文案：退回第一版时说第一版，否则说生成前的原图');
assert.ok(btn.includes('setCmp((v) => !v)'), '点击进入 / 退出对比');
assert.ok(btn.includes('Icon name="split"') && btn.includes('对比原图'), '按钮是 split 图标 + 文字');
assert.ok(btn.includes('ref={cmpBtnRef}') && btn.includes('style={at ? { right: at.right, bottom: at.bottom } : undefined}'), '按钮位置由量到的 corner 写成 inline right / bottom');

// wipe 对比：同一张图，左半边原图、右半边当前；渲染在 .lb-stage 里复用缩放 / 平移
const cmpLayer = sliceDiv(chrome, '<div className={"lb-cmp"', 'lb-cmp');
assert.ok(cmpLayer.includes('data-lb="compare-view"') && cmpLayer.includes('ref={setCmpEl}'), '对比层是 .lb-cmp，ref 同时接到 zoom.imgRef 和分割线基准');
assert.ok(cmpLayer.includes('style={{ ...zoom.imgStyle, "--lb-z": 1 / zoom.s } as CSSProperties}'), '对比层吃同一套 transform，并把 --lb-z（1/缩放）传给分割线 / 标签');
assert.ok(cmpLayer.includes('className="lb-cmp-cur" src={cmpCurrentUrl}'), '底层是当前图');
assert.ok(cmpLayer.includes('className="lb-cmp-top" src={cmpOriginalUrl}') && cmpLayer.includes('style={{ clipPath: "inset(0 " + (100 - cmpPct) + "% 0 0)" }}'), '原图叠在上面、按分割线百分比裁切（左半边原图）');
assert.ok(cmpLayer.includes('<div className="lb-cmp-div" style={{ left: cmpPct + "%" }}'), '竖向分割线');
assert.ok(cmpLayer.includes('className="lb-cmp-knob" role="slider" tabIndex={0}'), '圆形把手可聚焦（←/→ 微调）');
assert.ok(cmpLayer.includes('<span className="lb-cmp-tag">原图</span>') && cmpLayer.includes('<span className="lb-cmp-tag right">当前</span>'), '两侧标「原图 / 当前」');
assert.ok(chrome.includes('onPointerDown={onCmpDown}') && chrome.includes('e.currentTarget.setPointerCapture(e.pointerId)') && chrome.includes('wipeAt(e.clientX)'), '按住左右拖动跟手（pointer capture）');
assert.ok(chrome.includes('if (zoom.s > 1.001 && !onWipeLine(e.clientX)) return;'), '放大后按在线外不拦事件，让事件冒泡给舞台做平移');
assert.ok(chrome.includes('return Math.abs(clientX - (r.left + r.width * cmpPct / 100)) <= 24;'), '分割线命中区是屏幕 ±24px');
assert.ok(chrome.includes('const setCmpEl = useCallback((el: HTMLDivElement | null) => { cmpRef.current = el; zoom.assignImg(el); }, [zoom.assignImg]);'), '对比层就是 zoom.imgRef 指向的元素（百分比 / 平移边界跟着它）');
assert.ok(chrome.includes('useLayoutEffect(() => { zoom.onLoad(); }, [comparing, zoom.onLoad]);'), '进出对比态重新测量一次');
assert.ok(chrome.includes('setCmpPct((v) => Math.max(0, Math.min(100, v + (e.key === "ArrowLeft" ? -2 : 2))))'), '把手聚焦时 ←/→ 微调 2%');
assert.ok(chrome.includes('useEffect(() => { setCmp(false); }, [id]);'), '换节点时退出对比模式');

// 键盘与旧 DOM
assert.ok(chrome.includes('if (e.key === "Escape") close();'), 'Esc 关闭');
assert.ok(chrome.includes('(e.key === "ArrowLeft" || e.key === "ArrowRight") && g.hist.length > 1') && chrome.includes('hi: (g.hi + (e.key === "ArrowLeft" ? -1 : 1)'), '←/→ 切版本（多版本时）');
assert.ok(chrome.includes('e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_" || e.key === "0"') && chrome.includes('zoom.reset()'), '+ / - / 0 缩放');
assert.ok(!chrome.includes('lb-compare') && !chrome.includes('lb-cmp-pane'), '旧的左右并排 DOM 已删除');

// ---- CSS：取所有 selector 带 .lightbox 的规则当语料（含媒体查询里的），只校验查看器自己 ----
const lbCss = (css.match(/^[^\n{}]*\.lightbox[^\n{}]*\{[^}]*\}/gm) || []).join('\n');
assert.ok(lbCss.length > 1000, '读到了全屏查看器的样式规则');
assert.ok(css.includes('/* ---- 全屏查看器：左上返回、右侧信息栏、底部工具条'), '样式按「左上返回 / 右侧信息栏 / 底部工具条」分段');
assert.ok(!css.includes('lb-compare') && !css.includes('lb-cmp-pane'), '旧的并排样式已删除');

assert.ok(lbCss.includes('.lb-back{position:absolute;left:20px;top:20px;z-index:5;width:44px;height:44px;border-radius:50%'), '返回钮在左上、44×44 圆形');
assert.ok(lbCss.includes('.lb-info{position:absolute;left:var(--lb-x,0px);top:var(--lb-y,64px);z-index:3;width:240px'), '信息栏绝对定位 240px 宽，位置来自 --lb-x / --lb-y');
assert.ok(lbCss.includes('.lb-tools{position:absolute;left:50%;bottom:32px;transform:translateX(-50%)'), '底部工具条水平居中、离底 32px');
const toolsCss = (lbCss.match(/\.lightbox \.lb-tools\{[^}]*\}/) || [''])[0];
assert.ok(toolsCss.includes('border-radius:18px') && toolsCss.includes('backdrop-filter:blur(24px) saturate(160%)') && toolsCss.includes('-webkit-backdrop-filter:blur(24px) saturate(160%)'), '工具条是圆角磨砂底（含 -webkit- 前缀）');
assert.ok(lbCss.includes('.lb-btn{width:44px;height:44px;border-radius:12px'), '工具条按钮 44×44、圆角 12');
assert.ok(lbCss.includes('.lb-pct{height:44px'), '缩放百分比 chip 与工具条按钮同高');
assert.ok(lbCss.includes('.lb-stage{position:absolute;inset:0'), '图片舞台铺满视口');
assert.ok(lbCss.includes('.lb-stage .lb-cmp{position:relative;flex:0 0 auto;max-width:min(46vw,100%)'), '对比层是舞台里的普通流子元素（offset 口径和 .big 一致）');
assert.ok(lbCss.includes('touch-action:none') && lbCss.includes('cursor:ew-resize'), '对比层支持左右拖动分割线');
assert.ok(lbCss.includes('.lb-cmp-top{position:absolute;inset:0') && lbCss.includes('will-change:clip-path'), '原图叠在图上、只走 clip-path');
assert.ok(lbCss.includes('.lb-cmp-div{position:absolute;top:0;bottom:0;left:0;width:calc(2px * var(--lb-z,1))') && lbCss.includes('background:rgba(255,255,255,.9)') && lbCss.includes('box-shadow:0 0 calc(14px * var(--lb-z,1)) rgba(0,0,0,.5)'), '分割线按 --lb-z 反向缩放，屏幕上仍是 2px 白色半透明');
assert.ok(lbCss.includes('.lb-cmp-knob{position:absolute;left:50%;top:50%;width:30px;height:30px') && lbCss.includes('border-radius:50%') && lbCss.includes('transform:scale(var(--lb-z,1))'), '圆形把手放大时保持屏幕尺寸');
assert.ok(lbCss.includes('.lb-cmp-tag{position:absolute;top:calc(10px * var(--lb-z,1))') && lbCss.includes('transform:scale(var(--lb-z,1));transform-origin:0 0'), '「原图 / 当前」标签同理，边距也按屏幕像素算');
const cmpBase = (lbCss.match(/\.lightbox \.lb-cmp-btn\{[^}]*\}/) || [''])[0];
assert.ok(cmpBase.includes('display:inline-flex') && cmpBase.includes('gap:6px'), '「对比原图」基础态是图标 + 文字的 inline-flex');
const cmpCapsule = (lbCss.match(/\.lightbox \.lb-stage \.lb-cmp-btn[^{]*\{[^}]*\}/) || [''])[0];
assert.ok(cmpCapsule.includes('.lb-stage .lb-cmp-btn') && !cmpCapsule.includes('.lb-wipe'), '普通态和对比态共用一个舞台胶囊规则（不再有独立的 wipe 宿主）');
assert.ok(cmpCapsule.includes('position:absolute;right:12px;bottom:12px') && cmpCapsule.includes('height:28px') && cmpCapsule.includes('padding:0 10px'), '胶囊绝对定位、28px 高、左右 10px 内边距');
assert.ok(cmpCapsule.includes('border-radius:999px') && cmpCapsule.includes('background:rgba(0,0,0,.55)') && cmpCapsule.includes('color:#fff'), '胶囊黑底 55% + 白字、全圆角');
assert.ok(cmpCapsule.includes('backdrop-filter:blur(14px) saturate(160%)') && cmpCapsule.includes('-webkit-backdrop-filter:blur(14px) saturate(160%)'), '胶囊磨砂底带 -webkit- 前缀');
assert.ok(/\n\.cn-root \.lightbox \.lb-cmp-btn:disabled\{opacity:\.34/.test(lbCss), '禁用态（没有可比原图）保持 .34');
assert.ok(lbCss.lastIndexOf('.lb-cmp-btn:disabled{opacity:.34') > lbCss.indexOf('.lb-stage .lb-cmp-btn'), '禁用规则写在胶囊之后，同特异性下才能压住 .78');
assert.ok(!css.includes('.lb-acts .lb-cmp-btn'), '浅色主题里只调信息栏那颗按钮的覆盖规则已删除（信息栏不再有它）');
assert.ok(lbCss.includes('.lb-cmp-knob:focus-visible{box-shadow:'), '把手焦点用软光晕，不画线框');
assert.ok(!/\bborder:\s*(1px|0\.5px)/.test(lbCss), '查看器样式里没有 1px 描边');

// 窄屏（<=900px）：信息栏变工具条上方的横向三组
const narrowAt = css.indexOf('.lb-info{left:24px');
const narrowOpen = narrowAt > 0 ? css.lastIndexOf('@media (max-width: 900px)', narrowAt) : -1;
const narrowClose = narrowOpen > 0 ? css.indexOf('\n}', narrowOpen) : -1;
assert.ok(narrowAt > 0 && narrowOpen > 0 && narrowOpen < narrowAt && narrowClose > narrowAt, '窄屏信息栏写在 @media (max-width:900px) 里');
const narrow = css.slice(narrowOpen, narrowClose);
assert.ok(narrow.includes('.lb-facts{flex-direction:row;gap:32px'), '窄屏信息栏改成横向三组');
assert.ok(narrow.includes('.lb-tools{bottom:20px}'), '窄屏工具条离底 20px');

console.log('[PASS] 对比原图：来源图优先 / 再上游输入图 / 最后退回第一版 / 视频音频文本不显示 / 禁用提示');
console.log('[PASS] 查看器布局：左上返回 / 右侧信息栏（分辨率·模型·日期 + 版本 n/m）/ 底部工具条（放到画布·下载·收藏·放大百分比）');
console.log('[PASS] 对比原图：浮在图片包围盒右下角 10px（缩放 / 平移 / resize 跟手，越界夹回舞台内），信息栏里已无入口');
