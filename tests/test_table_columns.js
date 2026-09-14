
const path = require('path');
const W = require(path.resolve('static/js/shared/workflow-utils.js'));
let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => { JSON.stringify(a) === JSON.stringify(b) ? pass++ : fails.push(m + ' 期望' + JSON.stringify(b) + ' 实际' + JSON.stringify(a)); };

const cols = W.normalizeTableColumns(['品牌', '', '品牌', 'x'.repeat(200)]);
eq(cols.length, 4, '列数保持');
eq(cols[0].title, '品牌', '标题保留');
eq(cols[0].key, 'col', '非 ASCII key 兜底');
eq(cols[1].title, '未命名列', '空标题兜底');
eq(cols[2].title, '品牌(2)', '同名去重');
ok(cols[3].title.length === 120, '标题截断 120');
ok(cols.every(c => /^[a-z][a-z0-9_-]{0,63}$/.test(c.key)), '所有 key 合法');

// addTableColumn 不改动入参
const schema = W.normalizeTableSchema({ columns: [{ title: 'Brand', key: 'brand' }] });
const rows = [{ rowId: 'r1' }, { rowId: 'r2' }];
const snapshot = JSON.stringify({ schema, rows });
let r1 = W.addTableColumn(schema, rows, 'Scene');
eq(r1.schema.columns.length, 2, '加列后 2 列');
eq(JSON.stringify({ schema, rows }), snapshot, 'addTableColumn 不改动入参');

let r2 = W.setTableColumnValue(r1.schema, r1.rows, 0, { key: 'brand' }, 'Nike');
eq(r2[0].extra.brand, 'Nike', '写单元格');
eq(r2[1].extra.brand, undefined, '其他行不受影响');

// 列定位三通道
eq(W.resolveTableColumnIndex(r1.schema, { key: 'brand' }), 0, 'key 定位');
eq(W.resolveTableColumnIndex(r1.schema, { title: 'Scene' }), 1, '标题定位');
eq(W.resolveTableColumnIndex(r1.schema, { column: 2 }), 1, '序号定位');
try { W.resolveTableColumnIndex(r1.schema, { column: 9 }); fails.push('越界应抛错'); } catch(e){ ok(/1–2/.test(e.message), '越界错误信息'); }
try { W.resolveTableColumnIndex(r1.schema, { title: 'nope' }); fails.push('不存在应抛错'); } catch(e){ ok(/不存在数据列/.test(e.message), '不存在错误信息'); }

// 删列
let r3 = W.deleteTableColumn(r1.schema, r2, { key: 'brand' });
eq(r3.schema.columns.length, 1, '删列后 1 列');
eq(r3.rows[0].extra.brand, undefined, '单元格被清除');

// normalizeRowExtra 只保留已知列 + 截断
const long = 'y'.repeat(25000);
const extra = W.normalizeRowExtra({ brand: long, ghost: 'x' }, r3.schema);
ok(extra.ghost === undefined, '未知列被剔除');
ok(extra.brand === undefined || extra.brand.length <= 20000, '截断');

// normalizeMatrixNode / Row 集成
const node = W.normalizeMatrixNode({ rows: [{ prompt: 'p', extra: { a: '1' } }], tableSchema: { columns: [{ title: 'A', key: 'a' }] } });
ok(!!node.tableSchema, '节点有 tableSchema');
eq(node.tableSchema.version, 1, 'schema 版本');
eq(node.rows[0].extra.a, '1', '行 extra 保留');
ok(W.EXECUTION_INPUT_KEYS.indexOf('extra') < 0, 'extra 不在 EXECUTION_INPUT_KEYS');
ok(W.EXECUTION_INPUT_KEYS.indexOf('tableSchema') < 0, 'tableSchema 不在 EXECUTION_INPUT_KEYS');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
