> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# 上传图片

> 上传 JPEG、PNG、GIF 或 WebP 图片，获取可用于生成接口的公网 URL，默认单文件上限 30MB。

> [!NOTE]
>
> 上传参考素材，成功后直接返回公网 URL，无需轮询。上传本身免费，但账户余额必须大于 0。三个上传接口共享同一用户的文件额度，默认 72 小时内合计最多 2000 个文件。

> [!NOTE]
>
> 文档 Playground 不支持文件上传，请使用下方 cURL、Python 或 JavaScript 示例。JavaScript 示例需要页面中有已选择文件的 `<input type="file">`。

```bash cURL theme={null}
curl --request POST \
  --url https://api.apimart.ai/v1/uploads/images \
  --header 'Authorization: Bearer <token>' \
  --form 'file=@/path/to/reference.png'
```

```python Python theme={null}
import requests

with open("reference.png", "rb") as file:
    response = requests.post(
        "https://api.apimart.ai/v1/uploads/images",
        headers={"Authorization": "Bearer <token>"},
        files={"file": file}
    )

response.raise_for_status()
result = response.json()
print(result["url"])
```

```javascript JavaScript theme={null}
const input = document.querySelector('input[type="file"]');
const file = input?.files?.[0];
if (!file) throw new Error("Select a file first");

const formData = new FormData();
formData.append("file", file, file.name);

const response = await fetch("https://api.apimart.ai/v1/uploads/images", {
  method: "POST",
  headers: { Authorization: "Bearer <token>" },
  body: formData
});
const result = await response.json();
if (!response.ok) {
  throw new Error(result.error?.message ?? `HTTP ${response.status}`);
}
console.log(result.url);
```

```json 200 theme={null}
{
  "url": "https://cdn.example/uploads/reference.png",
  "filename": "reference.png",
  "content_type": "image/png",
  "file_type": "image",
  "bytes": 235680,
  "created_at": 1793836800,
  "quota": {
    "limit": 2000,
    "used": 124,
    "remaining": 1876,
    "window_hours": 72,
    "reset_at": 1794063600
  }
}
```

```json 402 theme={null}
{
  "error": {
    "message": "insufficient balance: uploading files requires a positive account balance, please top up",
    "type": "insufficient_user_quota"
  }
}
```

```json 413 theme={null}
{
  "error": {
    "message": "image file exceeds maximum 31457280 bytes (30MB)",
    "type": "invalid_request_error"
  }
}
```

```json 429 theme={null}
{
  "error": {
    "message": "upload limit reached: each account can upload at most 2000 files per 72 hours",
    "type": "rate_limit_exceeded",
    "code": "rate_limit_exceeded",
    "param": ""
  },
  "quota": {
    "limit": 2000,
    "used": 2000,
    "remaining": 0,
    "window_hours": 72,
    "reset_at": 1794063600
  }
}
```

## 认证

**Authorization** `string` *required*

使用有效、未禁用、未过期的 APIMart API Key，格式为 `Bearer <token>`，且账号未被封禁。账户余额必须大于 0；Key 自身额度用完仍可上传。可在 [API Key 管理页面](https://apimart.ai/keys) 获取 Key。

## 请求参数

**file** `file` *required*

通过 `multipart/form-data` 的 `file` 字段传入一个带文件名的文件。不要使用 JSON、base64 字符串或文件 URL 代替文件部分。其他表单字段会被忽略；同一请求传入多个 `file` 时只处理第一个。

**支持格式：** JPEG (.jpg, .jpeg), PNG (.png), GIF (.gif), WebP (.webp)

**默认单文件上限：** 30MB。单文件上限可调整，以实际服务配置和超限错误提示为准。

使用 cURL `--form`、Python `files` 或 JavaScript `FormData` 时，由客户端自动生成包含 boundary 的 `Content-Type`，不要手动设置该请求头。

## 文件校验

文件类型按实际内容识别，不依赖扩展名或客户端声明的 MIME 类型。文件内容必须与上传接口匹配；改扩展名不能转换格式，类型不匹配会返回 HTTP `400`。

图片必须可完整解码，总像素不超过 40MP，任一边不超过 32768 像素；GIF 最多 500 帧。

| 格式 | 识别后的 MIME 类型 |
| - | - |
| JPEG (.jpg, .jpeg) | `image/jpeg` |
| PNG (.png) | `image/png` |
| GIF (.gif) | `image/gif` |
| WebP (.webp) | `image/webp` |

## 成功响应

HTTP `200` 返回文件信息，`url` 位于 JSON 顶层，没有 `data` 包装，也不返回生成任务 ID。

**url** `string`

文件公网 URL。将其填入目标生成接口对应的参考素材参数；该模型仍有独立的格式、大小、数量、时长等限制，上传成功不代表一定符合模型要求。

**filename** `string`

原始文件名。

**content\_type** `string`

服务端按文件内容识别的 MIME 类型，不是客户端声明的值。

**file\_type** `string`

文件类别，本接口返回 `image`。

**bytes** `integer`

实际文件大小，单位为字节。

**created\_at** `integer`

上传时间，Unix 时间戳，单位为秒。

**quota** `object`

可选的上传额度信息。普通受限用户的字段如下；不限额或统计暂不可用时，结构可能不同，见下方说明。

| 字段 | 说明 |
| - | - |
| `quota.limit` | 当前用户在统计窗口内可成功上传的文件数上限，可能不同于默认值 2000。 |
| `quota.used` | 窗口内已用数量，包含本次成功上传。 |
| `quota.remaining` | 当前还可上传的文件数。 |
| `quota.window_hours` | 统计窗口小时数，默认 72。 |
| `quota.reset_at` | 最早一批记录移出统计窗口的时间，Unix 秒。届时释放部分名额，不代表全部额度同时重置。 |

## 共享额度与请求限速

图片、视频和音频三个接口按用户共享额度，同一用户的多个 API Key 不叠加额度。窗口按整点滚动，默认统计最近约 71–72 小时的成功上传。格式错误、超出大小或存储失败的上传不占文件额度。

普通受限响应同时提供 `X-Upload-Quota-Limit`、`X-Upload-Quota-Remaining`、`X-Upload-Quota-Reset`，分别对应 `limit`、`remaining`、`reset_at`；Reset 的单位是 Unix 秒。

不限额用户返回 `quota: {"unlimited": true}`，不带上述三个额度响应头。统计暂不可用时，成功响应可能省略 `quota`；此时不要按 0 或不限额解析，也不要因为缺少额度信息而重复上传。

文件额度耗尽时返回 HTTP `429`，`error.type` 为 `rate_limit_exceeded`，响应附带 `quota`（`remaining: 0`）和 `Retry-After`。按 `Retry-After` 指定的秒数等待后重试。另有每个 Key 每 60 秒 1000 次请求的限速，对应 `rate_limit_error`，与文件额度独立。

## 错误处理

错误对象位于 JSON 顶层的 `error` 中，通过 HTTP 状态码、`error.type` / `error.code` 和 `error.message` 判断原因。

| HTTP | `error.type` | 原因与处理 |
| - | - | - |
| 400 | `invalid_request_error` | 缺少文件、不是 multipart、空文件、类型不匹配、格式不支持或内容损坏；修正文件或接口路径后重试。 |
| 401 / 403 | `—` | Key 无效、已禁用或账号被封禁；检查认证和账号状态。 |
| 402 | `insufficient_user_quota` | 账户余额不大于 0，或 Key 已过期；补充余额或更换有效 Key。上传免费仍需满足准入条件。 |
| 413 | `invalid_request_error` | 超过该类型的单文件大小上限；压缩或缩小文件，以错误信息中的当前限制为准。 |
| 429 | `rate_limit_exceeded` | 用户的共享文件额度已用完；读取 `quota` 和 `Retry-After`，等待名额释放。 |
| 429 | `rate_limit_error` | Key 请求过于频繁；降低请求频率并退避重试。 |
| 500 | `server_error` | 文件写入存储失败；稍后重试。 |

## URL 使用与文件保存

72 小时是默认额度统计窗口，不是文件保存时长承诺。文件保留期限以存储策略为准，请保留原始文件，并在取得 URL 后及时用于生成；不要假定 URL 永久有效。

## 其他上传接口

* [上传视频](https://docs.apimart.ai/cn/api-reference/uploads/videos.md)
* [上传音频](https://docs.apimart.ai/cn/api-reference/uploads/audios.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.