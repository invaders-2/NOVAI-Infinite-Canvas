#!/usr/bin/env node
'use strict';
/*
 * 首页「所有入口」→ 智能画布BEAT 全链路静态回归。
 *
 * 覆盖真实行为点：
 *   1. HomePage.vue 的四个入口（输入框发送 submit / 快速开始 quickStart / 模板 useTemplate / 最近项目 openProject）
 *      全部传 ctx:'beat'：建 kind:'classic' + icon:'🧩' 的画布、种子带 renderer:'beat'、打开 /static/canvas.html；
 *      老 kind:'smart' 的画布从最近项目点开也走 BEAT（不再出现 smart-canvas.html）；
 *   2. 种子规格这一轮不变：templates.js 的 key/type/title/ratio/inputs/col 字段、submit 的 {v,nodes,agent,autoSend,renderer}、
 *      seedFromTemplate 的 {v,nodes,toast}（只有 opts.agent 才 autoSend，非 agent 模板不自动发送）；
 *   3. BEAT 侧 homeSeed.ts 把种子翻译成节点：image / text / label(便签) / gen(图+视频+比例) / table / group(空组降级图片槽位) /
 *      batch(不建节点只提示)、inputs 连边、按 col 分列、视口居中、seed.toast、空画布守卫、铺完先 saveNow；
 *   4. 构建产物：canvas.js 含 novai_canvas_seed / 比例映射表 / 批量降级文案；static/v2 产物里 ctx:"beat" 五处；
 *   5. static/canvas.html 的 canvas.js / canvas.css ?v= 形如 1.0.143.<unix 秒> 且两处一致、文件存在。
 *
 * 跑法：node tests/test_home_send_opens_beat.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
const sliceBetween = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + 1); return a >= 0 && b > a ? src.slice(a, b) : ''; };

/* ───────── [1] 首页四个入口全部进 BEAT ───────── */
console.log('[1] HomePage.vue：输入框 / 快速开始 / 模板 / 最近项目 全部进 BEAT');
const home = read('web/src/pages/home/HomePage.vue');
const submitStart = home.indexOf('function submit()');
const submitEnd = home.indexOf('/* ───────── 快速开始', submitStart);
ok(submitStart > 0 && submitEnd > submitStart, 'submit() 可定位（到「快速开始」注释为止）');
const submitBody = home.slice(submitStart, submitEnd);

ok(/renderer:\s*'beat'/.test(submitBody), "submit() 的种子带 renderer: 'beat'");
ok(/autoSend:\s*true/.test(submitBody), 'submit() 的种子带 autoSend: true');
ok(/launch\(title,\s*seed,\s*\{\s*ctx:\s*'beat'\s*\}\)/.test(submitBody), "submit() 调 launch(title, seed, { ctx: 'beat' })");
ok(/^\s*const sk = skill\.value;/m.test(submitBody) && submitBody.includes('seed.skillRef'), '带技能时种子仍写 skillRef（协议字段不丢）');

const createBody = sliceBetween(home, 'async function createCanvas', 'async function launch');
ok(/kind:\s*beat\s*\?\s*'classic'\s*:\s*'smart'/.test(createBody), "createCanvas 的 kind: beat ? 'classic' : 'smart'");
ok(/icon:\s*beat\s*\?\s*'🧩'\s*:\s*'layers'/.test(createBody), "createCanvas 的 icon: beat ? '🧩' : 'layers'");
ok(/const beat = opts\.ctx === 'beat'/.test(createBody), "createCanvas 以 opts.ctx === 'beat' 判定是否 BEAT");

const urlBody = sliceBetween(home, 'function canvasUrl', 'function timeTitle');
ok(/beat\s*\?\s*'\/static\/canvas\.html'\s*:\s*'\/static\/smart-canvas\.html'/.test(urlBody),
    "canvasUrl: beat ? '/static/canvas.html' : '/static/smart-canvas.html'（smart 分支只剩兜底，入口都传 ctx:'beat'）");
ok(/const beat = opts\.ctx === 'beat' \|\| c\.kind !== 'smart'/.test(urlBody), 'canvasUrl 按 ctx 或画布 kind 选页面');

const launchBody = sliceBetween(home, 'async function launch', '// 把模板变成种子');
ok(/localStorage\.setItem\(SEED_PREFIX \+ c\.id,\s*JSON\.stringify\(seed\)\)/.test(launchBody), 'launch 把种子写进 localStorage[SEED_PREFIX + 画布 id]');
ok(/openCanvasUrl\(canvasUrl\(c,\s*opts\)\)/.test(launchBody), 'launch 用 openCanvasUrl(canvasUrl(c, opts)) 打开画布');

// 四个入口：submit / quickStart(blank) / quickStart(image|video) / useTemplate 都调 launch，且每个调用点都带 ctx:'beat'
const launchCalls = [...home.matchAll(/\blaunch\(/g)]
    .filter((m) => home.slice(Math.max(0, m.index - 9), m.index) !== 'function ')
    .map((m) => home.slice(m.index, m.index + 260));
ok(launchCalls.length >= 4, 'launch(...) 调用点至少 4 处（实际 ' + launchCalls.length + ' 处）');
ok(launchCalls.length > 0 && launchCalls.every((s) => s.includes("ctx: 'beat'")),
    '每一个 launch( 调用点都传 ctx: \'beat\'（发送 / 快速开始 / 模板全走 BEAT）');
const beatCtx = home.match(/ctx:\s*'beat'/g) || [];
ok(beatCtx.length >= 5, "文件里 ctx: 'beat' 至少 5 处：4 个 launch 调用点 + openProject 的 canvasUrl（实际 " + beatCtx.length + ' 处）');

const quickStartBody = sliceBetween(home, 'function quickStart', '/* ───────── 最新项目');
ok(quickStartBody.includes("ctx: 'beat'"), "quickStart() 带 ctx: 'beat'");
ok((quickStartBody.match(/ctx:\s*'beat'/g) || []).length >= 2, '快速开始「空白」与「图片/视频」两条分支都带 ctx:\'beat\'');
ok(/if \(kind === 'blank'\) \{ launch\([^;]*ctx:\s*'beat'/.test(quickStartBody), '「新建项目」(blank) 分支走 BEAT');
ok(/if \(kind === 'batch'\) \{ useTemplate\('batch'\); return; \}/.test(quickStartBody), '「批量出图」转给 useTemplate(batch)（同一条 BEAT 路径）');
const genCall = quickStartBody.slice(quickStartBody.indexOf('const video = kind === \'video\';'));
ok(/ratio:\s*video \? '16:9' : ''/.test(genCall), '快速开始 gen 节点：视频 ratio 16:9、图片为空（交给 BEAT 映射 1:1）');
ok(/inputs:\s*rs\.length \? \['ref'\] : \[\]/.test(genCall), '快速开始带了参考素材时 gen.inputs 连 ref');

const useTemplateBody = sliceBetween(home, 'function useTemplate', 'function submit()');
ok(useTemplateBody.includes("ctx: 'beat'"), "useTemplate() 带 ctx: 'beat'（模板库全部进 BEAT）");
ok(/launch\(timeTitle\(t\.title\), seedFromTemplate\(t, opts\), \{ ctx: 'beat' \}\)/.test(useTemplateBody), 'useTemplate 调 launch(..., { ctx: \'beat\' })');

ok(/function openProject\(c\) \{ openCanvasUrl\(canvasUrl\(c, \{ ctx: 'beat' \}\)\); \}/.test(home),
    "最近项目 openProject 强制 ctx:'beat'（老 smart 画布点开也进 BEAT）");
ok(!/openCanvasUrl\(canvasUrl\(c\)\)/.test(home), '没有不带 ctx 的 openProject 旧写法残留');

/* ───────── [2] 种子规格这一轮不变 ───────── */
console.log('[2] 种子规格未改（templates.js 字段 + submit / seedFromTemplate 形状）');
const tpl = read('web/src/pages/home/templates.js');
ok(/export const SEED_PREFIX = 'novai_canvas_seed:';/.test(tpl), "templates.js 的 SEED_PREFIX = 'novai_canvas_seed:'");
for (const field of ['key', 'type', 'title', 'text', 'prompt', 'ratio', 'video', 'inputs', 'col']) {
    ok(new RegExp('\\b' + field + ':').test(tpl), '模板 node 字段 ' + field + ' 仍在');
}
// images 不是模板里写死的，由首页把上传素材填进 ref 节点（种子里仍是 images:[{url,name,kind}]）
ok(/images: rs, col: 0/.test(home), '种子里 ref 节点仍写 images: rs（上传素材进种子）');
const typesInTpl = ['image', 'gen', 'text', 'label', 'group', 'table', 'batch'].filter((t) => new RegExp("type: '" + t + "'").test(tpl));
ok(typesInTpl.length === 7, '模板里 7 种节点类型都还在（实际 ' + typesInTpl.join(',') + '）');
ok(/function labelNode\(text, color\)/.test(tpl) && /function refNode\(title\)/.test(tpl) && /function briefNode\(\)/.test(tpl), '模板构造函数 ref/brief/label 未改');
ok(/export const TEMPLATE_MAP = \{\}/.test(tpl) && /export \{ CATS \}/.test(tpl), 'TEMPLATE_MAP / CATS 导出未改');

const seedFromTpl = sliceBetween(home, 'function seedFromTemplate', 'function useTemplate');
ok(/const seed = \{ v: 1, nodes, toast: t\.toast \}/.test(seedFromTpl), 'seedFromTemplate 仍是 { v:1, nodes, toast }');
ok(/if \(opts\.agent\) \{/.test(seedFromTpl) && /seed\.autoSend = true/.test(seedFromTpl), '只有 opts.agent 才 autoSend（普通模板不自动发送）');
ok(/if \(copy\.ref && rs\.length\) copy\.images = rs/.test(seedFromTpl), 'ref 节点仍由首页素材填 images');
ok(/if \(copy\.brief\) copy\.text = tx/.test(seedFromTpl), 'brief 节点仍由输入框文字填 text');

/* ───────── [3] homeSeed.ts：六类节点翻译 ───────── */
console.log('[3] novai-canvas-ui homeSeed.ts 读-删-铺-连-居中-交草稿');
const seedRel = 'novai-canvas-ui/src/canvas/canvas-next/homeSeed.ts';
ok(exists(seedRel), seedRel + ' 存在');
const seedSrc = exists(seedRel) ? read(seedRel) : '';
ok(seedSrc.includes('novai_canvas_seed'), '种子键含 novai_canvas_seed');
ok(/export const HOME_SEED_PREFIX = "novai_canvas_seed:"/.test(seedSrc), 'HOME_SEED_PREFIX 为 novai_canvas_seed:');
const takeBody = seedSrc.slice(seedSrc.indexOf('function takeSeed'), seedSrc.indexOf('/**', seedSrc.indexOf('function takeSeed')));
ok(takeBody.includes('localStorage.getItem(key)') && takeBody.includes('localStorage.removeItem(key)'), 'takeSeed 读同一个 key 并立刻 removeItem');
ok(takeBody.indexOf('getItem') < takeBody.indexOf('removeItem'), '先读后删（不是删了再读）');

// 六类节点分支
for (const type of ['gen', 'text', 'label', 'table', 'batch', 'group']) {
    ok(new RegExp('type === "' + type + '"').test(seedSrc), '有 type === "' + type + '" 的翻译分支');
}
ok(/const kinds?\s*= video \? "video" : "image"|video \? "video" : "image"/.test(seedSrc), 'gen 分支按 video 选 image / video 节点');
ok(/defaultParams\("video"/.test(seedSrc) && /defaultParams\("image"/.test(seedSrc), 'gen 分支用默认参数起步（图片/视频各自一套）');
ok(/ratio,\s*dur: 5|ratio\b[\s\S]{0,80}dur: 5/.test(seedSrc), '视频 gen 节点带时长默认值（dur: 5）');
ok(/kind: "note"/.test(seedSrc), 'label 分支翻译成便签（kind: "note"）');
ok(/kind: "text"[\s\S]{0,120}manual: true|manual: true/.test(seedSrc), 'text 分支建文本节点（manual: true，不被助手覆盖）');
ok(/withTable\(/.test(seedSrc) && /emptyTable\(\)/.test(seedSrc), 'table 分支建多维表格（withTable + emptyTable）');
ok(/return \{ nodes: \[\], anchors: \[\], batch: true \}/.test(seedSrc), 'batch 分支不建节点，只标记 batch: true（降级提示走 toast）');
ok(/frameOf\(frame\.children\)/.test(seedSrc), 'group 分支用 frameOf 按成员位置算分组框');
ok(/return \{ nodes: kids, anchors: kids\.map\(\(n\) => n\.id\) \}/.test(seedSrc), '空分组降级成同名图片槽位（不建框）');
ok(/uploaded: true/.test(seedSrc), '图片槽位是 uploaded:true 的图片节点（可直接拖图进来）');
ok(/const IMAGE_W = 240/.test(seedSrc) && /MAX_IMAGES = 12/.test(seedSrc), '图片槽位尺寸 / 数量上限常量在');

// 比例映射
const ratioTable = { square: '1:1', wide: '16:9', story: '9:16', portrait43: '3:4', landscape43: '4:3', ultrawide: '21:9' };
for (const [semantic, value] of Object.entries(ratioTable)) {
    ok(new RegExp(semantic + ': "' + value.replace(/:/g, '\\:') + '"').test(seedSrc), '比例映射 ' + semantic + ' → ' + value);
}
ok(/function ratioOfSpec\(spec: SeedNode\)/.test(seedSrc), 'ratioOfSpec 统一换算比例');
ok(/\^\\d\+\(\?:\\\.\\d\+\)\?:\\d\+/.test(seedSrc) || /test\(raw\)\) return raw/.test(seedSrc), "已经写死 '16:9' 这类比例原样透传");
ok(/RATIO\[raw\] \|\| "1:1"/.test(seedSrc), '未知比例回落 1:1');

// 连边 / 分列 / 居中 / toast
ok(/Array\.isArray\(row\.spec\.inputs\)/.test(seedSrc), '按 spec.inputs 连边');
ok(/connect\(store, from, to, \{ quiet: true, select: false \}\)/.test(seedSrc), '连边走 connect(quiet) 不弹「已连接」打扰');
ok(/anchors\.get\(String\(key \|\| ""\)\)/.test(seedSrc), '按 key 找上游节点锚点（key → 节点 id）');
ok(/function layoutColumns\(columns: Map<number, CanvasNode\[\]>\)/.test(seedSrc), '按 col 分列排版 layoutColumns');
ok(/const col = Math\.max\(0, Math\.min\(6, Number\(spec\.col\) \|\| 0\)\)/.test(seedSrc), 'col 取 0..6（没有 col 归 0 列）');
ok(/const ROW_GAP = 48/.test(seedSrc) && /const COL_GAP = 140/.test(seedSrc), '排版间距常量 ROW_GAP / COL_GAP');
ok(/function centerView\(store: CanvasStore, nodes: CanvasNode\[\]\)/.test(seedSrc) && /store\.setView\(\{ x:/.test(seedSrc), 'centerView 把包围盒居中到视口');
ok(/function centerWhenSettled/.test(seedSrc), 'centerWhenSettled：面板开完宽度稳定后再补一次居中');
ok(/if \(seed\.toast\) store\.toast\(String\(seed\.toast\), 5000\)/.test(seedSrc), 'seed.toast 铺完后弹提示');
ok(/store\.toast\("批量出图在 BEAT 里由表格自带/.test(seedSrc), 'batch 降级会说明「批量出图由表格自带」');
ok(/store\.state\.doc\.nodes\.length \? \[\] : await placeSeed\(store, seed\)/.test(seedSrc),
    '只在空画布时铺节点（画过的画布不被塞东西）');
const consumeSlice = seedSrc.slice(seedSrc.indexOf('export async function consumeHomeSeed'));
const placeIdx = consumeSlice.indexOf('placeSeed(store, seed)');
const saveIdx = consumeSlice.indexOf('store.saveNow()');
const setUiIdx = consumeSlice.indexOf('setUI({ agentOpen: true })');
ok(placeIdx > 0 && saveIdx > placeIdx, '铺完节点先 store.saveNow() 再往下走（服务端先有版本）');
ok(saveIdx > 0 && (setUiIdx < 0 || saveIdx < setUiIdx), 'saveNow 在开助手面板 / 返回草稿之前');
ok(/store\.setUI\(\{ agentOpen: true \}\)/.test(seedSrc), '打开画布助手面板 setUI({ agentOpen: true })');
ok(/autoSend: seed\.autoSend === true/.test(seedSrc), '只有 seed.autoSend === true 才自动发');
ok(/return \{ seq: Date\.now\(\), text, autoSend/.test(seedSrc), '返回 { seq, text, autoSend } 交给外壳');

/* ───────── [4] 接线：main.tsx + AgentPanel.tsx ───────── */
console.log('[4] 外壳接线 main.tsx / AgentPanel.tsx');
const mainTs = read('novai-canvas-ui/src/main.tsx');
ok(/import \{ consumeHomeSeed[^}]*\} from "\.\/canvas\/canvas-next\/homeSeed"/.test(mainTs), 'main.tsx 从 homeSeed 引入 consumeHomeSeed');
const onReady = mainTs.slice(mainTs.indexOf('onReady='), mainTs.indexOf('onReady=') + 600);
ok(/consumeHomeSeed\(store\)/.test(onReady), 'onReady(store) 里调用 consumeHomeSeed(store)');
ok(/setAgentDraft\(draft\)/.test(onReady), '拿到的草稿 setAgentDraft 交给 CanvasApp');
ok(/agentDraft=\{agentDraft\}/.test(mainTs), 'CanvasApp 收到 agentDraft prop');

const panel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
ok(/if \(!draft\.autoSend\) return;/.test(panel), 'AgentPanel 认 draft.autoSend（非 agent 模板不自动发送）');
const draftSet = panel.indexOf('setDraft(text)');
const autoSendAt = panel.indexOf('if (!draft.autoSend) return;');
ok(draftSet > 0 && autoSendAt > draftSet, '先把文字填进输入框，再判 autoSend');
ok(/void send\(\)\.catch/.test(panel.slice(autoSendAt, autoSendAt + 1200)), 'autoSend 时真的调面板自己的 send()');
ok(/handledDraft\.current === draft\.seq/.test(panel), '同一个 seq 只处理一次（避免重复自动发送）');

/* ───────── [5] 构建产物 ───────── */
console.log('[5] 构建产物带上新逻辑');
const beatJsRel = 'static/novai-canvas/canvas.js';
ok(exists(beatJsRel), beatJsRel + ' 存在');
const beatJs = exists(beatJsRel) ? fs.readFileSync(path.join(root, beatJsRel), 'utf8') : '';
ok(beatJs.length > 1000, 'static/novai-canvas/canvas.js 非空（' + beatJs.length + ' 字节）');
ok(beatJs.includes('novai_canvas_seed'), '构建产物 canvas.js 含 novai_canvas_seed');
ok(beatJs.includes('agentOpen'), '构建产物 canvas.js 含 agentOpen');
ok((beatJs.match(/saveNow/g) || []).length >= 2, '构建产物 canvas.js 含 saveNow 定义与调用');
ok(beatJs.includes('square:"1:1"') && beatJs.includes('portrait43:"3:4"'), '构建产物含比例映射表（square:"1:1" / portrait43:"3:4"）');
ok(beatJs.includes('wide:"16:9"') && beatJs.includes('story:"9:16"') && beatJs.includes('ultrawide:"21:9"'), '构建产物比例表含 wide / story / ultrawide');
ok(beatJs.includes('批量出图在 BEAT 里由表格自带'), '构建产物含 batch 降级提示文案');
const v2Index = 'static/v2/index.html';
ok(exists(v2Index), v2Index + ' 存在');
const v2Assets = fs.existsSync(path.join(root, 'static/v2/assets'))
    ? fs.readdirSync(path.join(root, 'static/v2/assets')).filter((n) => /\.js$/.test(n)) : [];
ok(v2Assets.length > 0, 'static/v2/assets 下有构建出来的 js');
const v2Js = v2Assets.map((n) => fs.readFileSync(path.join(root, 'static/v2/assets', n), 'utf8')).join('\n');
ok(v2Js.includes('renderer:"beat"') || v2Js.includes("renderer:'beat'"), 'static/v2 构建产物含 renderer:"beat"');
ok((v2Js.match(/ctx:"beat"/g) || []).length >= 5, 'static/v2 构建产物含 5 处 ctx:"beat"（四个入口都改成 BEAT）');
ok(v2Js.includes("/static/canvas.html"), 'static/v2 构建产物含 /static/canvas.html');
ok(v2Js.includes("/api/canvases"), 'static/v2 构建产物含 /api/canvases');

/* ───────── [6] canvas.html 入口版本号 ───────── */
console.log('[6] static/canvas.html 的 canvas.js / canvas.css 版本号');
const ch = read('static/canvas.html');
const vers = [...ch.matchAll(/novai-canvas\/(?:canvas\.css|canvas\.js)\?v=([0-9.]+)/g)].map((m) => m[1]);
ok(vers.length === 2, 'canvas.html 里 canvas.css / canvas.js 各一处 ?v=（实际 ' + vers.length + ' 处）');
ok(vers[0] === vers[1], '两处 ?v= 一致（' + vers[0] + ' / ' + vers[1] + '）');
ok(/^1\.0\.143\.\d{10}$/.test(vers[0] || ''), '?v= 形如 1.0.143.<unix 秒>：' + vers[0]);
ok(exists('static/novai-canvas/canvas.js') && fs.statSync(path.join(root, 'static/novai-canvas/canvas.js')).size > 0,
    'canvas.js 对应的产物文件存在且非空');
ok(exists('static/novai-canvas/canvas.css') && fs.statSync(path.join(root, 'static/novai-canvas/canvas.css')).size > 0,
    'canvas.css 对应的产物文件存在且非空');
ok(/id="root"/.test(ch) && /type="module" src="\/static\/novai-canvas\/canvas\.js\?v=/.test(ch), 'canvas.html 仍以 module 方式加载 BEAT 入口');

console.log('');
console.log('首页所有入口 → 智能画布BEAT（静态）：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach((f) => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
process.exit(0);
