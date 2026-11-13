#!/usr/bin/env node
'use strict';
/**
 * 智能画布BEAT（canvas-next）图片节点的「调色」：旧智能画布专业调色（image-adjust-engine/editor/css）
 * 搬进 BEAT —— 工具条入口 + 居中对话框宿主 + 独立工具页 + init/apply/theme 协议 + 新节点带 adjust 参数。
 * 只读源码 / 构建产物做断言，不需要跑浏览器。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { checkStaticCacheVersions } = require('./static-cache-version');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui';

/* ---------- 工具条入口：重打光 → 调色 → 无损改图 → 更多 ---------- */
const gen = read(ui + '/GenPanel.tsx');
const imgRow = gen.split('\n').find((l) => l.includes('B("crop"') && l.includes('B("more"'));
assert(imgRow, '找到图片节点工具条那一行');
assert(imgRow.includes('B("adjust", "palette", "调色")'), '工具条有「调色」按钮（palette 线性图标）');
assert(imgRow.indexOf('"relight"') < imgRow.indexOf('"adjust"'), '调色排在「重打光」之后');
assert(imgRow.indexOf('"adjust"') < imgRow.indexOf('"lossless"'), '调色排在「无损改图」之前');

/* ---------- registry / Editors 接线 ---------- */
const reg = read(ui + '/editors/registry.tsx');
assert(reg.includes('from "./ColorAdjust"'), 'registry 引入 ColorAdjust');
assert(reg.includes('if (kind === "adjust") return openColorAdjust(id);'), 'cn:editor 的 adjust 路由到 openColorAdjust');
const route = reg.slice(reg.indexOf('kind === "adjust"'), reg.indexOf('kind === "adjust"') + 120);
assert(!route.includes('openModal'), '调色不进 openModal（有自己的对话框 + Esc）');
const editors = read(ui + '/Editors.tsx');
assert(editors.includes('ColorAdjustLayer'), 'Editors 里渲染 ColorAdjustLayer');
assert(editors.includes('<EditorLayer /><LosslessEditLayer /><ColorAdjustLayer />'), 'EditorLayer / Lossless / ColorAdjust 并排挂载');

/* ---------- 工具页：复用旧智能画布的三件套，只补基样式 ---------- */
const page = read('static/tools/image-adjust/index.html');
assert(page.includes('id="imageEditModal"'), '工具页有 #imageEditModal（editor 的 watchModal 依赖）');
assert(page.includes('class="image-edit-modal open"'), '#imageEditModal 常驻 open');
assert(page.includes('id="imageEditStage"') && page.includes('class="image-edit-stage"'), '有 #imageEditStage.image-edit-stage');
assert(page.includes('id="cropCanvas"') && page.includes('crop-canvas adjust-mode'), '#cropCanvas 是 adjust-mode');
assert(page.includes('id="cropImage"'), '#cropImage 存在（editor 顶部按它判断能不能跑）');
assert(page.includes('src="/static/js/image-adjust-engine.js"'), '原样引用 image-adjust-engine.js');
assert(page.includes('src="/static/js/image-adjust-editor.js"'), '原样引用 image-adjust-editor.js');
assert(page.includes('href="/static/css/image-adjust.css"'), '原样引用 image-adjust.css');
assert(!page.includes('NovaAdjustEngine = {'), '不复制引擎代码（只引用）');
/* editor 需要的基样式 */
for (const sel of ['.image-edit-stage{', '.image-edit-stage-inner{', '.crop-canvas{', '.crop-canvas img{',
  '.crop-canvas.adjust-mode .image-edit-canvas-adjust{', '.image-edit-canvas-adjust{', '.adjust-row{',
  '.image-edit-tools{']) {
  assert(page.includes(sel), '工具页补了基样式 ' + sel);
}
assert(!page.includes('adjust-compare-divider'), '工具页不再带旧的拖动对比分割线样式（对比已改成图片右下角按钮）');
/* 竖图不被裁：图片区上下各 24 内边距，max-height 必须比视口少 48px */
{
  const imgRule = (page.match(/\.crop-canvas img\{[^}]*\}/) || [''])[0];
  assert(imgRule, '工具页有 .crop-canvas img 规则');
  assert(/max-height:calc\(100vh - 48px\)/.test(imgRule), '竖图 max-height = 100vh - 48px（上下各 24 内边距）');
  assert(!/max-height:calc\(100vh - (24|64)px\)/.test(imgRule), '不再用旧的 -64 / -24');
  const inner = (page.match(/\.image-edit-stage-inner\{[^}]*\}/) || [''])[0];
  assert(/padding:24px/.test(inner) && /display:flex/.test(inner) && /align-items:center/.test(inner) && /justify-content:center/.test(inner), '图片区四周 24 内边距 + flex 水平垂直居中');
}
/* 亮 / 暗 token */
for (const tok of ['--text:', '--muted:', '--faint:', '--soft:', '--card:', '--surface-2:', '--strong:',
  '--strong-text:', '--overlay:', '--border-2:', '--radius-sm:', '--radius-full:', '--space-3:',
  '--shadow-md:', '--font:', '--font-mono:', '--text-sm:', '--panel:']) {
  assert(page.includes(tok), '工具页定义了 token ' + tok);
}
assert(page.includes('html[data-theme="dark"]'), '暗色 token 走 html[data-theme="dark"]');
assert(page.includes('overflow:hidden'), '工具页不滚动');
{
  const base = (page.match(/html,body\{[^}]*\}/) || [''])[0];
  assert(base, '工具页有 html,body 基样式');
  assert(/background:var\(--beat-panel, var\(--panel\)\)/.test(base), 'html/body 用宿主 --beat-panel（退回本页 --panel 实底）');
  assert(!/background:transparent/.test(base), 'html/body 不再透明');
  const lightPanel = (page.match(/:root\{[^}]*\}/) || [''])[0];
  const darkPanel = (page.match(/html\[data-theme="dark"\]\{[^}]*\}/) || [''])[0];
  assert(/--panel:#fbfbfc/.test(lightPanel), '亮色 --panel #fbfbfc（与宿主 .ie-frame 一致）');
  assert(/--panel:#0e0e0f/.test(darkPanel), '暗色 --panel #0e0e0f（与宿主 .ie-frame 一致）');
}

/* ---------- 工具页协议 / window.imageAdjust 适配 ---------- */
assert(page.includes("'novai-image-adjust'") && page.includes("'novai-image-adjust-host'"), '双向 postMessage 的 source');
for (const t of ['ready', 'init', 'apply', 'theme', 'result', 'error']) {
  assert(page.includes("'" + t + "'"), '协议里有 ' + t + ' 消息');
}
assert(page.includes('window.imageAdjust'), '提供 window.imageAdjust 适配对象');
for (const api of ['currentSource', 'upload', 'addResult', 'finish']) {
  assert(page.includes(api + ':'), '工具页实现 imageAdjust.' + api);
}
assert(page.includes('window.imageAdjustEnterMode()'), 'init 后调用 window.imageAdjustEnterMode');
assert(page.includes('window.applyImageAdjust()'), 'apply 后调用 window.applyImageAdjust');
assert(page.includes('调色引擎未加载') && page.includes('原图加载失败') && page.includes('调色导出失败'), 'engine 缺失 / 图裂 / apply 失败都出声');
assert(page.includes('type: \'result\''), '把导出结果 post 回宿主');

/* ---------- 宿主 ColorAdjust.tsx ---------- */
const ca = read(ui + '/editors/ColorAdjust.tsx');
assert(ca.includes('"/static/tools/image-adjust/index.html"'), '宿主加载调色工具页');
assert(ca.includes('?embed=1&theme='), 'iframe 带 embed=1 与 theme');
assert(ca.includes('const themeMsg = () =>') && ca.includes('panel: pick("--bg"') && ca.includes('raised: pick("--raised"'), 'theme 消息带宿主 --bg / --raised（图片区跟 --bg、面板跟 --raised）');
assert(ca.includes('/^https?:$/.test(location.protocol) ? location.origin : "*"'), 'targetOrigin 规则同无损改图');
assert(ca.includes('"novai-image-adjust-host"') && ca.includes('"novai-image-adjust"'), '宿主侧 source 常量');
assert(ca.includes('APPLY_TIMEOUT_MS = 60000'), '等结果超时 60s');
assert(ca.includes('{ type: "init", src:'), '打开时发 init 传图');
assert(ca.includes('{ type: "apply" }'), '应用时发 apply');
assert(ca.includes('resolveAsset'), 'openarc-asset: 先解析成 iframe 能 fetch 的地址');
assert(ca.includes('genOf(n).adjust'), '节点带 adjust 时按「原图 + 参数」继续');
assert(ca.includes('meta.source.url'), '再次编辑时用 adjust.source.url 当原图');
assert(ca.includes('importAsset(store.state.canvasId, dataUrl, name)'), '结果走 backend.importAsset 上传');
assert(ca.includes('title: "调色"'), '新节点标题「调色」');
assert(ca.includes('adjust: AdjustMeta = { v: 2, source: { url: src.saveUrl, name: src.name }, params: res.params }'), '新节点带 adjust（v2 + compact 源图 + 参数）');
assert(ca.includes('fitMediaBox(live.w, w, h)'), '新节点按真实像素摆正');
assert(ca.includes('addNodes([made], [{ id: uid("e"), from: live.id, to: made.id }], { select: true })'), 'addNodes + 连线 + 选中');
assert(ca.includes('compressForUpload(res.dataUrl'), '45MB 压缩复用抽出的 helper');
assert(ca.includes('调色结果较大，已自动压缩后应用'), '压缩后提示');
assert(ca.includes('调色完成，已生成新节点'), '成功提示');
assert(ca.includes('调色失败：'), '失败要出声且保留对话框');
assert(ca.includes('"正在应用…" : "应用"'), '主按钮文案统一为「应用」（busy 时「正在应用…」）');
{
  const head = ca.slice(ca.indexOf('className="ie-head"'), ca.indexOf('className="ie-body"'));
  assert(!head.includes('ie-apply') && !head.includes('data-ca="apply"'), '头部不再有应用按钮');
  assert(ca.includes('disabled={!ready || !inited || busy}'), '按钮禁用沿用 ready + init 完成 + busy');
  const body = ca.slice(ca.indexOf('className="ie-body"'), ca.indexOf('className="ie-body"') + 1200);
  assert(body.indexOf('className="ie-frame"') < body.indexOf('className="ie-apply"'), '应用按钮在 iframe 之后（浮窗正下方）');
}
assert(ca.includes('busyRef'), '防重复点击');
assert(ca.includes('className="ie-dialog ca"'), '调色用共用对话框外壳（.ie-dialog.ca）');
assert(ca.includes('className="ie-scrim"'), '有半透明遮罩');
assert(ca.includes('if (e.target === e.currentTarget) setCa(null)'), '点遮罩关闭');
assert(ca.includes('layerRef.current?.focus({ preventScroll: true })'), '焦点先收到宿主（Esc 才收得到）');
assert(ca.includes('addEventListener("keydown", onKey, true)'), 'capture keydown 阻断画布快捷键');
assert(ca.includes('setTimeout(() => setStalled(true), 10000)'), '10s 未 ready 给加载失败提示');
assert(ca.includes('removeEventListener("message", onMessage)'), '卸载时移除 message 监听');

/* ---------- model.ts：GenData.adjust + genOf 透传 ---------- */
const model = read('novai-canvas-ui/src/canvas/canvas-next/model.ts');
assert(model.includes('adjust?: { v: 2; source: { url: string; name: string }; params: unknown };'), 'GenData 增加可选 adjust 字段');
assert(model.includes('raw.adjust && typeof raw.adjust === "object"'), 'genOf 透传 adjust（否则保存后丢失）');

/* ---------- BEAT 外观：窗底统一 + 右侧调色面板浮窗 ---------- */
assert(page.includes("setProperty('--beat-panel'") && page.includes("setProperty('--beat-raised'"), 'theme 消息里写 --beat-panel / --beat-raised');
assert(page.includes('background:var(--beat-panel, var(--panel))'), 'html/body 窗底用宿主 --beat-panel');
const toolsRule = (page.match(/\.image-adjust-tools\.iaj\{[^}]*\}/) || [''])[0];
assert(toolsRule, '有 .image-adjust-tools.iaj 面板规则');
assert(/width:400px !important/.test(toolsRule) && /flex: 0 0 400px !important/.test(toolsRule), '右侧面板宽 400（贴边分栏）');
assert(/margin:0 !important/.test(toolsRule), '面板贴死对话框右边缘：无外边距');
assert(/\.adjust-row\.iaj-row\{gap:0/.test(page), '图片区与面板之间不留缝（靠 --bg / --raised 底色差分隔）');
assert(!/\.adjust-row\.iaj-row\{gap:(12|18)px/.test(page), '不再用浮窗时代的 12px / 18px 行间距');
assert(/border-radius:0 !important/.test(toolsRule), '贴边面板无圆角');
assert(/background:var\(--beat-raised/.test(toolsRule), '面板底色用宿主 --beat-raised');
assert(/box-shadow:none !important/.test(toolsRule), '贴边面板无投影');
assert(/border:0 !important/.test(toolsRule), '面板不画边框');
assert(/padding:16px 16px 72px !important/.test(toolsRule), '面板内边距统一 16、底部预留 72px 给主按钮');
assert(!/position:relative/.test(toolsRule) && !/z-index/.test(toolsRule), '贴边结构不需要 position/z-index（浮窗时代的抬层已删）');
assert(/overflow:hidden !important/.test(toolsRule) && /box-sizing:border-box !important/.test(toolsRule), '面板裁内容、宽度含内边距');

/* ---------- 共用压缩 helper ---------- */
const up = read(ui + '/editors/largeUpload.ts');
assert(up.includes('MAX_UPLOAD_BYTES = 45 * 1024 * 1024'), '45MB 上限');
assert(up.includes('CANVAS_MAX_SIDE = 16384') && up.includes('CANVAS_MAX_PIXELS = 260000000'), '避开 canvas 尺寸上限');
assert(up.includes('export async function compressForUpload'), '导出 compressForUpload');
assert(read(ui + '/editors/LosslessEdit.tsx').includes('from "./largeUpload"'), '无损改图也用同一份 helper');

/* ---------- 样式：调色 860 宽，与无损改图共用外壳 ---------- */
const css = read(ui + '/editors/editors.css');
const caDialog = (css.match(/\.cn-root \.ie-dialog\.ca\{[^}]*\}/) || [''])[0];
assert(caDialog, 'editors.css 有 .ie-dialog.ca');
assert(/width:calc\(100vw - 32px\)/.test(caDialog), '调色对话框铺满：宽 calc(100vw - 32px)（四周 16）');
assert(/height:calc\(100vh - 32px\)/.test(caDialog), '调色对话框铺满：高 calc(100vh - 32px)');
assert(!/border:|inset 0 0 0 1px/.test((css.match(/\.cn-root \.ie-dialog\{[^}]*\}/) || [''])[0]), '对话框不用 border / 发丝线');
assert(/background:var\(--panel\)/.test((css.match(/\.cn-root \.ie-dialog\{[^}]*\}/) || [''])[0]), '对话框用 var(--panel) 实底（头部不透出画布）');
const frameRule = (css.match(/\.cn-root \.ie-frame\{[^}]*\}/) || [''])[0];
assert(frameRule, 'editors.css 有 .ie-frame');
assert(/background:var\(--bg\)/.test(frameRule), 'iframe 用宿主 --bg（图片区底色，浅 #f2f2f4 / 深 #000）');
assert(!/background:transparent/.test(frameRule), 'iframe 不再透明');
const caApply = (css.match(/\.cn-root \.ie-apply\{[^}]*\}/) || [''])[0];
assert(caApply, 'editors.css 有 .ie-apply');
assert(/right:16px/.test(caApply) && /bottom:16px/.test(caApply) && /height:40px/.test(caApply), '应用按钮在面板内：离右 16 / 下 16、高 40');
assert(/width:368px/.test(caApply), '应用按钮宽 368（面板 400 - 左右各 16）');
assert(/border-radius:12px/.test(caApply), '应用按钮圆角 12');
assert(/background:var\(--solid\)/.test(caApply) && /color:var\(--on-solid\)/.test(caApply), '应用按钮 solid 实底');
assert(!css.includes('.ie-dialog.ca .ie-apply'), '不再有 .ca 单独宽度覆盖（调色/无损共用同一个主按钮）');
assert(/\.cn-root\[data-theme=light\] \.ie-dialog\{background:var\(--bg\);\}/.test(css), '浅色下对话框底用 --bg；深色留在 --panel 与遮罩分开');

/* ---------- 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.js');
assert(built.includes('调色'), '构建产物里有「调色」');
assert(built.includes('/static/tools/image-adjust/index.html'), '构建产物里有调色工具页地址');
assert(built.includes('novai-image-adjust-host') && built.includes('novai-image-adjust'), '构建产物里有调色协议 source');
assert(built.includes('调色完成，已生成新节点'), '构建产物里有调色成功提示');
assert(built.includes('调色结果较大，已自动压缩后应用'), '构建产物里有调色压缩提示');
const builtCss = read('static/novai-canvas/canvas.css');
assert(builtCss.includes('.ie-dialog.ca'), '构建产物 CSS 带调色对话框尺寸');
const builtFrame = (builtCss.match(/\.ie-frame\{[^}]*\}/) || [''])[0];
assert(/background:var\(--bg\)/.test(builtFrame), '构建产物 CSS 的 .ie-frame 有 --bg');
assert(/width:calc\(100vw - 32px\)/.test(builtCss), '构建产物 CSS 里对话框已是铺满尺寸');
assert(/\.ie-apply\{[^}]*right:16px/.test(builtCss) && /\.ie-apply\{[^}]*width:368px/.test(builtCss), '构建产物 CSS 里主按钮已是面板内 368×40 / 右 16 下 16');

/* ---------- 入口版本号（两处一致，防浏览器拿旧缓存） ---------- */
const html = read('static/canvas.html');
const vers = [...html.matchAll(/novai-canvas\/(?:canvas\.css|canvas\.js)\?v=([0-9.]+)/g)].map((m) => m[1]);
assert.strictEqual(vers.length, 2, 'canvas.html 里 css / js 各一处 ?v=');
const cache = checkStaticCacheVersions({ root, page: 'static/canvas.html' });
assert.ok(cache.ok, 'canvas.html 的 ?v= 满足：VERSION 前缀 / 10 位 mtime / 无裸链接 / 多处一致' + (cache.problems.length ? '：' + cache.problems.join('；') : ''));
assert.ok(cache.refs.has('/static/novai-canvas/canvas.css') && cache.refs.has('/static/novai-canvas/canvas.js'), 'css / js 两处 ?v= 都在：' + vers.join(' / '));

console.log('[PASS] 图片节点「调色」：入口 / 共用对话框 / 工具页 DOM 与协议 / init·apply / adjust 参数 / 45MB 压缩 / 构建产物');