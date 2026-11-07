# APIMart 官方文档调研报告（task-1）

> 调研对象：`https://docs.apimart.ai`（英文 /en 与中文 /cn，内容一致；本报告以中文页为准，英文页给行号证据）
> 产出机器可读清单：同目录 `catalog.json`
> 原文快照：同目录 `raw/`（抓取命令、sha256、行号使用方式见 `raw/README.md`）
> 对照项目：`NOVAI-v16` 当前工作树（只读，未改动 docs/ 以外任何文件）
> **配套文档：`VENDOR-REASONING.md`（task-11）——各厂商官方文档的推理强度参数矩阵。本报告段 C 只回答「APIMart 有没有」，那边回答「厂商上游到底支持什么」，两篇合起来才是完整的 think_level 依据。**

## 0. 怎么读这份报告（证据分级）

全文用 4 个显式标签，**推断绝不写成事实**：

| 标签 | 含义 |
| - | - |
| **原文** | 文档里直接写着的句子/示例，给 URL 或 `L<行号>`（行号对应 `raw/README.md` 里记录的 llms-full.txt sha256） |
| **推断** | 我根据文档+项目代码做的判断，文档没直接写；出错概率不为 0 |
| **未知** | 文档没写、也无法从文档推出，必须实测或问官方 |
| **项目现值** | 读项目代码得到的现状，带 `文件:行号` |

## 0.1 三条先说的结论（会改变既有方案）

1. **文档里没有 `reasoning_effort`，也没有 `thinkingBudget`/`thinkingConfig`/`budget_tokens`**（对 llms-full.txt 全文 grep，4 个符号各 0 次命中；详见 C 段）。所以「think_level → reasoning_effort」在 APIMart 侧没有任何文档依据，只能按**推断**发送并配降级。Lead 已据此更新契约第 4 条。
2. **唯一有"档位枚举"的推理参数在图像侧**：`gpt-image-2.6-ext` 的 `svg.reasoning.effort` 支持 `none/minimal/low/medium/high/xhigh/max`（**原文**，L6100–L6106）。这说明 APIMart 网关**确实能透传 xhigh/max 这类档位**，但它只对"写 SVG 的文本子模型"生效，不是 chat。
3. **`/v1/chat/completions` 省略 `stream` 时默认是流式**（**原文**，明确写着与 OpenAI 相反）——项目里凡是"不传 stream 就当非流式解析"的代码都是坑。

---

# A. 新增 / 变更模型清单

判定口径：把文档里**确证的模型 ID** 逐个去 `server/credits/apimart_pricing.json`（项目现有 340 条模型目录，`source.page = https://apimart.ai/zh/pricing`）里比对，**按 ID + 该文件的 alias_map 双向匹配**。
- ✅ 已有：本地目录能匹配到
- 🆕 文档独有：本地目录没有（这才是"新增"）
- ⚠️ 形式不同：同一个模型、ID 写法不一样，需要确认哪种上游认

## A.1 文本（chat）

端点统一：**`POST https://api.apimart.ai/v1/chat/completions`**（**原文** L27994–L28000）；另有 Claude 原生 `POST /v1/messages`、Gemini 原生 `POST /v1beta/models/{model}:{action}`、OpenAI Responses `POST /v1/responses`。

来源：`https://docs.apimart.ai/cn/api-reference/texts/general/chat-completions`（**原文**，中文 raw 快照 L646–L655 与 L850–L884；英文 llms-full L28633–L28877）

| 模型 ID（文档原样） | 文档里的说明（原文） | 本项目 |
| - | - | - |
| `gpt-5` | GPT-5 基础模型 | ✅ |
| `gpt-5.1` | GPT-5.1 增强版本 | ✅ |
| `gpt-5-chat-latest` | GPT-5 最新对话版本 | ✅ |
| `gpt-5-mini` | GPT-5 轻量级版本，性价比高 | ✅ |
| `claude-opus-4-8` | Claude Opus 4.8 旗舰模型 | ✅ |
| `claude-opus-4-7` | Claude Opus 4.7 旗舰模型 | ✅ |
| `claude-opus-4-6` | Claude Opus 4.6 旗舰模型 | ✅ |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 平衡版本 | ✅ |
| `claude-opus-4-5-20251101` | Claude Opus 4.5 模型 | ✅ |
| `gemini-3.5-flash` | Gemini 3.5 快速版 | ✅ |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro 预览版 | ✅ |
| `gemini-3-pro-preview` | Gemini 3 Pro 预览版 | ✅ |
| `gemini-3-pro-preview-thinking` | **Gemini 3 Pro 深度思考预览版** | ✅ |
| `gemini-3-flash-preview` | Gemini 3 Flash 预览版 | ✅ |
| `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite` | Gemini 2.5 三档 | ✅ |
| `deepseek-v4-pro` / `deepseek-v4-flash` | DeepSeek V4 专业/快速版 | ✅ |
| `deepseek-v3.2` / `deepseek-v3.2-exp` / `deepseek-v3-0324` | DeepSeek V3 系列 | ✅ |
| `deepseek-r1-250528` | **DeepSeek R1 推理模型** | ✅ |
| `qwen3.8-max` | 固定模型名；思考不能关（见 C.2.4） | ✅ |
| `gpt-5.2-pro` / `gpt-5.2-codex` | 只出现在 Responses 页示例（`/v1/responses`，**原文** L31991 的 `"model": "gpt-5.2-pro"`；codex 见该页模型清单） | ✅ |
| `gpt-6.1-terra` | 只出现在 OpenAI 上下文缓存指南的示例里（**原文** L31836、L31863、L31894 三处 `"model": "gpt-6.1-terra"`）；该页自己写着"以平台模型文档与定价页为准" | 🆕（**旁证弱**：正文模型清单没有它，见"未知" U5） |
| `claude-sonnet-5` | 只出现在 Claude 上下文缓存指南的示例里（**原文** L29885 明确写 "The examples in this guide use `claude-sonnet-5`"） | ✅ |
| `gemini-3.6-flash` | 只出现在 Gemini 上下文缓存指南的示例里（**原文** L26914 同句式，并注明"以平台文档与定价页为准"） | ✅ |

**文本侧没有"整族新增"**：文档 chat 模型清单里 29 个 ID，只有 `gpt-6.1-terra` 本地目录没有，而它的证据只是缓存页示例里的一句 model 名（**未知**：是不是真能调）。

## A.2 图像（image）

端点统一：**`POST https://api.apimart.ai/v1/images/generations`**（响应 `{"code":200,"data":[{"task_id","status":"submitted"}]}`，再用 `GET /v1/tasks/{id}` 取图）。Midjourney 例外：`POST /v1/midjourney/generations/...`。

| 模型 ID（文档原样） | 显示名 | 关键参数（原文） | 本项目 |
| - | - | - | - |
| `flux-2-flex` / `flux-2-pro` / `flux-2-max` | FLUX.2 | size(默认1:1) / resolution(默认2MP) / width+height(各≥64px, ≤4MP) / image_urls(≤8, 合计9MP) / output_format(默认jpeg) / n(仅1) / seed / prompt_upsampling / safety_tolerance / steps(1–50) / guidance(默认5.0) | ✅ |
| `flux-3-image-klein` | FLUX 3 Klein | prompt / image_urls / aspect_ratio(auto) / size / resolution(1k) / steps(16) / output_format(jpeg) / n / seed / safety_tolerance | ✅ |
| `flux-3-image` | FLUX 3 | 同上，另有 `grounding`(默认true)，无 steps | ✅ |
| `flux-kontext-pro` / `flux-kontext-max` | FLUX Kontext | prompt / image_urls(≤4, 合计9MP) / size(1:1) / output_format(png) / n / seed / safety_tolerance | ✅ |
| `gemini-2.5-flash-image-preview`（别名 `nano-banana-ext`）、`gemini-2.5-flash-image-preview-official`（别名 `nano-banana`） | Nano banana | 别名等价（**原文**"The two are interchangeable and produce identical results"） | ✅ |
| `gemini-3-pro-image-preview`（别名 `nano-banana-pro-ext`）、`…-official`（别名 `nano-banana-pro`） | Nano banana Pro | 同上；n 必须纯数字不能带引号 | ✅ |
| `gemini-3.1-flash-image-preview`（别名 `nano-banana-2-ext`）、`…-official`（别名 `nano-banana-2`） | Nano banana2 | 同上；`google_search` 需 `google_search: true` 搭配 | ✅ |
| `gemini-3.1-flash-lite-image`（别名 `nano-banana-2-lite`）、`gemini-3.1-flash-lite-image-ext`（别名 `nano-banana-2-lite-ext`） | Nano Banana Lite | 同上 | ✅ |
| `gemini-nano-banana-2.1` / `gemini-nano-banana-2.1-ext` | Nano banana 2.1 | size(auto) / resolution(1K) / n(official 1–4；ext 仅1) / image_urls(单图≤20MB，ext 合计≤50MB) / official_fallback / webhook。ext 按张·按分辨率计价，official 按实际 token | ✅ |
| `gpt-image-1-official` / `gpt-image-1.5-official` | GPT-Image 1/1.5 官方渠道 | size(1:1) / quality / background / moderation / output_format(png) / output_compression / image_urls / mask_url / nsfw_check | ✅ |
| `gpt-image-2.5-ext` | GPT-Image-2.5 Ext | n(1–4) / 幂等键 `Idempotency-Key`（1–191 可见 ASCII，约 24h 保留，重放带 `Idempotency-Replayed: true`） | ✅ |
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | GPT-Image-2.5 | size(auto) / resolution(1k) / quality / n / output_format(png) / background / moderation(默认low) / image_urls / mask_url | ✅ |
| `gpt-image-2.6-ext` | GPT-Image-2.6 Ext | version(flare/sunburst) / resolution(**仅1k**) / size(10种比例，含21:9) / aspect_ratio / n(**仅1**) / quality(**auto/low/medium/high/xhigh/max**) / output_format(png/jpeg/webp/svg/gif) / complexity(low/medium/high) / image_urls(≤16，各≤20MB) / svg{model,reasoning{effort}} | 🆕 |
| `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst` | GPT-Image-2.6 | size(auto) / resolution(1k/2k/4k) / quality / n(1–4) / output_format(含 svg/gif) / output_compression / background / moderation / image_urls / mask_url / complexity / safety_identifier / svg{model,reasoning{effort}} / markup 引导编辑 / frame_count(2–16，GIF) | 🆕 |
| `gpt-image-2`（别名 `gpt-image-2-ext`） | GPT-Image-2 | 别名等价 | ✅ |
| `gpt-image-2-official` | GPT-Image-2 官方渠道 | size(1:1) / resolution(1k) / quality / moderation / output_format / output_compression / n / image_urls / mask_url / nsfw_check | ✅ |
| `grok-imagine-2.0-ext` | Grok Imagine 2.0 Ext | n / size / resolution / response_format(url) / nsfw_check / webhook；另有「图层与区域编辑」页：selection_regions / boxes / object_indices（三者至少一个非空，坐标 0–1） | ✅ |
| `grok-imagine-image-2.0` | Grok Imagine Image 2.0 官方 | aspect_ratio(auto) / resolution(1k) / quality / image_urls / n(1–10) | ✅ |
| `grok-imagine-1.5-apimart`（别名 `grok-imagine-1.5-ext`） | Grok Imagine 1.5 | 别名等价；另有 `grok-imagine-image` / `grok-imagine-image-quality` 两个版本名 | ✅ |
| `hy-image-v3.5-preview` | Hy-Image-3.5 Preview | size(auto) / resolution(1K) / width+height / image_urls / negative_prompt / seed / n(**必须1**) | ✅ |
| `imagen-4.0-apimart` | Imagen 4.0 | n / size(默认16:9) / nsfw_check | ✅ |
| `mai-image-2.6` / `mai-image-2.6-flash` | MAI-Image-2.6 | size(1:1) / resolution(1K) / width+height(短边≥768，按32取整) / image_urls / auto_aspect_ratio / web_grounding / n | ✅ |
| `muse-image-ext` | Muse Image Ext | aspect_ratio / size / n / webhook / language / `Idempotency-Key`；≤9 张参考图；输出 **WebP** | 🆕 |
| `qwen-image-3.0` / `qwen-image-3.0-pro` | Qwen Image 3.0 | resolution(1K) / size(1:1) / n / negative_prompt / prompt_extend / prompt_extend_mode / image_urls | ✅ |
| `qwen-image-2.0` / `qwen-image-2.0-pro` | Qwen Image 2.0 | size(1:1) / resolution(1K) / n / negative_prompt / image_urls | ✅ |
| `seedream-4.5` | Seedream-4.5 | size(1:1) / resolution(2K) / n / image_urls / sequential_image_generation / watermark | ⚠️ 本地是 `seedream-4-5` |
| `seedream-4.0` | Seedream-4.0 | 同上 + optimize_prompt_options(默认standard) | ⚠️ 本地是 `seedream-4-0` |
| `seedream-5-0-flash` / `seedream-5-0-pro` | Seedream-5.0 Flash/Pro | resolution(1K) / size(auto) / background(opaque) / layer_decomposition / optimize_prompt_options / n / image_urls / output_format(jpeg) / watermark | ✅ |
| `seedream-5-0-lite` | Seedream-5.0 Lite | size(1:1) / resolution(2K) / n / image_urls / output_format / sequential_image_generation / watermark | ✅ |
| `wan2.7-image` / `wan2.7-image-pro` | Wan2.7 图像 | image_urls(≤9，240–8000px，比例1:8~8:1，各≤20MB) / n(标准1–4；sequential 1–12) / size(1K/2K/4K 或比例) / resolution / negative_prompt / watermark / seed / **thinking_mode(布尔，默认true)** / enable_sequential / bbox_list / color_palette(3–10 项，比例合计100%) | ✅ |
| `z-image-turbo` | Z-Image-Turbo | 轻量快速，1K/2K，支持中英文与智能提示词改写 | ✅ |
| `midjourney` | Midjourney | 独立族：`POST /v1/midjourney/generations`（imagine）、`/blend`、`/describe`、`/edits`、`/variation`、`/high-variation`、`/low-variation`、`/upscale`、`/pan`、`/zoom`、`/reroll`、`/remix-strong`、`/inpaint`(+ `/modal`)、`/video`；查询 `GET /v1/midjourney/{task_id}`；单图≤12MiB；inpaint 有 30 分钟 MODAL 超时自动取消+退款 | ✅ |

**图像新增 4 个（🆕）**：`gpt-image-2.6-ext`、`gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`、`muse-image-ext`；另有 2 个 ⚠️ ID 写法不同（`seedream-4.5`/`seedream-4.0`）。

## A.3 视频（video）

端点统一：**`POST https://api.apimart.ai/v1/videos/generations`**，轮询 `GET /v1/tasks/{id}`，结果在 `result.videos`。

| 模型 ID（文档原样） | 显示名 | 关键参数（原文） | 本项目 |
| - | - | - | - |
| `seedance-1-0-pro-quality` / `seedance-1-0-pro-fast` | Seedance 1.0 Pro | duration(5) / aspect_ratio(16:9) / resolution(1080p) / seed / image_with_roles[{url,role}] | ✅ |
| `flux-3-video` | FLUX 3 Video | duration(5) / resolution(hd) / aspect_ratio(auto) / image_urls / video_url / video_urls / audio(true) / draft / draft_from_task_id / safety_tolerance / mode | ✅ |
| `grok-imagine-1.5-video-ext` | Grok Imagine 1.5 Video | 见页面（模型名固定该值） | ✅ |
| `happyhorse-1.0` / `happyhorse-1.1` | HappyHorse | prompt / first_frame_image / image_urls / video_url(仅1.0) / audio_setting(1.0) / resolution(1080P) / duration(5) / size(16:9) / watermark / seed | ✅ |
| `kling-3.0-turbo` | Kling 3.0 Turbo | prompt / first_frame_image / aspect_ratio(16:9) / resolution(720p) / duration(5) / watermark | ✅ |
| `kling-v2-6` | Kling 2.6 | mode(std) / duration(5) / aspect_ratio / negative_prompt / image_urls / audio(false) / watermark | ✅ |
| `kling-v2-6-motion-control` / `kling-v3-motion-control` | Kling 动作控制 | image_url + video_url 必填 / keep_original_sound / character_orientation 必填 / mode 必填 / watermark_info | ✅ |
| `kling-v3-omni` | Kling v3 Omni | prompt / negative_prompt / mode / duration / aspect_ratio / image_urls / image_with_roles / video_list / multi_shot / shot_type / multi_prompt / element_list / watermark / audio | ✅ |
| `kling-v3` | Kling v3 | 同上，无 video_list | ✅ |
| `kling-v4` | Kling V4 | prompt / duration / resolution(720p) / aspect_ratio / image_urls / image_with_roles / first_frame_image / last_frame_image / video_url(s) / audio_urls / omni_reference_task_type(auto) / audio_setting | ✅ |
| `kling-video-o1` | Kling Video O1 | 推理增强（**原文**"Reasoning-enhanced model for highest quality video generation"）/ mode / duration / aspect_ratio / image_urls / image_with_roles / video_list | ✅ |
| `MiniMax-H3` / `MiniMax-H3-Max` | MiniMax-H3 | duration(5) / resolution(H3 默认2K / Max 默认768P) / aspect_ratio / watermark / webhook / first_frame_image / last_frame_image / image_urls / video_urls / audio_urls / image_with_roles | ✅ |
| `MiniMax-H3-Context-IR` | H3 提示词增强 | 单页专用于 Context-IR 提示词增强 | ✅ |
| `MiniMax-H3-Regeneration` | H3 重生成 | `source_task_id` 必填 | ✅ |
| `MiniMax-Hailuo-2.3` / `MiniMax-Hailuo-2.3-Fast` | 海螺 2.3 | duration(默认6) / resolution(768p) / first_frame_image / prompt_optimizer(true) / fast_pretreatment / watermark | ✅ |
| `MiniMax-Hailuo-02` | 海螺 02 | duration(5) / resolution(768p) / first_frame_image / last_frame_image / prompt_optimizer | ✅ |
| `seedance-1-5-pro` | Seedance 1.5 Pro | duration(5) / aspect_ratio / resolution(720p) / seed / audio(true) / camerafixed / image_urls / image_with_roles | ✅ |
| `seedance-2.0` / `-fast` / `-mini` / `-face` / `-fast-face` | Seedance 2.0 | prompt / duration(5) / size(16:9) / resolution(720p) / seed / generate_audio(true) / return_last_frame / tools[{type}] / image_urls / image_with_roles / video_urls / audio_urls | ✅ |
| `seedance-2.5` | Seedance 2.5 | draft / draft_task_id / resolution(720p) / size(adaptive) / duration(5) / generate_audio / watermark / seed / output_format(mp4) / omni_reference_task_type / image_urls / image_with_roles / video_urls / audio_urls / return_last_frame / tools | ✅ |
| `skyreels-v4-fast` / `skyreels-v4-std` | SkyReels V4 | duration(5) / resolution(1080p) / aspect_ratio(16:9) / prompt_optimizer / first_frame_image / end_frame_image / mid_frame_images / ref_images / ref_videos / audio_url | ✅ |
| `veo3.1-fast`（别名 `veo3.1-fast-ext`）/ `veo3.1-quality`（`-ext`）/ `veo3.1-lite`（`-ext`） | VEO3.1 | 文档写明 `model` 可用 `veo3.1-fast` 或兼容别名 `veo3.1-fast-ext` | ⚠️ 本地只有 `veo3.1-fast-ext（veo3.1-fast）` 这种脏 ID，见 §E |
| `veo3.1-fast-official` / `veo3.1-quality-official` | VEO3.1 官方渠道 | negative_prompt / duration(默认8) / aspect_ratio / resolution(720p) / first_frame_image / last_frame_image / seed / sample_count / generate_audio / person_generation / resize_mode / enhance_prompt | ✅ |
| `viduq3-pro` / `viduq3-turbo` | Vidu Q3 Pro/Turbo | duration(5) / resolution(720p) / aspect_ratio / image_urls / audio(true) / seed | ✅ |
| `viduq3-mix` / `viduq3` | Vidu Q3 参考生视频 | image_urls **必填** / duration(5) / resolution(720p) / aspect_ratio / seed | ✅ |
| `viduq4-preview` | Vidu Q4 Preview | image_urls / image_with_roles / first_frame_image / audio_urls / audio_url / aspect_ratio / size / duration(5) / resolution(720p) / audio / seed | ✅ |
| `wan2.5-preview` | Wan2.5 | prompt / image_urls / negative_prompt / resolution(720p) / duration(5) / size(16:9) / seed / prompt_extend(true) / audio(true) / audio_url / watermark | ✅ |
| `wan2.6` | Wan2.6 | prompt / image_urls / negative_prompt / aspect_ratio / resolution(720p) / duration(5) / seed / prompt_extend / audio / audio_url / shot_type / watermark / template | ✅ |
| `wan2.6-i2v-flash` | Wan2.6 i2v Flash | image_urls **必填** / resolution(1080p) / duration(5) / audio / audio_url / prompt_extend / shot_type / seed / watermark | ✅ |
| `wan2.7` / `wan2.7-r2v` / `wan2.7-videoedit` | Wan2.7 系列 | 生成 / 参考生视频 / 视频编辑三页 | ✅ |
| `wan3.0-video` / `wan3.0-video-prime` | Wan3.0 | 见页面 | ✅ |
| `gemini-omni-1.1-flash` / `gemini-omni-1.1-flash-ext` / `gemini-omni-flash-preview` | Gemini Omni | 见页面 | ✅ |
| `grok-imagine-video` / `grok-imagine-video-1.5` | Grok 官方视频 | 见页面 | ✅ |
| `muse-video-ext` | Muse Video Ext | 约 10 秒 / 720p / 带声音 / ≤9 张参考图 / `Idempotency-Key` | 🆕 |
| `pixverse-v6` / `pixverse-v6-max` | PixVerse V6 | 见页面 | ✅ |

**视频新增 1 个（🆕）**：`muse-video-ext`。

## A.4 音频（audio）

音频**不是**一个统一端点，而是"生成走 `POST /v1/music/generations`，各种编辑操作走各自子路径"，查询统一 `GET /v1/music/tasks/{task_id}`（**注意不是 `/v1/tasks/{id}`**，**原文** L70305）。

来源：`https://docs.apimart.ai/cn/api-reference/audios/*`

| 模型 ID（文档原样） | 覆盖能力 | 端点 | 本项目 |
| - | - | - | - |
| `suno`（model 字段默认值） | 40+ 个 Suno 操作：generate/addInstrumental/addStem/addVocals/coverSong/createModel/createVoice/crop/extend/fadeIn/fadeOut/generateMp4/inspo/lyrics/mashup/midi/persona/remaster/removeSection/replaceMusic/sample/sounds/stems/stemsAll/upload/uploadCover/uploadExtend/upsampleTags/vox(deprecated)... | `POST /v1/music/generations/<op>` | ✅（本地目录是 `suno@generate` 这种 op 粒度） |
| `flowmusic` | cover/downloadAudio/extend/generate/lyrics/replace/stems/upload_audio/video_clip | `POST /v1/music/generations`(generate) 或 `/<op>FlowMusic` | ✅（`flowmusic@*`） |
| `lyria-3.5` / `flowmusic-lyria-3.5` | FlowMusic 的 Lyria 3.5 专用版：generate / cover / extend / replace，**version 字段必填** | 同 FlowMusic 路径 | 🆕 |
| `gpt-4o-mini-tts` | TTS 语音合成（OpenAI 兼容） | `POST /v1/audio/speech` | 🆕 |
| `whisper-1` | 语音转写 | `POST /v1/audio/transcriptions`（multipart） | 🆕 |

Suno 版本/限制（**原文** L70320–L70357）：public version 仅 `v6` / `v6-wild` / `v6-mini`；`variety`=`off/normal/high/extra/max`；`max_mode`(默认 false，2× 计费)；`audio_format`=`mp3/m4a/wav`；`duration` 10–360s；prompt ≤3000 字符、custom 歌词 ≤5000、style ≤1000、title ≤80；`style_weight`/`weirdness`/`audio_weight` 0–1。

**音频新增 4 个（🆕）**：`lyria-3.5`、`flowmusic-lyria-3.5`、`gpt-4o-mini-tts`、`whisper-1`。

另：`omni-moderation-latest`（`POST /v1/moderations`）在文档里有独立页，本项目目录里归在 chat 类，**不属于本次四类增量**，只在 B 段提一句。

## A.5 上传（不属于模型，但生成接口强依赖）

| 端点 | 限制（原文） |
| - | - |
| `POST /v1/uploads/images` | JPEG/PNG/GIF/WebP，默认 30MB |
| `POST /v1/uploads/videos` | MP4/MOV/WebM，默认 50MB |
| `POST /v1/uploads/audios` | MP3/WAV/M4A，默认 15MB |

三个端点共享**每用户配额：72 小时内 2000 个文件**；上传免费但账户余额必须为正；成功立即返回公网 URL，无需轮询；响应带 `X-Upload-Quota-Remaining`。来源 `https://docs.apimart.ai/cn/api-reference/uploads/images`（**原文**）。

---

# B. 协议变更（文档现值 vs 项目现值）

## B.1 base URL 与鉴权

| 项 | 文档现值（原文） | 项目现值 |
| - | - | - |
| Base URL | `https://api.apimart.ai`，OpenAI 兼容前缀 `https://api.apimart.ai/v1` | `web/src/shell/settings/api/core/constants.js:128` `base_url: 'https://api.apimart.ai'`，一致 |
| Bearer 鉴权 | `Authorization: Bearer YOUR_API_KEY`（推理接口统一） | 一致 |
| **Anthropic 原生** | `POST /v1/messages` 用 `x-api-key` + `anthropic-version: 2025-10-01`，**不是 Bearer**（**原文** L30264–L30267 的 curl） | 项目没有走 /v1/messages 的路径（**推断**：APIMart 的 claude 模型目前走 /v1/chat/completions）。要做 Claude 原生就得单独处理 header |
| 管理接口 | `/api/*` 是管理 API，响应形如 `{success,message,data}`；**与推理接口 `{code,data}` 不是一套**，文档明确警告不要混（**原文** L30259–L30261） | 项目只用推理接口，未混用 |

## B.2 提交 / 轮询 / webhook

| 环节 | 文档现值 | 项目现值 | 差异 |
| - | - | - | - |
| 图像提交 | `POST /v1/images/generations` → `{"code":200,"data":[{"task_id","status":"submitted"}]}` | `main.py:15962` `gen_url = provider_endpoint_url(provider, "image_generation_endpoint", "/v1/images/generations")` | 一致 |
| 视频提交 | `POST /v1/videos/generations` | 一致（有 `/v1/videos` 特例处理） | 一致 |
| 图像/视频轮询 | `GET /v1/tasks/{task_id}`，外层 `{"code":200,"data":{...}}`；状态 `pending/processing/completed/failed/cancelled`；可选 `?language=en|zh|ja|ko|ru|fr|de|id|pt|es`（仅影响 `error.message`） | `main.py:8908` `f"{base_url}/tasks/{task_id}" if base_url.endswith("/v1") else f"{base_url}/v1/tasks/{task_id}"` | 一致；**但项目没传 `language`**（可选，影响失败文案语言） |
| **音频轮询** | `GET /v1/music/tasks/{task_id}`（**另一个路径**） | 未在本次核对范围内逐行确认（**未知**：项目音频任务查询是否走对路径，建议 backend 自查） | ⚠️ 待确认 |
| 图片 URL 形态 | `result.images[].url` 是**数组**，带 `expires_at`（Unix 秒）；"URL 有效期 24 小时"（**原文** L83332）；`result.audios` 对应音频 | 一致（**推断**：项目按数组处理） | 一致 |
| **webhook** | 请求体**顶层**加 `webhook`（填 base URL，平台自动追加 `/callback`）+ 可选 `language`；只在终态推一次；失败重试 3 次（约 10s/30s/60s）；**4xx 立即放弃不重试**；可能重复推送，需按 `id` 幂等；回调 URL 必须是公网（127.0.0.1/内网段会被拒）；`/mj/submit/*` 和 `/v1/images/edits` 不支持；xAI 官方图像模型带 `language` 会 400 | 项目是**纯轮询**，没有 webhook | 能力差，非破坏性；若要接 webhook 需处理"平台追加 /callback"这个反直觉规则 |
| 回调体包装 | **文档自身不一致**：`GET /v1/tasks/{id}` 的示例是 `{code,data}` 包装，但 webhook 推送示例是**裸 task 对象**（`{"id","status","progress",...}`，**原文** L79904–L79934） | — | **未知**：真实推送到底哪一层包装。要接 webhook 必须两种都兼容 |
| 幂等 | `Idempotency-Key` 头（1–191 可见 ASCII，UUID 最佳，约 24h 保留）；重复时回 `Idempotency-Replayed: true`；冲突 `409 idempotency_in_progress / idempotency_key_reused / idempotency_result_indeterminate`。文档在 `gpt-image-2.5-ext`、`grok-imagine-2.0-ext`、`muse-*` 页明确要求 | 项目请求体**没有** `Idempotency-Key` | 缺能力：网络超时重试现在是"重复计费风险" |

## B.3 响应包一层 `{"code":200,"data":{}}` 的规则（重要）

| 接口 | 是否包 `{code,data}` | 依据 |
| - | - | - |
| `/v1/chat/completions` | **包**（`{"code":200,"data":{"id":...,"choices":[...]}}`） | **原文** L28520–L28545 |
| `/v1/images/generations` / `/v1/videos/generations` | **包**（`data[0].task_id`） | **原文** L6262–L6271 |
| `/v1/tasks/{id}` | **包** | **原文** L79615–L79640 |
| `/v1/music/generations` / `/v1/music/tasks/{id}` | **包** | **原文** L56785 起、L70372 起 |
| **`/v1/messages`（Anthropic 原生）** | **不包**（上游原样透传） | **原文** L30257–L30261 |
| **`/v1/responses`（OpenAI Responses）** | 文档示例是**裸** Responses 对象（`output`/`usage`） | **原文** L32863 起的响应字段 |
| 错误响应 | **不包**，统一 `{"error":{"code","message","type"}}` | **原文** L28547–L28615 |
| 管理接口 `/api/*` | `{success,message,data}` | **原文** L30261 |

> **项目现值缺口**：错误体是裸 `{"error":{...}}`，与成功体的 `{code,data}` 不同层。**推断**：项目里如果只判断 HTTP 200 然后取 `data`，遇到"HTTP 200 但 code≠200"（文档没写会不会这样，**未知**）会静默拿到空数据。

## B.4 请求体大小与速率限制

| 项 | 文档现值 | 说明 |
| - | - | - |
| **速率** | 文档只给 `429 rate_limit_error` + "Honor `Retry-After`"，**没有给任何 RPM/TPM/并发数字**（**未知**） | 多页都出现"reduce concurrency before retrying"但无具体值 |
| 单图上限 | 按模型不同：4MB（gpt-image-2 mask）/ 10MB / 20MB / 30MB（上传接口默认）/ 12MiB（Midjourney）/ 7MB（建议值） | 见各模型页 |
| 单请求合计 | gpt-image-2：`Max 20 MB per image, 256 MB in total`（**原文** L7107）；nanobanana2.1-ext：单图 20MB / 合计 50MB | |
| 参考图数量 | FLUX.2 ≤8、FLUX Kontext ≤4、gpt-image-2.6 ≤16、wan2.7/muse ≤9、Midjourney 2–4 | |
| 下载参考图 | 默认 20MB / 60 秒超时（**原文** L5606） | 项目下载参考图若没有超时/大小保护，长任务会挂 |
| 任务超时 | 图像建议 3 分钟、视频 10 分钟；轮询间隔 3–5 秒（图像）/ 2 秒起、退避到 5 秒（Grok） | 项目是否有对应超时**未知** |

## B.5 可选参数与"被忽略/不支持"的参数

- `/v1/chat/completions`：`stream` **默认 true**（**原文**）——这是与 OpenAI 相反的默认值。
- `gpt-image-2.6-ext`：`resolution` 只支持 `1k`；`2k/4k` 返回 403 `model_price_not_configured`；`n` 只支持 1；`size` 只接受 10 种比例不接受像素（`1024x1024` 会 400）。（**原文** L6016–L6030）
- 各模型"Unsupported parameters"/"被忽略"段落：如 `flux-3*` 的 `steps`/`guidance`、`gpt-image-2.6` 的 `markup + mask` 互斥、`wan2.7-image` 的 `thinking_mode` 在 sequential/有参考图时被忽略。
- `/v1/messages/count_tokens` **未实现，返回 404**（**原文** L31529）。
- 响应要"忽略未知字段"：文档明确建议 `passthrough` / 不 `DisallowUnknownFields`（**原文** L31531–L31537）。
- `GET /v1/models?expand=category|parameters` + `GET /v1/models/{id}/schema`（模型名含 `/` 时用 `GET /v1/model-schema?model=`）：**这是本次最有价值的协议新增**——能拿到 `category`、`capability_tags`、以及 image/video 的 JSON Schema（`input_schema`，draft 2020-12）。chat/audio 目前只有 category + tags，没有 parameters（**原文** L31616–L31804）。
  - **项目现值**：`main.py:21272` 只用裸 `/v1/models` 做连通性探测，没有用 `expand`。
  - **意义**：`model_caps`（比例/档位/时长白名单）可以改成"从上游 schema 自动同步"，替代人工维护 `APIMART_IMAGE_MODEL_CAPS`/`APIMART_VIDEO_MODEL_CAPS`（**推断**，需实测 schema 覆盖度是否够）。

## B.6 文档自身的问题（复核时别踩）

1. **`llms.txt` 里宣称的 OpenAPI 规范是 Mintlify 默认占位示例**：`https://docs.apimart.ai/api-reference/openapi.json` 返回的是 "OpenAPI Plant Store"（演示用植物店 API，`paths: /plants`）。**原文观察**：抓下来 5168 字节，`info.title = "OpenAPI Plant Store"`，与 APIMart 无关。**不能用它做接口真值源。**
2. webhook 推送体带不带 `{code,data}` 包装，文档两处不一致（见 B.2）。
3. `/v1/tasks/{id}` 与 `/v1/music/tasks/{id}` 两套任务查询路径并存，容易混。
4. 中英文页一致（我抽查了 chat-completions / claude-messages / tasks/status / webhook / models/list 五页的 cn .md，与 en 的 llms-full 内容一致）。

---

# C. 思考强度 / 推理参数（这是 `model_caps.think` 的数据来源）

## C.1 全文证据：四个关键符号各 0 次命中

对 `llms-full.txt`（2,327,937 字节 / 87,909 行，sha256 `da7f038a…387fc`）做整文件计数（**原文观察**，我跑的，可复现）：

| 符号 | 命中次数 |
| - | - |
| `reasoning_effort` | **0** |
| `budget_tokens` | **0** |
| `thinkingConfig` | **0** |
| `thinkingBudget` | **0** |

复现命令：`grep -c reasoning_effort /tmp/apimart-llms-full.txt`（需先按 `raw/README.md` 下载同 sha256 的文件）。

**结论（原文）**：APIMart 不对外承诺任何"档位式"推理参数，除了 C.2 的 SVG 子对象。**"think_level → reasoning_effort" 是纯推断。**

## C.2 逐模型族：上游到底怎么传

### C.2.1 Anthropic 系（`/v1/messages` 原生透传）—— 唯一"文档确证支持思考"的族

**原文**（`https://docs.apimart.ai/cn/api-reference/texts/general/claude-messages`，中文 raw 快照 L683–L689；英文 llms-full L30930–L30936）：

> **thinking** `object` — Extended thinking 配置
> 开启后响应 `content` 中可能包含 `thinking` 块。**推荐**使用标准模型名 + 本参数，而不是依赖平台侧的 `-thinking` 模型别名…
> 多轮对话若需回传 thinking 块，必须**原样带回** `signature`，否则上游会拒绝。

- **传法**：请求体加 `thinking` 对象（透传给 Anthropic）——但**对象内部字段文档没列**（`type`/`budget_tokens` 均未出现）。
- **budget_tokens 范围**：**未知**。文档只说"语义以 [Anthropic Messages API] 为准"，把取值范围甩给了 Anthropic 官方文档。
- **档位**：文档**没有**档位概念，只有开/关。
- `-thinking` 后缀模型（`claude-opus-4-6-thinking` 等）是**平台别名**，文档推荐用"标准名 + thinking 参数"替代（**原文** L31541）。
- 计费：`output_tokens` **已包含** thinking tokens，不要重复加（**原文** L31180）。
- 响应解析陷阱：开了 thinking 后 `content[0]` 可能是 thinking 块，不能假设它是 text（**原文** L31133–L31139）。

### C.2.2 OpenAI 兼容（`/v1/chat/completions`）—— **文档没有任何推理参数**

**原文**：Body 段列出的全部字段是 `model` / `messages` / `temperature`(0–2) / `max_tokens` / `stream`(默认true) / `top_p`(0–1) / `frequency_penalty`(-2~2) / `presence_penalty`(-2~2) / `stop` / `n`（英文 L28633–L28768；中文 raw 快照 L644–L778 的 `## Body` 整段）。**没有 `reasoning_effort`，没有 `reasoning`。**

- **传法（推断）**：如果上游是"OpenAI 兼容 + 透传"，`reasoning_effort` 有可能被透传；但文档没有承诺，**可能被静默丢弃，也可能 400**。属于**未知**，必须实测。
- **推断依据强度**：中等。支持"能透传"的旁证是 `gpt-image-2.6` 的 `svg.reasoning.effort` 明确接受 `none/minimal/low/medium/high/xhigh/max`（见 C.2.5），说明网关侧存在 effort 枚举的映射逻辑；但那是文本子模型路径，不等于 `/v1/chat/completions`。
- **属于"推理族"的模型（推断）**：`o1`/`o1-*`/`o3`/`o3-*`/`o4-*`、`gpt-5*`（含 5.1/5.2/5.4/5.5/5.6、`-codex`、`-pro`）、`deepseek-r1*`、`grok-*-reasoning`、`qwen3.8-max`、`kimi-*-thinking`、`glm-z1`（后三个在文档里没出现，只在项目定价目录里）。
- **文档里出现的推理族**（有原文依据的只有 2 个）：`gemini-3-pro-preview-thinking`（"Gemini 3 Pro 深度思考预览版"）、`deepseek-r1-250528`（"DeepSeek R1 推理模型"）。

### C.2.3 Gemini 原生（`/v1beta/models/{model}:generateContent`）—— **没有 thinkingConfig**

**原文**：`generationConfig` 只列 `temperature` / `maxOutputTokens` / `topP` / `topK` / `stopSequences` / `safetySettings`（英文 L27824–L27885）。响应里只有 `usageMetadata.thoughtsTokenCount`（**用量统计，不是入参**，L27975–L27977）。

→ **不发 `generationConfig.thinkingConfig.thinkingBudget`**。文档没有这个字段，发了属于"未知字段"。

### C.2.4 qwen3.8-max —— **思考开关是模型固有属性，没有档位**

**原文**（`https://docs.apimart.ai/en/api-reference/texts/qwen3.8-max/guide`，L33535–L33543）：

> **Thinking cannot be turned off.** Every request reasons before answering.
> * `enable_thinking: false` is ignored in stream mode; non-stream is degraded — **not recommended**

→ 不可关、无档位。`model_caps.think` 应当**不下发**；前端隐藏入口，别让用户以为能调。

> **2026-11 更正（task-11，见 `VENDOR-REASONING.md` §2.5 / §4.5）**：上面的"无档位"只是 **APIMart 文档**的视角（APIMart 自己确实一个推理参数都没写）。**阿里云官方文档确认 qwen3.8-max 有 `reasoning_effort`：`low` / `medium` / `xhigh`（默认 `xhigh`），其中 `high` 与 `max` 都被映射成 `xhigh`。**
> 因此**结论以厂商文档为准**：`qwen3.8-max` **要保留入口，但档位收敛成 3 档**（低 / 中 / 极高），不要按本节"不下发"实现。本节其余事实（思考关不掉、`enable_thinking:false` 在 stream 被忽略）仍然成立。

### C.2.5 图像侧的 `thinking`/`effort`（两个真实存在的参数，别和 chat 混）

| 模型 | 参数 | 取值 | 原文 |
| - | - | - | - |
| `gpt-image-2.6-ext` / `gpt-image-2.6-*` | `svg.reasoning.effort` | `none / minimal / low / medium / high / xhigh / max`（"Supported values depend on the text model; omit if unsure"） | L6100–L6106 |
| `gpt-image-2.6-ext` | `quality` | `auto / low / medium / high / xhigh / max`（注意 `quality` 也是这套档位词） | L6032–L6034 |
| `wan2.7-image` / `wan2.7-image-pro` | `thinking_mode` | **布尔**，默认 `true`；"Enable enhanced reasoning mode to improve image quality at the cost of longer generation time"；**sequential 模式或有输入图时被忽略** | L26482–L26495 |

> 这两处说明：APIMart 的"思考"在图像侧是**开关 + 子模型 effort**，在文本侧是**模型选择（`-thinking` 别名）或 Anthropic `thinking` 对象**。**都不是** `low/mid/high/xhigh/max` 五档。

## C.3 模型 → 档位 表（`model_caps.think` 的数据来源）

按 Lead 定的证据分级写：**documented** = 文档确证有思考能力；**inferred** = 推理族但参数/档位是推断；**none** = 明确不支持/不可调。

| 模型族 / 代表 ID | 文档是否确认支持思考 | 上游传法 | 建议 `model_caps.think` | 分级 |
| - | - | - | - | - |
| `claude-opus-4-8` / `claude-opus-4-7` / `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-opus-4-5-20251101` | **是**（`thinking` 对象、extended thinking） | `POST /v1/messages` + `thinking` 对象 | `["low","mid","high","xhigh","max"]`（档位→budget 映射见 C.4） | documented（开关）/ inferred（档位） |
| `gemini-3-pro-preview-thinking` | **是**（文档写"深度思考预览版"） | 模型名即开关；原生格式无 thinkingConfig | `["low","mid","high","xhigh","max"]` 但**建议只给 `["high"]` 或不下发**（无法调档，仅有"thinking 版/非 thinking 版"两态） | documented（能力）/ inferred（档位无意义） |
| `deepseek-r1-250528` | **是**（"推理模型"） | 文档未给参数；R1 系通常不接受 effort | `[]`（不下发，前端不显示） | documented（能力）/ 无档位 |
| `gpt-5` / `gpt-5.1` / `gpt-5-chat-latest` / `gpt-5-mini` / `gpt-5.2-pro` / `gpt-5.2-codex` 等 `gpt-5*` | **否**（文档没写） | 推断：`/v1/chat/completions` + `reasoning_effort`，**发之前先探测/发失败就降级** | `["low","mid","high","xhigh","max"]`（`inferred: true`） | inferred |
| `o1`/`o3`/`o4-*` 系（只出现在项目定价目录） | **否** | 同上，推断 `reasoning_effort` | 同上 | inferred |
| `qwen3.8-max` | **是**（"不能关"） | 无参数可传 | `[]` | documented（不可调） |
| `claude-*-thinking` 别名模型 | 是（别名） | 模型名即开关 | 同 claude 族 | documented |
| `gemini-2.5-*` / `gemini-3.*`（非 -thinking） | **否**（文档未说可调） | 不发 | `[]` | none |
| `claude-haiku-4-5-20251001` | 否（文档未说） | 不发 | `[]` | none |
| 其它全部 chat 模型 | 否 | 不发 | 不下发该字段 | none |

## C.4 档位 → 上游取值 的**推断**映射（建议后端照此实现并标注）

> 以下全部是**推断**，文档无依据。原则：**默认不发；发了失败就降级重发一次不带该字段**。

### Anthropic 系（唯一可以真发的）

请求体 `thinking: {"type":"enabled","budget_tokens": N}`。`N` 的取值范围**文档未写（未知）**；按 Anthropic 官方的经验规律（`budget_tokens` 一般需要 ≥1024 且 < `max_tokens`），建议：

| think_level | 建议 budget_tokens |
| - | - |
| `low` | 1024 |
| `mid` | 2048 |
| `high` | 4096 |
| `xhigh` | 8192 |
| `max` | 16384 |

配套硬约束（推断 + 原文各一半）：`max_tokens` 必须 > `budget_tokens`，否则上游会拒（Anthropic 官方语义）；文档确认 `max_tokens` 是必填（**原文** L30922–L30928）。**必须做"400 → 去掉 thinking 重发一次"的降级。**

### OpenAI 兼容族（只能按推断发）

字段 `reasoning_effort`，文档无。建议映射（保守，宁可少档也别乱映射）：

| think_level | 建议 reasoning_effort |
| - | - |
| `low` | `minimal` |
| `mid` | `low` |
| `high` | `medium` |
| `xhigh` | `high` |
| `max` | `high`（不猜 `xhigh`/`max`，除非实测通过） |

只有 `o1*`/`o3*`/`o4*`/`gpt-5*`/`deepseek-r1*` 家族才发。**400/422 → 去掉字段重发**，并在日志里记一条"上游不接受 reasoning_effort"。

### Gemini 原生族

**不发 `thinkingConfig`**（文档没有）。将来若官方补上，再按官方范围实现。

### 图像侧（如果前端要暴露）

- `gpt-image-2.6-*`：可以暴露"质量/思考"档，但那是 `quality`（`auto/low/medium/high/xhigh/max`，**原文**）和 `svg.reasoning.effort`（**原文**），**不是 `think_level`**，不要复用同一个 UI 状态。
- `wan2.7-image*`：`thinking_mode` 布尔。

---

# D. 建议的最小改动清单

## D.1 必须（不做会导致功能错或用户看不到新模型）

| # | 改动 | 位置 | 依据 |
| - | - | - | - |
| D1 | 新增 4 个图像模型 + 1 个视频 + 4 个音频模型进本地目录（含 pricing 条目与别名） | `server/credits/apimart_pricing.json`（或新增一份 overlay） | A.2/A.3/A.4 的 🆕 |
| D2 | 修 `veo3.1-fast`/`veo3.1-quality`/`veo3.1-lite` 的 ID：`alias_map` 补三条正向映射，别再让定价抓取的脏 ID `veo3.1-fast-ext（veo3.1-fast）` 当唯一键 | `server/credits/apimart_pricing.json` | §E 附带发现 |
| D3 | **`qwen3.8-max` 要有入口，但只能 3 档、不能 5 档**：阿里云官方文档确认它有 `reasoning_effort` = `low` / `medium` / `xhigh`（默认 `xhigh`），`high` 和 `max` 都被映射成 `xhigh`；APIMart 文档完全不写推理参数 → **结论以厂商文档为准**，档位收敛成 3 档（低/中/极高），而不是"隐藏入口" | `server/protocols/thinking.py`：显式表加 `qwen3.8-max → [low, mid, xhigh]`；不要继续让 `_LEGACY_THINK_PATTERN` 的 `qwen3` 兜底给 5 档（现状就是 5 档 + 发 `{"reasoning_effort":"high"}`） | 阿里云官方文档 https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions ；汇总见 `VENDOR-REASONING.md` §2.5/§4.5 |
| D4 | **`deepseek-r1-250528` 的证据标注要拆开**：文档只证明"它是推理模型"，**没有**证明它能分 5 档、更没证明吃 `reasoning_effort`；现状把它标 `documented` 且给满 5 档 | `server/protocols/thinking.py:56-65` `THINK_MODEL_LEVELS`/`THINK_MODEL_EVIDENCE` → 建议拆成"能力 documented / 档位 inferred"两段标注，或档位收敛（R1 系通常拒绝 effort） | C.2.2、C.3 |
| D5 | **`gemini-3-pro-preview-thinking` 同理**：文档原话只是"深度思考预览版"（= 思考版模型），没有档位；现状给 5 档且 transport 判成 `reasoning_effort`（Gemini 族在 OpenAI 兼容体里没有任何可确认字段） | `server/protocols/thinking.py:56-65`、`171-186` `think_transport` | C.2.3、C.3 |
| D6 | **Claude 的 thinking 能力在 `/api/config` 里永远看不到**：`THINK_ANTHROPIC_MODEL_PATTERNS` 让 anthropic 族在 openai 体下返回 None，所以 `model_caps.think` 不含 Claude。产品上要决定：接受"Claude 暂无入口"，还是给 Anthropic 协议单独下发档位 | `server/protocols/thinking.py:82-84`、`133-134` | C.2.1、C.3 |
| D7 | 回归约束（现状已满足，别退化）：`/v1/chat/completions` 省略 `stream` 就是流式，所有非流式调用点必须显式 `stream:false` | `main.py:25593`（注释"APIMart 默认流式，强制关闭"）等调用点 | B.5（**原文**） |
| D8 | `/v1/chat/completions` 与 `/v1/messages`、`/v1/responses` 的**包装差异**要分开解析（前者包 `{code,data}`，后两者不包） | 新增 Claude 原生 / Responses 支持时 | B.3 |
| D9 | 协议更新接口必须自己维护版本号（`protocol_version`），**不要依赖上游 OpenAPI**（那份是 Mintlify 占位示例 Plant Store） | 契约 5 的实现 | B.6 |

## D.2 可选（有价值但可以晚一轮）

| # | 改动 | 价值 | 依据 |
| - | - | - | - |
| O1 | 接 `GET /v1/models?expand=category&category=video` 做"模型目录自动同步"，替代手写 `APIMART_VIDEO_MODEL_CAPS` | 高：白名单再也不用人工跟 | B.5 |
| O2 | 请求带 `Idempotency-Key`（UUID），超时重试复用同一个 key | 高：防重复计费 | B.2 |
| O3 | **图像**任务轮询补 `?language=zh`（视频与音乐已经带了，图片没有） | 中：失败文案直接中文 | B.2、`main.py:8955-8962` vs `23637-23638`/`22601` |
| O4 | 接 webhook（顶层 `webhook`，平台自动加 `/callback`，两种包装都兼容，按 `id` 幂等） | 中：长视频不用长轮询 | B.2 |
| O5 | 参考图下载加 20MB / 60s 超时保护 | 中：防长任务挂死 | B.4 |
| O6 | 把 `gpt-image-2.6` 的 `quality` 档、`wan2.7-image` 的 `thinking_mode` 作为**独立开关**暴露（不要塞进 think_level） | 中 | C.2.5 |
| O7 | （已确认无须改）音频任务查询已走 `/v1/music/tasks/{id}?language=zh` | — | `main.py:22599-22601` |

## D.3 明确"不要做"的

- ❌ 不要给 Gemini 原生请求塞 `generationConfig.thinkingConfig`（文档没有；按契约是"未知字段"）。
- ❌ 不要因为模型名里有 `thinking` 就假定它能调 5 档（`gemini-3-pro-preview-thinking` 只是"思考版模型"）。
- ❌ 不要用 `api-reference/openapi.json` 生成客户端（是占位示例）。
- ❌ 不要把 `/v1/messages` 的 `x-api-key` 和 `/v1/chat/completions` 的 `Bearer` 混用。

---

# E. 附带发现（本任务不修，只记录）

1. **`veo3.1` 定价脏 ID**：`server/credits/apimart_pricing.json` 里视频模型存在 `veo3.1-fast-ext（veo3.1-fast）`、`veo3.1-quality-ext（veo3.1-quality）`、`veo3.1-lite-ext（veo3.1-lite）` 三个带全角括号的 ID，`alias_map` 里只有 `veo3.1-fast-ext` 等，**没有** `veo3.1-fast` / `veo3.1-quality` / `veo3.1-lite` 的正向映射。而文档明确写"model 可用 `veo3.1-fast` 或别名 `veo3.1-fast-ext`"。→ 用户填 `veo3.1-fast` 可能匹配不到价格/能力。
2. **`/api/model-caps` 不含 chat**：`main.py:20531` 的循环只跑 `image`/`video`，所以 `think` 只能从 `/api/config` 的 `api_providers[].model_caps` 拿（契约 2 写的位置是对的，但这个端点容易误用）。
3. **调研期间后端（task-2）正在并行重构这块**：我第一次 grep 时 `think_level` 只有 `lovart_chat_mode` 一个消费者；收尾时 `main.py` 已出现 `chat_think_fields` / `post_chat_with_think` / `chat_stream_with_think`，真值源迁到 `server/protocols/thinking.py`。**本报告对项目现值的描述以 2026-11-06 15:20 左右的工作树为准**，backend 再改同类文件后请以代码为准、别以本报告为准。
4. 前端 `web/src/pages/chat/thought.js:26-32` 的 `THINK_LEVELS` 与后端 `THINK_LEVELS_FULL` 一致（low/mid/high/xhigh/max）；但 `legacyThinkLevels()`（前端兜底正则）与后端 `server/protocols/thinking.py` 的新规则**结构上不同步**：前端是"命中就给 5 档"，后端已经引入 documented/inferred 分级与 anthropic/gemini 族的排除。后端定稿后，前端兜底建议直接删掉、只信 `model_caps`，否则会出现"后端说没有、前端还显示"的假入口。
5. 文档没有给任何具体速率数字（RPM/TPM/并发），也没有"请求体最大字节数"这一项——只有按模型的图片大小限制。若要做限流，只能靠 `429` + `Retry-After` 自适应。

## E.1 对后端已实现方案（`server/protocols/thinking.py`）的逐项核对

> 这一节是**我给 Lead/backend 的验收意见**，不是文档内容。实测方式：`cd NOVAI-v16 && python3 -c "from server.protocols import thinking as t; ..."`（2026-11-06 收尾时跑）。

| 模型（实测输入） | 现状输出 | 文档怎么说 | 结论 |
| - | - | - | - |
| `qwen3.8-max` | levels=5 档、evidence=inferred、transport=`reasoning_effort`、`think_request_fields` 会发 `{"reasoning_effort":"high"}` | APIMart 文档不写推理参数；**但阿里云官方文档确认有 `low`/`medium`/`xhigh` 三档（默认 xhigh），high/max 都落 xhigh** | ⚠️ 档位给多了：入口要**保留**，但 5 档应收敛成 **3 档**（见 D3 更正） |
| `deepseek-r1-250528` | levels=5 档、evidence=**documented** | 只证"是推理模型"，无档位、无参数 | ⚠️ **证据等级标高了**，见 D4 |
| `gemini-3-pro-preview-thinking` | levels=5 档、evidence=**documented**、transport=`reasoning_effort` | 原话只是"深度思考预览版"，无档位；Gemini 原生无 thinkingConfig | ⚠️ 同 D5 |
| `gpt-5` / `gpt-5.1` / `gpt-5.2-pro` / `o3` | levels=5 档、evidence=inferred、发 `reasoning_effort` | 文档无该字段 | ✅ 符合契约（推断 + 400 降级已在 `post_chat_with_think` 里实现） |
| `claude-opus-4-6` | levels=**None**（openai 体）、anthropic 体才返回 `thinking` | `/v1/messages` 确证支持 thinking | ⚠️ 能力被藏起来了，见 D6 |
| `gemini-3.5-flash` / `gemini-2.5-pro` / `gpt-4o-mini` | levels=None、transport="" | 文档未说可调 | ✅ 正确，不下发 |
| `kimi-k2-thinking` / `glm-z1` | levels=5 档、evidence=inferred | 文档里没有这两个模型（只在项目定价目录） | ⚠️ 文档侧无法佐证，属"项目自说"；建议 backend 在注释里标明来源是定价目录而不是官方文档 |

另外，`thinking.py:43-45` 的 `REASONING_EFFORT_BY_LEVEL` 用的是 `low→low / mid→medium / high→high / xhigh→xhigh / max→max`，即**假定网关接受 `xhigh`/`max` 两个非 OpenAI 原生值**。文档里确实存在这套枚举（`svg.reasoning.effort`），所以这个推断**方向对**；但 OpenAI 原生 `reasoning_effort` 只到 `high`，如果上游严格校验，`xhigh`/`max` 两档会 400 → 靠 `think_fields_rejected` 的降级兜住。**这是可接受的实现，但要在日志里能看出"降级发生了几次"，否则线上会静默少两档。**

---

# F. 未知清单（必须实测或问官方才能定）

| # | 未知项 | 影响 | 建议验证方式 |
| - | - | - | - |
| U1 | `/v1/chat/completions` 是否接受并透传 `reasoning_effort` | 决定 D3–D5 的发送策略是否成立 | 拿一个 gpt-5 模型发 `reasoning_effort:"high"`，看 200 还是 400；再看响应 `usage` 有没有 reasoning_tokens 变化 |
| U2 | Anthropic `thinking.budget_tokens` 的合法范围 | 决定 C.4 映射表 | 发 `budget_tokens:1024` 与极小/极大值，看 400 文案 |
| U3 | webhook 推送体是否带 `{code,data}` 包装 | 决定回调解析 | 起一个公网回调，发一条最小任务 |
| U4 | ~~音频任务查询路径~~ **已关闭**：项目已走 `/v1/music/tasks/{id}?language=zh`（`main.py:22599-22601`），与文档一致；但文档里 `/v1/tasks/{id}` 与 `/v1/music/tasks/{id}` 两套并存，新写代码仍容易混 | 无需再验 | — |
| U5 | `gpt-6.1-terra` 是否真实可调 | 是否进目录 | 调一次 `/v1/chat/completions` |
| U6 | `seedream-4.5`（点）vs `seedream-4-5`（连字符）哪个真 | 用户填错就失败 | 各调一次，看 400 文案 |
| U7 | `GET /v1/models?expand=parameters` 对项目的目标模型覆盖到什么程度 | 决定 O1 值不值 | 用用户 key 拉一次（**本任务没有用户 key，未做**） |
