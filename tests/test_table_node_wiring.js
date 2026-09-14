
const fs = require('fs');
const canvas = fs.readFileSync('static/js/canvas.js', 'utf8');
const css = fs.readFileSync('static/css/table-node.css', 'utf8');
const html = fs.readFileSync('static/canvas.html', 'utf8');
const model = fs.readFileSync('static/js/shared/table-model.js', 'utf8');
let fail = 0;
const ok = (c, m) => { if(!c){ console.log('  ✗ ' + m); fail++; } else console.log('  ✓ ' + m); };

console.log('[1] 函数定义');
['novaTableModel','ensureTableState','addTableNode','syncTableNodeWidth','repaintTable','addTableRow',
 'addTableColumn','deleteTableRow','toggleTableRow','toggleAllTableRows','beginTableEdit','endTableEdit',
 'bindTableCellEditor','bindTableHeadEditor','renderTableBody'].forEach(name => {
  ok(new RegExp('function ' + name + '\\s*\\(').test(canvas), name + ' 已定义');
});
console.log('[2] 依赖的既有函数');
['defaultPoint','addNode','scheduleSave','tr','uid'].forEach(name => {
  ok(new RegExp('(function|var|let|const)\\s+' + name + '\\s*[=(]').test(canvas), name + ' 存在');
});
console.log('[3] 全局名对齐');
ok(/root\.NovaTableModel = api/.test(model), 'table-model.js 导出 NovaTableModel');
ok(/typeof NovaTableModel !== 'undefined'/.test(canvas), 'canvas.js 读取 NovaTableModel');
ok(html.includes('shared/table-model.js'), 'canvas.html 引入 table-model.js');
ok(html.includes('css/table-node.css'), 'canvas.html 引入 table-node.css');
ok(html.includes("menuAdd('table')"), 'canvas.html 有表格菜单入口');
ok(html.indexOf('marvis-shared.css') < html.indexOf('table-node.css'), 'table-node.css 在 marvis-shared.css 之后');
ok(html.indexOf('node-registry.js') < html.indexOf('table-model.js'), 'table-model.js 在 node-registry.js 之后');

console.log('[4] CSS 类覆盖');
const used = new Set();
(canvas.match(/table-[a-z-]+/g) || []).forEach(c => used.add(c));
const missing = [...used].filter(c => !css.includes('.' + c));
ok(missing.length === 0, 'JS 用到的 table-* 类全部有样式' + (missing.length ? ' 缺: ' + missing.join(', ') : ''));

console.log('[5] 分发接线');
['createNodeByType 分支','menuAdd 分支','defaultNodeSize 分支','标题三元','body 分支'].forEach((label, i) => {
  const needles = ["if(type === 'table') return addTableNode(point);", "if(type === 'table') addTableNode(menuPoint);",
    "if(type === 'table') return {w:310, h:0};", "node.type === 'table' ? tr('canvas.tableNode') :",
    "if(node.type === 'table') body.appendChild(renderTableBody(node));"];
  ok(canvas.includes(needles[i]), label);
});
ok(/'minimax','table'\]\.includes\(node\.type\)/.test(canvas) || canvas.includes("'minimax','table']"), 'table 有输入端口');
ok(canvas.includes("'output','table']"), 'table 有输出端口');

console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过');
process.exit(fail ? 1 : 0);
