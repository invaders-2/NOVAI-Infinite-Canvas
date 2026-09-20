/* 表格/批量节点滚轮放行的静态回归断言。
   背景：画布的滚轮监听会 preventDefault 做缩放/平移，落在表格上的滚轮被画布吃掉，
   表格滚不动。两个画布各自要放行 .table-node-grid / .table-batch-panel，且不能整块放行节点。
   跑法：node tests/test_table_wheel_passthrough.js */
const fs = require('fs');
const smart = fs.readFileSync('static/js/smart-canvas.js', 'utf8');
const classic = fs.readFileSync('static/js/canvas.js', 'utf8');
let fail = 0;
const ok = (c, m) => { if(!c){ console.log('  ✗ ' + m); fail++; } else console.log('  ✓ ' + m); };

console.log('[1] 智能画布 WHEEL_LOCK_SELECTOR 放行可滚动区');
const lockBlock = (smart.match(/const WHEEL_LOCK_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || '';
ok(lockBlock.length > 100, '找得到 WHEEL_LOCK_SELECTOR 数组');
ok(/['"]\.table-node-grid['"]/.test(lockBlock), "放行 '.table-node-grid'");
ok(/['"]\.table-batch-panel['"]/.test(lockBlock), "放行 '.table-batch-panel'");
ok(!/['"]\.table-node['"]/.test(lockBlock), "未整块放行 '.table-node'（节点其余部分仍可缩放）");
ok(!/['"]\.table-batch-host['"]/.test(lockBlock), "未整块放行 '.table-batch-host'");

console.log('[2] 经典画布 board.onwheel 放行可滚动区');
const onwheel = (classic.match(/board\.onwheel = e => \{([\s\S]*?)\n\};/) || [])[1] || '';
ok(onwheel.length > 100, '找得到 board.onwheel 处理器');
const guardIdx = onwheel.indexOf('.table-node-grid');
const preventIdx = onwheel.indexOf('e.preventDefault()');
ok(guardIdx >= 0 && preventIdx >= 0 && guardIdx < preventIdx,
   '放行判断在 preventDefault 之前（先 return 后缩放）');
ok(/\.table-batch-panel/.test(onwheel), "放行 '.table-batch-panel'");
ok(!/closest\?\.?\('\.table-node'\s*[,)]/.test(onwheel), "未整块放行 '.table-node'");

console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过');
process.exit(fail ? 1 : 0);
