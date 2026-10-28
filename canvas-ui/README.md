# canvas-ui · 画布助手微应用

NOVAI 智能画布的「画布助手」面板，用 React + Tailwind v4 + @xyflow/react 写成一个独立微应用，
构建成库模式产物挂进 `static/smart-canvas.html`。旧面板完整保留，用 localStorage 切换。

## 构建

```bash
cd canvas-ui
npm install
npm run build
```

产物（提交进仓库，桌面包不跑 Node）：

- `static/canvas-assistant/assistant-ui.js`（IIFE，暴露 `window.NovaiCanvasAssistant`）
- `static/canvas-assistant/assistant-ui.css`

当前产物：JS 约 419KB / gzip 133KB，CSS 约 63KB / gzip 12KB。

## 挂载与切换

```
localStorage.NOVAI_CANVAS_UI = 'legacy'   // 旧面板
其它值 / 不设置                          // 新面板（默认）
```

页面只加了一个 `<script defer src="/static/js/canvas-assistant-bridge.js">`。桥接层负责：

1. 把 `#novaiCanvasAssistantRoot` 挂进 `#chatModal`，隐藏旧的 `.chat-messages` / `.chat-composer`（旧 DOM 保留、照常驱动）；
2. 拦截 `window.fetch`，把 `/api/agent/run` 与续传流的 SSE 分一路给微应用（旧面板消费另一路）；
3. 镜像旧 DOM 的引用 chip / 技能 chip / 运行态 / 上下文占用；
4. 动作全部落回现有实现：`window.sendChatMessage` / `window.abortAgentRun` / 旧方案卡按钮 / 旧技能选择器。

## 三个面板能力（与旧面板对齐）

1. **产物侧栏**：顶栏左侧按钮或「更多 → 产物」在助手左侧展开独立文件侧栏。`GET /api/agent/canvases/{id}/artifacts`，
   按 kind 分组（HTML / Excel / CSV / 文档 / 图片），行内文件名、大小、相对时间、新标签下载；
   含骨架、失败重试、空态、truncated 提示；收到 `artifact_updated`（或本轮结束）自动刷新角标与面板。
2. **run 上下文调试**：运行卡底部「上下文」按钮（消息没有 run_id 时不显示）。`GET /api/agent/runs/{id}/model-context`，
   展示模型、估算 tokens、占比条（context_max 为 null 显示「未设置上下文上限」）、系统提示字数、
   分段 chips、工具数（展开上限 60）、历史/指令字数与口径说明；404 显示「这轮已过期，无法查看上下文」。
3. **线程重命名 / 删除**：顶部线程切换器，每行 hover 出「⋯」，行内展开「重命名 / 删除」。
   重命名就地输入（Enter 保存、Esc 取消）；删除二次确认；只剩一条时删除按钮 disabled 并提示
   「至少保留一条对话」。切换线程会同步旧面板的 active_id，保证下一轮消息落在正确的线程上。

这三块的状态都在 `src/assistant/api.ts` 里直接走相对 `/api/...`；不经过桥接层转发。线程标题显示当前对话，列表显示相对时间；回复可分支、好评/差评，反馈通过 `POST /api/agent/threads/feedback` 持久化。

## 执行过程与节点定位

- `vision` 事件与工具完成状态汇总为「看了 N 张图 / 读了 N 个文档 / 提交了 N 个生成 / 完成了 N 个操作」，完成后详细工具记录默认收起。
- 方案卡优先显示自然语言 description；参数与输出 JSON 收进工具详情的二级展开。
- 工具参数和结果里的节点 ID / 编号会形成引用 chips，点击经 `window.focusSmartNode()` 真正选中并居中节点。
- `run_start` 会复用先前的 vision-only 消息，避免「先看图再开始运行」产生重复运行卡。

## 微应用契约

```js
window.NovaiCanvasAssistant.mount(el, api) -> {
  pushEvent({ id, type, data }),      // SSE 事件
  setHistory(messages), setRefs(refs), setSkills(skills),
  setSelectedSkill(id), setRunning(bool), setPlanConfirm(bool),
  setContextUsage(usage), setArtifacts(items), notifySteer(text, status),
  notifySystem(text, kind), notifyRunSummary(text), clearHistory(), destroy()
}
```

`api`（宿主实现）：`send / abort / steer / selectSkill / clearSkill / removeRef / clearRefs /
planAction / confirmAction / togglePlanConfirm / openHistory / openNode / toast`。

## 目录

- `src/ai-elements/`：从 ai-elements 复制的组件（canvas/node/toolbar/panel/controls、
  conversation/message/tool/confirmation/artifact/prompt-input/reasoning/task/queue/context/plan），
  仅替换了重依赖：streamdown→`markdown.tsx`、motion→CSS shimmer、tokenlens→去掉成本估算、code-block→轻量版。
- `src/ui/`：按需拷来的 shadcn / Base UI 基础件。
- `src/assistant/`：NOVAI 会话模型（session/store/format）与面板组合（AssistantApp/Composer）、技能菜单、产物侧栏和录屏。
- `src/styles/index.css`：NOVAI Glass v2 令牌映射（浅色/深色），不画边框发丝线。

## 设计约束

颜色/圆角/间距全部映射到画布页令牌（`--panel/--surface/--text/--accent/--radius-*/--shadow-*`），
浅色深色跟随 `html.theme-dark`；容器一律用填充 + 柔影 + 间距表达层级。

## 应用市场 brief 自动发送

`window.NovaiCanvasAssistantBridge.seedAutoSend({ text, skillRef }) -> Promise<boolean>`

- 微应用就绪：把 text 填进 Composer、设置技能、走官方 `sendChatMessage` 通路发送一次，resolve(true)。
- 3 秒内起不来：resolve(false)，并在页面 toast + 之后挂载时补一条系统消息（不静默）。
- 发送失败：resolve(false)，微应用里出现可见系统消息，提示词留在输入框。
- `skillRef="store:<id>"`（应用市场技能）不在能力列表里，桥接层会在下一次 `/api/agent/run` 请求体注入 `skill_ref`。
- 打开画布时的种子（`novai_canvas_seed:<canvasId>`，`autoSend:true`）由桥接层接管：先抓内存副本，再把落盘种子的 agent/autoSend 摘掉，避免旧面板重复发送；节点等字段保持不动。

## Composer 三件套（对齐旧面板）

- **＋ 添加**：引用当前画布选中的节点（Cmd/框选多选点一次即可补齐），或上传图片/视频素材；两者都进「本轮引用」chips，随消息写入 `focus.references` / `focus.reference_images`。
- **技能与应用**：技能二级菜单从 `/api/skills` 读取完整列表，支持搜索、SKILL.md 文件/文件夹导入（`/api/skills/import`）、创建需求和管理入口；重名技能不会被静默覆盖。
- **真实录屏**：Electron 通过 `desktopCapturer` 提供屏幕/窗口来源，主进程用 `setDisplayMediaRequestHandler` 一次性授权已选来源，Renderer 用 `MediaRecorder` 录制；停止后经 `/api/local-assets/upload` 保存为本地视频引用，不依赖 ComfyUI 或外部云存储。取消或卸载时停止所有媒体轨道。浏览器走 `getDisplayMedia`，不支持时不显示录屏入口。
- **本地目录权限**：File System Access 句柄只存浏览器 IndexedDB；「更多 → 本地文件权限」可更换目录或移除授权，不把目录句柄发给后端。
- **模型 / 生图平台**：对话模型来自 `/api/config` 的 `chat_models`（按平台分组），默认取旧面板当前选择；切换会同步旧面板的 `#chatModelSelect`，请求体 `provider/model` 真实变化。生图平台为空 = 自动跟随模型，对应 `image_provider`。
- **自动 / 手动确认**：两段式开关，写 `smart_agent_plan_confirm`；自动 → `mode:"run"`（只读/聊天直接跑，写操作服务端仍先出方案），手动确认 → `mode:"plan"`。
- Enter 发送 / Shift+Enter 换行 / 空文本禁用发送 / 运行中按钮变停止。

## TapNow 1:1 面板（docs/v2/TAPNOW_PANEL_SPEC.md）

- 贴边全高抽屉：440 宽、#141414、圆角 16 0 0 16、无边框无投影、左缘 4px col-resize 手柄（可拖宽）。
- 顶部栏 60：40×40 产物侧栏开关 + 当前线程标题下拉（切换/重命名/删除/新建，显示相对时间）+ 右侧 36×36 新对话 / 全屏 / 更多；产物在助手左侧独立展开。
- 空态：24px/300「Hi {用户名}!」+ 28px/400 标题 + 412×124 建议卡（#1a1a1a、1px 白 5% 边框、16/36/16/12、14/500 标题、12/400 45% 描述、17 箭头）+ 16×16「换一批」；点卡片只填输入框不发。
- 输入区：424 宽、#1a1a1a、16 圆角、0.5px 白 10% 边框、0 5px 10px 6% 阴影；输入 391×48 / 14px / placeholder 随心输入；底部 添加32 / 已选目录36×28 / 手动生成26 / 截图28 / 截屏16×28；右侧 上下文24×32 / Auto26 / 语音32 / 发送32 圆形。
- 浅色：#fafafa 面板、#f5f5f5 卡片、rgba(0,0,0,.06) 描边。
