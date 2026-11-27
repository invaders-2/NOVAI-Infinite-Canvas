# APIMart 文档增量报告（2026-11-26 版）

> 基线：`docs/apimart-docs/` 现有数据层（`catalog.json` 183 条 / `params.json` 19 条 / `REPORT-DELTA-20261125.md` / `CAPS-CONTRACT-20261125.md` / `CATEGORY-AUDIT-20261126.md`）、`main.py` 的 `APIMART_*_MODEL_CAPS` 与 `APIMART_BUILTIN_MODEL_IDS`、`server/protocols/*.json`（v1–v7）、`server/credits/apimart_pricing.json`（352 条）。
> 新语料：`/tmp/apimart-llms-20261126.txt`（https://docs.apimart.ai/llms-full.txt），**2539863 bytes / 92372 行 / 197 个 Source 锚点，sha256 8b9f661c…e076c**。下文 L#### 全部指该文件行号。
> 旧语料：`/tmp/apimart-llms-20261125.txt`，2528392 bytes / 92103 行 / 196 页，sha256 0393fa48…eab82。
> 定价页：`/tmp/apimart-pricing-20261126.html`（1660662 bytes）对照 `/tmp/apimart-pricing-20261125.html`（1659028 bytes）。
> 上游模型表：`GET https://api.apimart.ai/v1/models?expand=category` → 263 条（`/tmp/apimart-models-20261126.json`，49330 bytes，今日 18:04 实拉）；对照今日 11:16 的 262 条快照（`/tmp/apimart-models-upstream-20261126.json`，49129 bytes，与 11-25 报告口径的 262 条完全一致）。
> 定价接口：`GET https://apimart.ai/api/pricing/model?model=magi-2`（免鉴权，200）。
> **"新增"口径**：新语料 / 新定价页 / 上游模型表里出现、但既有数据层里没有记录的项；不确定一律写"未知"。
> **本轮先说清一件事**：昨天报告推断"269 行净增 → 大概率还有已存在页面的正文改动"。逐页 diff 的结论是**没有**：269 行净增 100% 来自新页 magi-2，另有 1 页被整体搬家但内容逐字节相同。证据见 §1。

---

## 0. 一句话结论

1. **正文层面的真增量只有 1 个视频模型 `magi-2`（1 个新页）**。已有 196 个共有页里 **0 页正文/参数表发生变化**（196 个共有页 difflib ratio 全为 1.0；其中 1 页整体搬家、1 页被挤位移，内容逐字节相同，见 §1.2）。
2. **行数账目对得平**：92103 + 269 = 92372，而 magi-2 页正好 269 行（L40642–L40910），搬家净变化 0。这条账目本身就是"没有第二个改动"的证明。
3. **上游模型表 262 → 263，只加 `magi-2`（category=video）**，视频 62→63；没有消失的模型；262 个共有 ID 的字段级 diff **0 处变化**。
4. **magi-2 是"固定 1080p + 4–30 秒 + 默认带声音"的统一入口模型**：支持文生视频 / 首尾帧 / 参考图·视频·音频混合参考；有三个我们代码里**完全没有通道**的新协议面：`nsfw_check`（内容审核开关）、`omni_reference_task_type: reference` 的 10 图合并上限、以及 `first_frame_image` / `last_frame_image` 专用帧字段（L40780–L40806、L40741–L40746、L40788–L40794）。
5. **协议侧要动代码的是 1 组 / 3 条**（P1 `nsfw_check`、P3 参考上限 10/5/5 与我们 9/3/3 截断的矛盾、P4 modes 不能含 edit/extend）；其余既有协议页（webhook / 上传 / 用量 / 定价 / expand / 缓存 / 草稿 / MJ 视频 / 帧控制）**全部字节级未变**，本轮 0 条新协议。
6. **定价：新增 1 档（magi-2 `$0.08/秒`，单档 per_second），既有 61 条图像详表 0 处价格变动，索引 238 个共有行 0 处价格变动**；另有 3 行 LLM 展示名从"日期快照"改成"基础 ID"（同价，见 §6.3）。
7. **两个上一轮的待办已经在代码里落地了**（本轮复核确认，别重复派工）：任务查询已带 `?language=zh`（`main.py:28957`）、上传已带 `?retention_days=3`（`main.py:14030`）；`tools/apimart_pricing.py` 的 `parse_index` 也已按 h2+h3+li 新版页面结构重写。
8. **昨天两份文档的遗留未知，本轮解答 1 条、部分解答 5 条、仍未解答 4 条**（U18 已彻底解决：现在有 11-25 与 11-26 两份语料，页级 diff 可复现）；54 条漏收里本轮文档新增确认 **0 条**，但**新增 1 条硬漏收**（magi-2）。

---

## 1. 页面集合差与逐页 diff（给方法，可复核）

### 1.1 做法

1. 按 `Source: <URL>` 锚点切页；页的起点是紧贴锚点之前的 `#` 标题块（llms-full.txt 的格式是"标题块在前、Source 在后"），终点是下一页标题块之前。新语料 197 页、旧语料 196 页，首行 L5、末行分别 L92372 / L92103，**无重叠无缺口**。
2. 对同 URL 的页做 `difflib.SequenceMatcher(autojunk=False)` 行级 diff，记录 opcode + 新语料行号。
3. 再做一次**全文件 unified diff** 作为交叉验证（不依赖切页逻辑），逐个 hunk 归类。
4. 两路结果必须一致，再用"行数账目"第三次验证。

脚本：`/tmp/delta_1126/split2.py`（切页 + difflib）、`/tmp/delta_1126/pricing_diff.py`（定价页）；中间产物 `/tmp/delta_1126/pagediff.json`、`/tmp/delta_1126/global.diff`。

### 1.2 结论：+1 页（magi-2）+ 1 页搬家（kling-v3-omni）

| 类型 | 页 | 旧语料行 | 新语料行 | 说明 |
| - | - | - | - | - |
| **新增页** | `videos/magi-2/generation` | — | **L40642–L40910（269 行）** | 唯一新页 |
| **搬家（内容相同）** | `videos/kling-v3-omni/generation` | L39944–L40623（680 行，索引 76） | **L83010–L83689（680 行，索引 167）** | 从"kling-v2-6-motion-control 之后"挪到"grok-imagine/official 与 kling-v4-flash 之间"；**680 行逐字节相同**，只换位置 |
| 连带位移 | `videos/kling-v3/generation` | L40624–L41321 | L39944–L40641 | 只是被前面的搬家挤上去了，内容相同 |
| 无变化 | 其余 194 页（另加上述 2 页本身内容也相同） | — | — | difflib ratio = 1.0（完全相同） |

全文件 diff 只有 3 个 hunk，逐个对上：

| hunk | 旧起 | 新起 | 内容 | 归类 |
| - | - | - | - | - |
| 1 | L39937（690 行） | L39937（10 行） | 搬走 kling-v3-omni 页（680 行）+ 标题块 | 搬家 |
| 2 | L41317（8 行） | L40637（277 行） | 插入 magi-2 页（269 行）+ 标题块 | 新增页 |
| 3 | L83416（8 行） | L83005（688 行） | 在 grok-imagine 之后插入 kling-v3-omni 页 | 搬家落点 |

**行数账目**：92103（旧）+ 269（magi-2）= 92372（新）✓。搬家的"搬走 690 / 插入 688"差 2 行是两侧标题块与空行对齐差异，落在 kling-v3 与 grok-imagine 两页的边界上，不构成内容变化（这两页 difflib 也是完全相同）。

### 1.3 为什么可以确认"不是漏看"

- 197 个锚点全部参与比较，没有任何抽样；
- 两套互相独立的比较方法（切页 difflib + 全文件 unified diff）结论一致；
- 行数账目闭合（+269 = 新页行数）；
- **活站复核**：`https://docs.apimart.ai/en/api-reference/videos/magi-2/generation` 今日 200（536214 bytes），关键串 `omni_reference_task_type` / `first_frame_image` / `last_frame_image` / `nsfw_check` / `combined limit of 10` 全部命中且与语料一致 → 这份语料不是昨天的缓存副本，新页确实是今天上线的。

---

## 2. 模型增量（上游 `/v1/models?expand=category`）

| 项 | 11-25 口径（今日 11:16 快照复现） | 11-26 18:04 实测 | 变化 |
| - | - | - | - |
| 总数 | 262 | **263** | +1 |
| chat | 126 | 126 | 0 |
| image | 63 | 63 | 0 |
| video | 62 | **63** | **+1** |
| audio | 5 | 5 | 0 |
| unknown（上游没给分类） | 6 | 6 | 0 |

- **新增**：`magi-2`（category=video；`capability_tags` = Text to Video / Image to Video / Video to Video；`supported_endpoint_types` = [openai]；`owned_by` = custom；`created` = 1626777600 与其它条目一致的占位值）。
- **消失**：无（`set(morning) - set(now)` = 空集）。
- **字段级变化**：262 个共有 ID 逐一比较所有字段（category / capability_tags / supported_endpoint_types / owned_by 等），**0 处不同**。所以本轮没有任何"模型被悄悄改分类/改能力位"的情况。
- 对照定价页声明数：239 → **240**（图像 59 / 视频 61→**62** / LLM 116 / 音频 3），与新模型一一对应，没有"定价页多出但模型表没有"或反过来的情况。

---

## 3. 新模型 `magi-2` 全参数（唯一真增量，L40642–L40910）

出处一句话：`MAGI-2 is a video generation model from Sand AI`（L40717）。

| 项 | 文档原文 | 证据 |
| - | - | - |
| 入口 | `POST https://api.apimart.ai/v1/videos/generations`，异步，读 `data[0].task_id`，再轮询任务接口 | L40645、L40705–L40715、L40717 |
| 一句话能力 | 文生 / 首尾帧 / 图·视频·音频参考；**固定 1080p、4–30 秒、默认带声音** | L40646 |
| 三种模式 | Text-to-video（只给 prompt）/ Image-to-video（`image_urls` 首帧+可选尾帧，或专用帧字段）/ Reference-to-video（给了 `video_urls`、`audio_urls` 或 `role: reference_image` 就自动进参考模式） | L40723–L40736 |
| `model` | 固定 `magi-2` | L40737–L40739 |
| `nsfw_check` | **boolean，默认 false**；true 时用 `omni-moderation-latest` 先审 prompt 与输入图；false/省略 = 不请求审核、**不产生审核成本与延迟** | L40741–L40746 |
| `prompt` | 三种模式都必填，**上限 15000 字符**；对白放引号里 | L40748–L40750 |
| `duration` | integer，**4–30 整秒，默认 5**；显式 `0` / 小数 / 越界一律 **HTTP 400**；省略=默认 | L40752–L40754 |
| `seconds` | `duration` 的**别名**；两个都发则**必须相等** | L40756–L40758 |
| `resolution` | **只支持 1080p**（默认也是 1080p）；别的值 400 | L40760–L40762 |
| `aspect_ratio` | 文生/参考生：`16:9`（默认）/ `9:16` / `1:1` / `4:3` / `3:4` / `21:9`；**图生视频只支持前五个，不含 21:9**；省略或 `auto` = 跟随首帧比例；输出恒定 1080p | L40764–L40766 |
| `generate_audio` | boolean，**默认 true**；false = 无音轨；若同时发 `audio` 必须一致 | L40768–L40770 |
| `audio` | `generate_audio` 的**别名**，不得冲突；参考音频走 `audio_urls` | L40772–L40774 |
| `seed` | `0`–`2147483647`；省略或 `-1` = 随机；固定 seed 只让结果"更相似"，**不保证一致** | L40776–L40778 |
| `omni_reference_task_type` | **默认 auto**；只支持 `auto` / `reference`；多张图当参考时要显式 `reference`；**`edit` / `extend` 不支持** | L40780–L40782 |
| `image_urls` | 公网 HTTP(S)；**"2 张上限"只适用于图生视频**（首帧+可选尾帧）；参考模式（无视频/音频、无显式 reference 时不算）与 `image_with_roles` 里 `reference_image` **合计上限 10 张** | L40784–L40786 |
| `first_frame_image` | 公网 URL 的首帧；**与 `image_urls` 二选一** | L40788–L40790 |
| `last_frame_image` | 可选尾帧，必须配首帧 | L40792–L40794 |
| `image_with_roles` | 每项 `{url, role}`，role ∈ `first_frame` / `last_frame` / `reference_image`；图生视频最多一个首帧+一个尾帧；`reference_image` 角色即进参考模式，**与 `image_urls` 合计 ≤10** | L40796–L40798 |
| `video_urls` | **≤5 段参考视频，每段 2–30 秒，合计建议 ≤30 秒**，超了上游可能截断；**单数 `video_url` 不支持** | L40800–L40802 |
| `audio_urls` | **≤5 段参考音频，每段 2–30 秒，合计建议 ≤30 秒** | L40804–L40806 |
| 输入要求 | 必须公网可直下；登录墙/防盗链/下载失败会让任务失败；本地文件先走 uploads 拿 URL | L40808–L40810 |
| 三种请求示例 | 首尾帧 / 纯图参考 / 图+视频+音频混合参考 | L40812–L40870 |
| 轮询结果字段 | `data.status`（pending/processing/completed/failed）、`data.progress` 0–100、`data.result.videos[0].url`、`data.error.message`；**没有 `billing_status` / `cost` 字段** | L40872–L40887 |
| 明确 400 的参数 | `mode`、`negative_prompt`、`watermark: true`、`camera_control`、`multi_shot` / `multi_prompt`、`element_list`、`video_list`、`voice_list`、`audio_setting`、中间 `keyframe`、`omni_reference_task_type` 的 `edit`/`extend`、单数 `video_url`、非 1080p 的 `resolution` | L40889–L40891 |
| 错误对照表 | 12 条，含 `duration must be between 4 and 30 whole seconds`、`duration (5) and seconds (6) are aliases and must match`、`accepts at most 10 reference images / 5 videos / 5 audios`、`always outputs 1080p`、`audio (true) and generate_audio (false) are aliases and must match` | L40893–L40904 |

**没有的东西（别照抄其它 kling/seedance 的假设）**：没有草稿/两段式、没有视频编辑或延长、没有关键帧、没有 webhook 专段、没有计费/价格段（价格只能从定价页/定价接口拿）。

---

## 4. 已有页面的参数变化：0 条（附昨天的重点复核清单）

"整页字节级相同"比"逐字段核对"更强，所以下表每行都是**整页相同**，给的是新语料页范围：

| 昨天报告关注点 | 本轮结论 | 证据（新语料页） |
| - | - | - |
| kling-v4-image（2K/4K/8K、n 1–9、系列模式） | 无变化 | L10192–L10506 |
| kling-v4-long-image（skill / length / 8 计费档） | 无变化 | L10507–L10834 |
| mai-image-2.7 / -flash（13 比例、精确像素、background） | 无变化 | L11144–L11578 |
| seedream-5-5 / seedream-4.5 / seedream-5-0-flash·pro·lite | 无变化 | L26885–L27296、L23019–L28069 区段 |
| gpt-image-2.5 / 2.6 家族（svg.reasoning.effort） | 无变化 | L05064–L06765 |
| apimart-zoe（参考上限 30/10/10、草稿 24 小时） | 无变化（文档仍写 30/10/10，我们的能力表仍是 9/3/3，见 U23） | L35917–L36354（L36104 / L36118 / L36126 仍是 "Up to 30 reference images" / "Up to 10 reference videos" / "Up to 10" 音频） |
| seedance-2.5 草稿两段式 / seedance-2-5-flash 不支持草稿 | 无变化 | L45441–L46418、L45083–L45440 |
| flux-3-video（mode / draft_from_task_id） | 无变化 | L36878–L37320 |
| kling-v3 / kling-v3-omni（mode std/pro/4k、3–15 秒） | 无变化（omni 页只是搬家） | L39944–L40641、L83010–L83689 |
| veo3 三页 / wan2.5–3.0 / MiniMax-H3 四页 / Midjourney 12 页 | 无变化 | 见机读 JSON 的 `page_changes`（196 个共有页 ratio 全为 1.0） |

**所以"参数增量"这一节的诚实答案是：新增 0 个枚举值、0 个默认值变化、0 个计费档变化，全部增量都在 magi-2 这一个新页上。**

---

## 5. 协议增量

### 5.1 既有协议页：全部字节级未变（结论 + 页范围）

| 区域 | 页 | 新语料行 | 本轮变化 |
| - | - | - | - |
| webhook / 回调 | `tasks/webhook` | L79280–L79604 | 无 |
| 任务查询（含 `?language=`） | `tasks/status` | L78764–L79279 | 无 |
| 上传 图片/音频/视频（含配额头、retention） | `uploads/images` L79849–L80092、`uploads/audios` L79605–L79848、`uploads/videos` L80093–L80336 | 同左 | 无 |
| 账户用量 / 请求日志 | `account/usage` L54025–L54356、`account/request-logs` L53368–L53627 | 同左 | 无 |
| 定价接口 | `texts/qwen3.8-max/pricing` | L35662–L35916 | 无 |
| 模型列表 expand / schema | `texts/models/list` | L33599–L33788 | 无 |
| 上下文缓存（Gemini / Claude / OpenAI） | L28882–L29295、L31853–L32232、L33789–L33960 | 同左 | 无 |
| 草稿（seedance-2.5 两段式、flux-3-video） | L45441–L46418、L36878–L37320 | 同左 | 无 |
| MJ 视频 | `images/midjourney/video` | L19883–L20522 | 无 |
| 新增端点 | — | — | **无**（197 页锚点集合与 196 页只差 magi-2 一个） |

### 5.2 magi-2 页带来的协议面（P1–P6，这才是本轮要动的）

| # | 项 | 文档现值 | 证据 | 我们现状 | 要不要动 |
| - | - | - | - | - | - |
| **P1** | `nsfw_check` 语义 | boolean 默认 false；true 才发 `omni-moderation-latest` 审核，**false/省略不产生审核成本与延迟**；作用范围是 prompt + 输入图 | L40741–L40746 | `main.py` 只在注释里提过 `nsfw_check`（L29159 是 seedance-2-5-flash 的能力表注释），**能力表没有该键、请求体也不拼接** | **要动**：能力表加 `nsfw` 位 + body 按需拼（默认不发） |
| **P2** | 专用帧字段 `first_frame_image` / `last_frame_image` | 与 `image_urls` **二选一**；尾帧必须配首帧 | L40788–L40794 | 我们只走 `image_urls` / `image_with_roles` 两条路（`main.py` 统一入口组装：`image_with_roles` L31035、`image_urls` L31037、`video_urls` L31044），没有发专用字段的分支；功能上能用 `image_with_roles` 等价表达（role=first_frame/last_frame） | 可选：写进能力表备注即可，不急于加分支 |
| **P3** | 参考上限 10 图 / 5 视频 / 5 音频 | 参考模式下限 10（`image_urls` 与 `image_with_roles` 的 `reference_image` **合计**）；视频 ≤5、音频 ≤5，各 2–30 秒、合计建议 ≤30 秒 | L40786、L40796–L40806 | 通用分支硬截断 `image_payload[:9]` / `video_payload[:3]` / `audios[:3]`（截断点 L31037 / L30909 / L31053，注释 L29138、L29420） | **要动**：与 apimart-zoe 同一个坑（U23）。二选一——(a) 诚实写法 `ref_max=9 / video_ref_max=3 / audio_ref_max=3`；(b) 放开截断到 10/5/5 并实测 |
| **P4** | `omni_reference_task_type` 的另一半 | magi-2 只收 `auto` / `reference`；**`edit` / `extend` 传了 400**，该模型不支持视频编辑与延长 | L40780–L40782、L40889–L40891 | 统一入口已支持 `omni_task_type`（L31024–L31029，按 mode 映射 reference/edit/extend） | **要动**：能力表 `modes` 不能写 video_edit / video_extend，否则编辑器会放出这两个入口、上游 400 |
| **P5** | `duration` + `seconds` 别名、`generate_audio` + `audio` 别名 | 别名必须一致，否则 400；`duration` 是 **4–30 连续整秒**（不是 5/10 两档），默认 5 | L40752–L40758、L40768–L40774、L40899–L40904 | 能力表已有 `duration: (min, max)` 连续区间与 `audio_field` 机制（`seedance-2-0` / `apimart-zoe` 用过） | **不用改代码**，写对 caps 即可（`duration: (4,30)`、`audio_field: "generate_audio"`、`audio_default_on: True`） |
| **P6** | 帧控制比例约束 | 图生视频**不含 21:9**；省略或 `auto` = 跟随首帧 | L40764–L40766 | 能力表有 `ratio_follows_first_frame`（kling-v4 / v4-flash 用过，配合 `apimart_omit_ratio` 分支） | **不用改代码**：给 magi-2 打开该位，首帧模式就不发画幅 → 既不会撞 21:9 的 400，也符合"跟随首帧" |

### 5.3 上一轮协议待办：已在代码里落地（复核确认，别再派工）

| 昨天报告项 | 昨天状态 | 本轮实测代码 | 结论 |
| - | - | - | - |
| D8 任务查询 `?language=zh` | "不带，建议接" | `main.py:28957` `f"{task_path}?language=zh"`；音乐任务另见 `main.py:27880` | **已接** |
| D10 / I11 上传 `retention_days` | "不传，P0 计费风险，未改" | `main.py:14018–14031`：`apimart_upload_retention_days()` + 统一把 `?retention_days=3` 拼到上传 URL；`14035–14076` 还按响应 `expires_at`/`retention_days` 做缓存 TTL | **已接** |
| I9 定价页解析器（h2+h3+li 结构） | "parse_index 解析 0 行" | `tools/apimart_pricing.py:196` `parse_index` 已按 h2 总表 + 4 个 h3 分组 + `<li>` 行重写（`184` 是分组头正则） | **已改** |

---

## 6. 定价增量

### 6.1 页面索引：239 → 240，只有 magi-2，无价格变动

- 页面声明：**全部 240 个 AI 模型起步价**（图像 59 / 视频 **62** / LLM 116 / 音频 3）；昨天是 239（视频 61）。
- 索引行集合差：**新增 1 行** `视频 MAGI-2 = $0.08/秒`；**0 行价格发生变化**（238 个共有行逐一比较价格文本，全部相同）。

### 6.2 图像详表（initialCatalog）：61 条，0 处变化

逐模型比对 `fixed_prices.items[]` 的 `key / original_price / after_discount / member_prices{diamond,gold,platinum}`、`size[]`、`member_saving_percent`：**61 条全部相同，0 处改动**。昨天报告 §7.3 的解析配方照样可用，只是 RSC 里 initialCatalog 的字符位置从第 122342 挪到 123668（整页变长所致），**别写死偏移**。

### 6.3 3 行 LLM 展示名从"日期快照"改成"基础 ID"（同价，但影响价目查表）

| 昨天（11-25 页） | 今天（11-26 页） | 价格 |
| - | - | - |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 输入 $0.8 / 输出 $4（每 100 万 token），**未变** |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` | 输入 $2.4 / 输出 $12，**未变** |
| `claude-opus-4-5-20251101-thinking` | `claude-opus-4-5,claude-opus-4-5-20251101-thinking`（一行列两个） | 输入 $4 / 输出 $20，**未变** |

含义：定价页现在把**基础 ID**（`claude-haiku-4-5` / `claude-sonnet-4-5` / `claude-opus-4-5`）当在售条目摆出来了，而上游 `/v1/models` 里**基础 ID 与日期 ID 都在**（两组 6 个 ID 全部存在，tags 一致）。我们价目里只有日期版（3 条在 `models`，且 `alias_map` 是自映射）→ **基础 ID 查不到价**。这正好落在体检 §3.4 的"自映射"与 §5 的"42 个 chat 待补"上。

### 6.4 magi-2 实测价（免鉴权定价接口）

`GET https://apimart.ai/api/pricing/model?model=magi-2` → `billing_type = per_second`，`model_price = paid_price = 0.08`（gold），`default_spec = default`（**无 resolution 分档**，因为只有 1080p），会员系数 `gold 1 / platinum 0.95 / diamond 0.9`：

| 档 | 标价 | gold（实付） | platinum | diamond |
| - | - | - | - | - |
| 1080p（唯一档） | 0.08 USD/秒 | **0.08** | 0.076 | 0.072 |

### 6.5 既有价目缺口（不是本轮变化，但会卡住执行岗）

用今天的定价页索引（239 行 / 242 个 ID）逐个去 `server/credits/apimart_pricing.json`（352 条 + 820 条 alias_map）查表：**24 个页面在售 ID 查不到价**。本轮新增的只有 `magi-2`，其余 23 条是既有缺口，例如 `apimart-zoe`（$0.0544/秒）、`kling-v4-flash`（$0.0571/秒）、`gpt-image-2.6` 家族、`gemini-omni-1.2-flash(-ext)`、`minimax-h3-image(-highspeed)`、`muse-image-ext` / `muse-video-ext`、`gpt-6.x` 家族（`gpt-6.1-terra` / `gpt-6.2-astra` / `gpt-6.2-sol`）、`gemini-4-carbon/hydrogen/neon`、`claude-fable-5.2`、`qwen4-max`、`claude-*-4-5` 三种基础 ID。完整清单见机读 JSON 的 `pricing_changes` 里 `id = "price_missing_*"` 的条目。

---

## 7. 对我们代码的影响点（给执行岗照着改）

| # | 位置 | 现状 | 本轮要做什么 |
| - | - | - | - |
| **I1** | `main.py:29083` `APIMART_VIDEO_MODEL_CAPS` | 没有 `magi-2` 这条 key | 新增一条（参考 `seedance-2-5-flash` / `kling-v4` 写法）：`duration: (4, 30)`（默认 5）、`ratio_key: "aspect_ratio"`、`ratios: ("16:9","9:16","1:1","4:3","3:4","21:9","auto")`、`resolution_key: "resolution"`、`resolutions: ("1080p",)`、`generate_audio: True` + `audio_field: "generate_audio"` + `audio_default_on: True`、`watermark: False`、`seed: True`、`image_with_roles: True`、`video_urls: True`、`audio_urls: True`、`omni_task_type: True`、`ratio_follows_first_frame: True`、`ref_max: 9 / video_ref_max: 3 / audio_ref_max: 3`（**按现有截断写，别写 10/5/5**，见 I3）、`modes: ("text_to_video","image_to_video","start_end_to_video","reference_to_video")`（**不要 video_edit / video_extend**） |
| **I2** | `main.py:25595` `APIMART_BUILTIN_MODEL_IDS["video"]` | 没有 `magi-2` | 加 `magi-2: ("magi-2",)`，否则 `include_builtin=1` 时编辑器清单里看不到它 |
| **I3** | 通用视频分支（`image_payload[:9]` L31037 / `video_payload[:3]` L30909 / `audios[:3]` L31053，注释在 L29138、L29420） | 文档 10 图 / 5 视频 / 5 音频，我们静默截断成 9 / 3 / 3 | 与 apimart-zoe 的 U23 同一个坑。本轮先**按 9/3/3 写 caps**（诚实版），把"放开到 10/5/5"并入 U23 一起实测后再改 |
| **I4** | `nsfw_check` | 能力表没有该键，请求体不拼 | 加 caps 位（如 `nsfw: True`）+ body 拼接：只在用户显式打开时发 `nsfw_check: true`，默认**不发** |
| **I5** | `server/credits/apimart_pricing.json` | 没有 `magi-2` | 加一条 `billing: per_second`、单档 `spec: "1080P"`、`gold 0.08 / platinum 0.076 / diamond 0.072`（`credits = usd × 10`，与同文件其它条目一致），`source` 标成 `api:pricing/model@2026-11-26` |
| **I6** | `docs/apimart-docs/catalog.json` video 组（现 65 条） | 没有 `magi-2` | 加一条：`id: "magi-2"`、`name: "MAGI-2"`、`efforts: []`、`notes` 抄 §3 的参数摘要、`source_url: "https://docs.apimart.ai/en/api-reference/videos/magi-2/generation"` |
| **I7** | `docs/apimart-docs/params.json`（现 19 条：image 14 / video 5） | 没有 `magi-2` | 加一条 `kind: "video"` 的参数条目，字段按 §3 填；语料基准写 `doc_corpus_20261126`（sha256 8b9f661c…） |
| **I8** | `server/protocols/protocol_updates.json`（v1–v7） | 最新 v7（2026-11-25 第二轮） | 加 **v8（2026-11-26）**：`new_models.video = ["magi-2"]`、`protocol_changes` 收 P1 / P3 / P4 / P6、`parameter_changes` 记 magi-2 的 duration 4–30 与固定 1080p |
| **I9** | 前端编辑器视频参数面板 | 通用形态"分辨率 + 时长 + 比例 + 参考图" | magi-2 要补：**时长 4–30 连续滑杆（默认 5）**（不是 5/10 两档）、**比例 6 个 + auto**、**分辨率只给 1080p 或直接隐藏**（写别的值 400）、**首尾帧 / 参考模式切换**（参考模式参考图 ≤10）、**参考视频 ≤5 / 参考音频 ≤5（各 2–30 秒、合计 ≤30 秒）**、**声音开关（默认开）**、可选 `nsfw_check` 开关（标注会增加审核延迟/成本） |
| **I10** | 价目查表 | 24 个在售 ID 查不到价（含 magi-2） | 至少补 `magi-2`；其余 23 条见 §6.5，建议单独一轮修（不是本轮 delta 的锅） |
| **I11** | `docs/apimart-docs/REPORT-DELTA-20261125.md` 的 U23 / `CATEGORY-AUDIT-20261126.md` | 两处都只记了 apimart-zoe 的 9/3/3 vs 30/10/10 | 交叉引用：magi-2 是同一类问题的第二个样本，写进 U23"证据增至 2 个模型" |

---

## 8. 交叉核对：昨天两份文档的遗留未知 + 54 条漏收

### 8.1 U18–U28 状态

| # | 项 | 本轮状态 | 说明 |
| - | - | - | - |
| U18 | 11-18 语料的页面级增删无法比较 | **已解答（机制层面）** | 现在 11-25 与 11-26 两份语料都在（sha256 已记），逐页 diff 已跑通，本轮"0 页正文变化"就是靠这个得出的。后续每轮把语料按日期留档即可 |
| U19 | 7 个"仅定价页"chat 模型能否调用 | **部分解答（证据升级）** | 7 个 ID **全部在上游 `/v1/models`**，`category=chat`、`capability_tags=["Text","File"]`（`gemini-4-carbon/hydrogen/neon`、`gpt-6.2-astra/sol`、`claude-fable-5.2`、`qwen4-max`）。它们不是"定价页上的幽灵"，已进模型注册表；**能否真调通仍未验证**（本轮不发付费请求） |
| U20 | `claude-fable-5 / 5.1 / 5.2` 命名可疑 | **未解答** | 本轮无新证据，定价页继续按 $6.4 / $32 在售 `claude-fable-5.2` |
| U21 | `POST /v1/tasks/batch` 完整契约 | **未解答** | 相关页字节级未变，仍只有三处一句 TIP，无请求/响应/错误码 |
| U22 | `billing_status` 是否全平台 | **部分解答（反向证据 +1）** | magi-2 的任务结果字段只有 `status/progress/result/error`（L40882–L40887），**没有 billing_status / cost**。目前只有 kling-v4-long-image 一页出现过，倾向"非全平台" |
| U23 | apimart-zoe 参考上限真实值（9/3/3 vs 30/10/10） | **未解答（样本 +1）** | magi-2 文档写 10/5/5、我们代码截断 9/3/3，同类矛盾第二个模型。仍要实测超限请求 |
| U24 | 两个 veo 降价是否长期 | **部分解答（弱正向）** | 定价页索引 238 个共有行**0 处价格变动**（含 veo 三档），稳定性 +1 天；仍不足以定论 |
| U25 | `seedance-1-5-pro` 是否官方下线 | **证据升级（三处同时缺）** | 文档 0 命中（页已删）+ 定价页 62 个视频模型里没有 + **上游 `/v1/models` 也没有**。建议 catalog notes 从"疑似下线"改成"上游无此 ID，按已下线处理（保留条目，先不删）" |
| U26 | token 计费图像模型怎么进价目 schema（mai-image-2.7） | **未解答** | 无新文档，schema 口径仍待产品定 |
| U27 | `retention_days` 默认档 | **已在代码侧绕开（部分解答）** | 我们固定传 `retention_days=3`（`main.py:14030`）+ 读响应 `expires_at` 做缓存，所以"默认档是多少"不再影响成本；控制台那个默认值仍未验证 |
| U28 | 没跑真机生成调用 | **仍未跑（维持）** | 本轮只做了 3 个只读实测（`/v1/models`、`/api/pricing/model`、docs 页面 200），0 次生成请求、0 花费 |

另外，昨天报告 §3.2 的 `imagen-4.0-apimart`：本轮补充证据——**它在上游 `/v1/models` 里确实存在**（category=image），而文档 197 页 0 命中 → "文档删了、还在卖"从"定价页证据"升级为"模型表证据"。catalog 不要删。

### 8.2 54 条漏收：本轮文档新增确认 0 条，新增 1 条硬漏收

- **确认 0 条**：已有 196 页正文 0 变化，本轮文档不可能给那 54 条提供任何新参数证据。
- **新增 1 条硬漏收**：`magi-2`——上游 `/v1/models`（video）+ 独立文档页（L40642–L40910）**双向确认**，且我们 catalog / 能力表 / 内置清单 / 价目 / params / 协议包**六处全无**。这是本轮唯一"必补"的漏收，优先级最高（证据最硬：既有上游注册又有参数页）。
- 定价页侧新增的 3 个基础 ID（`claude-haiku-4-5` / `claude-sonnet-4-5` / `claude-opus-4-5`）**落在体检 §5"值得补的 42 个 chat"里**；本轮新增的是"定价页现在按基础 ID 摆卖"这一条证据，可用来决定补录时用基础 ID 还是日期 ID。

---

## 9. 未知 / 未做

| # | 项 | 现状 | 怎么解 |
| - | - | - | - |
| N1 | magi-2 真实出片质量/耗时/是否真按秒计费 | 只有文档 + 定价接口 | 用真 key 打一次 5 秒与 30 秒各一单，核对扣费（0.08 × 秒数） |
| N2 | `nsfw_check: true` 的实际延迟/成本 | 文档只说 false 时不产生成本，true 的增量未量化 | 同一 prompt 各跑一次对比耗时与账单 |
| N3 | 参考上限 10/5/5 是否真可用（我方 9/3/3 截断是否为唯一瓶颈） | 文档写 10/5/5，我方截断 9/3/3 | 直接发 10 张参考图的请求看是否 400（与 U23 同批） |
| N4 | `imagen-4.0-apimart` 文档为什么删 | 上游模型表在、文档无页 | 问官方；短期按"文档缺失但在售"处理 |
| N5 | `seedance-1-5-pro` 是否彻底下线 | 文档 + 定价页 + 上游模型表三处都无 | 用 key 发一次，看是否 model_not_found |
| N6 | 3 个 claude 基础 ID 与日期 ID 是否等价计价 | 上游两个 ID 都在、定价页改成基础 ID | 定价接口分别查 6 个 ID 比价；本轮只查了 magi-2（避免连发触发限流） |
| N7 | 本轮没跑真机生成 | 只读分析 | 与前几轮一致（U28） |

---

## 10. 一句话结论 + 必改清单

**一句话结论：2026-11-26 版文档相对 11-25 版只有一个真增量——新视频模型 `magi-2`（1 页 269 行、上游模型表 262→263、定价 $0.08/秒 单档），其余 196 页正文与全部既有协议/定价档位 0 变化；所以本轮该做的就是把这一个模型从能力表、内置清单、catalog、params、价目、协议包六处补齐，并把"参考上限截断"和"nsfw_check 无通道"这两个通用硬伤排期修掉。**

### 后端（按顺序）

1. **I1** 能力表加 `magi-2`（含 duration 4–30、固定 1080p、`audio_default_on`、`ratio_follows_first_frame`、`ref_max 9/3/3`、modes 不含 edit/extend）→ `main.py:29083`
2. **I2** 内置清单 video 组加 `magi-2: ("magi-2",)` → `main.py:25595`
3. **I5** 价目加 `magi-2`：per_second / 1080P / gold 0.08、platinum 0.076、diamond 0.072 → `server/credits/apimart_pricing.json`
4. **I8** 协议包加 v8（new_models.video + P1/P3/P4/P6）→ `server/protocols/protocol_updates.json`
5. **I4**（可同批）给 `nsfw_check` 加 caps 位与 body 拼接，默认不发
6. **I3 / U23**（单独一轮，需实测）参考上限截断：zoe 30/10/10 与 magi-2 10/5/5 一起放开或一起写成诚实值

### 前端（参数面板）

7. **I9** magi-2 面板：时长 4–30 连续（默认 5）、比例 6 + auto、**分辨率只给 1080p 或直接隐藏**、首尾帧/参考模式切换、参考视频 ≤5 / 音频 ≤5（2–30 秒、合计 ≤30）、声音默认开、可选 nsfw 开关（标延迟/成本提示）
8. 若视频面板对所有模型都显示"分辨率"下拉，magi-2 必须收敛成只剩 `1080p`，避免用户传 4k 直接 400

### 文档 / 数据

9. **I6** `catalog.json` video 65→66 加 `magi-2`（notes 抄 §3）
10. **I7** `params.json` 加 `magi-2`（`kind: video`，语料基准 `doc_corpus_20261126`）
11. **I11** U23 补"样本 2"；`seedance-1-5-pro` 的 notes 按 U25 升级为"上游无此 ID"
12. 定价缺口 24 条（含 magi-2）单列一张待办，不混进本轮 delta
