# 无限画布预设提示词 · 完整版 v2.0

> **备份日期**：2026-05-28
> **版本**：v2.1（新增视角类360全景图预设）
> **用途**：直接复制粘贴到无限画布AI工具的预设提示词框中
> **格式**：每个预设包含「预设名称」「适用场景」「正向提示词」「负向提示词」「平台参数建议」
> **原则**：画面绝对无数字/文字/角标，一致性通过多重锚定锁定，边缘柔和过渡无硬边无发光晕

---

## 预设1：多机位九宫格

### 适用场景
同一主体/场景，9个不同机位/角度同时呈现，用于角色多角度参考、产品展示、空间勘测

### 正向提示词
```
A multi-camera angle reference sheet in 3x3 grid layout, showing [主体] from 9 different perspectives simultaneously: top-left front view, top-center 3/4 front view, top-right side profile, middle-left low angle, middle-center eye-level straight-on, middle-right high angle, bottom-left back view, bottom-center 3/4 back view, bottom-right top-down overhead view. [主体详细描述]. Consistent lighting across all 9 frames, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional studio photography, clean grid layout with thin white dividers between frames, character consistency maintained across all angles, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, blurry, low quality, cropped, out of frame
```

### 平台参数建议
- **Midjourney**: `--ar 1:1 --style raw --s 50`
- **即梦/可灵**: 直接粘贴，开启「参考图」锁一致性
- **Flux**: 配合 `add_detail` LoRA，CFG 3.5-5.0

---

## 预设2：多机位九宫格4K

### 适用场景
高分辨率版本的多机位九宫格，用于印刷级输出、大屏展示、精细材质参考

### 正向提示词
```
Ultra high resolution multi-camera angle reference sheet in 3x3 grid layout, 4K quality, showing [主体] from 9 different perspectives simultaneously: top-left front view, top-center 3/4 front view, top-right side profile, middle-left low angle, middle-center eye-level straight-on, middle-right high angle, bottom-left back view, bottom-center 3/4 back view, bottom-right top-down overhead view. [主体详细描述]. Consistent cinematic lighting across all 9 frames, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional studio photography with medium format film aesthetic, clean grid layout with thin white dividers between frames, character consistency maintained across all angles, fine organic film grain, zero digital sharpening, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, blurry, low quality, cropped, out of frame, digital sharpening, oversharpened, plastic skin, over-smoothing
```

### 平台参数建议
- **Midjourney**: `--ar 1:1 --style raw --s 50 --q 2`
- **即梦/可灵**: 选择「高清」或「4K」模式
- **Flux**: 开启 Tiled VAE 或 hires fix

---

## 预设3：剧情推演四宫格

### 适用场景
同一事件的4个连续阶段/情绪递进，用于故事板预览、情绪弧线设计、叙事节奏测试

### 正向提示词
```
A 4-panel storyboard sequence in 2x2 grid, showing narrative progression of [事件/场景]: top-left [阶段1描述], top-right [阶段2描述], bottom-left [阶段3描述], bottom-right [阶段4描述]. Consistent character design across all panels, coherent lighting and color palette, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, cinematic composition, emotional arc from [情绪A] to [情绪B], film grain texture, clean thin white grid dividers, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, discontinuous action, jump cut feel, blurry, low quality, cropped, out of frame
```

### 平台参数建议
- **Midjourney**: `--ar 1:1 --style raw --s 75`
- **即梦/可灵**: 直接粘贴，建议分镜时先写情绪词再填场景
- **Flux**: 配合 `film grain` LoRA 增强故事板质感

---

## 预设4：角色脸部三视图

### 适用场景
角色面部正面/侧面/四分之三侧面的设定参考，用于Actor ID锁定、表情一致性控制

### 正向提示词
```
Character face reference sheet, three views side by side in single row: left panel front view straight-on, center panel 3/4 angle view, right panel side profile view. [角色面部详细描述]. Consistent lighting from 45-degree top-side across all three views, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, neutral clean backdrop, professional character design sheet, clean linework, subtle skin texture, identical facial features maintained across all angles, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, asymmetrical eyes, crossed eyes, extra fingers, deformed hands, inconsistent facial features between panels, lighting mismatch, blurry, low quality, cropped, out of frame
```

### 平台参数建议
- **Midjourney**: `--ar 16:9 --style raw --s 50`
- **即梦/可灵**: 上传参考图锁定Actor ID后使用
- **Flux**: 开启面部修复 + 一致性采样器

---

## 预设5：产品三视图

### 适用场景
产品设计的正面/侧面/顶面展示，用于工业设计、商品详情、技术文档

### 正向提示词
```
Product design reference sheet, three orthographic views in single row: front view, side view, top view. [产品详细描述]. Light warm gray background color F0EDE8, products softly blending with background with natural edge transition, no hard edges no white halo no light bleed, studio lighting with soft shadows, technical drawing aesthetic, precise proportions, material texture visible, no perspective distortion, professional product photography, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, distorted proportions, perspective distortion, blurry, low quality, cropped, out of frame, cluttered background, random objects, inconsistent material texture between views
```

### 平台参数建议
- **Midjourney**: `--ar 16:9 --style raw --s 50`
- **即梦/可灵**: 浅暖灰背景建议加 `--no gradient background`
- **Flux**: 配合 `product photography` LoRA

---

## 预设6：25宫格连贯分镜

### 适用场景
完整场景/动作的25帧连续分镜，5×5网格承载9个叙事节拍，用于电影分镜预览、动作连贯性测试、Seedance分段参考

### 正向提示词
```
A 5x5 cinematic storyboard grid, 25 sequential frames showing continuous narrative flow of [主体/场景/动作], naturally divided into 9 story beats progressing through beginning, development, escalation, twist, climax, and resolution. Scene transitions conveyed purely through visual continuity and character motion, absolutely no visible numbers, text, labels, frame counters, corner marks, or annotations anywhere on the image. Consistent character and environment across all 25 frames, smooth motion continuity between adjacent frames, uniform cinematic lighting and color palette, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, varied shot progression from wide to close-up, professional film storyboard aesthetic, subtle film grain, clean thin white grid dividers
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, discontinuous action, jump cut feel, blurry, low quality, cropped, out of frame, different hairstyle between frames, different clothing between frames
```

### 平台参数建议
- **Midjourney**: `--ar 1:1 --style raw --s 75 --q 2`
- **即梦/可灵**: 建议先测试单格效果再生成25格，分段生成更可控
- **Flux**: 开启 `Batch count: 1`，CFG 4.0，配合 `storyboard` LoRA

### 叙事节拍分配参考
| 节拍 | 帧数范围 | 功能 |
|------|---------|------|
| 起始 | 1-3帧 | 建立场景、引入主体 |
| 发展 | 4-7帧 | 动作展开、关系建立 |
| 推进 | 8-12帧 | 冲突升级、节奏加快 |
| 转折 | 13-15帧 | 关键变化、意外发生 |
| 高潮 | 16-20帧 | 情绪顶点、动作峰值 |
| 回落 | 21-23帧 | 余韵、反应、过渡 |
| 收尾 | 24-25帧 | 结局暗示、留白 |

---

## 预设7：电影级光影校正

### 适用场景
同一场景在不同光影条件下的对比展示，用于灯光方案测试、色调选择、情绪对照

### 正向提示词
```
Cinematic lighting comparison sheet, 6 panels showing the same [主体/场景] under different lighting conditions: top-left golden hour warm backlight, top-center overcast soft diffused light, top-right neon night city light, bottom-left harsh midday direct sun, bottom-center Rembrandt 45-degree side light with triangle shadow, bottom-right dramatic low-key chiaroscuro. Consistent composition and subject across all panels, only lighting changes, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional cinematography reference, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, inconsistent subject between panels, different pose between panels, different costume between panels, cluttered background, blurry, low quality, cropped, out of frame
```

### 平台参数建议
- **Midjourney**: `--ar 3:2 --style raw --s 50`
- **即梦/可灵**: 适合作为「Talk to Edit」的光影参考基底图
- **Flux**: 配合 `cinematic lighting` LoRA

### 6种光效情绪映射
| 光效 | 情绪 | 适用场景 |
|------|------|---------|
| 金色时刻暖逆光 | 温馨、怀旧、离别 | 爱情片、回忆场景 |
| 阴天柔光漫射 | 平静、客观、纪实 | 纪录片、日常叙事 |
| 霓虹夜景 | 赛博、孤独、未来 | 科幻、都市夜戏 |
| 正午硬光直射 | 真实、残酷、暴露 | 现实主义、冲突场景 |
| 伦勃朗45度侧光 | 经典、庄重、神秘 | 人像、悬疑、历史 |
| 低调明暗对比 | 恐怖、紧张、权力 | 黑色电影、权力对峙 |

---

## 预设8：角色设定参考表（胸口特写+全身三视图）

### 适用场景
角色一致性设定参考：左侧1/3脸部大特写锚定面部，右侧2/3三格横排全身三视图（正/侧/背）锚定服装与身形，用于Actor ID锁定、服装一致性控制、Seedance Canvas故事板

### 正向提示词
```
Character reference sheet, left-right split layout: left one-third area is chest-up close-up front view portrait (shoulder-up framing, extreme facial detail clarity, gentle natural expression, bright eyes looking straight at camera, realistic skin texture with visible pores and subtle imperfections, refined classical makeup); right two-thirds area is three full-body views in horizontal row, from left to right: full-body front standing pose (arms hanging naturally, feet together, complete front costume and body proportions), full-body side profile view (weight slightly shifted, waist-hip curve and silhouette visible, complete side costume and footwear), full-body back view (complete back neckline, hairstyle from behind, back costume details). Consistent front-top-side lighting across all panels, soft diffused light quality, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, identical character design, costume, hairstyle and accessories across all panels, professional character design sheet style, clean edges, accurate proportions, material texture visible from all angles, absolutely no visible numbers, text, labels, frame counters, corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, dividing line labels, panel markers, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, different hairstyle between panels, different clothing between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, broken layout
```

### 平台参数建议
- **Midjourney**: `--ar 16:9 --style raw --s 50 --q 2`
- **即梦/可灵**: 上传此图作为Actor ID参考，Canvas锁脸首选
- **Flux**: 开启面部一致性 + 服装一致性双重采样

### 区域功能分工
| 区域 | 占比 | 内容 | 景别 | 核心功能 |
|------|------|------|------|---------|
| 左侧 | 1/3 | 脸部正面高清特写 | 胸像肩以上大特写 | 面部锚定、Actor ID锁定、表情基准 |
| 右侧左格 | 2/3内 | 全身正面站姿 | 全景 | 服装正面、身形比例、整体姿态 |
| 右侧中格 | 2/3内 | 全身正侧面站姿 | 全景 | 侧面轮廓、腰臀曲线、服装侧片 |
| 右侧右格 | 2/3内 | 全身背面站姿 | 全景 | 背部剪裁、发型后片、服装背面 |

---

## 预设9：6种基础表情胸像（2×3六宫格）

### 适用场景
同一角色六种基础表情同时呈现，用于表情一致性控制、情绪基准设定、Seedance Talk to Edit表情参考

### 正向提示词
```
Character expression reference sheet in 2x3 grid layout, six basic expressions of the same character: top row from left to right: calm neutral expression (relaxed face, eyes looking straight ahead, lips naturally closed), gentle smile (corners of mouth slightly raised, eyes with smile lines, warm and approachable), joyful laugh (eyebrows and eyes curved upward, mouth open showing teeth, exuberant happiness); bottom row from left to right: sad tearful expression (slight furrow between brows, downturned outer eye corners, tears welling in eyes about to fall), angry stern expression (brows tightly locked, sharp piercing eyes with pressure, jaw slightly set), surprised astonished expression (eyes wide open, eyebrows raised high, mouth slightly open in O shape). All six expressions are chest-up close-up portraits of the same character, shoulder-up framing, extreme facial detail clarity, realistic skin texture preserved, no additional light source, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, identical character styling, hairstyle, makeup and accessories across all six panels, only facial expression changes, professional character expression sheet style, clean edges, absolutely no visible numbers, text, labels, frame counters, corner marks or annotations anywhere on the image
```

### 负向提示词
```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, expression name labels, emotion text, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, different hairstyle between panels, different clothing between panels, lighting mismatch between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, broken layout, extra rows, extra columns, missing panel, shadows on face, directional light, dramatic lighting, colored light
```

### 平台参数建议
- **Midjourney**: `--ar 3:2 --style raw --s 50`
- **即梦/可灵**: 直接粘贴，建议开启「参考图」锁角色一致性
- **Flux**: 配合 `add_detail` + 面部一致性采样器

### 六宫格布局
| 上排左 | 上排中 | 上排右 |
|--------|--------|--------|
| **平静中性** | **温和微笑** | **开怀大笑** |
| 面部放松，眼神平视，双唇闭合 | 嘴角微扬，眼角带笑，神态亲切 | 眉眼弯起，露齿张嘴，情绪外放 |

| 下排左 | 下排中 | 下排右 |
|--------|--------|--------|
| **悲伤垂泪** | **愤怒冷峻** | **惊讶错愕** |
| 眉心微蹙，眼尾下垂，眼眶含泪 | 眉峰紧锁，眼神锐利，下颌微收 | 双眼睁大，眉头上挑，嘴巴微张 |

---

## 预设10：360全景图

### 适用场景
用于生成360全景、VR全景、可左右循环拼接的空间视角图，适合室内空间、展厅、场景漫游、环境概念设计；封闭场景需要具备合理出入口。

### 正向提示词
```
生成一个720度的全景VR图，左右边缘100%像素级无缝衔接，可无限循环拼接；上下极点(南北极)自然过渡，无明显断层或拉伸，场景一致性，以及场景的逻辑性，封闭场景需要有门
```

### 负向提示词
```
seam, visible seam, hard seam, broken panorama, discontinuous edge, mismatched left and right edges, distorted poles, stretched ceiling, stretched floor, warped horizon, inconsistent scene logic, impossible space, no exit in closed room, text, letters, labels, watermark, logo, blurry, low quality
```

### 平台参数建议
- **Midjourney**: `--ar 2:1 --style raw --s 50`
- **即梦/可灵**: 使用2:1宽幅比例，生成后用360预览检查左右接缝
- **Flux**: 建议2:1比例，优先测试左右边缘连续性

---

## 电商

> **分类**：电商
> **适用平台**：Midjourney / Flux / 即梦 / 可灵 / ComfyUI
> **核心约束**：鞋类替换预设（11-13）强制保留白底图品牌logo/文字/英文不变形，参考图logo/文案必须去除

---

## 预设11：鞋子静物场景替换

### 适用场景
将参考静物场景图中的鞋子替换为用户提供的多角度白底产品图鞋子，保留场景、光影、角度不变。用于鞋类电商主图、场景化展示。

### 正向提示词
```
将参考静物场景图中的鞋子替换为多角度白底产品图中的鞋子。严格保留原场景不变——背景物品、道具摆放、光源方向、阴影位置、反光、构图、拍摄角度全部锁定。替换后的鞋子必须以完全相同的透视角度和位置呈现。保留白底图的全部材质细节：精确色值、材质纹理（皮革纹路、织物编织、麂皮绒面、针织纹理、橡胶大底）、车线缝线、鞋带结构、鞋底纹路、金属五金件、表面光泽度（哑光/亮面/漆皮）。白底图鞋面上的品牌logo、文字、英文、字母、图案等所有标识元素必须原样保留，位置精准、比例正确、不变形不拉伸不扭曲、清晰可读。鞋子整体形状不变形——鞋头、鞋身、鞋跟、鞋口、鞋底弧度等全部轮廓线精确一致。自然融入场景：鞋面接受相同方向光照，高光点与场景光源匹配，投影与现有阴影无缝融合，边缘过渡无接缝、无光晕、无色彩断层。最终效果应为单张原始拍摄照片。
```

```
Replace the shoes in the reference still-life scene with the shoes from the multi-angle white-background product image. Keep the reference scene completely unchanged — all background elements, props, lighting direction, shadow positions, reflections, composition and camera angle must remain identical. The replacement shoes must render at the exact same perspective angle and position as the original shoes. Retain full material detail from the white-background image: precise color accuracy, material texture (leather grain, fabric weave, suede nap, knit pattern, rubber outsole), stitching, lace structure, sole tread, metallic hardware, and surface finish (matte/glossy/patent). All branding elements on the white-background shoes — logos, text, English characters, letters, patterns — must be preserved exactly: precise positioning, correct proportions, no deformation, stretching or distortion, sharp and legible. Shoe overall shape must not deform — toe box, body, heel, collar, sole curvature all maintain identical silhouette. Natural scene integration: shoes receive identical light direction, specular highlights match scene lighting, cast shadows blend seamlessly with existing shadows. Edge blending must be seamless — no visible seams, no halos, no color mismatch between shoe and background. Final result must appear as a single original photograph.
```

### 额外规则
- 参考图中若有品牌logo、文案、水印、角标等文字/图形元素，必须去除
- 白底图鞋子上所有品牌标识（logo/文字/英文/图案）必须原样保留，不变形

### 负向提示词
```
场景变化、背景改动、光源变化、阴影不匹配、反光不一致、透视错位、角度偏差、位置偏移、色差、材质丢失、纹理丢失、细节丢失、缝线丢失、鞋带丢失、鞋底丢失、logo变形、logo拉伸、logo扭曲、logo模糊、logo丢失、logo位移、文字变形、文字模糊、文字丢失、品牌标识丢失、标识损坏、鞋子变形、鞋头被压扁、鞋身拉长、鞋跟扭曲、鞋口变形、鞋底弧度错误、模糊、像素化、可见接缝、抠图感、贴图感、鞋子悬浮、参考图logo残留、参考图文案残留、参考图水印残留、低画质、JPEG压缩伪影
```

```
scene change, background alteration, lighting change, shadow mismatch, reflection mismatch, perspective mismatch, angle mismatch, position shift, color shift, material loss, texture loss, detail loss, stitching loss, lace loss, sole loss, logo deformed, logo stretched, logo distorted, logo blurred, logo lost, logo displaced, text deformed, text blurred, text lost, brand mark lost, branding damaged, shoe deformed, toe box crushed, shoe body elongated, heel twisted, collar deformed, sole curve incorrect, blurry, pixelated, visible seam, visible edge, halo, glow, cutout look, pasted look, floating shoe, reference image logo residue, reference image text residue, reference image watermark residue, distorted shape, low quality, JPEG artifacts
```

---

## 预设12：模特上脚图鞋子替换

### 适用场景
将模特上脚图中的鞋子替换为用户白底产品图鞋子，区分左右脚，保留模特/场景/光影。用于鞋类电商穿搭展示。

### 正向提示词
```
将模特上脚图中的鞋子替换为多角度白底产品图中的鞋子。精确区分左右脚。模特、姿态、服装、背景、光源、场景完全保留不变。替换后的鞋子必须自然穿着于脚上——包裹脚型、贴合脚背弧度、脚踝轮廓、鞋头位置精准。匹配原始穿着角度和脚部朝向。保留白底图的全部材质细节：精确色值、材质纹理（皮革纹路、织物编织、麂皮绒面）、车线缝线、鞋带结构、大底纹路、金属五金件、表面光泽度。白底图鞋面上的品牌logo、文字、英文、字母、图案等所有标识元素必须原样保留，位置精准、比例正确、不变形不拉伸不扭曲、清晰可读。鞋子整体形状不变形——鞋头、鞋身、鞋跟、鞋口、鞋底弧度等全部轮廓线精确一致。自然光影融合：鞋面接受一致光源方向、鞋脚接触点环境遮挡自然、在皮肤和地面上投射自然阴影。关键左右脚区分：左右鞋必须呈现正确的非对称性（内侧/外侧弧度、鞋头造型）。鞋脚边界无可见接缝、无异常空隙、无悬浮感。最终效果应为单张原始拍摄照片。
```

```
Replace the shoes worn on the model's feet with the shoes from the multi-angle white-background product image. Accurately distinguish left and right foot shoes. Keep the model, pose, clothing, background, lighting and scene completely unchanged. Replacement shoes must dress naturally onto the feet — wrapping around the foot shape, following instep curve, ankle contour, and toe box position precisely. Match the original wear angle and foot orientation exactly. Retain full material detail: exact color accuracy, material texture (leather grain, fabric weave, suede nap), stitching, lace structure, sole tread, metallic hardware, surface finish (matte/glossy/patent). All branding elements on the white-background shoes — logos, text, English characters, letters, patterns — must be preserved exactly: precise positioning, correct proportions, no deformation, stretching or distortion, sharp and legible. Shoe overall shape must not deform — toe box, body, heel, collar, sole curvature all maintain identical silhouette. Natural lighting integration: shoes receive consistent light direction, match ambient occlusion at shoe-foot contact point, cast natural shadows on skin and ground. Critical left-right foot differentiation: left and right shoes must exhibit correct asymmetry matching real footwear design (medial/lateral curve, toe box shape). No visible seams at shoe-foot boundary, no unnatural gaps, no floating. Result must appear as single original photograph.
```

### 额外规则
- 参考图中若有品牌logo、文案、水印、角标等文字/图形元素，必须去除
- 白底图鞋子上所有品牌标识（logo/文字/英文/图案）必须原样保留，不变形

### 负向提示词
```
左右脚混淆、左右鞋不匹配、鞋脚分离、鞋子悬浮、脚型不贴合、脚背弧度错误、鞋头错位、鞋跟错位、鞋口不贴合、光源不一致、阴影不匹配、皮肤接触面无遮挡、材质丢失、纹理丢失、色差、细节模糊、logo变形、logo拉伸、logo扭曲、logo模糊、logo丢失、logo位移、文字变形、文字模糊、文字丢失、品牌标识丢失、标识损坏、鞋子变形、鞋头被压扁、鞋身拉长、鞋跟扭曲、鞋口变形、鞋底弧度错误、可见接缝、抠图感、贴图感、模特变形、背景变化、姿态变化、参考图logo残留、参考图文案残留、参考图水印残留、低画质、JPEG伪影
```

```
left right foot confusion, left right shoe mismatch, shoe foot separation, floating shoe, foot shape mismatch, instep curve incorrect, toe box misaligned, heel misaligned, collar gap, lighting inconsistency, shadow mismatch, skin contact no occlusion, material loss, texture loss, color shift, detail blur, logo deformed, logo stretched, logo distorted, logo blurred, logo lost, logo displaced, text deformed, text blurred, text lost, brand mark lost, branding damaged, shoe deformed, toe box crushed, shoe body elongated, heel twisted, collar deformed, sole curve incorrect, visible seam, cutout look, pasted look, model deformed, background change, pose change, reference image logo residue, reference image text residue, reference image watermark residue, low quality, JPEG artifacts
```

---

## 预设13：脚模鞋子替换

### 适用场景
脚模特写图的鞋子替换，聚焦鞋与脚的关系，保留白底图鞋细节。用于鞋类电商细节展示。

### 正向提示词
```
将脚模特写图中的鞋子替换为多角度白底产品图中的鞋子。精确区分左右脚。保留脚模的小腿、肤色、姿态、背景、光源、场景元素完全不变。替换后的鞋子必须自然包裹脚部——贴合脚背弧度、足弓轮廓、后跟杯包裹、鞋头位置、鞋口贴合度精准。匹配原始穿着角度。保留白底图的全部材质细节：精确色值、材质纹理（皮革纹路、麂皮绒面、网眼编织、针织纹理、橡胶外底）、车线缝线、鞋带结构、鞋眼五金、外底纹路、中底泡棉纹理、表面光泽度（哑光/亮面/金属/半透）。白底图鞋面上的品牌logo、文字、英文、字母、图案等所有标识元素必须原样保留，位置精准、比例正确、不变形不拉伸不扭曲、清晰可读。鞋子整体形状不变形——鞋头、鞋身、鞋跟、鞋口、鞋底弧度等全部轮廓线精确一致。自然光影：光线方向一致、鞋脚和鞋地接触面环境遮挡、自然柔和阴影。关键左右脚区分：正确非对称性（内侧外侧弧度、鞋头、足弓支撑）。保持真实的鞋脚交互关系：脚背轻微张力褶皱、后跟自然间隙、鞋头上翘弧度。无可见接缝、无空隙、无悬浮。最终效果应为单张原始棚拍照片。
```

```
Replace the shoes on the foot model with the shoes from the multi-angle white-background product image. Accurately distinguish left and right foot. Keep the foot model's legs, skin tone, pose, background, lighting and scene elements completely unchanged. Replacement shoes must wrap naturally around the foot — precisely following instep curve, arch contour, heel cup fit, toe box position, and ankle collar fit. Match original wear angle and foot orientation. Retain full material detail: color accuracy, material texture (leather grain, suede nap, mesh weave, knit pattern, rubber outsole), stitching, lace structure, eyelet hardware, sole tread, midsole foam texture, surface finish (matte/glossy/metallic/semi-translucent). All branding elements on the white-background shoes — logos, text, English characters, letters, patterns — must be preserved exactly: precise positioning, correct proportions, no deformation, stretching or distortion, sharp and legible. Shoe overall shape must not deform — toe box, body, heel, collar, sole curvature all maintain identical silhouette. Natural lighting: consistent light direction, ambient occlusion at shoe-foot and shoe-ground contact points, natural soft shadows. Critical left-right differentiation: correct asymmetry (medial/lateral curve, toe box, arch support). Maintain realistic foot-shoe interaction: slight tension wrinkles on instep, natural gap at heel collar, toe spring curve. No visible seams, no gaps, no floating. Result must look like single original studio photograph.
```

### 额外规则
- 参考图中若有品牌logo、文案、水印、角标等文字/图形元素，必须去除
- 白底图鞋子上所有品牌标识（logo/文字/英文/图案）必须原样保留，不变形

### 负向提示词
```
左右脚混淆、鞋脚不贴合、足弓不匹配、后跟分离、鞋头悬空、鞋口扭曲、材质丢失、皮革纹理消失、车线模糊、鞋带变形、五金件丢失、大底纹理消失、色差、光源不一致、阴影错位、皮肤接触面不自然、logo变形、logo拉伸、logo扭曲、logo模糊、logo丢失、logo位移、文字变形、文字模糊、文字丢失、品牌标识丢失、标识损坏、鞋子变形、鞋头被压扁、鞋身拉长、鞋跟扭曲、鞋口变形、鞋底弧度错误、小腿变形、脚踝扭曲、背景变化、可见接缝、抠图边缘、光晕、悬浮感、贴图感、参考图logo残留、参考图文案残留、参考图水印残留、低画质、JPEG伪影
```

```
left right foot confusion, shoe-foot mismatch, arch mismatch, heel separation, toe box floating, collar twisted, material loss, leather grain lost, stitching blurred, lace deformed, hardware lost, sole tread lost, color shift, lighting inconsistency, shadow misalignment, skin contact unnatural, logo deformed, logo stretched, logo distorted, logo blurred, logo lost, logo displaced, text deformed, text blurred, text lost, brand mark lost, branding damaged, shoe deformed, toe box crushed, shoe body elongated, heel twisted, collar deformed, sole curve incorrect, leg deformed, ankle twisted, background change, visible seam, cutout edge, halo, floating, pasted look, reference image logo residue, reference image text residue, reference image watermark residue, low quality, JPEG artifacts
```

---

## 预设14：电商海报设计

### 适用场景
用户上传参考海报+产品图+文案，分析参考风格后生成同风格新海报。用于促销活动、品牌页、商品推广。

### 正向提示词
```
深入分析参考海报的设计风格：整体构图布局、色板及色彩配比、字体排印风格（字体系列、粗细层级、字间距、行高）、视觉元素编排（产品位置、装饰元素、留白比例）、图形处理手法（扁平/立体/渐变/肌理）、摄影风格（光影基调、渲染方式）、整体视觉调性（轻奢/极简/潮流/复古/科技）。基于提供的产品图和文案，按完全相同设计风格生成新的电商海报。要求：保持一致的视觉节奏和版面密度、准确复刻色彩比例、应用匹配的字重层级体系、保留相近的负空间平衡感、匹配摄影处理和光影基调。产品自然融入版式，文案以恰当视觉权重排布，所有装饰与品牌元素遵循参考设计体系。输出为一张统一视觉的完整设计——必须属于同一系列感。无占位文本、无乱码、无排版错位。
```

```
Analyze the reference poster's design style thoroughly: overall composition layout, color palette and color ratios, typography style (font family, weight hierarchy, letter spacing, line height), visual element arrangement (product placement, decorative elements, negative space ratio), graphic treatment (flat/3D/gradient/texture), photography style (lighting mood, rendering approach), and overall visual tone (luxury/minimalist/trendy/vintage/tech). Create a new e-commerce poster in the exact same design style using the provided product image and copy text. Requirements: maintain identical visual rhythm and layout density, replicate color ratios accurately, apply matching typographic hierarchy, preserve similar negative space balance, match photographic treatment and lighting mood. Product naturally integrated into layout. Copy text positioned with proper visual weighting. All decorative and brand elements follow the reference's design system. Output as one cohesive design — must look like it belongs to the same campaign series. No placeholder text, no gibberish, no misalignment.
```

### 负向提示词
```
风格不一致、配色错误、色板偏差、字体错误、排版不匹配、布局错乱、构图错误、间距失衡、版式拥挤、设计不均衡、文字未对齐、文字溢出、文字截断、文案缺失、乱码文字、占位符文本、产品变形、产品错误、产品缺失、低分辨率、模糊、像素化、水印、模板化设计、设计同质化、风格混杂、对比度差、文字不可读、JPEG压缩伪影
```

```
different style, wrong color scheme, color mismatch, wrong typography, font mismatch, layout mismatch, wrong composition, wrong spacing, cluttered layout, unbalanced design, text misalignment, text overflow, text truncated, missing text, gibberish text, placeholder text, product distortion, wrong product, missing product, low resolution, blurry, pixelated, watermark, template look, generic design, inconsistent style, mixed design languages, poor contrast, illegible text, JPEG artifacts
```

---

## 预设15：字体设计

### 适用场景
用户上传参考字体图+文案，分析风格后生成同风格字体设计。用于电商品牌标题字、活动主题字、店铺招牌。

### 正向提示词
```
分析参考字体设计特征：字体风格类别（衬线/无衬线/手写/展示/哥特/手绘）、笔画粗细与对比度、字形比例（x字高、升部降部、字宽）、装饰元素（衬线形状、笔画收尾、连字、花体、装饰线）、肌理与材质处理（金属/渐变/立体/手工质感/霓虹/做旧）、色彩运用（纯色/渐变/纹理/多色）、特效处理（投影/发光/描边/浮雕/挤出）、空间排布（基线对齐、字偶距、字间距、堆叠）、背景融合度、整体情绪（优雅/活泼/粗犷/复古/未来/极简）。基于提供的文案，按完全相同的字体设计风格生成新作。精确复刻笔画特征、匹配字形比例、保留装饰细节层级、应用相同肌理和材质处理、使用匹配的配色方案、保持相同空间韵律与间距、达到一致的视觉冲击力和情绪表达。输出干净的字体设计图——字形饱满、边缘锐利、细节清晰、全文字符风格统一。最终效果应如同同一位设计师出品。
```

```
Analyze the reference typography design characteristics: font style category (serif/sans-serif/script/display/blackletter/hand-drawn), stroke weight and contrast ratio, letterform proportions (x-height, ascender/descender, width), decorative elements (serif shape, terminal style, ligatures, swashes, flourishes), texture and material treatment (metallic/gradient/3D/handcrafted/neon/distressed), color application (solid/gradient/textured/multi-color), special effects (shadow/glow/outline/emboss/extrude), spatial arrangement (baseline alignment, kerning, tracking, stacking), background integration, and overall mood (elegant/playful/bold/vintage/futuristic/minimalist). Create new typography design using the provided copy text in the exact same typographic style. Replicate stroke characteristics precisely, match letterform proportions, preserve decorative detail level, apply identical texture and material treatment, use matching color scheme, maintain same spatial rhythm and spacing, achieve identical visual impact and mood. Output clean typography artwork — characters well-formed, edges crisp, details sharp, consistent across all characters. Result must look created by same designer as reference.
```

### 负向提示词
```
字体风格错误、笔画粗细不一致、字形比例变形、装饰元素丢失、肌理不匹配、材质质感错误、配色偏移、渐变方向错误、特效缺失、阴影方向错误、发光强度不一致、字间距错误、字偶距不均、基线错位、文字堆叠错误、字符缺失、乱码、占位文本、边缘模糊、像素化、锯齿、背景融合不自然、风格断裂、低画质、JPEG伪影、水印、logo
```

```
wrong font style, inconsistent stroke weight, deformed letterform proportions, decorative elements lost, texture mismatch, material finish incorrect, color shift, gradient direction wrong, effect missing, shadow direction wrong, glow intensity inconsistent, tracking error, kerning uneven, baseline misalignment, text stacking error, missing characters, garbled text, placeholder text, blurred edges, pixelated, aliasing, unnatural background integration, style break, low quality, JPEG artifacts, watermark, logo
```

---

## 预设16：模特生成与换脸

### 适用场景
A) 根据风格生成电商服装模特；B) 将目标图模特脸部替换为参考肖像。用于服装展示、模特换装。

### 正向提示词
```
任务A——模特生成：基于参考风格生成专业电商服装模特。匹配指定属性：性别、年龄段、种族、体型、肤色、发型发色、五官特征、表情神态、姿态风格。自然棚拍或生活化光源，适合服装电商展示。全身或指定景别。构图干净，适合产品展示。高分辨率，真实感皮肤带自然毛孔和细微瑕疵，服装面料自然垂坠，肢体比例符合解剖学。

任务B——换脸：将目标图中模特的面部替换为上传参考肖像的面部，其余一切不变。目标图光线、肤色、头部角度、身体姿态、服装、背景全部保持原样。替换后的面部必须：精确匹配目标图光源方向与色温、在颌线和发际线处无缝融合肤色零可见边界、保持目标图原有头部角度和表情、精确贴合面部骨骼结构阴影过渡自然、保留自然皮肤纹理和毛孔、与发型耳朵自然衔接。无可见边界、无色差、无光源错位、无重影、无双重曝光。最终效果应为单张原始拍摄照片。
```

```
Task A — Model Generation: Generate a professional e-commerce fashion model based on the reference style. Match specified attributes: gender, age range, ethnicity, body type, skin tone, hairstyle and color, facial features, expression, and pose style from reference. Natural studio or lifestyle lighting appropriate for fashion e-commerce. Full body or specified framing. Clean composition suitable for product showcasing. High resolution, photorealistic skin with natural pores and subtle imperfections, realistic fabric draping, anatomically correct proportions.

Task B — Face Swap: Replace the model's face in the target image with the face from the provided reference portrait, preserving everything else unchanged. Target image lighting, skin tone, head angle, body pose, clothing, background must remain identical. The swapped face must: exactly match target lighting direction and color temperature, seamlessly blend skin tone at jawline and hairline with zero visible seams, maintain target's original head angle and expression, accurately follow facial structure with natural shadow transitions, preserve natural skin texture and pores, integrate naturally with hairstyle and ears. No visible boundary, no color shift, no lighting mismatch, no ghosting, no double exposure. Result must look like single original photograph.
```

### 负向提示词
```
脸部变形、五官扭曲、肤色不匹配、色差、光源方向不一致、颌线接缝、发际线接缝、可见边界、过渡不自然、皮肤纹理丢失、塑料感、磨皮过度、重影、双重曝光、表情丢失、原表情移位、角度不匹配、发型错位、耳朵变形、背景变化、身体变形、姿态变化、服装变化、低分辨率、模糊、像素化、水印、logo、JPEG伪影
```

```
face deformed, facial features distorted, skin tone mismatch, color shift, lighting direction inconsistent, jawline seam, hairline seam, visible boundary, unnatural transition, skin texture lost, plastic look, over-smoothing, ghosting, double exposure, expression lost, original expression displaced, angle mismatch, hairstyle misaligned, ear deformed, background change, body deformed, pose change, clothing change, low resolution, blurry, pixelated, watermark, logo, JPEG artifacts
```

---

## 通用负面词库（所有预设共用补充）

```
numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, different hairstyle between panels, different clothing between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, broken layout
```

---

## 预设使用纪律

1. **一致性三重锚定**：每套预设必须包含 `consistent` / `identical` / `uniform` 至少两个词
2. **无文字强制排除**：所有预设的负面词必须包含 `numbers, text, letters, labels, annotations` 等文字类排除
3. **光线整场锁定**：同一预设内所有格子必须统一光源方向和色温
4. **边缘柔和过渡**：所有预设必须包含 `subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed`
5. **背景统一浅暖灰**：所有预设使用 `light warm gray background color F0EDE8`，负面排除 `pure white background, stark white, cold gray`
6. **单格不切碎**：25宫格中相邻帧动作必须连贯，避免跳帧感
7. **先测后扩**：复杂预设（25宫格/九宫格）建议先单格测试效果，确认一致性后再生成完整网格

---

## 版本更新日志

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| v1.0 | 2026-05-22 | 初始版本，8个预设 |
| v2.0 | 2026-05-28 | 统一背景为浅暖灰#F0EDE8，新增表情六宫格预设，优化边缘处理，所有预设增加边缘柔和过渡描述 |
| v2.1 | 2026-05-30 | 新增视角类360全景图预设 |
| v1.0.55 | 2026-07-12 | 新增「电商」分类（预设11-16）：鞋子静物场景替换、模特上脚图替换、脚模替换、电商海报设计、字体设计、模特生成与换脸，全部中英双语 |

---

*本文件为无限画布AI工具的预设提示词标准库，直接复制粘贴即可使用。*
