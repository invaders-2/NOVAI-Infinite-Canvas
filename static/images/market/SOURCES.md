# 应用市场「最新上线」封面来源

六张封面全部是**真实素材**：官方模型示例图（5 张）+ 真实产品截图（1 张）。由 `tools/market-art/build.cjs` 一键复现（下载 → 按 crop 裁 16:9 → 覆盖式缩放到 1600×900 → JPG q90）。

> 说明：模型示例图来自厂商官方文档/官网，仅在产品内展示用；**对外发布前需确认授权**。

| 文件 | 用途 | 来源 | 裁切（源图像素） |
|---|---|---|---|
| `showcase-seedream.jpg` | 「Seedream 5.0」卡封面 | 火山方舟官方示例图 <https://arkdocs.tos-cn-beijing.volces.com/images/image-generation/Seedream50_layer_0.jpeg>（2048×2048，雨后雨林苔藓树枝） | `[0, 620, 2048, 1152]`：保留中部那根长满苔藓的树枝，向下让出卡片底部叠字区 |
| `showcase-seedance.jpg` | 「Seedance 2.5」卡封面 | 火山方舟官方示例图 <https://arkdocs.tos-cn-beijing.volces.com/images/video-generation/i2v_4k.png>（1280×714，越野摩托实拍） | 不裁，等比放大到覆盖 1600×900 后居中裁 6px |
| `showcase-gemini.jpg` | 「Gemini 3 Pro」卡封面 | Google 官方博客头图 <https://storage.googleapis.com/gweb-uniblog-publish-prod/images/gemini-3_model-blog_header-dark.width-1600.format-webp.webp>（1600×902，官方 Gemini 3 品牌视觉） | `[133, 76, 1333, 750]`：整体放大 1.2× 居中，logo + 星形约占画面 1/2 |
| `showcase-minimax.jpg` | 「MiniMax H3」卡封面 | MiniMax 官方示例图 <https://filecdn.minimax.chat/public/h3-en-v2-image-000-1785473644038.png>（2488×1408，咖啡街景视频画面） | `[560, 60, 1928, 1084]`：人物居中，避开左下角「CAFÉ」挂牌与顶部边角碎片，底部让出叠字区 |
| `showcase-gpt26.jpg` | 「GPT-Image 2.6」卡封面 | **不是官网图**：我们自己的 APIMart（apib.ai）调 `gpt-image-2.6-ext` 于 2026-11-06 生成的示例图（1024×1024，水晶体蜂鸟），源文件 `tools/market-art/sources/gpt-image-2.6.png`（跟生成器一起留在仓库里）。prompt：`A cinematic close-up of a translucent glass hummingbird perched on a dark branch, dramatic rim light, shallow depth of field, ultra detailed, dark studio background`（n=1，无尺寸参数）→ **自制可商用** | `[0, 40, 1024, 576]`：从 1024×1024 里取 16:9 居中偏上，保住翅膀与主体，底部落在深色枝干/背景上让出叠字区 |
| `showcase-fashion.jpg` | 「服装大片 · 胶片暗房」技能卡封面 | **不是官网图**：我们用 APIMart（apib.ai）`seedream-5-0-pro` 于 2026-11-06 生成的时尚编辑样片（2048×1152），源文件 `tools/market-art/sources/fashion-editorial.jpg`。prompt：`A fashion editorial photograph shot on 35mm analog film, hand-enlarged silver gelatin print, young woman in a cream linen slip dress leaning against a Mediterranean white stucco wall, soft natural window light with long cast shadows and dappled leaf shadows, muted low-saturation palette with milky cream tones, Kodak Portra 400 color signature, fine analog film grain, matte non-glossy surface, subtle gentle vignette, intimate quiet composition, honest skin texture, horizontal widescreen composition, no text, no logo, no watermark`（size=2048x1152，n=1）→ **自制可商用** | 不裁（源图正好 16:9），直接缩到 1600×900；主体在上半部，底部白墙 + 米色连衣裙承载叠字 |

约束与结论：
- 输出统一 1600×900 JPG（质量 90；Seedream 细节多单张 266KB，其余 56–244KB）。
- 六张图都不含第三方水印/角标文案；Seedream 官方图那种右下角带「AI生成」水印的版本没有采用。
- Gemini 那张自带官方「Gemini 3」字标，按需求保留（不是第三方水印）；GPT-Image 2.6 那张是我们自己用 APIMart 生成的示例图，没有第三方水印。
- 主体都避开了卡片左下角的叠字区（卡片底部 34% 起是渐变，标题/说明在底部 ~21%）。
- 2026-11-06 第二轮：按用户意见去掉两张产品截图卡（智能画布BEAT / 素材库），对应 `showcase-beat.jpg`、`showcase-assets.jpg` 已删除；新增 MiniMax H3、Qwen-Image 3 两张模型示例图。
- 2026-11-06 第三轮：Qwen-Image 3 卡换成 **GPT-Image 2.6**（封面换成我们自己用 APIMart 生成的玻璃蜂鸟），`showcase-qwen.jpg` 已删除。
- 2026-11-06 第四轮：「我的技能」卡换成我们自己技能「服装大片 · 胶片暗房」（封面用 APIMart seedream-5-0-pro 生成的时尚编辑样片），`showcase-skills.jpg` 已删除。卡片顺序：Seedream 5.0 → Seedance 2.5 → Gemini 3 Pro → MiniMax H3 → GPT-Image 2.6 → 服装大片 · 胶片暗房。

复现：
```bash
node tools/market-art/build.cjs      # 需要本机 Chrome（Playwright channel:'chrome'）+ python3 + Pillow
```
- 官方示例图会按表里的 URL 现下到 `_tmp/market-art/src/`（中间产物，可随时删）。
- 常驻仓库的源文件在 `tools/market-art/sources/`：`gpt-image-2.6.png`、`fashion-editorial.jpg`（都是我们自己生成的图，没有公开 URL 可依赖）。跑生成器只需要 python3 + Pillow（不再需要 Chrome / 本地服务）。
