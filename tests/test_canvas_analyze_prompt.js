#!/usr/bin/env node
/* 画布「解析」按钮（图片 / 视频节点）：点完立刻建文本节点 + 连线，取画面交给 /api/canvas-analyze-media，
   四段提示词回来写回该节点、失败把原因写进正文。
   视频走专用流程：使用区间 起 / 中点 / 末 三帧一起发（images + kind:"video" + duration），出视频提示词；
   图片仍是单图（image），「更多 › 解析当前帧」仍走单帧（image + is_video_frame:true）。
   覆盖：两颗按钮的落位与 data-tb 来源、更多菜单里的「解析当前帧」、先建节点并连线再请求、成功回填 / 失败保留节点、
        解析期的骨架 + 脉冲点（纯界面态，不进文档）、图片 / 视频 / 单帧三条取帧路径、体积闸门、
        接口调用与错误处理、四段式正文格式化、防重复点击、构建产物里真的有这些按钮与文案。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const media = read('novai-canvas-ui/src/canvas/canvas-next/ui/parseMedia.ts');
const registry = read('novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx');
const storeSrc = read('novai-canvas-ui/src/canvas/canvas-next/store.ts');
const nodeView = read('novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx');
const backendSrc = read('novai-canvas-ui/src/novaiBackend.ts');
const built = read('static/novai-canvas/canvas.js');

// ---- 1. 工具条按钮：B(act, …) 会把 act 写进 data-tb，所以两处都看 act 是不是 "parse" ----
assert(/"data-tb": act/.test(panel), 'B() 把 act 写进 data-tb');
assert.strictEqual(panel.split('B("parse", "wand"').length - 1, 2, '图片 / 视频工具条各一颗「解析」，都用线性 wand 图标');

const imageLine = panel.split('\n').find((line) => line.includes('else if (node.kind === "image") items ='));
assert(imageLine, '找得到图片工具条');
assert(imageLine.includes('B("parse", "wand", "解析：反推画面的提示词，自动生成一个文本节点", "解析"'), '图片按钮的标签 / 提示文案');
assert(imageLine.indexOf('B("more"') < imageLine.indexOf('B("parse"'), '图片：解析在「更多」之后');
assert(imageLine.indexOf('B("parse"') < imageLine.indexOf('className="vsep"'), '图片：解析在竖分隔线之前');
assert(!imageLine.includes('parseMediaFrame'), '图片节点没有「解析当前帧」');

const videoStart = panel.indexOf('else if (node.kind === "video" && out) items = [');
assert(videoStart > 0, '找得到视频工具条');
const video = panel.slice(videoStart, panel.indexOf('];', videoStart));
assert(video.includes('B("parse", "wand", "解析：反推画面的提示词，自动生成一个文本节点", "解析"'), '视频按钮的标签 / 提示文案');
assert(video.indexOf('B("frame"') < video.indexOf('B("parse"'), '视频：解析在「截帧」之后');
assert(video.indexOf('B("parse"') < video.indexOf('"data-tb": "vmore"'), '视频：解析在「更多」之前');
assert(panel.includes('import { parseMedia, parseMediaFrame } from "./parseMedia";'), '工具条走 parseMedia，更多菜单走 parseMediaFrame');

// ---- 1b. 视频「更多」菜单里的「解析当前帧」：走老的单帧逻辑 ----
const moreStart = panel.indexOf('function videoMore(');
const moreBlock = panel.slice(moreStart, panel.indexOf('function UnrefWarn(', moreStart));
assert(moreStart > 0 && moreBlock.length > 0, '找得到 videoMore 菜单');
assert(moreBlock.includes('data-tbk="parseframe"'), '更多菜单里有「解析当前帧」这一项（data-tbk=parseframe）');
assert(moreBlock.includes('解析当前帧'), '菜单文案是「解析当前帧」');
assert(/parseMediaFrame\(ctl, node\)/.test(moreBlock), '菜单项调 parseMediaFrame（单帧入口）');
assert.strictEqual(panel.split('parseMediaFrame(ctl, node)').length - 1, 1, '单帧入口只在更多菜单里挂一次');

// ---- 2. 取画面：图片走结果图地址 + resolveAsset；单帧复用 grabVideoFrame（当前帧 → 封面 → 首帧） ----
assert(!/runNode\(/.test(media) && !/from "\.\.\/engine"/.test(media), '不挂到画布生成运行时（不占 runNode 通道）');
assert(/outOf\(node\)\?\.url/.test(media), '图片取结果图地址 outOf(node).url');
assert(/isAssetRef\(url\)/.test(media) && /backend\.resolveAsset\(url\)/.test(media), 'novai-asset 引用先 resolveAsset');
assert(/await toDataUrl\(src, MAX_EDGE\)/.test(media), '复用编辑器的取字节 + 缩图（toDataUrl）');
assert(/const MAX_EDGE = 1280;/.test(media) && /const JPEG_QUALITY = 0.9;/.test(media), '长边 ≤1280、JPEG 0.9');
assert(/toDataURL\("image\/jpeg", JPEG_QUALITY\)/.test(media), '统一再编码成 JPEG 0.9');
const currentAt = media.indexOf('grabVideoFrame(store, node, "current")');
const coverAt = media.indexOf('if (o?.frame) {');
const firstAt = media.indexOf('grabVideoFrame(store, node, "first")');
assert(currentAt > 0 && coverAt > currentAt && firstAt > coverAt, '单帧取帧顺序不变：当前播放帧 → 封面 → 首帧');

// ---- 2b. 视频三帧：使用区间 起 / 中点 / 末，每帧缩到 ≤1280 的 JPEG，去重且至少 1 帧 ----
assert(/const FRAME_COUNT = 6;/.test(media), '视频解析取 6 帧');
assert(/const MAX_FRAMES = 8;/.test(media), '后端多帧上限已放宽到 8，客户端闸门同口径');
assert(/async function videoFrames\(store: CanvasStore, node: CanvasNode\)/.test(media), '视频多帧走 videoFrames');
assert(/const trim = o\?\.trim \? clampTrim\(o\.dur, o\.trim\) : null;/.test(media), '有使用区间就按 trim.in→trim.out');
assert(/const from = trim \? trim\.in : 0;/.test(media), '第一帧取区间起');
assert(/const head = await grabVideoFrameAt\(store, node, from\);/.test(media), '区间起用按秒取帧');
assert(/const total = head\.duration > 0 \? head\.duration : Number\(o\?\.dur\) \|\| 0;/.test(media), '总时长优先用视频真实时长（拿不到退 outOf().dur）');
assert(/const to = trim \? Math\.min\(trim\.out, total \|\| trim\.out\) : \(total > 0 \? total : from\);/.test(media), '区间末取 trim.out（没有 trim 就真实时长）');
assert(/for \(let i = 1; i < FRAME_COUNT; i \+= 1\)/.test(media), '首点之后再补 5 个点，按时间顺序追加');
assert(/const seconds = from \+ \(\(to - from\) \* i\) \/ \(FRAME_COUNT - 1\);/.test(media), '在 in→out 之间均匀等分 6 个时间点');
assert(/const frame = await grabVideoFrameAt\(store, node, seconds\)/.test(media), '每个等分点都走 grabVideoFrameAt');
assert(/const jpeg = await encodeJpeg\(data\)\.catch\(\(\) => ""\);/.test(media), '每帧同样缩到长边 ≤1280 的 JPEG');
assert(/if \(jpeg && !images\.includes\(jpeg\)\) images\.push\(jpeg\);/.test(media), '重复帧去掉（短视频只留能取到的帧）');
assert(/if \(!images\.length\) throw new Error\("取不到画面：视频还没加载出来"\);/.test(media), '一帧都取不到才报错（至少 1 帧）');

// 取帧能力加在 registry 里，seek 逻辑只有一份，first / current / last 调用点行为不变
assert(/export async function grabVideoFrameAt\(store: CanvasStore, n: CanvasNode, seconds: number\)/.test(registry), 'registry 导出 grabVideoFrameAt（按秒取帧）');
assert(/async function seekVideoFrame\(/.test(registry), 'seek / 临时 video 逻辑抽成一个内部函数');
assert.strictEqual(registry.split('seekVideoFrame(store, n, o,').length - 1, 2, 'grabVideoFrame 与 grabVideoFrameAt 共用同一段 seek（没有复制两份）');
assert(/at === "first"/.test(registry) && /at === "current"/.test(registry) && /Math\.min\(trim\.out, duration \|\| trim\.out\)/.test(registry), 'first / current / last 的取帧时间点原样保留');

// ---- 2c. 体积闸门：单帧 >8MB、总数 >8 帧都不发（toast 里带原因） ----
assert(/const MAX_BYTES = 8 \* 1024 \* 1024;/.test(media), '超过 8MB 不发');
assert(/function assertPayloadSize\(body: ParseBody\): void/.test(media), '发之前统一过体积闸门');
assert(/if \(body\.images\.length > MAX_FRAMES\) throw new Error/.test(media), '帧数超过上限也拒绝发送');
assert(/第 \$\{index \+ 1\} 帧约 \$\{Math\.round\(bytes \/ 1024 \/ 1024\)\}MB/.test(media), '视频超限时点名第几帧');
assert(/if \(bytes > MAX_BYTES\) throw new Error\(`画面约/.test(media), '图片 / 单帧超限提示不变');

// ---- 3. 接口：同源相对路径 + JSON；视频多帧带 images + kind + duration，素材库设置照旧带上 ----
assert(/const ENDPOINT = "\/api\/canvas-analyze-media";/.test(media), '请求打 /api/canvas-analyze-media');
assert(/method: "POST"/.test(media) && /"Content-Type": "application\/json"/.test(media), 'POST + Content-Type: application/json');
assert(/type ParseBody =\s*\| \{ image: string; is_video_frame: boolean \}\s*\| \{ images: string\[\]; kind: "video"; duration\?: number \};/.test(media), '请求体两种形状：单图 image / 多帧 images + kind + duration');
assert(/body: JSON\.stringify\(\{\s*\.\.\.body,/.test(media), '同一份 requestParse 把 body 原样展开');
assert(media.includes('{ image: await imageDataUrl(store, node), is_video_frame: false }'), '图片分支仍是单图 image');
assert(media.includes('{ image: await videoFrameDataUrl(store, node), is_video_frame: true }'), '「解析当前帧」仍是单图 + is_video_frame:true');
assert(media.includes('return { images, kind: "video", ...(duration > 0 ? { duration } : {}) };'), '视频分支发 images 数组 + kind:"video"，有总时长才带 duration');
assert(/return \{ images, duration: Number\(o\?\.dur\) \|\| 0 \};/.test(media), '请求里的 duration 用 outOf().dur（没有就是 0 → 不带）');
assert(/const CAPTION_SETTINGS_KEY = "asset_manager_local_caption_settings_v1";/.test(media), '读素材库「反推设置」同一个 localStorage key');
assert(/localStorage\.getItem\(CAPTION_SETTINGS_KEY\)/.test(media), '平台 / 模型从 localStorage 读');
assert(/\.\.\.\(caption\.provider && caption\.model \? \{ provider: caption\.provider, model: caption\.model \} : \{\}\)/.test(media), '两个字段都齐才带 { provider, model }，缺失就不发');
assert(/function captionModel\(\)/.test(media) && /catch \{\s*return \{ provider: "", model: "" \};/.test(media), '读设置包 try/catch，解析失败当没配置');
assert(!/captionPrompt/.test(media), '只借平台 / 模型，不用素材库的 captionPrompt（四段式模板在后端）');
assert(/pick\(row\.detail\) \|\| pick\(row\.error\)/.test(media), '失败既认 {detail} 也认 {ok:false,error}');
assert(/\.ok === false/.test(media), 'HTTP 200 + ok:false 也算失败');
assert(/if \(!text\) throw new Error\("模型没有返回内容"\)/.test(media), '空结果不当成功（走失败分支把原因写进节点正文）');
assert(/console\.warn\("\[canvas\] 解析失败", error\)/.test(media), '异常留痕，不静默吞掉');

// ---- 4. 先建节点 + 连线（不等结果），成功再回填正文，失败保留节点写原因 ----
assert(/const GAP_X = 140;/.test(media) && /const DROP_Y = 60;/.test(media), 'x = 源右侧 +140，避让步长 60');
assert(/store\.newNode\("text", x, freeY\(store, src, x, src\.y\)/.test(media), '建的是 kind "text" 节点，落在右侧空位');
assert(/hist: \[\{ text: "" \}\],/.test(media), '解析期间正文留空，不写「解析中…」这类临时文案');
assert(/hi: 0,/.test(media) && /manual: true,/.test(media), '按「粘贴的文本」的写法落 hi / manual');
assert(/title: `解析 · \$\{genOf\(src\)\.title/.test(media), '标题「解析 · 源节点标题」点击时就定好');
assert(/store\.addNodes\(\[text\], \[\{ id: uid\("e"\), from: src\.id, to: text\.id \}\], \{ select: true \}\)/.test(media), '同一次 addNodes 把节点和「源 → 文本」的边加进去，并选中新节点');
assert(/import \{ bounds, clampTrim, genOf, outOf, uid \} from "\.\.\/model";/.test(media), 'uid / clampTrim 从 model 引入');

const newNodeAt = media.indexOf('store.newNode("text", x, freeY');
const addAt = media.indexOf('store.addNodes([text], [{ id: uid("e")');
const toastAt = media.indexOf('store.toast(node.kind === "video" && !singleFrame ? "解析中…（约 15–50 秒）" : "解析中…（约 10–40 秒）", 40000);');
const collectAt = media.indexOf('await collect(store, node, singleFrame)');
assert(newNodeAt > 0 && addAt > newNodeAt, '先建节点，再一次 addNodes 加边');
assert(addAt < collectAt, '建节点 / 连线在取画面之前');
assert(addAt < media.indexOf('await requestParse(payload)'), '建节点 / 连线在打接口之前');
assert(toastAt > addAt, '建完节点、reveal 之后才 toast 即时反馈');
assert(toastAt < collectAt, '即时反馈也在取画面之前');
assert.strictEqual(media.split('store.toast(node.kind === "video" && !singleFrame ? "解析中…（约 15–50 秒）" : "解析中…（约 10–40 秒）", 40000);').length - 1, 1, '即时反馈只发一次（第二个参数 40000ms）');
assert(/const payload = await collect\(store, node, singleFrame\);/.test(media) && /assertPayloadSize\(payload\);/.test(media), '取画面后先过体积闸门再发');

// 成功：正文写回刚才那个节点的当前版本（不是新开一个节点）
assert(media.includes('if (store.node(text.id)) store.patchGen(text.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, text: body } : h)) }), { history: true });'), '成功后把四段正文写进新建节点的当前版本');
assert(/store\.toast\(parsed\.model \? `已生成解析提示词（\$\{parsed\.model\}）` : "已生成解析提示词"\)/.test(media), '成功 toast 带上实际模型，model 为空退回原文案');

// 失败：节点保留不删，正文写一行「解析失败：<原因>」，toast 同原因 + 指路
assert(media.includes('text: `解析失败：${reason}`'), '失败把「解析失败：<原因>」写进新节点正文');
assert(!/removeNodes\(/.test(media), '失败不删节点');
assert(/store\.toast\(`解析失败：\$\{reason\}\$\{hint\}`, 5000\)/.test(media), '失败 toast 同原因并接指路文案');
assert(/const hint = reason\.includes\("模型"\) && !\/key\/i\.test\(reason\) \? "（可在 设置 › API 设置 里配一个能看图的模型）" : "";/.test(media), '只有原因含「模型」且不含 Key 才补指路');
assert(/let text: CanvasNode;/.test(media) && /inFlight\.delete\(node\.id\);\s*return;/.test(media), '建节点本身失败只 toast、不建节点');
assert(/const inFlight = new Set<string>\(\);/.test(media), '按节点 id 维护模块级 Set');
assert(/inFlight\.has\(node\.id\)\).*store\.toast\("正在解析…"\)/.test(media), '进行中再点提示「正在解析…」');
assert(/finally \{[\s\S]*?inFlight\.delete\(node\.id\);/.test(media), '结束（成功 / 失败）都释放');

// 两个入口：工具条「解析」走多帧，更多菜单「解析当前帧」走单帧
assert(/export async function parseMedia\(ctl: Ctl, node: CanvasNode\): Promise<void> \{\s*return runParse\(ctl, node, false\);/.test(media), '工具条「解析」按多帧走');
assert(/export async function parseMediaFrame\(ctl: Ctl, node: CanvasNode\): Promise<void> \{\s*return runParse\(ctl, node, true\);/.test(media), '「解析当前帧」按单帧走');
assert(!/parseMediaFrame/.test(imageLine), '图片工具条 / 图片节点没有单帧入口');

// ---- 4d. 分镜表：响应里的 table 不是 null 就建 kind=table 节点（不连线、不抢选中）；null 不建 ----
assert(media.includes('import { normalizeTable, withTable, type TableData } from "../table";'), '用现成的 table.ts（normalizeTable / withTable / TableData）');
assert(/const TABLE_TITLE = "解析 · 分镜表";/.test(media) && /const TABLE_W = 1240;/.test(media) && /const TABLE_H = 360;/.test(media) && /const TABLE_GAP = 80;/.test(media), '分镜表标题 / 尺寸 / 与文本节点的间距');
assert(/function tableDataOf\(raw: unknown, sourceId: string\): TableData \| null/.test(media), '响应 table → TableData');
assert(/const t = normalizeTable\(raw, false\);/.test(media) && /if \(!t \|\| !t\.columns\.length \|\| !t\.rows\.length\) return null;/.test(media), 'table 为 null / 形状不对 / 空表都当没有');
assert(media.includes('return { kind: "table", version: 1, title: TABLE_TITLE, columns: t.columns, rows: t.rows, sourceId };'), 'columns / rows 来自响应，title / sourceId 由前端补');
assert(/table: row\.table \?\? null/.test(media), 'requestParse 把响应里的 table 带出来（null 原样）');
assert(/function addStoryboardTable\(store: CanvasStore, text: CanvasNode, table: TableData\): CanvasNode/.test(media), '建表函数');
assert(/withTable\(\{ id: uid\("t"\), kind: "table", x, y, w: TABLE_W, h: TABLE_H, text: TABLE_TITLE \}, table\)/.test(media), '用 withTable 把 TableData 塞进 kind=table 节点');
assert(/const x = text\.x;/.test(media), 'x 与文本节点对齐');
assert(/const y = freeY\(store, text, x, text\.y \+ text\.h \+ TABLE_GAP, TABLE_W, TABLE_H\);/.test(media), '文本节点正下方 80px，撞了按 60 往下让（freeY 按表格尺寸算）');
assert(/store\.addNodes\(\[node\], \[\], \{ history: true \}\);/.test(media), '只加节点、不连边、不 select（选中留在文本节点上）');
assert(/const table = tableDataOf\(parsed\.table, text\.id\);/.test(media) && /if \(table && live\) \{/.test(media), '四段正文写回之后才按 table 建表；table=null 不建');
assert(/revealIfOffscreen\(ctl, \[live, addStoryboardTable\(store, live, table\)\]\);/.test(media), '建完把文本节点和表格一起带进视图');
assert(/console\.warn\("\[canvas\] 分镜表创建失败", error\);/.test(media), '建表失败不把成功判成失败（只留痕）');
const tableAt = media.indexOf('const table = tableDataOf(parsed.table, text.id);');
assert(tableAt > media.indexOf('text: body } : h)) }), { history: true });'), '建表在四段正文写回之后');
assert(media.indexOf('已生成解析提示词') > tableAt, '成功 toast 在之后（文案不变）');

// ---- 4c. 解析期间显示「文本生成中」的骨架 + 脉冲点：纯界面态（store.ui.parsing），不进文档 ----
assert(/parsing: Set<string>;/.test(storeSrc), 'store UIState 加了「正在解析的节点 id」集合');
assert(/parsing: new Set<string>\(\)/.test(storeSrc), '初始化为空 Set');
assert(/export type UIState = \{[\s\S]*?parsing: Set<string>;/.test(storeSrc), 'parsing 在 UIState（纯界面状态）里，不在文档类型里');
assert(/store\.setUI\(\{ parsing: new Set\(\[\.\.\.store\.state\.ui\.parsing, text\.id\]\) \}\)/.test(media), '建完节点 / 连线后立刻置位');
const setParsingAt = media.indexOf('store.setUI({ parsing: new Set([...store.state.ui.parsing, text.id]) })');
assert(setParsingAt > media.indexOf('store.addNodes([text], [{ id: uid("e")'), '置位在建节点 / 连线之后');
assert(setParsingAt < collectAt, '置位在取画面 / 打接口之前');
assert(/store\.setUI\(\{ parsing: new Set\(\[\.\.\.store\.state\.ui\.parsing\]\.filter\(\(id\) => id !== text\.id\)\) \}\)/.test(media), 'finally 里按 id 清位（成功 / 失败 / 节点被删都走这里）');
assert(media.indexOf('store.setUI({ parsing: new Set([...store.state.ui.parsing].filter') > media.indexOf('} finally {'), '清位写在 finally 里');
assert(!/patchGen\([^)]*parsing|withGen\([^)]*parsing/.test(media), '解析态不写进 gen / 文档');
assert(!/parsing/.test(backendSrc), '文档序列化（novaiBackend）里没有解析态字段，画布 JSON 不会出现它');
assert(/const parsing = useS\(\(s\) => s\.ui\.parsing\.has\(node\.id\)\);/.test(nodeView), 'NodeView 按 ui.parsing 读当前节点是否在解析');
assert(/\(running \|\| parsing\) && node\.kind === "text"\) return p\.run\?\.stream \? .*: <TextSkeleton \/>;/.test(nodeView), '解析期间正文用现成的 TextSkeleton（和文本生成中同一套）');
assert(/aria-label="解析中"/.test(nodeView) && /className="runsig"/.test(nodeView), '标题栏右侧用现成的 runsig 脉冲点，aria-label 改「解析中」');
assert(/<Body \{\.\.\.p\} out=\{out\} running=\{running\} parsing=\{parsing\} hover=\{hoverNode\} \/>/.test(nodeView), 'parsing 传进 Body（骨架盖住正文和双击编辑框）');
// ---- 5. 四段式正文：标记行 → 标题；四段不齐保留原文 ----
assert(/export function formatParsedPrompt/.test(media), '四段标题格式化函数 formatParsedPrompt 存在');
for (const title of ['【中文 · 正向】', '【中文 · 负向】', '【English · Positive】', '【English · Negative】']) {
    assert(media.includes(title), '缺少标题 ' + title);
}
assert(/const SECTION_ORDER: SectionKey\[\] = \["cnPos", "cnNeg", "enPos", "enNeg"\];/.test(media), '四段按固定顺序输出');
assert(/if \(!complete\) return text;/.test(media), '四段没齐就原文照写');
assert(media.includes('const MARKER_RE = /^[') && media.includes('【]'), '按 [中文正向] / 【…】 标记行切段');
assert(/sectionOf\(mark\[1\]\)/.test(media), '标记行标签映射到四段');

// ---- 6. 构建产物：按钮、接口地址、两条 toast 文案真的进了 static/novai-canvas ----
assert.strictEqual(built.split('解析：反推画面的提示词').length - 1, 2, '构建产物里图片 / 视频工具条各一颗「解析」');
assert(built.includes('canvas-analyze-media'), '构建产物里带接口地址');
assert(built.includes('已生成解析提示词'), '构建产物里带成功文案');
assert(built.includes('【English · Negative】'), '构建产物里带四段标题');
assert(built.includes('asset_manager_local_caption_settings_v1'), '构建产物里读素材库反推设置');
assert(built.includes('已生成解析提示词（'), '构建产物里成功 toast 带模型');
assert(built.includes('解析中…（约 10–40 秒）'), '构建产物里带图片 / 单帧的「解析中…（约 10–40 秒）」反馈');
assert(built.includes('解析中…（约 15–50 秒）'), '构建产物里带视频多帧的「解析中…（约 15–50 秒）」反馈');
assert(built.includes('解析当前帧'), '构建产物里带「更多 › 解析当前帧」');
assert(built.includes('解析 · 分镜表'), '构建产物里带分镜表节点标题');
assert(built.includes('kind:"video"'), '构建产物里视频请求体带 kind:"video"');
assert(built.includes('images:'), '构建产物里视频请求体带 images 数组');
assert(built.includes('parsing'), '构建产物里带解析态（store.ui.parsing）');
assert(built.includes('解析中'), '构建产物里带「解析中」脉冲点 / toast 文案');
assert(built.includes('可在 设置 › API 设置 里配一个能看图的模型'), '构建产物里带失败指路文案');

console.log('[analyze-prompt] 全部通过（两处按钮落位 / 更多菜单解析当前帧 / 图片单图 / 视频区间等分 6 帧 / images+kind+duration 请求体 / 体积闸门 / 先建节点并连线再请求 / 成功回填正文 + 建「解析 · 分镜表」/ table=null 不建表 / 失败保留节点写原因 / 解析态骨架与脉冲点不进文档 / 四段式正文 / 构建产物）');
