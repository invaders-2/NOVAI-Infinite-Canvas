"""定位 ffmpeg 套件里的 ffprobe。

安装包把 ffmpeg/ffprobe 放在同一个目录：Windows 文件名带 .exe，macOS/Linux 不带。
调用方一般只拿得到 ffmpeg 的路径（桌面主进程通过 FFMPEG_PATH 告诉后端），所以候选名
按 ffmpeg 自己的文件名推：ffmpeg.exe 先找 ffprobe.exe，其余先找无后缀的 ffprobe；
最后才轮到 shutil.which（安装版不往 PATH 里加 bin，这条路通常落空）。

Windows 上「深度动作捕捉读不到源视频分辨率」就是只拼了无后缀的 ffprobe：
内置那份叫 ffprobe.exe，拼出来的路径不存在，探测直接返回空。
"""
from __future__ import annotations

import os
import shutil


def _variants(ffmpeg: str) -> list[str]:
    if ffmpeg.lower().endswith(".exe"):
        return ["ffprobe.exe", "ffprobe"]
    return ["ffprobe", "ffprobe.exe"]


def ffprobe_path(ffmpeg: str = "") -> str:
    """ffprobe 路径：FFPROBE_PATH → ffmpeg 同目录（按 .exe 变体推）→ PATH；都没有返回空串。"""
    override = (os.environ.get("FFPROBE_PATH") or "").strip()
    if override and os.path.isfile(override):
        return override
    names = _variants(ffmpeg or "")
    if ffmpeg:
        directory = os.path.dirname(ffmpeg)
        for name in names:
            candidate = os.path.join(directory, name) if directory else name
            if os.path.isfile(candidate):
                return candidate
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""
