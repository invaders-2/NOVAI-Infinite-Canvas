#!/usr/bin/env node
/* 执行进度清单（任务清单卡）：plan 步骤 + step 事件对账、面板接线、卡面样式（不真生成）
   跑法：node tests/test_novai_canvas_checklist.js */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const { taskChecklist, taskChecklistHint, taskChecklistTally } = load('novai-canvas-ui/src/canvas/canvas-next/agent/task.ts');
const ev = (eventType, payload) => ({ eventType, safePayload: payload });
const planEvent = (steps) => ev('harness.tool_proposed', { callId: 'plan:1', toolId: '执行方案', plan: { steps } });
const stepEvent = (type, index, extra) => ev('tool.execution.' + type, { callId: 'step:' + index, toolId: 'read_node', ...(extra || {}) });
const snap = (events, status = 'RUNNING') => ({ taskId: 't', status, steps: [], events, calls: [], artifacts: [], verifications: [] });

/* 1) plan 步骤默认全是待办，顺序与 plan 一致；文案取 description，没有才退回工具名 */
const steps = [
    { index: 0, tool: 'read_node', description: '读取画布与选中节点' },
    { index: 1, tool: 'update_node', description: '更新 3017（等你的 Mac 唤醒）' },
    { index: 2, tool: 'generate_image' },
];
let rows = taskChecklist(snap([planEvent(steps)]));
assert.deepStrictEqual(rows.map((r) => r.label), ['读取画布与选中节点', '更新 3017（等你的 Mac 唤醒）', 'generate_image'], '按 plan 顺序取 description，缺了退回工具名');
assert.ok(rows.every((r) => r.state === 'todo'), '还没执行 = 全部待办');
assert.deepStrictEqual(rows.map((r) => r.index), [0, 1, 2], 'index 原样带出');

/* 2) 工具事件把对应步标成 进行中 / 已完成 / 失败；未发生的步仍待办 */
rows = taskChecklist(snap([planEvent(steps), stepEvent('started', 0), stepEvent('succeeded', 0), stepEvent('started', 1)]));
assert.deepStrictEqual(rows.map((r) => r.state), ['done', 'run', 'todo'], 'started → 进行中，succeeded → 已完成');
rows = taskChecklist(snap([planEvent(steps), stepEvent('started', 0), stepEvent('failed', 0)]));
assert.deepStrictEqual(rows.map((r) => r.state), ['failed', 'todo', 'todo'], 'failed → 失败');
rows = taskChecklist(snap([planEvent(steps), stepEvent('started', 0), stepEvent('denied', 0)]));
assert.strictEqual(rows[0].state, 'failed', 'denied 也算失败');

/* 3) 可纠正的失败：失败事件带后端标记 recoverable → 中性态，不算失败；没标记的真失败一个字不改 */
rows = taskChecklist(snap([
    planEvent([{ index: 0, tool: 'install_skill', description: '安装 GitHub 仓库里的技能' },
               { index: 1, tool: 'install_skill', description: '按 path 安装第一个技能' }]),
    stepEvent('started', 0),
    stepEvent('failed', 0, { code: 'github_skill_install_failed', error: '仓库中有多个 SKILL.md，请用 path 指定一个：a/SKILL.md、b/SKILL.md', recoverable: true }),
    stepEvent('started', 1), stepEvent('succeeded', 1),
], 'SUCCEEDED'));
assert.deepStrictEqual(rows.map((r) => r.state), ['info', 'done'], 'recoverable 失败 → 中性态 info，不当失败');
let tally = taskChecklistTally(rows, 'SUCCEEDED');
assert.deepStrictEqual([tally.done, tally.failed, tally.needsInfo], [1, 0, 1], '可纠正的失败不计入失败数');
assert.strictEqual(tally.total, 2, '总步数照旧');
assert.strictEqual(tally.succeeded, true, 'run 成功');
assert.strictEqual(taskChecklistHint(tally), '1 步需补充信息', '汇总说「需补充信息」，不写「N 步失败」');
assert.ok(!taskChecklistHint(tally).includes('失败'), '汇总不含「失败」');
assert.strictEqual(taskChecklistHint(taskChecklistTally(rows, 'RUNNING')), '1 步需补充信息', '还没结束时也按中性措辞说');
rows = taskChecklist(snap([planEvent(steps), stepEvent('started', 0), stepEvent('failed', 0)]));
assert.strictEqual(rows[0].state, 'failed', '没带 recoverable 的失败仍是真失败');
assert.strictEqual(taskChecklistHint(taskChecklistTally(rows, 'FAILED')), '1 步失败', '真失败文案不变');
assert.strictEqual(taskChecklistTally(rows, 'FAILED').needsInfo, 0, '真失败不计入需补充信息');
/* 真失败与可纠正并存：失败优先，汇总仍说「N 步失败」 */
rows = taskChecklist(snap([
    planEvent([{ index: 0, tool: 'install_skill', description: '装技能' }, { index: 1, tool: 'update_node', description: '改节点' }]),
    stepEvent('failed', 0, { recoverable: true }), stepEvent('failed', 1),
], 'FAILED'));
tally = taskChecklistTally(rows, 'FAILED');
assert.strictEqual(taskChecklistHint(tally), '1 步失败', '有真失败时汇总优先说失败，不被中性态顶掉');
assert.deepStrictEqual([tally.failed, tally.needsInfo], [1, 1], '两类分开数');
assert.strictEqual(taskChecklistTally([], 'SUCCEEDED').allDone, false, '空清单不算全部完成');

/* 4) 多阶段任务逐轮追加 plan：index 连续就往后排；同 index 重发只更新文案，不重复一行 */
rows = taskChecklist(snap([
    planEvent([{ index: 0, tool: 'read_node', description: '读取画布' }]),
    stepEvent('started', 0), stepEvent('succeeded', 0),
    planEvent([{ index: 1, tool: 'create_node', description: '新建图片节点' }]),
    stepEvent('started', 1),
]));
assert.deepStrictEqual(rows.map((r) => r.label), ['读取画布', '新建图片节点'], '第二轮 plan 追加在后面');
assert.deepStrictEqual(rows.map((r) => r.state), ['done', 'run'], '跨轮状态各自保留');
rows = taskChecklist(snap([
    planEvent([{ index: 0, tool: 'read_node', description: '旧文案' }]),
    planEvent([{ index: 0, tool: 'read_node', description: '新文案' }]),
]));
assert.strictEqual(rows.length, 1, '同 index 不重复起行');
assert.strictEqual(rows[0].label, '新文案', '同 index 只更新文案');

/* 5) 待确认方案的 steps 没有 index：按顺序列出、全部待办，不会被 step 事件误标 */
rows = taskChecklist(snap([
    planEvent([{ tool: 'create_node', description: '新建提示词节点' }, { tool: 'generate_image', description: '生成主图' }]),
    stepEvent('succeeded', 0),
]));
assert.deepStrictEqual(rows.map((r) => r.label), ['新建提示词节点', '生成主图'], '没有 index 也能按顺序列出来');
assert.ok(rows.every((r) => r.state === 'todo'), '没有 index 的步骤不参与对账');
assert.ok(taskChecklist(snap([])).length === 0, '没有方案事件就没有清单');
assert.ok(taskChecklist(snap([ev('thought', { text: 'x' })])).length === 0, '无关事件不长出清单');

/* 6) 面板接线：输入框上方的折叠条（不再有消息流内联卡）；默认收起、新任务/切线程回收起；debug 验收口 */
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
const bar = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskChecklistBar.tsx'), 'utf8');
assert.ok(panel.includes('const checklist = taskChecklist(snapshot);'), 'watchTask 解析清单');
assert.ok(panel.includes('checklist: checklist.length ? checklist : m.task?.checklist'), '快照写进消息（空快照不覆盖已有清单）');
assert.ok(panel.includes('<TaskChecklistBar'), '输入框上方渲染折叠条');
assert.ok(!panel.includes('<TaskChecklistCard'), '消息流里不再有内联清单卡');
assert.ok(!fs.existsSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskChecklistCard.tsx')), '内联卡组件已删除');
assert.ok(panel.indexOf('<TaskChecklistBar') < panel.indexOf('<div className="ai ap2-composer"'), '折叠条在输入区（ap2-composer）之前、不占消息流');
assert.ok(panel.includes('const [checklistOpen, setChecklistOpen] = useState(false);'), '默认收起');
assert.ok(/const key = \(a\.activeThreadId \|\| "__new__"\) \+ "\|" \+ \(checklistTask\?\.taskId \|\| ""\)/.test(panel), '切线程 / 换任务用线程+任务拼 key');
assert.ok(panel.includes('setChecklistOpen(false);'), '新任务开跑 / 切线程回到收起');
assert.ok(panel.includes('const lastTaskMsg = [...a.msgs].reverse().find((m) => !!m.task);'), '只认当前线程最后一条任务消息（新任务替换旧清单、丢弃后不复活）');
assert.ok(panel.includes('lastTaskMsg.task.checklist?.length && !lastTaskMsg.task.plan'), '没有任务 / 方案待确认时整条不渲染');
assert.ok(panel.includes('?debugChecklist') || panel.includes('"debugChecklist"'), '验收口 ?debugChecklist=');
assert.ok(panel.includes('function debugChecklistMessage('), '验收口按后端事件形状造数据再走同一解析');
assert.ok(panel.includes('mode === "info"') && panel.includes('recoverable: true'), '验收口 info 模式用和真实后端同一枚 recoverable 标记');
assert.ok(bar.includes('aria-expanded={open}') && bar.includes('aria-controls="checklistBarBody"'), '收起/展开用 aria-expanded + aria-controls');
assert.ok(bar.includes('onMouseDown={(event) => event.preventDefault()}'), '点击不抢输入框焦点（键盘仍可聚焦）');
const taskSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/task.ts'), 'utf8');
assert.ok(taskSrc.includes('正在做：'), '收起态显示「正在做：当前进行中那一步」（文案在 taskChecklistHint）');
assert.ok(bar.includes('taskChecklistHint(tally)') && bar.includes('taskChecklistTally(items, status)'), '汇总文案与计数走 taskChecklistTally / taskChecklistHint（和后端标记同一口径）');
assert.ok(bar.includes('"需补充信息 · 已自动改道"'), '中性态文案：需补充信息 · 已自动改道（run 成功时）');
assert.ok(bar.includes('className="checklist-note"'), '中性态那一行有说明文案');
assert.ok(bar.includes('className="checklist-bar-head"'), '整条头部是 button');

/* 7) 条面样式：磨砂玻璃、无描边、限高内部滚动、展开动效可关；展开后行样式沿用四态 + 中性态 */
const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/message-cards.css'), 'utf8');
const start = css.indexOf('/* ══ 执行进度清单');
assert.ok(start > 0, '折叠条样式段存在');
/* 清单段后面紧跟的不是 `/* ══` 段头，而是「待生成卡片」那串 `/* ──` 分隔注释：只切到最近的段头为止。
   不截断就会一直扫到文件末尾，把后面画幅图标那种规则允许的 border（.gen-shape i 的 1.5px）也算进来，
   误伤「条面不画 border」。断言原意不变：只要求这一段里的 border 全是 0。 */
const nextSection = ['/* ── 待生成卡片', '/* ══ ']
    .map((marker) => css.indexOf(marker, start + 1))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0];
const end = nextSection === undefined ? css.length : nextSection;
assert.ok(end < css.length, '清单段有明确的结束分隔注释（否则 border 断言会扫到别的卡）');
const section = css.slice(start, end);
assert.ok(!/\.checklist-card/.test(section), '旧内联卡样式已移除');
assert.ok(section.includes('backdrop-filter: var(--glass-blur)') && section.includes('-webkit-backdrop-filter: var(--glass-blur)'), '磨砂玻璃含 -webkit-');
assert.ok(/color-mix\(in srgb, var\(--card\) \d+%, transparent\)/.test(section), '半透明底（不是裸 transparent）');
const borderDecls = [...section.matchAll(/\bborder(?:-(?!radius)[a-z]+)?\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
assert.ok(borderDecls.length > 0 && borderDecls.every((value) => value === "0"), '条面不画 border（只允许 0）：' + JSON.stringify(borderDecls));
assert.ok(!/inset 0 0 0/.test(section), '条面不用 inset 高光描边');
assert.ok(/\.checklist-bar-body\[class\] \{[^}]*max-height:[^}]*overflow-y:\s*auto/.test(section), '展开态限高 + 内部滚动');
assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.checklist-bar-body\[class\] \{ animation: none; \}/.test(section), 'reduce motion 关展开动效');
const tokens = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
assert.ok(/transition: rotate var\(--d-quick\)/.test(section), '箭头旋转走 --d-quick');
assert.ok(/--d-quick:\.16s/.test(tokens), '--d-quick = 160ms（展开/收起动效 160-200ms）');
assert.ok(section.includes('.is-done[class] .checklist-text[class]') && /\.checklist-label\[class\]::after \{[\s\S]*?transform: scaleX\(0\)/.test(section) && /\.is-done\[class\] \.checklist-label\[class\]::after \{ transform: scaleX\(1\)/.test(section), '已完成：1px 划线从左展开（伪元素，随状态切换）');
assert.ok(section.includes('.is-todo[class] .checklist-text[class] { color: color-mix(in srgb, var(--fg2) 68%, transparent)'), '待办：文字弱化');
assert.ok(section.includes('.is-run[class] .checklist-text[class]'), '进行中：文字正常');
assert.ok(section.includes('.is-failed[class] .checklist-mark[class]'), '失败：红叉状态点');
assert.ok(section.includes('.is-info[class] .checklist-mark[class]'), '可纠正的失败：中性色状态点');
assert.ok(section.includes('.checklist-note[class]') && /color:\s*var\(--fg3\)/.test(section.slice(section.indexOf('.checklist-note[class]'))), '中性态说明文案弱化，不用红色');
const infoBlock = section.slice(section.indexOf('.is-info[class] .checklist-mark[class]'), section.indexOf('/* 待办'));
assert.ok(infoBlock.length > 0 && !infoBlock.includes('--bad'), '中性态不借用红色');

console.log('[PASS] 任务清单条：解析 27 条 + 面板接线 20 条 + 条面样式 17 条 全部通过');
