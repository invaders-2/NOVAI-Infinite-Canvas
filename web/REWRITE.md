# NOVAI 2.0 前端重写 · 进度与约定

效果图（设计依据）：claude.ai 上的「NOVAI 2.0 界面」画布（11 页、72 张），设计 tokens 在 src/styles/ds.css。

## 进度
| 页面 | 状态 |
|---|---|
| 外壳（侧栏 / 标题栏 / 设置弹窗：通用·备份·外观·关于 / 更新 / 欢迎） | ✅ Vue；侧栏与外壳布局按用户要求还原旧版样式（72px 圆角浮卡、悬停展开 220px、舞台 20px 圆角）（第 20 轮） |
| 首页 | ↩︎ 按用户要求继续用原先的 home.html（iframe）；Vue 版 pages/home 保留未挂载 |
| 画布列表（含新建选择器、回收站、撤销删除） | ✅ Vue（第 19 轮） |
| 智能画布 / 经典画布编辑器 | ✅ 用户确认「保留引擎，统一外观」：结构与交互不动，`static/css/nv2-skin.css` 统一配色 token、状态色（只留 danger 一种彩色）、字重 400/500、底色与外壳一致（第 23 轮） |
| 在线生图 / Z-Image | ✅ Vue（第 22 轮，pages/online/） |
| GPT 对话 | ✅ Vue（第 22 轮，pages/chat/） |
| 素材库 | ✅ Vue（第 22 轮，pages/assets/） |
| 设置：API 设置 / 工作流设置 | ✅ Vue（第 20 轮，shell/settings/ApiSettingsPanel.vue + api/、WorkflowSettingsPanel.vue + workflow/） |

## 遗留功能处理（用户 2026-10-01 确认「按建议分」）
保留并补入口：
- 经典画布：Midjourney、多维表格加进快捷工具条和双击创建菜单
- 大图预览：左右切换、缩放预览加按钮（不只快捷键）
- GPT 对话：对话 / Agent / 图像 模式切换按钮
- 素材库：「移动到…」下拉（moveSelectedAssets）
- 设置：更新回滚按钮（rollbackProjectUpdate）、「设为首选平台」
重写时删除（不再实现）：
- Loop 循环节点（旧存档仍需能渲染/不报错）、提示词预设面板、工具条精简态、预览弹窗旧编辑工具行与弹窗拼接台、媒体浏览器/临时抽屉/图片模式切换文案
- 经典画布 selectionHub + Prompts 节点、GPT 旧空状态、素材库共享文件夹整套、旧 canvas-list.js
- 旧推荐 API 弹窗、RunningHub 编辑器节点列表死代码、设置详情页头
- 历史「删除所有」改为只删勾选项（或加二次确认）
顺手修：batchRowStatusText 未定义、smart.hintMulti 缺 i18n、聊天 Markdown 表格、Z-Image 英文残留

## 视觉约定（用户确认）
- 右侧内容区不要底框背景：`.stage` 透明，直接落在外壳底色（#f5f5f7 / #0c0c0c）上。
- 子菜单（所有下拉 / 弹出菜单）统一磨砂玻璃：面板色 78% + blur(44px) saturate(190%)，无描边（ds.css 末尾「子菜单统一」段；非 .nv-menu 的弹层加 class `nv-glass-pop`）。
- 子菜单动效沿用旧版：打开/关闭 opacity + 4px 位移 .14s ease；悬停高亮用 NovaGlide 滑块（`lib/novaGlide.js` 移植自 static/js/shared/glide.js，`lib/menus.js` 自动给 `.nv-menu` 和 `[data-glide="选项选择器"]` 挂上）。新写的菜单只要用 `.nv-menu` + `.nv-menu-item`（选中 `is-on`）就自动生效。

## 深浅色
- 组件只用 ds.css tokens；需要单独写深色规则时放在**非 scoped** 的 `<style>` 块里（Vue scoped 下 `:global(html.theme-dark) .x` 会把整条选择器编译成 `html.theme-dark`，规则失效——第 22 轮外壳和侧栏的深色就是因此没生效）。
- 页面切回时外壳派发 `window` 事件 `novai-page-focus`（detail.id）；后端 ws 的 canvas_updated / cloud_status / asset_library_updated 同时 postMessage 给外壳自己的 window。

## 英文界面（第 24 轮）
- 新页面文案直接写中文即可；英文模式由 `src/lib/autoTranslate.js` 运行时翻译（DOM 文本节点 + placeholder/title/aria-label，整句或 `{0}` 模板匹配），词典在 `src/lib/i18n-en.json`（key = 源码里的中文）。
- 新增/修改文案后：`node i18n-extract.cjs /tmp/zh.json` 抽取全部中文文案 → 找出 i18n-en.json 里没有的 → 补译后合并进 i18n-en.json。
- 用户内容不翻译：聊天正文（.md/.bu）、输入框、contenteditable、任何带 `data-no-i18n` 的容器。

## 第 25–27 轮修复记录
- 第 25 轮：Vue 画布列表「新建 / 打开画布」无反应 —— 第 20 轮误删了 LegacyStage 的 frameSrc / visited 两个 watch，已补回。
- 第 26 轮：小窗口下所有 Vue 弹层错位（theme.js 给 body 加了 `transform: scale()`，body 内的 fixed 元素按 body 定位）。新增 `#nv-layer`（挂在 `<html>` 上、不受缩放），所有 `<Teleport>` 一律 `to="#nv-layer"`，**新写弹层也必须 teleport 到这里**；menus.js / autoTranslate.js 改为观察 documentElement。GPT 对话模型选择器加「安全三角」悬停意图判断（斜移进子菜单不切换平台）。
- 第 27 轮：智能画布编辑器左上角平台下拉（向下弹）缺悬停桥，鼠标移进弹层就消失 → smart-canvas.css 补向下的悬停桥；该下拉接上 NovaGlide 滑块（原先只扫 #dynamicParams 漏了它）；smart-canvas.html 的 css/js 版本号已更新。
- 第 28 轮：默认入口切换 —— `/` 返回新前端（static/v2/index.html，未构建时回退旧 index.html），旧外壳移到 `/legacy`，`/v2` 保留；局域网未授权放行列表加上 `/v2`、`/legacy`；设置 → 关于 加「旧版界面」入口。
  全局盒模型：`#app` 与 `#nv-layer` 下统一 `box-sizing: border-box`（修在线生图提示词框、工作流设置文本框右侧溢出）；按旧尺寸补偿了 SetRow（min-height 74px）和对话输入框（min-height 48px），其余页面截图逐张对比无变化。
- 第 29 轮（全面检查后的优化）：
  - 选中 / 聚焦 / 拖入态的 1.5px、0.5px 描边环全部去掉（约 40 处），改为实底 + `var(--shadow-float)`；选中的图片卡靠勾选角标 + `var(--shadow-lift)`；拖入态改为 `--fill-3` 底色。复选框、单选圈、端口、开关圆钮这类「图形」的笔画保留。**新写样式不要再用 `box-shadow: 0 0 0 Npx` 表达状态。**
  - 小于 11px 的文字统一到 11px（工作流 / RH 节点图里的缩略标签除外）。
  - 英文模式接管首页 home.html：`autoTranslate.js` 改为按文档创建翻译器，`translateFrame(iframe)` 由 LegacyStage 在 frame-home 加载后挂上；模板变量也会递归翻译（如「更新于 {0}」+「{0} 小时前」）；`data-tip` 属性也翻译。
- 第 30 轮：输入框聚焦一律「平」——不画环、不加投影、不变白浮起，只把底色加深一档（`background: var(--fill-2); box-shadow: none`）。画布编辑器里约 30 处输入框的 focus 描边环在 `static/css/nv2-skin.css` 末尾统一去掉（键盘 :focus-visible 保留）。
- 第 31 轮：画布编辑器「专业调色」面板重做（见 docs/IMAGE_COLOR_ADJUST_DESIGN.md 第 6 节）：新引擎 image-adjust-engine.js、新面板 image-adjust-editor.js + css/image-adjust.css；结果节点可再次编辑。
- 第 32 轮：抠图。新增 server/matting_refine.py（原图引导修边 + 按局部对比度决定信原图还是信模型 + blur-fusion 前景色去污染 + 去碎块；绿幕改为 YCrCb 色度距离抠、背景色自动取样，生成图与原图对得上时用原图像素）。本地 RMBG-2.0 与「AI 抠图」两条链路都改用它；绿幕转透明失败不再静默返回绿底图。模型下载改为 .part 断点续传、8 次指数退避重试、大小 + SHA256 校验、速度/剩余时间、可取消（POST /api/matting/model/cancel）；推理组件缺失/模型损坏时报真实原因，不再误报「未下载」。前端下载弹窗改为磨砂无描边样式。
- 第 33 轮：画布助手 P0（「全部由助手操作画布」的地基，见报告《NOVAI 画布助手全托管调研》第五章 P0）。改动都在 main.py 的 Agent 段与 static/js/smart-canvas.js：
  - **字段对齐**：助手读写走「节点字段适配层」（`_agent_node_own_prompt / _agent_node_set_prompt / _agent_validate_settings / _agent_apply_settings`）。智能画布图片/视频节点的提示词写 `promptDraftText/promptDraftHtml/promptDraftTouched`，参数写 `runSettings`（比例按前端档位名存，如 16:9→wide）；视频节点 = `smart-image` + `runSettings.apiKind='video'`（不再建前端不认识的 `smart-video`）。经典画布仍走原实现（`*_classic`）。
  - **自动连线**：`create_node` 支持 `inputs`（建节点同时连上游，默认落在上游右侧且不重叠）；`connect_nodes` 校验类型/方向/成环并维护 `inputNodeIds`；新增 `disconnect_nodes`。`generate_image/video` 建「提示词节点 → 生成节点」，参考图以上游素材节点接入，不再塞进结果节点的 images。
  - **生成口径与用户点「运行」一致**（`_agent_start_node_generation`）：提示词 = 上游提示词节点 + 节点自身提示词；参考 = 节点自身已有的图 + 上游产物（尊重屏蔽）；节点已有结果时右侧新开结果节点。任务先登记到节点 `pendingTasks` 再入队，前端据此显示进度并自行收尾。
  - **写回**：任务结束后 `_agent_writeback_task_result` 加画布锁、只认登记过该任务的节点、结果追加去重不覆盖、失败写 `lastTaskStatus/lastTaskError`，写完广播。
  - **费用护栏**：用户批准的方案就是本次生成次数上限，后续轮次超出即 `confirm_required` 停下；停止/断开时取消本次运行还在排队的任务。
  - **逐步改动按字段下发**：`canvas_ops.nodes_patch`（已有节点只发改了的字段）；前端用户正在编辑栏打字时不覆盖提示词（会提示），编辑栏开着的节点自动刷新。
  - **三方合并**：前端记录「上次与服务器对齐时」的节点/连线基线（`setSmartServerBase`），合并时服务器没动过的节点保留本地修改、服务器删掉的不再复活、本地删掉的不再被拉回；助手删除/撤销会写 `canvas.deleted_node_ids` 墓碑。
  - **撤销一次运行**：运行期间记逆操作日志（`session.undo_log`），`POST /api/agent/undo {session_id}` 只撤助手改的部分并取消未完成任务；运行中各工具不再逐步存版本快照，只在运行前后各存一次。对话卡片上的「撤销本次」按钮待出界面预览后再加。
  - 测试：tests/test_agent_canvas_p0.py（17 项）；端到端用隔离服务 + 脚本化假模型跑过 22 项（改提示词实时可见、打字保护、一句话出图自动连线、预算拦截、撤销不复活且保留用户本地修改）。`window.__smartAgentTestHooks` 是端到端测试用的窥视口。
- 第 34 轮：画布助手的三块新界面接上功能（预览经用户确认；样式在 static/css/smart-canvas.css 末尾「画布助手：撤销本次 / 确认卡 / 提示词对比卡」段，黑白灰、线性图标、无描边）。
  - **撤销本次**：done 事件带 `session_id / undoable / changes`（新建/修改/删除节点数、连线数、生成次数），对话里出现改动摘要 + 「撤销本次」，点击调 `POST /api/agent/undo`，按钮变「已撤销」。
  - **确认卡**：`confirm_required` 带 `confirm_kind`（delete / budget）。同一次运行里的同类步骤合成一张卡；「删除 / 继续生成」把这几步作为 approved_steps 单独跑一次（第 1 轮用户已批准的删除不再拦，删除自动带 force），「保留 / 不用了」只记一句结果。
  - **对话改提示词（P1-8）**：新工具 `refine_prompt`——助手写 1–3 个改写候选，系统按字/词算差异、检查用户要求保留的片段、按目标模型给写法提醒（Veo 只认英文等），**只出候选不写入**；不花钱的改写在方案模式下也直接出对比卡，不先出方案。对比卡「用这个」调 `POST /api/agent/apply-prompt` 写进节点并记 `promptHistory`（最近 20 版），update_node 改提示词也会记历史。
  - 测试：tests/test_agent_canvas_p0.py 增至 25 项；端到端三套（撤销、超额确认、删除确认、对比卡翻页/写入/历史）全部通过。
- 第 35 轮：画布助手 P1 后端——节点编号 + 对话按画布持久保存（画布上显示编号的样式待用户确认预览后再加）。
  - **节点编号**：每个节点一个固定短编号（图N / 视频N / 提示词N / 文本N / 组N），按种类各自递增、删除不回收（`canvas.alias_counters`）。服务器在保存画布（PUT）和助手改画布时统一分配（`_agent_ensure_aliases`；前端没带回的从旧画布沿用），前端保存成功后从回包沿用（`adoptServerNodeAliases`）。空节点改了种类（图片→视频）会换成对应编号，已有产物的不改。
  - 助手摘要、选中节点说明都带编号；工具参数 node_id / from / to / inputs 可以直接写编号（`_agent_resolve_aliases_in_args`）；确认卡、对比卡用编号称呼节点；系统提示词第 15 条要求回复用户时用编号。
  - **对话持久化**：`data/agent_threads/{canvas_id}.json` 存用户原话、助手最终回复和本轮动作清单，以及「最近改动的节点」（新→旧，最多 12 个）。`GET /api/agent/thread/{canvas_id}` 取、`DELETE` 清（「新对话」按钮会调）。打开助手面板时把以前的对话接回来；前端没带历史时服务器用持久化记录；系统提示词附「最近改动的节点」，「刚才那张」据此对上。只在真实接口里启用（`req.use_thread`），直接调循环的单测不读写它。
  - 测试：tests/test_agent_canvas_p0.py 增至 29 项；端到端新增 e2e4（用编号改节点、刷新后对话还在、「刚才那张」指对、新对话清记录），前三套回归全部通过。
- 第 36 轮：画布上显示节点编号（预览经用户确认）。卡片外左上角、和外侧文件名同一行，11px 黑白灰、无底无描边；有编号时文件名往右让开（根节点 `has-alias` + `--alias-w`）；选中时更清楚，拖动时隐藏；标签节点不显示。两条渲染路径都加了（`nodeAliasHtml / nodeAliasStyle`）。四套端到端（50 项）回归通过。
- 第 37 轮：画布助手看图（P1）。选中节点的图（用编号标注）+ 用户附带的参考图，最多 4 张、本地图缩到 1024px 转 data URL：
  - 对话模型看得了图（按模型名判断：gpt-4o/4.1/5、claude、gemini、*-vl、glm-4v、doubao-seed 等）→ 每轮把图作为图片消息直接给模型；发图报错的模型记下来（本进程内）改走下一条。
  - 看不了图 → 在已配置的平台里找一个看图模型，把每张图转成 2–3 句文字说明（按文件缓存在 `data/agent_image_captions.json`），写进系统提示并注明「只能据此理解，别假装看过」；一个看图模型都没有就如实说明。
  - 运行卡里写一句「已把图1直接给模型看 / 已用「X」把图1转成文字说明 / 看不了图」（SSE `vision` 事件），纯问答时这句跟着回复气泡显示。对话输入框上的选中标签也改用编号（@图1 能被工具认出）。
  - 测试：tests/test_agent_canvas_p0.py 增至 34 项；端到端新增 e2e5（文本模型→转文字并说明；看图模型→直接看图），五套共 55 项通过。


## 第 38 轮：选平台只列该平台模型；方案卡说人话；多维表格批量生成（2026-10-08）
- 选平台后模型只列这个平台的：聊天面板（选了生图平台，对话模型下拉只留该平台；「自动」列全部）和方案卡「调整参数」里的平台/模型联动。
- 方案卡改版（.agent-plan2）：标题是一句话目标；每步一句人话（编号胶囊指代节点），不出工具名/参数名/节点 ID；表格步骤预览前 3 行；代价一行写清「会用掉 N 次生成 · 新增 N 个节点」；模型/比例收在「调整参数」；按钮「取消 / 换个说法 / 开始生成」。执行过程的步骤行同样用人话。
- 多维表格 / 批量：新工具 batch_generate（一步建「统一要求提示词 → 多维表格 → 批量生成」并开跑）、run_batch（跑已有批量节点）；create_node 支持 type=table/batch；update_node 支持 rows / append_rows、批量节点 settings。连线规则：参考图/组/提示词/文本 → 表格，表格 → 批量。编号：表格N、批量N。
- 逐行出图由页面执行：步骤结果带 client_action{type:run_batch}，这一轮结束、画布合并后页面调 runTableBatch（与用户点「运行」一致）。预算按行数计。
- 系统提示词 16/17：用户点名的节点类型必须照用（说表格/批量/N 个版本 → batch_generate，不拆成点对点）；description 写给不懂技术的人看。
- 测试：后端 81 个通过；E2E（假模型）12/12：平台筛模型、方案卡无工具名且写清代价、表格 3 行 → 批量已连线、统一要求接在表格前、页面逐行出 3 张、无点对点出图、无脚本错误。
- 备份：_claude_backup/20261008-round38-before


## 第 39 轮：API 设置关闭按钮；生成后检查（P2-1）（2026-10-09）
- API 设置：页头吸顶层（z-index 30）压住了右上角关闭按钮的左半边 → 关闭按钮层级提到 50（SettingsModal.vue），已重新构建 static/v2。
- 生成后检查：助手这一轮的生成都结束后（批量跑完也算），用能看图的模型对照用户原话逐张看，只指出明显问题并给修正后的提示词（POST /api/agent/review）。
  - 优先用当前对话模型（能看图时），否则在已配置平台里找能看图的模型；都没有就在对话里说明这次没检查。
  - 只给结论和建议步骤，不自己执行；「按建议重做」走正常的批准执行，受生成次数约束。单张：改真正驱动它的提示词（节点自己没写就改唯一的上游提示词节点）→ run_generation，原图保留。批量：只改出问题的行 → run_batch(row_numbers) 只勾选这几行重跑。
  - 开关「生成后检查 · 开/关」（localStorage smart_agent_review，默认开），放在「每次先给方案」旁边。
- run_batch 新增 row_numbers；表格多列时不替用户猜改哪一列，只给结论。
- 合并说明：本轮补丁是在 Mac 上最新的 main.py / smart-canvas.js（含供应商注册表、素材模式修正）上重新打的。
- 测试：后端 agent 测试 4 个文件全部通过（新增 6 个）；E2E（假模型）11/11：开关、自动出检查卡、问题与建议、代价、按建议改提示词、重做新开结果节点、批量指出第 2 行、只改第 2 行、只勾选第 2 行、只多出 1 张、无脚本错误。另用真实看图模型跑过一次，能看出「画面只是一块橙色」这类问题。
- 备份：_claude_backup/20261008-round39-before（设置弹窗）、_claude_backup/20261009-round39b-before


## 第 40 轮：流程模板（P2-2）（2026-10-09）
- 模板 = 资产库「工作流」分类里的条目，和画布「工作流 → 导出到资产库」同一种文件（workflow.json / zip 带资源），手动存的和助手存的互通。
- 新工具：list_templates（只读，不出方案卡，直接回答）、save_template（选中节点 + 之间的连线 + 参数存进资产库；生成节点不带上次结果，参考图打包；同名不覆盖，除非 overwrite）、apply_template（在画布右边空处一次搭出整套节点；inputs 替换模板里空着的素材位；prompt 写进模板第一个提示词节点，没有就写进最前面的出图节点；settings 改所有生成节点；默认接着运行最前面那一层生成节点，后面依赖结果的节点等结果出来再跑）。
- 方案卡人话：「把 提示词1 图1 存成模板「电商主图」」「按模板「电商主图」搭出整套节点…」；代价按真实生成次数和新增节点数算。多任务的步骤（apply_template）前端逐个跟进度。
- 系统提示词 18：存模板 / 问模板 / 用模板分别用对应工具，不要自己照着一个个建节点。
- 测试：后端 agent 测试 4 个文件全部通过（新增 5 个）；E2E（假模型）9/9：存模板方案卡、资产库里有模板、问模板直接回答、用模板方案卡、搭出 2 个节点并连线、提示词替换、接着出图、新节点有编号、无脚本错误。
- 备份：_claude_backup/20261009-round40-before


## 第 41 轮：原生工具调用（P2-3）（2026-10-09）
- 对话平台协议是 openai / volcengine 时，助手每轮请求带上 tools（由 AGENT_TOOLS 自动生成，每个工具多一个可选 description，canvas_id 由系统补），模型返回 tool_calls 直接变成步骤；只写文字就是给用户的回复；正文里写 JSON 也照样认。
- 原生模式下系统提示词不再塞整份工具 JSON（改为「见函数调用列表」），每轮少几千 token。
- 平台不认 tools（带 tools 报错、去掉就能通）时，用原来的 JSON 方式再问一次并记住这个 provider:model，之后直接走 JSON；别的错误照常重试，不误判。
- 开关：环境变量 NOVAI_AGENT_NATIVE_TOOLS=0 整体关掉。方案卡、执行、预算、撤销等上层流程不变。
- 测试：后端 agent 测试 4 个文件全部通过（新增 6 个，覆盖 tool_calls 转步骤、补 canvas_id、纯文字回复、JSON 兜底、平台拒绝后退回并记住、开关）；E2E 回归（假模型改为原生 tool_calls 回复）：批量 12/12、生成后检查 11/11、流程模板 9/9，全程 14 次原生调用，无一次退回。
- 备份：_claude_backup/20261009-round41-before


## 第 42 轮：项目记忆（P2-4）（2026-10-09）
- 两层记忆：这张画布（data/agent_memory/{canvas_id}.json）、所有画布（data/agent_memory/_global.json），每层最多 60 条，每条最长 300 字。
- 新工具 remember / forget（不改画布、不花钱，直接执行，不出方案卡）。只在用户明确说「记住 / 以后都 / 默认 / 每次都」时记，平常的话不偷偷记；一次性要求不记成长期偏好（系统提示词 19）。
- 每轮对话把记忆放进上下文（这张画布 + 所有画布），做方案默认照做；用户这次另有说法以这次为准，回复里说明按哪条来的。
- 接口：GET /api/agent/memory/{canvas_id}、POST /api/agent/memory、PUT/DELETE /api/agent/memory/{id}。
- 界面：画布助手标题栏新增图钉按钮 → 记忆面板（沿用历史记录面板样子，磨砂背景）；「这张画布 / 所有画布」切换，点文字直接改、× 删除、底部手动加。对话里记住时一行「已记住（这张画布）：… · 撤回」。
- 顺带：上一轮检查卡里图标库没有的 eye-off / message-circle 换成 eye / sparkles。
- 测试：后端 agent 测试 4 个文件全部通过（新增 5 个）；E2E（假模型）11/11（按钮、记住提示与撤回、不出方案卡、面板列出、手动加、两层同列、直接改、下一轮带上记忆、删除、撤回、无脚本错误），生成后检查回归 11/11。
- 备份：_claude_backup/20261009-round42-before


## 第 43 轮：串起来的流程整条跑完（2026-10-09）
- 新工具 run_downstream：把某个节点后面（顺着 input 连线往下）还没出结果的图片/视频节点按顺序跑完。上游已有结果的马上跑；其余登记成「待跑链条」（data/agent_chains.json，6 小时过期），前面出完结果后由服务端自动接着跑——页面关了也会接着跑。
- 触发点：助手任务结果写回后（_agent_writeback_and_broadcast）；页面先收下结果再保存画布时（update_canvas）也会检查一次，两条路都能推进。
- 只跑还没有结果的节点；上游没生成成功或素材位是空的，后面依赖它的不跑，并在节点上写明「没有接着跑：上游 xx 没生成成功」。
- 流程模板（apply_template）改为整套跑完：第一层马上跑，后面的自动接着跑；方案卡代价按整套生成次数算。用户不再需要说「继续跑」。
- 系统提示词 20：「继续跑 / 把后面的也跑了 / 整条跑完」用 run_downstream，不要对后面节点逐个 run_generation。
- 测试：后端 agent 测试 4 个文件全部通过（新增 5 个：第一波 + 写回后接着跑、上游已有结果马上跑、整条计数、上游失败停下并说明、没什么可跑）；E2E（假模型）5/5：方案卡写清「会用掉 2 次生成」、图1 出图、图3 在图1 出图后约 1 秒自动接着出图、服务端有记录、无脚本错误；流程模板回归 9/9。
- 备份：_claude_backup/20261009-round43-before


## 第 44 轮：一键整理（2026-10-09）
- 新工具 arrange_canvas（只挪位置、不改内容、不花钱，不出方案卡）：服务端只校验并下发 client_action{type:arrange}，由页面用节点真实大小排版。node_ids 不填=整张画布；填了就整理这些节点所在的整串。
- 页面 agentArrangeCanvas：按连线把每一串流程分层从左到右排成一行（复用「整理选中节点」的 arrangeSmartIdsByConnections），一串一串自上而下摞，串间距 140；散节点最后按行排开；分组整组挪动不拆开。整理前位置全部记下，对话里「已整理 N 个节点 · 撤销」一键回到原位（也可 Ctrl+Z）。
- 系统提示词 21：「整理一下 / 太乱了 / 排整齐」用 arrange_canvas；没说就不擅自整理别人的布局。
- 测试：后端 agent 测试 4 个文件全部通过（新增 3 个）；E2E（假模型）8/8：不出方案卡、第一串同一行且从左到右、第二串在下、散节点在最下一行、对话写明个数可撤销、整理后已保存、一键撤销回原位、无脚本错误。
- 备份：_claude_backup/20261009-round44-before

### 第 45 轮：真实模型把方案写成 JSON 文字时认不出（2026-10-09）
- 现象：某平台 gemini-3.1-pro-preview 不走 tool_calls，把方案写在正文 ```json 里，且平台拼接分片时在字符串中间插入真实换行（「提取图\n89」），json.loads 报错 → 整段 JSON 当回复显示，节点没建。
- 修复：`_agent_json_loads` 容错解析（字符串里的真实换行一定是拼接带进来的，去掉后再解析；转义的 \n 不受影响），方案解析、单轮解析、tool_calls 参数、AI 规划都改用它；正文里的方案补上 canvas_id。
- 明显是方案（含 "steps" + "tool" 或以 ```json 开头）却仍解析不了时，不再当回复原样显示，改按 JSON 方式重问一次。
- 测试：test_agent_canvas_p0 新增 2 条（用户截图原样内容），4 个 agent 测试文件 113 条全过；真实模型同一句话已能出方案卡。

### 第 46 轮：助手的模型不写死（2026-10-09）
- 原则：生图/生视频模型一律来自 API 设置里各平台配置的模型清单，代码里不写模型名兜底。
- 没选平台（自动）：给助手的清单开头写明「按这次任务挑最合适的平台和模型，provider、model 都写上」；助手没写就按配置顺序第一个有这类模型的平台、它清单里的第一个。
- 界面上选了平台：清单里标【用户选定】，生图只用它的模型；助手写了它没配置的模型 → 换成它清单里的并记原因。生视频时选定平台没有视频模型 → 自动挑有视频模型的平台。
- 模型名哪个平台都没配（助手瞎写）→ 落到所选平台清单里的模型，不再原样下发。
- agent_image_size 不再用 IMAGE_MODEL（gpt-image-2）兜底。
- 新增 `_agent_provider_media_models` / `_agent_fit_media_model`；test_agent_image_size 新增 4 条（AgentModelNotHardcodedTests）。
- 未改：项目原有各平台默认模型清单（即梦/Lovart/RunningHub/ModelScope、画布 DEFAULT_VIDEO_MODELS）、按名字判断对话模型能否看图的规则。
