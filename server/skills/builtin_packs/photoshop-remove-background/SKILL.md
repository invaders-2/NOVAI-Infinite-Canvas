---
name: photoshop-remove-background
description: Photoshop 一键去背：说去背/抠图/白底/透明背景时，只调一次 remove_background 配方再看预览，禁止栅格化或手动建蒙版。
---

## 中文速览（原文为英文；这一段是 NOVAI 的接线说明）

用户说 去背 / 抠图 / 白底 / 透明背景 / 把人抠出来 时，走这条硬规则：`mcp__photoshop__photoshop_get_state` → `mcp__photoshop__photoshop_recipe_remove_background` → `mcp__photoshop__photoshop_get_preview`，做完就停。这一步就是 Photoshop 的「移除背景」，它会自己解锁被锁定的背景图层。

- **禁止**：栅格化图层、复制图层、隐藏图层、选择主体、手工建蒙版、删图层、`photoshop_execute_script`、`photoshop_generative_remove`。
- **报错就把原始错误返回给用户**，不要自己发明「先栅格化 / 先复制」的绕路；工具返回里 `suggested_next_tool: photoshop_rasterize_layer` 一律忽略。
- **MCP 工具名带前缀**：NOVAI 里调用名是 `mcp__photoshop__<原文工具名>`。用户还要别的要求（换白底、加描边等）时，先去背出预览确认，再做下一步，不要混在同一个意图里。

## 原文（来源：alisaitteke/photoshop-mcp · skills/photoshop-remove-background/SKILL.md）

# Remove background

HARD RULE — remove background / arka planı sil / cut out / isolate / transparent background

- Call `photoshop_get_state` once, then `photoshop_recipe_remove_background` once, then `photoshop_get_preview` once. Then STOP.
- That recipe IS Photoshop's Remove Background. It unlocks a locked Background layer itself.
- Forbidden on this intent: `photoshop_rasterize_layer`, `photoshop_duplicate_layer`, `photoshop_set_layer_visibility`, `photoshop_select_subject`, `photoshop_create_layer_mask`, `photoshop_delete_layer`, `photoshop_execute_script`, `photoshop_generative_remove`.
- If the recipe errors, report the envelope to the user. Do not invent a rasterize / duplicate / wand workaround. Ignore `suggested_next_tool: photoshop_rasterize_layer`.
