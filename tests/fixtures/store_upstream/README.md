# server/store_data — TapNow 应用市场数据源

NOVAI 的「应用市场」只做**结构与目录复制**：把 TapNow 市场里的技能/应用条目原样搬成本地数据，
用于商店页展示与「新建画布 + 编译提示词」。**执行端不搬**——不接 TapNow 的运行时、插件、connector
和 OAuth；`launch` 不调用 TapNow 任何接口。

- 来源：TapNow 应用市场（app.tapnow.ai）接口抓取，原始响应见抓取工作目录 `catalog.json` / `details_all.json`
- 抓取日期：2026-10-24
- 数据版本：`content_version = 2a276d32834dd82a`
- 原始覆盖：83 条（skill 60 / app 23），分类 5 个，featured 14 条，trending_use_cases 8 条
- 当前一级市场：20 个 skill；33 个条目停止开放，30 个重复子场景只在合集详情中出现
- 技能正文：26 份原始正文（合计 355,703 字）+ 22 份公开元数据整理稿（非原文，见下）

## 市场运营配置

`curation.json` 不改写原始目录，用 `kind:name` 控制条目的展示和开放状态：

- `root_items`：一级市场、轮播和热门用例允许展示的条目；合集里的隐藏子项仍可通过详情打开和启动。
- `unavailable_items`：当前没有真实执行链路的条目；不在一级市场展示，安装与启动接口返回 409，已安装条目仍允许卸载。
- 接口保留全部 83 条供合集引用，另返回 `visible_counts`；每条补 `store_visible` / `store_available`，停用条目同时返回 `enabled=false`。

## 为什么放在 server/store_data（而不是 data/store）

仓库的 `.gitignore` 第 101 行把整个 `data/` 忽略了（防止 `git add -A` 误提交用户运行数据），
所以 `data/store/**` 永远不会入库。这批市场数据是要随代码分发的**只读数据**，因此整体迁到这里：

- 运行时优先读 `<DATA_DIR>/store`（部署时若把数据拷进数据目录，以它为准）；
- 找不到时回退到仓库自带的 `server/store_data`（`server/routes/store.py` 的 `store_dir()`）。

迁移原因与顺序写在代码注释里；`git check-ignore -v server/store_data/catalog.json` 应为空。

## 文件结构

```text
server/store_data/
├── catalog.json                 # 原始市场目录（含 {"code":200,"data":{...}} 外壳）
├── curation.json                # 一级入口与停用条目配置
├── details/
│   └── <kind>__<name>.json      # 83 个条目详情，内容是该条响应的 ["data"]（不是整个响应）
├── skill_instructions/
│   ├── _index.json              # 26 个技能的元数据（id/chars/provider/version/status…）
│   └── <skill-id>.md            # 26 份技能正文（launch 的「技能执行手册」）
│   ├── <skill-id>.md            # 26 份 TapNow 原始正文（launch/系统提示的「技能执行手册」）
│   └── generated/
│       └── <name>.md            # 22 份用公开元数据整理的等价手册（非原文，文件头有声明）
└── README.md
```

- `details/` 文件名规则：`<kind>__<name>.json`，例如 `skill__trending-recast-gallery.json`。
- 其中 2 条上游详情接口返回 `{"code":404,"error":"app_store_item_not_found","data":null}`，本地文件内容就是
  `null`：`app__baidupan.json`、`app__descript.json`（slug 清洗前的名字带品牌，已改名）。接口遇到 null 时回退成 catalog 条目
  （带 `installed`），不会 500。
- 详情里的图片 URL 已改写成 `/static/store/covers/<文件名>.webp`（见下节）。

## 字段说明（与接口一致，不改名）

catalog item（83 条）：

| 字段 | 说明 |
| --- | --- |
| `kind` | `skill` / `app` |
| `name` | 条目 id（商店内唯一），如 `trending-recast-gallery` |
| `display_name` | 展示名 |
| `description` / `marketing_line` / `business_scenario` | 一句话描述 / 营销语 / 业务场景分组 |
| `category` | 展示分类（中文） |
| `cover_url` / `cover_video_url` / `cover_poster_url` | 封面图（已是本地 WebP）/ 封面视频（远程，不下载）/ 视频封面兜底图（远程，见下） |
| `search_terms` / `marketing_slots` | 搜索词 / 营销位素材 |
| `installed` / `enabled` / `runtime_status` / `activation_skill` | 安装态（本地覆盖）/ 启用 / 运行时状态 / 激活所需 skill（可能对应技能正文） |
| `store_visible` / `store_available` | 是否在一级市场展示 / 是否允许安装和启动（由 `curation.json` 计算） |

detail 在 catalog 字段之外还会带：

| 字段 | 说明 |
| --- | --- |
| `guide` | `{summary, scenarios[], required_context[{title,description}], steps[{title,description}], outputs[], boundaries[], use_cases[], follow_ups[]}` |
| `install_mode` / `connectors` / `capabilities` | 仅 app 分支（`install_mode=user` 等） |
| `collection` | 集合页：`{categories[], entries[{item, category, cover, tags, featured, title, description}]}` |
| `influencer_studio` | 达人 studio：两条条目字段集不同（一条 `{agent, clips, personas, traits, fields, formats, references, view, note, clip_prompt}`，一条 `{view:"hub", studio, heroes, ticker}`） |
| `preset_gallery` | 预设墙：`{hero, categories[{id,label}], presets[]}`，preset 结构见下 |
| `try_form` | 试跑表单：`{references{min,max}, prompt{max_length}, fields[{id,label,placeholder,max_length}]}` |
| `starter_prompt` | 默认起始提示词（launch 不带 preset_id 时用它） |
| `icon_url` / `icon_style` | 图标（仍为远程 URL，未本地化） |
| `intro_showcase` / `recommended_model` / `library` / `presentation` / `public_content` | 详情页展示素材 |
| `has_skill_body` / `skill_body_chars` | **接口计算字段**（不落盘）：该条目有没有技能正文、正文多少字 |
| `skill_body_source` | **接口计算字段**：`"original"`（TapNow 原文）/ `"generated"`（公开元数据整理稿）/ `""`（没有正文） |
| `detail_unavailable` / `detail_unavailable_reason` | 仅上游 404 的 2 条 app（详情节为 null）：前端据此渲染降级页 |

preset（`preset_gallery.presets[]`）：

```text
{id, title, description, category, aspect, is_new,
 cover{kind, src, poster},
 agent{skill_mention, prompt, auto_send},
 inputs{references{min,max,roles[]}, prompt{max_length}, fields[{id,label,placeholder,max_length}]}}
```

## 分支分布（按详情字段判定）

| 分支 | 判定 | 条数 |
| --- | --- | --- |
| generic | 无下列字段 | 50（含 2 条上游 404 的 null 详情） |
| app | 有 `install_mode` | 21 |
| collection | 有 `collection` | 9 |
| studio | 有 `influencer_studio` | 2 |
| preset_wall | 有 `preset_gallery` | 1 |

## 技能正文（skill_instructions/）

- **原始正文**：26 份 `<skill-id>.md` + `_index.json`，与 TapNow 侧「技能」一一对应，大小 412 KB。
- **整理稿（generated/）**：60 条 skill 里 38 条能解析到 TapNow 原文（26 份原文通过 `activation_skill`
  也被多条条目复用，例如 `character-asset-pack` → `primordia-character-asset-pack`）；其余 **22 条**
  由 `tools/build_store_manuals.py` 用公开元数据（description / marketing_line / guide.* / starter_prompt）
  拼成固定结构的手册，写到 `skill_instructions/generated/<name>.md`，文件头固定声明
  「原始执行手册未随客户端下发，以下内容由公开元数据整理，非原文」。脚本幂等：第二次运行 0 变更。
  注意：早先按「60 - 26 = 34」估算过缺口，实际是 22——因为原文会通过 `activation_skill` 覆盖多条。
- 条目挂正文的规则（`server/routes/store.py`）：优先用 catalog/detail 的 `name`，否则用
  `activation_skill`，两者都要求在 `_index.json` 里或存在同名 `.md`。
  - 26 个 key 里，21 个直接等于某条 catalog 的 `name`；24 个能命中某条的 `activation_skill`；
  - `digital-human-video` 与 `commerce-ad-studio` 两份正文在 83 条里没有对应条目（保留文件，不对外挂）。
- 解析顺序：原始正文 → `generated/` 整理稿 → 空；`GET /api/store/items/{kind}/{name}` 会返回
  `has_skill_body` / `skill_body_chars` / `skill_body_source`，前端可据此给整理稿打「整理稿」标记。
- `POST .../launch` 返回 `skill_ref`（有正文时形如 `store:skrull`，没有则空串），**提示词里不再放正文**
  （会撞 `/api/agent/run` 的 instruction 4000 字上限）；前端把 `skill_ref` 原样传给 `/api/agent/run`，
  由后端注入系统提示的【技能执行手册】段落，正文超过 30000 字截断并标注「（已截断）」。
  - 内部引用前缀是 `store:`；解析端兼容历史前缀（旧画布种子 / 旧请求里的旧写法仍能读到正文）。
  - `include_skill_body` 参数已废弃（deprecated），传 true 也不改变提示词，只为兼容旧前端保留。

## 封面资源与视频

- 脚本：`tools/fetch_store_assets.py`（urllib，超时 20s，单张失败不中断，幂等）。
- 下载范围：`cover_url`、`poster` / `poster_url`、`{kind:"image", src}`（包含 `intro_showcase` 面板与
  collection / preset 封面）。产物在 `static/store/covers/`。
- **压缩**：Pillow 重编码成 WebP，最长边 ≤ 1280、quality 80（`--resize / --quality` 可调）；总大小超过
  `--target-mb`（默认 12）会自动逐级降 quality（最低 50）。实测 151 张：**43.0 MB → 2.9 MB（-92.8%）**，
  最大单张 193 KB。文件名保持「原主干 + .webp」，旧 jpg/png 写出成功后删除。
- **视频不下载**（体积太大）：`cover_video_url`、`{kind:"video", src}` 保持远程 URL。
- 对带封面视频的 catalog 条目（47 条）补了 `cover_poster_url`：把视频 URL 的 `variant_name` 换成
  `thumbnail`（TapNow 同一份上传的缩略图口径），前端视频播不了时回退它；该图仍是远程 URL、未本地化。

## 品牌词清洗（界面层）

产品界面不允许出现抓取来源的品牌字样，所以 `server/store_data` 的**数据内容**已由
`tools/scrub_store_brand.py` 清洗（幂等，可 `--dry-run`）：

- 固定短语替换（如 `TapNow Skrull → Skrull`、`在 TapNow 上 → 在画布上`、`TapNow MCP → 平台 MCP`），
  再兜底删除残留品牌词并清理多余空格/标点；
- catalog.json、details/*.json、skill_instructions 下 26 份原始正文 + 22 份整理稿 + `_index.json`
  全部处理；**`grep -ri tapnow server/store_data --include=*.json` 为 0**；
- 例外与副作用（如实记录）：
  1. **14 条 app 的 slug 改名**（`tapnow-hubspot → hubspot` 等），details 文件同步重命名、引用同步更新
     —— 不改 slug 无法做到「数据里 0 命中」；
  2. **品牌媒体 URL 被清空**：`cover_video_url`（94）、`kind=video` 的 `src`（159）、`video`（31）、
     `kind=audio` 的 `src`（2）、下载失败/本身是 mp4 的营销位 `url`（22）。这些资源原本也是远程/不可用，
     前端回退到已本地化的 poster / cover_url；
  3. `_index.json` 里的 `chars`（原始正文字数）是清洗前的统计值，清洗后不再精确（接口不用它，详情用
     `skill_body_chars` 现场计算）；
  4. **封面图里可能烧录了品牌 logo**（例如 Skrull 封面、部分营销位图）：图片内容改不了，已本地化在
     `static/store/covers/`，需要换图只能重新抓取替换；此处仅作记录。
- 本文件（README）保留来源说明，仓库内文档不算产品界面，因此仍会提到抓取来源（`grep --include=*.md`
  只剩这一处属预期）。

## 与既有 NOVAI 数据的关系

- 本目录**只含 TapNow 这 83 条**，不包含仓库已有的 NOVAI 技能（`server/skills/builtin_skills.json`）与
  智能体（`server/agents/builtin_agents.json`）；应用市场接口不再读那两个注册表。
- 安装态单独落 `<DATA_DIR>/store_installed.json`（数组，元素 `"kind:name"`），与既有技能/智能体安装态无关。

## 重新抓取 / 重新下载 / 重新压缩

```bash
# 1) 覆盖 server/store_data（catalog.json + details/ + skill_instructions/），保持原始响应不动
# 2) 下载并本地化成 WebP（幂等，可重复跑）
python3 tools/fetch_store_assets.py
python3 tools/fetch_store_assets.py --dry-run            # 只看要处理多少
python3 tools/fetch_store_assets.py --force              # 已压缩的也按当前参数重编码
python3 tools/fetch_store_assets.py --resize 1024 --quality 75 --target-mb 10

# 3) 给没有原始正文的 skill 重新生成「整理稿」（幂等；有原文的会跳过，多余的会删掉）
python3 tools/build_store_manuals.py
python3 tools/build_store_manuals.py --dry-run
```
