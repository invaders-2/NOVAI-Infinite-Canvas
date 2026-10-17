#!/usr/bin/env node
// 经典画布（static/js/canvas.js）批量视频：分镜表「时长(秒)」逐行驱动本次请求的 duration。
//
// 链路：shared/table-node.js 把每行「时长(秒)」算成 row.duration → rowOverride.duration →
// canvas.js 的 runVideoNode 在提交体里把这一行的 duration 覆盖成行内时长。
// 区间沿用经典画布已有的 videoDurationRange()（MODEL_CAPABILITIES 官方区间；没有官方区间时
// 沿用节点时长输入框的 1–60 兜底），越界收敛到边界；行里没有时长就保持节点级 node.duration。
// 只覆盖本次提交，不回写 node.duration；图片分支走 runGenerator，完全不读 duration。
//
// 差分证明（接改前备份应失败）：
//   NOVAI_CLASSIC_DURATION_SRC=/tmp/novai-classicdur-evidence/backup/canvas.js \
//     node tests/test_canvas_batch_row_duration.js
// 运行：node tests/test_canvas_batch_row_duration.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLASSIC_SRC = process.env.NOVAI_CLASSIC_DURATION_SRC || path.join(ROOT, 'static/js/canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');

const src = fs.readFileSync(CLASSIC_SRC, 'utf8');
console.log('[classic-duration] 经典画布源码 = ' + (process.env.NOVAI_CLASSIC_DURATION_SRC || 'static/js/canvas.js'));

function blockOf(re, label){
    const matched = re.exec(src);
    if(!matched) throw new Error('缺少源码块 ' + label);
    return matched[0];
}
// 顶层 function（含 async）：函数体里所有右花括号都有缩进，第一个顶格 '\n}' 就是函数结尾。
function topLevelFunction(name){
    const matched = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    if(!matched) throw new Error('未找到函数 ' + name);
    const start = matched.index + 1;
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

// 官方时长表（与节点级时长输入框共用同一张 MODEL_CAPABILITIES）+ 两个比例键常量。
const capsSrc = [
    blockOf(/const GEMINI_RATIO_KEYS = \[[\s\S]*?\];/, 'GEMINI_RATIO_KEYS'),
    blockOf(/const SEEDREAM_RATIO_KEYS = \[[\s\S]*?\];/, 'SEEDREAM_RATIO_KEYS'),
    blockOf(/const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/, 'MODEL_CAPABILITIES')
].join('\n');

/* 从 canvas.js 原样抠出 runVideoNode 与时长区间函数，依赖全部用桩注入；
   这样测的是真实实现，而不是在测试里复制一份逻辑。 */
const sandboxBody = [
    'let nodes = [];',
    'let outNode = null;',
    'let pendingSeq = 0;',
    'const posted = [];',
    capsSrc,
    topLevelFunction('modelCapabilityFor'),
    topLevelFunction('videoDurationRange'),
    'function cascadeTargetIdFromOptions(){ return ""; }',
    'function applyUploadedUrlToRefs(refs){ return refs || []; }',
    'function mediaKindForRef(ref){ return (ref && ref.kind) || "image"; }',
    'function generatorSources(){ return [{id:"src1", prompt:"节点级提示词", refs:[]}]; }',
    'function orderedSources(node, sources){ return sources || []; }',
    'function generatorNeedsPromptMessage(){ return "need prompt"; }',
    'function imageRefsOnly(refs){ return (refs || []).filter(ref => mediaKindForRef(ref) === "image"); }',
    'function videoRefsOnly(refs){ return (refs || []).filter(ref => mediaKindForRef(ref) === "video"); }',
    'function audioRefsOnly(refs){ return (refs || []).filter(ref => mediaKindForRef(ref) === "audio"); }',
    'function manualVideoUrlForNode(){ return ""; }',
    'function tempShUploadedUrlForNode(node, url){ return url; }',
    'function tr(key){ return key; }',
    'function outputForNode(){ if(!outNode) outNode = {id:"out1", type:"output", _pending:[]}; return outNode; }',
    'function uid(prefix){ return prefix + (++pendingSeq); }',
    'function runSnapshot(node, prompt, refs){ return {node, prompt, refs}; }',
    'function makePendingForRun(id, run, node, options){ return {id, run, node, options}; }',
    'function refreshRunNodes(){}',
    'async function resolveVideoNodeAspectRatio(){ return "16:9"; }',
    'function resolveVideoProviderId(id){ return id || "comfly"; }',
    'async function cascadeFetch(url, init){',
    '    posted.push({url, body: JSON.parse(init.body)});',
    '    return {ok:true, json:async () => ({task_id:"task_stub"})};',
    '}',
    'async function responseErrorMessage(){ return "stub error"; }',
    'async function waitCanvasVideoTaskResult(){ return {videos:[{url:"/out/stub.mp4", kind:"video"}]}; }',
    'function collectRunMeta(){ return {runMs:1}; }',
    'function requestMetaFromResult(){ return {}; }',
    'function resultMediaUrls(result){ return (result && result.videos) || []; }',
    'function outputUrlValue(item){ return typeof item === "string" ? item : ((item && item.url) || ""); }',
    'function appendOutputImages(){}',
    'function mergeGeneratedOutputs(){}',
    'function addGenerationLog(){}',
    'function scheduleSave(){}',
    'function friendlyBatchError(message){ return message; }',
    'function isCascadeAbortError(){ return false; }',
    'function alert(){}',
    topLevelFunction('runVideoNode'),
    'return {',
    '    posted,',
    '    async run(node, options){',
    '        nodes = [node];',
    '        outNode = null;',
    '        posted.length = 0;',
    '        node.running = false;',
    '        node.runStatus = "";',
    '        await runVideoNode(node.id, options);',
    '        return posted.length ? posted[0] : null;',
    '    },',
    '};'
].join('\n');

const runtime = new Function('console', sandboxBody)(console);

const videoNode = model => ({
    id: 'vid1', type: 'video', model,
    duration: 6, aspectRatio: '16:9', resolution: '', apiProvider: 'comfly'
});
// 表格批量派发时给的 options：batch + 逐行 rowOverride + runContext（矩阵场景走 async 提交）
function batchOptions(rowNumber, duration){
    const options = {
        batch: true,
        rowOverride: {prompt: '第' + rowNumber + '行分镜', refs: [{url: '/assets/row' + rowNumber + '.png', kind: 'image'}], duration},
        runContext: {tableId: 'tbl1', rowNumber, batchRunId: 'batch1', batchRowNumbers: [1, 2, 3]}
    };
    return options;
}
async function runCase(model, rowDuration){
    const node = videoNode(model);
    const posted = await runtime.run(node, batchOptions(1, rowDuration));
    return {node, body: posted && posted.body, url: posted && posted.url};
}

(async () => {
    // ═══ 1. 三行分镜 5 / 8 / 12 秒：提交体 duration 逐行不同（Agnes 官方 4–12 秒） ═══
    console.log('[1] 三行分镜 5/8/12 → 三次提交体 duration = 5/8/12');
    const rows = [5, 8, 12];
    const submitted = [];
    for(let index = 0; index < rows.length; index++){
        const node = videoNode('agnes-video-2.5');
        const posted = await runtime.run(node, batchOptions(index + 1, rows[index]));
        ok(posted && posted.url === '/api/canvas-video?async=1', '第 ' + (index + 1) + ' 行走表格批量的异步视频提交');
        eq(posted && posted.body.run_context.rowNumber, index + 1, '第 ' + (index + 1) + ' 行提交体带同一行号');
        ok(posted && String(posted.body.prompt).indexOf('第' + (index + 1) + '行分镜') >= 0, '第 ' + (index + 1) + ' 行提示词对应本行');
        submitted.push(posted && posted.body.duration);
        eq(node.duration, 6, '第 ' + (index + 1) + ' 行逐行覆盖不回写 node.duration');
    }
    eq(submitted, [5, 8, 12], '三次提交体 duration 分别 5 / 8 / 12（不再一律是节点级 6）');

    // ═══ 2. 越界收敛到模型官方边界（沿用 videoDurationRange 的同一条 clamp） ═══
    console.log('[2] 越界值收敛到模型边界');
    eq((await runCase('agnes-video-2.5', 2)).body.duration, 4, 'Agnes：2 秒越下界 → 4');
    eq((await runCase('agnes-video-2.5', 20)).body.duration, 12, 'Agnes：20 秒越上界 → 12');
    eq((await runCase('agnes-video-2.5', 2.5)).body.duration, 4, 'Agnes：2.5 秒按区间收敛到 4（不四舍五入）');
    eq((await runCase('agnes-video-2.5', 7.5)).body.duration, 7.5, '区间内的小数原样提交');
    eq((await runCase('kling-3.0-turbo', 20)).body.duration, 15, 'Kling 3.0 Turbo：20 → 15');
    eq((await runCase('kling-3.0-turbo', 1)).body.duration, 3, 'Kling 3.0 Turbo：1 → 3');
    eq((await runCase('seedance-1-0', 20)).body.duration, 12, 'Seedance 1.0：20 → 12');
    eq((await runCase('seedance-2-0-fast', 1)).body.duration, 4, 'Seedance 2.0 Fast：1 → 4');
    // 没有官方区间的模型：沿用经典画布节点时长输入框的 1–60 兜底（不新造第二套表）
    eq((await runCase('some-unknown-video', 20)).body.duration, 20, '无官方区间的模型：20 在 1–60 内原样提交');
    eq((await runCase('some-unknown-video', 90)).body.duration, 60, '无官方区间的模型：90 → 60（沿用画布兜底）');

    // ═══ 3. 行里没有时长 → 回退节点级 duration ═══
    console.log('[3] 空 / 缺失 / 非数字时长 → 回退节点级');
    for(const value of [null, undefined, '', '约三秒', 0]){
        const result = await runCase('agnes-video-2.5', value);
        eq(result.body.duration, 6, '行时长 ' + JSON.stringify(value) + ' → 回退节点级 6');
        eq(result.node.duration, 6, '行时长 ' + JSON.stringify(value) + ' 不改变节点级 6');
    }
    // 完全没有 rowOverride（单段生成 / 一键运行）行为不变
    {
        const node = videoNode('agnes-video-2.5');
        const posted = await runtime.run(node, {runContext: {rowNumber: 1, batchRunId: 'b1'}});
        eq(posted.body.duration, 6, '没有 rowOverride.duration → 节点级 6');
    }

    // ═══ 4. 图片分支不在这次改动里：runGenerator 不读逐行时长 ═══
    console.log('[4] 图片分支不受影响');
    const generatorSrc = topLevelFunction('runGenerator');
    ok(generatorSrc.length > 0, '能定位 runGenerator');
    ok(!/rowOverride\.duration|runDuration|videoDurationRange/.test(generatorSrc),
        'runGenerator 不出现逐行时长 / 视频区间逻辑（图片分支不读 duration）');
    ok(/duration:runDuration/.test(topLevelFunction('runVideoNode')),
        'runVideoNode 的提交体确实用本次算出的 duration');

    console.log('经典画布批量视频逐行时长：' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
})().catch(error => {
    console.error('用例异常：' + (error && error.stack || error));
    process.exit(1);
});
