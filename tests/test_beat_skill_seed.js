#!/usr/bin/env node
'use strict';
/*
 * 应用市场「在新画布里使用」→ 画布助手技能胶囊。
 *
 * 种子协议（web 侧 HomePage / 应用市场写 localStorage[novai_canvas_seed:<canvasId>]）：
 *   { v: 1, agent, autoSend, skillRef }，skillRef = 内置技能 id，市场技能 = store:<id>。
 * 这里锁四件事：
 *   1. skillRef 纯映射真跑（id / 名字 / store: 前缀 / 匹配不到 → null 静默忽略）；
 *   2. homeSeed.consumeHomeSeed 真的把 skillRef 带进草稿（以前只读 agent / autoSend / nodes）；
 *   3. AgentPanel 按 id 或名字匹配，技能列表晚到时靠 pendingSkillRef 补胶囊，查不到就放弃、不动草稿；
 *   4. 构建产物 static/novai-canvas/canvas.js 里带上了这套逻辑。
 *
 * 跑法：node tests/test_beat_skill_seed.js
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

/* ───────── [1] 纯映射 ───────── */
console.log('[1] skillRef 纯映射（真跑 skillRef.ts）');
const { normalizeSkillRef, matchSkillRef } = load('novai-canvas-ui/src/canvas/canvas-next/agent/skillRef.ts');
const skills = [
    { id: 'fashion-editorial', name: '服装大片 · 胶片暗房' },
    { id: 'mk_123', name: '市场技能示例' },
    { name: '只有名字的技能' },
];
ok(normalizeSkillRef('store:mk_123') === 'mk_123', 'store:<id> 前缀被去掉');
ok(normalizeSkillRef('  fashion-editorial  ') === 'fashion-editorial', '两侧空白被裁掉');
ok(normalizeSkillRef(undefined) === '' && normalizeSkillRef(null) === '' && normalizeSkillRef('') === '', '空值归一成空串（不抛）');
ok(matchSkillRef('fashion-editorial', skills) === '服装大片 · 胶片暗房', '内置技能按 id 匹配到名字');
ok(matchSkillRef('store:mk_123', skills) === '市场技能示例', '市场技能 store:<id> 去前缀后按 id 匹配');
ok(matchSkillRef('服装大片 · 胶片暗房', skills) === '服装大片 · 胶片暗房', '也接受直接按名字匹配');
ok(matchSkillRef('只有名字的技能', skills) === '只有名字的技能', '没有 id 的技能按名字匹配');
ok(matchSkillRef('not-exist', skills) === null, '匹配不到返回 null（面板静默忽略，不报错）');
ok(matchSkillRef('', skills) === null && matchSkillRef(undefined, skills) === null, '空引用返回 null');
ok(matchSkillRef('fashion-editorial', []) === null, '技能列表还没加载时返回 null（等加载完再补）');

/* ───────── [2] homeSeed 带出 skillRef ───────── */
console.log('[2] homeSeed.consumeHomeSeed 读出 skillRef');
const seedSrc = read('novai-canvas-ui/src/canvas/canvas-next/homeSeed.ts');
ok(/import \{ normalizeSkillRef \} from "\.\/agent\/skillRef";/.test(seedSrc), 'homeSeed 引入 normalizeSkillRef');
ok(seedSrc.includes('skillRef?: string'), 'AgentDraft 声明 skillRef 字段');
ok(/const skillRef = normalizeSkillRef\(seed\.skillRef\);/.test(seedSrc), 'consumeHomeSeed 读 seed.skillRef 并归一化');
ok(/return \{ seq: Date\.now\(\), text, [\s\S]{0,120}skillRef/.test(seedSrc), '返回的草稿带上 skillRef');
ok(/if \(!text && !skillRef\) return null/.test(seedSrc), '只有技能、没有文字也交草稿（不整条丢掉）');
ok(/autoSend: seed\.autoSend === true && !!text/.test(seedSrc), '没有文字时不自动发送');

/* ───────── [3] AgentPanel 匹配 + 晚到补偿 ───────── */
console.log('[3] AgentPanel：按 id/名字匹配，技能列表晚到再补胶囊');
const panel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
ok(/import \{ matchSkillRef \} from "\.\.\/canvas-next\/agent\/skillRef";/.test(panel), 'AgentPanel 引入 matchSkillRef');
ok(panel.includes('if (draft.skillRef && !a.skill) {'), '处理草稿时看 draft.skillRef（用户已选技能就不覆盖）');
ok(panel.includes('const name = matchSkillRef(draft.skillRef, a.skills);'), '按当前已加载技能列表匹配');
ok(panel.includes('else pendingSkillRef.current = draft.skillRef;'), '匹配不到先暂存，不报错、不动草稿');
ok(panel.includes('const ref = pendingSkillRef.current;') && panel.includes('}, [a.skills, a]);'), '技能列表变化后重试（依赖 a.skills）');
ok(panel.includes('if (!name) return;') && panel.includes('if (!a.skill) { a.skill = name; a.emit(); }'), '补胶囊：查不到就放弃，查到了也不抢用户已选的');

/* ───────── [4] 构建产物 ───────── */
console.log('[4] 构建产物 static/novai-canvas/canvas.js');
const beatJs = read('static/novai-canvas/canvas.js');
ok(beatJs.includes('skillRef'), 'canvas.js 含 skillRef');
ok(beatJs.includes('novai_canvas_seed'), 'canvas.js 仍含种子键 novai_canvas_seed');

console.log('');
console.log('应用市场 skillRef → 画布助手技能胶囊：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach((f) => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
process.exit(0);
