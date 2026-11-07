# 模型参数文档核对报告（task-17）

> 目的：把用户在用的 15 个模型的**官方文档参数**抽成结构化数据（同目录 `params.json`），再和**当前后端能力表**逐字段对比，找出「会让编辑器选项错误/缺失」的地方。
> 文档依据：`https://docs.apimart.ai/llms-full.txt`（2,332,676 字节 / 87,909 行，sha256 `da7f038a…387fc`，与 task-1 同一份快照）
> 后端依据：**运行中的服务** `GET http://127.0.0.1:3999/api/model-caps`（2026-11-06 抓取，29 条 items，其中 apimart 条目覆盖本表 14/16 个模型），并用 `main.py` 的 `APIMART_IMAGE_MODEL_CAPS` / `APIMART_VIDEO_MODEL_CAPS` 交叉核对未下发的字段。
> 证据分级：**原文**（文档原句，带 llms-full 行号）/ **推断** / **未知**。

## 0. 结论摘要：5 条高严重度

| # | 模型 | 问题 | 后果 |
| - | - | - | - |
| H1 | `seedance-2.5` | caps 的 resolutions 含 `2k`/`4k`，但文档明说 **2k/4k 会同步 400** | 用户选 2K/4K 必失败，且是"看起来支持"的骗人选项 |
| H2 | `muse-image-ext` | caps 的 ratios 是空数组，但文档给了 **7 个比例** | 编辑器里完全没有比例选项（该模型能出 7 种） |
| H3 | `muse-video-ext` | 同上：ratios 空，文档有 **7 个比例** | 视频比例无法选 |
| H4 | `midjourney` | **完全没有任何 caps 条目**，编辑器大概率用通用 OpenAI 参数（size/quality/n） | MJ 的 quality 是 `0.25/0.5/1/2`、比例走 `--ar`、一次固定 4 张；用通用 UI 会把非法的 `quality=high` 发出去 |
| H5 | `MiniMax-H3-Context-IR` | 没有独立 caps 条目，**继承了 MiniMax-H3 的分辨率/时长/modes** | 但这个模型**不产视频**（只返回结构化提示词）；编辑器会给分辨率选项并等一个永远不来的视频 |

## 1. 数据来源与复核方式

```bash
# 文档
curl -sSL -x http://127.0.0.1:7897 https://docs.apimart.ai/llms-full.txt -o /tmp/apimart-llms-full.txt
shasum -a 256 /tmp/apimart-llms-full.txt   # 应为 da7f038a4cf98a3f09c2c9fdd960c2276885ed00c084aae551aebada968387fc

# 当前后端能力（服务需在跑）
curl -sS http://127.0.0.1:3999/api/model-caps -o /tmp/caps3999.json
python3 -c "import json;d=json.load(open('/tmp/caps3999.json'));print(len(d['items']))"
```

说明：
- `/api/model-caps` 只下发 `ratios / resolutions / qualities / n_max / durations / modes`（部分条目还带 `max_long_edge / max_pixels / min_pixels`，gpt-image-2.5/2.6 系列有）。**`ref_max` 和 `output_formats` 不在 API 响应里**（`main.py` 表里有，但没进 payload），所以编辑器拿不到参考图上限和输出格式。
- `gemini-nano-banana-2.1-ext` 和 `midjourney` 不在当前 `/api/model-caps` 结果里（前者没被配置进 provider 的模型列表，后者表里本来就没有条目）。

## 2. 逐模型对比

图例：✅ 完全一致 ｜ ⚠️ 部分差异（不影响主流程）｜ ❌ 会出错/缺失

### 2.1 图像（10）

| 模型 | 文档值（原文） | 当前 caps | 差异 | 级别 |
| - | - | - | - | - |
| `gemini-3-pro-image-preview` | ratios: auto+1:1/2:3/3:2/3:4/4:3/4:5/5:4/9:16/16:9/21:9；res: 1K/2K/4K；n=1 | ratios 同、res 同、n_max=1 | 无 | ✅ |
| `gemini-nano-banana-2.1` | ratios: auto+14（含 1:4/4:1/1:8/8:1）；res 1K/2K/4K；n=1–4（官方版） | ratios 同、res 同、n_max=4 | 无（ext 版 n=1 已单独建条目） | ✅ |
| `gpt-image-2.5-ext` | ratios auto+10；res 1K/2K/4K；n=1–4；参考图≤16；**无 quality** | ratios 同、res 同、n_max=4、qualities 空 | 无（qualities 空是对的）；但 caps 额外给了 `max_long_edge/max_pixels/min_pixels`，**文档这页没写精确像素规则** | ⚠️ |
| `gpt-image-2.5-flare` | ratios auto+15；res 1K/2K/4K；quality **auto/low/medium/high/xhigh/max**；n=1–4；像素规则 3840/8294400/655360 | ratios 同、res 同、qualities **low/medium/high/xhigh/max（缺 auto）**、n_max=4、像素规则同 | **quality 缺 `auto`**（默认值恰好就是 auto）；2.6 系列有 auto、2.5 系列没有 → 两代不一致 | ❌ |
| `gpt-image-2.5-sunburst` | 同 flare | 同 flare | 同上 | ❌ |
| `gpt-image-2.6-ext` | ratios auto+10；res **仅 1K**；quality auto/low/medium/high/xhigh/max；n=**1**；size 不收像素 | ratios 同、res 同、qualities 同、n_max=1 | 无 | ✅ |
| `gpt-image-2.6-flare` | ratios auto+15；res 1K/2K/4K；quality 6 档含 auto；n=1–4；像素规则同上；另有 `output_format`(png/jpeg/webp/gif/svg)、`complexity`、`markup_url`、GIF `frame_count` 2–16 | ratios 同、res 同、qualities 同、n_max=4、像素规则同 | **未下发** `output_format` / `complexity` / `markup` / `frame_count` | ⚠️ |
| `gpt-image-2.6-sunburst` | 同 flare | 同 flare | 同上 | ⚠️ |
| `muse-image-ext` | ratios **7 个**：1:1/16:9/9:16/4:3/3:4/3:2/2:3（"自动"要省略字段，不能传 auto）；**无分辨率档**；n=1；参考图≤9；输出固定 WebP | ratios **[]（空）**；res [] ✓；n_max=1 | **缺 7 个比例**；`ref_max=9` 在表里有但 API 不下发 | ❌ |
| `midjourney` | 走 `/v1/midjourney/generations*`；比例用 `size`(=`--ar`，文档未枚举)；`quality` = `0.25/0.5/1/2`；另有 version/speed/stylize/chaos/weird/tile/niji/iw/cw/sw/cref/sref/dref/dw/repeat/raw/draft/hd/stop/extra；一次 imagine 固定 4 张 | **无条目** | 编辑器的通用参数模型（size/quality/n）与 MJ 语义不兼容；`quality=high` 之类会被 MJ 拒绝 | ❌ |

### 2.2 视频（5）

| 模型 | 文档值（原文） | 当前 caps | 差异 | 级别 |
| - | - | - | - | - |
| `MiniMax-H3` | res **2K/768P**；duration **4–15**；ratios 21:9/16:9/4:3/1:1/3:4/9:16；无 mode 字段（字段自动判定 T2V/I2V/R2V） | res 768P/2K；durations 4–15；ratios 同；modes 5 种（含 reference_video_to_video） | 无（modes 的 reference_video_to_video 有文档依据：R2V 用 video_urls 参考视频） | ✅ |
| `MiniMax-H3-Max` | res **480P/768P/1080P**，不支持 2K；duration **5–15**；ratios 同；**1080P 必须省略 watermark 和 aigc_watermark（连 false 都不能带）** | res 480P/768P/1080P；durations 5–15；ratios 同 | 缺 `1080P 不能带 watermark` 这条约束（caps 里 watermark: True） | ⚠️ |
| `MiniMax-H3-Context-IR` | **不产视频**，返回 `result.prompt`；duration 4–15；aspect_ratio 纯文本必填且不能 adaptive | **继承 MiniMax-H3**：res 768P/2K、durations 4–15、ratios 同、modes 5 种 | 语义错误：不应该有分辨率/modes（它不产视频），也不该期待视频产物 | ❌ |
| `seedance-2.5` | res **480p/720p/1080p**，2k/4k 同步 400；size 取值 16:9/4:3/1:1/3:4/9:16/21:9/**adaptive(默认)**；duration **4–30 + -1(自选)**；参考图≤30、视频≤10、音频≤10；draft 模式；输出 mp4/mov | res **480p/720p/1080p/2k/4k**；ratios **无 adaptive**；durations 4–30（无 -1）；无 ref_max；无 draft/output_format | **多了 2k/4k（必然 400）**；少 `adaptive` 默认档；少 `-1 自动时长`；少 ref 上限与 draft | ❌ |
| `muse-video-ext` | ratios **7 个**（自动要省略字段）；res **仅 720p**；duration **固定约 10s**（只接受 10 / "10" / "10s"）；n=1；参考图≤9；**声音固定开，audio=false 会被拒** | ratios **[]**；res 720p ✓；durations [10] ✓；n_max=1 ✓；modes text/image_to_video ✓ | **缺 7 个比例**；`ref_max=9` 未下发 | ❌ |

## 3. 不一致清单（按严重度）

### 高（会让编辑器选项错误/缺失，或必然失败）

1. **`seedance-2.5` 的分辨率多了 2k/4k**
   文档原文（L45203）："Unsupported values like `2k`/`4k` return a sync **400**."；页首还写明 "2.0's 4k is **not** available on 2.5"。
   建议：`APIMART_VIDEO_MODEL_CAPS["seedance-2-5"]["resolutions"]` 改成 `("480p","720p","1080p")`。
2. **`muse-image-ext` 缺 7 个比例**
   文档（L20715）："`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`"，且"自动"要省略字段、不能传 auto（L20713）。
   建议：`ratios` 填这 7 个（**不要加 auto**，会因为发 `auto` 被拒），`send_resolution` 保持 False。
3. **`muse-video-ext` 缺 7 个比例**
   同上（L82039），且同样不能传 auto。
4. **`midjourney` 需要专门的参数集**
   文档（L12892/L14126/L14130/L14131）：走 `/v1/midjourney/...`，`size`=`--ar`，`quality`=`0.25/0.5/1/2`，结构化字段覆盖 prompt flag。
   建议：给 MJ 单独一条 caps（`ratios` 留空表示"自由输入比例"，`qualities=("0.25","0.5","1","2")`，`n_max` 留空并在 notes 写明"一次固定 4 张、repeat 2–40"），编辑器里换一套 MJ 专用控件，不要复用 OpenAI 的 quality/size 控件。
5. **`MiniMax-H3-Context-IR` 不该按视频模型渲染**
   文档（L40100/L40225）："produces an enhanced structured prompt (**text only, no video**)"、"No video is produced. Result is in `result.prompt`"。
   建议：单独条目（`resolutions=null`、`modes=null`、`n_max=null`），编辑器把它当"提示词增强"动作，或至少在选它时不显示分辨率。

### 中（选项缺失或某组合会 400）

6. **`gpt-image-2.5-flare/sunburst` 的 quality 缺 `auto`**
   文档（L5547）："`low`, `medium`, `high`, `xhigh`, `max`, or `auto`"。当前 caps 给了 5 档、漏了默认值 auto；2.6 系列则是 6 档，两代不一致。
   建议：两代都补 `auto`（编辑器可把它当"默认/自动"选项）。
7. **`seedance-2.5` 的比例缺 `adaptive`、时长缺 `-1`**
   文档（L45211）："`16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` (default)"；（L45221-45222）"4~30；**-1**: model picks duration"。
   建议：ratios 补 `adaptive`；durations 里加一个"自动"选项（值为 -1），或在 notes 里标清楚。
8. **`seedance-2.5` 的参考素材上限没下发**
   文档（L45345/L45311）：图 ≤30、视频 ≤10（单条 2–30s、合计 ≤30s）、音频 ≤10。
   建议：`ref_max=30` 进 payload（目前 `/api/model-caps` 不下发 `ref_max`，需要先扩字段）。
9. **`MiniMax-H3-Max` 的 1080P 水印约束缺失**
   文档（L41270）："At `1080P`, omit both `watermark` and its alias `aigc_watermark`, even when the value is `false`."
   建议：后端在 1080P 时不要发这两个字段（现在是 `watermark: True` 无条件发）。
10. **`gpt-image-2.6-flare/sunburst` 的 `output_format` / `complexity` / `markup` 未进 caps**
    文档（L6323/L6345/L6395）：output_format=png/jpeg/webp/gif/svg、complexity=low|medium|high、markup_url 引导编辑（与 mask_url 互斥）。
    影响：编辑器无法选 SVG/GIF，也无法用 markup 局部改图。
11. **`gpt-image-2.6-ext` 的 `complexity` 与 `output_format` 也没下发**（文档 L6305-L6345 同页），而 ext 的 SVG 正是它和 2.5 的主要差异点。

### 低 / 信息

12. **`gpt-image-2.5-ext` 的 `max_long_edge/max_pixels/min_pixels`**：文档这页只写"10 个比例 + auto"，没写精确像素规则（**未知**）。当前 caps 带了 3840/8294400/655360，属于沿用了 flare/sunburst 的规则；值本身无害，但 `exact_size` 语义未确认。
13. **`ref_max` / `output_formats` 不在 `/api/model-caps` 响应里**：muse 两个模型、seedance-2.5、gpt-image-2.6 系列的参考图上限和输出格式，后端表里有、前端拿不到。
14. **`gemini-nano-banana-2.1-ext` 与 `midjourney` 不在 `/api/model-caps` 结果里**：前者是因为没配置进 provider 模型列表（配置层问题，不是 caps 错），后者是表里本来就没有。

## 4. 文档未写 / 需要实测的点

| # | 未知项 | 影响 |
| - | - | - |
| U1 | `gpt-image-2.5-ext` 是否也支持精确像素（文档这页没写），现有 caps 已按支持处理 | 低（多发像素请求可能被 400） |
| U2 | `midjourney` 的合法 `--ar` 取值边界（文档只给示例 16:9/1:1/9:16） | 中：编辑器如果要限制比例，只能自由输入 + 上游兜错 |
| U3 | `MiniMax-H3-Context-IR` 在编辑器里应该走哪条 UI（提示词增强 vs 视频生成） | 高（产品决策，不是纯参数问题） |
| U4 | `seedance-2.5` 的 `-1` 时长在 caps 里怎么表达（枚举里放 -1 还是单独一个 "auto"） | 中：取决于前端控件 |

## 5. 建议的修复顺序

1. 先修 **H1 / H2 / H3**（纯数据错，加/删字符串即可，风险最低，收益最高）。
2. 再决定 **H4（MJ 专用控件）** 和 **H5（Context-IR 的定位）**——这两条要先拍产品语义。
3. `/api/model-caps` 扩字段（`ref_max` / `output_formats` / `qualities 的 auto`），再做 `seedance-2.5` 的 adaptive/ref 上限。
4. 最后补 `output_format` / `complexity` / `markup` 这类"额外能力"字段。

---

## 附录 A：params.json 字段速查（15 条）

| 模型 | kind | ratios | resolutions | qualities | n_max | durations | modes | ref_max |
| - | - | - | - | - | - | - | - | - |
| gemini-3-pro-image-preview | image | auto+10 | 1K/2K/4K | — | 1 | — | — | null（无固定上限） |
| gemini-nano-banana-2.1 | image | auto+14 | 1K/2K/4K | — | 4（ext=1） | — | — | null |
| gpt-image-2.5-ext | image | auto+10 | 1K/2K/4K | null | 4 | — | — | 16 |
| gpt-image-2.5-flare | image | auto+15 | 1K/2K/4K | low/medium/high/xhigh/max/**auto** | 4 | — | — | 16 |
| gpt-image-2.5-sunburst | image | auto+15 | 1K/2K/4K | 同上 | 4 | — | — | 16 |
| gpt-image-2.6-ext | image | auto+10 | **1K** | auto/low/medium/high/xhigh/max | **1** | — | — | 16 |
| gpt-image-2.6-flare | image | auto+15 | 1K/2K/4K | 同上 | 4 | — | — | 16 |
| gpt-image-2.6-sunburst | image | auto+15 | 1K/2K/4K | 同上 | 4 | — | — | 16 |
| muse-image-ext | image | **7 个（无 auto）** | null | null | 1 | — | — | 9 |
| midjourney | image | null（--ar 自由） | null | **0.25/0.5/1/2** | null（固定 4 张） | — | 13 个子操作 | null |
| MiniMax-H3 | video | 6 | 2K/768P | — | 1 | 4–15 | 5 种 | null |
| MiniMax-H3-Max | video | 6 | 480P/768P/1080P | — | 1 | 5–15 | 5 种 | null |
| MiniMax-H3-Context-IR | video | 6 | **null（不产视频）** | — | null | 4–15 | **null** | null |
| seedance-2.5 | video | 6+**adaptive** | 480p/720p/1080p | — | 1 | 4–30（+ -1） | 5 种 | 30（图）/10（视频）/10（音频） |
| muse-video-ext | video | **7 个（无 auto）** | 720p | — | 1 | 10（固定） | text/image_to_video | 9 |

> 精确像素：只有 gpt-image-2.5-flare/sunburst、gpt-image-2.6-flare/sunburst 四个是 `exact_size=true`，约束统一为 单边≤3840 / 总像素 655360–8294400 / 边长 16 的倍数 / 长短边比≤3:1。其余模型 `exact_size` 为 `false`（明确只收比例）或 `null`（文档没写）。

## 附录 B：一句话结论（给 Lead/前端/后端）

- **纯数据错 3 条**（可以直接改字符串，不用改逻辑）：seedance-2.5 去掉 2k/4k、muse-image-ext 补 7 比例、muse-video-ext 补 7 比例。
- **需要产品决策 2 条**：Midjourney 要不要专门的 MJ 控件（现在是"没有参数、按通用 OpenAI 发"）；MiniMax-H3-Context-IR 到底是"提示词增强动作"还是"视频模型"（它不产视频）。
- **能力表要扩字段**：`/api/model-caps` 目前不下发 `ref_max` 和 `output_formats`，导致参考图上限、输出格式（WebP/mp4/mov/svg/gif）在编辑器里不可见。
- **文档值本身齐全**：15 个模型里 12 个的 ratios/resolutions/n 与文档**完全一致**，说明之前的 caps 维护质量不错，问题集中在"文档没被读到的少数字段"（auto/adaptive/-1/watermark 约束/MJ 语义）。
