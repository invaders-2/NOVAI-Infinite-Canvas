> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# 任务完成回调（Webhook）

> 提交异步生成任务时带上回调地址，任务完成（成功或失败）后主动把结果 POST 给你，并可指定失败错误文案的语言。

提交视频 / 图片 / 音频等异步生成任务时，可以带上一个回调地址。任务**完成（成功或失败）后**，我们会主动把结果 POST 到你的地址，你就不用一直轮询查询了。对于视频和图片生成任务，还可以通过 `language` 指定失败回调中错误文案的语言。

## 快速开始

提交任务时，在请求体顶层加入 `webhook` 字段；如需翻译失败回调中的错误文案，再加入 `language`：

```bash theme={null}
curl -X POST https://你的接入域名/v1/images/generations \
  -H "Authorization: Bearer 你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a red apple on a table",
    "size": "1024x1024",
    "webhook": "https://your-server.com",
    "language": "zh"
  }'
```

任务做完后，我们会向 **`你的地址 + /callback`** 发一个 POST 请求。

> [!NOTE]
>
> 视频、音频等其它异步任务接口同理，`webhook` 应放在提交请求体的顶层。`language` 目前适用于 `POST /v1/videos/generations` 和 `POST /v1/images/generations`，同样放在请求体顶层。

## 指定错误文案语言

`language` 是可选字符串参数，只影响失败回调中的 `error.message`。任务 ID、状态、进度、金额和结果 URL 等字段不会随语言变化。不传时，错误文案保持上游或平台返回的原文。

| 语言 | 参数值 | 语言 | 参数值 |
| - | - | - | - |
| English | `en` | Русский | `ru` |
| 简体中文 | `zh` | Français | `fr` |
| 日本語 | `ja` | Deutsch | `de` |
| 한국어 | `ko` | Bahasa Indonesia | `id` |
| Português | `pt` | Español | `es` |

* 参数值不区分大小写，首尾空格会自动移除，例如 `"ZH"`、`" zh "` 都会按 `zh` 处理。
* 请使用表格中的两位语言码。`zh-CN`、`en-US`、`pt-BR` 等带地区标签的值不会被识别。
* 不支持的参数值不会导致任务提交失败，回调会保留原始错误文案。
* 如果错误原文已经是目标语言，会直接返回原文，不会重复翻译。
* 翻译失败时会回退到原始错误文案，不会影响回调投递。

> [!NOTE]
>
> 轮询任务时，可通过[任务状态接口的 `language` 查询参数](https://docs.apimart.ai/cn/api-reference/tasks/status#query-parameters)指定相同的错误文案语言。Webhook 没有查询参数，因此必须在**提交任务时**指定 `language`。

> [!WARNING]
>
> `POST /mj/submit/*` 和 `POST /v1/images/edits` 不支持 `webhook` / `language`。官方 xAI 图片模型不支持 `language`，携带该参数会返回 `400 parameter "language" is not supported`；调用这些模型时请不要传入该参数。

## 地址规则

你填的 `webhook` 是**基础地址（base）**，我们会自动在后面拼 `/callback`：

| 你填的 `webhook` | 我们实际 POST 到 |
| - | - |
| `https://your-server.com` | `https://your-server.com/callback` |
| `https://your-server.com/api` | `https://your-server.com/api/callback` |
| `https://your-server.com/api/` | `https://your-server.com/api/callback` |

所以你的服务端需要准备一个接收 `POST .../callback` 的接口。

## 你会收到什么

推送内容**和「[获取任务状态](https://docs.apimart.ai/cn/api-reference/tasks/status.md)」接口返回的完全一致**——你用同一套解析逻辑处理即可。

```json 成功（status: completed） theme={null}
{
  "id": "task_01KV7FXR8BEYS1BWHJCT3JMCJ5",
  "status": "completed",
  "progress": 100,
  "created": 1781589029,
  "completed": 1781589058,
  "actual_time": 29,
  "cost": 0.006,
  "credits_cost": 0.06,
  "result": {
    "images": [{ "url": ["https://.../result.png"], "expires_at": 1781675458 }]
  }
}
```

```json 失败（status: failed） theme={null}
{
  "id": "task_xxx",
  "status": "failed",
  "progress": 100,
  "created": 1781589029,
  "completed": 1781589050,
  "error": {
    "message": "输入图片无法访问，请确认链接是公网可达的",
    "type": "task_failed",
    "param": "",
    "code": "task_failed"
  }
}
```

> [!NOTE]
>
> 视频任务结果在 `result.videos`，音频在 `result.audios`。

> [!NOTE]
>
> 上面的失败示例使用了 `"language": "zh"`。语言参数只改变 `error.message`，其他字段与不传时一致。

> [!WARNING]
>
> 只有任务到达**终态**（`completed` / `failed`）才会推送；处理中不推。

## 重试与去重（重要）

* **重试**：如果你的服务端没在约 10 秒内返回 `2xx`，或返回了 `5xx`，我们会自动重试，最多 **3 次**，间隔约 **10 秒、30 秒、60 秒**。3 次都失败就放弃（约 2 分钟内结束）。
* **不重试的情况**：你的接口返回 `4xx`（视为地址 / 请求有问题），我们直接放弃，不重试。
* **去重**：正常情况下一个任务只推一次。但在极端情况下（如我们这边发送后、确认前发生重启）你**可能收到重复推送**。请务必**按 `id`（task\_id）做幂等去重**，避免重复处理。

**你的接收接口建议：**

**1. 尽快返回 2xx**

先收下、入队，再异步处理，别让我们等你处理完。

**2. 按 id 去重**

以 `id`（task\_id）作为幂等键，避免重复处理。

**3. 配置并校验签名**

在生产环境对回调请求做来源校验，拒绝伪造请求。

## 对回调地址的要求

为安全起见，回调地址必须满足：

| 要求 | 说明 |
| - | - |
| 公网可访问 | **不能**是内网 / 本地地址（如 `127.0.0.1`、`10.x`、`192.168.x` 等会被拒绝） |
| 协议 | `http` 或 `https`（推荐 `https`） |
| 端口 | 用标准端口（`80` / `443`），非标端口可能被拦截 |
| 域名 | 不能指向我们自己的服务域名 |

不满足要求的地址会被直接丢弃（不会推送、也不会重试）。

## 常见问题

> [accordion] 提交了带 webhook 的任务，但没收到推送？
>
> 逐项排查：
>
> 1. 任务**是否真的完成了**？查一下任务详情，`status` 是不是 `completed` / `failed`（处理中不推）。
> 2. 你的地址是不是**公网可访问**？我们能不能连上你的 `/callback`？
> 3. 端口是不是标准端口（80 / 443）？非标端口可能被安全策略拦掉。
> 4. 你的 `/callback` 是不是**及时返回了 2xx**？返回 4xx 会被直接放弃。
> 5. 用 `https` 了吗？证书是否有效？

> [accordion] 收到的 result 里 url 怎么是个数组？
>
> 部分模型一次会出多张图，`images[].url` 可能是数组，按数组处理即可。

> [accordion] 结果链接有有效期吗？
>
> `result` 里若带 `expires_at`（Unix 时间戳），表示该链接的过期时间，请及时转存。

> [accordion] 会推送「处理中」的状态吗？
>
> 不会。只在任务**最终成功或失败**时推送一次。

## 最小接收端示例

```python Python theme={null}
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        data = json.loads(body)
        print("收到任务回调:", data["id"], data["status"])
        # TODO: 这里按 id 去重、校验签名、再处理
        self.send_response(200); self.end_headers()
        self.wfile.write(b'{"ok":true}')

HTTPServer(("0.0.0.0", 443), H).serve_forever()
```

收到后请尽快返回 `200`，处理逻辑放后台异步做。


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.