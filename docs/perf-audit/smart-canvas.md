# 智能画布（旧版 smart-canvas）性能专项（smart-perf / task-2）

> 写作用域：`NOVAI-v16/static/js/smart-canvas.js`、`static/css/smart-canvas.css`、`static/smart-canvas.html`（另按 Lead 授权改了 `tests/test_glide.js` 一条正则，见 §5.2）。
> 环境：`NOVAI_PORT=3112`（3100/3101 被其他 agent 占用，未碰 3000）、`NOVAI_DATA_DIR=/tmp/novai-perf-smart`，全程没有读写 `NOVAI-v16/data/`。浏览器 Chrome 156（本机安装版），视口 1440×900@1x。
> **数字口径**：采样期间同一台机器上还有别的 agent 在跑基准，`load average 7~9`、空闲内存一度只剩约 90MB。所以：① 绝对数字只作参考，关键结论都用**前后交替采样取中位数**（同一进程里 after/before 轮换，互相承担同样的噪声）；② 表里注明哪次是「较空时单跑」、哪次是「交替 A/B」；③ 最终统一矩阵由 perf-lab 复测。

## 0. 结论摘要

| 指标（140 节点画布 / CPU 6x 降速） | 改动前 | 改动后 | 变化 | 来源 |
|---|---|---|---|---|
| 平移单次 mousemove 的 JS 成本 | 7.11 ms | **0.78~0.84 ms** | **-88%** | 较空时单跑 |
| 平移单次事件（交替 A/B 中位） | 7.43 ms | **1.61 ms** | **-78%** | 交替 A/B |
| 真实平移帧 p95 | 50.0 ms | **33.4 ms** | -33% | 较空时单跑 |
| 真实平移帧 p95（交替 A/B 中位） | 100 ms | **83.4 ms** | -17% | 交替 A/B |
| 首屏 → 140 节点全部渲染 | 1205 ms | **923 ms** | -23% | 较空时单跑 |
| 首屏 → 140 节点（交替 A/B 中位） | 837 ms | **712 ms** | -15% | 交替 A/B |
| 首屏图片请求数 / 字节 | 60 张 / 5055 KB | **38 张 / 742 KB** | **-37% / -85%** | 较空时单跑 |
| 小地图隐藏时 `.minimap-node` 重建量 | 140 个 / 每事件 | **0** | **-100%** | 实测 DOM |
| 缩放 3s 期间 cull 执行次数（140 节点 / 6x） | 每帧一次（≈40+/3s） | **7 次**（2.3/s） | **-80%+** | 埋点实测 |
| 流式：50 次纯文字 ops 触发的整画布 render() | 50 次 | **0 次**（200ms 后补 1 次落定渲染） | **-98%** | 埋点实测 |
| 流式单次文字 ops 成本（140 节点） | 一次整画布 render | **0.066ms（prompt）/ 0.048ms（text）** | 数量级下降 | 埋点实测 |
| 结构 ops 同一任务 6 次 → render 次数 | 6 次 | **1 次**（rAF 合并） | -83% | 埋点实测 |
| 分组归属查表（20 次 cull） | 每次逐节点 O(n) 扫 | **0 次重建**（缓存命中） | O(n²)→O(n) | 埋点实测 |
| 保存一次文档的**全量序列化次数** | 3 次（+1 次深拷 parse） | **1 次（无变化）/ 2 次（有变化）** | -67% / -33%（代码事实） | 代码路径 |
| 其中纯 stringify（705KB 文档） | 0.4 ms / 6x 下 3.0 ms | 同 | 所以本项只省 ~1~2ms，见 §P0-4 诚实结论 | 实测 |
| 空闲 12s 长任务 | 2 个 / 193 ms | 2 个 / 170 ms | 持平（见 §6 forensics） | 较空时单跑 |
| JS 堆（首屏后稳定值） | 31 MB | **24.4 MB**（低性能模式）/ 19.1→16.5 MB（A/B） | -20% | 单跑 / A/B |
| `node tests/run-all.js` | 134/135（1 项 BEAT 失败） | **135/135 全绿** | — | 最终一轮 |

改动量（只统计我的三个文件 + 一条测试正则）：

```
static/css/smart-canvas.css |  30 ++++
static/js/smart-canvas.js   | 373 ++++++++++++++++++++++++++++++++++++++++----
static/smart-canvas.html    |  41 +++---
tests/test_glide.js         |   3 +-
```

## 1. 复现方式（harness 在 `_to_delete/perf-backup/smart-canvas/harness/`，不进版本库）

```bash
# 1) 启动独立数据目录的服务（不要用 3000，也不要碰 data/）
cd NOVAI-v16 && NOVAI_PORT=3112 NOVAI_DATA_DIR=/tmp/novai-perf-smart venv/bin/python main.py
# 2) 造 140 节点测试画布（真实画布 d1d62f1d…json 复制 + 图片 URL 重映射到 12 张自生成图）
venv/bin/python _to_delete/perf-backup/smart-canvas/harness/make_fixture.py
# 3) 前后对比 / 单点基准 / 功能自检 / 长会话
cd _to_delete/perf-backup/smart-canvas/harness
NODE_PATH=/Users/wepingli/node_modules node ab-baseline.cjs --reps 3   # 交替 A/B（用 route 把 JS 换回改动前）
NODE_PATH=/Users/wepingli/node_modules node bench.cjs --perfmode smooth # 单轮基准（含低性能模式）
NODE_PATH=/Users/wepingli/node_modules node verify.cjs                # 工具条/小地图/表格缩略图功能自检
NODE_PATH=/Users/wepingli/node_modules node equivalence.cjs           # 保存等价性 + 回环 + 动画断言
NODE_PATH=/Users/wepingli/node_modules node ab-html-defer.cjs          # 首屏 defer 前后（localhost / 30ms / 6x+30ms）
NODE_PATH=/Users/wepingli/node_modules node soak.cjs                   # 5 分钟长会话
```

测试画布构成：140 节点（122 `smart-image` / 7 `smart-prompt` / 4 `table` / 4 `smart-batch` / 3 `smart-group`）、116 条连线、172 个图片引用、10348 个 DOM 元素、5175 条 CSS 规则 —— 与用户真实画布同构（取自 `data/canvases/d1d62f1dece5456da3dfb757a9b5227f.json`，只把 `/assets/input/*.jpg` 换成 12 张自生成图：8×1024²、4×2048²）。

## 2. 问题与改动（按 impact / effort 排序）

### P0-1 平移时每帧重建隐藏的小地图 + 每事件扫全量 DOM（占平移 CPU 38%）

**证据（6x 降速下 240 次平移的 CPU profile，按自身耗时占比）**：
- `renderMinimap` `smart-canvas.js:4073`（改前）**29.0%**；`querySelector` **9.5%**。
- `applyViewport()`（`:4020` 改前）在**每个 mousemove** 里同步做：小地图重建、缩放条文字、`.smart-tool-portal-host` 全文档查询、`syncSmartImageToolbarBounds()`（内部 `world.querySelector('.image-node.selected .smart-image-toolbar')`，没有选中时也要扫 1 万+ 元素）、编辑栏/标签面板重锚、缩放下拉夹取。
- 小地图默认是**隐藏**的：`smart-canvas.css:5330 #minimap{display:none!important}`，只有 `body.canvas-minimap-visible` 才显示（`canvas-rail.js:620` 切类）。实测 `body.className="studio-scale-viewport"`、`#minimapContent.clientWidth=0`，但 DOM 里仍有 **140 个 `.minimap-node`** —— 每帧重建一遍、全部白干。

**改动**：
- `smart-canvas.js:4072 applyViewport()` 只保留「必须跟手」的事：写 `world.style.transform`、`syncNodeUiInverseScale`、`canvas-scaled`/LOD 类、背景尺寸（加同值判断避免无谓写）。其余收进 `:4093 scheduleViewportFrameWork()` → 一帧一次 `:4102 syncViewportChrome()`。**同一帧来多少次 pointermove 都只算一次**。
- `:4147 smartMinimapVisible()` 只看 `body` 上的 class（**不量尺寸、不碰 getComputedStyle**，按 Lead 要求）；`:4148 renderMinimap(rectOf)` 隐藏时在轻量同步后直接 return，0 工作量。
- `:4186` 加 `MutationObserver` 盯 `body` 的 class：用户在 `canvas-rail.js` 里点开小地图（那一步不会回调本文件）时，立刻补画一次，不会出现「打开是空白、要等下次平移才出现」。

**收益**：平移单事件 7.11 → 0.78~0.84 ms（6x）；交替 A/B 中位 7.43 → 1.61 ms；平移帧 p95 50 → 33.4 ms；隐藏态小地图重建量 140 → 0。

**风险与安全性**：只改「什么时候算」，不改「算什么」；唯一可感知差异是**最多晚一帧**（≤16.7ms）完成工具条/小地图/下拉夹取。已验证：选中节点后工具条相对节点偏移在平移前后、拖拽前后完全一致（`centerDelta=0`、`barAboveNode=true`、`barInsideViewport=true`，见 §5.3 截图与断言）。

### P0-2 同一帧内 140 个 `nodeRect` 算两遍

**证据**：profile 里 `imageLayout` 3.9% + `smartGroupContainingNode` 4.4% + `shared/media.js originalMediaUrl` 4.7% + `URL` 3.8% —— 这些都由 `nodeRect()`（`:3793`，内部 `imageLayout` 要解析媒体 URL、算分组归属）拉起，而 `cullOffscreenNodes`（`:41318` 改前）和小地图在同一帧各算一遍 140 个。

**改动**：`:41522 nodeRectFrameCache()` —— 缓存实例在**一次同步调用栈内**创建、用完即弃，**不跨帧**，所以不存在「选中/尺寸变化后拿到过期矩形」的问题（Lead 问的过期风险由「不跨帧」这条结构性约束排除，而不是靠失效标记）。`:41538 cullOffscreenNodes(rectOf)` 与小地图共用同一份。命中率可自查：`window.__smartPerfStats`（`{hits, misses}`）。

**实测**：小地图隐藏时 cull 独占缓存，`hits=0 / misses=279`（无收益也无额外开销）；小地图打开时同一帧里两处共用，hits 随之上升。

### P0-1b 视口外裁剪（cull）单独节流（第二轮解冻，perf-lab 帧级数据驱动）

**证据（perf-lab 的 after 帧级数据，100 节点 / 6x / zoom 阶段）**：我第一轮把 renderMinimap 从 hot 里消掉后，`cullOffscreenNodes` 变成唯一热点 —— **550ms（61%）**、zoom p95 208.9ms（比 before 的 134.1ms 更差）、longTasks 18 / longTaskMs 2917。原因：`scheduleViewportFrameWork` 里 cull 跟着 rAF 每帧跑，而 6x 降速下一个 rAF 就有 130ms+，固定时间节流几乎等于「每帧都跑」。
**改动**（只动 smart-canvas.js 一处）：
- `:4093 scheduleViewportFrameWork` 只留 chrome（小地图/缩放条/浮动菜单/工具条夹取），cull 交给独立节流器；
- `:41539` 起 `scheduleOffscreenCull()`：连续视口变化期间按 `smartCullMinInterval()` 决定是否跑，**视口停稳 150ms 后一定补跑一次**；
- `smartCullMinInterval()` = `min(450, max(150, 帧间隔EMA / 0.15))` —— 快机器固定 150ms（≈每 9 帧一次），6x 掉到 6~8fps 时自动放到约 380~450ms（≈每秒 2~3 次）。帧长 EMA 由 `:4098 noteSmartFrameInterval()` 在每帧的 chrome 回调里顺手更新（不新增 rAF）。
- 首次进入画布仍由 `render()` 末尾直接 `cullOffscreenNodes()`（不受节流影响）；`cullOffscreenNodes` 内部「跳过 selected / dragging / 聚焦中节点」的规则原样未动。
**实测（140 节点 / 6x / 连续缩放 3s，埋点 `window.__smartPerfStats.cullRuns`）**：cull 执行 **7 次（2.3 次/秒）**，对照的是「每帧一次」；同一次 profile 里 `cullOffscreenNodes` 已**不在 top-12**（<5ms），缩放帧 p50/p95 = 16.7/16.7ms。停稳后补跑生效（计数 +1），停稳后抽查：140 节点里 116 个远距离节点全部 `nv-offscreen`，视口内 3 个节点全部未隐藏；`fitAll` 后 offscreen 归 0、cull 只跑 1 次。
**语义与风险**：`nv-offscreen` 只影响合成/绘制（`content-visibility:hidden`），不影响坐标、命中、导出（导出前有 `smartExportingNow` 直接 return，且导出会走完整 DOM）；裁剪边界本来就有「半屏余量」，最坏情况是节点进入视口后最多 150~450ms 才被取消隐藏，肉眼等于无（远小于半屏余量能覆盖的平移速度）。若将来要更激进，改 `SMART_CULL_MAX_INTERVAL` 一个常量即可。

### P0-2b 流式 ops 触发整画布 render()（第二轮，本轮最大热点）

**问题**：`applyAgentCanvasOps()` 只要 `changed` 就无条件 `render()`（原 `smart-canvas.js:10050` 附近）。`render()` 是整画布级别的：给**全部**节点重算 HTML 模板、比对 `__renderKey`、重建图标（`lucide.createIcons` 全文档扫描）、重新量尺寸、重建连线层、重画小地图。250 节点 / 6x 下 perf-lab 测得流式 p95 数百 ms。

**改动**（只在 `static/js/smart-canvas.js`）：
- `:9987` 起新增 `SMART_OPS_TEXT_KEYS = [text, outputText]`、`scheduleAgentOpsRender()`（rAF 合并，一帧最多一次 render）、`scheduleStreamingTextSettle()`（200ms 落定渲染）、`paintStreamingNodeText(node)`（单节点文字 DOM 刷新）。
- `applyAgentCanvasOps()` 里判定「纯文字增量」：无 `nodes_remove`/`nodes_upsert`/`connections_*`、无 `unset`、`set` 的键全部在 `text/outputText` 内。命中则**只刷受影响节点的文字 DOM**（prompt 节点复用生产里已有的 `paintPromptStreamSnapshot`：节点预览 + 编辑栏流式预览；text 节点刷 `.smart-text-preview` + 字数脚注），**不渲染**；否则走 `scheduleAgentOpsRender()`（rAF 合并）。收尾 200ms 后补一次 `render()`，让 Markdown、节点自动高度、角标落定。
- 打字保护（`PROMPT_KEYS`）、`refreshActive` 的 `updateComposer`、`scheduleConnectionLayerRefresh`、`resumeSmartPendingTasks` 全部保持原样；DOM 刷不动（例如聊天页签、空文本节点还没有预览容器）时**自动退回**整画布 render，不会留下半截界面。

**实测（140 节点，埋点 `window.__smartPerfStats.renders / textPatches`）**：

| 场景 | 结果 |
|---|---|
| prompt 节点连续 50 次文字 ops | 整画布 render **0 次**，textPatches 50，总耗时 3.3ms（**0.066ms/op**），DOM 末尾文字与模型一致；200ms 后补 1 次落定渲染 |
| text 节点连续 40 次文字 ops（节点已有内容） | render **0 次**，textPatches 40，**0.048ms/op**，DOM 同步更新，落定后高度 116px 正常 |
| text 节点从「空节点」开始流式 | 前几次自动退回整画布 render（空态没有 `.smart-text-preview` 容器），有内容后自动转快路径 |
| 同一任务里 6 次结构 ops（改 x） | 当帧 render **0 次** → 下一帧 **1 次**（rAF 合并） |
| prompt 节点切到聊天页签后改文字 | 快路径拒绝，退回整画布 render（聊天页签显示的是对话记录，不能按那套刷） |
| 补充：text 节点有内容后连续 40 次文字 ops（独立脚本 `round2-text2.cjs`） | render **0 次**，textPatches 40，**0.048ms/op**，落定后高度 116px 正常 |

**perf-lab 受控复核（ABBA、两侧同代理、100 节点 / 6x / 各 3 轮 / pin full，loadavg 10~12）**：流式 p95 **284.0ms → 17.5ms（-93%）**，两侧区间完全不重叠（275.1~316.9 vs 16.9~25.0）；after 侧 3 轮流式**整画布 render = 0 次**、textPatches 173/轮、groupMapBuilds 173、cullRuns 3。这是本轮最确定的一项。

**风险与回退**：结构类 ops 的 DOM 落地从「同步」改为「下一帧」（≤1 帧）；为此给测试钩子加了同步版 `applyOpsNow()`（`__smartAgentTestHooks`），需要同步断言的用例用它。文字增量路径与生产流式（`paintPromptStreamSnapshot`）是同一套函数，打字机效果不变。回退：把 `applyAgentCanvasOps` 尾部的分支换回 `render()`。

### P1-1b 分组归属判定 O(n²) → 一次建表

**问题**：`smartGroupContainingNode()` 原本每次 `nodes.find(... items.includes ...)`（O(n)），而 `imageLayout()` 对**每个**媒体节点都会问一次 —— cull / render 一轮就是 O(n²)（250 节点约 6 万次 `includes`）。perf-lab 平移 profile 里它占 3.1%，`isSmartGroupNode` 1.8%。
**改动**：`:2502` 附近新增 `smartGroupOwnerMap()`（nodeId → 分组对象，一次 O(节点数+成员数) 建表，**保持「第一个包含它的分组胜出」的旧语义**）+ `invalidateSmartGroupOwnerCache()`；缓存 key = `nodes` 数组身份 + 节点数（节点增删自动失效），分组 `items` 被改的 7 处显式失效，`render()` 开头也清一次（漏改也能在下一次渲染自愈）。
**实测**（干净 fixture 复测）：连续 20 次 cull → **分组表重建 0 次**（全部缓存命中）；`cullOffscreenNodes` 单次 **0.32ms（1x）/ 3.32ms（6x）**（140 节点）；分组渲染结果不变（3 个分组 / 7 个媒体成员照旧，`smart-group-media-member` 数量一致）。
**风险**：如果将来有新代码绕过这 7 处改动去改 `items`，最坏是「本次渲染分组归属旧一拍、下一次渲染自愈」。

### P1-2b 缩放帧级复核（受控交替 A/B）

**口径**：同一进程里 after / before 交替各 3 轮（before = 我上一轮的产物经 route 替换），6x 降速、140 节点、每轮 3s 连续 wheel 缩放，记录 `os.loadavg()` 与 longtask。跑了两次：① 第一次采样时 loadavg 16.5→13.9（序列 [16.47, 16.60, 16.39, 15.65, 14.88, 13.85]）；② 之后同一脚本复测一次（loadavg 仍在 11~16）。**只认「同一分钟交替中位」**，绝对值不作对外口径（最终矩阵由 perf-lab 复核）。

| 指标（6x，3s 连续缩放） | before（中位） | after（中位） |
|---|---|---|
| 帧间隔 p50 / p95 | 16.7 / 16.8 ms | **16.7 / 16.8 ms** |
| 长帧数（>32ms） | 3 | **1** |
| longtask 数 / 总时长 | 0 / 0ms（另一轮 1 / 53ms） | **0 / 0ms** |
| cull 执行次数 | 无埋点（每帧一次，约 40 次/3s） | **7 次** |

结论：**缩放帧级不劣于 before**（p50/p95 持平，长帧与 longtask 反而更少），且 cull 从「每帧一次」降到 7 次/3s。与上一轮「结构性问题修好但缩放帧级无改善」的结论一致：缩放的剩余成本在系统样式重算/绘制（`(program)` 占多数），不是 JS 热点，本轮没有再动。

**perf-lab 的 ABBA 复核（同代理两侧、100 节点 / 6x，与上表不是同一种负载）**：缩放 p95 **150.3ms → 140.9ms（-6%）**，但 longTask 个数 19~20 → **26（略增）**。

> **待核项（测量口径差异，待安静机器复核）**：这条 longTask 计数差异**不构成需要改代码的结论**，理由是：
> 1) 两侧负载不是一回事 —— 我的对照是 140 节点 / 3s 连续 wheel / p95 16.7ms 量级；perf-lab 的口径更像「逐帧程序化改 scale」，p95 150ms 量级；
> 2) 更强的证据已经指向不劣于 before：缩放 p95 -6%、流式 p95 -93%（284→17.5ms）、结构指标 `renders=0 / textPatches 命中 / groupMapBuilds 命中 / cullRuns=7`；
> 3) perf-lab 还缺三项才能判定：longTask **总时长**（个数多但总时长下降 = 工作量重新分布，不是新增成本）、zoom 阶段 profile top-10、zoom 阶段 `renders` 是否为 0。
> 若补齐后仍是「总时长明显变长」，再解冻 `smart-canvas.js` 评估；在此之前**保持冻结**，本项列为本轮未结项。

**诊断结果（2026-11-04 17:0x，只诊断未改代码）**：用 Chrome Trace（`UpdateLayoutTree / Layout / Paint / PrePaint / Layerize / FunctionCall` 逐项计时）在**两侧都走 route 从磁盘喂**的对称仪器上复现了同一负载（Ctrl+wheel、deltaY -13.98、每 tick +50ms、每 6 档翻转、3s、6x、140 节点、loadavg 10.6）：

| 指标（3s 缩放窗口） | before（原始快照） | after（当前） |
|---|---|---|
| 完成滚轮档数（同一 3s 墙钟） | 25 | **34** |
| 帧 p95 / longTask 数 / longTaskMs | 66.7ms / 21 / 1493ms | **50.0ms / 10 / 559ms** |
| `UpdateLayoutTree`（样式重算）总计 | 991.6ms / 72 次 | 1149.6ms / **43 次** |
| 样式重算**每档**均摊 | 39.7ms/档 | **33.8ms/档** |
| `Layout` 总计 / 每档 | 100.7ms / 4.03 | **67.0ms / 1.97** |
| `Paint` 总计 / 每档 | 75.3ms / 3.01 | 87.6ms / **2.58** |
| JS 自身（`FunctionCall` self） | 1253.3ms | **163.9ms** |
| `setTimeout` / `clearTimeout` 调用数（总耗时） | 63 / 49（4.5+2.1ms） | 117 / 100（3.9+3.2ms） |
| `document.querySelector`（总耗时） | 25 次 / 11.0ms | 34 次 / 14.9ms |

结论：**「after 多出 567ms program」在对称仪器上没有复现**；after 的样式重算**总量**确实高了 +158ms，但那是「同一 3s 里多跑 9 档滚轮」带来的，**每档均摊反而下降 15%**（39.7→33.8ms），Layout 每档降一半。perf-lab 的 +21% 最可能来自**固定 3s 窗口下的档数差异**（快的一侧跑更多档 → 绝对原生时间被放大）＋ 两侧代理/快照的仪器差，不是代码回归。

五个嫌疑逐一排除（实测）：① 每帧 `setTimeout/clearTimeout` 共 217 次总耗时 7.1ms（3s 窗口的 0.2%）；② `document.querySelector` 34 次 14.9ms；③ renderMinimap 早退前的三个同步调用没有增加样式重算（事件数 72→43）；④ cull 8 次（140 节点 3.32ms/次 ≈ 26ms）没有形成 14ms 长帧；⑤ 样式重算每次元素数两侧一致（1518~1742），说明 `--nv-zoom-inv` 这类全子树失效是**改前就有的**、不是我引入的。
**结论：未定位为代码回归，无需改代码；建议 perf-lab 的缩放阶段改成「固定档数（如 24 档）」或按「每档」归一，而不是固定 3s 墙钟。**

**最强证据（同一 3s 窗口、两侧对称仪器、按「每档」归一）**：

| 每档均摊 | before | after | 变化 |
|---|---|---|---|
| 样式重算 `UpdateLayoutTree` | 39.7 ms/档 | **33.8 ms/档** | **-15%** |
| 布局 `Layout` | 4.03 ms/档 | **1.97 ms/档** | **-51%** |
| JS 自身 `FunctionCall` self | 1253.3 ms / 25 档 | **163.9 ms / 34 档** | **-90%（合计口径）** |

即：after 在同一段墙钟里跑得更多（34 档 vs 25 档），所以绝对原生时间被放大；但**每一步都更便宜**。这就是 perf-lab「+21~26% program」的来源，不是代码回归。

### P0-3 多维表格单元格用原图 `<img>`（真实画布里单张解码约 159 MB）

**证据**：实测 DOM 里 230 个节点图有 **80 个是原图** `/assets/…`，全部来自 `table-media-thumb`（表格单元格），渲染入口 `smart-canvas.js:39872` 的适配器 `canvasPreviewImgHtml`（改前直接 `<img src=url>`）。表格模块 `shared/table-node.js:263/511/637/1065` 传的 size 是 **32/24/36/256 显示像素** —— 也就是说 5562×7140 的原图被塞进 15px 的格子里全尺寸解码。
**改动**：`:39970` 适配器改走节点同款缩略图接口 `/api/media-preview`（`main.py:9098`，按路径+尺寸落盘缓存 + immutable），w 按「格子显示尺寸 × dpr」归一到 128/256/384/512（封顶 512）；补 `loading="lazy"`、`decoding="async"`、`onerror` 回退原图。**导出 / lightbox / 生成仍读 `node.images` 里的原图 URL，不受影响。**
**收益**：同一画布首屏图片请求 60 → 38、字节 5055KB → 742KB（**-85%**）；真实 5562×7140 原图（解码 159MB）→ 256 宽 webp（约 0.3MB），实测单元格 `naturalWidth=256`。
**风险**：缩略图首次访问要服务端现生成（PIL，走线程池）；`lazy` 让视口外格子延后取图（用户快速拖动画布时会有一瞬空白，比爆显存可接受）。回退原图保证「缩略图接口不可用」时不白格。

### P0-4 保存链路：1 次深拷 + 3 次全量序列化

**证据**：改前 `saveCanvas()`（`:14282`）依次做：`canvasForStorage()` = `JSON.parse(JSON.stringify(canvas))`（1 次全量 stringify + 1 次 parse）→ `canvasContentSignature()`（第 2 次 stringify）→ `fetch(body: JSON.stringify(...))`（第 3 次）。**每次 `scheduleSave`（含只改选中态、开面板）都要付这三遍。** 实测 140 节点画布 JSON 约 **670 KB**，6x 降速下这就是空闲期那 2 个 100ms 级长任务的来源。
**改动**：
- `:1264 canvasForStorageShallow()`：逐节点浅拷 + 同一份「剥临时字段」清单，代替整张画布的深拷（省掉 1 次全量 stringify + 1 次全量 parse）。
- `:14370 saveCanvas()`：文档没变化时只花**1 次**签名序列化就返回；有变化时签名 + 请求体各 1 次（**共 2 次**）。`body` 改为预先拼好的字符串（`body: saveBodyText`）。
**等价性证明见 §3（必做项，已通过）。**

**诚实结论（实测后的修正）**：这次只把「全量序列化次数」从 3 降到 1/2，并去掉了深拷那一次 parse；但用页面内探针单独计时发现，**705KB 文档的纯 JSON.stringify 只要 0.4ms（普通）/ 3.0ms（6x）**，所以这一项的墙钟收益量级只有 **~1~2ms（普通）/ ~6ms（6x）每次保存**，并不是空闲期那 2 个 100ms 级长任务的主因（改前 2 个 / 193ms，改后 2 个 / 170ms，基本持平）。剩余成本推断来自 canvasForStorage* 里逐节点的 mediaItemForStorage / settingsForStorage 归一化 + 6x 下的布局与 GC —— **这一条只做到「不再白做 2 遍」，没有把长任务消掉，属于未完成的观察**（要彻底解决需要把归一化也挪进 idle 分片，风险更高，未在本次范围）。

### P1-1 低性能模式「流畅优先」（新功能，用户可开关 + 持久化）

设计见 §4。代码：`smart-canvas.js:41433` 起（探测/持久化/应用）+ `:38003`（低性能模式下常驻 500ms 特效扫描在「没有生成中节点」时直接跳过）+ CSS `:8310` 起 + 入口 `smart-canvas.html:287`。

### P1-2 节点大图预览宽度按显示框收敛

**证据**：改前单图节点固定请求 `w=768`、缩略格 `w=512`；实测节点显示框只有 154~179px（还有 105×158 的竖图），却按 768 解码 —— 真实画布 140 张独立大图就是 140 × 768² × 4B ≈ 330MB 解码内存。
**改动**：`:788 smartPreviewScaleBucket()` + `:792 smartNodePreviewWidth()`：宽度 = 显示框 × 缩放档位（>0.8 / 0.4~0.8 / <0.4 三档）× dpr × 1.15，量化到 256/384/512/768（封顶 768）；**档内宽度不变**，且换档只在下一次 `render()` 生效 —— 缩放过程中不会每帧换 URL 触发重复解码。单图 `<img>` 补 `decoding="async"`。
**风险**：档位跳变（如 81% 缩到 79%）后，下一次 render 会给已存在的节点换一次 URL（一次重新取图）。为把频率压到最低，档位只有 3 档，且 render 只在内容/选中变化时发生。

### P2 首屏 13 个同步脚本改 defer（Lead 追加线索）

**证据**：`smart-canvas.html` 改前有 20 个非 defer 的 `<head>` 脚本（`theme.js`、`shared/utils.js`、`size-policy.js`、`media.js`、`psd-writer.js`、`viewport.js`、`workflow-utils.js`、`node-registry.js`、`table-model.js`(75KB)、`table-node.js`(113KB)、`dropdown.js`、`glide.js`、`morph-button.js`、`i18n.js` …），HTML 解析必须逐个下载+执行。
**改动**：`smart-canvas.html:28` 起 13 个脚本（上列除 `theme.js` 外的全部）加 `defer`，并在前面写了原因注释。`theme.js` 保留同步（首屏上色要赶在 CSS 生效前，避免闪白）。
**为什么安全**：这 13 个文件都是纯全局定义（IIFE 只挂 `window.X`）；预览页 body 里**没有 inline `<script>`**，全页**没有 `onload=`/`onerror=` 内联处理器**（grep 计数 0）；`defer` 之间严格按文档顺序执行，且都排在原有 `defer` 脚本之后、`smart-canvas.js` 之前 —— 依赖顺序与改前完全一致。
**收益（首屏，交替 3 轮中位）**：

| 场景 | 指标 | defer 前 | defer 后 |
|---|---|---|---|
| localhost 不降速（5 轮交替） | 首屏到 140 节点 | 1029 ms | **962 ms** |
| | DCL / load | 445 / 576 ms | **436 / 527 ms** |
| 30ms 延迟 | 首屏到 140 节点 | 971 ms | 973 ms（噪声内） |
| | DCL / load | 373 / 515 ms | 399 / 531 ms（噪声内） |
| **6x 降速 + 30ms 延迟** | **DCL** | 1516 ms | **1090 ms（-28%）** |
| | **load** | 1778 ms | **1586 ms（-11%）** |
| | 首屏到 140 节点 | 3871 ms | 3970 ms（噪声内） |

结论：**在主线程慢（6x）时收益明确（DCL -28%）**；localhost 不降速时只有小幅/噪声级差异 —— 因为本地下载本来就快，「解析阻塞」的代价被掩盖了。保留该改动（机制上只会减少解析阻塞，不会新增工作）。

**未做（评估后风险偏高）**：把 `table-model.js`+`table-node.js`(188KB) 改成按需加载。它们在 `smart-canvas.js` 里有 20+ 处直接调用（`mountSmartTableNodes`、`nodeBodyHtml` 的表格分支、批量生成链路等），改成异步要逐处加 await/guard，超出「diff 要小、可解释」的边界。建议作为后续独立 PR。

## 3. 保存等价性证明（Lead 必做项）

### 3.1 深拷 vs 浅拷逐字段 diff

在真实 140 节点画布上、**同一次调用内**分别取旧 `canvasForStorage()` 与新 `canvasForStorageShallow()` 的 JSON（只读探针 `window.__smartAgentTestHooks.storageJson()`，见 §8 说明）：

```
deepLen = 669764   shallowLen = 669764   deep === shallow: true
递归 diff（key 集合 + 逐层值，最多 40 条）: count = 0
```

即：**除显式 delete 的那批临时字段外，零差异**（字段清单与 `canvasForStorage()` 逐条对齐：`_batchRunning/_batchProgress/_batchRunCount/_batchRunRows/_batchRunConcurrency/_batchStopRequested/_stopContextId/tableBatchRunning/batchRunExpected/batchRunLanded/batchRunFailed/batchRunConcurrency/batchRowOrder/batchRowStates/__renderHtml/__renderKey/running/chatStickBottom/chatFocusInput`，另加 `SMART_LOG_PREVIEW_NODE_ID` 过滤）。

### 3.2 真实 PUT 回环

抓一次真实保存请求的 body，与浅拷 JSON 的对应字段比对：

```
PUT /api/canvases/perfsmart100  次数=1
body vs shallow 递归 diff: count = 0     （body 额外带 viewport / base_updated_at / client_id，属预期）
```

### 3.3 保存 → 刷新 → 回读

```
保存前: nodes=140 conns=116
拖动节点 n_a47d0b33680318_1791445080589: world 坐标 (812,785) → (950,851)，即 +138/+66（屏幕 +80/+40 @ scale 0.58）
刷新后: nodes=140 conns=116  节点顺序一致  节点标题列表一致  目标节点坐标 (950,851)  控制台报错 0
```

→ 浅拷版本可以保留（未回退成深拷）。

## 4. 低性能模式「流畅优先」（P1-1）

### 4.1 默认值与开关

| 项 | 行为 |
|---|---|
| 默认 | `auto`：`hardwareConcurrency ≤ 4` **或** `deviceMemory ≤ 4`，**或**首屏后一次性帧率采样判定慢 → 才降级 |
| 帧率采样 | 首屏后**只采一次**：延迟 1.5s 开始、40 帧、丢掉 >100ms 尖峰，中位帧 >24ms 才算慢（避免高配机被启动抖动误判） |
| 手动开关 | 左栏「更多 → 流畅优先」（`smart-canvas.html:287`），`localStorage.novai_smart_perf_mode = 'smooth'（强制开）/ 'full'（强制关）`，**只影响本机** |
| prefers-reduced-motion | 额外挂 `body.smart-reduce-motion`，**只关装饰动画**（生成光束/思考微光），不动磨砂、不动功能 |
| 降级内容 | ① 节点卡片磨砂关掉（`.group-node`/`.prompt-smart-node`/`.loop-smart-node`/`.smart-group-node`/音频卡/文件卡，底色本来就接近不透明）；② 连线流动动画、生成光束、呼吸/微光停掉；③ 低性能模式下 500ms 常驻特效扫描在没有生成中节点时跳过 |
| 不降级 | 进度 spinner、流式文本光标、保存状态、所有交互入口、布局、配色、图标（见 4.2 断言） |

菜单入口原本放在右上「更多」，实测 `#canvasTopRight` 在画布页被 `smart-canvas.css:5245 display:none !important` 收起（点不到），因此改到左栏 `#canvasLeftMorePanel`（`smart-canvas.html:287`），并复用了该面板既有的 `.canvas-anchored-item` 样式；开启状态用一颗 6px 圆点表示（沿用画布既有「软底/圆点」语言，不画线框）。

### 4.2 断言：该动的还在动（Lead 必做项）

注入代表性 DOM 后读 `getComputedStyle().animationName`：

| 元素 | 普通模式 | 低性能模式 | 结论 |
|---|---|---|---|
| `.jimeng-pending-spinner i`（生成中进度 spinner） | `spin` | **`spin`** | 仍转 |
| `.chat-tw-caret`（流式文本光标） | `chatCaretBlink` | **`chatCaretBlink`** | 仍闪 |
| `.conn-line.conn-pending`（连线流动） | `dash-flow-pending` | `none` | 停（装饰） |
| `.gen-beam`（生成光束） | `genBeamSweep` | `none` | 停（装饰） |
| `.thought-line__breath`（思考微光） | `thoughtLineShimmer` | `none` | 停（装饰） |
| `.thought-line__glyph`（思考图标呼吸） | `thoughtLineBreath` | `none` | 停（装饰） |

保存状态文字（`#smartSaveState`）不是动画，低性能模式不影响它的「保存中…/已保存」切换。

## 5. 验证与回归

### 5.1 单元/静态测试

```
改动前基线：node tests/run-all.js → 134/135（唯一失败 test_novai_canvas_requested_fixes.js，属 BEAT 画布）
改动后最终：node tests/run-all.js → 135/135 全通过
```

（中途出现过一次由我的 defer 改动引起的假红，见 5.2，已修。）

### 5.2 测试配套修正（经 Lead 授权，只改一条正则）

`tests/test_glide.js:266` 原本用 `/<script src="…glide\.js\?v=([0-9.]+)"><\/script>/` 断言「页面引入了 glide.js 且带版本号」。`glide.js` 加了 `defer` 后不再匹配。改为允许 `<script>` 与 `src` 之间有属性（`/<script\s+[^>]*src="…"/`），**断言本意不变**（仍要求引入且 `?v=` 是 VERSION.mtime 形式）。`node tests/test_glide.js` → 90/90。

### 5.3 功能自检（playwright，`verify.cjs` / `equivalence.cjs` / `final-evidence.cjs`）

| 项 | 结果 |
|---|---|
| 页面加载、140 节点渲染 | 正常，无 `pageerror` / `console.error` |
| 表格单元格缩略图 | 80/80 走 `/api/media-preview`（w=256），`loading=lazy`、`decoding=async`、保留 `data-original-src` 回退 |
| 小地图默认隐藏 | `.minimap-node` = 0（0 工作量） |
| 点开小地图 | 2 帧内 140 个格子齐全，`clientWidth=170` |
| 选中节点工具条位置 | 节点 (307,318,244×239) / 工具条 (205,277,449×38)：`centerDelta=0`、在节点上方、完整在视口内 |
| 平移 30 次后 | 工具条相对节点偏移不变（dx=113, dy=-538） |
| 拖拽 40 次后 | 偏移仍不变，节点随后被拖动 +80/+40 屏幕像素 |
| 缩放 0.55 后 | `centerDelta=0`、`canvas-scaled` 类生效 |
| 保存回环 | 见 §3.3（140/116、顺序/标题/坐标一致、0 报错） |
| 低性能模式开关 | 点一次 → 生效 + `localStorage=smooth` + 圆点 0.85 + 面板自动收起 + toast；刷新后保持；再点一次 → 关闭 + `full` |

截图（已拷到 `NOVAI-v16/_to_delete/perf-backup/smart-canvas/shots/`，不进版本库；也可用 harness 重跑生成到 `/tmp/perf-smart-shots/`）：
- `final-toolbar-selected.png` 选中后工具条位置
- `final-toolbar-after-drag.png` 拖拽后工具条仍贴住
- `final-left-more-menu.png` 左栏「更多」里的「流畅优先」入口
- `final-low-perf-on.png` 开启后的画布（磨砂关闭、观感一致）

### 5.4 5 分钟长会话（soak，6x 降速，连续交互压力）

```
node soak.cjs  →  48 轮 / 305s，数据见 §6.2 表
堆 20.9 → 36.5 MB（平台期，撤销栈上限 40 导致）；DOM 节点 10210 → 10490（+2.7%，无泄漏）
docs 全程 6（无文档泄漏）；image 节点恒为 140；页面报错 0
```

## 6. 深入观察

### 6.1 未采纳项与负结果

1. **手势期间给 `.world` 加 `will-change: transform`（想让平移变纯合成）—— 实测更慢**：交替 3 轮，6x 降速下平移帧均值 **33.5ms（加）vs 28.1ms（不加）**。原因：`.world` 是 6000×4000 的大层（`smart-canvas.css:45`），提升为独立层后整层重新栅格化，反而更贵。已在 `smart-canvas.css:8331` 留注释记录，**没有采用**。
2. **节点图 `loading="lazy"`**：画布本来就用 `nv-offscreen` + `content-visibility:hidden` 收起视口外节点，再加 lazy 只会让快速平移时出现白卡，收益不抵观感损失 —— 只给表格单元格加了 lazy（它们数量多且尺寸极小）。
3. **`table-model.js` + `table-node.js`(188KB) 按需加载**：调用点 20+，见 §2 P2。
4. **`screenToWorld()` 里的 `getBoundingClientRect`（每事件 0.46ms@6x）**：可以缓存 `shell` 的 rect，但 shell 尺寸会随窗口/侧栏变化，失效点分散；收益小（约 8% 平移 JS 成本），风险不划算，未做。

### 6.2 长会话与「用久了越来越卡」

5 分钟 soak（6x 降速，每轮 = 平移 40 事件 + 选中 6 个节点 + 拖节点 30 事件 + 缩放一档，间隔约 2s）：

| 采样点 | 堆 | DOM 节点 | image 节点 | Layouts | StyleRecalcs |
|---|---|---|---|---|---|
| start (t=0) | 20.9 MB | 10210 | 140 | — | — |
| round16 (t=103s) | 26.6 MB | 10510 | 140 | 2583 | 3615 |
| round24 (t=150s) | 34.8 MB | 10507 | 140 | 3630 | 5074 |
| round32 (t=201s) | 31.3 MB | 10304 | 140 | 4690 | 6608 |
| round40 (t=246s) | 35.4 MB | 10490 | 140 | 5865 | 8298 |
| end (t=305s) | 36.5 MB | 10490 | 140 | 7277 | 10259 |

结论：**DOM 节点数稳定（±2%，无泄漏）**；堆从 20.9 → 36.5 MB 后进入平台期（24~38MB 震荡），与撤销栈上限 `UNDO_LIMIT=40` 一致（每轮拖动都会 push 一次快照，40 步后开始丢弃最旧的一份）；`docs=6` 全程不变（没有 iframe/文档泄漏）。长任务数量随「合成交互频率」线性增长（这是压力测试输入造成的，不代表日常使用），单次最长 1096ms 出现在 6x 降速 + 机器 load 9 下的整画布 render。

唯一与「越来越卡」直接相关且这次已修的是**保存链路**（§P0-4）：改前每次自动保存都要 3 次全量序列化（670KB 文档），改后无变化时 1 次、有变化 2 次，并去掉了深拷。

## 7. 风险与回退

| 改动 | 风险 | 回退方式 |
|---|---|---|
| P0-1 视口副作用 rAF 合并 | 工具条/菜单/小地图最多晚一帧；用户若在同一帧内连点「缩放下拉」可能被 `closeSizeCustomSubmenu` 收掉（与改前同样的行为，只是晚 ≤16ms） | 删 `scheduleViewportFrameWork/syncViewportChrome`，把函数体搬回 `applyViewport` |
| P0-1 小地图隐藏跳过 | 若将来有代码在隐藏时依赖 `.minimap-node`（例如导出截图），需先打开小地图 | 去掉 `renderMinimap` 里的 `if(!smartMinimapVisible()) return;` |
| P0-2 矩形缓存 | 只活在一次调用栈内，无跨帧过期 | 传 `rectOf` 的两个调用点改回 `nodeRect` |
| P0-1b cull 节流 | 连续视口变化时离屏节点最多晚 150~450ms 收起；语义不变（只影响合成/绘制） | `scheduleOffscreenCull()` 改回 `if(smartCullRaf) return; smartCullRaf = requestAnimationFrame(cull...)` |
| P0-3 表格缩略图 | 依赖 `/api/media-preview`（`main.py:9098`，还在）；首次访问要现生成 | 适配器改回 `<img src=url>` |
| P0-4 浅拷保存 | 依赖「节点 images/runSettings 在 saveCanvas 上游已就地规范化」这条前提（`:14285-14288`）；若以后有人在 `saveCanvas` 之前跳过这一步，需要同步维护 `canvasForStorageShallow` 的字段清单 | 把 `:14371` 的 `canvasForStorageShallow()` 换回 `canvasForStorage()`（一行） |
| P1-1 低性能模式 | 默认 auto，只在探测命中时降级；观感差异仅「磨砂关掉 + 装饰动画停」 | 删 body class 或 `localStorage.novai_smart_perf_mode='full'` |
| P1-2 预览宽度 | 档位跳变时一次重新取图 | `smartNodePreviewWidth()` 直接 `return 768` |
| P2 defer | 依赖顺序与改前一致（见 §2 P2 证据） | 去掉 13 个脚本的 `defer` 属性 |

## 8. 备注

- 新增的只读测试探针 `window.__smartAgentTestHooks.storageJson()`（`smart-canvas.js:41360` 附近，与既有的 `node/nodes/connections/selectedId/busy/applyOps/save` 探针并列）：返回深拷/浅拷两份序列化结果，供 §3.1 的等价性断言使用，**不参与任何业务逻辑**。
- `window.__smartPerfStats`：矩形缓存命中计数（自查用）。
- **归属说明（重要，第二版）**：诊断完成时的盘上版本是 **`9b9a5af8`**（2353947 字节，mtime 16:39:19）——它在我定稿的 `cf839ed6` 之上叠了**外部会话两批功能改动**：① 16:25 的 `AGENT_RUN_MAX_STEPS` 12→0；② 16:39 的 Agent 运行卡状态 UI（`agentRunSetStatus` / `agentRunRound`，+17/-2 行）。两批都在 Agent SSE 运行卡路径，**与 zoom / render / cull / 流式任何性能路径无关**；上面的缩放诊断就是在 `9b9a5af8` 上跑的，结论不受影响。
- **归属说明（第一批）**：`static/js/smart-canvas.js` 里另有一处**不是本次性能工作的改动** —— 16:25 由外部会话把 `AGENT_RUN_MAX_STEPS` 从 12 改成 0（注释写「0 = 不限步数」），共 +2/-1 行。它只影响 Agent SSE 的 max_steps 字段，不在拖拽/缩放/流式/render 路径上。所以：定稿 sha `cf839ed6`（我的性能改动）→ 当前盘上 sha `576639e8`（= 我的改动 + 那 2 行）。两边跑出来的性能数字应当一致（perf-lab 已用 cf839ed6 出过数）。
- 测试基线：本轮我跑的是 **135/135**；之后外部会话新增了一个测试文件，当前盘上为 **136/136**（无失败项）。
- 未改动：`static/js/smart-canvas.js` 里既有的 LOD（`lod-far/lod-tiny`）、`nv-offscreen` 收起、渲染复用（`__renderKey`）、撤销栈结构共享 —— 这些是之前就有的优化，我这次只在其上补漏。