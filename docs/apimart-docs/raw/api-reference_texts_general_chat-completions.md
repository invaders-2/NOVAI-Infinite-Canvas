> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# 通用对话接口(默认流式)

>  - 统一的对话API接口，支持所有文本生成模型
- 通过 model 参数选择不同的AI模型
- 兼容 OpenAI Chat Completions API 格式 

```bash cURL theme={null}

curl --request POST \
  --url https://api.apimart.ai/v1/chat/completions \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "gpt-5", # 可替换为任意支持的模型 ID
    "messages": [
      {
        "role": "system",
        "content": "你是一个专业的AI助手。"
      },
      {
        "role": "user",
        "content": "介绍一下人工智能的发展历史。"
      }
    ]
  }'
```

```python Python theme={null}
import requests

url = "https://api.apimart.ai/v1/chat/completions"

payload = {
    "model": "gpt-5",  # 可替换为任意支持的模型 ID
    "messages": [
        {
            "role": "system",
            "content": "你是一个专业的AI助手。"
        },
        {
            "role": "user",
            "content": "介绍一下人工智能的发展历史。"
        }
    ]
}

headers = {
    "Authorization": "Bearer <token>",
    "Content-Type": "application/json"
}

response = requests.post(url, json=payload, headers=headers)

print(response.json())
```

```javascript JavaScript theme={null}
const url = "https://api.apimart.ai/v1/chat/completions";

const payload = {
  model: "gpt-5",  // 可替换为任意支持的模型 ID
  messages: [
    {
      role: "system",
      content: "你是一个专业的AI助手。"
    },
    {
      role: "user",
      content: "介绍一下人工智能的发展历史。"
    }
  ]
};

const headers = {
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
};

fetch(url, {
  method: "POST",
  headers: headers,
  body: JSON.stringify(payload)
})
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```

```go Go theme={null}
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io/ioutil"
    "net/http"
)

func main() {
    url := "https://api.apimart.ai/v1/chat/completions"

    payload := map[string]interface{}{
        "model": "gpt-5",  // 可替换为任意支持的模型 ID
        "messages": []map[string]string{
            {
                "role":    "system",
                "content": "你是一个专业的AI助手。",
            },
            {
                "role":    "user",
                "content": "介绍一下人工智能的发展历史。",
            },
        },
    }

    jsonData, _ := json.Marshal(payload)

    req, _ := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
    req.Header.Set("Authorization", "Bearer <token>")
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
        String url = "https://api.apimart.ai/v1/chat/completions";

        // 可替换为任意支持的模型 ID
        String payload = """
        {
          "model": "gpt-5",
          "messages": [
            {
              "role": "system",
              "content": "你是一个专业的AI助手。"
            },
            {
              "role": "user",
              "content": "介绍一下人工智能的发展历史。"
            }
          ]
        }
        """;

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer <token>")
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

$url = "https://api.apimart.ai/v1/chat/completions";

// 可替换为任意支持的模型 ID
$payload = [
    "model" => "gpt-5",
    "messages" => [
        [
            "role" => "system",
            "content" => "你是一个专业的AI助手。"
        ],
        [
            "role" => "user",
            "content" => "介绍一下人工智能的发展历史。"
        ]
    ]
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer <token>",
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

url = URI("https://api.apimart.ai/v1/chat/completions")

# 可替换为任意支持的模型 ID
payload = {
  model: "gpt-5",
  messages: [
    {
      role: "system",
      content: "你是一个专业的AI助手。"
    },
    {
      role: "user",
      content: "介绍一下人工智能的发展历史。"
    }
  ]
}

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Post.new(url)
request["Authorization"] = "Bearer <token>"
request["Content-Type"] = "application/json"
request.body = payload.to_json

response = http.request(request)
puts response.body
```

```swift Swift theme={null}
import Foundation

let url = URL(string: "https://api.apimart.ai/v1/chat/completions")!

let payload: [String: Any] = [
    "model": "gpt-5",  // 可替换为任意支持的模型 ID
    "messages": [
        [
            "role": "system",
            "content": "你是一个专业的AI助手。"
        ],
        [
            "role": "user",
            "content": "介绍一下人工智能的发展历史。"
        ]
    ]
]

var request = URLRequest(url: url)
request.httpMethod = "POST"
request.setValue("Bearer <token>", forHTTPHeaderField: "Authorization")
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
        var url = "https://api.apimart.ai/v1/chat/completions";

        // 可替换为任意支持的模型 ID
        var payload = @"{
            ""model"": ""gpt-5"",
            ""messages"": [
                {
                    ""role"": ""system"",
                    ""content"": ""你是一个专业的AI助手。""
                },
                {
                    ""role"": ""user"",
                    ""content"": ""介绍一下人工智能的发展历史。""
                }
            ]
        }";

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Add("Authorization", "Bearer <token>");

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

int main(void) {
    CURL *curl;
    CURLcode res;

    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl = curl_easy_init();

    if(curl) {
        const char *url = "https://api.apimart.ai/v1/chat/completions";
        // 可替换为任意支持的模型 ID
        const char *payload = "{"
            "\"model\":\"gpt-5\","
            "\"messages\":[{\"role\":\"system\",\"content\":\"你是一个专业的AI助手。\"},{\"role\":\"user\",\"content\":\"介绍一下人工智能的发展历史。\"}]"
        "}";

        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, "Authorization: Bearer <token>");
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
        NSURL *url = [NSURL URLWithString:@"https://api.apimart.ai/v1/chat/completions"];
        
        // 可替换为任意支持的模型 ID
        NSDictionary *payload = @{
            @"model": @"gpt-5",
            @"messages": @[
                @{
                    @"role": @"system",
                    @"content": @"你是一个专业的AI助手。"
                },
                @{
                    @"role": @"user",
                    @"content": @"介绍一下人工智能的发展历史。"
                }
            ]
        };
        
        NSError *error;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:payload
                                                          options:0
                                                            error:&error];
        
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        [request setHTTPMethod:@"POST"];
        [request setValue:@"Bearer <token>" forHTTPHeaderField:@"Authorization"];
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

let url = "https://api.apimart.ai/v1/chat/completions"

(* 可替换为任意支持的模型 ID *)
let payload = {|{
  "model": "gpt-5",
  "messages": [
    {
      "role": "system",
      "content": "你是一个专业的AI助手。"
    },
    {
      "role": "user",
      "content": "介绍一下人工智能的发展历史。"
    }
  ]
}|}

let () =
  let headers = Header.init ()
    |> fun h -> Header.add h "Authorization" "Bearer <token>"
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
import 'package:http/http.dart' as http;

void main() async {
  final url = Uri.parse('https://api.apimart.ai/v1/chat/completions');
  
  // 可替换为任意支持的模型 ID
  final payload = {
    'model': 'gpt-5',
    'messages': [
      {
        'role': 'system',
        'content': '你是一个专业的AI助手。'
      },
      {
        'role': 'user',
        'content': '介绍一下人工智能的发展历史。'
      }
    ]
  };
  
  final response = await http.post(
    url,
    headers: {
      'Authorization': 'Bearer <token>',
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

url <- "https://api.apimart.ai/v1/chat/completions"

# 可替换为任意支持的模型 ID
payload <- list(
  model = "gpt-5",
  messages = list(
    list(
      role = "system",
      content = "你是一个专业的AI助手。"
    ),
    list(
      role = "user",
      content = "介绍一下人工智能的发展历史。"
    )
  )
)

response <- POST(
  url,
  add_headers(
    Authorization = "Bearer <token>",
    `Content-Type` = "application/json"
  ),
  body = toJSON(payload, auto_unbox = TRUE),
  encode = "raw"
)

cat(content(response, "text"))
```

```json 200 theme={null}
{
  "code": 200,
  "data": {
    "id": "chatcmpl-9876543210",
    "object": "chat.completion",
    "created": 1677652288,
    "model": "gpt-5",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "人工智能（AI）的发展历史可以追溯到20世纪50年代...\n\n1. **早期阶段（1950s-1960s）**：图灵测试的提出标志着AI研究的开始...\n\n2. **专家系统时代（1970s-1980s）**：基于规则的系统开始应用于医疗诊断、金融分析等领域...\n\n3. **机器学习兴起（1990s-2000s）**：统计学习方法逐渐成为主流...\n\n4. **深度学习革命（2010s-至今）**：神经网络技术的突破带来了AI的爆发式发展..."
        },
        "finish_reason": "stop"
      }
    ],
    "usage": {
      "prompt_tokens": 28,
      "completion_tokens": 320,
      "total_tokens": 348
    }
  }
}
```

```json 400 theme={null}
{
  "error": {
    "code": 400,
    "message": "请求参数无效",
    "type": "invalid_request_error"
  }
}
```

```json 401 theme={null}
{
  "error": {
    "code": 401,
    "message": "身份验证失败，请检查您的API密钥",
    "type": "authentication_error"
  }
}
```

```json 402 theme={null}
{
  "error": {
    "code": 402,
    "message": "账户余额不足，请充值后再试",
    "type": "payment_required"
  }
}
```

```json 403 theme={null}
{
  "error": {
    "code": 403,
    "message": "访问被禁止，您没有权限访问此资源",
    "type": "permission_error"
  }
}
```

```json 429 theme={null}
{
  "error": {
    "code": 429,
    "message": "请求过于频繁，请稍后再试",
    "type": "rate_limit_error"
  }
}
```

```json 500 theme={null}
{
  "error": {
    "code": 500,
    "message": "服务器内部错误，请稍后重试",
    "type": "server_error"
  }
}
```

```json 502 theme={null}
{
  "error": {
    "code": 502,
    "message": "网关错误，服务器暂时不可用",
    "type": "bad_gateway"
  }
}
```

## Authorizations

**Authorization** `string` *required*

所有接口均需要使用Bearer Token进行认证

获取 API Key：

访问 [API Key 管理页面](https://apimart.ai/keys) 获取您的 API Key

使用时在请求头中添加：

```
Authorization: Bearer YOUR_API_KEY
```

## Body

**model** `string` *required* (default: gpt-5)

模型名称

支持的模型包括：

* **OpenAI**: `gpt-5`, `gpt-5.1`, `gpt-5-chat-latest`, `gpt-5-mini`
* **Anthropic**: `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-5-20251101`
* **Google**: `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3-pro-preview`, `gemini-3-pro-preview-thinking`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`
* **DeepSeek**: `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2`, `deepseek-v3.2-exp`, `deepseek-r1-250528`, `deepseek-v3-0324`
* 更多模型持续更新中...

**messages** `array` *required*

对话消息列表

消息数组，每条消息包含 `role` 和 `content` 两个字段。

**💡 快速填写（Try it 区域）：**

1. 点击 "+ Add an item" 添加一条消息
2. `role` 输入：`user`（用户消息）、`assistant`（AI回复）或 `system`（系统提示词）
3. `content` 输入：你想说的话

**详细字段说明**

**role** `string` *required* (default: user)

角色类型

可选值：`user`（用户消息）、`assistant`（AI回复，用于多轮对话）、`system`（系统提示词，设置AI行为）

**content** `string` *required*

消息内容

填写你想说的话或问题

**示例：**

```json theme={null}
[{"role": "user", "content": "你好，请介绍一下你自己"}]
```

**进阶用法：**

添加系统提示词（让 AI 扮演特定角色）：

```json theme={null}
[
  {"role": "system", "content": "你是专业的Python导师"},
  {"role": "user", "content": "如何学习编程？"}
]
```

多轮对话（包含上下文）：

```json theme={null}
[
  {"role": "user", "content": "你好"},
  {"role": "assistant", "content": "你好！有什么可以帮你的？"},
  {"role": "user", "content": "介绍一下人工智能"}
]
```

**角色说明：**

* `user`: 用户消息（大多数情况用这个）
* `system`: 系统提示词，设置 AI 的行为和角色
* `assistant`: AI 的历史回复，用于多轮对话时提供上下文

**temperature** `number`

控制输出随机性，范围 0-2

* 较低的值（如 0.2）使输出更确定
* 较高的值（如 1.8）使输出更随机

默认值：1.0

**max\_tokens** `integer`

生成的最大token数量

不同模型有不同的最大值限制，请参考具体模型文档

**stream** `boolean`

是否使用流式输出

* `true`: 流式返回（SSE格式）
* `false`: 一次性返回完整响应

默认值：true

**top\_p** `number`

核采样参数，范围 0-1

控制生成文本的多样性，建议与 temperature 二选一使用

默认值：1.0

**frequency\_penalty** `number`

频率惩罚，范围 -2.0 到 2.0

正值会降低重复使用相同词汇的可能性

默认值：0

**presence\_penalty** `number`

存在惩罚，范围 -2.0 到 2.0

正值会增加谈论新主题的可能性

默认值：0

**stop** `string or array`

停止序列

最多4个序列，遇到这些序列时将停止生成

**n** `integer`

生成的回复数量

默认值：1

**⚠️ 注意：** 必须输入纯数字（如 `1`），不要加引号，否则会报错

## Response

**id** `string`

响应的唯一标识符

**object** `string`

对象类型，固定为 `chat.completion`

**created** `integer`

创建时间戳

**model** `string`

实际使用的模型名称

**choices** `array`

生成的回复列表

**属性**

**index** `integer`

选项索引

**message** `object`

消息内容

**属性**

**role** `string`

角色类型（assistant）

**content** `string`

生成的文本内容

**finish\_reason** `string`

结束原因

可能的值：

* `stop` - 自然结束
* `length` - 达到最大长度
* `content_filter` - 内容过滤
* `function_call` - 函数调用

**usage** `object`

token使用统计

**属性**

**prompt\_tokens** `integer`

输入消息的token数

**completion\_tokens** `integer`

生成内容的token数

**total\_tokens** `integer`

总token数

## 支持的模型列表

### OpenAI 系列

* `gpt-5` - GPT-5 基础模型
* `gpt-5.1` - GPT-5.1 增强版本
* `gpt-5-chat-latest` - GPT-5 最新对话版本
* `gpt-5-mini` - GPT-5 轻量级版本，性价比高

### Anthropic 系列

* `claude-opus-4-8` - Claude Opus 4.8 旗舰模型
* `claude-opus-4-7` - Claude Opus 4.7 旗舰模型
* `claude-opus-4-6` - Claude Opus 4.6 旗舰模型
* `claude-sonnet-4-6` - Claude Sonnet 4.6 平衡版本
* `claude-opus-4-5-20251101` - Claude Opus 4.5 模型

### Google 系列

* `gemini-3.5-flash` - Gemini 3.5 快速版
* `gemini-3.1-pro-preview` - Gemini 3.1 Pro 预览版
* `gemini-3-pro-preview` - Gemini 3 Pro 预览版
* `gemini-3-pro-preview-thinking` - Gemini 3 Pro 深度思考预览版
* `gemini-3-flash-preview` - Gemini 3 Flash 预览版
* `gemini-2.5-pro` - Gemini 2.5 专业版
* `gemini-2.5-flash` - Gemini 2.5 快速版
* `gemini-2.5-flash-lite` - Gemini 2.5 超轻量版

### DeepSeek 系列

* `deepseek-v4-pro` - DeepSeek V4 专业版
* `deepseek-v4-flash` - DeepSeek V4 快速版
* `deepseek-v3.2` - DeepSeek V3.2 标准版
* `deepseek-v3.2-exp` - DeepSeek V3.2 实验版
* `deepseek-r1-250528` - DeepSeek R1 推理模型
* `deepseek-v3-0324` - DeepSeek V3 标准版

## 使用示例

### 基础对话

```json theme={null}
{
  "model": "gpt-5",
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}
```

### 系统提示词

```json theme={null}
{
  "model": "claude-sonnet-4-6",
  "messages": [
    {"role": "system", "content": "你是一位专业的Python编程导师"},
    {"role": "user", "content": "如何使用列表推导式？"}
  ]
}
```

### 多轮对话

```json theme={null}
{
  "model": "gemini-2.5-flash",
  "messages": [
    {"role": "user", "content": "什么是机器学习？"},
    {"role": "assistant", "content": "机器学习是人工智能的一个分支..."},
    {"role": "user", "content": "能举个例子吗？"}
  ]
}
```

### 流式输出

```json theme={null}
{
  "model": "gpt-5",
  "messages": [
    {"role": "user", "content": "写一首关于春天的诗"}
  ],
  "stream": true
}
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.