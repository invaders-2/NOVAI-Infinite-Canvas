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
        appendChild(child){ child.parentElement = el; child.parentNode = el; el.children.push(child); return child; },
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
        toggle(c, force){
            const on = force === undefined ? !el.classList.contains(c) : Boolean(force);
            on ? el.classList.add(c) : el.classList.remove(c);
            return on;
        },
    };
    return el;
}
const all = el => { const out = []; const rec = e => { out.push(e); (e.children || []).forEach(rec); }; rec(el); return out; };
const byClass = (el, c) => all(el).filter(e => e.classList.contains(c));
const byTag = (el, t) => all(el).filter(e => e.tagName === t.toUpperCase());
const one = (el, c) => byClass(el, c)[0];
const rowAt = (root, i) => byTag(root, 'tbody')[0].children[i];

global.document = {
    createElement: makeEl,
    querySelector: () => null,
    // 文本节点：只要有 textContent / children 就够 shim 用
    createTextNode: text => ({
        nodeType: 3, textContent: String(text), children: [], parentNode: null,
        classList: {contains: () => false, add(){}, remove(){}, toggle(){ return false; }},
    }),
};
global.window = {};
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
let uidSeq = 0;
// 极简 nodesEl：让 repaintBatchPanel 能找到生成节点的面板，用于验证跨节点重绘
const panelHosts = new Map();
const nodesEl = {
    querySelector(selector){
        const matched = /\.node\[data-id="([^"]+)"\]/.exec(selector);
        if(!matched) return null;
        const panel = panelHosts.get(matched[1]);
        if(!panel) return null;
        return { querySelector(inner){ return inner === '[data-table-batch-panel]' ? panel : null; } };
    }
};
// 运行器垫片：记录批量执行到底把哪一行、哪份覆盖传给了谁
let iconRefreshes = 0;
const batchCalls = [];
let videoShimMode = 'ok';
const runVideoShim = (id, opts) => {
    batchCalls.push({id, opts});
    if(videoShimMode === 'fail') throw new Error('{"error":{"message":"Agnes rate limit: free users"}}');
    return 'via-runVideoNode';
};
const runGeneratorShim = (id, opts) => { batchCalls.push({id, opts}); return 'via-runGenerator'; };

const api = new Function(
    'document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl',
    'canvasPreviewImgHtml', 'canvasVideoPreviewHtml', 'nowMs', 'tr', 'nodesEl',
    'runVideoNode', 'runGenerator', 'window', 'saveCanvas', 'refreshIcons',
    'outputUrlValue', 'mediaKindForRef',
    block + '\nreturn {renderTableBody, repaintTable, addTableNode, ensureTableState, addTableColumn, addTableRow,' +
    ' deleteTableRow, toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth,' +
    ' ensureTableChannels, tableRowInputs, tableInputEntryAt, tableUpstreamTexts, toggleTableChannelMode,' +
    ' addTableInputChannel, removeTableInputChannel, deleteTableColumn, tableNodeSignature, connectNodes, tableDropPortFor,' +
    ' generatorUpstreamTables, renderTableBatchPanel, paintTableBatchPanel, tableRowRefs, tableRowMaterialIssues,' +
    ' llmMediaGroups, llmListInputs, llmRunButtonLabel, materializeLlmTable, tableSourceItems,' +
    ' tableBatchRunButtonHtml, tableBatchSingleLabel, tableBatchSingleButtonHtml, tableDrivenHidden, paintTableBatchPanel,' +
    ' normalizeTableNodeHeight, tableNaturalSize,' +
    ' setTableCellMedia, tableManualInputItem, setTableManualInputItem, addTableManualInputItem, replaceTableManualInputItem, renderTableCellText, normalizeContentHeightNode,' +
    ' tableBatchConcurrencyFor, tableBatchRunner, runTableBatch,' +
    ' generatorNeedsPromptMessage, friendlyBatchError,' +
    ' llmOutputModeButtonsHtml, LLM_OUTPUT_MODE_BUTTONS, TABLE_DELETE_COLUMN_WIDTH};'
)(
    // addNode 必须把节点放进 nodes：真实实现如此，generatorUpstreamTables 要从 nodes 反查表格
    global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); nodes.push(n); return n; }, () => {}, p => p + '_' + (uidSeq += 1),
    connections, nodes, () => {}, n => (n && n.mediaKind) || 'image', url => missingUrls.has(url),
    (url) => '<img src="' + url + '">', (url) => '<video src="' + url + '"></video>', () => 1700000000000,
    key => ({'canvas.apiGenerate':'API生成', 'canvas.generating':'生成中', 'canvas.videoGenerate':'生成视频'})[key] || key,
    nodesEl,
    runVideoShim, runGeneratorShim, global.window, () => {},
    () => { iconRefreshes += 1; },
    // 输出节点的媒体在 images 里，url 要从条目上取；类型看 url
    item => (typeof item === 'string' ? item : (item && item.url) || ''),
    ref => {
        // 和真实现一致：显式 kind 优先，没有才看后缀
        const declared = String((ref && ref.kind) || '').toLowerCase();
        if(['video','audio','image','text','file'].includes(declared)) return declared;
        const url = String((ref && ref.url) || ref || '');
        if(/\.(mp4|webm|mov|m4v)$/i.test(url)) return 'video';
        if(/\.(mp3|wav|m4a)$/i.test(url)) return 'audio';
        if(/\.(txt|json|csv|md)$/i.test(url)) return 'text';
        return 'image';
    }
);

const keydown = key => ({ key, shiftKey:false, preventDefault(){}, stopPropagation(){} });

// ═══ A. 空表结构 ═══
const node = api.addTableNode();
const root = api.renderTableBody(node);
ok(root.classList.contains('table-node'), '根 class = table-node');
eq(node.table.columns, [], '新节点无数据列');
eq(byClass(root, 'table-input-column').length, 1, '默认 1 个输入列');
eq(one(root, 'table-input-label').textContent, '输入 1', '输入列表头文案');
eq(one(root, 'table-input-mode').textContent, '沿用', '空通道默认沿用');
eq(one(root, 'table-input-count').textContent, '0', '输入数为 0');
eq(one(root, 'table-node-count').textContent, '0 列 · 0 行', '计数文案');
eq(one(root, 'table-node-inputs').textContent, '1 个输入', '输入列计数文案');
eq(byClass(root, 'table-node-action').map(b => b.textContent), ['+ 输入列', '新增列', '新增行'], '信息条按钮');
eq(one(root, 'table-empty-cell').textContent, '点「新增列」开始建表', '空表引导');
// 列序：输入列 → 数据列 → 操作列
eq(byTag(root, 'th').length, 3, '表头：输入列 + 选择列 + 删除列（空表尚无数据列）');
eq(byClass(root, 'table-delete-cell').filter(e => e.tagName === 'TH')[0].textContent, '删除行', '删除列表头文案');

// ═══ B. 素材连线进来 → 输入列 ═══
nodes.push({id:'img1', type:'image', url:'/a.png'});
nodes.push({id:'img2', type:'image', url:'/b.png'});
nodes.push({id:'img3', type:'image', url:'/c.png'});
['img1','img2','img3'].forEach(id => connections.push({id:'c_' + id, from:id, to:node.id}));
api.renderTableBody(node);
eq(byClass(root, 'table-input-column').length, 1, '仍然 1 个输入列');
eq(one(root, 'table-input-count').textContent, '3', '输入数 3');
eq(one(root, 'table-input-mode').textContent, '沿用', '参考栏默认沿用（一行一张）');

api.addTableColumn(node);
api.addTableRow(node);
api.addTableRow(node);
/* 参考栏默认「沿用」（一行一张）；这一节要验的是「逐行」的 1:1 落格，显式切过去。 */
node.tableInputChannelModes = {'input-1': 'sequence'};
api.renderTableBody(node);
eq(byTag(root, 'tbody')[0].children.length, 2, '两行');
eq(byTag(root, 'tbody')[0].children[0].children.length, 4, '每行 = 输入列 + 数据列 + 选择列 + 删除列');
ok(rowAt(root, 0).children[0].classList.contains('table-media-cell'), '第 1 格是输入列');
ok(rowAt(root, 0).children[2].classList.contains('table-row-actions'), '倒数第二格是选择列');
ok(rowAt(root, 0).children[3].classList.contains('table-delete-cell'), '最后一格是删除列');
eq(one(rowAt(root, 0).children[2], 'table-row-delete'), undefined, '选择列里没有删行按钮了');
const delBtn = one(rowAt(root, 0).children[3], 'table-row-delete');
eq(delBtn.textContent, '', '删除列里是图标按钮，没有文字');
eq(delBtn.children.length, 1, '图标按钮里只有一个元素');
eq(delBtn.children[0].tagName, 'I', '图标是 lucide 的 <i data-lucide>');
eq(delBtn.children[0].dataset.lucide, 'trash-2', '用的是垃圾桶图标');
eq(delBtn.title, '删除这一行', '图标按钮带 title 说明');
eq(byClass(rowAt(root, 0).children[3], 'table-checkbox').length, 0, '删除列里没有勾选框');
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

// ═══ E. 模式切换（逐行 → 全部 → 沿用 → 逐行） ═══
/* 参考栏默认「沿用」：一行一张，素材多出来时不再自动切「全部」。 */
delete node.tableInputChannelModes['input-1'];
eq(api.ensureTableChannels(node)[0].mode, 'shared', '参考栏默认沿用');
// 手动值优先于自动推导，切换循环也只走手动值
node.tableInputChannelModes = node.tableInputChannelModes || {};
node.tableInputChannelModes['input-1'] = 'sequence';
eq(api.ensureTableChannels(node)[0].mode, 'sequence', '手动「逐行」优先');
api.toggleTableChannelMode(node, 0);
eq(api.ensureTableChannels(node)[0].mode, 'all', '切到「全部」（每行整组）');
api.toggleTableChannelMode(node, 0);
eq(api.ensureTableChannels(node)[0].mode, 'shared', '切到「沿用」');
api.toggleTableChannelMode(node, 0);
eq(api.ensureTableChannels(node)[0].mode, 'sequence', '循环回逐行');
eq(node.tableInputChannelModes['input-1'], 'sequence', '手动值被记住');
// 全部模式：每一行都拿到整列
{
  const nodes2 = api.ensureTableChannels(node)[0];
  const before = nodes2.mode;
  node.tableInputChannelModes['input-1'] = 'all';
  const items0 = api.tableRowInputs(node)[0].channelItems[0].map(e => e.nodeId);
  eq(items0.length, 3, '「全部」模式下第 1 行拿到整列（此刻连了 3 张）');
  eq(items0, ['img1','img2','img3'], '整列内容与顺序');
  node.tableBatchStartRow = 1;
  const allMedia = api.tableRowInputs(node)[0].media.map(e => e.nodeId);
  ok(allMedia.length >= 3, '「全部」模式下该行 media 至少含整列：' + JSON.stringify(allMedia));
  node.tableInputChannelModes['input-1'] = before;
}

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

// ═══ F2. 输入列「内容」变了也要重绘（素材晚到才有 url / 分组增删素材）═══
/* 这是「图片数量对不上」的根因：入边、行列数都没变，只有条目变了。
   只比连线的话签名不变 → 表格永远不重绘，表头写 4 张、格子里只有 2 张。 */
{
  const colBefore2 = byTag(root, 'colgroup')[0];
  const img1 = nodes.find(n => n.id === 'img1');
  const savedUrl = img1.url;
  img1.url = '';                       // 模拟这张图还没跑完 / 拿不到 url
  api.renderTableBody(node);
  ok(byTag(root, 'colgroup')[0] !== colBefore2, '输入列条目变化时必须重绘（不能只比连线）');
  eq(one(root, 'table-input-count').textContent, '3', '少一张时表头数字跟着变');
  img1.url = savedUrl;
  api.renderTableBody(node);
  eq(one(root, 'table-input-count').textContent, '4', '素材回来后数字恢复');
}
/* 参考栏默认沿用 → 一行一张；表头数字仍是整列张数（不代表每行都用得上）。
   模式变了也必须自己重绘（签名里带模式），不能靠调用方显式 repaintTable。 */
{
  const savedMode = node.tableInputChannelModes['input-1'];
  node.tableInputChannelModes['input-1'] = 'all';
  api.renderTableBody(node);
  eq(one(byClass(root, 'table-input-head')[0], 'table-input-mode').textContent, '全部', '模式变化触发重绘（表头文案更新）');
  eq(one(root, 'table-input-count').textContent, '4', '表头数字是整列张数');
  node.tableInputChannelModes['input-1'] = 'shared';
  api.renderTableBody(node);
  eq(one(byClass(root, 'table-input-head')[0], 'table-input-mode').textContent, '沿用', '切回沿用同样立刻生效');
  node.tableInputChannelModes['input-1'] = savedMode;
  api.renderTableBody(node);
}

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

// ═══ H. 勾选 / 删行 / 宽度（勾选语义＝默认全选） ═══
eq(node.table.selectedRows, [0, 1], '新增行默认全选');
eq(one(root, 'table-node-picked'), undefined, '全选时不显示勾选提示（默认状态没信息量）');
api.toggleTableRow(node, 0, false);
eq(node.table.selectedRows, [1], '取消第 1 行');
eq(one(root, 'table-node-picked').textContent, '已勾选 1/2', '取消一部分后才显示');
api.toggleAllTableRows(node, true);
eq(node.table.selectedRows, [0, 1], '全选');
api.deleteTableRow(node, 0);
eq(node.table.rows.length, 1, '删行');
// 删掉第 1 行后，原来的第 2 行顺位变成第 0 行并继承选中
eq(node.table.selectedRows, [0], '删行后选中顺位');
eq(one(root, 'table-node-picked'), undefined, '只剩 1 行且已勾选 → 不显示提示');
api.toggleTableRow(node, 0, false);
eq(one(root, 'table-node-picked'), undefined, '取消选择后不再显示已选');
// 删列不影响行选中（回归：曾按列数过滤行号）
const probe = model.normalizeTable({columns:['a'], rows:[['1'],['2'],['3']]}).table;
probe.selectedRows = [0, 1, 2];
eq(model.applyOperation(probe, 'delete_column', {column:1}).selectedRows, [0, 1, 2], '删列后行选中不变');
api.syncTableNodeWidth(node);
eq(node.w, model.nodeSize(node.table, 2).width + api.TABLE_DELETE_COLUMN_WIDTH + 24, '节点宽 = 输入列 + 数据列 + 选择列 + 删除列 + 内边距');

// ═══ I. 提示词组装与悬空引用 ═══
eq(model.buildRowPrompt(['上游'], '节点提示', '行文本'), '上游\n节点提示\n行文本', 'jf 三段拼接');
eq(model.buildRowPrompt(['', '  '], '', ''), '', '全空 → 空串');
eq(model.danglingMentions('@图片1', [{kind:'image'}]).length, 0, '引用能对上');
eq(model.danglingMentions('@图片5', [{kind:'image'}]).length, 1, '越界引用报出');
eq(model.danglingMentions('@视频1', [{kind:'image'}]).length, 1, '类型不符报出');
eq(model.mentionTokenAt('video', 2), '@视频2', 'mention 文案');
eq(model.channelModeFor([]), 'shared', '0 个 → 共享');
eq(model.channelModeFor([1, 2]), 'shared', '>1 个 → 沿用（参考栏默认一行一张）');
eq(model.normalizeChannels('bad'), [], '非法通道输入 → 空');


// ═══ J. 批量面板（DX OS §10：挂在生成节点上） ═══
const genNode = {id:'gen1', type:'generator'};
nodes.push(genNode);
eq(api.renderTableBatchPanel(genNode), null, '无上游表格 → 不渲染批量面板');
eq(api.tableBatchRunButtonHtml(genNode), '', '无上游表格 → 主按钮位不加批量按钮');
eq(api.tableBatchSingleLabel(genNode), 'API生成', '无上游表格 → 主按钮文案不变');
eq(api.tableDrivenHidden(genNode), '', '无上游表格 → 不隐藏 IMAGES 区块');

connections.push({id:'c_tbl_gen', from:node.id, to:genNode.id});
eq(api.generatorUpstreamTables(genNode.id).map(t => t.id), [node.id], '认得上游表格');

const panel = api.renderTableBatchPanel(genNode);
ok(panel && panel.classList.contains('table-batch-panel'), '上游有表格 → 渲染批量面板');
eq(api.tableBatchSingleLabel(genNode), '单张生成', '有上游表格 → 主按钮改成「单张生成」');
ok(api.tableBatchRunButtonHtml(genNode).indexOf('批量生成') > 0, '有上游表格 → 主按钮位加「批量生成」');
// IMAGES 区块：表格驱动时隐藏（.input-list 是 display:flex，只能用内联样式压）
eq(api.tableDrivenHidden(genNode), ' style="display:none"', '有上游表格 → 隐藏节点自己的 IMAGES 区块');

eq(one(panel, 'table-batch-title').textContent, '生成输入', '面板标题按规范叫「生成输入」');
const rowData2 = api.tableRowInputs(node);
const statusText = one(panel, 'table-batch-status').textContent;
ok(statusText.indexOf('批量 ' + rowData2.length + ' 行') >= 0, '状态行显示总行数：' + statusText);
ok(statusText.indexOf('首批 ') >= 0, '状态行显示首批并发数：' + statusText);
ok(statusText.indexOf('图片 ') >= 0, '状态行显示素材张数：' + statusText);

// 行列表：行号 + 参考图 + 该行真正会发出去的提示词
const rowArticles = byClass(panel, 'table-batch-row');
eq(rowArticles.length, rowData2.length, '行列表条数 = 表格行数');
eq(one(rowArticles[0], 'table-batch-row-num').textContent, '1', '行号徽标');
eq(one(rowArticles[0], 'table-batch-row-media').children.length, rowData2[0].media.length, '缩略图数 = 该行参考图数');
eq(rowArticles[0].children[2].textContent, rowData2[0].prompt, '提示词预览 = 该行真正会发出去的提示词');
eq(rowArticles[0].children[3].type, 'checkbox', '勾选框在最右（与表格里一致）');
// 默认全选：每行前面都有勾选框且默认勾上
api.toggleAllTableRows(node, true);
const rowArticles2 = byClass(api.renderTableBatchPanel(genNode), 'table-batch-row');
eq(byClass(rowArticles2[0], 'table-checkbox').length, 1, '每行一个勾选框');
eq(one(rowArticles2[0], 'table-checkbox').checked, true, '行勾选框默认勾上（默认全选）');
eq(rowArticles2.every(a => one(a, 'table-checkbox').checked), true, '所有行都默认勾上');
eq(node.table.selectedRows, [0], '数据模型里也是全选');
// 取消一行 → 该行不参与执行
one(rowArticles2[0], 'table-checkbox').checked = false;
one(rowArticles2[0], 'table-checkbox').onchange({ stopPropagation(){} });
eq(node.table.selectedRows, [], '取消勾选写回数据模型');
eq(model.batchRowsToRun(rowData2, {startRow:1, selectedRows:node.table.selectedRows}).length, 0, '取消勾选的行不参与执行');
ok(one(api.renderTableBatchPanel(genNode), 'table-batch-status').textContent.indexOf('已勾选 0/1') >= 0, '状态行显示已勾选 0/1');
// 勾回来
api.toggleTableRow(node, 0, true);
eq(model.batchRowsToRun(api.tableRowInputs(node), {startRow:1, selectedRows:node.table.selectedRows}).length, 1, '勾回来后又参与执行');

/* @图片N 重编号验证。
   此刻全局清单：ch0=[img1,img2,img3,img5]（序号 1-4，逐行模式）、ch1=[img4]（序号 5，共享模式）。
   第 0 行实际拿到 [img1, img4] → 行内序号 1 和 2。 */
node.table.rows[0][0] = '把 @图片5 换成新的';
const rewritten = api.tableRowInputs(node)[0];
eq(rewritten.media.map(e => e.nodeId), ['img1', 'img4'], '第 0 行实际参考图');
ok(rewritten.prompt.indexOf('@图片2') > 0, '全局序号 @图片5 → 行内 @图片2：' + rewritten.prompt);
ok(rewritten.prompt.indexOf('@图片5') < 0, '不再残留全局序号');
eq(rewritten.danglingMentions, [], '没有悬空引用');
// @图片4 是 img5，本行逐行模式不含它 —— 必须被报成悬空，不能静默发出去
node.table.rows[0][0] = '把 @图片4 换掉';
const danglingRow = api.tableRowInputs(node)[0];
eq(danglingRow.danglingMentions.map(d => d.token), ['@图片4'], '引用本行拿不到的素材 → 报悬空');
eq(danglingRow.danglingMentions[0].reason, 'missing', '悬空原因');
node.table.rows[0][0] = '一只狗';

// 跨节点同步：在表格里取消勾选，生成面板的候选行要跟着变（只重绘表格会显示过期勾选）
api.toggleAllTableRows(node, true);
const panelSync = api.renderTableBatchPanel(genNode);
panelHosts.set('gen1', panelSync);
eq(one(byClass(panelSync, 'table-batch-row')[0], 'table-checkbox').checked, true, '同步前：面板行已勾选');
api.toggleTableRow(node, 0, false);
eq(node.table.selectedRows.indexOf(0), -1, '表格里取消了下标 0');
eq(one(byClass(panelSync, 'table-batch-row')[0], 'table-checkbox').checked, false, '生成面板同步取消候选');
api.toggleTableRow(node, 0, true);
eq(one(byClass(panelSync, 'table-batch-row')[0], 'table-checkbox').checked, true, '再勾上 → 面板同步恢复');

// 点整行 = 切换该行勾选
node.table.selectedRows = [];
const articlesNow = byClass(api.renderTableBatchPanel(genNode), 'table-batch-row');
eq(node.table.selectedRows, [], '点之前未勾选');
articlesNow[0].onclick({ stopPropagation(){} });
eq(node.table.selectedRows, [0], '点整行 → 勾选该行');
const panelPicked = api.renderTableBatchPanel(genNode);
eq(byClass(panelPicked, 'table-batch-row')[0].classList.contains('is-selected'), true, '选中行带 is-selected');
byClass(panelPicked, 'table-batch-row')[0].onclick({ stopPropagation(){} });
eq(node.table.selectedRows, [], '再点一下 → 取消勾选');

const startInput = one(panel, 'table-batch-input');
eq(startInput.value, '1', '起始行默认 1');
const selects = byTag(panel, 'select');
eq(selects.length, 2, '两个下拉（并发 / 出错策略）');
eq(selects[0].children.length, model.MAX_BATCH_CONCURRENCY, '并发选项 1..8');
eq(selects[0].value, String(model.DEFAULT_BATCH_CONCURRENCY), '并发默认 3');
eq(selects[1].value, 'continue', '出错策略默认「继续跑完」');
ok(Boolean(one(panel, 'table-batch-manual-box')), '有独立运行勾选框');

// 「批量生成」已上移到主按钮位，面板里只剩「恢复上次」
eq(byClass(panel, 'table-node-action').length, 1, '面板操作区只剩一个按钮');
eq(byClass(panel, 'table-node-action')[0].textContent, '恢复上次', '剩下的是「恢复上次」');
eq(byClass(panel, 'table-node-action')[0].disabled, true, '没有 journal 时「恢复上次」禁用');

// 控件改动落到表格节点
startInput.value = '2'; startInput.onchange();
eq(node.tableBatchStartRow, 1, '起始行被夹到行数范围内（当前共 1 行）');
selects[0].value = '5'; selects[0].onchange();
eq(node.tableBatchConcurrency, 5, '并发写入表格节点');
selects[1].value = 'stop'; selects[1].onchange();
eq(node.tableBatchFailurePolicy, 'stop', '出错策略写入表格节点');
one(panel, 'table-batch-manual-box').checked = true; one(panel, 'table-batch-manual-box').onchange();
eq(node.tableBatchManualSelection, true, '独立运行开关写入表格节点');

// 独立运行模式下状态行显示已选数量
node.table.selectedRows = [];
const panel2 = api.renderTableBatchPanel(genNode);
ok(one(panel2, 'table-batch-status').textContent.indexOf('独立运行 · 已勾选 0/1') >= 0, '独立运行显示已勾选 0/1：' + one(panel2, 'table-batch-status').textContent);
api.toggleTableRow(node, 0, true);
const panel3 = api.renderTableBatchPanel(genNode);
ok(one(panel3, 'table-batch-status').textContent.indexOf('独立运行 · 已勾选 1/1') >= 0, '勾选后显示已勾选 1/1');
api.toggleTableRow(node, 0, false);

// 起始行：改成 2 之后，行列表只显示第 2 行起
api.addTableRow(node);
api.addTableRow(node);
eq(node.table.rows.length, 3, '补到 3 行');
node.tableBatchManualSelection = false;
node.tableBatchStartRow = 2;
const panelStart = api.renderTableBatchPanel(genNode);
eq(byClass(panelStart, 'table-batch-row-num').map(b => b.textContent), ['2', '3'], '起始行 2 → 隐藏第 1 行');
const startStatus = one(panelStart, 'table-batch-status').textContent;
ok(startStatus.indexOf('批量 2 行') >= 0, '状态行按可见行数：' + startStatus);
ok(startStatus.indexOf('已从第 2 行起') >= 0, '状态行提示从第几行起：' + startStatus);
// 独立运行要靠列表勾选，必须能看到全部行
node.tableBatchManualSelection = true;
const panelManual = api.renderTableBatchPanel(genNode);
eq(byClass(panelManual, 'table-batch-row-num').map(b => b.textContent), ['1', '2', '3'], '独立运行 → 显示全部行供勾选');
ok(one(panelManual, 'table-batch-status').textContent.indexOf('已从第') < 0, '独立运行不显示起始行提示');
// 起始行回到 1 → 全部显示
node.tableBatchManualSelection = false;
node.tableBatchStartRow = 1;
eq(byClass(api.renderTableBatchPanel(genNode), 'table-batch-row-num').map(b => b.textContent), ['1','2','3'], '起始行 1 → 全部显示');
// 勾选仍按原始行下标，不会因为隐藏而错位
node.tableBatchStartRow = 2;
node.table.selectedRows = [];
const panelPick = api.renderTableBatchPanel(genNode);
byClass(panelPick, 'table-batch-row')[0].onclick({ stopPropagation(){} });
eq(node.table.selectedRows, [1], '隐藏第 1 行后，点列表第一项勾的是第 2 行（下标 1）');
node.table.selectedRows = node.table.rows.map((row, index) => index);
node.tableBatchStartRow = 1;

// 尺寸语义：默认随内容；字号不缩放；表格区不设高度上限；手动拉过不被覆盖
{
    const sized = api.addTableNode();
    api.ensureTableState(sized);
    api.addTableColumn(sized);
    api.addTableRow(sized);
    const sizedRoot = api.renderTableBody(sized);
    const natural = model.nodeSize(sized.table, 1).width + api.TABLE_DELETE_COLUMN_WIDTH;
    api.syncTableNodeWidth(sized);
    eq(sized.w, natural + 24, '默认宽度 = 表格本体宽（含删除列）+ 内边距');
    eq(sizedRoot.style.zoom, undefined, '不做整体缩放（字号不该跟着变）');
    eq(sizedRoot.style.fontSize, undefined, '不覆写字号');
    eq(one(sizedRoot, 'table-node-grid').style.maxHeight, undefined, '表格区不设高度上限 → 行数自然全显示');
    // 用户手动拉宽后，重绘不再把它覆盖回去
    sized.tableWidthUserSet = true;
    sized.w = 999;
    api.syncTableNodeWidth(sized);
    eq(sized.w, 999, '手动拉过宽度 → 重绘不覆盖');
    sized.tableWidthUserSet = false;
    api.syncTableNodeWidth(sized);
    eq(sized.w, natural + 24, '没手动拉过 → 仍按本体宽（含删除列）同步');
}

// 历史固定高度清理（行少时底部留白的根因）
{
    const legacy = {type:'table', h:720};
    eq(api.normalizeTableNodeHeight(legacy), true, '历史固定高度被清掉');
    eq(legacy.h, undefined, 'h 已删除 → 改为随内容高度');
    const resized = {type:'table', h:500, tableHeightUserSet:true};
    eq(api.normalizeTableNodeHeight(resized), false, '用户手动拉过高度的 → 保留');
    eq(resized.h, 500, '手动设的高度不被清掉');
    eq(api.normalizeTableNodeHeight({type:'table'}), false, '没有 h → 不动');
    const other = {type:'image', h:300};
    eq(api.normalizeTableNodeHeight(other), false, '非表格节点不动');
    eq(other.h, 300, '其他节点高度不受影响');
    eq(api.normalizeTableNodeHeight(null), false, '空节点不炸');
}

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


// ═══ K. LLM → 表格（list 模式：媒体组 / 物化 / 按钮文案） ═══
{
    const llm = {id:'llm1', type:'llm', x:1000, y:100, w:420, llmOutputMode:'list'};
    const imgA = {id:'imgA', type:'image', url:'/a.png', name:'A'};
    const grp = {id:'grp1', type:'group', items:['imgB','imgC']};
    const imgB = {id:'imgB', type:'image', url:'/b.png'};
    const imgC = {id:'imgC', type:'image', url:'/c.png'};
    const promptNode = {id:'p9', type:'prompt', text:'拆解脚本'};
    nodes.push(llm, imgA, grp, imgB, imgC, promptNode);
    connections.push({id:'x1', from:'imgA', to:'llm1'});
    connections.push({id:'x2', from:'grp1', to:'llm1'});
    connections.push({id:'x3', from:'p9', to:'llm1'});

    eq(api.tableSourceItems(promptNode), [], '文本节点不是素材');
    eq(api.tableSourceItems(grp).map(i => i.nodeId), ['imgB','imgC'], 'group 展开成成员素材');
    eq(api.tableSourceItems(null), [], '空来源 → 无素材');

    const groups = api.llmMediaGroups(llm);
    eq(groups.length, 2, '两组素材（group 算一组、文本节点不计）');
    eq(groups[0].sourceId, 'imgA', '第一组来源是单图');
    eq(groups[1].sourceId, 'grp1', '第二组来源是 group');
    eq(groups[1].entries.map(e => e.nodeId), ['imgB','imgC'], 'group 组内成员');
    eq(api.llmListInputs(llm).map(e => e.nodeId), ['imgA','imgB','imgC'], '输入清单顺序');
    eq(api.llmListInputs(llm).map(e => e.kind), ['image','image','image'], '输入类型');

    // 物化：PR()
    const parsed = model.parseTableOutput(JSON.stringify({kind:'table', version:1, columns:['提示词'], rows:[['一行'],['二行']]}));
    const created = api.materializeLlmTable(llm, parsed, groups);
    ok(created && created.type === 'table', '物化出表格节点');
    eq(created.table.rows.length, 2, '表格数据带过去');
    eq(created.llmGeneratedOutput, true, '标记为 LLM 生成');
    eq(created.llmSourceId, 'llm1', '溯源到 LLM');
    eq(created.x, 1000 + 420 + 170, '落在源右侧 170px');
    eq(created.y, 100, '没有下游时 y 与源对齐');
    eq(created.h, undefined, '不设固定高度（行少时不会在底部留白）');
    eq(created.tableInputChannelCount, 2, '通道数与媒体组数一致');

    const intoCreated = connections.filter(c => c.to === created.id);
    eq(intoCreated.length, 3, '入边 = 两个素材列 + LLM flow');
    eq(intoCreated.map(c => c.toPort || '').filter(Boolean).sort(), ['input-1','input-2'], '素材连线带 toPort');
    ok(intoCreated.some(c => c.from === 'llm1' && !c.toPort), 'LLM → 表格 不带 toPort');

    const channels = api.ensureTableChannels(created);
    eq(channels.length, 2, '推导出两个输入通道');
    eq(channels[0].items.map(i => i.nodeId), ['imgA'], '第 1 通道是单图');
    eq(channels[0].mode, 'shared', '单图 → 共享');
    eq(channels[1].items.map(i => i.nodeId), ['imgB','imgC'], '第 2 通道是 group 成员');
    eq(channels[1].mode, 'shared', '两张 → 沿用（参考栏默认一行一张）');
    eq(api.tableUpstreamTexts(created), [], 'LLM 节点不进上游文本');

    // 按钮文案
    eq(api.llmRunButtonLabel({running:false, llmOutputMode:'list'}), '生成', 'list 未运行');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'planning'}), '规划中', 'list 规划中');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'repairing'}), '校验中', 'list 校验中');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'generating'}), '生成中', 'list 生成中');
    eq(api.llmRunButtonLabel({running:false, llmOutputMode:'text'}), '生成', 'text 模式按钮也是「生成」');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'text'}), '生成中', 'text 模式运行中');
}

// ═══ L. 视频节点的表格批量（分镜逐段生成） ═══
{
    const vid = {id:'vid1', type:'video', duration:5, aspectRatio:'16:9'};
    nodes.push(vid);
    eq(api.renderTableBatchPanel(vid), null, '视频节点无上游表格 → 不渲染批量面板');
    eq(api.tableBatchSingleLabel(vid), '生成视频', '视频节点未接表格 → 保持「生成视频」按钮');
    eq(api.tableDrivenHidden(vid), '', '视频节点未接表格 → 不隐藏 Media 区块');

    connections.push({id:'c_tbl_vid', from:node.id, to:vid.id});
    eq(api.generatorUpstreamTables(vid.id).map(t => t.id), [node.id], '视频节点也认得上游表格');

    const vidPanel = api.renderTableBatchPanel(vid);
    ok(vidPanel && vidPanel.classList.contains('table-batch-panel'), '视频节点接表格 → 渲染批量面板');
    eq(api.tableBatchSingleLabel(vid), '单段生成', '视频节点接表格 → 主按钮改成「单段生成」');
    ok(api.tableBatchRunButtonHtml(vid).indexOf('批量生成') > 0, '视频节点主按钮位加「批量生成」');
    eq(api.tableDrivenHidden(vid), ' style="display:none"', '视频节点接表格 → 隐藏 Media 区块');

    // 视频又慢又贵：未设置并发时逐段串行，不能像图像一样一次发 3 段
    // （J 段为了验证写入把并发改成了 5，这里先还原成未设置）
    const savedConcurrency = node.tableBatchConcurrency;
    delete node.tableBatchConcurrency;
    eq(api.tableBatchConcurrencyFor(vid, node), 1, '视频未设置并发 → 默认 1');
    eq(api.tableBatchConcurrencyFor(genNode, node), 3, '图像未设置并发 → 默认 3');
    node.tableBatchConcurrency = 4;
    eq(api.tableBatchConcurrencyFor(vid, node), 4, '视频尊重显式设置');
    eq(api.tableBatchConcurrencyFor(genNode, node), 4, '图像同样尊重显式设置');
    delete node.tableBatchConcurrency;

    const vidPanelRerun = api.renderTableBatchPanel(vid);
    const statusVid = one(vidPanelRerun, 'table-batch-status').textContent;
    ok(statusVid.indexOf('首批 1') >= 0, '视频面板首批并发显示 1：' + statusVid);
    eq(byClass(vidPanelRerun, 'table-batch-row').length, api.tableRowInputs(node).length, '视频面板行数 = 表格当前行数');
    eq(api.tableBatchRunner(vid)(), 'via-runVideoNode', '视频节点派发到 runVideoNode');
    eq(api.tableBatchRunner(genNode)(), 'via-runGenerator', '图像节点派发到 runGenerator');

    // 接了表格还去点「单段生成」时，提示必须说清该点哪儿
    ok(api.generatorNeedsPromptMessage(vid).indexOf('批量生成') > 0, '接了表格的单段提示指向「批量生成」：' + api.generatorNeedsPromptMessage(vid));
    ok(api.generatorNeedsPromptMessage(vid).indexOf('单段生成') > 0, '接了表格的单段提示点名「单段生成」');
    ok(api.generatorNeedsPromptMessage(genNode).indexOf('单张生成') > 0, '图像侧同理（genNode 已接表格）：' + api.generatorNeedsPromptMessage(genNode));
    eq(api.generatorNeedsPromptMessage({id:'genNoTable', type:'generator'}), 'canvas.needPromptOrImage', '没接表格时保留原文案（图像）');
    eq(api.generatorNeedsPromptMessage({id:'vidNoTable', type:'video'}), 'canvas.videoNeedsPrompt', '没接表格时保留原文案（视频）');

    // 行里连的是视频，参考素材就要原样带 kind=video 过去（否则会被当成参考图）
    const vidRow = {rowNumber:1, media:[{url:'/clip.mp4', nodeId:'mv1', kind:'video', node:{name:'参考片段'}}]};
    eq(api.tableRowRefs(vidRow), [{url:'/clip.mp4', name:'参考片段', kind:'video', nodeId:'mv1'}], '视频参考素材带 kind=video');

    node.tableBatchConcurrency = savedConcurrency;
}

// ═══ K2. 对齐：只有长文本列左对齐，其余居中 ═══
{
    const alignNode = api.addTableNode();
    api.ensureTableState(alignNode);
    alignNode.table = model.normalizeTable({
        columns: ['时长(秒)', '运镜', '画面描述'],
        rows: [['1.5', '缓慢推近', '雨后城市街头，湿沥青地面有薄水膜，白色运动鞋鞋底特写，冷色漫反射光，浅景深']]
    }).table;
    alignNode.table.selectedRows = [0];
    const alignRoot = api.renderTableBody(alignNode);
    const ths = byTag(alignRoot, 'thead')[0].children[0].children;
    eq(ths.slice(1, 4).map(th => th.classList.contains('is-text-column')), [false, false, true],
        '表头：只有画面描述（长文本）列标记 is-text-column');
    const tds = byTag(alignRoot, 'tbody')[0].children[0].children;
    eq(tds.slice(1, 4).map(td => td.classList.contains('is-text-column')), [false, false, true],
        '单元格：同样只有长文本列左对齐');
    ok(ths[ths.length - 2].classList.contains('table-actions-cell'), '倒数第二列表头是选择列');
    eq(ths[ths.length - 1].textContent, '删除行', '最后一列表头是删除行');
}

// ═══ L1. 输出形式药丸按钮 ═══
{
    eq(api.LLM_OUTPUT_MODE_BUTTONS.map(b => b.value), ['text', 'list', 'list-video'], '三颗药丸：文本 / 多维表格 / 视频分镜表');
    eq(api.LLM_OUTPUT_MODE_BUTTONS.map(b => b.label), ['文本输出', '多维表格', '视频分镜表'], '药丸文案');
    const pillHtml = api.llmOutputModeButtonsHtml({llmOutputMode:'list-video'});
    eq((pillHtml.match(/data-output-mode=/g) || []).length, 3, '渲染出 3 颗药丸');
    ok(pillHtml.indexOf('data-output-mode="list-video" title="视频分镜表：每一行一个分镜，接视频生成节点逐段生成"') > 0, '药丸带 title 说明用途');
    eq((pillHtml.match(/ active/g) || []).length, 1, '只有一颗是选中态');
    ok(/data-output-mode="list-video"[^>]*class|class="[^"]*llm-output-mode-btn active"[^>]*data-output-mode="list-video"/.test(pillHtml)
        || pillHtml.indexOf('llm-output-mode-btn active" data-output-mode="list-video"') > 0, '选中的是视频分镜表');
    ok(api.llmOutputModeButtonsHtml({llmOutputMode:'list'}).indexOf('data-output-mode="list" title="多维表格') > 0, 'list 用药丸');
    ok(api.llmOutputModeButtonsHtml({llmOutputMode:'list'}).indexOf('llm-output-mode-btn active" data-output-mode="list"') > 0, 'list 时选中的是多维表格');
    ok(api.llmOutputModeButtonsHtml({}).indexOf('llm-output-mode-btn active" data-output-mode="text"') > 0, '没设置时选中的是文本输出');
    ok(api.llmOutputModeButtonsHtml({llmOutputMode:'乱写'}).indexOf('active" data-output-mode="text"') > 0, '非法值回落文本输出');
    ok(api.llmOutputModeButtonsHtml({llmOutputMode:'list-video'}).indexOf('llm-output-mode-btn active" data-output-mode="list"') < 0, 'list-video 不会同时点亮 list');
}

// ═══ L2. 供应商错误体的可读化 ═══
eq(api.friendlyBatchError('{"error":{"message":"You have reached the API rate limit for free users. (request id: 20260915151137290479961DSm9pxEj)"}}'),
   'You have reached the API rate limit for free users. (request id: 20260915151137290479961DSm9pxEj)',
   '嵌套 JSON 错误体抽出 message（Agnes rate_limit_exceeded 原始体）');
eq(api.friendlyBatchError('{"detail":"Agnes 未配置 Base URL"}'), 'Agnes 未配置 Base URL', 'FastAPI detail 抽出');
eq(api.friendlyBatchError('{"error":"plain string"}'), 'plain string', 'error 是字符串也能抽');
eq(api.friendlyBatchError('网络错误'), '网络错误', '普通文本原样返回');
eq(api.friendlyBatchError(''), '', '空值返回空串');
eq(api.friendlyBatchError('{不是 JSON}'), '{不是 JSON}', '不是 JSON 时原样返回，不吞信息');
eq(api.friendlyBatchError(undefined), '', 'undefined 安全');

// ═══ M. 批量执行端到端（异步：runTableBatch → 运行器 → 逐行覆盖） ═══
(async () => {
    batchCalls.length = 0;
    const vidE2E = nodes.find(n => n.id === 'vid1');
    // 表格里放两行真实分镜内容，清掉前面用例留下的执行参数
    const fresh = model.normalizeTable({columns:['画面描述'], rows:[['镜头A：推近'], ['镜头B：拉远']]}).table;
    fresh.selectedRows = [0, 1];   // 勾选语义＝默认全选
    node.table = fresh;
    delete node.tableBatchStartRow;
    delete node.tableBatchManualSelection;
    delete node.tableBatchFailurePolicy;
    node.tableBatchConcurrency = 1;

    await api.runTableBatch(vidE2E.id, {});
    eq(batchCalls.length, 2, '批量执行逐行派发 2 次');
    eq(batchCalls.map(c => c.id), [vidE2E.id, vidE2E.id], '两次都派发给同一个视频节点');
    eq(batchCalls.map(c => c.opts.batch), [true, true], '都带批量模式标记');
    ok(batchCalls[0].opts.rowOverride.prompt.indexOf('镜头A') >= 0, '第 1 行提示词按行覆盖：' + batchCalls[0].opts.rowOverride.prompt);
    ok(batchCalls[1].opts.rowOverride.prompt.indexOf('镜头B') >= 0, '第 2 行提示词按行覆盖：' + batchCalls[1].opts.rowOverride.prompt);
    eq(batchCalls[0].opts.runContext.rowNumber, 1, '第 1 行带行号归属');
    eq(batchCalls[1].opts.runContext.rowNumber, 2, '第 2 行带行号归属');
    ok(batchCalls[0].opts.rowOverride.refs.length >= 1, '按行带上了这一行的参考素材');

    // 取消勾选第 2 行 → 只跑第 1 行（勾选语义两种模式都适用）
    api.toggleTableRow(node, 1, false);
    batchCalls.length = 0;
    await api.runTableBatch(vidE2E.id, {});
    eq(batchCalls.length, 1, '取消勾选的行不参与批量执行');
    ok(batchCalls[0].opts.rowOverride.prompt.indexOf('镜头A') >= 0, '只跑了留下的那一行');
    api.toggleTableRow(node, 1, true);

    // 失败时必须把「为什么」带出来：批量模式不能弹窗，只报「失败 N 行」等于没说
    videoShimMode = 'fail';
    batchCalls.length = 0;
    await api.runTableBatch(vidE2E.id, {});
    const batchMsg = String(vidE2E._batchLastMessage || '');
    ok(batchMsg.indexOf('失败 2 行') > 0, '摘要报出失败行数：' + batchMsg);
    ok(batchMsg.indexOf('Agnes rate limit: free users') > 0, '摘要带出首个失败原因：' + batchMsg);
    ok(batchMsg.indexOf('{"error"') < 0, '摘要里不出现原始 JSON');
    videoShimMode = 'ok';

// ═══ M. 输出(Output)节点作为参考来源 ═══
{
    const outNode = {id:'outRef', type:'output', images:[{url:'/static/out/1.png'},{url:'/static/out/2.png'},{url:'/static/out/3.png'}]};
    nodes.push(outNode);
    eq(api.tableSourceItems(outNode).map(i => i.url), ['/static/out/1.png','/static/out/2.png','/static/out/3.png'], '输出节点展开成它产出的每一张');
    eq(api.tableSourceItems(outNode).map(i => i.outputIndex), [0,1,2], '每项带 outputIndex');
    eq(api.tableSourceItems(outNode).map(i => i.nodeId), ['outRef','outRef','outRef'], 'nodeId 仍是输出节点自己的 id（下游能反查）');
    const outGroup = {id:'grpOut', type:'group', items:['outRef','extraImage']};
    nodes.push(outGroup, {id:'extraImage', type:'image', url:'/static/out/extra.png'});
    eq(api.tableSourceItems(outGroup).map(i => i.nodeId), ['outRef','outRef','outRef','extraImage'], '组里的输出节点逐张展开、普通素材仍是一项');

    const tbl = api.addTableNode();
    connections.push({id:'c_out_ref', from:'outRef', to:tbl.id});
    const outChannels = api.ensureTableChannels(tbl);
    eq(outChannels[0].items.length, 3, '同一节点的 3 张不会被去重并成 1 张');
    eq(outChannels[0].items.map(i => i.url), ['/static/out/1.png','/static/out/2.png','/static/out/3.png'], '通道里保留每张的 url');
    eq(outChannels[0].mode, 'shared', '参考栏默认沿用');

    api.addTableColumn(tbl);
    api.addTableRow(tbl);
    api.addTableRow(tbl);
    const outRows = api.tableRowInputs(tbl);
    eq(outRows.length, 2, '两行');
    eq(outRows.map(r => r.channelItems[0].map(e => e.url)), [['/static/out/1.png'],['/static/out/2.png']], '沿用：一行取一张');
    eq(outRows[0].references[0].nodeId, 'outRef', '引用记的是输出节点 id');
    eq(outRows[0].media[0].outputIndex, 0, '素材带 outputIndex（临时图床回写要用）');
    eq(api.tableRowRefs(outRows[0])[0].outputIndex, 0, 'tableRowRefs 把 outputIndex 传给生成');

    const sigBefore = api.tableNodeSignature(tbl);
    outNode.images.push({url:'/static/out/4.png'});
    ok(api.tableNodeSignature(tbl) !== sigBefore, '输出节点新增产出 → 签名变化（否则表格不重绘）');
    eq(api.ensureTableChannels(tbl)[0].items.length, 4, '重算后是 4 张');
}

// ═══ N. 主运行按钮：接了多维表格就整个不渲染 ═══
{
    const gen = {id:'genBtn1', type:'generator', model:'x'};
    nodes.push(gen);
    const plain = api.tableBatchSingleButtonHtml(gen);
    ok(plain.indexOf('class="gen-btn"') >= 0, '没接表格 → 渲染主按钮');
    ok(plain.indexOf('data-lucide="zap"') >= 0, '生成节点用 zap 图标');
    ok(plain.indexOf('API生成') >= 0, '没接表格 → 文案是「API生成」');
    ok(plain.indexOf('disabled') < 0, '没在运行 → 不禁用');

    const tbl = api.addTableNode();
    connections.push({id:'c_btn_tbl', from:tbl.id, to:gen.id});
    eq(api.tableBatchSingleButtonHtml(gen), '', '接了表格 → 主按钮不渲染（只留「批量生成」）');

    const vid = {id:'vidBtn1', type:'video', model:'x'};
    nodes.push(vid);
    const videoPlain = api.tableBatchSingleButtonHtml(vid);
    ok(videoPlain.indexOf('data-lucide="clapperboard"') >= 0, '视频节点用 clapperboard 图标');
    ok(videoPlain.indexOf('生成视频') >= 0, '视频节点未接表格 → 文案是「生成视频」');
    connections.push({id:'c_btn_tbl2', from:tbl.id, to:vid.id});
    eq(api.tableBatchSingleButtonHtml(vid), '', '视频节点接了表格也不渲染主按钮');

    const running = {id:'genBtn2', type:'generator', model:'x', running:true};
    nodes.push(running);
    const busy = api.tableBatchSingleButtonHtml(running);
    ok(busy.indexOf('gen-btn running') >= 0 && busy.indexOf('disabled') >= 0, '运行中仍带 running / disabled');
    ok(busy.indexOf('生成中') >= 0, '运行中文案不变');
}

// ═══ O. 格子交互：LLM 表不放图标 / 空白表才有「+」和「···」 ═══
{
    // ── 用户新建的空白表 ──
    const tbl = api.addTableNode();
    api.addTableColumn(tbl);
    api.addTableRow(tbl);
    const root = api.renderTableBody(tbl);
    const dataCell = () => rowAt(root, 0).children[1];

    const inputCell = () => rowAt(root, 0).children[0];

    // 数据列只支持文本：没有「+」也没有「···」
    eq(byClass(dataCell(), 'table-cell-add').length, 0, '数据列不放「+」（只支持文本）');
    eq(byClass(dataCell(), 'table-cell-more').length, 0, '数据列不放「···」');

    // 输入列：空格子正中一个「+」
    const add = () => byClass(inputCell(), 'table-cell-add')[0];
    ok(Boolean(add()), '输入列空格子正中一个「+」');
    eq(add().title, '上传图片/视频', '「+」的说明');
    eq(byClass(inputCell(), 'table-cell-add').length, 1, '只有一个「+」');
    eq(byClass(inputCell(), 'table-cell-more').length, 0, '空格子没有「···」');

    // 数据列写文字 → 双击可编辑
    tbl.table.rows[0][0] = '一只猫';
    api.repaintTable(tbl);
    ok(typeof dataCell().ondblclick === 'function', '文字格双击可编辑');
    eq(byClass(dataCell(), 'table-cell-add').length, 0, '文字格没有「+」');

    // 输入列上传 → 「+」变「···」，双击看大图
    api.setTableManualInputItem(tbl, 'input-1', 0, {url:'/static/m.png', mediaType:'image', name:'m.png'});
    api.repaintTable(tbl);
    const mediaCell = inputCell();
    eq(byClass(mediaCell, 'table-media-thumb').length, 1, '输入列渲染成缩略图');
    const more = () => byClass(inputCell(), 'table-cell-more')[0];
    ok(Boolean(more()), '有素材后右上角「···」');
    eq(more().textContent, '···', '就是三个点');
    const moreMenu = byClass(inputCell(), 'table-cell-menu')[0];
    ok(Boolean(moreMenu), '「···」带着菜单');
    eq(byClass(moreMenu, 'menu-btn').map(b => b.textContent), ['替换','新增'], '菜单两项：替换 / 新增');
    more().onclick({stopPropagation(){}});
    ok(moreMenu.classList.contains('is-open'), '点「···」展开菜单');

    // 「新增」= 追加到同一行（一行可以有多张）
    api.addTableManualInputItem(tbl, 'input-1', 0, {url:'/static/m2.png', mediaType:'image', name:'m2.png'});
    api.repaintTable(tbl);
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.url), ['/static/m.png','/static/m2.png'], '新增后这一行有两张');
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.ordinal), [1,2], '第二张序号顺延');
    api.repaintTable(tbl);
    eq(byClass(inputCell(), 'table-cell-menu')[0]
        ? byClass(inputCell(), 'table-cell-menu')[0].children.map(b => b.textContent) : [],
        ['替换','替换','新增'], '多张时菜单按张替换（靠缩略图区分，不显示序号）');
    eq(byClass(byClass(inputCell(), 'table-cell-menu')[0], 'menu-btn').map(b => b.title), ['@图片1','@图片2',null], 'token 放在 title 上');

    // 单张替换只动那一张
    api.replaceTableManualInputItem(tbl, 'input-1', 0, 1, {url:'/static/m3.png', mediaType:'image', name:'m3.png'});
    api.repaintTable(tbl);
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.url), ['/static/m.png','/static/m3.png'], '只换了第二张，第一张没动');
    api.setTableManualInputItem(tbl, 'input-1', 0, {url:'/static/m.png', mediaType:'image', name:'m.png'});
    api.repaintTable(tbl);

    // 自建表格双击编辑不要线框
    api.beginTableEdit(tbl, {kind:'cell', row:0, column:0});
    api.repaintTable(tbl);
    eq(byClass(dataCell(), 'table-cell-editor').map(x => x.classList.contains('is-plain')), [true], '自建表格编辑器加 is-plain（无线框）');
    api.endTableEdit(tbl);
    eq(byClass(inputCell(), 'table-cell-add').length, 0, '有图就不再显示「+」');
    ok(typeof mediaCell.ondblclick === 'function', '媒体格双击可查看');
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.url), ['/static/m.png'], '输入列的素材进了这一行');
    api.setTableManualInputItem(tbl, 'input-1', 0, null);
    api.repaintTable(tbl);

    // ── LLM 生成的多维表格：一个格子图标都不放 ──
    const llmTable = api.addTableNode();
    llmTable.llmGeneratedOutput = true;
    api.addTableColumn(llmTable);
    api.addTableRow(llmTable);
    const llmRoot = api.renderTableBody(llmTable);
    const llmDataCell = () => rowAt(llmRoot, 0).children[1];
    eq(byClass(llmDataCell(), 'table-cell-add').length, 0, 'LLM 表：空格子不放「+」');
    eq(byClass(llmDataCell(), 'table-cell-more').length, 0, 'LLM 表：空格子不放「···」');
    api.setTableCellMedia(llmTable, 0, 0, {url:'/static/llm.png', mediaType:'image', name:'llm.png'});
    const llmMedia = llmDataCell();
    eq(byClass(llmMedia, 'table-media-thumb').length, 1, 'LLM 表：媒体格照样出缩略图');
    eq(byClass(llmMedia, 'table-cell-more').length, 0, 'LLM 表：媒体格也不放「···」');
    eq(byClass(llmMedia, 'table-cell-add').length, 0, 'LLM 表：媒体格也不放「+」');
    ok(typeof llmMedia.ondblclick === 'function', 'LLM 表：媒体格双击可查看');
    // ── 数据列只支持文本 + @本行素材显示缩略图 ──
    {
        const t = api.addTableNode();
        api.addTableColumn(t);
        api.addTableRow(t);
        const rootT = api.renderTableBody(t);
        const cellOf = () => rowAt(rootT, 0).children[1];
        eq(byClass(cellOf(), 'table-cell-add').length, 0, '自建表的数据列不放「+」（只支持文本）');
        eq(byClass(cellOf(), 'table-cell-more').length, 0, '自建表的数据列不放「···」');

        // 参考栏上传一张，再把 @图片1 写进同一行的文本格
        api.setTableManualInputItem(t, 'input-1', 0, {url:'/static/row.png', mediaType:'image', name:'row.png'});
        t.table.rows[0][0] = '把 @图片1 换成红色的';
        api.repaintTable(t);
        const chip = byClass(cellOf(), 'table-cell-mention')[0];
        ok(Boolean(chip), '@图片1 变成缩略图 chip');
        eq(byClass(cellOf(), 'table-media-thumb').length, 1, 'chip 里有一个缩略图');
        eq(cellOf().textContent, '把  换成红色的', '引用位置留空、其余文字保留');
        eq(byClass(cellOf(), 'table-cell-view')[0].children.length, 3, '文本 + chip + 文本 三段');

        // 空格子（本行没素材）有说明文字
        const blankT = api.addTableNode();
        api.addTableColumn(blankT);
        api.addTableRow(blankT);
        const bRoot = api.renderTableBody(blankT);
        eq(byClass(rowAt(bRoot, 0).children[1], 'table-cell-hint').map(h => h.textContent), ['文字；@ 可引用本行素材'], '空数据格有说明');

        // 编辑器里打 @ → 弹出本行素材选择条，点一下插入 @图片N
        api.beginTableEdit(t, {kind:'cell', row:0, column:0});
        api.repaintTable(t);
        const editor = byClass(cellOf(), 'table-cell-editor')[0];
        ok(Boolean(editor), '双击后出现编辑器');
        editor.value = '把 @';
        if(typeof editor.selectionStart !== 'number') { editor.selectionStart = editor.value.length; editor.selectionEnd = editor.value.length; }
        editor.oninput();
        const picker = byClass(cellOf(), 'table-cell-mention-picker')[0];
        ok(picker && picker.classList.contains('is-open'), '打 @ 弹出选择条');
        const item = byClass(picker, 'table-cell-mention-item')[0];
        ok(Boolean(item), '选择条里有本行素材');
        eq(item.title, '@图片1', '选择条目带 token 说明');
        let downPrevented = false;
        item.onmousedown({preventDefault(){ downPrevented = true; }, stopPropagation(){}});
        ok(downPrevented, '选择条目的 mousedown 必须 preventDefault（否则失焦先提交，插入落空）');
        editor.selectionStart = editor.value.length;
        editor.selectionEnd = editor.value.length;
        item.onclick({preventDefault(){}, stopPropagation(){}});
        eq(editor.value, '把 @图片1', '点一下插入 @图片1');
        ok(!picker.classList.contains('is-open'), '选完收起');
        editor.onkeydown({key:'Enter', shiftKey:false, preventDefault(){}, stopPropagation(){}});
        api.repaintTable(t);
        ok(Boolean(byClass(cellOf(), 'table-cell-mention')[0]), '提交后 @图片1 渲染成缩略图');

        // 对不上的引用原样留着
        t.table.rows[0][0] = '看 @图片9';
        api.repaintTable(t);
        eq(byClass(cellOf(), 'table-cell-mention').length, 0, '对不上的 @图片9 不渲染缩略图');
        eq(cellOf().textContent, '看 @图片9', '对不上的引用原样保留');

        // LLM 表：提示词保持纯文本（不插缩略图，免得行高爆炸）
        const lt = api.addTableNode();
        lt.llmGeneratedOutput = true;
        api.addTableColumn(lt);
        api.addTableRow(lt);
        api.setTableManualInputItem(lt, 'input-1', 0, {url:'/static/llm2.png', mediaType:'image', name:'llm2.png'});
        lt.table.rows[0][0] = '参考 @图片1';
        const lroot = api.renderTableBody(lt);
        api.repaintTable(lt);
        eq(byClass(rowAt(lroot, 0).children[1], 'table-cell-mention').length, 0, 'LLM 表提示词不插缩略图');
        eq(rowAt(lroot, 0).children[1].textContent, '参考 @图片1', 'LLM 表原样显示文本');
    }

    // ── 生成 / 视频节点默认随内容高度（不留白），用户拉过的才保留 ──
    {
        eq(api.normalizeContentHeightNode({type:'generator', h:900}), true, '生成节点的旧固定高度被清掉');
        eq(api.normalizeContentHeightNode({type:'video', h:800}), true, '视频节点同理');
        const kept = {type:'generator', h:900, tableHeightUserSet:true};
        eq(api.normalizeContentHeightNode(kept), false, '用户拉过的高度保留');
        eq(kept.h, 900, 'h 没被删');
        eq(api.normalizeContentHeightNode({type:'table', h:700}), false, '表格节点不走这条');
        eq(api.normalizeContentHeightNode({type:'generator'}), false, '没有 h 就不动');
    }

    // ── 删列 ──
    {
        const t = api.addTableNode();
        api.addTableColumn(t);
        api.addTableColumn(t);
        api.addTableRow(t);
        t.table.rows[0][0] = 'A';
        t.table.rows[0][1] = 'B';
        api.repaintTable(t);
        const root2 = api.renderTableBody(t);
        eq(byClass(root2, 'table-head-delete').length, 2, '两个数据列各一个删除按钮');
        eq(byClass(root2, 'table-head-cell').length, 5, '表头 5 格：输入 + 2 数据 + 选择 + 删除行');
        // 只有一列输入时不给删（删了也会自己长回来，ensureTableChannels 至少留一列）
        eq(byClass(root2, 'table-head-delete').length, 2, '单列输入没有删除按钮');
        api.deleteTableColumn(t, 0);
        eq(t.table.columns.length, 1, '删掉一列');
        eq(t.table.rows[0], ['B'], '同一行里被删掉的格子也去掉');
        eq(t.table.rows[0][0], 'B', '剩下那列的值没串位');
        api.deleteTableColumn(t, 0);
        eq(t.table.columns.length, 0, '删空');
        eq(t.table.rows[0], [], '删空后行也空了');
        api.deleteTableColumn(t, 0);
        eq(t.table.columns.length, 0, '空表再删不报错');

        // 输入列：删掉列 = 连到这一列的连线一起删，后面的列号前移
        const t2 = api.addTableNode();
        nodes.push({id:'imgDelA', type:'image', url:'/static/a.png'});
        nodes.push({id:'imgDelB', type:'image', url:'/static/b.png'});
        connections.push({id:'c_del_a', from:'imgDelA', to:t2.id, toPort:'input-1'});
        connections.push({id:'c_del_b', from:'imgDelB', to:t2.id, toPort:'input-2'});
        api.addTableColumn(t2);
        api.addTableRow(t2);
        eq(api.ensureTableChannels(t2).length, 2, '两条连线 → 两列');
        const root3 = api.renderTableBody(t2);
        eq(byClass(root3, 'table-head-delete').length, 3, '两列输入各一个删除按钮 + 一个数据列');
        api.removeTableInputChannel(t2, 0);
        eq(api.ensureTableChannels(t2).length, 1, '删掉第一列输入');
        eq(api.ensureTableChannels(t2)[0].items.map(i => i.nodeId), ['imgDelB'], '第二列的连线前移到第一列');
        eq(connections.filter(c => c.to === t2.id).map(c => c.toPort), ['input-1'], 'toPort 跟着前移');
        api.removeTableInputChannel(t2, 0);
        eq(api.ensureTableChannels(t2).length, 1, '只剩一列时不给删');
    }

    // LLM 表的参考栏同样不放图标
    nodes.push({id:'imgLlmCell', type:'image', url:'/static/up2.png'});
    connections.push({id:'c_llm_cell', from:'imgLlmCell', to:llmTable.id});
    api.renderTableBody(llmTable);
    const llmInputCell = rowAt(llmRoot, 0).children[0];
    eq(byClass(llmInputCell, 'table-media-thumb').length, 1, 'LLM 表：参考栏照样出缩略图');
    eq(byClass(llmInputCell, 'table-cell-more').length + byClass(llmInputCell, 'table-cell-add').length, 0, 'LLM 表：参考栏也不放图标');

    // ── 参考栏：手动上传覆盖这一行 ══
    nodes.push({id:'imgCell', type:'image', url:'/static/up.png'});
    connections.push({id:'c_cell', from:'imgCell', to:tbl.id});
    api.renderTableBody(tbl);
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.url), ['/static/up.png'], '连线推出来的参考图');
    ok(Boolean(byClass(rowAt(root, 0).children[0], 'table-cell-more')[0]), '有参考图 → 右上角「···」');

    api.setTableManualInputItem(tbl, 'input-1', 0, {url:'/static/manual.png', mediaType:'image', name:'manual.png'});
    api.renderTableBody(tbl);
    const rows = api.tableRowInputs(tbl);
    eq(rows[0].media.map(m => m.url), ['/static/manual.png'], '手动上传覆盖这一行');
    eq(rows[0].references[0].nodeId, '', '手动素材没有来源节点');
    eq(api.tableManualInputItem(tbl, 'input-1', 0).url, '/static/manual.png', '手动项存下来了');

    api.setTableManualInputItem(tbl, 'input-1', 0, null);
    api.renderTableBody(tbl);
    eq(api.tableRowInputs(tbl)[0].media.map(m => m.url), ['/static/up.png'], '移出手动项 → 回到连线推出来的那张');

    // 第二行不受手动项影响（一行一张）
    api.addTableRow(tbl);
    api.setTableManualInputItem(tbl, 'input-1', 0, {url:'/static/manual.png', mediaType:'image', name:'manual.png'});
    api.renderTableBody(tbl);
    const twoRows = api.tableRowInputs(tbl);
    eq(twoRows[0].media.map(m => m.url), ['/static/manual.png'], '第 1 行用手动那张');
    eq(twoRows[1].media.map(m => m.url), ['/static/up.png'], '第 2 行仍是连线的');

    // 空白表（没有任何连线）也能上传：只有手动项时它就是这一行的参考
    const blank = api.addTableNode();
    api.addTableColumn(blank);
    api.addTableRow(blank);
    const blankRoot = api.renderTableBody(blank);
    ok(Boolean(byClass(rowAt(blankRoot, 0).children[0], 'table-cell-add')[0]), '空白表的参考格也有「+」');
    api.setTableManualInputItem(blank, 'input-1', 0, {url:'/static/solo.mp4', mediaType:'video', name:'solo.mp4'});
    api.renderTableBody(blank);
    const solo = api.tableRowInputs(blank)[0].media;
    eq(solo.map(m => m.url), ['/static/solo.mp4'], '空白表：手动上传的就是这一行的参考');
    eq(solo[0].kind, 'video', '视频按后缀认出是 video');
    ok(Boolean(byClass(rowAt(blankRoot, 0).children[0], 'table-cell-more')[0]), '上传后参考格变「···」');
    // 地址不带后缀时按上传时记下的类型判（素材地址不保证有扩展名）
    api.setTableManualInputItem(blank, 'input-1', 0, {url:'/api/asset/9f2', mediaType:'video', name:'clip'});
    api.renderTableBody(blank);
    eq(api.tableRowInputs(blank)[0].media[0].kind, 'video', '无后缀地址按上传时的类型判');
}

    console.log('通过 ' + pass + '/' + (pass + fails.length));
    if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('全部通过');
})();
