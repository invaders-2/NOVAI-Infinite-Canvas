#!/usr/bin/env node
'use strict';
/*
 * 视频节点「按需挂载 <video>」回归。
 *
 * 背景：画布不虚拟化，所有节点常驻 DOM。以前只要 out.url 有值就无条件挂
 * <video preload="metadata"> + 常驻控制条：一条 N 个视频节点的画布 = N 个媒体元素
 * + N 次元数据请求 + N 次流式地址解析（桌面 bridge 每个节点一次 mediaUrl IPC），
 * 逼近 Chromium 单渲染进程的媒体元素上限（约 75），用户没在看的视频也都在解码。
 *
 * 现在的行为：默认只画封面 <img>；指针进正文才懒挂 <video>（静音循环预览）；
 * 点播放按钮 / 画面进入固定播放（移开不卸载）；「收起」暂停归零并回到封面。
 * 多个视频允许同时播（不做全局互斥）。
 *
 * 这里只做静态事实断言（源码 + 构建产物），运行时行为由
 * _verification-video-lazy/probe.py 实测。
 *
 * 跑法：node tests/test_canvas_video_lazy_mount.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeView = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx'), 'utf8');
const useMedia = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/useMedia.ts'), 'utf8');
const bundlePath = path.join(root, 'static/novai-canvas/canvas.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const videoBody = nodeView.slice(nodeView.indexOf('function VideoBody('), nodeView.indexOf('/** 播放控制条'));
const bodyFn = nodeView.slice(nodeView.indexOf('function Body('), nodeView.indexOf('function MediaImg('));
const nodeViewTop = nodeView.slice(0, nodeView.indexOf('function Body('));

console.log('[1] 默认态不渲染 <video>、不解析播放地址');
ok(/const \[pinned, setPinned\] = useState\(false\);/.test(videoBody), 'VideoBody 有 pinned 状态');
ok(/const \[closed, setClosed\] = useState\(false\);/.test(videoBody), '收起后需要 closed 标记（指针还在节点里也不许立刻挂回）');
ok(/const mounted = pinned \|\| \(hover && !closed\);/.test(videoBody), 'mounted = pinned || (hover && !closed)：closed 只压 hover 预览，不压固定播放');
ok(/\{mounted && url \? <video/.test(videoBody), '<video> 只在 mounted && url 时渲染');
ok(/const media = useMediaUrl\(out\.url \|\| "", mounted\);/.test(videoBody), 'useMediaUrl 的 enabled 跟着 mounted（默认态不解析流式地址）');
ok(!/<video[^>]*autoPlay/.test(videoBody), '没有 autoPlay：挂载时机由 mounted 决定');
ok(!/\{url \? <video/.test(videoBody), '不再是「有 url 就挂 <video>」的老写法');

console.log('[2] hover 才挂载（.nbody pointerenter，只重渲染这一个节点）');
ok(/const \[hoverNode, setHoverNode\] = useState\(false\);/.test(nodeViewTop), 'hover 状态在 NodeView 层（不进 store）');
ok(/onPointerEnter=\{node\.kind === "image" \|\| node\.kind === "video" \? \(\) => setHoverNode\(true\) : undefined\}/.test(nodeView), '.nbody pointerenter 同时覆盖图片（GIF）和视频');
ok(/onPointerLeave=\{node\.kind === "image" \|\| node\.kind === "video" \? \(\) => setHoverNode\(false\) : undefined\}/.test(nodeView), '.nbody pointerleave 收回 hover');
ok(/<Body \{\.\.\.p\} out=\{out\} running=\{running\} hover=\{hoverNode\} \/>/.test(nodeView), 'hover 传给 Body');
ok(/hover=\{p\.hover\} \/>;/.test(bodyFn), 'Body 传给 VideoBody');
ok(!/store\.(patchGen|set|updateNode)\([^)]*hover/.test(nodeView), 'hover 不写画布文档');

console.log('[3] pinned（固定播放）逻辑存在且控制条只在 pinned 时出现');
ok(/const onSurface = \(\) => \{ if \(!pinned\) \{ setPinned\(true\); return; \} toggle\(\); \};/.test(videoBody), '点画面：预览态进固定态，固定态才是播放/暂停');
ok(/data-act="play" onPointerDown=\{\(e\) => \{ e\.stopPropagation\(\); if \(out\.url\) setPinned\(true\); \}\}/.test(videoBody), '播放按钮进固定态（onPointerDown，来得及在被卸载前响应）');
ok(/\{pinned \? <VideoControls /.test(videoBody), '控制条只在 pinned 时渲染');
ok(/onClose=\{close\}/.test(videoBody) && /const close = \(\) => \{ const v = vref\.current; if \(v\) \{ v\.pause\(\); seekTo\(v, 0\); \} setPinned\(false\); setClosed\(true\);/.test(videoBody), '收起：暂停 + 归零 + 卸载回封面');
ok(/loop=\{!pinned\}/.test(videoBody), '预览态循环（loop），固定态按使用区间走');

console.log('[4] 不做全局互斥：多个视频可以同时播');
ok(!/activeId|activeVideo|onlyOne|currentVideo|setActiveId/i.test(nodeView), '没有模块级「当前唯一播放」协调变量');
ok(!/\.pause\(\)[\s\S]{0,80}other|others\.forEach/.test(videoBody), '没有去暂停别的节点');
ok(/onEnded=\{\(\) => \{ setPaused\(true\); setNow\(length\); \}\}/.test(videoBody), 'onEnded 只收自己的状态');

console.log('[5] 封面：优先 out.frame，没有就让后端抽帧');
ok(/const frame = useThumbnailUrl\(out\.frame \|\| "", node\.w\);/.test(videoBody), '封面帧仍走 useThumbnailUrl（缩略图链路不变）');
ok(/const preview = out\.frame \? "" : previewThumbUrl\(out\.url \|\| "", thumbStep\(node\.w\)\);/.test(videoBody), '没有 out.frame 时用 previewThumbUrl(out.url, 宽度档位)');
ok(/const cover = frame \|\| \(preview\.startsWith\("\/api\/media-preview\?"\) \? preview : ""\);/.test(videoBody), '只接受真的被改写成 /api/media-preview 的地址（其它引用塞进 <img> 只会裂图）');
ok(/poster=\{cover \|\| undefined\}/.test(videoBody), '<video> 的 poster 也用这个封面');
ok(/decoding="async"/.test(videoBody), '封面图异步解码（几十张同时在视口里时不抢主线程）');

console.log('[6] useMediaUrl 有「未启用」开关，且不影响老的调用方');
ok(/export function useMediaUrl\(src: string, enabled = true\)/.test(useMedia), 'useMediaUrl(src, enabled = true)：默认行为不变');
ok(/const canStream = enabled && !!be\.mediaUrl/.test(useMedia), '未启用时不去要流式地址');
ok(/const needData = enabled && \(!canStream \|\| failed\);/.test(useMedia), '未启用时也不读整段 data URL');
ok(/if \(!enabled\) return \{ url: "", stream: false, onError \};/.test(useMedia), '未启用时直接返回空地址');
ok(!/if \([^)]*\)\s*return[^;]*;\s*\n\s*const \w+ = use/.test(useMedia), 'hooks 没有条件调用（useAssetUrl 仍在顶层）');

console.log('[7] 时长角标 / 使用区间 / 截帧链路没被砍掉');
ok(/onLoadedMetadata=\{\(e\) => learnDur\(e\.currentTarget\)\}/.test(videoBody), 'learnDur 仍在 onLoadedMetadata 上（懒挂载后推迟到首次 hover/播放才学到真实时长）');
ok(/const learnDur = \(el: HTMLVideoElement\) => \{[\s\S]{0,400}?store\.patchGen\(node\.id/.test(videoBody), 'learnDur 仍回写 dur');
ok(/<span className="vdur tnum" data-vdur>\{formatClock\(out\.dur\)\}<\/span>/.test(videoBody), 'dur 角标还在');
ok(/onFrame=\{\(\) => \{ vref\.current\?\.pause\(\); window\.dispatchEvent\(new CustomEvent\("cn:editor", \{ detail: \{ kind: "frame", id: node\.id \} \}\)\); \}\}/.test(videoBody), '截帧仍发 cn:editor');
ok(/<TrimBar trim=\{trim\}/.test(videoBody), '使用区间面板还在');

console.log('[8] 构建产物包含改动');
const srcMtime = fs.statSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx')).mtimeMs;
const buildMtime = fs.statSync(bundlePath).mtimeMs;
ok(buildMtime > srcMtime, 'canvas.js 比源码新（构建产物已更新）');
ok(/preload:"metadata"/.test(bundle) && /playsInline:!0/.test(bundle), 'canvas.js 里还有 <video> 的构造（预览/固定播放路径在）');
ok(/media-preview/.test(bundle), 'canvas.js 里有 /api/media-preview 封面兜底');
ok(/loop:/.test(bundle), 'canvas.js 里有 loop 参数');
ok(bundle.includes('setView'), 'canvas.js 是当前源码的构建产物');

console.log('画布视频节点按需挂载：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach((f) => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
