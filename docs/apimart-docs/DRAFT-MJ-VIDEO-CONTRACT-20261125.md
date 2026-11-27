# DRAFT-MJ-VIDEO-CONTRACT-20261125 — Seedance 草稿模式 + Midjourney 视频契约

> 交付岗：backend-draft（第二轮后端/数据层）。范围只到后端 + 文档，**未改任何前端文件**
> （novai-canvas-ui / static / web 均未动）。
> 证据：/tmp/apimart-llms-20261125.txt（sha256 0393fa48…）**L46524–L46602 草稿模式**、
> **L45662**（seedance-2.5-flash 不支持 draft）、L46346 / L46822–L46824（参考上限 30/10/10）、
> L80789–L80912（上传 retention_days）。行号都以该文件为准。
>
> 本文上半（§1–§7）是 Seedance 草稿模式，给下一个前端岗照做；
> §8 是 Midjourney 视频（第三轮**后端**岗补全：虚拟视频模型 + caps + 请求体 + 计费 + 错误分支 + 前端控件），
> 前端岗按同一节接 UI，不用再查文档。

## 0. 一句话

seedance-2.5 支持 **两段式**：先出 480p 草稿（带 draft:true），拿到草稿 task_id 后再用
draft_task_id 出 1080p / 4k 成片；成片请求**只发白名单字段**，草稿阶段用过的 prompt/参考/时长/
比例/seed/音频等全部由上游继承，重发（哪怕同值）直接 400。草稿 3 天过期。

## 1. /api/model-caps 新增字段（只有 seedance-2.5 带）

GET /api/model-caps?include_builtin=1 里 model=seedance-2.5, kind=video 的条目新增：

| 字段 | 类型 | 取值 | 含义 |
|---|---|---|---|
| draft | bool | true | 支持草稿模式；字段缺失 = 该模型不支持 |
| draft_resolution | string | "480p" | 草稿阶段固定档位（用户传其它档位后端本地 400） |
| draft_final_resolutions | string[] | ["1080p","4k"] | 成片可选档位（省略按 1080p）；与 resolutions 分开表达，别把 480p 当草稿成片档 |
| draft_expires_days | int | 3 | 草稿有效期（天）；过期/不存在/非本人 → 上游 400 |

真实下发（curl 实测见验收记录）：

~~~json
{"provider": "apimart", "model": "seedance-2.5", "kind": "video",
 "ratios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
 "resolutions": ["480p", "720p", "1080p", "4k"],
 "durations": [-1, 4, 5, "…", 30],
 "n_max": 1, "audio": true,
 "ref_max": 9, "video_ref_max": 3, "audio_ref_max": 3,
 "draft": true, "draft_resolution": "480p",
 "draft_final_resolutions": ["1080p", "4k"], "draft_expires_days": 3}
~~~

**seedance-2-5-flash 没有 draft 字段**（文档 L45662 明确 draft/draft_task_id 返回 400）。
apimart-zoe / flux-3-video 的 draft_from_task_id 是**另一套协议**，本契约不覆盖、也不要混用。

## 2. 生成请求字段（CanvasVideoRequest / POST /api/canvas-video）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| draft | bool | false | 草稿步：正常请求 + draft:true，resolution 强制 480p |
| draft_task_id | string | "" | 成片步：草稿返回的 task_id；与 draft 互斥 |

前端**不要**自己拼「成片只发白名单」之外的字段：后端会按下面的规则组装，前端多传的 prompt/图片/
视频/音频/时长/比例/seed 在成片步会被忽略（并且后端不会上传这些媒体），但 UI 上别让用户以为它们会生效。

## 3. 两段式流程（前端照做）

1. **草稿**：用户选 seedance-2.5 → 正常填 prompt/参考/时长/比例 → POST /api/canvas-video
   body 加 draft: true（resolution 留空或 480p）。
2. 后端返回正常视频结果（videos / task_id / canvas_meta）。**草稿 task_id = 返回体的 task_id**
   （不是上游 raw 里的 id；两边一致，但前端只认这一个）。
3. 等草稿出片后（前端已有轮询/任务状态链路），用户点「出成片」：POST /api/canvas-video，
   body **只带** model + draft_task_id + resolution（1080p 或 4k，省略=1080p）
   + 可选 return_last_frame / watermark；draft 必须为 false/省略。
   prompt 字段是后端 schema 必填（min_length=1），前端可以传占位文本，**不会发给上游**。
4. 成片是新的 task_id，正常轮询出片；一个草稿可以出多个成片，各自计费。

草稿 3 天内有效；过期/被删/不属于本账号/不是草稿任务 → 上游 400 且**不建任务不扣费**。
4K 成片要求草稿所在通道支持 4K，否则 400 且不扣费 → 前端错误提示应引导用户改用 1080p 重提，
**不要**让用户重新出草稿。

## 4. 后端已做的本地校验（前端可以直接依赖）

| 情况 | 后端行为 |
|---|---|
| 模型不支持草稿（含 seedance-2-5-flash） | 400「…不支持草稿模式…」 |
| draft 与 draft_task_id 同时给 | 400「draft 与 draft_task_id 互斥…」 |
| draft=true 且 resolution 不是 480p/空 | 400「草稿分辨率固定为 480p…」 |
| draft_task_id 且 resolution 不是 1080p/4k | 400「成片分辨率只支持 1080p / 4k…」 |

本地 400 **不会上传媒体、不会提交上游、不扣费**（预扣在任务创建前，失败会退款）。

## 5. 计费口径（后端已实现）

- **草稿**：按 480p 档预扣（用户即使传了 4k，也按 480P 计；duration:-1 按 30 秒上限预扣）。
- **成片**：按请求档位 1080P/4K 预扣；如果草稿阶段带了原始参考视频，按 **1080P-input / 4K-input**
  档（后端用草稿 task_id 的进程内上下文判断；服务重启/换机后上下文丢失则回落非 input 档）。
  成片时长沿用草稿记录的输出时长，不按前端默认 5 秒扣。
- 上游成功按实际 token 结算，失败全额退；4K 未开通的 400 不扣费。
- 前端只展示返回的 credits / credits_cost，不要自己按模型名估价。

## 6. 错误分支文案（上游 400 的常见原因，前端按类型给提示）

| 上游 400 原因 | 前端建议 |
|---|---|
| draft_task_id 不存在/过期/非本人/非草稿 | 「草稿不存在或已过期（3 天），请重新生成草稿」 |
| 4K 通道不支持 | 「该通道不支持 4K 成片，改用 1080p 重试」 |
| 成片重发了继承字段（后端已保证不发；第三方调用可能触发） | 「成片请求不要重复提交提示词/参考/时长等草稿字段」 |
| service_tier 等草稿不支持字段 | 前端不提供该开关 |

## 7. 前端必须镜像的落点（给下一个前端岗）

1. novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts
   - ModelCapsItem 增可选：draft、draft_resolution、draft_final_resolutions、draft_expires_days。
   - modelCapsUi 映射成 ui：draft = item.draft === true；draftRes = draft_resolution；
     draftFinals = string[]；draftExpiresDays = number（缺失=不支持，不要给默认 true）。
2. model.ts：VideoParams 加 draft / draftTaskId；换模型时清掉这两个值（别的模型没有草稿）。
   草稿态 resolution 固定 480p；成片态可选 draft_final_resolutions。
3. novaiBackend.ts 的 createVideoTask 请求体：按需带 draft: true 或 draft_task_id；
   **成片步不要带 prompt/图片/视频/时长/比例/seed**（后端会忽略，但别让 UI 误导）。
4. GenPanel.tsx：seedance-2.5 加「草稿」开关 + 「出成片」入口（展示成片档位 1080p/4k）；
   草稿任务完成后从返回体拿 task_id 作为 draft_task_id；UI 上标「草稿 3 天内可出成片」。
5. 错误提示按 §6 分支；4K 失败引导改 1080p，不要让用户重新出草稿。

## 8. Midjourney 视频（MJ video，虚拟视频模型 midjourney-video）

> 本节由第三轮**后端**岗补全（只改后端 / 数据 / 文档，未碰前端）。证据：/tmp/apimart-llms-20261125.txt
> **L19884–L20060**（端点页）、**L20400–L20520**（参数与计费表）、**L11640–L11720**（计费控制建议）。
> 行号以该文件为准；文中「未知」= 文档没写、也没有实测。

### 8.1 一句话

MJ 图生视频走独立端点 **POST /v1/midjourney/generations/video**（不是 /v1/videos/generations，请求体
**不带 model**）：只有图生视频、固定 FAST、约 5 秒、**不支持文生视频**；输入 `image_urls`（首帧 1 张）
或 `task_id` + `index`（复用 MJ 出图的 4 张候选）二选一；计费按 `midjourney@video`（480p）/
`midjourney@video-720p`（720p）× `batch_size`；任务轮询与其它 APIMart 视频任务同一条
`GET /v1/tasks/{id}`。

### 8.2 虚拟模型 key（前端不要硬编码 MJ 视频参数）

| 项 | 值 |
|---|---|
| 画布视频模型名 | **`midjourney-video`**（`kind=video`，平台 apimart） |
| 上游模型 | 固定 `midjourney`（cap 里的 `mj_video.upstream_model`；**请求体不发 model 字段**） |
| 上游端点 | `POST {base}/v1/midjourney/generations/video`（cap 里的 `mj_video.endpoint`） |
| 后端常量 | `APIMART_MJ_VIDEO_CAPS` + `APIMART_VIDEO_MODEL_CAPS["midjourney-video"]` |
| 下发位置 | `GET /api/model-caps?include_builtin=1` 的 `builtin:true` 条目；v7 更新包 `new_models.video` 应用后也进平台视频清单（默认 `/api/model-caps` 可见） |

注意：普通视频模型名 `midjourney` **不会**命中 MJ 视频分支（能力匹配要求 `midjourney-video`），
别把出图模型 `midjourney` 填进视频模型清单。

### 8.3 caps 字段与取值（视频条目，GET /api/model-caps?include_builtin=1）

| 字段 | 取值 | 含义 |
|---|---|---|
| `modes` | `["image_to_video"]` | 只有图生视频；文生视频/首尾帧之外的方式一律没有 |
| `durations` | `[5]` | 时长固定约 5 秒，前端别渲染时长滑杆 |
| `resolutions` | `["480p", "720p"]` | **计费档**，由 `video_type` 决定；不是可自由传的 resolution 参数 |
| `ratios` | `[]` | 上游没有画幅字段，画幅跟随首帧图；比例控件应隐藏 |
| `n_max` | `1` | 一次画布请求只产出一条记录（batch 是上游 N 条，见下） |
| `ref_max` | `1` | 首帧图只收 1 张 |
| `batch` | `[1, 2, 4]` | 等于上游 `batch_size`，按 N 倍计费 |
| `mj_video` | 见下表 | MJ 视频专属能力位 |

`mj_video` 子对象：

| 键 | 取值 | 含义 |
|---|---|---|
| `endpoint` | `/v1/midjourney/generations/video` | 提交路径 |
| `upstream_model` | `midjourney` | 仅标识，不进请求体 |
| `input_sources` | `["image_urls", "task_id"]` | 二选一 |
| `requires_first_frame` | `true` | 必须有首帧（图片或复用 task_id） |
| `supports_end_frame` | `true` | 支持尾帧 `end_url` |
| `duration_seconds` / `duration_fixed` | `5` / `true` | 固定约 5 秒 |
| `motions` / `motion_default` | `["low","high"]` / `high` | 运动幅度，不影响计费 |
| `video_types` | `vid_1.1_i2v_480`、`vid_1.1_i2v_720`、`vid_1.1_i2v_start_end_480`、`vid_1.1_i2v_start_end_720` | 4 个合法值 |
| `video_type_default` | `vid_1.1_i2v_480` | 默认 480p 基础 |
| `base_by_tier` | `{"480p":"vid_1.1_i2v_480","720p":"vid_1.1_i2v_720"}` | 无尾帧时按档位选值 |
| `start_end_by_tier` | `{"480p":"vid_1.1_i2v_start_end_480","720p":"vid_1.1_i2v_start_end_720"}` | 有尾帧时按档位升级 |
| `start_end_video_types` | 上面两个 start_end 值 | 尾帧模式的合法值 |
| `animate_modes` | `["manual","auto"]` | `auto` 必须配 `task_id` + `index` |
| `batch` / `batch_default` | `[1,2,4]` / `1` | 上游 batch_size |
| `index_min` / `index_max` | `0` / `3` | 复用 MJ 出图的 4 张候选下标 |
| `billing` | `["midjourney@video","midjourney@video-720p"]` | 计费 id |
| `billing_by_tier` | `{"480p":"midjourney@video","720p":"midjourney@video-720p"}` | 档位 → 计费 id |

**图片模型 `midjourney` 的 `mj.video` 也会下发同一份内容**（以前 `_caps_payload` 只传
versions/speeds/hd，把 video 整段丢了；本轮修好）。编辑器的 MJ 出图面板可用它提示「MJ 也能出视频」，
但真正发起视频请用视频模型 `midjourney-video`。

### 8.4 请求字段（POST /api/canvas-video / `CanvasVideoRequest`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `model` | string | — | 必须是 `midjourney-video`，否则不会走 MJ 视频分支 |
| `prompt` | string | 必填（schema） | 视频提示词；文档里 prompt 可省，但本项目 schema 必填，正常当视频提示词发 |
| `mode` | string | 空 = image_to_video | 只接受 `image_to_video`；其它方式本地 400 |
| `images[0].url` | string | — | 首帧图（本地 /assets、公网 http(s) 都行；两张以上本地 400） |
| `end_image` | `{url}` | 空 | 尾帧图；也可以改用 `images` 里 `role=last_frame` 的那张（两者只能给一种） |
| `video_type` | string | 空 = 按档位默认 | 4 个合法值之一；给了就以它为准（档位由它决定） |
| `resolution` | string | 空 | 仅在 `video_type` 为空时用来选 480p/720p；只接受 480p/720p/auto/空 |
| `motion` | string | 空 = high | `low` / `high` |
| `mj_batch` | int | 0 = 1 | 只接受 1 / 2 / 4；映射到上游 `batch_size`；费用 × N |
| `mj_task_id` | string | 空 | 复用 MJ 出图任务的上游 task_id（**不是画布 task id**） |
| `mj_index` | int | -1 | 0–3，必须配 `mj_task_id`；不传时复用模式显式发 0（见 §8.9 未知） |
| `animate_mode` | string | 空 = manual | `manual` / `auto`；`auto` 必须 `mj_task_id` + 显式 `mj_index` |

**只有模型名命中 `midjourney-video` 且平台是 apimart 时这些字段才生效**；其它视频模型即使收到
`motion / video_type / mj_batch / end_image / mj_task_id / mj_index / animate_mode` 也一个都不会进请求体
（有测试守着）。

### 8.5 请求体映射（上游 body）

| 上游字段 | 来源 | 说明 |
|---|---|---|
| `prompt` | `prompt` | 空字符串不发（schema 必填，通常都有） |
| `image_urls` | `images[0]` | 数组，恰好 1 条；本地图先走既有 APIMart 上传/图床转成公网 URL |
| `task_id` + `index` | `mj_task_id` + `mj_index` | 与 `image_urls` 互斥；`index` 0–3 |
| `end_url` | `end_image`（或 `role=last_frame`） | 有值就把 `video_type` 升级成 `start_end_*`（档位不变） |
| `video_type` | `video_type` / `resolution` / 默认 | 空 → `base_by_tier`；有尾帧 → `start_end_by_tier` |
| `motion` | `motion` | 默认 `high` |
| `batch_size` | `mj_batch` | 默认 1 |
| `animate_mode` | `animate_mode` | 默认 `manual` |

**不发**：`model`、`duration`、`size`、`aspect_ratio`、`resolution`、`seed`、`watermark`、
`generate_audio`、`image_with_roles`、`video_urls`、`audio_urls`、`nsfw_check`（本地没有该开关）。

轮询：提交只回 `task_id`，结果走 `GET /v1/tasks/{task_id}`；成功体里的 `video_url` 是首条，
`video_urls` 长度 = batch_size。后端把全部 URL 落盘后放进 `videos` 数组返回。

### 8.6 计费口径（预扣 = 结算）

- 档位：`video_type` 以 `_720` 结尾 → 720p，否则 480p；`video_type` 为空时按 `resolution`（默认 480p）。
- 计费 id：480p → `midjourney@video`；720p → `midjourney@video-720p`（价目 category=image、
  unit=per_call，走 pick_video_tier 的 per_call 分支）。
- 数量：`rows = mj_batch`（1/2/4），费用 = 单价 × batch_size；`motion` 不影响计费。
- 价目 gold（2026-11-18 定价接口实测，价目文件已有）：
  - `midjourney@video`：0.2 USD/次 → 成本 2 积分，售价 **2.60** 积分/条；
  - `midjourney@video-720p`：0.4 USD/次 → 成本 4 积分，售价 **5.20** 积分/条；
  - batch=4 的 480p = 成本 8 / 售价 10.40；batch=2 的 720p = 成本 8 / 售价 10.40。
- 预扣用和结算完全相同的 billing id + rows；上游任务没返回 cost 时结算按同一参数保守估价，不会二次抬价。
- **价目缺键显式失败**：拿不到 `midjourney@video` / `@video-720p` 或无有效单价时返回 500，绝不按 0 计。
- 估价接口 `GET /api/credits/price?model=midjourney-video&kind=video&resolution=720p&rows=2`
  本轮补了 `resolution` 参数：虚拟模型按档位映射到两个计费 id，结果与预扣一致（不再落到 conservative 高价）。
- 上游 4xx 不建任务/预扣失败会退款；成功按预扣同口径结算。

### 8.7 错误分支

| 情况 | 后端行为 |
|---|---|
| 平台不是 APIMart | 400「Midjourney 图生视频是 APIMart 渠道能力…」 |
| `mode` 不是 image_to_video（含 text_to_video） | 400 |
| 既没有首帧图也没有 `mj_task_id` | 400（文档不支持文生视频） |
| 首帧图与 `mj_task_id` 同时给 | 400 互斥 |
| `mj_index` 不在 0–3 / 没有 `mj_task_id` 却给了 index | 400 |
| `animate_mode=auto` 缺 `mj_task_id` 或显式 `mj_index` | 400 |
| `motion` 不在 low/high | 400 |
| `mj_batch` 不在 1/2/4 | 400 |
| `video_type` 不在 4 个值 | 400 |
| `resolution` 传 1080p/4k 且没给 video_type | 400（只有 480p/720p） |
| 首帧/尾帧图转不成 APIMart 可访问地址 | 400（带原因） |
| 价目缺键 | 500（不按 0 计） |
| 上游 400 / 422（内容审核自动退款）/ 429 / 5xx | 原状态码 + 上游文案透出；任务失败会退款 |

### 8.8 前端要渲染哪些控件

1. **模型来源**：视频节点的模型候选从 `/api/model-caps`（含 `include_builtin=1`）读 `midjourney-video`，
   不要在前端写死参数；比例/时长控件按 caps 隐藏（`ratios=[]`、`durations=[5]`）。
2. **输入二选一**：
   - 「首帧图」上传/连图（1 张，必填）；
   - 或「复用 MJ 出图」：选一张已完成的 MJ 出图结果 → 取它返回体里的上游 `mj_task_id`
     （不是画布任务 id），再让用户选 4 张候选之一（`mj_index` 0–3）。
3. **尾帧图**（可选）：一个「尾帧」入口，提交到 `end_image`；UI 上提示「设尾帧会自动切首尾帧模式」。
4. **参数**：motion（低/高，默认高）、档位（480p/720p，默认 480p；用它可不带 `video_type`）、
   batch（1/2/4，默认 1，旁注「按 N 倍计费」）、animate_mode（手动/自动；自动仅在复用模式可选）。
5. **时长**：固定约 5 秒，不要给滑杆；**比例**：不要给比例控件（画幅跟随首帧）。
6. **费用**：只展示返回的 `credits` / `credits_cost`，不要自己按模型名估价；batch>1 时提示 ×N。
7. **结果**：`videos` 数组（batch N 时可能有多条，逐条入画布）；`task_id` 是画布任务 id；
   `mj_video` 回显本次 `video_type / tier / batch_size / motion / animate_mode`，便于结果卡展示。
8. **轮询**：沿用现有视频任务链路（`/api/tasks/{id}` 或 canvas-video 同步返回），不需要新接口。

### 8.9 本轮未知 / 证据缺口

- **任务返回结构**：文档写 `GET /v1/tasks/{id}` 的 SUCCESS 含 `video_url` / `video_urls`，但是否包在
  `{code,data}` 外层没写、也没实测；实现同时认顶层与 `data/detail/result` 嵌套（未知外层是否稳定）。
- **上游是否回 cost / usage**：文档没提；结算拿不到实际成本时按预扣同口径保守估价（不伪造 actual）。
- **index 省略时的上游默认值**：文档没写；本实现复用模式下未传 `mj_index` 时显式发 `index: 0`，
  并在契约里标明这是本地取值（拿不到实测，未知是否与上游默认一致）。
- **`task_id` + `end_url` 组合**：文档未明确允许/禁止；本地允许（首帧复用 + 尾帧），上游若 400 原样透出。
- **`start_end_*` 但没有 `end_url`**：文档未说明；本地允许，上游若 400 原样透出。
- **单帧 ≤12 MiB**：文档限制；本地没单独做 12MiB 拦截，沿用既有上传压缩/图床链路，超限由上游 400。
- **多参考图**：文档只收 1 张首帧，本地多给直接 400；不支持把 MJ 视频当参考生视频用。
- **单价复测**：midjourney@video / @video-720p 价格来自 2026-11-18 定价接口实测，本轮无网络未复测。

## 9. 本轮未知 / 未做

- **MJ 视频**：已在 §8 接完后端（虚拟模型 + caps + 请求体 + 计费 + 本地校验）；剩余未知见 §8.9。
- **apimart-zoe / flux-3-video 的 draft_from_task_id**：另一套协议，未混入本契约（未知）。
- **成片 input 档判断**：依赖进程内草稿上下文（最多 500 条、3 天 TTL）；重启/换机后丢失 →
  回落非 input 档，可能少算参考视频输入差额。要做到精确必须持久化草稿上下文（未做，未知）。
- **output_format**：文档允许成片改 mp4/mov，但 CanvasVideoRequest 本轮没有该字段 → 后端不发，
  走上游默认 mp4。要开放得先加 schema 字段（未知是否产品需要）。
- **草稿参考视频输入秒数**：计费只记录「有没有参考视频」，不探测原始视频秒数；精确到秒需要
  在草稿提交时探测并持久化（未做，未知）。
