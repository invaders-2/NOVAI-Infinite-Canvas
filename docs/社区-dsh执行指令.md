# 给 dsh 的执行指令：NOVAI 社区（局域网版）

> 先通读 `AGENTS.md` 和 `docs/社区方案.md`（本指令的设计依据，冲突时以本指令为准）。
> 界面预览（已确认）：https://claude.ai/artifact/WxdSphj2cpr1NAnj4AAAYU （7 张画板：首页社区精选 / 社区页 / 作品详情 / 画布分享菜单 / 已发布状态 / 发布弹窗 / 我的主页）。打不开就按下面文字规格做。
> 做完后会有另一个助手逐条审查，请在最后交一份「验收报告」（见第 9 节）。

## 0. 硬规则（违反任何一条都算不通过）

1. **3000 端口是正式安装版，绝对不碰**：不 kill、不重启、不发写请求、不改它的数据。自测一律 `NOVAI_PORT=3931/3932` + 各自独立的 `NOVAI_DATA_DIR=/tmp/novai-comm-a`、`/tmp/novai-comm-b`。
2. 预览 / 截图用无头浏览器 + CDP，不弹 GUI 窗口；每次全新 `--user-data-dir`；进程用 `proc.kill()` 收尾，不用 `pkill -f`。
3. 不 git push、不发版。可以本地 commit，但每个里程碑一个 commit，message 写清楚。
4. Python 3.9：注解只用 `Optional/Dict/List`，禁止 `X | Y`。缩进 4 空格。
5. UI 硬规则（`AGENTS.md`「设计约束」全部适用）：不画边框 / 发丝线；容器 = 磨砂玻璃（半透明底 + `backdrop-filter` + 柔和投影），小弹层用加厚底；图标一律线性（lucide，走 `tools/icons/gen.mjs` 生成，别手改产物）；输入框获得焦点时**不出现**聚焦光圈 / 阴影 / 上浮；卡片里的操作按钮右对齐；下拉用磨砂玻璃；字号克制，跟现有页面一致；不写死模型名。
6. 前端改 `web/` 源码 → `cd web && npm run build`（产物 `static/v2/` 一起提交）；改画布改 `novai-canvas-ui/` → `npm run build`（产物 `static/novai-canvas/`）；构建后跑 `python3 tools/refresh_static_versions.py --write`，再确认 dry-run 为 0。
7. 已确认的三个决定：**「社区」放顶栏导航**（应用市场和我的之间，图标 `users`）；**「在局域网社区中可见」默认关闭**（第一次发布时引导打开）；**克隆来的技能默认停用**，确认后才启用。
8. 不做：「局域网在线」创作者头像栏；评论 / 关注 / 粉丝。

## 1. 后端（M1）

新建 `server/community/`（`store.py` 数据读写、`packager.py` 发布包、`transport.py` 传输层）和 `server/routes/community.py`，在 `main.py` 里 lan_account 路由后面挂载（照 canvas_share 的 `_deps.bind` 写法取 `LOAD_CANVAS / SAVE_CANVAS / ASSET_LIBRARY_DIR`）。

**数据落盘**（原子写，照 `lan_account._write_atomic`）：
- `<DATA_DIR>/community/items.json`：我发布的作品元数据 + 统计
- `<DATA_DIR>/community/packages/<item_id>/`：`package.json` + `cover.webp` + `media/`
- `<DATA_DIR>/community/cache/`：别人作品的元数据 + 封面 + 打开过详情的完整包
- `<DATA_DIR>/community/me.json`：收藏、点过赞的、克隆记录、屏蔽作者、已举报、可见开关
- `<DATA_DIR>/community/profile.json`：主页背景图（文件名 + 焦点位置 x/y）

**作品字段**：`id`（`<作者账号码>-<随机6位>`）、`kind`（canvas|skill|prompt）、`source_id`、`title`、`desc`、`tags`、`category`、`cover`、`author{account_id,nickname,avatar}`、`version`、`created_at`、`updated_at`、`allow_clone`、`meta{nodes,media,size_bytes}`、`stats{likes,clones,views,reports}`、`report_reasons[]`、`status`（published|unlisted）。

**传输层**：`CommunityTransport` 抽象 + `LanTransport` 实现。节点发现复用 `lan_account.peers_snapshot()` + 好友列表；并发拉取、单节点超时 1.5s、结果缓存 30s；拉不到的节点用 cache 并标 `online:false`。以后加 `CloudTransport` 时前端和接口不变。

**本机接口**（前端用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/community/feed?kind=&q=&sort=latest\|hot\|clones&category=` | 聚合作品流，每条带 `online` |
| GET | `/api/community/featured` | 本周精选：近 7 天 `likes + 2×clones` 排序取前 5（轮播和首页用） |
| GET | `/api/community/items/{id}` | 详情（远端经本机代理，顺带 +1 浏览，并缓存完整包） |
| POST | `/api/community/publish` | `{kind, source_id, title, desc, tags, category, cover, allow_clone, include_media}` |
| GET | `/api/community/mine?source_id=` | 我的发布；带 `source_id` 时返回这张画布的发布状态 + `has_changes`（画布 `updated_at` > 包的 `updated_at`）|
| PATCH | `/api/community/mine/{id}` | 编辑信息；`{republish:true}` 时重新打包、version+1 |
| POST | `/api/community/mine/{id}/unlist` / `relist` | 下架 / 重新上架 |
| DELETE | `/api/community/mine/{id}` | 删除发布（不删源画布） |
| POST | `/api/community/items/{id}/clone` | 克隆 → `{kind, target_id, copied, failed}` |
| POST | `/api/community/items/{id}/like` / `favorite` / `report` | 点赞（可取消）/ 收藏（可取消）/ 举报 `{reason}` |
| GET | `/api/community/favorites` / `likes` / `clones` | 我的收藏 / 点赞 / 克隆 |
| GET/PUT | `/api/community/settings` | `{visible}` |
| GET/PUT | `/api/community/profile` | 主页背景图上传 / 选素材 / 焦点 / 恢复默认 |

**公开接口**（局域网其他节点调用；`visible=false` 时一律 404）：

| 方法 | 路径 |
|---|---|
| GET | `/api/community/public/items` |
| GET | `/api/community/public/items/{id}` |
| GET | `/api/community/public/items/{id}/package`（`allow_clone=false` → 403）|
| GET | `/api/community/public/media/{id}/{file}` |
| GET | `/api/community/public/profile`（昵称、头像、背景图、统计，供别人看主页）|
| POST | `/api/community/public/items/{id}/event` `{type: like\|unlike\|clone\|view\|report, account_id, reason?}` |

**安全**：只读发布包，绝不暴露画布库 / 素材库 / 配置；`id`、`file` 白名单正则，防目录穿越；限流每 IP 每分钟 120 读 / 30 事件；事件按 `account_id` 去重；遵守 `NOVAI_LAN_AUTH`；对端发来的包要校验 schema、JSON ≤ 20MB。

## 2. 发布包与克隆（M1）

- **画布**：用 `canvas_share.canvas_snapshot()` + `sanitize_local_path()`；再去掉 API key / provider 配置；`include_media` 时把媒体复制进 `media/`（单包上限 200MB，超了报错说明原因）。
- **技能**：技能定义 JSON，去 env / key / 本机路径，保留作者署名。
- **提示词**：`{name, category, positive, negative}`。
- **克隆画布**：拉包 → `canvas_share.localize_media_urls()` 把媒体落到本机（失败的节点标红占位）→ 新建画布「原标题（克隆）」，写 `source:{item_id, version, author}`。
- **克隆技能**：新 id `原id-c<4位>` → `skills.registry.import_skill()`，**`enabled=false`**；返回里带 `needs_enable:true`，前端弹「来自 XXX 的技能，确认后启用」。
- **克隆提示词**：写进提示词库「社区」分组（没有就建）。
- 克隆完成后向作者节点上报 `clone` 事件；作者离线但本机有完整缓存包时仍可克隆，否则按钮置灰「作者离线」。

## 3. 首页「社区精选」（M3，`web/src/pages/home/HomePage.vue`）

- 放在模板库下方，同宽（内容宽度已统一为 `min(1240px, calc(100% - 96px))`，别改回去）。
- 标题「社区精选」+ 绿色小标签「局域网内 N 位创作者在线」+ 右侧「查看更多 >」胶囊按钮 → 切到社区页。
- 4 张卡（4:3 封面、左上类型标签 画布/技能/提示词、标题、作者头像昵称、点赞 / 克隆数），点卡打开作品详情弹窗。数据来自 `/api/community/featured`，不足 4 张用最新补。
- 没有在线节点也没有缓存时整块隐藏。

## 4. 社区页（M3，新建 `web/src/pages/community/CommunityPage.vue`，在 `web/src/lib/store.js` 的 `PAGES` 和 `shell/Titlebar.vue` 的 `NAV` 加 `community`，i18n key `nav.community`）

从上到下：
1. 标题「社区」+ 副标题「看看同一网络里的大家在做什么，喜欢就克隆到自己的画布」；右侧搜索框（胶囊，`搜索画布、技能、提示词`）+ 黑色「发布作品」胶囊按钮（先选类型和来源，再进发布弹窗）。
2. **本周精选轮播**：直接复用应用市场 `MarketPage.vue` 的 3D 轮播（`.cf` / `.cf-card` 那套：中间最大、两侧后退倾斜、宽 36.3%、步长 103.6%、自动播放 + 左右箭头 + 圆点）。卡片：封面铺满、底部渐变、类型标签、标题、简介、作者 + 点赞克隆数，右下白色「克隆」胶囊。点卡打开详情。
3. 分类 Tab「发现 / 画布 n / 技能 n / 提示词 n」+ 右侧分段排序「最新 / 最热 / 最多克隆」。
4. 「画布 / 工作流」4 列网格：4:5 竖版封面、悬停上浮 2px + 图片放大 1.03 + 右下出现「克隆」；作者离线的卡灰度半透明 + 右上「作者离线」。
5. 「技能」3 列卡：上方封面条 + 压在下沿的图标块，名称、说明、作者、右对齐「克隆 n」。
6. 「提示词」3 列卡：左侧 84×112 效果图，右侧标签「提示词」、标题、两行正文、作者、右对齐「克隆 n」。
7. 每个分区右上「查看全部 >」切到对应 Tab。空状态：一行标题 + 一行说明 + 一个主按钮，不要插画。

## 5. 作品详情弹窗（M3）

非全屏弹窗（宽 ~1120、高 ~720），左边只读预览，右边 400 宽信息栏：
- 画布：复用首页模板预览的只读画布（`TemplatePreview.vue` 那套），可拖动缩放，左上「只读预览 · 可拖动缩放」，左下缩放控件；技能 / 提示词显示正文。
- 右栏：`CANVAS · V3` 等宽小字、关闭；标题；作者头像 + 名字 + 在线点 + 「在线 · 3 天前发布」；简介；标签；信息块（节点 / 媒体 / 模型 AUTO / 发布包大小）；点赞 / 克隆 / 浏览数；说明「克隆后成为你自己的画布，图片和视频会复制到本机……模型按你的 API 设置自动选择」；底部右对齐：点赞、收藏、更多（举报 / 屏蔽作者）图标按钮 + 黑色大按钮「克隆到我的画布」。
- 点作者头像 → 打开对方主页（第 8 节，只读）。

## 6. 画布里的发布入口（M2，`novai-canvas-ui/src/canvas/canvas-next/ui/ShareSheet.tsx`）

- `ShareMenuBody` 的「分享链接」「打开分享链接」下面空一点，加第三项「发布到社区」：图标 `users`，说明「局域网里的人能在社区看到，并克隆这张画布」，右侧 `>`；点击打开发布弹窗。
- 已发布：这一项变成「已发布到社区」+ 绿色小版本角标 `V3`；`has_changes` 为真时说明改为「画布有新改动，可以更新到社区」，右侧黑色「更新」小按钮（圆角 5px，文字上下左右居中）。点这一项进入管理子面板：返回箭头 + 「已发布到社区」；封面 + 标题 + 「画布 · v3 · 3 天前发布」；点赞 / 克隆 / 浏览；改动提示「发布后画布又改了 N 个节点。更新后社区里显示 v4，已经克隆走的副本不受影响。」；菜单「编辑标题、封面和简介」「在社区查看」「从社区下架」；右下「更新到社区」。
- 状态读 `GET /api/community/mine?source_id=<canvasId>`。

## 7. 发布弹窗（M2）

宽 720 磨砂弹窗：标题「发布到社区」+ 关闭；来源条（缩略图 + 画布名 + 「画布 · 12 个节点 · 38 张生成结果」）；封面选择（画布里的生成图前 4 张 + 本地上传，选中用 1.5px 墨色描边 + 2px 间距 + 右下对勾——这是唯一允许的选中描边）；标题；简介；分类下拉 + 标签（可增删）；开关组「允许克隆」「包含生成结果（约 18.4 MB）」；底部提示「局域网可见已开启 · ……API Key 和本机路径不会被发布」（未开启时这里改为开关 + 说明）；右下「取消」「发布」。技能管理、提示词库各加一个「发布到社区」入口，进同一个弹窗。

## 8. 「我的」页改为个人主页（M4，重写 `web/src/pages/me/MePage.vue`）

- 顶部通栏背景图（高 250，铺满窗口宽），右下磨砂深色胶囊「更换背景」→ 菜单：上传图片（建议 2400×500）/ 从素材库选择 / 调整位置 / 恢复默认。默认背景用一张中性灰的图。
- 内容区 1240 宽：112px 圆头像压在背景下沿（白色 4px 外圈）；右侧「分享主页」「编辑资料」（黑色）胶囊按钮。
- 昵称（22px）+ 「好友码 NOVAI-xxxxxx · 局域网身份」。
- 统计一行：作品 / 获赞 / 被克隆 / 浏览 / **好友**（好友带下拉箭头，点开好友浮层：标题「好友 n」+「添加好友」；每行头像 + 在线点、名字、「在线 · n 件作品」或「离线 · x 前在线」、「主页」「消息」（未读数角标）；底部「我的好友码 + 复制」。数据沿用 `/api/lan/friends` 等现有接口，原来的好友 / 聊天能力都要保留）。
- 分隔后：大号 Tab「发布 / 点赞 / 收藏 / 克隆」（带数量）+ 右侧「最新」「全部类型」「全部状态」三个磨砂下拉、作品名搜索框、黑色「+ 发布作品」。
- 作品网格 4 列，4:5 封面：左上类型标签、左下状态角标（已发布 / 已下架 / 红色「举报 n」）、右上「更多」（编辑 / 下架 / 删除）；已下架的封面灰度半透明。
- 原来的资料 / 账户内容并入「编辑资料」弹窗。
- 别人看你的主页：同一页面的只读模式（无编辑 / 更换背景 / 下架），数据走 `/api/community/public/profile`。

## 9. 测试与验收报告

- 新增 `tests/test_community_store.py`、`tests/test_community_routes.py`、`tests/test_community_clone.py`（照 `test_canvas_share_store.py` / `test_lan_account_store.py` 的写法）：覆盖发布 / 编辑 / 重新发布版本号 / 下架 / 删除、可见开关关闭时公开接口 404、`allow_clone=false` 403、路径穿越被拒、事件去重、技能克隆后 `enabled=false`、内置技能 id 不能被覆盖、包超限报错。
- **双节点实测**：起 A（3931）和 B（3932）两个后端（独立数据目录，`NOVAI_SHARE_PAGE_URL` 等按需设），A 发布 1 张画布 + 1 个技能 + 1 条提示词，B 在社区看到 → 打开详情 → 点赞 → 克隆三种 → 检查 B 本机新画布媒体都已本地化、技能为停用、提示词进了「社区」分组 → A 的统计数变化 → 关掉 A 后 B 的卡变灰但缓存过的仍能克隆 → A 关闭可见开关后 B 拉不到。
- 截图（浅色 + 深色各一套，1440×900 和 1100×800 两个窗口宽）：首页社区精选、社区页（轮播第 1、2 张）、详情弹窗、画布分享菜单（未发布 / 已发布有改动 / 管理面板）、发布弹窗、我的主页（含背景菜单展开、好友浮层展开）。放 `_verification-community/`。
- `node tests/run-all.js` 和 `pytest tests/test_community_*.py tests/test_canvas_share_*.py tests/test_lan_*.py` 全绿，`known-failures.json` 不许新增条目。
- 最后写 `_verification-community/REPORT.md`：每一节做了什么、改了哪些文件、测试结果原文、截图清单、与本指令不一致的地方及原因、遗留问题。
