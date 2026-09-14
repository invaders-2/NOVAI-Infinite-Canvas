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
const missingUrls = new Set();
const api = new Function(
    'document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl',
    'canvasPreviewImgHtml', 'canvasVideoPreviewHtml',
    block + '\nreturn {renderTableBody, addTableNode, ensureTableState, addTableColumn, addTableRow,' +
    ' deleteTableRow, toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth,' +
    ' ensureTableChannels, tableRowInputs, tableInputEntryAt, tableUpstreamTexts, toggleTableChannelMode,' +
    ' addTableInputChannel, tableNodeSignature, connectNodes, tableDropPortFor,' +
    ' generatorUpstreamTables, renderTableBatchPanel, paintTableBatchPanel, tableRowRefs, tableRowMaterialIssues};'
)(
    // addNode 必须把节点放进 nodes：真实实现如此，generatorUpstreamTables 要从 nodes 反查表格
    global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); nodes.push(n); return n; }, () => {}, p => p + '_1',
    connections, nodes, () => {}, n => (n && n.mediaKind) || 'image', url => missingUrls.has(url),
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


// ═══ J. 批量面板（DX OS §10：挂在生成节点上） ═══
const genNode = {id:'gen1', type:'generator'};
nodes.push(genNode);
eq(api.renderTableBatchPanel(genNode), null, '无上游表格 → 不渲染批量面板');

connections.push({id:'c_tbl_gen', from:node.id, to:genNode.id});
eq(api.generatorUpstreamTables(genNode.id).map(t => t.id), [node.id], '认得上游表格');

const panel = api.renderTableBatchPanel(genNode);
ok(panel && panel.classList.contains('table-batch-panel'), '上游有表格 → 渲染批量面板');
eq(one(panel, 'table-batch-title').textContent, '多维表格批量', '面板标题');
const rowData2 = api.tableRowInputs(node);
const metaText = one(panel, 'table-batch-meta').textContent;
ok(metaText.indexOf(rowData2.length + ' 行') === 0, '面板显示行数：' + metaText);
ok(metaText.indexOf('可执行 1') >= 0, '面板显示可执行行数：' + metaText);

const startInput = one(panel, 'table-batch-input');
eq(startInput.value, '1', '起始行默认 1');
const selects = byTag(panel, 'select');
eq(selects.length, 2, '两个下拉（并发 / 出错策略）');
eq(selects[0].children.length, model.MAX_BATCH_CONCURRENCY, '并发选项 1..8');
eq(selects[0].value, String(model.DEFAULT_BATCH_CONCURRENCY), '并发默认 3');
eq(selects[1].value, 'continue', '出错策略默认「继续跑完」');
ok(Boolean(one(panel, 'table-checkbox')), '有独立运行勾选框');

const runButton = one(panel, 'table-batch-run');
eq(runButton.textContent, '批量生成', '按钮文案');
eq(runButton.disabled, false, '有可执行行 → 按钮可用');
eq(byClass(panel, 'table-node-action')[0].disabled, true, '没有 journal 时「恢复上次」禁用');

// 控件改动落到表格节点
startInput.value = '2'; startInput.onchange();
eq(node.tableBatchStartRow, 1, '起始行被夹到行数范围内（当前共 1 行）');
selects[0].value = '5'; selects[0].onchange();
eq(node.tableBatchConcurrency, 5, '并发写入表格节点');
selects[1].value = 'stop'; selects[1].onchange();
eq(node.tableBatchFailurePolicy, 'stop', '出错策略写入表格节点');
one(panel, 'table-checkbox').checked = true; one(panel, 'table-checkbox').onchange();
eq(node.tableBatchManualSelection, true, '独立运行开关写入表格节点');

// 手动模式下没勾选行 → 不可执行
const panel2 = api.renderTableBatchPanel(genNode);
ok(one(panel2, 'table-batch-meta').textContent.indexOf('可执行 0') >= 0, '手动模式未勾选 → 可执行 0');
eq(one(panel2, 'table-batch-run').disabled, true, '→ 按钮禁用');
api.toggleTableRow(node, 0, true);
const panel3 = api.renderTableBatchPanel(genNode);
ok(one(panel3, 'table-batch-meta').textContent.indexOf('可执行 1') >= 0, '勾选该行后恢复可执行 1');
eq(one(panel3, 'table-batch-run').disabled, false, '按钮恢复可用');

// 运行中的按钮文案
node.tableBatchRunning = true;
eq(one(api.renderTableBatchPanel(genNode), 'table-batch-run').textContent, '批量生成中…', '运行中按钮文案');
eq(one(api.renderTableBatchPanel(genNode), 'table-batch-run').disabled, true, '运行中按钮禁用');
node.tableBatchRunning = false;

// 行参考图与素材校验
const refs = api.tableRowRefs(rowData2[0]);
eq(refs.length, rowData2[0].media.length, '参考图数量与行媒体一致');
eq(refs[0].url, '/a.png', '首个参考图 url');
eq(refs[0].kind, 'image', '参考图类型');
ok(Boolean(refs[0].name), '参考图有名字');
eq(api.tableRowMaterialIssues(rowData2[0]), [], '素材齐全 → 无问题');
missingUrls.add('/gone.png');
const brokenRow = {rowNumber:9, media:[{url:'/gone.png', nodeId:'g', kind:'image'}]};
eq(api.tableRowMaterialIssues(brokenRow).length, 1, '缺文件的素材被挑出');
eq(api.tableRowMaterialIssues(brokenRow)[0].reason, 'missing', '缺失原因');
eq(api.tableRowMaterialIssues(brokenRow)[0].rowNumber, 9, '缺文件的行号');
missingUrls.delete('/gone.png');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
