#!/bin/bash
cd "$(dirname "$0")"
# NOVAI_PORT 是后端读的端口变量（默认 3000）；导出给 main.py，脚本报的地址才和实际监听一致
PORT="${NOVAI_PORT:-3000}"
export NOVAI_PORT="$PORT"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP="127.0.0.1"
fi
APP_URL="http://${LAN_IP}:${PORT}/"

echo "Starting ComfyUI-API-Modelscope..."
echo "Visit: ${APP_URL}"
echo "Local: http://127.0.0.1:${PORT}/"
echo "Press Ctrl+C to stop."
echo ""

# Open browser after 3 seconds
sleep 3 && open "${APP_URL}" &

python3 main.py

echo ""
echo "Server stopped."
