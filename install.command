#!/bin/bash
cd "$(dirname "$0")"

echo "============================================"
echo "  NOVAI 一键安装"
echo "============================================"
echo ""

# 检测 Python
if ! command -v python3 &> /dev/null; then
    echo "[错误] 未检测到 Python 3！"
    echo "请先安装：https://www.python.org/downloads/"
    read -p "按回车退出..."
    exit 1
fi

echo "[1/2] Python $(python3 --version 2>&1)"
echo ""

# 安装依赖
echo "[2/2] 安装依赖..."
python3 -m pip install -r requirements.txt --disable-pip-version-check
if [ $? -ne 0 ]; then
    echo ""
    echo "[错误] 依赖安装失败，请检查网络连接"
    echo "可尝试使用国内镜像源："
    echo "  pip3 install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple"
    read -p "按回车退出..."
    exit 1
fi

echo ""
echo "============================================"
echo "  安装完成！"
echo "============================================"
echo ""
echo "  双击 '启动.command' 启动服务"
echo ""
read -p "是否立即启动？(Y/n) " start
if [ "$start" != "n" ] && [ "$start" != "N" ]; then
    echo ""
    echo "正在启动服务..."
    echo "本机访问：http://127.0.0.1:3000/"
    echo "============================================"
    python3 main.py
fi
