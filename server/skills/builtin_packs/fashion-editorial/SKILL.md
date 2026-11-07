---
name: fashion-editorial
description: 胶片暗房放大风格服装场景大片合成（Fashion Editorial Composite）—— 用户提供模特白底服装 look 图（单人或双人）+ 空镜画面（无人场景），批量合成指定数量的胶片暗房放大风格服装场景大片：每张人物动作不同、景别不同，人物/服装/场景跨张一致（身份锁 + 每条 prompt 自含一致性块 + 参考图随图输入三层保障）。风格档案 v1.1（profiles/film-darkroom-cn.json，画面零文字 + 油润色彩质感）默认加载；后续可用 --mode lock 继续迭代。出图模型不预设，按用户要求配置（OpenAI 兼容 / 火山方舟 Seedream / dashscope，支持运行时 --model 切换）。触发词：服装大片、场景大片、look图合成、空镜合成、模特置入场景、批量出图、多动作多景别、lookbook、campaign、胶片风格、暗房放大。
---

# Fashion Editorial — 胶片暗房放大风格服装场景大片合成

输入三类素材 → 输出**每张动作不同、景别不同、风格统一、跨张一致**的服装场景大片。

> 风格档案已锁定为 v1.1（profiles/film-darkroom-cn.json）：画面零文字 + 油润色彩质感。

---

## 输入

| 参数 | 必备 | 类型 | 说明 |
|---|---|---|---|
| `--look / -l` | 是 | 路径，可多次 | 模特白底服装 look 图（单人/双人）。例：`--look look1.jpg` |
| `--scene-image / -si` | 可选 | 路径，可多次 | 空镜画面（无人场景）。与 `--scene` 至少二选一 |
| `--scene / -s` | 可选 | 字符串 | 场景文字描述（无空镜时使用） |
| `--count / -n` | 是 | 整数 | 出图数量，默认 6，上限 30 |
| `--style` | 可选 | 字符串 | 覆盖风格 ID，默认 `film-darkroom` |
| `--style-file` | 可选 | 路径 | 指定风格档案（JSON），覆盖默认 |
| `--out` | 可选 | 路径 | 计划输出路径，默认 `<workdir>/shotplan.json` |

## 输出

| 文件 | 说明 |
|---|---|
| `shotplan.json` | 结构化拍摄计划（含身份锁、风格档案、镜头组） |
| `shotprompts.md` | 可直接复制的提示词文件（每镜一段，含中英双语） |

## 一致性保障（三层）

1. **身份锁（shoot_plan.py 自动提取）** —— look 图 + 场景文字 → 逐条人/服/场特征清单，穿戴细节明确（如"罗纹高领""宽腿亚麻裤""玳瑁框太阳镜"）
2. **prompt 内一致块** —— 每条英文 prompt 全部复制一遍完整身份描述，不会跨镜漂移
3. **参考图随图输入** —— 调用 `generate_image.py` 出图时 look 图 + 空镜自动作为多参考图随图输入

## 工作流

### Step 1：拍计划

```bash
python3 <skill-root>/scripts/shoot_plan.py \
  --look look1.png \
  --scene-image scene1.png \
  --scene "Mediterranean white stucco wall with single white-framed window, yellow trumpet vine" \
  --count 4 \
  --out shotplan.json
```

输出：
- `shotplan.json` —— 身份锁 + 风格档案注入 + 4 镜编排（每镜景别/机位/动作全唯一）
- `shotprompts.md` —— 可直接复制粘贴的成品提示词

### Step 2：核对

打开 `shotprompts.md` 通读，确认身份块、场景、动作编排无误。

### Step 3：出图

把 `shotprompts.md` 里每条 prompt 贴到你的出图模型（出图模型名见 config.json 或运行时 `--model`）。

如要在脚本内直接出图：

```bash
python3 <skill-root>/scripts/generate_image.py \
  --plan shotplan.json \
  --all \
  --output ./outputs \
  --model openai-compatible \
  --name look01_scene01
```

> 环境变量优先（注入到其他 agent 时推荐）：
> `FE_LLM_API_KEY` / `FE_LLM_BASE_URL` / `FE_LLM_MODEL`
> `FE_IMG_API_KEY` / `FE_IMG_BASE_URL` / `FE_IMG_MODEL`

### Step 4：迭代（可选）

如某张风格没出来，按提示词末尾的"style_keywords"反向追问你的出图模型。常见方向：
- 颗粒不够 → "Add more visible film grain, especially in midtones"
- 暗角弱 → "Strengthen the corner vignette by 30%"
- 颜色干 → "Add oily lustrous color depth and warm highlight rolloff"
- 露出文字 → "Remove ALL text from the image; pure visual photograph"

---

## 风格档案

`profiles/film-darkroom-cn.json` v1.1（2026-09-01 锁定自 17 张用户参考图）已为默认风格，含：
- 35mm 胶片 + matte 银盐相纸 + 颗粒 + 暗角 + Portra 400 褪色调性
- 自然窗光/侧光为主，林荫斑驳 + 墙地投影
- 真实皮肤纹理（不磨皮）、环境叙事（厨房/街头/花园/蓝色房间/巴黎店面等）
- **画面零文字**（已排除任何杂志标题/品牌字/wordmark）
- **油润色彩质感**（oily lustrous color rendition）+ 完整 negative_prompt（已排除数码感、HDR、teal-and-orange、影楼硬闪、塑料皮肤等）

切换其他风格：`--style 文件名`（不带 `.json`，自动从 `profiles/` 目录查）

---

## 附录 A：锁定专属风格（用户提供胶片放大参考素材后）

用户提供 3-20 张同风格参考图、明确要"锁定为我的风格"时：

```bash
python3 <skill-root>/scripts/shoot_plan.py \
  --mode lock --image ref1.png --image ref2.png --image ref3.png \
  --profile-name <档案名> --out <skill-root>/profiles/<档案名>.json
```

锁定后 `profiles/` 有唯一档案时所有 plan 自动加载（stderr 有 `[AUTO]` 提示），无需
`--style-file`；多份档案时才需显式指定。档案字段：`style_name / zh_summary /
style_keywords / single_line / color_palette / composition / lighting /
texture_material / negative_prompt / consistency_notes`——暗房放大特有的颗粒/
暗角/相纸色/显影不均痕迹务必写全（lock 的系统提示已内置该要求）。

---

## 文件结构

```
fashion-editorial/
├── SKILL.md                          # 当前文件
├── config.example.json               # 出图模型配置示例
├── scripts/
│   ├── shoot_plan.py                 # 拍计划 + lock 模式
│   └── generate_image.py             # 多参考图直接出图
├── references/
│   ├── styles.md                     # 风格预设（与档案对齐）
│   ├── shot-library.md              # 景别/机位/动作词表
│   └── api-guide.md                  # 出图 API 接入
└── profiles/
    ├── film-darkroom-cn.json         # v1.1 锁定档案
    └── README.md
```
