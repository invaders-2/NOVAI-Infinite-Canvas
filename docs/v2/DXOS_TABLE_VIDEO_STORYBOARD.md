# 多维表格 → 视频分镜：逐段生成链路

> 状态：已实现并实测通过（2026-09，参考视频真实切段版）
> 前置：表格数据层见 `docs/v2/DXOS_TABLE_SPEC.md`；图片链路（同一套执行器）先落地，视频链路复用它。

## 1. 链路

```
参考视频（/assets/… 、/output/… 本地文件；也支持 http(s) 远程地址）
        │
        ▼
   LLM 节点（输出形式 = 视频分镜表；可选「每段秒数」1–5 秒，默认 3）
        │  ① POST /api/video/segments：参考视频真实切成 N 段，
        │     每段一个 mp4 + 一张首帧 jpg，落 assets/input/segments/<key>/
        │  ② 首帧图分批交给 /api/canvas-llm，写「画面描述 / 运镜」
        ▼
   多维表格节点（一段一行，5 列）
        │   时间段(秒) | 时长(秒) | 画面描述 | 运镜 | 参考用法
        ▼
   视频生成节点（批量生成 = 逐行出视频，每行只用本行那一段的片段做视频参考）
```

参考视频没连、或没选「视频分镜表」时静默走老链路：LLM 直接按提示词出分镜表，不切段、不报错。

## 2. 接口契约：POST /api/video/segments

```json
// 请求
{"url": "/assets/input/ref.mp4", "seconds": 3, "max_segments": 30}
// 响应 200
{"ok": true, "duration": 12.34, "seconds": 3.0, "truncated": false,
 "segments": [{"index": 1, "start": 0.0, "end": 3.0, "duration": 3.0,
               "clip_url": "/assets/input/segments/<key>/seg_01.mp4",
               "frame_url": "/assets/input/segments/<key>/seg_01.jpg"}]}
```

- `url` 必填：`/assets/…`、`/output/…` 走本地解析；`http(s)://` 先用 httpx 下到临时文件（超时 120s），失败 400。
- `seconds` clamp 到 1.0–5.0；缺省或非数字 → 3.0。`max_segments` clamp 到 1–60，缺省 30；超出只切前 N 段并置 `truncated=true`。
- 分段规则：start = 0, seconds, 2*seconds…，end = min(start+seconds, duration)；**末段不足 1s 并入上一段**（上一段 end 拉到 duration，总段数 -1）；整除不产生空段；总长 < seconds 时只有一段。
- 失败一律 `HTTPException(400, detail="中文原因")`：找不到文件 / ffmpeg 或 ffprobe 缺失 / 时长读不到或 ≤0 / 切片失败；不会返回半截 ok 结果。
- 切片是精确重编码（`-ss` + `-t` + libx264，`-an` 去音轨），不用 `-c copy`：copy 只能从关键帧切起，段长会明显偏离请求值；去音轨是因为火山参考视频带音乐会报版权。
- 输出目录 key = `sha1(源文件绝对路径|seconds)[:12]`；同源同参数重复请求复用已有非空文件，不重复转码。

**前端 `planVideoSegments`（`static/js/shared/table-model.js`）是后端 `plan_video_segments` 的镜像**：只算行数与时间段（列表预览、段数校验）。分段规则一改必须两边同时改，否则表格行数和后端片段数会对不上。

## 3. 关键实现点

1. **通道模式**：参考视频通道 `mode='sequence'`，逐行写这一段的 `clip_url` 当手动素材（不伪造连线）；产品 / 模特穿搭通道一律 `mode='all'`。
   为什么：非 `all` 的通道整行只留最先遇到的那一张主参考图，别的组（比如额外 @ 到的视频）会把本行的分镜片段挤掉。
2. **看图写描述**走 `/api/canvas-llm`，带 `images` + `no_prompt_intelligence: true`，超时 180s，每批最多 8 张；解析不出时补一次「修复」请求，条数不齐时只对缺失段补一次（每批最多多 1 次请求）。
   为什么：Prompt Intelligence 收到 images 时会改写 message，把「只返回一个 JSON 对象」这类结构化提示词毁掉；fetch 永远 pending 时 `finally` 不执行，节点会一直显示「运行中」，所以必须带超时。
3. **`@视频N` / `@图片N` 是全局序号**（通道 `ordinalBase` + 组内位置 + 1，手动项占的就是组内那个位置），由 `rewriteMentions` 逐行重写。
   为什么：序号口径必须与 `computeTableRowInputs` 一致，否则逐行提示词里的 @ 会指错素材甚至悬空。
4. **只 @ 到、没连线的素材**：智能画布支持（不伪造连线，用「额外输入通道 + 每行手动素材」落位）；经典画布没有 mention chip，@ 到的素材必须先自己连上。
5. **逐行批量 `rowRefsAuthoritative`**：带 `rowOverride` 的批量运行中，视频节点自己的「手动视频链接」不再覆盖本行 refs。
   为什么：不加这个开关，手动链接会把每一行的分镜片段顶掉，一次批量等于把整条参考视频跑 N 遍。
6. **经典画布物化后接线**：把新表接到下游视频节点（视频节点的批量面板只在「上游有表格」时才出现，Output 是中转要穿过去）；并把同一个 LLM 上一次生成的旧表先从视频节点摘线。
   为什么：批量执行按连线顺序取第一张上游表格，不摘线会一直跑旧表。只摘「同一个 LLM 生成的表」，手动连的和别的 LLM 的不碰。

## 4. 覆盖范围与差异

- 智能画布 `static/js/smart-canvas.js` 与经典画布 `static/js/canvas.js` 是**两套独立实现**（仓库约定，改一边不要假设另一边同理），共用 `static/js/shared/table-model.js` 的纯函数（`planVideoSegments` / `segmentCountOf` / `formatSeconds` / `segmentReferenceLine` / `rewriteMentions`）和 `shared/table-node.js` 的手动素材存储形状。
- 与图片链路的三点差异仍然成立：

| 点 | 图片链路 | 视频链路 |
|---|---|---|
| 提示词 | 一行一张图的完整生成内容 | 一行一个分镜（时间段 / 时长 / 画面描述 / 运镜 / 参考用法） |
| 运行器 | `runGenerator` | `runVideoNode` + `rowOverride`（配合 `rowRefsAuthoritative`） |
| 默认并发 | 3 | 1（视频又慢又贵，未显式设置时逐段串行） |

其余（表格数据层、输入通道、勾选语义、journal 续跑、失败策略、批量面板）完全共用。

## 5. 验证

- `python3 -m unittest tests.test_video_segments`：13 项全过（分段规则、max 截断、参数 clamp，以及真实 ffmpeg 生成的短视频验证「计划段长 = 实际段长」，误差 < 0.25s）。CI 已并入 `.github/workflows/tests.yml` 的 Python unit tests 一步。
- `node tests/test_video_segment_storyboard.js`：166 项通过（智能画布：纯函数、只 @ 未连线场景、物化结果、逐行视频载荷与兜底）。
- `node tests/test_canvas_video_segment_storyboard.js`：98 项通过（经典画布：物化、通道绑定、@ 引用零悬空、自动接下游视频节点、接口失败回退老链路）。
- 隔离实例跑接口（`NOVAI_PORT=3311 NOVAI_DATA_DIR=/tmp/novai-seg-verify`，8.4s 测试视频，2026-09 实测）：`seconds=3` → 3 段 3.0 / 3.0 / 2.4，ffprobe 复核误差 0.000；`seconds=5` → 2 段（5.0 + 3.4）；`seconds=99` → clamp 成 5.0；同一请求重发，产物 mtime + 字节数完全不变（复用、不重转码）；不存在的 url → 400 + 中文 detail。
- 浏览器端到端：打开真实画布连参考视频（约 14.6s）→ 输出形式「视频分镜表」→ 每段秒数 3 → 点生成；拦截 `/api/canvas-video` 确认 5 行 `videos` 各自是 `seg_01`…`seg_05`，没有一行是整条参考视频（落盘片段目录 5 个 mp4：3.003×4 + 2.586）。

## 6. 已知限制

- 每行「时长(秒)」目前只是提示词里的文字，视频节点自身的 `duration` 仍是整批共用的 API 参数；要做到每段时长不同，需要再引入按行覆盖 API 参数，目前不做。
- 模型少写段时（返回条数少于段数），缺口行用兜底文案「对齐参考片段的画面与运镜」；每批最多只补一次请求，不会为凑数反复调用模型。
- 切片缓存 key 依赖源文件的**绝对路径**：换安装路径、换素材盘后同一个视频会各切一份，不自动迁移（旧目录可手动删）。
- 表格同时接到图像节点和视频节点时，靠连接顺序取第一个；用显式「视频分镜表」可以定死。
