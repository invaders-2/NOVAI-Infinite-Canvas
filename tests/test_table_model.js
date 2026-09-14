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


// ═══ 输入列（DX OS §3：Co / ab / 通道） ═══
eq(M.channelIdAt(0), 'input-1', '通道 id 从 1 开始');
eq(M.channelIdAt(2), 'input-3', '通道 id');
eq(M.channelIndexFromId('input-3'), 2, 'id → 序号');
eq(M.channelIndexFromId('input-0'), -1, 'input-0 非法');
eq(M.channelIndexFromId('nope'), -1, '非法 id');
eq(M.channelLabel(0), '输入 1', '通道表头文案');
eq(M.channelModeFor([]), 'shared', '0 个引用 → 共享');
eq(M.channelModeFor([1]), 'shared', '1 个引用 → 共享');
eq(M.channelModeFor([1, 2]), 'sequence', '>1 个引用 → 逐行（DX OS: refs.length > 1）');

eq(M.normalizeChannels(null), [], '非数组 → 空');
eq(M.normalizeChannels([{items:[{type:'media', nodeId:'a'}, {nodeId:''}, {type:'text', text:'  '}]}]),
   [{id:'input-1', mode:'shared', items:[{type:'media', nodeId:'a', text:''}]}], '过滤空 item + 默认值');
eq(M.normalizeChannels([{id:'x', mode:'逐行', items:[]}])[0], {id:'x', mode:'shared', items:[]}, '非法 mode 归一到 shared');

{
  const seq = {id:'input-1', mode:'sequence', items:[{nodeId:'a'},{nodeId:'b'},{nodeId:'c'}]};
  eq(M.inputItemAt(seq, 0).nodeId, 'a', 'ab sequence 第 0 行');
  eq(M.inputItemAt(seq, 2).nodeId, 'c', 'ab sequence 第 2 行');
  eq(M.inputItemAt(seq, 9), null, 'ab sequence 越界 → null');
  const shared = {id:'input-1', mode:'shared', items:[{nodeId:'a'},{nodeId:'b'}]};
  eq(M.inputItemAt(shared, 0).nodeId, 'a', 'ab shared 第 0 行 → 第 1 个');
  eq(M.inputItemAt(shared, 1).nodeId, 'b', 'ab shared 第 1 行 → 第 2 个');
  eq(M.inputItemAt(shared, 99).nodeId, 'b', 'ab shared 超出后沿用最后一个');
  eq(M.inputItemAt({mode:'sequence', items:[]}, 0), null, 'ab 空 items → null');
}

// Xw：有媒体时下限抬到 144
eq(M.rowHeightForRow(['短'], [], false), 44, '无媒体 → textMin 44');
eq(M.rowHeightForRow(['短'], [], true), 144, '有媒体 → mediaMin 144');
eq(M.rowHeightForRow(['x'.repeat(40)], [], true), 144, '有媒体时下限恒为 144');
eq(M.rowHeightForRow(['x'.repeat(40)], [], false), 24 + 3 * 15, '无媒体时取文本高');
eq(M.rowHeightForRow(['x'.repeat(200)], ['y'.repeat(200)], false), 160, '超长 → 夹到 maxHeight 160');

// ═══ 提示词（DX OS §4：L7 / jf） ═══
eq(M.buildRowPrompt(['  上游  ', ''], '节点提示', ' 行文本 '), '上游\n节点提示\n行文本', 'jf 三段拼接并 trim');
eq(M.buildRowPrompt([], '', ''), '', 'jf 全空 → 空串');
eq(M.buildRowPrompt([], '', '只有行文本'), '只有行文本', 'jf 只有行文本');
eq(M.mentionTokenAt('image', 1), '@图片1', 'mention 图片');
eq(M.mentionTokenAt('video', 2), '@视频2', 'mention 视频');
eq(M.mentionTokenAt('audio', 3), '@音频3', 'mention 音频');
eq(M.mentionTokenAt('file', 4), '@文件4', 'mention 文件');
eq(M.mentionTokenAt('unknown', 1), '@文件1', '未知类型 → 文件');
eq(M.mentionsIn('@图片1 和 @视频2').map(m => m.index), [0, 1], '解析 mention 序号');
eq(M.mentionsIn('没有引用'), [], '无 mention');
eq(M.danglingMentions('@图片1', [{kind:'image'}]).length, 0, '引用对得上');
eq(M.danglingMentions('@图片5', [{kind:'image'}]).length, 1, '越界引用');
eq(M.danglingMentions('@视频1', [{kind:'image'}]).length, 1, '类型不符');
eq(M.danglingMentions('@图片1', []).length, 1, '没有参考时引用悬空');

// 回归：删列不该动行选中（曾按列数过滤行号）
{
  const t = M.normalizeTable({columns:['a'], rows:[['1'],['2'],['3']]}).table;
  t.selectedRows = [0, 1, 2];
  eq(M.applyOperation(t, 'delete_column', {column:1}).selectedRows, [0, 1, 2], '删列保留行选中');
}
// 删行时选中顺位
{
  const t = M.normalizeTable({columns:['a'], rows:[['1'],['2'],['3']]}).table;
  t.selectedRows = [0, 1, 2];
  eq(M.applyOperation(t, 'delete_row', {row:2}).selectedRows, [0, 1], '删中间行：前后各留一个，后面顺移');
  eq(M.applyOperation(t, 'delete_row', {row:3}).selectedRows, [0, 1], '删末行：只剩两个选中');
}


// ═══ 批量执行（DX OS §4 执行器 / §5 journal） ═══
eq(M.batchFailurePolicy('stop'), 'stop', 'failurePolicy stop');
eq(M.batchFailurePolicy(undefined), 'continue', 'failurePolicy 默认 continue');
eq(M.batchFailurePolicy('乱写'), 'continue', 'failurePolicy 非法值归一到 continue');

eq(M.batchStartRow(1, 10), 1, '起始行 1');
eq(M.batchStartRow(7, 10), 7, '起始行 7');
eq(M.batchStartRow(99, 10), 10, '起始行夹到行数');
eq(M.batchStartRow(0, 10), 1, '起始行 <1 → 1');
eq(M.batchStartRow('x', 10), 1, '起始行非法 → 1');

eq(M.batchConcurrency(1), 1, '并发 1');
eq(M.batchConcurrency(8), 8, '并发 8');
eq(M.batchConcurrency(99), 8, '并发夹到 8');
eq(M.batchConcurrency(0), 3, '并发 0 → 默认 3');
eq(M.batchConcurrency(undefined), 3, '并发未设 → 默认 3');

{
  const rows = [
    {rowNumber:1, text:'a', media:[]},
    {rowNumber:2, text:'', media:[]},          // 空行
    {rowNumber:3, text:'', media:[{nodeId:'x'}]},
    {rowNumber:4, text:'d', media:[]},
  ];
  eq(M.batchRowsToRun(rows, {startRow:1}).map(r => r.rowNumber), [1,3,4], 'bl 跳过空行');
  eq(M.batchRowsToRun(rows, {startRow:3}).map(r => r.rowNumber), [3,4], 'bl 起始行之后');
  eq(M.batchRowsToRun(rows, {manual:true, selectedRows:[0,2]}).map(r => r.rowNumber), [1,3], 'bl 手动模式只取已选行（下标 0-based）');
  eq(M.batchRowsToRun(rows, {manual:true, selectedRows:[1]}), [], 'bl 手动模式选中的是空行 → 仍然跳过');
  eq(M.batchRowsToRun(rows, {manual:true, selectedRows:[]}), [], 'bl 手动模式未选 → 空');
  eq(M.batchRowsToRun(null, {}), [], 'bl 非法输入 → 空');
}

{
  const rows = [
    {rowNumber:1, text:'一行', media:[{nodeId:'img1'}]},
    {rowNumber:2, text:'二行', media:[{nodeId:'img2'}]},
  ];
  const j = M.emptyJournal('run1', rows, 'stop');
  eq(j.runId, 'run1', 'journal runId');
  eq(j.failurePolicy, 'stop', 'journal 策略');
  eq(j.rows.map(r => r.status), ['pending','pending'], '新建 journal 全 pending');
  eq(j.rows[0].mediaNodeIds, ['img1'], 'journal 记录媒体节点');

  M.journalMarkRow(j, 1, 'completed');
  eq(M.journalCompletedRows(j).length, 1, '标记 completed');
  eq(M.journalPendingRows(j).map(r => r.rowNumber), [2], 'pending 只剩第 2 行');

  M.journalMarkRow(j, 2, 'running', 'req-9');
  eq(M.journalInflightRows(j).map(r => r.rowNumber), [2], 'running 算「仍在后台」');
  eq(j.rows[1].requestId, 'req-9', 'requestId 被记录');
  M.journalMarkRow(j, 2, 'deferred');
  eq(M.journalInflightRows(j).length, 1, 'deferred 也算「仍在后台」');

  M.journalMarkRow(j, 2, 'failed');
  eq(M.journalFailedRows(j).length, 1, 'failed 可标记');
  eq(M.journalMarkRow(j, 99, 'completed'), null, '不存在的行号返回 null、不炸');
  eq(M.journalMarkRow(j, 2, '乱写').status, 'failed', '非法状态被忽略');

  // 续跑：runId 一致 → completed 沿用；failed 重置以便重试；文本改了 → 重置
  const same = M.matchBatchJournal(j, 'run1', rows, 'stop');
  eq(same.rows[0].status, 'completed', '续跑沿用 completed（跳过已完成行）');
  eq(same.rows[1].status, 'pending', '续跑把 failed 重置为 pending 以重试');
  const edited = M.matchBatchJournal(j, 'run1', [{rowNumber:1, text:'改过了', media:[{nodeId:'img1'}]}, rows[1]], 'stop');
  eq(edited.rows[0].status, 'pending', '行内容改了 → 重置为 pending');
  const otherRun = M.matchBatchJournal(j, 'run2', rows, 'stop');
  eq(otherRun.rows.map(r => r.status), ['pending','pending'], 'runId 不同 → 全新 journal');
  const noRunId = M.matchBatchJournal(j, '', rows, 'stop');
  eq(noRunId.runId, '', '空 runId → 新 journal');
  eq(M.normalizeJournal(null).rows, [], 'normalizeJournal 非法输入');
  eq(M.normalizeJournal({rows:[{status:'乱写'}]}).rows[0].status, 'pending', '非法状态归一');
}

eq(M.batchMissingMaterials([{rowNumber:1, media:[{nodeId:'a', invalid:'missing'}, {nodeId:'b'}]}]).map(i => i.nodeId), ['a'], '素材校验挑出缺失');
eq(M.batchMissingMaterials([{rowNumber:1, media:[{nodeId:'a'}]}]), [], '素材齐全 → 空');
eq(M.batchMissingMaterials(null), [], '素材校验非法输入');


// ═══ LLM → 表格（DX OS §6：FS / BS / a6 / CR） ═══
const FENCE = String.fromCharCode(96,96,96);

// extractJsonObject：剥代码块 → 取首尾大括号
eq(M.extractJsonObject(FENCE + 'json\n{"a":1}\n' + FENCE), {a:1}, '剥 json 代码块');
eq(M.extractJsonObject(FENCE + '\n{"a":1}\n' + FENCE), {a:1}, '无语言标记的代码块');
eq(M.extractJsonObject('说明文字 {"a":1} 收尾'), {a:1}, '夹在散文里也能取出来');
eq(M.extractJsonObject('{"a":1}'), {a:1}, '裸 JSON');
eq(M.extractJsonObject('完全不是 JSON'), null, '没有大括号 → null');
eq(M.extractJsonObject('{不是合法 JSON}'), null, 'JSON 非法 → null');
eq(M.extractJsonObject(''), null, '空串 → null');
eq(M.extractJsonObject(null), null, 'null → null');

// parseTableOutput：a6 校验
{
  const good = JSON.stringify({kind:'table', version:1, columns:['提示词','品牌'], rows:[['一只猫','Nike']]});
  eq(M.parseTableOutput(good).columns, ['提示词','品牌'], '合法表格：列名');
  eq(M.parseTableOutput(good).rows, [['一只猫','Nike']], '合法表格：行');
  eq(M.parseTableOutput(good).kind, 'table', '合法表格：kind');
  eq(M.parseTableOutput(FENCE + 'json\n' + good + '\n' + FENCE).rows, [['一只猫','Nike']], '代码块包裹也能解析');
}
{
  // 行按列数补齐 + 非字符串 stringify + 截断
  const t = M.parseTableOutput(JSON.stringify({kind:'table', version:1, columns:['a','b','c'], rows:[[1, {x:2}]]}));
  eq(t.rows[0], ['1', '{"x":2}', ''], '行补齐列数 + 非字符串 stringify');
  const long = M.parseTableOutput(JSON.stringify({kind:'table', version:1, columns:['a'], rows:[['x'.repeat(25000)]]}));
  eq(long.rows[0][0].length, 20000, '单元格截断到 20000');
}
const rejects = (text, message, label) => {
  let got = '';
  try { M.parseTableOutput(text); } catch(error){ got = error.message; }
  eq(got, message, label);
};
rejects('不是 JSON', M.TABLE_PARSE_ERRORS.format, '解析失败 → 格式错误文案');
rejects(JSON.stringify({kind:'nope', version:1, columns:['a'], rows:[]}), M.TABLE_PARSE_ERRORS.format, 'kind 不对 → 格式错误文案');
rejects(JSON.stringify({kind:'table', version:2, columns:['a'], rows:[]}), M.TABLE_PARSE_ERRORS.format, 'version 不对 → 格式错误文案');
rejects(JSON.stringify({kind:'table', version:1, columns:[], rows:[]}), M.TABLE_PARSE_ERRORS.columns, '没有列 → 列名不完整文案');
rejects(JSON.stringify({kind:'table', version:1, columns:['a'], rows:'x'}), M.TABLE_PARSE_ERRORS.format, 'rows 不是数组 → 格式错误文案');
rejects(JSON.stringify({kind:'table', version:1, columns:['   '], rows:[]}), M.TABLE_PARSE_ERRORS.columns, '列名全空白 → 列名不完整文案');
{
  const manyCols = []; for(let i = 0; i < M.LLM_MAX_COLUMNS + 1; i += 1) manyCols.push('c' + i);
  rejects(JSON.stringify({kind:'table', version:1, columns:manyCols, rows:[]}), M.TABLE_PARSE_ERRORS.format, '超过 LLM 列上限 → 格式错误');
  const manyRows = []; for(let i = 0; i < M.LLM_MAX_ROWS + 1; i += 1) manyRows.push(['x']);
  rejects(JSON.stringify({kind:'table', version:1, columns:['a'], rows:manyRows}), M.TABLE_PARSE_ERRORS.format, '超过 LLM 行上限 → 格式错误');
  eq(M.normalizeTable({columns:manyCols, rows:[]}).table.columns.length, M.LLM_MAX_COLUMNS + 1, '手工上限更大（归一化接受同样宽度）');
}
eq(M.TABLE_PARSE_ERRORS.format, '模型没有返回统一的多维表格格式', '格式错误文案与规范一致');
eq(M.TABLE_PARSE_ERRORS.columns, '模型返回的表格列名不完整', '列名错误文案与规范一致');
eq(M.LLM_REPAIR_MAX_TOKENS, 8192, '修复重试的 max_tokens');

// CR：修复提示词
ok(M.buildRepairPrompt('坏结果').indexOf(M.TABLE_REPAIR_INSTRUCTION) === 0, '修复提示词以指令开头');
ok(M.buildRepairPrompt('坏结果').indexOf('坏结果') > 0, '修复提示词带上原结果');

// FS / BS
eq(M.inputListText([{kind:'image', label:'猫'}, {kind:'video'}]), '1. 图片（@图片1） — 猫\n2. 视频（@视频2）', '输入清单带序号与 mention');
eq(M.inputListText(null), '', '空输入清单');
ok(M.buildListPlanPrompt('拆解脚本', [{kind:'image'}]).indexOf('只做规划，不要输出最终 rows') > 0, 'FS 明确不输出 rows');
ok(M.buildListPlanPrompt('拆解脚本', []).indexOf('拆解脚本') > 0, 'FS 带上用户要求');
{
  const bs = M.buildListGeneratePrompt('拆解脚本', [{kind:'image'}], {task:'x', rowCount:3});
  const musts = [
    '可逐行执行的生成任务',
    '严格遵守用户指定的数量',
    '图片组通常逐张映射到各行',
    '显式写清它们的关系',
    '不要只写「使用图1」「参考图2」这类占位说明',
    '请根据任务自行设计最合适的列结构，不套固定模板',
    '通常不需要额外创建只用于计数的序号列',
    '不要在 JSON 中创建图片、参考图或生成输入列',
    '只返回一个 JSON 对象',
    '"kind":"table","version":1'
  ];
  const missing = musts.filter(text => bs.indexOf(text) < 0);
  eq(missing, [], 'BS 含全部规范约束' + (missing.length ? ' 缺: ' + missing.join(' | ') : ''));
  ok(bs.indexOf('\"rowCount\": 3') > 0, 'BS 带上规划 JSON');
}
ok(M.buildListGeneratePrompt('r', [], null).indexOf('（无规划，按用户要求自行判断）') > 0, '没有规划时的兜底文案');

// 输出模式与按钮文案
eq(M.llmOutputMode('list'), 'list', 'list 模式');
eq(M.llmOutputMode('text'), 'text', 'text 模式');
eq(M.llmOutputMode(undefined), 'text', '未设置 → text');
eq(M.llmOutputMode('乱写'), 'text', '非法值 → text');
eq(M.llmRunStageLabel(false, 'planning'), '生成', '未运行时按钮 = 生成');
eq(M.llmRunStageLabel(true, 'planning'), '规划中', '规划中');
eq(M.llmRunStageLabel(true, 'repairing'), '校验中', '校验中');
eq(M.llmRunStageLabel(true, 'generating'), '生成中', '生成中');
eq(M.llmRunStageLabel(true, undefined), '生成中', '阶段缺失 → 生成中');

// runWithSharedCursor 是异步的，放到最后
(async () => {
  {
    let inFlight = 0, maxInFlight = 0;
    const results = await M.runWithSharedCursor([1,2,3,4,5,6], 3, async n => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(done => setTimeout(done, 5));
      inFlight -= 1;
      return n * 2;
    });
    eq(maxInFlight, 3, '共享游标：并发上限被遵守');
    eq(results.map(r => r.value), [2,4,6,8,10,12], '结果按输入顺序回填');
    ok(results.every(r => r.ok), '全部成功');
  }
  {
    let inFlight = 0, maxInFlight = 0;
    await M.runWithSharedCursor([1,2], 8, async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(done => setTimeout(done, 3));
      inFlight -= 1;
    });
    eq(maxInFlight, 2, '并发收敛到行数');
  }
  {
    // continue：某行失败不打断其余行
    const results = await M.runWithSharedCursor([1,2,3,4], 2, async n => {
      if(n === 2) throw new Error('boom');
      return n;
    });
    eq(results.filter(r => r.ok).length, 3, 'continue 策略：失败不打断其余行');
    eq(results[1].ok, false, '失败行被标记');
    eq(results[1].error.message, 'boom', '错误对象被保留');
  }
  {
    // stop：出错后不再派发新行
    let started = 0;
    const results = await M.runWithSharedCursor([1,2,3,4,5,6], 1, async n => {
      started += 1;
      if(n === 2) throw new Error('boom');
      return n;
    }, {stopOnError: true});
    eq(started, 2, 'stop 策略：出错后不再派发新行');
    eq(results[2], undefined, '未派发的行没有结果');
    eq(results[0].ok, true, '已完成的行结果保留');
  }
  eq(await M.runWithSharedCursor([], 3, async () => 1), [], '空列表直接返回');

  console.log('通过 ' + pass + '/' + (pass + fails.length));
  if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('全部通过');
})();

