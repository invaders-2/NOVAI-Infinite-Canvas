# BEAT 画布（novai-canvas-ui / canvas-next）性能专项（beat-perf / task-1）

> 范围：`NOVAI-v16/novai-canvas-ui/src/**`（源码）+ `NOVAI-v16/static/novai-canvas/**`（我只跑 `npm run build` 生成）。
> 未碰 `static/js/**`、`static/smart-canvas.*`、`main.py`、`server/**`、真实 `data/`。
> 日期：2026-11-04 · 服务端口 3177 · 数据目录 `/tmp/novai-perf-beat`（100 节点专用画布，与真实用户数据完全隔离）。

## 0. 结论摘要

实测口径：真实 Chromium 156（headless + `--disable-gpu`，即 **软件光栅**，比集显更吃 CPU，只用相对值）+ CDP `Emulation.setCPUThrottlingRate=6`；
同一张 100 节点画布（67 个图片节点指向 2048×2048 的 /output 图，98 条连线），同一套 harness 跑「改动前构建产物」与「改动后构建产物」。
改动前产物用开工时拍的源码快照单独构建到 `/static/openarc-baseline/`（A/B 两套产物同源、同数据、同机）。

| 指标（6x 降速，100 节点） | 改动前 | 改动后（画质优先） | 改动后（流畅优先） |
|---|---|---|---|
| 平移 帧均值 / p95 | 30.5 / 35.4 ms | 30.6 / 39.0 ms | **28.0 / 32.3 ms** |
| **缩放** 帧均值 / p95 | **59.9 / 74.9 ms** | **50.6 / 72.9 ms（-16%）** | **49.1 / 68.4 ms（-18%）** |
| 缩小到 0.3 后平移（小地图浮出） | 25.6 / 29.7 ms | 28.0 / 31.6 ms | 25.7 / 32.5 ms |
| 流式生成（每帧推 token） | 19.6 / 32.7 ms | 18.6 / 29.6 ms | **18.3 / 28.4 ms** |
| 缩放期间样式重算（99 帧累计） | 2.94 s | **2.12 s（-28%）** | **2.09 s（-29%）** |
| 流式生成期间脚本时间（159 帧） | 0.70 s | **0.35 s（-50%）** | **0.34 s（-51%）** |
| **节点图片解码位图总量** | **1072 MB** | **268 MB（-75%）** | 268 MB |
| 带 backdrop-filter 的元素数 | 135 | 136 | **2** |
| 首屏 store 就绪（domContentLoaded / 首节点） | 77 / 172 ms | 71 / 147 ms | 66 / 156 ms |
| JS 堆（强制 GC 后） | 5.4 MB | 5.6 MB | 5.6 MB |
| canvas.js 体积 | 1137.5 KB（gzip 378.4） | 1145.5 KB（gzip 381.7） | 同左 |
| canvas.css 体积 | 228.4 KB（gzip 40.1） | 231.9 KB（gzip 40.6） | 同左 |

**一句话**：这次改的是「解码内存、流式期间的脚本与重渲、缩放期间的样式重算、低配机的磨砂特效」，四类都有实测量化的下降；
**平移/缩放的绝对帧时间在本 harness 里改善有限**（平移基本持平、缩放 -16%），因为本机是软件光栅、瓶颈落在「67 张图的每帧光栅合成」上，这部分属于 GPU/光栅成本，
headless 测不准（见 §5.3 的否决记录：我用同一 harness 也测过 `content-visibility` 这类纯光栅优化的收益）。真机集显的正式数字由 perf-lab 出。

## 1. 测量方法与可复现性

- **画布**：`POST /api/canvases` 建 PERF-100，`PUT` 写入 100 节点（`type: image/prompt`，1024/2048 图走 `/output/perf_0xx.png`）+ 98 条 `connections`。图用 Pillow 现场生成，与真实素材格式/尺寸同档（2K PNG）。
- **harness**：`/tmp/beat-perf/{cdp.mjs,bench.mjs,bench.js,boot.js}`。CDP 驱动 headless Chrome，页面内 `window.__bench` 提供：
  - `pan(n)` / `zoom(n)` / `stream(n)`：在 rAF 回调里调真实 `store.setView` / `store.patchRun`，量帧间隔；每段用 `Performance.getMetrics` 前后差值给出 TaskDuration / ScriptDuration / RecalcStyleDuration / RecalcStyleCount / LayoutDuration。
  - `asserts()`：见 §4 的 12 条一致性断言。
  - `decoded()`：汇总 `#nodes img` 的 `naturalWidth×naturalHeight×4`（解码位图近似值）。
  - `repaintProbe()` / `cvProbe()`：同页 A/B 微基准（见 §5.3）。
- **首屏**：`Page.addScriptToEvaluateOnNewDocument` 注入 MutationObserver 记 `store 就绪` / `首个 .node 出现`；navigation timing 取 dcl/firstPaint；resource timing 取 canvas.js/css 的 encoded/decoded/duration。
- **公平性**：每轮都先 `localStorage` 固定 `openarc-canvas-perf` 与主题、`Page.reload(ignoreCache)`，等首屏稳定 1.5s 再测；每轮结束关掉 target（不关会残留 100 节点页面，把后面的轮次拖慢——这个坑我踩过一次，早期数据作废重测）。
- **只用于相对比较**：headless + 软件光栅的绝对值不代表真机；所有结论都写「改前 vs 改后」同口径。

## 2. 热点清单（改动前，file:line + 实测）

### 2.1 节点图片按原图解码：解码位图 1072MB（最大的一个）
- `ui/useThumbnail.ts:32`（改动前）只对 `data:image/` 的地址做 canvas 缩图；`/assets/`、`/output/` 的地址原样返回 → `ui/NodeView.tsx:167` 直接 `<img src={原图}>`。
- 网页版 `novaiBackend.ts:791` `resolveAsset(ref) => ref`，所以节点 url 就是后端原图路径；后端其实早就有缩图接口 `main.py:9098 GET /api/media-preview`（按「路径+宽度」落盘缓存、`immutable` 长缓存、异步生成），表格缩略图 `ui/TableNode.tsx:133` 已经在用，节点卡却没用。
- 实测：67 个 2048×2048 节点 = **1072MB 解码位图**（每个 16MB）。8G 机器上这就是「越用越卡、切换画布后卡一阵」的直接原因。

### 2.2 平移/缩放重渲整棵节点树（缩放 59.9ms）
- `ui/Viewport.tsx:75`（改动前）同时订阅 `doc/view/ui/runtime/batches`；`:404`（改动前）把 `world` 的 `transform` 和 `--zinv` 写在 JSX 里 → 每个 pointermove 都重渲 Viewport 全部 JSX（100 个 NodeView 的 memo 比较 + `hiddenIds` + `sort` + 每节点 `modelOf→genOf` 分配）。
- `--zinv` 是祖先级自定义属性，写一次要重算整棵子树样式：只被 3 条规则用（`canvas-next.css:1333 / 1581 / 1600`，都套了 `max(1, min(var(--zinv),3))`）。实测缩放 99 帧 **RecalcStyleDuration 2.94s**（≈30ms/帧 @6x），占单帧 CPU 一半以上。

### 2.3 小地图每帧 200 次 getComputedStyle
- `ui/Chrome.tsx:1087`（改动前）`const css = (k) => getComputedStyle(document.querySelector(".cn-root"))...`，而 `:1092` 在 `forEach` 里对**每个节点**各调 2 次（`--solid`、`--ink`）→ 100 节点 = 200 次强制样式解析/帧；`:1094` 的 `useEffect` 没有依赖数组，父组件任何重渲都会重画整张 canvas。
- 触发条件：缩放 < 0.35 时小地图自动浮出（`ui/minimap.ts:11`），也就是「缩小看全图」时最卡。

### 2.4 流式生成时连线层每 token 全量重渲
- `ui/Edges.tsx:13`（改动前）订阅整个 `runtime`；`store.patchRun`（`store.ts:313`）每个 token 都换掉 `runtime` 对象 → 连线层每 token 重渲一次，且 `:48` 每条边都调 `inputsOf`（内部 `doc.edges.filter`，O(E)）→ 98 条边 ≈ 1 万次比较/帧。
- 实测：流式 159 帧脚本时间 0.70s（≈4.4ms/帧 @6x）。

### 2.5 连线拖动时 connectBlock 是 O(V×E)
- `model.ts:511 connectBlock` → `:505 wouldCycle` 在 while 里对每个弹出的节点 `doc.edges.filter` 一遍；`ui/Viewport.tsx:413` 在 conn 拖动时对**每个节点**都算一次 `connectBlock` → 100 节点 × 98 边 = 上万次比较/pointermove。

### 2.6 集显上的磨砂与常驻动画
- `ui/canvas-next.css` 里 39 处 `backdrop-filter`、54 组 `@keyframes`、86 处 `animation`。运行时实测 **135 个元素**带 backdrop-filter，其中大头是**每个节点卡片上的小浮层**（`.vstrip` 版本条、`.favstar` 收藏、`.node-replace`、`.play`、`.gtool` 分组按钮、`.qbadge` 排队徽标）—— 它们都压在图片上做 8–18px 采样模糊，100 节点 = 上百个模糊层。
- 常驻动画里纯装饰的 7 个（流式连线的流动虚线、骨架扫光、加载扫光、缩略图占位流光、模板卡流光等）。

### 2.7 每次自动保存同步写整份文档到 localStorage
- `novaiBackend.ts:639`（改动前）`saveDoc` 第一行 `writeDoc(canvasId, doc)` → `reactCanvasStore.ts:383` `localStorage.setItem(key, JSON.stringify(doc))`。防抖 800ms（`store.ts:186 scheduleSave`），文档越大越慢。
- 实测（本测试画布 96,760B）：单次 `JSON.stringify` 0.2–1.3ms + `setItem` 0.9–1.2ms；**1.19MB 真实画布约 3–12ms**（backend-perf 侧同口径数据）。低配机上这段正好落在拖拽/输入同一帧。
- 附带：`useAsset.ts:12` 的图片 URL LRU 上限是 **300M 字符**（UTF-16 最坏 ≈600MB 堆）。

## 3. 已落地的改动（逐条：为什么变快 / 为什么安全）

### 3.1 节点图片走 /api/media-preview（`ui/useThumbnail.ts`、`ui/NodeView.tsx`）
- `useThumbnailUrl(src, cssWidth)` 新增宽度参数：`/assets/`、`/output/` 经 `table.ts:100 previewThumbUrl` 改写成 `/api/media-preview?w=…`；
  `thumbStep()` 取 **2.5×节点显示宽**并归一到 256/384/512/768/1024/1536 六档（档位少 → 服务端按「路径+宽度」缓存命中率高）。
- 为什么变快：2048² 图从 16MB 解码降到 4MB（-75% 总量），首帧少 804MB 位图；光栅合成也少读 4 倍像素。
- 为什么安全：① 只改节点卡里的 `<img>`；灯箱（`Chrome.tsx:1289 useAssetUrl(imgSrc)`）、图像编辑器、导出、时间轴截帧仍用**原图**（断言 `lightboxUsesOriginal` 见 §4）；② 非 `/assets|/output` 地址（`data:`、外链、`openarc-asset:`）走原来的逻辑；③ 加载失败 `onError` 回退原图（不会变空白）；④ 宽高比不变（服务端等比缩），不会出现裁切差异。
- 画质取舍：dpr1 + 最大缩放 k=2 时 320px 节点需要 640 设备像素，档位给 1024 → 不放大、不糊；dpr2 屏幕在 k>1.25 时会略软（想要绝对锐利可切「画质优先」，或双击进灯箱看原图）。

### 3.2 视图变换命令式化（`ui/Viewport.tsx`）
- Viewport **不再订阅 view**：`useLayoutEffect` 里 `store.subscribe` + rAF 合并，直接写 `#world` 的 `transform`、`#vp` 的网格 `backgroundSize/Position`；`--zinv` **只在 k 变化时写**，且 k≥1 时写常量 `"1"`（CSS 本来就 `max(1, …)` 钉在 1）、k<1 时按 1/24 量化（24px 小按钮每档差 <1px）。
- `--zinv` 的真实消费者只有 3 条带 `max(1,min(…))` 的规则 → 量化后**渲染结果不变**；参考线粗细（`:433`）和协作者光标（`:453`）不能吃这个量化值，所以：参考线在渲染时直接读精确的 `1/k`（参考线只在拖动节点时存在，pointermove 本来就会重渲），协作者光标单独订阅 `view.k`（数量是个位数，代价可忽略）。
- 为什么变快：平移时 0 次 React 渲染、0 次 `--zinv` 写入；缩放时样式重算 2.94s → 2.12s（-28%）。
- 为什么安全：store 里的 `view` 照旧同步更新，`ctl.toWorld` / `ctl.toScreen` / 小地图 / 连线端点 / 拖动吸附全部读它（断言 `storeViewMoved` / `transformMatchesStore`）。`ui.conn.p` 仍用 `ctl.toWorld`，未受影响。

### 3.3 小地图：取色提到循环外 + 订阅收窄（`ui/Chrome.tsx:1082`）
- `getComputedStyle` 每次绘制只取一次（原来 200 次/帧）；`runtime` 订阅换成「正在生成的节点 id 串」（流式 token 不再触发重绘）；`useEffect` 加依赖数组（父组件重渲不再连带重画）。
- 为什么安全：绘制内容与原来逐项等价（断言 `minimapRedrawsOnPan` 为 true，说明平移时小地图仍在重画）。

### 3.4 连线层订阅收窄（`ui/Edges.tsx`）
- `runtime` 订阅 → `Object.keys(runtime).join(",")` 签名，只在生成开始/结束变化；`flow` 判定用该集合。
- 流畅优先下不再渲染 SMIL 扫光（`<animate>`），改用已有的 `.e.gen` 静态高亮（线宽 2.5px、颜色同一套 var）——「这条线在给生成中的节点供料」仍然看得出来。
- 实测：流式脚本时间 0.70s → 0.35s（-50%）。

### 3.5 连线校验 O(V×E) → O(V+E)（`model.ts:505-527`）
- 加 `WeakMap<CanvasDoc, {out, pairs}>` 出边邻接表 + 已连端点集合；缓存键就是 doc 对象（所有改动都换新 doc 引用 → 自动失效，不存在脏读）。
- 行为完全不变：`wouldCycle` 仍是同一个 DFS，只是把 `doc.edges.filter` 换成邻接表；`connectBlock` 的判定顺序与文案一字未改。

### 3.6 低性能模式（新 `canvas-next/perf.ts` + `CanvasApp.tsx` + `canvas-next.css` 末尾 + `Chrome.tsx` 设置项）
- **判定**：硬件只做初判（`hardwareConcurrency ≤ 4`；**不用** `deviceMemory`，Chrome 封顶就是 8，用它等于所有机器都进候选）→
  等用户**第一次真实操作**（pointerdown/pointermove/wheel/keydown，最多等 3s）后采 1.2s 的 rAF 帧间隔，**p95 > 45ms** 才降级；尊重 `prefers-reduced-motion`。
- **入口 / 默认值 / 切回**：画布设置 → 拖动与显示 → 「性能模式」，三档 `流畅优先 / 画质优先 / 自动`，默认 **自动**；选择写 `localStorage["openarc-canvas-perf"]`，随时一键切回「画质优先」。
- **改了什么**（`.cn-root[data-perf="low"]`，只覆盖成本、不动配方）：`--glass-blur` 44px→10px（底色仍是 `color-mix(70/78%)`、双层柔和投影、`border:0`，设计规则保持）；
  节点小浮层去掉 `backdrop-filter`（底色不变，深色半透底 + 白字，对比度与原来一致）；大面板半径统一收进来；停掉 7 个纯装饰常驻动画（状态类 spinner / 保存圆点 / 文本光标闪烁**保留**）。
  实测带 backdrop-filter 的元素 135 → **2**。
- **为什么安全**：不碰 `border` / `stroke` / `fill` → 图标仍是线性描边、不出现线框；磨砂配方的变量定义原样保留（`test_novai_canvas_glass_surfaces.js` 仍通过）；被停的动画都有可见的静态 base 样式。

### 3.7 本机镜像写盘降频（新 `canvas-next/localMirror.ts` + `novaiBackend.ts:638`）
- `saveDoc` 不再同步 `writeDoc`：只有 doc 引用变了才写、推迟到 `requestIdleCallback`（1.5s 兜底）、`pagehide/visibilitychange` 同步补写、粗估 >1.5MB 不写（服务端才是权威，localStorage 全局只有 5MB）。
- 为什么安全：读回路径（`novaiBackend.ts:315 readDoc` + 「从本机副本打开」提示）逻辑未改，只是可能读到上一份；真正落盘仍由服务端 PUT 保证。

### 3.8 图片 URL 缓存上限 300M → 64M 字符（`ui/useAsset.ts:12`）
- 最坏 600MB 堆 → 128MB；淘汰后重读是一次 IPC，代价远小于把 8G 机器挤进换页。

## 4. 验证

### 4.1 一致性断言（页面内实测，改动前后都跑）
| 断言 | 改动前 | 改动后 |
|---|---|---|
| 平移后 `#edges path.e` 的 d 属性完全不变（连线仍是世界坐标） | ✅ | ✅ |
| 平移期间 `#world` 的 `--zinv` 不被写 | ✅ | ✅ |
| `#nodes .node` 数量 == 节点总数（**无裁剪**） | ✅ 100 | ✅ 100 |
| 平移后 store.state.view 真的变了 | ✅ | ✅ |
| `#world` 计算出的 matrix 与 store 的 view 一致 | ✅ | ✅ |
| 网格 `backgroundPosition` 跟 view 一致 | ✅ | ✅ |
| zoom 到 k=2 后 `--zinv` 的**夹取后**值与 1/k 等价 | ✅ | ✅ |
| k=0.75 时 `--zinv` 与 1/k 的差 ≤ 量化步长 | — | ✅ |
| 平移时小地图 canvas 像素确实变化 | ✅ | ✅ |
| 画布节点 img 全是 `/api/media-preview` | ❌（原图） | ✅ |
| 灯箱 img 是原图（非 media-preview） | ✅ | ✅ |
| 断言跑完后 `.node` 仍为 100 | ✅ | ✅ |

### 4.2 命令
- `cd novai-canvas-ui && npx tsc --noEmit` → **0 错**
- `npm run build` → **成功**（产物已更新到 `static/novai-canvas/`）
- `node tests/run-all.js` → 见 §4.4
- 截图（浅/深 + fit 全览 + 选中节点 200%）：`/tmp/beat-perf/shots/{baseline,after}-{fit,sel200}-{light,dark}.png`，另有 `after-*-lowperf.png` 展示流畅优先下的观感（去模糊后文字仍可读、图标仍线性）。

### 4.3 首屏（未降速）
| | 改动前 | 改动后 |
|---|---|---|
| domContentLoaded | 77 ms | 71 ms |
| firstPaint | 124 ms | 116 ms |
| store 就绪 / 首节点出现 | 172 ms | 147 ms |
| canvas.js | 1137.5KB（decoded 1137.5KB，服务端无 gzip 时） | 1145.5KB |

> gzip 由 backend-perf 在服务端统一加（他们实测 canvas.js 1137KB → 387KB），我这边不再动构建；vendor 拆分（manualChunks）按 Lead 要求等 gzip 落地后单独评估，本轮**未做**。

### 4.4 node 测试
- 改动前基线（同一工作树）：**135/135 通过**（第一次跑出现过 1 个 flaky 失败，重跑通过）。
- 改动后最终一轮（15:45 产物）：**135/135 全部通过**（含全部 `test_novai_canvas_*` 与磨砂玻璃用例）。
- 中间一轮曾出现 **134/135**：失败项 `test_glide.js` 的两条断言是「`static/smart-canvas.html` 引入 `shared/glide.js` 且带 `?v=『VERSION.mtime』`」——
  该文件在我基线之后（15:22）被并发的 smart 画布改动改过（`stat` 可见 mtime），**与 canvas-next 无关**：`grep` 确认 `test_glide.js` 不读 `novai-canvas-ui/**` 或 `static/novai-canvas/**`。
  该用例单独重跑退出码 0（它只 print 失败、不置退出码）；smart 画布那边补上 `?v=` 后，最后一轮 135/135。
- 与画布相关的 openarc 用例：`test_novai_canvas_*`（backend / glass_surfaces / node_params / table_media / library_* / lossless_edit / media_fit / model_caps / plan_params / requested_fixes / ntb_dock / lightbox_compare 等）**全部通过**，磨砂玻璃规则（`--glass-blur:blur(44px) saturate(190%)` 等）未被破坏。

## 5. 未采纳项与理由

### 5.1 视口裁剪（unmount 视口外节点）——不做
- 理由 1：收益不稳定。100 节点全部在视口内时裁剪收益 = 0，而「节点被错误隐藏」的风险面很大（拖动/连线/`elementFromPoint`/堆叠飞出/工具条定位都依赖节点 DOM 存在）。
- 理由 2：本轮主要损失不在「节点 DOM 太多」，而在解码内存与重渲（已单独解决）。

### 5.2 `content-visibility:auto`（浏览器原生裁剪）——实测后否决
- 同一页面内注入/移除对比（`cvProbe`）：缩放到 1:1（约 20 个节点在视口内）时，平移帧均值 **24.3 → 16.7ms（-31%）**，看起来很美。
- 但整页启用后，**fit 全览（100 节点都在视口内）反而 30 → 115ms（慢约 4 倍）**：每帧都要重算 in/out-of-view 并对进入视口的节点重新做 style/layout/paint。
- 结论：只对「缩进来看局部」有利、对「看全图」有害，且快速平移时新进入视口的节点会晚一帧绘制。**不采纳**（已回滚，代码里没有这段）。

### 5.3 模糊（backdrop-filter）成本：本 harness 测不出来，不写进收益表
- `repaintProbe`（同页切 `data-perf` 并在每帧挪动节点浮层强制重绘）在 headless + `--disable-gpu` 下 high/low 都是 16.7ms（vsync 顶格）→ **测不出光栅差异**。
- 所以流畅优先的收益我只写「结构性指标」（模糊层 135 → 2、装饰动画 -7），不编造帧时间；真机集显的 blur 成本请以 perf-lab 的矩阵为准。

### 5.4 其它
- undo 栈 60 份 → 30：属功能行为变更，不做。
- 用 rAF 合并 `store.emit()`：会改掉「React 之外所有同步读 state」的语义（`elementFromPoint`、拖拽、测试），风险/收益不如 §3.4 的订阅收窄，不做。
- manualChunks 拆 vendor：等 backend-perf 的 gzip 落地后再评估（避免抢跑导致 `canvas.html` 引用与 `?v=` 版本串不一致、桌面 file 场景加载问题）。

## 6. 风险与遗留

1. **dpr2 屏幕 + 高缩放的锐度**：节点卡走 2.5×宽档位预览，k>1.25 的 retina 屏会略软；灯箱/编辑器/导出仍是原图。若不接受，可把 `useThumbnail.ts` 的 `2.5` 调大（内存同比上升）。
2. **本机镜像可能落后一份**：极端情况下（改完立刻崩溃/断电）可能丢最后一次本机镜像，服务端已保存的不会丢。
3. **低性能模式的自动判定**是启发式（4 核 + 1.2s 采样 p95>45ms），首屏 3s 内没有交互会按 3s 兜底采样；用户可随时手动锁定。
4. **构建产物包含外部未提交的功能改动**：同时有另一个会话在改 `novai-canvas-ui/src`（ImageViewer / Character* 等，15:01–15:04），我构建的是整个工作树的当前状态，所以 `static/novai-canvas/canvas.js` 里也含他们的未提交功能改动；与本次性能改动无关。
5. 本轮**没有**改动任何嵌套存储/接口协议；服务端 gzip 由 backend-perf 负责。
6. **反复打开画布时 JS 堆上升（perf-lab 实测，双方一致复现）：本轮不修，按「有界缓存预热」处理**
   - 数据：改动前 8.47 → 15.08 → 21.81 → 22.20 → 22.55 MB（5 次重开），改动后 8.78 → 15.39 → 22.08 → 22.43 → 22.76 MB —— **第 3 轮起进入平台期**（22.20 / 22.55 基本不动），两次表现同形。
   - 同时 DOM 元素数恒定 3706、window/document 监听器恒定 938 → **不是** DOM / listener 泄漏。
   - 判定：这是模块级有界缓存（图片 URL 缓存、ImageBitmap 像素池、模板/音频缩略图缓存等）在多次打开后被填到上限的预热曲线，不是无限泄漏；首轮 +6.6MB 之后每轮增量迅速收敛到 ±0.3MB。
   - **具体归属未查明**（我静态列过可疑项：`agent/state.ts` 的模块级 Agent 会话状态、`ui/thumb.tsx:18` 的 ImageBitmap 池、`ui/Chrome.tsx:379/532` 的模板缩略图缓存；`ui/useAsset.ts` / `ui/useThumbnail.ts` 在 NOVAI 网页版这条路上不写缓存，已排除）。后续排查方法：同一个 target 里重开 5 次，在第 1 次与第 5 次各取一次 HeapProfiler 快照（`HeapProfiler.takeHeapSnapshot`）做 comparison，看 retained size 前几名落在哪个模块。
   - 不做「关闭画布时清理本画布相关 key + 统一 LRU」的原因：属于「更干净但非必要」，而当时产物已冻结、perf-lab 正在用它跑关键格，再 build 一次会让口径漂移。

### 4.5 构建产物（最终）
```
static/novai-canvas/canvas.js   1,145,913B  sha256 26bc1a241a43b516d479ba767472e3976e3f2d69ddb53908da46e43b27ee8b4d  mtime 2026-11-04 15:45:02
static/novai-canvas/canvas.css    231,872B  sha256 f08963ace25f4f412829e3c026d0eb8a81c5d09aeadf2dbbdcedb847654fb0c7  mtime 2026-11-04 15:45:02
static/novai-canvas/index.html       455B  mtime 2026-11-04 15:45:02

> 15:45 这次是 perf-lab 复核后的收尾修补（§3.1 末尾「首帧不再挂原图」），只动了 `useThumbnail.ts` 两行；css 哈希未变。
```
> 临时用于 A/B 的 `static/openarc-baseline/`（开工快照单独构建）已删除，不在交付里。

### 4.6 截图（`/tmp/beat-perf/shots/`）
`baseline-fit-{light,dark}.png` / `after-fit-{light,dark}.png`（fit 全览）、`baseline-sel200-dark.png` / `after-sel200-{light,dark}.png`（选中单节点 200%）、
`after-fit-dark-lowperf.png` / `after-sel200-light-lowperf.png`（流畅优先）。
人工比对结论：深浅两套主题下布局、节点卡、工具栏、小地图、选中态完全一致；差异只有节点图片的采样分辨率（缩略图 vs 原图）与流畅优先下的模糊半径。