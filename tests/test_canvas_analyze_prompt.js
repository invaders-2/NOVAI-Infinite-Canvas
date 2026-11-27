#!/usr/bin/env node
/* 画布「解析」按钮（图片 / 视频节点）：
   视频 = 只建「解析 · 分镜表」表格节点（连到视频、选中、先占位 12 列 + 1 行空行），6 帧 + table_only；
          成功用响应里的列 / 行整表替换，失败把原因写进第一行「画面描述」，表格保留。
   图片 = 只建文本节点（四段正文 + 骨架 + 源 → 文本边），不建表格。
   「更多 › 解析当前帧」= 单帧 + 文本节点，不建表。
   覆盖：按钮落位 / 更多菜单 / 视频优先发 video_url、读不到才本地 6 帧（896 / 0.85）/ 体积闸门 / table_only / 视频只建表与替换/失败 /
        图片只建文本（没有 withTable）/ 单帧不建表 / 解析态骨架（图片 / 单帧）/ 四段式正文 / 构建产物。 */
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

// ---- 1. 工具条按钮：图片 / 视频各一颗「解析」，视频「更多」里还有「解析当前帧」 ----
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

const moreStart = panel.indexOf('function videoMore(');
const moreBlock = panel.slice(moreStart, panel.indexOf('function UnrefWarn(', moreStart));
assert(moreStart > 0 && moreBlock.length > 0, '找得到 videoMore 菜单');
assert(moreBlock.includes('data-tbk="parseframe"'), '更多菜单里有「解析当前帧」这一项（data-tbk=parseframe）');
assert(moreBlock.includes('解析当前帧'), '菜单文案是「解析当前帧」');
assert(/parseMediaFrame\(ctl, node\)/.test(moreBlock), '菜单项调 parseMediaFrame（单帧入口）');
assert.strictEqual(panel.split('parseMediaFrame(ctl, node)').length - 1, 1, '单帧入口只在更多菜单里挂一次');

// ---- 2. 取画面：图片走结果图地址；视频 6 帧走 grabVideoFrameAt；单帧仍复用 grabVideoFrame ----
assert(!/runNode\(/.test(media) && !/from "\.\.\/engine"/.test(media), '不挂到画布生成运行时（不占 runNode 通道）');
assert(/outOf\(node\)\?\.url/.test(media), '图片取结果图地址 outOf(node).url');
assert(/isAssetRef\(url\)/.test(media) && /backend\.resolveAsset\(url\)/.test(media), 'novai-asset 引用先 resolveAsset');
assert(/await toDataUrl\(src, MAX_EDGE\)/.test(media), '复用编辑器的取字节 + 缩图（toDataUrl）');
assert(/const MAX_EDGE = 1280;/.test(media) && /const JPEG_QUALITY = 0.9;/.test(media), '长边 ≤1280、JPEG 0.9');
assert(/canvas\.toDataURL\("image\/jpeg", quality\)/.test(media), '统一再编码走 encodeJpeg 的 quality（默认 0.9）');
const currentAt = media.indexOf('grabVideoFrame(store, node, "current")');
const coverAt = media.indexOf('if (o?.frame) {');
const firstAt = media.indexOf('grabVideoFrame(store, node, "first")');
assert(currentAt > 0 && coverAt > currentAt && firstAt > coverAt, '单帧取帧顺序不变：当前播放帧 → 封面 → 首帧');

assert(/const FRAME_COUNT = 6;/.test(media), '本地兜底取帧是 6 帧等距');
assert(/const FALLBACK_EDGE = 896;/.test(media) && /const FALLBACK_QUALITY = 0\.85;/.test(media), '兜底帧长边 896 / JPEG 0.85（别把 body 撑大）');
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
assert(/const jpeg = await encodeJpeg\(data, FALLBACK_EDGE, FALLBACK_QUALITY\)\.catch\(\(\) => ""\);/.test(media), '兜底帧统一缩到长边 ≤896 的 JPEG 0.85');
assert(/function encodeJpeg\(dataUrl: string, maxEdge = MAX_EDGE, quality = JPEG_QUALITY\)/.test(media) && /canvas\.toDataURL\("image\/jpeg", quality\)/.test(media), 'encodeJpeg 支持长边 / 质量参数（图片仍用 1280 / 0.9）');
assert(/if \(jpeg && !images\.includes\(jpeg\)\) images\.push\(jpeg\);/.test(media), '重复帧去掉（短视频只留能取到的帧）');
assert(/if \(!images\.length\) throw new Error\("取不到画面：视频还没加载出来"\);/.test(media), '一帧都取不到才报错（至少 1 帧）');

assert(/export async function grabVideoFrameAt\(store: CanvasStore, n: CanvasNode, seconds: number\)/.test(registry), 'registry 导出 grabVideoFrameAt（按秒取帧）');
assert(/async function seekVideoFrame\(/.test(registry), 'seek / 临时 video 逻辑抽成一个内部函数');
assert.strictEqual(registry.split('seekVideoFrame(store, n, o,').length - 1, 2, 'grabVideoFrame 与 grabVideoFrameAt 共用同一段 seek（没有复制两份）');
assert(/at === "first"/.test(registry) && /at === "current"/.test(registry) && /Math\.min\(trim\.out, duration \|\| trim\.out\)/.test(registry), 'first / current / last 的取帧时间点原样保留');

// ---- 2c. 体积闸门：单帧 >8MB、总数 >8 帧都不发 ----
assert(/const MAX_BYTES = 8 \* 1024 \* 1024;/.test(media), '超过 8MB 不发');
assert(/function assertPayloadSize\(body: ParseBody\): void/.test(media), '发之前统一过体积闸门');
assert(/if \(body\.images\.length > MAX_FRAMES\) throw new Error/.test(media), '帧数超过上限也拒绝发送');
assert(/第 \$\{index \+ 1\} 帧约 \$\{Math\.round\(bytes \/ 1024 \/ 1024\)\}MB/.test(media), '视频超限时点名第几帧');
assert(/if \(bytes > MAX_BYTES\) throw new Error\(.画面约/.test(media), '图片 / 单帧超限提示不变');

// ---- 3. 接口 body：视频多帧 images + kind + table_only；图片 / 单帧仍 image + is_video_frame ----
assert(/const ENDPOINT = "\/api\/canvas-analyze-media";/.test(media), '请求打 /api/canvas-analyze-media');
assert(/method: "POST"/.test(media) && /"Content-Type": "application\/json"/.test(media), 'POST + Content-Type: application/json');
assert(/type ParseBody =\s*\| \{ image: string; is_video_frame: boolean \}\s*\| \{ video_url: string; kind: "video"; duration\?: number; table_only: true \}\s*\| \{ images: string\[\]; kind: "video"; duration\?: number; table_only: true \};/.test(media), '请求体三种形状：单图 image / 视频 video_url / 视频本地帧 images');
assert(/function backendReadableVideoUrl\(url: string\): boolean/.test(media) && /\^\\\/\(\?:assets\|output\)/.test(media) && /\^https\?:/.test(media), '只有 /assets、/output、http(s) 才交给后端自己抽帧');
assert(media.includes('return { video_url: videoUrl, kind: "video", table_only: true, ...(duration > 0 ? { duration } : {}) };'), '可读地址：发 video_url + kind + table_only（不带 images）');
assert(media.includes('const { images } = await videoFrames(store, node);') && media.includes('return { images, kind: "video", table_only: true, ...(duration > 0 ? { duration } : {}) };'), '读不到的地址才退回本地 8 帧 images');
assert(/const videoUrl = o\?\.url \? await fetchable\(store, o\.url\) : "";/.test(media), 'video_url 取视频节点当前结果地址（素材引用先解析）');
assert(media.indexOf('if (videoUrl && backendReadableVideoUrl(videoUrl))') < media.indexOf('const { images } = await videoFrames(store, node);'), '先判断后端能不能读地址，读不到才本地抽帧');
assert(/if \(!\('images' in body\)\) return;/.test(media) || /if \(!\("images" in body\)\) return;/.test(media), '体积闸门跳过 video_url 形态（没有本地帧要卡）');
assert(!/return \{ images, kind: "video"[^;]*table_only: false/.test(media), '图片 / 单帧不带 table_only');
assert(media.includes('{ image: await imageDataUrl(store, node), is_video_frame: false }'), '图片分支仍是单图 image');
assert(media.includes('{ image: await videoFrameDataUrl(store, node), is_video_frame: true }'), '「解析当前帧」仍是单图 + is_video_frame:true');
assert(/return \{ images, duration: Number\(o\?\.dur\) \|\| 0 \};/.test(media), '请求里的 duration 用 outOf().dur（没有就是 0 → 不带）');
assert(/body: JSON\.stringify\(\{\s*\.\.\.body,/.test(media), '同一份 requestParse 把 body 原样展开');
assert(/\.\.\.\(caption\.provider && caption\.model \? \{ provider: caption\.provider, model: caption\.model \} : \{\}\)/.test(media), '两个字段都齐才带 { provider, model }，缺失就不发');
assert(/function captionModel\(\)/.test(media) && /catch \{\s*return \{ provider: "", model: "" \};/.test(media), '读设置包 try/catch，解析失败当没配置');
assert(!/captionPrompt/.test(media), '只借平台 / 模型，不用素材库的 captionPrompt（四段式模板在后端）');
assert(/pick\(row\.detail\) \|\| pick\(row\.error\)/.test(media), '失败既认 {detail} 也认 {ok:false,error}');
assert(/\.ok === false/.test(media), 'HTTP 200 + ok:false 也算失败');
assert(/if \(requireText && !text\) throw new Error\("模型没有返回内容"\)/.test(media), 'table_only 的视频请求允许没有正文，图片 / 单帧仍要求有正文');
assert(/async function requestParse\(body: ParseBody, opts: \{ requireText\?: boolean; timeoutMs\?: number; timeoutText\?: string \} = \{\}\)/.test(media), 'requestParse 支持 requireText / timeout / timeoutText 选项');
assert(/const VIDEO_TIMEOUT_MS = 300 \* 1000;/.test(media), '长视频「首次 100s + 降级重试」→ 视频接口超时 300 秒');
assert(media.includes('const VIDEO_TIMEOUT_TEXT = "等待超时（这次用了 5 分钟）：素材可能太大，可以重试或换一段更短的视频";'), '超时 toast 是人话（不吐 signal is aborted without reason）');
assert(/function isAbortError\(error: unknown\): boolean/.test(media), 'AbortError 按 name / message 兜底识别（不同环境 instanceof DOMException 不一定成立）');
assert(/if \(isAbortError\(error\)\) throw new Error\(opts\.timeoutText \|\| "等待超时，请稍后再试"\);/.test(media), 'requestParse 捕获超时后抛人话');
assert(/const reason = isAbortError\(error\) \? "等待超时，请稍后再试"/.test(media), 'failureOf 也不会漏出浏览器原始 AbortError 文案');
assert(/console\.warn\("\[canvas\] 解析失败", error\)/.test(media), '异常留痕，不静默吞掉');
assert(/if \(!response\.ok\) throw new Error\(reasonOf\(data\) \|\| .接口返回 \$\{response\.status\}.\);/.test(media), 'HTTP 4xx/5xx 的 detail（含「HTTP 502」这类文案）原样抛出，没 detail 才退回「接口返回 <status>」');
assert(/store\.toast\(.解析失败：\$\{reason\}\$\{hint\}., 5000\)/.test(media), '失败 toast 直接用 reason 原文（不吞状态码）');

// ---- 4. 视频解析：只建「解析 · 分镜表」表格节点（连到视频、选中、12 列占位 + 1 空行），不建文本节点 ----
const videoFlowStart = media.indexOf('async function runVideoParse');
const videoFlow = media.slice(videoFlowStart, media.indexOf('/** 点「解析」', videoFlowStart));
assert(videoFlowStart > 0 && videoFlow.length > 0, '找得到视频解析专用流程 runVideoParse');
assert(!videoFlow.includes('newNode("text"'), '视频解析不建文本节点（也不再建「解析 · 视频」）');
assert(/if \(node\.kind === "video"\) return runVideoParse\(ctl, node\);/.test(media), 'parseMedia 把视频节点路由到 runVideoParse');
assert(/const TABLE_COLUMNS = \["镜号", "时长", "画面描述", "角色", "角色描述", "景别", "情绪", "光影氛围", "音效", "对白", "分镜提示词", "视频运动提示词"\];/.test(media), '前端留一份 12 列表头常量（和后端契约一致）');
const columnNames = ['镜号', '时长', '画面描述', '角色', '角色描述', '景别', '情绪', '光影氛围', '音效', '对白', '分镜提示词', '视频运动提示词'];
assert.strictEqual(columnNames.length, 12, '列名常量是 12 列');
assert(media.includes('const TABLE_COLUMNS = ["' + columnNames.join('", "') + '"];'), '12 列顺序与产品要求一致');
assert(/function emptyStoryboard\(\): TableData \{/.test(media), '建表占位函数 emptyStoryboard');
assert(/columns: \[\.\.\.TABLE_COLUMNS\], rows: \[TABLE_COLUMNS\.map\(\(\) => ""\)\]/.test(media), '占位是 12 列表头 + 1 行空行');
assert(/function createVideoTable\(store: CanvasStore, src: CanvasNode\): CanvasNode/.test(media), '视频建表函数 createVideoTable');
assert(/const x = src\.x \+ src\.w \+ GAP_X;/.test(media), '表格落在视频节点右侧（x = 源 x + w + 140）');
assert(/freeY\(store, src, x, src\.y, TABLE_W, TABLE_H\)/.test(media), 'y 对齐源节点，撞了按 60 往下让');
assert(media.includes('{ id: uid("t"), kind: "table", x, y: freeY(store, src, x, src.y, TABLE_W, TABLE_H), w: TABLE_W, h: TABLE_H, text: TABLE_TITLE }'), '表格标题「解析 · 分镜表」、尺寸 1240×360');
assert(/store\.addNodes\(\[node\], \[\{ id: uid\("e"\), from: src\.id, to: node\.id \}\], \{ select: true \}\);/.test(media), '建表同时连「视频 → 表格」的边并选中表格');
assert.strictEqual(media.split('store.toast("解析中…（约 1–3 分钟）", 180000);').length - 1, 1, '视频解析 toast「约 1–3 分钟」只发一次');
assert(/requestParse\(payload, \{ requireText: false, timeoutMs: VIDEO_TIMEOUT_MS, timeoutText: VIDEO_TIMEOUT_TEXT \}\)/.test(media), '视频请求允许空正文、300 秒超时、超时用人话');
assert(/const data = tableDataOf\(parsed\.table\);/.test(videoFlow), '成功时取响应里的 table');
assert(/if \(!data\) throw new Error\("模型没有返回分镜表"\);/.test(videoFlow), '响应没有表格按失败处理（写原因，不留空表）');
assert(/if \(store\.node\(table\.id\)\) fillTable\(store, table\.id, data\);/.test(videoFlow), '成功把响应列 / 行写进这个表格节点');
assert(/store\.toast\(parsed\.model \? .已生成分镜表（\$\{parsed\.model\}）. : "已生成分镜表"\);/.test(videoFlow), '成功 toast「已生成分镜表（模型名）」');
assert(/writeTableFailure\(store, table\.id, reason\);/.test(videoFlow), '失败把原因写进表格第一行');
assert(!/removeNodes\(/.test(media), '失败不删节点（视频表格保留）');
assert(/const found = columns\.indexOf\("画面描述"\);/.test(media), '失败写进「画面描述」列');
assert(/解析失败：\$\{reason\}/.test(media), '表格 / 文本失败正文都带「解析失败：<原因>」');
assert(videoFlow.indexOf('createVideoTable(store, src)') < videoFlow.indexOf('store.toast("解析中…（约 1–3 分钟）"'), '先建表再 toast');
assert(videoFlow.indexOf('store.toast("解析中…（约 1–3 分钟）"') < videoFlow.indexOf('await collect(store, node, false)'), 'toast 在取画面 / 发地址之前');
assert(videoFlow.indexOf('await collect(store, node, false)') < videoFlow.indexOf('await requestParse(payload, { requireText: false'), '取完帧再打接口');

// ---- 5. 图片解析：只建文本节点（四段 + 骨架），不建表格；单帧入口同样只建文本 ----
const textFlowStart = media.indexOf('async function runParse');
const textFlow = media.slice(textFlowStart, videoFlowStart);
assert(textFlowStart > 0 && textFlow.length > 0, '找得到「文本」流程 runParse');
assert(/const GAP_X = 140;/.test(media) && /const DROP_Y = 60;/.test(media), 'x = 源右侧 +140，避让步长 60');
assert(/store\.newNode\("text", x, freeY\(store, src, x, src\.y\)/.test(textFlow), '图片 / 单帧建 kind "text" 节点');
assert(/hist: \[\{ text: "" \}\],/.test(textFlow), '解析期间正文留空，不写「解析中…」这类临时文案');
assert(/hi: 0,/.test(textFlow) && /manual: true,/.test(textFlow), '按「粘贴的文本」的写法落 hi / manual');
assert(/title: .解析 · \$\{genOf\(src\)\.title/.test(textFlow), '标题「解析 · 源节点标题」点击时就定好');
assert(/store\.addNodes\(\[text\], \[\{ id: uid\("e"\), from: src\.id, to: text\.id \}\], \{ select: true \}\)/.test(textFlow), '同一次 addNodes 把节点和「源 → 文本」的边加进去，并选中新节点');
assert(/store\.toast\("解析中…（约 10–40 秒）", 40000\);/.test(textFlow), '图片 / 单帧 toast 仍是「约 10–40 秒」');
assert.strictEqual(media.split('store.toast("解析中…（约 10–40 秒）", 40000);').length - 1, 1, '10–40 秒 toast 只发一次');
assert(!textFlow.includes('withTable('), '图片解析没有 withTable 调用');
assert(!textFlow.includes('tableDataOf'), '图片解析不读响应里的 table');
assert(!media.includes('addStoryboardTable'), '图片建表函数已删掉（表格只给视频解析）');
assert(!/const TABLE_GAP =/.test(media), '图片表格的 80px 间距常量已删掉');
assert(!/const table = !singleFrame/.test(media), '图片 / 单帧都没有建表分支');
assert(/requestParse\(payload\)/.test(textFlow), '图片请求仍走 requestParse（不带 table_only / video_url）');
assert(/export async function parseMedia\(ctl: Ctl, node: CanvasNode\): Promise<void> \{\s*if \(node\.kind === "video"\) return runVideoParse\(ctl, node\);\s*return runParse\(ctl, node, false\);/.test(media), '图片 = runParse(false)，视频 = runVideoParse');
assert(/export async function parseMediaFrame\(ctl: Ctl, node: CanvasNode\): Promise<void> \{\s*return runParse\(ctl, node, true\);/.test(media), '「解析当前帧」= runParse(true)（单帧、只建文本节点）');

// 成功 / 失败正文（图片 + 单帧）
assert(media.includes('if (store.node(text.id)) store.patchGen(text.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, text: body } : h)) }), { history: true });'), '成功后把四段正文写进新建文本节点的当前版本');
assert(/store\.toast\(parsed\.model \? .已生成解析提示词（\$\{parsed\.model\}）. : "已生成解析提示词"\)/.test(textFlow), '图片 / 单帧成功 toast 文案不变');
assert(/text: .解析失败：\$\{reason\}/.test(media), '失败把「解析失败：<原因>」写进文本节点正文');
assert(/store\.toast\(.解析失败：\$\{reason\}\$\{hint\}., 5000\)/.test(media), '失败 toast 同原因并接指路文案');
assert(/const hint = reason\.includes\("模型"\) && !\/key\/i\.test\(reason\) \? "（可在 设置 › API 设置 里配一个能看图的模型）" : "";/.test(media), '只有原因含「模型」且不含 Key 才补指路');
assert(/let text: CanvasNode;/.test(media) && /inFlight\.delete\(node\.id\);\s*return;/.test(media), '建节点本身失败只 toast');
assert(/const inFlight = new Set<string>\(\);/.test(media), '按节点 id 维护模块级 Set');
assert(/inFlight\.has\(node\.id\)\).*store\.toast\("正在解析…"\)/.test(media), '进行中再点提示「正在解析…」');
assert(/finally \{[\s\S]*?inFlight\.delete\(node\.id\);/.test(media), '结束（成功 / 失败）都释放');

// ---- 5b. 解析期间显示「文本生成中」的骨架 + 脉冲点：纯界面态（store.ui.parsing），不进文档 ----
assert(/parsing: Set<string>;/.test(storeSrc), 'store UIState 有「正在解析的节点 id」集合');
assert(/parsing: new Set<string>\(\)/.test(storeSrc), '初始化为空 Set');
assert(/export type UIState = \{[\s\S]*?parsing: Set<string>;/.test(storeSrc), 'parsing 在 UIState（纯界面状态）里，不在文档类型里');
assert(/store\.setUI\(\{ parsing: new Set\(\[\.\.\.store\.state\.ui\.parsing, text\.id\]\) \}\)/.test(media), '图片 / 单帧建完节点后置位');
assert(/store\.setUI\(\{ parsing: new Set\(\[\.\.\.store\.state\.ui\.parsing\]\.filter\(\(id\) => id !== text\.id\)\) \}\)/.test(media), 'finally 里按 id 清位');
assert(!/patchGen\([^)]*parsing|withGen\([^)]*parsing/.test(media), '解析态不写进 gen / 文档');
assert(!/parsing/.test(backendSrc), '文档序列化（novaiBackend）里没有解析态字段');
assert(/const parsing = useS\(\(s\) => s\.ui\.parsing\.has\(node\.id\)\);/.test(nodeView), 'NodeView 按 ui.parsing 读当前节点是否在解析');
assert(/\(running \|\| parsing\) && node\.kind === "text"\) return p\.run\?\.stream \? .*: <TextSkeleton \/>;/.test(nodeView), '解析期间正文用现成的 TextSkeleton');
assert(/aria-label="解析中"/.test(nodeView) && /className="runsig"/.test(nodeView), '标题栏脉冲点 aria-label 改「解析中」');
assert(/<Body \{\.\.\.p\} out=\{out\} running=\{running\} parsing=\{parsing\} hover=\{hoverNode\} \/>/.test(nodeView), 'parsing 传进 Body');

// ---- 6. 四段式正文：标记行 → 标题；四段不齐保留原文 ----
assert(/export function formatParsedPrompt/.test(media), '四段标题格式化函数 formatParsedPrompt 存在');
for (const title of ['【中文 · 正向】', '【中文 · 负向】', '【English · Positive】', '【English · Negative】']) {
    assert(media.includes(title), '缺少标题 ' + title);
}
assert(/const SECTION_ORDER: SectionKey\[\] = \["cnPos", "cnNeg", "enPos", "enNeg"\];/.test(media), '四段按固定顺序输出');
assert(/if \(!complete\) return text;/.test(media), '四段没齐就原文照写');
assert(/sectionOf\(mark\[1\]\)/.test(media), '标记行标签映射到四段');

// ---- 7. 构建产物 ----
assert.strictEqual(built.split('解析：反推画面的提示词').length - 1, 2, '构建产物里图片 / 视频工具条各一颗「解析」');
assert(built.includes('canvas-analyze-media'), '构建产物里带接口地址');
assert(built.includes('已生成解析提示词'), '构建产物里带图片 / 单帧成功文案');
assert(built.includes('已生成分镜表'), '构建产物里带视频成功文案「已生成分镜表」');
assert(built.includes('解析中…（约 1–3 分钟）'), '构建产物里带视频「解析中…（约 1–3 分钟）」');
assert(built.includes('等待超时（这次用了 5 分钟）'), '构建产物里带超时的人话文案');
assert(built.includes('解析中…（约 10–40 秒）'), '构建产物里带图片 / 单帧「解析中…（约 10–40 秒）」');
assert(built.includes('解析当前帧'), '构建产物里带「更多 › 解析当前帧」');
assert(built.includes('解析 · 分镜表'), '构建产物里带分镜表节点标题');
assert(built.includes('table_only'), '构建产物里带 table_only');
assert(built.includes('video_url'), '构建产物里带 video_url');
assert(built.includes('kind:"video"'), '构建产物里视频请求体带 kind:"video"');
assert(built.includes('images:'), '构建产物里视频请求体带 images 数组');
assert(built.includes('【English · Negative】'), '构建产物里带四段标题');
assert(built.includes('asset_manager_local_caption_settings_v1'), '构建产物里读素材库反推设置');
assert(built.includes('可在 设置 › API 设置 里配一个能看图的模型'), '构建产物里带失败指路文案');

console.log('[analyze-prompt] 全部通过（视频：可读地址发 video_url + table_only、读不到退回本地 6 帧 896/0.85；只建分镜表 + 源→表边 + 12 列占位/响应替换/失败写原因 / 图片只建文本、无表格 / 解析当前帧只建文本 / 体积闸门 / 四段式 / 构建产物）');
