# DX OS 多维表格 · 完整规范（逆向提取）

> 来源：DX OS 0.3.3 便携包 → `data/developer-apps/.versions/canvas/1.0.144+10144-c4c22544/source/`
> 方法：app 的 JS 已被 Vite 压缩且**无 sourcemap**，但 **HTML 模板字符串 / 类名 / CSS 属性值未被 mangling**，
> 因此 DOM 结构、CSS、字符串常量、协议参数键全部可以原样提取；JS 逻辑只能按语义还原。
> 可读的 TypeScript 源码在 host 侧（`server/*.ts`、`shared/*.ts`、`src/apps/canvas/*.ts`）。

---

## 1. 数据模型

```json
{ "kind": "table", "version": 1,
  "columns": ["列名1", "列名2"],
  "rows": [["单元格1", "单元格2"]],
  "selectedRows": [], "mergedGroups": [] }
```

| 项 | 手工编辑 | LLM 生成（`a6()`） |
|---|---|---|
| 列上限 | **200**（`Wh`） | **40** |
| 行上限 | **5000**（`Zh`） | **200** |
| 单元格长度 | **20000**（`Vv`） | 20000 |

归一化（`Mx`）：kind/version 强制；列名 `String(x).trim() || "未命名列"`；行按列数补齐；
非字符串单元格 `JSON.stringify`；再截断。

---

## 2. 节点与协议参数

新建表格（`xu()`）：`kind:"table", title:"多维表格", w:520, h:320`，
默认 `columns:["输入 1","字段 2","字段 3"]`、3×3 空行。

**全部 16 个 `params.protocolParams` 键：**

| 键 | 含义 |
|---|---|
| `table` | 表格数据本体 |
| `tableInputChannels` | 输入通道（= 最左的「输入 N」列），`[{id, mode, items}] ` |
| `tableInputColumn` | 是否启用输入列 |
| `tableInputColumnsDetached` | 输入列是否已从数据列剥离（防重复剥离） |
| `tableInputItems` | 输入项（优先于 `t.inputs` 推导） |
| `tableInputsConnectionDriven` | 输入是否由连线驱动 |
| `tablePinnedInputChannels` | 输入通道的「钉住」快照 `{id, nodeIds, cardId}` |
| `tablePinnedInputNodeIds` / `tablePinnedInputCardIds` | 同上，节点/卡片 id |
| `tableBatchConcurrency` | 批量并发，clamp **1..8** |
| `tableBatchStartRow` | 起始行，clamp 1..最大行数 |
| `tableBatchManualSelection` | 「独立运行」模式开关 |
| `tableBatchSelectedRows` | 手动选中的行号数组 |
| `tableBatchFailurePolicy` | `"stop"` / `"continue"`（默认 continue） |
| `generationBatchJournal` | 批量执行 journal（见 §5） |
| `tableOutput` / `tableRow` / `tableNodeId` | 输出物化 / 行引用 |
| `llmGeneratedOutput` / `llmSourceId` / `llmRunAt` | LLM 物化标记与溯源 |

---

## 3. 上游：素材怎么变成「输入列」

```js
XS(t) = t.params.protocolParams.tableInputItems ?? t.inputs.map(x => ({type:"media", nodeId:x.nodeId}))

Co(t): 有 tableInputChannels 就用；否则从 XS(t) 惰性推导 [{id:"input-1", items}]
       并把 columns[0]==="生成输入" 改名为 "输入 1"

ab(t, ch, row): items 为空 → null
                mode === "sequence" → items[row]            // 逐行对应
                否则                → items[min(row, len-1)] // 共享最后一个
```

- **通道 = 一列**，表头显示「输入 N」，单元格渲染媒体缩略图（`.table-media-cell`）
- **连线用 `toPort` 定位通道**：`{from, to, toPort:"input-1", kind:"ref"}`
- 删通道（`QS`）会**连带删除 `toPort === channel.id` 的连线**
- **`mode` 判定规则**（`PR()` 里）：`refs.length > 1 ? "sequence" : "shared"`

---

## 4. 下游：表格怎么驱动生成节点

```js
lb(t)   = 入边来源中 kind === "table" 的卡片
yp(t)   = max(上游各表行数)                      // 扇出行数

Pu(t)   = Array.from({length: yp(t)}, (_, u) => {   // ⭐ 逐行
            media = [], text = []
            for (表 of lb(t)) {
              for (i of 表的输入通道数) {
                wl(表,i,u) && media.push(...)      // 该通道该行的媒体
                Od(表,i,u)?.trim() && text.push()  // 该通道该行的文本
              }
              for (j of 表的列数)
                表.rows[u][j]?.trim() && text.push()   // 数据列的值
            }
            return {rowNumber:u+1, media, text:text.join("\n")}
          })

bl(t)   = 手动模式 → Pu 过滤(已选行 且 有 media 或 text)
          批量模式 → Pu 过滤(行号 >= 起始行 且 有 media 或 text)   // 空行自动跳过
a_(t)   = min(并发数, bl(t).length)                 // 首批
rb(t,e) = 该行是否属于并发窗口（批量取前 N 个 / 手动取已选）
Df(t,e) = [...t.inputs, ...e.media] 去重            // 该行素材
```

### 提示词构建

```js
jf(t, inputs, rowText) = [
    ...Ip(t).map(x => x.text.trim()),        // ① 上游连来的文本节点
    L7(t.params.prompt, t.inputs, inputs),   // ② 节点自己的提示词（经引用替换）
    rowText.trim()                           // ③ 表格该行的文本
  ].filter(Boolean).join("\n")

K0(t,e) = jf(t, Df(t,e), e.text, false)      // 该行的完整提示词（UI 预览用）
```

**`L7(prompt, inputs)` 把提示词里的引用替换成 mention：** `@图片1` / `@视频2` / `@音频3` / `@文件4`
（因此它有 `PromptRichEditor` 富文本编辑器 + `data-reference-index`）
**不是 `{列名}` 占位符。** 表格行的值是通过 ③ **追加**进去的，不是替换。

### 执行器

```js
p = 起始行; h = bl(t)
if (!h.length) notify(手动 ? "请先点击上方行，选择至少一行独立运行"
                          : p > 总行数 ? `起始行超出表格范围，当前共 N 行`
                          : "起始行之后没有可生成的内容")
if (comfy && !已选工作流) notify("请先选择 ComfyUI 工作流")
if (!comfy && 平台!=="api" && !runninghub) notify("请先选择 RunningHub AI 应用/工作流")
if (!comfy && 平台==="api" && 无模型) notify("还没有可用的图像模型，请在「API 设置」里添加")
await 素材准备(); x = [...t.inputs, ...h.flatMap(r=>r.media)] 去重
if (!await 素材校验(x)) return                 // 公网链接 missing/expired
M = h.map(r => ({rowNumber, title, text, mediaNodeIds: Df(t,r).map(x=>x.nodeId)}))
V = 续跑匹配(journal, resumeRunId) || 新建 journal({runId, rows:M, failurePolicy})
跳过 journal 中 completed 的行 + 仍在后台(pending/deferred)的行
并发 = min(tableBatchConcurrency, 待执行行数)
共享游标 + N 个 worker：for(; cursor<N;) { cursor++; await 单行生成() }
```

---

## 5. `generationBatchJournal`（我最初完全没想到的机制）

- 持久化在 `params.protocolParams.generationBatchJournal`
- 结构：`{runId, rows:[{rowNumber, title, text, mediaNodeIds, status, requestId}]}`
- `status`：`completed` / `running` / `pending` / `deferred`
- **断点续跑**：带 `resumeRunId` 再次执行时按 rowNumber 对齐，跳过已完成行
- **后台恢复检测**：`io.get(nodeId)` 里 `counted && (pending|deferred)` 的请求视为"仍在后台"，
  避免重复派发；若有则报错 `批量生成仍有 N 行正在后台恢复，请等待完成后再次恢复 Graph。`
- **失败策略**：`tableBatchFailurePolicy` = `stop`（遇错停）/ `continue`（跑完其余行）

---

## 6. LLM → 表格（完整链路）

### 输出模式

```js
_u(t) = t.params.protocolParams.llmOutputMode === "list" ? "list" : "text"
tb(t,e) = 设置 llmOutputMode
US(t) = 按钮文案：run!=="running" ? "生成"
                 : llmRunStage==="planning"  ? "规划中"
                 : llmRunStage==="repairing" ? "校验中" : "生成中"
```

### 执行（`B0(t)`）

```
llmRunStage = outputMode==="list" ? "planning" : "generating"
  ↓
① 规划遍：planningPrompt = FS(t)  → LLM 返回 plan JSON
   {task, rowCount, targetInputs, referenceInputs,
    inputRoles:[{input,role,mapping,transfer,doNotTransfer}],
    columns, rowRules, qualityChecks}
   "只做规划，不要输出最终 rows。"
  ↓ （plan 存进 protocolParams.llmListPlan）
② 生成遍：prompt = BS(t, plan)  → LLM 返回表格 JSON
  ↓
③ 解析校验 a6()：剥 ```json 代码块 / 取首尾大括号 → JSON.parse
   校验 kind==="table" && version===1 && columns/rows 是数组
   列 ≤40 且非空；行 ≤200；补齐列数；非字符串 stringify；截断 20000
   失败 → "模型没有返回统一的多维表格格式" / "模型返回的表格列名不完整"
  ↓
④ 修复重试 CR(plan, bad)：
   "请把下面未通过校验的结果修复为合法的多维表格 JSON。不要删减原有信息，不要输出解释或 Markdown。"
   llmRunStage = "repairing"
  ↓
⑤ 物化 qS() → PR()
```

### 生成遍的关键约束（`BS` 的 list 分支）

- "请把结果整理为可逐行执行的生成任务：每一行必须是一条完整、独立、可直接用于后续图像生成的内容。"
- "严格遵守用户指定的数量；未指定时根据逐项输入数量和任务目标合理决定。图片组通常逐张映射到各行，单图参考通常应用到所有相关行。"
- "如果任务区分了「目标主体」和「风格/版式参考」，每行生成提示词都必须显式写清它们的关系"
- "**不要只写「使用图1」「参考图2」这类占位说明**。每个文字单元格应提供与普通文本输出相当的信息密度"
- "请根据任务自行设计最合适的列结构，不套固定模板"
- "行的先后顺序已经可以表达执行顺序，因此通常不需要额外创建只用于计数的序号列。"
- "**不要在 JSON 中创建图片、参考图或生成输入列**，系统会在独立的输入区域按规划映射素材，不会覆盖文字列。"
- "只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。"
- `'{"kind":"table","version":1,"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}'`

### 物化（`PR()`）

```
outputMode==="text" → 建 prompt 节点（title: "LLM 输出文本" 或 `${skillName}输出`）
                       protocolParams: {llmGeneratedOutput, llmSourceId, llmRunAt}
                       LLM --flow--> 文本节点

outputMode==="list" → 建 table 节点（title: "LLM 输出列表"）
                       w:520  h: max(320, min(720, 38 + rows*88))
                       inputs: LLM 的图片输入
                       protocolParams: { table, tableInputColumn, tableInputColumnsDetached,
                         tableInputChannels(来自 mediaGroups，mode 按 refs.length>1 判定),
                         tablePinnedInputChannels/_NodeIds/_CardIds,
                         tableInputsConnectionDriven:true, llmGeneratedOutput, llmSourceId, llmRunAt }
                       上游素材 --ref/input-N--> 表格
                       LLM --flow--> 表格
```

---

## 7. Agent 工具（3 个）

| 工具 | patternId | 说明 |
|---|---|---|
| `canvas_run_batch_workflow` | `media-batch-edit` | 框选多图/分组 → 逐图编辑，每张图一个独立生成节点 |
| `canvas_run_batch_workflow` | `reference-set-variants` | 主体 × N 参考图 → 每个组合一个生成节点（笛卡尔积） |
| `canvas_compose_workflow` | `llm-table-batch` | source → LLM(list) → 表格 → 生成节点 → 多个结果组 |
| `canvas_run_workflow` | — | 单节点工作流运行 |

`canvas_run_batch_workflow` 会往 `protocolParams` 打归属标记：
`canvasAgentBatch`, `batchPatternId`, `batchIndex`, `batchExpectedCount`,
`batchSubjectNodeId`, `batchReferenceNodeId`，并**核对结果数量**。

---

## 8. 工作流声明（`llm-table-batch`）

```js
{ id:"llm-table-batch", title:"LLM 表格批量生成",
  description:"LLM 使用列表模式生成多维表格；表格逐行驱动生成节点，画布按行产生多个结果组。",
  nodes:[ {role:"source", types:["image","video","audio","prompt","sticky"], multiple:true},
          {role:"llm"}, {role:"table"}, {role:"generator"}, {role:"results", types:["group"], multiple:true} ],
  edges:[ source→llm, llm→table, table→generator, generator→results ],
  stages:[create, connect, execute-llm, connect, execute-generator, collect-results] }
```

## 9. 画布预设（4 个）

| id | 标题 | 说明 | 节点 |
|---|---|---|---|
| `prompt-image` | 创意图片生成 | 提示词 → 图片生成 | 提示词, 图片生成 |
| `table-image` | **多维表格批量出图** | 按表格行批量组合提示词和素材，并发生成图片 | 多维表格, 图片生成 |
| `prompt-video` | 文本视频生成 | 提示词 → 视频生成 | 提示词, 视频生成 |
| `llm-table` | **LLM 结构化表格** | 提示词 → LLM → 多维表格，用于拆解脚本、商品信息和任务清单 | 提示词, LLM, 多维表格 |

---

## 10. UI 与 CSS（**只借结构与交互，不移植视觉**）

> ⚠️ **约束（2026-02 明确）**：前端 UI 设计语言沿用 **NOVAI 自有体系**，不得套用 DX OS 的外观。
> 因此下面提取的 DOM 结构、尺寸、交互（双击编辑等）**照搬**；
> 而 §10 的 CSS 规则与 §19 的面板 CSS **只作为布局参考**，实际样式用 `marvis-shared.css` 的设计令牌
> 按 NOVAI 的视觉语言重写。**91 条 CSS 不是移植清单，是结构参考。**
> DXOS 变量 → NOVAI 令牌的映射表仍有用（用于理解每条规则表达的是哪种语义，如"边框""次要文字"）。

### 表格节点

```html
<div class="table-node">
  <header class="table-node-meta" title="拖动表格">
    <span>{icon}</span><b>多维表格</b>
    <small>{行数} × {列数} · {N} 个输入</small>
  </header>
  <div class="table-node-grid [scrollable]">
    <table>
      <colgroup>
        <col class="table-input-column">      <!-- 112px -->
        <col v-for="列"><col class="table-actions-column">
      </colgroup>
      <thead><tr>
        <th class="table-input-head"><span>输入 N</span></th>
        <th><input><button class="table-delete-column">×</button></th>
        <th class="table-actions-head"></th>
      </tr></thead>
      <tbody><tr>
        <td class="table-media-cell"> <img|video|span+small> </td>
        <td class="table-text-output-cell"> <textarea|input> </td>
        <td class="table-row-actions"><button>…</button></td>
      </tr></tbody>
    </table>
  </div>
</div>
```

### 生成节点的批量面板

```html
<header><b>生成输入</b><div><span>{icon}</span><b>{名称}</b></div></header>
<div><span>批量 N 行 · 首批 X</span> | <span>独立运行 · 已选 A/B</span>
     <span class="is-image">图片 N</span> …</div>
<div class="generation-table-batch-list">
  <article class="generation-table-batch-row [is-concurrent] [is-selectable]">
    <b>{行号}</b>
    <div>{该行媒体缩略图}</div>
    <p>{该行提示词预览 || "仅媒体输入"}</p>
  </article>
</div>
<div class="np-table-batch-inline" title="表格共 N 行，当前将执行 M 个任务">
  <span class="np-table-batch-icon"></span>
  <label><span>并发数</span><input type="number" min=1 value=N></label>
  <label><span>起始行</span><input type="number" min=1 max=N><small>/ N</small></label>
  <button class="np-table-manual-toggle [on]">独立运行</button>
</div>
```

### CSS

- 表格节点：`.table-node*` `.table-input-*` `.table-media-*` `.table-text-output` `.table-delete-column`
  `.table-actions-*` `.table-row-actions` `.table-port-dot` `.table-channel-port` —— **50 条规则**
- 生成面板：`.generation-table-batch-*` `.generation-table-row-*` `.np-table-batch-*` `.np-table-manual-toggle`
- 源文件：`assets/Dnh6Zfeg.css`（423KB，canvas app 主样式表）
- **只依赖 11 个变量**，映射到 NOVAI 令牌：

| DXOS | NOVAI |
|---|---|
| `--ink` | `--text` |
| `--ink-soft` | `--text-2` |
| `--ink-faint` | `--text-3` |
| `--line` | `--border` |
| `--accent` | `--accent` |
| `--canvas-empty-surface` | `--surface` |
| `--canvas-param-fill` | `--surface-2` |
| `--canvas-param-hover` | `--nav-hover-bg` |
| `--canvas-card-shadow` | `--shadow-md` |
| `--danger` | `--danger` |
| `--font` | `--font-sans` |

---

## 11. 错误与提示文案（原样）

**表格操作**
- `表格最多允许 200 列。` / `表格最多允许 5000 行。`
- `列名“X”不唯一。` / `不存在列“X”。`
- `行序号必须是 1–N。` / `列序号必须是 1–N。`
- `表格节点不支持操作：X`
- `表格操作未能保存，请检查画布保存状态。`
- `多维表格无法连接到生成节点。`

**LLM → 表格**
- `模型没有返回统一的多维表格格式`
- `模型返回的表格列名不完整`
- `缺少多维表格输出`
- `LLM 没有生成可执行的多维表格。`
- `LLM 表格工作流需要拆分任务的文字要求。`

**批量执行**
- `请先点击上方行，选择至少一行独立运行`
- `起始行超出表格范围，当前共 N 行`
- `起始行之后没有可生成的内容`
- `请先选择 ComfyUI 工作流` / `请先选择 RunningHub AI 应用` / `请先选择 RunningHub 工作流`
- `还没有可用的图像模型，请在「API 设置」里添加`（音频/视频同构）
- `已开始批量生成：N 行，并发 M`
- `批量生成仍有 N 行正在后台恢复，请等待完成后再次恢复 Graph。`
- `找不到与当前表格输入匹配的批量生成 journal：RUNID`
- `仅媒体输入`（行预览无文本时的占位）

---

## 13. 结果回写（生成结果怎么进画布）

```js
// 每个结果 → 一张独立卡片，归入结果组，并标记它来自表格的哪一行
ke.params.protocolParams = {
  generatedFrom: 生成节点.id,
  generationEntity: "result-item",
  generationTaskId: 任务.id,
  generationOutputKey: Qv(结果),            // 输出指纹
  generationDurationMs: snapshot.durationMs,
  ...(有行号 ? {tableRow: 行号} : {}),        // ← 表格行号（批量时才有）
};
ke.run = {status:"ready"};

// 结果组：把该任务的多个结果卡归到同一个 group
a.normalizeResultGroup(分组, 生成节点.id);
const ue = cards.filter(c => c.groupId === 分组.id);

// ⭐ 幂等去重：同任务 + 同输出指纹 已存在就不重复建卡
if(ue.some(v => v.params.protocolParams?.generationTaskId === 任务.id
             && v.params.protocolParams?.generationOutputKey === 指纹)) return;

// 占位卡：首个结果填进已有的 placeholder 卡；无结果则删掉占位卡
ke && J[0] ? a.setMedia(ke, J[0]) : (无结果 && 删除 ke)

// 文字结果
d.textResult = {artifactId, text, role:"result", prompt};
// 每个文字输出也建一张 prompt 卡，同样带 generationTaskId/OutputKey
```

## 14. 尺寸与布局

```js
Fie = 132   // 每列宽
Bie = 44    // 预留（操作列等）
qie = 38    // 表头高
Wie = 720   // 最大高度
Gie = 44    // 空表最小高度

Yw(t) = { width:  max(280, (输入列数 + 数据列数) * 132 + 44 + 2),
          height: 38 + Σ各行高 + 2 }
ns(t) = 自动尺寸：w = max(现有w, Yw.width)，h = min(720, Yw.height)

// 行高：按最长单元格折算行数
mR(items, {charactersPerLine=18, lineHeight=15, verticalPadding=24,
           textMinHeight=44, mediaMinHeight=84, maxHeight=160}) {
  总行数 = max(1, Σ 每个单元格按 18 字/行 折算的行数)
  return min(160, max(hasMedia ? 84 : 44, 24 + 总行数 * 15))
}
Xw(t, row, i) = mR([...数据列值, ...输入列文本值],
                   {hasMedia: 该行是否有媒体, mediaMinHeight:144, maxHeight:160})

// 新建节点布局：放源节点右侧 170px，y 取已有下游的最大值 + 42 避让
l6(canvas, 源, 新) = { 新.x = 源.x + 源.w + 170,
                       新.y = max(源.y + 源.h/2 - 新.h/2,
                                 ...已有下游.map(v => v.y + v.h + 42)) }
```

## 15. 单元格编辑状态机（`readonly` 由它控制）

```js
Wf(t,e)    = `${t.id}:header:${e}`        // 表头编辑态 key
Zf(t,e,i)  = `${t.id}:cell:${e}:${i}`    // 单元格编辑态 key
u1(x)      = (当前编辑态 === x)

// 单元格默认 readonly；**双击**才进入编辑
Tb(event, node, key) = { 阻止冒泡 → 选中节点 → 当前编辑态 = key
                         → await nextTick() → el.focus({preventScroll:true}) }
Lb(key)    = 失焦 → 退出编辑态
Eb(event) = Esc  → el.blur()
$b(event,key) = 处于编辑态时阻止 pointerdown 冒泡

// 模板里：
<input :readonly="!u1(Wf(s,i))"  @dblclick="Tb($event,s,Wf(s,i))" ... />
<textarea :readonly="!u1(Zf(s,row,i))" @dblclick="Tb($event,s,Zf(s,row,i))" ... />
```

**注意：表格单元格默认只读，双击才可编辑。** 这不是可选细节——单击/拖动不应该进入编辑。

## 16. 表格输入同步 `X0(t)`

```js
function X0(t){                                    // t.kind === "table"
  let e = Co(t); e.length || (q0(t), e = Co(t));
  const i = e.map(pe => ({id:pe.id, mode:pe.mode, items:[]}));   // 新通道骨架
  const p = (未标记 connection-driven) && tablePinnedInputChannels ? 钉住的通道 : [];
  for (通道 of p) {                                 // ① 钉住的通道
    const F = max(0, e.findIndex(x => x.id === pe.id));
    for (B of pe.nodeIds) {
      const ie = t.inputs.find(x => x.nodeId===B) || cards.map(so).find(x => x?.nodeId===B);
      if (ie && i[F]) { i[F].items.push({type:"media", nodeId:B}); l.push(Va(ie)); }
    }
  }
  let h = p.length ? [] : tablePinnedInputNodeIds;   // ② 钉住的节点
  let k = tablePinnedInputCardIds;
  if (!p.length && !h.length && llmGeneratedOutput === true) {
    // ③ LLM 生成的表格：从 flow 上游的 LLM 节点推断图片输入
    const pe = connections.find(c => c.to===t.id && c.kind==="flow");
    const F  = pe ? cards.find(c => c.id===pe.from && c.kind==="llm") : null;
    const B  = F?.inputs.filter(i => i.kind==="image") || [];
    if (F && B.length) { h = B.map(i=>i.nodeId); k = F0(F,B).map(i=>i.id); ib(F,t,...) }
  }
  ...
}
```

**优先级**：钉住的通道 > 钉住的节点 > LLM 上游推断 > `t.inputs`。

## 17. 修复重试的完整代码

```js
let y = null;
if (outputMode === "list") {
  try { y = a6(结果文本) }                              // 解析校验
  catch {
    await onStage?.("repairing", {plan});               // llmRunStage = "repairing"
    w = await generateText({
      canvasId, prompt: CR(plan, 结果文本), providerId, model,
      params: { max_tokens: 8192 },                     // ← 修复用 8192
    });
    y = a6(w.text);
  }
}
return { result: w, tableOutput: y, plan };
```

## 18. 建连线辅助 `oh`

```js
function oh(canvas, from, to, ctx, kind, toPort) {
  if (canvas.connections.some(c => c.from===from && c.to===to && c.kind===kind && c.toPort===toPort)) return;
  canvas.connections.push({ id: ctx.createConnectionId(), from, to, kind, ...(toPort?{toPort}:{}) });
}
```

连线语义：`kind:"flow"`（LLM→表格、文本→节点）与 `kind:"ref"`（素材→表格输入列，必须带 `toPort:"input-N"`）。

---

## 19. 生成节点批量面板 CSS（41 条，可直接移植）

依赖变量（映射见 §10）：`--line-soft` → `--border`，`--canvas-param-fill` → `--surface-2`，
`--canvas-composer-line` → `--border`，`--canvas-input-surface` → `--surface-2`，
`--ink` → `--text`，`--ink-soft` → `--text-2`，`--solid` → `--bg`，`--accent` → `--accent`。

```css
.generation-table-batch-list{min-width:0;max-height:520px;display:grid;gap:6px;overflow:auto;padding-right:2px;scrollbar-width:thin}

.generation-table-batch-row{min-width:0;min-height:54px;display:grid;grid-template-columns:20px minmax(58px,30%) minmax(0,1fr);align-items:center;gap:7px;padding:6px;box-sizing:border-box;border:1px solid var(--line-soft);border-radius:10px;background:color-mix(in srgb,var(--canvas-param-fill) 58%,transparent);transition:border-color .14s ease,background .14s ease}

.generation-table-batch-row.is-concurrent{border-color:color-mix(in srgb,var(--accent) 40%,var(--line-soft));background:color-mix(in srgb,var(--accent) 6%,var(--canvas-param-fill))}

.generation-table-row-number{display:grid;width:18px;height:18px;place-items:center;border-radius:6px;background:var(--ink);color:var(--solid);font-size:8px;line-height:1}

.generation-table-batch-row.is-concurrent .generation-table-row-number{background:var(--accent);color:#fff}

.generation-table-row-media{min-width:0;display:flex;gap:3px;overflow-x:auto;scrollbar-width:thin}
.generation-table-row-media>span{width:42px;height:42px;flex:0 0 42px;display:grid;place-items:center;overflow:hidden;border-radius:8px;background:var(--canvas-param-fill)}
.generation-table-row-media img,.generation-table-row-media video{width:100%;height:100%;object-fit:cover}
.generation-table-row-media i{display:grid;width:100%;height:100%;place-items:center;color:var(--ink-soft)}
.generation-table-row-media i svg{width:18px;height:18px;fill:currentColor}

.generation-table-batch-row>p{min-width:0;max-height:48px;margin:0;overflow:hidden;color:var(--ink-soft);font-size:9px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}

.generation-table-batch-row.is-selectable{cursor:pointer;user-select:none}
.generation-table-batch-row.is-selectable:hover{border-color:color-mix(in srgb,var(--accent) 28%,var(--line-soft));background:color-mix(in srgb,var(--accent) 3%,var(--canvas-param-fill))}
.generation-table-batch-row.is-selectable.is-concurrent{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 11%,var(--canvas-param-fill));box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 24%,transparent)}

/* 另一处变体：composer 里的横向预览条 */
.table-batch-preview-track{min-width:0;flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;padding:1px 1px 3px;scrollbar-width:thin}
.table-batch-preview-item{width:252px;height:48px;flex:0 0 252px;display:grid;grid-template-columns:18px 82px minmax(0,1fr);align-items:center;gap:6px;padding:4px 6px;box-sizing:border-box;border:1px solid var(--canvas-composer-line);border-radius:9px;background:var(--canvas-param-fill)}
.table-batch-preview-item>b{display:grid;width:17px;height:17px;place-items:center;border-radius:5px;background:var(--ink);color:var(--solid);font-size:7.5px}
.table-batch-preview-media{min-width:0;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.table-batch-preview-media::-webkit-scrollbar{display:none}
.table-batch-preview-media>span{width:38px;height:38px;flex:0 0 38px;display:grid;place-items:center;overflow:hidden;border-radius:7px;background:var(--canvas-input-surface)}
.table-batch-preview-media img,.table-batch-preview-media video{width:100%;height:100%;object-fit:cover}
.table-batch-preview-media i{display:grid;width:100%;height:100%;place-items:center;color:var(--ink-soft)}
.table-batch-preview-media i svg{width:16px;height:16px;fill:currentColor}
.table-batch-preview-item>p{min-width:0;max-height:34px;margin:0;overflow:hidden;color:var(--ink-soft);font-size:8.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.table-batch-preview-item.is-concurrent{border-color:color-mix(in srgb,var(--accent) 42%,var(--canvas-composer-line));background:color-mix(in srgb,var(--accent) 6%,var(--canvas-param-fill))}
```

> 注意：`color-mix(in srgb, ...)` 需要 Chrome 111+ / Safari 16.2+。
> NOVAI 若需兼容更旧的浏览器，需把这些 `color-mix` 预计算成具体 rgba 值（11 个变量都是已知色）。

**至此 CSS 全部提取完毕：表格节点 50 条 + 生成面板 41 条 = 91 条规则（仅作结构参考，样式按 NOVAI 设计语言重写）。**

---

## 20. 另两套批量机制（与表格并列，Agent 驱动）

`canvas_run_batch_workflow` 有两个 patternId。**它们与表格无关**——每个任务建一个**独立生成节点**，
不经过表格。三者关系：

| 机制 | 扇出单元 | 产物 |
|---|---|---|
| 表格驱动（`table-image` / `llm-table-batch`） | 表格的**一行** | 生成节点逐行扇出 |
| `media-batch-edit` | **一张输入图** | 每图一个生成节点 |
| `reference-set-variants` | **主体 × 参考** 组合 | 每组合一个生成节点 |

### 任务规划器 `_D(n)`

```js
function _D(n){
  const a = 去重(n.inputNodeIds), r = 去重(n.subjectNodeIds), d = 去重(n.referenceNodeIds);
  const c = n.patternId === "media-batch-edit"
    ? a.map(w => ({subjectNodeId:w, sourceNodeIds:[w]}))                       // 每图一个
    : r.flatMap(w => d.filter(y => y !== w)                                  // 主体 × 参考
                     .map(y => ({subjectNodeId:w, referenceNodeId:y, sourceNodeIds:[w,y]})));
  const v = Math.max(1, Math.floor(n.maxJobs));
  if(c.length > v) throw new Error(`Canvas batch workflow planned ${c.length} jobs; limit is ${v}.`);
  return c;
}
```

调用点：`maxJobs: 20` ← **批量任务上限 20**。

### 分组展开 `Tg(ids, kind)`

递归展开分组（`group`）为叶子节点，只保留指定 kind（`"image"`）。

### 执行器

```js
for (const [i, job] of jobs.entries()) {
  const anchor = job.reference || job.subject;
  const gen = await es("image", anchor.x + anchor.w + 220, anchor.y + anchor.h/2);  // 每 job 一个生成节点
  Ag(canvas, gen, job.sources);                                                     // 连接 sources
  gen.title = patternId === "media-batch-edit"
    ? `批量编辑 · ${job.subject.title || i+1}`
    : `参考设计 · ${job.reference?.title || i+1}`;
  gen.params.prompt = patternId === "reference-set-variants"
    ? "输入图片 1 是必须保持身份、外观、结构和品牌一致的主体/产品；" +
      "输入图片 2 只用于参考风格、版式、构图、光线或视觉语言，不得替换主体。" + 用户提示词
    : 用户提示词;
  gen.params.protocolParams = {
    ...透传(args, ["patternId","prompt","autoModel","ratio","resolution","quality","requestId"]),
    canvasAgentBatch: true,
    batchPatternId: patternId,
    batchIndex: i + 1,                    // 1-based
    batchExpectedCount: jobs.length,
    batchSubjectNodeId: job.subject.id,
    ...(job.reference ? {batchReferenceNodeId: job.reference.id} : {}),
  };
  if (args.autoModel !== false) await 自动选模型(gen, "image", job.sources, {resolution});
  应用参数(gen, args);
}

// ⭐ 并发执行：上限 4，默认 3
const conc = Math.max(1, Math.min(4, Math.floor(args.maxConcurrency || 3), jobs.length));
let cursor = 0;
const worker = async () => {
  for (; cursor < jobs.length && !aborted; ) {
    const job = jobs[cursor++];
    try { await 运行(job.generator); if (job.generator.run.status === "error") throw ... }
    catch (e) { failed.push({subjectNodeId:job.subject.id, ...(job.reference?{referenceNodeId:job.reference.id}:{}), message:String(e.message||e)}); }
  }
};
await Promise.all(Array.from({length: conc}, () => worker()));
```

### ⭐ 结果核对（三重校验）

```js
const created  = cards.filter(c => !before.has(c.id)).map(c => c.id);
const images   = 收集图片产物(created).filter(c => c.kind === "image");
const success  = jobs.length - failed.length;

if (failed.length || images.length < success) {
  throw new Error(`多图工作流未全部完成：计划 ${jobs.length}，成功 ${success}，失败 ${failed.length}，` +
    `实际图片产物 ${images.length}${失败清单?'; 失败任务 '+失败清单:''}。` +
    `重试时只传失败的主体/参考节点，避免重复已成功任务。`);
}
```

**注意**：不只是看"没报错"，还**核对实际产出的图片数量**。少于成功数就整体判失败，并给出
"只重传失败节点"的指引——这是一套**防重复扣费**的设计。

### 提示词模板（`reference-set-variants` 固定前缀）

> 输入图片 1 是必须保持身份、外观、结构和品牌一致的主体/产品；输入图片 2 只用于参考风格、版式、构图、光线或视觉语言，不得替换主体。

### 报错文案

- `不支持的多图工作流：X`
- `多图工作流需要明确提示词。`
- `框选节点或输入分组中没有可逐图编辑的图片。`
- `参考组变体工作流缺少主体/产品图片。`
- `参考组变体工作流缺少参考图片或参考分组。`
- `无法为第 N 个任务创建图片生成节点。`
- `生成节点不接受输入“X”。`
- `Canvas batch workflow planned N jobs; limit is 20.`（原文英文）
- `多图工作流未全部完成：计划 N，成功 A，失败 B，实际图片产物 C；失败任务 X+Y。重试时只传失败的主体/参考节点，避免重复已成功任务。`
- `当前画布没有编辑权限，无法修改节点。`

### 成功文案

- `已逐图完成 N 张图片的批量编辑，每张图片使用独立生成节点。`
- `已用 N 张参考图为 M 个主体生成 K 个独立设计结果。`




---

## 12. 与我已实现部分的差距

| 机制 | DXOS | 当前 NOVAI 实现 | 处置 |
|---|---|---|---|
| 数据模型 | `columns/rows/selectedRows/mergedGroups` | 已按此实现（`table-grid.js`） | ✅ 一致 |
| 常量上限 | 200/5000/20000 | 已照搬 | ✅ |
| 报错文案 | 见 §11 | 已照搬表格操作部分 | ✅ |
| 提示词来源 | 上游文本 + 节点提示词 + **行文本追加** | `{列名}` 模板替换 | ❌ 需重做 |
| 引用语法 | `@图片1` mention（`L7`） | 无 | ❌ 需实现 |
| 输入列 | `tableInputChannels` + `mode` + `toPort` 落列 | 无 | ❌ 需实现 |
| 逐行参考图 | 输入列 media（sequence/shared） | 仅全行共用 | ❌ 需实现 |
| journal 续跑 | `generationBatchJournal` | **无** | ❌ 需实现（最要紧） |
| 失败策略 | `stop`/`continue` | 无 | ❌ |
| 并发 worker | 共享游标 + N worker | 后端 Run 并发 | ⚠️ 机制不同 |
| 素材校验 | 公网链接 missing/expired | 无 | ❌ |
| 前置提示 | 逐层明确 | 通用报错 | ❌ |
| 手工上限 vs LLM 上限 | 200/5000 vs 40/200 | 只有一套 | ❌ |
| 预设模板 | 4 个（含「多维表格批量出图」） | 无 | ❌ |
| UI/CSS | 50 条规则可移植 | 手写 `.dtable-*` | ❌ 需替换 |
| LLM 两遍（规划→生成→修复） | `FS`/`BS`/`CR`/`a6` | 无 | ❌ |
