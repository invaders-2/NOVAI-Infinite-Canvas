# ComfyUI-API-Modelscope macOS 一键启动

## 快速开始

### 方法一：双击运行（推荐）

1. **首次使用**：右键点击 `mac-启动服务.command` → 选择 "打开" → 点击 "打开"（绕过安全警告）
2. **之后使用**：直接双击 `mac-启动服务.command` 即可

### 方法二：终端运行

```bash
cd 项目文件夹
python3 main.py
```

## 功能特点

- **自动检测依赖**：首次运行会自动检查并安装所需依赖
- **自动打开浏览器**：服务启动后 3 秒自动打开网页
- **显示访问地址**：同时显示本地地址和局域网地址

## 系统要求

- macOS 10.14 或更高版本
- Python 3.10+（如果没有安装，程序会提示下载链接）

## 安装 Python

如果系统没有 Python，请访问 https://www.python.org/downloads/ 下载安装。

## 文件说明

| 文件 | 说明 |
|------|------|
| `mac-启动服务.command` | 双击运行的启动器（自动修复权限、清理旧进程、启动服务） |
| `mac-修复权限.command` | 单独修复 macOS 安全限制 |
| `main.py` | 服务主程序（直接 `python3 main.py` 即可启动） |
| `安装即梦CLI.command` | 安装/更新 dreamina CLI |
| `登录即梦CLI.command` | 登录 dreamina CLI |

## 常见问题

### 1. 提示 "无法打开，因为无法验证开发者"

**解决方法**：
- 右键点击 `mac-启动服务.command`
- 选择 "打开"
- 在弹出的对话框中点击 "打开"

或者到 系统设置 → 隐私与安全性 → 安全性 → 点击 "仍要打开"

### 2. 提示 "Python 3 not found"

请安装 Python 3.10 或更高版本：
https://www.python.org/downloads/

### 3. 依赖安装失败

尝试手动安装依赖：
```bash
pip3 install fastapi uvicorn httpx pillow requests pydantic python-dotenv websockets watchfiles
```

## 手动控制

### 安装依赖
```bash
pip3 install fastapi uvicorn httpx pillow requests pydantic python-dotenv websockets watchfiles
```

### 启动服务
```bash
python3 main.py
```

## 访问服务

- 本机访问：http://127.0.0.1:3000/
- 局域网访问：http://你的IP:3000/（启动时会显示）

## 停止服务

在终端窗口中按 `Ctrl+C` 即可停止服务。
