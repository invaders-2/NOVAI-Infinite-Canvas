> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# 模型列表元数据接口

>  - GET /v1/models 基础列表 + expand 参数获取分类/能力/参数契约
- 支持 `category` 过滤、`expand=parameters` 拉取 JSON Schema
- 适用自动化集成、动态表单、预校验 

> [!NOTE]
>
> **模型列表元数据接口**（`GET /v1/models`）默认只返回模型名等基础字段。加上 `expand` 查询参数后，每个模型会附带：
>
> * **所属分类**（`category`）：`chat` / `image` / `video` / `audio`
> * **能力标签**（`capability_tags`）：如 `Text to Video`、`Image to Image`
> * **参数契约**（`parameters`）：标准 JSON Schema，标明必填/可选、枚举、取值范围与默认值
>
> 适用场景：拉取一次全量目录生成客户端代码、动态构建参数表单、请求发出前的本地预校验。
>
> > **向后兼容**：不带 `expand`（或值不认识）时，响应与原有格式完全一致，存量客户端零影响。

> [!WARNING]
>
> **模型范围**：受 API Key 的模型限制与所属分组控制。`category=unknown` 表示平台暂未收录该模型的分类元数据。

## 获取模型列表（含元数据）

**GET** `/v1/models`

### 请求头

```
Authorization: Bearer YOUR_API_KEY
```

### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| - | - | :-: | - |
| `expand` | string | 否 | `category`：附加分类与能力标签（轻量）；`parameters`：再附加参数 JSON Schema（全量，响应较大） |
| `category` | string | 否 | 按分类过滤：`chat` / `image` / `video` / `audio` / `unknown`。仅在带 `expand` 时生效 |

返回的模型范围与不带 `expand` 时一致：受 API Key 的模型限制与所属分组控制。

### 示例 1：只要分类

```bash cURL theme={null}
curl -s "https://api.apimart.ai/v1/models?expand=category" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

```json theme={null}
{
  "success": true,
  "object": "list",
  "data": [
    {
      "id": "wan2.6",
      "object": "model",
      "created": 1626777600,
      "owned_by": "alibaba",
      "supported_endpoint_types": ["openai"],
      "category": "video",
      "capability_tags": ["Text to Video"]
    },
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1626777600,
      "owned_by": "openai",
      "supported_endpoint_types": ["openai"],
      "category": "chat",
      "capability_tags": ["Text", "Vision"]
    }
  ]
}
```

### 示例 2：视频模型全量参数契约

```bash cURL theme={null}
curl -s "https://api.apimart.ai/v1/models?expand=parameters&category=video" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Accept-Encoding: gzip" --compressed
```

单个条目（`input_schema.properties` 仅展示部分字段）：

```json theme={null}
{
  "id": "wan2.6",
  "object": "model",
  "created": 1626777600,
  "owned_by": "alibaba",
  "supported_endpoint_types": ["openai"],
  "category": "video",
  "capability_tags": ["Text to Video"],
  "parameters": {
    "operation": "video_generation",
    "method": "POST",
    "endpoint": "/v1/videos/generations",
    "schema_version": "2026-07-30",
    "source": "task_model_registry",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "additionalProperties": true,
      "required": ["model"],
      "anyOf": [
        { "required": ["prompt"] },
        { "required": ["messages"] },
        { "required": ["image_urls"] },
        { "required": ["image_with_roles"] },
        { "required": ["video_urls"] }
      ],
      "properties": {
        "model":      { "type": "string", "const": "wan2.6" },
        "prompt":     { "type": "string", "minLength": 1 },
        "duration":   { "type": "integer", "minimum": 1 },
        "resolution": { "type": "string" },
        "aspect_ratio": { "type": "string" }
      }
    }
  }
}
```

## 响应字段说明

### 条目字段

| 字段 | 类型 | 出现条件 | 说明 |
| - | - | - | - |
| `id` / `object` / `created` / `owned_by` / `supported_endpoint_types` | - | 恒有 | 与原接口一致 |
| `category` | string | 带 `expand` | `chat` / `image` / `video` / `audio` / `unknown` |
| `capability_tags` | string\[] | 带 `expand` 且有标签 | 见下方标签表 |
| `parameters` | object | `expand=parameters` 且该模型有参数契约 | 见下方 parameters 块 |

`category=unknown` 表示平台暂未收录该模型的分类元数据（通常是 Key 的模型白名单里配置了非标准名称），模型本身仍可正常调用。

### 能力标签取值

| 分类 | 可能的标签 |
| - | - |
| video | `Text to Video`、`Image to Video`、`Video to Video` |
| image | `Text to Image`、`Image to Image` |
| chat | `Text`、`Embedding`、`Vision`、`Audio`、`Omni` |
| audio | `Audio` |

### parameters 块

| 字段 | 说明 |
| - | - |
| `operation` | `image_generation` / `video_generation` |
| `method` + `endpoint` | 调用该模型应使用的 HTTP 方法与路径（如 `POST /v1/videos/generations`） |
| `schema_version` | 契约版本（日期），跨版本字段只增不删 |
| `source` | 契约数据来源，排障用；`base` 表示仅有通用基础契约 |
| `input_schema` | JSON Schema draft 2020-12，请求体的完整参数契约 |

### 如何读 input\_schema

标准 JSON Schema，主流工具链（ajv、pydantic、openapi-generator 等）可直接消费：

* **必填参数** = 顶层 `required` 数组；`anyOf` 表示“以下组合至少满足一个”（如上例：`prompt` / `messages` / 三类参考媒体五选一）
* **可选值枚举** = 属性上的 `enum`
* **取值范围** = `minimum` / `maximum`
* **默认值** = `default`
* `additionalProperties: true`：允许传 schema 未列出的模型专属扩展参数（经 `metadata` 透传）

## 查询单个模型

列表接口之外，单模型契约有独立端点（返回结构相同，外层多幂等与响应契约说明块）：

```bash theme={null}
curl -s "https://api.apimart.ai/v1/models/wan2.6/schema" \
  -H "Authorization: Bearer YOUR_API_KEY"

# 模型名含 "/" 时用查询参数形式
curl -s "https://api.apimart.ai/v1/model-schema?model=provider/model-name" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 注意事项

1. **chat / audio 模型目前只有 `category` 与 `capability_tags`，暂无 `parameters`**（参数契约当前覆盖 image / video 两类，后续版本补齐）。
2. **schema 是尽力而为的契约，最终以服务端校验为准**：个别模型的动态限制（如特定分辨率与时长的组合约束）可能未完整表达在 schema 中，请求仍可能被服务端拒绝并返回具体原因。
3. **数据新鲜度为分钟级**：目录带缓存，新上架模型或参数调整可能有几分钟延迟。
4. **`expand=parameters` 全量响应可达数百 KB**：建议配合 `category` 过滤按需拉取，并带 `Accept-Encoding: gzip`。
5. 本参数仅对 OpenAI 格式的模型列表生效；Anthropic / Gemini 方言的模型列表接口不支持 `expand`。


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.