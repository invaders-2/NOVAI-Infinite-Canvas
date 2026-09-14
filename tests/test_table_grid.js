#!/usr/bin/env node
// table-grid.js 的纯函数测试。运行： node tests/test_table_grid.js
'use strict';

const Grid = require('../static/js/shared/table-grid.js');

let passed = 0;
const failures = [];

function check(name, fn){
    try {
        fn();
        passed += 1;
    } catch (error) {
        failures.push(name + ' → ' + error.message);
    }
}

function eq(actual, expected, label){
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if(a !== b) throw new Error((label || '') + ' 期望 ' + b + '，实际 ' + a);
}

function ok(value, label){ if(!value) throw new Error((label || '') + ' 期望为真'); }

function throws(fn, fragment, label){
    let message = '';
    try { fn(); } catch (error) { message = String(error.message); }
    if(!message) throw new Error((label || '') + ' 期望抛错但没有');
    if(fragment && message.indexOf(fragment) < 0){
        throw new Error((label || '') + ' 错误信息不含「' + fragment + '」，实际：' + message);
    }
}

function baseTable(){
    return Grid.normalizeTable({
        columns: ['提示词', '品牌'],
        rows: [['一只猫', 'Nike'], ['一只狗', 'Adidas']]
    }).table;
}

// ---- 归一化 --------------------------------------------------------------

check('空输入产出合法空表', () => eq(Grid.normalizeTable(null).table, Grid.emptyTable()));

check('非字符串列名/错长行被修复', () => {
    const result = Grid.normalizeTable({ columns: ['a', 2, ''], rows: [['1'], ['1', '2', '3'], 'bad'] });
    ok(result.repaired, 'repaired');
    // 列数保持 3（数字会被 String 化保留，与 DXOS 归一行为一致），空串兜底为未命名列
    eq(result.table.columns, ['a', '2', '未命名列'], '列名归一');
    // 行按列数补齐到 3；非数组元素被丢弃
    eq(result.table.rows, [['1', '', ''], ['1', '2', '3']], '行对齐');
});

check('列名去重', () => eq(Grid.normalizeColumnTitles(['x', 'x', 'x']), ['x', 'x(2)', 'x(3)']));

check('列名 trim 与空值兜底', () => eq(Grid.normalizeColumnTitles(['  a  ', '   ']), ['a', '未命名列']));

check('列数上限 200', () => {
    const cols = [];
    for(let i = 0; i < 250; i += 1) cols.push('c' + i);
    const result = Grid.normalizeTable({ columns: cols, rows: [] });
    eq(result.table.columns.length, Grid.MAX_COLUMNS, '列数');
    ok(result.issues.length > 0, '有 issues');
});

check('行数上限 5000', () => {
    const rows = [];
    for(let i = 0; i < 5100; i += 1) rows.push(['v' + i]);
    const result = Grid.normalizeTable({ columns: ['c'], rows: rows });
    eq(result.table.rows.length, Grid.MAX_ROWS, '行数');
});

check('单元格 20000 字符截断', () => {
    const long = 'x'.repeat(25000);
    const result = Grid.normalizeTable({ columns: ['c'], rows: [[long]] });
    eq(result.table.rows[0][0].length, Grid.MAX_CELL_CHARS, '单元格长度');
});

check('对象单元格序列化为 JSON', () => {
    const result = Grid.normalizeTable({ columns: ['c'], rows: [[{ a: 1 }]] });
    eq(result.table.rows[0][0], '{"a":1}', 'JSON');
});

check('合法表不被标记 repaired', () => ok(!Grid.normalizeTable(baseTable()).repaired, 'repaired=false'));

check('selectedRows 越界被过滤', () => {
    // 只有 1 行（合法下标 0），5 / -1 / '1' 全部越界被过滤
    const result = Grid.normalizeTable({ columns: ['c'], rows: [['a']], selectedRows: [0, 5, -1, '1'] });
    eq(result.table.selectedRows, [0], 'selectedRows');
});

// ---- 定位 -----------------------------------------------------------------

check('列序号 1-based 且越界报错', () => {
    const table = baseTable();
    eq(Grid.resolveColumnIndex(table, { column: 1 }), 0, '第 1 列');
    eq(Grid.resolveColumnIndex(table, { column: 2 }), 1, '第 2 列');
    throws(() => Grid.resolveColumnIndex(table, { column: 3 }), '列序号必须是 1–2', '越界');
    throws(() => Grid.resolveColumnIndex(table, { column: 0 }), '列序号必须是 1–2', '下界');
});

check('列名定位优先于序号', () => eq(Grid.resolveColumnIndex(baseTable(), { columnName: '品牌', column: 1 }), 1));

check('列名不存在报错', () => throws(() => Grid.resolveColumnIndex(baseTable(), { columnName: '尺寸' }), '不存在列“尺寸”'));

check('列名重复报错', () => {
    // 归一化会去重，因此手工构造重复列名表绕过归一化
    const table = { kind: 'table', version: 1, columns: ['a', 'a'], rows: [['1', '2']], selectedRows: [], mergedGroups: [] };
    throws(() => Grid.columnIndexByTitle(table, 'a'), '不唯一');
});

check('行序号越界报错', () => throws(() => Grid.resolveRowIndex(baseTable(), 9), '行序号必须是 1–2'));

// ---- 操作 -----------------------------------------------------------------

check('set_cell', () => {
    const out = Grid.applyOperation(baseTable(), 'set_cell', { row: 1, columnName: '品牌', value: 'Puma' });
    eq(out.rows[0], ['一只猫', 'Puma'], '单元格');
});

check('append_row 数组形式', () => {
    const out = Grid.applyOperation(baseTable(), 'append_row', { values: ['一只鸟', 'Puma'] });
    eq(out.rows.length, 3, '行数');
    eq(out.rows[2], ['一只鸟', 'Puma'], '新行');
});

check('append_row 对象形式按列名映射', () => {
    const out = Grid.applyOperation(baseTable(), 'append_row', { values: { '品牌': 'Puma' } });
    eq(out.rows[2], ['', 'Puma'], '按列名');
});

check('append_row 行数上限', () => {
    const rows = [];
    for(let i = 0; i < Grid.MAX_ROWS; i += 1) rows.push(['v']);
    const table = Grid.normalizeTable({ columns: ['c'], rows: rows }).table;
    throws(() => Grid.applyOperation(table, 'append_row', { values: ['x'] }), '最多允许 5000 行');
});

check('delete_row 并修正 selectedRows', () => {
    const table = Grid.normalizeTable({ columns: ['c'], rows: [['a'], ['b'], ['c']], selectedRows: [0, 1, 2] }).table;
    // row 是 1-based：row=1 删第一行
    const out = Grid.applyOperation(table, 'delete_row', { row: 1 });
    eq(out.rows, [['b'], ['c']], '行');
    eq(out.selectedRows, [0, 1], '选中索引左移');
});

check('add_column 补空单元格并去重', () => {
    const out = Grid.applyOperation(baseTable(), 'add_column', { title: '品牌' });
    eq(out.columns, ['提示词', '品牌', '品牌(2)'], '列名');
    eq(out.rows[0], ['一只猫', 'Nike', ''], '补空');
});

check('delete_column 同步删行内单元格', () => {
    // column 是 1-based：column=1 删第一列（提示词）
    const out = Grid.applyOperation(baseTable(), 'delete_column', { column: 1 });
    eq(out.columns, ['品牌'], '列');
    eq(out.rows, [['Nike'], ['Adidas']], '行');
    // 用列名删第二列
    const byName = Grid.applyOperation(baseTable(), 'delete_column', { columnName: '品牌' });
    eq(byName.columns, ['提示词'], '按列名删');
});

check('未知操作报错', () => throws(() => Grid.applyOperation(baseTable(), 'drop_table', {}), '不支持操作：drop_table'));

// ---- 操作契约 -------------------------------------------------------------

check('操作契约分级正确', () => {
    eq(Grid.describeOperation('read_table').risk, 'low', 'read risk');
    eq(Grid.describeOperation('read_table').confirmation, 'on-ambiguity', 'read confirmation');
    eq(Grid.describeOperation('delete_row').risk, 'medium', 'delete risk');
    eq(Grid.describeOperation('delete_row').confirmation, 'on-risk', 'delete confirmation');
    eq(Grid.describeOperation('delete_row').idempotency, 'keyed', 'idempotency');
    eq(Grid.describeOperation('nope'), null, '未知操作');
    eq(Grid.operationIds().length, 6, '操作数');
});

check('requiresConfirmation 语义', () => {
    ok(!Grid.requiresConfirmation('delete_row', {}), 'on-risk 非风险场景不确认');
    ok(Grid.requiresConfirmation('delete_row', { risky: true }), 'on-risk 风险场景确认');
    ok(!Grid.requiresConfirmation('set_cell', {}), 'on-ambiguity 明确时不确认');
    ok(Grid.requiresConfirmation('set_cell', { ambiguous: true }), 'on-ambiguity 歧义时确认');
});

// ---- 幂等 -----------------------------------------------------------------

check('同 requestId 回放且数据不变', () => {
    const first = Grid.planTableOperation(baseTable(), 'set_cell', { row: 1, columnName: '品牌', value: 'Puma' }, 'r1', []);
    ok(first.changed, '首次 changed');
    ok(!first.replayed, '首次非回放');
    eq(first.table.rows[0], ['一只猫', 'Puma'], '首次生效');
    // 同一 requestId 再来一次，且这次试图改别的值——必须被拒、数据不变
    const second = Grid.planTableOperation(first.table, 'set_cell', { row: 1, columnName: '品牌', value: 'Nike' }, 'r1', first.requestIds);
    ok(second.replayed, '二次回放');
    ok(!second.changed, '回放不改数据');
    eq(second.table.rows[0], ['一只猫', 'Puma'], '数据保持首次结果');
});

check('不同 requestId 正常执行', () => {
    const first = Grid.planTableOperation(baseTable(), 'append_row', { values: ['a', 'b'] }, 'r1', []);
    const second = Grid.planTableOperation(first.table, 'append_row', { values: ['c', 'd'] }, 'r2', first.requestIds);
    ok(!second.replayed, '非回放');
    eq(second.table.rows.length, 4, '两次都生效');
});

check('read_table 不写 requestId', () => {
    const out = Grid.planTableOperation(baseTable(), 'read_table', {}, 'r1', []);
    eq(out.requestIds, [], '不记录');
    ok(!out.changed, '只读不产生变更');
});

check('requestId 缓冲上限 64', () => {
    let ids = [];
    for(let i = 0; i < 100; i += 1) ids = Grid.appendRequestId(ids, 'r' + i);
    eq(ids.length, Grid.MAX_REQUEST_IDS, '长度');
    eq(ids[ids.length - 1], 'r99', '保留最新');
    ok(Grid.hasRequestId(ids, 'r99'), '最新可命中');
    ok(!Grid.hasRequestId(ids, 'r0'), '最旧已淘汰');
});

check('requestId 去重不产生重复项', () => {
    let ids = Grid.appendRequestId([], 'r1');
    ids = Grid.appendRequestId(ids, 'r1');
    eq(ids, ['r1'], '去重');
});

check('planTableOperation 不改动入参', () => {
    const table = baseTable();
    const snapshot = JSON.stringify(table);
    Grid.planTableOperation(table, 'set_cell', { row: 1, column: 1, value: 'X' }, 'r1', []);
    eq(JSON.stringify(table), snapshot, '入参未被修改');
});

// ---- 输入列 ---------------------------------------------------------------

check('ensureInputColumns 生成输入列', () => {
    const out = Grid.ensureInputColumns(baseTable(), 3);
    eq(out.columns, ['生成输入', '输入 1', '输入 2', '提示词', '品牌'], '列名');
    eq(out.rows[0], ['', '', '', '一只猫', 'Nike'], '补空');
});

check('ensureInputColumns 幂等', () => {
    const once = Grid.ensureInputColumns(baseTable(), 2);
    const twice = Grid.ensureInputColumns(once, 2);
    eq(twice.columns, once.columns, '重复调用不变');
});

check('detachInputColumns 剥离且幂等', () => {
    const withInputs = Grid.ensureInputColumns(baseTable(), 2);
    const first = Grid.detachInputColumns(withInputs);
    eq(first.detached, 2, '剥离数量');
    eq(first.table.columns, ['提示词', '品牌'], '剩余列');
    const second = Grid.detachInputColumns(first.table);
    eq(second.detached, 0, '二次剥离为 0');
});

check('isInputColumn 词表', () => {
    ok(Grid.isInputColumn('生成输入'), '生成输入');
    ok(Grid.isInputColumn('输入 1'), '输入 1');
    ok(Grid.isInputColumn('输入 12'), '输入 12');
    ok(!Grid.isInputColumn('品牌'), '品牌');
    ok(!Grid.isInputColumn('输入abc'), '输入abc');
});

// ---- 输出 -----------------------------------------------------------------

const total = passed + failures.length;
console.log('通过 ' + passed + '/' + total);
if(failures.length){
    console.log('失败：');
    failures.forEach(function(item){ console.log('  - ' + item); });
    process.exit(1);
}
console.log('全部通过');
