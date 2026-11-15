# Fashion Editorial Director｜时尚大片创意策划 Skill

**面向平台：** NOVAI  
**Skill ID：** `fashion-editorial-director`  
**版本：** 1.0.0  
**默认语言：** 简体中文  
**核心能力：** 参考图深度分析、时尚创意策划、摄影分镜、系列一致性管理、AI 生图提示词生成与迭代。

## 1. 这个 Skill 能做什么

它不是单纯的“提示词润色器”，而是一个虚拟时尚创意团队。它会先理解用户的参考图和需求，再形成有明确视觉逻辑的创意方案，最后把方案转成逐张可执行的图像生成提示词。

典型闭环：

1. 接收文字需求、产品图、人物参考图、造型参考图、场景参考图或摄影参考图。
2. 分析每张参考图，并标注哪些是可观察事实、哪些是合理推断、哪些是创意建议。
3. 归纳视觉方向，建立参考图使用矩阵，解决不同参考图之间的冲突。
4. 输出主题概念、视觉系统、人物造型、场景与摄影执行策略。
5. 设计一组有叙事节奏、画面变化和整体统一性的 shot list。
6. 为每个镜头输出独立、完整、可复制的 AI 图像生成提示词。
7. 按用户反馈做局部修改，并维护已确认设定与版本变更。

## 2. 安装方式

> 说明：NOVAI 的具体 Skill Loader / Registry 接口需要以你当前运行版本的实现为准。本包采用独立目录 + `novai.skill.json` 的自描述结构；它不是 NOVAI App 的 `manifest.json`，也不假设 App manifest 与 Skill manifest 通用。

### 方式 A：通过 NOVAI 的 Skill 管理器导入

如果当前 NOVAI 版本提供“导入 Skill / 添加 Skill / 从目录加载”入口：

1. 解压本 ZIP。
2. 选择文件夹 `Fashion-Editorial-Director-NOVAI-Skill`，或直接选择其中的 `novai.skill.json`（以导入器支持方式为准）。
3. 确认 Skill ID 为 `fashion-editorial-director`。
4. 将 `SKILL.md` 设置为入口指令文件。
5. 检查 `references/`、`templates/` 是否作为随包资源一并加载。
6. 启用 Skill，并用 README 末尾的验收用例测试。

### 方式 B：手动放入 Skills 目录

如果 NOVAI 使用文件夹扫描式 Skill Registry，将整个目录复制到 NOVAI 配置的 Skills 根目录下。推荐目录名：

`skills/fashion-editorial-director/`

然后在 NOVAI 的 Skill Registry 中登记：

- `id`: `fashion-editorial-director`
- `entry`: `SKILL.md`
- `manifest`: `novai.skill.json`

**不要**把本目录直接放入 `apps/`，也不要把 `novai.skill.json` 改名成 NOVAI App 的 `manifest.json`，除非你的加载器明确要求这种转换。

### 方式 C：暂时没有 Skill Loader

可以把 `SKILL.md` 内容作为 NOVAI Agent 的专用系统指令，将 `references/` 与 `templates/` 作为知识文件或项目文件挂载。等 NOVAI 的正式 Skill API / Loader 确定后，再将本包的 `novai.skill.json` 映射到真实注册结构。

## 3. 文件结构

```text
Fashion-Editorial-Director-NOVAI-Skill/
├── README.md
├── SKILL.md
├── novai.skill.json
├── references/
│   ├── reference-image-analysis.md
│   ├── creative-direction.md
│   ├── fashion-photography.md
│   ├── series-continuity.md
│   ├── prompt-engineering.md
│   └── quality-gate.md
├── templates/
│   ├── creative-brief.md
│   ├── reference-analysis-report.md
│   ├── shot-list.md
│   ├── image-prompt-package.md
│   └── revision-log.md
├── workflows/
│   ├── workflow.yaml
│   └── output.schema.json
└── examples/
    └── example-workflow.md
```

## 4. 建议的 NOVAI 运行能力

| 能力 | 是否必需 | 用途 |
|---|---:|---|
| 多模态视觉理解 | 必需 | 阅读并分析用户上传的参考图片 |
| 长上下文 / 会话状态 | 推荐 | 维护本组大片已确认的模特、服装、场景与风格设定 |
| 文件读取 | 推荐 | 加载本 Skill 的 references 与 templates |
| 图像生成工具 | 可选 | 用户明确要求生成图片时调用；没有该能力时只输出提示词 |
| 文件导出 | 可选 | 导出 Markdown / JSON 创意方案 |

如果 NOVAI 的工具名称不同，应在 Agent 工具映射层做适配，不要在 Skill 指令中假定某个未接入的工具一定存在。

## 5. 快速测试

### 测试 A：单张参考图

上传一张时尚摄影图并输入：

> 分析这张参考图，提取它的摄影语言和视觉风格，再策划一组原创时尚大片。不要照搬原图。

预期：先做分层视觉分析，再给出创意概念、画面规划和可执行建议；不能只写一段泛泛的风格描述。

### 测试 B：多张参考图分工

上传 3 张图并说明：图 1 参考模特气质，图 2 参考服装造型，图 3 参考场景和光线。

预期：建立 REF-01 / REF-02 / REF-03 对应关系，明确每张图取用什么、不取用什么，不能把三张图混成一个模糊风格。

### 测试 C：局部修改

在已输出方案后输入：

> 保留模特、服装和色彩体系，只把第 03 张的室内场景改成雨后城市街道，其他镜头不变。

预期：只修改第 03 张相关部分，并说明哪些连续性锚点保持不变。

### 测试 D：提示词输出

输入：

> 把全部分镜转换成可直接用于图生图的提示词，中英文各一版，并注明每张图该引用哪张参考图。

预期：每张图都有独立完整提示词、参考图绑定说明、负面约束和一致性要求。

## 6. 版本说明

- `1.0.0`：初始完整版本，包含参考图分析、创意策划、摄影分镜、系列一致性、提示词生成和质量审核。

## 7. 兼容性声明

本包已经包含完整 Skill 内容和自描述 manifest，可作为目录型 Skill 包使用。**由于没有接入你当前 NOVAI 运行实例或读取其 Skill Loader 源码，本包尚未验证该版本 NOVAI 的一键导入按钮、字段映射和工具调用接口。** 如果需要做到完全原生的一键安装，需要将 `novai.skill.json` 与当前 NOVAI Skill Registry / Loader 的真实 schema 对齐。
