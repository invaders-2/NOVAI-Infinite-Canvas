#!/bin/bash
cd "$(dirname "$0")"
echo "============================================"
echo "   Installing dependencies (offline)"
echo "============================================"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python not found. Please install Python 3.10+"
    echo "Download: https://www.python.org/downloads/"
    read -p "Press Enter to exit..."
    exit 1
fi

python3 --version

echo ""
echo "[1/2] Checking pip..."
python3 -m pip --version &> /dev/null
if [ $? -ne 0 ]; then
    echo "pip not found, bootstrapping..."
    python3 -m ensurepip --upgrade
fi

echo "[2/2] Installing from local packages folder..."
python3 -m pip install --no-index --find-links=packages -r requirements.txt

if [ $? -ne 0 ]; then
    echo ""
    echo "[WARN] Offline install failed, trying online..."
    python3 -m pip install -r requirements.txt
fi

echo ""
echo "Done. 双击 '启动.command' 或 'mac-启动服务.command' 启动服务。"
read -p "Press Enter to exit..."