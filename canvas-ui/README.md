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

- `src/components/ai-elements/`：从 ai-elements 复制的组件（canvas/node/toolbar/panel/controls、
  conversation/message/tool/confirmation/artifact/prompt-input/reasoning/task/queue/context/plan），
  仅替换了重依赖：streamdown→`markdown.tsx`、motion→CSS shimmer、tokenlens→去掉成本估算、code-block→轻量版。
- `src/components/ui/`：按需拷来的 shadcn / Base UI 基础件。
- `src/assistant/`：NOVAI 会话模型（session/store/format）与面板组合（AssistantApp/Composer）。
- `src/styles/index.css`：NOVAI Glass v2 令牌映射（浅色/深色），不画边框发丝线。

## 设计约束

颜色/圆角/间距全部映射到画布页令牌（`--panel/--surface/--text/--accent/--radius-*/--shadow-*`），
浅色深色跟随 `html.theme-dark`；容器一律用填充 + 柔影 + 间距表达层级。
