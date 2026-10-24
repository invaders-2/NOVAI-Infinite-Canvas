# NOVAI MCP Server：外部 Agent 调用 NOVAI

本文讲**这一个方向**：外部 Agent（Claude Desktop / Codex / 其它 MCP 客户端）通过 MCP 调用 NOVAI 的画布能力。

- 入口：仓库根目录的 `novai_mcp_server.py`（和 `novai_cli.py` 同级）。
- 它**不 import main**、不直接读写画布文件；所有操作都通过 HTTP 调**已经运行的本机 NOVAI**（REST 接口）。
- 支持两种 MCP 传输：`stdio`（推荐，由客户端 spawn 这个进程）与 Streamable HTTP（独立起一个 HTTP 服务）。

反向能力（NOVAI 作为 MCP 客户端去调外部工具）是另一套东西，配置在 `data/mcp_servers.json` 并在 NOVAI 设置页里启用，见文末「方向区别」。

## 前置

1. NOVAI 已经启动并可访问。默认地址 `http://127.0.0.1:8000`；端口以实际启动日志为准（环境变量 `NOVAI_PORT`，默认 3000；桌面版/部署方式不同会变）。
2. Python 3.9（本入口只用标准库，**零额外依赖**）。
3. 本机能执行仓库里的 `novai_mcp_server.py`。MCP 客户端配置里用**绝对路径**，避免工作目录不同找不到文件。

## stdio 方式（推荐）

由 MCP 客户端启动进程，一条命令：

```bash
NOVAI_BASE_URL=http://127.0.0.1:8000 python3 /绝对路径/NOVAI-v16/novai_mcp_server.py
```

### Claude Desktop

配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "novai": {
      "command": "/usr/bin/python3",
      "args": ["/绝对路径/NOVAI-v16/novai_mcp_server.py"],
      "env": {
        "NOVAI_BASE_URL": "http://127.0.0.1:8000",
        "NOVAI_API_TOKEN": "",
        "NOVAI_MCP_TIMEOUT": "30"
      }
    }
  }
}
```

改完重启客户端；在工具列表里应能看到 7 个 `novai_*` 工具。

### Codex

`~/.codex/config.toml`（字段名以当前 Codex 版本为准）：

```toml
[mcp_servers.novai]
command = "/usr/bin/python3"
args = ["/绝对路径/NOVAI-v16/novai_mcp_server.py"]
env = { NOVAI_BASE_URL = "http://127.0.0.1:8000", NOVAI_MCP_TIMEOUT = "30" }
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOVAI_BASE_URL` | `http://127.0.0.1:8000` | 本机 NOVAI 地址；带不带末尾斜杠都行 |
| `NOVAI_API_TOKEN` | 空 | 有值时每个请求带 `Authorization: Bearer <token>`；登录/权限开启时才需要 |
| `NOVAI_MCP_TIMEOUT` | `30` | 单次 REST 调用超时秒数 |

命令行参数 `--base-url / --token / --timeout` 与这三个变量等价，给了参数以参数为准。

## Streamable HTTP 方式

独立启动一个 HTTP 服务（NOVAI 仍然是另一个进程）：

```bash
NOVAI_BASE_URL=http://127.0.0.1:8000 python3 novai_mcp_server.py \
  --transport http --host 127.0.0.1 --port 8765 --path /mcp
```

- 所有 JSON-RPC 都 `POST /mcp`，请求体可以是单条对象，也可以是数组（批量，响应同样是数组）。
- 响应头带 `Mcp-Session-Id`（启动时生成、整个进程内保持）；服务端不强制客户端回传，客户端回传也会被接受。
- 响应类型是 `application/json`；当前实现不从服务端发起 SSE 推送流。
- `GET /mcp` 返回 **405**：本实现不支持服务端推送流（规范允许），客户端应改用 POST。
- `DELETE /mcp` 返回 **204**（关闭会话；当前实现无会话状态需要清理）。
- 只有通知（没有 `id`）的 POST 返回 **202** 空 body。
- 工具名/参数与 stdio 完全一致，错误码也一致（`-32700` 解析错误、`-32601` 未知方法）。

### curl 冒烟（逐字可跑）

启动服务后（示例端口 8765，NOVAI 在 3946）：

```bash
BASE=http://127.0.0.1:8765/mcp
# ① initialize：响应头里有 Mcp-Session-Id
curl -si -X POST $BASE \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# ② tools/list：7 个工具
curl -s -X POST $BASE \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# ③ tools/call：列画布（只读）
curl -s -X POST $BASE \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"novai_canvas_list","arguments":{"limit":5}}}'
```

实际返回（本机实测，缩进过便于阅读）：

```text
# ① 响应头（节选）
HTTP/1.1 200 OK
Content-Type: application/json
Mcp-Session-Id: sess_xxx
# ① 响应体
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"novai-mcp-server","version":"1.0"}}}

# ② tools/list（节选）
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"novai_canvas_list",...}, ...共 7 个]}}

# ③ tools/call novai_canvas_list
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"共 1 个画布（显示前 5 个）：\n- <canvas_id> | 演示画布 | 更新: 179…"}],"isError":false,"structuredContent":{"canvases":[…]}}}
```

## 工具清单（7 个）

| 工具 | 作用 | 关键参数 | 是否修改数据 |
| --- | --- | --- | --- |
| `novai_canvas_list` | 列出画布（id / 标题 / 更新时间） | `limit?`（1–200，默认 20） | 只读 |
| `novai_canvas_get` | 画布结构摘要（节点数量、节点 id/类型/标题、连线数） | `canvas_id` | 只读 |
| `novai_canvas_create` | 新建空白画布，返回 canvas_id | `title?` | **会修改数据**（新建画布） |
| `novai_node_create` | 新建节点，返回 node_id | `canvas_id`，`type?`（text/prompt/image/video，默认 text），`title?`、`x?`、`y?`、`text?` | **会修改画布** |
| `novai_node_update` | 更新节点标题/文本/生成参数 | `canvas_id`、`node_id`，`title?`、`text?`、`settings?` | **会修改画布** |
| `novai_node_delete` | 删除节点，不可撤销 | `canvas_id`、`node_id` | **会修改画布**（被连线引用时后端返回 409 需要确认） |
| `novai_image_generate` | 触发一次图片生成（异步，不等出图） | `canvas_id`、`prompt`，`node_id?` | **会修改画布并消耗生成额度** |

约定：

- 调用写工具前先用 `novai_canvas_list` / `novai_canvas_get` 确认 `canvas_id`（和 `node_id`）。
- `novai_image_generate` 只负责触发，返回 task/node 提示；出图结果稍后体现在画布节点上。
- 工具成功返回 `{"content":[{"type":"text","text":…}],"isError":false}`，能结构化的还会带 `structuredContent`；失败统一 `isError: true` + 可读原因。

## 安全与边界

- 该进程以**当前系统用户权限**运行；它能做什么，取决于该用户在 NOVAI 里的权限。
- 写工具（canvas_create / node_create / node_update / node_delete / image_generate）**没有二次确认**：是否让 Agent 执行由 MCP 客户端自己的确认机制负责。
- 建议 `NOVAI_BASE_URL` 只指向本机（`http://127.0.0.1:…` 或 `http://localhost:…`），不要把带权限的 NOVAI 地址暴露给不可信客户端。
- `NOVAI_API_TOKEN` 通过环境变量传入，不写入本仓库任何文件；HTTP 传输同理（`--token` 只在命令行可见）。
- HTTP 模式默认只监听 `127.0.0.1`；改成 `0.0.0.0` 前先确认网络边界与 token。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 工具返回 `连不上 NOVAI（…）` | NOVAI 没启动，或 `NOVAI_BASE_URL` 端口不对；先 `curl http://127.0.0.1:<端口>/api/canvases` 确认 |
| 工具返回 HTTP 401 | 需要登录态但没给/给错 `NOVAI_API_TOKEN` |
| `GET /mcp` 返回 405 | HTTP 传输不支持服务端推送流；改用 POST |
| `-32601 method not found` | JSON-RPC 方法名拼错（只支持 `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`） |
| `-32700` | 请求体不是合法 JSON；检查引号与转义 |
| 工具 isError：画布不存在 | `canvas_id` 错或画布已删除；先用 `novai_canvas_list` 取正确 id |
| 工具 isError：节点不存在 / 被连线引用 | `node_id` 错；或删除的节点仍被连线引用，后端返回 409（需要先断开连线） |
| 工具 isError：生图未配置模型 | NOVAI 的「设置 → API 设置」里生图平台没有填模型 |

## 方向区别：MCP Server vs MCP Client

- **本文件（Server 方向）**：外部 Agent → NOVAI。入口 `novai_mcp_server.py`，NOVAI 是被调用方。
- **Client 方向**：NOVAI → 外部工具。配置在 `data/mcp_servers.json`（顶层键 `mcpServers`，`type` 为 `stdio` 或 `http`），需要环境变量 `NOVAI_MCP_ENABLED=1` 才启用；NOVAI 用这些配置去 spawn/连接外部 MCP 服务，把它们的工具并进画布助手的工具目录。

两者方向相反、互不影响；可以同时开启。
