#!/usr/bin/env node
// 分镜表「时长(秒)」逐行驱动视频 duration。
//
// 以前这一列只被拼进该行提示词，真正提交的 duration 永远是节点级 runSettings.videoDuration。
// 现在：表格把每行「时长(秒)」算成 row.duration → 批量派发写进 rowOverride.duration →
// tableRunOneRow 在该行视频请求上覆盖 runSettings.videoDuration（只覆盖本次请求，
// 不回写 settings / 节点），区间沿用 videoDurationBounds()（MODEL_CAPABILITIES 官方区间）。
// 行里没有时长（空 / 非数字）时保持节点级 videoDuration；图片分支不读 duration。
//
// 跑法：node tests/test_table_row_duration.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');

// ═══ A. 数据层：列定位 + 单元格解析（shared/table-model.js） ═══
const model = require('../static/js/shared/table-model.js');

eq(model.durationColumnIndex(['时间段(秒)', '时长(秒)', '画面描述']), 1, '标准分镜表：定位到「时长(秒)」列');
eq(model.durationColumnIndex(['时长（秒）', '画面描述']), 0, '全角括号的列名也认');
eq(model.durationColumnIndex(['Duration(s)', 'shot']), 0, '英文列名也认');
eq(model.durationColumnIndex(['秒数', '画面描述']), 0, '「秒数」也认');
eq(model.durationColumnIndex(['时间段(秒)', '画面描述']), -1, '只有「时间段(秒)」时不误认成时长列');
eq(model.durationColumnIndex(['画面描述', '运镜']), -1, '没有时长列时返回 -1');
eq(model.durationColumnIndex([]), -1, '空表头返回 -1');
eq(model.durationColumnIndex(undefined), -1, '表头缺失也安全');

eq(model.cellDuration('3'), 3, '整数');
eq(model.cellDuration('3.0'), 3, '3.0 → 3');
eq(model.cellDuration(' 2.5 秒 '), 2.5, '带「秒」单位与空格');
eq(model.cellDuration('4s'), 4, '带 s 单位');
eq(model.cellDuration(6), 6, '数字单元格');
eq(model.cellDuration(''), null, '空 → null（回退节点级）');
eq(model.cellDuration('  '), null, '纯空格 → null');
eq(model.cellDuration('约三秒'), null, '非数字 → null');
eq(model.cellDuration('3-5秒'), null, '区间不当成 3 秒 → null');
eq(model.cellDuration('0'), null, '0 秒 → null');
eq(model.cellDuration(model.mediaCell('/a.png', 'image')), null, '媒体格 → null');

// ═══ B/C. 表格侧：行时长 → rowOverride（shared/table-node.js 真实代码） ═══
const tableSrc = fs.readFileSync(path.join(__dirname, '../static/js/shared/table-node.js'), 'utf8');
const blockStart = tableSrc.indexOf('function novaTableModel(){');
const blockEnd = tableSrc.lastIndexOf(String.fromCharCode(10) + '        return {');
ok(blockStart > 0 && blockEnd > blockStart, '能定位表格节点代码段');

const nodes = [];
const connections = [];
const batchCalls = [];
let uidSeq = 0;
const nodesEl = {querySelector(){ return null; }};
const runVideoShim = (id, opts) => { batchCalls.push({id, opts}); return 'via-runVideoNode'; };
const runGeneratorShim = (id, opts) => { batchCalls.push({id, opts}); return 'via-runGenerator'; };

const api = new Function(
    'document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl',
    'canvasPreviewImgHtml', 'canvasVideoPreviewHtml', 'nowMs', 'tr', 'nodesEl',
    'runVideoNode', 'runGenerator', 'window', 'saveCanvas', 'refreshIcons',
    'outputUrlValue', 'mediaKindForRef', 'generationStopRequested',
    tableSrc.slice(blockStart, blockEnd) + String.fromCharCode(10) +
    'return {ensureTableState, tableRowInputs, runTableBatch, tableBatchRunner};'
)(
    {}, () => {}, () => ({x:0, y:0}), n => { nodes.push(n); return n; }, () => {}, p => p + '_' + (uidSeq += 1),
    connections, nodes, () => {}, n => (n && n.mediaKind) || 'image', () => false,
    () => '', () => '', () => 1700000000000, key => key, nodesEl,
    runVideoShim, runGeneratorShim, {}, () => {}, () => {},
    item => (typeof item === 'string' ? item : (item && item.url) || ''),
    ref => String((ref && ref.kind) || 'image'),
    () => false
);

const tableNode = {
    id: 'tbl1', type: 'table',
    table: model.normalizeTable({
        columns: ['时间段(秒)', '时长(秒)', '画面描述'],
        rows: [
            ['0-5s', '5', '镜头A：推近'],
            ['5-13s', '8', '镜头B：拉远'],
            ['13-25s', '12', '镜头C：固定'],
            ['25-30s', '', '镜头D：未写时长'],
            ['30-35s', '大约三秒', '镜头E：写了文字'],
        ],
    }).table,
};
tableNode.table.selectedRows = [0, 1, 2, 3, 4];
api.ensureTableState(tableNode);
const genNode = {id: 'gen1', type: 'video', images: []};
nodes.push(tableNode, genNode);
connections.push({id: 'c1', from: tableNode.id, to: genNode.id});

const rows = api.tableRowInputs(tableNode);
eq(rows.map(row => row.duration), [5, 8, 12, null, null], '逐行时长：纯数字认，空/文字回退 null');
ok(rows[0].prompt.indexOf('镜头A') >= 0 && rows[0].prompt.indexOf('5') >= 0, '第 1 行提示词仍逐行对应（含时长文字）');
ok(rows[1].prompt.indexOf('镜头B') >= 0 && rows[1].prompt.indexOf('8') >= 0, '第 2 行提示词仍逐行对应');
ok(rows[3].prompt.indexOf('镜头D') >= 0, '第 4 行提示词仍逐行对应');

// 没有时长列时行为不变
const plain = {
    id: 'tbl2', type: 'table',
    table: model.normalizeTable({columns: ['画面描述'], rows: [['镜头X']]}).table,
};
nodes.push(plain);
eq(api.tableRowInputs(plain).map(row => row.duration), [null], '没有时长列 → duration 全是 null');

(async () => {
    // 批量派发：每行把自己的时长和提示词一起交给运行器
    eq(api.tableBatchRunner(genNode), runVideoShim, '视频节点走 runVideoNode');
    tableNode.tableBatchConcurrency = 1;
    await api.runTableBatch(genNode.id, {});
    eq(batchCalls.length, 5, '批量逐行派发 5 次');
    eq(batchCalls.map(call => call.opts.rowOverride.duration), [5, 8, 12, null, null],
        'rowOverride.duration 逐行对应');
    ok(batchCalls[0].opts.rowOverride.prompt.indexOf('镜头A') >= 0
        && batchCalls[2].opts.rowOverride.prompt.indexOf('镜头C') >= 0, '提示词与时长同一行对应');
    eq(batchCalls.map(call => call.opts.runContext.rowNumber), [1, 2, 3, 4, 5], '行号不变');

    // ═══ D. 执行侧：这一行视频请求的 duration（smart-canvas.js 的 tableRunOneRow） ═══
    const smartSrc = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');

    function extractFn(src, name){
        const start = src.indexOf('function ' + name + '(');
        if(start < 0) throw new Error('未找到函数 ' + name);
        const end = src.indexOf(String.fromCharCode(10) + '}', start);
        if(end < 0) throw new Error('未找到函数结尾 ' + name);
        return src.slice(start, end + 2);
    }
    function extractBetween(src, from, to){
        const start = src.indexOf(from);
        if(start < 0) throw new Error('未找到 ' + from);
        const end = src.indexOf(to, start);
        if(end < 0) throw new Error('未找到 ' + to);
        return src.slice(start, end + to.length);
    }

    // 官方时长表连同它引用的比例键一起抠出来（MODEL_CAPABILITIES 与节点级滑条共用这一张表）
    const capsAt = smartSrc.indexOf('const GEMINI_RATIO_KEYS = [');
    const capsEnd = smartSrc.indexOf(String.fromCharCode(10) + '];', smartSrc.indexOf('const MODEL_CAPABILITIES = ['));
    ok(capsAt > 0 && capsEnd > capsAt, '能定位 MODEL_CAPABILITIES（官方时长表）');
    const capsSrc = smartSrc.slice(capsAt, capsEnd + 3);
    const minAt = smartSrc.indexOf('const VIDEO_DURATION_MIN');
    const minSrc = smartSrc.slice(minAt, smartSrc.indexOf(';', minAt) + 1);
    ok(/VIDEO_DURATION_DEFAULT = 5/.test(minSrc), '能定位节点级默认时长常量');

    const rowFnSrc = (smartSrc.includes('async function tableRunOneRow(') ? 'async ' : '')
        + extractFn(smartSrc, 'tableRunOneRow');

    // 提交体里的 duration 仍以 runSettings.videoDuration 为准（本次覆盖写的就是它）
    ok(/duration: \(\(\) => \{ const b = videoDurationBounds\(runSettings\.videoModel\); return Math\.max\(b\.min, Math\.min\(b\.max, Number\(runSettings\.videoDuration\) \|\| VIDEO_DURATION_DEFAULT\)\); \}\)\(\),/.test(smartSrc),
        '提交体 duration 来自 runSettings.videoDuration + videoDurationBounds（未被改成第二套表）');

    const sandboxSrc = [
        'const settings = {videoDuration:6, videoModel:"agnes-video-2.5"};',
        'let nodes = [];',
        'let resultNode = null;',
        'let nextUrls = ["v1"];',
        'let lastRunSettings = null;',
        'const canvas = {connections: []};',
        'const batchRunResultNodes = new Map();',
        capsSrc,
        extractFn(smartSrc, 'modelCapabilityFor'),
        extractFn(smartSrc, 'videoDurationRange'),
        minSrc,
        extractFn(smartSrc, 'videoDurationBounds'),
        'function smartSettingsForNode(){ return {}; }',
        'function snapshotRunMeta(prompt){ return {prompt:String(prompt || "")}; }',
        'function rowSourceRatio(){ return Promise.resolve(null); }',
        'function explicitRequestOutputSizeForPending(){ return null; }',
        'function applyRowSourceRatioToSettings(){}',
        'function applySourceRatioToVideoAspect(){}',
        'function batchResultNodeForRun(){',
        '    if(!resultNode) resultNode = {id:"out1", type:"smart-video", images:[], pending:1, title:"Video"};',
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
        'function stripImageGenerationMeta(item){ return item; }',
        'function cleanHistoryImages(list){ return list; }',
        extractFn(smartSrc, 'nonPreviewOutputImages'),
        'async function generateUrlsForCurrentSettings(node, prompt, refs, runSettings){',
        '    lastRunSettings = Object.assign({}, runSettings);',
        '    return {urls: nextUrls.slice()};',
        '}',
        extractFn(smartSrc, 'appendBatchResultImages'),
        rowFnSrc,
        'globalThis.__rowRun = {',
        '    model(name){ settings.videoModel = name; },',
        '    nodeLevelDuration(){ return settings.videoDuration; },',
        '    setNodeLevelDuration(value){ settings.videoDuration = value; },',
        '    async run(rowNumber, duration, forceVideo){',
        '        nodes = [{id:"gen1", type:"smart-batch", images:[]}];',
        '        const options = {batch:true, rowOverride:{prompt:"第" + rowNumber + "行", refs:[{url:"r" + rowNumber + ".png", kind:"image"}]}};',
        '        if(duration !== undefined) options.rowOverride.duration = duration;',
        '        options.runContext = {tableId:"t1", rowNumber: rowNumber, batchRunId:"run-" + rowNumber, batchRowNumbers:[rowNumber]};',
        '        lastRunSettings = null;',
        '        await tableRunOneRow("gen1", options, forceVideo);',
        '        return lastRunSettings;',
        '    },',
        '};',
    ].join(String.fromCharCode(10));

    const sandbox = {console};
    vm.createContext(sandbox);
    vm.runInContext(sandboxSrc, sandbox, {filename: 'table-run-one-row-sandbox.js'});
    const runtime = sandbox.__rowRun;

    // Agnes Video 2.5 官方 seconds 区间 4–12（MODEL_CAPABILITIES / main.py agnes_video_seconds 同口径）
    eq(await runtime.run(1, 5, true).then(s => s.videoDuration), 5, 'Agnes：行时长 5 → 本次 duration 5');
    eq(await runtime.run(2, 8, true).then(s => s.videoDuration), 8, 'Agnes：行时长 8 → 本次 duration 8');
    eq(await runtime.run(3, 12, true).then(s => s.videoDuration), 12, 'Agnes：行时长 12 → 本次 duration 12');
    eq(await runtime.run(4, 2, true).then(s => s.videoDuration), 4, 'Agnes：行时长 2 越下界 → 收敛 4');
    eq(await runtime.run(5, 20, true).then(s => s.videoDuration), 12, 'Agnes：行时长 20 越上界 → 收敛 12');
    eq(await runtime.run(6, 2.5, true).then(s => s.videoDuration), 4, 'Agnes：2.5 秒仍按区间收敛到 4（小数不四舍五入）');
    eq(await runtime.run(7, undefined, true).then(s => s.videoDuration), 6, '行里没有时长 → 回退节点级 6');
    eq(await runtime.run(8, null, true).then(s => s.videoDuration), 6, '行时长 null → 回退节点级 6');
    eq(await runtime.run(9, 9, false).then(s => s.videoDuration), 6, '图片分支：duration 不参与，仍是节点级 6');
    eq(runtime.nodeLevelDuration(), 6, '逐行覆盖不回写节点级 settings.videoDuration');

    // 其它模型的官方区间（同一张表，clamp 到各自边界）
    runtime.model('kling-3.0-turbo');
    eq(await runtime.run(1, 20, true).then(s => s.videoDuration), 15, 'Kling：20 → 15');
    eq(await runtime.run(2, 1, true).then(s => s.videoDuration), 3, 'Kling：1 → 3');
    runtime.model('seedance-1-0');
    eq(await runtime.run(3, 20, true).then(s => s.videoDuration), 12, 'Seedance 1.0：20 → 12');
    runtime.model('no-such-video-model');
    eq(await runtime.run(4, 20, true).then(s => s.videoDuration), 15, '没有官方区间的模型：沿用画布默认 4–15 → 15');
    eq(await runtime.run(5, 2, true).then(s => s.videoDuration), 4, '没有官方区间的模型：2 → 4');

    console.log('分镜表逐行时长：' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
})().catch(error => {
    console.error('用例异常：' + (error && error.stack || error));
    process.exit(1);
});
