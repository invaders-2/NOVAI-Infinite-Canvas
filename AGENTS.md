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

## 文档（按需读，不要预先全读）

- `docs/v2/`：NOVAI V2 设计、变更地图、风险与验收清单
- `docs/NOVAI_ARCHITECTURE_AUDIT.md` 位于 `docs/v2/`；`docs/IMAGE_COLOR_ADJUST_DESIGN.md` 是图像调色设计
- `docs/superpowers/specs/`：桌面打包设计等 spec
- `README.md` / `新手运行与使用教程.md`：安装、运行、打包
