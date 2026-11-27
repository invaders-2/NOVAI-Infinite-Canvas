# APIMart 文档增量报告（2026-11-25 版）

> 基线：本项目 2026-11-18 定稿的数据层（`docs/apimart-docs/REPORT.md`、`REPORT-DELTA-20261118.md`、`catalog.json`、`params.json`、`server/protocols/protocol_updates.json` v1–v5、`main.py` 的 `APIMART_*_MODEL_CAPS`、`server/credits/apimart_pricing.json` 的 11-18 快照）。
> 新语料：`/tmp/apimart-llms-20261125.txt`（https://docs.apimart.ai/llms-full.txt），2,528,392 bytes / 92,103 行 / 196 个 Source 锚点，sha256 0393fa48…4eab82。下文 L#### 全部指该文件行号。
> 定价页面：`/tmp/apimart-pricing-20261125.html`（https://apimart.ai/zh/pricing），1,659,028 bytes，sha256 a617bfcd…38ac385a。
> 定价接口：`GET https://apimart.ai/api/pricing/model?model=ID`（免鉴权），全部数值为本日实测。
> **"新增"口径**：新语料（含定价页与定价接口）里出现、但 11-18 数据层（报告 + catalog + 能力表 + 更新包 + 价目）里没有记录的项；不确定一律写"未知"，不猜。
> **一处必须说清的限制**：11-18 的语料没留档，所以"页面增删"只能拿 11-06 的 186 页索引（`docs/apimart-docs/raw/llms-full-index.txt`）做集合差，再用 11-18 报告正文反查哪些页当时已经存在。凡涉及"11-18 之后才出现"的判断，都同时标了旁证强弱。

## 0. 一句话结论

1. **真正新增的图像模型 4 个（3 个新页面）**：`kling-v4-image`（2K/4K/8K）、`kling-v4-long-image`（电商长图 / 网页设计，8 个计费档）、`mai-image-2.7` 与 `mai-image-2.7-flash`（同页并列，1K/2K + 精确像素）。文本、视频、音频**没有**新增模型。
2. **另有 7 个"只出现在定价页/定价接口"的 chat 模型**：`gemini-4-carbon` / `-hydrogen` / `-neon`、`gpt-6.2-astra` / `-sol`、`claude-fable-5.2`、`qwen4-max`。文档 196 页 0 命中，只有定价页列表 + 定价接口 200（接口对乱写的模型 id 返回 404，所以能证明"在售"）。**证据只到"在售"，未验证"能调"**。
3. **两个文档页消失了**：`imagen-4.0-apimart`（定价页仍在售 → 文档缺失，别删模型）、`seedance-1-5-pro`（文档页消失 + 定价页 61 个视频模型里也没有 → 疑似下线）。
4. **协议侧 15 条（D1–D15），必须动代码的是 0 条**：本轮没有"不改就出错"的协议项。值得排期的只有 2 条：任务查询加 `?language=zh`（一行改动，中文报错）与 `POST /v1/tasks/batch`（能把多任务轮询合并，但文档只有一句话，需实测）。
5. **一条既有能力表 bug 被文档确证**：`apimart-zoe` 的参考媒体上限，能力表写 9 / 3 / 3，文档写 **30 张图 / 10 个视频 / 10 段音频**（L36104、L36118、L36126），差 3 倍，编辑器会把合法请求拦下来。
6. **定价页改版，旧解析器必然失败**：起步价索引从表格改成 h2 总表 + 4 个 h3 分组 + ul/li 行（所以 `parse_index()` 得 0 行）。可复现配方见 §7.3：图像详表仍走 `initialCatalog`（61 条），视频/LLM/音频的逐档价必须逐模型打免鉴权定价接口。本轮页面声明 **239 个模型**（图像 59 / 视频 61 / LLM 116 / 音频 3）。
7. 推理参数结论不变：`reasoning_effort` / `thinkingBudget` / `thinkingConfig` / `budget_tokens` 在新语料里仍是 **0 命中**；thinking 只在 35 处出现，均非 chat 顶层推理档位。

---

## 1. 文本（chat）

### 1.1 /v1/chat/completions 的 Supported Models 清单没变

文档正文的模型清单仍是那 24 个（L30622–L30627 与 L30824–L30882 两份重复列表）：OpenAI `gpt-5 / gpt-5.1 / gpt-5-chat-latest / gpt-5-mini`；Anthropic `claude-opus-4-8 / 4-7 / 4-6 / claude-sonnet-4-6 / claude-opus-4-5-20251101`；Google `gemini-3.5-flash / 3.1-pro-preview / 3-pro-preview / 3-pro-preview-thinking / 3-flash-preview / 2.5-pro / 2.5-flash / 2.5-flash-lite`；DeepSeek 6 个。与 11-18 报告 §1.1 结论一致，**没有新增**。

### 1.2 定价页独有的 7 个 chat 模型（证据弱，未入产品白名单）

下列 id 在 196 页文档里 **0 命中**，但出现在新定价页的 LLM 索引（116 行）里，且定价接口返回 200：

| 模型 ID | 定价页标价（USD / 1M tokens） | 证据 | 分类 |
| - | - | - | - |
| `gemini-4-hydrogen` | 输入 1.2 / 输出 6 | 定价页 LLM 索引 + 接口 200 | 新增（仅定价页） |
| `gemini-4-carbon` | 输入 1.6 / 输出 8 | 同上 | 新增（仅定价页） |
| `gemini-4-neon` | 输入 2.4 / 输出 12 | 同上 | 新增（仅定价页） |
| `gpt-6.2-astra` | 输入 6.4 / 输出 32 | 同上 | 新增（仅定价页） |
| `gpt-6.2-sol` | 输入 1.6 / 输出 8 | 同上 | 新增（仅定价页） |
| `claude-fable-5.2` | 输入 6.4 / 输出 32 | 同上 | 新增（命名可疑，见 U20） |
| `qwen4-max` | 输入 1.4286 / 输出 4.2857 | 同上 | 新增（仅定价页） |

对照组：`gemini-4-argon`、`claude-fable-5` / `5.1`、`gemini-3.7-flash` / `3.8-flash`、`kimi-k3`、`glm-5.3` 这些"看起来新"的 id，在 11-18 的价目快照里**已经存在**（`server/credits/apimart_pricing.json` 的 191 个 chat 条目），所以不算新增——这也说明"catalog 里没有"不等于"数据层没有"，判新增必须连价目一起查。

### 1.3 别名写法 / 不是可传 model

| 写法 | 证据 | 判定 |
| - | - | - |
| `gemini-3-pro-preview-nothinking` | 定价页把 -nothinking 与 -thinking 写在同一行 | 别名（我们 catalog 只有 gemini-3-pro-preview-thinking） |
| `qwen-turbo-0624 / 0919 / 1101 / 2024-06-24 / 2024-09-19 / 2024-11-01 / 2025-04-28 / 2025-07-15` | 定价页一行里逗号列 8 个同价别名 | 别名写法，不要建 8 个条目 |
| `seedream-5.0-lite` / `Seedream-5.0-lite` | L27845：“Supported models: seedream-5-0-lite、seedream-5.0-lite、Seedream-5.0-lite” | 别名（大小写/点号写法都收） |
| `seedream-5.0-pro` | L25198：seedream-5-0-**flash** 页写 “Also accepted: seedream-5.0-pro” | **坑**：它是 flash 的别名，不是 5-0-pro 模型 |
| `doubao-seedance-2.0` | L53802、L53860（定价接口示例与响应） | seedance-2.0 的官方别名 |
| `gpt-4o / gpt-4.1 / gpt-4.1-mini / gemini-2.0-flash-exp / claude-3` | L6168、L88673、L90781、L92046（cherry-studio / cursor / cc-switch 等接入页的选模型清单） | 第三方客户端示例，不入目录 |


---

## 2. 图像（image）

### 2.1 三个新页面 → 4 个新模型

#### 2.1.1 kling-v4-image（L10193 起，参数 L10285–L10350，计费 L10472–L10484）

| 项 | 文档原文 |
| - | - |
| 入口 | `POST /v1/images/generations`，异步，读 `data[0].task_id`（L10195、L10277） |
| resolution | `2K`（默认）/ `4K` / `8K`，大小写不敏感；1:1 时分别 2048 / 4096 / 8192（L10316–L10320） |
| size | `auto`（默认）+ 8 个比例 `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 21:9`；像素尺寸不支持；`aspect_ratio` 是 `size` 别名且优先（L10322–L10332） |
| n | 1–9，默认 1；系列模式必须省略或 1（L10312–L10314） |
| 系列模式 | `sequential_image_generation: "auto"` + `sequential_image_generation_options.max_images` 2–4（必填，不接受字符串 auto）（L10334–L10346） |
| 参考图 | `image_urls` ≤10 张，单张 ≤30MB、两边 ≥300px、比例 2:5–5:2；提示词里用 ```Image1` … ```Image10` 指代（L10302–L10310） |
| 明确 400 | `width` / `height` / `mask_url` / 像素 size / `watermark: true`（L10348–L10350） |
| 计费键 | `kling-v4-image@2K` / `kling-v4-image@4K` / `kling-v4-image@8K` / `kling-v4-image@input`（L10476–L10481） |
| 工程注意 | `estimated_time` 固定 60s，不能当倒计时（L10437）；8K 单张可达 100 MB+，列表必须用缩略图（L10439） |

#### 2.1.2 kling-v4-long-image（L10508 起，模式 L10604–L10609，参数 L10617–L10674，计费 L10795–L10808）

| 项 | 文档原文 |
| - | - |
| 定位 | 一请求出**一张长图**：`ecommerce` 出商品详情长图，`webpage` 出网页设计图（L10510–L10511、L10602） |
| skill | **必填**，`ecommerce` 或 `webpage`，大小写不敏感（L10634–L10636） |
| length | 仅 `skill=ecommerce`：`short` / `medium`（默认）/ `long`，约 2–5 / 6–10 / 11–18 个内容段；webpage 模式传了直接 400（L10638–L10640） |
| resolution | `1K`（默认）/ `2K`，`4K` 不支持；输出宽 1024 / 2048 px，高随内容（L10642–L10644） |
| 参考图 | ecommerce：`image_urls` **1–3 张必填**；webpage：`image_with_roles` 里 `style` / `subject` 各最多 1 张（L10646–L10662） |
| 限制 | `n` 只能 1；`watermark: true` 400；`size` / `aspect_ratio` / `width` / `height` / `mask_url` / `sequential_*` **一律 400（即使传 null 或空串）**（L10664–L10674） |
| 计费档 | 8 个：`1K/2K` × `SHORT / MEDIUM / LONG / WEBPAGE`，另有 `…@input` 按参考张数计（L10798–L10806） |
| 新字段 | 任务响应 `data.billing_status` = `held`（预扣）/ `settled` / `refunded`，`data.cost` 预扣额 → 结算额（L10759–L10761、L10772） |
| 工程注意 | 生成通常数分钟（long+2K 实测 432s）；`estimated_time` 恒为 60，不能当超时阈值；long+2K 实测 2048×46615、63.9 MB（L10791–L10793） |

#### 2.1.3 mai-image-2.7 / mai-image-2.7-flash（L11145 起，参数 L11331–L11456）

| 项 | 文档原文 |
| - | - |
| 两个模型 | 同一页并列：`mai-image-2.7`（高质量）与 `mai-image-2.7-flash`（更快更便宜），**能力与参数完全一致**（L11150、L11339–L11342） |
| prompt | 中文/英文都行，上限 20,000 字符，超长 400（L11351–L11357） |
| n | 固定 1，>1 或 ≤0 都 400（L11359–L11367） |
| size | 两种形态：① 比例 `1:4`–`4:1` 任意整数比（配 resolution 决定像素）；② 精确像素 `宽x高`（也收 `宽*高` 与 `宽×高`），要求两边 ≥768、总像素 ≤4,194,304、**各自向下取 32 的倍数**（1000x1000 → 992x992）（L11369–L11388）；auto 不支持（L11386–L11388） |
| resolution | `1K`（默认）/ `2K`，`4K` 不支持；13 组比例的像素映射表在 L11398–L11412 |
| width / height | 必须成对，优先级最高（覆盖 size/resolution），仅文生图（L11418–L11428） |
| 参考图 | `image_urls` ≤5 张；收公网 URL 或 **base64 data URI**；JPEG/PNG，WEBP/GIF 自动转 PNG；图生图时 size/resolution/width/height 全部失效（L11430–L11442） |
| background | `auto` / `opaque`（等同省略）；**transparent 还不支持，传了 400**（L11444–L11452） |
| 明确忽略 | `quality` / `style` / `output_format` / `response_format` / `mask_url`（L11456） |
| 明确 400 | `4K`、`auto_aspect_ratio`、`web_grounding`（L11456） |
| 计费 | 页面无 Billing 段，实际是 token 计费 + 按档预扣，见 §7.1 |

### 2.2 已有图像模型复核（都无变化）

| 模型 | 复核结论 | 证据 |
| - | - | - |
| seedream-5-5 | n 只能 1、参考 0–10、透明背景要 `output_format=png`，与 11-18 §2 一致 | L26886 起 |
| minimax-h3-image / -highspeed | 与 11-13/11-18 记录一致 | L21732、L21292 |
| gpt-image-2.6 家族 svg.reasoning.effort | 仍在（11-18 §2.1 已记录），档位表未变 | L6549、L6566、L6671 |
| flux-3-image-klein / flux-3-image | 参数页无结构性变化 | L388、L736 |

### 2.3 文档缺失 / 页面消失

- `imagen-4.0-apimart`：11-06 索引里有 `images/imagen-4.0-apimart/generation`，本轮 196 个锚点里**没有**，全文 grep imagen **0 命中**。但新定价页 initialCatalog 里**仍然有** `imagen-4.0-apimart`（default 档：标价 0.05 / 实付 0.04 / 铂金 0.038 / 钻石 0.036）。→ 结论：**文档删了、还在卖**；catalog 不要删，只把 notes 标成“2026-11-25 文档页已下线”。


---

## 3. 视频（video）

**没有新增视频模型。** 12 个新增页面里 5 个是视频页（apimart-zoe、gemini-omni-1.2-flash、gemini-omni-1.2-flash-ext、kling-v4-flash、seedance-2-5-flash），全部已在 catalog 里（11-13 批次补录 + 11-18 新增）。

### 3.1 逐项复核

| 模型 | 变化 | 证据 |
| - | - | - |
| seedance-2-5-flash | **无变化**：仍明确不支持 `draft` / `draft_task_id`，传了 400 并指向 seedance-2.5 | L45662、L45845 |
| seedance-2.5 | **无变化**：resolution 仍 480p/720p/1080p/4k；草稿 3 天有效、成片只收 1080p/4k、继承字段不得重发 | L45859、L45864、L46524、L46166–L46172 |
| apimart-zoe | 参数复核与 11-13 记录一致（draft 480p → draft_task_id 1080p），**另补两处**：草稿 **24 小时**内必须出片、成片禁发 `seed` / `audio` / `generate_audio` | L36130–L36138、L36256–L36268 |
| apimart-zoe | **能力表上限与文档不一致（要改）**：文档 `image_urls` ≤30、`video_urls` ≤10、`audio_urls` ≤10；main.py 里是 9 / 3 / 3 | L36104、L36118、L36126 vs `main.py:28956` |
| kling-v4-flash | 与 11-18 记录一致（只有 720p；`kling-v4-flash@720P` 是计费档名不是模型） | L83422 起 |
| flux-3-video | 统一入口：mode = `t2v / i2v / v2v / draft_enhance`（也收官方写法 text-to-video / image-continuation / video-continuation）；草稿两步用 `draft:true` → `draft_from_task_id`（**注意：不是 seedance 的 draft_task_id**）；duration "auto" 不支持，按 5 秒处理；参数 `safety_tolerance` 0–4 | L37063–L37113、L37150–L37174 |

### 3.2 seedance-1-5-pro 疑似下线

11-06 索引里有 `videos/seedance-1-5-pro/generation`，本轮 196 个锚点里**没有**，全文 grep `seedance-1-5` **0 命中**；新定价页 61 个视频模型里也**没有**它。→ 文档 + 在售两侧同时消失，**疑似下线**（无官方公告，见 U25）。我们 catalog(video) 与 main.py 的 `seedance-1-5-pro` 映射应视为陈旧候选，先别删，等实测。

---

## 4. 音频（audio）

**音频分类修正（2026-11-26 复核，覆盖本节原判断）**：

- 文档页**没有新增音频模型**；但定价页音频组只有 3 行（flowmusic / suno / whisper-1）也不完整。
  用 API/.env 的 APIMart key 实测 `GET https://api.apimart.ai/v1/models?expand=category`（262 个模型）：
  **audio 共 5 个 = flowmusic / gpt-4o-mini-tts / gpt-audio-mini / suno / whisper-1**。
  其中 **gpt-audio-mini 全仓此前 0 命中**（文档 196 页也没有），只有上游实测证据。
- **Lyria 3.5 不是独立模型 ID**：文档 L56840 起四页（generate / cover / extend / replace）的请求体是
  `{"model":"flowmusic","version":"lyria-3.5",...}`，它是 flowmusic 的 version 取值；我们 catalog 原来
  误列了 `lyria-3.5` 与 `flowmusic-lyria-3.5` 两条独立模型（已删，版本说明并入 flowmusic 条目）。
- 定价接口口径：gpt-audio-mini / gpt-4o-mini-tts 是 tiered_token（usd_per_million_tokens，含
  audio_input / audio_output 分价）；whisper-1 是 **per_minute**（`price_per_minute=0.006`）；
  suno 是 suno_action、flowmusic 是 flowmusic@generate（已有 lyria-3-pro / lyria-3.5 两个 spec 档）。

只有两处端点弃用需要留档：

| 项 | 文档原文 | 证据 |
| - | - | - |
| wav 端点弃用 | 旧的 `POST /v1/music/generations/wav` 仍兼容，等价于新端点 + `formats: ["wav"]`；新端点是 `POST /v1/music/generations/download` | L77280 |
| vox 端点弃用 | 新接入不要再用 `vox_audio_id` 当必填 | L77240、L76668 |

我们的音频路径不直接调 wav（走 generate + `/v1/music/tasks/ID` 轮询），**无影响**。


---

## 5. 协议 / 接口变化（15 条，含“要不要接”）

| # | 端点 / 字段 | 文档现值 | 证据 | 我们现状 | 要不要接 |
| - | - | - | - | - | - |
| D1 | webhook_secret 长度与优先级 | secret **8–256 bytes**（UTF-8 计字节，CJK 一字 3 字节），禁空白/控制字符；三层优先级：请求体 > 控制台 Callback signing > **旧版通知设置**（11-18 只记了两层）；轮换时旧密钥最长再签 **20 分钟** | L79877–L79882、L79868–L79875、L79933–L79942 | 纯轮询，不用 webhook | 暂不接。接的时候注意 11-18 记的“≥16 字符”是**错的**，按字节校验 |
| D2 | `GET /v1/logs/requests`（+`/ID`）细节 | 单条可按同步响应的 `X-Oneapi-Request-Id` 头或异步 task_id 查；sync 支持 start/end_timestamp（≤31 天）、type=all/consume/error、model、token_id、limit 1–1000、cursor；watermark = 服务器时间 −300s；对账建议 end 不晚于 watermark、下一轮从上一轮 end 前 10 分钟起、按 (id,type) 去重；cost_credits = USD × 10 | L53891–L53897、L53909、L53941–L53973 | 未接 | 值得接（做积分对账），但不是本轮 |
| D3 | `POST /v1/logs/export` | 异步导出调用明细（CSV / XLSX）；**只在一张对比表里出现一句，无独立页无参数文档** | L54762–L54763 | 未接 | 不接（证据太弱） |
| D4 | `GET /v1/dashboard/billing/usage` | 只给累计花费，无模型/时间过滤；另有 …/subscription | L54761、L35657–L35658 | 未接 | 不接（被 /v1/usage 取代的老接口） |
| D5 | `GET /v1/usage` 参数补全 | start/end（unixtime 或 RFC3339，区间 [start,end)，≤31 天）、model（逗号分隔 ≤50，精确且大小写不敏感、不支持通配）、group_by=none/model/date/model,date、tz=IANA（默认 Asia/Shanghai）、scope=key/account；60 次/分/Key，同参缓存 60s（X-Usage-Cache: hit/miss）；数据自 2026-04-27；503 usage_unavailable 不得当 0 | L54577–L54621、L54722–L54736、L54751–L54755 | 未接 | 接用量面板时按这个口径 |
| D6 | `GET /v1/pricing/model`（鉴权） | model 支持别名；spec 参数 resolution/size/quality/duration(1–3600)/n(1–100)；返回 unit=per_image/per_call/per_second/per_million_tokens、unit_prices、total_usd、estimated、price_source=membership/user_override/group/default、canonical_model、spec_source、price_factors、membership_tier；60 次/分/Key；错误码 no_valid_pricing / model_not_found / 429 | L53983–L54022、L54033–L54035 | 未接 | 接“调用前报价”时按 no_valid_pricing 分支 |
| D7 | `POST /v1/tasks/batch` | 批量查任务：body {task_ids:[task_xxx,task_yyy]}；**只在三处模型页以一句 TIP 出现**（L5743、L6234、L6647），无独立页/错误码 | L5743、L6234、L6647 | 单任务串行轮询 | 有价值（合并多任务轮询），文档不足 → 列入待实测 |
| D8 | 任务查询 `?language=` | `GET /v1/tasks/ID?language=en` 可取 10 种语言的 error.message（en/zh/ja/ko/ru/fr/de/id/pt/es；两字母码，大小写不敏感、去空白，zh-CN 不认）；只影响 error.message | L79595–L79612、L8581、L57126、L70251 | 不带 | **建议接**：拼 URL 一行，中文用户直接看到中文报错 |
| D9 | 任务响应 data.billing_status | pending/processing → held（data.cost 为预扣）；completed → settled；failed → refunded 且 cost=0 | L10759–L10761、L10772 | 只读 status/result | 只在 kling-v4-long-image 页出现，是否全平台未知 → 先实测 |
| D10 | 上传配额细节 | 响应头 X-Upload-Quota-Limit / -Remaining / -Reset；无限账号 quota={unlimited:true}；错误里 overage.reason=overage_not_enabled/needs_reconfirm/insufficient_balance/insufficient_key_quota；图片校验 40MP / 单边 32768px / GIF ≤500 帧；另有 1000 请求/Key/60s 的独立限流 | L80444–L80468、L80470–L80490 | 上传不传 retention_days（11-18 就标了 P0 计费风险，**本轮仍未改**） | 头/枚举只在做“上传计费展示”时用；主坑还是 retention_days |
| D11 | Suno 端点弃用 | wav → /v1/music/generations/download + formats；vox 弃用 | L77280、L77240 | 不直调 | 无影响，留档 |
| D12 | `GET /api/pricing/model` 契约细化 | 只读 data.pricing；rates=标价、effective_rates=**实付**（不要自己乘）；extras.tools[x].price 是标价要自己乘 price_factor；unit=usd_per_1000_queries/usd_per_page；**tier_count>1 才有 tiers（不能靠 billing_type 判断）**；字段缺省=不适用（不是 0/免费），显式 0=免费；limits.supports_cache_read/write 是能力位；pricing_mode=standard/image_modalities 互斥 | L35691–L35802、L35850、L35890 | 价目工具按自建规则解析 | 改工具时必须按这套语义（尤其 effective_rates 与 tier_count） |
| D13 | `GET /v1/models?expand` + 单模 /schema | 复核**无变化**：expand=category/parameters、category 过滤、parameters 只覆盖 image/video（chat/audio 只有 category + capability_tags）、schema_version=2026-07-30、source=base/task_model_registry、anyOf、单模 /v1/models/ID/schema 与 /v1/model-schema?model=、expand=parameters 可达数百 KB 建议 gzip | L33602–L33786 | 只用裸 /v1/models 做连通性探测 | 没变；仍是用接口替代手写能力表的唯一入口，本轮 4 个新图像模型的参数契约也能从这拿 |
| D14 | Midjourney v7 draft | MJ 参数表 draft / --draft 标注 **Draft mode (v7+)** | L13533、L14834、L11707 | 只用 imagine/upscale | 能力表加一行留档即可 |
| D15 | /v1/messages 响应 usage 透传字段 | usage 里可能出现 service_tier、inference_geo、cache_creation{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}、output_tokens_details{thinking_tokens}；**流式 message_delta.usage 只有 4 个 token 字段**，其余按可选处理 | L33173–L33187、L33508、L33516 | 只读 input/output tokens | 要显示“思考/缓存 token”时按可选解析，不能严格 schema 校验 |


---

## 6. 对我们代码的影响点

| # | 位置 | 现状 | 本轮处理（给执行岗） |
| - | - | - | - |
| I1 | main.py `APIMART_IMAGE_MODEL_CAPS` | 无 `kling-v4-image` | 新增：ratios = auto + 8 个、resolutions = 2K/4K/8K、n_max=9、mask_url=False、base64_refs=False（文档只收公网 URL）、ref_max=10、系列模式 2–4 |
| I2 | 同上 | 无 `kling-v4-long-image` | 新增：ratios=()、resolutions=1K/2K、n_max=1、ref_max=3、skill(ecommerce/webpage)、length(short/medium/long 仅 ecommerce)、image_with_roles(style/subject)、watermark 不可开 |
| I3 | 同上 | 无 `mai-image-2.7` / `-flash` | 新增两条：ratios 1:4–4:1 任意整数比、resolutions 1K/2K、n_max=1、base64_refs=True、ref_max=5、background auto/opaque；exact_size 要按“宽高成对、两边 ≥768、总像素 ≤4,194,304、向下取 32 的倍数”收敛（**不能复用 gpt-image 的 3840 长边规则**） |
| I4 | main.py `APIMART_BUILTIN_MODEL_IDS` | 无新 id | 补 4 条映射，否则能力表命中不到 |
| I5 | `APIMART_VIDEO_MODEL_CAPS["apimart-zoe"]` | ref_max 9 / video_ref_max 3 / audio_ref_max 3 | 文档是 30 / 10 / 10（L36104/36118/36126），实测后改；另可补 enhance_prompt / output_format(mov) / first_frame_image / last_frame_image |
| I6 | server/credits/apimart_pricing.json | 无 4 个新模型；veo3.1-lite-ext / quality-ext 只有单档 | 补 4 个新模型（含 kling-v4-image 三档 + input、long-image 八档 + input、mai 两档预扣 + 多模态 token rate）；两个 veo 改三档；source 标 `api:pricing/model@2026-11-25` |
| I7 | docs/apimart-docs/catalog.json | image 61 / video 65 | image 追加 4 条；`imagen-4.0-apimart`、`seedance-1-5-pro` 的 notes 标“2026-11-25 文档页已消失”；chat 若加 7 个仅定价页模型必须标 confidence=低 |
| I8 | server/protocols/protocol_updates.json | v1–v5 | 加 v6：protocol_changes 收 D1/D5/D6/D7/D8/D10/D11/D12 的文档确证项；new_models.image 追加 4 个；parameter_changes 记两个 veo 档位与 apimart-zoe 上限 |
| I9 | tools/apimart_pricing.py | `parse_index` 解析 0 行直接 SystemExit | 改成 h2 总表 + h3 分组 + li 行（§7.3）；视频/LLM/音频档位改由定价接口逐模型补；initialCatalog 继续管图像 |
| I10 | 编辑器参数面板 | 图像按通用 1K/2K/4K 档 | 新模型要补：kling-v4-image 的 **8K 档 + n 1–9 + 系列模式**；kling-v4-long-image 的 **skill / length 二级下拉**；mai-image-2.7 的 **13 组比例 + 宽高像素输入 + background** |
| I11 | 上传流程 | 不传 retention_days | 本轮不在数据层范围，仍未改；建议固定 retention_days=3 并读 expires_at |
| I12 | 任务查询 URL | 不带 language | 可选一行：拼 `?language=zh` |

---

## 7. 定价数据来源与解析配方

### 7.1 新模型实测价（免鉴权接口，2026-11-25）

接口：`GET https://apimart.ai/api/pricing/model?model=ID`（不要 Authorization）。
**域名注意：apimart.ai 稳定；api.apimart.ai 同一路径今天多次返回 000（连接被拒），解析器只用 apimart.ai。**
口径：`resolution_prices` 是**标价档**，`model_price` / `paid_price` 是默认档**实付（gold）**；platinum = gold × 0.95、diamond = gold × 0.9（与接口 `membership.levels.factor` 一致）。

| 模型 | 计费 | 实测价（USD，gold） |
| - | - | - |
| kling-v4-image | per_image | 2K 0.0571432 / 4K 0.0857144 / 8K 0.1428568；**输入参考图 0.0028568 / 张，最多 10 张，首张不免费** |
| kling-v4-long-image | per_image | 1K-SHORT 0.2142856、1K-MEDIUM 0.4285712、1K-LONG 0.7142856、1K-WEBPAGE 0.5、2K-SHORT 0.2571432、2K-MEDIUM 0.5、2K-LONG 0.7857144、2K-WEBPAGE 0.5428568；输入参考图 0.0028568 / 张，最多 3 张 |
| mai-image-2.7 | tiered_token（image_modalities） | 标价 text_input 5 / image_input 8 / image_output 34（每 1M tokens）；实付 4 / 6.4 / 27.2；**按档预扣 1K 0.035 / 2K 0.14** |
| mai-image-2.7-flash | 同上 | 标价 1.75 / 2.5 / 10；实付 1.4 / 2 / 8；预扣 1K 0.011 / 2K 0.041 |

原始 JSON 片段（kling-v4-long-image）：

```
"model_price": 0.4285712, "paid_price": 0.4285712, "default_resolution": "1K-MEDIUM",
"input_image_max_count": 3, "input_image_paid_price": 0.0028568, "input_image_first_free": false,
"resolution_paid_prices": {"1K-LONG": 0.7142856, "1K-MEDIUM": 0.4285712, "1K-SHORT": 0.2142856,
  "1K-WEBPAGE": 0.5, "2K-LONG": 0.7857144, "2K-MEDIUM": 0.5, "2K-SHORT": 0.2571432, "2K-WEBPAGE": 0.5428568}
```

（mai-image-2.7 侧是 `pricing.pricing_mode = "image_modalities"`、`rates.image_output = 34`、`precharge_prices.resolution_prices = {"1K":0.035,"2K":0.14}`、`limits.max_input_tokens = 32768`。）

### 7.2 变了档的模型（同接口前后对比）

| 模型 | 11-18 快照 | 2026-11-25 实测 | 判断 |
| - | - | - | - |
| veo3.1-quality-ext | 只有 default 一档，gold 1.0 / 秒 | 标价 720P 0.703125 / 1080P 0.7265625 / 4K 0.890625，paid 0.5625 | **降价 + 分档细化**（我们按单档报价会偏高） |
| veo3.1-lite-ext | 只有 default，gold 0.07 / 秒 | 标价 720P 0.046875 / 1080P 0.0703125 / 4K 0.234375，paid 0.0375 | 720P 降、4K 更贵，必须分档 |
| veo3.1-fast-ext | 快照无该 id（只有 `veo3.1-fast-ext（veo3.1-fast）` 这种带括号写法） | 标价 0.09375 / 0.1171875 / 0.28125，paid 0.075 | 补条目 |

对照（**没变**，可放心）：seedance-2-5-flash 480P 0.06312 / 480P-input 0.0384 / 720P 0.14192 / 720P-input 0.0864；veo3.1-quality-official paid 0.16；qwen-image-3.0 paid 0.0205712；grok-imagine-video 480P paid 0.04。


### 7.3 新定价页的解析配方（给执行岗照着改 tools/apimart_pricing.py）

**页面结构变了**：旧版是 h3 章节 + `<table><tr>` 起步价表，新版是

1. 一个 `<h2>`：文本“**全部 239 个 AI 模型起步价**”（示例 HTML 位置 993332）；
2. 紧接 4 个 `<h3>` 分组头，各带 `<span>` 计数：图像 59 / 视频 61 / LLM 116 / 音频 3（位置 993646 / 1017452 / 1041942 / 1092605）；
3. 每组一个 `<ul>`，行是 `<li>` 而不是 `<tr>` —— 所以 `parse_index()` 里 findall(tr) 拿 0 行，直接触发“起步价索引只解析到 0 行（预期 ~296）”。

实测样例：

```html
<h3 class="flex items-center gap-2 border-border border-b px-4 py-3 font-semibold text-[14px] text-foreground sm:px-5">图像<span class="font-normal text-[12.5px] text-muted-foreground tabular-nums">59</span></h3>
<ul class="grid lg:grid-cols-2">
  <li class="flex min-w-0 items-baseline justify-between gap-4 ...">
    <span class="min-w-0 text-[13.5px] [overflow-wrap:anywhere]"><a class="text-foreground underline-offset-4 hover:underline" href="/zh/model/flux-2-flex">flux-2-flex</a></span>
    <span class="shrink-0 text-right text-[12.5px] text-muted-foreground tabular-nums">$0.04/张</span>
  </li>
```

**配方（可复现）**：

1. 抓 `https://apimart.ai/zh/pricing`（**必须中文页**，英文页没有这张总表）。代理：`curl -x http://127.0.0.1:7897`。
2. 定位总表：`re.search(r"<h2[^>]*>(.*?)</h2>", html)`，校验文本含“个 AI 模型起步价”，从该 start 切段。
3. 分组头：`re.finditer(r"<h3[^>]*>(图像|视频|LLM|音频)(?:<span[^>]*>([0-9]+)</span>)?s*</h3>", seg)`；把 span 里的数字当校验和（实测 59/61/116/3 = 239）。
4. 行解析：每组 group_end 到下一组 start 之间 `re.finditer(r"<li[^>]*>(.*?)</li>")`，取该 li 内所有 span：**第一个 span = 模型名**（内部可能有 `<a href="/zh/model/SLUG">`），**最后一个 span = 起步价**：
   - `$0.032/张` → per_image；`$0.011/秒` → per_second；`$0.01/次` → per_call；
   - `输入 $8 / 输出 $40 · 每 100 万 token` → per_1m_tokens（input/output 两个 rate）；
   - 只有 `$0.0048`（如 whisper-1）→ 单位缺失，标 unknown。
5. **图像**的逐档详表仍在 RSC 里：`decode_rsc` 后取 initialCatalog 的 JSON（解码文本第 122342 字符处，JSON 长度 119625），`modelsByCategory.image` 共 **61 条**（含本轮 4 个新模型），每条有 `fixed_prices.items[]` 的 key / original_price / after_discount / member_prices{diamond,gold,platinum}，以及 size[]、member_saving_percent。
6. **视频 / LLM / 音频没有逐档详表**（HTML 里只有图像有 `<h3 title=…>` + `<table>` 卡片），必须逐模型打 `GET https://apimart.ai/api/pricing/model?model=ID` 补 resolution_prices / pricing.rates / effective_rates。

**缺口（必须知道）**：

- 图像详表 initialCatalog 只有 image；视频 61 / LLM 116 / 音频 3 只能靠接口逐拉（239 次请求，请加缓存）。
- 同一模型可能对应多张表（gpt-image-2.5-flare 与 -sunburst 各一张），要按 `<h3 title>` + 紧随的 `<table>` 关联。
- 页内模型数从 10-24 快照的 **296 行降到 239 行**（LLM 把 8 个 qwen-turbo 别名挤成一行；音频 43 行降到 3 行），**不能再用行数判断模型增删**。
- 没观察到“加载更多”按钮，239 与 h2 声明数一致，可认为索引完整。

---

## 8. 页面增删与模型 ID 分类核对

### 8.1 页面集合差（196 vs 11-06 的 186）

| 增（12） | 是否 11-18 已覆盖 | 结论 |
| - | - | - |
| account/request-logs | 部分（端点已记，细节未记） | 文档合并页，细节见 D2/D6 |
| images/kling-v4-image | 否 | **真新增** |
| images/kling-v4-long-image | 否 | **真新增** |
| images/mai-image-2.7 | 否 | **真新增（含 2 个模型）** |
| images/minimax-h3-image、-highspeed、images/seedream-5-5、videos/apimart-zoe、videos/gemini-omni-1.2-flash、-ext、videos/kling-v4-flash、videos/seedance-2-5-flash | 是（11-13 补录 / 11-18 新增） | 相对 11-06 是新的，相对 11-18 不是 |

| 删（2） | 结论 |
| - | - |
| images/imagen-4.0-apimart | 文档删了但在售（定价页仍列），标“文档缺失”，不删模型 |
| videos/seedance-1-5-pro | 文档 + 定价页两侧同时消失，**疑似下线** |

### 8.2 模型 ID 分类（按 11-18 §8 的口径）

| 类别 | 数量 | 例子 | 处理 |
| - | - | - | - |
| 本批真新增（有独立文档页） | 4 | kling-v4-image、kling-v4-long-image、mai-image-2.7、mai-image-2.7-flash | 进 catalog / 能力表 / 价目 / 更新包 v6 |
| 本批新增（仅定价页 + 接口） | 7 | gemini-4-carbon/hydrogen/neon、gpt-6.2-astra/sol、claude-fable-5.2、qwen4-max | 进 catalog 但标低置信；不进能力表（无参数页） |
| 别名写法 | 5 组 | seedream-5.0-lite、seedream-5.0-pro、doubao-seedance-2.0、gemini-3-pro-preview-nothinking、qwen-turbo-* | 只进 alias_map |
| 计费 / 动作 id（不是可传 model） | 4 类 | kling-v4-image@2K、kling-v4-long-image@1K-LONG、kling-v4-image@input、midjourney@video | 不进 catalog |
| 第三方客户端示例 | 5+ | gpt-4o、gpt-4.1、gpt-4.1-mini、gemini-2.0-flash-exp、claude-3 | 不进目录 |
| 文档页消失 | 2 | imagen-4.0-apimart（仍在售）、seedance-1-5-pro（疑似下线） | 只改 notes |

---

## 9. 未知 / 未做

| # | 项 | 现状 | 为什么 / 怎么解 |
| - | - | - | - |
| U18 | 11-18 语料的页面级增删 | 只能对 11-06 索引做差 | 11-18 语料没留档；下次抓完把文件按日期存一份 |
| U19 | 7 个“仅定价页” chat 模型能否调用 | 只有定价页 + 接口 200 | 接口 200 只证明“在售”（乱写 id 会 404）；要真 key 打 /v1/chat/completions 或 /v1/models?expand=chat |
| U20 | claude-fable-5 / 5.1 / 5.2 这组命名 | 定价页有、价目有、文档 0 命中 | 与 opus/sonnet 体系不符，疑似渠道别名；问官方或实测 |
| U21 | `POST /v1/tasks/batch` 完整契约 | 只有三处一句话 TIP | 无请求/响应/错误码文档，需实测 |
| U22 | billing_status 是否全平台都有 | 只在 kling-v4-long-image 页出现 | 拿其它模型的任务查询对照 |
| U23 | 参考上限真实值（apimart-zoe、magi-2 两个样本） | apimart-zoe：能力表 9/3/3 vs 文档 30/10/10；**magi-2 是第二个样本：文档 10/5/5，代码 9/3/3**（2026-11-26，REPORT-DELTA-20261126 §3 / §5.2，语料 L40786 / L40802 / L40806） | 实测一次超限请求（10 张图 / 5 段视频 / 5 段音频）；放开前同时改通用分支与能力表 |
| U24 | 两个 veo 降价是否长期 | 接口只给当前价 | 隔几天再拉一次比对 |
| U25 | seedance-1-5-pro 是否官方下线 | 文档页 + 定价页都消失 | 用 key 调一次看是否 model_not_found |
| U26 | token 计费图像模型怎么进我们的价目 schema | apimart_pricing.json 的 token_rates 是单组 input/output | mai-image-2.7 是 image_modalities 多模态 rate + 按档预扣；要扩 schema 或按预扣价报价（需产品定口径） |
| U27 | retention_days 默认档 | 无 key 无法上传 | 登录控制台看，或实测一次上传读返回的 retention_days |
| U28 | 本轮没跑任何真机调用 | 全部结论来自文档 + 免鉴权接口 + 页面 | 无用户 API key；凡涉及“能不能调/收不收”的判断都标了证据强弱 |

