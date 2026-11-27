#!/usr/bin/env node
// table-model.js「智能」数据层（AI 列 / 选区 / 批量写格 / 执行计划 / 解析 / 对比回滚）的测试。
// 运行： node tests/test_table_ai_model.js
'use strict';
const M = require('../static/js/shared/table-model.js');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => { JSON.stringify(a) === JSON.stringify(b) ? pass++ : fails.push(m + ' 期望' + JSON.stringify(b) + ' 实际' + JSON.stringify(a)); };
const throws = (fn, frag, m) => { let msg=''; try { fn(); } catch(e){ msg = String(e.message); } if(!msg){ fails.push(m+' 应抛错'); return; } String(msg).includes(frag) ? pass++ : fails.push(m+' 错误信息不含「'+frag+'」: '+msg); };

// ── 常量与导出 ──
eq(M.AI_COLUMN_BATCH_ROWS, 20, '默认每批 20 行');
eq(M.AI_COLUMN_BATCH_ROWS_MAX, 50, '每批上限 50 行');
eq(M.AI_INSTRUCTION_MAX_CHARS, M.MAX_CELL_CHARS, '指令长度上限沿用单元格上限');
ok(M.AI_COLUMN_MAX_TOKENS > 0, 'max_tokens 常量单独导出');
eq(M.TABLE_SNAPSHOT_KIND, 'table-snapshot', '快照 kind');
['normalizeSelection', 'planAiColumn', 'aiColumnPrompt', 'batchRewritePrompt', 'parseAiValues', 'diffTables', 'tableSnapshot'].forEach(name => {
  eq(typeof M[name], 'function', '导出 ' + name);
});

// ═══ AI 列（aiColumns）：与 columns 平行的指令数组 ═══
{
  const t = M.normalizeTable({columns:['场景描述','卖点'], rows:[['海边','轻']]}).table;
  eq(t.aiColumns, [null, null], '没有 aiColumns 的老数据 → 与列数对齐的 null 数组');
  ok(!('selection' in t), '没有 selection 的老数据 → 不凭空多出字段');
  eq(typeof t.columns[0], 'string', 'columns 仍然是字符串数组（没有被改成对象）');

  eq(M.normalizeTable({columns:['a','b','c'], rows:[['1','2','3']],
    aiColumns:[{instruction:'  改写   ', updatedAt:12.9}, null, 'x']}).table.aiColumns,
    [{instruction:'改写', updatedAt:12}, null, null], 'aiColumns 归一化：trim、时间戳取整、非法项归 null');
  eq(M.normalizeTable({columns:['a','b'], rows:[['1','2']], aiColumns:[{instruction:'只给一条'}]}).table.aiColumns.length, 2,
    '短数组补齐到列数');
  eq(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:'x'},{instruction:'y'}]}).table.aiColumns,
    [{instruction:'x', updatedAt:0}], '超长数组截到列数');
  const long = 'x'.repeat(M.AI_INSTRUCTION_MAX_CHARS + 100);
  eq(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:long, updatedAt:5}]}).table.aiColumns[0].instruction.length,
    M.AI_INSTRUCTION_MAX_CHARS, '指令按上限截断');
  eq(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:'   '}]}).table.aiColumns, [null], '空白指令算没有');
  eq(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:'x', updatedAt:'昨天'}]}).table.aiColumns[0].updatedAt,
    0, '非法 updatedAt 归 0');

  ok(!M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:'写点东西', updatedAt:1}]}).repaired,
    '规范的 aiColumns 算干净数据（repaired=false）');
  ok(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:'x'}).repaired, 'aiColumns 不是数组 → repaired');
  eq(M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:'x'}).table.aiColumns, [null],
    '非法 aiColumns 平滑降级成全 null');
  eq(M.normalizeTable({columns:[], rows:[], aiColumns:[{instruction:'x'}]}).table.aiColumns, [],
    '没有列时 aiColumns 也是空数组');
}

// ═══ cloneTable 深拷贝隔离 ═══
{
  const src = M.normalizeTable({columns:['a','b'], rows:[['1','2']],
    aiColumns:[{instruction:'改成口语', updatedAt:9}], selection:{r0:0,c0:0,r1:0,c1:1}}).table;
  const cp = M.cloneTable(src);
  eq(cp.aiColumns, src.aiColumns, 'cloneTable 带上 aiColumns');
  ok(cp.aiColumns[0] !== src.aiColumns[0], 'aiColumns 元素是新对象（不是共享引用）');
  cp.aiColumns[0].instruction = '改坏了';
  eq(src.aiColumns[0].instruction, '改成口语', '改克隆体的 AI 指令不影响原表');
  cp.selection.r0 = 99;
  eq(src.selection.r0, 0, '改克隆体的选区不影响原表');
  cp.rows[0][0] = 'changed';
  eq(src.rows[0][0], '1', '行照旧深拷贝');
  eq(M.cloneTable(null).aiColumns, [], '空表 cloneTable 也有对齐的 aiColumns');
}

// ═══ 列增删：aiColumns 同步对齐 ═══
{
  const base = () => M.normalizeTable({columns:['场景','卖点'], rows:[['海边','轻']],
    aiColumns:[{instruction:'改写成 30 字口语', updatedAt:7}, null]}).table;
  const added = M.applyOperation(base(), 'add_column', {title:'风格'});
  eq(added.columns, ['场景','卖点','风格'], 'add_column 照旧加列');
  eq(added.aiColumns, [{instruction:'改写成 30 字口语', updatedAt:7}, null, null],
    'add_column 追加 null，原指令留在原列');
  eq(added.rows[0], ['海边','轻',''], 'add_column 照旧补空格');

  eq(M.applyOperation(base(), 'delete_column', {column:1}).aiColumns, [null], 'delete_column 同步删掉对应指令');
  eq(M.applyOperation(base(), 'delete_column', {columnName:'卖点'}).aiColumns,
    [{instruction:'改写成 30 字口语', updatedAt:7}], '按列名删列同样对齐');
  eq(M.applyOperation(base(), 'delete_row', {row:1}).aiColumns.length, 2, 'delete_row 不动 aiColumns');

  const legacy = M.normalizeTable({columns:['a'], rows:[['1']]}).table;
  eq(M.applyOperation(legacy, 'delete_column', {column:1}).aiColumns, [], '老数据删列 → 空 aiColumns');
  eq(M.applyOperation(legacy, 'add_column', {title:'b'}).aiColumns, [null, null], '老数据加列 → 对齐 null');
}

// ═══ 选区：越界钳制 / 反序交换 / 非法清掉 ═══
{
  const t = M.normalizeTable({columns:['a','b','c'], rows:[['1','2','3'],['4','5','6'],['7','8','9']]}).table;
  eq(M.normalizeSelection(t, {r0:2,c0:2,r1:0,c1:0}), {r0:0,c0:0,r1:2,c1:2}, '反序交换成左上/右下');
  eq(M.normalizeSelection(t, {r0:-5,c0:-5,r1:99,c1:99}), {r0:0,c0:0,r1:2,c1:2}, '越界钳制到表边界');
  eq(M.normalizeSelection(t, {r0:1.9,c0:1.2,r1:1,c1:1}), {r0:1,c0:1,r1:1,c1:1}, '小数向下取整');
  eq(M.normalizeSelection(t, {r0:0,c0:0}), null, '缺字段 → null');
  eq(M.normalizeSelection(t, {r0:'x',c0:0,r1:0,c1:0}), null, '非数字 → null');
  eq(M.normalizeSelection(t, {r0:0,c0:0,r1:Infinity,c1:0}), null, 'Infinity → null');
  eq(M.normalizeSelection(t, null), null, 'null → null');
  eq(M.normalizeSelection(M.emptyTable(), {r0:0,c0:0,r1:0,c1:0}), null, '空表 → null');

  const kept = M.normalizeTable({columns:['a'], rows:[['1'],['2']], selection:{r0:1,c0:0,r1:0,c1:0}}).table;
  eq(kept.selection, {r0:0,c0:0,r1:1,c1:0}, '合法选区归一后留在表上');
  const cleared = M.normalizeTable({columns:['a'], rows:[['1']], selection:{r0:0,c0:0}}).table;
  ok(!('selection' in cleared), '非法选区被清掉（不残留半截对象）');
  eq(M.normalizeTable({columns:['a'], rows:[['1']], selection:{r0:9,c0:0,r1:9,c1:9}}).table.selection,
    {r0:0,c0:0,r1:0,c1:0}, '越界选区被夹回');

  const lastRow = M.normalizeTable({columns:['a'], rows:[['1'],['2']],
    selection:{r0:1,c0:0,r1:1,c1:0}}).table;
  eq(M.applyOperation(lastRow, 'delete_row', {row:2}).selection, {r0:0,c0:0,r1:0,c1:0}, '删掉选中行 → 选区夹回');
  const onlyRow = M.normalizeTable({columns:['a'], rows:[['1']], selection:{r0:0,c0:0,r1:0,c1:0}}).table;
  ok(!('selection' in M.applyOperation(onlyRow, 'delete_row', {row:1})), '删到没有行 → 选区整条清掉');
  const twoCols = M.normalizeTable({columns:['a','b'], rows:[['1','2']],
    selection:{r0:0,c0:1,r1:0,c1:1}}).table;
  eq(M.applyOperation(twoCols, 'delete_column', {column:2}).selection, {r0:0,c0:0,r1:0,c1:0}, '删掉选中列 → 选区夹回');
}

// ═══ set_cells：批量写格，一格非法整批不写 ═══
{
  eq(M.describeOperation('set_cells'), {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
    confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'批量修改单元格'}, 'set_cells 操作契约');
  ok(M.OPERATION_IDS.includes('set_cells'), 'set_cells 进入操作清单');
  ok(!M.requiresConfirmation('set_cells', {}), 'set_cells 非歧义不确认');
  ok(M.requiresConfirmation('set_cells', {ambiguous:true}), 'set_cells 歧义时确认');

  const base = () => M.normalizeTable({columns:['提示词','品牌','备注'],
    rows:[['猫','Nike','旧'],['狗','Puma','旧']]}).table;
  const out = M.applyOperation(base(), 'set_cells', {cells:[
    {row:1, column:1, value:'一只猫'},
    {row:1, columnName:'品牌', value:'Adidas'},
    {row:2, column:3, value:'新'},
  ]});
  eq(out.rows, [['一只猫','Adidas','旧'],['狗','Puma','新']], 'set_cells 一次写多格（序号与列名混用）');
  eq(out.columns, base().columns, 'set_cells 不动列');

  const b = base(); const snap = JSON.stringify(b);
  M.applyOperation(b, 'set_cells', {cells:[{row:1, column:1, value:'X'}]});
  eq(JSON.stringify(b), snap, 'set_cells 不改动入参');

  const atomic = base(); const atomicSnap = JSON.stringify(atomic);
  throws(() => M.applyOperation(atomic, 'set_cells', {cells:[
    {row:1, column:1, value:'先改这格'},
    {row:9, column:1, value:'越界'},
  ]}), '行序号必须是 1–2', 'set_cells 越界行');
  eq(JSON.stringify(atomic), atomicSnap, 'set_cells 越界 → 一格都没写');

  throws(() => M.applyOperation(base(), 'set_cells', {cells:[
    {row:1, column:1, value:'ok'},
    {row:1, column:9, value:'越界'},
  ]}), '列序号必须是 1–3', 'set_cells 越界列');
  throws(() => M.applyOperation(base(), 'set_cells', {cells:[
    {row:1, column:1, value:'ok'},
    {row:1, columnName:'没有这列', value:'x'},
  ]}), '不存在列', 'set_cells 列名不存在');

  const long = 'x'.repeat(M.MAX_CELL_CHARS + 1);
  throws(() => M.applyOperation(base(), 'set_cells', {cells:[
    {row:1, column:1, value:'ok'},
    {row:2, column:1, value:long},
  ]}), '不能超过 20000', 'set_cells 超长单元格');
  eq(M.applyOperation(base(), 'set_cells', {cells:[{row:1, column:1, value:'y'.repeat(M.MAX_CELL_CHARS)}]})
    .rows[0][0].length, M.MAX_CELL_CHARS, '恰好等于上限可以写');

  const media = M.applyOperation(base(), 'set_cells', {cells:[{row:1, column:1, value:M.mediaCell('/a.png','image','a.png')}]});
  eq(media.rows[0][0], {kind:'media', url:'/a.png', mediaType:'image', name:'a.png'}, 'set_cells 能写媒体格');
  throws(() => M.applyOperation(base(), 'set_cells', {}), '需要 cells 数组', 'set_cells 缺 cells');
  eq(M.applyOperation(base(), 'set_cells', {cells:[]}).rows, base().rows, '空批次 → 不改任何格');
  eq(M.applyOperation(base(), 'set_cells', {cells:[{row:1, column:1, value:'A'}, {row:1, column:1, value:'B'}]})
    .rows[0][0], 'B', '同一格重复写 → 后写覆盖');

  const withAi = M.normalizeTable({columns:['a'], rows:[['1']], aiColumns:[{instruction:'改写', updatedAt:3}]}).table;
  eq(M.applyOperation(withAi, 'set_cells', {cells:[{row:1, column:1, value:'2'}]}).aiColumns,
    [{instruction:'改写', updatedAt:3}], 'set_cells 不动 AI 列');
  eq(M.applyOperation(withAi, 'set_cells', {cells:[{row:1, column:1, value:'2'}]}).selection, undefined,
    '没有选区时 set_cells 也不会凭空生出 selection');
}

// ═══ planAiColumn：要跑哪些行 + 分批 ═══
{
  const table = count => M.normalizeTable({columns:['场景'], rows:Array.from({length:count}, () => ['x'])}).table;
  eq(M.planAiColumn(table(0), 0), [], '0 行 → 没有批次');
  const one = M.planAiColumn(table(20), 0);
  eq(one.length, 1, '恰好一批（20 行）→ 1 批');
  eq(one[0].rows.length, 20, '一批 20 行');
  eq(one[0].rows[0], 1, '行号从 1 开始（1-based）');
  eq(one[0].rows[19], 20, '一批到第 20 行');
  eq(one[0].columnIndex, 0, '批次带上列下标（0-based）');

  const cross = M.planAiColumn(table(21), 0);
  eq(cross.map(batch => batch.rows.length), [20, 1], '跨批：20 + 1');
  eq(cross[1].rows, [21], '第二批是第 21 行');
  eq(M.planAiColumn(table(45), 0, {batchSize:10}).map(batch => batch.rows.length), [10,10,10,10,5], '可配置每批行数');
  eq(M.planAiColumn(table(60), 0, {batchSize:100})[0].rows.length, 50, '每批上限 50（不是 100）');
  eq(M.planAiColumn(table(60), 0, {batchSize:100}).map(batch => batch.rows.length), [50,10], '夹到 50 后跨两批');
  eq(M.planAiColumn(table(25), 0, {batchSize:0})[0].rows.length, 20, '非法 batchSize → 默认 20');
  eq(M.planAiColumn(table(25), 0, {batchSize:'8'})[0].rows.length, 8, '字符串 batchSize 也认');
  eq(M.aiColumnBatchSize(999), 50, 'aiColumnBatchSize 夹上限');
  eq(M.aiColumnBatchSize(0), 20, 'aiColumnBatchSize 默认值');

  const mixed = M.normalizeTable({columns:['场景'], rows:[['a'],[''],['b']]}).table;
  eq(M.planAiColumn(mixed, 0).map(batch => batch.rows).flat(), [1,3], '整行全空的跳过');
  const other = M.normalizeTable({columns:['场景','卖点'], rows:[['','轻'],['','']]}).table;
  eq(M.planAiColumn(other, 0)[0].rows, [1], '目标列空、但别的列有内容 → 仍然要跑');
  eq(M.planAiColumn(table(5), 0, {rows:[2,4,99]}).map(batch => batch.rows).flat(), [2,4], '只跑指定行（越界行忽略）');
  eq(M.planAiColumn(table(3), 9), [], '列下标越界 → 没有批次');
  eq(M.planAiColumn(table(3), -1), [], '负列下标 → 没有批次');
  eq(M.planAiColumn(table(3), 'x'), [], '非数字列下标 → 没有批次');
  eq(M.planAiColumn(null, 0), [], '空表 → 没有批次');
}

// ═══ aiColumnPrompt：强约束 JSON + 列名/逐行原文 ═══
{
  const columns = ['场景描述', '品牌'];
  const cells = [
    {row:3, values:['海边日落', 'Nike']},
    {row:5, values:['', 'Puma']},
  ];
  const prompt = M.aiColumnPrompt('把场景描述改写成 30 字以内电商口语', cells, columns, {columnName:'场景描述'});
  const musts = [
    '把场景描述改写成 30 字以内电商口语',
    '目标列：「场景描述」',
    '表格列（按顺序）：场景描述、品牌',
    '第 3 行',
    '第 5 行',
    '海边日落',
    'Nike',
    'Puma',
    '（空）',
    '- 行号必须与原文行号完全一致',
    '- 只为上面列出的每一行各产出一条结果',
    '只返回一个 JSON 对象',
    '不要 Markdown 代码块',
    '"values":[{"row":3,"value":"改写后的单元格文本"}]',
  ];
  const missing = musts.filter(text => prompt.indexOf(text) < 0);
  eq(missing, [], 'aiColumnPrompt 关键约束齐全' + (missing.length ? ' 缺: ' + missing.join(' | ') : ''));

  ok(M.aiColumnPrompt('改', [{row:1, values:['a', 'b']}], columns, {columnIndex:1}).indexOf('目标列：「品牌」') >= 0,
    'columnIndex → 目标列名');
  ok(M.aiColumnPrompt('改', ['原文'], ['描述']).indexOf('描述：原文') > 0, 'cells 传字符串 → 当作目标列原文');
  ok(M.aiColumnPrompt('改', [], ['a']).indexOf('（没有可处理的行）') > 0, '没有行时的兜底文案');
  ok(M.aiColumnPrompt('改', [], []).indexOf('目标列：「未指定列」') >= 0, '缺目标列名时的兜底');
  ok(M.aiColumnPrompt('', [{row:1, values:['a']}], ['描述']).indexOf('未填写指令') > 0, '空指令也有明确兜底');
}

// ═══ batchRewritePrompt：选区二维原文 + 行列回填 ═══
{
  const patch = [['夏天', '白底'], ['', '带文字']];
  const prompt = M.batchRewritePrompt('把选中区域改写成 30 字以内电商口语', patch);
  const musts = [
    '把选中区域改写成 30 字以内电商口语',
    '选中区域：第 1–2 行，第 1–2 列',
    '第 1 行',
    '第 2 行',
    '第 1 列：夏天',
    '第 2 列：白底',
    '（空）',
    '行号、列号必须原样照抄',
    '- 不需要改写的格子可以不返回',
    '只返回一个 JSON 对象',
    '不要 Markdown 代码块',
    '"values":[{"row":1,"col":1,"value":"改写后的单元格文本"}]',
  ];
  const missing = musts.filter(text => prompt.indexOf(text) < 0);
  eq(missing, [], 'batchRewritePrompt 关键约束齐全' + (missing.length ? ' 缺: ' + missing.join(' | ') : ''));

  const offsetPrompt = M.batchRewritePrompt('更短', {values:[['甲']], rowOffset:4, colOffset:2, columnNames:['卖点']});
  ok(offsetPrompt.indexOf('第 5 行') > 0, 'patch 带偏移 → 写整表真实行号');
  ok(offsetPrompt.indexOf('卖点（第 3 列）：甲') > 0, 'patch 带偏移 → 写整表真实列号与列名');
  ok(offsetPrompt.indexOf('第 5–5 行，第 3–3 列') > 0, '区域范围也按绝对行列号');
  ok(M.batchRewritePrompt('改', []).indexOf('（没有可改写的单元格）') > 0, '空选区兜底');
  ok(M.batchRewritePrompt('', [['a']]).indexOf('未填写要求') > 0, '空指令也有明确兜底');
}

// ═══ parseAiValues：成功哪些行 / 缺哪些行 / 非法行号 / 坏 JSON ═══
{
  const F = String.fromCharCode(96,96,96);
  const normal = M.parseAiValues(JSON.stringify({values:[{row:2, value:'第二条'}, {row:1, value:'第一条'}]}), [1,2]);
  eq(normal.ok, true, '正常返回 → ok');
  eq(normal.parsed, true, '正常返回 → parsed');
  eq(normal.applied, [{row:1, value:'第一条'}, {row:2, value:'第二条'}], 'applied 按行号升序');
  eq(normal.values, {1:'第一条', 2:'第二条'}, 'values 按行号索引');
  eq(normal.missing, [], '不缺行');
  eq(normal.invalid, [], '没有非法项');
  eq(normal.extra, [], '没有多余行');

  const fenced = F + 'json\n' + JSON.stringify([{row:'1', value:'a'}]) + '\n' + F;
  eq(M.parseAiValues(fenced, [1]).applied, [{row:1, value:'a'}], '代码块 + 顶层数组 + 字符串行号也认');

  const blocks = F + 'json\n' + JSON.stringify({values:[{row:1, value:'a'}]}) + '\n' + F + '\n'
    + F + 'json\n' + JSON.stringify({values:[{row:2, value:'b'}]}) + '\n' + F;
  eq(M.parseAiValues(blocks, [1,2]).applied.map(item => item.value), ['a','b'], '多块输出合并');

  const missing = M.parseAiValues(JSON.stringify({values:[{row:1, value:'a'}]}), [1,2,3]);
  eq(missing.missing, [2,3], '缺行被明确列出来');
  eq(missing.ok, false, '缺行 → ok=false');
  eq(missing.applied, [{row:1, value:'a'}], '已经成功的行照常返回');

  const extra = M.parseAiValues(JSON.stringify({values:[{row:1, value:'a'}, {row:9, value:'z'}]}), [1]);
  eq(extra.extra, [{row:9, value:'z'}], '超出预期的行进 extra');
  eq(extra.applied, [{row:1, value:'a'}], '范围内的行照常成功');
  eq(extra.ok, false, '有多余行 → ok=false');

  const bad = M.parseAiValues('模型今天不想输出 JSON', [1,2]);
  eq(bad.parsed, false, '坏 JSON → parsed=false');
  eq(bad.applied, [], '坏 JSON → 没有成功行');
  eq(bad.missing, [1,2], '坏 JSON → 全部算缺行');
  eq(bad.ok, false, '坏 JSON → ok=false');

  const illegal = M.parseAiValues(JSON.stringify({values:[{row:0, value:'x'}, {row:'一', value:'y'}, {row:2, value:'ok'}]}), [2]);
  eq(illegal.invalid.map(item => item.reason), ['row','row'], '非法行号进 invalid');
  eq(illegal.applied, [{row:2, value:'ok'}], '合法行照常回填');
  eq(illegal.ok, false, '有非法行 → ok=false');

  const noValue = M.parseAiValues(JSON.stringify({values:[{row:1}]}), [1]);
  eq(noValue.invalid, [{row:1, reason:'value'}], '缺 value → invalid');
  eq(noValue.missing, [1], '缺 value 的行同时算缺行');

  const dup = M.parseAiValues(JSON.stringify({values:[{row:1, value:'先'}, {row:1, value:'后'}]}), [1]);
  eq(dup.applied, [{row:1, value:'先'}], '重复行保留先出现的那条');
  eq(dup.invalid, [{row:1, reason:'duplicate'}], '重复行被报出来（不静默吞）');

  // 选区批量改写：带 col 的结果按行列回填（同一行多列不会互相挤掉）
  const withCols = M.parseAiValues(JSON.stringify({values:[
    {row:1, col:2, value:'甲'}, {row:1, col:1, value:'乙'}, {row:2, col:1, value:'丙'},
  ]}), [1,2]);
  eq(withCols.applied, [
    {row:1, col:1, value:'乙'},
    {row:1, col:2, value:'甲'},
    {row:2, col:1, value:'丙'},
  ], '带 col 的结果按行列回填（行内按列升序）');
  eq(Object.keys(withCols.cells).sort(), ['1:1','1:2','2:1'], '带 col 的结果进 cells');
  eq(withCols.cells['1:2'], '甲', 'cells 按「行:列」索引');
  eq(withCols.values, {}, '带 col 的结果不往行级 values 里塞');
  eq(withCols.ok, true, '同一行多列都齐全 → ok');
  eq(M.parseAiValues(JSON.stringify({values:[{row:1, col:0, value:'x'}]}), [1]).invalid,
    [{row:1, reason:'col'}], '非法列号进 invalid');
  eq(M.parseAiValues(JSON.stringify({values:[{row:1, col:1, value:'a'}, {row:1, col:1, value:'b'}]}), [1]).invalid,
    [{row:1, col:1, reason:'duplicate'}], '同行同列重复 → invalid');

  const longValue = M.parseAiValues(JSON.stringify({values:[{row:1, value:'x'.repeat(M.MAX_CELL_CHARS + 5)}]}), [1]);
  eq(longValue.applied[0].value.length, M.MAX_CELL_CHARS, '超长值按单元格上限截断');

  eq(M.parseAiValues(JSON.stringify({values:[{row:2, value:'b'}]}), 2).missing, [1], 'expectedRows 传数字按 1..N 理解');
  const shape = M.parseAiValues(JSON.stringify({values:[null, 'string', 3]}), [1]);
  eq(shape.invalid.map(item => item.reason), ['shape','shape','shape'], '非对象项进 invalid');
}

// ═══ diffTables：只列变化格，先行后列 ═══
{
  const before = M.normalizeTable({columns:['场景','卖点'], rows:[['海边','轻'],['城市','重']]}).table;
  eq(M.diffTables(before, M.cloneTable(before)), [], '没有变化 → 空差异');

  const after = M.cloneTable(before);
  after.rows[1][1] = '很重';
  after.rows[0][0] = '海边日落';
  eq(M.diffTables(before, after), [
    {row:1, col:1, columnName:'场景', before:'海边', after:'海边日落'},
    {row:2, col:2, columnName:'卖点', before:'重', after:'很重'},
  ], '只列变化格，先行后列（1-based 行列号）');

  const rowAdded = M.applyOperation(before, 'append_row', {values:['山','硬']});
  eq(M.diffTables(before, rowAdded).map(item => [item.row, item.col]), [[3,1],[3,2]], '新增行按行号列出变化格');
  eq(M.diffTables(before, rowAdded)[0].before, '', '新增行的原值算空串');

  const withMedia = M.normalizeTable({columns:['参考'], rows:[[M.mediaCell('/a.png','image','a.png')]]}).table;
  const changedMedia = M.cloneTable(withMedia);
  changedMedia.rows[0][0] = M.mediaCell('/b.png','image','b.png');
  eq(M.diffTables(withMedia, changedMedia),
    [{row:1, col:1, columnName:'参考', before:'/a.png', after:'/b.png'}], '媒体格按 URL 比对，不会被当成没变');

  const renamed = M.normalizeTable({columns:['场景'], rows:[['海边']]}).table;
  const renamedAfter = M.normalizeTable({columns:['场景描述'], rows:[['海边']]}).table;
  eq(M.diffTables(renamed, renamedAfter), [], '只改列名不算逐格变化');
}

// ═══ tableSnapshot：可整体还原的深拷贝 ═══
{
  const table = M.normalizeTable({columns:['场景','卖点'], rows:[['海边','轻']],
    aiColumns:[{instruction:'改写成口语', updatedAt:11}], selection:{r0:0,c0:0,r1:0,c1:1}}).table;
  const snap = M.tableSnapshot(table);
  eq(snap.kind, 'table-snapshot', '快照有自己的 kind，和表格区分开');
  eq(snap.version, M.TABLE_VERSION, '快照带表格版本');
  eq(snap.table, M.cloneTable(table), '快照里是完整的深拷贝 table');
  ok(snap.table !== table, '快照不是同一个对象');

  const working = M.cloneTable(table);
  working.rows[0][0] = '改坏了';
  working.aiColumns[0].instruction = '也改坏了';
  working.selection.c1 = 0;
  eq(snap.table.rows[0][0], '海边', '快照不跟着工作副本变');
  eq(snap.table.aiColumns[0].instruction, '改写成口语', '快照里的 AI 指令不受影响');
  eq(snap.table.selection, {r0:0,c0:0,r1:0,c1:1}, '快照里的选区不受影响');

  const restored = M.cloneTable(snap.table);
  eq(restored, M.cloneTable(table), '用快照整体还原回原状');
  eq(restored.aiColumns, [{instruction:'改写成口语', updatedAt:11}, null], '还原带回 AI 列指令');
  eq(restored.selection, {r0:0,c0:0,r1:0,c1:1}, '还原带回选区');
  eq(M.tableSnapshot({columns:['a'], rows:[['1']]}).table.aiColumns, [null], '老数据快照补齐 aiColumns');
}

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
