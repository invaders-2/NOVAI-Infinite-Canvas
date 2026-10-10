#!/bin/bash
# 修复权限并启动服务
# 双击运行即可

cd "$(dirname "$0")"

# NOVAI_PORT 是后端读的端口变量（默认 3000）；导出给 main.py，脚本里的清理/提示地址才和实际监听一致
PORT="${NOVAI_PORT:-3000}"
export NOVAI_PORT="$PORT"

echo "============================================"
echo "   ComfyUI-API-Modelscope"
echo "============================================"
echo ""
echo "修复权限中..."

# 移除安全限制（只针对实际存在的文件类型）
xattr -r -d com.apple.quarantine *.command 2>/dev/null
xattr -r -d com.apple.quarantine main.py 2>/dev/null

# 设置执行权限（修正：原脚本引用了不存在的 启动服务.command/启动服务.py）
chmod +x *.command 2>/dev/null
chmod +x main.py 2>/dev/null

echo "权限已修复！"
echo ""

# 清理占用端口（$PORT）的旧进程，避免 address already in use
OLD_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$OLD_PID" ]; then
    echo "检测到 $PORT 端口被占用，正在停止旧进程 (PID: $OLD_PID)..."
    kill $OLD_PID 2>/dev/null
    sleep 1
    # 仍未退出则强制结束
    if lsof -ti :$PORT >/dev/null 2>&1; then
        kill -9 $(lsof -ti :$PORT) 2>/dev/null
    fi
    echo "旧进程已停止。"
    echo ""
fi

echo "正在启动服务..."
echo "本机访问： http://127.0.0.1:$PORT/"
echo "============================================"
echo ""

# 优先使用 Homebrew Python，避免部分工具管理的 Python 签名问题
if [ -x /opt/homebrew/bin/python3 ]; then
    /opt/homebrew/bin/python3 main.py
elif [ -x /usr/local/bin/python3 ]; then
    /usr/local/bin/python3 main.py
elif command -v python3 >/dev/null 2>&1; then
    python3 main.py
else
    echo "错误：找不到 Python3，请先安装 Python 3.10+："
    echo "https://www.python.org/downloads/"
    read -p "按 Enter 键退出..."
    exit 1
fi
