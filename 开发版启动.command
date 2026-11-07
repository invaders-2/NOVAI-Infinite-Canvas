#!/bin/bash
# 开发版后端：用当前项目代码启动，端口从 3101 往后找空闲的，不碰正式版占用的 3000。
cd "$(dirname "$0")"
PORT=3101
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT+1))
  if [ $PORT -gt 3120 ]; then echo "3101-3120 都被占用了"; read -n1 -p "按任意键退出"; exit 1; fi
done
if [ -x venv/bin/python3 ]; then PY=venv/bin/python3; else PY=python3; fi
export NOVAI_PORT=$PORT
echo "开发版后端（项目代码）"
echo "地址: http://127.0.0.1:${PORT}/"
echo "Python: $PY"
echo "按 Ctrl+C 停止。正式版 3000 不受影响。"
echo ""
(sleep 4 && open "http://127.0.0.1:${PORT}/") &
"$PY" main.py --port $PORT
echo ""
echo "后端已停止。如果上面有报错，把这个窗口的内容截图发给我。"
read -n1 -p "按任意键关闭"
