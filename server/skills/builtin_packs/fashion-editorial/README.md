# Fashion Editorial — 胶片暗房放大风格服装场景大片合成

> AI Agent Skill（v1.1）· 输入模特服装 look 图 + 空镜 → 输出每张动作不同、景别不同、风格统一、跨张一致的服装场景大片

## 功能简介

用户提供模特白底服装 look 图（单人/双人）+ 空镜画面（无人场景），本技能批量合成指定数量的**胶片暗房放大风格**服装场景大片：

- 每张人物动作不同、景别不同
- 人物 / 服装 / 场景跨张一致（三层保障：身份锁 + 每条 prompt 自含一致性块 + 参考图随图输入）
- 风格档案 v1.1（`profiles/film-darkroom-cn.json`）：画面零文字 + 油润色彩质感，默认加载
- 出图模型不预设：OpenAI 兼容 / 火山方舟 Seedream / dashscope 均可，支持运行时 `--model` 切换

## 触发词

服装大片、场景大片、look图合成、空镜合成、模特置入场景、批量出图、多动作多景别、lookbook、campaign、胶片风格、暗房放大

## 目录结构

```
fashion-editorial/
├── SKILL.md                    # 技能主文件（入口，含输入/输出说明与工作流）
├── config.example.json         # 配置模板（复制为 config.json 填写）
├── profiles/
│   ├── film-darkroom-cn.json   # 默认风格档案 v1.1（胶片暗房放大·油润色彩）
│   └── README.md               # 档案字段说明 / lock 模式用法
├── references/
│   ├── styles.md               # 风格库
│   ├── api-guide.md            # API 配置指南（LLM + 图像后端）
│   └── shot-library.md         # 镜头库
└── scripts/
    ├── shoot_plan.py           # 镜头编排：身份锁 + 风格档案 + 生成 shotplan.json
    └── generate_image.py       # 批量出图：按 shotplan 调用图像后端
```

## 安装与使用

### 1. 放置技能

将整个 `fashion-editorial-v1.1/` 目录放入 Agent 的 skills 目录（如 WorkBuddy/OpenClaw 的 `skills/` 下），或按各平台 Skill 安装方式导入。

### 2. 配置 API

```bash
# 复制模板并填写
cp config.example.json config.json
```

config.json 需要两部分：

| 配置项 | 说明 |
|---|---|
| `prompt_llm` | 视觉语言模型（镜头编排 + 身份锁提取，需支持图片输入） |
| `image_backend` | 出图模型（需支持多参考图输入保证一致性，如 Seedream 4.0） |

或使用环境变量（优先级高于 config.json）：

```bash
# 镜头编排 LLM
FE_LLM_BASE_URL / FE_LLM_API_KEY / FE_LLM_MODEL / FE_LLM_VISION_MODEL
# 图像后端
FE_IMG_TYPE / FE_IMG_BASE_URL / FE_IMG_API_KEY / FE_IMG_MODEL / FE_IMG_SIZE
```

> 详见 `references/api-guide.md`。

### 3. 出图（两条路径）

**路径 A：自然语言驱动**（Agent 内置技能时）

向 Agent 描述需求，例如：
> 用这张 look 图和这张空镜，出 6 张胶片暗房风格的场景大片，动作和景别每张不同。

**路径 B：命令行驱动**

```bash
# 先生成拍摄计划
python3 scripts/shoot_plan.py \
  --look look1.jpg --look look2.jpg \
  --scene-image scene1.jpg \
  --count 6 \
  --out shotplan.json

# 再按计划批量出图
python3 scripts/generate_image.py --plan shotplan.json
```

### 4. 锁定新风格（可选，lock 模式）

提供 3-20 张同风格参考图，锁定为自己的专属风格档案：

```bash
python3 scripts/shoot_plan.py \
  --mode lock \
  --image ref1.png --image ref2.png --image ref3.png \
  --profile-name <档案名> \
  --out profiles/<档案名>.json
```

## 配置说明（重要）

- `config.json` 含 API Key，**不要提交到 GitHub**（已在 .gitignore 中排除）
- 所有脚本同时支持 config.json 与环境变量两种方式
- 出图模型建议选择支持**多参考图输入**的模型（即梦/Seedream/GPT-4o 等），以保证跨张一致性

## License

MIT © 2026
