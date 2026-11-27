#!/usr/bin/env node
/* Seedance 草稿模式（两段式）UI 契约 —— 取代 2026-11-13 的「按最低档草稿」旧口径：
   1. 入口只由后端 caps 声明决定（draft / draft_resolution / draft_final_resolutions / draft_expires_days）；
      seedance-2-5-flash 没有 draft 字段 → 没有草稿开关与「出成片」入口；
   2. 一行两段：左边「草稿模式 + 草稿 480p · 成片可选 1080p 或 4k · 草稿 3 天有效」，右边画布统一胶囊开关；
   3. 草稿态请求固定草稿档、其它分辨率卡片禁用（不是静默忽略）；成片档只认 caps 的 draft_final_resolutions；
   4. 零边框 / 软底 / 复用 .sw 胶囊；
   5. 参数弹层统一走「小弹层加厚底」的磨砂玻璃（param-pop）。 */
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
const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

// ---- 1. caps：seedance-2.5 有草稿，seedance-2-5-flash 没有 ----
const SEEDANCE_DRAFT = {
    provider: 'apimart', model: 'seedance-2.5', kind: 'video',
    ratios: ['16:9'], resolutions: ['480p', '720p', '1080p', '4k'], durations: [-1, 4, 5],
    draft: true, draft_resolution: '480p', draft_final_resolutions: ['1080p', '4k'], draft_expires_days: 3,
};
const FLASH_NO_DRAFT = {
    provider: 'apimart', model: 'seedance-2-5-flash', kind: 'video',
    ratios: ['16:9'], resolutions: ['480p', '720p', '1080p', '4k'], durations: [5],
};
const draftSpec = model.specFor({ configId: 'apimart::seedance-2.5', label: 'seedance-2.5', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', SEEDANCE_DRAFT), specSource: 'spec' });
const flashSpec = model.specFor({ configId: 'apimart::seedance-2-5-flash', label: 'seedance-2-5-flash', vendor: 'APIMART', kind: 'video', ui: caps.modelCapsUi('video', FLASH_NO_DRAFT), specSource: 'spec' });
assert.strictEqual(draftSpec.draft, true, 'seedance-2.5 声明草稿 → spec.draft');
assert.strictEqual(model.draftSupported(draftSpec), true, '有 caps.draft 才有入口');
assert.strictEqual(flashSpec.draft, undefined, 'seedance-2-5-flash 没有 draft 字段');
assert.strictEqual(model.draftSupported(flashSpec), false, 'flash 没有草稿入口（spec.draft 缺省即不支持）');
assert.deepStrictEqual(model.draftFinalResolutions(draftSpec), ['1080p', '4k'], '成片档只认 draft_final_resolutions');
assert.deepStrictEqual(model.draftFinalResolutions(flashSpec), [], 'flash 没有成片档');
assert.strictEqual(model.draftResolution(draftSpec), '480p', '草稿档只认 draft_resolution');
assert.strictEqual(model.draftExpiresDays(draftSpec), 3, '草稿 3 天有效');

// ---- 2. 行为：草稿发固定草稿档；非草稿发用户选的档；不支持草稿的模型一律不改清晰度、不带 draft ----
const draftOn = { model: draftSpec.id, mode: '文生视频', ratio: '16:9', res: '4k', dur: 5, sound: false, times: 1, draft: true };
const draftOff = { ...draftOn, draft: false };
assert.strictEqual(model.draftActive(draftOn, draftSpec), true);
assert.strictEqual(model.draftRes(draftOn, draftSpec), '480p', '草稿模式发固定草稿档（480p），即使面板选的是 4k');
assert.strictEqual(model.draftRes(draftOff, draftSpec), '4k', '非草稿发当前选的档位');
assert.strictEqual(model.draftActive(draftOn, flashSpec), false, 'flash 上的旧 draft 值不生效');
assert.strictEqual(model.draftRes(draftOn, flashSpec), '4k', 'flash 不因旧 draft 值降低清晰度');
assert.strictEqual(model.clampParams('video', { ...draftOn, draftTaskId: 't' }, flashSpec).draft, undefined, '换到 flash 清掉 draft');
// 成片步：只认草稿任务 id，目标档位收敛进成片档
assert.strictEqual(model.draftFinalActive({ draftTaskId: 'up_1' }, draftSpec), true);
assert.strictEqual(model.draftFinalActive({ draftTaskId: 'up_1' }, flashSpec), false, 'flash 不接受 draft_task_id');
assert.strictEqual(model.draftFinalResolution({ res: '4k' }, draftSpec), '4k', '成片 4k 合法');
assert.strictEqual(model.draftFinalResolution({ res: '720p' }, draftSpec), '1080p', '成片其它档位收敛到 1080p');
const finalParams = model.clampParams('video', { ...draftOn, res: '720p', draftTaskId: 'up_1' }, draftSpec);
assert.strictEqual(finalParams.draft, undefined, '成片步与 draft 互斥');
assert.strictEqual(finalParams.draftTaskId, 'up_1', '成片步带草稿任务 id');
assert.strictEqual(finalParams.res, '1080p', '成片档位收敛进 caps 的成片档');

// ---- 3. 结构：整行可点的软底开关（标题 + 说明 + 胶囊）----
assert.ok(panel.includes('function DraftRow('), 'DraftRow 组件存在');
assert.ok(panel.includes('className="draft-mode"'), '一行式软底开关（.draft-mode）');
assert.ok(panel.includes('data-p="vdraft"') && panel.includes('data-vopt="draft"'), '保留既有 e2e 选择器');
assert.ok(panel.includes('role="switch"') && panel.includes('aria-checked={on}'), '开关语义（role=switch / aria-checked）');
assert.ok(panel.includes('<span className="t">草稿模式</span>'), '标题「草稿模式」');
assert.ok(panel.includes('草稿 ${res} · 成片可选 ${finals.join(" 或 ")}') && panel.includes('草稿 ${expiresDays} 天有效'), '说明写清草稿档 → 成片档 → 有效期');
assert.ok(panel.includes('data-draft-res={res}') && panel.includes('data-draft-finals={finals.join(",")}'), '行上带草稿档 / 成片档，方便 e2e 断言');
assert.ok(panel.includes('className={"sw" + (on ? " on" : "")}'), '右侧用画布统一的胶囊开关（.sw / 开态加 .on）');
assert.ok(panel.includes('aria-label="草稿模式"'), '胶囊有 switch 语义');
assert.ok(panel.includes('onClick={(event) => { event.stopPropagation(); onToggle(); }}'), '点胶囊不冒泡到整行（避免切换两次）');
const draftBlock = panel.slice(panel.indexOf('function DraftRow('), panel.indexOf('function DraftRow(') + 1600);
assert.ok(!draftBlock.includes('aria-pressed'), '不用关/开分段按钮');
assert.ok(!draftBlock.includes('className="dot"'), '不自绘小圆点');

// ---- 4. 样式：零边框 / 软底 / 胶囊 ----
const row = (css.match(/\.cn-root \.draft-mode\{[^}]*\}/) || [''])[0];
assert.ok(row, '有 .draft-mode 样式');
assert.ok(!/(^|;)\s*border\s*:/.test(row) && !/border-(color|width|style)/.test(row), '.draft-mode 不画边框（border-radius 允许）：' + row);
assert.ok(!/inset/.test(row), '.draft-mode 不用 inset 描边');
assert.ok(!/(^|;)\s*background/.test(row), '不加底框（直接坐在弹层磨砂底上）：' + row);
assert.ok(/\.cn-root \.draft-mode \.sw\{flex:none/.test(css), '胶囊开关横排在右侧');
assert.ok(/\.cn-root \.draft-mode\[data-on\] \.t\{color:var\(--fg\);font-weight:500\}/.test(css), '开启态标题提亮 + 字重变化');
const swBlock = (css.match(/\.cn-root \.sw\{[^}]*\}/) || [''])[0];
assert.ok(/width:36px;height:20px;border-radius:10px/.test(swBlock), '全局胶囊开关 36×20 / 圆角 10：' + swBlock);
assert.ok(/\.cn-root \.sw:after\{[^}]*width:16px;height:16px;border-radius:50%/.test(css), '圆钮由 ::after 画（16px 圆）');
assert.ok(/\.cn-root \.sw\.on\{background:var\(--solid\)\}/.test(css), '开态用 --solid');

// ---- 5. 入口接线：只看 caps；草稿态禁用其它分辨率 ----
assert.ok(panel.includes('{draftSupported(m) ? <DraftRow'), '草稿开关只在 caps.draft 的模型上渲染');
assert.ok(!panel.includes('{rr ? <DraftRow'), '旧的「两档清晰度即草稿」门槛已删除');
assert.ok(panel.includes('disabled: disabled || (draftOn && r !== fixedDraftRes)'), '草稿态下其它分辨率卡片禁用（不是静默忽略）');
assert.ok(panel.includes('{draftActive(vp, m) ? ') && panel.includes('draftResolution(m)') && panel.includes('videoResLabel(vp.res)'), '底栏摘要显示「草稿 480p」');
assert.ok(panel.includes('data-draft-note') && panel.includes('草稿 " + draftResolution(m) + " · 成片可选 "'), '草稿态给出档位 / 成片档 / 有效期说明');
assert.ok(panel.includes('data-draft-final={res}') && panel.includes('draftToFinalTask(store, node, draftTaskId, res)'), '草稿任务完成后有「出成片」入口（列 1080p / 4k）');
assert.ok(panel.includes('成片生成中'), '成片任务轮询时显示「成片生成中」');
assert.ok(panel.includes('data-draft-final-note'), '成片节点说明只发草稿任务 id + 目标档位');

console.log('[PASS] Seedance 草稿两段式 UI：caps 门槛（flash 无入口）/ 草稿 480p 固定档 / 成片档 1080p·4k / 3 天有效期 / 禁用其它分辨率 / 出成片入口 / 胶囊开关与磨砂规范');

// ---- 6. 参数弹层统一走「小弹层加厚底」的磨砂玻璃（param-pop）----
assert.ok(panel.includes('cls ? "param-pop " + cls : "param-pop"'), '参数弹层默认挂 param-pop（和模型菜单同一套磨砂底）');
assert.ok(panel.includes('const pop = (render: (close: () => void) => React.ReactNode, cls?: string)'), 'pop 辅助函数仍是单一出口');
assert.ok(/\.cn-root #pop\.param-pop\{padding:12px 14px 14px\}/.test(css), '参数弹层外层四边距 12/14/14');
assert.ok(/\.cn-root #pop\.param-pop \.mh\{padding:8px 0 6px\}/.test(css), '分组标题不再自带左右缩进');
assert.ok(/\.cn-root #pop\.param-pop \.seg\{padding:0 0 8px\}/.test(css) && /\.cn-root #pop\.param-pop \.opt-grid\{padding:0 0 8px\}/.test(css), '选项区（seg / opt-grid）不再二次缩进');
assert.ok(/\.cn-root #pop\.param-pop \.vset > \*:last-child\{padding-bottom:0\}/.test(css), '最后一行去掉自带下边距（底部=顶部）');
assert.ok(/\.cn-root #pop\.param-pop\.vset-pop\{width:calc\(272px \+ 28px\)\}/.test(css), '视频参数浮层 = 内容 272 + 左右内边距 28（右侧不再多出空白）');

const agentCss = read('novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css');
assert.ok(agentCss.includes('.cn-root #pop.param-pop.param-pop.param-pop'), '加厚底配方覆盖 param-pop');
assert.ok(agentCss.includes('background: rgba(24, 24, 24, .95)') && agentCss.includes('background: rgba(255, 255, 255, .96)'), '深/浅两套加厚底都保留 blur + 柔和投影');
