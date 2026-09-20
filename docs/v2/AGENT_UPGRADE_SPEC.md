# NOVAI 智能画布 · AI 助手升级 · 接口契约 v1（真 agent 循环 + SSE 流式）

> 状态：后端已实现（`main.py`）。前端接入见第 6 节。
> 实现位置：`main.py` 中「Agent 真·循环（POST /api/agent/run · SSE 流式）」代码块，
> 位于原有 `/api/agent/sessions/{id}` 之后、T05 素材路由 bind 之前。

## 0. 与老接口的关系

| 接口 | 状态 |
| --- | --- |
| `POST /api/agent/plan` | 行为与响应格式**完全不变**（`static/gpt-chat.html` 在用） |
| `POST /api/agent/preview` | 完全不变 |
| `POST /api/agent/apply` | 完全不变 |
| `POST /api/agent/rollback` | 完全不变 |
| `GET /api/agent/sessions`、`GET /api/agent/sessions/{id}` | 完全不变（run 记录复用同一存储） |
| `POST /api/agent/run` | **新增**，唯一的增量 |

本次改动对 `main.py` 是纯新增代码块，没有修改任何既有函数/端点。

## 1. 请求

```http
POST /api/agent/run
Content-Type: application/json
```

```json
{
  "canvas_id": "string 必填",
  "instruction": "string 必填 1..4000",
  "focus": {
    "selected_node_ids": ["n_1", "n_2"],
    "reference_images": ["https://..."],
    "reference_videos": ["https://..."],
    "viewport": {"x": 0, "y": 0, "scale": 1}
  },
  "provider": "comfly",
  "model": "",
  "ms_model": "",
  "max_steps": 12
}
```

* `focus` 可为空对象、可省略、可以是 `null`；它是「用户此刻的注意力」提示，后端**不据此做任何正确性判断**，
  只在 system prompt 里标注（选中节点会核对是否真实存在，不存在的单独提示「可能已过期」）。
* 画布权威状态一律由后端 `load_canvas(canvas_id)` 读取，不信任前端传来的图。
* `max_steps` 会被收敛到 `1..24`（默认 12），`run_start` 里回显的是生效值。
* 请求阶段的错误直接用 HTTP 状态码返回（此时还没开始流）：
  * 画布不存在/已删除 → 404 `{"detail":"画布不存在"}`
  * `instruction` 为空 → 422（pydantic 校验）
  * 没有任何可用对话模型 → 400 `{"detail":"无法运行 Agent（对话模型不可用）：…"}`

  → 前端遇到非 200 时回退到原来的聊天逻辑。

## 2. 响应：SSE 事件流

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

格式：`event: <名>` + `data: <json>` + 空行；首个事件之前没有任何其它输出。

| event | data 字段 | 说明 |
| --- | --- | --- |
| `run_start` | `run_id`, `canvas_id`, `model`, `max_steps` | 流的第一条事件 |
| `plan` | `intent`, `steps[{index,tool,args,description}]`, `round` | 每轮模型给出计划后发一次 |
| `round_start` | `round` | 第 2 轮及以后，在调用模型**之前**发 |
| `step_start` | `index`, `tool`, `args`, `description` | 即将执行某一步 |
| `step_result`（成功） | `index`, `tool`, `ok:true`, `result`, `message`, 可选 `canvas_ops` | 执行成功 |
| `step_result`（失败） | `index`, `tool`, `ok:false`, `error`, `code`, `retryable` | 执行失败（不中断流，错误回灌模型） |
| `message` | `text` | 模型给用户的总结（气泡） |
| `confirm_required` | `index`, `tool`, `args`, `reason` | 删除类/force 类步骤被跳过（一期不做交互确认） |
| `done` | `run_id`, `status`(ok/failed/aborted), `steps_executed`, `rounds`, `message` | 流的最后一条事件 |
| `error` | `message`, `code` | 致命错误（后面仍会跟一条 `done`） |

心跳：**连续 15 秒没有任何事件**时发一行注释 `\n: ping\n\n`（客户端会忽略），防止代理/浏览器空闲断连。

### index 语义

`index` 是**整个 run 内全局递增**的（从 0 开始），同一轮里 `plan.steps[].index` 与该步
`step_start`/`step_result` 的 `index` 一致；跳过的步骤（confirm / 连续失败）也会占用一个 index。
前端按 index 关联「正在执行 → 完成/失败」即可，不会跨轮撞号。

### canvas_ops

```json
{
  "nodes_upsert": ["完整节点对象…"],
  "nodes_remove": ["id"],
  "connections_upsert": ["完整连线对象…"],
  "connections_remove": [{"from": "a", "to": "b"}]
}
```

* 由「该步执行前 / 执行后」后端真实画布快照做差集得到，**精确**。
* 只读工具（list_canvases / get_canvas / use_asset / check_task）或没有实际变化时，
  **整个 `canvas_ops` 字段被省略**（不是空对象，更不会瞎编）。
* 前端可在 `step_result` 到达时立即应用到本地 `nodes/connections` 并重绘；`done` 后再做一次权威刷新。

## 3. 循环规则（服务端）

1. 每轮把 ①用户指令 ②最新画布摘要 ③本轮之前已执行的步骤与结果摘要（成功给关键返回字段，
   失败给 `error`+`code`）④最近一次失败原因 ⑤focus 回灌模型；模型返回：
   `{"thought":"…","steps":[{…}],"done":false,"message":""}` 或 `{"done":true,"message":"给用户的总结"}`。
2. 上限：`max_steps`（默认 12，硬上限 24）+ 最多 **6 轮**模型调用；超限立即 `done`，
   `status:"aborted"`，message 说明中断原因。
3. 工具失败：错误回灌模型允许换招；**同一 `tool+args` 连续失败 2 次**后，后续相同调用直接发
   `step_result(ok:false, code:"skipped_after_failures")` 跳过，继续后面的步骤。
4. **连续两轮没有任何成功步骤** → 结束，`status:"failed"`，message 如实说明（不会死循环）。
5. 删除类（`delete_node` / 名字以 `delete` 开头）或 `args.force=true` 的步骤：发 `confirm_required`
   后**跳过该步**（一期不做交互确认），其余步骤继续；`done.message` 里列出跳过了哪几步。
6. `retryable` 判定：`code` 属于 {unknown_tool, invalid_args, node_not_found, canvas_not_found,
   task_not_found, references_exist} → `false`，其余 → `true`。
7. 模型连续两轮不可用（上游报错/返回非法 JSON）→ `status:"failed"`，`error` 事件后跟 `done`。

### run 记录

每次 run 都会写进现有 session 存储（`data/agent_sessions/*.json`，格式不变）：

* 复用：`session_id` / `canvas_id` / `instruction` / `intent` / `plan.steps` / `execution_log` /
  `status` / `version` / `created_at` / `updated_at`
* 新增：`run_id` / `mode:"run"` / `focus` / `run_status`(ok|failed|aborted) / `rounds` /
  `steps_executed` / `message` / `finished_at`
* `status` 取值：ok→`applied`、failed→`failed`、aborted→`aborted`（老字段语义兼容）
* 画布真的被改动过时，run 结束会存一次画布版本快照并广播 `canvas_updated`（与 apply 一致，可回滚）

## 4. 实测 curl

```bash
# 拿真实画布 ID
curl -s http://127.0.0.1:3333/api/canvases

# 真 agent 循环（SSE）
curl -N -X POST http://127.0.0.1:3333/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"canvas_id":"<真实画布ID>","instruction":"画一只猫"}'

# 指定 provider / model / 步数上限，并带上结构化 focus
curl -N -X POST http://127.0.0.1:3333/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"canvas_id":"<真实画布ID>","instruction":"把选中的图改成赛博朋克风格","focus":{"selected_node_ids":["<真实节点ID>"],"reference_images":[],"reference_videos":[],"viewport":{"x":0,"y":0,"scale":1}},"provider":"agnes-ai","model":"agnes-2.5-pro","max_steps":6}'

# 查 run 记录
curl -s http://127.0.0.1:3333/api/agent/sessions/<session_id>
```

## 5. 前端接入（原生 JS，无构建）

* 把 `buildCanvasContextSummary()` 的自然语言摘要换成结构化 focus（多选必须走 `selectedNodeIds()`，
  不要再用单数的 `selectedNode()`）。
* 必须用 `fetch('/api/agent/run')` + `resp.body.getReader()` 手写 SSE 解析（`EventSource` 不支持 POST，
  禁止使用），并处理跨 chunk 的半行（按空行切块，剩余部分留在 buffer 里）。
* 事件处理：`step_start` → 面板插入「正在执行：description（tool）」；`step_result(ok)` → 更新为完成态，
  **立即**把 `canvas_ops` 应用到本地 `nodes/connections` 并复用现有渲染函数重绘；
  `step_result(fail)` → 显示原因但不中断流；`message` → 助手气泡；`done` → 权威刷新 + 结束运行态 + 恢复输入框。
* `confirm_required` → 面板提示「已跳过（需确认）」。
* 出错/断流要如实提示；`/api/agent/run` 返回非 200（如 400 无可用模型）时回退原聊天逻辑。

## 6. 验证记录（端口 3333）

```
python -m py_compile main.py              → OK
POST /api/agent/run（画一只猫，指定 agnes-2.5-pro）
                                          → run_start → plan → step_start → step_result(+canvas_ops: 2 节点 1 连线)
                                            → round_start×5 → check_task×4 → message → done(ok, 5 步 6 轮)
                                            画布上真实出现 prompt 节点 + image 节点与连线，图片任务 succeeded
删除+新建混合指令                          → confirm_required(delete_node 跳过) → create_node 成功 → done(ok)，message 列出跳过项
max_steps=1                               → done(aborted, "已达到最大步数上限 1")
客户端中途断开                             → 服务端 done(aborted, "客户端断开连接，运行已取消")，会话落盘
POST /api/agent/plan|preview|apply|rollback → 全部 200，响应结构与改动前一致
心跳（桩生产者空闲 16.5s）                 → 15.0s 收到注释行 ": ping"
前端解析器联调（node 提取 __SSE_PARSER_START__ 段，7 字节小块喂真实流）→ 23/23 事件全解析、0 丢帧
```

### 环境备注（与代码无关）

* 环境里可用的对话 provider 只有 `agnes-ai` / `lingjing`（同一聚合账号）。其默认首选模型
  `agnes-2.0-flash` 常年报 "API rate limit for free users"，因此**不带 provider/model 的裸命令**
  会走到 `error(provider_http_error) → done(failed)`（如实报错，不伪造）；显式指定
  `{"provider":"agnes-ai","model":"agnes-2.5-pro"}` 即可完整跑通。
* `modelscope` / `runninghub` / `volcengine` 在本机没有可用聊天模型配置，会被自动跳过。
