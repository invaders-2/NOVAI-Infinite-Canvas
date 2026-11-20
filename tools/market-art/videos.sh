#!/bin/bash
# 应用市场轮播：有官方视频的模型用官方示例视频（静音、1280×720、约 10 秒、H.264 faststart）。
# 源视频先下到 _tmp/market-art/src/（来源见 static/images/market/SOURCES.md），然后：
#   bash tools/market-art/videos.sh
# 每段同时导出首帧作为 showcase-<id>.jpg（视频加载前的封面，与视频画面一致）。
set -e
cd "$(dirname "$0")/../.."
SRC=_tmp/market-art/src; OUT=static/images/market
clip() { # id src start duration
  ffmpeg -v error -y -ss "$3" -t "$4" -i "$SRC/$2" -an -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30" \
    -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart "$OUT/showcase-$1.mp4"
  ffmpeg -v error -y -ss 4 -i "$OUT/showcase-$1.mp4" -vf "scale=1600:900" -frames:v 1 -q:v 3 "$OUT/showcase-$1.jpg"
  echo "[ok] showcase-$1.mp4 $(du -k "$OUT/showcase-$1.mp4" | cut -f1) KB"
}
clip seedance seedance25.mp4 2.2 10
clip kling kling4.mp4 2.0 12
clip gemini g_Castaway_Crash_Zoom_Out_Demo.mp4 4.3 10
