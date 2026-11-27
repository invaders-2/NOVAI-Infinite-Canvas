# EDITOR-PARAMS-MAP — 模型能力 / 生成参数 → 编辑器 UI 控件 全链路映射

> 只读审计产出。审计对象：`NOVAI-v16`（工作目录 `/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main/NOVAI-v16`）。
> 审计时间：2026-11-25。除本文件外未改动任何代码/构建产物，未 commit / push。
> 结论标注：观察（有 file:line 证据）／推断／未知。凡「未知」一律写明。

---

## 0. 测试基线（本次实测，只跑不改）

### node

命令：`node tests/run-all.js`
结果：**208 / 213 通过，5 个失败**（全量耗时约 9 分钟）。

| 失败用例 | 失败断言（证据） | 与本链路关系 |
|---|---|---|
| `tests/test_beat_popup_thumbnails.js` | 缩略图尺寸断言 5 条 ✗（上下文胶囊 17px / 消息缩略图 30px / AgentPanel 无裸 img / 时间线片段封面） | 无关（缩略图实现） |
| `tests/test_canvas_assistant_glass_addmenu.js:35` | AssertionError: bridge 缓存版本跟随 assistant-ui.js mtime | 无关（缓存版本号） |
| `tests/test_canvas_carousel_layout.js` | `.cl-in` 宽度 / 内边距 / `.wel inert` 三条 ✗ | 无关（首页布局） |
| `tests/test_novai_canvas_lightbox_compare.js:100` | AssertionError: 左上返回钮（.lb-back / data-lb=back） | 无关（灯箱） |
| `tests/test_shell_sidebar_gear_align.js` | `.side-pill` 收起态 padding/gap 共 9 条 ✗ | 无关（侧栏样式） |

结论：node 基线**不是全绿**，但 5 个红灯全部是 UI 静态断言，不涉及模型能力/参数链路。

### pytest

- 仓库根目录没有 `pytest.ini` / `setup.cfg` / `pyproject.toml` / `tox.ini`，`tests/` 下有 `conftest.py`（会 import `main`）。
- `python3 -m pytest -q`（仓库根）：**24 个 collection error，interrupted，0 passed**。
  - 其中 13 条来自 _claude_backup/**、_to_delete/** 等历史目录（例如 `_to_delete/skt/mem_test.py`）。
  - 其余 11 条形如 AttributeError: module 'main' has no attribute ...（tests/test_agent_*.py、tests/test_model_caps_nmax_modes.py、tests/test_skills_manage.py）——根因是那些历史目录里的同名 main 模块先被放进 sys.path，污染了 main 的解析；**单独跑这些文件是通过的**（见下）。
- `python3 -m pytest tests -q --co`：**3545 个用例，0 error，2.18s** ——说明 tests/ 本身可以正常收集。
- `python3 -m pytest tests -q` 全量跑：**超过 15 分钟未结束**，已主动中止（job_kill），因此「全量 pytest 是否全绿」= **未知**；卡住的具体用例也**未知**。
- 与本链路直接相关的 9 个文件单独跑（test_apimart_model_caps.py、test_model_caps_api.py、test_model_caps_nmax_modes.py、test_model_caps_builtin.py、test_direct_chain_model_caps.py、test_apimart_protocol_alignment.py、test_provider_size_overrides.py、test_apimart_video_params.py、test_apimart_size_resolution.py）：
  **141 passed / 7 failed**（1.55s）。
  - test_model_caps_api.py 6 条：test_apimart_video_caps_expand_duration_range、test_cache_reads_providers_once_until_invalidated、test_item_shape_is_fixed、test_models_without_authoritative_caps_are_absent、test_model_without_caps_is_untouched、test_generate_image_validator_converges
  - test_apimart_size_resolution.py 1 条：test_dispatch_sends_ratio_and_tier
  - 已核实其中一条的具体原因（**tests/test_model_caps_api.py:65**）：接口下发了 ref_max，但测试白名单 OPTIONAL_KEYS 未包含它 →
    `{'kind','durations','provider','n_max','ref_max','max_long_edge','min_pixels','model','max_pixels','qualities','resolutions','ratios'} not less than or equal to {…无 ref_max…}`。
    即**契约字段加了、断言表没跟**，不是链路坏了。
  - 其余 6 条同类性质的判断是**推断**（未逐条核实），按「契约/断言漂移」理解，不能当成「功能已坏」的证据。

---

## 1. 一句话结论

链路共 **4 层**：后端能力表（main.py 两个大 dict）→ 归一函数 + `GET /api/model-caps` → 前端 `modelCaps.ts` 翻译成 `ModelSpec` → `GenPanel.tsx` 的控件。
**单一事实来源是 main.py 的 `APIMART_IMAGE_MODEL_CAPS` / `APIMART_VIDEO_MODEL_CAPS`（+ 各供应商族函数）**；
`server/protocols/*` 只放元数据与「增量更新包」，**不放逐模型能力**；
旧画布（`static/js/smart-canvas.js`、`static/js/canvas.js`）各有一份**完全独立的硬编码能力表**，不读 /api/model-caps，因此任何模型参数改动都必须**手工同步两份**。

---

## 2. 链路分层（含每层入口）

```
[L1 后端能力表]  main.py:16192 APIMART_IMAGE_MODEL_CAPS / main.py:28641 APIMART_VIDEO_MODEL_CAPS
      │          （族函数：gemini_* / AGNES_* / VOLCENGINE_* / JIMENG_* + volcengine_video_* 等）
      │  覆盖层：provider.model_caps_overrides（main.py:16464-16493），来自 protocol_updates.json
      ▼
[L2 归一 + 下发]  model_caps_for(main.py:25004) → _caps_payload(main.py:24856) → GET /api/model-caps(main.py:25607)
      │          并行旁路：GET /api/ai/size-policy(main.py:38953)、GET /api/ai/descriptor(main.py:38925)
      ▼
[L3 前端翻译]    novai-canvas-ui/src/novaiBackend.ts:362 loadCaps → modelCaps.ts:140 modelCapsUi → model.ts:532 specFor
      │
      ▼
[L4 控件渲染]    GenPanel.tsx（底栏摘要 + 参数弹层）/ DurationSlider.tsx / MjPop 等
```

同一份能力还有**三个旁路消费者**（改参数时容易漏）：

1. **生成时收敛**（不给 UI）：apimart_image_resolution_for_model(main.py:16156)、apimart_quality_for_model(16591)、apimart_thinking_mode_value(16607)、apimart_output_format_fields(16525)、direct_image_size_caps(25171)、apimart_video_body_params(29170)、apimart_video_duration_value(29069)。
2. **旧画布**：只吃 /api/ai/size-policy（static/js/shared/size-policy.js:274），外加自己的 MODEL_CAPABILITIES。
3. **PS 插件 / 第三方**：GET /api/image-params（main.py:28393）返回**通用**字段表 IMAGE_PARAM_RATIOS(28340) / IMAGE_PARAM_RESOLUTIONS(28350)，与逐模型能力**无关**（当前唯一消费者：tools/photoshop-asset-connector/js/generate.js:177）。

---

## 3. L1 后端能力表

### 3.1 图片：APIMART_IMAGE_MODEL_CAPS

- 定义：**main.py:16192** 起，到 **main.py:16449** 结束。
- 结构：dict[归一化能力键] -> dict，键是**模型名归一化后的子串**（re.sub(r"[^a-z0-9]+","-",name)，main.py:16451-16452）。匹配规则是**最长 key 优先的子串命中**（main.py:16458-16461）；注释明确这是有意的家族匹配（main.py:16176-16184）。
- 条目字段（出现过的全部）：

| 字段 | 含义 | 消费点 |
|---|---|---|
| ratios | 允许画幅 | 下发 main.py:25034 / 收敛 main.py:25181+ |
| resolutions | 分辨率档（1K/2K/4K/1.5K/0.5K/768SQ/3K） | main.py:25035、16167、16144 |
| n_max | 单次请求最多几张 | main.py:25036、25126（拆批）、25566（收敛） |
| mask_url / base64_refs / ref_max / refs_none | 参考图与蒙版能力 | main.py:25043（只下发 ref_max） |
| qualities | 质量档枚举 | main.py:16591-16604 |
| thinking_mode | 先思考开关（wan2.7 族） | main.py:16607-16616 |
| native_background | 原生透明背景 | main.py:15796-15801 |
| output_formats | png/jpeg/webp/gif/svg | main.py:16511-16540 |
| gif_frames | GIF 帧数/时长 | main.py:24902-24912 |
| svg: {model, efforts} | SVG 走文本模型 | main.py:16543-16553 |
| sizes | 另一种档位写法（midjourney 只给 sizes=["2K"]） | main.py:24913-24914 |
| batch | 张数候选（仅 midjourney 用；main.py:16426-16427 说明给了 n_max 就不再声明 batch） | main.py:24915-24916 |
| mj: {versions, speeds, hd, video} | Midjourney 专属 | main.py:24917-24922（**只转发 versions/speeds/hd，video 被丢弃**） |
| exact_size / max_long_edge / max_pixels / min_pixels | 精确像素模型 | main.py:24870-24876、25049-25051 |
| fixed_resolution / send_resolution / size_field / response_version / idempotency / official_fallback / quality_levels_documented / quality_text_only | 请求组装细节 | 生成侧读取（如 main.py:16160、25033） |

- 相关常量（同属「图片参数真值源」）：

| 常量 | 位置 | 作用 |
|---|---|---|
| APIMART_ASPECT_RATIOS | main.py:16047 | 21 种画幅，比例→标签 |
| APIMART_OFFICIAL_PIXELS | main.py:16055 | 官方「比例×档位→像素」表（1k/2k/4k） |
| APIMART_RESOLUTION_LEVELS | main.py:16072 | ("1k","2k","4k") |
| APIMART_IMAGE_RESOLUTION_RANK | main.py:16636 | 档位排序（0.5K…4K） |
| APIMART_SPECIAL_RESOLUTION_PIXELS | main.py:16139 | 特殊档位像素（0.5K/768SQ/1.5K/3K） |
| IMAGE_OUTPUT_FORMAT_VALUES | main.py:16497 | 输出格式白名单 |

### 3.2 视频：APIMART_VIDEO_MODEL_CAPS

- 定义：**main.py:28641** 起，到 **main.py:29038** 结束；main.py:29042 追加别名 APIMART_VIDEO_MODEL_CAPS["omni-flash-ext"] = APIMART_VIDEO_MODEL_CAPS["gemini-omni-1-1-flash-ext"]。
- 结构：同图片，键为归一化模型名子串，最长 key 优先（main.py:29053-29060）。
- 条目字段：

| 字段 | 含义 | 消费点 |
|---|---|---|
| ratios + ratio_key | 画幅枚举 + 上游字段名（size / aspect_ratio / None） | main.py:29089、29170-29188 |
| resolutions + resolution_key | 档位枚举 + 字段名（resolution / mode） | 同上；kling 特例 main.py:29190-29200 |
| resolution_aliases | 旧值→官方值（720p→768P 等） | 生成侧 resolution_value |
| duration=(min,max) 或 durations=[...] | 时长 | _caps_durations main.py:24753-24779、29069 |
| generate_audio + audio_field + audio_default_on | 音频开关能力 | main.py:24986-25001 |
| watermark / seed / image_with_roles / video_urls / audio_urls / ref_max / video_ref_max / audio_ref_max | 文件类能力与参考上限 | 3 个 ref_max 下发 25092-25094 |
| modes（可写死） | 生成方式白名单 | main.py:24941-24983 |
| omni_task_type / ratio_follows_first_frame / prompt_only | 上游分支标记 | main.py:25087-25088 |

- 相关常量：APIMART_VIDEO_RESOLUTION_RANK（main.py:29044）、APIMART_BUILTIN_MODEL_IDS（main.py:25225）。

### 3.3 音频 / 文本：**没有逐模型能力表**

- 音频侧只有**请求级常量**：APIMART_MUSIC_*、APIMART_AUDIO_EXTS、APIMART_TTS_DEFAULT_MODEL、APIMART_TTS_MAX_INPUT、APIMART_TTS_VOICES、APIMART_TTS_FORMATS、APIMART_TTS_SPEED_MIN/MAX（main.py:27387-27400）；校验 apimart_tts_voice/apimart_tts_format/apimart_tts_speed（main.py:27534-27575）；组装 apimart_audio_submit_body(27403)、apimart_tts_submit_body(27568)。
- 端点：POST /api/canvas-audio（main.py:27772，音乐）、POST /api/canvas-tts（main.py:27861，配音）。
- model_caps_for() 对 kind="audio" **直接返回 None**（main.py:25016/25122-25123 只有 image/video 分支），所以 /api/model-caps 里**永远没有音频条目** → 音频编辑器的「类型 / 时长」只能靠前端硬编码（见 6.3）。
- 文本侧能力是「思考档位」，真值源在 server/protocols/thinking.py（见 4.6），**不在 main.py**。

### 3.4 能力表 → /api/model-caps 的翻译

| 步骤 | 位置 | 说明 |
|---|---|---|
| 1. 逐模型取表 | model_caps_for(provider, model, kind) main.py:25004 | 按 provider 协议分派：agnes / gemini / apimart / volcengine / jimeng；apimart 走 25028-25052(image)、25082-25105(video) |
| 2. 拼 caps 条目 | _caps_payload(...) main.py:24856-24925 | **字段缺失 = 后端不掌握**（main.py:24861-24863）；空数组是「明确没有」 |
| 3. 列条目 | _model_caps_items main.py:25346 | 只列 provider 已登记的 image_models/video_models；include_builtin=1 再补能力表里有但没登记的（25318-25343、25391-25394） |
| 4. 缓存 | _model_caps_payload main.py:25398 | TTL 120s(24712)，指纹=providers 文件 mtime/大小 + 每个平台 model_caps_overrides(24725-24741) |
| 5. 端点 | GET /api/model-caps main.py:25607-25614 | 返回 {"items":[{provider, model, kind, ratios, resolutions, durations, qualities, n_max, ref_max, ...}], "generated_at":int}；?include_builtin=1 多出 builtin:true 条目 |

- 视频 caps 的 modes 是**推导**的：apimart_video_modes（main.py:24941-24983）——能力表有 modes 就直接用，否则按 image_with_roles / video_urls / 名字含 videoedit / 时长下限推。
- 视频 audio 标记来自 apimart_video_audio_field（main.py:24986-25001）——只认 generate_audio / audio 两个真实字段名。

### 3.5 能力表的全部消费点（改表前必须过的清单）

| 消费点 | 位置 | 用途 |
|---|---|---|
| 透明背景判定 | main.py:15796-15801 | 决定是否发 background=transparent |
| 单图生成主链 | main.py:18948 _generate_ai_image_unlimited（caps 19095、档位 19126、质量 19159、先思考 19163、输出格式 19147） | 直发/助手链路 |
| 在线生图 | main.py:26998 build_online_image_result（输出格式 27013）；路由 main.py:27114 | POST /api/online-image |
| 画布图片任务 | main.py:28185 | POST /api/canvas-image-tasks |
| 画布视频任务 | main.py:29721 POST /api/canvas-video → main.py:29883 _canvas_video_run_unlimited（caps 30109） | 画布视频 |
| 尺寸收敛（直发） | main.py:25171 direct_image_size_caps | 提交前把 size 钳进 caps |
| 拆批 | main.py:25126 direct_image_request_batches | 按 n_max 拆请求 |
| 视频入参收敛 | main.py:29170 apimart_video_body_params（duration 29069、kling 29190） | 上游字段映射 |
| 前端下发 | main.py:25398 / 25607 | /api/model-caps |
| agent 工具 | main.py:46107 附近（批量节点用同一份 caps） | 批量生成上限 |

### 3.6 覆盖层：provider.model_caps_overrides

- 写入：协议更新包 apply 时写进 data/api_providers.json（main.py:25780-25783），字段白名单 server/protocols/protocol_updates.py:52-60。
- 读取/合并：_provider_caps_overrides(16464) → _caps_override_for(16471) → _merge_caps_table(16483) → apimart_image_caps_for(16491) / apimart_video_caps_for(16587)。**字段级覆盖内置表**。
- 归一（含丢掉旧 midjourney 契约）：main.py:3084-3106；is_stale_midjourney_image_caps 见 protocol_updates.py:140-156。
- 视频覆盖优先级最高：main.py:25096-25104 明确「modes/durations/ratios/resolutions/n_max 直接替换内置推导值」。
  **这是最容易踩的坑**：代码表加了一档 4k，但用户数据里的旧覆盖没删，前端仍然看不到。

---

## 4. L2 协议层（server/protocols/）

### 4.1 model_protocols.json —— 「模型协议」元数据，**不含逐模型能力**

- 格式头：novai-model-protocols/v1（server/protocols/model_protocols.json:2），protocols 数组 18 条（:3 起）。
- 每条结构：id / label / version / kind="model" / capabilities[] / match{provider_ids|provider_protocols|model_patterns} / inputs{images,videos,audios,files} / defaults / limits / param_engine / docs。
- 与本链路相关的两条：
  - apimart-image（**:246**）：capabilities ["image.generate","image.edit"]，defaults {size:"1024x1024",quality:"auto",n:1}，limits {n:{min:1,max:4}}。
  - apimart-video（**:310**）：capabilities ["video.generate","video.text_to_video","video.image_to_video","video.first_last_frame","video.multi_reference"]，defaults {duration:5,aspect_ratio:"16:9"}，limits {duration:{min:1,max:15}}。
- 另有 4 条带 size 块的尺寸族条目（**唯一**落到具体取值的块）：lovart-gpt-image、lovart-image、gpt-image-2-family（**:1072**）、gpt-image-1-family → 被 registry.size_policy_* 消费。
- 谁读：server/protocols/registry.py；谁下发：GET /api/ai/protocols（main.py:38968）与 /api/ai/descriptor（main.py:38925）。

> 关键判断：**它不是模型能力的单一事实来源**。对 APIMart 只声明「这族能做 image.generate / video.generate」，不声明「哪个模型支持 4k / 几秒 / 哪些比例」。把这些写进这里不会影响任何编辑器控件。

### 4.2 provider_protocols.json —— 供应商接入方式

- 格式头 novai-provider-protocols/v1，7 条：openai(:5) / apimart(**:24**) / runninghub(:42) / volcengine(:60) / codex(:78) / gemini-cli(:94) / lovart(:110)。
- 每条：auth{type,...}（bearer|api_key_header|google_api_key|none，registry.py:52）、models_endpoint、categories、docs。
- 用途：鉴权方式 + 模型列表端点 + 分类；被 registry.provider_protocol()(registry.py:139) 与 resolve_model_protocol(177) 用于「按供应商协议回退匹配」。

### 4.3 protocol_updates.json —— **唯一能在部署后改前端参数的增量包**

- 格式头 novai-protocol-updates/v1；updates 数组 5 条，全部是 apimart（v1 :6 / 2026-11-06、v2 :59、v3 :542 / 2026-11-11、v4 :637 / 2026-11-13、v5 :786 / 2026-11-18）。

| 版本 | new_models | model_caps 条数 | parameter_changes 条数 |
|---|---|---|---|
| v1 | image 4 / video 1 | 0 | 0 |
| v2 | — | 10 | 16 |
| v3 | image 1 | 1 | 6 |
| v4 | image 2 / video 8 | 0 | 10 |
| v5 | chat 12 / video 1 | 0 | 8 |

- 每条更新可带：new_models{chat,image,video,audio}、protocol_changes[{field,from,to,note}]、model_caps[{model,kind,caps}]、parameter_changes[{model,field,from,to,note}]（protocol_updates.py:198-240）。
- caps 字段白名单（protocol_updates.py:52-60）：列表 ratios/resolutions/qualities/modes/output_formats/sizes；整型列表 durations/batch；整型 n_max/max_long_edge/max_pixels/min_pixels/ref_max/video_ref_max/audio_ref_max；布尔 exact_size/mask_url/base64_refs/official_fallback/send_resolution/thinking_mode/prompt_only/native_background；字符串 fixed_resolution/size_field/response_version；加 mj{versions,speeds,hd}（protocol_updates.py:103-109，**同样没有 mj.video**）。

### 4.4 registry.py —— 协议加载/校验 + 尺寸策略（**不承载 HTTP 执行**）

- 职责声明：registry.py:3-27（「只承载元数据…不承载 HTTP 执行」）。
- 文件与格式：registry.py:41-47；校验 _validate_protocol :72-94（坏条目只失效不抛异常）；载入缓存 load_protocols :123-136。
- 能力/匹配：_match_score(147-163，精确 id 30 > 协议 20 > 模型名模式 10)、model_protocols_for(166)、resolve_model_protocol(177-208)、capabilities_for(211-218)、list_protocols(221)、manifest(227-236)。
- **尺寸策略**（第二套真值源，只服务图片尺寸，不服务视频）：SIZE_POLICY_FORMAT(245)、size_policy_for(407)、constrain_size(540)、_provider_size_overrides(558)、size_policy_table(647)；入口 GET /api/ai/size-policy（main.py:38953）。

### 4.5 protocol_updates.py —— 更新包的解析与合并

- 文件与格式：protocol_updates.py:39-41；MODEL_KINDS(:42)、CAPS_KINDS=("image","video")(:60)。
- 校验 _validate_update(198-240)；载入分组 load_protocol_updates(243-263)；pending_updates(281-287)；视图 build_updates_view(290-341)；合并 apply_updates(356-419)。
- 合并语义（重要）：
  - 模型：追加到用户列表末尾、去重、保留用户顺序（:375-386）。
  - 协议字段：只覆盖 PROVIDER_OVERRIDABLE_FIELDS（:45-48）且原来就有的字段，其余写 protocol_fields 留档（:387-394）。
  - caps：**字段级合并**，跨版本后版本优先（:396-411）；protocol_version 推进到最大版本（:414）。
  - 已知缺陷被显式兜底：旧 v2 写的 batch=[4]/speeds=["fast"] 会被丢弃（:368-374、:140-156），否则永远回落不到代码表。

### 4.6 thinking.py —— 推理档位（文本模型唯一能力源）

- 档位 canonical 键：THINK_LEVELS=("low","mid","high","xhigh","max")（thinking.py:28），中文标签 :30-32。
- 证据分级 documented / inferred / fixed（:34-36）。
- 各族 wire 映射：OPENAI(:45)、legacy(:50)、GEMINI(:54)、DEEPSEEK(:58)、QWEN(:62)、KIMI(:66)、GLM(:70)…
- 解析链：normalize_think_level(199)、think_model_family(205)、_explicitly_no_think(229)、_resolve_levels(235)、**think_levels_for_model(250)**、think_model_evidence(262)、effort_wire_value(274)、_clamp_level_to_model(297)、think_transport(316)、think_request_fields(335)、think_fields_rejected(361)、strip_think_fields(375)。
- 到前端的路：main.py:2180-2184 只做转发（think_levels_for_model），在 public_provider 里写进 **main.py:3191-3200** → provider.model_caps[模型名]={"think":[...]} → GET /api/config（main.py:24682）。前端读 api_providers[].model_caps[m].think（novaiBackend.ts:717、web/src/pages/home/HomePage.vue:408、web/src/components/EffortSlider.vue:9）。
- 请求侧：main.py:7531-7558（think_request_fields + 被拒后剥离重试）；agent 侧 main.py:42166。

### 4.7 下发端点与返回结构

| 端点 | 位置 | 返回 |
|---|---|---|
| GET /api/ai/protocols?kind=provider 或 model | main.py:38968-38974 | {manifest:{format,protocols:[{id,kind,version}]}, protocols:[...]} |
| GET /api/ai/descriptor?provider_id&model&intent | main.py:38925（构造 38853） | {model:{id,name,protocol_id,profile_id,profile_label}, intent, capabilities[], parameters:{schema_id,source,fields[],defaults,limits} 或 null, limits, inputs, execution{available,mode,reasons}} |
| GET /api/ai/size-policy | main.py:38953 | novai-size-policy/v1 表（图片尺寸） |
| GET /api/providers/protocol-updates | main.py:25748-25750 | {items:[{provider_id,name,current_version,latest_version,available,new_models,protocol_changes,model_caps,parameter_changes,summary,docs_url,released_at}]} |
| POST /api/providers/protocol-update/apply | main.py:25752-25794 | {ok,provider_id,applied:{added_models,protocol_changes,model_caps,parameter_changes},current_version,latest_version,provider} |

> 注意：/api/ai/descriptor 的 parameters.fields 来自 build_image_param_fields（main.py:28356），是**通用**字段（比例 8 个 / 档位 3 个 / 质量 4 档 / 张数 1-4），**不读逐模型 caps**。它只影响协议握手与 PS 插件，不影响主编辑器。

---

## 5. L3 / L4 前端消费点

### 5.1 新编辑器 novai-canvas-ui（智能画布 BEAT，React）

#### 5.1.1 数据入口

- novaiBackend.ts:362-375 loadCaps()：fetch("/api/model-caps")，超时 1000ms(:31)，失败返回空表（best-effort）。
- novaiBackend.ts:382-396 loadBuiltinCaps()：fetch("/api/model-caps?include_builtin=1")，给「清单外/用户自选」模型找参数。
- novaiBackend.ts:619-631 capsItemFor()：真正发请求前再取一次（缓存空表时兜底）。
- novaiBackend.ts:677-768 listModels()：config(/api/config) + caps 合并成 ModelSpec[]；:705-718 是核心拼装（modelCapsUi → mergeCapsReferenceCapability → specFor）；:744-755 把「caps 有规格但没登记」的模型加成候选（unlisted:true）；:756-763 用户自选模型（extra:true）。

#### 5.1.2 modelCaps.ts —— 契约字段 → ModelSpec.ui 的翻译器（只翻译，不编能力）

| 函数/区段 | 行 | 作用 |
|---|---|---|
| ModelCapsItem 类型 | 10-51 | 后端契约字段清单（含 ref_max/video_ref_max/audio_ref_max、prompt_only、audio、mj、builtin） |
| clampImageSize | 62-83 | 按 max_long_edge/max_pixels/min_pixels 等比缩（与后端 normalize_gpt_image_2_size 同口径） |
| normalizeGifFrames | 89-103 | GIF 帧参数兜底 2–16 / 9 / 200 |
| normalizeMjSpec | 106-111 | **只收 versions/speeds/hd**（mj.video 到此为止） |
| normalizeCapsRatio | 117-119 | auto/adaptive/自动/自适应 → "自适应" |
| resolutions | 125-128 | 视频档位转小写、图片档位转大写 |
| normalizeCapsModes | 130-137 | 接口值 → VMODES 中文名 |
| **modelCapsUi** | **140-203** | 全量映射：promptOnly/mj/ratios/maxRefs；图片 sizes+batch+qualities+thinkingMode+nativeBackground+outputFormats+gifFrames；视频 res+durs+modes+audio |
| mergeCapsReferenceCapability | 210-217 | caps 不声明参考图能力时沿用官方/预设（不让权威参数误关入口） |
| modelCapsKey / indexModelCaps | 219-235 | provider::model 索引 |

#### 5.1.3 model.ts —— ModelSpec 与参数收敛

| 内容 | 行 | 说明 |
|---|---|---|
| ImageParams | 24 | ratio/size/sourceSize/count/style/camera/mj/quality/thinking/outputFormat/frameCount/frameDuration/background |
| VideoParams | 26 | mode/ratio/res/dur/sound/times/multiShot/genMode/turbo/**draft** |
| TextParams / AudioParams | 27 / 28 | 文本 think；音频 kind/dur |
| ModelSpec | 96-144 | ui 落地后的规格（含 specSource: spec 或 guess） |
| VMODES | 147-156 | 8 种生成方式：中文名 ↔ 接口值（前后端共用词表） |
| THINK_LEVEL_KEYS / QUALITY_LABEL / OUTPUT_FORMAT_LABEL / GIF_FRAME_FALLBACK | 314 / 348 / 413 / 440 | 前端枚举与标签 |
| **PRESETS** | **478-492** | **按模型名正则的硬编码兜底能力表**（banana/seedream/gpt-image/flux/mj/recraft/sdxl/seedance/veo/kling/hailuo…） |
| **DEFAULTS** | **493-500** | 每类通用兜底（image ratios/sizes/batch；video modes/ratios/res/durs；audio kinds/adurs） |
| specFor | 532-565 | 有 ui 就只认 ui（可选能力缺省=不支持），没 ui 才套 PRESETS |
| defaultParams | 595-608 | 新节点默认值（ratio 优先 3:4、size 优先 2K/1K、video res 优先 720p） |
| clampParams | 615-686 | 换模型时收敛（ratio/size/count/mj/quality/thinking/outputFormat/frame/background；视频 ratio/res/dur/sound/times/mode） |
| resRange / draftRes | 921-927 | 草稿模式用的最低/最高档 |

#### 5.1.4 真正渲染控件的组件（novai-canvas-ui/src/canvas/canvas-next/ui/）

| 控件 | 组件 : 函数 | 行 | 选项来源 |
|---|---|---|---|
| 视频底栏摘要（方式·比例·分辨率·时长） | GenPanel.tsx 视频分支 | 381-394 | m.modes / m.ratios / m.res / m.durs |
| 视频音频开关 | GenPanel.tsx | 396（底栏）、939（弹层） | m.audio |
| 视频条数 | GenPanel.tsx | 399（按钮，m.times.length<2 时禁用）、926 | m.times（**当前恒为 [1]**，见 6.2） |
| 视频参数总弹层 | VideoSetPop | 1116-1139 | 方式 1124 / 分辨率+草稿 1125-1129 / 比例 1130-1133 / 时长 1134-1136 / 音频 1137 |
| 视频分辨率 + 草稿 | DraftRow | 969-982 | resRange(m)（档位差 ≥2 才可开） |
| 视频时长 | DurationSlider.tsx 1-40（复用 EffortSlider） | — | m.durs（-1 = 自动） |
| 视频生成方式（独立弹层） | GenPanel.tsx k==="mode" | 927 | VMODES 全 8 项，mm.modes 决定可用 |
| 视频比例（独立弹层） | VRatioPop / videoRatioChoices | 1144-1170 | m.ratios |
| 图片比例+尺寸+背景+输出格式 | RatioPop | 1038-1079 | m.ratios 1065-1069、m.sizes 1056-1057、m.nativeBackground 1058-1064、outputFormatOptions(m) 1071-1076 |
| 图片张数 | GenPanel.tsx k==="count" | 919-925 | **硬编码 [4,2,1]**，mm.batch 只用来 disable |
| 图片质量 | GenPanel.tsx 419-422 / qualityChoices | 879-884 | m.qualities |
| 先思考（图片） | GenPanel.tsx 423-426 / 905-914 | — | m.thinkingMode |
| Midjourney 参数 | MjPop | 1082-1107 | m.mj.{versions,speeds,hd} + 硬编码 MJ_STYLIZE=[100..1000](1081) |
| GIF 帧 | GifFrameRows | 1019-1036 | gifFrameSpec(m) |
| 文本思考档位 | GenPanel.tsx 448（底栏）/ 861-878（弹层） | — | thinkLevelsFor(m) ← spec.think |
| 文本输出模式（文本/表格/分镜） | GenPanel.tsx 942 | — | **硬编码 OUTPUT_MODES** |
| 音频类型 / 时长 | GenPanel.tsx 409（底栏）/ 940-941（弹层） | — | m.kinds / m.adurs ← DEFAULTS（**硬编码**） |

#### 5.1.5 请求体（参数真正发出去的地方）

| 类型 | 位置 | 发的字段 |
|---|---|---|
| 图片 | novaiBackend.ts:289-330 createImageTask | size(313)、ratio:auto(315)、n(**316 硬钳 ≤4**)、quality(318)、thinking_mode(319)、output_format(320)、background(321)、GIF 帧(322)、MJ 四件套(323-326) → POST /api/canvas-image-tasks |
| 视频 | novaiBackend.ts:837-851 | duration(841)、aspect_ratio(842)、resolution(843，仅当 caps 声明档位)、images(844，含 role)、videos(845)、audios(846)、generate_audio(847) → POST /api/canvas-video |
| 音频 | novaiBackend.ts:868-878 | TTS：voice:"alloy"、response_format:"wav" **硬编码**(873)；音乐：custom、instrumental:false、duration(874) |

> **观察（重要）**：视频请求体**不含** mode / draft / turbo / genMode。后端 CanvasVideoRequest 有 mode 字段（main.py:5639-5640），但前端从不发；draftRes()（model.ts:927）在 novaiBackend.ts 里**没有被 import/调用**（imports 见 :4），即「草稿模式」只影响底栏显示，不影响真正发出的 res。

### 5.2 web/（NOVAI 2.0 新前端，Vue 3）—— API 设置页

- 目录：web/src/shell/settings/api/（ApiSettingsPanel.vue + parts/ + core/ + kit/）。
- **这里没有「逐模型能力展示/编辑」**（在 web/src 里 grep /api/model-caps、model_caps_overrides 均无命中）。「设置 → API」与参数相关的只有三件事：

| 功能 | 位置 | 说明 |
|---|---|---|
| 模型清单编辑（增删模型 ID、单模型协议覆盖、视频厂商标签） | parts/ModelBlock.vue:17-38（行数据）、43-50（新增） | 改的是 image_models / chat_models / video_models / audio_models；**只改清单，不改能力** |
| 配置/协议更新弹窗（展示 new_models / protocol_changes / model_caps / parameter_changes，一键 apply） | parts/ProtocolUpdateDialog.vue:28-33（分组）、46-57（字段中文名）、58-83（参数分组） | 数据来自 core/protocolUpdates.js:7-8 的两个端点 |
| 「能力覆盖」（provider.size_overrides，**只对生图模型生效**） | parts/SizeOverridesCard.vue + core/sizeOverrides.js:4-11（词表）、92-103（模型下拉） | 保存后 core/sizePolicySync.js:4-6 重新拉 /api/ai/size-policy |

- 能力覆盖的词表来自公共文件 web/src/lib/sizeCatalog.js:4-20（15 个官方比例）+ :22-27（4 个 Gemini 专用比例）+ :30（6 个档位）。
- 尺寸策略运行时：web/src/lib/sizePolicy.js:1（真值源声明）→ :270（fetch('/api/ai/size-policy')）。
- 文本思考档位在首页/对话：web/src/pages/home/HomePage.vue:352、:408，组件 web/src/components/EffortSlider.vue:9。

> 结论：**设置页不是参数编辑入口**。用户期待的「在设置里改模型参数」只有两种落点：协议更新弹窗（走 protocol_updates.json）或尺寸覆盖（只影响生图尺寸，不影响视频）。

### 5.3 旧壳 / 旧画布（static/，手写、无构建）

| 文件 | 性质 | 与本链路的关系 |
|---|---|---|
| static/js/smart-canvas.js（2.35MB） | **手写源码**，旧智能画布 | **自带硬编码能力表** MODEL_CAPABILITIES(:525-611) + MODEL_TIER_PIXELS(:615-638) + modelCapabilityFor(:639-647) + 视频辅助(:660-678)。**完全不读 /api/model-caps**（grep 0 命中）。只吃 /api/ai/size-policy 做档位覆盖(:681) |
| static/js/canvas.js（810KB） | 手写源码，传统画布 | **同一份表再抄一遍**：MODEL_CAPABILITIES(:879-…) / modelCapabilityFor(:995) / 覆盖合并(:1016)。注释明确「两套画布各持一份同内容表」（smart-canvas.js:519），并有测试强制一致 |
| static/js/shared/size-policy.js | 手写公共模块 | :1 声明尺寸真值源在 /api/ai/size-policy；:274 发请求 |
| static/js/api-settings.js（267KB）+ static/api-settings.html（118KB） | 手写，旧设置页 | **没有任何能力展示/编辑**：/api/model-caps 0 命中、protocol-update 0 命中、size_overrides 仅 :4426 一处**原样透传**（无 UI）。只有 provider/模型清单编辑（API_PROTOCOLS :159、默认模型 :232-262） |
| static/js/smart-canvas.js:4806-4930 | 旧画布视频参数面板 | 比例/清晰度/时长/生成音频/数量合并控件；弹层入口登记在 :7471-7481 |
| static/js/smart-canvas.js:5651 | 音频 | 「目标时长（秒）」输入，纯前端范围 0–360 |

### 5.4 构建产物 vs 源码（**不能直接改产物**）

| 产物目录 | 源码 | 构建命令 | 输出配置 |
|---|---|---|---|
| static/novai-canvas/（canvas.js 2.87MB、canvas.css 1.03MB、chunks/、assets/） | novai-canvas-ui/ | cd novai-canvas-ui && npm run build | novai-canvas-ui/vite.config.ts:18 → ../static/novai-canvas |
| static/v2/（index.html + assets/） | web/ | cd web && npm run build | web/vite.config.js:16 → ../static/v2 |
| static/canvas-assistant/（assistant-ui.js/css） | canvas-ui/ | cd canvas-ui && npm run build | canvas-ui/vite.config.ts:35 → ../static/canvas-assistant |

- 无构建步骤、可直接改的源码：static/*.html、static/js/*.js（含 smart-canvas.js、canvas.js、api-settings.js）、static/css/*.css。
- 改完产物必须跑 python3 tools/refresh_static_versions.py --write 刷 ?v=（AGENTS.md 约定）。

---

## 6. 当前编辑器支持度表

> 「选项从哪来」中：**caps** = /api/model-caps；**硬编码** = 源码常量；**未接线** = 字段存在但没被发送。

### 6.1 图片（image）

| 控件 | 可选项从哪来 | 证据 | 新增一个选项要改哪 |
|---|---|---|---|
| 模型下拉 | provider.image_models（+ caps 候选 / 用户自选） | novaiBackend.ts:693-720、744-763 | 用户数据 data/api_providers.json，或 APIMART_BUILTIN_MODEL_IDS(main.py:25225) |
| 比例 | caps.ratios | modelCaps.ts:149 → GenPanel.tsx:1065-1069 | 能力表 ratios 加值（**自动生效**） |
| 分辨率档 | caps.resolutions（转大写） | modelCaps.ts:160-162 → GenPanel.tsx:1056-1057 | 能力表 resolutions 加值；若新档位是新像素档，补 APIMART_SPECIAL_RESOLUTION_PIXELS(16139)/APIMART_IMAGE_RESOLUTION_RANK(16636) |
| 张数 | caps.n_max 展开成 batch | modelCaps.ts:163-175 | **只改 caps 不够**：GenPanel.tsx:920 只给 [4,2,1]，novaiBackend.ts:316 硬钳 ≤4 → 三处都要改 |
| 质量 | caps.qualities | modelCaps.ts:182 → GenPanel.tsx:419-422 | 能力表 qualities；新标签要加 QUALITY_LABEL(model.ts:348) |
| 先思考 | caps.thinking_mode | modelCaps.ts:183 | 能力表布尔位 |
| 输出格式 | caps.output_formats | modelCaps.ts:187-191 → GenPanel.tsx:1071-1076 | 能力表 + OUTPUT_FORMAT_LABEL(model.ts:413)、IMAGE_OUTPUT_FORMAT_VALUES(main.py:16497)、image_output_extension(16556) |
| GIF 帧 | caps.gif_frames | modelCaps.ts:89-103、190 | 能力表 gif_frames |
| 透明背景 | caps.native_background | modelCaps.ts:185 → GenPanel.tsx:1058-1064 | _caps_payload 已通用(24887-24889)，只加 caps 键即可 |
| MJ 版本/速度/HD | caps.mj | modelCaps.ts:106-111、146 | _caps_payload 的 mj 白名单(24917-24922) 只 3 个字段 |
| 参考图上限 | caps.ref_max 优先于 max_refs | modelCaps.ts:154-158 | 能力表 ref_max（下发已通用 24893-24899） |
| 精确像素上限 | caps.max_long_edge/max_pixels/min_pixels | modelCaps.ts:62-83 | 能力表三键（下发 24870-24876） |

### 6.2 视频（video）

| 控件 | 可选项从哪来 | 证据 | 新增一个选项要改哪 |
|---|---|---|---|
| 生成方式 | caps.modes（或后端推导） | main.py:24941-24983 → modelCaps.ts:198 → GenPanel.tsx:927、1124 | 能力表写 modes 或改推导；VIDEO_MODE_VALUES(main.py:24821) 加值 + VMODES(model.ts:147) |
| 分辨率 | caps.resolutions | modelCaps.ts:193 → GenPanel.tsx:1125-1127 | 能力表加值；上游字段名不同则改 resolution_key / apimart_video_body_params(29170) |
| 草稿开关 | **前端推导** resRange(m)（档位差 ≥2） | model.ts:921-925 → GenPanel.tsx:969-982 | 后端只有注释（main.py:28680-28681「项目未提供草稿入口」），**没有字段** |
| 比例 | caps.ratios | modelCaps.ts:149 → GenPanel.tsx:1130-1133 | 能力表加值（ratio_key 决定上游字段） |
| 时长 | caps.durations / duration 区间展开 | main.py:24753-24779 → modelCaps.ts:194-197 → DurationSlider.tsx | 能力表加值（-1 = 自动） |
| 音频开关 | caps.audio（来自 audio_field） | main.py:24986-25001 → modelCaps.ts:200 → GenPanel.tsx:396、939、1137 | 能力表加 audio_field（**只认 generate_audio / audio**） |
| 条数 | **硬编码**（caps 无 times 字段） | model.ts:545（times: prov.times ?? [1]） | 恒为 [1]、按钮禁用；要开放需新增 caps 字段 times + `_caps_payload` + modelCapsUi + 后端批处理 |
| 提示词 only | caps.prompt_only | modelCaps.ts:145 | 能力表布尔位 |
| 参考上限 | caps.ref_max / video_ref_max / audio_ref_max | modelCaps.ts:154-158 | 能力表（下发 25092-25094） |

### 6.3 音频（audio）

| 控件 | 可选项从哪来 | 证据 | 新增一个选项要改哪 |
|---|---|---|---|
| 模型下拉 | provider.audio_models | novaiBackend.ts:695-699 | 用户数据 |
| 类型（音乐/配音/音效） | **硬编码** | model.ts:497（DEFAULTS.audio.kinds）、:490-491（PRESETS） | DEFAULTS/PRESETS；/api/model-caps 无音频条目（main.py:25122） |
| 时长 | **硬编码** | model.ts:497（adurs:["自适应","15s","30s"]） | 同上 |
| 音色 voice | **硬编码 "alloy"** | novaiBackend.ts:873 | 前端 + 后端 APIMART_TTS_VOICES(main.py:27396)（后端已有白名单，前端没界面） |
| 音频格式 | **硬编码 "wav"** | novaiBackend.ts:873 | 同上（APIMART_TTS_FORMATS main.py:27397） |
| 语速 | 无界面 | main.py:27399-27400、27534 | 后端已支持，前端未接 |

### 6.4 文本（text）

| 控件 | 可选项从哪来 | 证据 | 新增一个选项要改哪 |
|---|---|---|---|
| 思考档位 | server/protocols/thinking.py → /api/config 的 provider.model_caps[m].think | thinking.py:250 → main.py:3191-3200 → novaiBackend.ts:717 → GenPanel.tsx:448、861-878 | **只改 thinking.py**（main.py 明确「别再往这里加模型名」2178-2179）；THINK_LEVEL_KEYS(model.ts:314) 只在新增 canonical 档位时改 |
| 输出模式 | **硬编码** | GenPanel.tsx:942（OUTPUT_MODES）、model.ts:27 | 前端两处 |
| 联网搜索 | caps 没声明就按名字猜 | model.ts:562 | 无接口 |
| 视觉（读图） | 后端声明 row.vision，或名字猜 | model.ts:561、novaiBackend.ts:718 | — |

---

## 7. 重复 / 冲突来源（决定同步改动的范围）

### 7.1 同一能力存在多份的地方

| # | 位置 | 形态 | 是否权威 |
|---|---|---|---|
| 1 | main.py:16192 APIMART_IMAGE_MODEL_CAPS | 代码表 | ✅ **图片权威** |
| 2 | main.py:28641 APIMART_VIDEO_MODEL_CAPS | 代码表 | ✅ **视频权威** |
| 3 | main.py:25225 APIMART_BUILTIN_MODEL_IDS + 各供应商族函数（volcengine_video_resolutions 24782、volcengine_video_durations 24791、gemini_*、AGNES_*、JIMENG_RATIO_CHOICES） | 代码 | ✅ 各 provider 权威（main.py:24708-24710 自述） |
| 4 | data/api_providers.json → provider.model_caps_overrides（来源 server/protocols/protocol_updates.json） | **用户数据（运行时覆盖）** | ⚠️ 优先级高于代码表（main.py:25096-25104） |
| 5 | novai-canvas-ui/src/canvas/canvas-next/model.ts:478-500 PRESETS/DEFAULTS | 前端硬编码（名字正则） | ❌ 仅当没有 caps 时兜底，面板标「参数按名字推断」 |
| 6 | novai-canvas-ui/src/novaiBackend.ts:33-44 officialImageUi | 前端硬编码（仅 agnes-image-2.x-flash） | ❌ 与 #1 重叠（agnes 不归 APIMart 表管） |
| 7 | static/js/smart-canvas.js:525-611 MODEL_CAPABILITIES | **旧画布硬编码** | ❌ 独立副本 |
| 8 | static/js/canvas.js:879-… MODEL_CAPABILITIES | **第二份旧画布硬编码** | ❌ 独立副本（测试强制与 #7 一致） |
| 9 | server/protocols/model_protocols.json 的 size 块（gpt-image-2-family:1072 等） | 协议元数据 | ⚠️ 只服务 /api/ai/size-policy（图片尺寸），不服务比例/视频档位 |
| 10 | main.py:28340 IMAGE_PARAM_RATIOS / 28350 IMAGE_PARAM_RESOLUTIONS | 代码（通用 schema） | ❌ 只服务 /api/image-params（PS 插件） |
| 11 | web/src/lib/sizeCatalog.js:4-30 | 前端词表（设置页覆盖用） | ❌ 只是「可选值词表」，不是逐模型能力 |
| 12 | novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx:2574 | 前端硬编码（agent 计划卡的视频节点默认） | ❌ 又一份 ratios/res/durs |
| 13 | novai-canvas-ui/src/canvas/canvas-next/timelineModel.ts:353 RESES | 前端常量 | ❌ 导出分辨率（不同概念，勿混） |

### 7.2 已确认的「同一能力不同值」冲突（证据）

| 项目 | 后端代码表 | 旧画布硬编码 | 影响 |
|---|---|---|---|
| seedance-2.5 分辨率 | ("480p","720p","1080p","4k")（main.py:28684） | ['480p','720p','1080p']（smart-canvas.js:527） | **旧画布看不到 4k** |
| veo3.1 时长 | ext 档固定 durations:(8,)（main.py:29024） | durationMin:4, durationMax:8（smart-canvas.js:539-541） | 旧画布可发 4/6 秒 → 上游拒绝（后端另有注释「官方档暂不建表」29021-29022） |
| gpt-image-2.5-ext 比例 | 11 个（main.py:16208） | 10 个（smart-canvas.js:566） | 旧画布少 1 个选项 |
| grok-imagine-2.0 档位 | fixed_resolution:"quality"（main.py:16384）→ 前端 sizes=[]、不发档位（model_caps_for 25033） | resLevels:['quality']（smart-canvas.js:582） | 语义不同（一个发 quality 字段、一个当档位名） |
| kling-v3 档位字段 | resolution_key:"mode"，值 std/pro/4k（main.py:28709） | videoResolutions:['720p','1080p','4k']（smart-canvas.js:538） | 值域不同名；靠 apimart_kling_video_params(29190) 翻译 |
| 图片张数上限 | 能力表最高 n_max=15（seedream-4-0，main.py:16319） | 前端只 4/2/1（GenPanel.tsx:920）+ 请求硬钳 4（novaiBackend.ts:316） | **能力表声明与实际可发不一致（15 → 4）** |
| 草稿模式 | 注释表示「项目未提供入口」（main.py:28681），请求体无 draft（5631-5658） | 前端有 DraftRow 与 draftRes（GenPanel.tsx:969、model.ts:927） | **未接线**：只改显示、不改请求 |
| mj.video | 能力表已写（main.py:16438-16446） | 无 | **下发即被丢**（_caps_payload 24917-24922；protocol_updates.py:103-109 同样没有） |

> 说明：上表中「能力表声明/实际可发」「mj.video 被丢」「草稿不接线」三条已由代码路径直接证实；
> 「旧画布 vs 后端不一致」是**观察到的字面差异**，是否有意（例如旧画布故意保守）**未知**。

---

## 8. 最小改动清单

> 标 ⚠️ 的是「不改也能跑，但不改会不一致」。

### A. 新增一个「图片」模型（能力档位已存在）

1. main.py:16192 APIMART_IMAGE_MODEL_CAPS 加条目（key 用**归一化子串**，注意最长 key 优先；家族共用要写注释说明）。
2. main.py:25225 APIMART_BUILTIN_MODEL_IDS["image"] 加 能力表key -> (上游正式ID, ...)（否则 include_builtin 也不会出现）。
3. 让模型出现在 provider 清单：data/api_providers.json 的 image_models（用户数据），或走 protocol_updates.json 的 new_models。
4. ⚠️ server/protocols/protocol_updates.json：若要给**已装用户**自动补模型，加一版 updates（provider_id/version/new_models/parameter_changes）。
5. ⚠️ 旧画布同步：static/js/smart-canvas.js:525-611 与 static/js/canvas.js:879-… **两份都要加**（比例/档位/透明背景等），且两份内容必须一致（否则 tests/test_canvas_preset_matrix.js:177-184 红）。
6. 测试：tests/test_apimart_model_caps.py、tests/test_model_capabilities.js、tests/test_canvas_preset_matrix.js；若新增 caps 字段，还要更新 tests/test_model_caps_api.py 的 OPTIONAL_KEYS（当前 7 条红就是这个原因）。
7. 无需改前端：/api/model-caps → modelCapsUi → GenPanel 全自动。

### B. 新增一个「视频」模型

1. main.py:28641 APIMART_VIDEO_MODEL_CAPS 加条目（必填：ratios+ratio_key、resolutions+resolution_key、durations 或 duration、generate_audio+audio_field、image_with_roles/video_urls/audio_urls）。
2. main.py:25225 APIMART_BUILTIN_MODEL_IDS["video"] 加 能力表key → 上游正式 ID。
3. 若上游字段名/取值特殊：能力表内 resolution_aliases，或 apimart_video_body_params(29170) / apimart_kling_video_params(29190) / apimart_video_duration_value(29069)。
4. 若生成方式要写死：能力表 modes（值必须在 VIDEO_MODE_VALUES，main.py:24821-24822）。
5. 若上游要 omni 任务类型：omni_task_type(24964) + _canvas_video_run_unlimited(29883 起) 的对应分支。
6. provider 清单 / 协议更新包 / 旧画布两份表 / 测试 —— 同 A 的 3、4、5、6。

### C. 视频分辨率多一档（例：4k）

1. **唯一必改**：对应能力条目的 resolutions 加 "4k"（main.py:286xx）。改完 /api/model-caps、前端下拉、生成侧收敛（apimart_video_resolution_value）同时生效。
2. ⚠️ **先查覆盖**：server/protocols/protocol_updates.json 里是否有该模型的 model_caps.resolutions。有的话必须**同时改更新包**，否则 main.py:25100-25102 会用覆盖值把代码表盖回去。
   注意版本语义：pending_updates 只返回 version > 已应用版本的包（protocol_updates.py:281-287），所以**改旧版本对已应用用户无效**，必须**发新版本**（并让用户点一次「配置更新」）。
3. ⚠️ 旧画布：smart-canvas.js 对应条目 videoResolutions + canvas.js 同一份。
4. ⚠️ 若档位需要新的像素换算（如图片 3K），补 APIMART_SPECIAL_RESOLUTION_PIXELS(16139)、APIMART_IMAGE_RESOLUTION_RANK(16636)、MODEL_CAPS_TIER_RANK(24715)、MODEL_CAPS_VIDEO_RES_RANK(24716-24717)、APIMART_VIDEO_RESOLUTION_RANK(29044)。**视频新档 4k 已在 29046 有映射，纯加枚举即可**。
5. 测试：tests/test_apimart_video_params.py、tests/test_apimart_model_caps.py、tests/test_model_caps_api.py。

### D. 新增「草稿模式」开关（draft）

现状：VideoParams.draft 已存在（model.ts:26），UI 已存在（GenPanel.tsx:969-982），**但请求不带、后端无字段**。最小闭环 6 处：

1. 前端请求体：novaiBackend.ts:837-851 加 draft 透传，且 res 改用 draftRes(params, req.model)（同时把 draftRes 加进 :4 的 import）。
2. 后端 schema：main.py:5631-5658 CanvasVideoRequest 加 draft: bool = False。
3. 后端请求组装：_canvas_video_run_unlimited(main.py:29883) 的 APIMart 分支把 draft 写进 body；草稿回填（draft_task_id）在本仓库**未找到任何实现** → 是否一并实现**未知**（main.py:28680-28681 只记录文档事实）。
4. 能力开关：能力表加布尔位（如 "draft": True）+ _caps_payload(24856) 转发 + protocol_updates.py:56-57 白名单 + modelCaps.ts:10-51/140-203 映射成 ui.draft，让「哪些模型支持草稿」变成后端声明而不是前端猜。
5. 前端收敛：GenPanel.tsx:1128（rr ? DraftRow）改成按 m.draft 显示；model.ts:615-686 clampParams 里切模型时清 draft。
6. 旧画布（smart-canvas.js 视频面板 4806-4930）**没有草稿入口** → 不用改，但要在更新说明里写清「仅新画布支持」。

### E. 新增 mj.video（Midjourney 图生视频参数）

现状：能力表已写（main.py:16438-16446：endpoint / motions / batch / video_types / animate_modes / billing），**但整条链路都没透传**（证据：_caps_payload 24917-24922 只 3 个字段；normalize_caps protocol_updates.py:103-109 同样只 3 个）。最小改动：

1. main.py:24917-24922 _caps_payload 的 mj 增加 video 子对象（endpoint/motions/motion_default/batch/batch_default/video_types/video_type_default/animate_modes/billing）。
2. server/protocols/protocol_updates.py:103-109 normalize_caps 的 mj 白名单同步加 video（否则更新包里的 mj.video 会被丢弃）。
3. novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts:10-51 ModelCapsItem.mj 类型 + :106-111 normalizeMjSpec 返回 video。
4. model.ts ModelSpec.mj(125) + MjParams(23) 加 video 字段；clampParams(615-632) 收敛非法值。
5. GenPanel.tsx:1082-1107 MjPop 加控件（动效 low/high、视频规格 480p/720p、批次 1/2/4、首尾帧模式）。
6. 请求链路：OnlineImageRequest(main.py:4939-4963) 加字段 → novaiBackend.ts:309-330 下发 → build_online_image_result(26998) / _generate_ai_image_unlimited(18948) 透传 → generate_apimart_midjourney_provider_image(38279) 或新分支打 /v1/midjourney/generations/video（endpoint 已在能力表里）。
7. 测试：新增断言 + tests/test_model_caps_api.py 白名单。

---

## 9. 未知与风险

1. **全量 pytest 是否全绿 = 未知**（15 分钟未跑完，已中止）；卡住的具体用例未知。
2. tests/test_model_caps_api.py 其余 6 条失败 / test_apimart_size_resolution.py 1 条失败的具体断言未逐条核实，只核实了 test_item_shape_is_fixed（ref_max 白名单漂移）。
3. 「旧画布能力表与后端不一致」是有意的保守还是历史漂移 = **未知**（见 7.2）。
4. 「视频请求不带 mode」是否有意（改成靠 images[].role 表达生成方式）= **推断为有意**，无注释/文档直接确认。
5. 「草稿模式只改显示不改请求」是半成品还是刻意占位 = **未知**；draft_task_id 回填链路在仓库中**未找到**。
6. 音频/文本**没有权威能力接口**：若产品要求「音频模型也能按后端声明出选项」，需要**新建**一条链路（model_caps_for 增加 audio 分支 + _caps_payload 增加音频字段 + 前端 modelCapsUi audio 分支），不是改现有表能解决的。
7. APIMART_BUILTIN_MODEL_IDS 与能力表是**两处人工维护**：能力表加了 key 但没加映射 → /api/model-caps?include_builtin=1 不会出现（_model_caps_builtin_items main.py:25331-25333 会 continue），且**不会报错**。

---

## 10. 复核命令（只读）

```bash
# 能力表位置
grep -n "^APIMART_IMAGE_MODEL_CAPS\|^APIMART_VIDEO_MODEL_CAPS\|^APIMART_BUILTIN_MODEL_IDS" main.py
# caps 下发端点与拼装
grep -n "@app.get(\"/api/model-caps\")\|def _caps_payload\|def model_caps_for" main.py
# 前端消费
grep -rn "api/model-caps" novai-canvas-ui/src static/js
# 协议层
grep -n "def " server/protocols/registry.py server/protocols/protocol_updates.py server/protocols/thinking.py
# 旧画布两份表
grep -n "const MODEL_CAPABILITIES" static/js/smart-canvas.js static/js/canvas.js
# 基线
node tests/run-all.js
python3 -m pytest -q tests/test_model_caps_api.py tests/test_apimart_model_caps.py
```
