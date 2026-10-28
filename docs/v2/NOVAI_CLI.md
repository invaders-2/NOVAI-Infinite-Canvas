# NOVAI 只读 CLI（novai_cli.py）

一个只用标准库、只读的命令行入口，给运维、脚本和以后的 Agent 外壳用：查服务状态、画布、节点，以及"工具集能干什么"。

- 本期**只读**：任何写操作直接返回退出码 2，不改 data/、不改画布。
- 零第三方依赖，Python 3.9 语法；不 import main.py（单体 import 成本高）。
- 所有数据都从 HTTP API 拿，不直接读 data/canvases/*.json。

## 快速开始

```bash
cd NOVAI-v16
python3 novai_cli.py status                     # 服务地址 / 是否可达 / 画布总数 / 版本号
python3 novai_cli.py canvas ls                  # ID / 名称 / 项目 / 更新时间
python3 novai_cli.py canvas show <canvas_id>    # 名称、节点数、按类型分组计数
python3 novai_cli.py nodes ls <canvas_id>       # 逐行节点：ID / 类型 / 标题（40 字截断）
python3 novai_cli.py commands                   # 命令表：命令 / 对应工具 / 是否写 / 说明
```

任何命令都可加 `--json` 供脚本消费：

```bash
python3 novai_cli.py canvas ls --json
python3 novai_cli.py nodes ls <canvas_id> --json | python3 -m json.tool
```

真实输出片段（临时实例 `NOVAI_DATA_DIR=/tmp/novai-cli-e2e NOVAI_PORT=3931`）：

```text
$ python3 novai_cli.py status
服务地址：http://127.0.0.1:3931
可达状态：可达
画布总数：1
版本号：1.0.140

$ python3 novai_cli.py canvas ls
ID                                名称                项目     更新时间
--------------------------------  ------------------  -------  -------------------
4222c71d60bf4892ad0347a09d488059  CLI 端到端测试画布  default  2026-10-23 17:21:07

$ python3 novai_cli.py nodes ls 4222c71d60bf4892ad0347a09d488059
节点 ID       类型          标题
------------  ------------  --------------------------------------------------------------
n_cli_demo_1  smart-prompt  产品图提示词：白色背景上的咖啡杯，棚拍柔光
n_cli_demo_2  smart-image   主视觉（首帧）
n_cli_demo_3  smart-image   这是一条特别特别长的标题用来验证 CLI 的四十字截断行为是否正常工作不…
```

## 全局参数

| 参数 | 说明 |
| --- | --- |
| `--base-url` | 服务地址，默认 `http://127.0.0.1:${NOVAI_PORT:-3000}` |
| `--token` | 局域网访问口令（一般本机不需要） |
| `--timeout` | 单次请求超时秒数，默认 10 |
| `--json` | JSON 输出 |

参数放子命令前后都行：`novai_cli.py --json canvas ls` 与 `novai_cli.py canvas ls --json` 等价。

## 鉴权与端口

- 口令走请求头 `x-novai-token`（服务端也认 `?token=` 查询参数和 `novai_lan_token` cookie）。
- 服务端只校验**非本机回环**来源：`127.0.0.1` / `localhost` 直接放行，所以本机跑 CLI 一般不用传 token。
- 口令解析顺序：`--token` > 环境变量 `NOVAI_LAN_TOKEN` > `$NOVAI_DATA_DIR/data/security.json` 里的 `lan_token`。注意服务端实际路径是"数据目录/data/security.json"（`DATA_DIR = $NOVAI_DATA_DIR/data`）；`NOVAI_DATA_DIR` 缺省时等于仓库根。
- 调试时可 `NOVAI_LAN_AUTH=0` 让服务端整体关掉鉴权；CLI 侧不用改。
- 端口读 `NOVAI_PORT`，默认 3000。服务起在别的端口：`export NOVAI_PORT=3931` 或 `--base-url http://127.0.0.1:3931`。
- 收到 HTTP 401 时 CLI 会明确提示用 `--token` 或 `NOVAI_LAN_TOKEN`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数错误（例如 `canvas show` 缺 ID），或写命令被"本期只读"拦下 |
| 3 | 连不上服务（输出中文提示 + 底层原因，绝不静默返回空） |
| 4 | 服务返回非 2xx（401/404 等，带服务端 detail） |

连不上时的提示形如：

```text
错误：连不上 127.0.0.1:3999，请先启动 NOVAI（macOS: ./mac-启动服务.sh，或 python3 main.py）；底层原因：[Errno 61] Connection refused
```

## 为什么走 HTTP，而不是直接改 data/canvases/*.json

直接改盘看着省事，但会绕过服务端已有的 6 道保护：

1. **并发锁**：所有画布写入都在 `CANVAS_LOCK` 下做原子写（`write_json_atomic`）。外部进程同时改同一份 JSON，正在跑的服务会覆盖或读到半截文件。
2. **版本快照 / 撤销**：`PUT /api/canvases/{id}` 保存后会 `snapshot_canvas_version` 生成 `data/canvas_versions/{id}/vN.json`（保留最近 N 个，`NOVAI_CANVAS_VERSION_LIMIT` 默认 20），前端另有撤销栈和 Agent 的 "agent undo" 快照。直接改盘这些东西全丢。
3. **冲突检测**：保存请求带 `base_updated_at`，落后于磁盘就 409 拒绝旧版本覆盖。直接写盘没有任何保护。
4. **状态同步**：保存成功后 `manager.broadcast_canvas_updated` 通知所有打开着的页面；直接改盘页面不会刷新，用户看到的是旧状态。
5. **预算闸门**：真实生成走任务引擎与 Agent 预算信封（`NOVAI_AGENT_IMAGE_MAX` 默认每次运行 4 张，免费工具白名单 `AGENT_FREE_TOOLS`）。绕过 API 直接调底层等于绕开计费安全阀。
6. **权限**：`require_canvas_access` 按 owner/admin/editor/viewer 判权，列表按归属过滤；直接读文件目录会连权限口径一起绕开。

所以 CLI（包括以后的写命令）一律只走 API。

## 命令表

唯一真相源是 `server/agents/cli_spec.py`：

- 26 条命令 = `main.py` 的 `AGENT_TOOLS`（22 个画布工具）+ `server/agents/tools.py` 的 `AGENT_FILE_TOOLS`（4 个文件工具）。
- 命令名用点号命名（`node.create`、`canvas.get`），字段：`tool` / `mutates` / `mutates_canvas` / `summary`。
- `mutates`：整条命令是否产生持久化副作用（写画布、写素材库或记忆、落盘产物、发起生成任务）；CLI 用它判断"本期只读"该不该拦，将来写命令也用它决定要不要二次确认。
- `mutates_canvas`：与工具注册表里的同名标记保持一致，只表示"改动画布内容"。两者会分叉：`template.save` / `memory.remember` / `memory.forget` / `report.write_html` / `xlsx.write` / `file.image_generate` 不改画布但会写数据，所以 `mutates=true`、`mutates_canvas=false`。`commands` 表按 `mutates` 显示"写操作"。
- 当前 8 条不产生副作用：`canvas.list`、`canvas.get`、`template.list`、`asset.search`、`task.check`、`table.read`、`canvas.arrange`、`prompt.refine`；其余 18 条会改数据。
- `cli_spec.py` 刻意不 import main；单测解析 `main.py` / `server/agents/tools.py` 的源码，核对"每个 tool 都真实存在"和 `mutates_canvas` 是否一致，防止命令表漂移。

## 后续扩展

1. **写命令**：按命令表逐条补子命令（例如 `node create`、`node update`）。要求：只走 PUT/POST、带 `base_updated_at` 防覆盖、默认 `--dry-run`、`mutates=true` 的命令必须二次确认。本期拦截逻辑（`blocked_write_command`）可以直接换成实现。
2. **Agent 工具**：服务端 `agent_execute_step` 是统一执行器，支持 `{stepN.node_id}` 跨步骤引用。CLI 后续可接 `/api/agent/*`，把"调工具"包装成一条命令，而不是在 CLI 里复制业务逻辑。
3. **MCP 外壳**：`cli_spec.COMMANDS` 已经是机器可读的命令表，可直接 1:1 映射成 MCP tools（`summary` 当 description，`mutates` 当危险标记），先只读上线，再放写工具。`iter_commands()` / `command_names()` 就是为这种消费方准备的。

## 已知限制 / 未验证

- 局域网口令（HTTP 401）的真实非回环链路没有实测，单测只覆盖了提示文案与服务端 detail 透传。
- 画布列表的 `scope` / `all` 等查询参数没有暴露到 CLI。
- 节点只按原始 `type` 计数，不区分 v1 传统画布（classic）与智能画布（smart）的语义分组。
- 接口一旦改字段（例如列表项 `title` 改回 `name`），CLI 兼容了 `title` / `name` 两种，但其他新字段不会自动出现。

## 接入画布助手（canvas_cli）

画布助手（`/api/agent/run` 的模型循环）现在可以直接用一条外壳工具 `canvas_cli` 覆盖整张命令表：
模型只填 `command` + `args`，服务端在步骤进闸门之前把它换成真实工具。实现分三个文件：
`server/agents/canvas_cli.py`（外壳，不 import main）、`tests/test_agent_canvas_cli.py`（单测）、
`main.py`（3 处接入：import、`_agent_run_normalize_steps` 里展开、注册表末尾挂一行）。

### 模型侧的形态

- 只有一条外壳工具，名字固定 `canvas_cli`（`canvas_cli.TOOL_NAME`）。
- `schema.command` 是 `string` + `enum`，取值就是 `sorted(cli_spec.COMMANDS)` 的 26 条，模型不可能编出命令表以外的值。
- `schema.args` 是一个对象（该命令自己的参数，字段见命令表）；`required` 只有 `["command"]`。
- 22 个原画布工具**没有删**，模型想直接调也仍然可以；`canvas_cli` 只是多出来的一条窄入口。
- 外壳的 `mutates_canvas` 固定 `False`——一条命令不可能统一判定写不写，真正的写判定由展开后的内层工具承担
  （这也是为什么**必须**展开：不展开的话，按工具名判定的闸门看到的就是这个 `False`）。

### 安全不变量（不接受别的做法）

确认闸门 / 免费判定 / 生成单元计数 / undo / 产物登记**全部按工具名工作**
（`AGENT_PLAN_CONFIRM_TOOLS`、`AGENT_FREE_TOOLS`、`_agent_step_generation_units` 都是名字集合）。
所以不变量只有一条：

> `{tool: "canvas_cli", args: {command, args}}` 必须在 `main._agent_run_normalize_steps` 里、
> 在**任何**闸门使用 steps 之前，展开成 `{tool: <内层真实工具>, args: <内层 args>}`。
> 展开后所有既有机制自动正确，run 记录 / 方案卡片 / 撤销里看到的都是真实工具名。

只在注册表里挂 `canvas_cli` 而不展开，等于给模型开了一个"免确认改画布"的后门。两条断言即可验证
（纯函数，不用起服务）：

```python
import main

raw = [{"tool": "canvas_cli",
        "args": {"command": "node.create",
                 "args": {"canvas_id": "c1", "type": "prompt", "prompt": "黄昏海边的猫"}}}]

# 反例（后门形态）：闸门按工具名判定，看不见里面的写操作 → 直接放行
assert main.agent_plan_confirmation_needed(raw)["needed"] is False

steps, unknown = main._agent_run_normalize_steps(raw, main.AGENT_TOOLS)
assert unknown == []
assert steps[0]["tool"] == "create_node"                        # 展开成内层真实工具名
assert main.agent_plan_confirmation_needed(steps)["needed"] is True   # 写操作必须等用户点执行
```

防呆：`canvas_cli` 的 `run()` 被直接执行时一定抛 `CanvasCliError`（`code=canvas_cli_not_expanded`），
所以"漏展开"是响亮的失败，而不是静默成功。展开失败（未知命令、内层工具不在当前工具表、args 不是对象）
一律进 `unknown` 文案，不产生可执行步骤。

### 已知边界

- **4 条文件类命令在画布助手内不可用**：`table.read` / `report.write_html` / `xlsx.write` /
  `file.image_generate` 对应的工具在 `_AGENT_FILE_TOOLS`，而画布助手的可用工具表是 `AGENT_TOOLS`；
  这 4 条命令仍出现在 enum 里，但展开时会进 `unknown`（"对应工具 当前不可用"），工具描述里也点名了它们。
- **`/api/agent/apply`、`/api/agent/preview` 不经过 `_agent_run_normalize_steps`**（走
  `_agent_steps_from_request`）：手工构造的 `canvas_cli` 步骤在这两个入口不会展开。
  `preview` 已做防御（`entry["preview"]` 对任何输入都返回中文串、不抛错），
  `apply` 会在 `run()` 处响亮失败（`ok=false`、`code=internal_error` 并停止）。
  前端正常路径拿的是 plan 事件里**已展开**的步骤，碰不到这两个入口。
- **系统提示词尚未提及 canvas_cli**：`_AGENT_RUN_SYSTEM_PROMPT` 的示例仍只写原工具名，
  模型目前靠工具 description 认识它。

### 注册行为什么写在 `AGENT_TOOLS = {...}` 字面量之外

`tests/test_novai_cli.py` 用正则 `^AGENT_TOOLS = \{\n(.*?)\n\}\n` 从源码里抠出注册表字面量，
并断言其中恰好 22 个条目。把 `canvas_cli` 写进字面量会直接把这个用例弄红，所以注册放在字面量之后：

```python
AGENT_TOOLS[_agent_canvas_cli.TOOL_NAME] = _agent_canvas_cli.build_tool_entry(AGENT_TOOLS)
```

这样源码解析看到的仍是原来那 22 条，运行时注册表则是 23 个（22 个画布工具 + 外壳）。
