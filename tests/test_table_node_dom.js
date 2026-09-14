#!/usr/bin/env node
// DOM 级驱动表格节点：结构、重绘、编辑状态机、输入通道（DX OS §3/§4）。
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const show = v => { try { return JSON.stringify(v); } catch(e){ return String(v); } };
const eq = (a, b, m) => { show(a) === show(b) ? pass++ : fails.push(m + ' 期望' + show(b) + ' 实际' + show(a)); };

// ── 极简 DOM 垫片 ──
function makeEl(tag){
    const el = {
        tagName: String(tag).toUpperCase(), children: [], className: '', _text: '', innerHTML: '',
        style: {}, dataset: {}, parentElement: null, _listeners: {},
        appendChild(child){ child.parentElement = el; el.children.push(child); return child; },
        addEventListener(type, fn){ (el._listeners[type] = el._listeners[type] || []).push(fn); },
        querySelector(){ return null; },
        closest(){ return null; },
        focus(){ el._focused = true; },
        select(){},
        get textContent(){ return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
        set textContent(v){ el.children.length = 0; el._text = String(v === null || v === undefined ? '' : v); },
    };
    el.classList = {
        add(...cs){ const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
        remove(...cs){ const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
        contains(c){ return el.className.split(/\s+/).includes(c); },
    };
    return el;
}
const all = el => { const out = []; const rec = e => { out.push(e); (e.children || []).forEach(rec); }; rec(el); return out; };
const byClass = (el, c) => all(el).filter(e => e.classList.contains(c));
const byTag = (el, t) => all(el).filter(e => e.tagName === t.toUpperCase());
const one = (el, c) => byClass(el, c)[0];
const rowAt = (root, i) => byTag(root, 'tbody')[0].children[i];

global.document = { createElement: makeEl, querySelector: () => null };
global.requestAnimationFrame = fn => fn();
const model = require('../static/js/shared/table-model.js');
global.NovaTableModel = model;
global.NovaNodeRegistry = require('../static/js/shared/node-registry.js');

// ── 从 canvas.js 抽出表格节点代码求值 ──
const canvasSrc = fs.readFileSync(path.join(__dirname, '../static/js/canvas.js'), 'utf8');
const start = canvasSrc.indexOf('function novaTableModel(){');
const end = canvasSrc.indexOf('function defaultNodeSize(type){');
ok(start > 0 && end > start, '能定位表格节点代码段');
const block = canvasSrc.slice(start, end);

const connections = [];
const nodes = [];
const added = [];
const api = new Function(
    'document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl',
    'canvasPreviewImgHtml', 'canvasVideoPreviewHtml',
    block + '\nreturn {renderTableBody, addTableNode, ensureTableState, addTableColumn, addTableRow,' +
    ' deleteTableRow, toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth,' +
    ' ensureTableChannels, tableRowInputs, tableInputEntryAt, tableUpstreamTexts, toggleTableChannelMode,' +
    ' addTableInputChannel, tableNodeSignature, connectNodes, tableDropPortFor};'
)(
    global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); return n; }, () => {}, p => p + '_1',
    connections, nodes, () => {}, n => (n && n.mediaKind) || 'image', () => false,
    (url) => '<img src="' + url + '">', (url) => '<video src="' + url + '"></video>'
);

const keydown = key => ({ key, shiftKey:false, preventDefault(){}, stopPropagation(){} });

// ═══ A. 空表结构 ═══
const node = api.addTableNode();
const root = api.renderTableBody(node);
ok(root.classList.contains('table-node'), '根 class = table-node');
eq(node.table.columns, [], '新节点无数据列');
eq(byClass(root, 'table-input-column').length, 1, '默认 1 个输入列');
eq(one(root, 'table-input-label').textContent, '输入 1', '输入列表头文案');
eq(one(root, 'table-input-mode').textContent, '共享', '空通道默认共享');
eq(one(root, 'table-input-count').textContent, '0', '输入数为 0');
eq(one(root, 'table-node-count').textContent, '0 列 · 0 行', '计数文案');
eq(one(root, 'table-node-inputs').textContent, '1 个输入', '输入列计数文案');
eq(byClass(root, 'table-node-action').map(b => b.textContent), ['+ 输入列', '新增列', '新增行'], '信息条按钮');
eq(one(root, 'table-empty-cell').textContent, '点「新增列」开始建表', '空表引导');
// 列序：输入列 → 数据列 → 操作列
eq(byTag(root, 'th').length, 2, '表头：输入列 + 操作列（空表尚无数据列）');

// ═══ B. 素材连线进来 → 输入列 ═══
nodes.push({id:'img1', type:'image', url:'/a.png'});
nodes.push({id:'img2', type:'image', url:'/b.png'});
nodes.push({id:'img3', type:'image', url:'/c.png'});
['img1','img2','img3'].forEach(id => connections.push({id:'c_' + id, from:id, to:node.id}));
api.renderTableBody(node);
eq(byClass(root, 'table-input-column').length, 1, '仍然 1 个输入列');
eq(one(root, 'table-input-count').textContent, '3', '输入数 3');
eq(one(root, 'table-input-mode').textContent, '逐行', '3 个引用 → 自动逐行对应');

api.addTableColumn(node);
api.addTableRow(node);
api.addTableRow(node);
eq(byTag(root, 'tbody')[0].children.length, 2, '两行');
eq(byTag(root, 'tbody')[0].children[0].children.length, 3, '每行 = 1 输入列 + 1 数据列 + 1 操作列');
ok(rowAt(root, 0).children[0].classList.contains('table-media-cell'), '第 1 格是输入列');
ok(rowAt(root, 0).children[2].classList.contains('table-row-actions'), '最后一格是操作列');
eq(byClass(one(rowAt(root, 0), 'table-media-cell'), 'table-media-thumb')[0].innerHTML, '<img src="/a.png">', '第 1 行取第 1 个素材');
eq(byClass(one(rowAt(root, 1), 'table-media-cell'), 'table-media-thumb')[0].innerHTML, '<img src="/b.png">', '第 2 行取第 2 个素材');
eq(one(rowAt(root, 0), 'table-media-cell').dataset.channel, 'input-1', '输入格带 data-channel（toPort 落点用）');
eq(rowAt(root, 0).style.height, '144px', '有媒体 → 行高抬到 mediaMin 144');

// ═══ C. 文本节点只进提示词，不进输入列 ═══
nodes.push({id:'p1', type:'prompt', text:'一只猫'});
connections.push({id:'c_p1', from:'p1', to:node.id});
api.renderTableBody(node);
eq(one(root, 'table-input-count').textContent, '3', '文本节点不增加输入项');
eq(api.tableUpstreamTexts(node), ['一只猫'], '文本节点走 Ip(t)');
eq(api.tableRowInputs(node)[0].prompt, '一只猫', '空数据列时提示词只有上游文本');

// ═══ D. toPort 定位通道 ═══
nodes.push({id:'img4', type:'image', url:'/d.png'});
connections.push({id:'c_img4', from:'img4', to:node.id, toPort:'input-2'});
api.renderTableBody(node);
eq(byClass(root, 'table-input-column').length, 2, 'toPort=input-2 开出第 2 个输入列');
eq(one(root, 'table-input-count').textContent, '3', '第 1 列仍是 3 个');
const counts = byClass(root, 'table-input-count').map(c => c.textContent);
eq(counts, ['3', '1'], '第 2 列 1 个（共享）');
eq(api.ensureTableChannels(node)[1].id, 'input-2', '第 2 通道 id');

// ab() 语义
const ch1 = api.ensureTableChannels(node)[0];
eq(model.inputItemAt(ch1, 0).nodeId, 'img1', 'sequence 第 0 行 → img1');
eq(model.inputItemAt(ch1, 2).nodeId, 'img3', 'sequence 第 2 行 → img3');
eq(model.inputItemAt(ch1, 9), null, 'sequence 越界 → null');
const ch2 = api.ensureTableChannels(node)[1];
eq(model.inputItemAt(ch2, 0).nodeId, 'img4', 'shared 第 0 行 → 最后/唯一一个');
eq(model.inputItemAt(ch2, 99).nodeId, 'img4', 'shared 任何行都取最后一个');

// ═══ E. 模式切换 ═══
api.toggleTableChannelMode(node, 0);
eq(api.ensureTableChannels(node)[0].mode, 'shared', '手动切到共享');
api.toggleTableChannelMode(node, 0);
eq(api.ensureTableChannels(node)[0].mode, 'sequence', '再切回逐行');
eq(node.tableInputChannelModes['input-1'], 'sequence', '手动值被记住');

// ═══ F. 签名驱动重绘 ═══
const colBefore = byTag(root, 'colgroup')[0];
api.renderTableBody(node);
ok(byTag(root, 'colgroup')[0] === colBefore, '无变化时不重绘（保住编辑焦点）');
nodes.push({id:'img5', type:'image', url:'/e.png'});
connections.push({id:'c_img5', from:'img5', to:node.id});
api.renderTableBody(node);
ok(byTag(root, 'colgroup')[0] !== colBefore, '连线变化时重绘');
eq(one(root, 'table-input-count').textContent, '4', '重绘后输入数更新');
const sameEl = api.renderTableBody(node);
ok(sameEl === root, '始终复用同一个 DOM 根');

// ═══ G. 数据格编辑在重构后仍然可用 ═══
api.beginTableEdit(node, {kind:'cell', row:0, column:0});
const editor = byClass(root, 'table-cell-editor')[0];
ok(Boolean(editor), '双击后出现单元格编辑器');
editor.value = '一只狗';
editor.onkeydown(keydown('Enter'));
eq(node.table.rows[0][0], '一只狗', 'Enter 提交');
eq(byClass(root, 'table-cell-editor').length, 0, '提交后编辑器移除');
eq(api.tableRowInputs(node)[0].prompt, '一只猫\n一只狗', '行文本追加在提示词末尾');

// 列重命名
api.beginTableEdit(node, {kind:'column', column:0});
const headEditor = byClass(root, 'table-head-editor')[0];
headEditor.value = '提示词';
headEditor.onkeydown(keydown('Enter'));
eq(node.table.columns, ['提示词'], '列名提交');

// ═══ H. 选择 / 删行 / 宽度 ═══
api.toggleTableRow(node, 0, true);
eq(node.table.selectedRows, [0], '选中第 1 行');
eq(one(root, 'table-node-picked').textContent, '已选 1 行', '已选提示');
api.toggleAllTableRows(node, true);
eq(node.table.selectedRows, [0, 1], '全选');
api.deleteTableRow(node, 0);
eq(node.table.rows.length, 1, '删行');
// 删掉第 1 行后，原来的第 2 行顺位变成第 0 行并继承选中
eq(node.table.selectedRows, [0], '删行后选中顺位');
eq(one(root, 'table-node-picked').textContent, '已选 1 行', '剩余行仍保持选中');
api.toggleTableRow(node, 0, false);
eq(one(root, 'table-node-picked'), undefined, '取消选择后不再显示已选');
// 删列不影响行选中（回归：曾按列数过滤行号）
const probe = model.normalizeTable({columns:['a'], rows:[['1'],['2'],['3']]}).table;
probe.selectedRows = [0, 1, 2];
eq(model.applyOperation(probe, 'delete_column', {column:1}).selectedRows, [0, 1, 2], '删列后行选中不变');
api.syncTableNodeWidth(node);
eq(node.w, model.nodeSize(node.table, 2).width + 24, '节点宽按表格宽 + 内边距（含输入列）');

// ═══ I. 提示词组装与悬空引用 ═══
eq(model.buildRowPrompt(['上游'], '节点提示', '行文本'), '上游\n节点提示\n行文本', 'jf 三段拼接');
eq(model.buildRowPrompt(['', '  '], '', ''), '', '全空 → 空串');
eq(model.danglingMentions('@图片1', [{kind:'image'}]).length, 0, '引用能对上');
eq(model.danglingMentions('@图片5', [{kind:'image'}]).length, 1, '越界引用报出');
eq(model.danglingMentions('@视频1', [{kind:'image'}]).length, 1, '类型不符报出');
eq(model.mentionTokenAt('video', 2), '@视频2', 'mention 文案');
eq(model.channelModeFor([]), 'shared', '0 个 → 共享');
eq(model.channelModeFor([1, 2]), 'sequence', '>1 个 → 逐行');
eq(model.normalizeChannels('bad'), [], '非法通道输入 → 空');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
