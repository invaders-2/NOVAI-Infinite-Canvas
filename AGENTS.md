# AGENTS.md — NOVAI / Infinite Canvas

AI 创作工具：无限画布 + 多模型调用（OpenAI API、ComfyUI、火山引擎、即梦 CLI、ModelScope），提供图片/视频生成、GPT 对话、资产管理。

## 运行与验证

- 启动：Windows 双击 `启动.bat`（桌面窗口模式走 `novai-desktop.py`，浏览器模式走 `main.py`）；macOS 用 `启动.command`。
- 端口：环境变量 **`NOVAI_PORT`**，默认 3000。（旧启动脚本里的 `DEPLOY_RUN_PORT` 只是别名，Python 侧读的是 `NOVAI_PORT`。）
- 依赖：`pip install -r requirements.txt`。
- 测试：`node tests/run-all.js` 跑全部 node 测试。**自动化 / 手动验证一律用独立数据目录**：`NOVAI_DATA_DIR=/tmp/novai-test python main.py`，不要在日常数据里建 `TEMP-*` / `VERIFY-*` 画布（清理见 `tools/cleanup_test_canvases.py`）。
- 允许自行改文件、起服务、反复重试，不需要每步问我；只有对外发布（git push / 发版 / 改远端数据）时才先问。

## 改之前先看的坑

- `main.py` 是**单体后端**（约 2.2 万行），绝大多数路由都在里面；`server/` 下另有一层模块化代码（`server/routes/`、`server/schemas/`、`server/appRegistry.py`、`server/capabilities.py`）。找路由时两处都要看。
- 默认传统画布入口 `static/canvas.html` 已替换为 OpenArc `canvas-next` 无限画布，对外名称为「智能画布BEAT」：源码与 NOVAI REST 适配器在 `openarc-canvas-ui/`，`cd openarc-canvas-ui && npm install && npm run build` 输出到 `static/openarc-canvas/`（构建产物要一起提交）。`novaiBackend.ts` 负责文档/生成，`novaiBridge.ts` 负责素材库、提示词、工作流、技能与记忆；协作、共享、团队库、元素同步和桌面专用入口在 NOVAI 宿主中隐藏。`static/legacy-canvas.html` + `static/js/canvas.js` 保留传统实现作回退；`static/js/smart-canvas.js` 仍是独立智能画布，三套实现不要假设可以同步改动。
- 传统回退页的缩放/平移由 `viewport` 对象（x, y, scale）驱动，改动需同步 `applyViewport()` 与 `renderLinks()`；OpenArc 画布使用自己的 `view`（x, y, k）与 store。
- 旧前端页面是原生 HTML/JS，无构建步骤；`index.html` 用 iframe 加载子页面，页面切换靠 `switchUI()`，跨页面通信用 `postMessage`。`web/`、`canvas-ui/` 与 `openarc-canvas-ui/` 三个微应用分别有构建流程。
- **NOVAI 2.0 新前端（逐页替换中）**：源码在 `web/`（Vue 3 + Vite），`cd web && npm install && npm run build` 输出到 `static/v2/`（构建产物要一起提交，桌面包不跑 Node）；后端默认入口 `/` 返回它（`/v2` 同样可用；新版未构建时 `/` 自动回退旧外壳），旧外壳保留在 `/legacy` 作为回退（设置 → 关于 →「旧版界面」可切换）。
  - 已用 Vue 重写：外壳（侧栏 / 标题栏 / 设置弹窗全部 6 页：通用、API 设置、工作流设置、数据备份、外观、关于 / 更新弹窗 / 欢迎页）、画布列表（`web/src/pages/canvas/CanvasListPage.vue`）、在线生图 / Z-Image（`pages/online/`）、GPT 对话（`pages/chat/`）、素材库（`pages/assets/`）。首页仍保留旧 `static/home.html`；传统画布由 `openarc-canvas-ui` 提供，智能画布仍用 `smart-canvas.html`。
  - 用户要求：首页继续用旧 `static/home.html`（iframe），左侧导航保持旧外壳的样式与交互（`web/src/shell/Sidebar.vue` 是旧 index.html 侧栏的移植）。进度与约定见 `web/REWRITE.md`。
  - 画布页是 native + frame：没打开画布时显示 Vue 列表；`openCanvasUrl()` 把 `frame-canvas` 指到旧编辑器，编辑器点「返回画布列表」会把 iframe 指回 `canvas-list.html`，LegacyStage 在 load 时识别到就调 `closeCanvas()` 切回 Vue 列表（旧 canvas-list.html 仍保留给旧外壳 `/` 用）。其余页面仍是旧 HTML，新外壳用 `frame-<id>` iframe 承载，消息协议与旧 `index.html` 完全一致（见 `web/src/lib/bridge.js` 顶部注释）。
  - 页面注册表在 `web/src/lib/store.js` 的 `PAGES`：重写完一页就把它的 `legacy` 换成 `native` 组件。
  - 设计系统 tokens / 组件样式在 `web/src/styles/ds.css`（与画布效果图同源），图标在 `web/src/lib/icons.js`（线性 1.5）。
- 缩进 4 空格；JS 用 IIFE 隔离模块；CSS 走 CSS 变量 + Tailwind CDN（另有 `vendor/` 本地资源）。

## 设计约束（UI，硬规则）

- **不画线框、不画发丝线**：不要用 `border`、`border-color`、`box-shadow: inset 0 0 0 1px`、1px 高光/描边来表达分隔、层级或选中态。这条针对新写的样式，也针对改动时顺手看到的旧样式。
- **层级靠别的表达**：分隔用间距/留白；容器靠磨砂玻璃底 + 柔和投影；选中态用「半透明软底 + 文字色提亮 + 字重变化」（本项目的滑块高亮 `.nv-glide-pill` / `--nv-glide-bg` 就是这套），必要时加一颗小圆点，不要描边。
- **磨砂玻璃配方**（弹层/浮层的标准写法，照抄 `.smart-popover` / `.smart-node-floating-menu`）：`border:0` + `background:color-mix(in srgb, var(--panel) 78%, transparent)`（深色 70%）+ `backdrop-filter:blur(44px) saturate(190%)`（含 `-webkit-`）+ 两层柔和投影。底色要保证 `backdrop-filter` 失效时文字仍可读。
  - **小弹层 / 下拉 / 工具面板例外**（2026-09 起）：它们常盖在图片或文字上，且嵌在编辑栏、节点这些 backdrop root 里时模糊采样不到后面的内容，78% 会透字、被图片染色。统一用近乎不透明的实底（浅 `rgba(255,255,255,.96)`、深 `rgba(24,24,24,.95)`），规则集中在 `smart-canvas.css` 末尾「弹层底色加厚」一段；大面积的编辑栏仍用磨砂。
- 例外只有「本身是图形/图标」的描边，例如比例格子里表示画幅的小方框。
- **图标一律保持线性（描边）风格**：下拉三角、比例/画幅图标、播放三角、缩放把手、端口 ⊕、对勾、spinner 这些是「图形/图标」，用描边（border / currentColor 笔画 / lucide 线性图标）画，**不要**改成实心填充、也不要去掉它们的笔画。改 UI 时这部分原样保留。
- **select 的自绘下拉箭头统一用线性人字**：`background-image: var(--select-caret)`（变量定义在 `marvis-shared.css`，亮/暗各一条 SVG data URI，跟 lucide chevron-down 同款描边），位置 `calc(100% - 8px) 50%`、大小 10px、`padding-right:24px`。**不要**再用两条 `linear-gradient` 拼的实心三角。
- **另一个明确例外：`.nv-beam` / `.nv-beam-wrap` 的动态光束边框**（home / online / gpt-chat 三页的「开始创作」「生成」按钮用的 border-beam 动效，实现在 `static/css/nv-beam.css` 与三页的内联副本里）。它是产品要的效果，用 `mask-composite` 收成 2px 环、**不要**改成模糊外发光，清扫线框时跳过它。

## 文档（按需读，不要预先全读）

- `docs/v2/`：NOVAI V2 设计、变更地图、风险与验收清单
- `docs/NOVAI_ARCHITECTURE_AUDIT.md` 位于 `docs/v2/`；`docs/IMAGE_COLOR_ADJUST_DESIGN.md` 是图像调色设计
- `docs/superpowers/specs/`：桌面打包设计等 spec
- `README.md` / `新手运行与使用教程.md`：安装、运行、打包
- `docs/待推送清单.md`：**每次 push / 发版前必读**——工作树里已改完但未提交的条目、对应文件、验收命令与发版文案
