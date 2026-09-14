# NOVAI 桌面应用打包设计方案

**日期**: 2026-07-16  
**版本**: 基于现有 NOVAI-main 项目 (VERSION 1.0.81)

---

## 一、目标

将 NOVAI 项目打包为 Win + Mac 双平台可安装桌面应用，内置 Python 运行环境和所有依赖，开箱即用。支持启动时自动检查更新 + 手动检查更新，更新后自动重启，用户数据不受影响。

---

## 二、打包架构（混合方案）

### 2.1 整体架构

```
┌─────────────────────────────────────┐
│  NOVAI.exe  (PyInstaller --onefile) │
│  ┌─────────────────────────────┐    │
│  │  Python 3.x + 全部依赖      │    │
│  │  + 启动器代码                │    │
│  └─────────────────────────────┘    │
│  职责：提供 Python 运行环境，       │
│  启动时加载安装目录下的 main.py      │
└─────────────────────────────────────┘

安装目录 (C:\Program Files\NOVAI)
├── NOVAI.exe              ← 启动器+Python环境（不参与更新）
├── main.py                ← 业务代码（更新白名单）
├── static/                ← 前端资源（更新白名单）
├── tools/                 ← 工具脚本（更新白名单）
├── VERSION                ← 版本号（更新白名单）
├── 安装即梦CLI.bat
├── 登录即梦CLI.bat
├── requirements.txt
├── app.py
├── packages/
└── 其他数据文件

%APPDATA%\NOVAI\
├── data/                  ← 用户数据（永不触碰）
├── output/                ← 生成内容（永不触碰）
├── assets/output/         ← 图片视频（永不触碰）
└── update_backups/        ← 更新备份
```

### 2.2 设计理由

- **Onefile exe + 外置业务代码**：Python 环境锁在 exe 里不可被误改，业务代码（main.py / static/ / tools/）外置支持热更新
- **零改动复用现有更新逻辑**：`update_allowed_file()` 白名单天生匹配此架构
- **用户数据隔离到 %APPDATA%**：安装目录和用户数据完全分离，更新/卸载不丢数据

### 2.3 启动流程

```
双击 NOVAI.exe
  │
  ├─ 1. 启动 FastAPI 后端服务 (127.0.0.1:3000)
  │
  └─ 2. 打开桌面窗口 (pywebview)，加载 http://127.0.0.1:3000

用户也可直接用浏览器访问 http://127.0.0.1:3000
```

---

## 三、Windows 安装程序

### 3.1 工具选型

**NSIS**（Nullsoft Scriptable Install System）

- 轻量原生，不引入额外运行时依赖
- 支持自定义页面、静默安装、快捷方式管理
- 生成的安装包体积小

### 3.2 安装流程

```
双击 NOVAI-Setup.exe
  │
  ├─ 检测 VC++ 运行时，缺则静默安装
  ├─ 选择安装路径（默认 C:\Program Files\NOVAI）
  ├─ 复制文件到安装目录
  ├─ 创建桌面快捷方式
  ├─ 创建开始菜单程序组（含启动 + 卸载入口）
  └─ 完成
```

### 3.3 卸载

- 标准卸载程序，通过控制面板或开始菜单入口触发
- 卸载时询问是否保留用户数据（%APPDATA%\NOVAI\）
- 勾选保留则只删除安装目录，不碰用户数据

---

## 四、更新机制

### 4.1 更新源

三个仓库并发检测，任意一个成功即可：

| 源 | URL |
|---|---|
| GitHub | `https://raw.githubusercontent.com/invaders-2/NOVAI/main/VERSION` |
| Gitee | `https://gitee.com/invaders/novai/raw/master/VERSION` |
| ModelScope | `https://modelscope.cn/api/v1/studio/bllack/NOVAI/repo?Revision=main&FilePath=VERSION` |

### 4.2 更新流程

```
启动时自动检查 → 三源并发检测版本
    │
    ├─ 无更新 → 静默跳过
    └─ 有更新 → 弹窗展示更新内容

手动「检查更新」
    │
    ├─ 已是最新 → 弹窗「当前已是最新版本」
    └─ 有更新 → 弹窗展示更新内容（版本号 + 更新日志）

弹窗点「立即更新」
    │
    ├─ 后台下载更新文件（显示进度）
    ├─ 自动备份当前文件到 %APPDATA%/NOVAI/update_backups/
    ├─ 原子替换文件（下载到 .update_tmp → os.replace）
    ├─ 跳过 data/ / output/ / assets/output/
    └─ 自动重启软件，加载新版本
```

### 4.3 文件白名单（现有逻辑，不改）

```python
def update_allowed_file(path: str) -> bool:
    # 只更新这些，其余一律跳过
    return (
        path in {"main.py", "VERSION", "安装即梦CLI.bat", "安装即梦CLI.command",
                 "登录即梦CLI.bat", "登录即梦CLI.command"}
        or path.startswith("static/")
        or path.startswith("tools/")
    )
```

### 4.4 自动重启

复用现有 `schedule_self_restart()` 逻辑，适配为：

- 生成临时 bat 脚本
- 等待旧进程退出 → 启动 NOVAI.exe
- 脚本自删除

---

## 五、Mac 打包

### 5.1 打包方式

- PyInstaller `--onefile` 生成 macOS 可执行文件
- 打包为 `.app` Bundle 结构
- DMG 磁盘镜像分发

### 5.2 架构（与 Win 一致）

```
NOVAI.app/Contents/
├── MacOS/NOVAI          ← 启动器+Python环境
├── Resources/
│   ├── main.py          ← 业务代码
│   ├── static/          ← 前端资源
│   ├── tools/           ← 工具脚本
│   └── VERSION
└── ...

用户数据：~/Library/Application Support/NOVAI/
```

### 5.3 签名与公证

- 需要 Apple Developer 证书进行代码签名
- 通过 Apple 公证（notarization）避免 Gatekeeper 拦截
- 若暂无证书，提供未签名版本 + 手动右键打开的说明

---

## 六、项目文件结构变更

### 6.1 新增文件

| 文件 | 说明 |
|------|------|
| `installer.nsi` | NSIS 安装脚本（Windows） |
| `launcher.py` | 打包用启动器，替代 novai-desktop.py |
| `NOVAI.spec` | 更新后的 PyInstaller spec（适配混合方案） |
| `build-all.py` | 统一构建脚本（一键打包 Win + 安装包） |

### 6.2 修改文件

| 文件 | 变更 |
|------|------|
| `main.py` | `schedule_self_restart` 适配 exe 启动方式（启动 NOVAI.exe 而非 bat） |
| `build.py` | 更新打包参数，匹配新架构 |
| `novai-desktop.py` | 替换为 launcher.py |

---

## 七、构建流程

```
build-all.py
  │
  ├─ 1. pip install pyinstaller pywebview
  ├─ 2. PyInstaller 打包 launcher.py → dist/NOVAI.exe
  ├─ 3. 复制 main.py / static/ / tools/ / VERSION ... 到 dist-desktop/
  ├─ 4. NSIS 编译 installer.nsi → dist-desktop/NOVAI-Setup.exe
  └─ 5. (Mac) 打包 .app + 创建 DMG
```

---

## 八、测试计划

| 测试项 | 方法 |
|------|------|
| 安装程序正常运行 | 在干净 Windows 环境安装，检查桌面快捷方式、开始菜单、文件完整性 |
| 软件启动 | 双击 exe / 快捷方式，确认服务启动 + 窗口打开 |
| 浏览器访问 | 打开浏览器访问 127.0.0.1:3000，确认功能正常 |
| 更新检查 | 模拟远端版本号高于本地，确认弹窗内容正确 |
| 更新执行 | 触发更新，确认备份、替换、重启全流程 |
| 用户数据保护 | 更新后确认 data/ 和 output/ 内容完好 |
| 卸载 | 卸载后确认安装目录清空，用户数据按选择保留/删除 |
| Mac 启动 | 在 macOS 上双击 .app，确认服务启动 + 浏览器可访问 |
