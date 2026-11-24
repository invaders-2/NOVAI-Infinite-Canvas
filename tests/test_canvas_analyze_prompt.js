#!/usr/bin/env node
/* 画布「解析」按钮（图片 / 视频节点）：点完立刻建文本节点 + 连线，取画面交给 /api/canvas-analyze-media，
   四段提示词回来写回该节点、失败把原因写进正文。
   覆盖：两颗按钮的落位与 data-tb 来源、先建节点并连线再请求、成功回填 / 失败保留节点、
        解析期的骨架 + 脉冲点（纯界面态，不进文档）、取帧 / 缩图、接口调用与错误处理、
        四段式正文格式化、防重复点击、构建产物里真的有这颗按钮。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const media = read('novai-canvas-ui/src/canvas/canvas-next/ui/parseMedia.ts');
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

const videoStart = panel.indexOf('else if (node.kind === "video" && out) items = [');
assert(videoStart > 0, '找得到视频工具条');
const video = panel.slice(videoStart, panel.indexOf('];', videoStart));
assert(video.includes('B("parse", "wand", "解析：反推画面的提示词，自动生成一个文本节点", "解析"'), '视频按钮的标签 / 提示文案');
assert(video.indexOf('B("frame"') < video.indexOf('B("parse"'), '视频：解析在「截帧」之后');
assert(video.indexOf('B("parse"') < video.indexOf('"data-tb": "vmore"'), '视频：解析在「更多」之前');
assert(panel.includes('import { parseMedia } from "./parseMedia";'), '工具条走 parseMedia 入口');

// ---- 2. 取画面：图片走结果图地址 + resolveAsset；视频复用 grabVideoFrame，顺序是 当前帧 → 封面 → 首帧 ----
assert(!/runNode\(/.test(media) && !/from "\.\.\/engine"/.test(media), '不挂到画布生成运行时（不占 runNode 通道）');
assert(/outOf\(node\)\?\.url/.test(media), '图片取结果图地址 outOf(node).url');
assert(/isAssetRef\(url\)/.test(media) && /backend\.resolveAsset\(url\)/.test(media), 'novai-asset 引用先 resolveAsset');
assert(/await toDataUrl\(src, MAX_EDGE\)/.test(media), '复用编辑器的取字节 + 缩图（toDataUrl）');
assert(/const MAX_EDGE = 1280;/.test(media) && /const JPEG_QUALITY = 0.9;/.test(media), '长边 ≤1280、JPEG 0.9');
assert(/toDataURL\("image\/jpeg", JPEG_QUALITY\)/.test(media), '统一再编码成 JPEG 0.9');
const currentAt = media.indexOf('grabVideoFrame(store, node, "current")');
const coverAt = media.indexOf('if (o?.frame) {');
const firstAt = media.indexOf('grabVideoFrame(store, node, "first")');
assert(currentAt > 0 && coverAt > currentAt && firstAt > coverAt, '视频取帧顺序：当前播放帧 → 封面 → 首帧');
assert(/const MAX_BYTES = 8 \* 1024 \* 1024;/.test(media), '超过 8MB 不发');
assert(/if \(bytes > MAX_BYTES\) throw new Error/.test(media), '体积超限时给一句中文原因');

// ---- 3. 接口：同源相对路径 + JSON，带上素材库「反推设置」的平台 / 模型，两种失败形状都取中文原因 ----
assert(/const ENDPOINT = "\/api\/canvas-analyze-media";/.test(media), '请求打 /api/canvas-analyze-media');
assert(/method: "POST"/.test(media) && /"Content-Type": "application\/json"/.test(media), 'POST + Content-Type: application/json');
assert(/body: JSON\.stringify\(\{\s*image,/.test(media) && /is_video_frame: isVideoFrame,/.test(media), 'body 里是 image / is_video_frame');
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
assert(/import \{ bounds, genOf, outOf, uid \} from "\.\.\/model";/.test(media), 'uid 从 model 引入');

const newNodeAt = media.indexOf('store.newNode("text", x, freeY');
const addAt = media.indexOf('store.addNodes([text], [{ id: uid("e")');
const startAt = media.indexOf('store.toast("解析中…（约 10–40 秒）", 40000);');
assert(newNodeAt > 0 && addAt > newNodeAt, '先建节点，再一次 addNodes 加边');
assert(addAt < media.indexOf('await analyze(store, node)'), '建节点 / 连线在取画面之前');
assert(addAt < media.indexOf('await requestParse('), '建节点 / 连线在打接口之前');
assert(startAt > addAt, '建完节点、reveal 之后才 toast 即时反馈');
assert(startAt < media.indexOf('await analyze(store, node)'), '即时反馈也在取画面之前');
assert.strictEqual(media.split('store.toast("解析中…（约 10–40 秒）", 40000);').length - 1, 1, '即时反馈只发一次（第二个参数 40000ms）');

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

// ---- 4c. 解析期间显示「文本生成中」的骨架 + 脉冲点：纯界面态（store.ui.parsing），不进文档 ----
assert(/parsing: Set<string>;/.test(storeSrc), 'store UIState 加了「正在解析的节点 id」集合');
assert(/parsing: new Set<string>\(\)/.test(storeSrc), '初始化为空 Set');
assert(/export type UIState = \{[\s\S]*?parsing: Set<string>;/.test(storeSrc), 'parsing 在 UIState（纯界面状态）里，不在文档类型里');
assert(/store\.setUI\(\{ parsing: new Set\(\[\.\.\.store\.state\.ui\.parsing, text\.id\]\) \}\)/.test(media), '建完节点 / 连线后立刻置位');
const setParsingAt = media.indexOf('store.setUI({ parsing: new Set([...store.state.ui.parsing, text.id]) })');
assert(setParsingAt > media.indexOf('store.addNodes([text], [{ id: uid("e")'), '置位在建节点 / 连线之后');
assert(setParsingAt < media.indexOf('await analyze(store, node)'), '置位在取画面 / 打接口之前');
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

// ---- 6. 构建产物：两颗按钮和接口地址真的进了 static/novai-canvas ----
assert.strictEqual(built.split('解析：反推画面的提示词').length - 1, 2, '构建产物里图片 / 视频工具条各一颗「解析」');
assert(built.includes('canvas-analyze-media'), '构建产物里带接口地址');
assert(built.includes('已生成解析提示词'), '构建产物里带成功文案');
assert(built.includes('【English · Negative】'), '构建产物里带四段标题');
assert(built.includes('asset_manager_local_caption_settings_v1'), '构建产物里读素材库反推设置');
assert(built.includes('已生成解析提示词（'), '构建产物里成功 toast 带模型');
assert(built.includes('解析中…（约 10–40 秒）'), '构建产物里带点完即出的「解析中…（约 10–40 秒）」反馈');
assert(built.includes('parsing'), '构建产物里带解析态（store.ui.parsing）');
assert(built.includes('解析中'), '构建产物里带「解析中」脉冲点 / toast 文案');
assert(built.includes('可在 设置 › API 设置 里配一个能看图的模型'), '构建产物里带失败指路文案');

console.log('[analyze-prompt] 全部通过（两处按钮落位 / 取帧缩图 / 先建节点并连线再请求 / 成功回填正文 / 失败保留节点写原因 / 解析态骨架与脉冲点不进文档 / 四段式正文 / 构建产物）');
