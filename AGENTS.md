# AGENTS.md — NOVAI / Infinite Canvas

AI 创作工具：无限画布 + 多模型调用（OpenAI API、ComfyUI、火山引擎、即梦 CLI、ModelScope），提供图片/视频生成、GPT 对话、资产管理。

## 运行与验证

- 启动：Windows 双击 `启动.bat`（桌面窗口模式走 `novai-desktop.py`，浏览器模式走 `main.py`）；macOS 用 `启动.command`。
- 端口：环境变量 **`NOVAI_PORT`**，默认 3000。（旧启动脚本里的 `DEPLOY_RUN_PORT` 只是别名，Python 侧读的是 `NOVAI_PORT`。）
- 依赖：`pip install -r requirements.txt`。
- 测试：`tests/` 下只有少量脚本（如 `test_canvas_log_cleanup.py`），没有统一测试入口。改动后请起服务、打开对应页面手动自测再交付。
- 允许自行改文件、起服务、反复重试，不需要每步问我；只有对外发布（git push / 发版 / 改远端数据）时才先问。

## 改之前先看的坑

- `main.py` 是**单体后端**（约 2.2 万行），绝大多数路由都在里面；`server/` 下另有一层模块化代码（`server/routes/`、`server/schemas/`、`server/appRegistry.py`、`server/capabilities.py`）。找路由时两处都要看。
- `static/js/canvas.js` 与 `static/js/smart-canvas.js` 是**两套独立画布实现**（传统节点连线式 vs 智能画布），改一边不要假设另一边同理。
- 画布缩放/平移由 `viewport` 对象（x, y, scale）驱动，改动需同步 `applyViewport()` 与 `renderLinks()`。
- 前端是原生 HTML/JS，无构建步骤；`index.html` 用 iframe 加载子页面，页面切换靠 `switchUI()`，跨页面通信用 `postMessage`。
- 缩进 4 空格；JS 用 IIFE 隔离模块；CSS 走 CSS 变量 + Tailwind CDN（另有 `vendor/` 本地资源）。

## 设计约束（UI，硬规则）

- **不画线框、不画发丝线**：不要用 `border`、`border-color`、`box-shadow: inset 0 0 0 1px`、1px 高光/描边来表达分隔、层级或选中态。这条针对新写的样式，也针对改动时顺手看到的旧样式。
- **层级靠别的表达**：分隔用间距/留白；容器靠磨砂玻璃底 + 柔和投影；选中态用「半透明软底 + 文字色提亮 + 字重变化」（本项目的滑块高亮 `.nv-glide-pill` / `--nv-glide-bg` 就是这套），必要时加一颗小圆点，不要描边。
- **磨砂玻璃配方**（弹层/浮层的标准写法，照抄 `.smart-popover` / `.smart-node-floating-menu`）：`border:0` + `background:color-mix(in srgb, var(--panel) 78%, transparent)`（深色 70%）+ `backdrop-filter:blur(44px) saturate(190%)`（含 `-webkit-`）+ 两层柔和投影。底色要保证 `backdrop-filter` 失效时文字仍可读。
- 例外只有「本身是图形/图标」的描边，例如比例格子里表示画幅的小方框。
- **图标一律保持线性（描边）风格**：下拉三角、比例/画幅图标、播放三角、缩放把手、端口 ⊕、对勾、spinner 这些是「图形/图标」，用描边（border / currentColor 笔画 / lucide 线性图标）画，**不要**改成实心填充、也不要去掉它们的笔画。改 UI 时这部分原样保留。
- **select 的自绘下拉箭头统一用线性人字**：`background-image: var(--select-caret)`（变量定义在 `marvis-shared.css`，亮/暗各一条 SVG data URI，跟 lucide chevron-down 同款描边），位置 `calc(100% - 8px) 50%`、大小 10px、`padding-right:24px`。**不要**再用两条 `linear-gradient` 拼的实心三角。
- **另一个明确例外：`.nv-beam` / `.nv-beam-wrap` 的动态光束边框**（home / online / gpt-chat 三页的「开始创作」「生成」按钮用的 border-beam 动效，实现在 `static/css/nv-beam.css` 与三页的内联副本里）。它是产品要的效果，用 `mask-composite` 收成 2px 环、**不要**改成模糊外发光，清扫线框时跳过它。

## 文档（按需读，不要预先全读）

- `docs/v2/`：NOVAI V2 设计、变更地图、风险与验收清单
- `docs/NOVAI_ARCHITECTURE_AUDIT.md` 位于 `docs/v2/`；`docs/IMAGE_COLOR_ADJUST_DESIGN.md` 是图像调色设计
- `docs/superpowers/specs/`：桌面打包设计等 spec
- `README.md` / `新手运行与使用教程.md`：安装、运行、打包
