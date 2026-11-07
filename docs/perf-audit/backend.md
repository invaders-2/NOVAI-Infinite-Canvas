# 后端与存储性能专项（backend-perf / task-4）

> 范围：`NOVAI-v16/main.py`（外科式改动）、`docs/perf-audit/backend.md`。**未改任何前端文件**（`static/**`、`novai-canvas-ui/**` 属 beat-perf / smart-perf）。
> 日期：2026-11-04 · 端口 3131（3000 是正式服务，3100/3101/3112/3120 被其他 agent 占用，全程未碰）· 数据目录 `/tmp/novai-perf-backend`。
> 最终数字在「机器空闲」时复测（有一次 bench 与 `node tests/run-all.js` 并发跑，PUT 被 CPU 争用抬到 73ms，已作废）。

## 0. 结论摘要

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| GET /api/canvases（366 画布 / 4.47MB） | 66.9ms / 143,457B | **11.0ms（不带 AE）/ 11.8ms（gzip）/ 24,376B** | **-84% 耗时 / -83% 字节** |
| GET /api/recent-canvases | 66.8ms / 5,851B | **4.1ms / 1,255B** | -94% / -79% |
| GET /api/canvases/trash | 61.7ms / 11,375B | **4.2ms / 2,175B** | -93% / -81% |
| GET /api/projects | 60.5ms | **4.2ms** | -93% |
| GET /api/canvases/{id}（最大画布 1.19MB） | 32.2ms / 945,664B | **36.1ms / 75,913B** | 耗时 +3.9ms（压缩 CPU）/ **-92% 字节** |
| GET /static/novai-canvas/canvas.js（~1.14MB） | 3.6ms / 1,137,484B | **16.7ms / 390,575B** | +13ms 压缩 CPU / **-66% 字节** |
| GET /static/novai-canvas/canvas.css（~232KB） | — | 5~8ms / **45,607B** | -80% 字节 |
| GET /api/canvases/{id}/versions（20 版 / 24.7MB） | 130.9ms | **5.9ms** | **-95%** |
| PUT /api/canvases/{id}（保存 1.19MB 画布） | 187.5ms / 945,664B 回包 | **55.7ms（内容未变）/ 61.9ms（内容变化）/ 75,913B** | **-70% 耗时 / -92% 回包字节** |
| pytest（7 个画布/存储相关用例文件） | 165 passed, 1 failed | 165 passed, 1 failed | **无回归**（失败项改动前就红） |
| node `tests/run-all.js` | — | **135/135 通过** | — |

进程内函数级（消除 HTTP/握手噪声，366 画布 4.47MB、923 个版本目录 5,771 个快照 101MB）：

| 函数 | 前 | 后 |
|---|---|---|
| `cleanup_expired_canvas_trash()` | 29.1ms | **1.6ms** |
| `iter_canvas_records()` | 58.5ms（732 次 `json.load`，**每个画布解析 2 遍**） | **2.7ms（0 次 json.load，全部缓存命中）** |
| `list_canvas_versions()`（20 版 24.7MB） | 110.1ms | **0.13ms**（冷启动首访 108.5ms，之后 ~6ms 含 HTTP） |
| `snapshot_canvas_version()` | 141.8ms | **5.1~6.8ms（真写）/ 4.5ms（去重命中）** |
| `save_canvas()` | 15.8ms | 14.7ms（其中序列化 11.6→3.6ms；余下是 fsync 抖动） |
| 画布文件体积（1.19MB 画布） | 1,192,484B | **982,619B（-17.6%）** |

---

## 1. 问题与证据（改动前，实测）

环境：把真实 `data/canvases`（166 个 / 3.3MB）与 `data/canvas_versions`（923 目录 / 5,771 文件 / 101MB）整体复制到 `/tmp`，再合成 200 个画布（6~14 节点、含图片 URL/文本），合计 **366 个画布 / 4.47MB**。服务：`NOVAI_PORT=3131 NOVAI_DATA_DIR=/tmp/novai-perf-backend`。

### 1.1 画布列表每次请求把全部画布解析两遍（最大列表开销）

证据（改动前 `main.py:5740 iter_canvas_records` / `main.py:5724 cleanup_expired_canvas_trash`）：
- `iter_canvas_records()` 第一行就调 `cleanup_expired_canvas_trash()`，后者在 **5727-5733** 又 `os.listdir` + 对每个 `.json` `json.load` 一遍（只为读一个 `deleted_at`）；
- 然后 `iter_canvas_records` 自己再 `os.listdir` + 全部 `json.load` 一遍；
- 实测 366 个画布 = **732 次 json.load / 58.5ms**，其中 cleanup 占 29.1ms。
- 连带：`/api/recent-canvases`（main.py:25653 只取前 12 个）、`/api/canvases/trash`、`/api/projects`（`list_projects` 也调 `iter_canvas_records`）**每个都付同样的全量扫盘**：实测 60~67ms，与返回 1KB 还是 143KB 无关。
- 另外每个文件还做两趟节点遍历算缩略图（`canvas_thumbnail` main.py:5753、`canvas_thumbnails` main.py:5770，各遍历一次 `nodes`），缓存后这趟也省了。

### 1.2 PUT 保存每次都重新解析该画布的全部历史版本（PUT 187ms 里约 140ms）

证据（改动前 `main.py:5442 snapshot_canvas_version` → `main.py:5428 list_canvas_versions`）：
- `snapshot_canvas_version` 为了拿「下一个版本号」，调用 `list_canvas_versions()`，而后者把该画布目录下**每个** `v{N}.json` 都 `json.load` 一遍（还算 nodes/images 计数）；
- 实测：最大画布保留 20 版、24.7MB 快照 → 单次 **110.1ms**；整个 `snapshot_canvas_version` 141.8ms；
- PUT 路由（`@app.put` main.py:27063 / `update_canvas` main.py:27064）在每次保存后都会调它，而前端是 **800ms 防抖整份保存**（`novai-canvas-ui/src/novaiBackend.ts:638-661 saveDoc`），因此这条 110ms 是高频常驻开销；
- 旧实现还有 7.0ms 的 `json.loads(json.dumps(canvas))` 深拷贝（只为了落盘时不让写盘拿到活对象，但写盘是同步的，不需要克隆）。

### 1.3 保存/快照落盘带 indent=2，文件更大、序列化更慢

证据（改动前 `main.py:5253 save_canvas`、`main.py:5440` 及另外 6 处直写）：`write_json_atomic(..., indent=2)`。
实测 1.19MB 画布：`json.dumps(indent=2)` **11.6ms / 1,192,437B**，紧凑 **3.6ms / 982,619B**（-17.6% 体积、-70% 序列化耗时）。慢不只是 CPU：文件更大意味着每次保存多写 21 万字节，版本快照目录已经 **101MB**。

### 1.4 无 gzip：静态与 JSON 全明文

证据：全仓 `grep -n "GZipMiddleware|Content-Encoding|gzip"` = **0 处**。
实测（带 `Accept-Encoding: gzip` 也照样明文）：`canvas.js` 1,137,484B、`canvas.css` 228,390B、`GET /api/canvases/{id}` 945,664B、`GET /api/canvases` 143,457B。

### 1.5 版本列表接口把 24.7MB 快照全解析（GET /versions 130.9ms）

证据：`list_canvas_versions` 每次都被 `GET /api/canvases/{id}/versions`（main.py:27412）直接调用，返回体只有 1.8KB，却要解析 20 个 1.2MB 文件。

### 1.6 PUT 里没有 assets registry / 缩略图 / hash 的重复全量计算（已排除）

按要求单独核查 `update_canvas`（main.py:27064）逐行：只做 `load_canvas`（5.4ms）→ 权限 → 版本冲突校验 → 字段覆盖 → `_agent_ensure_aliases`（实测 **0.54ms**）→ `save_canvas` → `snapshot_canvas_version` → 广播。**没有**调用 `assets_registry`、没有重算缩略图、没有 hash。pydantic `CanvasSaveRequest` 校验（982KB / 约 1000 个节点）实测只有 **0.13ms**，不是瓶颈。

### 1.7 前端是否需要全量 logs（结论：需要，不改协议）

已与 beat-perf 确认：canvas-next 不渲染 `doc.logs`、也不进 AI 上下文，生成历史走 localStorage `canvas-next:runs:<id>`；但 `saveDoc` 会把内存里的 `meta.logs` **原样 PUT 回去**（`novaiBackend.ts:646`）。所以「GET 只返回最近 N 条」会被下一次 800ms 防抖保存静默截断老画布历史。
→ **⑤ 不做**。GET 保持全量，只靠 gzip 把 945KB 压到 75.9KB（-92%）。

---

## 2. 改动清单（全部在 main.py）

我的净改动：**+180 / -56**（用改动前备份做基线逐 hunk 核对；`git diff` 里另有 **+11/-1** 属于**其他 agent 的并发改动**，见 §6）。

### ① 压缩：GZipMiddleware（main.py:186）

    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=4)

- 选 **starlette 自带的 GZipMiddleware**（不引新依赖，starlette 1.6.0 已装）。它自带 `DEFAULT_EXCLUDED_CONTENT_TYPES`：`text/event-stream`、`image/*`、`video/*`、`audio/*`、`font/woff*`、`application/zip`、`image/avif|gif|jpeg|png|webp` —— **SSE 与已压缩二进制天然排除**。
- `minimum_size=1024`：小响应（`/api/projects` 136B、404、`/api/canvases/{id}/meta`）不付压缩成本。
- `compresslevel=4`：实测 level4 用 62% 的 CPU 拿到 96% 的压缩率（本地优先产品同时兼顾局域网访问）。
- 该中间件对 `status==206`（Range 分段）也会跳过，视频/音频拖动进度条不受影响。

压缩档位实测（`zlib.compress`，3 次中位数）：

| 数据 | level1 | level4 | level5 | level6 | level9 |
|---|---|---|---|---|---|
| canvas.js 1,137,484B | 9.5ms / 432,078B | 17.1ms / 387,443B | 21.9ms / 376,967B | 27.5ms / 374,449B | 30.5ms / 373,692B |
| 画布 JSON 982,619B | 2.8ms / 110,759B | 4.9ms / 79,046B | 5.3ms / 75,119B | 6.1ms / 71,798B | 9.0ms / 70,426B |

> 大于 128KB 的响应 starlette 会丢到工作线程压缩（`thread_minimum_size`），不阻塞事件循环，但该响应自身延迟 +3~17ms。浏览器对静态资源有 ETag 协商（二次访问 304、无 body、不压缩），一次性成本可接受。

### ② 列表 O(缓存)：(mtime_ns, size) 记录缓存（main.py:5816-5884）

- 新增 `_CANVAS_RECORD_CACHE`（key=文件名 → `((mtime_ns,size), record)`）与 `_canvas_file_records()`：文件 stat 没变就直接复用上次 `canvas_record()` 的结果（记录只含 id/title/icon/kind/owner/color/pinned/project/board_x/y/created_at/updated_at/deleted_at/node_count/thumbnail/thumbnails，**不含 nodes**，内存有界）。
- `cleanup_expired_canvas_trash()`（main.py:5855）改为复用同一份记录，**消灭第二次 json.load**：`iter_canvas_records` 的 732 次 → 0 次（缓存命中）。
- `iter_canvas_records()`（main.py:5868）返回 **浅拷贝 dict**：因为 `list_canvases_for_request`（main.py:5951）会往记录里塞 `access_role`/`owner_username`，不能污染缓存。
- `save_canvas()`（main.py:5285）写完后 `_invalidate_canvas_record(basename)` 主动失效。

**失效点（全量列出）**

| 写入方式 | 失效机制 |
|---|---|
| `save_canvas()`：PUT /api/canvases/{id}（main.py:27064）、新建、删除/恢复、恢复版本、agent 步骤写画布等绝大多数路径 | 主动 `_invalidate_canvas_record()`（不依赖 stat） |
| 直写 `write_json_atomic(canvas_path(...))`：`POST /api/canvases/{id}/meta`（main.py:25759）、`POST /api/canvases/{id}/logs/delete`（main.py:27360）、备份恢复（main.py:17574）、agent 原子改写 `_agent_mutate_canvas`（main.py:31684）、agent 批量写（main.py:34423）、删项目时把画布迁回默认项目（main.py:25704） | 靠 `(mtime_ns, size)` 变化自动失效（都走 `write_json_atomic`：临时文件 + `os.replace`，mtime 必然更新） |
| 删除文件：`DELETE /api/canvases/{id}/purge`、回收站过期清理 | 该文件名的缓存条目在下一次扫描时被剪掉（`seen` 差集） |
| 另一个进程/另一个实例写入 | 同上，靠 `(mtime_ns,size)` 判断 |

**已知限制**

1. 跨进程写入只按 `(mtime_ns, size)` 判断。若外部进程把文件改成「mtime 与 size 都不变」的内容，列表会读到旧值 —— 已实测复现。**最坏情况不是「几毫秒」，而是「直到该文件下一次产生不同 (mtime,size) 的写入为止」，可能一直错**（缓存没有 TTL）。
2. 缓存是**进程内**的。若同时跑两个后端实例（本机 + 局域网调试、或用户开了两份桌面版指向同一 `NOVAI_DATA_DIR`），实例 A 的写入实例 B 靠 stat 兜底，漏读窗口同上。
3. 缓存**不落盘**，进程重启后第一次列表回到冷路径（366 画布实测约 58ms，一次性）。
4. `_CANVAS_RECORD_CACHE` 的内存与画布数成正比、与画布体积无关（每条只含元信息 + ≤4 个缩略图 URL）。实测 367 个画布 = 367 条。

### ③ 保存路径减负 + 写盘口径统一

- `save_canvas()`（main.py:5285）改用 `indent=_CANVAS_JSON_INDENT`（main.py:142）：默认 `None`（紧凑），`NOVAI_PRETTY_CANVAS_JSON=1` 时恢复 `indent=2`（人工排查用，已实测开关生效：设置后文件首 80 字符是 `{\n  "id": ...`）。
- **另外 6 处「绕过 save_canvas」的整份写盘也统一**到同一个常量（按 Lead 要求）：meta 更新（25759）、logs 删除（27360）、agent 原子改写（31684）、agent 批量写（34423）、备份恢复（17574）、删项目迁画布（25704）。这样「同一份画布不论从哪个入口写」体积/耗时口径一致。
- 新增 `write_bytes_atomic()`（main.py:118）：与 `write_json_atomic` 完全相同的原子语义（同目录临时文件 + flush + fsync + `os.replace` + 异常清理），但直接写已序列化好的 UTF-8 字节。**原子性、fsync 语义一个字没改。**

写盘口径验证（见 §3.5）：`POST /api/canvases/{id}/meta` 置顶后列表立刻可见、落盘首 120 字节无缩进；`_agent_mutate_canvas` 直写后列表 `node_count` 立刻更新、落盘紧凑。**注意：`/meta` 改标题在 auth-off 下会 403**（「只有所有者或管理员可以重命名画布」，`server/perms.py:189 can(None,"manage")==False`，既有行为，与本改动无关），所以改名验证用「与 /meta 完全相同的写盘语句 + 独立进程直写」来做，列表立刻读到新标题。

### ④ 版本快照：只扫文件名 + 内容 hash 去重（main.py:5418-5538）

- 新增 `_canvas_version_numbers()`（main.py:5420）：只 `os.listdir` + 文件名正则取版本号，**不解析快照本体**。`snapshot_canvas_version` 改用它 → 110.1ms → 0.1ms。
- 内容 hash 去重：`stable = {k: v for k, v in canvas.items() if k != "updated_at"}` 的 sha256 与本画布上一个快照相同 → **直接返回 None，不写盘**。忽略 `updated_at` 是因为 `save_canvas` 每次都会刷新它（不忽略就永远算变化，去重形同虚设）。
- 写盘只序列化一次：`content = json.dumps(canvas)` 的字节直接拼进 `{"version":…,"saved_at":…,"canvas_snapshot":<content>,"note":…}`，省掉旧的 7ms 深拷贝。
- 版本裁剪仍按 `version <= next - limit` 删旧文件，并清掉对应 `_VERSION_META_CACHE` 条目。

#### 返回值语义变化与调用点核对结论（5 个调用点逐个看）

`snapshot_canvas_version(canvas, note="", force=False)` 去重命中时返回 **None**（原来必返回版本号）。逐个核对：

| 调用点 | 用途 | 是否用返回值 | 结论 |
|---|---|---|---|
| main.py:27092 `update_canvas`（PUT 保存） | 800ms 防抖整份保存 | **不用**，响应只有 `{"canvas": canvas}`；下次 `base_updated_at` 取自 `canvas.updated_at`（`save_canvas` 已刷新） | 安全，无需 force |
| main.py:31694 `_agent_snapshot`（agent 侧统一入口，15 个调用点都用它） | 助手运行前/后、每步改动的版本点 | **用**：`/api/agent/apply` 返回 `pre_version`/`version`（main.py:38207-38208），前端 `static/js/smart-canvas.js:11739/11802` 拿它当「撤销本次修改」的回滚目标，且 `if(!st.version) return;` 会静默禁用回滚 | **已改 `force=True`**：内容没变也落一版，与去重前行为一致 |
| main.py:26577 outputs「加入画布」 | 旁路，try/except 包裹 | 不用（且每次都会 append 节点，内容必变） | 安全 |
| main.py:39303 agent undo | 旁路，裸调用 | 不用 | 安全（撤销后内容通常等于某个已存在快照，不写新版本不丢信息） |
| main.py:38248 / 27438 恢复版本（agent rollback / 版本恢复） | 用户显式恢复 | **用**，写进响应 `version` | **已传 `force=True`**：用户点恢复必定产生新版本 |

顺带确认：仓库里**没有**「手动打版本」的 HTTP 接口（`/versions` 只有 GET 列表 / GET 单版 / POST restore / DELETE），所以不存在「手动保存版本接口返回 None」的问题；能主动产生版本的入口是 PUT 保存（去重）、恢复版本（force）、agent 操作（force）。

#### 用户可见行为变化：版本历史里的「空版本」消失

- 以前：每次 PUT（含 800ms 防抖的连续保存）都写一份历史，即使用户只是选中/拖动后没实质修改 → `data/canvas_versions` 里堆着大量内容完全相同的版本（本机真实数据 101MB / 5,771 个快照）。
- 现在：**内容（除 updated_at 外）与上一份快照相同 → 不写新版本**，版本历史更干净；代价是「想手动留一版当前状态」没有入口（原本也没有）。
- 不受影响的两类路径：(a) 恢复版本 / agent 回滚 `force=True`，必定新增一版；(b) agent 预/后快照 `force=True`，回滚目标始终存在。
- 已实测：恢复 v1 后再保存一次，能正常产生新版本（见 §3.6 的 `[1,2,3,4]`）。

### ⑤ 版本列表元信息缓存（main.py:5418-5480）

`list_canvas_versions` 按 `(mtime_ns,size)` 缓存每个 `v{N}.json` 的 `{version,saved_at,size,note,nodes,images}`，文件没变不重新解析；已被删除/裁掉的条目在列表时剪掉。GET /versions：130.9ms → 5.9ms（冷启动首访 108.5ms 一次性）。

---

## 3. 验证

### 3.1 SSE（硬要求）：真实 `/api/canvas-llm/stream` 走完整中间件链，未压缩、分块增量到达

在 **/tmp 数据目录**里加了一个本地 OpenAI 兼容 mock 上游（`127.0.0.1:3133`，每 250ms 推一个 `chat.completion.chunk`），把 `provider` 指到它，然后对 **真实 3131 服务**发请求（`/tmp/nvperf/sse_live.py`）：

    # 请求头带 Accept-Encoding: gzip, deflate
    status=200 content-type=text/event-stream; charset=utf-8
    content-encoding=None  transfer-encoding=chunked  vary=None
    first_chunk_ms=7.9
    chunks: 7.9ms/71B, 8.9ms/43B, 263.9ms/43B, 518.9ms/43B, 774.0ms/43B, 1024.3ms/43B, 1276.4ms/83B
    first_bytes: b'data: {"type": "meta", "model": "mock-model", "provider": "perfmock"}\n\n'

对照（同一请求不带 `Accept-Encoding`）：`content-encoding=None`、块时间线同节奏（36.7/38.2/292.7/543.4/796.4/1047.9/1303.3ms）。
结论：**`Content-Encoding` 未被改写（无 gzip）、无缓冲（7 个块按上游节奏陆续到达，首块 7.9ms）**。

另外用同一份 `main.app` + 同一份中间件配置起 uvicorn（`/tmp/nvperf/sse_verify.py`，注入与 main.py:25594 同构的 `StreamingResponse(media_type="text/event-stream")`）复核：5 块落在 0.1/250.5/503.6/753.7/1005.1ms，`content-encoding=None`。

### 3.2 已压缩二进制不被二次压缩

    GET /static/images/logo_512.png (25,279B) -> status=200 content-encoding=None vary=None ctype=image/png
    GET /assets/media_previews/nope.png      -> 404，无 gzip

`image/*`、`video/*`、`audio/*`、`font/woff*`、`application/zip` 全在 starlette 排除表内；`/api/media-preview`（main.py:9218）返回的也是 `image/*`，同一条规则排除（本次 /tmp 数据目录未复制 media_previews，用静态 png 验证同一规则）。

小响应阈值（`minimum_size=1024`）：`/api/projects` = `content-length: 136`、无 `Vary`；`/api/canvases` = `content-length: 24376`、`vary: Accept-Encoding`、`content-encoding: gzip`。

### 3.3 缓存正确性回归（18/18 PASS，`/tmp/nvperf/cache_smoke2.py`）

覆盖：新建→列表、跨进程改写（mtime/size 变）→列表更新、PUT 保存→node_count 更新、首次保存写 1 个快照、内容不变重复保存 **不写新快照**、内容变化写新快照、快照 JSON 合法且节点一致、快照四字段齐全、恢复版本返回 v3 且内容回滚、版本裁剪到 20、版本号单调递增、软删除/回收站/恢复/彻底删除。**结果 18/18 PASS**。已知局限也在同一脚本里复现（等长改写 + `os.utime` 还原 mtime → 列表读旧值）。

### 3.4 损坏文件行为（与改动前一致，实测）

测试：往 `/tmp/.../canvases/` 放两个坏 JSON（普通 + 带 deleted_at 的回收站文件），再放一个正常的过期垃圾文件。

    列表 status=200 条目=337 耗时=14.8ms；损坏文件在列表里=False
    回收站 status=200 条目=30；损坏的回收站文件在里面=False
    多次列表后损坏文件仍在（cleanup 不会误删）: True
    调一次列表后过期垃圾被清理: True（删除时间 early 1970，远超 30 天保留）

结论：**损坏文件永远不会被清理、也永远不会阻塞列表**（解析失败在 `_canvas_file_records()` 里 `continue`，不会进缓存也不会进回收站删除判定）—— 与改动前 `try: json.load except: continue` 行为一致；而「能解析且 deleted_at 过期」的文件仍照常清理。

### 3.5 写盘口径统一验证（`/tmp/nvperf/write_paths.py` + `agent_write.py`）

    POST /meta 置顶+改色 -> status=200；列表立刻可见: pinned=True
    落盘紧凑（首 120 字节无换行缩进）: True   b'{"id": "80a638ecf0c74405abb2c141488dc04e", "title": "META-CA'
    POST /meta 改名 -> status=403 detail=只有所有者或管理员可以重命名画布（auth-off 既有行为）
    （用与 /meta 完全相同的写盘语句直写）列表立刻看到新标题: META-RENAMED-DIRECT | 落盘紧凑: True
    （_agent_mutate_canvas 直写）agent 写入完成 nodes=1；落盘紧凑: True；列表 node_count 立刻更新: 1

注意后两项是**跨进程**验证：写盘由独立 python 进程完成，3131 服务的列表正是通过 `(mtime_ns,size)` 发现变化并刷新缓存，证明跨进程失效生效。

### 3.6 版本历史 + 多进程极限窗口（`/tmp/nvperf/lead_checks2.py`）

    新建后 versions = []
    第 1 次保存（新建后首存）          → versions = [1]
    第 2 次保存（内容未变）            → versions = [1]        ← 去重命中，不写新快照
    第 3 次保存（内容未变）            → versions = [1]        | PUT 响应字段: ['canvas']
    第 4 次保存（内容有变）            → versions = [1, 2]
    恢复 v1（force=True）              → 接口返回 version = 3  | versions = [1, 2, 3]
    恢复后再保存（内容有变）           → versions = [1, 2, 3, 4]

    双进程（3131 写 / 3142 读，同一 data 目录）：
      A 建好后 B 立即可见: True
      外部进程改写（size 变）后 B 立即可见: True
      等长改写 + os.utime 还原 mtime 后，B 读到旧标题（size 相同=True, mtime 相同=True）← 唯一漏读窗口
      下一次真实写入（mtime 变）后，B 读到新标题

多进程/协作说明（补充 §2② 限制）：桌面版与局域网模式都是**单进程 uvicorn**（`uvicorn.run` 未开 workers），所有画布写入都在这一个进程里 → 走主动失效，不存在漏读。只有用户手动开两个后端实例（或两份桌面版）指向同一 `NOVAI_DATA_DIR` 才是跨进程，此时最小可观测延迟：
- mtime 分辨率：APFS **1ns**、NTFS **100ns**、ext4 **1ns**、HFS+ **1s**、exFAT **2s**（后两者才有现实风险）；
- 漏读需要「同一时间刻度内 + 字节数完全相同」两个条件同时成立。想让画布内容实质变化而字节数完全不变，几乎只能改 `updated_at` 这种等长数字（此时列表只是「最后修改时间」旧一点，排序可能差一位）；
- **最坏情况**：命中该窗口后不是「等 1 秒自动好」，而是**一直读到旧值，直到该文件下一次产生不同 (mtime,size) 的写入**（缓存无 TTL）。需要立即正确时重启进程即可（缓存不落盘）。

### 3.7 Python / Node 测试

    $ venv/bin/python -m pytest tests/test_agent_canvas_p0.py tests/test_canvas_log_cleanup.py \
        tests/test_canvas_permissions.py tests/test_page_import.py tests/test_asset_dedupe.py \
        tests/test_agent_classic_text_node.py tests/test_agent_classic_update_settings.py -q
    1 failed, 165 passed, 6 warnings in 2.57s
    FAILED tests/test_agent_canvas_p0.py::VisionTests::test_no_vision_model_anywhere_is_honest   ← 改动前基线同样这一条红

    $ node tests/run-all.js
    [run-all] 结果：135/135 通过
    [run-all] 全部通过

后端正常启动、画布新建/打开/保存/恢复版本/回收站/彻底删除全通。

### 3.8 测试环境说明（不影响结论）

- `static/novai-canvas/canvas.js` 在压测期间被前端 agent 重建过（1,137,484B → 1,144,574B），静态资源绝对字节数有 ±0.6% 漂移，压缩率结论不受影响。
- 本机同时有其他 agent 压测：有一次 bench 与 node 测试并发，PUT 被抬到 73ms；表中数字取空闲复测。`/tmp/novai-perf-backend` 里还出现过非我创建的 `c1.json`（可能有别的 agent 也在用同一 /tmp 目录），已排除对我的删除/清理类测试的干扰。

---

## 4. 风险与回退

| 风险 | 说明 | 缓解/回退 |
|---|---|---|
| gzip 客户端兼容 | 兼容所有现代浏览器/Electron/curl；不带的客户端拿到明文（原行为） | 删掉 main.py:186 一行即完全回退 |
| gzip CPU | 1.14MB 静态资源 +13~17ms（工作线程内，不阻塞事件循环），二次访问 304 不再压 | 更省 CPU：`compresslevel` 调 2~3；更小字节：调 5~6（数据见 §2①） |
| 列表缓存跨进程 | 只按 `(mtime_ns,size)`，见 §2② 限制与 §3.6；极端同 mtime+size 会读旧值 | 重启进程清空缓存；或删掉 `_CANVAS_RECORD_CACHE` 使用处回到全量解析 |
| 快照去重减少版本数 | 「内容没变只点保存」不再产生新版本（历史更干净）；恢复/agent 路径 force=True 不受影响 | 需要旧行为：`snapshot_canvas_version` 去掉 hash 判断，或调用处传 `force=True` |
| 紧凑 JSON | 文件 1.19MB → 0.98MB，人眼可读性下降；所有读方都是 `json.load`，无格式契约 | `NOVAI_PRETTY_CANVAS_JSON=1` 重启即恢复缩进 |
| 版本元信息缓存 | 以 `(mtime_ns,size)` 为键，文件被替换必然失效；删除时主动清条目 | 删掉 `_VERSION_META_CACHE` 相关几行即回到每次解析 |

**回退方式**：改动前的完整 `main.py` 备份在 `NOVAI-v16/_to_delete/perf-backup/backend/main.py.bak`（14:56 复制，早于任何编辑）。**未执行**任何 `git checkout/stash/reset/clean/commit/push`。

---

## 5. PUT 剩下的 ~56ms 构成 + 「只回 updated_at」的收益与影响面（仅评估，**未改协议**）

| 环节 | 实测 |
|---|---|
| 请求体 JSON 解析（982KB） | ~10ms（框架侧，估算） |
| pydantic `CanvasSaveRequest` 校验（约 1000 节点） | **0.13ms** |
| `load_canvas`（1.19MB `json.load`） | 5.4ms |
| `_agent_ensure_aliases` | 0.54ms |
| `save_canvas`（序列化 3.6ms + fsync/写盘） | 14.7ms（写盘部分受磁盘负载影响） |
| `snapshot_canvas_version`（去重命中） | 4.5~5.6ms |
| 响应序列化 + gzip（945,617B → 75,913B） | ~4ms + ~5ms（level4 实测 4.9ms） |
| HTTP/连接 + 其他 | 余量 |
| **合计 p50** | **55.7ms（未变）/ 61.9ms（内容变化）** |

**只回 `{id, updated_at}` 的收益估算**：省掉「响应序列化 ~4ms + gzip ~5ms + 传 75.9KB」，回包从 75.9KB 降到 ~200B（-99.7%），**PUT 端到端预计 55.7ms → 约 45~47ms（-15%~-18%）**。收益主要吃在响应侧；请求侧那 10ms 解析省不掉（要读 nodes）。

**前端影响面（不能只改后端）**：PUT 成功响应体现在被三方消费，且都不只读 `updated_at`——

1. `novai-canvas-ui/src/novaiBackend.ts:650-652 saveDoc`：`const canvas = data.canvas || {}; metadata.set(canvasId, metaOf(canvas)); return { ok: true, version: Number(canvas.updated_at) || baseVersion }`，而 `metaOf`（同文件 :226-234）读 **title/icon/viewport/logs/updated_at**。另 `save()`（:630-631）同样 `metaOf(data.canvas)`。
   → 若只回 `{id,updated_at}`：`metaOf` 会拿到空 title/icon，把内存 metadata 覆盖成默认值（标题变成「未命名画布」、viewport 被重置）。**必须同步改 2~3 行**：改成 `metadata.set(canvasId, { ...meta, updatedAt: Number(canvas.updated_at) || meta.updatedAt })`（`meta` 本来就在第 640 行拿到了）。
2. `static/js/smart-canvas.js:14411-14414`：`if(data.canvas.updated_at) canvas.updated_at = ...`、`setSmartServerBase(data.canvas.nodes, data.canvas.connections)`、`adoptServerNodeAliases(data.canvas)` → **依赖成功响应里的 nodes/connections/别名计数器**，瘦身会直接打断「服务端节点编号对齐」，需要配套改成保存后再 GET 一次本地状态。
3. `static/js/canvas.js:2008-2010`（传统画布）：`if(data.canvas) canvas = {...canvas, ...data.canvas, viewport:localViewport}` → 依赖响应里的 `alias_counters` 等字段做服务端合并，同样要改。

结论：**收益 ~10ms/次（-15%~-18%），但要同时改 3 个画布前端（其中 2 个依赖 nodes/别名），风险明显大于收益，建议不做**。若将来一定要做，最小改动版是返回 `{canvas:{id,updated_at,title,icon,viewport,logs}}`（canvas-next 够用）+ 把 smart/legacy 的「服务端合并」改成保存后 GET。另外还有一个**零协议变更**的小优化可备选：让 `save_canvas` 把已序列化的字节返回给 PUT 路由直接当响应体（省 ~3.6ms 的二次序列化），但会改动路由返回类型，这次没做。

---

## 6. 只属于我作用域的改动

    $ diff -u _to_delete/perf-backup/backend/main.py.bak main.py | diffstat -s
     1 file changed, 191 insertions(+), 57 deletions(-)
       ├─ 我的改动：            +180 / -56
       └─ 其他 agent 并发改动：  +11 / -1   （agent 提示词文案 + 预算跳过逻辑，非我所改）

- 我改了 `NOVAI-v16/main.py`（+180/-56）并新增 `NOVAI-v16/docs/perf-audit/backend.md`。
- `git diff` 里 `main.py` 的 4 个 hunk（`@@ -40610`、`@@ -41560`、`@@ -41588`、`@@ -41653`：agent 提示词文案、「预算用完」状态判定）**不是我改的**，在我备份之后由其他 agent 并发写入；我全程只碰 gzip / 列表缓存 / 保存 / 快照 / 写盘 indent 这几处。
- `server/**` **一行未改**（`git diff --stat` 出现的 `server/integrations/openclaw.py`、`server/routes/assets.py`、`server/web_access.py` 是**前次会话遗留 WIP**，mtime 11-02/11-03，早于本会话 11-04 14:56）。
- 前端（`static/**`、`novai-canvas-ui/**`、`canvas-ui/**`、`web/**`）**一行未改**；`NOVAI-v16/data/` **一行未改**（压测全在 `/tmp/novai-perf-backend`）。

## 7. 复现命令

    # 1) /tmp 数据副本（真实 166 画布 + 101MB 版本快照 + 200 个合成画布）
    cp -R data/canvases/.        /tmp/novai-perf-backend/data/canvases/
    cp -R data/canvas_versions/. /tmp/novai-perf-backend/data/canvas_versions/
    python3 <合成 200 画布脚本>            # 见 §1 环境说明

    # 2) 起服务（不碰 3000，也不碰 data/）
    NOVAI_PORT=3131 NOVAI_DATA_DIR=/tmp/novai-perf-backend venv/bin/python main.py

    # 3) HTTP 基线/复测（7 次中位数；改前后同一 harness）
    venv/bin/python /tmp/nvperf/bench2.py
    venv/bin/python /tmp/nvperf/sizes.py           # 序列化/落盘体积对比
    venv/bin/python /tmp/nvperf/putbreak.py        # PUT 分段计时

    # 4) SSE 验证（mock 上游 3133 + 真实路由）
    venv/bin/python /tmp/nvperf/mock_llm.py &
    API_PROVIDER_PERFMOCK_KEY=perf-key NOVAI_PORT=3131 NOVAI_DATA_DIR=/tmp/novai-perf-backend venv/bin/python main.py
    venv/bin/python /tmp/nvperf/sse_live.py

    # 5) 缓存正确性 / 失效边界 / 写盘口径 / 版本历史 / 多进程
    venv/bin/python /tmp/nvperf/cache_smoke2.py
    venv/bin/python /tmp/nvperf/write_paths.py
    venv/bin/python /tmp/nvperf/agent_write.py
    venv/bin/python /tmp/nvperf/lead_checks2.py

> 所有脚本都在 `/tmp/nvperf/`（不在仓库内，避免污染工作树）。仅用于复现，删除不影响仓库。
