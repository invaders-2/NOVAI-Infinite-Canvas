# APIMart 模型分类全量体检（2026-11-26）

> 只读审计，没改任何产品代码。数据源：`GET https://api.apimart.ai/v1/models?expand=category`（262 条，只读免费，未产生生成费用）+ 文档语料 `/tmp/apimart-llms-20261125.txt`（92103 行）+ 价目 352 条 + 我们的 catalog/内置清单/能力表。机器可读结果：`/tmp/model-category-audit.json`。

## 一句话结论

**四个类的分类字段本身没有一处错**——183 条 catalog 里能按 ID 归一到上游的 157 条，category 全部一致；价目 222 条对得上，category 也全部一致（昨天音频那两类错确实已经修掉了，见 `6.1` 复核）。真正要派工的是 **4 类共 9 个 ID 的别名解析问题**（内置下发无效 ID、能力表死 key、别名 ID 命中旧规格、价目别名指向错模型），另有 **17 类需实测/产品确认**、**14 条看着可疑但核实不是错**。

| 项目 | 数值 |
|---|---|
| 上游 `GET /v1/models?expand=category` | 262（chat 126 / image 63 / video 62 / audio 5 / unknown 6），49129 bytes，sha256 `e00a699a…fe572` |
| 我们的 catalog | 183（chat 48 / image 65 / video 65 / audio 5） |
| 能归一对上上游的 | 157 → **category 不一致 0 处** |
| catalog 有、上游没有 | 26 → 15 条文档明写是别名（不是错）+ 11 条待确认 |
| 上游有、catalog 没有 | 105 → 值得补 54（chat 42 / image 8 / video 4），不建议补 51 |
| 价目 `apimart_pricing.json` | 352 条，222 条对得上上游 → **category 不一致 0 处**；别名指向问题 6 处 |
| **确定错** | **4 类 / 9 个 ID** |
| **疑似错** | **17 类** |
| **不是错（别改）** | **14 条** |

---

## 0. 体检口径

- **ID 归一**：小写 + `_` 与 `.` 统一成 `-` + 压掉连续 `-`。所以 `seedream-4.5` = `seedream-4-5` = `Seedream-4.5`、`MiniMax-H3` = `minimax-h3`、`gemini-3.1-flash` = `gemini-3-1-flash` 都算同一模型。所有"不一致"结论都在归一之后仍成立才算。
- **权威优先级**：① 上游 `category` ② 文档 Source 锚点路径（`/images/ /videos/ /audios/ /texts/`）+ 页内 `model` 字段 ③ 价目 `category`/`alias_map` ④ 我们的 catalog / `APIMART_BUILTIN_MODEL_IDS` / 能力表 / `model_protocols.json`。
- **基线**：本次核对的是工作区当前状态，`catalog.json`（11:06:49）、`apimart_pricing.json`（11:07:06）、`main.py`（11:07:24）都是今天刚改过、尚未提交的本地改动（`git status` = M）。所以"分类字段已经对齐"是这一版的事实，不代表历史版本。
- **没做的事**：没有发任何生成请求（不花钱），所以"这个 ID 能不能真提交成功"只能标"需实测"。

---

## 1. 分类一致性核对：0 处错（结论来自六个方向的交叉比对）

| 比对 | 覆盖面 | 不一致 |
|---|---|---|
| catalog 分类 vs 上游 `category` | 157/157 能归一的条目 | **0** |
| catalog 内部同一 ID 落在两类 | 183 条 | **0** |
| catalog 分类 vs 内置清单 `APIMART_BUILTIN_MODEL_IDS` 分组 | 96 个 key / 105 个模型条目 | **0** |
| 价目 `category` vs 上游 `category` | 222/222 能归一的条目 | **0** |
| `docs/apimart-docs/params.json` 的 `kind` vs 上游 | 19 条 | **0** |
| `protocol_updates.json` 7 个版本的 `new_models` 分组 vs 上游/catalog | 全部 | **0**（唯一例外 `midjourney-video` 是刻意造的虚拟模型，见 `4`） |

音频单独复核：catalog audio = `suno / flowmusic / gpt-4o-mini-tts / whisper-1 / gpt-audio-mini`，与上游 audio 组的 5 条**完全一致**，没有 lyria-3.5，也没有混入别类。

---

## 2. 确定错（要改）：4 类 / 9 个 ID

### 2.1 内置清单里下发了无效模型 ID：`gpt-image-2.5`

- **位置**：`main.py L25604` → `"gpt-image-2-5": ("gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst")`
- **证据**：
  - 上游 `/v1/models` image 组只有 `gpt-image-2.5-ext`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，**没有裸 `gpt-image-2.5`**。
  - 文档原文：`Image model name: `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst`.`（llms-full **L5553**）。
- **影响**：编辑器把"GPT-Image-2.5"作为一个可选项下发给用户，选中后请求带 `model=gpt-image-2.5`，预期 400/404。
- **建议改法**：内置值改成 `("gpt-image-2.5-flare", "gpt-image-2.5-sunburst")`；如果要保留一个"2.5"菜单项，就用 caps key `gpt-image-2-5` 做展示名、值只放这两个真 ID。

### 2.2 能力表死 key：`nano-banana-lite`

- **位置**：`main.py L16454`（`APIMART_IMAGE_MODEL_CAPS` 的 key）
- **证据**：`apimart_image_model_caps()` 用「key 是模型名的子串」匹配（L16644-L16652），而文档里这条别名是 **`nano-banana-2-lite`**（llms-full **L4029**："`gemini-3.1-flash-lite-image` (Nano Banana Lite, compatible alias `nano-banana-2-lite`)"）。`nano-banana-2-lite` 里不含 `nano-banana-lite` 这个子串，所以这个 key 永远命不中；我把上游 ID、catalog ID、内置下发 ID 三种来源都过了一遍，**只有它一个是完全打不中的 key**。
- **建议改法**：key 改成 `nano-banana-2-lite`；或在 `apimart_image_model_caps()` 入口先做「别名 → 正式 ID」归一，让这类 key 直接不需要。

### 2.3 别名 ID 命中错误的规格家族：`nano-banana-2` / `-2-ext` / `-2-lite` / `-2-lite-ext`

- **位置**：`main.py L16644-L16652`（最长 key 子串匹配）+ L16434（`nano-banana` 规格块）
- **证据**：这 4 个别名（catalog L742 / L728 / L756 / L770）归一后都会先命中 `nano-banana`（Gemini 2.5 家族）那条规格，而它们等价的是 3.1 家族：

| 别名 | 应该用 | 实际命中 | 差异 |
|---|---|---|---|
| `nano-banana-2` `-2-ext` | `gemini-3-1-flash-image-preview` | `nano-banana` | resolutions 只有 `1K`（真值 `0.5K/1K/2K/4K`）；比例 11 个 vs 15 个；`mask_url` False vs True |
| `nano-banana-2-lite` `-2-lite-ext` | `gemini-3-1-flash-lite-image` | `nano-banana` | 比例 11 个 vs 15 个；`mask_url` False vs True |

- **影响**：用户用别名选模型时，2K/4K 选项和 4 个比例（`1:4/4:1/1:8/8:1`）会消失，局部重绘（mask）也会被判为不支持——功能看起来"少了"，但其实是规格命中错。
- **建议改法**：给 3.1 家族补别名 key（`nano-banana-2`、`nano-banana-2-lite`…），或在匹配前先查一张别名表把 ID 换成正式 ID。

### 2.4 价目 `alias_map` 把 3 个别名指到"非官方版"（计价按错模型）

- **位置**：`server/credits/apimart_pricing.json` `alias_map`：`nano-banana` L41777、`nano-banana-2` L41780、`nano-banana-pro` L41793
- **证据**：同一份文件的 `models` 里反而是官方版声明了这些别名——`gemini-2.5-flash-image-preview-official.aliases = ["nano-banana"]`（L3081 起）、`gemini-3-pro-image-preview-official.aliases = ["nano-banana-pro"]`（L3230 起）；文档也写 `gemini-2.5-flash-image-preview-official` - Official version (compatible alias `nano-banana`)（**L1988**）、`gemini-3.1-flash-image-preview-official` … alias `nano-banana-2`（**L3337**）。三处对照，`alias_map` 是错的那一侧。
- **影响**（按价目里的 gold 单价）：

| 别名 | 文档/官方价 | `alias_map` 实际取价 | 差 |
|---|---|---|---|
| `nano-banana` | `gemini-2.5-flash-image-preview-official` = **0.0312 USD/张** | `gemini-2.5-flash-image-preview` = **0.008 USD/张** | 少收约 3.9 倍 |
| `nano-banana-pro` | `gemini-3-pro-image-preview-official` = **0.1072 USD/张** | `gemini-3-pro-image-preview` = **0.02 USD/张** | 少收约 5.4 倍 |
| `nano-banana-2` | `gemini-3.1-flash-image-preview-official` | `gemini-3.1-flash-image-preview` | 官方/非官方两档价 |

- **建议改法**：把这三个 `alias_map` 目标改成 `-official` 版；改完顺手跑一次 `server/credits` 的估价单测（价目 resolver 走 id → 别名 → 压缩别名，改数据不动代码即可生效）。

---

## 3. 疑似错（需实测或产品确认）：17 类

### 3.1 catalog 收了、上游没有、文档只列了名字（9 个 ID）→ 2026-11-27 已处置，见 §8

这批都只在文档的"模型清单"里出现，`/v1/models` 里没有，也没有独立参数页 —— 要么已下线，要么平台没部署。**建议先各发一次最小请求实测**（失败一般 400/404，不收费），再决定删还是留。

| ID | 我们的类 | 文档出处 | 价目 | 备注 |
|---|---|---|---|---|
| `deepseek-r1-250528` | chat（L352） | llms-full L30858 | 有 | 上游只有 `deepseek-r1` 和 `deepseek-r1-0528`，这条**很可能是老写法** |
| `deepseek-v3.2-exp` | chat（L402） | L30857 | 有 | 上游只有 `deepseek-v3.2` |
| `deepseek-v3-0324` | chat（L410） | L30859 | 有 | 上游无 |
| `gpt-5-chat-latest` | chat（L57） | L30830 | 有 | 上游无 |
| `gpt-5.2-codex` | chat（L112） | L34689 | 有 | 上游 codex 只有 `gpt-5.3-codex` |
| `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite` | chat（L301/L318/L335） | L29306（走 `/v1beta` 原生端点）、`texts/general/chat-completions` 示例 | 有 | 上游 `/v1/models` 已无 2.5 文本系；可能只能走 Gemini 原生端点 |
| `seedance-1-5-pro` | video（L1216） | 文档页已消失 | 有 | catalog notes 自己也标了"疑似下线，保留不删，见 U25" |

### 3.2 文档示例 ID 与上游实际 ID 对不上（2 个）

| 文档里写的 | 上游实际 ID | 现状 |
|---|---|---|
| `gemini-omni-1.1-flash-ext`（`videos/omni-flash-ext/generation`，catalog L1433） | `Omni-Flash-Ext` | catalog 只收了前者；`main.py L25694` 的内置清单用后者。两个都在，但**catalog 漏了真 ID**，建议两条并存并在 notes 互指 |
| `grok-imagine-1.5-video-ext`（`videos/grok-imagine/generation`，catalog L1090） | `grok-imagine-1.5-video-apimart` | 同上，catalog 漏了上游那一条 |

### 3.3 上游自己把音频/审核模型归到 chat（3 个）→ 2026-11-27 已处置，见 §8

- `gpt-4o-transcribe`、`gpt-4o-mini-transcribe`：上游 `category=chat`、tags `[Text, Vision, Audio, Omni]`，但它们本质是**转写**模型。
- `omni-moderation-latest`：上游 `category=chat`，文档在 `moderations/` 目录下。
- **影响**：编辑器会照抄上游 category，把它们塞进对话下拉——用户点进去必然失败。这也正是昨天 `gpt-audio-mini` 那类问题的同一个坑（只不过那次上游把它归在 audio）。
- **建议**：在 `classify_upstream_model` 之外再补一条"语义覆盖表"（这些 ID 强制归 audio / 隐藏），或至少在 `/v1/models` 同步时把它们从 chat 列表剔除。**需产品确认**要不要在音频节点里支持转写。

### 3.4 价目自映射（3 个）→ 2026-11-27 已处置，见 §8

`alias_map` 里 `veo3.1-fast-ext` L41898、`veo3.1-quality-ext`、`veo3.1-lite-ext` 指向**自己**，等于没解析；其中 `veo3.1-fast-ext` 连 `models` 行都没有（`veo3.1-quality-ext` / `lite-ext` 有独立价目）。文档（L47579）说这三个就是 `veo3.1-fast/quality/lite` 的等价别名。**建议**：自映射要么删、要么改成真 ID，别留一个"看起来能解析其实是空转"的条目。

### 3.5 无 `category` 时的关键词回退有缺口（低危）

`main.py L26751 classify_upstream_model`：顺序 video → image → audio → chat，但关键词表缺这些族——缺 `category` 时会被归到 chat：

- 图像：`grok-imagine`（注意 `imagine` 不含 `image` 子串）
- 视频：`pixverse`、`viduq3`、`skyreels`、`happyhorse`、`MiniMax-H3`、`gemini-omni`、`apimart-zoe`

APIMart 带 `expand=category` 时不受影响（上游分类优先），但换成别家 OpenAI 兼容站、或上游某次不给 category 就会错。**建议**把这些族名补进对应 keys。

### 3.6 `thinking.py` 里有 8 个上游不存在的 ID（低危）→ 2026-11-27 已处置，见 §8

`server/protocols/thinking.py L90-L121` 的 `THINK_MODEL_LEVELS` 含：`gpt-5.1-codex`、`gpt-5.1-codex-max`、`gpt-5.1-codex-mini`、`gpt-5.5-pro`、`glm-5.3-flashx`、`kimi-k3.1-pro`、`deepseek-flash`、`deepseek-ocr`。这些 ID 上游都没有（codex 只有 `gpt-5.3-codex`）。目前只影响"用户自己登记了同名模型时的档位"，不影响分类，**建议**改名或标注历史兼容。

### 3.7 catalog 漏收了内置/上游在用的 9 个 ID（与 `2` 不同，这里是漏收）

`Omni-Flash-Ext`、`gpt-image-1`、`grok-imagine-image`、`grok-imagine-image-quality`、`grok-imagine-1.0-apimart`、`grok-imagine-1.0-edit-apimart`、`grok-imagine-1.5-edit-apimart`、`grok-imagine-1.5-video-apimart`、`wan2.6-i2v`。其中 `grok-imagine-image` 有独立文档页（`images/grok-imagine/generation`）、`gpt-image-1` 上游明确 image、`Omni-Flash-Ext` 内置清单已在用 —— 这三条是硬缺口。

### 3.8 `-thinking` 变体漏收（2 个，见 `5`）

`gemini-3-flash-preview-thinking`、`gemini-3-flash-preview-nothinking`：同族基础 ID 已在 catalog，这两个变体没进；`thinking.py` 里其实已经分别按"思考版 3 档"和"no-think"处理了，属于文档与代码不同步。

---

## 4. 不是错（别改）——14 条

| # | 看着可疑的点 | 核实结论 | 证据 |
|---|---|---|---|
| 1 | `nano-banana` `-ext` `-pro` `-pro-ext` `-2` `-2-ext` `-2-lite` `-2-lite-ext` 像是重复收录 | **不是错**：文档明写是 compatible alias，catalog 约定就是"别名单独成条 + notes 写 = 正式 ID"，15 对别名/正式 ID 都在 | llms-full L1420、L1987-L1988、L2119、L3336-L3337、L4029-L4030；catalog L672-L770 |
| 2 | `veo3.1-fast-ext` `-quality-ext` `-lite-ext` 同上 | **不是错**：文档明说是 `veo3.1-fast/quality/lite` 的等价别名 | llms-full **L47579** |
| 3 | `gpt-image-2-ext` | **不是错**：`Fixed to gpt-image-2 (compatible alias gpt-image-2-ext)` | llms-full L6783、L7192 |
| 4 | `grok-imagine-1.5-ext` | **不是错**：= `grok-imagine-1.5-apimart`，价目别名也指同一目标 | catalog L889 notes |
| 5 | `doubao-seedance-2-5-flash` 像重复视频模型 | **不是错**：文档写明"用 `seedance-2-5-flash`，别名 `doubao-seedance-2-5-flash` 也接受"（同页还写 `seedance-2.5-flash` 带点写法**不支持**） | llms-full **L45585** |
| 6 | `claude-opus-5-thinking` 像 `-thinking` 造出来的假模型 | **不是错**：这是平台扩展别名，文档说所有模型都能加 `-thinking`；catalog notes 已标 = `claude-opus-5` | llms-full L89183、L89192；catalog L544-L547 |
| 7 | `gemini-3-pro-preview-thinking` / `gemini-3.1-pro-preview-thinking` | **不是错**：上游 `/v1/models` 里就是独立 ID（`category=chat`），不是我们造的重复条目（后者 catalog 未收，属漏收见 §3.8） | 上游 JSON |
| 8 | `midjourney-video`（内置 video 组） | **不是错**：刻意造的虚拟模型，提交走 MJ video 端点、不带 `model`；只在 `include_builtin=1` 时下发 | main.py L25647-L25650 注释 |
| 9 | `MiniMax-H3-Regeneration` 像"动作"被当模型 | **不是错**：再生接口里它就是 `model` 的字面值，上游 `category=video` | llms-full **L42881** `Fixed value: MiniMax-H3-Regeneration` |
| 10 | `seedream-4.5` / `seedream-4.0`（catalog）vs `seedream-4-5` / `seedream-4-0`（上游） | **不是错**：文档明说三种写法都收 | llms-full **L23606** `Supported models: seedream-4.5, Seedream-4.5, seedream-4-5` |
| 11 | `gpt-5.4-mini` / `gpt-4.1-mini` 出现在 `/images/` 文档页 | **不是错**：那是嵌在图片请求 schema 里的 `svg.model`（SVG 作者模型），不是生成模型 | llms-full **L6532**、**L6602-L6610** |
| 12 | `veo3.1-lite` 上游 tags 是 `Text to Image / Image to Image` | **不是错**：上游 `category=video` 才是权威分类，tags 是上游元数据瑕疵 | 上游 JSON |
| 13 | `gpt-image-2.5-flare` / `-sunburst` 共用 `gpt-image-2-5` 一套 caps | **不是错**：文档写"flare 与 sunburst 参数完全相同，只是速度/细节取向不同" | params.json 该条 notes（引 llms-full） |
| 14 | `minimax-h3-image-highspeed` 复用 `minimax-h3-image` 的 caps | **不是错**：文档写 `parameters identical to the standard version`（只是单价 2 倍） | llms-full **L21295** |

---

## 5. 漏收盘点（D）：105 条上游有、catalog 没有

| 上游类 | 缺失 | 其中值得补 | 原因分布 |
|---|---|---|---|
| chat | 87 | 42 | 家族整体未收录 64、日期快照 15、`-thinking/-nothinking` 变体 8 |
| image | 8 | **8** | 全是上游明确 image 的（grok-imagine 族、gpt-image-1/1.5、dall-e-3） |
| video | 4 | **4** | `Omni-Flash-Ext`、`grok-imagine-1.0/1.5-video-apimart`、`wan2.6-i2v` |
| unknown | 6 | 0 | 上游没给分类（`deepseek-v3.1`、`qwen3.6-max`、`text-ada-001` 等老 legacy） |

**值得补的 12 个 image/video**（建议一次派工补进 catalog，分类按上游）：
`dall-e-3`、`gpt-image-1`、`gpt-image-1.5`、`grok-imagine-1.0-apimart`、`grok-imagine-1.0-edit-apimart`、`grok-imagine-1.0-video-apimart`、`grok-imagine-1.5-edit-apimart`、`grok-imagine-1.5-video-apimart`、`grok-imagine-image`、`grok-imagine-image-quality`、`Omni-Flash-Ext`、`wan2.6-i2v`。

**值得补的 42 个 chat**（建议按族一次性补，别逐个来）：claude 家族（`claude-fable-5/5.1`、`claude-haiku-4-5…`、`claude-opus-4-5`、`claude-opus-5-5`、`claude-sonnet-4-5`、`claude-sonnet-5-5` 及 5 个 `-thinking`）、gemini（`gemini-3.7-flash`、`gemini-3.8-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite-preview`、`gemini-4-argon`、2 个 `-thinking/-nothinking`）、gpt（`gpt-5-nano`、`gpt-5-pro`、`gpt-5.4-pro`、`gpt-5.4-nano`、`gpt-5.6-terra`、`gpt-6-sol`、`gpt-5-search-api`、`gpt-4.1`、`gpt-4.1-mini`、`gpt-4o`、`gpt-4o-mini`）、qwen3.8（`-flash`、`-27b`、`-2.4t-a95b`）、glm（`glm-5.2/5.3/5.3-flash`）、kimi（`kimi-k3`）、deepseek（`deepseek-r1`、`deepseek-v4.1-flash`）。全量清单见 JSON 的 `missing[]`（每条带 `reason` 与 `actionable`）。

**不建议补的 51 条**：整族没收录的（`o3*`、`glm-5/5.1`、`kimi-k2.x`、`minimax-m2.5/m3`、`grok-4.x`、`qwen3.6/3.7`、`step-3.7`、`text-embedding-*` 等）属于产品选型不是分类错误；15 条带日期快照（`gpt-5-2025-08-07` 等）不必要；6 条上游 `unknown`。

---

## 6. 附：复核与局限

### 6.1 音频（用户昨天提的那两类）复核结果

- catalog audio 5 条与上游 audio 5 条**逐条一致**，无多余、无缺失。
- `lyria-3.5` 是 `flowmusic` 的 `version` 参数值，不是模型——文档两处铁证：`Model version, must be "lyria-3.5"`（**L55520**）和 `Lyria 3.5 still uses flowmusic as the model name. Do not change model to lyria-3.5 or flowmusic-lyria-3.5`（**L55524**）。现在仓库里已经没有 `lyria-3.5` 条目（只剩 `_preview/` 历史快照，不影响运行）。
- 结论：音频侧的"lyria 假模型 / gpt-audio-mini 漏收"两个问题**已修复**，本次未发现新的音频分类错。

### 6.2 局限（没验证到的）

1. 没有发任何生成/提交请求，所以 `-ext` 系列、`seedance-1-5-pro`、`gemini-2.5-*` 等"能不能真提交"仍是**需实测**，不是已确认。
2. 上游 `category` 本身有瑕疵（`veo3.1-lite` 的 tags、`transcribe` 归 chat），本次按"以上游 category 为权威"处理，只在 `3.3` 标注。
3. 未覆盖非 APIMart 供应商；`config/providers.json` 目前只有 `pixverse` 一个默认清单。
4. `apimart_image_model_caps` / `apimart_video_model_caps` 的 key 匹配是子串匹配，本次只按「上游 ID + catalog ID + 内置下发 ID」三种真实 ID 检查命中，别名命中错规格的结论来自这套模拟，未在运行中的服务上复现。

### 6.3 复现

```bash
# 1) 拉上游清单（只读，需要代理和 APIMart key）
#    见 /tmp/audit_build_json.py 里的 urllib + ProxyHandler 127.0.0.1:7897 写法
# 2) 重建审计结果
python3 /tmp/audit_build_json.py      # 输出 /tmp/model-category-audit.json
```

---

## 7. 派工清单（按优先级）

| 优先级 | 改什么 | 文件:行 | 状态 |
|---|---|---|---|
| P0 | `gpt-image-2-5` 内置值去掉裸 `gpt-image-2.5` | main.py:25610 | ✅ 已修（2026-11-26）：值改为 `("gpt-image-2.5-flare", "gpt-image-2.5-sunburst")`；回归测试 `test_builtin_gpt_image_2_5_has_no_bare_id` |
| P0 | `alias_map` 的 `nano-banana` / `nano-banana-pro` / `nano-banana-2` 改指 `-official` | apimart_pricing.json:41777 / 41780 / 41793 | ✅ 已修：三个别名目标改为 `-official` 版；**compact 拼写** `nanobanana` / `nanobanana2` / `nanobananapro` 同步改（否则换种拼法仍绕过去）；回归测试 `test_nano_banana_aliases_use_official_pricing` |
| P1 | caps key `nano-banana-lite` → `nano-banana-2-lite`（或入口做别名归一） | 原 main.py:16454（已删）/ 别名段 16637-16643 | ✅ 已修：删掉永远命不中的 `nano-banana-lite`，改为别名条目 `nano-banana-2-lite` 引用 `gemini-3-1-flash-lite-image`（未引入第二套匹配逻辑） |
| P1 | 补 3.1 家族别名 key，修 4 个别名命中旧规格 | main.py:16637-16643（dict 后别名段） | ✅ 已修：`nano-banana-2` → `gemini-3-1-flash-image-preview`（0.5K/1K/2K/4K、15 比例、mask=True），`nano-banana-2-lite` → lite；回归测试 `test_nano_banana_2_aliases_hit_31_family` |
| P2 | catalog 补 12 个 image/video + 2 个 `-thinking` 变体 | catalog.json | ✅ 2026-11-27 已补：实际补 54 条（chat 39 / image 8 / video 4 / audio 2 / hidden 1），见 §8 |
| P2 | 9 个"文档有、上游无"的 ID 各实测一次再决定去留 | — | ✅ 已实测并处置：7 个移除、2 个 503 保留注明（ID-PROBE-20261127.md），见 §8 |
| P3 | `classify_upstream_model` 关键词补齐；`thinking.py` 幽灵 ID 清理 | main.py:26757 / thinking.py:90 | ✅ classify 已补（grok-imagine/imagine/z-image；pixverse/viduq3/viduq4/skyreels/happyhorse/minimax-h3/gemini-omni/apimart-zoe/omni-flash，含同族 -image 优先，测试 3 条）；✅ thinking.py 2026-11-27 已清：8 个幽灵 ID 移入 `THINK_MODEL_LEGACY_GHOST_IDS`，不再参与档位解析（见 §8） |

### 7.1 本轮实测补充：内置清单里"上游不存在"的值（只报不改）

用 `GET /v1/models?expand=category`（262 个模型，2026-11-26 实测）对了一遍 `APIMART_BUILTIN_MODEL_IDS`，
除已修的裸 `gpt-image-2.5` 外还有 8 个值不在上游清单里：

| 值 | 类 | 判断 | 处理 |
|---|---|---|---|
| `seedream-4.0` / `seedream-4.5` | image | 上游用连字符 `seedream-4-0` / `seedream-4-5` | **本轮不动**（点号写法可能是平台别名，需实测确认） |
| `nano-banana` / `nano-banana-pro` | image | 上游无这两个 id，但文档写明是 `-official` 的兼容别名（L1988） | 不动（有意保留别名） |
| `midjourney-video` | video | 项目虚拟模型（用户填 midjourney 时派生），不是上游 id | 不动 |
| `seedance-1-5-pro` | video | 文档页已消失 + 上游无 → 疑似下线（U25） | 不动（已标「文档页已消失」） |
| `grok-imagine-1.5-video-ext` | video | 上游真 id 是 `grok-imagine-1.5-video-apimart`（文档写的是前者） | 不动（两条都保留） |
| `gemini-omni-1.1-flash-ext` | video | 上游真 id 是 `Omni-Flash-Ext`（内置另有 `omni-flash-ext` 映射到它） | 不动（别名并存） |

### 7.2 交叉引用：U23 的第二个样本 magi-2（2026-11-26 增量）

REPORT-DELTA-20261125.md 的 U23 原先只有 apimart-zoe 一个样本（能力表 9/3/3 vs 文档 30/10/10）。**magi-2 是第二个样本：文档 10/5/5，代码 9/3/3。** 2026-11-26 文档新增页 magi-2（L40642–L40910）声明参考上限 **图 10 / 视频 5 / 音频 5**（L40786 / L40798 / L40802 / L40806），而我方通用提交分支仍是硬截断 image_payload[:9] / video_payload[:3] / audios[:3] → 本轮能力表继续按实际队列写 **9 / 3 / 3**（与 apimart-zoe 同口径），U23 证据由 1 个模型增至 2 个。

- 证据与改动清单：REPORT-DELTA-20261126.md §3（magi-2 全参数）、§5.2（P1–P6 协议面）、§8.1（U23 状态）。
- 分类本身无新增错：magi-2 上游 category=video、capability_tags=[Text to Video, Image to Video, Video to Video]，与能力表 modes（不含 video_edit/video_extend，见 P4）一致。
- 仍未解：10/5/5 是否真可用（U23 同批实测，注意产生费用），见 docs/待推送清单.md 的「11-26 magi-2 与协议补齐」小节。
- **2026-11-27 更新**：通用视频分支已改为按能力表声明下发，magi-2 能力表按文档写 10/5/5（apimart-zoe / seedance-2.5 写 30/10/10），mock 实测 12 张发 12、7 张发 7、未声明模型仍 9；真机超限仍未实测，见 §8。


---

## 8. 2026-11-27 收口结果（①②③④⑤ 全部落地 + 参考上限改能力表驱动）

| 项 | 原问题 | 处置 | 结果 / 证据 |
|---|---|---|---|
| ① | catalog 收了上游没有的 9 个 ID（§3.1） | 7 个确定不可用：从 catalog 删条目 + 清价目别名 + 从内置可选清单删 seedance-1-5-pro；2 个 503（gemini-2.5-pro / -flash）各重试 2 次仍 503 → 保留并注明 | catalog 计数 chat 48→81、video 66→69（含④补入）；ID-PROBE-20261127.md 的「复测结果」「最终处置」；tests/test_credits.py::test_offline_model_ids_have_no_alias_entry |
| ② | 上游把 2 个转写 + 1 个审核模型归到 chat（§3.3） | 新增语义覆盖表 APIMART_MODEL_SEMANTIC_OVERRIDES，在 parse_upstream_models 里应用：转写强制 audio、审核 hidden（不进任何桶、不进全量 ids、记进 meta.hidden）；不改上游返回 | tests/test_apimart_model_categories.py 新增 2 条（含 gpt-4o 等普通 chat 不受影响、无 category 时也生效）；catalog 里两条转写落 audio、审核落新增的 hidden 桶 |
| ③ | 价目 veo3.1-*-ext 自映射空转（§3.4） | veo3.1-fast-ext 由自映射改指真实 models 行 veo3.1-fast-ext（veo3.1-fast）；veo3.1-quality-ext / -lite-ext 删自映射（各自已有 models 行，直查命中、价格不变） | 估价（8 秒 720p）：fast-ext 0.14 USD（修前落分类兜底价）、quality-ext 4.5、lite-ext 0.3；tests/test_credits.py::test_veo_ext_aliases_resolve_to_real_models |
| ④ | catalog 漏收 54 条（§5） | 按上游 category 补：chat 39 + image 8 + video 4 + audio 2 + hidden 1（其中 2 条转写、1 条审核按②归位，所以 chat 比 42 少 3）；有文档页的 6 条写参数摘要，其余 notes 统一「仅上游清单/无独立文档页（2026-11-27）」 | catalog 现 231 条（chat 81 / image 73 / video 69 / audio 7 / hidden 1），跨桶无重复；上游 2026-11-27 实测 263 条，54 条逐条仍在列且 category 未变 |
| ⑤ | thinking.py 8 个上游不存在的 ID（§3.6） | 从 THINK_MODEL_LEVELS / THINK_MODEL_NO_THINK 摘掉，集中进 THINK_MODEL_LEGACY_GHOST_IDS（标注历史兼容、上游无此 ID），不再参与解析；真实条目档位未动 | tests/test_think_level_protocol_updates.py::test_legacy_ghost_ids_are_not_in_truth_table（60 passed） |
| ⑥ | 参考上限硬截断 9/3/3（U23） | APIMart 通用视频分支改读该模型能力表 ref_max / video_ref_max / audio_ref_max（没声明回落 9/3/3）；能力表按文档改：apimart-zoe 30/10/10、seedance-2-5 30/10/10、magi-2 10/5/5；/api/model-caps 读同一张表自动同步 | mock 实测：zoe 传 12 张 → 请求体 12 条、magi-2 传 7 张 → 7 条、未声明模型传 12 张 → 9 条；tests/test_apimart_mock_upstream.py::test_reference_limits_follow_caps_table |

**仍是未知 / 未做**

- 30/10/10 与 10/5/5 只是「按文档放开」，上游是否真照收超限请求没有付费实测（U23 未闭环）；被拒时回退点只有能力表这一处（提交分支读表）。
- catalog 新增的 48 条只有上游清单、没有参数文档（notes 已标），能不能真调通未知；有文档页的 6 条也只抄了文档字段，没有别的证据。
- thinking.py 里 gpt-5-chat-latest / gpt-5.2-codex / gemini-2.5-* 的显式档位条目仍在（本轮按①的口径只动 catalog + 价目，没扩到 thinking 表里这几个已下线 ID）。
- 完整改动文件、真实测试输出、发版文案与格式说明见 docs/待推送清单.md 的「后端收口（2026-11-27）」小节。

