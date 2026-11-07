# 传统回退画布（legacy-canvas）性能专项（legacy-perf / task-5）

> 写作用域（只改了这三个文件 + 本文档）：`static/js/canvas.js`、`static/css/canvas.css`、`static/legacy-canvas.html`。
> 没有碰 `smart-canvas.*`、`novai-canvas-ui/`、`static/novai-canvas/`、`main.py`、`server/**`、真实 `data/`；没有 git checkout/stash/reset/commit/add。
> 环境：`NOVAI_PORT=3161 NOVAI_DATA_DIR=/tmp/novai-perf-legacy venv/bin/python main.py`；A/B 代理 3162（before 快照）/ 3163（after 快照）/ 3164（仪器对照，也是 before 快照）。
> 浏览器：headless Chromium 156（`chrome-headless-shell-1223`，`--disable-gpu` = **软件光栅**）+ CDP `Emulation.setCPUThrottlingRate=6`；视口 1440×900@1x。
> 测试画布：`/api/canvases` 合成 **PERF-legacy-100**（100 节点 = 70 image / 20 prompt / 10 group，图片是 640² PNG，24 张轮换），另有一张 **PERF-legacy-real24**（真实 `data/canvases/88fa24fb…` 的 24 节点 classic 画布只读复制、图片 URL 重映射到同一批占位图，7 条连线，用来验连线/表格/生成节点的视觉）。
> 日期：2026-11-04。

## 0. 结论摘要

**口径**：同一分钟内 **ABBA 交替**（奇数轮 before→after、偶数轮 after→before，各 4 次取中位），**两侧都走同一个 A/B 代理程序**（3162 / 3163，只换快照目录与端口，gzip/no-store 规则一致），每轮先 `node reset.cjs` 把画布字节复位、载入后统一 `zoomBarFitAll()`，并校验两侧 `#world` transform 逐位一致（`matrix(0.247801,0,0,0.247801,72,52.7748)`）。
采样期间机器 `loadavg 7.9~17.8`（还有 perf-lab 在压测），所以绝对值只作同口径相对参考。

| 指标（100 节点 / 6x 降速 / 4 次交替中位） | 改动前 | 改动后 | 变化 | 备注 |
|---|---|---|---|---|
| **平移帧 p95** | **79.6 ms**（75.9~99.2） | **58.6 ms**（50.2~67.4） | **-26%** | 见 §4.1 |
| **平移长帧率（>50ms 帧占比）** | **74.9%** | **16.7%** | **-78%** | 同一批样本 |
| **缩放帧 p95**（普通滚轮 12 档往返，不撞 clamp） | **46.0 ms**（32.8~58.0） | **33.7 ms**（25.4~41.8） | **-27%** | 见 §4.2 |
| **拖拽节点帧 p95** | **66.9 ms**（66.0~75.9） | **46.7 ms**（42.4~57.7） | **-30%** | 同一套 |
| 首屏 → `#saveState === 'Ready'` | 1728 ms（1356~2089） | 1605 ms（1346~2113） | -7%（噪声内） | 未改首屏链路，见 §5.1 |
| 首次绘制 firstPaint | 724 ms（632~896） | 670 ms（548~960） | -7%（噪声内） | 同上 |
| 选中一个节点的同步耗时（isolation 单跑） | 3.7 ms | 1.0 ms | -73% | 8 条连线；真实 116 条会差更多 |
| 编辑一次（`addPromptNode` → 全量 `render()`） | 见 §4.3 | 见 §4.3 | **未测出稳定差异** | 噪声 137~247 ms，如实标注 |
| DOM 元素数 / 节点数 | 2516 / 100 | 2521 / 100（+5 = 新增性能开关按钮） | +0.2% | — |
| 小地图每帧 DOM 重建量 | 100 个 `.minimap-node` + `#minimapViewport` **每帧重建** | **0**（结构只建一次，只写变化的 left/top/w/h） | -100% | 实测 DOM |
| 每帧 `.node[data-id]` querySelector + offsetWidth | 100 + 100 次/帧 | **0**（节点矩形缓存） | -100% | 见 §2.1 |
| `backdrop-filter` 元素数（低性能模式关闭后） | 126 | 1 | -99% | 但主线程指标没测出收益，见 §5.3 |
| 节点图片请求 / 字节（合成画布 640² 素材） | 48 请求 / 160.6 KB（24 张 `/api/media-preview?w=768` + 24 张原图量尺寸） | 同左 | 0 | 节点早已走缩略图，见 §5.4 |
| JS 堆（强制 GC 后） | 7.3~7.5 MB | 7.5~7.9 MB | +0~5% | 噪声内 |
| `node tests/run-all.js` | — | **136/136 通过** | — | 见 §4.6 |

**一句话**：这次真正动到的是「平移/缩放/拖拽路径上的无条件连线重建」和「小地图每帧全量重建」两处结构性浪费，
主线程指标全部下降（平移长帧率 75%→17%）；首屏链路没动（defer 方案实测净负面，已回退，见 §5.1）；
低性能模式已实现但**在 headless 软件光栅下没测出收益**，不作为收益项。

## 1. 测量方法与可复现性

```bash
# 1) 真后端（独立数据目录，绝不碰 data/）
cd NOVAI-v16 && NOVAI_PORT=3161 NOVAI_DATA_DIR=/tmp/novai-perf-legacy venv/bin/python main.py
# 2) 合成 100 节点 legacy 画布（复用 _perf/lib/synth.py 的 legacy spec）
NOVAI_DATA_DIR=/tmp/novai-perf-legacy venv/bin/python _perf/lib/synth.py --base http://127.0.0.1:3161 --kind legacy --size 100
# 3) 三个同源 A/B 代理：3162=before 快照、3163=after 快照、3164=before 快照（仪器对照）
cd _to_delete/perf-backup/legacy/harness
node ab-server.cjs --port 3162 --upstream http://127.0.0.1:3161 --snapshot ../snapshot-before
node ab-server.cjs --port 3163 --upstream http://127.0.0.1:3161 --snapshot ../snapshot-after
node ab-server.cjs --port 3164 --upstream http://127.0.0.1:3161 --snapshot ../snapshot-before
# 4) ABBA 交替矩阵（每轮 reset 画布；奇数轮 before→after，偶数轮 after→before）+ 仪器对照
bash matrix2.sh 4 ab3-legacy
```

- **harness 全部在 `_to_delete/perf-backup/legacy/harness/`（不进版本库）**：`bench.cjs`（单轮埋点）、`profile.cjs`（CDP CPU profile，self time 聚合）、`shots.cjs`（视觉回归截图）、`verify-zoom.cjs`（缩放功能断言）、`ab-server.cjs`（每侧只换三个文件的同源代理，gzip level 4 / minimum 1KB 对齐 `main.py` 的 GZipMiddleware）、`reset.cjs`（把画布 JSON 字节复位）。
- **每轮全新 browser context**（sessionStorage/localStorage 天然为空）→ 载入后显式 `zoomBarFitAll()`，并用 `#world` transform 校验两侧初始视口逐位一致。
  （legacy 的 per-canvas 视口存 **sessionStorage `canvas_session_viewports_v1`**，不是 localStorage——这点和 perf-lab 对齐过。）
- **就绪信号**：`#saveState` 文本 === `'Ready'` 且 `#nodes .node` 数量 > 0（`openCanvas()` 成功收尾时 `setStatus('Ready')`）。
- **帧时间**：页面内独立 rAF 采样帧间隔 + `PerformanceObserver(longtask)`；headless 的 rAF 不是 16.7ms 固定节拍，所以一律用绝对毫秒（p95 / >50ms 长帧率），不用 fps。
- **归因方法**：改动前先用 CDP Profiler 取 pan/zoom/edit 的 self time top（§2），再**逐项单点改 + 重测**；另做过「把 `tailwindcss-cdn.js` 用 route 短路掉」的对照实验，用来确认 profile 里的 `pf` 到底属于谁。

### 1.1 仪器对照（这次最关键的方法论修正）

固定顺序 A/B 会让「后跑的那一侧」系统性更快。仪器对照：**同一份 before 代码**，3162 vs 3164 两个实例、ABBA 各 2 次：

| 对照轮 | 3162 pan p95 | 3164 pan p95 |
|---|---|---|
| 第 1 对（3162→3164） | 75.8 ms | 57.7 ms |
| 第 2 对（3164→3162） | 50.8 ms | 67.5 ms |
| 分端口均值 | 63.3 ms | 62.6 ms |

→ **「同一份代码、同一套代理」的端口间残差 ≈ 1%**，而本轮 before/after 的平移差是 26%：
所以 26% 不是仪器/顺序造成的。同时它暴露了「同一对里第二遍快 ~18ms」的顺序偏置——这正是必须 ABBA 的原因（固定顺序会把 -18ms 白送给后跑的一侧）。

## 2. 热点清单（改动前，file:line + 实测）

行号均指 **改动前快照**（`_to_delete/perf-backup/legacy/snapshot-before/`）；CPU 占比是 6x 降速、100 节点、一次 90 步中键平移的 CDP profile（self time / 总采样）。

### 2.1 平移：每个 mousemove 都无条件重建整层连线（最大头之二）
- `canvas.js:15465` 的 `board.addEventListener('mousemove')` 在每个移动事件里调用 `setKnifeMode(false)`；
- `canvas.js:15328 setKnifeMode()` 在「本来就不是刀模式」时也照样走到 `renderLinks()`；
- `canvas.js:15109 renderLinks()` = `linksEl.innerHTML=''` + 每条连线 **2 次 `getBoundingClientRect`**（`portPoint`）+ 重建 3 个 SVG 节点 + `linkControls` 按钮。
- 实测：平移 profile 里 `getBoundingClientRect` **7.6%**、`querySelectorAll` 4.1%、`querySelector` 3.4%，且每次重建都是 childList 变更 → 触发 §2.2 的 tailwind 观察器。

### 2.2 小地图每帧全量重建（最大头之一）
- `canvas.js:1762 renderMinimap()`：`minimapContent.innerHTML = ...` **每帧**重建 100 个 `.minimap-node` + `#minimapViewport`，再 `getElementById` 取回引用；
- `canvas.js:1731 minimapBounds()` → 对每个节点调 `canvas.js:1714 estimatedNodeRect()` = `.node[data-id="…"]` **querySelector + offsetWidth/offsetHeight**（100 节点 = 每帧 100 次强制布局）；
- `renderMinimap` 在 `applyViewport()`（`canvas.js:1604`）里被 `scheduleMinimapRender()` 排队 → **平移/缩放的每个事件都会走到**；小地图是常显的（`canvas.css:956 .minimap position:fixed`），不存在「隐藏时白干」。
- 实测：`renderMinimap` 2.7%、`estimatedNodeRect` 0.8%、`get offsetWidth` 2.6%，并间接放大 §2.3。

### 2.3 tailwind Play CDN 的 DOM 观察器被上面的 churn 反复触发（13~19%）
- profile 里的 `pf` 不是业务函数，是 `static/vendor/js/tailwindcss-cdn.js:64` 的编译回调（键里带 URL，可复核）；它在 `document.documentElement` 上挂了 `{attributes:true, attributeFilter:['class'], childList:true, subtree:true}` 的 MutationObserver。
- 小地图每帧 innerHTML（§2.2）和每次 `renderLinks`（§2.1）都是 childList 变更 → 每帧触发重扫/重编译。
- 实测：平移 **13.4%**、缩放 7.6%、编辑 `render()` **37.3%**。用一个「route 短路掉 tailwind」的对照实验验证过：短路后同一平移 6x p95 从 92.3→50.1ms、长帧率 60%→5.4%（但页面会缺 utility 样式，只用于归因，不作为方案）。

### 2.4 缩放/适应画布/居中：纯视口变化也重建连线
- `canvas.js:1641 / 1672 / 1706 / 1803 / 1816 / 1836 / 1865 / 1894 / 15552 / 15643` 共 10 处 `applyViewport(); renderLinks(); renderSelectionHub();`。
- 节点与连线都在 `#world` 内，连线坐标是**世界坐标**（`portPoint` → `screenToWorld`），纯视口变化不需要重建（平移路径就从来只调 `applyViewport()`，这是现成的反证）。
- 实测：缩放 profile 里 `getBoundingClientRect` 6.4%、`pf` 7.6%，`renderMinimap`+缓存链合计约 10%。

### 2.5 首屏：16 个同步脚本 + 407KB tailwind CDN
- `legacy-canvas.html:19-35` 是 13 个 head 同步脚本（含 407KB `tailwindcss-cdn.js`）+ `theme.js`。
- **实测结论和最初的猜测相反**：改 defer 后 firstPaint 560→116ms，但 ready 1158→1922ms（+66%），原因是 tailwind 执行时机从「DOM 为空」挪到「完整 DOM」，一次重编译 **+651ms 长任务**。详见 §5.1（未采纳）。

### 2.6 其它被量到但未动的
- `render()`（`canvas.js:5985`）全量重建所有节点 DOM：编辑一次 `addPromptNode` 在 6x 下 97~247ms。它同时被 §2.3 放大（每次 render 触发 tailwind 重扫 37.3%）。做增量渲染风险高（选中态/事件绑定/表格编辑/拖拽引用都挂在重建出来的 DOM 上），本轮**未动**，见 §5.2。
- 节点图片第一次载入时 `measureCanvasOriginalImageNodes`（`canvas.js:5953`）会对每张图 `new Image()` 载原图量尺寸 → 合成画布上 24 张预览 + 24 张原图 = 48 请求；量到的尺寸写回节点并保存，所以**每个节点只发生一次**（第二次载入只剩 24 条预览请求，实测确认）。真实 2K/4K 素材第一次打开会多解码一轮，未改（见 §5.5）。

## 3. 已落地的改动（逐条：为什么变快 / 为什么安全）

### P0-1 非刀模式不再重建连线 —— `canvas.js:15430 setKnifeMode()`
```js
function setKnifeMode(active){
    if(!active && !knifeActive && !document.body.classList.contains('canvas-knife')) return;
    ...
```
- 为什么快：board 的每个 mousemove 都会调它（`canvas.js:15465`），原来无条件 `renderLinks()`：2×连线数 次 `getBoundingClientRect` + 3×连线数 个 SVG 节点重建 + 一次 childList 变更（再放大 §2.3）。非刀模式下它本来就是纯空操作。
- 为什么安全：只在「当前不是刀模式、且要切到非刀模式」时直接返回；切进刀模式、或刀模式收尾（`knifeActive`/body class 还在）时逻辑完全不变。`setKnifeMode(true/false)` 的其余调用点（`keydown/keyup/blur/endDrag`）都保留原行为。

### P0-2 小地图增量更新 —— `canvas.js:1744/1765/1781/1815/1823/1846/1885`
- 新增 `minimapNodeRects()`：一次遍历 `#nodes` 子元素建立 id→矩形缓存（1 次布局），取代每帧每节点一次 querySelector+offsetWidth；
- 新增 `invalidateMinimapRects()`：只在 `render()` / `refreshNodes()`（增删/重排/整节点重建）后失效；
- 新增 `syncMinimapRectsFromModel([withSize])`：拖拽/缩放节点时按模型增量刷新坐标（不读 DOM）；
- 新增 `rebuildMinimapStructure()`：`.minimap-node` 与 `#minimapViewport` **只在节点数量/id 序列变化时建一次**，之后每帧只写变化的 `left/top/width/height`（`setMinimapStylePx` 先比字符串再写）；
- `renderMinimap()` 改成「先读（视口矩形 + clientWidth）→ 再写」，并把同一个 `viewRect` 传给 `updateMinimapViewport()`，避免原来写 innerHTML 之后 `currentWorldViewRect()` 触发强制重排。
- 为什么快：每帧 100 次 querySelector + 100 次 offsetWidth + 100 个元素销毁重建 + 1 次 childList 变更（→ tailwind 重编译）全部消失；平移/缩放的 DOM 变更降到 0。
- 为什么安全：几何公式、`minimapState`、`minimapEventToWorld()` 的坐标换算、`EMPTY` 占位、选中态类名、`#minimapViewport` 的 id/class 都保持原样；结构重建时也保留同样顺序（节点格子 → empty → viewport）。误差只来自 px 保留 3 位小数（≤0.0005px）。

### P0-3 纯视口变化不再重建连线 —— 10 处（见 §2.4 的行号）
- 只去掉 `renderLinks()`，保留 `renderSelectionHub()` 与 `scheduleViewportSave()`；节点/连线本身变化时仍由 `refreshGeometry()`/`renderLinks()` 重建（`render` 路径未改）。
- 为什么安全：连线是世界坐标、放在 `#world` 内，随 transform 一起缩放/平移（平移路径本来就不重建）；`renderSelectionHub()` 只是清空一个空容器（`canvas.js:15474`），与缩放无关。
- 视觉验证：见 §4.5（真实 24 节点 + 7 条连线的画布，缩放前后截图 before/after 像素差 ≤0.311%，且全部落在新增按钮区域）。

### P1-1 低性能模式「流畅优先」（新增）—— `canvas.js:15941-15990` + `canvas.css:1665-1681`
- `localStorage.novai_legacy_perf_mode`：`'full'`（强制画质）/ `'smooth'`（强制流畅）/ 缺省=auto；
- auto 判定：`prefers-reduced-motion: reduce` → 降级；`hardwareConcurrency ≤ 4` 或 `deviceMemory ≤ 4` → 降级；
- 入口：运行时注入到快捷工具栏最左的按钮（`zap` 线性图标 + 文案「画质优先 / 流畅优先」），点击切换并持久化，`aria-pressed` 同步；
- smooth 档只关「磨砂采样」与装饰动画（`body.legacy-perf-smooth * { backdrop-filter:none }`、`link-flow`/状态点动画停），**不动布局、字号、配色、选中态表达**（选中态仍是 box-shadow 软底 + 字色，没有新增 border/描边）；
- 另有独立的 `@media (prefers-reduced-motion: reduce)` 停装饰动画（手动 pin full 时也尊重系统设置）。
- **默认档与改动前一致**（auto 在本机（核多、无 reduce-motion）解析为不降级），所以 perf-lab 两侧 pin `'full'` 的主矩阵可比；
  不降级时 `legacy-perf-smooth` 类不会被加上，新增 CSS 只有 `.toolbar-perf.is-on` 一条且只命中这个新按钮 → 与改动前逐位一致。
- 按钮行为：点击在「画质优先 / 流畅优先」之间切换并写 `localStorage.novai_legacy_perf_mode`（刷新后保持）；`aria-pressed` 同步；
  插在 `.toolbar-fixed` 最左（工作流/资产库/日志之前），不遮挡、不重排原有按钮——截图实测原三个按钮的 x 位置不变，工具栏向左扩（§4.5 的差异区域就是它）。
- **旧画布新增可见开关是有意为之**（产品要求低配机有兜底），**不是观感回归**：默认档下本改动只多这一个按钮，画布本体 0 像素差异。
- 实测收益：**没测出来**（§5.3），保留它是因为「低配机兜底」是产品要求，且默认不改变行为。

## 4. 验证

### 4.1 平移（6x，4 次 ABBA 中位）
before 79.6ms p95 / 长帧率 74.9% / 均值 56.3ms；after 58.6ms p95 / 长帧率 16.7% / 均值 40.0ms。
单次完整 profile 复核：`getBoundingClientRect` 7.6%→4.0%、`querySelector`/`querySelectorAll` 7.5%→1.3%、`pf` 18.8%→4.3%。

### 4.2 缩放（普通滚轮 12 档往返，起始 0.2478，不撞 0.06/8 clamp）
before 46.0ms p95（且每次滚动都重建连线）；after 33.7ms p95。
**功能没丢的证据**（`results/verify-zoom-{before,after}.json`）：
- `#world` scale 0.247801 → 0.393229，两侧**逐位相同**；
- 3 个节点屏幕宽度的放大比 1.587 / 1.587 / 1.586，与 scale 比 1.587 一致（误差 <0.1%）；
- 小地图 `#minimapViewport` 与选中的同步：`minimapSelectedSynced=true`、`minimapNodesStable=true`（节点数不随缩放变化）；
- 选中态：`.node.selected` 数量缩放前后一致（`selectionHeld=true`）；
- 0 个 pageerror / console error。
- ⚠️ **诚实标注**：合成 100 节点 fixture 的 8 条 synth 连线是 `image→prompt`，而 prompt 节点没有入端口 → `renderLinks` 实际渲染 0 条连线，所以 `linksIntact` 这条断言在这张画布上是**空的**（before/after 都为 0）。连线视觉改用 §4.5 的真实 24 节点/7 连线画布截图证明。

### 4.3 编辑路径（如实：未测出稳定差异）
`addPromptNode()`（`addNode → render()` 全量重建）6x 下：before 回归 137.4~224.1ms（中位 154.5），after 147.9~247.2ms（中位 194.1）；但换一组较空时的样本是 before 117.9~175.2（中位 121.4）、after 84.4~133.0（中位 116.2）。
**结论：噪声与本轮改动同量级，不能声称编辑变快或变慢**。代码事实是 `render()` 本身没改，而它 37.3% 的耗时来自 tailwind 在完整 DOM 上重扫（§2.3），这条留给后续（§5.2）。

### 4.4 仪器对照 + loadavg
见 §1.1（同代码端口残差 ≈1%）。每轮 loadavg 已写进 `results/ab3-legacy-*.json` 的 `loadavg` 字段与 `harness/matrix-ab3.log`（7.9~17.8，采集期间 perf-lab 也在跑矩阵）。

### 4.5 视觉回归（`_perf/lib/pixdiff.py`，tol=8）
两组画布、浅/深 × fit/100%/选中，before vs after：

| 画布 | 最大像素差 | 差异位置 | 解释 |
|---|---|---|---|
| 合成 100 节点（6 张） | **0.315%**（light 三态）/ 0.097%·0.041%（dark） | 全部在 `x 960-1152, y 0-96` | 新增的「画质优先/流畅优先」按钮 + 快捷工具栏因此左扩 |
| 真实 24 节点 / 7 连线（6 张） | **0.311%**（light 三态）/ 0.039%（dark） | 同上 | 同上 |

→ 画布本体（节点、图片、连线、小地图、缩略图、选中态、缩放条）**0 像素差异**；全部差异来自新增开关按钮这一处可见 UI 变更——
**这是有意为之的产品入口（低配机兜底），不是观感回归**；默认档（不降级）下 `legacy-perf-smooth` 类不存在，除该按钮外样式与改动前完全一致。截图在 `_to_delete/perf-backup/legacy/shots/` 与 `shots-real/`（不进版本库）。

### 4.6 测试与体积
- `cd NOVAI-v16 && node tests/run-all.js` → **136/136 通过，`[run-all] 全部通过`**（外部会话新增了 1 个测试文件，现在是 136 项）。
- `legacy-canvas.html` 的 `?v=` 已同步：`canvas.css?v=1.0.143.1793780309`、`canvas.js?v=1.0.143.1793780289`，且 html 本身处于修改状态 → `tests/test_table_node_wiring.js` 的 [8] 通过。
- 体积：`canvas.js` 801,428 → **809,739 B**（+1.0%）；`canvas.css` 168,021 → **169,269 B**（+0.7%）；gzip 后（level 4）分别约 +0.9% / +0.6%（本次改动以逻辑为主，压缩率更好）。

### 4.7 改动量
```
static/css/canvas.css     |  24 ++++-
static/js/canvas.js       | 233 +++++++++++++++++++++++++++++++++++++++++-----
static/legacy-canvas.html |  10 +-
3 files changed, 228 insertions(+), 39 deletions(-)
```

## 5. 未采纳项与理由

### 5.1 把 head 里 13 个同步脚本改 defer（实测净负面，已回退）
- 全 defer（tailwind 也 defer）：firstPaint 560→**116ms**（-79%），但 ready 1158→**1922ms**（+66%），长任务里多出 **+651ms** 单次任务。
- 根因：tailwind Play CDN 在**脚本执行时**扫描并生成 CSS。同步放 head 时执行时 body 还没解析、DOM 基本为空 → 编译极便宜；defer 后执行时整个静态 body（500 行 + 全部弹层 class）已在 DOM 里 → 一次性重编译。
- 交叉验证：**tailwind 保持同步、其余 12 个 defer** → firstPaint 548/564ms、ready 1281/1381ms，等于没改（tailwind 同步仍然阻塞首绘，省下的 350KB 小脚本对 ready 无感）。
- 结论：defer 本身没有净收益，**已整体回退**（现在 `legacy-canvas.html` 相对改动前快照只差三处 `?v=`）。用户感知优先保「画布出现时间」而不是「空壳首绘」。

### 5.2 立项建议：把 tailwind Play CDN 换成静态 utility 表（收益最大，但不在本轮作用域）
- block-tailwind 对照实验：6x 下 ready 2758→**653ms**、firstPaint 未计时但明显更早、平移 p95 92.3→50.1ms、长帧率 60%→5.4%。
- 但 tailwind 是**运行时扫描 DOM** 生成 CSS，静态化必须覆盖所有动态生成的 class（100+ 种节点模板、弹层、表格、批量面板），漏一个 utility 就破版；且 `canvas.css` 之外的弹层还依赖 preflight。
- 建议单独立项：用 Tailwind CLI 从 `static/**` + 全部模板字符串里生成一份 utility 表并入 `canvas.css`（或独立的 `canvas-utilities.css`），再在真机 1x/4x 上验视觉。**本轮不动**。

### 5.3 低性能模式在 headless 软件光栅下没测出收益
- smooth 档实测：`backdrop-filter` 元素 126→1，但 pan p95 42.6→49.9、zoom 9.3→9.3、drag 34.1→32.5、edit 97.8→132（单跑对比，全部在噪声内）。
- 推断：`--disable-gpu` 的软件光栅下 backdrop-filter 的采样成本没有被主线程指标捕捉（更可能落在合成/光栅线程），且 fit 视口下 100 个节点只占很小面积。
- **未知**：真机集显/低端核显上的 GPU 成本。保留功能（默认 auto=不降级），但报告不把它算成收益。

### 5.4 图片：节点**已经**走 `/api/media-preview?w=768`，不是缺口
- `canvas.js:70 canvasPreviewImgHtml()` → `canvas.js:62 _localMediaPreviewUrl()` 对 `/output/`、`/assets/` 前缀生成缩略图 URL；实测合成画布 24 张图 → 24 条 `/api/media-preview`。
- 真实画布里出现 0 条 media-preview 的场景是：节点 URL 不是 `/output/`、`/assets/` 前缀（外部 https 走 `/api/download-output` 代理原图）。这属于「素材 URL 形态」问题，不是 legacy 没接缩略图；本轮不改（要改得动 media.js/mian.py，超出写作用域）。

### 5.5 首次载入的原图量尺寸（`measureCanvasOriginalImageNodes`）未改
- 它给每个 image 节点 `new Image()` 载**原图**量 `natural_w/h`，量完写回节点并保存 → 每节点只发生一次（第二次载入实测只剩 24 条预览请求）。
- 真实 2K/4K 素材第一次打开会多一轮原图下载 + 解码；改它要动「编辑器的裁剪/比例依赖 `natural_w/h`」这条数据契约，风险 > 收益，本轮不改。

### 5.6 `render()` 增量渲染未做
- 现在任何一次节点增删/分组/撤销都全量重建（`canvas.js:5985`），6x 下 97~247ms，且触发 tailwind 重扫。
- 未做的原因：选中态、事件委托、表格单元格编辑、拖拽中的节点引用、`#minimapViewport` 等都在重建出来的 DOM 上；`refreshNodes(ids)` 已经有单节点重建路径，但把它套到所有编辑入口需要逐条回归（表格/批量/生成/图像调色），风险高。建议作为下一轮的 P0（配合 §5.2 一起做收益最大）。

## 6. 风险与回退

| 改动 | 风险 | 回退方式 |
|---|---|---|
| P0-1 setKnifeMode 提前返回 | 若将来有代码依赖「每次 mousemove 都 renderLinks」的副作用（目前没有） | 删掉新增的一行 guard |
| P0-2 小地图增量 | 节点 DOM 增删但不经过 `render()/refreshNodes()` 的路径会拿到旧矩形（当前所有增删都走这两个入口；另在拖拽/缩放手势里按模型增量刷新） | 恢复 `renderMinimap` 的 innerHTML 版本（本文档 §2.2 有原实现要点），或只把 `minimapNodeRects()` 改回逐节点 `estimatedNodeRect()` |
| P0-3 去掉视口 renderLinks | 若将来连线需要随缩放改变线宽/虚线密度（目前是 world 坐标随 transform，无需） | 把 10 处的 `renderLinks()` 加回（diff 里是删行，容易恢复） |
| P1-1 性能开关 | 多一个按钮（视觉差 0.3%）+ 一段自动探测逻辑 | 删 `canvas.js:15941-15990` 与 `canvas.css:1665-1681`；或只删 CSS 类效果 |

快照与回退：`_to_delete/perf-backup/legacy/snapshot-before/`（改动前三个文件，sha256 与 perf-lab 的 before 快照一致）、`snapshot-after/`（定稿版）；任何一侧都可直接 `cp` 回去。

## 7. 结论分级

**实测（有前后对比 + 可复核数据）**
- 平移 p95 -26%、长帧率 -78%；缩放 p95 -27%；拖拽 p95 -30%（6x、100 节点、ABBA 4 次中位、两侧同代理）。
- 小地图每帧 DOM 重建 100 元素 → 0；每帧 100 次 querySelector/offsetWidth → 0。
- 同一份代码的端口对照残差 ≈1%（说明上面的差值不是仪器）。
- 视觉回归：画布本体 0 像素差异；唯一差异是新增开关按钮（≤0.315%）。
- `node tests/run-all.js` 136/136。

**推断（有依据但未直接测量）**
- 真实 2K/4K 素材、100+ 连线的画布上，P0-1/P0-3 的收益会**更大**（每次 mousemove/wheel 省的 rect 数与 SVG 节点数与连线数成正比）；本轮 fixture 只有 0/7~8 条连线。
- 低性能模式在真机集显上应有收益（少 125 层 backdrop 采样），但在软件光栅下测不出。

**未知（没测到，不写收益）**
- 1x CPU（本机 loadavg 8~18，1x 数字不可信；perf-lab 有 1x/4x 权威数据）。
- 编辑路径 `render()` 是否变快（噪声内）。
- 真机 GPU/合成成本、真机内存峰值、长会话（≥5 分钟）稳定性。
- 流式生成（legacy 没有对外增量钩子，按 perf-lab 口径**未测**）。
- Safari/WKWebView（桌面端）表现。
