#!/usr/bin/env node
// 多维表格逐行驱动「生成输入」时：一行一个参考，只落一张产出（static/js/smart-canvas.js 的 tableRunOneRow）。
//
// 上游 Lovart 一次可能回多张（实测第 1 行回 4 张），全落下去结果节点里就是几张几乎一样的图，
// 用户会误判成「每一行都用了第一张参考图」。批量链路只留第一张；单节点生成不受影响。
//
// 跑法：node tests/test_smart_canvas_batch_row_single_output.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');

const file = path.join(__dirname, '../static/js/smart-canvas.js');
const code = fs.readFileSync(file, 'utf8');
const label = 'static/js/smart-canvas.js';

// 从源码里原样抠出待测函数，避免在测试里复制一份逻辑导致「测的不是真代码」。
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

// extractFn 从 "function 名字(" 开始抠，async 前缀要自己补回来（否则函数体里的 await 是语法错误）
const rowFnSrc = (code.includes('async function tableRunOneRow(') ? 'async ' : '') + extractFn(code, 'tableRunOneRow');

// ---- 静态断言 ----
const assignAt = rowFnSrc.indexOf('urls = Array.isArray(out && out.urls) ? out.urls : [];');
const trimAt = rowFnSrc.indexOf('urls = urls.slice(0, 1)');
const additionsAt = rowFnSrc.indexOf('const additions = rowUrls()');
const pushAt = rowFnSrc.indexOf('node.images.push');
ok(assignAt >= 0, 'tableRunOneRow 里找得到产出 urls 的赋值');
ok(trimAt > assignAt, '裁剪就在 urls 赋值之后（裁剪的是本次真实产出）');
ok(trimAt < additionsAt && trimAt < pushAt, '裁剪发生在 rowUrls()/node.images.push 之前（下游自然只有一条）');
ok(rowFnSrc.includes('options.batch === true') && rowFnSrc.includes('Number(rowNumber) > 0'),
    '批量判定同时认 options.batch 与 runContext.rowNumber');
eq((rowFnSrc.match(/urls = urls\.slice\(/g) || []).length, 1, '裁剪只有一处，不会误伤别处');
ok(code.includes("(urls.length > 1 ? '-' + (index + 1) : '')"),
    '命名规则未动：单张时名字仍是「第N行」（没有 -N 后缀）');

// ---- 行为断言：在沙箱里跑真实函数 ----
const sandboxSrc = [
    'let nodes = [];',
    'let resultNode = null;',
    'let nextUrls = [];',
    'let generateCalls = 0;',
    'const settings = {};',
    'const canvas = {connections: []};',
    'const batchRunResultNodes = new Map();',
    'function smartSettingsForNode(){ return {}; }',
    'function snapshotRunMeta(prompt){ return {prompt:String(prompt || "")}; }',
    'function rowSourceRatio(){ return Promise.resolve(null); }',
    'function applyRowSourceRatioToSettings(){}',
    'function applySourceRatioToVideoAspect(){}',
    'function batchResultNodeForRun(){',
    '    if(!resultNode) resultNode = {id:"out1", type:"smart-image", images:[], pending:1, title:"Image"};',
    '    return resultNode;',
    '}',
    'function liveSmartNode(node){ return node || null; }',
    'function ensureBatchRowPlan(){}',
    'function setBatchRowState(){}',
    'function smartGenerationStopRequestedFor(){ return false; }',
    'function syncRunButtonState(){}',
    'function render(){}',
    'function scheduleSave(){}',
    'function markSmartNodeComplete(){}',
    'function mediaLayoutSize(){ return {width:0, height:0}; }',
    'function mediaNodeDefaultScale(){ return 1; }',
    'function cleanHistoryImages(list){ return list; }',
    'function stripImageGenerationMeta(item){ return item; }',
    'async function generateUrlsForCurrentSettings(){ generateCalls += 1; return {urls: nextUrls.slice()}; }',
    extractFn(code, 'appendBatchResultImages'),
    rowFnSrc,
    'globalThis.__batchRow = {',
    '    setNodes(list){ nodes = list; resultNode = null; generateCalls = 0; },',
    '    setUrls(list){ nextUrls = list; },',
    '    node(){ return nodes[0]; },',
    '    result(){ return resultNode; },',
    '    generateCalls(){ return generateCalls; },',
    '    run(nodeId, options, forceVideo){ return tableRunOneRow(nodeId, options, forceVideo); },',
    '};',
].join('\n');

const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, {filename: 'tableRunOneRow-sandbox.js'});
const harness = sandbox.__batchRow;

const ROW_OPTIONS = (rowNumber, batch) => {
    const options = {rowOverride: {prompt: '第' + rowNumber + '行提示词',
        refs: [{url: 'ref-' + rowNumber + '.png', kind: 'image'}]}};
    if(batch !== undefined) options.batch = batch;
    if(rowNumber) options.runContext = {tableId: 't1', rowNumber: rowNumber, batchRunId: 'run-1', batchRowNumbers: [rowNumber]};
    return options;
};

async function runRow({urls, rowNumber, batch, forceVideo = false}){
    harness.setNodes([{id: 'gen1', type: 'smart-batch', images: []}]);
    harness.setUrls(urls);
    const returned = await harness.run('gen1', ROW_OPTIONS(rowNumber, batch), forceVideo);
    return {returned, node: harness.node(), result: harness.result(), generateCalls: harness.generateCalls()};
}

(async () => {
    // ① 批量（options.batch=true）：一次回 4 张，只落第一张
    let r = await runRow({urls: ['u1', 'u2', 'u3', 'u4'], rowNumber: 1, batch: true});
    eq(r.returned, ['u1'], '批量：返回给调用方的只有第一张');
    eq(r.node.images.length, 1, '批量：生成节点 images 只落 1 张');
    eq(r.node.images[0].url, 'u1', '批量：落的是第一张（不是最后一张）');
    eq(r.node.images[0].name, '第1行', '批量：单张命名不带 -N 后缀');
    eq(r.node.images[0].role, 'batch', '批量：仍标记 role=batch');
    eq(r.node.images[0].rowNumber, 1, '批量：仍带真实行号（进度框归位用）');
    eq(r.result.images.length, 1, '批量：下游结果节点只有 1 张');
    eq(r.result.title, 'Image', '批量：结果节点标题是单图 Image（不是 Group）');
    eq(r.generateCalls, 1, '批量：这一行仍然只请求一次');

    // ② 批量产出是 {url, kind} 对象时同样只留第一张
    r = await runRow({urls: [{url: 'a', kind: 'image'}, {url: 'b', kind: 'image'}], rowNumber: 2, batch: true});
    eq(r.node.images.map(img => img.url), ['a'], '批量：对象形式产出也只落第一张');

    // ③ 视频分镜表（forceVideo）走同一条批量链路
    r = await runRow({urls: ['v1', 'v2'], rowNumber: 3, batch: true, forceVideo: true});
    eq(r.node.images.length, 1, '批量视频：只落 1 张');
    eq(r.node.images[0].url, 'v1', '批量视频：落的是第一张');
    eq(r.result.title, 'Video', '批量视频：结果节点标题是单段 Video');

    // ④ 没有 batch 标志、只靠 runContext.rowNumber 识别的批量行，同样只落第一张
    r = await runRow({urls: ['x1', 'x2', 'x3'], rowNumber: 7});
    eq(r.returned, ['x1'], '仅按行号识别：返回只有第一张');
    eq(r.node.images.length, 1, '仅按行号识别：节点只落 1 张');
    eq(r.node.images[0].name, '第7行', '仅按行号识别：命名按真实行号');

    // ⑤ 批量只有一张产出时原样通过
    r = await runRow({urls: ['only'], rowNumber: 5, batch: true});
    eq(r.node.images.length, 1, '批量单张产出：不重复也不丢');
    eq(r.node.images[0].name, '第5行', '批量单张产出：命名正常');

    // ⑥ 非批量（单节点生成）：一次出多张仍然全部保留
    r = await runRow({urls: ['n1', 'n2', 'n3', 'n4'], rowNumber: 0, batch: false});
    eq(r.returned, ['n1', 'n2', 'n3', 'n4'], '非批量：返回的 4 张一张不少');
    eq(r.node.images.map(img => img.url), ['n1', 'n2', 'n3', 'n4'], '非批量：生成节点 images 仍是 4 张');
    eq(r.result.images.length, 4, '非批量：下游结果节点仍是 4 张');
    eq(r.result.title, 'Group', '非批量：多张时结果节点标题仍是 Group');

    // ⑦ 非批量且完全没有 runContext 时也不受影响（不传 batch / 不传行号）
    r = await runRow({urls: ['m1', 'm2'], rowNumber: 0});
    eq(r.node.images.length, 2, '非批量无 runContext：2 张都保留');

    console.log(label + '：' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
})().catch(error => {
    console.error('行为用例异常：' + (error && error.stack || error));
    process.exit(1);
});
