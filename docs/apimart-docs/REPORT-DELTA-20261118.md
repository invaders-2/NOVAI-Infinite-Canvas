# APIMart 文档增量报告（2026-11-18 版）

> 基线：本项目 2026-11-13 定稿的数据层（`docs/apimart-docs/REPORT.md`、`catalog.json`、`server/protocols/protocol_updates.json` v1–v4、`main.py` 能力表、`server/credits/apimart_pricing.json`）。
> 新版语料：`/tmp/apimart-llms-full-new.txt`，2513521 bytes / 92052 行，sha256 `94eb9c53d60e2ef7d7e57b152de7e66a296bfd628ea10f7890b4ec2e1ded205e`（下文 `L####` 均指该文件行号）。
> 旧语料（11-13 正文）没有留档，能复核的旧锚点只有 `docs/apimart-docs/raw/llms-full-index.txt`（11-06 的 186 个页面位置）与 11-06 的 7 个中文原文快照。因此本报告的"新增"口径是：
> **新版语料里出现、但 11-13 数据层（报告 + 目录 + 更新包 + 能力表）里没有记录的项**；页面长度变化用 11-06 索引做旁证。不确定的一律写"未知"。

## 0. 一句话结论

1. 11-13 报告已经覆盖了本轮大部分"看起来新"的模型（seedream-5-5、kling-v4、qwen-image-3.0、nano-banana-2.1、grok-imagine-2.0、wan2.6/2.7/3.0、skyreels-v4、happyhorse、minimax-h3、flux-3-video、apimart-zoe、vidu-q4、pixverse-v6、gemini-omni、suno v6、lyria-3.5 …）。**真正新增的模型 ID 只有 15 个**：文本 12 个、视频 1 个（`seedance-2-5-flash`）、外加 2 个别名写法；图片、音频没有新增模型。
2. 协议侧的增量比模型侧重要：**webhook 签名（`webhook_secret` + `X-Webhook-Signature`）**、**上传保留期与超量计费**、**账户余额/用量/消费记录接口**、**模型定价接口**、**三种上下文缓存**、**Seedance 2.5 草稿模式**、**Midjourney 图生视频**、**Seedance 虚拟人资产**。
3. 推理参数结论不变：`reasoning_effort` / `thinkingBudget` / `thinkingConfig` / `budget_tokens` 在新版里仍是 **0 命中**（`grep -c` 全为 0）。唯一新增的推理入口是图片接口里的嵌套字段 `svg.reasoning.effort`（L6537–L6563），属于"给 SVG 作者模型用"，不是 chat 的 reasoning_effort。
4. 能力表有两处必须改：`seedance-2.5` 的 resolution 现在有 **4k**（L46265–L46266），`wan3.0-video` 支持 **duration=-1** 与 **21:9/adaptive**（L53714–L53744）。
5. 计费侧有一条会直接多花钱的坑：**上传不传 `retention_days` 时按控制台默认档走**，如果默认是 7/15/30 天，每次上传都按字节计费（L80789 起的 WARNING）；**`wan3.0-video` 不传 resolution 按 1080P 出图与计费**（L53714）；`minimax-h3-image` 不传 resolution 按 4K（11-13 已记录）。

---

## 1. 文本（chat）

### 1.1 全新模型 ID（12 个）

chat/completions 页自带的"Supported Models"清单**一个字都没变**（与 11-06 中文原文快照的 token 集合完全一致，L30114–L30122 / L31064–L31072）。下面 12 个 ID 都是在别的页面里被当作"平台可用模型"列出来的：

| 模型 ID | 证据（行号） | 文档给的档位证据 | 分类 | 写入位置 |
| - | - | - | - | - |
| `gpt-5.4` | L6577 / L6582（gpt-image-2.6 页 SVG 作者模型对比表）、L90113（Codex CLI 页） | 无独立档位表 | 全新 ID | catalog chat |
| `gpt-5.4-mini` | L6560（SVG 作者模型档位表）、L6535（"有文本 token 计价的模型，例如 gpt-5.4-mini / gpt-5.6-sol"） | `none/low/medium/high/xhigh`，不支持 `minimal/max` | 全新 ID | catalog chat |
| `gpt-5.5` | L6577 / L6583、L88899（Claude Code 页）、L90112（Codex 页）、L54247（/v1/logs 示例） | 无独立档位表 | 全新 ID | catalog chat |
| `gpt-5.6-sol` | L6561 / L6584、L6535 | `none/low/medium/high/xhigh/max`，不支持 `minimal` | 全新 ID | catalog chat + pricing |
| `gpt-5.6-luna` | L54926（/v1/usage 示例响应） | 无 | 全新 ID（证据弱） | catalog chat |
| `gpt-6-astra` | L6585（SVG 作者模型对比表，文档建议复杂透明背景先试它） | 未单列（表里只出现模型名） | 全新 ID | catalog chat |
| `gpt-6-luna` | L6562 | `none/low/medium/high/xhigh/max`，不支持 `minimal` | 全新 ID | catalog chat |
| `gpt-6.1-sol` | L6563 | `low/medium/high/xhigh/max`，不支持 `minimal/none` | 全新 ID | catalog chat |
| `gpt-5.2` | L90116（Codex CLI 页模型表：稳定均衡） | 无 | 全新 ID | catalog chat |
| `gpt-5.3-codex` | L90115（Codex CLI 页：Codex 优化的编码模型） | 无 | 全新 ID | catalog chat |
| `claude-opus-5` | L89176（Claude Code 页模型表："下一代旗舰"） | 无；但可加 `-thinking`（L89183） | 全新 ID | catalog chat |
| `claude-opus-5-thinking` | L89183（"所有模型都可加 -thinking"）、L89192 | 无 | **同一模型不同写法**（= `claude-opus-5` + 平台扩展后缀） | catalog chat + pricing alias_map |

**没有独立参数页**：这 12 个 ID 在文档里都只出现在示例/清单/对比表，没有各自 generation 页；因此 catalog 里 `efforts` 全部留空（不下发推理档位），并把"文档给的是 SVG 作者模型 effort，不是 chat reasoning_effort"写进 notes。

### 1.2 同一模型的不同写法 / 不是新模型

| 写法 | 证据 | 判定 |
| - | - | - |
| `-thinking` 后缀（如 `claude-opus-5-thinking`） | L33012（"同名模型的 -thinking 后缀是平台扩展别名"）、L89183 | 别名，官方建议改用标准名 + 请求体 `thinking` |
| `gemini-3-pro-preview-thinking` | L30114 / L30334 | 11-06 就在 chat 清单里，不算新增 |
| `claude-opus-4/4-5/4-6/4-7/4-8`、`claude-sonnet-4-6`、`gemini-3.x`、`deepseek-*` | L30112–L30122 | chat 清单原文，11-06 已记录 |
| `gpt-4o` / `gpt-4.1` / `gpt-4o-image` / `claude-3` / `claude-sonnet-4-5-20250929` / `gemini-2.0-flash-exp` | L87462、L87793、L87805、L88621、L91102 等第三方客户端接入页 | **第三方客户端示例清单，不是平台目录新增**；未入 catalog |
| `omni-moderation-latest` | L79351（独立页，`POST /v1/moderations`，`stream` 只支持 false） | 11-13 REPORT A.4 已提过；不是四类生成模型 |

---

## 2. 图像（image）

**没有新增图像模型。** 11-13 报告 A.2 已覆盖的新面孔（`gpt-image-2.6-*`、`grok-imagine-2.0-ext`、`qwen-image-3.0`、`seedream-5-5`、`nano-banana-2.1`、`minimax-h3-image`、`muse-image-ext`、`midjourney`）本轮都在，模型清单没有扩。

真正的新内容是**图片接口里多了一个推理参数**和**Midjourney 出视频**：

| 变化 | 证据 | 说明 |
| - | - | - |
| `svg.reasoning.effort` | L6525–L6569（gpt-image-2.6 页）、L6141–L6170（gpt-image-2.6-ext 页） | 值 `none/minimal/low/medium/high/xhigh/max`（大小写不敏感，L6543）；只对 `output_format:"svg"` 生效；"各作者模型实际支持档位不同"（L6556），并给了 4 个模型的档位表（L6559–L6563）；SVG 作者模型按 token 另计费，用量在 `data.usage.svg_usage`（L6680–L6681）；顶层 `reasoning_effort` 仍 0 命中 |
| `gpt-image-2.6-ext` 也支持 SVG | L6141–L6170 | 之前只记了 flare/sunburst；ext 的 svg 分支是"文生图 only + n=1"（L6143） |
| Midjourney 图生视频 | L19372–L19972 | 见 §4.3（本质是视频能力，挂在 /midjourney 端点） |
| `seedream-5-5` 透明/图层参数复核 | L26480–L26545 | n 必须 1（L26510）；`layer_decomposition_options.max_images` 2–100 默认 30、`text_recognition`（L26534）；`optimize_prompt_options` 只认 `{"mode":"standard"}`；3K/4K 不支持 |
| `seedream-5-5` 之外没有参数变化 | L26374–L26786 | 与 11-13 REPORT G.2 一致 |

---

## 3. 视频（video）

### 3.1 全新模型（1 个 + 1 个别名）

| 模型 | 证据 | 关键参数（文档原文） | 分类 |
| - | - | - | - |
| `seedance-2-5-flash` | 页面 L45901–L46259；参数 L45987 起；别名与点号写法 L45990 | resolution 只有 `480p/720p`（1080p/2k/4k 400，L46010）；size 6 比例 + `adaptive`（默认 adaptive；首尾帧/编辑/延长必须 adaptive）；duration 4–30 或 `-1`；`generate_audio` 默认 true；`watermark` 默认 false；`output_format` mp4/mov；`omni_reference_task_type` auto/reference/edit/extend；图 ≤10（含首尾帧）、视频 ≤5、音频 ≤5（各 2–30 秒、合计 ≤30 秒，纯音频参考可以）；`return_last_frame` / `web_search` / `tools` / `nsfw_check`；**不支持 draft/draft_task_id**（L46195） | 全新模型 |
| `doubao-seedance-2-5-flash` | L45990 | = 上一行的官方别名 | **同一模型不同写法** |
| `seedance-2.5-flash`（点号） | L45990、L46250 | **明确不支持**（model not found） | 不要加进模型列表 |

### 3.2 已有模型的参数/能力变化

| 模型 | 变化 | 证据 |
| - | - | - |
| `seedance-2.5` | resolution 从 480p/720p/1080p 变成 **480p/720p/1080p/4k**（2k/2160p 仍不支持） | L46265–L46266（"Resolution: 480p / 720p / 1080p / 4k are supported"）、L47190 的错误表 |
| `seedance-2.5` | **草稿模式**：`draft:true` 只出 480p、轮询拿 task_id → `draft_task_id` + resolution(1080p/4k) 出成片；草稿 3 天过期；成片不得重发 prompt/image_urls/video_urls/audio_urls/duration/size/aspect_ratio/seed/generate_audio/audio/omni_reference_task_type/generation_type/camerafixed/web_search/tools（同值也 400） | L46930–L47180（"## Draft mode" 在 L46930，计费在 L46918 之后） |
| `seedance-2.5` | 私有资产 `asset://` 与 2.0 共用一套接口 | L47150 左右（"Private asset" 示例与 2.0 的差异表） |
| `wan3.0-video` | duration 支持 `-1`（模型自选）；size/aspect_ratio 多了 `21:9` 与 `adaptive`；**不传 resolution 按 1080P 出图与计费**；`audio` 默认 true；新增 `file_url`（≤1 个文档）/ `link_url`（≤1 个网页）/ `generation_type(frame\|reference)`；参考视频 ≤5、音频 ≤5（各 1–15 秒、合计 ≤15 秒） | L53486–L53980（resolution L53714，size L53726，duration L53735，audio L53746，file_url/link_url L53804 附近） |
| `kling-v4-flash` | 价格口径写得更细：`kling-v4-flash@720P` / `@720P-input`（这是**计费档名**，不是模型 ID）；明确 1080p/尾帧/音频/mode 等一律 400 | L83900–L83990（"Unsupported parameters" 列表） |
| `kling-v4` | 复核：不再有 mode，用 resolution；首帧方式不能带 aspect_ratio；参考上限图 10/视频 5/音频 3 | L40811–L41138 |

### 3.3 Midjourney 出视频（能力新增，不是新模型）

| 项 | 文档原文 | 证据 |
| - | - | - |
| 端点 | `POST /v1/midjourney/generations/video`；图生视频、固定 FAST、约 5 秒、**不支持文生视频** | L19372–L19376 |
| 输入 | `image_urls` 或 `task_id`+ `index`(0–3) 二选一；单图 ≤12MiB | L19936–L19944 |
| 参数 | `video_type` 默认 `vid_1.1_i2v_480`，只有 4 个值（480/720 × 基础/首尾帧）；`motion` low/high 默认 high（不影响计费）；`batch_size` 1/2/4 默认 1（按 N 倍计费）；`end_url` 设了自动升级 `start_end_*`；`animate_mode` manual/auto（auto 需要 task_id+index） | L19940–L19972 |
| 计费 | `midjourney@video` / `midjourney@video-720p`，费用 = 单价 × batch_size | L19930、L20030 左右（"Video billing control"） |

---

## 4. 音频（audio）

**没有新增音频模型，也没有接口路径变化。** Suno 页仍是 `v6 / v6-wild / v6-mini`（L70600 左右的 overview 页）、FlowMusic 仍是 generate/cover/extend/replace/lyrics/stems/upload_audio/video_clip（L55544 起，14 个页面）。

只有一处需要留意：`suno@remaster`、`suno@download` 这类**计价动作 id** 在文档里出现（L71405、L77980），它们在 11-13 报告 A.4 里已按"40+ 操作"记录过，不是新模型。

---

## 5. 协议 / 接口变化（只写文档确证项）

| # | 字段 / 端点 | 文档现值 | 证据 | 对我们的影响 |
| - | - | - | - | - |
| P1 | `webhook_secret` + `X-Webhook-Signature` | 提交体顶层可选 `webhook_secret`（≥16 字符、键名必须小写），回调带 `X-Webhook-Signature: hex(HMAC-SHA256(secret, raw body))`；没配就没有签名头；控制台 Callback signing 可配默认密钥，请求级覆盖 | L80236–L80390（签名格式 L80243，键名 L80272，优先级 L80279，无签名说明 L80388） | 我们只用轮询、不用 webhook → 当前无影响；一旦接回调必须验签 |
| P2 | 上传保留期与超量计费 | `retention_days=3\|7\|15\|30`（只认 URL query，form 字段无效）；3 天档在免费额度内免费，超出或选长档按实际字节计费；响应新增 `bytes` / `retention_days` / `expires_at`，付费上传带 `overage{charged,bytes,cost_usd,price_per_gb_usd}` 与可选 `quota{limit,used,remaining,window_hours,reset_at}` | L80668–L80912（保留期 L80789，共享配额 L80867，错误表 L80877） | **P0 计费风险**：现在上传不传 `retention_days`，跟随控制台默认；默认是 7/15/30 天时每次上传都按字节扣费。建议上传固定带 `retention_days=3` |
| P3 | 账户 / 用量 / 消费记录 | `GET /v1/balance`（Key 余额）、`GET /v1/user/balance`（账户余额）、`GET /v1/usage`（start/end/group_by，≤31 天，返回 amount_usd/credits/requests/tokens）、`GET /v1/logs/requests` + `/v1/logs/requests/{id}`（consume/error 明细，游标分页，`watermark` = 服务器时间-300s） | L54447–L54795、L54844–L55175、L55176–L55544、L54187–L54446 | 目前没有余额/用量面板；零余额也能查（L54970 附近）。可用来做"调用前余额检查/对账"，未接 |
| P4 | 模型定价接口 | `GET /api/pricing/model?model=`（**免鉴权**，只读 `data.pricing`：`rates` / `effective_rates` / `price_factor` / `tier_count` / `limits` / `extras.tools`）；`GET /v1/pricing/model`（鉴权，按 resolution/size/quality/duration/n 报本账户实付价，含 `price_source`） | L35150–L35405（免鉴权 L35163、字段语义 L35175–L35326）、L54384–L54420 | 我们的积分价目仍是 2026-10-24 构建期快照；本轮新条目已按这个接口实测补价（见 §7） |
| P5 | 上下文缓存 | `cache_control{type:"ephemeral",ttl:"5m"|"1h"}` 走 OpenAI 兼容与 Claude 原生两条路；Claude 1h 需 `anthropic-beta: extended-cache-ttl-2025-04-11`，且 `system` 必须是数组；`/v1/responses` 另收 `prompt_cache_options.ttl` = `30m`/`12h`（12h 仅 responses）+ `mode:"explicit"` + `prompt_cache_breakpoint`，缓存前缀至少 1024 tokens | L28371–L28560（Gemini）、L31342–L31560（Claude）、L33278–L33520（OpenAI） | 我们不发缓存字段，长 system prompt 每次全价；接缓存要动 chat/messages 请求体，单独一轮 |
| P6 | Seedance 2.5 草稿模式 | 见 §3.2 | L46930–L47180 | 没有草稿入口；能力表/报告留档 |
| P7 | Midjourney 图生视频 | 见 §3.3 | L19372–L19972 | 没有入口；能力表 mj.video 留档 |
| P8 | Seedance 虚拟人资产 | `POST /v1/seedance2/private-avatar`（批量 ≤20）；`/private-avatar/assets`(+/{id})、`/private-avatar/groups`(+/{id})；审核走 `GET /v1/tasks/{id}`；通过后返回 `asset://`，可直接填 image_urls/image_with_roles/video_urls/audio_urls；资产接口免费、不产计费记录；真实人脸必须先入库 | L45377–L45900（提交 L45378，管理接口 L46860–L46900）、L45708（`object: seedance.avatar.asset.task`） | 带人脸参考图会失败；没有资产库入口 |
| P9 | `svg.reasoning.effort` | 见 §2 | L6537–L6569、L6676–L6681 | 能力表加 `svg.efforts` 留档；生成侧仍只发 `svg.model` |
| P10 | Responses API 能力范围 | `/v1/responses` 支持多模态输入（input_text + input_image）与 web_search/file_search/function_call/remote MCP；响应是 `output` 数组（message/reasoning/function_call 逐项判 type）；thinking 不能关闭（qwen3.8-max 固定思考，计费在 `output_tokens_details.reasoning_tokens`） | L33450–L33480、L34334–L34350、L34863、L35006–L35014 | 我们走 chat/completions 与 messages，不解析 output 数组 |
| P11 | `-thinking` 别名规则 | "同名模型的 -thinking 后缀是平台扩展别名，官方建议用标准名 + 请求体 `thinking` 参数" | L33012、L89183 | `server/protocols/thinking.py` 走的正是 budget_tokens 映射，与文档建议一致 |

---

## 6. 对我们代码的影响点

| # | 位置 | 现状 | 本轮处理 |
| - | - | - | - |
| I1 | `main.py` `APIMART_VIDEO_MODEL_CAPS["seedance-2-5"]` | 只有 480p/720p/1080p | 补 `4k`；注释写明草稿模式与继承字段限制 |
| I2 | `main.py` `APIMART_VIDEO_MODEL_CAPS` 新增 `seedance-2-5-flash` | 无条目 | 按文档补：480p/720p、4–30+`-1`、6 比例+adaptive、图 10/视频 5/音频 5、omni_task_type、6 种 modes。最长 key 命中保证不会落到 `seedance-2-5` |
| I3 | `main.py` `APIMART_VIDEO_MODEL_CAPS["wan3-0-video"]` | duration 只到 (2,30)、比例没有 21:9/adaptive | 改成 `durations=(-1,2..30)`、比例补 21:9/adaptive；注释写明"不传 resolution 按 1080P 计费" |
| I4 | `main.py` `APIMART_IMAGE_MODEL_CAPS["gpt-image-2-6-*"]` | svg 只有 model | 加 `svg.efforts`（7 值）留档 |
| I5 | `main.py` `APIMART_IMAGE_MODEL_CAPS["midjourney"]["mj"]` | 只有 versions/speeds/hd | 加 `mj.video`（endpoint/motions/batch/video_types/animate_modes/billing）留档 |
| I6 | `server/credits/apimart_pricing.json` | 10-24 快照，缺新模型与 4K 档 | 补 `seedance-2-5-flash`、`midjourney@video`、`midjourney@video-720p`、`gpt-5.6-sol`；`seedance-2.5` 补 4K/4K-input/token-4K/token-4K-input 四档；alias_map 补 4 条 |
| I7 | 上传流程（`main.py` APIMart 上传分支） | 不传 `retention_days` | **未改**（超出本轮数据层范围）。建议下一轮固定带 `retention_days=3` 并读 `expires_at`，否则默认档可能是付费档 |
| I8 | 余额/用量/定价接口 | 未接 | 未改；价目仍是构建期快照 |
| I9 | 推理参数 | 四项仍是 0 命中 | 不改 `thinking.py`；catalog 里 12 个新 chat ID 的 `efforts` 全为空 |
| I10 | 模型列表 | 只到 11-13 的模型 | 更新包 v5 会把 12 个 chat + `seedance-2-5-flash` 增量追加到用户已有列表（不删除、不覆盖） |

### 6.1 复核时发现的一个既有问题（不是本轮引入）

`seedance-2.5` 的价目虽然在 `apimart_pricing.json` 里有 480P/720P/1080P（本轮又补了 4K）分档，但估价引擎对它的任何 resolution 都按 720P 报价：`quote.estimate("video","seedance-2.5",{"resolution":"4k"|"1080p"|"720p"|"480p","duration":5})` 全部返回 `cost=10.8`（= 720P 2.16×5）。用 `git show HEAD:server/credits/apimart_pricing.json` 的旧快照跑同样调用，结果一样（4k/1080p/720p 都是 10.8），所以是既有问题（`quote.py` 的视频分档匹配），不是本轮新增条目引起；本轮补的 4K 档也受它影响，报价会偏低。对照：`seedance-2.0` 的 4K 能正确报 4.29。

---

## 7. 价格来源说明（不要把它当文档文字）

新条目的价格**不是**文档正文里的数字（文档正文只写"去 pricing 页或 /api/pricing 看"），而是文档 §P4 的 `GET /api/pricing/model` 接口在 2026-11-18 实测返回：

- `seedance-2-5-flash`：per_second，480P 0.06312 / 480P-input 0.0384 / 720P 0.14192 / 720P-input 0.0864；token 6.57144、token-input 4（USD / 1M tokens）；会员价与标价相同（接口里 resolution_prices == resolution_paid_prices）。
- `midjourney@video`：per_call，标价 0.25、会员实付 0.2；`midjourney@video-720p`：标价 0.5、实付 0.4。
- `gpt-5.6-sol`：per_1m_tokens，input 标价 4 / 实付 3.2，output 标价 20 / 实付 16；`tier_count=2`（>272K 输入 tokens 的第二档 input 8 / output 30）——**本项目的价目 schema 没有分档字段，第二档没有写进 JSON**，只在报告留档，见 §8 U12。
- `seedance-2.5` 4K：4K 1.0761 / 4K-input 0.6596 / token-4K 5.5357 / token-4K-input 3.3929（会员实付 0.86088 / 0.52768 / 4.42856 / 2.71432）。
- `claude-opus-5-thinking` 接口 404（`model_not_found`），按别名映射到 `claude-opus-5` 的价格（alias_map），不单独编价。

价目文件里 `source` 写成 `api:pricing/model@2026-11-18`，`platinum/diamond` 由 gold × 0.95 / 0.9 推导（与文件里既有条目的口径一致），并在条目的 `derived` 里写明。

---

## 8. 对"新版比旧版多 62 个模型 ID"的核对

按"新版语料里出现、11-13 数据层没有"的口径，用 `"model": "…"` 字段 + 反引号 token + 页面 slug 三种方式扫出来是 **74 个候选**，但绝大部分不是新模型：

| 类别 | 数量（约） | 例子 | 处理 |
| - | - | - | - |
| 页面族名 / 别名（不是可传 model） | 21 | `flux-2`、`qwen-image`、`seedream-4`、`veo3`、`wan2.5`、`vidu-q3`、`flow-music`、`tts` | 不入目录（catalog 已有正式 ID） |
| 计费 / 动作 id（不是可传 model） | 23 | `midjourney@video`、`midjourney@blend-fast`、`kling-v4-flash@720P`、`suno@remaster`、`seedance.avatar.asset.task` | 不入 catalog；MJ 视频进能力表与价目表 |
| 第三方客户端示例 | 8 | `gpt-4o`、`gpt-4.1`、`claude-3`、`claude-sonnet-4-5-20250929`、`gemini-2.0-flash-exp` | 不入目录 |
| 11-13 已记录但 catalog 漏收 | 6 | `seedream-5-5`、`minimax-h3-image`、`minimax-h3-image-highspeed`、`apimart-zoe`、`kling-v4-flash`、`gemini-omni-1.2-flash(-ext)` | 本轮补录进 catalog（标注"2026-11-13 批次补录"） |
| 本批真新增 | 15 | 12 个 chat + `seedance-2-5-flash` + `doubao-seedance-2-5-flash` + `claude-opus-5-thinking` | 进 catalog / 更新包 / 价目 |

所以"多 62 个"更接近"多 62 个出现过的新字符串"，真正的模型增量是 15 个 ID（含 2 个别名写法）。

---

## 9. 未知 / 未做

| # | 项 | 现状 | 为什么 |
| - | - | - | - |
| U12 | `gpt-5.6-sol` 第二档价格（>272K 输入 tokens：input 8 / output 30） | 没有写进 `apimart_pricing.json` | 现有价目 schema 只有单组 `token_rates`，没有分档；写进去会被 `_max_token_rates` 取最大值从而对普通请求过度计价，保持原 schema、只在报告记录 |
| U13 | 12 个新 chat ID 是否真能调、真实档位 | 只有文档示例/清单级证据，没有独立参数页，也没有用户 key 实测 | 需要真机试；catalog 里 `efforts` 全空、并标注证据强弱 |
| U14 | `seedance-2-5-flash` 的 4K/1080P | 文档明确只有 480p/720p | 上游可能后续加；现在按文档写死，传高档会 400 |
| U15 | `retention_days` 默认档 | 控制台默认值未知（文档说"不一定是 3 天"） | 需要登录控制台看；计费风险已在 §5 P2 标出 |
| U16 | 上传默认档若为付费档，上传成功但走 402/429 的分支 | 文档给了完整错误表（L80877 起），代码只处理了配额头 | 接的时候要连上传重试、报价、余额一起改 |
| U17 | Midjourney 视频与虚拟人资产的产品入口 | 只有 API 与计价 | 属于前端/画布侧改动，本岗不动前端 |
