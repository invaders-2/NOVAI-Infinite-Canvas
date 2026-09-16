# NOVAI v16-beta 接手说明（HANDOFF）

> 生成：2026-09-17（+08:00），由主开发机（`E:\桌面\ceshi\NOVAI-Infinite-Canvas-main`）整理并推送。
> 仓库：https://github.com/invaders-2/NOVAI-Infinite-Canvas
> 分支：`v16-beta`　版本：`VERSION = 1.0.117`　提交数：132（2026-09-14 ~ 09-17）
> 接手第一件事：**读本文件 + `AGENTS.md`**，再动代码。

---

## 1. 这个分支是什么

- 本机主开发机在 2026-09-14 用「1.0.115 源码快照」重建了 git 仓库，之后 132 个提交全部在这条线上：**多维表格重构 + 智能画布批量生成 + 协议层 + 1.0.117 发布改动**。
- 它与本仓库的 `main` **没有共同祖先**（独立历史），这是历史来源决定的，不是操作失误。
- 两边的文件差异是**有意为之**（见 §3.6 与 §5），**不要往 main 合并、也不要把 main 上的文件搬过来**。
- 主线工作只为接手继续开发，**只在这个分支上提交**，不要 force push。

## 2. 怎么跑起来（后端不要用 3000）

```bash
git clone -b v16-beta --single-branch https://github.com/invaders-2/NOVAI-Infinite-Canvas.git NOVAI-v16
cd NOVAI-v16
pip install -r requirements.txt        # Python 3.10+

# Windows（cmd）
set NOVAI_PORT=3211
set DEPLOY_RUN_PORT=3211
python main.py 3211
# 打开 http://127.0.0.1:3211/

# macOS / Linux
NOVAI_PORT=3211 python main.py 3211
```

端口规则（源码实测）：

| 位置 | 行为 |
|---|---|
| `main.py`（`__main__`，约 24243 行） | `argv[1]` > `NOVAI_PORT` > 3000；`uvicorn.run(host="0.0.0.0")` |
| `/api/lan-info`（约 12490 行） | **只读 `NOVAI_PORT`**，局域网二维码地址靠它，所以命令行和环境变量一起给 |
| `run.bat` | 写死 3000 + 自动开浏览器 → **源码环境别用** |
| `novai-desktop.py` / `启动.bat` 桌面模式 | 写死 3000，且要打包好的 `NOVAI.exe` → **源码环境别用** |
| `启动.bat` 浏览器模式 | 只从 `DEPLOY_RUN_PORT` 取"要打开的浏览器地址"，真正端口仍由 `main.py` 决定 |

数据目录：源码跑默认在仓库目录；打包版在 `%APPDATA%\NOVAI`。用环境变量 `NOVAI_DATA_DIR` 切换（想复用安装版的老画布/素材/API Key 就指过去）。相关变量还有 `NOVAI_APP_DIR`、`NOVAI_INSTALL_DIR`（素材目录解析用）。

## 3. 主开发机改了什么

### 3.1 多维表格（本次最大的一块，几乎重做）

- **先推倒再重建**：`revert(table): 移除 NOVAI 原有的多维表格实现（matrix / task-table）` → `revert(table): 清空之前全部多维表格自研实现，改按 DX OS 规范重做`。所以旧实现相关文件已删（见 §5），**不要复活旧 matrix 代码**。
- 新增数据层与渲染层：
  - `static/js/shared/table-model.js` —— 表格数据模型（columns / cells / rows，动态列，P2-5）
  - `static/js/shared/table-node.js` —— 表格节点渲染与交互（工厂函数 + 宿主注入，**经典画布与智能画布共用同一份**）
  - `static/css/table-node.css` —— 表格节点样式（智能画布只加载这一个 CSS）
- 能力：格子放媒体（上传/替换/删除 + 文字）、行列增删（删行独立按钮）、行勾选（默认全选、跨节点同步）、`@` 引用素材（写法 `@图片1`，选择器可选）、CSV 导入、单元格居中策略、表格节点不设固定高度。
- 与生成链路打通：
  - 新增「批量生成」节点：输入口收多维表格，主体是批量面板；「跑一行 / 依次生成 / 运行」三种驱动
  - 后端执行引擎 `/api/runs`（Run / RowRun）
  - 生成结果按行落盘、按行参考比例适配、结果自动成组；视频分镜表按视频跑
  - LLM 节点三选一（文本输出 / 多维表格 / 视频分镜表），出表自动物化并接批量生成节点
  - 传统画布「运行群组」/ 智能画布「一键运行」按组内顺序级联

### 3.2 智能画布（`static/js/smart-canvas.js`）

- LLM 节点向经典画布对齐：Input / Output 分区、供应商与模型挪到 Input 上方一行、上下分栏把手（`llm-pane-resizer`）、底部输出形式药丸按钮、去掉顶部大提示词框、加 90 秒请求超时（曾因无超时长期卡「运行中」）。
- 批量生成节点：加拖拽把手、磨砂玻璃外框、默认展开、产物按行显示在面板下、失败行显示失败占位、进度框不提前收起、再次运行开新批次。
- 表格节点宿主适配层（host），把智能画布的连线/节点能力喂给 `shared/table-node.js`。
- 修过的一批坑：`#world` 定位导致的坐标偏移、端口被裁、视频节点可拖/原图比例、删连线回弹、图片拖入结果群组、多表格渲染提速 3 倍。

### 3.3 经典画布（`static/js/canvas.js` + `static/css`）

- 下拉菜单改自绘弹层（新增 `static/js/shared/dropdown.js`，线性 Lucide 图标，不再用浏览器原生弹层）。
- 生成/视频节点高度随内容、运行按钮钉住不被顶出、多维表格接进来时只留「批量生成」。
- 连线命中层与可见层分离，群组端口常显并外移（解决"从群组往外拖线抓不到端口"）。
- 深色主题下下拉列表 / 占位卡 / 旋转动效可见性修复。

### 3.4 协议层（`server/protocols/`，新增）

- `server/protocols/{__init__.py, registry.py, manifest.json, model_protocols.json, provider_protocols.json}`：协议元数据层 + registry，启动加载。
- `GET /api/ai/descriptor`：模型能力握手（`novai-model-descriptor/v1`，带 TTL 缓存）。
- `run_matrix` 提交前预检：不可执行/超界的 cell 标记 `blocked` 并附 reason，不进 Task 队列。
- 1.0.117 这一版在协议表里补了：**灵境 API**（文本/图像/视频，含 Gemini 图像自动走 `/v1beta` 原生协议、拉取模型时补齐被令牌分组过滤掉的 Gemini 模型、新增视频厂商分发 MiniMax/Kling/Vidu/通义万象(wan/happyhorse)/豆包 Seedance/Luma/Runway）、**Agnes AI**（Video 2.5 / 2.5 Flash，OpenAI Videos 兼容：mode/seconds/size/aspect_ratio + video_id 轮询）。

### 3.5 最后一个提交（`chore(release): v16 测试版（1.0.115 → 1.0.117）`，27 个文件）

这是本次"16 版本测试版"的收口改动：

- `main.py`（+707）：灵境视频厂商分发、模型协议自动推断、gpt-image-1/1.5 去掉顶层 `response_format`（新版官方图像接口已移除该参数，报 `unknown_parameter` 时自动去参重试一次）、生成图片下方标注真实像素尺寸、GPT 聊天模型选择器只显示"已启用 + 有 Key + 有模型列表"的平台、停用 ModelScope 内置默认聊天模型（并清理老用户已保存配置）、一键更新白名单补 `server/`。
- `static/gpt-chat.html`（+262）、`static/js/api-settings.js`（+71）、`static/api-settings.html`、`static/css/api-settings.css`：聊天顶栏去边框/色块（背景同色 + 模糊）、流式输出只在贴底时跟随（用户上滚不再被抢回）、模型选择器收敛、API 设置页同步。
- `server/protocols/{manifest,model_protocols}.json`：灵境 / Agnes 协议条目。
- 打包与更新链路补 `server/`：`.github/workflows/build-electron.yml`（PyInstaller `--add-data "server;"`）、`installer.nsi`、`desktop/package.json`、`build*.py`。
- `VERSION` 1.0.115 → 1.0.117、`static/update-notes.json`（22 条更新说明，**这是最完整的功能清单**）、`.gitignore` 加 `_novai_*.log`。
- 其余 `static/*.html`（angle / asset-manager / canvas-list / comfyui-settings / enhance / home / klein / online / zimage / index）是静态资源缓存版本号 `?v=` 同步。

### 3.6 有意下线的功能（别再当 bug 修回来）

- `revert(canvas): 下线循环 / LTX Director / MiniMax H3 / Modelscope生成 四种节点` —— 对应 `static/js/ltx-director-timeline.js` 已删。
- 旧多维表格实现（matrix / task-table）整套删除。
- LLM 节点的"手动尺寸/整体缩放"折腾过 6 次均不生效，已明确停掉（`chore(smart-canvas): 停掉 LLM 节点缩放的尝试`）；表格节点也明确不设固定高度。

## 4. 关键文件地图（相对 1.0.115 快照）

新增：

| 文件 | 作用 |
|---|---|
| `server/protocols/__init__.py` / `registry.py` | 协议注册与加载 |
| `server/protocols/manifest.json` / `model_protocols.json` / `provider_protocols.json` | 协议真值表（**运行必需的数据文件**） |
| `static/js/shared/table-model.js` | 多维表格数据模型 |
| `static/js/shared/table-node.js` | 表格节点渲染/交互（工厂 + 宿主注入，两画布共用） |
| `static/css/table-node.css` | 表格节点样式 |
| `static/js/shared/dropdown.js` | 自绘下拉弹层 |
| `tests/test_table_model.js`、`test_table_node_dom.js`、`test_table_node_wiring.js`、`test_smart_canvas_table_wiring.js`、`test_select_menu.js`、`test_dark_mode_canvas.js`、`test_video_storyboard_live.js` | 静态断言/接线测试（无统一测试入口，按需 node 跑） |
| `docs/v2/DXOS_TABLE_SPEC.md`、`DXOS_TABLE_VIDEO_STORYBOARD.md`、`SMART_CANVAS_TABLE_PORT.md` | 表格规范与移植映射 |

删除：`static/js/ltx-director-timeline.js`、`static/js/shared/matrix-run.js`、`static/js/shared/table-grid.js`、`tests/test_table_grid.js`。

## 5. 与 `main` 的文件差异（别搬回来）

- main 有、本机没有：`static/js/ltx-director-timeline.js`、`static/js/shared/matrix-run.js`、`static/vendor/js/lucide.js`、`static/runninghub/api_providers.json`、`assets/models/face_detection_yunet.onnx`、`static/images/concept/pinterest_carousel.mp4`。
  （前两个是 §3.6 有意下线的产物；`api_providers.json` 在本机是 gitignore 的运行时文件，缺失时 `main.py` 约 1301 行有兜底逻辑。）
- 本机有、main 没有：`server/protocols/*`、`static/js/shared/table-model.js`、`table-node.js`、`static/css/table-node.css`、`static/js/shared/dropdown.js`、`docs/v2/DXOS_TABLE_SPEC.md` 等、`tests/test_table_*.js` 等。

## 6. 坑与约定（改之前先看）

1. **两套画布**：`static/js/canvas.js`（经典）与 `static/js/smart-canvas.js`（智能）是两套独立实现，改一边别假设另一边同理；表格节点已抽到 `shared/table-node.js` 共用一份。
2. **`server/protocols/*.json` 是运行必需的数据文件**，打包/一键更新必须带上（1.0.117 修的就是这个：更新白名单、PyInstaller `--add-data`、NSIS、desktop `extraFiles`）。新增运行时数据文件时四处都要补。
3. **启动时会改写 HTML**：`sync_static_html_versions()` 每次启动给 `static/*.html` 的 `?v=` 重新编号 → 跑完服务常常出现"未提交改动"，不是别人改的。
4. **静态资源无构建步骤**：原生 HTML/JS + Tailwind CDN（`vendor/` 本地副本），改完刷新即可；缩进 4 空格，JS 用 IIFE 隔离。
5. **`.gitignore`** 忽略：`_novai_*.log`、`static/runninghub/api_providers.json`、`data/table-fanout/`、`logs/` 等。
6. 提交历史里有一批 `revert`、`test`、`chore` 提交，是被否掉的方案与测试垫片调整，别重蹈覆辙（尤其 LLM 节点尺寸那套）。
7. 后端仍是单体 `main.py`（约 2.4 万行），模块化部分在 `server/routes/`、`server/schemas/`、`server/capabilities.py`、`server/protocols/`；找路由两处都要看。

## 7. 计划文档与待办

- `docs/v2/NOVAI_TASK_TABLE_AND_PROTOCOL_PLAN.md` 是这张表的完整计划（P2 数据与操作契约 / P3 协议与握手 / P4 素材与模型）。
- 提交历史里**明确落地**的条目：P2-5（动态列 `tableSchema`）、P3-1 / P3-2 / P3-4（协议表 + descriptor + Run 预检）。
- 其余条目（P2-1 ~ P2-4、P2-6、P2-7、P3-3、P3-5、P3-6、P4-*）在提交信息里没有出现，**接手时按该文档逐条对照当前代码确认**，别默认已完成。
- `docs/superpowers/specs/` 下是桌面打包等 spec；`docs/NOVAI_V2_*.md` 是更早的审计/风险/验收文档（部分结论针对测试版副本，注意甄别）。

## 8. 交接时的状态

- 本机工作区干净，远端分支 = 本地分支。
- 本机 GitHub 直连不通，走 Clash 代理 `http://127.0.0.1:7897`（`git -c http.proxy=... `）；另一台电脑如果网络正常可忽略。
- 本机没有留下额外的本地改动：所有 1.0.115 → 1.0.117 的改动都已在本分支里。
