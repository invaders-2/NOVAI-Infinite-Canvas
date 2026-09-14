#!/bin/bash
cd "$(dirname "$0")"

LOG_DIR="$PWD/logs"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/jimeng-cli-login-$(date +%Y%m%d-%H%M%S).log"

DREAMINA_BIN=$(command -v dreamina)
if [ -z "$DREAMINA_BIN" ]; then
    echo "未找到 dreamina CLI。请先运行 安装即梦CLI.command"
    echo ""
    echo "按 Enter 键关闭..."
    read -r
    exit 1
fi

echo "=== 即梦CLI 登录 ==="
echo "找到 dreamina: $DREAMINA_BIN"
echo ""
echo "即将打开登录流程。终端会显示一个验证地址和验证码，"
echo "请在浏览器中打开该地址，输入验证码完成授权。"
echo "注意：验证码有时效，请在 5 分钟内完成。"
echo ""
echo "按 Enter 开始登录..."
read -r

echo "正在登录..." | tee -a "$LOG_PATH"
$DREAMINA_BIN login 2>&1 | tee -a "$LOG_PATH"
LOGIN_EXIT=${PIPESTATUS[0]}

echo ""
if [ $LOGIN_EXIT -ne 0 ]; then
    echo "登录未成功（退出码: $LOGIN_EXIT）"
    echo "常见原因：验证码过期、网络异常、浏览器未打开。"
    echo "请重新运行本脚本再试一次。"
    echo ""
    echo "按 Enter 键关闭..."
    read -r
    exit $LOGIN_EXIT
fi

echo ""
echo "登录成功。正在查询额度..." | tee -a "$LOG_PATH"
$DREAMINA_BIN user_credit 2>&1 | tee -a "$LOG_PATH"
echo ""

API_DIR="$PWD/API"
mkdir -p "$API_DIR"
ENV_PATH="$API_DIR/.env"
if grep -q '^JIMENG_USE_WSL' "$ENV_PATH" 2>/dev/null; then
    sed -i '' '/^JIMENG_USE_WSL/d' "$ENV_PATH"
fi
if grep -q '^DREAMINA_BIN' "$ENV_PATH" 2>/dev/null; then
    sed -i '' '/^DREAMINA_BIN/d' "$ENV_PATH"
fi
echo "JIMENG_USE_WSL=0" >> "$ENV_PATH"
echo "DREAMINA_BIN=$DREAMINA_BIN" >> "$ENV_PATH"
echo "已更新 API/.env: JIMENG_USE_WSL=0, DREAMINA_BIN=$DREAMINA_BIN" | tee -a "$LOG_PATH"

echo ""
echo "完成。" | tee -a "$LOG_PATH"
echo ""
echo "按 Enter 键关闭..."
read -r
