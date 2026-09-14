# ModelScope Studio 入口
# 实际逻辑在 main.py 中，此文件仅为 ModelScope 平台兼容
import uvicorn
from main import app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7860)
