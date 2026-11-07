> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Claude 消息接口

>  - 完全兼容 Anthropic Claude Messages 原生协议（`POST /v1/messages`）
- 支持多轮对话、流式 SSE、工具调用、extended thinking
- 支持文本、图像等多模态内容
- 响应为上游原样透传，无 `{code, data}` 外层包装 

> [!WARNING]
>
> **两套 API 不要混用**：`/v1/*` 为推理 API（本文档，上游原样透传、无包装）；`/api/*` 为管理 API（查余额/日志等，响应为 `{success, message, data}`）。若看到某处写 `/v1/messages` 返回 `{code, data}`，以本文档为准。

```bash cURL theme={null}
curl https://api.apimart.ai/v1/messages \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2025-10-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "你好，世界"}
    ]
  }'
```

```python Python theme={null}
import anthropic

client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="https://api.apimart.ai"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "你好，世界"}
    ]
)

print(message.content)
```

```javascript JavaScript theme={null}
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.API_KEY,
  baseURL: 'https://api.apimart.ai'
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: '你好，世界' }
  ]
});

console.log(message.content);
```

```go Go theme={null}
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io/ioutil"
    "net/http"
    "os"
)

func main() {
    url := "https://api.apimart.ai/v1/messages"

    payload := map[string]interface{}{
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "messages": []map[string]string{
            {
                "role":    "user",
                "content": "你好，世界",
            },
        },
    }

    jsonData, _ := json.Marshal(payload)

    req, _ := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
    req.Header.Set("x-api-key", os.Getenv("API_KEY"))
    req.Header.Set("anthropic-version", "2025-10-01")
    req.Header.Set("Content-Type", "application/json")

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    body, _ := ioutil.ReadAll(resp.Body)
    fmt.Println(string(body))
}
```

```java Java theme={null}
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URI;

public class Main {
    public static void main(String[] args) throws Exception {
        String url = "https://api.apimart.ai/v1/messages";
        String apiKey = System.getenv("API_KEY");

        String payload = """
        {
          "model": "claude-sonnet-4-6",
          "max_tokens": 1024,
          "messages": [
            {
              "role": "user",
              "content": "你好，世界"
            }
          ]
        }
        """;

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2025-10-01")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}
```

```php PHP theme={null}
<?php

$url = "https://api.apimart.ai/v1/messages";
$apiKey = getenv('API_KEY');

$payload = [
    "model" => "claude-sonnet-4-6",
    "max_tokens" => 1024,
    "messages" => [
        [
            "role" => "user",
            "content" => "你好，世界"
        ]
    ]
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "x-api-key: " . $apiKey,
    "anthropic-version: 2025-10-01",
    "Content-Type: application/json"
]);

$response = curl_exec($ch);
curl_close($ch);

echo $response;
?>
```

```ruby Ruby theme={null}
require 'net/http'
require 'json'
require 'uri'

url = URI("https://api.apimart.ai/v1/messages")
api_key = ENV['API_KEY']

payload = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: "你好，世界"
    }
  ]
}

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Post.new(url)
request["x-api-key"] = api_key
request["anthropic-version"] = "2025-10-01"
request["Content-Type"] = "application/json"
request.body = payload.to_json

response = http.request(request)
puts response.body
```

```swift Swift theme={null}
import Foundation

let url = URL(string: "https://api.apimart.ai/v1/messages")!
let apiKey = ProcessInfo.processInfo.environment["API_KEY"] ?? ""

let payload: [String: Any] = [
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
        [
            "role": "user",
            "content": "你好，世界"
        ]
    ]
]

var request = URLRequest(url: url)
request.httpMethod = "POST"
request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
request.setValue("2025-10-01", forHTTPHeaderField: "anthropic-version")
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

let task = URLSession.shared.dataTask(with: request) { data, response, error in
    if let error = error {
        print("Error: \(error)")
        return
    }
    
    if let data = data, let responseString = String(data: data, encoding: .utf8) {
        print(responseString)
    }
}

task.resume()
```

```csharp C# theme={null}
using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

class Program
{
    static async Task Main(string[] args)
    {
        var url = "https://api.apimart.ai/v1/messages";
        var apiKey = Environment.GetEnvironmentVariable("API_KEY");

        var payload = @"{
            ""model"": ""claude-sonnet-4-6"",
            ""max_tokens"": 1024,
            ""messages"": [
                {
                    ""role"": ""user"",
                    ""content"": ""你好，世界""
                }
            ]
        }";

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Add("x-api-key", apiKey);
        client.DefaultRequestHeaders.Add("anthropic-version", "2025-10-01");

        var content = new StringContent(payload, Encoding.UTF8, "application/json");
        var response = await client.PostAsync(url, content);
        var result = await response.Content.ReadAsStringAsync();

        Console.WriteLine(result);
    }
}
```

```c C theme={null}
#include <stdio.h>
#include <curl/curl.h>
#include <stdlib.h>

int main(void) {
    CURL *curl;
    CURLcode res;
    const char *api_key = getenv("API_KEY");

    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl = curl_easy_init();

    if(curl) {
        const char *url = "https://api.apimart.ai/v1/messages";
        const char *payload = "{"
            "\"model\":\"claude-sonnet-4-6\","
            "\"max_tokens\":1024,"
            "\"messages\":[{\"role\":\"user\",\"content\":\"你好，世界\"}]"
        "}";

        char auth_header[256];
        snprintf(auth_header, sizeof(auth_header), "x-api-key: %s", api_key);

        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, auth_header);
        headers = curl_slist_append(headers, "anthropic-version: 2025-10-01");
        headers = curl_slist_append(headers, "Content-Type: application/json");

        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

        res = curl_easy_perform(curl);

        if(res != CURLE_OK) {
            fprintf(stderr, "curl_easy_perform() failed: %s\n",
                    curl_easy_strerror(res));
        }

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
    }

    curl_global_cleanup();
    return 0;
}
```

```objectivec Objective-C theme={null}
#import <Foundation/Foundation.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSURL *url = [NSURL URLWithString:@"https://api.apimart.ai/v1/messages"];
        NSString *apiKey = [NSProcessInfo processInfo].environment[@"API_KEY"];
        
        NSDictionary *payload = @{
            @"model": @"claude-sonnet-4-6",
            @"max_tokens": @1024,
            @"messages": @[
                @{
                    @"role": @"user",
                    @"content": @"你好，世界"
                }
            ]
        };
        
        NSError *error;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:payload
                                                          options:0
                                                            error:&error];
        
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        [request setHTTPMethod:@"POST"];
        [request setValue:apiKey forHTTPHeaderField:@"x-api-key"];
        [request setValue:@"2025-10-01" forHTTPHeaderField:@"anthropic-version"];
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        [request setHTTPBody:jsonData];
        
        NSURLSessionDataTask *task = [[NSURLSession sharedSession] 
            dataTaskWithRequest:request
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                if (error) {
                    NSLog(@"Error: %@", error);
                    return;
                }
                NSString *result = [[NSString alloc] initWithData:data 
                                                        encoding:NSUTF8StringEncoding];
                NSLog(@"%@", result);
            }];
        
        [task resume];
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
```

```ocaml OCaml theme={null}
(* Requires cohttp and yojson libraries *)
open Lwt
open Cohttp
open Cohttp_lwt_unix

let url = "https://api.apimart.ai/v1/messages"
let api_key = Sys.getenv "API_KEY"

let payload = {|{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "你好，世界"
    }
  ]
}|}

let () =
  let headers = Header.init ()
    |> fun h -> Header.add h "x-api-key" api_key
    |> fun h -> Header.add h "anthropic-version" "2025-10-01"
    |> fun h -> Header.add h "Content-Type" "application/json"
  in
  let body = Cohttp_lwt.Body.of_string payload in
  
  let response = Client.post ~headers ~body (Uri.of_string url) >>= fun (resp, body) ->
    body |> Cohttp_lwt.Body.to_string >|= fun body_str ->
    print_endline body_str
  in
  Lwt_main.run response
```

```dart Dart theme={null}
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

void main() async {
  final url = Uri.parse('https://api.apimart.ai/v1/messages');
  final apiKey = Platform.environment['API_KEY'];
  
  final payload = {
    'model': 'claude-sonnet-4-6',
    'max_tokens': 1024,
    'messages': [
      {
        'role': 'user',
        'content': '你好，世界'
      }
    ]
  };
  
  final response = await http.post(
    url,
    headers: {
      'x-api-key': apiKey!,
      'anthropic-version': '2025-10-01',
      'Content-Type': 'application/json',
    },
    body: jsonEncode(payload),
  );
  
  print(response.body);
}
```

```r R theme={null}
library(httr)
library(jsonlite)

url <- "https://api.apimart.ai/v1/messages"
api_key <- Sys.getenv("API_KEY")

payload <- list(
  model = "claude-sonnet-4-6",
  max_tokens = 1024,
  messages = list(
    list(
      role = "user",
      content = "你好，世界"
    )
  )
)

response <- POST(
  url,
  add_headers(
    `x-api-key` = api_key,
    `anthropic-version` = "2025-10-01",
    `Content-Type` = "application/json"
  ),
  body = toJSON(payload, auto_unbox = TRUE),
  encode = "raw"
)

cat(content(response, "text"))
```

```json 200 theme={null}
{
  "model": "claude-sonnet-4-6",
  "id": "msg_011CdfeHuC728oxqaLrRNbcB",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "你好！我是Claude。很高兴见到你。"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "usage": {
    "input_tokens": 12,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 0
    },
    "output_tokens": 18,
    "service_tier": "standard",
    "inference_geo": "global"
  }
}
```

```json 400 theme={null}
{
  "error": {
    "code": "model_not_found",
    "message": "model not found (request id: 20260803181903172761862QzohKPXF)",
    "param": "",
    "type": "apimart_error"
  }
}
```

```json 401 theme={null}
{
  "error": {
    "code": "",
    "message": "无效的API密钥 (request id: 20260803181903172761862QzohKPXF)",
    "param": "",
    "type": "apimart_error"
  }
}
```

```json 402 theme={null}
{
  "error": {
    "code": "",
    "message": "账户余额不足 (request id: 20260803181903172761862QzohKPXF)",
    "param": "",
    "type": "apimart_error"
  }
}
```

```json 429 theme={null}
{
  "error": {
    "code": "",
    "message": "请求过于频繁 (request id: 20260803181903172761862QzohKPXF)",
    "param": "",
    "type": "apimart_error"
  }
}
```

```json 500 theme={null}
{
  "error": {
    "code": "",
    "message": "服务器内部错误 (request id: 20260803181903172761862QzohKPXF)",
    "param": "",
    "type": "apimart_error"
  }
}
```

## Authorizations

鉴权支持两种方式，**任选其一**：

**x-api-key** `string`

Anthropic 风格鉴权头

访问 [API Key 管理页面](https://apimart.ai/keys) 获取您的 API Key

```
x-api-key: YOUR_API_KEY
```

**Authorization** `string`

Bearer Token 鉴权（与 `x-api-key` 二选一）

```
Authorization: Bearer YOUR_API_KEY
```

**anthropic-version** `string`

API 版本号（**可选**，不传也能正常返回）

为便于日后迁移到 Anthropic 官方端点，建议照常带上：

示例：`2025-10-01`

## Body

**model** `string` *required* (default: claude-sonnet-4-6)

模型名称

* `claude-opus-4-8` - Claude Opus 4.8 旗舰模型
* `claude-opus-4-7` - Claude Opus 4.7 旗舰模型
* `claude-opus-4-6` - Claude Opus 4.6 旗舰模型
* `claude-sonnet-4-6` - Claude Sonnet 4.6 平衡版本
* `claude-opus-4-5-20251101` - Claude Opus 4.5 模型

**messages** `array` *required*

消息列表

消息数组，模型会基于这些消息生成下一条回复。每条消息包含 `role` 和 `content` 两个字段。

**💡 快速填写（Try it 区域）：**

1. 点击 "+ Add an item" 添加一条消息
2. `role` 输入：`user`（用户消息）或 `assistant`（AI回复，用于多轮对话）
3. `content` 输入：你想说的话

**详细字段说明**

**role** `string` *required* (default: user)

角色类型

可选值：`user`（用户消息）、`assistant`（AI回复，用于多轮对话和预填充）

注：Claude API 的 system 提示词使用单独的 `system` 参数，不在 messages 中

**content** `string` *required*

消息内容

填写消息的文本内容

**单条用户消息示例：**

```json theme={null}
[{"role": "user", "content": "你好，Claude"}]
```

**多轮对话示例：**

```json theme={null}
[
  {"role": "user", "content": "你好"},
  {"role": "assistant", "content": "你好！我是Claude。"},
  {"role": "user", "content": "能解释一下AI吗？"}
]
```

**预填充助手回复：**

```json theme={null}
[
  {"role": "user", "content": "太阳的希腊名称是？(A) Sol (B) Helios (C) Sun"},
  {"role": "assistant", "content": "答案是 ("}
]
```

**max\_tokens** `integer` *required*

最大生成 token 数（**必填**，与 Anthropic 官方一致）

生成停止前的最大 token 数量。模型可能会在达到此限制前停止。

不同模型有不同的最大值，请参考模型文档。最小值：1

**thinking** `object`

Extended thinking 配置

开启后响应 `content` 中可能包含 `thinking` 块。**推荐**使用标准模型名 + 本参数，而不是依赖平台侧的 `-thinking` 模型别名，便于无改代码迁移到官方端点。

多轮对话若需回传 thinking 块，必须**原样带回** `signature`，否则上游会拒绝。

**system** `string | array`

系统提示词

系统提示词用于设置Claude的角色、个性、目标和指令。

**字符串格式：**

```json theme={null}
{
  "system": "你是一位专业的Python编程导师"
}
```

**结构化格式：**

```json theme={null}
{
  "system": [
    {
      "type": "text",
      "text": "你是一位专业的Python编程导师"
    }
  ]
}
```

**temperature** `number`

温度参数，范围 0-1

控制输出的随机性：

* 低值（如0.2）：更确定、更保守
* 高值（如0.8）：更随机、更有创意

默认值：1.0

**top\_p** `number`

核采样参数，范围 0-1

使用nucleus sampling。建议使用 `temperature` 或 `top_p` 其中之一，不要同时使用。

默认值：1.0

**top\_k** `integer`

Top-K采样

只从概率最高的K个选项中采样，用于移除"长尾"低概率响应。

建议仅在高级用例中使用。

**stream** `boolean`

是否启用流式输出

设置为 `true` 时，使用服务器发送事件（SSE）流式返回响应。

默认值：false

**stop\_sequences** `array`

停止序列

自定义文本序列，遇到这些序列时模型将停止生成。

最多4个序列。

示例：`["\n\nHuman:", "\n\nAssistant:"]`

**metadata** `object`

元数据

用于请求的元数据对象。

包含：

* `user_id`: 用户标识符

**tools** `array`

工具定义

工具列表，模型可以调用这些工具来完成任务。

**函数工具示例：**

```json theme={null}
{
  "tools": [
    {
      "name": "get_weather",
      "description": "获取指定位置的当前天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {
            "type": "string",
            "description": "城市和省份，例如：北京"
          },
          "unit": {
            "type": "string",
            "enum": ["celsius", "fahrenheit"],
            "description": "温度单位"
          }
        },
        "required": ["location"]
      }
    }
  ]
}
```

支持的工具类型：

* 自定义函数工具
* 计算机使用工具（computer\_20241022）
* 文本编辑器工具（text\_editor\_20241022）
* Bash工具（bash\_20241022）

**tool\_choice** `object`

工具选择策略

控制模型如何使用工具：

* `{"type": "auto"}`: 自动决定（默认）
* `{"type": "any"}`: 必须使用工具
* `{"type": "tool", "name": "tool_name"}`: 使用指定工具

## Response

**id** `string`

唯一消息标识符

示例：`"msg_013Zva2CMHLNnXjNJJKqJ2EF"`

**type** `string`

对象类型

固定为 `"message"`

**role** `string`

角色

固定为 `"assistant"`

**content** `array`

内容块数组

`content` 按 `type` 区分块类型。**一次响应可能包含多个块**（例如开启 thinking 时是 `thinking` + `text` 两块）。

**text 块：**

```json theme={null}
{ "type": "text", "text": "OK" }
```

**tool\_use 块：**

```json theme={null}
{
  "type": "tool_use",
  "id": "toolu_01QgsazxKXSfQVj9Q1XxjYXo",
  "name": "get_weather",
  "input": { "city": "Beijing" },
  "caller": { "type": "direct" }
}
```

> [!NOTE]
>
> `caller` 是上游新增字段，官方文档尚未收录，解析时忽略即可。

**thinking 块**（请求体带 `thinking` 参数时出现）：

```json theme={null}
{
  "type": "thinking",
  "thinking": "推理过程文本...",
  "signature": "<约 500+ 字符的签名串>"
}
```

> [!WARNING]
>
> 多轮对话回传 thinking 块时，必须**原样带回** `signature`，否则上游会拒绝。

> [!WARNING]
>
> **不要假设 `content[0]` 就是文本。** 开启 thinking 时 `content[0]` 可能是 thinking 块。应遍历筛选：
>
> ```python theme={null}
> text = "".join(b.text for b in resp.content if b.type == "text")
> ```

**model** `string`

处理请求的模型

示例：`"claude-sonnet-4-6"`

**stop\_reason** `string`

停止原因

可能的值：

* `end_turn`: 自然结束
* `max_tokens`: 达到最大 token 数
* `stop_sequence`: 遇到停止序列
* `tool_use`: 调用了工具

**stop\_sequence** `string | null`

触发的停止序列

如果因停止序列而停止，则为该序列内容；否则为 `null`

**stop\_details** `object | null`

Anthropic 较新字段，常规请求为 `null`

**usage** `object`

Token 使用统计（非流式完整结构）

**属性**

**input\_tokens** `integer`

输入 token 数

**output\_tokens** `integer`

输出 token 数（**已包含** thinking tokens，计费勿重复累加）

**cache\_creation\_input\_tokens** `integer`

缓存写入 token

**cache\_read\_input\_tokens** `integer`

缓存命中 token

**cache\_creation** `object`

`{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`

**service\_tier** `string`

如 `"standard"`

**inference\_geo** `string`

如 `"global"`

**output\_tokens\_details** `object`

开启 thinking 时可能出现：`{ thinking_tokens: int }`

## 使用示例

### 基础对话

```python theme={null}
import anthropic

client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="https://api.apimart.ai"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "解释量子计算的基本原理"}
    ]
)

print(message.content[0].text)
```

### 多轮对话

```python theme={null}
messages = [
    {"role": "user", "content": "什么是机器学习？"},
    {"role": "assistant", "content": "机器学习是人工智能的一个分支..."},
    {"role": "user", "content": "能举个实际应用的例子吗？"}
]

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=messages
)
```

### 使用系统提示词

```python theme={null}
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    system="你是一位资深的Python开发专家，擅长代码审查和优化建议。",
    messages=[
        {"role": "user", "content": "如何优化这段代码？\n\n[代码]"}
    ]
)
```

### 流式响应

```python theme={null}
with client.messages.stream(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "写一篇关于AI的短文"}
    ]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### 工具使用

```python theme={null}
tools = [
    {
        "name": "get_stock_price",
        "description": "获取股票的实时价格",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "股票代码，例如：AAPL"
                }
            },
            "required": ["ticker"]
        }
    }
]

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    tools=tools,
    messages=[
        {"role": "user", "content": "特斯拉的股价是多少？"}
    ]
)

# 处理工具调用
if message.stop_reason == "tool_use":
    tool_use = next(block for block in message.content if block.type == "tool_use")
    print(f"调用工具: {tool_use.name}")
    print(f"参数: {tool_use.input}")
```

### 视觉理解

```python theme={null}
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "url",
                        "url": "https://example.com/image.jpg"
                    }
                },
                {
                    "type": "text",
                    "text": "描述这张图片"
                }
            ]
        }
    ]
)
```

### Base64图像

```python theme={null}
import base64

with open("image.jpg", "rb") as image_file:
    image_data = base64.b64encode(image_file.read()).decode("utf-8")

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": image_data
                    }
                },
                {
                    "type": "text",
                    "text": "分析这张图片"
                }
            ]
        }
    ]
)
```

## 最佳实践

### 1. 提示词工程

**清晰的角色定义：**

```python theme={null}
system = """你是一位经验丰富的数据科学家，专长包括：
- 统计分析和数据可视化
- 机器学习模型开发
- Python和R编程
请提供专业、准确的建议。"""
```

**结构化输出：**

```python theme={null}
message = "请以JSON格式返回分析结果，包含summary、key_findings和recommendations字段。"
```

### 2. 错误处理

```python theme={null}
from anthropic import APIError, RateLimitError

try:
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": "你好"}]
    )
except RateLimitError:
    print("速率限制，请稍后重试")
except APIError as e:
    print(f"API错误: {e}")
```

### 3. Token优化

```python theme={null}
# 使用更短的提示词
messages = [
    {"role": "user", "content": "总结要点：\n\n[长文本]"}
]

# 限制输出长度
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=500,  # 限制输出
    messages=messages
)
```

### 4. 预填充响应

```python theme={null}
# 引导模型以特定格式回复
messages = [
    {"role": "user", "content": "列出5个Python最佳实践"},
    {"role": "assistant", "content": "以下是5个Python最佳实践：\n\n1."}
]

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=messages
)
```

## 流式响应处理

### Python流式示例

```python theme={null}
import anthropic

client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="https://api.apimart.ai"
)

with client.messages.stream(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "写一个Python装饰器示例"}
    ]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### JavaScript流式示例

```javascript theme={null}
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.API_KEY,
  baseURL: 'https://api.apimart.ai'
});

const stream = await client.messages.stream({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: '写一个React组件示例' }
  ]
});

for await (const chunk of stream) {
  if (chunk.type === 'content_block_delta' && 
      chunk.delta.type === 'text_delta') {
    process.stdout.write(chunk.delta.text);
  }
}
```

## 平台差异与对接注意

### 响应无包装

`POST /v1/messages` 成功时**直接返回** Anthropic message 对象，**没有** `{code, data}` 外层。官方 SDK、Claude Code、Cline 等才能 1:1 兼容。

### 错误格式（与官方唯一实质差异）

```json theme={null}
{
  "error": {
    "code": "model_not_found",
    "message": "... (request id: ...)",
    "param": "",
    "type": "apimart_error"
  }
}
```

相对 Anthropic 官方：顶层缺少 `"type": "error"`；`error.type` 固定为 `apimart_error`，而非 `invalid_request_error` 等语义化类型。

**对接建议**：不要依赖 `error.type` 做重试分支，改用 **HTTP 状态码 + `error.code`**：

| 状态码 | 含义 | 建议动作 |
| - | - | - |
| 400 | 请求参数错误 | 不重试，检查请求体 |
| 401 | Key 无效 | 不重试 |
| 402 | 余额不足 | 不重试，提示充值 |
| 429 | 限流 | 退避后重试 |
| 5xx | 上游/网关异常 | 指数退避重试 |

报障请提供：`error.message` 末尾的 request id，以及响应头 `x-oneapi-request-id`。

### 流式 SSE

请求加 `"stream": true`。事件序列与官方一致：

`message_start` → `content_block_start` → `ping` → `content_block_delta`（多次）→ `content_block_stop` → `message_delta` → `message_stop`

⚠️ **流式与非流式的 usage 结构不同**：`message_delta.usage` 通常只有 4 个 token 字段，**没有** `cache_creation`、`service_tier`、`inference_geo`。请分开解析或全部设为可选。

### 未实现接口

`POST /v1/messages/count_tokens` **未实现，返回 404**。官方 SDK 的 `client.messages.count_tokens()` 会失败。需要预估 token 时请在本地估算，或读取响应中的 `usage.input_tokens`。

### 必须忽略未知字段

本接口对上游透传，Anthropic 可能随时新增字段（如 `stop_details`、`inference_geo`、`caller`、`output_tokens_details`）。请勿开启严格 schema：

* Go：不要用 `DisallowUnknownFields()`
* Pydantic：不要 `extra="forbid"`
* TypeScript / Zod：用 `.passthrough()` 而非 `.strict()`

### 模型名建议

带 `-thinking` 后缀的同名模型是平台扩展别名。**推荐**用不带后缀的标准模型名 + 请求体 `thinking` 参数，便于迁移官方端点。

请求体其它字段与官方一致：`model`、`messages`、`max_tokens`（必填）、`system`、`temperature`、`top_p`、`top_k`、`stop_sequences`、`stream`、`tools`、`tool_choice`、`thinking`、`metadata`。语义以 [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) 为准。

## 注意事项

1. **API 密钥安全**：
   * 使用环境变量存储 API 密钥
   * 不要在代码中硬编码密钥
   * 定期轮换密钥

2. **速率限制**：
   * 注意 API 的速率限制
   * 实现重试机制（按 HTTP 状态码）
   * 使用指数退避策略

3. **Token 管理**：
   * 监控 token 使用量（读 `usage`）
   * 优化提示词长度
   * 使用适当的 `max_tokens` 值
   * 开启 thinking 时 `output_tokens` 已含 thinking，勿重复计费

4. **模型选择**：
   * Opus: 复杂任务、需要深度思考
   * Sonnet: 平衡性能和成本
   * Haiku: 快速响应、简单任务

5. **内容解析**：
   * 遍历 `content` 取 `type == "text"`，不要写死 `content[0].text`
   * 模型若返回 Markdown 代码块包裹的 JSON，属模型输出而非接口包装（见下方 FAQ）

6. **内容过滤**：
   * 验证用户输入
   * 过滤敏感信息
   * 实现内容审核机制

## FAQ

### 响应里 `content` 的 text 是 ` ```json ... ``` ` 代码块，怎么去掉？

这不是接口结构问题。`text` 字段装的是**模型生成的原始内容**：模型判断你想要 JSON，就用 Markdown 代码块包起来了。接口不会也不应该改写模型输出。

想拿到干净的结构化数据，有三种正确做法（推荐程度从高到低）：

1. **用 tools 强制结构化输出**——最可靠，`input` 字段直接就是解析好的对象：

```json theme={null}
{
  "tools": [{
    "name": "emit_result",
    "input_schema": {
      "type": "object",
      "properties": { "answer": { "type": "string" } }
    }
  }],
  "tool_choice": { "type": "tool", "name": "emit_result" }
}
```

2. **prefill 助手消息**，让模型从 `{` 接着写：

```json theme={null}
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "{" }
  ]
}
```

3. 在 system prompt 里明确要求「只输出 JSON，不要加 Markdown 代码块」。

不推荐用正则去剥 code fence——模型偶尔不加围栏时会解析失败。


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.