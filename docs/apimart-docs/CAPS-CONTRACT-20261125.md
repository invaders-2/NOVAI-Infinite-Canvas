# CAPS-CONTRACT-20261125 — /api/model-caps 与生成请求体的本轮增量

> 交付岗：后端/数据层（backend-data）。范围只到后端 + 文档：**未改任何前端文件**
> （novai-canvas-ui、static/js、static/novai-canvas、web 均未动）。
> 本文是给下一个「前端执行岗」的照抄清单：左边是后端已下发的值，右边是前端要镜像的落点。
> 证据：/tmp/apimart-llms-20261125.txt（sha256 0393fa48…，行号 L####）、
> /tmp/apimart-delta-20261125.json、/tmp/apimart-pricing-20261125.html。

## 1. /api/model-caps 新增字段（image kind）

全部按「字段缺失 = 后端不掌握」下发，只出现在对应模型上；其它模型不要假设有这些键。

| 字段 | 类型 | 出现模型 | 含义 / 取值 |
|---|---|---|---|
| series | {min,max} | kling-v4-image | 系列模式张数区间 **{min:2, max:4}**；走 sequential_image_generation=auto + options.max_images |
| skill | string[] | kling-v4-long-image | **["ecommerce","webpage"]**，必填，空值按 ecommerce |
| length | string[] | kling-v4-long-image | **["short","medium","long"]**，只在 skill=ecommerce 下发，默认 medium |
| background | string[] | mai-image-2.7 / -flash | **["auto","opaque"]**；transparent 上游 400，别给这个选项 |
| send_size | boolean | kling-v4-long-image | **false** = 请求体不带 size/aspect_ratio；编辑器不要显示比例/尺寸控件 |
| exact_size_pair | boolean | mai-image-2.7 / -flash | **true** = 精确像素用 width/height 成对下发（不是 size="WxH"） |
| min_side | int | mai-image-2.7 / -flash | **768**：宽、高各自 ≥768 |
| size_step | int | mai-image-2.7 / -flash | **32**：宽高各自向下取 32 的倍数（1000 → 992） |
| max_pixels | int | mai-image-2.7 / -flash | **4194304**：总像素上限（与 GPT-Image 的 max_long_edge=3840 不是同一套规则） |

已有字段本轮没有改语义：ratios / resolutions / n_max / ref_max / durations / qualities / modes / audio /
native_background / max_long_edge / min_pixels / output_formats / gif_frames / mj。

## 2. 四个新模型的真实下发值（curl 实测，端口 3937 独立数据目录）

```json
{"provider": "apimart", "model": "kling-v4-image", "kind": "image", "ratios": ["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"], "resolutions": ["2K", "4K", "8K"], "durations": [], "qualities": [], "n_max": 9, "ref_max": 10, "series": {"min": 2, "max": 4}}
{"provider": "apimart", "model": "kling-v4-long-image", "kind": "image", "ratios": [], "resolutions": ["1K", "2K"], "durations": [], "qualities": [], "n_max": 1, "ref_max": 3, "skill": ["ecommerce", "webpage"], "length": ["short", "medium", "long"], "send_size": false}
{"provider": "apimart", "model": "mai-image-2.7", "kind": "image", "ratios": [], "resolutions": ["1K", "2K"], "durations": [], "qualities": [], "max_pixels": 4194304, "n_max": 1, "ref_max": 5, "background": ["auto", "opaque"], "min_side": 768, "size_step": 32, "exact_size_pair": true}
{"provider": "apimart", "model": "mai-image-2.7-flash", "kind": "image", "ratios": [], "resolutions": ["1K", "2K"], "durations": [], "qualities": [], "max_pixels": 4194304, "n_max": 1, "ref_max": 5, "background": ["auto", "opaque"], "min_side": 768, "size_step": 32, "exact_size_pair": true}
```

要点（文档确证，别按猜测改）：
- **kling-v4-image**：ratio 只有 auto + 8 个（传像素尺寸 400）；档位 2K/4K/8K（1:1 时 2048/4096/8192），
  默认 2K；**n 1–9**（后端不钳到 4：direct_image_request_batches 上限改成模型 n_max，实测 n=9 原样提交）；
  系列模式用 max_images 2–4 且**不能带 n>1**；参考图 ≤10 只收公网 URL（后端会自动上传本地图）。
- **kling-v4-long-image**：**skill 必填**；length 只在 ecommerce；resolution 1K/2K；n 固定 1；
  size/aspect_ratio/width/height/sequential_* 传了就 400 → 后端 send_size=false 不下发；
  webpage 模式的参考图必须走 image_with_roles(style|subject)，通用链路只会发 image_urls →
  后端对「webpage + 参考图」显式 400（宁可报错也不发错字段、白扣参考图费）。
- **mai-image-2.7 / -flash**：ratio 任意整数 1:4–4:1（后端不收敛，ratios 下发空数组 = 任意）；
  resolution 1K/2K；n 固定 1；参考图 ≤5（URL 或 data:image，图生图时尺寸参数全失效）；
  像素约束 = 两边 ≥768 / 总像素 ≤4194304 / 向下取 32 倍数；background 只有 auto|opaque。
  两版同页声明能力完全一致，靠最长 key 命中复用同一条 caps。

## 3. apimart-zoe（video）：能力表保持 9/3/3，不跟随文档放开

```json
"ref_max": 9, "video_ref_max": 3, "audio_ref_max": 3
```

文档 L36104 / L36118 / L36126 声明 image_urls ≤30、video_urls ≤10、audio_urls ≤10，
但我们的通用上传分支只取前 9 张图 / 3 段视频 / 3 段音频（image_limit / video_payload[:3]），
超出部分会被静默截断。**能力表按实际队列写 9/3/3**：宁可编辑器先拦，也不让用户以为拖 30 张都生效。
放开顺序：先实测超限请求（U23）→ 再同步改上传分支与能力表，两处一起动。

## 4. 生成请求体新增字段

后端两个入口都接收（OnlineImageRequest）：
POST /api/canvas-image-tasks、POST /api/online-image

| 请求体字段 | 类型 | 发给上游的条件 | 上游字段 |
|---|---|---|---|
| skill | string | 仅 caps.skill 存在（kling-v4-long-image） | skill（必填；空 = ecommerce） |
| length | string | 仅 caps.length + skill=ecommerce | length（short/medium/long；空 = medium） |
| series_images | int | 仅 caps.series 且 2 ≤ 值 ≤ max | sequential_image_generation="auto" + sequential_image_generation_options.max_images |
| background | string | 既有字段；仅 caps.background 存在（mai） | background（白名单外回退 auto） |
| size（像素） | "WxH" | caps.exact_size_pair=true（mai）时不发 size，改发 width/height 两个整数 | width + height（成对） |
| size | string | caps.send_size=false（kling-v4-long-image）时完全不发 | — |

后端行为细节：
- 系列模式：series_images 命中区间时**不发 n**（上游 n>1 直接 400），且只提一次请求（不再按 n 拆批）。
- 预扣：_credits_image_params 的 rows 取 max(n, series_images)，避免系列出 4 张只扣 1 张的钱。
- n：direct_image_request_batches 的总数上限从写死 8 改成 max(8, n_max)，kling-v4-image 的 n=9 原样下发。
- mai 精确像素：请求里的 size 若是 "1000x1000"，后端按「两边 ≥768、总像素 ≤4194304、向下取 32」收成
  992x992 再以 width/height 成对发出；比例请求（如 "16:9"）仍走 size + resolution。
- 其它模型不会收到任何新字段（mock 上游测试已断言 seedream-5-0-flash 的请求体没有这些键）。

## 5. 前端必须镜像的值（给前端执行岗）

1. novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts
   - ModelCapsItem 增可选字段：series / skill / length / background / send_size / exact_size_pair / min_side / size_step（类型 unknown）。
   - modelCapsUi() 映射成 ui：series={min,max}（读 number）、skill 与 length 与 backgroundAllowed 都转成 string[]、
     sendSize = (item.send_size !== false)（缺省 true）、exactSizePair = (item.exact_size_pair === true)、
     minSide 与 sizeStep 转 number。
   - ui.batch 继续由 n_max 展开（kling-v4-image 会得到 9,8,...,1），**不要再写死 4,2,1**。
2. model.ts：ImageParams 加 skill / length / series；clampParams 换模型时清掉不属于新模型的这三个值
   （否则会发给别的模型，上游 400）。
   sizes 走 caps.resolutions（kling-v4-image 自然出现 **8K**，不需要前端加特判）。
3. novaiBackend.ts 的 createImageTask 请求体：按需带 skill、length、series_images；
   **series 生效时不要带 n>1**（后端已兜底，但前端别自己再造一个 400）。
   size 继续传像素字符串即可，mai 的 width/height 由后端成对转换。
4. GenPanel.tsx：
   - kling-v4-long-image：加「用途」下拉（skill，必填，默认 ecommerce）；skill=ecommerce 时再加
     「篇幅」下拉（length: short/medium/long，默认 medium）；webpage 模式隐藏 length，并且参考图入口要么
     隐藏要么提示「webpage 参考图暂不支持」（后端对该组合返回 400）。
   - kling-v4-image：张数用 ui.batch（1–9）；可选「系列模式」开关 → 2/3/4 张（选后禁用张数选择）。
   - mai-image-2.7：加「背景」下拉（auto/opaque）；若要支持精确像素，输入宽高后按
     min_side/size_step/max_pixels 就地收敛（算法见 main.py 的 normalize_mai_image_size）。
   - 隐藏条件：send_size===false 的模型不要渲染比例/尺寸控件。
5. modelCaps.ts 的 clampImageSize（按 max_long_edge/max_pixels/min_pixels 等比缩）**不能用在 mai 上**：
   它没有长边上限，规则是「两边 ≥768 + 向下取 32」。建议复制一份 clampMaiSize，用 min_side/size_step/max_pixels。

## 6. JS 侧要不要改值？（tests/test_size_map_parity.js）

**本轮不需要改任何 JS 值**：node tests/test_size_map_parity.js 实测 45 格差异 0、全部通过。
原因：8K 只出现在 caps.resolutions（档位），没有进前端 SIZE_MAP 的「比例 × 档位 → 像素」预置表。
如果下一个前端岗要往 static/js/smart-canvas.js / static/js/canvas.js 的 SIZE_MAP 加 8K 预设，
必须同时在 main.py 的 _AGENT_SMART_SIZE_MAP（以及 APIMART_OFFICIAL_PIXELS）加**同一组像素**，
否则 parity 测试会红。文档只确证了 1:1 的 8K = 8192×8192，其它比例的 8K 像素文档写的是
「use the actual dimensions of the returned images」→ **未知，不许编**。

## 7. 本轮未做的未知项（U18–U28 相关）

- **U19/U20**：7 条「仅定价页」chat（gemini-4-* / gpt-6.2-* / claude-fable-5.2 / qwen4-max）只写进
  catalog.json 并标 confidence=low，没进 provider 清单、没进更新包；claude-fable-5.2 命名可疑。
- **U21**：POST /v1/tasks/batch 只有三处一句 TIP，契约不明 → 不接。
- **U22**：data.billing_status 只在新长图页出现，是否全平台未知 → 只在更新包里留档，代码不解析。
- **U23**：apimart-zoe 文档声明 30/10/10，但共用上传分支仍截断 9/3/3 → 能力表本轮保持 9/3/3，
  需要先实测超限请求、再同时改上传分支与能力表才放开。
- **U24**：veo3.1 ext 降价只代表今天，无生效时间；价目 source 已写明 api:pricing/model@2026-11-25。
- **U25**：seedance-1-5-pro 疑似下线（文档页消失 + 定价页 61 个视频模型里没有），**没有删除**
  catalog/能力表/价目里的条目，只在 catalog notes 标「2026-11-25 文档页已消失」。
- **U26**：token 计价图像模型怎么进价目 schema：mai 按既有 mai-image-2.6 口径（预扣 per_image 档 +
  token_rates）落库，估价走预扣档（1K 0.028 / 2K 0.112 gold），是不是产品要的口径待确认。
- **U27（已接，剩余未知收窄）**：上传固定 `?retention_days=3`（`APIMART_UPLOAD_RETENTION_DAYS` 可覆盖 3/7/15/30），
  响应 `bytes/retention_days/expires_at` 保留到上传缓存与最近一次上传结果，缓存 TTL 优先 `expires_at`（≤2 天），
  v7 的 `upload_retention_days` 已留档；「控制台默认档未知」已被固定 3 天规避。剩余未做：超量计费展示
  （`overage{charged,bytes,cost_usd,price_per_gb_usd}`）与配额 UI（`quota{limit,used,remaining,...}`），
  402/429 仍按现有错误路径原样透出。
- **veo3.1-fast-ext**：delta 给了三档新价，但快照里的 key 是历史写法 veo3.1-fast-ext（veo3.1-fast），
  本轮没动（避免造重复记录）；要接得先统一 key 再刷价。
- **kling-v4-long-image 的估价**：quote 看不到 skill/length，带 2K 尺寸时会落在该分辨率的第一档；
  实际费用以上游 usage 结算为准（后端会 _attach_upstream_cost）。

## 8. 验收命令（本轮真实跑过）

```bash
python3 -m pytest -q tests/test_apimart_model_caps.py tests/test_model_caps_api.py \
  tests/test_apimart_video_params.py tests/test_credits.py tests/test_apimart_size_resolution.py \
  tests/test_apimart_mock_upstream.py
# 194 passed, 4 skipped（2026-11-26 音频分类修正后重跑）
# 分文件：test_apimart_model_caps 38 / test_model_caps_api 17 / test_apimart_video_params 26 /
#         test_credits 66 / test_apimart_size_resolution 9 / test_apimart_mock_upstream 38(+4 skipped)
# 之前另一次 235 passed 是把 4 个相邻 caps 套件一起跑（builtin 5 + nmax_modes 12 +
# direct_chain_model_caps 22 + apimart_protocol_alignment 15 = 54 条）；两种口径不要混用。

node tests/test_size_map_parity.js          # 45 格差异 0，全部通过

python3 tools/apimart_pricing.py --html /tmp/apimart-pricing-20261125.html --out /tmp/pricing-check.json
# 模型 241（image 61 / video 61 / chat 116 / audio 3）；索引 239

NOVAI_PORT=3937 NOVAI_DATA_DIR=/tmp/novai-1125-check NOVAI_AUTH_DISABLED=1 python3 main.py
curl -s "http://127.0.0.1:3937/api/model-caps?include_builtin=1"
```
