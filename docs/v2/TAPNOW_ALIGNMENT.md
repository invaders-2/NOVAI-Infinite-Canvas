# TapNow 对齐说明（画布助手 Agent 运行时）

对照对象：TapNow 前端（app.tapnow.ai，React SPA）与我们抓包看到的 run 事件模型。
本文只写事实与落点：每条结论都能在下面列出的文件/函数里找到对应实现。

行号取自当前工作树，会随后续改动漂移——检索时以函数名为准。

## 1. 对齐目标与范围

### 1.1 对齐了什么

- **run 事件模型**：一条 run 从开始到结束的 SSE 流带递增序号，可断线重连、按序号续传；
- **交互方式**：运行中插话（排队到下一轮，不打断当前轮）、方案卡确认后再执行；
- **展示语义**：会话状态机、part 类型、计时（思考/整轮，跨轮累计不重置）、上下文占用指示、技能挂载、引用带身份（role）。

### 1.2 明确不抄什么

| TapNow 的东西 | 我们的决定 | 事实依据 |
| --- | --- | --- |
| connectors（第三方账号 OAuth 接入） | 不做 | 仓库里没有 connector 认证/授权链路（只有一个素材工具目录 `tools/photoshop-asset-connector/`，不是账号接入） |
| 插件市场（上架、安装、分发） | 不做 | 画布助手工具集固定为 `main.AGENT_TOOLS`（22 个）+ 命令表 `server/agents/cli_spec.py`（26 条命令） |
| App 沙箱 iframe（第三方 UI 以 iframe 沙箱内嵌运行） | 不做 | `static/` 下 `sandbox=` 零命中；仓库有 `apps/` + `server/appRegistry.py`（`GET /api/apps`、`POST /api/apps/invoke`，进程内调用），不提供 iframe 隔离 |
| 分支对话（从任意消息分叉出多条会话） | 不做 | 会话按画布单线程持久化：`AGENT_THREADS_DIR = DATA_DIR/agent_threads/{canvas_id}.json`（`agent_thread_load` / `agent_thread_append`），一轮 run 只在末尾追加一条 assistant 记录 |

## 2. 机制对照表

| TapNow 观察 | 本仓库实现 | 位置（文件 · 函数） |
| --- | --- | --- |
| 每个 run 的事件流带递增 id，客户端断线后能接着收 | 进程内总线：每个 run 一条 `{events, subs, done, next_seq, steer}`，事件帧带 `id: <seq>`，seq 从 1 递增、丢最旧事件也不回退 | `main.py` · `_agent_run_bus_new` / `_agent_run_bus_publish`（约 36379 行）/ `_agent_sse_event`（约 34590 行） |
| 断线后按游标重放，已结束的 run 重放完即收尾 | `GET /api/agent/runs/{run_id}/stream?after=N`：先订阅再回放，重放 `seq>after` 再接实时；`bus.done` 为真时回放完直接结束 | `main.py` · `agent_run_stream`（约 36896 行）/ `_agent_run_bus_stream`（约 36424 行）/ `_agent_run_bus_events_after` |
| 前端 EventSource 带 `Last-Event-ID` 自动续传 | 端点同时认 `after` 查询参数与 `Last-Event-ID` 头（逗号分隔取最后一个） | `main.py` · `agent_run_stream`（`Header(alias="Last-Event-ID")`） |
| 前端记录游标、只应用更新的帧 | `state.lastEventId` 由每个事件的 `id` 更新；续传前记游标、重放时只应用比游标新的帧；断流自动退避重连 | `static/js/shared/agent-session.js` · `applyEvent`（约 307 行，游标 311-313）；`static/js/smart-canvas.js` · `resumeAfter`(9753) / 游标去重(9756) / `/stream?after=` 重连(9829) / `agentResumeDelay`(8163) |
| 运行中可插话，排队到下一轮 | `POST /api/agent/runs/{run_id}/steer` → 入队（上限 10）→ producer 每轮开头 drain：发 `user_steer(status=placed)` 并把文本拼进本轮 user 提示词末尾；收尾仍没读到的发 `user_steer(status=unread)` + `done.unread_steer` | `main.py` · `_agent_run_bus_push_steer` / `_agent_run_bus_drain_steer` / `_agent_run_producer`（drain 在构造 user_text 之前）；前端 `handleAgentSteerEvent`(8302) / `sendAgentSteer`(8318) |
| 会话状态机（idle/streaming/等待用户/终态） | `streamState`：`idle`→`streaming`→`waiting_user_input` 或终态；终态集合 `completed/failed/stopped/ended_unknown`，等待集合 `waiting_user_input/waiting_external`；未知事件忽略 | `static/js/shared/agent-session.js` · `create`(52) / `applyEvent`(307) / `TERMINAL_STATUSES`(9) / `WAITING_STATUSES`(10) |
| part 类型决定渲染 | 事件落到 part：`thinking`(连续思考可合并+累计时长) / `text` / `tool_event` / `usage` / `user_steer` / `run_outcome` / `agent_error`；方案卡与执行详情由 smart-canvas 渲染，插话行显示「已插话：…」 | `agent-session.js` · `applyEvent` 各分支（`mergeThinking` 273）；`smart-canvas.js` · 运行行渲染（`已插话：` 8619） |
| 计时在等待/终态时冻结，跨轮累计 | `runActivity{startedAt, frozenMs, frozen}`：`freezeActivity` 冻结并累计，`run_start` 以已有 `frozenMs` 为基线继续累，`done/error` 调 `settleActivity` 落 `activeWorkMs`；思考 part 另有 `totalDurationMs` 合并累计 | `agent-session.js` · `activityElapsed`(219) / `freezeActivity`(224) / `settleActivity`(234) / `run_start` 基线(321) / `done.activeWorkMs`(452)；`smart-canvas.js` · `agentPlanTimeMs`(8455) / `formatWorkMs` |
| 上下文占用百分比 | 后端每轮估 token 并下发 `context_usage`；窗口上限按优先级解析，取不到给 0（前端只显示绝对值） | `main.py` · `_agent_estimate_tokens`(约 36228) / `_agent_run_context_max`(约 36278) / `_agent_context_window_default`；前端 `agent-session.js` · `context_usage` 分支(401) |
| 技能（Skill）挂载到一次运行 | 请求 `skill_id` → 校验 `enabled` → 把技能段落追加到 system prompt 末尾（20000 字截断） | `main.py` · `_agent_require_skill`(36019) / `_agent_skill_prompt_block`(36029) / `_CanvasRunContext.build_system_prompt`；注册表 `server/skills/registry.py` · `get_skill` |
| 引用带身份（这张图当主体/风格/首帧） | `focus.references=[{id,name,role,source}]`：清洗（role/source 白名单、按 id 去重、最多 12 条）→ 提示词里逐条输出 `{{node/<id>}}｜role=…｜type=…｜标题=…`；图片按 references 顺序进「看图」列表 | `main.py` · `_agent_run_normalize_references`(34613) / `_agent_run_normalize_focus`(34639) / `_agent_run_focus_text`(34713) / `_agent_run_collect_images`(35547) |
| （附带）模型侧只调一条命令 | `canvas_cli` 外壳：`command` enum 来自 26 条命令表；步骤在 `_agent_run_normalize_steps` 里展开成真实工具名后才进确认闸门 | `server/agents/canvas_cli.py` · `TOOL_NAME`(22) / `build_tool_entry`(105) / `expand_step`(130)；`main.py` · `_agent_run_normalize_steps`(34846)；命令表 `server/agents/cli_spec.py` · `COMMANDS` |

## 3. 接口清单

### 3.1 POST /api/agent/run

请求（`AgentRunRequest`，JSON 顶层）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `canvas_id` | str | 必填 |
| `instruction` | str | 1..4000 字 |
| `focus` | object | `selected_node_ids` / `reference_images` / `reference_videos` / `references` / `viewport` |
| `history` | array | `[{role, text}]`，只认 user/assistant |
| `provider` / `model` / `ms_model` | str | 对话模型选择 |
| `image_provider` / `image_model` | str | 生图平台缺省值 |
| `max_steps` | int | 默认 12，上限 `AGENT_RUN_MAX_STEPS_CAP=24` |
| `mode` | str | `plan`（默认）/ `run` |
| `approved_steps` | array | 用户点「执行」带回来的步骤 |
| `skill_id` | str | 可选，最长 64；缺省空串 |

响应：`200 text/event-stream`，响应头含 `X-NOVAI-Run-Id: run_xxx`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
错误：`400` canvas_id/instruction 为空；`400 技能不存在或未启用：<id>`；`404` 画布不存在；`403` 无权限（见下）；对话模型不可用时 4xx。

画布级权限：`load_canvas` 之后、开流之前调 `require_canvas_access(canvas, request, "edit" if approved_steps else "view")`——带 `approved_steps`（用户点了「执行」）要可编辑权限，只出方案/只读要 view；auth-off 时自动放行。

### 3.2 GET /api/agent/runs/{run_id}/stream

查询参数 `after`（int，默认 0），或请求头 `Last-Event-ID`。先重放 `seq>after`，再接实时；run 已结束则重放完正常收尾。
错误：`404 run 不存在或已过期`（结束超过 10 分钟的 run 不再保留）；`403 无权访问该画布`（run 上记的画布对当前用户不可读）；画布已删则 `404 画布不存在`。

### 3.3 POST /api/agent/runs/{run_id}/steer

请求 `{"message": "..."}`（1..2000 字）。

| 情况 | 状态码 | 响应体 |
| --- | --- | --- |
| 正常入队 | 200 | `{"accepted": true, "pending": N}` |
| 空 / 超 2000 字 | 400 | `{"detail": "message 长度必须在 1..2000 字之间"}` |
| run 不存在/已过期 | 404 | `{"detail": "run 不存在或已过期"}` |
| 无编辑权限（viewer） | 403 | `{"detail": "需要可编辑权限"}` |
| run 已结束 | 409 | `{"error": "该运行已结束，无法插话"}` |
| 队列已满 10 条 | 409 | `{"error": "插话太频繁，请等本轮读完"}` |

### 3.4 SSE 帧格式与事件表

```text
id: 12
event: user_steer
data: {"status": "placed", "text": "背景换成夜景，比例 16:9", "id": "run_xxx:steer:1"}

: ping            ← 空闲 15 秒的心跳（AGENT_RUN_HEARTBEAT_SECONDS=15）
```

| 事件 | 关键字段 |
| --- | --- |
| `run_start` | `run_id` / `model` / `max_steps` / `canvas_id` |
| `context_usage` | `id` / `used_tokens` / `max_tokens` / `percentage` / `source="estimate"` / `round` |
| `plan` | `intent` / `steps` / `expected_output` / `impact` / `summary`（拦截时带 `requires_confirmation`、`blocked_tools`） |
| `step_start` / `step_result` | `index` / `tool` / `args`；结果带 `ok` / `error` / `code` |
| `round_start` | `round` |
| `message` | `text` |
| `user_steer` | `status`(placed/unread) / `text`（placed 带 `id`） |
| `confirm_required` / `vision` / `error` | 确认拦截 / 看图说明 / `message`+`code` |
| `done` | `run_id` / `status` / `steps_executed` / `rounds` / `message` / `changes` / `session_id` / `undoable` / `unread_steer` |

## 4. 运维与配置开关

| 项目 | 值 / 位置 | 说明 |
| --- | --- | --- |
| 窗口上限：显式 | `chat["context_max"]` | 最高优先级，测试/内部注入用 |
| 窗口上限：provider 配置 | `provider_cfg.context_max` | 在 API 设置的 provider 条目里加即可，正整数 |
| 窗口上限：按模型 | `provider_cfg.context_windows[model]` | 精确 key 匹配，正整数 |
| 窗口上限：环境变量 | `NOVAI_CONTEXT_MAX` | 正整数；非法值忽略 |
| 窗口上限：内置默认表 | `AGENT_CONTEXT_WINDOW_DEFAULTS`（main.py 约 36251 行） | 只收可核实值：`claude*` → 200000；其余 0，不猜 |
| 事件保留 | `AGENT_RUN_BUS_MAX_EVENTS=1000` / `AGENT_RUN_BUS_TTL_SECONDS=600` / `AGENT_RUN_BUS_MAX_FINISHED=200` | 每 run 留最近 1000 条；已结束的 run 留 10 分钟且最多 200 个，谁先到清谁；运行中的不清 |
| 插话上限 | `AGENT_RUN_STEER_MAX=10` / `AGENT_RUN_STEER_TEXT_MAX=2000` | 队列满 → 409 |
| 心跳 | `AGENT_RUN_HEARTBEAT_SECONDS=15` | 空闲发 `: ping` 注释帧 |
| 轮次/步数 | `AGENT_RUN_MAX_ROUNDS=6` / `AGENT_RUN_MAX_STEPS_CAP=24` | 超限以 `status=aborted` + 原因结束 |
| 总线生命周期 | 进程内字典 `_AGENT_RUN_BUS` | **单进程**；多 worker / 多机部署时续传会打到没有该 run 的进程 → 需要换外部存储（Redis 等） |
| 会话/线程落盘 | `DATA_DIR/agent_sessions/*.json`、`DATA_DIR/agent_threads/{canvas_id}.json` | 运行记录与画布会话分开存 |

## 5. 已知限制与未做项

1. **总线只在进程内**：多 worker、滚动重启、换机器都会丢失未结束的 run 与已结束 run 的重放窗口（10 分钟）。
2. **重放有时效**：超过 1000 条事件或超过 TTL/200 个 run 之后，旧 run 一律 404；没有冷存储回放。
3. **SSE 订阅队列无背压**：慢客户端的事件在内存队列里堆积（单 run 事件量小，但理论上无上限）。
4. **续传靠响应头**：`run_start` 还没到达就断线时，前端必须用 `X-NOVAI-Run-Id` 才能续传；该头是新增的，老调用方不会读它。
5. **上下文占用是估算**：CJK 每字 1 token、其它可见字符 4 字符 1 token，不引分词器，不是计费口径；看图时的图片 data URL 不计入估算。
6. **默认窗口表只有 claude**：其它模型不给百分比（`max_tokens=0` / `percentage=null`）；`context_windows` 只做精确 key 匹配，模型名大小写/前缀不一致就不命中。
7. **技能只接画布助手**：上传文件 agent（`FilesRunContext`）不挂技能；一次运行只支持一个 `skill_id`；技能说明超 20000 字直接截断；技能不能改变可用工具集。
8. **引用有上限**：一次最多 12 条；`source=upload` 的素材没有画布节点身份，也不会进入看图列表（后端拿不到该上传的 URL）；`collect_images` 每个节点只取第一张图，总量上限 `AGENT_VISION_MAX_IMAGES=4`。
9. **Agent 路由的画布权限依赖 bus 上的 canvas_id**：`/api/agent/run` 直接按 `load_canvas` 回来的画布判定；`/runs/{id}/stream`、`/runs/{id}/steer` 靠 `_agent_require_run_access` 取 bus 里记的 canvas_id 再判定（view / edit）。没有 canvas_id 的老 bus（历史数据/非画布上下文）直接放行——这是兼容性取舍，不是遗漏。
10. **插话只投放一次**：读到的插话只在本轮提示词里出现一次，之后靠模型自身的步骤结果延续；run 在读到前就结束时按 `unread` 如实回报（前端把文本放回输入框）。
11. **无分支对话**：一个画布一条线程，不能从历史某条消息分叉。
12. **未做**：connectors OAuth、插件市场、App 沙箱 iframe、多用户共享同一个 run、run 列表接口（只能凭 `run_id` 访问）。

## 6. 验证方式

```bash
# 1) 语法
python3 -m py_compile main.py

# 2) 本次相关 Python 单测（全部打桩，不连模型、不写真实画布）
python3 -m unittest tests.test_agent_run_stream tests.test_agent_run_steer tests.test_agent_context_usage \
    tests.test_agent_skill_prompt tests.test_agent_focus_references -v

# 3) 回归（画布助手核心 + 命令表）
python3 -m unittest tests.test_agent_canvas_p0 tests.test_agent_run_plan_mode tests.test_agent_run_history \
    tests.test_agent_canvas_cli tests.test_agent_plan_guard tests.test_novai_cli

# 4) node 测试（前端 part / 会话状态机）
node tests/run-all.js

# 5) 只读 CLI（命令表消费方）
python3 novai_cli.py status
python3 novai_cli.py commands
```

真实 run 的端到端（先起服务：`NOVAI_DATA_DIR=/tmp/novai-align python3 main.py`，默认端口 3000）：

```bash
# 发一轮（-N 关闭缓冲；响应头里的 x-novai-run-id 就是 run_id）
curl -N -D- -X POST http://127.0.0.1:3000/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"canvas_id":"<canvas_id>","instruction":"看看这张画布","mode":"run"}'

# 断流恢复：只重放 seq>12 的事件，若 run 已结束则重放完即断开
curl -N 'http://127.0.0.1:3000/api/agent/runs/<run_id>/stream?after=12'
curl -N -H 'Last-Event-ID: 12' 'http://127.0.0.1:3000/api/agent/runs/<run_id>/stream'

# 运行中插话（run 结束后再调会 409）
curl -X POST http://127.0.0.1:3000/api/agent/runs/<run_id>/steer \
  -H 'Content-Type: application/json' -d '{"message":"背景换成夜景，比例 16:9"}'

# 上下文占用直接看 SSE 里的 context_usage 帧；模型是 claude* 时 max_tokens=200000、percentage 是数字，
# 其它模型 max_tokens=0、percentage=null（默认表只收可核实的那条，不猜）
```
