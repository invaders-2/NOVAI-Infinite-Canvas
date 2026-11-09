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

## 指向云端（云端模式）

默认仍拉起本机后端。要让桌面端直接连服务器，二选一：

1. 环境变量：`NOVAI_URL=https://novai.example.com`
2. 配置文件：把 `novai-cloud.example.json` 复制成数据目录下的 `novai-cloud.json`，
   内容 `{ "baseUrl": "https://your-host" }`（只接受合法 http/https 地址）。
   数据目录：macOS/Linux `~/NOVAI/`、Windows `%APPDATA%\NOVAI\`（开发模式是仓库 `data/`）；
   Electron 的 `app.getPath('userData')` 也会被查一次，两个位置先查前者。

- 解析顺序：`NOVAI_URL` → `<userData>/novai-cloud.json` → 本机 `http://127.0.0.1:<port>`。
- 命中前两者时**不启动本地后端、不探测端口**，窗口直接加载该地址。
- 想临时回到本机后端：`NOVAI_LOCAL_BACKEND=1`（会跳过配置文件；显式 `NOVAI_URL` 仍优先）。
- 解析逻辑在 `cloud-config.js`（纯函数），单测：`node desktop/__tests__/test_cloud_base_url.js`。

## 打包安装包

```bash
cd desktop
npm run dist          # 当前平台（macOS → dmg+zip；Linux → AppImage+deb；Windows → NSIS）
npm run dist:mac
npm run dist:win      # 需在 Windows 上执行（或 CI）
npm run pack          # 仅解包目录（免安装快速验证）
```

产物输出到 `desktop/release/`。

### Windows 安装包内置 ffmpeg / ffprobe

Windows 安装包自带 **ffmpeg / ffprobe**（[BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) 的 **GPL 静态版**，含 `libx264` / `libx265`），
视频探测、首帧/缩略图、纯转封装，以及视频云压缩 / 时间线剪辑导出都不再依赖用户机器预装。CI
（`.github/workflows/build-electron.yml` 的 `Download bundled ffmpeg (windows, GPL static)` 步骤）把它下载到
`vendor/ffmpeg/win/`，再经 `package.json` 的 **win 专属** `extraResources` 打进产物 `resources/bin/win/`：

- 主进程启动后端时注入 `FFMPEG_PATH` / `FFPROBE_PATH`（仅 win32；用户已显式设置环境变量时不覆盖）；
- 后端 `main.py` 的 `ffmpeg_binary()` / `ffprobe_binary()` 按「环境变量 → 安装包内置 → PATH」解析；
- macOS / Linux 包不含该二进制，仍使用系统 ffmpeg（macOS 可 `brew install ffmpeg`），打包行为不变。

> 第三方组件：FFmpeg / FFprobe（**GPL 静态构建**，含 `libx264` / `libx265`，未修改）。`LICENSE.txt`（GPLv3 原文）
> 与 `SOURCE.txt`（实际构建版本 + 源码获取地址）随包复制到 `resources/bin/win/`。GPLv3 分发义务靠这两份文件
> 满足：版本行形如 `ffmpeg version N-128227-g4811625b5f-...`，`g` 后即 FFmpeg 提交号，源码见
> https://github.com/FFmpeg/FFmpeg ；构建脚本与 release 产物见 https://github.com/BtbN/FFmpeg-Builds 。
> 体积（2026-11-09 从 GPL zip 中央目录核对）：`ffmpeg.exe` 162.0MB + `ffprobe.exe` 161.8MB（解压后），zip 约 201.7MB，
> Windows 安装包体积约 **+120~150MB**（NSIS 压缩后估算）。
>
> **libx264 已可用**：原 LGPL 方案不含 GPL-only 的 `libx264`，`main.py` 的云压缩
> （`compress_video_for_cloud_upload`）与时间线 / 剪辑导出（写死 `libx264`）在 Windows 上会报
> `Unknown encoder 'libx264'`；换 GPL 静态版后这条阻塞解除。
>
> 本地直接在 Windows 上 `npm run dist:win` 时，若没有 `vendor/ffmpeg/win/ffmpeg.exe`，
> electron-builder 只打一条 warning、产物不含内置 ffmpeg；请先按 CI 的下载步骤准备该目录。

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
