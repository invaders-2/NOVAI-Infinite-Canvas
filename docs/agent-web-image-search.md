# 画布助手联网搜图 / 反图 / 原图入画布 —— 接口契约 v1

> 本文件是两个前端执行组和后端执行组共用的接口契约。契约里的字段名、路径、语义先定死，
> 三组并行开发，不许各自改契约；要改先回报 Lead。

## 1. 背景与实测结论（Lead 已实测，不要重复验证）

- 现有 `server/web_access.py` 的 `web_search` 走 DuckDuckGo（`html.duckduckgo.com`），
  在用户当前网络下直接 000 连不通 —— 也就是「设置了联网但搜不出东西」。
- 实测可用（200 + 有内容）：
  - 必应国内版图片：`https://cn.bing.com/images/async?q=<词>&first=1&count=N&mkt=zh-CN`
    HTML 里 `murl` = **原图直链**、`turl` = 缩略图、`purl` = 出处页、`t` = 标题。
  - 360 图片：`https://image.so.com/j?q=<词>&pn=0&rn=N` 返回 JSON，
    `list[].img` = **原图直链**、`list[].thumb` = 缩略图、`list[].width/height` = 尺寸、
    `list[].link` = 出处页、`list[].site` = 站点名。
  - 360 文本搜索 `https://www.so.com/s?q=...`、必应文本 `https://cn.bing.com/search?q=...`。
- 不可用/不稳定：`duckduckgo.com`（连不通）、百度识图上传（返回 `{"status":1,"msg":"Reject"}`）、
  必应以图搜图上传（404）。所以**「反图」不做第三方以图搜图上传**，改成
  「视觉模型读图 → 生成检索词 → 图搜」这条稳定链路。

## 2. 开关

全部新能力都受 `settings.agent_web_enabled`（设置 → 通用 → 画布助手联网）管辖，
关闭时：工具不在 `_agent_build_tools_catalog()` 里出现，直接调工具返回
`code="web_access_disabled"`，HTTP 接口返回 403 + 可读中文原因。

## 3. LLM 可见的工具（schema 固定，名字固定）

### search_images
```json
{"query": "搜索关键词，必填", "count": 12, "orientation": "any|landscape|portrait|square",
 "sources": ["huaban", "zcool", "bing", "360"]}
```
`sources` 可选，不传=全部可用来源。返回：
```json
{"engine": "multi", "query": "原样回显", "note": "可选，写各来源的真实失败原因",
 "sources": {"huaban": 12, "zcool": 6, "bing": 6}, "items": [ImageItem]}
```
来源覆盖（实测结论，2026-11-03）：
- **稳定可用（默认来源）**：花瓣（huaban.com/v3/search，原图无尺寸后缀）、堆糖（duitang.com/search）、
  必应图片、360 图片；
- 尽力（不进默认）：站酷——img.zcool.cn 直连 403（带 Referer 也 403），搜索页拿不到原图，只写真实原因；
- **不可用（明确告知用户，不要假装支持）**：小红书（需登录 + x-s/x-t 签名）、Pinterest（本机不可达）、
  百度图片（Forbid spider access）、昵图（soso 500）、图虫（rest 404）、
  Unsplash/Pexels/Pixabay（需 API key / 被 Cloudflare 拦）。

### find_similar_images（反图）
```json
{"image_url": "/uploads/xxx.jpg 或 data: 或 https://...", "count": 12}
```
返回：
```json
{"engine": "bing|360|merged", "query": "首个检索词",
 "queries": ["生成的检索词..."], "description": "视觉模型对这张图的描述",
 "note": "可选", "items": [ImageItem]}
```
实现：把图交给现有对话模型（能读图的那条链路）拿 3~5 组检索词 + 画面描述，
再对每组跑 `search_images`，合并去重（按 original_url）。视觉链路拿不到图时
**必须报错说明**，不要静默降级成只用文件名/画布标题猜词。

### add_image_to_canvas
```json
{"canvas_id": "c1", "url": "原图直链或 /uploads/...", "title": "可选"}
```
返回：`{"node_id": "...", "url": "落库后的本地 url（/assets/uploads/...）", "width": 1234, "height": 800}`

### ImageItem（统一）
```json
{"id": "稳定短 id（original_url 的 hash）",
 "title": "标题",
 "original_url": "原图直链",
 "thumb_url": "缩略图（仅供面板预览）",
 "width": 2048, "height": 1280,
 "source_page": "出处网页 url",
 "source_site": "站点名或域名"}
```
宽高拿不到时用 `null`，不要编 0 或估计值。

### 铁律
1. `original_url` 必须是原图直链；`thumb_url` 只允许出现在面板预览里，
   **任何落画布、落素材库、进生成的路径都不许用 thumb_url**。
2. 不许编造图片 URL，不许拿占位图凑数。
3. 搜不到就返回空 `items` + `note` 写真实原因（引擎超时 / 被限流 / 关键词无结果）。
4. 单个工具结果 `items` 上限 24 条。
5. **多来源**：一份结果可以来自多个素材站，每条 `ImageItem` 必须带
   `source_kind`（bing / 360 / huaban / zcool / nipic / duitang / tuchong / 空串）与
   `source_site`（展示用域名）；结果里带 `sources`（{"huaban": 12, "bing": 6}）便于前端按来源筛选。
   某站失败不能让整次搜索失败：其它站的图照常返回，失败原因写进 `note`。

## 4. HTTP 接口（两个前端直接调）

### POST /api/agent/images/import
```json
{"items": [{"url": "https://原图直链", "source_page": "https://出处页"}], "name": "可选基名"}
```
`items` 优先，也兼容老写法 `{"urls": ["https://原图直链"]}`（不带出处页）。
**两个前端一律传 items + source_page**：服务端用 source_page 的 origin 当 Referer，
58pic / nipic / 花瓣这类防盗链站点不带出处页会 403（实测同一批 8 条：只传 urls 成功 5 条，
带 source_page 成功 6 条，58pic CDN 那条从 403 变 OK）。
- 1..12 条（只用于外链原图，本地 `/assets/...` 已落库的图不要重复送进来）；
  服务端逐条下载原图：跟随重定向 ≤5、带 UA 和 `Referer`、超时 20s、单文件 ≤25MB。
- 魔数嗅探真实图片类型（png/jpeg/webp/gif/bmp/avif），只认图片。
- 落盘到素材库本地目录（`LOCAL_UPLOAD_DIR`）下的 `agent-web/` 子目录，返回 url 形如
  `/assets/uploads/agent-web/xxx.jpg`（这样素材库里也直接能看到、两个画布都能当本地图用），
  并复用现有 local-assets 登记路径。
- **缩略图判定**（三道，任一命中即 `ok=false, code="thumbnail_only", error="只拿到缩略图"`，不落盘）：
  1. 已知缩略图 CDN 域名/路径：`ts*/tse*` 开头的 `*.bing.net`、`bing.com` 的 `/th/` 路径、
     360 `*.qhimgs*.com` 的 t 前缀图 → 连下载都不做；
  2. 下载过程中重定向落到上面这些缩略图地址；
  3. 兜底：真实长边 < 300px（尺寸只能兜底：必应 turl 常输出 474×449，长边 474 > 300，必须靠域名规则）。
- 返回：
```json
{"items": [{"source_url": "...", "ok": true, "url": "/assets/uploads/agent-web/xxx.jpg",
            "width": 2048, "height": 1280, "bytes": 345678, "error": "", "code": "", "detail": ""}]}
```
- 失败绝不静默：`error` 写真实原因（HTTP 403 / 不是图片 / 超时 / 超过大小 / 只拿到缩略图）。

### POST /api/agent/images/add-to-canvas
```json
{"canvas_id": "c1", "url": "https://... 或 /uploads/...", "title": "可选"}
```
内部复用上面的下载逻辑（本地 `/uploads` 路径则直接读盘），再用现有建节点路径创建 image 节点。
返回 `{"node_id": "...", "url": "本地 url", "width": 1234, "height": 800}`。

### POST /api/agent/images/reverse（反图，面板直调，不经过一轮对话）
```json
{"image_url": "/assets/uploads/xxx.jpg 或 https://...", "count": 12}
```
> 本地路径统一支持 `/assets/...`、`/output/...`、`data:`、`https://`；
> 本地解析必须用项目现成的 `main.py output_file_from_url()`（已做路径越权校验），
> 不要自己拼路径。
内部就是 `find_similar_images` 的同一份实现（视觉模型读图 → 检索词 → 图搜合并），
返回与 `find_similar_images` 完全同构：
```json
{"engine": "bing|360|merged", "query": "...", "queries": ["..."],
 "description": "...", "note": "...", "items": [ImageItem]}
```
前端「以图搜图」入口就是：先把图（画布选中节点 / 上传）过 `/api/agent/images/import`
拿本地 url，再 POST 到这里，结果直接进参考图选择卡（不需要消耗一轮对话）。
关闭联网时同样 403。

## 5. 前端契约

工具结果怎么到前端：
- **智能画布BEAT（novai-canvas-ui）**：`/api/agent/runs/{run_id}/snapshot` 与总线里的
  `tool.execution.succeeded` 事件，`event.safePayload.result` 就是工具返回值，
  从 `result.items` 取图（见 `main.py` `_agent_run_task_snapshot`）。
- **智能画布（canvas-ui 微应用）**：SSE `step_result` 事件，`data.result` 是工具返回值，
  从 `data.result.items` 取图（见 `static/js/canvas-assistant-bridge.js`）。

两个面板都渲染同样的「参考图选择卡」：
- 网格 3 列、方图 cover，**预览用 `thumb_url`**，旁边标 `宽×高` 和来源域名，出处链接可点开。
- 多选，**默认一张都不选**；底部「加入画布 (n)」+「全选」。
- 加入流程：`POST /api/agent/images/import` → 用返回的本地 `url` 建 image 节点
  （落在视口中心、可撤销、建完选中）→ toast「已加入 n 张」。
- 失败行显示真实原因；**禁止**失败后用 `thumb_url` 或占位图兜底。
- 关闭联网时卡片显示「联网未开启」+ 一句指引（设置 → 通用 → 画布助手联网）。

## 6. 明确不做

- 不做第三方以图搜图上传（百度/必应识图实测不可用）。
- 不改现有工具名和 schema（`web_search` / `fetch_url` 保留），只把 `web_search` 的引擎换成可用的。
- 不改 agent 事件协议、不动 `/api/agent/run` 的请求体。
