# NOVAI 架构审计报告（PHASE 0 · 只读）

> 审计对象：`/Users/wepingli/Desktop/NOVAI-test/main.py`（测试版副本，19,914 行 / 916 KB，单文件 FastAPI 后端）
> 审计日期：2026-08-11 ｜ 方式：静态代码分析（只读，未修改任何文件）
> 配套前端：`static/`（原生 HTML/JS，canvas.js ~14,800 行、smart-canvas.js ~18,092 行）

---

## 1. 架构总览

```
┌────────────────────────────── 前端（原生 HTML/JS，无框架）──────────────────────────────┐
│ index.html（外壳） ──iframe──▶ home / canvas / smart-canvas / online / gpt-chat /        │
│                                canvas-list / api-settings / asset-manager / ...          │
│ 页面间通信：postMessage；UI 状态：localStorage（主题/排序/最近设置/提示词预设等）           │
└──────────────┬───────────────────────────────────────────────────────────────────────────┘
               │ HTTP (fetch)  +  WebSocket /ws/stats（在线数/新图/画布更新/资产库更新/cloud_status）
┌──────────────▼──────────────────────── main.py（单文件 19,914 行）───────────────────────┐
│ ① 启动区 L1-330    全局配置/目录/锁/ConnectionManager/WS 端点/Provider 默认值             │
│ ② 配置与更新 L331-2600   api_providers.json 读写、API/.env 加载、自更新/回滚/备份          │
│ ③ Provider 基础层 L2600-5700   get_api_provider、鉴权头、chat 解析、codex/gemini-cli       │
│ ④ 即梦 CLI 层 L5403-8100      登录/生图/视频/查询媒体（subprocess + --poll 同步等待）      │
│ ⑤ 火山/APIMart/上传层 L7835-10630  SignV4、素材上传、图床/APIMart 中转、模型注册表         │
│ ⑥ 生图分发 L10632-11095   generate_ai_image()：按 provider 类型分支到各平台实现           │
│ ⑦ 静态文件/上传 L11095-12060   /、/api/view、upload、local-assets、comfyui 上传           │
│ ⑧ 平台集成 L12060-12698   RunningHub 工作流 CRUD、jimeng/codex/gemini 状态与登录          │
│ ⑨ 配置 API L12698-13697   providers CRUD、models、test-connection、storage 设置           │
│ ⑩ 在线生图 L13697-14018   online-image（同步 gather）、image-task-query、canvas 任务      │
│ ⑪ 视频/画布 L14019-15239   canvas-video 多平台分发、canvas-llm、conversations             │
│ ⑫ 画布/资产 L15239-16525   canvases CRUD(乐观锁)、workflow 导入导出、asset/prompt 库      │
│ ⑬ 对话/Agent L16525-16891  /api/chat、/api/chat/agent（意图路由）、/api/chat/stream(SSE)  │
│ ⑭ 历史/ComfyUI L16891-18165  history、/api/generate（ComfyUI 同步轮询）、workflows CRUD  │
│ ⑮ 存储/时间线 L18165-19914  storage 配置、minimax 时间线、Midjourney、native-save         │
└───────────────────────────────────────────────────────────────────────────────────────────┘
数据层：data/*.json（画布/对话/Provider/资产库/提示词库/项目）+ history.json + output/ + assets/
        （无数据库；threading.Lock 串行化 JSON 读写）
```

**核心结论**：这是一个"路由即应用"的巨型单体。185 个路由（184 HTTP + 1 WebSocket）全部挂在同一个 `app` 上，约 1,016 个函数/类。Provider 通过"配置字典 + 路由内 if/elif 分发"实现，没有独立 Service 层。任务执行以**请求内同步等待**为主，辅以少量内存态异步任务（`CANVAS_TASKS`），**不存在 Task Engine**。

---

## 2. 路由分组清单（共 185 个：184 HTTP + 1 WebSocket）

| # | 分组 | 路由数 | 行号区间 | 代表端点 |
|---|------|-------|---------|---------|
| 1 | WebSocket / 统计 | 1 | 232-244 | `/ws/stats`（在线数、新图、画布更新推送） |
| 2 | 应用信息 / 自更新 / 回滚 | 9 | 1484-2605 | `/api/app-info` 1847、`/api/check-update` 2000、`/api/update-from-github` 2425、`/api/update-backups` 2596、`/api/update-rollback` 2605 |
| 3 | 媒体代理 / 静态 / 上传 | 6 | 6480-11405 | `/api/media-preview` 6480、`/api/image-jpeg` 6517、`/` 11140、`/api/view` 11144、`/api/upload` 11215、`/api/ai/upload` 11243、`/api/video/blur-faces` 11291 |
| 4 | 本地素材 / 云视频上传 | 9 | 11709-12060 | `/api/local-assets/*`（upload/import-urls/folders/items/caption/classify）、`/api/temp-sh/upload` 12040、`/api/cloud-video/upload` 12045 |
| 5 | RunningHub 集成 | 11 | 12060-12391 | `/api/runninghub/submit` 12083、`workflow-submit` 12114、`workflows` CRUD 12182-12295、`query` 12310、`upload-asset` 12349 |
| 6 | CLI 平台状态（Codex/Gemini/即梦） | 9 | 12391-12698 | `/api/codex/status` 12391、`/api/gemini-cli/status` 12460、`/api/jimeng/status|credit|login|query-media` 12527-12679 |
| 7 | Provider / 配置管理 | 13 | 12698-13697 | `/api/config` 12698、`/api/providers` GET/PUT 12720-12724、`test-connection` 13227、`probe-async` 13340、`fetch-models` 13616-13623、storage/output-dir/classification-prompt |
| 8 | 在线生图 / 任务 | 8 | 13697-14018 | `/api/online-image` 13697、`/api/image-task-query` 13701、`/api/canvas-image-tasks` POST/GET 13870-13888、`/api/canvas-comfy-tasks` 13923-13940、`/api/image-params` 14001 |
| 9 | 视频生成 | 1（核心） | 14615-15146 | `/api/canvas-video` 14615（分发到即梦/RunningHub/APIMart/火山/玉玉/灵境/Agnes） |
| 10 | 画布 LLM / 会话 | 4 | 15146-15264 | `/api/canvas-llm` 15146、`/api/conversations` CRUD 15239-15254 |
| 11 | 画布 / 项目 CRUD | 14 | 15264-15385, 16475-16525 | `/api/canvases` 15328、`meta` 15332-15343、`PUT/DELETE/restore/purge` 16475-16525、`/api/projects` 15273-15295、`/api/canvases/trash` 15324 |
| 12 | 画布资产 / 工作流导入导出 | 6 | 15379-15671 | `/api/canvas-assets/check|download` 15395-15408、`/api/canvas-workflows/export|import|export-to-library` 15545-15671 |
| 13 | 资产库 / 提示词库 / 共享目录 | 24 | 15719-16475 | `/api/asset-library/*`（libraries/categories/items/batch/classify/avatar）、`/api/prompt-libraries/*`、`/api/shared-folders/*` |
| 14 | 对话 / Agent / SSE | 3 | 16525-16891 | `/api/chat` 16525、`/api/chat/agent` 16655、`/api/chat/stream` 16741（SSE） |
| 15 | 历史 / 队列状态 / 角度 | 4 | 16891-17130 | `/api/history` 16891、`/api/queue_status` 16914、`/api/angle/generate|poll_status` 16965-17036 |
| 16 | 生成（ComfyUI / MS） | 3 | 17130-17325 | `/generate` 17130（旧）、`/api/ms/generate` 17219、`/api/generate` 17325（同步轮询 ComfyUI） |
| 17 | ComfyUI 工作流管理 | 10 | 17985-18165 | `/api/comfyui/instances` 17985-17989、`/api/workflows` CRUD 18025-18181（含 run 18123） |
| 18 | 存储配置 / 时间线 / Midjourney / 原生保存 | 9 | 18181-19914 | `/api/config/storage` 18181、`/api/storage-files/*` 19032-19087、`/api/smart-canvas/minimax-export` 19187、`/api/midjourney/*` 19435-19533、`/api/native-save` 19874 |

---

## 3. Provider 层设计与调用链

### 3.1 Provider 注册表（配置驱动）

- **存储**：`data/api_providers.json`（当前 3 个：modelscope / runninghub / volcengine）+ 内置默认值 `default_api_providers()`（L814，仅 3 个强保留平台；`comfly`/OpenAI 兼容为兜底默认，代码中大量默认 `provider_id="comfly"`）。
- **加载**：`load_api_providers()` L1340 → `merge_default_api_providers()` L871（注入缺失默认项）；`get_api_provider()` L1408 按 id 查；`get_api_provider_exact()` L1421。
- **密钥**：`API/.env`（`API_ENV_FILE` L293，启动时 `load_env_file` 注入 `os.environ`）+ 各平台环境变量（`COMFLY_API_KEY`、`MODELSCOPE_API_KEY`、`ARK_API_KEY`、`RUNNINGHUB_API_KEY` 等，映射见 L734-744）；`provider_env_key_value()` 按 provider id 取键。
- **Provider 判别**：全靠 `is_xxx_provider(provider)` 判定函数（如 `is_volcengine_provider` L4519、`is_jimeng_provider`、`is_apimart_provider`、`is_agnes_provider` 等），依据 provider dict 中的 `id`/`protocol`/`kind`/`base_url` 特征。

### 3.2 图片生成调用链

```
前端 POST /api/online-image (L13697)
  └─ build_online_image_result (L13638)：asyncio.gather 并发 n 张
       └─ generate_ai_image (L10632) ★ 唯一图片分发入口
            ├─ modelscope        → generate_modelscope_provider_image (L9372)
            ├─ codex (CLI)       → generate_codex_provider_image
            ├─ gemini-cli (CLI)  → generate_gemini_cli_provider_image
            ├─ jimeng (CLI)      → generate_jimeng_provider_image（subprocess + --poll 同步等）
            ├─ runninghub        → generate_runninghub_provider_image（异步提交 → 前端轮询 image-task-query）
            ├─ protocol=gemini   → generate_gemini_provider_image
            ├─ volcengine        → generate_volcengine_provider_image
            └─ 默认 OpenAI 兼容 → /v1/images/generations 或 /v1/images/edits（按 image_request_mode：
                 openai / openai-json / openai-responses / openai-video-proxy 四种子模式）
       → save_ai_image_to_output (L8960) 落盘 output/ → save_to_history (L3312) → WS broadcast_new_image
画布内生成：POST /api/canvas-image-tasks (L13870) → asyncio.create_task(run_canvas_image_task)（内存任务）
ComfyUI：   POST /api/canvas-comfy-tasks (L13923) → run_canvas_comfy_task → asyncio.to_thread(generate)
```

### 3.3 视频生成调用链

```
POST /api/canvas-video (L14615) ★ 唯一视频分发入口
  ├─ jimeng     → generate_jimeng_video (L6147)：subprocess CLI（multimodal2video/frames2video/... + --poll 同步等待）
  ├─ runninghub → generate_runninghub_video (L10570)
  ├─ agnes      → generate_agnes_video (L14321)
  ├─ lingjing   → generate_lingjing_openai_video
  ├─ yuli(veo)  → generate_yuli_openai_video
  └─ 默认(APIMart/火山/OpenAI 兼容) → 提交后循环轮询（asyncio.sleep + 状态检查，VIDEO_POLL_TIMEOUT）
```

### 3.4 对话调用链

```
/api/chat (L16525) ── resolve_chat_provider (L3797) 解析 base_url/headers/model
  ├─ codex (CLI)      → codex_chat_text (L5054)
  ├─ gemini-cli (CLI) → gemini_cli_chat_text (L5346)
  ├─ modelscope       → 特判
  └─ 默认             → httpx POST {base}/chat/completions（多模态格式转换：图片→URL/dataURL）
/api/chat/stream (L16741) → SSE（StreamingResponse, text/event-stream；codex/gemini 为整段后发，非 token 级流式）
/api/chat/agent (L16655) → decide_chat_agent_action (L10977)：LLM 意图路由（JSON：chat/generate_image/edit_image）+ heuristic 兜底
/api/canvas-llm (L15146) → 纯文本直通（画布内对话助手，无工具调用）
```

### 3.5 Provider 层关键特征

- ✅ 分发入口统一（图片/视频/对话各一个）；❌ 但**分发逻辑在路由/业务函数内部**（if/elif 链），无独立 Service/Adapter 类，新增平台需改 4-6 处（判别函数、分发点、默认值、表单 schema、模型注册表）。
- Provider 配置（models/endpoint/protocol）**数据化**在 `api_providers.json`，这是一大优势：新增 OpenAI 兼容平台基本零代码。
- 特化平台（即梦 CLI、Codex CLI、Gemini CLI）走 **subprocess**，与 HTTP Provider 完全不同的执行模型。

---

## 4. 任务执行现状（无 Task Engine）

| 机制 | 现状 | 证据 |
|------|------|------|
| 同步请求内执行 | **主流**：生图/视频/对话全部在 HTTP 请求内完成，最长 read timeout 1800s（生图）/轮询到完成 | generate_ai_image L10664；canvas_video L14678；/api/generate L17420-17428 轮询 ComfyUI history |
| 异步内存任务 | `CANVAS_TASKS`（内存 dict + CANVAS_TASK_LOCK）：status ∈ queued/running/succeeded/failed，`asyncio.create_task` 即发即弃 | L13870-13946 |
| 任务队列 | **无真实队列**。`QUEUE`（L328）只是显示用列表（`/api/queue_status` L16914 报位置），无 worker、无调度、无并发上限 | L17330-17334 append / L17541 remove |
| 重试 | 仅传输层：`httpx_request_with_transient_retries`（502/503/504/520/522/524，2 次，L6305）；APIMart 上传 TLS 瞬时错误重试（L8467）。**业务生成 5xx 刻意不重试**（防重复扣费，L4341、L4415 注释） | L6305-6321 |
| 状态机 | 仅任务 status 枚举（queued/running/succeeded/failed），无状态机框架、无证据链、无中间事件 | L13874-13884 |
| 进度推送 | 画布任务**无 WS 进度推送**，前端轮询 GET `/api/canvas-image-tasks/{id}`；RunningHub/角度任务完成后通过 `send_personal_message` 推 cloud_status | L17012-17119 |
| 任务持久化 | ❌ 内存态，服务重启即丢（404 提示"任务已过期"） | L13893 |

**结论**：`CANVAS_TASKS` 是 Task Engine 的雏形（已具备 task_id/status/timestamps/result/error 字段），但缺：持久化、worker 池、重试策略、队列、并发限制、事件/证据链、取消/超时治理。

---

## 5. 数据持久化现状

### 5.1 data/ 目录结构（无数据库，纯 JSON + threading.Lock）

| 文件/目录 | 内容 | 读写方式 |
|-----------|------|---------|
| `data/canvases/{id}.json` | 每画布一文件（当前 11 个） | `save_canvas` L3409（CANVAS_LOCK 全量覆写）；乐观锁 409（base_updated_at）L16479 |
| `data/conversations/{user}/{id}.json` | 每对话一文件（按 user_id 分目录） | `save_conversation` L3356（CONVERSATION_LOCK） |
| `data/api_providers.json` | Provider 注册表（3 个） | `load/save_api_providers` L1340/1353 |
| `data/asset_library.json` | 资产库索引 | 资产库 API L15719+（GLOBAL_CONFIG_LOCK 等） |
| `data/prompt_libraries.json` | 提示词库 | L15723+ |
| `data/projects.json` | 项目（默认项目 + 自定义） | L3422/3433 |
| `data/media_previews/` | 视频/媒体预览缩略图（73 个） | 生成时落盘 |
| `data/settings.json` | 输出目录等设置 | L295 |
| `history.json`（data 根） | 生成历史记录 | `save_to_history` L3312（HISTORY_LOCK） |
| `output/`、`assets/` | 生成结果、素材（library/uploads/input） | 文件系统 |
| `workflows/*.json` + `*.config.json` | ComfyUI 工作流（内置 + custom/ 自定义） | L18025-18121 |
| `~/.NOVAI/config.json`（或 NOVAI_DATA_DIR） | storage_path 等全局配置 | L18168-18179 |

### 5.2 画布数据模型（关键）

```json
画布 canvas: { id, title, icon, kind: "classic"|"smart", owner, color, pinned, project,
               created_at, updated_at, nodes[], connections[], viewport{x,y,scale},
               board_x, board_y, logs[], settings{} }
节点 node:   { id, type("smart-image"…), x, y, title, images[], created_at, scale,
               runSettings{…}, promptDraftHtml, promptDraftText,
               running, pending, queued, runStartedAt, runFinishedAt, runElapsedMs, runTimerHidden, w, h }
连线 connection: { from, to, kind: "input" }
```

### 5.3 数据模型现状要点

- **Asset = 字符串 URL**：节点 `images[]` 只存本地 URL（`/output/...`），无对象化元数据（无宽高/来源/参数/关系）；资产库索引才有结构化条目。
- **Workflow 无版本**：`workflows/*.json` 原地覆写（PUT config 亦然），无历史、无回滚；画布内节点 runSettings 是"节点级参数快照"，与工作流文件无绑定关系。
- **画布版本**：仅乐观锁（409）防并发覆盖，**无版本历史/回滚**；`logs` 仅保留最近 500 条（L16494）。
- **删除**：画布软删除（deleted_at）+ 30 天保留 + purge（L323, L16500-16525）；资产库批量删除有 `deleted` 标记逻辑。
- 无外键/引用完整性：画布引用的素材删除后成为死链；无迁移框架（启动时只有几个一次性"迁移"函数：资产库分组、双扩展名、错误扩展名修复 L217-230）。

---

## 6. WebSocket 与推送

- **唯一 WS 端点**：`/ws/stats?client_id=...`（L232），`ConnectionManager`（L105-188）维护 active_connections + user_connections（按 client_id 单连接）。
- **推送消息类型**：`stats`（在线数）、`new_image`（生成完成广播）、`canvas_updated`（画布保存后广播，带 client_id 溯源）、`asset_library_updated`、`cloud_status`（RunningHub/角度任务完成，点对点）、pong。
- **线程安全**：生成任务在线程/子协程完成时用 `asyncio.run_coroutine_threadsafe(..., GLOBAL_LOOP)` 投递（L7101、L13694 等多处）。
- **缺口**：无任务进度百分比/阶段推送；画布节点运行状态（running/pending/queued）是**前端本地状态**，不持久化、不跨端同步；WS 断线无重连补偿（无事件回放）。

---

## 7. 配置管理

| 层次 | 载体 | 说明 |
|------|------|------|
| 环境变量 | `API/.env`（启动 load_env_file 注入 os.environ）+ 系统 env | API Key、NOVAI_DATA_DIR、NOVAI_APP_DIR、NOVAI_USE_PROXY、DEPLOY_RUN_PORT、LOCAL_IMAGE_IMPORT_MAX_BYTES 等 |
| Provider 配置 | `data/api_providers.json` | base_url/protocol/models/endpoints/enabled/密钥名映射；`/api/providers` PUT 保存后同步回环境变量（L1473-1480） |
| 应用配置 | `~/.NOVAI/config.json` | storage_path、output_dir（另有 data/settings.json 一份输出目录） |
| 代码常量 | main.py 顶部 + `global_config.json` | 超时/模型默认值/URL 常量散落各处 |

⚠️ 配置读取分散：同一概念（输出目录）在 settings.json 与 config.json 两处；启动时 `_DATA_ROOT` 与运行时 `config.json` 的 storage_path 相互覆盖逻辑复杂（L262-313）。

---

## 8. 与 V2 目标差距表

| V2 目标 | 现状 | 证据（行号） | 差距等级 |
|---------|------|-------------|---------|
| **Task Engine**（任务状态/证据链/队列/重试） | 内存 CANVAS_TASKS 雏形：id/status(4态)/result/error/时间戳；无持久化、无 worker、无队列、无重试、无证据链、无取消 | L13870-13946；QUEUE 仅展示 L328/L16914 | 🔴 没有（有雏形） |
| **Workflow 版本化/回滚** | ComfyUI 工作流 JSON 原地覆写；仅画布保存有乐观锁；应用代码有 update-rollback（与工作流无关） | L18075-18121；L16479 | 🔴 没有 |
| **Asset 对象化**（元数据/关系/血缘） | 节点 images[] 是 URL 字符串；资产库索引有结构化条目但无血缘/参数链 | 节点模型 L3485-3499 + 样例数据 | 🟡 部分（资产库有元数据，画布节点无） |
| **Matrix 批量生成** | 仅"n 张并发"（asyncio.gather ≤8）与提示词拆分（chat_split_parallel_prompts）；无参数矩阵/组合爆炸/结果网格 | L13644-13660；L16698 | 🟡 部分（并发 N 份，非矩阵） |
| **Agent / Planner** | /api/chat/agent 单步意图路由（chat/generate_image/edit_image 三选一）+ 启发式兜底；无多步规划、无工具循环、无任务图；画布助手=纯文本直通 | L10977-11032；L15146 | 🟡 部分（单步路由，非 Planner） |
| 任务进度推送（WS） | 只有 new_image/canvas_updated/cloud_status；画布任务靠前端轮询 | L146-188；L13888 | 🟡 部分 |
| 统一 Provider 抽象 | 3 注册表平台 + CLI 平台 + 特征判别函数；分发入口统一但实现散落在业务函数 | L814-940；L10632；L14616 | 🟡 部分 |
| 数据可迁移/有 schema | 无 DB、无 schema 版本、无迁移框架；JSON 全量覆写 | L3356-3522 | 🔴 没有 |

---

## 9. 关键风险

1. **单文件巨型后端拆分难度高**：19,914 行 / 1,016 个函数，模块间通过模块级全局变量（provider 缓存、锁、QUEUE、CANVAS_TASKS、GLOBAL_LOOP、各 *_LOCK）与函数互调耦合。拆分需先建立"全局状态清单 + 调用图"，否则拆包即断。建议按 5.1 的分层（配置→Provider 基础→各平台实现→业务路由→任务层）渐进拆分，每个 Provider 平台（volcengine/jimeng/runninghub/apimart/modelscope/cli）是天然的独立模块边界。
2. **Provider 逻辑与路由强耦合**：分发 if/elif 链嵌在业务函数内，新增平台需改动多处；`is_xxx_provider` 靠字符串/URL 特征嗅探，脆弱且不可测试。V2 的 Provider 接口化是最高杠杆重构。
3. **任务系统缺失导致体验与成本问题**：无持久化任务 = 重启丢任务；无重试策略（生成 5xx 不重试防扣费是合理但粗糙的取舍）；无并发限制，canvas 任务可无限并发打爆上游；无超时治理。
4. **数据迁移成本**：画布节点/连线/日志为无 schema JSON，历史数据无版本标记；Asset URL 字符串→对象化需全量扫描 `images[]`、`asset_library.json`、`history.json`、conversation attachments 四处；建议写一次性迁移脚本并在新模型里保留旧字段兼容（现有代码已有先例：启动迁移函数 L217-230）。
5. **前端状态与服务端数据脱节**：画布节点运行状态（running/pending/queued/runElapsedMs）只存在于前端 localStorage/内存；`save_canvas` 全量覆写 + 乐观锁只能防"同页面并发"，无法防"旧客户端覆盖新字段"。V2 需定义服务端权威的节点任务状态。
6. **数据一致性**：JSON 全量覆写无事务；进程崩溃可能写坏文件（无原子写/备份）；跨文件引用（画布→素材、对话→图片）无完整性约束。
7. **同步长请求**：视频/生图最长 read timeout 1800s，HTTP 层长连接占用 worker；V2 任务引擎 + WS 推送可根治。
8. **配置三处分散**（.env / api_providers.json / config.json+settings.json），输出目录存在双写，迁移到统一配置模块有兼容成本。

---

## 10. 附录：统计数字

- main.py：19,914 行 / 916 KB；路由 185（184 HTTP + 1 WS）；函数/类定义 1,016
- Provider 类型（判别函数覆盖）：OpenAI 兼容(comfly 默认)、ModelScope、RunningHub、火山引擎、即梦 CLI、Codex CLI、Gemini CLI（+ APIMart/玉玉/灵境/Agnes 为 OpenAI 兼容上的特征平台）
- 注册表内置默认：3（modelscope/runninghub/volcengine）
- 数据文件：data/canvases 11、conversations 若干、media_previews 73、api_providers 3、asset_library 1、prompt_libraries 1、projects 1
- 前端：canvas.js ~14,800 行、smart-canvas.js ~18,092 行（双画布并行维护，均为前端状态驱动）
