
const path = require('path');
const W = require(path.resolve('static/js/shared/workflow-utils.js'));
let pass = 0; const fails = [];
const eq = (a,b,m) => JSON.stringify(a)===JSON.stringify(b) ? pass++ : fails.push(m+' 期望'+JSON.stringify(b)+' 实际'+JSON.stringify(a));
const ok = (c,m) => c ? pass++ : fails.push(m);

let schema = W.normalizeTableSchema({ columns: [{ title: 'Brand', key: 'brand' }] });
let rows = W.setTableColumnValue(schema, [{rowId:'r1'}], 0, { key:'brand' }, 'Nike');
const renamed = W.renameTableColumn(schema, { key:'brand' }, '品牌');
eq(renamed.columns[0].key, 'brand', '改列名后 key 不变');
eq(renamed.columns[0].title, '品牌', '标题已更新');
ok(rows[0].extra.brand === 'Nike', '原单元格按 key 仍可访问');

// 重名时标题自动去重，key 仍各自保留
let two = W.normalizeTableSchema({ columns: [{title:'A',key:'a'},{title:'B',key:'b'}] });
const dup = W.renameTableColumn(two, { key:'b' }, 'A');
eq(dup.columns.map(c=>c.title), ['A','A(2)'], '重名去重');
eq(dup.columns.map(c=>c.key), ['a','b'], 'key 均保留');
console.log('通过 ' + pass + '/' + (pass+fails.length));
if(fails.length){ fails.forEach(f=>console.log('  - '+f)); process.exit(1); }
console.log('全部通过');
