#!/usr/bin/env node
// table-model.js 的规范符合性测试。运行： node tests/test_table_model.js
'use strict';
const M = require('../static/js/shared/table-model.js');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => { JSON.stringify(a) === JSON.stringify(b) ? pass++ : fails.push(m + ' 期望' + JSON.stringify(b) + ' 实际' + JSON.stringify(a)); };
const throws = (fn, frag, m) => { let msg=''; try { fn(); } catch(e){ msg = String(e.message); } if(!msg){ fails.push(m+' 应抛错'); return; } String(msg).includes(frag) ? pass++ : fails.push(m+' 错误信息不含「'+frag+'」: '+msg); };

// ── 常量（DX OS: Wh / Zh / Vv / Fie / Bie / qie / Wie）──
eq(M.MAX_COLUMNS, 200, '列上限'); eq(M.MAX_ROWS, 5000, '行上限'); eq(M.MAX_CELL_CHARS, 20000, '单元格上限');
eq(M.LLM_MAX_COLUMNS, 40, 'LLM 列上限'); eq(M.LLM_MAX_ROWS, 200, 'LLM 行上限');
eq(M.COLUMN_WIDTH, 132, '列宽'); eq(M.RESERVED_WIDTH, 44, '预留宽'); eq(M.HEADER_HEIGHT, 38, '表头高');
eq(M.MAX_NODE_HEIGHT, 720, '最大高'); eq(M.INPUT_COLUMN_WIDTH, 112, '输入列宽');

// ── 归一化 ──
eq(M.normalizeTable(null).table, M.emptyTable(), '空输入 → 空表');
eq(M.normalizeTable({columns:['a','a',''],rows:[['1']]}).table.columns, ['a','a(2)','未命名列'], '列名去重+兜底');
eq(M.normalizeTable({columns:['a','b'],rows:[['1']]}).table.rows, [['1','']], '行按列数补齐');
eq(M.normalizeTable({columns:['a'],rows:[[{x:1}]]}).table.rows, [['{"x":1}']], '对象单元格 → JSON');
eq(M.normalizeTable({columns:['c'],rows:[['x'.repeat(25000)]]}).table.rows[0][0].length, 20000, '单元格截断');
{
  const cols=[]; for(let i=0;i<250;i++) cols.push('c'+i);
  eq(M.normalizeTable({columns:cols,rows:[]}).table.columns.length, 200, '列数截断');
}
{
  const rows=[]; for(let i=0;i<5100;i++) rows.push(['v']);
  eq(M.normalizeTable({columns:['c'],rows}).table.rows.length, 5000, '行数截断');
}
eq(M.normalizeTable({columns:['c'],rows:[['a']],selectedRows:[0,9,-1,'1']}).table.selectedRows, [0], 'selectedRows 越界过滤');
ok(!M.normalizeTable({columns:['a'],rows:[['b']]}).repaired, '合法表 repaired=false');

// ── 深拷贝 ──
{
  const src = M.normalizeTable({columns:['a'],rows:[['b']]}).table;
  const cp = M.cloneTable(src);
  cp.rows[0][0] = 'changed';
  eq(src.rows[0][0], 'b', 'cloneTable 深拷贝');
}

// ── 列定位（DX OS: o6 / Kh）──
{
  const tb = M.normalizeTable({columns:['提示词','品牌'],rows:[['x','y']]}).table;
  eq(M.columnIndex(tb, {column:1}), 0, '列序号 1-based');
  eq(M.columnIndex(tb, {columnName:'品牌'}), 1, '按列名定位');
  throws(() => M.columnIndex(tb, {column:3}), '列序号必须是 1–2', '列序号越界');
  throws(() => M.columnIndex(tb, {columnName:'无'}), '不存在列“无”', '列名不存在');
  throws(() => M.columnIndex({columns:['a','a'],rows:[[]]}, {columnName:'a'}), '不唯一', '列名不唯一');
  throws(() => M.rowIndex(tb, 9), '行序号必须是 1–1', '行序号越界');
}

// ── 操作 ──
{
  const base = () => M.normalizeTable({columns:['提示词','品牌'],rows:[['猫','Nike']]}).table;
  eq(M.applyOperation(base(),'set_cell',{row:1,columnName:'品牌',value:'Puma'}).rows[0], ['猫','Puma'], 'set_cell');
  eq(M.applyOperation(base(),'append_row',{values:['狗','Adidas']}).rows.length, 2, 'append_row 数组');
  eq(M.applyOperation(base(),'append_row',{values:{'品牌':'Puma'}}).rows[1], ['','Puma'], 'append_row 按列名');
  eq(M.applyOperation(base(),'delete_row',{row:1}).rows, [], 'delete_row');
  eq(M.applyOperation(base(),'add_column',{title:'品牌'}).columns, ['提示词','品牌','品牌(2)'], 'add_column 去重');
  eq(M.applyOperation(base(),'add_column',{title:'新'}).rows[0], ['猫','Nike',''], 'add_column 补空');
  eq(M.applyOperation(base(),'delete_column',{column:1}).columns, ['品牌'], 'delete_column');
  eq(M.applyOperation(base(),'read_table',{}).rows, base().rows, 'read_table');
  throws(() => M.applyOperation(base(),'drop',{}), '表格节点不支持操作：drop', '未知操作');
  // 不改动入参
  const b2 = base(); const snap = JSON.stringify(b2);
  M.applyOperation(b2,'set_cell',{row:1,column:1,value:'X'});
  eq(JSON.stringify(b2), snap, 'applyOperation 不改动入参');
}
{
  const rows=[]; for(let i=0;i<5000;i++) rows.push(['v']);
  const full = M.normalizeTable({columns:['c'],rows}).table;
  throws(() => M.applyOperation(full,'append_row',{values:['x']}), '最多允许 5000 行', '行上限');
}

// ── 操作契约（照搬 builtinCanvasNodes.ts）──
eq(M.describeOperation('read_table').risk, 'low', 'read risk');
eq(M.describeOperation('read_table').confirmation, 'on-ambiguity', 'read confirmation');
eq(M.describeOperation('delete_row').risk, 'medium', 'delete_row risk');
eq(M.describeOperation('delete_row').confirmation, 'on-risk', 'delete_row confirmation');
eq(M.describeOperation('delete_column').confirmation, 'on-risk', 'delete_column confirmation');
eq(M.describeOperation('nope'), null, '未知操作描述');
eq(M.OPERATION_IDS.length, 6, '操作数 6');
ok(!M.requiresConfirmation('delete_row',{}), 'on-risk 非风险不确认');
ok(M.requiresConfirmation('delete_row',{risky:true}), 'on-risk 风险时确认');

// ── 行高（DX OS: mR：18 字/行 × 15px + 24 padding，夹在 [44|144, 160]）──
eq(M.rowHeight([]), 44, '空 → textMin');
eq(M.rowHeight(['a'.repeat(18)]), 44, '18 字 → 被 textMin 夹住');
eq(M.rowHeight(['a'.repeat(19)]), 54, '19 字 → 2 行 = 54');
eq(M.rowHeight([['a','b'].join(String.fromCharCode(10))]), 54, '两行真实换行 → 54');
eq(M.rowHeight(['a'], {hasMedia:true, mediaMinHeight:144, maxHeight:160}), 144, '有媒体 → mediaMin 144');
eq(M.rowHeight([('x'.repeat(18)+String.fromCharCode(10)).repeat(20)], {maxHeight:160}), 160, '超长 → maxHeight 160');

// ── 节点尺寸（DX OS: Yw）──
eq(M.nodeSize(M.emptyTable(),0).width, 280, '空表宽 = max(280, ...)');
eq(M.nodeSize(M.normalizeTable({columns:['a','b'],rows:[]}).table,0).width, 310, '2 列宽 = 2*132+44+2');
eq(M.nodeSize(M.normalizeTable({columns:['a'],rows:[]}).table,2).width, 442, '输入列计入宽度 (1+2)*132+44+2');
eq(M.nodeSize(M.emptyTable(),0).height, 38+44+2, '空表高 = 38+44+2');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
