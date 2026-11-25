---
name: photoshop-recipes
description: Photoshop 配方选择表：去背/抠图/白底/修人像/磨皮/调色/电影感/网页导出/九宫格/批量水印/证件照/贴图替换，先查表再调工具。
---

## 中文速览（原文为英文；这一段是 NOVAI 的接线说明，必须连同下文一起遵守）

这是一张「用户说什么 → 调哪个 Photoshop 工具」的配方路由表。用户说去背、抠图、白底、透明背景、修人像、磨皮、调色、电影感、网页导出、九宫格、批量水印、证件照、贴图替换、换天空时，先在下表找到对应配方再调工具；不要自己临时拼脚本或用 execute_script 绕路。

- **工具名前缀**：下文写 `photoshop_xxx`，在 NOVAI 里实际调用名是 `mcp__photoshop__photoshop_xxx`（例如 `mcp__photoshop__photoshop_recipe_remove_background`）。MCP 总开关没开时先提示用户去「设置 → 插件 → MCP 服务」打开。
- **ps.* 是提示词不是工具**：下文 `ps.xxx` 指 MCP 的 prompts/get，NOVAI 只暴露工具、没有 prompts。遇到 `ps.xxx` 就按同名的 `photoshop_recipe_xxx` 工具直接做；指南类（如 `ps.color_correct`、`ps.dodge_burn_guide`）按其描述手动串工具。
- **先看状态、后出预览**：动手前 `mcp__photoshop__photoshop_get_state` 确认 Photoshop 连接正常；改完 `mcp__photoshop__photoshop_get_preview` 出图给用户看，不要只口述成功。
- **一次只做一件事**：配方工具本身就是一次可撤销操作，别把多个配方链在一起；用户提多个要求时逐个确认。

中文说法补充（原文只有英文及土耳其语词条，这里只补常见说法）：

- 去背 / 抠图 / 白底 / 透明背景 → `photoshop_recipe_remove_background`（严格按 photoshop-remove-background 技能执行）
- 修人像 / 磨皮 / 去瑕疵 → `photoshop_recipe_enhance_portrait`；纹理分频 → `photoshop_recipe_frequency_separation`
- 调色 / 电影感 / 青橙 / 胶片感 → `photoshop_recipe_apply_color_grade`；「太平了 / 提亮压暗 / 拉对比」→ `photoshop_adjust_curves`
- 网页导出 / 发 IG / 电商主图规格 → `photoshop_recipe_export_social_variants` 或 `photoshop_recipe_prepare_for_web`
- 九宫格 / 切长图 / 无缝轮播 → `photoshop_recipe_split_carousel`
- 批量水印 / 批量加 logo → `photoshop_recipe_batch_watermark`
- 证件照 / 签证照 / 一寸二寸 → `photoshop_recipe_passport_photo`
- 贴图替换 / 批量套样机 → `photoshop_recipe_batch_mockup_replace`
- 白边贴纸 / 一键白边 → `photoshop_recipe_sticker_outline`；换天空 → `photoshop_sky_replacement`，不可用时 `photoshop_recipe_sky_blend`；去路人 / 去杂物 → `photoshop_generative_remove`

## 原文（来源：alisaitteke/photoshop-mcp · skills/photoshop-recipes/SKILL.md）

# Recipe routing

User intent glossary

- Map colloquial phrases to the primary tool below.
- bg.remove — "remove background", "cut out", "isolate subject", "transparent background", "arka planı sil" → `photoshop_recipe_remove_background` (the recipe unlocks a locked Background layer itself — do not rasterize, duplicate, or hide layers first; one recipe call then `photoshop_get_preview`). Follow the photoshop-remove-background skill.
- obj.remove — "remove that person", "erase distraction", "generative remove" → `photoshop_generative_remove` first; fallback `photoshop_recipe_remove_distraction` (content-aware) after manual selection
- mask.gradient_fade — "fade into background", "gradient mask", "blend subject" → `photoshop_recipe_gradient_fade`; guide `ps.gradient_blend` for atomic chain
- sky.replace — "replace sky", "fix blown sky", "better clouds" → `photoshop_sky_replacement` when `sky_replacement_native`; else `photoshop_recipe_sky_blend`; guide `ps.composite_blend` for manual composite
- portrait.enhance — "smooth skin", "retouch portrait", "fix blemishes" → `photoshop_recipe_enhance_portrait`
- portrait.freq_sep — "frequency separation", "split texture and color" → `photoshop_recipe_frequency_separation`
- color.correct — "make it pop", "S-curve", "fix flat image", "auto tone" → `photoshop_adjust_curves`; fallback `photoshop_auto_levels` then `photoshop_adjust_brightness_contrast`; guide `ps.color_correct`
- color.grade — "cinematic", "teal orange", "moody grade" → `photoshop_recipe_apply_color_grade`
- light.dodge_burn — "dodge and burn", "sculpt light", "lighten face" → `photoshop_recipe_dodge_burn`; guide `ps.dodge_burn_guide` for atomic setup
- export.social — "for Instagram", "web export" → `photoshop_recipe_export_social_variants` or `photoshop_recipe_prepare_for_web`
- layers.organize — "organize layers", "rename mess" → `photoshop_recipe_organize_layers`
- carousel.split — "seamless carousel", "split panorama", "swipe post", "slayt" → `photoshop_recipe_split_carousel`
- batch.watermark — "watermark these photos", "add logo to all", "toplu filigran" → `photoshop_recipe_batch_watermark`
- id.passport — "passport photo", "visa photo", "ID photo", "vesikalık", "biyometrik" → `photoshop_recipe_passport_photo`
- batch.csv_cards — "csv to cards", "batch cards", "data-driven graphics", "mail merge for images", "name badges from spreadsheet", "sertifika bas" → `photoshop_recipe_csv_to_cards`; prompt `ps.csv_to_cards`
- sticker.outline — "sticker", "white border", "white outline", "die-cut sticker", "double outline", "贴画", "白边描边", "一键白边", "kontur ekle", "beyaz çerçeve", "çift çizgi" → `photoshop_recipe_sticker_outline` (one call = white stroke + optional drop shadow; `outline_style: "die_cut"` = white border + thin dark outer line via two stroked copies. Do NOT chain `photoshop_apply_layer_style` twice — it overwrites the previous effect.) Remove the background first when the layer is not yet isolated.
- artboard.multi — "artboard", "artboards", "iPhone and iPad frames", "device layouts", "画板" → `photoshop_list_artboards` then `photoshop_create_artboard` / `photoshop_set_active_artboard` / `photoshop_export_artboards` (or `photoshop_export_as` with `artboard_id`)
- docs.multi — "multi-screen", "multiple files", "all open tabs", "这几个文档", "close these documents" → `photoshop_list_documents` (artboard_count + saved per tab), then `document_id` on `photoshop_get_preview` / save / close. Not a second Photoshop process.
- type.set — "tracking", "leading", "letter spacing", "line height", "text box", "paragraph text", "字间距", "行高", "排版", "文本框" → pass those fields on `photoshop_create_text_layer` or `photoshop_set_text_style`. Do not use `photoshop_execute_script` for tracking/leading/box.
- type.mixed — "mixed fonts", "two colors in one line", "混排", "同一文字层" → `photoshop_set_text_ranges` (from inclusive, to exclusive). Do not split into extra layers unless that tool errors.

Degrade paths

- Generative remove / distraction — prefer `photoshop_generative_remove`; degrade to `photoshop_recipe_remove_distraction` or `photoshop_content_aware_fill` when `generative_unavailable` or `generative_credits_exhausted`.
- Sky replacement — prefer `photoshop_sky_replacement`; degrade: `photoshop_recipe_sky_blend` when a sky file path is available; otherwise `photoshop_place_image` + mask workflow or guide `ps.composite_blend`.
- Neural skin / harmonize — `photoshop_neural_filter` when `neural_filters` is true; else frequency separation / manual recipes.
- Select Subject v2 missing — `photoshop_recipe_remove_background` returns `version_unsupported` → manual selection tools + `photoshop_create_layer_mask`.
- Curves unavailable — use `photoshop_auto_levels` then `photoshop_adjust_brightness_contrast` before retrying stronger edits.

Disambiguation

- "gradient" — prefer linear gradient **on a layer mask** (blend/fade); not a Gradient Fill layer unless the user explicitly asks for a fill layer.
- "remove" — prefer mask or content-aware inpainting; not deleting the layer unless the user explicitly wants pixels destroyed.
- "sharpen" — web export sharpen pass → `photoshop_recipe_prepare_for_web`; single-layer sharpen → `photoshop_apply_sharpen`.

Guide prompts (MCP prompts/get)

- Prefer matching `ps.*` **recipe** prompt when the user wants a one-undo outcome; use guide prompts for teaching atomic chains.
- Recipe prompts (1:1 with `photoshop_recipe_*`): `ps.remove_background`, `ps.enhance_portrait`, `ps.prepare_for_web`, `ps.export_social_variants`, `ps.apply_color_grade`, `ps.frequency_separation`, `ps.batch_mockup_replace`, `ps.organize_layers`, `ps.gradient_fade`, `ps.sky_blend`, `ps.dodge_burn`, `ps.remove_distraction`, `ps.split_carousel`, `ps.batch_watermark`, `ps.passport_photo`, `ps.csv_to_cards`
- Guide prompts (no recipe pair): `ps.gradient_blend` — fade via mask gradient; `ps.color_correct` — tone / contrast fix chain; `ps.dodge_burn_guide` — 50% gray overlay setup; `ps.composite_blend` — place asset + mask + blend mode; `ps.generative_fill`, `ps.generative_remove`, `ps.generative_expand` — Firefly workflows
