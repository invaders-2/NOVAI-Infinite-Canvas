# 风格预设（Built-in Style Presets）

> 启动时优先级：lock 模式档案 > `profiles/` 唯一档案 > 此文件中的 `film-darkroom`（默认）。多个内置风格并存时使用 `--style <id>` 显式选择。

---

## 胶片暗房放大（默认，参考锁定版 v1.1） (film-darkroom)

> 2026-09-01 用户提供 17 张参考图后锁定，v1.1 修订：画面零文字（杂志标题/品牌字不复刻）+ 油润色彩质感。完整档案见 `profiles/film-darkroom-cn.json`。本预设与档案等价；启动后会自动加载档案。

shot on 35mm film, hand-enlarged silver gelatin matte fiber print, analog film grain, soft natural window light or sidelight, long cast shadow on wall or floor, muted low-saturation palette, milky desaturated tones, Kodak Portra 400 / Fuji 400H faded color signature, oily lustrous color rendition, waxy-smooth tonal transitions, dense creamy color saturation like layered oil paint, darkroom C-print dye density, subtle cool cyan in shadows, warm cream highlight rolloff, soft dark vignette at print edges, faint hand-printed imperfection, honest skin texture with visible pores, no airbrushed plastic skin, environmental storytelling (kitchen / street / garden / blue room / Parisian storefront), European fashion editorial mood, introspective quiet atmosphere, intimate distance, vertical or 4:3 framing, optional polaroid-style white border with slight yellowing, optional camera data strip at bottom edge, absolutely no text or typography in frame

避免：any text, typography, magazine title, brand name, logo, type overlay, clean digital rendering, HDR look, oversaturated colors, glossy magazine retouching, digital sharpening halos, clinical perfection, 3D render look, plastic airbrushed skin, studio strobe, ring light, neon, deep pure black shadows, lens flare, bokeh balls, Instagram filter, smartphone photo, stock photo look, dry flat washed-out colors, thin digital color separation, identical twin symmetry, studio white seamless backdrop, generic AI glow, magenta color cast, teal-and-orange Hollywood grading, high fashion runway

---

## 杂志硬光 (magazine-hard)

modern magazine fashion editorial, hard key light with controlled fill, sculpted shadows, glossy studio retouching, saturated bold palette, polished skin, fashion week set design, slightly cool midtones, deep clean blacks, no grain, smooth gradient transitions

避免：film grain, vintage cast, soft natural light, candid moment

---

## 电影感 (cinematic)

cinematic still frame, anamorphic lens character, shallow depth of field, widescreen 2.39:1 framing, teal-and-orange color grade, atmospheric haze or fog, dramatic light direction, narrative moment, no grain for non-cinema cameras

避免：bright even key light, magazine cover flatness, smartphone snapshot

---

## 街头纪实 (street-doc)

candid street fashion, documentary photojournalism, photo essay mood, 35mm reportage framing, decisive moment, weather/season context, mixed lighting, deadpan expression, no retouching

避免：studio backdrop, posed editorial setup, beauty retouch, glossy finish

---

## 极简棚拍 (clean-studio)

minimal clean studio, seamless paper backdrop (NOT pure white unless specified), single softbox key + subtle fill, no environmental props, focus on garment silhouette and fabric detail, jewelry-grade product photography, neutral palette

避免：busy background, dramatic light, vintage character, grain

---

## 日系森系 (jp-nature)

Japanese Mori / forest girl aesthetic, soft leafy natural light, polaroid-style film, low contrast, gentle pastel palette, flower meadow or moss-covered forest, lined composition, nostalgic quiet mood

避免：urban context, hard shadows, saturated colors, glossy retouch

---

# 风格与档案的关系

每个内置风格用一段英文 `single_line` 描述，外加负面词。profiles/ 下的 JSON 档案比预设更丰富（含 zh_summary / color_palette / composition / lighting / texture_material 等多维度分解），供 prompt-LLM 做精细控制；单行预设供 fallback / LLM-less 调用。
