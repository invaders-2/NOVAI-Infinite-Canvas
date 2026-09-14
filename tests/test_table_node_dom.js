#!/usr/bin/env node
// 真正跑 renderTableBody：用极简 DOM 垫片驱动表格节点的重绘与编辑状态机。
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => { JSON.stringify(a) === JSON.stringify(b) ? pass++ : fails.push(m + ' 期望' + JSON.stringify(b) + ' 实际' + JSON.stringify(a)); };

// ── 极简 DOM 垫片 ──
function makeEl(tag){
    const el = {
        tagName: String(tag).toUpperCase(), children: [], className: '', _text: '',
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

global.document = { createElement: makeEl, querySelector: () => null };
global.requestAnimationFrame = fn => fn();

// ── 从 canvas.js 抽出表格节点代码，配 shim 求值 ──
const canvasSrc = fs.readFileSync(path.join(__dirname, '../static/js/canvas.js'), 'utf8');
const start = canvasSrc.indexOf('function novaTableModel(){');
const end = canvasSrc.indexOf('function defaultNodeSize(type){');
ok(start > 0 && end > start, '能在 canvas.js 中定位表格节点代码段');
const block = canvasSrc.slice(start, end);

const added = [];
const api = new Function('document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid', block +
    '\nreturn {renderTableBody, addTableNode, ensureTableState, addTableColumn, addTableRow, deleteTableRow,' +
    ' toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth, novaTableModel};'
)(global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); return n; }, () => {}, p => p + '_1', null);

// NovaTableModel 从真实模块取
const model = require('../static/js/shared/table-model.js');
global.NovaTableModel = model;
// 重新求值一次（让 novaTableModel() 能读到）
const api2 = new Function('document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid', 'NovaTableModel', block +
    '\nreturn {renderTableBody, addTableNode, ensureTableState, addTableColumn, addTableRow, deleteTableRow,' +
    ' toggleTableRow, toggleAllTableRows, beginTableEdit, endTableEdit, syncTableNodeWidth, novaTableModel};'
)(global.document, global.requestAnimationFrame, () => ({x:0, y:0}), n => { added.push(n); return n; }, () => {}, p => p + '_1', model);

const A = api2;
const keydown = key => ({ key, shiftKey:false, preventDefault(){}, stopPropagation(){} });

// ── 建节点 ──
const node = A.addTableNode();
eq(node.type, 'table', '节点类型');
eq(node.table.columns, [], '新节点空表');
eq(node.table.rows, [], '新节点无行');
ok(/^tbl_1/.test(node.id), 'id 前缀 tbl');

const root = A.renderTableBody(node);
ok(root.classList.contains('table-node'), '根 class = table-node');
const grid = byClass(root, 'table-node-grid')[0];
ok(Boolean(grid), '有 table-node-grid');
ok(Number(String(grid.style.maxHeight).replace('px', '')) === model.MAX_NODE_HEIGHT - 66, 'grid 最大高 = MAX_NODE_HEIGHT-66');
ok(root._listeners.mousedown && root._listeners.mousedown[0], '根拦截 mousedown（不启动节点拖拽）');
ok(root._listeners.wheel && root._listeners.wheel[0], '根拦截 wheel（滚动表格而非缩放画布）');

const metaButtons = byClass(root, 'table-node-action').map(b => b.textContent);
eq(metaButtons, ['新增列', '新增行'], '信息条两个操作按钮');
eq(byClass(root, 'table-node-count')[0].textContent, '0 列 · 0 行', '计数文案');
eq(byClass(root, 'table-empty-cell')[0].textContent, '点「新增列」开始建表', '空表引导文案');

// ── 新增列 ──
A.addTableColumn(node);
eq(node.table.columns, ['未命名列'], '新增列');
eq(byClass(root, 'table-data-column').length, 1, 'colgroup 中的数据列');
eq(byTag(root, 'th').length, 3, '表头：全选 + 1 数据列 + 尾列');
eq(byClass(root, 'table-empty-cell')[0].textContent, '暂无数据，点「新增行」开始填写', '有列无行时的引导');

// ── 新增行 ──
A.addTableRow(node);
eq(node.table.rows, [['']], '新增行补空单元格');
eq(byTag(root, 'tbody')[0].children.length, 1, 'tbody 1 行');
eq(byTag(root, 'tbody')[0].children[0].children.length, 3, '每行 3 个单元格');
eq(byTag(root, 'tbody')[0].children[0].style.height, '44px', '空行高 = 44（textMin）');
ok(byClass(root, 'table-checkbox').length >= 2, '有选择框');

// ── 双击编辑单元格 → 提交 ──
A.beginTableEdit(node, {kind:'cell', row:0, column:0});
let editors = byClass(root, 'table-cell-editor');
eq(editors.length, 1, '出现 1 个单元格编辑器');
const editor = editors[0];
ok(editor.parentElement.classList.contains('is-editing'), '所在单元格标记 is-editing');
editor.value = '一只猫';
editor.onkeydown(keydown('Enter'));
eq(node.table.rows[0][0], '一只猫', 'Enter 提交到数据模型');
eq(byClass(root, 'table-cell-editor').length, 0, '提交后编辑器移除');
eq(byClass(root, 'is-editing').length, 0, '提交后无 is-editing');
eq(byClass(root, 'table-cell-view')[0].textContent, '一只猫', '视图已刷新');

// Shift+Enter 换行而非提交
A.beginTableEdit(node, {kind:'cell', row:0, column:0});
editors = byClass(root, 'table-cell-editor');
editors[0].value = 'a\nb';
editors[0].onkeydown({ key:'Enter', shiftKey:true, preventDefault(){}, stopPropagation(){} });
eq(byClass(root, 'table-cell-editor').length, 1, 'Shift+Enter 不提交、继续编辑');
editors = byClass(root, 'table-cell-editor');
editors[0].onkeydown(keydown('Escape'));
eq(node.table.rows[0][0], '一只猫', 'Escape 放弃修改');
eq(byClass(root, 'table-cell-editor').length, 0, 'Escape 退出编辑');

// 长文本 → 行高变化
node.table.rows[0][0] = 'x'.repeat(40);
A.beginTableEdit(node, {kind:'cell', row:0, column:0});
byClass(root, 'table-cell-editor')[0].onkeydown(keydown('Escape'));
eq(byTag(root, 'tbody')[0].children[0].style.height, '69px', '40 字折 3 行 → 24+3*15=69');

// ── 列重命名 ──
A.beginTableEdit(node, {kind:'column', column:0});
let headEditors = byClass(root, 'table-head-editor');
eq(headEditors.length, 1, '出现列名编辑器');
headEditors[0].value = '提示词';
headEditors[0].onkeydown(keydown('Enter'));
eq(node.table.columns, ['提示词'], '列名提交');
eq(byClass(root, 'table-head-label')[0].textContent, '提示词', '表头文字刷新');

// 重名去重
A.addTableColumn(node);
A.beginTableEdit(node, {kind:'column', column:1});
byClass(root, 'table-head-editor')[0].value = '提示词';
byClass(root, 'table-head-editor')[0].onkeydown(keydown('Enter'));
eq(node.table.columns, ['提示词', '提示词(2)'], '重名列自动去重');

// ── 选择行 ──
A.addTableRow(node);
A.toggleTableRow(node, 0, true);
eq(node.table.selectedRows, [0], '选中第 1 行');
ok(byTag(root, 'tbody')[0].children[0].classList.contains('is-selected'), '行标记 is-selected');
eq(byClass(root, 'table-node-picked')[0].textContent, '已选 1 行', '已选行数提示');
A.toggleAllTableRows(node, true);
eq(node.table.selectedRows, [0, 1], '全选');
A.toggleAllTableRows(node, false);
eq(node.table.selectedRows, [], '取消全选');

// ── 删除行 ──
A.addTableRow(node);
eq(node.table.rows.length, 3, '共 3 行');
byClass(root, 'table-row-delete')[1].onclick({ stopPropagation(){} });
eq(node.table.rows.length, 2, '删除第 2 行');

// ── 宽度同步 ──
A.syncTableNodeWidth(node);
eq(node.w, model.nodeSize(node.table, 0).width + 24, '节点宽 = 表格宽 + node-body 内边距');

// ── 空表状态回退 ──
const emptyNode = A.addTableNode();
const emptyRoot = A.renderTableBody(emptyNode);
A.addTableColumn(emptyNode);
A.addTableColumn(emptyNode);
A.addTableRow(emptyNode);
A.deleteTableRow(emptyNode, 0);
eq(emptyNode.table.rows, [], '删完行回到空表');
eq(byClass(emptyRoot, 'table-empty-cell')[0].textContent, '暂无数据，点「新增行」开始填写', '空行提示回退');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
