# 供应商级「能力覆盖」size_overrides

供应商（网关 / 中转站）对某个模型实际上只能出有限的比例与分辨率时，在该供应商的
`data/api_providers.json` 条目里加一个 `size_overrides` 字段即可；**不需要改代码**，
不同网关可以分别声明。未声明的供应商 / 模型行为与现在完全一致。

## 字段

```jsonc
"size_overrides": {
    "<模型名，必须与 image_models 中的名字完全一致>": {
        "ratios": ["1:1", "16:9"],   // 允许的宽高比；省略 = 不按比例收窄
        "resolutions": ["1k"],       // 允许的档位 id；省略 = 不按档位收窄
        "maxEdge": 2048,             // 可选：最长边上限（像素，>0 才生效）
        "maxPixels": 4194304         // 可选：面积上限（像素，>0 才生效）
    }
}
```

- `ratios` 写宽高比标签（`"1:1"` / `"16:9"`）；也接受画布内部 key（`square` / `wide` …）。
- `resolutions` 写档位 id（`"1k"` / `"2k"` / `"4k"`，小写；也支持 `"0.5k"` / `"1.5k"` / `"3k"`）。
- 数组里坏值会被丢弃；整段声明写坏时按“未声明”处理，不影响服务启动。

## 合并规则（`/api/ai/size-policy`）

1. 先按原有逻辑算出该 (供应商, 模型) 的全局协议策略（`model_protocols.json` / 默认 free）。
2. 若该供应商声明了该模型的覆盖，把 `ratios` / `resolutions` / `maxEdge` / `maxPixels`
   写入返回的策略 —— **覆盖优先于全局协议表**；只加被声明的字段，未声明字段原样保留。
3. 同名模型出现在多个供应商时：允许项取交集、边界取更小值，`mode` 仍保留更严格的一方
   （与既有行为一致）。
4. **未声明覆盖的模型返回结果与改动前逐字节一致**（不会多出任何字段）。
5. 前端（两套画布 + 在线生图页）把接口下发的覆盖合并到各自的静态预设表之上，
   只做收窄、不凭空放宽；因此覆盖项不会在前端再抄一份。

## 可直接复制的样例：把中转站 gemini-3.1-flash-image 收窄为「10 个比例 + 只有 1k」

实测该中转站恒只输出 1K，且只认 10 个比例类（`1:4 / 1:8 / 4:1 / 8:1` 会被回退成 1:1）：
见 `/tmp/novai-matrix-evidence/REPORT.md`。把下面这条加进 `data/api_providers.json`
的 `providers` 数组（密钥放 `API/.env`，**不要写进 JSON**）：

```jsonc
{
    "id": "sub2api",
    "name": "Sub2API",
    "base_url": "http://43.130.6.197:8080",
    "protocol": "openai",
    "enabled": true,
    "image_models": ["gemini-3.1-flash-image"],
    "size_overrides": {
        "gemini-3.1-flash-image": {
            "ratios": ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
            "resolutions": ["1k"]
        }
    }
}
```

只声明边界（不改比例/档位清单）的写法：

```jsonc
"size_overrides": {
    "some-model": { "resolutions": ["1k", "2k"], "maxEdge": 2048, "maxPixels": 4194304 }
}
```

## 验证

```bash
# 该模型应带上 ratios / resolutions；其它模型不带这两个字段
curl -s http://127.0.0.1:3000/api/ai/size-policy | python3 -m json.tool
```

## 为什么不放进 /api/ai/descriptor

descriptor 是 (供应商, 模型, 意图) 的可用性与参数 Schema 握手，尺寸消费方（两套画布 +
在线生图页）走的就是 `/api/ai/size-policy`；把覆盖再挂到 descriptor 会多一份无人消费的
契约，且没有增量收益。若将来有新的消费方只读 descriptor，再按同一份 `size_overrides`
合并即可。
