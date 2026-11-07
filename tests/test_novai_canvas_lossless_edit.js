#!/usr/bin/env node
'use strict';
/**
 * 智能画布BEAT（canvas-next）图片节点的「无损改图」：工具条入口 + 居中编辑对话框 + 工具页 postMessage 协议
 * + 素材槽选择器 + 45MB 压缩 + 新节点连线 + 构建产物。
 * 只读源码 / 构建产物做断言，不需要跑浏览器。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui';

/* ---------- 工具条入口 ---------- */
const gen = read(ui + '/GenPanel.tsx');
const imgRow = gen.split('\n').find((l) => l.includes('B("crop"') && l.includes('B("more"'));
assert(imgRow, '找到图片节点工具条那一行');
assert(imgRow.includes('B("lossless", "layers", "无损改图")'), '工具条有「无损改图」按钮（layers 线性图标）');
assert(imgRow.indexOf('"relight"') < imgRow.indexOf('"lossless"'), '无损改图排在「重打光」之后');
assert(imgRow.indexOf('"lossless"') < imgRow.indexOf('"more"'), '无损改图排在「更多」之前');

/* ---------- 路由：走全屏编辑层，不进 openModal ---------- */
const reg = read(ui + '/editors/registry.tsx');
assert(reg.includes('from "./LosslessEdit"'), 'registry 引入 LosslessEdit');
assert(reg.includes('if (kind === "lossless") return openLosslessEdit(id);'), 'cn:editor 的 lossless 路由到 openLosslessEdit');
const losslessRoute = reg.slice(reg.indexOf('kind === "lossless"'), reg.indexOf('kind === "lossless"') + 120);
assert(!losslessRoute.includes('openModal'), '无损改图不进 openModal（Esc 会和素材槽选择器打架）');

const editors = read(ui + '/Editors.tsx');
assert(editors.includes('LosslessEditLayer'), 'Editors 里渲染 LosslessEditLayer');
assert(editors.includes('<EditorLayer /><LosslessEditLayer />'), '<EditorLayer /> 旁挂 <LosslessEditLayer />');

/* ---------- 编辑层：iframe / 协议 / 排队 / 主题 ---------- */
const le = read(ui + '/editors/LosslessEdit.tsx');
assert(le.includes('"/static/tools/lossless-edit/index.html"'), 'iframe 指向本地内置工具页');
assert(le.includes('?embed=1&beat=1&theme='), 'iframe 带 embed=1 / beat=1 / theme 参数');
assert(!/index\.html[^"']*\borig=/.test(le), '图片不走 iframe 的 query（合成图是 data URL，会超长）');
assert(le.includes('encodeURIComponent'), 'theme 进 iframe 前编码');
assert(le.includes('"novai-lossless-edit-host"') && le.includes('"novai-lossless-edit"'), '双向 postMessage 的 source 常量');
for (const t of ['prefill', 'request-result', 'pick-result', 'pick-cancel', 'ready', 'result', 'error', 'pick-request']) {
  assert(le.includes('"' + t + '"') || le.includes("'" + t + "'"), '协议里有 ' + t + ' 消息');
}
assert(le.includes('theme-changed'), '工具侧 theme-changed 有处理（不反写画布主题）');
assert(le.includes('d.source !== TOOL_SRC') && le.includes('e.source !== frameRef.current.contentWindow'), '只认本 iframe 发来 + 工具方 source 的消息');
assert(le.includes('/^https?:$/.test(location.protocol) ? location.origin : "*"'), 'targetOrigin：http(s) 锁 location.origin，其余退 *');
assert(le.includes('readyRef') && le.includes('queueRef') && le.includes('q.forEach'), 'ready 之前排队，ready 后按顺序发');
assert(le.includes('onLoad={() => { loadedRef.current = true; post(themeMsg())'), 'iframe load 后补发 theme（带宿主底色）');
assert(le.includes('kick();'), 'iframe load 后补发 prefill');
assert(le.includes('useState(() => TOOL_PAGE'), 'iframe 地址只算一次（改 theme 不能让 iframe 重载）');

/* ---------- 预填：ai = 当前结果；唯一一条图片入边才当 orig ---------- */
assert(le.includes('const aiRaw = outOf(n)?.url || ""'), 'ai 预填本节点当前结果');
assert(le.includes('ins.length === 1 && ins[0].node.kind === "image"'), '只有恰好一条来自图片节点的入边才带 orig');
assert(le.includes('{ type: "prefill", reset: true }'), 'prefill 带 reset:true（换图时清掉没提供的槽位）');
assert(le.includes('isAssetRef') && le.includes('resolveAsset'), '资源引用（新 novai-asset: / 旧 openarc-asset:）先 resolveAsset 成 iframe 能 fetch 的地址');
assert(le.includes('if (s.orig) msg.orig = s.orig;') && le.includes('if (s.ai) msg.ai = s.ai;'), '空槽不发 prefill 字段（让用户在工具里自己选）');

/* ---------- 素材槽选择器（工具里点槽位必须有反应） ---------- */
assert(le.includes('if (d.type === "pick-request") { setPick(d.slot === "ai" ? "ai" : "orig"); return; }'), 'pick-request 弹宿主选择器');
assert(le.includes('n.kind === "image" && !!outOf(n)?.url'), '选择器列出画布上所有有图的图片节点');
assert(le.includes('useAssetUrl'), '缩略图走 useAssetUrl（资源引用也能显示）');
assert(le.includes('搜索节点标题'), '选择器带搜索');
assert(le.includes('accept="image/*"') && le.includes('readAsDataURL'), '支持上传本地图片（FileReader → data URL）');
assert(le.includes('type: "pick-result", slot: pick, url, name'), '选中后回 pick-result（含 slot/url/name）');
assert(le.includes('type: "pick-cancel"'), '取消回 pick-cancel');
assert(le.includes('className="le-pick"'), '选择器浮在 iframe 之上');

/* ---------- 应用：请求结果 → 压缩 → 上传 → 新节点连线 ---------- */
assert(le.includes('APPLY_TIMEOUT_MS = 30000'), '等结果超时 30s');
assert(le.includes('"正在应用…" : "应用"'), '主按钮文案统一为「应用」（busy 时「正在应用…」）');
{
  const head = le.slice(le.indexOf('className="ie-head"'), le.indexOf('className="ie-body"'));
  assert(!head.includes('ie-apply') && !head.includes('data-le="apply"'), '头部不再有应用按钮');
  const body = le.slice(le.indexOf('className="ie-body"'), le.indexOf('className="ie-body"') + 1200);
  assert(body.indexOf('className="ie-frame"') < body.indexOf('className="ie-apply"'), '应用按钮在 iframe 之后（浮窗正下方）');
  assert(le.includes('data-le="apply"'), '按钮仍走同一个 apply()');
}
assert(le.includes('busyRef'), '防重复点击');
assert(le.includes('无损改图失败：'), '失败要出声');
assert(le.includes('importAsset(store.state.canvasId, dataUrl, name)'), '结果走 backend.importAsset 上传（NOVAI 适配器 → /api/ai/upload-base64）');
assert(le.includes('fitMediaBox(live.w, w, h)'), '新节点按真实像素摆正');
assert(le.includes('store.newNode("image"'), '结果建成新的图片节点');
assert(le.includes('title: "无损改图"'), '新节点标题「无损改图」');
assert(le.includes('hist: [{ url, w, h }]'), '新节点带上结果版本');
assert(le.includes('addNodes([made], [{ id: uid("e"), from: live.id, to: made.id }], { select: true })'), 'addNodes + 连线 + 选中');

/* ---------- 45MB 上传保护：逻辑抽到 largeUpload.ts，无损改图与调色共用 ---------- */
const up = read(ui + '/editors/largeUpload.ts');
assert(up.includes('MAX_UPLOAD_BYTES = 45 * 1024 * 1024'), '45MB 上限');
assert(up.includes('CANVAS_MAX_SIDE = 16384') && up.includes('CANVAS_MAX_PIXELS = 260000000'), '避开单边 16384 / 2.6 亿像素 canvas 上限');
assert(up.includes('push("image/png"') && up.includes('push("image/jpeg", maxSide, true)'), 'PNG 优先保透明，压不下来再白底 JPEG');
assert(up.includes('export async function compressForUpload'), '导出 compressForUpload 供两个对话框共用');
assert(le.includes('from "./largeUpload"') && le.includes('compressForUpload(res.dataUrl'), '无损改图复用抽出的压缩 helper');
assert(le.includes('原图较大，已自动压缩后应用'), '压缩后提示');

/* ---------- 对话框外壳（和调色共用 .ie-*）：遮罩 + 头部 + iframe 主体 ---------- */
assert(le.includes('className="ie-scrim"'), '有半透明遮罩层');
assert(le.includes('className="ie-dialog le"'), '居中对话框（.ie-dialog.le）');
assert(le.includes('className="ie-head"') && le.includes('className="ie-body"'), '头部 / 主体结构');
assert(le.includes('className="ie-frame"'), 'iframe 铺满主体');
assert(le.includes('if (e.target === e.currentTarget) setLe(null)'), '点遮罩关闭对话框');

/* ---------- 生命周期 / 键盘 ---------- */
assert(le.includes('addEventListener("keydown", onKey, true)'), '编辑层用 capture keydown 阻断画布快捷键');
assert(le.includes('if (pickRef.current) { setPick(null); return; }'), 'Esc：选择器开着先关选择器');
assert(le.includes('setLe(null)'), 'Esc / 关闭按钮关编辑层');
assert(le.includes('removeEventListener("message", onMessage)'), '卸载时移除 message 监听');
assert(up.includes('revokeObjectURL'), '压缩只临时建 objectURL，用完即释放');

/* ---------- F1：焦点在 iframe 里时，宿主也得能收到 Esc ---------- */
assert(le.includes('ref={layerRef} tabIndex={-1}'), '编辑层容器可聚焦（tabIndex=-1）');
assert(le.includes('layerRef.current?.focus({ preventScroll: true })'), '打开时把焦点收回宿主（iframe 里的按键传不到宿主）');
assert(le.includes('if (!pick) layerRef.current?.focus'), '选择器关掉（取消 / 遮罩 / 选中）后焦点回到层');
assert(le.includes('const panelRef = useRef<HTMLDivElement>(null)'), '选择器面板有 ref');
assert(le.includes('ref={panelRef} tabIndex={-1}'), '选择器面板可聚焦（tabIndex=-1）');
assert(le.includes('panelRef.current?.focus({ preventScroll: true })'), '选择器一开就把焦点抢到面板，Esc 才能先关选择器');

/* ---------- F3：工具页加载失败要看得出来（不自动关层） ---------- */
assert(le.includes('setTimeout(() => setStalled(true), 10000)'), '10s 仍未 ready 判定为加载失败');
assert(le.includes('工具加载失败，请关闭后重试'), '失败提示文案');
assert(le.includes('stalled ? "工具加载失败，请关闭后重试" : "无损改图工具加载中…"'), '失败后提示替换「加载中」，ready 后恢复');

/* ---------- 主题联动 ---------- */
assert(le.includes('useS((s) => s.ui.theme)') && le.includes('[theme, ready]'), 'watch 画布主题，变化时给工具发 theme');
assert(le.includes('const themeMsg = () =>') && le.includes('panel: pick("--bg"') && le.includes('raised: pick("--raised"'), 'theme 消息带宿主 --bg / --raised（图片区跟 --bg、面板跟 --raised）');

/* ---------- BEAT 外观：窗底统一 + 右侧浮窗（只对带 beat=1 的宿主生效） ---------- */
const llPage = read('static/tools/lossless-edit/index.html');
assert(llPage.includes("params.get('beat') === '1'") && llPage.includes("dataset.beat = '1'"), 'beat=1 时给 html 打 data-beat');
assert(/html\[data-beat\], html\[data-beat\] body \{[^}]*background: var\(--beat-panel/.test(llPage), '窗底（html/body）用宿主 --beat-panel');
assert(/html\[data-beat\] \.stage \{[^}]*var\(--beat-panel/.test(llPage), '舞台底色也用 --beat-panel（和头部/窗口一致）');
const beatPanel = (llPage.match(/html\[data-beat\]\.embed \.panel \{[^}]*\}/) || [''])[0];
assert(beatPanel, '有 html[data-beat].embed .panel 贴边面板规则');
assert(/flex: 0 0 400px/.test(beatPanel) && /width: 400px/.test(beatPanel), '面板宽 400（贴边分栏）');
assert(/margin: 0;/.test(beatPanel), '面板贴死对话框右边缘：无外边距');
assert(!/margin: 12px;/.test(beatPanel) && !/margin: 16px 28px 64px 12px/.test(beatPanel), '不再用浮窗时代的 margin');
assert(/border-radius: 0;/.test(beatPanel), '贴边面板无圆角');
assert(/background: var\(--beat-raised/.test(beatPanel), '面板底色用宿主 --beat-raised');
assert(/box-shadow: none;/.test(beatPanel), '贴边面板无投影');
assert(/border: 0/.test(beatPanel) && !/border-left:/.test(beatPanel), '面板不画边框（不用 border 表达层级）');
assert(/overflow: hidden/.test(beatPanel) && /align-self: stretch/.test(beatPanel), '面板裁内容、撑满高度');
assert(/padding-bottom: 72px;/.test(beatPanel), '面板底部预留 72px 给宿主主按钮');
assert(!/position: relative;/.test(beatPanel) && !/z-index/.test(beatPanel), '贴边结构不需要 position/z-index（浮窗时代的抬层已删）');
assert(/html\[data-beat\]\.embed \.panel-body \{ padding: 16px; \}/.test(llPage), '面板滚动区内边距统一 16');
assert(/html\[data-beat\]\.embed \.panel-bottom \{ padding: 16px; border-top: 0; \}/.test(llPage), '导出区内边距 16、不画发丝线');
assert(/html\[data-beat\]\.embed #btnExportPng \{[^}]*background: rgba\(0, 0, 0, \.06\)/.test(llPage), '「合成 PNG」降为浅底次要按钮（应用是唯一主按钮）');
assert(/html\[data-theme="dark"\]\[data-beat\]\.embed #btnExportPng \{ background: rgba\(255, 255, 255, \.08\)/.test(llPage), '深色下「合成 PNG」用 8% 白浅底');
assert(llPage.includes("document.documentElement.dataset.beat === '1' ? 48"), 'fitView：BEAT 贴边分栏下图片四周留白 24（pad=48，四边相等）');
assert(llPage.includes("data.type === 'theme'") && llPage.includes("setProperty('--beat-panel'") && llPage.includes("setProperty('--beat-raised'"), '工具页 theme 消息里写 --beat-panel / --beat-raised');

/* ---------- 样式：共用居中对话框外壳（无损改图 960 宽）+ 选择器 ---------- */
const css = read(ui + '/editors/editors.css');
const scrimRule = (css.match(/\.cn-root \.ie-scrim\{[^}]*\}/) || [''])[0];
assert(scrimRule, 'editors.css 有共用的 .ie-scrim 遮罩');
assert(/background:rgba\(0,0,0,\.5\)/.test(scrimRule), '遮罩是半透明黑底（同其它弹窗）');
const dialogRule = (css.match(/\.cn-root \.ie-dialog\{[^}]*\}/) || [''])[0];
assert(dialogRule, 'editors.css 有共用的 .ie-dialog');
assert(!/border:|inset 0 0 0 1px/.test(dialogRule), '对话框不用 border / 发丝线表达层级');
assert(/background:var\(--panel\)/.test(dialogRule), '对话框用 var(--panel) 实底（头部不透出画布）');
assert(!/background:var\(--modal\)/.test(dialogRule), '不再用 70% 玻璃的 --modal（头部会透底）');
assert(/border-radius:18px/.test(dialogRule) && /box-shadow:/.test(dialogRule), '圆角 18 + 柔和投影');
const leDialog = (css.match(/\.cn-root \.ie-dialog\.le\{[^}]*\}/) || [''])[0];
assert(leDialog, '无损改图有 .ie-dialog.le 尺寸');
assert(/width:calc\(100vw - 32px\)/.test(leDialog), '铺满：宽 calc(100vw - 32px)（四周 16）');
assert(/height:calc\(100vh - 32px\)/.test(leDialog), '铺满：高 calc(100vh - 32px)');
assert(/\.cn-root \.le-pick-panel\{[^}]*background:var\(--glass-bg\)/.test(css) && /\.le-pick-panel\{[^}]*backdrop-filter:var\(--glass-blur\)/.test(css), '选择器用磨砂玻璃');
assert(css.includes('.cn-root .ie-dialog:focus,.cn-root .le-pick-panel:focus{outline:none;'), '程序化聚焦的容器不出焦点描边');

/* ---------- 窄 iframe（<=900 宽）的紧凑空状态：两张卡竖排、不横向溢出；960 宽（>=890）不生效 ---------- */
const losslessPage = read('static/tools/lossless-edit/index.html');
const narrow = (losslessPage.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/) || [''])[0];
assert(narrow, '无损工具页有窄 iframe 的紧凑样式（@media max-width:900px）');
assert(!/@media \(max-width: 720px\)/.test(losslessPage), '阈值抬到 900，避免 721~895 的中间宽度又裁');
const nrule = (sel) => (narrow.match(new RegExp('html\\.embed \\.' + sel + '\\s*\\{[^}]*\\}')) || [''])[0];
assert(/padding: 12px/.test(nrule('stage-empty')), '窄宽度下空状态 padding 收到 12px');
assert(/flex-direction: column/.test(nrule('empty-cards')) && /gap: 8px/.test(nrule('empty-cards')), '两张卡改成竖排、gap 8px');
assert(/display: none/.test(nrule('pick-join')), '竖排时隐藏中间的 + 号');
assert(/width: min\(220px, 100%\)/.test(nrule('pick-card')) && /height: 112px/.test(nrule('pick-card')), '.pick-card 收成 min(220px,100%) × 112px');
assert(/html\.embed \.empty-brand b \{ font-size: 17px/.test(narrow) || /html\.embed \.empty-brand b/.test(narrow), '空状态标题字号略缩');
const selLines = narrow.split('\n').filter((l) => l.includes('{') && !l.trim().startsWith('@media'));
assert(selLines.length >= 4 && selLines.every((l) => l.includes('html.embed ')), '紧凑规则只作用于嵌入模式（html.embed 前缀）');
assert(!narrow.includes('html:not(.embed)'), '不影响非嵌入模式');

/* ---------- 主按钮「应用」：浮窗正下方、右/下 12px、与浮窗同宽 ---------- */
const applyRule = (css.match(/\.cn-root \.ie-apply\{[^}]*\}/) || [''])[0];
assert(applyRule, 'editors.css 有 .ie-apply');
assert(/right:16px/.test(applyRule) && /bottom:16px/.test(applyRule), '应用按钮在面板内：离右 16 / 下 16');
assert(/height:40px/.test(applyRule) && /width:368px/.test(applyRule), '应用按钮高 40、宽 368（面板 400 - 左右各 16）');
assert(/background:var\(--solid\)/.test(applyRule) && /color:var\(--on-solid\)/.test(applyRule), '应用按钮 solid 实底 + on-solid 文字');
assert(/z-index:4/.test(applyRule), '应用按钮压在 iframe 之上');
assert(!css.includes('.ie-dialog.ca .ie-apply'), '不再有 .ca 单独宽度覆盖（唯一主按钮）');

/* ---------- 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.js');
assert(built.includes('无损改图'), '构建产物里有「无损改图」');
assert(built.includes('/static/tools/lossless-edit/index.html'), '构建产物里有工具页地址');
assert(built.includes('novai-lossless-edit-host') && built.includes('novai-lossless-edit'), '构建产物里有协议 source');
assert(built.includes('?embed=1&beat=1&theme='), '构建产物里 iframe 带 embed=1 / beat=1');
assert(built.includes('原图较大，已自动压缩后应用'), '构建产物里有压缩提示');
assert(built.includes('工具加载失败，请关闭后重试'), '构建产物里有加载失败提示');
const builtCss = read('static/novai-canvas/canvas.css');
assert(builtCss.includes('.ie-dialog') && builtCss.includes('.ie-dialog.le') && builtCss.includes('.le-pick-panel'), '构建产物 CSS 带对话框与选择器样式');

/* ---------- 入口版本号（两处一致，防浏览器拿旧缓存） ---------- */
const html = read('static/canvas.html');
const vers = [...html.matchAll(/novai-canvas\/(?:canvas\.css|canvas\.js)\?v=([0-9.]+)/g)].map((m) => m[1]);
assert.strictEqual(vers.length, 2, 'canvas.html 里 css / js 各一处 ?v=');
assert.strictEqual(vers[0], vers[1], 'css / js 的 ?v= 一致');
assert(/^1\.0\.143\.\d{10}$/.test(vers[0]), '?v= 形如 1.0.143.<unix 秒>：' + vers[0]);

console.log('[PASS] 图片节点「无损改图」：入口 / 居中对话框 / 协议 / 选择器 / 45MB 压缩 / 新节点连线 / 构建产物');