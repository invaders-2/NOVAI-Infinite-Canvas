# NOVAI 前端代码审计报告（PHASE 0，只读）

> 审计对象：`/Users/wepingli/Desktop/NOVAI-test`（测试版，端口 3001，变体 C 原生版）
> 审计时间：2026-08-11 ｜ 审计方式：静态代码阅读（未改动任何文件）
> 用途：V2 升级规划（Workflow 版本化 UI / Task Manager UI / Outputs 页面）的前端基线
> 关键文件规模：`static/js/smart-canvas.js` **18,092 行（915KB）**；`static/js/canvas.js` 16,742 行；`main.py` 19,914 行（后端单文件）；`static/index.html` 5,272 行

---

## 1. 前端架构总览

```
index.html  (AI Studio 壳：侧边栏 + 设置弹窗 + 舞台区，5272 行)
│   所有 iframe 预先创建（3268-3278 行），data-src 懒加载，switchUI() 切换
│   localStorage 'studio_active_page' 记忆上次页面（3924 行）
│   消息总线：
│     ├─ postMessage  → 子页导航 navigate / open-canvas / canvas-focus / studio-theme / studio-lang
│     ├─ BroadcastChannel 'studio-api'（3976 行）→ providers/workflows/comfy 变更广播
│     └─ localStorage 共享键（studio_theme、client_id、active_page …）
│
├─ frame-home          → home.html            首页（官网深色科技风复刻）
├─ frame-zimage        → zimage.html          Flux Modern Gallery 统一控制台（DEFAULT_PAGE_ID）
├─ frame-enhance       → enhance.html         Z-IMAGE 增强
├─ frame-klein         → klein.html           Flux Klein
├─ frame-angle         → angle.html           3D 视角重塑
├─ frame-online        → online.html          在线生图
├─ frame-gpt-chat      → gpt-chat.html        GPT 对话（独立聊天页，含会话持久化）
├─ frame-canvas        → canvas-list.html     画布工作台（项目网格 + 回收站）
│                          └─ 二级 iframe 加载 canvas.html（传统画布）/ smart-canvas.html（智能画布）
├─ frame-asset-manager → asset-manager.html   素材库管理（6 个 tab）
├─ frame-api-settings  → api-settings.html    API 设置
└─ frame-comfyui-settings → comfyui-settings.html  工作流设置
```

**关键架构事实**

- **iframe 路由**：`switchUI(el, id)`（index.html:3900）切换 iframe `active` class；`PAGE_IDS`（3830 行）白名单路由；子页面通过 `parent.postMessage({type:'navigate', route, canvasId})` 请求导航（3955 行），壳页面转发 `open-canvas` 给目标 iframe（3964 行）。
- **无前端框架**：全部原生 HTML/CSS/JS；Tailwind CDN + Lucide 图标 + Three.js；每个子页面是**独立完整文档**（自带 `<script>` 与 CSS），跨页共享仅 `static/js/shared/{utils,media,viewport}.js`（NovaUtils / NovaMedia，挂 window）+ `i18n.js` + `theme.js`。
- **两套画布代码基完全独立**：`smart-canvas.js/.html/.css`（智能画布）与 `canvas.js/.html/.css`（传统画布）互不加载对方，共享的只有 `shared/media.js`；同一功能（视频控制、@引用、canvas_meta）需双份实现——已多次踩坑（见风险）。
- **页面间数据同步三通道**：localStorage（简单键）、postMessage（父子 iframe）、BroadcastChannel（同源跨 iframe）+ 后端 WebSocket `/ws/stats`（仅顶层页面直连）。
- **画布页面是 iframe 套 iframe**：index → canvas-list → (canvas.html | smart-canvas.html)，三层文档，事件与状态桥接成本高。

### 页面清单（14 个子页 + 壳）

| 页面 | 标题 | 职责 | 关键 JS |
|---|---|---|---|
| index.html | AI Studio | 壳：侧边栏导航/设置弹窗/iframe 舞台/版本更新 | 内联（5272 行） |
| home.html | NOVAI - 首页 | 官网风落地页、引擎墙、最近画布、模板中心（hidden） | 内联 |
| canvas-list.html | 画布工作台 | 项目/画布网格、回收站、新建（普通/智能） | canvas-list.js（1094 行） |
| canvas.html | 无限画布 | 传统画布：image/llm/generator/output 四类节点 | canvas.js（16,742 行） |
| smart-canvas.html | （无 title 标签） | 智能画布：smart-image/prompt/loop/group 节点 + 对话助手 | smart-canvas.js（18,092 行） |
| online.html | 在线生图 | 单张生图页 | 内联 |
| gpt-chat.html | GPT 对话 | 独立对话页（/api/chat、会话持久化、附件） | 内联 |
| asset-manager.html | 素材库管理 | 资产/工作流/提示词/画布资产/共享文件夹/本地素材 6 tab | asset-manager.js（4,766 行） |
| api-settings.html | API 设置 | 多 provider 管理 | api-settings.js（4,106 行） |
| comfyui-settings.html | 工作流设置 | ComfyUI 实例与工作流 | comfyui-settings.js（1,415 行） |
| enhance.html | Z-IMAGE 增强 | 图生图增强 | 内联 |
| zimage.html | Flux Modern Gallery | 统一生图控制台（默认首页） | 内联 |
| klein.html | Flux Klein | 极简终端 | 内联 |
| angle.html | 3D 视角重塑 | 角度生成 | 内联 |

---

## 2. smart-canvas.js 组织与状态管理（18,092 行单文件 IIFE）

### 2.1 文件结构（按行号定位）

| 区间 | 内容 |
|---|---|
| 1-172 | IIFE 头部 + **全部模块级状态**（nodes/selectedId/viewport/settings/undoStack…） |
| 173-240 | 级联运行状态（smartCascadeRuns Map）+ 撤销栈（snapshotForUndo 206 / pushUndo 215 / performUndo 221，UNDO_LIMIT=40） |
| 393-560 | NovaMedia/NovaUtils 双实现兜底（`window.X ?? _localX` 模式）+ 视频播放器 |
| 843-1130 | 设置序列化（settingsForStorage 850 / canvasForStorage 901）+ 工作流导出导入（exportSelectedSmartWorkflow 1034 / importSmartWorkflowFile 1108） |
| 1191-1360 | 节点类型判定（isSmartImageNode 1192 / isSmartGroupNode 1195）+ **normalizeLegacySmartNode 1216**（数据迁移） |
| 1440-1700 | 选择状态（selectedNode 1440 / syncSelectionUi 1455）+ 分组系统 |
| 1825-2250 | 布局计算（imageLayout 2059 / nodeRect 2140）+ 自动排列 |
| 2251-2478 | **视口系统**：viewport{x,y,scale}、applyViewport 2251、screenToWorld 2268、minimap、缩放条 |
| 2479-3650 | 引擎/模型/参数渲染（provider、comfy、runninghub、modelscope、火山） |
| 3696-4510 | 资产库 UI、提示词预设/模板库（localStorage） |
| 4521-4765 | **chatModal 对话助手**（详见 §4） |
| 4766-5570 | 提示词模板组、系统提示词同步（/api/chat 后端共享） |
| 5574-5900 | **多人协作同步**：smartClientId、applyMergedServerCanvas 5780、handleCanvasUpdatedMessage 5829、startCanvasMetaPoll 5838、connectAssetLibrarySyncSocket 5863（WS /ws/stats） |
| 6379-6508 | **loadCanvas 6379 / scheduleSave 6430 / saveCanvas 6434 / createNode 6497** |
| 6509-6630 | createPromptNode / createLoopNode / createSmartGroupNode / cloneSmartNode |
| 7514-8100 | 运行日志面板（renderSmartCanvasLog）、节点 HTML 生成 |
| 8104-8190 | **render() 全量重渲染**（DOM 重建 + 媒体元素移植 + 事件重绑） |
| 8769+ | bindNodeEvents（节点交互/拖动/端口） |
| 12065-12640 | composer 状态同步（updateComposer）、appendImagesToSmartNode 12635 |
| 13377-13460 | collectPromptParts / buildPromptRequest（@ token → refs 组装） |
| 13830-14165 | 循环输出槽、**M1 canvas_meta 自动落位**（afterVideoAutoPlace 14068 / autoPlaceGeneratedNode 14080）、M2 建议条（fetchSmartSuggestions 14008 / runSuggestionAction 14045） |
| 14688-15673 | 任务轮询（waitSmartComfyTaskResult 14688）、runGeneration 15329、runApiVideoGeneration 15611 |
| 18018-18037 | postMessage 监听（theme/providers/asset_library_updated/canvas_updated/studio-lang） |
| 18038-18092 | window.onload 启动序列 + window.* 导出清单 |

### 2.2 状态管理方式（无框架，纯模块级变量 + 全量重渲染）

- **单一可变状态池**：所有状态是 IIFE 内 `let` 变量（nodes[] 86 行、selectedId/selectedIds/selectedImage 87-89、viewport、settings、canvas、assetLibrary…），无 store、无订阅机制、无响应式。
- **渲染 = 全量重建**：`render()`（8104）遍历 nodes → 生成 HTML 字符串 → 一次性插入 `#world` → 重绑事件（bindNodeEvents 8769）→ 重绘连线/小地图。唯一的性能优化是 `reusableNodes`（8111）：有 live 媒体（播放中的视频）的节点 DOM 复用移植（transplantSmartMediaElements 8174），避免播放中断。
- **持久化 = 防抖全量 PUT**：`scheduleSave()`（6430，450ms 防抖）→ `saveCanvas()`（6434）PUT `/api/canvases/{id}`，body 为 `{title, icon, nodes, connections, viewport, logs, settings, base_updated_at, client_id}`；`base_updated_at` 是乐观锁——服务端 409 时（main.py:16475 起）返回服务端画布，前端 `applyMergedServerCanvas`（5780）做**节点 id 合并 + 图片并集**后重存（6465-6482）。
- **多端同步**：后端 PUT 后广播 `canvas_updated`（main.py `manager.broadcast_canvas_updated`）；前端三层兜底——① WS `/ws/stats`（**仅顶层窗口连接**，smart-canvas.js:5864 `if(window.parent && window.parent !== window) return`，iframe 内不连 WS）；② postMessage `canvas_updated` 转发；③ 8 秒轮询 `GET /api/canvases/{id}/meta`（5838-5856）比对 updated_at 触发合并重载。拖拽/框选期间跳过合并（5813-5817），自己发起的更新忽略（5832）。
- **撤销/重做**：JSON 深拷贝快照（nodes+connections+selection），内存 40 步，**不持久化**。
- **localStorage 键散落**：prompt presets/template groups/overrides（126-128 行）、最近设置（RECENT_SMART_SETTINGS_KEY）、active_page 等，无统一封装。

---

## 3. 节点数据模型（带代码位置）

### 3.1 智能画布节点（smart-canvas.js）

**节点类型**：`smart-image`（默认/图片视频音频节点）、`smart-prompt`（提示词）、`smart-loop`（循环）、`smart-group`（分组容器）；旧版 `smart-container` 由 `normalizeLegacySmartNode`（1216-1240）迁移为 smart-image。`storyboard` 只是 slash 菜单模板分类（4457 行），不是节点类型。

**smart-image 节点字段**（createNode 6500 行创建 + 真实持久化 JSON 实测）：

```js
{
  id: 'n_xxx'（uid('smart')）, type:'smart-image',
  x, y,                       // 世界坐标
  title, images: [],          // 媒体数组（见下）
  created_at, scale, w, h,    // 布局（w/h 仅 resize/输出槽时存在）
  // —— 业务快照（节点=可复现生成单元的关键）——
  runSettings: {…},           // 完整生成参数快照：engine/apiKind/provider_id/model/ratio/
                              //   resolution/custom*、video* 系列、ms*、comfy*、rh*、enhance*（实测 ~60 键）
  promptDraftHtml, promptDraftText,   // composer 草稿
  inputNodeIds: [],           // 输入类连线的上游节点 id（12951 行维护）
  // —— 运行状态（易失，加载时恢复/清理）——
  pending, running, queued,
  runStartedAt, runFinishedAt, runElapsedMs, runTimerHidden,
  runPrompt, runModelPrompt, runPromptRefs, runInputRefs, runAt,   // 本次运行快照
  outputKind,                // 产物类型
  sourceNodeId, loopSourceId, loopRootId, loopRoundIndex, loopSlotIndex,  // 循环输出槽标记（13869）
  isHistoryGroup, historyFor,  // 历史分组（多次生成累积）
  jimengPending               // 即梦待查任务
}
```

**images[] 元素**（实测）：`{url:'/assets/input/…', name, kind:'video'|'image'|'audio', mime, natural_w, natural_h, preview/thumbnail, generatedResult?}`；保存前经 `mediaItemForStorage`（891）剥离瞬态字段。

**连线**：`connections: [{from, to, kind:'input'|'flow'}]`（**无 id**；传统画布 canvas.js 用 `{id, from, to}`——两套模型不兼容）。

**画布记录**（服务端 JSON 顶层，实测）：`id, title, icon, kind('smart'|classic), owner, color, pinned, project, created_at, updated_at, nodes, connections, viewport{x,y,scale}, board_x, board_y, logs[]（最多 500 条运行日志）, settings`。

### 3.2 传统画布节点（canvas.js，对比）

`image`（2704）/ `llm`（2748）/ `generator`（2767，含 `apiProvider, model, ratio, resolution, inputs:[]`）/ `output`（3411，`images:[]`）——generator.inputs[] 是显式上游 id 列表，比智能画布的 inputNodeIds 更接近“业务对象”；工作流导入导出（zip workflow.json: nodes+connections+resources）基于这套模型（main.py 15470+）。

### 3.3 canvas_meta 自动落位链路（M1）

```
后端 build_canvas_meta(urls, payload, node_type)（main.py:6379）
  → 仅接入 3 个生成分支：即梦视频 / RunningHub / 通用视频（skill 记录 ~6252/10612/14887）
  → 返回 {output_url, canvas_meta:{node_type, title(≤24字截断), media_url, auto_place:true}}
前端 runApiVideoGeneration 透传 {urls, canvas_meta}（smart-canvas.js:15673 / 14750）
  ├─ 结果节点已存在 → afterVideoAutoPlace（14068）：平移视口 + toast
  └─ 无节点上下文 → autoPlaceGeneratedNode（14080）：视口中心随机角度偏移 + 8 次碰撞检测
       → createImageNodeAt → 写 images/kind/title → 选中 → 视频探测真实比例（14123-14142）
```

**结论**：节点已具备“业务对象”雏形（runSettings 全量快照 + runPrompt + refs + logs + 可导出工作流），但**没有稳定的 config/inputs/outputs 结构、没有持久化的 task_id、没有 schema 版本字段**；canvas_meta 是补丁式链路（只覆盖视频分支，图片生成分支大多不带 meta）。

---

## 4. 画布对话助手（chatModal）能力评估

### 4.1 现状（代码位置）

- **DOM**：smart-canvas.html:582-597（header+模型下拉+消息区+输入框+引用条+缩放柄）；**JS**：4521-4765。
- **@ 引用**：选中节点自动进 `chatRefs`（syncChatContext 4587）→ 输入框 `@` 触发候选浮层（4725-4731，纯文本 `@名字` 插入，**非 token**）→ 发送时 `chatContextImages()`（4620）把引用媒体 URL 随请求发 `/api/canvas-llm`（4687，images+videos 字段）。
- **对话**：单轮——`messages:[]` 恒为空（4689 行），`chatMessages` 仅内存展示；模型可选（initChatModel 4526）；无流式、无会话持久化。
- **画布操作（唯一“Agent 能力”）**：系统提示词要求模型在回复末尾附 `{"actions":[…]}`（4682）→ 正则提取（4696）→ `executeChatActions`（4556）执行 **2 种命令**：
  - `create_node {type: image|prompt|loop, x, y}` → createPromptNode/createLoopNode/createImageNodeAt
  - `connect {from, to, kind}` → addConnection（支持 `{0}` 引用已建节点）
- **生成建议条（M2）**：生成完成后 `fetchSmartSuggestions`（14008）→ POST `/api/suggestions`（main.py:14562，复用对话模型，system 强制 JSON 数组，返回 3 条 `{label, prompt}`）→ 底部建议条（13985）→ 点击 `runSuggestionAction`（14045）用原节点 refs + 新 prompt 再次触发 `runApiVideoGeneration`（单步闭环）。

### 4.2 离 Agent/Planner 的差距

| 维度 | 现状 | Agent/Planner 要求 | 差距 |
|---|---|---|---|
| 工具调用 | 2 个命令（create_node/connect），正则解析 JSON | 工具注册表 + 结构化调用 + 参数校验 | 大 |
| 规划 | 无 | 多步计划生成、依赖排序、失败重试 | **完全缺失** |
| 上下文 | 单轮、messages 恒空；引用仅媒体 URL | 多轮记忆、画布状态快照进上下文 | 大 |
| 执行 | 只能建节点/连线，**不能触发生成、不能改参数、不能删节点** | 可执行任意画布操作并回读结果 | 大 |
| 状态追踪 | 无任务/步骤状态机 | 计划步骤状态、可中断/续跑 | **完全缺失** |
| 反馈闭环 | 无（不把生成结果回喂给模型） | 执行→观察→再规划 | **完全缺失** |
| 持久化 | 无会话存储 | 会话/计划可恢复 | 大 |

**结论**：`has_agent = false`。当前实现是“带 2 个硬编码动作的聊天窗 + 单步建议条”，没有任何 Agent 循环或 Planner 能力；升级到 Agent/Planner 需从状态层（画布快照 API）、通信层（流式/工具协议）、执行层（节点操作服务化）三处重做。

---

## 5. 资产库数据流（asset-manager）

```
asset-manager.html（6 tab）← asset-manager.js（IIFE，4,766 行）
  apiJson() 统一封装（147 行）
  loadAll()（1039）并行拉取：
    /api/asset-library          → 多库/分类/条目（items batch 上传 2261、classify 2821、
                                   move 4293、register-avatar 4194、workflows upload 2282）
    /api/prompt-libraries       → 提示词库 CRUD（4394-4558）
    /api/providers              → 引擎列表（仅用于 AI 分类/打标）
    /api/canvas-assets          → 画布资产聚合索引（main.py:3758 canvas_assets_index：
                                  遍历所有画布 JSON 提取媒体，按 kind/画布分类；
                                  下载走 /api/canvas-assets/download zip，15408）
    /api/shared-folders         → 共享文件夹（tree 631 / import 4351）
    /api/local-assets           → 本地素材（upload 2546 / caption 2704 / classify 2787 / move 2488）
```

- **智能画布侧内嵌资产库**：smart-canvas.js 自带一套资产库 UI 与状态（111-125 行），**与 asset-manager 是两套独立实现**；通过 WS `asset_library_updated`（5878-5881）+ postMessage（18022）保持刷新。
- **跨页一致性**：无共享客户端数据层，每页各自持有状态副本，靠广播“刷新信号”而不是共享 store 同步。
- **画布资产 tab 即现状最接近“Outputs 页面”的东西**：聚合所有画布的媒体 + 批量下载 zip，但只读、无预览对比、无跨画布筛选/复用/删除。

---

## 6. 与 V2 目标的差距表

| V2 目标 | 现状 | 差距 | 可行路径评估 |
|---|---|---|---|
| **Workflow 版本化 UI** | 画布是单文档 PUT 全量覆盖；乐观锁（base_updated_at）只防并发覆盖；版本概念仅存在于内存撤销栈（40 步）与一次性 zip 导入导出（exportSelectedSmartWorkflow 1034 / importSmartWorkflowFile 1108）；服务端无快照/版本表 | **大**：无版本记录、无 diff、无还原 UI、节点无 schema 版本字段 | 服务端已有 updated_at + 409 冲突基础，可在 PUT 时旁路存快照；前端需新增版本面板 + diff 视图；节点模型建议先加 `schema`/`config` 稳定字段 |
| **Task Manager UI** | **不存在**。任务状态全在节点对象内存字段（pending/running/queued）+ activeSmartTaskPolls Map（161）+ smartCascadeRuns（156）；轮询端点齐全（/api/canvas-image-tasks/{id} main.py:13889、/api/canvas-comfy-tasks/{id} 13941、queue_status），画布 logs[]（≤500 条/画布）是唯一落盘痕迹；节点无持久化 task_id | **完全缺失**：无全局队列视图、无跨画布任务历史、无批量取消/重试 UI（仅级联运行有 stop 按钮） | 后端任务数据已存在（各 task 端点 + logs），补一个聚合端点 + 独立页面可行；前端需把 task_id 持久化到节点/画布 |
| **Outputs 页面** | 部分：asset-manager「画布资产」tab（/api/canvas-assets 聚合 + zip 下载）；智能画布运行日志面板（renderSmartCanvasLog 7514，按画布）；节点内历史分组（isHistoryGroup） | **中**：无独立跨画布 Outputs 页，无预览/筛选/对比/一键回画布 | canvas_assets_index 已是现成聚合源，扩展成独立页面成本可控 |
| （基础）节点=业务对象 | 半是：runSettings 全量参数快照 + runPrompt + inputNodeIds + logs 使节点“可复现”；但无标准 config/inputs/outputs 结构、无 task_id、无 schema | 中 | 建议 V2 先行定义节点 schema，写迁移层（normalizeLegacySmartNode 已有先例） |
| （基础）对话助手→Agent | 2 命令动作解析 + 单步建议条（见 §4.2） | 大 | 需独立设计 |

---

## 7. 前端风险列表

1. **单文件巨型 IIFE（最高风险）**：smart-canvas.js 18,092 行 / 915KB、canvas.js 16,742 行——无模块边界、无 import、状态全在 IIFE 闭包、`window.*` 导出零散（18056-18091）、无任何前端测试与 lint。任何 V2 改造都会直面“改一处崩三处”的回归风险；函数间隐式依赖（如 createNode 内部已 push nodes + render + scheduleSave，外层再 push 会重复，skill 有真实踩坑记录）。
2. **双画布代码基分叉**：智能/传统两套画布独立实现，功能需双份维护（视频控制条、@引用、canvas_meta 均两处），改一处漏一处是历史事故高发区（v1.0.103→1.0.107 连修 7 版）。
3. **iframe 架构阻碍 V2 多模块扩展**：① 三层 iframe（index→canvas-list→canvas）使状态桥接脆弱；② 每页独立 JS 副本，Outputs/Assets/Tasks 若做成独立页需复制大量逻辑或强制引入共享模块（当前只有 media/utils 两个）；③ 事件/焦点/拖拽跨 iframe 丢失（已有多处 workaround：120s 轮询、sessionStorage 兜底）；④ WS 只在顶层直连，iframe 内靠轮询补位（8s meta 轮询打磁盘）。
4. **画布同步机制脆弱**：全量 PUT + 450ms 防抖，409 合并策略是“id 并集 + 图片并集”，会丢失语义级编辑（删除/移动冲突）；离线编辑无队列直接丢；`beforeunload` 主动断轮询；iframe 内无 WS 时双端并发编辑依赖 8s 轮询发现，冲突窗口长。
5. **canvas_meta 链路是补丁式**：只挂 3 个视频生成分支，图片/Comfy 分支大多无 meta → 自动落位行为不一致；title 24 字截断、node_type 仅 video/image/audio；前后端字段靠“顺手透传”，无契约。
6. **数据模型无 schema 约束**：节点自由对象，迁移靠 normalizeLegacySmartNode 逐补丁；V2 加 task_id/config/inputs/outputs 字段无校验；存量画布（含历史版本产生的脏字段）无 schema 防线。
7. **对话助手无状态且语法脆弱**：消息不持久、messages 恒空、动作靠正则抠 JSON、仅 2 命令；作为 Agent 地基需整体重写（见 §4.2）。
8. **本地状态散落 localStorage**：多页各自读写（presets/templates/theme/active_page/recent settings），已引发过“桌面端表现旧”类问题（缓存/版本号排查链，见 skill）；无统一状态层。
9. **无前端测试体系**：零单元测试、零 E2E；回归靠人工 checklist（docs/regression-checklist.md 7 组检查点）；18k 行文件连 `node --check` 都只能验语法。
10. **安全面**：子页 `parent.postMessage(..., '*')` 发送（接收端有 origin 校验但发送端不校验目标）；大量内联 `onclick` + `window.*` 全局函数；HTML 拼接普遍经 escapeHtml，但新增注入点（如建议条 label 已转义）需持续警惕。
11. **细节问题**：smart-canvas.html 缺 `<title>`（其余页都有）；默认落点 `DEFAULT_PAGE_ID='zimage'`（3830 行）而非 home；`/api/lan-info` 端口写死 3000（测试版 3001 下显示错误，后端已知 bug）。

---

## 8. 给 V2 的结论摘要

- 前端是**“功能完备但结构过时”**的原生多页 iframe 架构：画布功能深度足够（级联运行、循环、分组、@引用、任务轮询、多端合并），但**无模块化、无共享状态层、无双画布收敛、无测试**。
- V2 三目标中：**Task Manager 完全缺失**（后端任务数据已具备，缺口在前端聚合与持久化 task_id）；**Outputs 页有现成聚合源**（canvas_assets_index）成本最低；**Workflow 版本化 UI 缺口最大**（需服务端快照 + 前端版本面板 + 节点 schema 化）。
- 建议 V2 开工前先做两项地基：① 定义节点 schema（config/inputs/outputs/task_id）并写迁移层；② 建立画布状态快照 API（服务端旁路存版本），两者都可在现有 PUT/乐观锁之上增量实现，不必推翻 iframe 架构（但 Outputs/Tasks 新页建议作为 index.html 一级路由 iframe，避免再套一层）。
