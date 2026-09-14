# NOVAI 桌面客户端 (Electron)

用 **Electron** 封装 NOVAI 无限画布，产出可在 Windows / macOS / Linux 分发的可安装包。
Electron 启动时拉起项目自带的 **FastAPI 后端**（main.py），以本地页面渲染 —— 与网页版功能一致，
并通过 **pywebview 兼容桥** 让前端**零改动**获得完整的桌面能力（原生对话框 / 窗口控制 / 托盘 / 数据目录）。

## 与旧版（pywebview + PyInstaller）的区别

| 维度 | 旧桌面版（已发布多版） | 本 Electron 版 |
|------|----------------------|----------------|
| 渲染内核 | 系统 WebView（WKWebView / EdgeWebView2） | 自带 Chromium（各平台行为完全一致） |
| 桌面桥接 | Python 层 js_api（launcher.py 1170 行） | preload + IPC（native 一等公民） |
| 兼容性 | 随系统版本漂移（黑屏/无控制条等） | 固定 Chromium，跨平台一致 |
| 自动更新 | 自建三源检查 + 一键升级 | electron-updater（GitHub Releases 增量更新） |
| 安装包 | 较小（~几十 MB） | 较大（~100MB+，含 Chromium） |

## 目录结构

```
desktop/
├── package.json     # 依赖 + electron-builder 打包/发布配置
├── main.js          # 主进程：拉后端 + 端口避让 + 窗口/托盘 + IPC 桥 + 自动更新 + iframe 注入
├── preload.js       # pywebview 兼容桥（window.pywebview.api）+ iframe 转发监听
├── icons/           # 官方图标（icon.icns / icon.ico / icon.png）
└── README.md        # 本文档
```

## 桌面桥接做了什么（前端零改动）

前端按 `window.pywebview.api.*` 约定调用（旧 pywebview 版遗留），本 Electron 版在 preload 里**原样模拟**该对象：

| 前端调用 | Electron 实现 |
|----------|---------------|
| `save_file(dataUrl, name)` | `dialog.showSaveDialog` + 写文件（支持 base64） |
| `select_directory()` | `dialog.showOpenDialog` 选目录 |
| `open_data_dir()` / `get_data_dir()` | `shell.openPath` / 数据目录 |
| `set_auto_start(v)` | `app.setLoginItemSettings` |
| `minimize / maximize / close / quit_app` | `BrowserWindow` 原生控制 |
| `set_titlebar_theme(r,g,b)` | macOS 窗口背景色同步 |
| `start_window_drag` 等 | 无边框窗口（`-webkit-app-region: drag` 原生支持） |

- **UA 注入**：主进程把 `pywebview` 拼进 userAgent，前端 `navigator.userAgent.includes('pywebview')` 的桌面检测直接生效。
- **iframe 子页面**（asset-manager / zimage 等）：通过 `frame-created` 注入迷你 shim，调用经 `postMessage` 转发到主 frame 再走 IPC，子页面同样获得原生能力。
- **pywebviewready 事件**：preload 触发，前端桌面初始化逻辑照常运行。

## 前置要求

- Node.js 18+（本仓库用 22）
- Python 3.10+ 且已安装 `requirements.txt`（运行后端用；若打入 bundled 后端二进制则目标机免 Python）

## 安装依赖

```bash
cd desktop
npm install
```

> 若 `~/.npm` 缓存有 root 属主文件（npm 已知 bug）导致 EPERM，用项目内独立缓存：
> `npm install --cache ./.npm-cache`

## 开发运行

```bash
cd desktop
npm start        # electron . —— 自动用 python3 启动 main.py（端口 3000；被占用自动顺延）
```

## 打包安装包

```bash
cd desktop
npm run dist          # 当前平台（macOS → dmg+zip；Linux → AppImage+deb；Windows → NSIS）
npm run dist:mac
npm run dist:win      # 需在 Windows 上执行（或 CI）
npm run pack          # 仅解包目录（免安装快速验证）
```

产物输出到 `desktop/release/`。

## 自动更新（electron-updater）

- 打包后启动 8 秒检查 **GitHub Releases**（`invaders-2/NOVAI`）新版本。
- 发现新版本弹窗询问 → 下载 → 下载完成弹窗询问重启安装。
- 发布新版本：`npm run dist:publish`（需仓库 `GITHUB_TOKEN` 权限），把 `latest-mac.yml` / `latest.yml` 一并上传。

## 关于打包后端

`build.extraResources` 会将 `main.py` + `requirements.txt` 复制进安装包 `resources/backend/`。
运行时按顺序找后端：**bundled 二进制**（`resources/backend/NOVAI(.exe)`，可用根目录 `build-desktop.py` 预打包）→ **系统 Python 跑 main.py**。
> 完全免 Python 分发：先 `build-desktop.py` 生成后端 exe 放入 `desktop/resources/backend/` 再 `npm run dist:win`。

## 已知说明

- 网页版 `/api/native-save`（走 pywebview）在 Electron 下不再使用 —— 前端已优先走 `window.pywebview.api.save_file` 桥（本版已实现）。
- 需在真实桌面环境验证窗口/托盘/对话框（无显示 CI 只能验证逻辑）。
