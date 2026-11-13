# AGENTS.md — NOVAI / Infinite Canvas

AI 创作工具：无限画布 + 多模型调用（OpenAI API、ComfyUI、火山引擎、即梦 CLI、ModelScope），提供图片/视频生成、GPT 对话、资产管理。

## 运行与验证

- 启动：Windows 双击 `启动.bat`（桌面窗口模式走 `novai-desktop.py`，浏览器模式走 `main.py`）；macOS 用 `启动.command`。
- 端口：环境变量 **`NOVAI_PORT`**，默认 3000。（旧启动脚本里的 `DEPLOY_RUN_PORT` 只是别名，Python 侧读的是 `NOVAI_PORT`。）
- **3000 端口是「正式安装版」的后端，任何改动版 / 预览版永远不许碰它**（用户明确、长期规则，优先于下面「不要起新后端」那条）：不 kill、不重启、不停、不发写请求、不改它的数据。改动版一律用独立端口 + 独立数据目录跑自己的后端（例：`NOVAI_PORT=3931 NOVAI_DATA_DIR=/tmp/novai-preview python main.py`），所有检查只打自己起的那个端口，用完自己收尾。
- 依赖：`pip install -r requirements.txt`。
- 测试：`node tests/run-all.js` 跑全部 node 测试。**自动化 / 手动验证一律用独立数据目录**：`NOVAI_DATA_DIR=/tmp/novai-test python main.py`，不要在日常数据里建 `TEMP-*` / `VERIFY-*` 画布（清理见 `tools/cleanup_test_canvases.py`）。
- 允许自行改文件、起服务、反复重试，不需要每步问我；只有对外发布（git push / 发版 / 改远端数据）时才先问。
- **预览 / 验收在后台跑，不要弹窗**（用户明确要求）：不要启动 GUI 窗口、不要抢前台；预览只连自己那个独立端口的后端，**3000（正式安装版）一律不碰**。渲染与截图用无头浏览器 + CDP（`Page.captureScreenshot`），日志写到 /tmp 再看，不要在会话里等窗口。
  - 关缓存：每次用全新 `--user-data-dir=/tmp/xxx`，别复用。
  - 关进程：脚本自己 `proc.kill()` 收尾，别用 `pkill -f "..."`——模式串会匹配到执行命令本身的 shell，把自己杀掉、输出全丢（踩过）。
  - 改画布 UI 必须改 `novai-canvas-ui/` 源码再 `npm run build`；只改 `static/novai-canvas/` 会被下次构建覆盖（踩过：补丁被清空、`skill-thumbs.js` 变 404）。

## 改之前先看的坑

- `main.py` 是**单体后端**（约 2.2 万行），绝大多数路由都在里面；`server/` 下另有一层模块化代码（`server/routes/`、`server/schemas/`、`server/appRegistry.py`、`server/capabilities.py`）。找路由时两处都要看。
- 默认传统画布入口 `static/canvas.html` 已替换为 NOVAI `canvas-next` 无限画布，对外名称为「智能画布BEAT」：源码与 NOVAI REST 适配器在 `novai-canvas-ui/`，`cd novai-canvas-ui && npm install && npm run build` 输出到 `static/novai-canvas/`（构建产物要一起提交）。`novaiBackend.ts` 负责文档/生成，`novaiBridge.ts` 负责素材库、提示词、工作流、技能与记忆；协作、共享、团队库、元素同步和桌面专用入口在 NOVAI 宿主中隐藏。`static/legacy-canvas.html` + `static/js/canvas.js` 保留传统实现作回退；`static/js/smart-canvas.js` 仍是独立智能画布，三套实现不要假设可以同步改动。
- **两个画布别搞混（命名坑）**：智能画布BEAT = `/static/canvas.html` → `novai-canvas-ui`（原 `openarc-canvas-ui`，构建到 `static/novai-canvas/`）；旧智能画布 = `/static/smart-canvas.html` → `canvas-ui`（构建到 `static/canvas-assistant/`）。改画布相关 UI 一律先确认在哪一个 app。
- 传统回退页的缩放/平移由 `viewport` 对象（x, y, scale）驱动，改动需同步 `applyViewport()` 与 `renderLinks()`；NOVAI 画布使用自己的 `view`（x, y, k）与 store。
- 旧前端页面是原生 HTML/JS，无构建步骤；`index.html` 用 iframe 加载子页面，页面切换靠 `switchUI()`，跨页面通信用 `postMessage`。`web/`、`canvas-ui/` 与 `novai-canvas-ui/` 三个微应用分别有构建流程。
- **NOVAI 2.0 新前端（逐页替换中）**：源码在 `web/`（Vue 3 + Vite），`cd web && npm install && npm run build` 输出到 `static/v2/`（构建产物要一起提交，桌面包不跑 Node）；后端默认入口 `/` 返回它（`/v2` 同样可用；新版未构建时 `/` 自动回退旧外壳），旧外壳保留在 `/legacy` 作为回退（设置 → 关于 →「旧版界面」可切换）。
  - 已用 Vue 重写：外壳（侧栏 / 标题栏 / 设置弹窗全部 6 页：通用、API 设置、工作流设置、数据备份、外观、关于 / 更新弹窗 / 欢迎页）、画布列表（`web/src/pages/canvas/CanvasListPage.vue`）、素材库（`pages/assets/`）。首页仍保留旧 `static/home.html`；传统画布由 `novai-canvas-ui` 提供，智能画布仍用 `smart-canvas.html`。
  - 用户要求：首页继续用旧 `static/home.html`（iframe），左侧导航保持旧外壳的样式与交互（`web/src/shell/Sidebar.vue` 是旧 index.html 侧栏的移植）。进度与约定见 `web/REWRITE.md`。
  - 画布页是 native + frame：没打开画布时显示 Vue 列表；`openCanvasUrl()` 把 `frame-canvas` 指到旧编辑器，编辑器点「返回画布列表」会把 iframe 指回 `canvas-list.html`，LegacyStage 在 load 时识别到就调 `closeCanvas()` 切回 Vue 列表（旧 canvas-list.html 仍保留给旧外壳 `/` 用）。其余页面仍是旧 HTML，新外壳用 `frame-<id>` iframe 承载，消息协议与旧 `index.html` 完全一致（见 `web/src/lib/bridge.js` 顶部注释）。
  - 页面注册表在 `web/src/lib/store.js` 的 `PAGES`：重写完一页就把它的 `legacy` 换成 `native` 组件。
  - 设计系统 tokens / 组件样式在 `web/src/styles/ds.css`（与画布效果图同源），图标在 `web/src/lib/icons.js`（线性 1.5）。
- 缩进 4 空格；JS 用 IIFE 隔离模块；CSS 走 CSS 变量 + Tailwind CDN（另有 `vendor/` 本地资源）。
- **重建静态资源后要刷新缓存号**：`npm run build`（web / canvas-ui / novai-canvas-ui）会改产物 mtime，`static/*.html` 里的 `?v=` 仍是旧值，同版本号下老用户会继续吃缓存。跑 `python3 tools/refresh_static_versions.py --write`（默认 dry-run，幂等，只改 `?v=`），再确认 dry-run 为 0 处。发版时 `tools/bump_version.py --write` 会自动做这一步。

## 设计约束（UI，硬规则）

- **不画线框、不画发丝线**：不要用 `border`、`border-color`、`box-shadow: inset 0 0 0 1px`、1px 高光/描边来表达分隔、层级或选中态。这条针对新写的样式，也针对改动时顺手看到的旧样式。
- **层级靠别的表达**：分隔用间距/留白；容器靠磨砂玻璃底 + 柔和投影；选中态用「半透明软底 + 文字色提亮 + 字重变化」（本项目的滑块高亮 `.nv-glide-pill` / `--nv-glide-bg` 就是这套），必要时加一颗小圆点，不要描边。
- **背景框一律不用透明，默认就是磨砂玻璃质感**（用户 2026-11 明确，硬规则，优先级最高）：任何背景容器 / 卡片 / 面板 / 弹层 / 工具面板都不许用裸 `transparent`，也不许靠低透明度让背后的图片或文字透出来；默认形态 = 半透明底 + `backdrop-filter` 模糊 + 柔和投影，且底色要保证模糊不生效、或背后是高对比图片时文字依然可读。
- **磨砂玻璃配方**（弹层/浮层的标准写法，照抄 `.smart-popover` / `.smart-node-floating-menu`）：`border:0` + `background:color-mix(in srgb, var(--panel) 78%, transparent)`（深色 70%）+ `backdrop-filter:blur(44px) saturate(190%)`（含 `-webkit-`）+ 两层柔和投影。底色要保证 `backdrop-filter` 失效时文字仍可读。
  - **小弹层 / 下拉 / 工具面板例外**（2026-09 起）：它们常盖在图片或文字上，且嵌在编辑栏、节点这些 backdrop root 里时模糊采样不到后面的内容，78% 会透字、被图片染色。统一用加厚底（浅 `rgba(255,255,255,.96)`、深 `rgba(24,24,24,.95)`）+ **仍然保留 `backdrop-filter` 模糊和柔和投影**，不是纯实色平涂（按 2026-11「默认磨砂玻璃」要求），规则集中在 `smart-canvas.css` 末尾「弹层底色加厚」一段；大面积的编辑栏用标准 78% 磨砂。
- 例外只有「本身是图形/图标」的描边，例如比例格子里表示画幅的小方框。
- **图标一律保持线性（描边）风格**：下拉三角、比例/画幅图标、播放三角、缩放把手、端口 ⊕、对勾、spinner 这些是「图形/图标」，用描边（border / currentColor 笔画 / lucide 线性图标）画，**不要**改成实心填充、也不要去掉它们的笔画。改 UI 时这部分原样保留。
  图标动效由三端共用的 static/css/nv-icons.css 提供（vite 构建用 @import 引入），图标数据由 tools/icons/gen.mjs 从 lucide 生成到 web/src/lib/icons.js 与 tools/icons/canonical.json，改图标先改生成器再重跑，别手改产物；React 画布端对应 novai-canvas-ui/src/canvas/canvas-next/ui/iconData.ts（改了 nv-icons.css 要通知重建 static/novai-canvas）。
- **select 的自绘下拉箭头统一用线性人字**：`background-image: var(--select-caret)`（变量定义在 `marvis-shared.css`，亮/暗各一条 SVG data URI，跟 lucide chevron-down 同款描边），位置 `calc(100% - 8px) 50%`、大小 10px、`padding-right:24px`。**不要**再用两条 `linear-gradient` 拼的实心三角。
- **另一个明确例外：`.nv-beam` / `.nv-beam-wrap` 的动态光束边框**（home 页的「开始创作」「生成」按钮用的 border-beam 动效，实现在 `static/css/nv-beam.css` 与该页的内联副本里）。它是产品要的效果，用 `mask-composite` 收成 2px 环、**不要**改成模糊外发光，清扫线框时跳过它。

## 更新流程（固定规范，2026-11 用户定，动更新相关代码前必读）

用户的固定要求：更新不许打断使用。凡是涉及自动更新、发版、更新提示的改动都按这套来，不许退回"弹窗问要不要更新"的老做法。

- **发现新版本不弹窗**：后台静默下载（`desktop/main.js` 的 `startUpdateDownload`），下载完成才通过 `novai:update-stage` 通知前端；不许再出现"发现新版本，是否现在下载"这类原生对话框。
- **下载完成只出一张右下角卡片**（`web/src/shell/UpdateReminder.vue`）：立即重启 / 稍后。点「稍后」必须在 `desktop/update-state.js` 落 `pendingVersion`，退出时静默装完（`convergeUpdateOnQuit` + `autoInstallOnAppQuit`）；不许出现"点了稍后就永远不装"。
- **下次启动先播启动动画**（`desktop/splash.html`），logo + 进度条，后端就绪再显示主窗口，不许白屏干等。
- **升级后首次启动必须弹更新说明**（`web/src/shell/UpdateDone.vue` + 主进程 applied 事件）：逐条列改动，每条可带 `media`（image/gif/video）做动态演示，没素材时退回纯文字。
- **失败必须能兜住**：`bootAttempts` 达阈值自动回滚到备份；安装目录不可写要发 `error(phase:'install')`；关机打断留在 `pendingVersion` 下次重试。不许出现"装一半打不开"。
- **发版素材走固定管线**：更新说明写根 `update-notes.json`（changes 每项可带 media）→ `python3 tools/sync_update_notes.py` 生成 `static/update-notes.json` → 上传三源。占位动图用 `python3 tools/make_update_placeholder_gif.py <版本>`。素材规范与上传步骤见 `README.md`「更新说明与素材（发版流程）」。
- **改完更新链路必须跑**：`cd desktop && npm run test:update`，以及 `node --test tests/test_desktop_{update_bridge,win_update,mac_updater}.js`。这三个回归测试断言的就是新流程，产品行为改了要同步改断言，**不许删断言换绿灯**。
- 设计依据与验收记录见 `_verification-update-flow/evidence.md`；这条链路还没做过真机安装包升级实测（2026-11 当时的遗留项），发版前必须补一次真机升级验证。

## 文档（按需读，不要预先全读）

- `docs/v2/`：NOVAI V2 设计、变更地图、风险与验收清单
- `docs/NOVAI_ARCHITECTURE_AUDIT.md` 位于 `docs/v2/`；`docs/IMAGE_COLOR_ADJUST_DESIGN.md` 是图像调色设计
- `docs/superpowers/specs/`：桌面打包设计等 spec
- `README.md` / `新手运行与使用教程.md`：安装、运行、打包
- `docs/待推送清单.md`：**每次 push / 发版前必读**——工作树里已改完但未提交的条目、对应文件、验收命令与发版文案
