#!/usr/bin/env node
'use strict';
/*
 * BEAT 弹窗缩略图化静态回归：弹窗 / 列表位必须走缩略图，灯箱 / 图像编辑器 / 导出继续用原图。
 *
 * 覆盖真实行为点：
 *   1. 缩略图基建 useThumbnailUrl：本地素材 → /api/media-preview（按显示宽度归一档位）、首帧就挂缩略图、
 *      data URL 走主线程缩到 768 长边（thumbStep / STEPS / MAX_EDGE 不能被改小改没）；
 *   2. 弹窗 / 列表位全部换成 ThumbImg / PreviewImg：@ 引用面板、助手上下文胶囊 / mention 行 / 引用卡 / 回复引用、
 *      提示词编辑器菜单 / 元素缩略 / 胶囊悬停大预览、生成面板 ChipImg / RowThumb / dot / style-peek、
 *      元素库 RefImg、角色生成 RefThumb、旧节点参考图 —— 这些位如果退回原图，弹窗又会解码几十 MB；
 *   3. 原图位保留：全屏看图（ImageViewer）、无损改图（LosslessEdit）、导出（exportCanvas）仍用原图地址，
 *      ThumbImg 只做展示、失败退回原图，不能把「看图 / 编辑 / 导出」也缩了；
 *   4. @ 引用列表的 10 秒短缓存：只缓存成功结果、CACHE_MS = 10 秒；
 *   5. 构建产物 static/novai-canvas/canvas.js 里带上 /api/media-preview 与宽度档位（大图弹窗的新逻辑真的进了产物）。
 *
 * 跑法：node tests/test_beat_popup_thumbnails.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const ui = 'novai-canvas-ui/src/canvas/canvas-next/';
const tapnow = 'novai-canvas-ui/src/canvas/tapnow/';

/* ───────── [1] 缩略图基建 ───────── */
console.log('[1] 缩略图基建 useThumbnailUrl / previewThumbUrl');
const useThumb = read(ui + 'ui/useThumbnail.ts');
ok(/export function useThumbnailUrl\(src: string, cssWidth = 320\)/.test(useThumb), 'useThumbnailUrl(src, cssWidth) 存在');
ok(/const STEPS = \[256, 384, 512, 768, 1024, 1536\]/.test(useThumb), '宽度档位 STEPS = [256,384,512,768,1024,1536]');
ok(/const MAX_EDGE = 768/.test(useThumb), 'data URL 缩到长边 768（MAX_EDGE）');
ok(/\* 2\.5/.test(useThumb), '按显示宽度 × 2.5 归一档位（高分屏也不糊）');
ok(/useState\(\(\) => previewThumbUrl\(full, thumbStep\(cssWidth\)\) \|\| full\)/.test(useThumb),
    '首帧就挂缩略图地址（不会先按原图解码一帧）');
ok(/previewThumbUrl\(full, thumbStep\(cssWidth\)\)/.test(useThumb), '缩略图地址统一由 previewThumbUrl 生成');
ok(/toDataURL\("image\/webp", \.84\)/.test(useThumb), 'data URL 走主线程 canvas 缩图（webp）');
ok(/MAX_ITEMS = 80/.test(useThumb), 'data URL 缩图有 LRU 上限');

const table = read(ui + 'table.ts');
ok(/export function previewThumbUrl\(url: string, width = 512\): string/.test(table), 'table.ts 的 previewThumbUrl(url, width) 存在');
ok(table.includes('(?:assets|output)') && table.includes('return raw;'), 'previewThumbUrl 只拦本地 /assets、/output（外链原样返回）');
ok(table.includes('/api/media-preview?w='), 'previewThumbUrl 命中 /api/media-preview?w=');
ok(table.includes('encodeURIComponent(raw)'), 'previewThumbUrl 把原图地址编码进 url 参数');
ok(/Math\.max\(64, Math\.min\(2048, Math\.round\(Number\(width\) \|\| 512\)\)\)/.test(table), '宽度 clamp 到 64..2048（和后端一致）');

/* ───────── [2] 弹窗 / 列表位全部走缩略图 ───────── */
console.log('[2] 弹窗 / 列表位换成 ThumbImg（不再直接挂原图）');
const mention = read(ui + 'agent/MentionPalette.tsx');
ok(/import \{ ThumbImg \} from "\.\.\/ui\/thumb"/.test(mention), '@ 引用面板引入 ThumbImg');
ok(/<ThumbImg src=\{src\} width=\{36\}/.test(mention), '@ 引用面板行缩略图 36px（走缩略图）');

const panel = read(tapnow + 'AgentPanel.tsx');
ok(/import \{ ThumbImg \} from "\.\.\/canvas-next\/ui\/thumb"/.test(panel), 'AgentPanel 引入 ThumbImg');
ok(/<ThumbImg src=\{src\} width=\{17\}/.test(panel), '上下文胶囊缩略图 17px');
ok(/<ThumbImg src=\{src\} width=\{24\}/.test(panel), 'mention 行缩略图 24px');
ok(/<ThumbImg src=\{src\} width=\{14\}/.test(panel), '回复里的节点引用 14px');
ok(/<ThumbImg className="cthumb" src=\{c\.src\} width=\{30\}/.test(panel), '消息里的上下文缩略图 30px');
ok(/<ThumbImg src=\{src\} width=\{96\}/.test(panel), '结果卡缩略图 96px');
ok(!/<img[^>]*src=\{src\}/.test(panel), 'AgentPanel 里没有直接 <img src={src}> 的展示位（都走 ThumbImg）');

const prompt = read(ui + 'ui/PromptEditor.tsx');
ok(/function MenuThumb[\s\S]{0,400}<ThumbImg src=\{srcOf\(node\)\} width=\{24\}/.test(prompt), '提示词编辑器菜单缩略图 24px');
ok(/function ElThumb[\s\S]{0,200}<ThumbImg src=\{el\.refs\[0\] \|\| ""\} width=\{24\}/.test(prompt), '提示词菜单里的元素缩略图 24px');
ok(/function PrevMember[\s\S]{0,400}<ThumbImg src=\{srcOf\(n\)\} width=\{72\}/.test(prompt), '分组/堆叠预览成员缩略图 72px');
ok(/<ThumbImg src=\{u\} width=\{180\}/.test(prompt), '胶囊悬停大预览 180px 宽也用缩略图');

const gen = read(ui + 'ui/GenPanel.tsx');
ok(/function ChipImg[\s\S]{0,200}<ThumbImg src=\{src\} width=\{28\}/.test(gen), 'GenPanel ChipImg 28px 走缩略图');
ok(/function RowThumb[\s\S]{0,260}<ThumbImg src=\{src\} width=\{28\}/.test(gen), 'GenPanel RowThumb 28px 走缩略图');
ok(/<ThumbImg src=\{src\} width=\{24\}/.test(gen), 'GenPanel 参数 dot 24px 走缩略图');
ok(/data-style-peek=[\s\S]{0,200}<ThumbImg src=\{src\} width=\{160\}/.test(gen), 'GenPanel 风格大预览 160px 走缩略图');

const elements = read(ui + 'ui/Elements.tsx');
ok(/function RefImg[\s\S]{0,200}<ThumbImg src=\{src\} width=\{72\}/.test(elements), '元素库 RefImg 72px 走缩略图');
const chgen = read(ui + 'ui/CharacterGenerate.tsx');
ok(/function RefThumb[\s\S]{0,200}<ThumbImg src=\{src\} width=\{72\}/.test(chgen), '角色生成 RefThumb 72px 走缩略图');
ok(/<PreviewImg src=\{run\.url \|\| ""\} width=\{240\}/.test(chgen), '角色生成结果预览走 PreviewImg（缩略图优先）');
const legacy = read(ui + 'ui/LegacyNodes.tsx');
ok(/<ThumbImg src=\{ref\} width=\{18\}/.test(legacy), '旧节点参考图小图 18px 走缩略图');

/* ───────── [3] 原图位必须保留 ───────── */
console.log('[3] 灯箱 / 图像编辑器 / 导出仍然用原图');
const viewer = read(ui + 'ui/ImageViewer.tsx');
ok(/useAssetUrl\(item\?\.src \|\| ""\)/.test(viewer) && /<img src=\{url\}/.test(viewer), '全屏看图（灯箱）用原图地址');
ok(!/ThumbImg|useThumbnailUrl/.test(viewer), '灯箱没有走缩略图');
const lossless = read(ui + 'ui/editors/LosslessEdit.tsx');
ok(/const aiRaw = outOf\(n\)\?\.url \|\| ""/.test(lossless), '无损改图吃的是节点原图 outOf(n).url');
ok(/useAssetUrl\(outOf\(node\)\?\.url \|\| ""\)/.test(lossless), '无损改图的预览用原图解析（不是缩略图）');
ok(!/ThumbImg|useThumbnailUrl/.test(lossless), '无损改图没有走缩略图');
const exporter = read(ui + 'exportCanvas.ts');
ok(/const o = outOf\(node\)/.test(exporter), '导出取节点原图 outOf(node)');
ok(!/ThumbImg|useThumbnailUrl|media-preview/.test(exporter), '导出链路没有缩略图化');
const colorAdjust = exists(ui + 'ui/editors/ColorAdjust.tsx') ? read(ui + 'ui/editors/ColorAdjust.tsx') : '';
ok(!!colorAdjust && !/ThumbImg|useThumbnailUrl/.test(colorAdjust), '调色编辑器没有被缩略图化');
const thumbSrc = read(ui + 'ui/thumb.tsx');
ok(/s === 0 && small !== full \? 1 : 2/.test(thumbSrc), 'ThumbImg 缩略图失败会退回原图（不留空白）');
ok(/继续用原图/.test(thumbSrc), 'thumb.tsx 注释明确「灯箱/编辑器/导出/生成请求用原图」');

/* ───────── [4] @ 引用列表短缓存：应用 10s / 素材库 1.5s，失败不缓存，写完立刻作废 ───────── */
console.log('[4] listAgentReferences 分档缓存 + 失败/写后行为');
const refs = read(ui + 'agent/references.ts');
ok(/const APPS_TTL = 10_000/.test(refs), '应用目录缓存 10 秒（变化慢）');
ok(/const ASSETS_TTL = 1_500/.test(refs), '素材库缓存收短到 1.5 秒（新增后尽快可见）');
ok(/if \(hit && now - hit\.at < ttl\) return hit\.value/.test(refs), 'TTL 内直接返回缓存（不重复拉）');
ok(/export function invalidateAgentReferences\(\): void/.test(refs) && /assetsCache = null/.test(refs), '导出 invalidateAgentReferences()，只作废素材库缓存');
ok(/result\.ok !== false/.test(refs) && /素材库不可用/.test(refs), '认 {ok:false} 为失败（bridge 不 reject 也不会被当成空列表）');
ok(/if \(part\.error && slot\(\)\?\.value === value\) replace\(null\)/.test(refs), '失败结果从缓存里剔除（下次打开真的重试）');
ok(/listAgentReferences\(\)\.then/.test(mention), '@ 面板挂载时拉一次引用列表');
ok(/!loading && !choices\.length && !error/.test(mention), '有错误时不再显示「没有匹配的引用」');
ok(/mention-error/.test(mention) && /仍可使用画布节点/.test(mention), '@ 面板有错误时会显示原因（不静默空列表）');
const bridge = read('novai-canvas-ui/src/novaiBridge.ts');
ok(/import \{ invalidateAgentReferences \}/.test(bridge), 'novaiBridge 引入 invalidateAgentReferences');
ok(/async function afterLibraryWrite/.test(bridge) && /finally \{ invalidateAgentReferences\(\); \}/.test(bridge), '素材库写完（finally）立刻作废引用缓存');
ok(/canvas\/assetLibrary\/import"\) return afterLibraryWrite/.test(bridge) && /canvas\/assetLibrary\/upsert"\) return afterLibraryWrite/.test(bridge) && /canvas\/assetLibrary\/delete"\) return afterLibraryWrite/.test(bridge),
    'import / upsert / delete 三条写路径都走 afterLibraryWrite');

/* ───────── [4b] 无损改图选择器 / 生成历史 / 灯箱版本条 / 时间线片段 ───────── */
console.log('[4b] 无损改图选择器、历史抽屉、灯箱版本条、时间线片段也走缩略图');
const losslessFull = read(ui + 'ui/editors/LosslessEdit.tsx');
ok(/const PICK_THUMB_W = 384/.test(losslessFull), '无损改图选择器格子上限 384 档缩略图');
ok(/const thumb = previewThumbUrl\(full, PICK_THUMB_W\)/.test(losslessFull), 'PickCell 用 previewThumbUrl 生成格子缩略图');
ok(/const raw = outOf\(n\)\?\.url \|\| ""/.test(losslessFull) && /onPick\(url, titleOf\(n\)/.test(losslessFull), '点选时交给工具页的仍是原图地址（不是缩略图）');
ok(/选择画布图片/.test(losslessFull) && /pick-request/.test(losslessFull), '工具里点素材槽 → 宿主「选择画布图片」选择器');

const chrome = read(ui + 'ui/Chrome.tsx');
ok(/function Thumb\(\{ src \}: \{ src: string \}\) \{ return <ThumbImg src=\{src\} width=\{42\}/.test(chrome), '生成历史列表行缩略图 42px（ThumbImg）');
ok(/<ThumbImg src=\{src\} width=\{100\} fallback=\{null\} \/>/.test(chrome), '素材抽屉网格 100px 走缩略图');
ok(/function LbThumb\(\{ src \}: \{ src: string \}\) \{ return <ThumbImg src=\{src\} width=\{88\}/.test(chrome), '灯箱版本条缩略图 88px（ThumbImg）');
ok(/const imgUrl = useAssetUrl\(imgSrc\)/.test(chrome) && /<img className=\{zoom\.imgClass\} ref=\{zoom\.assignImg\} src=\{imgUrl\}/.test(chrome), '灯箱主图仍用原图地址（useAssetUrl，不是缩略图）');
ok(/function NodeRow[\s\S]{0,600}<ThumbImg src=\{src\} width=\{42\}/.test(chrome), '文件面板列表行缩略图 42px');

const timeline = read(ui + 'ui/TimelineEditor.tsx');
ok(/useThumbBg\(useAssetUrl\(t === "video" \? c\.thumb \|\| \(isImg \? c\.url : ""\) : ""\), 160\)/.test(timeline),
    '时间线片段封面：视频走 thumb、图片走 url，统一 useThumbBg(160)');
ok(/grabThumb\(u, c\.inPoint \+ 0\.05\)/.test(timeline), '视频片段没有封面时仍从入点现取一帧（逻辑没动）');
ok(/backgroundImage: thumb \?/.test(timeline), '片段封面以背景图渲染，无封面时留空不拉原图');

const thumbHelpers = read(ui + 'ui/thumb.tsx');
ok(/export function useThumbBg\(src: string, width: number\): string/.test(thumbHelpers), 'useThumbBg(src, width) 存在');
ok(/const small = previewThumbUrl\(src, width\)/.test(thumbHelpers) && /probe\.onerror = \(\) => \{ if \(alive\) setUrl\(src\); \}/.test(thumbHelpers),
    'useThumbBg 走 previewThumbUrl，失败才退回原图');

/* ───────── [5] 构建产物 ───────── */
console.log('[5] 构建产物带上缩略图逻辑');
const beatJsRel = 'static/novai-canvas/canvas.js';
ok(exists(beatJsRel), beatJsRel + ' 存在');
const beatJs = exists(beatJsRel) ? fs.readFileSync(path.join(root, beatJsRel), 'utf8') : '';
ok(beatJs.includes('/api/media-preview'), '构建产物 canvas.js 含 /api/media-preview');
ok(beatJs.includes('media-preview?w='), '构建产物含 media-preview?w= 的拼装');
ok(beatJs.includes('256,384,512,768,1024,1536'), '构建产物含宽度档位 [256..1536]');
ok(beatJs.length > 1000, '构建产物非空（' + beatJs.length + ' 字节）');

ok(exists('static/v2/index.html'), 'static/v2/index.html 存在');

console.log('');
console.log('BEAT 弹窗缩略图化（静态）：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach((f) => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
process.exit(0);
