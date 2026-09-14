# NOVAI 多维表格（task-table）与 API 协议升级计划

> 版本：v1（2026-02）
> 范围：`static/js/shared/*`（前端契约层）、`main.py`（Task Engine / Matrix / Agent / Provider）、`server/`（协议层新增）
> 性质：**增量补齐，不重写**。本仓库已存在成熟的 matrix 系统，本计划补齐的是"端口契约 + 操作契约 + 协议握手"三层。
> 参照实现：DX OS 0.3.7 的 `dx-canvas-nodes/v2`、`dx-protocol/v2`、`dx-ai-task/v2`（分析结论见附录 B）

---

## 0. 一句话结论

NOVAI 的 `task-table` 在**执行语义**（revision / 执行签名 / 依赖 DAG / Run+RowRun / 归因）上已经领先于参照实现，**行模型不要动**。缺的是三样：

1. **端口契约** —— 没有数组/单值维度，没有连线兼容与强制转换规则，表格本身不输出"行"
2. **操作契约** —— 表格的增删改没有 risk / idempotency / confirmation 声明，Agent 重试会重复写入
3. **协议握手** —— matrix 批量提交前无法预知某个 target 能不能跑，1000 个 cell 只能"跑完才知道哪个失败"

---

## 1. 现状盘点（已核实，含行号）

### 1.1 已存在，**不要重造**

| 能力 | 位置 | 说明 |
|---|---|---|
| 节点类型单一事实来源 | `static/js/shared/node-registry.js`（103 行） | 15 个节点 spec，含 `aliases`/`runnable`/`capabilities`/`inputTypes`/`outputTypes`/`migrate` |
| 表格节点 | `node-registry.js:8-34` | `TASK_TABLE_TYPE='task-table'`，别名 `['matrix','smart-matrix']`，UI 名「多维表格」 |
| 矩阵行模型 v2 | `static/js/shared/workflow-utils.js`（740 行） | `MATRIX_VERSION=2`、`normalizeMatrixRow`(`:262`)、`normalizeMatrixNode`(`:312`)、`validateMatrix`(`:533`)、`migrateMatrixNode`(`:388`) |
| 执行签名 / revision | `workflow-utils.js:36-58` | `computeRowExecutionSignature`、`markRowChangedIfExecutionInputsDiffer`，执行语义变了才 bump |
| 行执行上下文 | `workflow-utils.js:60-120` | 注释明确为「唯一事实来源」，禁止另写一套 |
| Run / RowRun 生命周期 | `static/js/shared/matrix-run.js`（11KB） | `createRun`(`:90`)、`createRowRun`(`:68`)、`buildExecutionSnapshot`(`:51`)、`patchRowRun`(`:183`)、`setRunStatus`(`:195`)、`ownedRefs`(`:148`)、`collectRowRefs`(`:171`) |
| Task Engine | `main.py:2986-3470` | `TASK_STORE`(`:2987`)、`TASK_RUNNERS`(`:2993`)、`TASK_STATUS_FLOW`(`:3003`)、`task_create`(`:3128`)、`task_set_status`(`:3176`)、`task_enqueue`(`:3264`)、`task_cancel`(`:3363`)、`task_retry`(`:3378`)、`task_list`(`:3429`) |
| Task 状态机 | `main.py:3002-3016` | 11 状态 + 显式可达集合，非法转换直接拒绝 |
| 自动重试上限 | `main.py:2991` | `TASK_AUTO_RETRY_MAX = 2`，注释「网络层自动重试上限（未提交上游时）」 |
| 三种 runner | `main.py:15230 / 15273 / 16051` | `run_canvas_image_task` / `run_canvas_comfy_task` / `run_canvas_video_task` |
| Matrix 后端 | `main.py:21209-21560` | 维度笛卡尔积模型；`MATRIX_MAX_DIMENSIONS=8`(`:21227`)、`MATRIX_MAX_CELLS=1000`(`:21228`)、`_matrix_build_cells`(`:21289`)、`_matrix_render_value`(`:21304`)、`_matrix_refresh_cells`(`:21323`)、`_matrix_stats`(`:21340`) |
| Matrix API | `main.py:21371/21412/21421/21438/21500/21543` | `POST/GET /api/matrices`、`GET/DELETE /api/matrices/{id}`、`/run`、`/cancel` |
| Matrix → Task 桥接 | `main.py:21438-21497` | 逐 cell `task_create` + `task_enqueue`；**已有关联且未结束的任务跳过** |
| Agent 工具注册表 | `main.py:23061-23211` | 11 个工具，含 `create_matrix`(`:23199`)，结构 `{description, schema, validate, run, preview, mutates_canvas}` |
| Agent 预览/应用/回滚 | `main.py:23558/23615/23665/23752` | `/api/agent/plan`、`/preview`、`/apply`、`/rollback` |
| Provider 配置 | `main.py:409/1461/1474/1480/1403/1539` | `API_PROVIDERS_FILE`、`load_api_providers`、`save_api_providers`、`public_provider`（剥离密钥）、`normalize_provider`、`get_api_provider` |
| 画布原子读改写 | `main.py:21994` | `_agent_mutate_canvas`，全程持 `CANVAS_LOCK` |
| 画布版本快照 | `main.py:22005` | `_agent_snapshot` → `snapshot_canvas_version` |

### 1.2 缺口清单（带证据）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | 端口无数组/单值维度 | `node-registry.js:31` `outputTypes:['image','video','text']` 是裸字符串数组 | 无法表达"这一列吃 9 张参考图" |
| G2 | 无连线类型校验 | `canvas.js:16859` `canConnect(fromId,toId)` 只按 **node.type 白名单字符串**判断，无端口概念 | 非法连线靠硬编码 if 链维护，5 处白名单 |
| G3 | 表格不输出"行" | `node-registry.js:31` 输出类型里没有 `table`/`rows` | 跨行批量只能靠 `targetNodeId`+`dependencies` 隐式路由，连线上看不见 |
| G4 | 无输出目标概念 | 全局无 `output.targets` 类结构 | 生成结果无法"按行回写表格"，缺 V2 文档里的 Outputs 汇聚 |
| G5 | 表格操作无风险声明 | `main.py:23061` 只有 `mutates_canvas: bool` | 删行/删列与读表同权，Agent 无依据决定是否要确认 |
| G6 | 行编辑无幂等 | `workflow-utils.js` 行操作无 requestId 去重 | Agent 重试 → 重复追加行 |
| G7 | 无提交前握手 | 无 descriptor 类接口 | 1000 cell 批量提交后才知道哪个 target 不可用 |
| G8 | 无统一任务信封 | `task_create(kind, payload, runner_name, ...)`(`:3128`) 的 payload 是自由 dict | cell payload 无 schema 约束，字段名靠约定 |
| G9 | `create_matrix` 标记矛盾 | `main.py:23209` `mutates_canvas: False`，但它确实写 `MATRIX_STORE` | 影响 Agent 变更审批语义 |
| G10 | 后端契约文件缺失 | `workflow-utils.js:8` 要求与 `server/node_types/task_table.py` 的 `ROW_STATUSES` 一致，该文件**全仓不存在** | 前后端词汇一致性无落点 |

---

## 2. 目标与非目标

### 2.1 目标

- **T1** 表格成为一等端口类型：既可作为批量驱动（输出 `rows`），也可作为结果汇聚（`table-node` 输出目标）
- **T2** 建立端口类型系统与连线兼容/转换规则，替换 `canConnect` 里的硬编码白名单
- **T3** 表格 6 个操作具备 risk / sideEffect / idempotency / confirmation 声明，并支持 requestId 幂等回放
- **T4** 表格支持动态列（用户自定义列）与上游输入列自动生成
- **T5** 提供模型能力握手接口，matrix 批量提交前可预检 target
- **T6** 引入统一任务信封与协议元数据表，新增平台从"改 Python"变为"加配置"

### 2.2 非目标（本计划明确不做）

- ❌ 重写 `task-table` 行模型（现有富对象模型保留）
- ❌ 引入前端框架 / 构建步骤
- ❌ 把 `generate_ai_image()` 的执行逻辑整体搬进 JSON（P4 才评估，且只对新平台）
- ❌ 引入数据库（继续用 JSON + 锁，符合现有约定）
- ❌ 实现 OT/CRDT 协同
- ❌ **自创、改造或替换 NOVAI 现有 UI 设计语言**（详见 §2.3，硬性约束）

### 2.3 UI 约束（硬性，不可协商）

**所有前端 UI 必须复用 NOVAI 现有设计语言；禁止自创视觉，禁止套用参照实现（DX OS）的外观。**

样式加载层次（`static/canvas.html:10-13`，后者覆盖前者）：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `static/css/canvas.css`（186KB） | 画布组件样式 |
| 2 | `static/css/theme.css`（63KB） | 主题覆盖 |
| 3 | `static/vendor/css/fonts.css` | 字体 |
| 4 | `static/css/marvis-shared.css`（13KB） | **NOVAI Design Token System（最后加载，令牌胜出）** |

**必须使用的令牌**（`marvis-shared.css:4+`；禁止硬编码颜色 / 字号 / 圆角 / 阴影）：

| 类别 | 令牌 |
|---|---|
| 背景层 | `--bg` `--surface` `--surface-2` `--elevated` `--overlay` `--canvas-bg` `--panel-bg` `--sidebar-bg` `--stage-bg` |
| 文字层 | `--text` `--text-2` `--text-3` `--text-on-accent` `--accent` `--accent-hover` `--accent-pressed` `--accent-text` `--accent-subtle` |
| 语义色 | `--danger` `--success` `--warning` `--info`（各含 `-bg` / `-border` / `-text` 变体，Apple 风冻结基线） |
| 边框 | `--border` `--border-2` `--border-strong` `--divider` `--nav-hover-bg` `--scrollbar` |
| 阴影 | `--shadow-sm` `--shadow-md` `--shadow-lg` |
| 圆角 | `--radius-sm` `--radius-lg` `--radius-full` |
| 字体 | `--font-sans`（Geist / Inter / PingFang SC）、`--font-mono`（Geist Mono） |

**必须复用的既有组件类**（`canvas.css`）：`.panel`(`:20`)、`.toolbar` / `.toolbar-items` / `.toolbar-fixed`(`:139/140/144`)、`.node`(`:218`)、`.canvas-*` 系列。图标统一 Lucide：`<i data-lucide="..."></i>`。

**落实方式**：

1. 新增表格 UI 只允许「设计令牌 + 既有组件类 + Lucide 图标」三种材料
2. 不新增任何颜色值、字号、圆角、阴影、动效常量
3. 不复制参照实现的视觉外观与组件结构
4. 渲染函数沿用现有 `data-matrix-*` 属性命名与事件绑定约定（`canvas.js:6594-6611`、`:6613-6675`）
5. 亮/暗主题必须同时可用（令牌已按主题分组，不得绕过）

> ⚠️ **已知缺口**：本副本中表格 UI 的 CSS **完全缺失**。`matrix-rows` / `matrix-row` / `matrix-row-index` / `matrix-row-refs` / `matrix-row-status` / `matrix-row-error` / `matrix-row-ref-port` / `matrix-view-bar` / `matrix-token-help` / `matrix-validation-errors` / `matrix-overlay-editor` / `matrix-result-view` / `matrix-source-map` 等类在 `canvas.js` 中被使用，但在**所有 CSS 文件与 HTML 内联样式中零命中**。因此「照现有表格 UI 的外观做」在本副本内**无法参照**——需要补齐该 CSS 后才能对齐。详见附录 C-5。

---

## 3. 详细设计

### 3.1 端口类型系统（T2，对应 G1/G2）

**新增文件** `static/js/shared/port-compat.js`

**端口类型词表**（沿用参照实现，14 种）：

```js
const PORT_TYPES = [
  'text','text[]','json','table','file','file[]',
  'media.image','media.image[]','media.video','media.video[]',
  'media.audio','media.audio[]','artifact','event'
];
```

**端口定义结构**：

```js
{ id: 'images', title: '参考图片', type: 'media.image[]', required: false, multiple: true }
```

**兼容与转换规则**（`portCompatibility(source, target)`）：

| 条件 | ok | coercion |
|---|---|---|
| `source.type === target.type` | ✅ | `none` |
| `target.type === 'artifact'` 且 source 非 `event` | ✅ | `artifact` |
| `target.type === 'event'` | ❌ | 事件端口不能作为数据制品连接 |
| `target.type === 'file'` 且 source 是 `media.*`/`file` 且非数组 | ✅ | `file` |
| `target.type === 'file[]'` 且 source 是 `media.*`/`file`/`file[]` | ✅ | 数组→`file`，单值→`wrap` |
| `target.type === 'json'` 且 `source.type === 'table'` | ✅ | `none`（**整表逐行**） |
| 去 `[]` 后同名 | 单值→数组 | `wrap` |
| 去 `[]` 后同名 | 数组→单值且 `target.multiple` | `flatten` |
| 去 `[]` 后同名 | 数组→单值且非 multiple | ❌ 「多值输出不能连接到单值输入」 |
| 其他 | ❌ | `${source.type} 不能连接到 ${target.type}` |

**接线点**：
- `canvas.js:16859` `canConnect(fromId,toId)` → 增加端口解析：从 `NovaNodeRegistry.specOf(node)` 取 `outputs`/`inputs`，对无端口声明的旧节点回退到现有 type 白名单（**保证零破坏**）
- `canvas.js:16881` `sanitizeConnections()` → 复用同一函数
- 连线数据结构增加可选 `fromPort`/`toPort`，旧连线缺省为空

### 3.2 节点 spec 升级（T1，对应 G1/G3/G4）

**修改** `static/js/shared/node-registry.js`：`spec()` 增加 `inputs`/`outputs`/`output` 三个可选字段，并在返回对象里保留旧的 `inputTypes`/`outputTypes` 作为**派生视图**（由端口自动生成），确保 `acceptsInput`/`producesOutput` 的现有调用点零改动。

`task-table` 升级后：

```js
spec(TASK_TABLE_TYPE, {
  aliases: TASK_TABLE_ALIASES, label: '多维表格', runnable: true,
  capabilities: ['plan','batch','continuous','dag','revision','stale','mapping','table-ops'],
  inputs:  [
    { id: 'rows', title: '输入', type: 'artifact', multiple: true },
    { id: 'text', title: '文本', type: 'text', multiple: true },
  ],
  outputs: [
    { id: 'rows',  title: '行',   type: 'json',  multiple: true },
  ],
  output: { targets: ['inline','text-node','table-node'], defaultTarget: 'inline', defaultPort: 'rows' },
  migrate: node => NovaWorkflowUtils ? NovaWorkflowUtils.migrateMatrixNode(node) : node,
})
```

> 说明：表格**输出**是 `json[]`（逐行），**输入**是 `artifact[]`。生成节点增加 `output.targets` 后即可选 `table-node` 作为结果落点。

### 3.3 动态列与输入列（T4）

**行列分工**（保留执行字段，另加数据列）：

- **执行字段**保持行顶层：`rowId`/`prompt`/`references`/`dependencies`/`type`/`status`/`revision` 等，**不动**
- **数据列**放 `row.extra`：`{ [columnKey]: string }`
- **列定义**放节点：`node.tableSchema = { version: 1, columns: [...], inputColumns: N }`

```js
column = {
  key: 'brand',            // ^[a-z][a-z0-9_-]{0,63}$
  title: '品牌',           // 1..120
  type: 'text',            // 一期只支持 text
  source: 'custom',        // 'custom' | 'execution' | 'input'
  width: 140,
  editable: true,
}
```

**约束**（全部在归一化时静默纠正，不抛错）：

| 项 | 上限 | 越界处理 |
|---|---|---|
| 列数 | 200 | 截断 |
| 行数 | 5000 | 截断 |
| 单元格长度 | 20000 字符 | 截断 |
| 列名 | 空 → `"未命名列"`，重复 → 追加 `(2)` | 自动修复 |
| 行长度 | 不足补 `''`，超长截断 | 自动对齐 |

**输入列自动生成**：上游连线进来的素材自动成为最左侧列，列名 `生成输入` 或 `输入 N`（N 从 1 起）。用 `node.tableSchema.inputColumns = N` 记录已生成数量，并用 `node.tableSchema.inputDetached = true` 标记"已从数据列剥离"，避免重复剥离。运行时上下文解析时按 `inputColumns` 跳过这些列。

**列定位双通道**（供操作与 Agent 使用）：

```js
resolveColumn(node, { columnName, column }) -> index  // 0-based
// columnName 非空时：要求列名唯一，否则抛「列名"X"不唯一」/「不存在列"X"」
// 否则：column 按 1-based 序号，越界抛「列序号必须是 1–N」
```

### 3.4 表格操作契约 + 幂等（T3，对应 G5/G6）

**新增文件** `static/js/shared/table-ops.js`

```js
const TABLE_OPERATIONS = {
  read_table:    { kind:'query',    risk:'low',    sideEffect:'none',  idempotency:'idempotent', confirmation:'on-ambiguity' },
  set_cell:      { kind:'mutation', risk:'low',    sideEffect:'local', idempotency:'keyed',      confirmation:'on-ambiguity', inputSchema:{ row:{type:'integer',minimum:1}, columnName:{type:'string'}, column:{type:'integer',minimum:1}, value:{type:'string',maxLength:20000} }, required:['row','value'] },
  append_row:    { kind:'mutation', risk:'low',    sideEffect:'local', idempotency:'keyed',      confirmation:'on-ambiguity', inputSchema:{ values:{type:'array'} }, required:['values'] },
  delete_row:    { kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',      confirmation:'on-risk',      inputSchema:{ row:{type:'integer',minimum:1} }, required:['row'] },
  add_column:    { kind:'mutation', risk:'low',    sideEffect:'local', idempotency:'keyed',      confirmation:'on-ambiguity', inputSchema:{ title:{type:'string',maxLength:120} }, required:['title'] },
  delete_column: { kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',      confirmation:'on-risk',      inputSchema:{ columnName:{type:'string'}, column:{type:'integer',minimum:1} } },
};
```

**风险分级原则**：读最低 → 增改次之 → 删最高（删行/删列用 `on-risk`，其余 `on-ambiguity`）。

**plan / apply 契约**：

```js
planTableOperation(node, operationId, args, requestId)
  -> { operationId, before, after, changed, replayed, requestId }
```

- 执行前**深拷贝**一份用于 `before`/`after` 比对
- `requestId` 记录在 `node.tableOpIds`，**只保留最近 64 个**（环形）
- 命中已存在的 `requestId` → 返回当前状态 + `replayed: true`，**不改数据**
- `read_table` 不写 `tableOpIds`

**前端调用点**：`canvas.js:13715-14220` 的表格节点操作函数统一改走 `planTableOperation`，不再直接改 `node.rows`。

**后端镜像**（`main.py` AGENT_TOOLS）：新增 6 个工具，并给注册表条目扩展字段：

```python
"set_table_cell": {
    "description": "修改多维表格单元格。",
    "schema": {...},
    "validate": _agent_tool_set_table_cell_validate,
    "run": _agent_tool_set_table_cell_run,
    "preview": _agent_tool_set_table_cell_preview,
    "mutates_canvas": True,
    # 新增契约字段
    "risk": "low",
    "side_effect": "local",
    "idempotency": "keyed",
    "confirmation": "on-ambiguity",
    "reads": ["table"], "writes": ["table"],
},
```

`/api/agent/tools/{tool_name}`（`main.py:23544`）接受可选 `request_id`，落盘到 `data/agent_op_log.json`（环形，按 canvas_id 分组），命中则直接返回上次结果。

**`create_matrix` 修正**（G9）：`mutates_canvas` 改为 `True`，并补 `risk: "low"`、`side_effect: "external-state"`、`confirmation: "on-ambiguity"`。

### 3.5 模型能力握手（T5，对应 G7）

**新增端点** `GET /api/ai/descriptor?provider_id=&model=&intent=`

返回（对齐 `dx-model-descriptor/v1` 的结构，但用 NOVAI 命名空间）：

```json
{
  "format": "novai-model-descriptor/v1",
  "provider": { "id": "comfly", "name": "Comfly", "protocol_id": "openai-image", "source": "api", "enabled": true },
  "model":    { "id": "flux-1.1-pro", "name": "FLUX 1.1 Pro", "profile_id": "", "profile_label": "" },
  "intent": "image.generate",
  "capabilities": ["image.generate", "image.edit"],
  "inputs": {
    "images": { "min": 0, "max": 9, "roles": ["reference_image"], "maxBytes": 10485760, "mimeTypes": ["image/png","image/jpeg","image/webp"] },
    "videos": { "min": 0, "max": 0, "roles": [], "maxBytes": 0, "mimeTypes": [] },
    "audios": { "min": 0, "max": 0, "roles": [], "maxBytes": 0, "mimeTypes": [] },
    "files":  { "min": 0, "max": 0, "roles": [], "maxBytes": 0, "mimeTypes": [] }
  },
  "parameters": {
    "schema_id": "comfly-image",
    "source": "param_schema",
    "fields": [],
    "defaults": {},
    "limits": {}
  },
  "execution": { "available": true, "mode": "native", "reasons": [] }
}
```

**`execution.mode` 取值**：`declarative` | `native` | `legacy` | `unavailable`

**数据来源（复用现有函数，不新造真值源）**：

| descriptor 字段 | 现有来源 |
|---|---|
| `provider.*` | `get_api_provider_exact()`（`main.py:1552`）+ `public_provider()`（`:1480`） |
| `model.caps` | provider 的 `models[]` 里的 `caps` 字段 |
| `parameters.defaults/limits` | 现有 `/api/image-params`（`main.py:14001`）与 `paramSchema` |
| `execution.available` | `test-connection`（`main.py:13227`）/ `probe-async`（`:13340`）/ `fetch-models`（`:13616`）的结果缓存 |
| `inputs.*` | 一期用**内置静态表**（按 provider/model 前缀匹配），二期再动态化 |

**缓存**：descriptor 结果按 `provider_id + model + intent` 缓存在内存（TTL 300s），并支持 `?refresh=1` 强制刷新。

**前端接入**：`api-settings.js` 或新模块负责拉取并缓存；矩阵 run 前批量调用。

### 3.6 统一任务信封（T6，对应 G8）

**新增端点** `POST /api/ai/tasks`（与既有 `/api/canvas-image-tasks` 并存，不替换）

请求体：

```json
{
  "format": "novai-ai-task/v1",
  "request_id": "7f3c...",
  "context": { "surface": "canvas", "canvas_id": "c_1", "node_id": "n_1" },
  "intent": "image.generate",
  "target": { "provider_id": "comfly", "kind": "model", "id": "flux-1.1-pro", "metadata_ref": "" },
  "prompt": "...",
  "params": { "size": "1024x1024", "quality": "auto" },
  "inputs": [
    { "asset_id": "a_1", "kind": "image", "role": "reference_image", "source": { "type": "url", "id": "https://..." } }
  ],
  "output": { "kind": "image", "count": 1, "size": "1024x1024" }
}
```

**约束**：

- `intent` 为**闭合枚举**（见附录 A.3），非法值 400
- `request_id` **幂等**：已存在则直接返回原 task，不新建、不重复扣费
- `params` 字段名必须在 descriptor 的 `parameters.fields` 里（一期只告警，二期拒绝）
- `output.kind` 只允许 `image|video|audio|text`

**适配层**：`/api/ai/tasks` 内部转成现有 `task_create(kind, payload, runner_name, provider_id, model_id, extra)`（`main.py:3128`），runner 由 `intent` + provider 推导。**不新增执行路径。**

**`task_create` 幂等改造**：增加可选 `request_id` 参数，写入 `task["request_id"]`，并维护 `data/task_request_index.json`（`request_id -> task_id`）。

### 3.7 协议元数据表（T6）

**新增目录** `server/protocols/`

```
server/protocols/
├─ __init__.py
├─ registry.py              # 加载 + 校验 + 查询
├─ provider_protocols.json  # 供应商协议（鉴权 + models 端点 + 公共规则）
├─ model_protocols.json     # 模型协议（能力 + 参数 + 素材规则 + limits）
└─ manifest.json            # 版本清单（供更新通道）
```

**边界（一期刻意收窄）**：协议表**只承载元数据**——capabilities / parameters / limits / inputs 规则 / docs。
**不承载 HTTP 执行**。原因：`generate_ai_image()` 等执行路径是深度命令式的 Python，整体声明式化是独立的大工程（列 P4）。一期目标是**让 descriptor 有真值源**，且新增平台只需加元数据。

供应商协议条目：

```json
{
  "id": "comfly",
  "label": "Comfly",
  "version": 1,
  "kind": "provider",
  "auth": { "type": "bearer", "header": "Authorization", "prefix": "Bearer " },
  "models_endpoint": "/v1/models",
  "categories": ["image", "video", "llm"],
  "docs": []
}
```

模型协议条目：

```json
{
  "id": "openai-image",
  "label": "OpenAI 兼容图片",
  "version": 1,
  "kind": "model",
  "capabilities": ["image.generate", "image.edit"],
  "assets": {
    "images": { "mode": "data_url", "maxBytes": 10485760, "maxDimension": 2048, "mimeTypes": ["image/png","image/jpeg"] }
  },
  "defaults": { "size": "1024x1024", "quality": "auto" },
  "limits": { "count": { "min": 1, "max": 4 } },
  "match": ["flux", "dall-e", "gpt-image"]
}
```

**版本规则**（照搬参照实现）：内置协议 `version` 固定为 1；自定义协议 `max(现有 keys)+1`；**内置协议不可被自定义覆盖**。

**`manifest.json`**：

```json
{
  "format": "novai-protocol-manifest/v1",
  "generated_at": 0,
  "protocols": [
    { "id": "comfly", "kind": "provider", "version": 1, "sha256": "..." }
  ]
}
```

**下发通道**：复用现有三源更新机制（GitHub / Gitee / ModelScope）。新增校验：包格式 `novai-protocol-bundle/v1`、**下载域名同源**、SHA-256 校验、体积 ≤4MB、原子写入 `data/protocols/`。内置与远程合并规则：同名以内置为准（不可覆盖）。

### 3.8 防重复扣费（T6）

**现状**：`TASK_AUTO_RETRY_MAX = 2`（`main.py:2991`），注释已写明"未提交上游时"。

**要做的事**：

1. **审计**：逐 runner 确认「上游已接单」的判定点（拿到 `provider_task_id` / 收到 2xx 之后）是否严格禁止自动重试
2. **显式化**：在 task 上落一个布尔 `upstream_submitted`，一旦置 `True`，`task_bump_retry`（`:3242`）直接拒绝自动重试并记录原因
3. **文档化**：把"已提交上游不重试"写进 `AGENTS.md` 的「改之前先看的坑」
4. **幂等**：`request_id` 贯穿 `/api/ai/tasks` → `task_create`，重试复用同一 id

---

## 4. 分阶段实施

### P0 — 止血（1–3 天，独立可交付）

| # | 任务 | 改动文件 | 验收 |
|---|---|---|---|
| P0-1 | 修 `server/node_types/task_table.py` 断链：补回模块导出 `ROW_STATUSES`，或删除 `workflow-utils.js:8` 的注释引用 | `server/node_types/task_table.py`（新增）或 `workflow-utils.js:8` | 全仓搜索 `task_table` 不再有悬空引用 |
| P0-2 | `request_id` 幂等落到 `task_create` + `/api/ai/tasks` | `main.py:3128`、新增端点 | 同 id 提交两次，第二次返回同一 task，无新任务产生 |
| P0-3 | 审计并显式化 `upstream_submitted` | `main.py` 各 runner | 已提交上游的任务不会被 `task_bump_retry` 自动重试 |
| P0-4 | 修 `create_matrix` 的 `mutates_canvas` | `main.py:23209` | Agent 变更审批能看到该工具会改状态 |

**风险**：P0-2 涉及 `task_create` 签名变更 → 加**可选参数**，保持全部现有调用点不变。

### P1 — 端口契约（1–2 周）

| # | 任务 | 改动文件 | 验收 |
|---|---|---|---|
| P1-1 | 新增 `port-compat.js`（类型词表 + 兼容规则） | `static/js/shared/port-compat.js`（新增） | 单元测试覆盖附录 A.1 全部分支 |
| P1-2 | `node-registry.js` `spec()` 支持 `inputs`/`outputs`/`output`，并派生旧字段 | `node-registry.js` | `acceptsInput`/`producesOutput` 现有调用点零改动、行为不变 |
| P1-3 | `canConnect`/`sanitizeConnections` 接入端口校验（无端口声明时回退旧白名单） | `canvas.js:16859`、`canvas.js:16881` | 旧画布连线全部保留；新建非法连线被拒并给出可读理由 |
| P1-4 | `task-table` 增加 `rows` 输出端口 + `output.targets` | `node-registry.js` | 表格可连到生成节点；生成节点可选 `table-node` 落点 |
| P1-5 | 连线数据支持 `fromPort`/`toPort`（可选字段） | `canvas.js` 连线读写 | 旧数据无该字段时按默认端口解析 |

**风险**：P1-3 触碰画布核心连线逻辑（`AGENTS.md` 已警告 `applyViewport`/`renderLinks` 需同步）。**策略**：新逻辑做成纯函数 + 白名单回退，先只做"校验"不做"渲染"，渲染改动放 P2。

### P2 — 表格能力（2–3 周）

| # | 任务 | 改动文件 | 验收 |
|---|---|---|---|
| P2-1 | `table-ops.js`：6 个操作契约 + `planTableOperation` + requestId 环形缓冲 | `static/js/shared/table-ops.js`（新增） | 同 requestId 重放返回 `replayed:true` 且数据不变 |
| P2-2 | 前端表格操作统一走 `planTableOperation` | `canvas.js:13715-14220` | 所有行编辑入口不再直接改 `node.rows` |
| P2-3 | 后端 6 个表格 Agent 工具 + 契约字段扩展 | `main.py:23061` 区域 | `GET /api/agent/tools` 返回新字段；删行工具带 `confirmation: on-risk` |
| P2-4 | `/api/agent/tools/{name}` 支持 `request_id` 幂等 | `main.py:23544` | 同 id 重复调用不重复写入 |
| P2-5 | 动态列 `tableSchema` + `row.extra` 归一化 | `workflow-utils.js` `normalizeMatrixNode`/`normalizeMatrixRow` | 列/行/单元格越界静默截断；旧数据无 `tableSchema` 时自动生成默认列 |
| P2-6 | 输入列自动生成 + `inputDetached` 标记 | `workflow-utils.js`、`canvas.js` 渲染 | 连 3 个上游 → 左起 3 列「生成输入/输入 1/输入 2」，重复加载不重复剥离 |
| P2-7 | `output.targets` 生效：生成结果按行回写表格 | `canvas.js` 结果落点逻辑 | 选中 `table-node` 时，生成结果成为新行而非新节点 |

**风险**：P2-5 改的是 `normalizeMatrixNode`/`normalizeMatrixRow`——**这是行情景的唯一事实来源**，改错会波及全部矩阵逻辑。**策略**：先加只读字段（`tableSchema`）不影响执行签名（`EXECUTION_INPUT_KEYS` `workflow-utils.js:15` **不加入** `tableSchema`/`extra`），确认稳定后再让操作写入。

### P3 — API 协议层（2–4 周）

| # | 任务 | 改动文件 | 验收 |
|---|---|---|---|
| P3-1 | `server/protocols/` 目录 + registry + 两个 JSON + manifest | `server/protocols/*`（新增） | 启动加载；id 命名 `^[a-z0-9][a-z0-9:_-]{1,63}$` 校验 |
| P3-2 | `GET /api/ai/descriptor` + 内存 TTL 缓存 | `main.py` 新增路由 | 返回结构符合 `novai-model-descriptor/v1`；`execution.mode` 四值之一 |
| P3-3 | `POST /api/ai/tasks` 统一信封 + 适配 `task_create` | `main.py` 新增路由 | `intent` 非法 400；`request_id` 幂等；跑通 image + video 两条链路 |
| P3-4 | matrix run 前握手预检 | `main.py:21438` `run_matrix` | 不可执行/超界的 cell 标记为 `blocked` 并附 `reason`，**不进入 Task Engine** |
| P3-5 | 协议包走三源更新通道 + 同源/SHA256/4MB 校验 | 现有更新代码（`main.py:2120-2850` 区域） | 伪造包被拒；内置协议不可被远程覆盖 |
| P3-6 | `AGENTS.md` 补「已提交上游不重试」「协议表真值源」两条 | `AGENTS.md` | — |

**风险**：P3-4 会改变 `run_matrix` 的行为（部分 cell 不再启动）。**策略**：加开关 `?preflight=1`，默认开；响应里返回 `blocked` 明细。

### P4 — 可选（评估后再定）

| # | 任务 | 说明 |
|---|---|---|
| P4-1 | 声明式 operation（`method/path/bodyTemplate/response selector`） | **只对新增平台**启用，存量平台继续走 Python |
| P4-2 | `assets.mode` 自动素材转换（`data_url`/`public_url`/`upload_operation`） | 依赖 P3-2 的 inputs 规则表 |
| P4-3 | 协议覆盖率诊断（`novai-protocol-coverage/v1`） | 列出哪些 provider/model 还没有协议条目 |

---

## 5. 兼容与迁移

| 对象 | 兼容策略 |
|---|---|
| 旧画布数据 | 无 `tableSchema` → 加载时按当前 `MATRIX_TYPES` 生成默认列；无 `tableOpIds` → 视为空数组 |
| 旧连线 | 无 `fromPort`/`toPort` → 用节点定义的第一个兼容端口；无 `inputs`/`outputs` 声明的旧节点 type → 回退现有白名单 |
| `node-registry.js` 调用点 | `inputTypes`/`outputTypes` 保持为派生只读视图，`acceptsInput`/`producesOutput` 签名不变 |
| `task_create` | `request_id` 为**可选参数**，现有 30+ 调用点零改动 |
| 既有生成接口 | `/api/canvas-image-tasks`、`/api/online-image` 等**全部保留**，`/api/ai/tasks` 为并行新入口 |
| `matrix` / `smart-matrix` 别名 | 保持 `NovaNodeRegistry.canonical()` 归一，不强制改名 |

**迁移入口**：统一走 `NovaNodeRegistry.migrateNode`（`node-registry.js:79`）→ `NovaWorkflowUtils.migrateMatrixNode`（`workflow-utils.js:388`），不新增第二套迁移路径。

---

## 6. 验收清单

**多维表格**

- [ ] 表格节点能输出 `rows`（`json[]`）并连到生成节点，连线在画布上可见
- [ ] 生成节点可选 `table-node` 作为输出目标，结果成为新行
- [ ] 同 `request_id` 重复执行表格操作：数据不变、返回 `replayed: true`
- [ ] 删行/删列在 Agent 侧触发确认（`confirmation: on-risk`），改单元格不触发
- [ ] `columnName` 重复时报「列名"X"不唯一」；`column` 越界时报「列序号必须是 1–N」
- [ ] 连 3 个上游节点 → 表格左起自动出现 3 列输入列；重新加载不重复剥离
- [ ] 200 列 / 5000 行 / 单元格 2 万字符越界时静默截断，不抛错、不丢画布
- [ ] 旧画布（无 `tableSchema`）打开后能正常编辑和运行

**API 协议**

- [ ] `GET /api/ai/descriptor` 对 image/video/llm 三类各返回一个合法 descriptor
- [ ] matrix run 前预检：不可执行的 target 对应 cell 标记 `blocked` 且**未创建 Task**
- [ ] `POST /api/ai/tasks` 同 `request_id` 提交两次 → 只产生一个 task
- [ ] `intent` 传非法值 → 400 且错误信息列出合法值
- [ ] 已提交上游的任务，断网后不会被自动重试（无重复扣费）
- [ ] 远程协议包：非同源 URL 被拒、SHA256 不符被拒、>4MB 被拒、同名内置协议不被覆盖

---

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| P1-3 改动画布连线核心，可能回归 | **高** | 纯函数 + 白名单回退；先只校验不渲染；`sanitizeConnections` 保留旧路径 |
| P2-5 改动行情景归一化，波及全部矩阵 | **高** | `tableSchema`/`extra` 不进 `EXECUTION_INPUT_KEYS`，不影响执行签名与 revision |
| P3-4 改变 `run_matrix` 行为 | 中 | 加 `preflight` 开关，返回 `blocked` 明细；可回退 |
| P3-1 协议表与现有 provider 配置双真值源 | 中 | 一期协议表**只读**，不参与执行；descriptor 从现有配置派生，协议表只提供 limits/inputs 元数据 |
| P0-2 `task_create` 签名变更 | 中 | 可选参数；`request_id` 缺省时行为与现在完全一致 |
| 缓冲区无统一测试入口 | 中 | 每个阶段交付**可手工验证的验收路径**（起服务 → 打开页面 → 具体操作），并在 `tests/` 补关键纯函数的脚本测试 |

---

## 8. 附录

### 附录 A.1 端口类型与兼容矩阵

见 §3.1 表格。`event` 端口只用于事件流，不参与数据制品连接。

### 附录 A.2 表格操作契约全表

| 操作 | kind | risk | sideEffect | idempotency | confirmation |
|---|---|---|---|---|---|
| `read_table` | query | low | none | idempotent | on-ambiguity |
| `set_cell` | mutation | low | local | keyed | on-ambiguity |
| `append_row` | mutation | low | local | keyed | on-ambiguity |
| `add_column` | mutation | low | local | keyed | on-ambiguity |
| `delete_row` | mutation | **medium** | local | keyed | **on-risk** |
| `delete_column` | mutation | **medium** | local | keyed | **on-risk** |

### 附录 A.3 `intent` 闭合枚举（一期）

```
llm.chat  llm.chat.vision  llm.tools  llm.structured_output
image.generate  image.edit  image.blend  image.upscale  image.variation
image.inpaint  image.zoom  image.pan  image.reroll
video.text_to_video  video.image_to_video  video.first_last_frame
video.multi_reference  video.video_to_video  video.audio_reference  video.multimodal
video.upscale  video.erase_subtitle
audio.tts  audio.transcribe  audio.translate  audio.music
```

### 附录 A.4 新增/修改文件清单

**新增**

| 文件 | 阶段 | 作用 |
|---|---|---|
| `static/js/shared/port-compat.js` | P1 | 端口类型 + 兼容/转换规则 |
| `static/js/shared/table-ops.js` | P2 | 表格操作契约 + plan/apply + 幂等 |
| `server/protocols/__init__.py` | P3 | 协议包入口 |
| `server/protocols/registry.py` | P3 | 加载 / 校验 / 查询 |
| `server/protocols/provider_protocols.json` | P3 | 供应商协议元数据 |
| `server/protocols/model_protocols.json` | P3 | 模型协议元数据 |
| `server/protocols/manifest.json` | P3 | 版本清单 |
| `server/node_types/task_table.py` | P0 | 补回 ROW_STATUSES 契约（或改为删注释） |

**修改**

| 文件 | 阶段 | 改动 |
|---|---|---|
| `static/js/shared/node-registry.js` | P1 | `spec()` 支持 `inputs`/`outputs`/`output`；`task-table` 加端口与输出目标 |
| `static/js/canvas.js` | P1/P2 | `canConnect`(`:16859`)、`sanitizeConnections`(`:16881`)、表格操作(`:13715-14220`)、结果落点 |
| `static/js/shared/workflow-utils.js` | P2 | `normalizeMatrixNode`(`:312`)/`normalizeMatrixRow`(`:262`) 支持 `tableSchema`/`extra`；输入列 |
| `main.py` | P0/P2/P3 | `task_create`(`:3128`)、`task_bump_retry`(`:3242`)、`AGENT_TOOLS`(`:23061`)、`/api/agent/tools`(`:23544`)、`run_matrix`(`:21438`)、新增 descriptor/tasks 路由 |
| `AGENTS.md` | P3 | 补两条铁律 |

### 附录 B 与参照实现的对照结论

| 维度 | NOVAI 现状 | 参照实现 | 处置 |
|---|---|---|---|
| 行模型 | 富对象（执行语义完备） | 纯字符串矩阵 | **保留 NOVAI 的** |
| 列模型 | 无 | `columns: string[]` 动态列 | **采纳**（P2-5） |
| 端口 | 粗粒度类型标签 | 14 种类型 + 5 类转换 | **采纳**（P1） |
| 表格输出 | 无 | `table` / `json[]` | **采纳**（P1-4） |
| 输出目标 | 无 | `inline`/`text-node`/`table-node` | **采纳**（P2-7） |
| 操作契约 | 仅 `mutates_canvas: bool` | risk/sideEffect/idempotency/confirmation | **采纳**（P2-1/P2-3） |
| 幂等 | 无 | requestId 最近 64 个回放 | **采纳**（P2-1/P2-4） |
| 握手 | 无 | `dx-model-descriptor/v1` | **采纳**（P3-2） |
| 任务信封 | 自由 payload | `dx-ai-task/v2` 闭合 intent + 稳定 target | **采纳**（P3-3） |
| 协议表 | Python if/elif | `dx-protocol/v2` 声明式 operation + 表达式引擎 | **只采纳元数据层**（P3-1），执行层留 P4 |
| 协同 | 无 | WebSocket 广播 + 乐观锁 | 不做 |

### 附录 C 待确认问题

1. **P0-1 的取向**：`server/node_types/task_table.py` 是要**补回**（说明它曾存在、被误删/未纳入本仓库），还是**删注释**（说明这是从别处借来的写法）？这决定 P0-1 是新增模块还是改 3 行注释。
2. **P3-1 协议表的真值源边界**：provider 的 `caps`/`protocol` 字段目前存在 `api_providers.json`（`main.py:409`）。协议表要不要成为 `caps` 的唯一真值源？如果不要，两者如何避免漂移？
3. **P2-7 输出目标的交互**：结果落 `table-node` 时是"追加新行"还是"写入选中行"？需要产品决策。
4. **P0-2 幂等键的持久化范围**：`request_id -> task_id` 索引是否需要跨重启保留（走 `data/` 落盘），还是进程内足够？
5. **表格 UI 的 CSS 在哪？**（阻塞 UI 相关工作）本副本中 `matrix-*` 全部类名在 CSS/HTML 内零命中，`/api/runs` 后端与 `server/node_types/task_table.py` 同样缺失。三者指向同一结论：**本目录是不完整副本**。在做任何表格 UI 相关工作前，需要其中之一：
   - 提供**完整源码副本**（含表格 CSS），或
   - 在 `git init` 后由我按 §2.3 的令牌 + 既有组件类**新建**表格样式（届时是对齐设计体系，而非"照抄现有表格外观"）
6. **删除前置条件**：确认是否接受「先 `git init` 建立回滚点，再执行删除」。当前无版本控制，删除不可恢复。
