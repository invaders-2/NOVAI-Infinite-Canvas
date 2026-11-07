# 各厂商 OpenAI 兼容接口的「推理强度」参数支持矩阵

> 任务：task-11。调研对象是**模型厂商自己的官方文档**（不是 APIMart），因为 APIMart 的 chat 文档没有任何推理参数（见 REPORT.md 段 C）。
> 结论用于回答：文本节点的「模型强度」入口除了 GPT 系，还能给哪些模型族开、开到几档。
> 抓取方式：`curl -x http://127.0.0.1:7897`，优先取官方 `.md` / `llms.txt` 版本（比 HTML 干净、可引用原文）。
> 证据分级：**原文**（官方文档原句，附 URL）/ **推断**（我按文档+常识判断）/ **未知**（文档没写）。

## 0. 三条先给的结论

1. **能直接吃 OpenAI `reasoning_effort` 的族有 6 个**：OpenAI 自家（gpt-5.2 及以后）、Gemini（OpenAI 兼容层，4 档）、DeepSeek（V4 系列）、Qwen3.8（DashScope，3 档）、Kimi K3（3 档）、GLM-5.2+（最多 7 档）。其中 **Gemini 和 Qwen 的取值不是我们的 5 档**，要收敛。
2. **Claude 是唯一"文档明写忽略 reasoning_effort"的族**：Anthropic 自己的一致性层把 `reasoning_effort` 标为 **Ignored**，要控制思考只能传 `thinking: {type:"enabled", budget_tokens:N}`（N ≥ 1024 且 < max_tokens）。而 backend-dev 对 APIMart 实测 `claude-sonnet-4-6` 带 `reasoning_effort` 返回 **400**，说明 APIMart 是把请求透传给 Anthropic 原生接口、由 Anthropic 报错——**这条链路千万别发 `reasoning_effort`**。
3. **只有 OpenAI 和 GLM-5.2 完整覆盖 xhigh/max**。Gemini 上游只有 minimal/low/medium/high；DeepSeek/Qwen/Kimi/GLM-5.3 只有 3 档（low/high/max 一类）。所以**不要给所有族都显示 5 档**，否则用户点「Max」在 Gemini 上等于「高」，是假功能。

---

## 1. 主表：谁支持、传什么、几个值

| 厂商 / 模型族 | 参数名 | 允许取值（文档原文） | 适用模型（文档声明） | 是否在 **OpenAI 兼容** `/chat/completions` 生效 | 证据 URL | 对我们 5 档的映射建议 |
| - | - | - | - | - | - | - |
| **OpenAI** gpt-5.2 及以后 | `reasoning_effort` | 取决于模型，可能包含 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` | gpt-5.2 / 5.4 / 5.4-mini / 5.4-pro / 5.5 / 5.5-pro / 5.6-* / gpt-6-* / gpt-6.1-* | ✅ 是（文档直接写 `reasoning_effort` (Chat Completions)） | https://developers.openai.com/api/docs/guides/reasoning | 原生 5 档直映：low→low、mid→medium、high→high、xhigh→xhigh、max→max；**按模型裁剪**（见 4.1 节） |
| **Google Gemini** 3.x / 4.x / 2.5 | `reasoning_effort` | `minimal` / `low` / `medium` / `high`（+ 2.5 系可 `none` 关思考） | 全部 OpenAI 兼容入口的 Gemini 模型 | ✅ 是（官方专门给了 OpenAI→Gemini 映射表） | https://ai.google.dev/gemini-api/docs/openai | 只给 **3 档**：low→low、mid→medium、high→high；**xhigh/max 收敛到 high**（上游没这俩） |
| **Anthropic Claude** 4.x/5.x | ①`reasoning_effort` ②`thinking.budget_tokens` | ① **Ignored（忽略）** ② `budget_tokens`：**N ≥ 1024 且 < max_tokens** | 全部 Claude（兼容层）；`thinking` 走请求体顶层 | ⚠️ `reasoning_effort` **被忽略**；`thinking` 对象可用（需放 body 顶层 / extra_body） | https://platform.claude.com/docs/en/api/openai-sdk | 用 `budget_tokens`：low→1024、mid→4096、high→8192、xhigh→16384、max→32768（推断，受 max_tokens 约束） |
| **Anthropic Claude**（原生 `/v1/messages`） | `output_config.effort` | `low` / `medium` / `high` / `xhigh` / `max` | Fable/Mythos/Opus 4.6+ / Sonnet 4.6+ / Haiku 5.5 等（见文档 supportedModels） | ❌ 不是 OpenAI 兼容字段 | https://platform.claude.com/docs/en/build-with-claude/effort | **原生 5 档直映**（最理想的族）；但要求走 Anthropic 协议 |
| **DeepSeek** V4 | `reasoning_effort` + `thinking.type` | `reasoning_effort`: `low`/`high`/`max`（映射表另接受 minimal/medium/xhigh/ultra） | `deepseek-flash`、`deepseek-v4-pro` | ✅ 是（文档给的就是 OpenAI 格式示例） | https://api-docs.deepseek.com/guides/thinking_mode | low→low、mid→medium(→high)、high→high、xhigh→xhigh(→high)、max→max；实际只有 **3 档** |
| **阿里 Qwen** qwen3.8 系（DashScope OpenAI 兼容） | `reasoning_effort`（或 `thinking_budget`，二者互斥） | `xhigh`/`medium`/`low`；映射接受 `max`→xhigh、`high`→xhigh、`minimal`→low、`none`→关思考 | `qwen3.8-max` / `-0902` / `qwen3.8-flash` / `qwen3.8-2.4t-a95b` / `qwen3.8-27b` | ✅ 是（明确说非 OpenAI 标准参数用 extra_body，HTTP 直接放 body 顶层） | https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions | 只给 **3 档**：low→low、mid→medium、high/xhigh/max→xhigh；或直接用 `thinking_budget`（low=4096 / medium=16384 / xhigh=262144） |
| **Moonshot Kimi** K3 | `reasoning_effort` | `low` / `high` / `max`（默认 `max`） | `kimi-k3.1-pro`、`kimi-k3` | ✅ 是（顶层字段，OpenAI SDK 直接传） | https://platform.kimi.com/docs/guide/use-reasoning-effort | 只给 **3 档**：low→low、high→high、max→max；mid 要么隐藏要么映射到 high |
| **Moonshot Kimi** K2.x | `thinking.type` / `thinking.keep` | `{"type":"enabled"}` / `{"type":"disabled"}`；K2.7-code 仅 `enabled` | `kimi-k2.6`、`kimi-k2.7-code` | ✅ 是（body 顶层，SDK 用 extra_body） | https://platform.kimi.com/docs/guide/use-thinking-models | **无强度概念**，只能开关 |
| **智谱 GLM** 5.2+ | `reasoning_effort` | GLM-5.2：`max`/`xhigh`/`high`/`medium`/`low`/`minimal`/`none`；GLM-5.3 / 5.3-FLASH / 5.3-FLASHX：**仅** `max`/`high`/`low`，其余报错 | `reasoning_effort` 仅 **GLM-5.2 及以上**支持 | ✅ 是（OpenAI 风格 body 字段；兼容页确认 `thinking` 对象同一套用法） | https://docs.bigmodel.cn/cn/guide/capabilities/thinking | GLM-5.2：5 档直映（mid→medium）；GLM-5.3：只给 **3 档**（low/high/max） |
| **智谱 GLM** 4.5~4.7 | `thinking.type` | `enabled` / `disabled` | GLM-4.5 / 4.6 / 4.7 | ✅ | 同上 | **无强度**，只能开关 |

---

## 2. 逐厂商原文（可直接粘贴进代码注释）

### 2.1 OpenAI — `reasoning_effort`（Chat Completions）

来源：https://developers.openai.com/api/docs/guides/reasoning （官方 `.md`：`https://developers.openai.com/api/docs/guides/reasoning.md`）

**原文**：

> The `reasoning.effort` parameter guides the model on how much to think when performing a task.
> Supported values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

**原文**（字段名差异，很关键）：

> Setting `reasoning.effort` (Responses) or `reasoning_effort` (Chat Completions) to `none` returns HTTP 400.
> GPT-6 Astra does not support `none` reasoning effort. GPT-6.1 Sol does not support `none` or `minimal` and defaults to `medium`.

**逐模型支持（原文，来自各模型页 `/api/docs/models/<id>.md`）**：

| 模型 | Reasoning.effort 支持 | 默认 |
| - | - | - |
| `gpt-5.2` / `gpt-5.4` / `gpt-5.4-mini` | none, low, medium, high, xhigh | none |
| `gpt-5.4-pro` | medium, high, xhigh | medium |
| `gpt-5.5` | none, low, medium, high, xhigh | medium |
| `gpt-5.5-pro` | medium, high, xhigh | high |
| `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra` | none, low, medium, high, xhigh, **max** | medium |
| `gpt-6-astra` | low, medium, high, xhigh, **max**（**没有 none**） | medium |
| `gpt-6-luna` | none, low, medium, high, xhigh, max | medium |
| `gpt-6.1-sol` | low, medium, high, xhigh, max（没有 none） | medium |
| `gpt-6.1-terra` | none, low, medium, high, xhigh, max | medium |
| `gpt-5.2-pro` | **仅 Responses API** 可用（文档原话 "available in the Responses API only"） | — |

**SDK 类型（原文，官方 openai-node `src/resources/shared.ts`）**：

> export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;

→ 说明 `xhigh`/`max` 已经是 OpenAI 官方枚举的一部分，不是我们自创。

**各档语义（原文表）**：`none` 延迟敏感、不推理；`low` 轻量推理（工具/规划/搜索）；`medium` 默认平衡档；`high` 硬推理、复杂调试；`xhigh` 长周期 agent / 深度研究（文档提示"只在你自己的评测证明有收益时用"）。

**未知**：我们目录里的 `gpt-5`、`gpt-5.1`、`gpt-5-mini`、`gpt-5-chat-latest`、`gpt-5.2-codex` / `gpt-5.3-codex`、裸 `gpt-5.6` 在 OpenAI 当前文档里**没有独立模型页**（已换代），它们各自的取值**文档未写**。→ 按"同族保守裁剪"处理（见 4.1 节）。

### 2.2 Google Gemini — OpenAI 兼容层接受 `reasoning_effort`

来源：https://ai.google.dev/gemini-api/docs/openai

**原文**：

> Different Gemini models have different reasoning configurations, you can see how they map to OpenAI's reasoning efforts as follows:

| reasoning_effort (OpenAI) | thinking_level (Gemini 4 Argon) | thinking_level (Gemini 3.1 Flash-Lite) | thinking_level (Gemini 3 Flash) | thinking_budget (Gemini 2.5) |
| - | - | - | - | - |
| `minimal` | `low` | `minimal` | `minimal` | `1,024` |
| `low` | `low` | `low` | `low` | `1,024` |
| `medium` | `medium` | `medium` | `medium` | `8,192` |
| `high` | `high` | `high` | `high` | `24,576` |

**原文**（能否关思考）：

> If you want to disable thinking, you can set `reasoning_effort` to `"none"` for 2.5 models. **Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models.**

**原文**（各模型支持的 thinking_level，来自 https://ai.google.dev/gemini-api/docs/thinking ）：

| Model | Default Thinking | Levels Supported |
| - | - | - |
| `gemini-4-argon` | On (medium) | low, medium, high |
| `gemini-3.8-flash` | On (medium) | low, medium, high |
| `gemini-3.6-flash` | On (medium) | minimal, low, medium, high |
| `gemini-3.5-flash-lite` | On (minimal) | minimal, low, medium, high |
| `gemini-3.1-pro-preview` | On (high) | low, medium, high |
| `gemini-3-flash-preview` | On (high) | minimal, low, medium, high |
| `gemini-3-pro-preview` | On (high) | **low, high**（只有两档！） |
| `gemini-2.5-pro` / `gemini-2.5-flash` | On | low, medium, high |
| `gemini-2.5-flash-lite` | **Off** | low, medium, high |

**原文**（原生也能直接给 `thinking_level`，走 `extra_body.google.thinking_config`）：

> extra_body={ 'extra_body': { "google": { "thinking_config": { "thinking_level": "low", "include_thoughts": True } } } }

→ **对 NOVAI 的意义**：Gemini 是"文档确证能吃 reasoning_effort"的族，但**上游只有 4 个值**，`xhigh`/`max` 无从谈起；而且 `gemini-3-pro-preview` 只有 low/high 两档、`gemini-3.1-pro-preview` 只有 low/medium/high。**按模型裁剪是必须的，不能一律 5 档。**

### 2.3 Anthropic Claude — 兼容层**忽略** `reasoning_effort`，只认 `thinking`

来源：https://platform.claude.com/docs/en/api/openai-sdk （`.md` 可取）

**原文**（参数支持表，明确一条）：

> | `reasoning_effort` | **Ignored** |

**原文**：

> Most unsupported fields are silently ignored rather than producing errors.

**原文**（OpenAI 兼容层怎么开思考）：

> On Claude 5 models and Claude Mythos Preview, thinking is on by default, so you can omit the `thinking` field. To use thinking on other models through the compatibility layer, set the `thinking` field of the request body to `{"type": "enabled", "budget_tokens": N}`. **`N` must be at least 1,024 and less than `max_tokens` or `max_completion_tokens`, whichever you set.**

**原文**（兼容层的限制）：

> The response doesn't include Claude's thinking. The native Claude API can return summarized thinking.
> Setting `thinking` to `{"type": "adaptive"}` returns a 400 error.

**原文**（原生 API 有真正的 5 档 effort，来源 https://platform.claude.com/docs/en/build-with-claude/effort ）：

> **Messages API**: Set `output_config.effort` on the request. With no value, the model's default level applies.
> `max` = Absolute maximum capability...；`xhigh` = Extended capability for long-horizon work...；`high` = Spends as many tokens as the task needs...（The default on every model that supports effort except Claude Opus 5.5 and Claude Haiku 5.5）；`medium` = Balanced...；`low` = Most efficient...
> **Not every model that supports `max` supports `xhigh`.**

→ **对 NOVAI 的意义**：
- 走 APIMart 的 `/v1/chat/completions`（OpenAI 兼容体）时，**唯一可行的思考参数是 `thinking` 对象**（`budget_tokens` 1024 起），**绝不能发 `reasoning_effort`**（Anthropic 忽略，但 APIMart 透传后会被 Anthropic 原生接口 400，见本文 5 节实测）。
- 若以后接 Anthropic 原生 `/v1/messages`，用 `output_config.effort` 可以直接上 5 档。

### 2.4 DeepSeek — `reasoning_effort` + `thinking.type`

来源：https://api-docs.deepseek.com/guides/thinking_mode

**原文**（控制参数矩阵）：

| 能力 | OpenAI 格式 | Anthropic 格式 | Responses API 格式 |
| - | - | - | - |
| 思考开关 | `{"thinking": {"type": "enabled/disabled"}}` | — | `{"reasoning": {"effort": "none/low/high/max"}}`（none = 关） |
| 思考强度 | `{"reasoning_effort": "low/high/max"}` | `{"output_config": {"effort": "low/high/max"}}` | 同上 |

**原文**（默认值与映射）：

> Thinking mode is enabled by default, with the default effort being **high**.
> The mapping between the effort set by the user and the model's actual reasoning effort is as follows:
> `minimal`→`low`、`low`→`low`、`medium`→`high`、`high`→`high`、`xhigh`→`high`、`max`→`max`、`ultra`→`max`

**原文**（模型与限制）：

> Use `deepseek-flash` or `deepseek-v4-pro`.
> Thinking mode does not support the `temperature`, `presence_penalty`, or `frequency_penalty` parameters... setting these parameters will not trigger an error but will also have no effect.

**未知**：我们目录里的 `deepseek-r1-250528`、`deepseek-v3.2` 等旧 ID 在本文档里**没有出现**（文档只列 deepseek-flash / deepseek-v4-pro）。backend-dev 实测这两个 ID 在 APIMart 上直接 404 不可用，所以它们本来也用不了。

### 2.5 阿里 Qwen（DashScope OpenAI 兼容）— `reasoning_effort` 或 `thinking_budget`

来源：https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions

**原文**（qwen3.8 主流模型）：

> `qwen3.8-max`、`qwen3.8-max-0902`、`qwen3.8-flash`、`qwen3.8-2.4t-a95b`、`qwen3.8-27b`：默认值为 `xhigh`
> 可选值：`xhigh`（默认）、`medium`、`low`
> `max` 映射为 xhigh，`high` 映射为 xhigh，`minimal` 映射为 low，`none` 映射为 enable_thinking=False。
> **设置上述可选值及映射值以外的值将会报错。**
> 不支持 `reasoning_effort` 与 `thinking_budget` 同时设置，同时设置会报错。

**原文**（两参数互转，等于给了 budget 语义）：

> 未设置 `thinking_budget` 时，`reasoning_effort` 档位自动映射 `thinking_budget`：`low` 对应 **4096**，`medium` 对应 **16384**，`xhigh` 对应 **262144**。
> 两者均未设置时，使用默认 `thinking_budget`（**131072**），默认 `reasoning_effort`（`xhigh`）。

**原文**（开关与位置）：

> `enable_thinking`：`true` 开启 / `false` 不开启。该参数非 OpenAI 标准参数。通过 Python SDK 调用时请放入 `extra_body`；用 curl 直接调用则放请求体顶层。

**原文**（同页其它 Qwen 系，供参考）：`qwen3.8-omni-flash` 的 `reasoning_effort` 接受 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（minimal→low、high/max→xhigh）。

→ **对 NOVAI 的意义**：qwen3.8-max 有 3 个真实档（low/medium/xhigh），我们 5 档里的 high 和 max 都会被映射成 xhigh。**给 qwen 显示 5 档是误导**，建议只给 3 档。另外 `thinking_budget` 是另一条更"连续"的路（4096/16384/262144），二选一，别同时发。

### 2.6 Moonshot Kimi — K3 才吃 `reasoning_effort`

来源：https://platform.kimi.com/docs/guide/use-reasoning-effort

**原文**：

> 使用 `reasoning_effort` 在 `low`、`high` 和 `max` 之间调节 Kimi K3.1 Pro 的推理深度、延迟与 token 消耗。
> 该字段支持 `"low"` / `"high"` / `"max"` 三档，默认 `"max"`。
> 从 K2.x 迁移到 K3 时，移除 K2.x 的 `thinking` 配置，并按需使用顶层 `reasoning_effort`。

**原文**（K3 与 K2.x 的参数差异，https://platform.kimi.com/docs/guide/use-thinking-models ）：

| 请求字段 | kimi-k3.1-pro | kimi-k3 | kimi-k2.7-code | kimi-k2.6 |
| - | - | - | - | - |
| `reasoning_effort` | low/high/max（默认 max） | low/high/max（默认 max） | **不支持** | **不支持** |
| `thinking.type` | — | — | 仅 `"enabled"`（传 disabled 报错） | `"enabled"`（默认）/ `"disabled"` |
| `thinking.keep` | — | — | 恒为 `"all"` | `null`（默认）/ `"all"` |

**未知**：我们目录里的 `kimi-k2-thinking` 这个 ID 在当前 Kimi 文档里**没有出现**（K2 系列现在叫 kimi-k2.5 / k2.6 / k2.7-code）。它是"模型自带思考"的老模型，**没有强度参数**。

### 2.7 智谱 GLM — GLM-5.2 才有 `reasoning_effort`

来源：https://docs.bigmodel.cn/cn/guide/capabilities/thinking

**原文**：

> **`reasoning_effort`**: 控制开启思维链下的推理程度，**仅 `GLM-5.2` 及以上支持**
> 可选值：`max`（默认且推荐，深度推理）、`high`（增强推理）、`low`（轻度推理，仅 `GLM-5.3` 支持）
> * 针对 `GLM-5.3` `GLM-5.3-FLASH` `GLM-5.3-FLASHX`，仅支持 `max`、`high`、`low`，其余输入将报错；
> * 针对 `GLM-5.2`，支持 `max`（默认）、`xhigh`、`high`、`medium`、`low`、`minimal`、`none`，其中 `none`/`minimal` 代表模型放弃思考；`low`/`medium` 映射为 `high`；`xhigh` 映射为 `max`

**原文**（开关）：

> **`thinking.type`**: `enabled`（默认）/ `disabled`
> 注：GLM-5.3 GLM-5.3-FLASH 不再支持关闭思考（API 请求中 thinking.type 传 disabled 将会报错）。

**原文**（OpenAI 兼容入口确认可用，https://docs.bigmodel.cn/cn/guide/develop/openai/introduction ）：兼容页里有一节「推理（thinking）」，示例即 OpenAI 兼容请求体里的 `"thinking": {...}`。

→ **对 NOVAI 的意义**：GLM-5.2 是除 OpenAI 外**唯一能完整落 5 档**的族；GLM-5.3 只能 3 档；GLM-4.5/4.6/4.7 只有开关。

---

## 3. 「明确不支持 / 不要加」清单

| # | 不要做的事 | 依据 |
| - | - | - |
| 1 | **不要对 Claude 发 `reasoning_effort`**（Anthropic 兼容层 Ignored；经 APIMart 透传后被 Anthropic 400） | https://platform.claude.com/docs/en/api/openai-sdk ；见本文 5 节实测 |
| 2 | **不要给 Gemini 发 `xhigh` / `max`**（上游只有 minimal/low/medium/high） | https://ai.google.dev/gemini-api/docs/openai 映射表 |
| 3 | **不要给 Gemini 2.5 Pro / Gemini 3 发 `reasoning_effort:"none"`**（文档明说关不掉） | 同上 |
| 4 | **不要给 Gemini 原生 `generateContent` 塞 `thinkingConfig.thinkingBudget`**（APIMart 文档没有；Gemini 原生用自己的 `thinking_level`/`thinkingBudget` 字段） | REPORT.md 段 C |
| 5 | **不要同时发 `reasoning_effort` 和 `thinking_budget`**（Qwen3.8 会报错） | 阿里云 Chat Completions 参数页 |
| 6 | **不要给 Kimi K2.6 / K2.7-code 发 `reasoning_effort`**（文档：不支持） | https://platform.kimi.com/docs/guide/use-thinking-models |
| 7 | **不要给 GLM-4.5/4.6/4.7 发 `reasoning_effort`**（仅 GLM-5.2+ 支持） | https://docs.bigmodel.cn/cn/guide/capabilities/thinking |
| 8 | **不要给 GLM-5.3 发 `thinking.type: disabled`**（报错），也不要发 max/high/low 以外的 effort | 同上 |
| 9 | **不要给 DeepSeek thinking 模式发 temperature/presence_penalty/frequency_penalty**（不报错但无效，白费字段） | https://api-docs.deepseek.com/guides/thinking_mode |
| 10 | **不要用"模型名带 thinking 就 5 档"的启发式**（`gemini-3-pro-preview-thinking` 只有 low/high 两档） | Gemini thinking 表 |
| 11 | **不要把 `minimal`/`none` 暴露成我们的档位**（会关思考，语义与"低"不同） | OpenAI/Gemini 文档 |

---

## 4. 对 NOVAI 的落地建议（`model_caps.think` 该下发什么）

> 原则：**UI 显示几档 = 上游真能区分的几档**。能映射但落回同一档的，不该显示成两个选项。

### 4.1 OpenAI 系

| 模型 | 建议下发档位 | 说明 |
| - | - | - |
| `gpt-5.6-*`、`gpt-6-*`、`gpt-6.1-*` | low / mid / high / xhigh / max | 原生 5 档；gpt-6-astra / gpt-6.1-sol 没有 none（我们不暴露 none，无影响） |
| `gpt-5.2`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5` | low / mid / high / xhigh | 4 档，**没有 max**（官方枚举到 xhigh） |
| `gpt-5.4-pro`、`gpt-5.5-pro`、`gpt-5.2-pro` | mid / high / xhigh | pro 家族 3 档（medium/high/xhigh）。**`gpt-5.2-pro` 官方标注 "available in the Responses API only"** → 走 `/chat/completions` 属未验证，别把它当主链路 |
| `gpt-5`、`gpt-5.1`、`gpt-5-mini`、`gpt-5-chat-latest` | low / mid / high / xhigh | **老 ID**（官方已无模型页）：UI 给 4 档，但 **wire 要整体下移一档** —— low→`minimal`、mid→`low`、high→`medium`、xhigh→`high`（**推断**：老一代枚举只到 high） |
| `*-codex`（`gpt-5.2-codex` / `gpt-5.3-codex` 等） | low / mid / high | 文档无模型页；保守 3 档（**推断**） |

### 4.2 Gemini 系

统一 **3 档**（low / mid / high）：low→`low`、mid→`medium`、high→`high`；`xhigh`/`max` 不显示（历史数据里若存了，发送前收敛到 high）。

例外：`gemini-3-pro-preview` 上游只有 low/high → 2 档；`gemini-3.1-pro-preview` / `gemini-3.8-flash` / `gemini-4-argon` → 3 档。

### 4.3 Anthropic 系

- **现在（走 APIMart `/v1/chat/completions`）**：发 `thinking: {type:"enabled", budget_tokens:N}`，**不发 `reasoning_effort`**。5 档 budget 建议：low=1024、mid=4096、high=8192、xhigh=16384、max=32768（**推断**；硬约束 budget < max_tokens，最大档要把 max_tokens 抬到 ≥ 32769，否则上游 400）。
- **将来接 `/v1/messages`**：`output_config.effort` 原生 5 档直映，比 budget 推断可靠。

### 4.4 DeepSeek V4 系

3 档：low / high / max（`deepseek-flash`、`deepseek-v4-pro`）。mid 若保留 → 发 `medium`，上游映射到 high，会出现"中和高结果一样"，不建议显示。

### 4.5 Qwen3.8 系

3 档，但档名是 **低 / 中 / 极高**：low→`low`、mid→`medium`、xhigh→`xhigh`（high 和 max 都落 xhigh）。
或改用 `thinking_budget`（4096 / 16384 / 131072 / 262144 四档），二者互斥，别同时发。
`none` 会被解释成关思考，我们没这个档，别发。

### 4.6 Kimi K3 系

3 档：low / high / max（`kimi-k3`、`kimi-k3.1-pro`）。我们 5 档里 mid 与 high 会撞车，建议只显示 低 / 高 / Max。

### 4.7 GLM 系

- `glm-5.2`：**5 档直映**（low→low、mid→medium、high→high、xhigh→xhigh、max→max），除 OpenAI 外唯一能完整落 5 档的族。
- `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx`：3 档（low / high / max）。
- `glm-4.5` / `4.6` / `4.7`：不下发（只能开关），前端隐藏入口。

### 4.8 一个必须提起的产品问题

「模型强度」是**每模型能力不同**的东西，同一 vendor 内不同代也差很多（`gpt-5.4-pro` 3 档 vs `gpt-6-astra` 5 档）。所以：

- `model_caps.think` **必须是"模型名 → 档位数组"的显式表**，不能是族正则（与 task-1 报告 D3–D6 一致）。
- 只有 3 档的族**宁可下发 3 档**：下发了 5 档，用户点 Max 得到和 High 一样的结果，会被当成 bug。

---

## 5. 附：APIMart 网关侧实测（backend-dev 提供，非本文档调研）

> 这一节是 **APIMart 平台层**证据，用来把"厂商文档说支持"和"经 APIMart 转发还能不能用"连起来。原始材料：`/tmp/novai-apimart-probe/APIMART_PROBE_SUMMARY.md`、`probe_matrix.json`、`probe_usage.json`、`chat_models_parameters.md`（Key 未落盘、未打印）。**只作参考，不是厂商文档原文。**

| 探针结论 | 对我们的影响 |
| - | - |
| `GET /v1/models?expand=parameters`：316 个模型，chat 184 个**全都没有 `parameters` 字段**（带 parameters 的 114 个都是 image/video）；整份响应 grep `reasoning`/`thinking`/`effort` **0 命中** | APIMart **不能**作为推理能力的真值源；必须用本文档（厂商文档）+ 本地显式表 |
| `gemini-3.1-pro-preview` 带 `reasoning_effort` → 200/200 | 与 Gemini 官方文档一致（兼容层接受该字段） |
| `claude-sonnet-4-6` 带 `reasoning_effort` → 200/400（400 来自上游 Anthropic/Bedrock），而未知字段 `foo_bar` → 200 | 说明 APIMart **不是**严格校验而是**透传**；Claude 的 400 来自 Anthropic 自己 → 佐证第 3 节第 1 条 |
| `qwen3.8-max` 带 `reasoning_effort` → 200/200，但 `reasoning_tokens` 基本不变 | 能过，但**无法证明调档生效**（Qwen 思考始终开） |
| `gpt-5.5` 带 `reasoning_effort=high` → 出现 `reasoning_content`（对照组没有） | OpenAI 族**真生效** |
| Claude 走 `/v1/messages` + `thinking` → 返回 `content_blocks=[thinking,text]`（真生效）；走 `/chat/completions` 只有 200、无 thinking 证据 | Claude 要真生效必须走 Anthropic 协议 |
| `deepseek-v3.2` / `deepseek-r1-250528` → 404（model_not_found / ModelArts.81009） | 这两个 ID 在该账号下不可用，别当对照组 |

**跨层结论**：厂商文档说"支持" ≠ 经 APIMart 一定生效。**当前能确认在 APIMart 上真生效的只有：OpenAI 族 `reasoning_effort`、Claude `thinking`@`/v1/messages`**。Gemini / Qwen / DeepSeek / Kimi / GLM 经 APIMart 的可调性**尚未验证**（要各自做 A/B：同 prompt 两档比 `usage.reasoning_tokens` 是否单调变化）。

---

## 6. 未知 / 待验证清单

| # | 未知项 | 影响 | 怎么验 |
| - | - | - | - |
| V1 | APIMart 是否把 `reasoning_effort` 真转发给 Gemini/Qwen/Kimi/GLM 上游（不只是"不报错"） | 决定这几个族能不能真开入口 | 同 prompt 跑两档，比 `usage.reasoning_tokens` 是否单调变化 |
| V2 | `gpt-5` / `gpt-5.1` / 裸 `gpt-5.6` / `*-codex` 的 effort 取值 | 这些是目录里的老 ID，用户可能还在用 | OpenAI 已无模型页；只能实测 400 边界 |
| V3 | APIMart 上 Claude 走 `/chat/completions` 时，`thinking` 对象能不能透传（vendor 文档说兼容层支持，但 APIMart 是否走兼容层？） | 决定 Claude 能否在现有链路开强度 | 发 `thinking:{type:enabled,budget_tokens:2048}` 看 200/400 与响应 |
| V4 | Qwen `thinking_budget` 与 `reasoning_effort` 经 APIMart 哪个可用 | 二选一实现 | 各发一次 |
| V5 | `kimi-k2-thinking` 这个 ID 现在映射到什么 | 老模型，可能已下线 | 直接调一次看 404/200 |

---

## 7. 抓取与复核

```bash
# 厂商文档（全部走代理）
curl -sSL -x http://127.0.0.1:7897 https://developers.openai.com/api/docs/guides/reasoning.md -o oa_reasoning.md
curl -sSL -x http://127.0.0.1:7897 https://developers.openai.com/api/docs/models/gpt-5.5.md -o gpt55.md
curl -sSL -x http://127.0.0.1:7897 https://ai.google.dev/gemini-api/docs/openai -o gemini_openai.html
curl -sSL -x http://127.0.0.1:7897 https://ai.google.dev/gemini-api/docs/thinking -o gemini_thinking.html
curl -sSL -x http://127.0.0.1:7897 https://platform.claude.com/docs/en/api/openai-sdk.md -o claude_openai_sdk.md
curl -sSL -x http://127.0.0.1:7897 https://platform.claude.com/docs/en/build-with-claude/effort.md -o claude_effort.md
curl -sSL -x http://127.0.0.1:7897 https://api-docs.deepseek.com/guides/thinking_mode -o ds_thinking_mode.html
curl -sSL -x http://127.0.0.1:7897 https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions.md -o qwen_chat.md
curl -sSL -x http://127.0.0.1:7897 https://platform.kimi.com/docs/guide/use-reasoning-effort.md -o kimi_effort.md
curl -sSL -x http://127.0.0.1:7897 https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md -o glm_thinking.md
```

说明：

- OpenAI 主站 `platform.openai.com/api/docs/*` 走代理会 403，改用 `developers.openai.com`（同一份文档，`og:url` 指向它）。
- Google 两页只有 HTML（无 `.md`），本报告引用的是从 HTML 抽出的正文，关键字可在页面里全局搜到。
- Anthropic 文档域名已从 `docs.anthropic.com` 迁到 `platform.claude.com`，两者都可用。
- 抓取时间：2026-11（与 task-1 同一环境，同一代理）。
