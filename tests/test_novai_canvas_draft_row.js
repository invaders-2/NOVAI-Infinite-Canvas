#!/usr/bin/env node
/* 2026-11-13：视频「草稿模式」改成开关行（原来只有一行灰字，看着像段落标题，没人知道能点）。
   契约：
   1. 一行两段：左边「草稿模式 + 先按 X 出草稿、满意后再按 Y 出成片」，右边一颗 34×20 胶囊开关；
   2. 零边框零发丝线：关时低对比软底，开时半透明蓝软底 + 蓝色轨道 + 白色圆钮右移；
   3. 状态用 role="switch" / aria-checked 表达，data-p="vdraft"、data-vopt="draft" 保留（既有 e2e 选择器）；
   4. 分辨率只有一档的模型不显示这行（沿用原有逻辑）；点分辨率卡片会顺手关掉草稿。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

// ---- 1. 行为：草稿发的就是模型最低档，成片是当前选的那档 ----
const spec = model.specFor({ configId: 'apimart::apimart-zoe', label: 'apimart-zoe', kind: 'video', ui: { ratios: ['16:9'], res: ['480p', '720p', '1080p', '2k', '4k'], durs: [4, 5] }, specSource: 'spec' });
const draftOn = { model: spec.id, mode: '文生视频', ratio: '16:9', res: '4k', dur: 5, sound: false, times: 1, draft: true };
const draftOff = { ...draftOn, draft: false };
assert.strictEqual(model.draftRes(draftOn, spec), '480p', '草稿模式发最低档（480p）');
assert.strictEqual(model.draftRes(draftOff, spec), '4k', '非草稿发当前选的档位');
assert.deepStrictEqual(model.resRange(spec), { low: '480p', high: '4k' }, '说明文案的两档来自能力表');

// ---- 2. 结构：整行可点的软底开关（标题 + 说明 + 小圆点）----
assert.ok(panel.includes('function DraftRow('), 'DraftRow 组件存在');
assert.ok(panel.includes('className="draft-mode"'), '一行式软底开关（.draft-mode）');
assert.ok(panel.includes('data-p="vdraft"') && panel.includes('data-vopt="draft"'), '保留既有 e2e 选择器');
assert.ok(panel.includes('role="switch"') && panel.includes('aria-checked={on}'), '开关语义（role=switch / aria-checked）');
assert.ok(panel.includes('<span className="t">草稿模式</span>'), '标题「草稿模式」');
assert.ok(panel.includes('先按 ${range.low} 出草稿，满意后再按 ${range.high} 出成片'), '说明写清草稿档位 → 成片档位');
assert.ok(panel.includes('className={"sw" + (on ? " on" : "")}'), '右侧用画布统一的胶囊开关（.sw / 开态加 .on）');
assert.ok(panel.includes('role="switch"') && panel.includes('aria-checked={on}') && panel.includes('aria-label="草稿模式"'), '胶囊有 switch 语义');
assert.ok(panel.includes('onClick={(event) => { event.stopPropagation(); onToggle(); }}'), '点胶囊不冒泡到整行（避免切换两次）');
const draftBlock = panel.slice(panel.indexOf('function DraftRow('), panel.indexOf('function DraftRow(') + 1400);
assert.ok(!draftBlock.includes('data-draft="on"') && !draftBlock.includes('aria-pressed'), '不再用关/开分段按钮');
assert.ok(!draftBlock.includes('className="dot"'), '不再自绘小圆点');
assert.ok(!draftBlock.includes('.sw i'), '不自绘圆钮（.sw 的圆钮由 ::after 提供，避免和全局 .sw 打架）');

// ---- 3. 样式：零边框 / 软底 / 蓝点 ----
const row = (css.match(/\.cn-root \.draft-mode\{[^}]*\}/) || [''])[0];
assert.ok(row, '有 .draft-mode 样式');
assert.ok(!/(^|;)\s*border\s*:/.test(row) && !/border-(color|width|style)/.test(row), '.draft-mode 不画边框（border-radius 允许）：' + row);
assert.ok(!/inset/.test(row), '.draft-mode 不用 inset 描边');
assert.ok(!/(^|;)\s*background/.test(row), '不加底框（直接坐在弹层磨砂底上）：' + row);
assert.ok(!/border-radius/.test(row), '不加底框就不需要圆角');
assert.ok(/\.cn-root \.draft-mode \.sw\{flex:none/.test(css), '胶囊开关横排在右侧');
assert.ok(/\.cn-root \.draft-mode\[data-on\] \.t\{color:var\(--fg\);font-weight:500\}/.test(css), '开启态标题提亮 + 字重变化');
// 复用全局胶囊开关：36×20 胶囊 + ::after 圆钮 + 开态 --solid，别再自定义一套
const swBlock = (css.match(/\.cn-root \.sw\{[^}]*\}/) || [''])[0];
assert.ok(/width:36px;height:20px;border-radius:10px/.test(swBlock), '全局胶囊开关 36×20 / 圆角 10：' + swBlock);
assert.ok(/\.cn-root \.sw:after\{[^}]*width:16px;height:16px;border-radius:50%/.test(css), '圆钮由 ::after 画（16px 圆）');
assert.ok(/\.cn-root \.sw\.on\{background:var\(--solid\)\}/.test(css), '开态用 --solid');
assert.ok(!/\.cn-root \.draft-mode \.dot/.test(css), '旧的小圆点样式已删除');

// ---- 4. 单一档位模型不给入口；点分辨率卡片顺手关草稿 ----
assert.ok(panel.includes('{rr ? <DraftRow on={!!p.draft}') && panel.includes('range={rr}'), '只有真有两档才渲染开关行');
assert.ok(panel.includes('set({ res: r, draft: false })'), '点分辨率卡片会关掉草稿模式');

console.log('[PASS] 草稿模式 UI：一行说明 + 画布统一胶囊开关（.sw / 36×20 / :after 圆钮 / 开态 --solid）+ 零边框 + 单档模型不显示');

// ---- 6. 参数弹层统一走「小弹层加厚底」的磨砂玻璃（param-pop）----
assert.ok(panel.includes('cls ? "param-pop " + cls : "param-pop"'), '参数弹层默认挂 param-pop（和模型菜单同一套磨砂底）');
assert.ok(panel.includes('const pop = (render: (close: () => void) => React.ReactNode, cls?: string)'), 'pop 辅助函数仍是单一出口');
// 参数弹层内边距：外层 12/14/14，内部行不再二次缩进（原来标题 16 / 卡片 12 / 模型名 8 三种左缩进，底部只有 10）
assert.ok(/\.cn-root #pop\.param-pop\{padding:12px 14px 14px\}/.test(css), '参数弹层外层四边距 12/14/14');
assert.ok(/\.cn-root #pop\.param-pop \.mh\{padding:8px 0 6px\}/.test(css), '分组标题不再自带左右缩进');
assert.ok(/\.cn-root #pop\.param-pop \.seg\{padding:0 0 8px\}/.test(css) && /\.cn-root #pop\.param-pop \.opt-grid\{padding:0 0 8px\}/.test(css), '选项区（seg / opt-grid）不再二次缩进');
assert.ok(/\.cn-root #pop\.param-pop \.ev-slider\{padding:0\}/.test(css), '拖动条与其它内容同一条左边线');
assert.ok(/\.cn-root #pop\.param-pop \.vset > \*:last-child\{padding-bottom:0\}/.test(css), '最后一行去掉自带下边距（底部=顶部）');
// 视频参数浮层按内容定宽（272 + 左右 28），否则弹层按 max-content 撑开会在右边空一条
assert.ok(/\.cn-root #pop\.param-pop\.vset-pop\{width:calc\(272px \+ 28px\)\}/.test(css), '视频参数浮层 = 内容 272 + 左右内边距 28（右侧不再多出空白）');

const agentCss = read('novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css');
assert.ok(agentCss.includes('.cn-root #pop.param-pop.param-pop.param-pop'), '加厚底配方覆盖 param-pop');
assert.ok(agentCss.includes('background: rgba(24, 24, 24, .95)') && agentCss.includes('background: rgba(255, 255, 255, .96)'), '深/浅两套加厚底都保留 blur + 柔和投影');
