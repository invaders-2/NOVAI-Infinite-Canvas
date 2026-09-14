#!/bin/bash
# NOVAI 一键启动脚本（macOS）
# 双击运行即可自动安装依赖并启动服务

cd "$(dirname "$0")"

echo "============================================"
echo "  NOVAI - AI 创作工具"
echo "============================================"
echo ""

# ---- 修复权限 ----
xattr -r -d com.apple.quarantine *.command 2>/dev/null
xattr -r -d com.apple.quarantine main.py 2>/dev/null
chmod +x *.command 2>/dev/null

# ---- 定位 Python ----
PYEXE=""
if command -v python3 &>/dev/null; then
    PYEXE="python3"
elif command -v python &>/dev/null; then
    PYEXE="python"
else
    echo "[ERROR] 未找到 Python，请安装 Python 3.10+"
    echo "下载: https://www.python.org/downloads/"
    read -p "按回车退出..."
    exit 1
fi

echo "[$PYEXE] $($PYEXE --version 2>&1)"
echo ""

# ---- 检查依赖是否需要安装 ----
DEPS_OK=0
REQ_HASH_FILE=".deps_hash"

if [ -f ".deps_installed" ] && [ -f "$REQ_HASH_FILE" ]; then
    CURRENT_HASH=$(shasum -a 256 requirements.txt 2>/dev/null | awk '{print $1}')
    SAVED_HASH=$(cat "$REQ_HASH_FILE" 2>/dev/null)
    if [ "$CURRENT_HASH" = "$SAVED_HASH" ]; then
        DEPS_OK=1
    fi
fi

if [ "$DEPS_OK" -eq 0 ]; then
    echo "[1/2] 正在检查依赖..."

    # 确保 pip 可用
    $PYEXE -m pip --version &>/dev/null
    if [ $? -ne 0 ]; then
        echo "      正在安装 pip..."
        $PYEXE -c "import urllib.request; urllib.request.urlretrieve('https://bootstrap.pypa.io/get-pip.py', 'get-pip.py')" 2>/dev/null
        if [ -f "get-pip.py" ]; then
            $PYEXE get-pip.py --quiet 2>/dev/null
            rm -f get-pip.py
        fi
    fi

    echo "[2/2] 正在安装/更新依赖（首次可能较慢，请耐心等待）..."
    $PYEXE -m pip install -r requirements.txt --quiet --disable-pip-version-check 2>/dev/null
    if [ $? -ne 0 ]; then
        echo ""
        echo "[WARN] 部分依赖安装失败，尝试继续启动..."
    fi

    # 记录安装标记
    echo "installed" > .deps_installed
    shasum -a 256 requirements.txt 2>/dev/null | awk '{print $1}' > "$REQ_HASH_FILE"

    echo "[OK] 依赖已就绪"
    echo ""
fi

# ---- 确定端口 ----
PORT="${DEPLOY_RUN_PORT:-3000}"

# ---- 清理旧进程 ----
OLD_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$OLD_PID" ]; then
    echo "检测到 $PORT 端口被占用，正在停止旧进程 (PID: $OLD_PID)..."
    kill $OLD_PID 2>/dev/null
    sleep 1
    OLD_PID=$(lsof -ti :$PORT 2>/dev/null)
    if [ -n "$OLD_PID" ]; then
        kill -9 $OLD_PID 2>/dev/null
        sleep 1
    fi
fi

echo "[NOVAI] 正在启动服务..."
echo "[NOVAI] 访问地址: http://127.0.0.1:$PORT/"
echo "[NOVAI] 按 Ctrl+C 停止服务"
echo ""

# 延迟打开浏览器
(sleep 3 && open "http://127.0.0.1:$PORT/" 2>/dev/null) &

# 启动服务
$PYEXE main.py

echo ""
echo "[NOVAI] 服务已停止"
read -p "按回车退出..."
