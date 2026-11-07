#!/usr/bin/env node
'use strict';
/*
 * 图片节点 GIF「hover 播放 / 移开回静态」回归。
 *
 * 背景：画布不虚拟化，所有节点常驻 DOM，只靠 #world 的 transform:scale 缩放；把所有 GIF 的
 * 原图默认挂进 <img> 就是所有 GIF 常驻解码。所以默认态必须是静态（优先 /api/media-preview
 * 缩略图，拿不到静态帧时用 canvas 自绘首帧 poster），只有指针进到节点正文才换原图。
 * 这里只做静态事实断言（源码 + 构建产物），运行时效果由 _verification-gif-hover/probe.py 实测。
 *
 * 跑法：node tests/test_canvas_gif_hover_playback.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeView = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx'), 'utf8');
const thumb = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/useThumbnail.ts'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'static/novai-canvas/canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const mediaImg = nodeView.slice(nodeView.indexOf('function MediaImg('), nodeView.indexOf('function Loading('));
const bodyFn = nodeView.slice(nodeView.indexOf('function Body('), nodeView.indexOf('function MediaImg('));

console.log('[1] GIF 判定基于解析后的原图地址');
ok(/export const isGifUrl = \(url: string\) => \/\^data:image\\\/gif\/i\.test\(url\) \|\| \/\\\.gif\(\?:\$\|\[\?#\]\)\/i\.test\(url\);/.test(thumb), 'isGifUrl 同时认 data:image/gif 和带 query 的 .gif 路径');
ok(/const full = useAssetUrl\(src\);/.test(mediaImg) && /const gif = isGifUrl\(full\);/.test(mediaImg), 'MediaImg 用解析后的原图地址判定 GIF');
ok(!/isGifUrl\(src\)/.test(mediaImg), '不拿未解析的 novai-asset: 引用判定');

console.log('[2] 默认态是静态，原图只在 hover 时挂上');
ok(/const shown = gif && play \? full : still;/.test(mediaImg), 'shown = play ? 原图 : 静态');
ok(/const still = gif \? \(url && url !== full && !thumbBroken \? url : poster\)/.test(mediaImg), '静态态优先缩略图，缩略图就是原图/裂了才用 poster');
ok(!/<img[^>]*src=\{src\}/.test(mediaImg) && !/<img[^>]*src=\{full\}/.test(mediaImg), '<img> 不直接吃原图地址（默认态不会把动画放出来）');
ok(/if \(!shown\) return gif \? null : /.test(mediaImg), '首帧还没画好时 GIF 宁可空着也不拿原图顶上');

console.log('[3] 存在自绘首帧 poster 兜底');
ok(/export function useGifPoster\(src: string\): string/.test(thumb), 'useGifPoster() 存在');
ok(/const poster = useGifPoster\(gif && \(url === full \|\| thumbBroken\) \? full : ""\);/.test(mediaImg), '只有缩略图等于原图或裂掉时才去画首帧');
ok(/ctx\.drawImage\(image, 0, 0, canvas\.width, canvas\.height\);/.test(thumb), 'poster 用 canvas 画第一帧');
ok(/resolve\(canvas\.toDataURL\("image\/webp", \.9\)\);/.test(thumb), 'poster 输出 webp data URL（只在内存里）');
ok(/const posterCache = new Map<string, string>\(\)/.test(thumb) && /posterCache\.get\(src\)/.test(thumb), 'poster 按地址缓存，不每次 hover 重算');
ok(/if \(long <= MAX_EDGE\) \{ resolve\(src\); return; \}/.test(thumb), '缩略图链路对长边 ≤768 的 data URL 仍直接返回原图（poster 存在的理由）');

console.log('[4] 没有在挂载时预加载原图');
ok(!/new Image\(\)[\s\S]{0,200}?image\.src = (src|full)/.test(mediaImg), 'MediaImg 里没有为播放预热原图的 Image()');
ok(/const poster = useGifPoster\(gif && \(url === full \|\| thumbBroken\)/.test(mediaImg), 'poster 只在缩略图不可用时才解码原图，浏览器模式下挂载不碰原图');
ok(/useEffect\(\(\) => \{ setFresh\(true\); setFallback\(false\); setThumbBroken\(false\);/.test(mediaImg), '挂载副作用只重置显示状态，不拉原图');

console.log('[5] hover 挂在 .nbody 上，只重渲染这一个节点');
ok(/const \[hoverNode, setHoverNode\] = useState\(false\);/.test(nodeView), 'hover 状态在 NodeView 层（和视频懒挂载共用一份）');
ok(/onPointerEnter=\{node\.kind === "image" \|\| node\.kind === "video" \? \(\) => setHoverNode\(true\) : undefined\}/.test(nodeView), '.nbody pointerenter 开播（图片/视频共用同一个 hover）');
ok(/onPointerLeave=\{node\.kind === "image" \|\| node\.kind === "video" \? \(\) => setHoverNode\(false\) : undefined\}/.test(nodeView), '.nbody pointerleave 立刻回静态');
ok(/<Body \{\.\.\.p\} out=\{out\} running=\{running\} hover=\{hoverNode\} \/>/.test(nodeView), 'hover 传给 Body');
ok(/hover: boolean \}/.test(bodyFn) && /<MediaImg src=\{out\.url\} alpha=\{false\} px=\{node\.w\} play=\{p\.hover\} \/>/.test(bodyFn), 'Body 把 play 传给 MediaImg');
ok(!/store\.(patchGen|snapshot|updateNode)/.test(nodeView.slice(nodeView.indexOf('const [playGif'), nodeView.indexOf('const gif = isGifUrl'))), 'hover 状态不写 store / 不进历史（NodeView 早退分支里没有 store 写入）');

console.log('[6] 非 GIF / 灯箱 / 生成链路未被牵动');
ok(/const still = gif \?[^;]*: \(fallback \? src : url\);/.test(mediaImg), '非 GIF 仍是「缩略图，失败回退原图」的老行为');
ok(/if \(gif\) \{ if \(!play\) setThumbBroken\(true\); return; \} if \(!fallback && url !== src\) setFallback\(true\);/.test(mediaImg), 'GIF 的 onError 不走原图回退');
ok(!/previewThumbUrl|media_preview/.test(mediaImg), '没有改动缩略图/后端取图逻辑');
ok(fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/ImageViewer.tsx'), 'utf8').includes('useAssetUrl'), '灯箱仍用原图（能播动画），未改');

console.log('[7] 构建产物包含改动');
ok(/\^data:image\\\/gif/.test(bundle) && /\.gif\(\?:\$\|\[\?#\]\)/.test(bundle), 'canvas.js 里有 GIF 判定');
ok(/image\/webp",\.9/.test(bundle), 'canvas.js 里有首帧 poster 生成');
ok(bundle.includes('"data-act":"play"'), 'canvas.js 里有视频卡的播放按钮（构建产物是当前源码）');
ok(bundle.includes('setView'), 'canvas.js 是当前源码的构建产物');

console.log('画布 GIF hover 播放：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach(f => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
