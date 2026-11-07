# 首页模板库封面 · 素材来源

> 2026-11-06 整理。素材全部来自**用户本机 Chrome 缓存里的 Pinterest 图/视频**（图片域名 `i.pinimg.com`，视频域名 `v1.pinimg.com`）。
> 流程：缓存去重导出 → 打印拼图审阅（`_tmp/pinterest-mine/sheets/`）→ 按模板主题挑定 → 统一裁成 **3:4 竖版 720x960 JPEG q84**（≤160KB，sRGB，无 EXIF）或 **720x960 H.264 静音 6 秒 mp4**（≤1.2MB，faststart）。

**版权提示**：以下素材版权归 Pinterest 上的原作者所有，本仓库仅在本地/个人项目内部演示使用；对外发布或二次商用前请自行确认授权，或换成自有素材。

## 卡片封面（15 张，3:4 / 720x960）

| 文件 | 模板 | 原始 hash | 原图 URL | 原始尺寸 | 裁切锚点 | 成品 |
| --- | --- | --- | --- | --- | --- | --- |
| `product-swap.jpg` | product-swap | `a2e18a8c93774b6a19f2634671163ae8` | https://i.pinimg.com/474x/a2/e1/8a/a2e18a8c93774b6a19f2634671163ae8.jpg | 736x920 | center | 720x960 · 137.0KB |
| `ecom-set.jpg` | ecom-set | `66a12cd14ba5827b2508fb99b02e0321` | https://i.pinimg.com/474x/66/a1/2c/66a12cd14ba5827b2508fb99b02e0321.jpg | 735x913 | center | 720x960 · 150.2KB |
| `white-bg.jpg` | white-bg | `f44242e36fa307eb0ad9712fe242ba9c` | https://i.pinimg.com/474x/f4/42/42/f44242e36fa307eb0ad9712fe242ba9c.jpg | 736x1307 | center | 720x960 · 101.6KB |
| `multi-angle.jpg` | multi-angle | `29efaa068c2bf5f89c4c69b6c847b100` | https://i.pinimg.com/474x/29/ef/aa/29efaa068c2bf5f89c4c69b6c847b100.jpg | 736x920 | center | 720x960 · 149.2KB |
| `retouch.jpg` | retouch | `261fe671e0cae6d9b2775d988f440085` | https://i.pinimg.com/474x/26/1f/e6/261fe671e0cae6d9b2775d988f440085.jpg | 736x1308 | center | 720x960 · 46.2KB |
| `poster.jpg` | poster | `f03a8a44633e45904e7a9bca5ddc9ac9` | https://i.pinimg.com/474x/f0/3a/8a/f03a8a44633e45904e7a9bca5ddc9ac9.jpg | 736x1104 | center | 720x960 · 81.6KB |
| `social-cover.jpg` | social-cover | `c4119a3ada6cd25c52fa1b97a66937a9` | https://i.pinimg.com/474x/c4/11/9a/c4119a3ada6cd25c52fa1b97a66937a9.jpg | 736x1103 | top | 720x960 · 107.8KB |
| `portrait.jpg` | portrait | `b4d23ff21f1714765f145c48c193e57e` | https://i.pinimg.com/474x/b4/d2/3f/b4d23ff21f1714765f145c48c193e57e.jpg | 736x1097 | 0.3 (偏上，保脸) | 720x960 · 86.4KB |
| `try-on.jpg` | try-on | `b1c37322619bfa6dfc936b286f494fe0` | https://i.pinimg.com/474x/b1/c3/73/b1c37322619bfa6dfc936b286f494fe0.jpg | 736x981 | center | 720x960 · 104.0KB |
| `storyboard.jpg` | storyboard | `646a77bb7c284986308b71fa9855ae0c` | https://i.pinimg.com/474x/64/6a/77/646a77bb7c284986308b71fa9855ae0c.jpg | 736x920 | center | 720x960 · 135.5KB |
| `char-three.jpg` | char-three | `ed764b70883298d9b67aa1d1b9eb794a` | https://i.pinimg.com/474x/ed/76/4b/ed764b70883298d9b67aa1d1b9eb794a.jpg | 736x977 | center | 720x960 · 87.5KB |
| `scene-four.jpg` | scene-four | `8aa168b7e5baf108a0021f365962d8ae` | https://i.pinimg.com/474x/8a/a1/68/8aa168b7e5baf108a0021f365962d8ae.jpg | 736x981 | center | 720x960 · 121.5KB |
| `batch.jpg` | batch | `281fc0b2658f8fab07f39becc9c0ae7d` | https://i.pinimg.com/474x/28/1f/c0/281fc0b2658f8fab07f39becc9c0ae7d.jpg | 720x893 | center | 720x960 · 156.4KB |
| `video-relay.jpg` | video-relay | `be2636e0895555238be94df56cf48332` | https://v1.pinimg.com/videos/iht/hls/be/26/36/be2636e0895555238be94df56cf48332_720w.m3u8 | 1.0s 处帧（720x1280） | 0.40（留头） | 720x960 · 99.9KB |
| `product-video.jpg` | product-video | `42937dadd47bdd2235d8cb123b9f0d18` | https://v1.pinimg.com/videos/iht/hls/42/93/7d/42937dadd47bdd2235d8cb123b9f0d18_720w.m3u8 | 8.0s 处帧（720x1280） | center | 720x960 · 62.1KB |

两张视频封面是从 mp4 里截的帧（Pinterest 那边的视频没有独立封面图）。

## 预览窗 16:9 示例图（3 张，960x540）

这三个模板在 `TemplatePreview.vue` 里「示例效果」节点是按 16:9 排的，所以另出一版横图：`templates.js` 的 `preview` 字段优先用它，卡片仍用 3:4 那张。

| 文件 | 模板 | 来源 hash | 取自 | 裁切锚点 | 成品 |
| --- | --- | --- | --- | --- | --- |
| `video-relay-wide.jpg` | video-relay | `be2636e0895555238be94df56cf48332` | 同 video-relay.jpg | 0.15（留头） | 960x540 · 60.7KB |
| `product-video-wide.jpg` | product-video | `42937dadd47bdd2235d8cb123b9f0d18` | 同 product-video.jpg | 0.5 | 960x540 · 46.9KB |
| `char-three-wide.jpg` | char-three | `ed764b70883298d9b67aa1d1b9eb794a` | 736x977 | 0.12（留头） | 960x540 · 52.2KB |

## 视频（2 个，720x960 / 6 秒 / 静音 / faststart）

| 文件 | 模板 | 源 videoId | 截取区间 | 成品 |
| --- | --- | --- | --- | --- |
| `video-relay.mp4` | video-relay | `be2636e0895555238be94df56cf48332` | 源 8.38s，取 1.0~7.0s | 720x960 · 6.0s · 静音 · 1105.2KB |
| `product-video.mp4` | product-video | `42937dadd47bdd2235d8cb123b9f0d18` | 源 15.17s，取 8.0~14.0s | 720x960 · 6.0s · 静音 · 992.5KB |

源 HLS 地址（视频）：

- `video-relay.mp4` → https://v1.pinimg.com/videos/iht/hls/be/26/36/be2636e0895555238be94df56cf48332_720w.m3u8
- `product-video.mp4` → https://v1.pinimg.com/videos/iht/hls/42/93/7d/42937dadd47bdd2235d8cb123b9f0d18_720w.m3u8

## 历史

2026-11 之前，这 15 张封面用的是从 Unsplash / Coverr 随手找的**横版占位图（640x440）**，被 3:4 卡片中心裁掉左右各 24%（只剩 330x440 再放大 2.2 倍），既糊又容易切主体，也没有逐张出处记录 —— 本次整段替换为上面的 Pinterest 素材。
