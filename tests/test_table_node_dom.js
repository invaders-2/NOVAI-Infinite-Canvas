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
let uidSeq = 0;
const api = new Function(
    'document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl',
    'canvasPreviewImgHtml', 'canvasVideoPreviewHtml', 'nowMs', 'tr',
    block + '\nreturn {renderTableBody, addTableNode, ensureTableState, addTableColumn, addTableRow,' +
    ' deleteTableRow, toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth,' +
    ' ensureTableChannels, tableRowInputs, tableInputEntryAt, tableUpstreamTexts, toggleTableChannelMode,' +
    ' addTableInputChannel, tableNodeSignature, connectNodes, tableDropPortFor,' +
    ' generatorUpstreamTables, renderTableBatchPanel, paintTableBatchPanel, tableRowRefs, tableRowMaterialIssues,' +
    ' llmMediaGroups, llmListInputs, llmRunButtonLabel, materializeLlmTable, tableSourceItems,' +
    ' tableBatchRunButtonHtml, tableBatchSingleLabel, paintTableBatchPanel};'
)(
    // addNode 必须把节点放进 nodes：真实实现如此，generatorUpstreamTables 要从 nodes 反查表格
    global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); nodes.push(n); return n; }, () => {}, p => p + '_' + (uidSeq += 1),
    connections, nodes, () => {}, n => (n && n.mediaKind) || 'image', url => missingUrls.has(url),
    (url) => '<img src="' + url + '">', (url) => '<video src="' + url + '"></video>', () => 1700000000000,
    key => ({'canvas.apiGenerate':'API生成', 'canvas.generating':'生成中'})[key] || key
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

// ═══ E. 模式切换（逐行 → 全部 → 沿用 → 逐行） ═══
eq(api.ensureTableChannels(node)[0].mode, 'sequence', '4 个引用 → 自动逐行');
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
eq(api.tableBatchRunButtonHtml(genNode), '', '无上游表格 → 主按钮位不加批量按钮');
eq(api.tableBatchSingleLabel(genNode), 'API生成', '无上游表格 → 主按钮文案不变');

connections.push({id:'c_tbl_gen', from:node.id, to:genNode.id});
eq(api.generatorUpstreamTables(genNode.id).map(t => t.id), [node.id], '认得上游表格');

const panel = api.renderTableBatchPanel(genNode);
ok(panel && panel.classList.contains('table-batch-panel'), '上游有表格 → 渲染批量面板');
eq(api.tableBatchSingleLabel(genNode), '单张生成', '有上游表格 → 主按钮改成「单张生成」');
ok(api.tableBatchRunButtonHtml(genNode).indexOf('批量生成') > 0, '有上游表格 → 主按钮位加「批量生成」');

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

// 点整行 = 切换该行勾选
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
ok(Boolean(one(panel, 'table-checkbox')), '有独立运行勾选框');

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
one(panel, 'table-checkbox').checked = true; one(panel, 'table-checkbox').onchange();
eq(node.tableBatchManualSelection, true, '独立运行开关写入表格节点');

// 独立运行模式下状态行显示已选数量
const panel2 = api.renderTableBatchPanel(genNode);
ok(one(panel2, 'table-batch-status').textContent.indexOf('独立运行 · 已选 0/1') >= 0, '独立运行显示已选 0/1：' + one(panel2, 'table-batch-status').textContent);
api.toggleTableRow(node, 0, true);
const panel3 = api.renderTableBatchPanel(genNode);
ok(one(panel3, 'table-batch-status').textContent.indexOf('独立运行 · 已选 1/1') >= 0, '勾选后显示已选 1/1');
api.toggleTableRow(node, 0, false);

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
    eq(created.h, 320, '高度：38+2*88 被 320 下限托住');
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
    eq(channels[1].mode, 'sequence', '两张 → 逐行对应');
    eq(api.tableUpstreamTexts(created), [], 'LLM 节点不进上游文本');

    // 按钮文案
    eq(api.llmRunButtonLabel({running:false, llmOutputMode:'list'}), '生成', 'list 未运行');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'planning'}), '规划中', 'list 规划中');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'repairing'}), '校验中', 'list 校验中');
    eq(api.llmRunButtonLabel({running:true, llmOutputMode:'list', llmRunStage:'generating'}), '生成中', 'list 生成中');
    eq(api.llmRunButtonLabel({running:false, llmOutputMode:'text'}), 'Run LLM', 'text 模式按钮不变');
}

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
