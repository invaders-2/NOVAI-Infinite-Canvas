> ## Documentation Index
> Fetch the complete documentation index at: https://docs.apimart.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# 获取任务状态

>  - 查询异步任务的执行状态和结果
- 实时状态更新和进度跟踪
- 任务完成时获取生成结果
- 支持 10 种语言的错误文案返回（en/zh/ja/ko/ru/fr/de/id/pt/es） 

```bash cURL theme={null}
curl --request GET \
  --url 'https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh' \
  --header 'Authorization: Bearer <token>'
```

```python Python theme={null}
import requests

url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt"

headers = {
    "Authorization": "Bearer <token>"
}

params = {
    "language": "zh"
}

response = requests.get(url, headers=headers, params=params)

print(response.json())
```

```javascript JavaScript theme={null}
const url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";

const headers = {
  "Authorization": "Bearer <token>"
};

fetch(url, {
  method: "GET",
  headers: headers
})
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```

```go Go theme={null}
package main

import (
    "fmt"
    "io/ioutil"
    "net/http"
)

func main() {
    url := "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh"

    req, _ := http.NewRequest("GET", url, nil)
    req.Header.Set("Authorization", "Bearer <token>")

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
        String url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer <token>")
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}
```

```php PHP theme={null}
<?php

$url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer <token>"
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

url = URI("https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh")

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Get.new(url)
request["Authorization"] = "Bearer <token>"

response = http.request(request)
puts response.body
```

```swift Swift theme={null}
import Foundation

let url = URL(string: "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh")!

var request = URLRequest(url: url)
request.httpMethod = "GET"
request.setValue("Bearer <token>", forHTTPHeaderField: "Authorization")

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
using System.Threading.Tasks;

class Program
{
    static async Task Main(string[] args)
    {
        var url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Add("Authorization", "Bearer <token>");

        var response = await client.GetAsync(url);
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
        const char *url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";

        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, "Authorization: Bearer <token>");

        curl_easy_setopt(curl, CURLOPT_URL, url);
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
        NSURL *url = [NSURL URLWithString:@"https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh"];
        
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        [request setHTTPMethod:@"GET"];
        [request setValue:@"Bearer <token>" forHTTPHeaderField:@"Authorization"];
        
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

let url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh"

let () =
  let headers = Header.init ()
    |> fun h -> Header.add h "Authorization" "Bearer <token>"
  in
  
  let response = Client.get ~headers (Uri.of_string url) >>= fun (resp, body) ->
    body |> Cohttp_lwt.Body.to_string >|= fun body_str ->
    print_endline body_str
  in
  Lwt_main.run response
```

```dart Dart theme={null}
import 'package:http/http.dart' as http;

void main() async {
  final url = Uri.parse('https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh');
  
  final response = await http.get(
    url,
    headers: {
      'Authorization': 'Bearer <token>',
    },
  );
  
  print(response.body);
}
```

```r R theme={null}
library(httr)

url <- "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh"

response <- GET(
  url,
  add_headers(
    Authorization = "Bearer <token>"
  )
)

cat(content(response, "text"))
```

```json 200 - 图像生成任务 theme={null}
{
  "code": 200,
  "data": {
    "id": "task_01KA040M0HP1GJWBJYZMKX1XS1",
    "status": "completed",
    "cost": 0.15,
    "credits_cost": 1.5,
    "progress": 100,
    "result": {
      "images": [
        {
          "url": [
            "https://upload.apimart.ai/f/image/9998236911693428-e8d7441f-f7b4-4130-97ad-9ef8a0dde2ce-image_task_01KA0413RT2GGNZJ9GWQ4PXF2F_0.png"
          ],
          "expires_at": 1763174708
        }
      ]
    },
    "created": 1763088289,
    "completed": 1763088308,
    "estimated_time": 60,
    "actual_time": 19
  }
}
```

```json 400 theme={null}
{
  "error": {
    "code": 400,
    "message": "无效的任务ID",
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

## Path parameters

**task\_id** `string` *required*

生成API返回的任务ID

## Query parameters

**language** `string`

失败任务中 `error.message` 的语言，支持以下值：

* `en` - 英语
* `zh` - 简体中文
* `ja` - 日语
* `ko` - 韩语
* `ru` - 俄语
* `fr` - 法语
* `de` - 德语
* `id` - 印度尼西亚语
* `pt` - 葡萄牙语
* `es` - 西班牙语

该参数只影响 `error.message`。不传或传入不支持的值时，返回原始错误文案。

## Response

**id** `string`

任务唯一标识符

**status** `string`

任务状态值：

* `pending` - 排队等待处理
* `processing` - 处理中
* `completed` - 成功完成
* `failed` - 失败
* `cancelled` - 用户取消

**cost** `number`

本次任务扣费金额

**credits\_cost** `number`

本次任务扣费积分

**progress** `integer`

任务进度百分比（0–100）

**result** `object`

任务结果，仅在状态为 `completed` 时返回

**属性**

**images** `array`

生成的图像对象数组（图像生成任务）

**videos** `array`

生成的视频对象数组（视频生成任务）

**created** `integer`

任务创建时间戳

**completed** `integer`

任务完成时间戳（仅在完成时存在）

**estimated\_time** `integer`

预计完成时间（秒）

**actual\_time** `integer`

实际完成时间（秒）（仅在完成时存在）

**error** `object`

错误详情（仅在状态为 `failed` 时存在）

**属性**

**code** `integer`

错误代码

**message** `string`

错误消息

**type** `string`

错误类型


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.