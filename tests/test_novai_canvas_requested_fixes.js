#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const timeline = load('novai-canvas-ui/src/canvas/canvas-next/timelineModel.ts');
assert.deepStrictEqual(timeline.frameSize('16:9', '4K'), { width: 3840, height: 2160 });
assert.deepStrictEqual(timeline.frameSize('9:16', '4K'), { width: 2160, height: 3840 });
assert(timeline.RATIOS.includes('21:9') && timeline.RATIOS.includes('2.39:1'));
assert(timeline.RESES.includes('2K') && timeline.RESES.includes('4K'));

const workflows = load('novai-canvas-ui/src/canvas/canvas-next/personalTemplates.ts');
const doc = {
    nodes: [
        { id: 'n1', kind: 'text', x: 10, y: 20, w: 260, h: 220, text: '脚本', data: { gen: { title: '脚本', prompt: '写脚本', hist: [{ text: '正文' }], hi: 0 } } },
        { id: 'n2', kind: 'image', x: 340, y: 20, w: 260, h: 220, text: '产品图', url: '/output/product.png', data: { gen: { title: '产品图', prompt: '参考 @{n1}', hist: [{ url: '/output/product.png' }], hi: 0 } } },
        { id: 'n3', kind: 'video', x: 670, y: 20, w: 260, h: 220, text: '短片', url: '/output/clip.mp4', data: { gen: { title: '短片', prompt: '使用 @{n2}', hist: [{ url: '/output/clip.mp4' }], hi: 0 } } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'n3' }], comments: [],
};
const exported = workflows.workflowFileContents('测试工作流', doc);
const parsed = workflows.parseWorkflowFile(exported);
assert.strictEqual(parsed.title, '测试工作流');
assert.strictEqual(parsed.doc.nodes[0].data.gen.hist[0].text, '正文');
assert.strictEqual(parsed.doc.nodes[1].url, '/output/product.png');
assert.strictEqual(parsed.doc.nodes[2].url, '/output/clip.mp4');
let idSeq = 0;
const cloned = workflows.cloneWorkflowForImport(parsed.doc, { x: 1000, y: 600 }, (prefix) => prefix + '_' + (++idSeq));
assert.strictEqual(cloned.nodes[1].data.gen.hist[0].url, '/output/product.png');
assert.strictEqual(cloned.nodes[2].data.gen.hist[0].url, '/output/clip.mp4');
assert.strictEqual(cloned.nodes[1].data.gen.prompt, '参考 @{' + cloned.nodes[0].id + '}');
assert.strictEqual(cloned.nodes[2].data.gen.prompt, '使用 @{' + cloned.nodes[1].id + '}');
assert.strictEqual(cloned.edges[1].from, cloned.nodes[1].id);
assert.strictEqual(cloned.edges[1].to, cloned.nodes[2].id);
assert.throws(() => workflows.parseWorkflowFile('{bad json'), /JSON/);
assert.throws(() => workflows.parseWorkflowFile('{"nodes":[]}'), /没有可导入/);

const qa = load('novai-canvas-ui/src/canvas/canvas-next/agent/qa.ts');
const answer = qa.parseQuestions('先确认：\n```openarc-questions\n[{"question":"比例？","options":["16:9","9:16"]}]\n```');
assert.strictEqual(answer.questions[0].options[1], '9:16');
assert.strictEqual(answer.rest, '先确认：');

const editor = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/TimelineEditor.tsx'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx'), 'utf8');
const chrome = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Chrome.tsx'), 'utf8');
const state = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/state.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBridge.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
// 2026-11 task-18 用户新要求：图片编辑器多角度/标注画笔改用滑杆（只有图片编辑器允许 range；时间线/Chrome 仍不允许）
assert(!editor.includes('type="range"') && !chrome.includes('type="range"') && registry.includes('type="range"'));
assert(editor.includes('onLanesWheel') && editor.includes('startPan') && editor.includes('data-tl="zoom-in"'));
assert(chrome.includes('data-menu="export-workflow"') && chrome.includes('data-menu="import-workflow"'));
// 2026-11 task-4：内置技能包（skill_type=system）不再被过滤——旧断言钉的是「列表里过滤掉 system」，
// 而库里唯一的技能就是内置包，过滤后 / 菜单永远是空的。现在 system 视为官方技能，正文另走 /api/skills/{id}/export。
assert(!state.includes('const OFFICIAL') && bridge.includes('skill.skill_type === "system"') && bridge.includes('/export'));
// 画布助手不再用问答卡片反问：系统提示改成「自己按默认决定 + 把假设写进 assumptions」
assert(!main.includes('```openarc-questions') && main.includes('不要反问'));
assert(main.includes('"assumptions"') && main.includes('"reason"'));
assert(main.includes('os.environ.get("NOVAI_CHAT_BACKEND", "local")'));
const canvasCss = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
// 2026-11 用户要求菜单/弹层不显示滚动条（但保留滚动）：改成 display:none，而不是上一版可见的细滚动条
assert(canvasCss.includes('.cn-root #pop::-webkit-scrollbar') && canvasCss.includes('display:none') && canvasCss.includes('scrollbar-width:none'));
assert(canvasCss.includes('.cn-root #modal::-webkit-scrollbar') && canvasCss.includes('.cn-root .model-flyout::-webkit-scrollbar'));
assert(chrome.includes('BUILTIN_COVER_DOCS') && chrome.includes('TplFlowAnim') && canvasCss.includes('.tpl-anim .ta-node'));
// 公共模板清空：内置模板留空数组、不依赖数量的引导语文案、空态一句话
assert(chrome.includes('const BUILTIN_TEMPLATES: TplEntry[] = [];') && chrome.includes('还没有公共模板') && !chrome.includes('个模板覆盖电商'));
assert(!fs.existsSync(path.join(root, 'web/src/pages/store')));
assert(!chrome.includes('market/catalog') && !chrome.includes('市场清单读取失败') && !chrome.includes('个节点</span>'));
const promptEditor = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/PromptEditor.tsx'), 'utf8');
const genPanel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
const nodeView = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx'), 'utf8');
const agentPanel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
assert(promptEditor.includes('expandGroupInputs') && !promptEditor.includes('appendMention'));
assert(!genPanel.includes('explicitIds') && genPanel.includes('{ins.map'));
assert(!nodeView.includes('node.kind !== "text" ? <div className="rz"'));
assert(agentPanel.includes('aria-haspopup="menu"') && canvasCss.includes('.model-flyout'));
assert(canvasCss.includes('aspect-ratio:1/1') && canvasCss.includes('.cn-root .ntext::-webkit-scrollbar{display:none'));
const actions = load('novai-canvas-ui/src/canvas/canvas-next/actions.ts');
const group = { id: 'stack', kind: 'group', x: 0, y: 0, w: 200, h: 200, text: '堆叠', children: ['img1'], data: { stack: {} } };
const image = { id: 'img1', kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '图1', data: { gen: { title: '图1', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
const target = { id: 'target', kind: 'text', x: 300, y: 0, w: 260, h: 220, text: '文本', data: { gen: { title: '文本', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
const video = { id: 'video1', kind: 'video', x: 0, y: 300, w: 200, h: 200, text: '视频', data: { gen: { title: '视频', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
const textSource = { id: 'text1', kind: 'text', x: 0, y: 600, w: 200, h: 200, text: '文本', data: { gen: { title: '文本', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
const store = {
    state: { doc: { nodes: [group, image, video, textSource, target], edges: [], comments: [] }, ui: { sel: new Set(), edge: null } },
    node(id) { return this.state.doc.nodes.find(n => n.id === id); },
    addEdge(from, to) { const edge = { id: 'new-edge', from, to }; this.state.doc.edges.push(edge); return edge; },
    patchGen(id, patch) { const n = this.node(id); const p = typeof patch === 'function' ? patch(n.data.gen) : patch; n.data.gen = { ...n.data.gen, ...p }; },
    setUI() {}, toast() {},
};
actions.connect(store, 'stack', 'target');
assert.strictEqual(target.data.gen.prompt, '');
actions.addMention(store, 'target', 'stack');
assert.strictEqual(target.data.gen.prompt, '@{stack} ');
actions.connect(store, 'img1', 'target');
actions.connect(store, 'video1', 'target');
actions.connect(store, 'text1', 'target');
assert.strictEqual(target.data.gen.prompt, '@{stack} ');
actions.addMention(store, 'target', 'img1');
assert(target.data.gen.prompt.includes('@{img1}'));
assert(!target.data.gen.prompt.includes('@{video1}') && !target.data.gen.prompt.includes('@{text1}'));
console.log('[PASS] 智能画布问答卡、工作流导入导出、无滑块、时间线平移缩放与 4K 回归');