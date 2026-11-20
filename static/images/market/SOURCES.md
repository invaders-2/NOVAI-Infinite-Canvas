# 应用市场「最新上线」封面来源

2026-11-19 第五轮：按用户要求，轮播只放当前最新的 7 个模型，封面用各家官网 / 官方文档的示例图。由 `tools/market-art/build.cjs` 一键复现（下载 → 按 crop 裁 16:9 → 覆盖式缩放到 1600×900 → JPG q90）。

> 说明：模型示例图来自厂商官方网站/文档，仅在产品内展示该模型用；**对外发布前需确认授权**。

| 文件 | 模型 | 来源 | 裁切（源图像素） |
|---|---|---|---|
| `showcase-gpt26.jpg` | GPT Image 2.6 | OpenAI 官网发布页没有可下载的示例图，沿用我们用 APIMart `gpt-image-2.6-ext` 生成的玻璃蜂鸟（`tools/market-art/sources/gpt-image-2.6.png`，自制可商用） | `[0, 40, 1024, 576]` |
| `showcase-seedream.jpg` | Seedream 5.5 | 字节 Seed 官网示例图 <https://lf3-static.bytednsdoc.com/obj/eden-cn/bdeh7uhpsuht/sd55-006-22d1692c-l.webp>（2512×1664，酒吧吧台白猫） | `[0, 125, 2512, 1413]` |
| `showcase-minimax.jpg` | MiniMax H3-Image | MiniMax 官网发布头图 <https://file.cdn.minimax.io/public/h3-image-cover-1794323228475.jpg>（1280×545，水母 + 官方字标） | `[155, 0, 969, 545]` |
| `showcase-nanobanana.jpg` | Nano Banana 2.1 | Google DeepMind Gemini Image（Nano Banana）官网示例图 <https://lh3.googleusercontent.com/IQrKmeotvku7oU92ImkQ4h74TbS7A695HU4Zq633YsuNW0hvjZlndcmzyhh5-CqxFntzW6K9J1pgaTUayRTYgK93laVGdPBp2uDAdJASSm4CZprKE3Q=w1920-h1080-n-nu>（1920×1080，黄昏草地人像） | 不裁 |
| `showcase-seedance.jpg` | Seedance 2.5 | 火山方舟官方示例图 <https://arkdocs.tos-cn-beijing.volces.com/images/video-generation/i2v_4k.png>（1280×714，越野摩托） | 不裁 |
| `showcase-kling.jpg` | Kling 4.0 | 可灵官方 Kling 4.0 发布说明示例关键帧 <https://klingai.com/release-note/release-notes/Kling_4>（2720×1536，风暴船头弹钢琴） | 不裁 |
| `showcase-gemini.jpg` | Gemini Omni 1.2 Flash | Google 官方博客头图 <https://storage.googleapis.com/gweb-uniblog-publish-prod/images/gemini-omni-1.2_FZLql41.width-1300.png>（1300×731，官方字标） | 不裁 |

- 有官方视频的三个模型改用官方示例视频（`bash tools/market-art/videos.sh`：静音、1280×720、H.264 CRF 26、约 10 秒，同时取第 4 秒画面做 `showcase-<id>.jpg`）：
  - `showcase-seedance.mp4`：Seedance 2.5 官方项目页 <https://seed.bytedance.com/seedance2_5> 首屏视频（火焰前的红裙舞者），取 2.2s 起 10 秒。
  - `showcase-kling.mp4`：Kling 4.0 发布说明「关键帧 → 生成结果」示例视频 <https://v4-kling.kechuangai.com/bs2/upload-ylab-stunt/kling-userdoc/file/79118979d9da8918cb88b44b9b53fd2c03388b47cf92b5838cb8f5c2caa33359.mp4>，取 2s 起 12 秒。
  - `showcase-gemini.mp4`：Gemini Omni 1.2 Flash 官方博客 <https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-omni-1-2-flash/> 的 Castaway Crash Zoom Out 示例 <https://storage.googleapis.com/gweb-uniblog-publish-prod/original_videos/Castaway_Crash_Zoom_Out_Demo.mp4>，跳过开头 4.3 秒的提示词界面。
  - 上表里这三张的静态图因此由视频帧替代。
- 旧的 `showcase-fashion.jpg`、`showcase-hypit.jpg` 不再出现在轮播里（技能仍在「精选技能」里）。
- 部分官方 CDN 在国内直连会超时：`ART_PROXY=http://127.0.0.1:7897 node tools/market-art/build.cjs`。已下载的源图缓存在 `_tmp/market-art/src/`，不会重复下载。
