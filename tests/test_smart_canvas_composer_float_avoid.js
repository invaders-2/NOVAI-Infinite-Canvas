/* 「运行」按钮被右下角浮动按钮挡住 的静态回归断言。
   缺陷：编辑栏（z-index:30）被窗口右边夹住时，运行按钮正好落在对话助手 / 版本历史（z-index:89）底下，
   点运行实际打开的是对话面板。修法是「编辑栏横向让开」，不是「抬层级」（抬了对话按钮就点不到）。
   跑法：node tests/test_smart_canvas_composer_float_avoid.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const tableNode = read('static/js/shared/table-node.js');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

console.log('[1] 让开的目标是两颗 fixed 浮动按钮');
ok(/const COMPOSER_FLOAT_AVOID_IDS = \['chatToggleBtn', 'versionHistoryBtn'\];/.test(js),
    'COMPOSER_FLOAT_AVOID_IDS 列出 chatToggleBtn / versionHistoryBtn');
ok(js.includes('function composerLeftClearOfFloatingButtons('), '有 composerLeftClearOfFloatingButtons');
ok(js.includes('el.getClientRects().length'), '隐藏的浮动按钮不算障碍物');
ok(js.includes('const vertical = top < box.bottom + gap && top + height > box.top - gap;'), '先判竖直重叠（远离时不动编辑栏）');
ok(js.includes('safe = Math.min(safe, box.left - gap - width)'), '横向让到障碍物左边');
ok(js.includes('return Math.max(8, safe);'), '让开后不越出窗口左边');

console.log('[2] 定位与高度回收两条路都要让');
ok(js.includes('const clampedLeft = Math.max(8, Math.min(Math.max(8, window.innerWidth - rendered.width - 8), visualLeft));'),
    'positionComposerForNode 先按窗口夹取');
ok(/const left = composerLeftClearOfFloatingButtons\(clampedLeft, top, rendered\.width, rendered\.height\);/.test(js),
    'positionComposerForNode 再用避让结果写 left');
const clampFn = (js.match(/function clampComposerIntoWindow\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(clampFn.includes('composerLeftClearOfFloatingButtons('), 'clampComposerIntoWindow 也要让（内容撑高往上收之后会钻到按钮底下）');
ok(clampFn.includes('settled.left'), '用落定后的实际位置判断，不用上一次的 left');

console.log('[3] 不靠抬层级：两颗按钮的 z-index 原样');
const chatRule = (css.match(/\.chat-toggle \{([\s\S]*?)\}/) || [])[1] || '';
ok(/z-index:\s*89/.test(chatRule), '.chat-toggle 仍是 z-index:89');
const composerRuleLine = css.split('\n').find(line => line.startsWith('.composer {')) || '';
ok(/z-index:30/.test(composerRuleLine), '.composer 仍是 z-index:30（没有反压）');

console.log('[4] 0 行表提示：先说「表格是空的」');
ok(tableNode.includes("tr('smart.tableBatchNoRows')"), 'runTableBatch 的 0 行分支走 i18n 键');
const zeroBranch = tableNode.indexOf('else if(!rows.length) say(tr(\'smart.tableBatchNoRows\'));');
const rangeBranch = tableNode.indexOf("else if(startRow > rows.length) say('起始行超出表格范围");
ok(zeroBranch > 0 && rangeBranch > zeroBranch, '0 行分支排在「起始行超出范围」之前');
ok(tableNode.includes("say('起始行超出表格范围，当前共 ' + rows.length + ' 行')"), '非空表的起始行越界提示保留');

console.log('[5] LLM 空表提示：也说「表格是空的」');
ok(js.includes("throw new Error(tr('smart.llmTableEmpty'))"), 'runSmartLLMTableMode 抛 i18n 文案');
ok(!js.includes("'模型没有返回可用的表格'"), '旧文案已删除');

console.log('[6] i18n 词条齐全且两种语言都有');
for(const [key, zhNeedle] of [['smart.tableBatchNoRows', '表格里还没有数据行'], ['smart.llmTableEmpty', '表格是空的']]){
    const block = (i18n.match(new RegExp('"' + key + '": \\{[\\s\\S]*?\\n        \\}')) || [''])[0];
    ok(block.includes('zh:'), key + ' 有 zh');
    ok(block.includes('en:'), key + ' 有 en');
    ok(block.includes(zhNeedle), key + ' 的 zh 点明了空表');
}

console.log('');
if(fails.length){
    fails.forEach(label => console.error('[FAIL] ' + label));
    console.error('[test] ' + fails.length + ' 项未通过');
    process.exit(1);
}
console.log('[test] 全部通过（' + pass + ' 项）');
