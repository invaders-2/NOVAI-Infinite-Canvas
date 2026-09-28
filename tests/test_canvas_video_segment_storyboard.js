#!/usr/bin/env node
// 经典画布（static/js/canvas.js）视频分镜表：参考视频按「每段秒数」自动分段，一段一行。
//
// 覆盖：
//   1. 真实经典画布数据（data/canvases/88fa24fb89e848f5af8c979c1c2bd8b4.json）里取素材 / LLM / 下游视频节点
//   2. 只有视频分镜表才有的「每段秒数」下拉（1-5 秒，默认 3，存 node.segmentSeconds）
//   3. 分段链路：/api/video/segments 真实切段 → 一段一行 → 每行视频格 = 该段 clip_url
//   4. 产品 / 模特通道一律 mode='all'（每行都带），行提示词 @引用零悬空（跑 shared/table-node.js 的真实 tableRowInputs）
//   5. 摘帧描述：/api/canvas-llm 带 images + no_prompt_intelligence + 180s 超时，每次最多 8 张分批，失败走兜底文案
//   6. 物化后表格自动接到下游视频节点（批量面板才会出现）
//   7. 分段接口失败 → 中文提示 + 回退老链路「LLM 直接出分镜表」，节点不卡 running
//
// 跑法：node tests/test_canvas_video_segment_storyboard.js（cwd 必须是仓库根）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../static/js/shared/table-model.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a) + '）');
const has = (text, frag, msg) => ok(String(text).includes(frag), msg + '（找不到 ' + frag + '）');

const canvasSrc = fs.readFileSync(path.join(__dirname, '../static/js/canvas.js'), 'utf8');
const modelSrc = fs.readFileSync(path.join(__dirname, '../static/js/shared/table-model.js'), 'utf8');

// 从源码里原样抠出待测函数，避免在测试里复制一份逻辑导致「测的不是真代码」。
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    // async 关键字在 'function' 之前，不加回来抠出的就是语法错误的 await
    const head = src.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
    return head + src.slice(start, end + 2);
}
// 单行声明（const / 一行写完的 function）按整行抠
function extractLine(src, name){
    const hit = new RegExp('^(?:const |function )' + name + '[ (=].*$', 'm').exec(src);
    if(!hit) throw new Error('未找到声明 ' + name);
    return hit[0];
}

/* ─────────────── 0. 经典画布真实数据 ───────────────
   画布 JSON 是运行时数据（data/canvases 在 .gitignore 里）：读得到就用真节点，
   读不到退回同一份结构的最小节点图，测试照跑。 */
const REAL_CANVAS = path.join(__dirname, '../data/canvases/88fa24fb89e848f5af8c979c1c2bd8b4.json');
const REAL_IDS = {
    llm: 'llm_b5eec349da2b1_1789698453331',
    productMembers: ['img_4c2b7f47e312a8_1789694458263', 'img_4bdd6c384a465_1789694458263', 'img_4449152182954_1789694458263'],
    model: 'img_188a0f8129ca48_1789694333885',
    videoTarget: 'vid_8816278501d7_1789750093130',
};
const FALLBACK_MEDIA = {
    products: [
        {id: REAL_IDS.productMembers[0], name: 'DSC05717.jpg', url: '/assets/input/ai_ref_19292f15e323.jpg'},
        {id: REAL_IDS.productMembers[1], name: 'DSC05721.jpg', url: '/assets/input/ai_ref_5f8130975360.jpg'},
        {id: REAL_IDS.productMembers[2], name: 'DSC05729.jpg', url: '/assets/input/ai_ref_4f8d8f773332.jpg'},
    ],
    model: {id: REAL_IDS.model, name: '卡其 (2).jpg', url: '/assets/input/ai_ref_183bf73c4572.jpg'},
};
const VIDEO_URL = '/assets/input/ai_ref_a36ca049dbcd.mp4';
const REF_VIDEO_NODE_ID = 'img_canvas_segment_ref';
const kindForUrl = url => /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(String(url || '')) ? 'video'
    : (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(url || '')) ? 'audio' : 'image');

function canvasMediaFixture(){
    if(!fs.existsSync(REAL_CANVAS)) return {real: false, products: FALLBACK_MEDIA.products, model: FALLBACK_MEDIA.model, llm: null};
    const canvas = JSON.parse(fs.readFileSync(REAL_CANVAS, 'utf8'));
    const byId = new Map((canvas.nodes || []).map(n => [n.id, n]));
    const products = REAL_IDS.productMembers.map(id => {
        const node = byId.get(id);
        return node ? {id, name: node.name, url: node.url} : null;
    }).filter(Boolean);
    const model = byId.get(REAL_IDS.model);
    if(products.length !== REAL_IDS.productMembers.length || !model || !byId.get(REAL_IDS.llm)) {
        return {real: false, products: FALLBACK_MEDIA.products, model: FALLBACK_MEDIA.model, llm: null};
    }
    return {
        real: true,
        products,
        model: {id: model.id, name: model.name, url: model.url},
        llm: byId.get(REAL_IDS.llm),
    };
}

const MEDIA = canvasMediaFixture();
console.log('[0] 素材来源：' + (MEDIA.real ? '真实画布 ' + path.basename(REAL_CANVAS) : '内置最小节点图（真实画布数据不存在）'));

function buildFixture(){
    const nodes = MEDIA.products.map(item => ({id:item.id, type:'image', name:item.name, url:item.url}));
    nodes.push({id:'grp_canvas_segment_product', type:'group', items:MEDIA.products.map(item => item.id)});
    nodes.push({id:MEDIA.model.id, type:'image', name:MEDIA.model.name, url:MEDIA.model.url});
    nodes.push({id:REF_VIDEO_NODE_ID, type:'image', name:'参考视频.mp4', url:VIDEO_URL});
    const llm = MEDIA.llm
        ? JSON.parse(JSON.stringify(MEDIA.llm))
        : {id:'llm_canvas_segment', type:'llm', mode:'node', systemPrompt:'You are a helpful assistant.', messages:[]};
    llm.llmOutputMode = 'list-video';
    llm.outputText = '';
    nodes.push(llm);
    nodes.push({id:REAL_IDS.videoTarget, type:'video', model:'vegas-2.5', duration:5, aspectRatio:'16:9'});
    const connections = [
        {id:'c_ref', from:REF_VIDEO_NODE_ID, to:llm.id},
        {id:'c_model', from:MEDIA.model.id, to:llm.id},
        {id:'c_product', from:'grp_canvas_segment_product', to:llm.id},
        {id:'c_down', from:llm.id, to:REAL_IDS.videoTarget},
    ];
    const requirement = '参考视频做分镜，人物替换成' + MEDIA.model.name + '，鞋子替换成'
        + MEDIA.products.map(item => item.name).join(' ') + '，去掉logo';
    return {nodes, connections, llm, requirement, videoTargetId:REAL_IDS.videoTarget};
}

/* ─────────────── 1. 从 canvas.js 抠出真实实现 ─────────────── */
function segmentSnippets(withRealCallCanvasLLM, withListMode){
    const list = [
        extractLine(canvasSrc, 'SEGMENT_SHOTS_BATCH'),
        extractLine(canvasSrc, 'SEGMENT_SHOTS_TIMEOUT_MS'),
        extractLine(canvasSrc, 'SEGMENT_STORYBOARD_COLUMNS'),
        extractLine(canvasSrc, 'SEGMENT_SHOT_FALLBACK'),
        extractLine(canvasSrc, 'LLM_SEGMENT_SECONDS_OPTIONS'),
        extractFn(canvasSrc, 'outputUrlValue'),
        extractFn(canvasSrc, 'canvasLlmOutputModeValue'),
        extractFn(canvasSrc, 'segmentSecondsOf'),
        extractFn(canvasSrc, 'llmSegmentSecondsHtml'),
        extractFn(canvasSrc, 'segmentEntryKey'),
        extractFn(canvasSrc, 'segmentMediaUrlFor'),
        extractFn(canvasSrc, 'segmentMediaNameFor'),
        extractFn(canvasSrc, 'segmentStoryboardSources'),
        extractFn(canvasSrc, 'segmentStoryboardPlan'),
        extractFn(canvasSrc, 'segmentStoryboardTable'),
        extractFn(canvasSrc, 'setSegmentManualInputList'),
        extractFn(canvasSrc, 'applySegmentStoryboardChannels'),
        extractFn(canvasSrc, 'requestVideoSegments'),
        extractFn(canvasSrc, 'callCanvasLLMSegmentShots'),
        extractFn(canvasSrc, 'segmentShotsFor'),
        extractFn(canvasSrc, 'connectCanvasVideoTargetsFor'),
        extractFn(canvasSrc, 'runSegmentStoryboard'),
    ];
    if(withRealCallCanvasLLM) list.push(extractFn(canvasSrc, 'callCanvasLLM'));
    if(withListMode) list.push(extractFn(canvasSrc, 'runLLMListMode'));
    return list;
}

/* ─────────────── 2. 验收场景：参考视频 + 模特图 + 产品组连线 → 一段一行 ─────────────── */
const FIX = buildFixture();
const SEGMENTS = M.planVideoSegments(14.613, 3, 30).map((item, index) => Object.assign({}, item, {
    clip_url: '/assets/input/segments/canvas-test/seg_0' + (index + 1) + '.mp4',
    frame_url: '/assets/input/segments/canvas-test/seg_0' + (index + 1) + '.jpg',
}));

const llmCalls = [];
const posted = [];
let segmentsMode = 'ok';
// 模拟「模型少写几段」：按顺序给每次 canvas-llm 调用一个返回条数上限（0 / 缺省 = 全给）
let shotLimits = [];
async function fakeFetch(url, init){
    const body = init && init.body ? JSON.parse(init.body) : null;
    posted.push({url:String(url), body, signal: init && init.signal});
    if(String(url) === '/api/video/segments'){
        if(segmentsMode === 'fail'){
            return {ok:false, status:400, json: async () => ({detail:'找不到视频文件：' + VIDEO_URL})};
        }
        return {ok:true, status:200, json: async () => ({ok:true, duration:14.613, seconds:3, truncated:false, segments:SEGMENTS})};
    }
    if(String(url) === '/api/canvas-llm'){
        llmCalls.push(body);
        const images = (body && body.images) || [];
        if(images.some(item => String(item).includes('fail'))){
            return {ok:false, status:500, json: async () => ({detail:'模型挂了'})};
        }
        // 段号从提示词里抠（提示词里写着「第 N 段（…）」；补齐请求会明确写「本次只写第 4、5 段」）
        const indexes = [];
        String(body && body.message || '').replace(/第 (\d+) 段（/g, (all, digits) => { indexes.push(Number(digits)); return all; });
        const limit = shotLimits.length ? shotLimits.shift() : 0;
        const wanted = limit > 0 ? indexes.slice(0, limit) : indexes;
        return {ok:true, status:200, json: async () => ({text: JSON.stringify({shots: wanted.map(index => ({
            index, '画面描述':'第' + index + '段画面', '运镜':'缓慢推近',
        }))})})};
    }
    throw new Error('未预期的请求 ' + url);
}

global.NovaTableModel = M;
require('../static/js/shared/table-node.js');
let uidSeq = 0;
const liveNodes = FIX.nodes;
const liveConnections = FIX.connections;
const tableApi = global.NovaTableNode({
    tr: key => key, uid: prefix => prefix + '_' + (++uidSeq), nodes: liveNodes, connections: liveConnections,
    nodesEl: {querySelector: () => null},
    selected: {has:() => false, add(){}, delete(){}, forEach(){}, get size(){ return 0; }},
    addNode(node){ liveNodes.push(node); return node; },
    render(){}, renderNode(){}, refreshIcons(){}, nowMs: () => Date.now(),
    scheduleSave(){}, saveCanvas: async () => {}, pushUndo(){}, defaultPoint: (x, y) => ({x:x || 0, y:y || 0}),
    mediaKindForNode: node => (node && node.mediaKind) || kindForUrl(node && node.url),
    mediaKindForRef: ref => (ref && ref.kind) || kindForUrl(ref && ref.url),
    mediaKindForUpload: file => kindForUrl(file && file.name),
    outputUrlValue: item => (typeof item === 'string' ? item : (item && item.url) || ''),
    isMissingAssetUrl: () => false,
    canvasPreviewImgHtml: () => '', canvasVideoPreviewHtml: () => '',
    responseErrorMessage: async (res, fallback) => fallback + ' ' + res.status, showErrorModal(){},
    runGenerator(){}, runVideoNode(){}, generationStopRequested: () => false, onBatchSettled(){},
});

const sandbox = {console, setTimeout, clearTimeout, AbortController, __MODEL:M, __NODES:liveNodes, __CONNS:liveConnections, __API:tableApi, __fetch:fakeFetch};
vm.createContext(sandbox);
vm.runInContext([
    'const window = {NovaTableModel: __MODEL};',
    'let nodes = __NODES;',
    'let connections = __CONNS;',
    'let saveCount = 0;',
    'let refreshCount = 0;',
    'const toasts = [];',
    'const connectNodes = __API.connectNodes;',
    'const materializeLlmTable = __API.materializeLlmTable;',
    'function scheduleSave(){ saveCount += 1; }',
    'function refreshNodes(){ refreshCount += 1; }',
    'function pushUndo(){}',
    'function notifyCanvas(text){ toasts.push(String(text)); }',
    'function tr(key){ return key; }',
    'function escapeAttr(value){ return String(value); }',
    'function escapeHtml(value){ return String(value); }',
    'function novaTableModel(){ return __MODEL; }',
    'function resolveChatProviderId(id){ return id || "comfly"; }',
    'function resolveChatModel(model){ return model || "gpt-test"; }',
    'function llmInputImages(){ return []; }',
    'function llmInputVideos(){ return []; }',
    'function llmDownstreamTarget(){ return {target_type:"video", target_model:""}; }',
    'async function responseErrorMessage(res, fallback){ return fallback + " " + res.status; }',
    'async function fetch(input, init){ return __fetch(input, init); }',
    'async function cascadeFetch(input, init){ return __fetch(input, init); }',
].concat(segmentSnippets(true)).concat([
    'globalThis.__seg = {',
    '    run: (node, requirement, groups) => runSegmentStoryboard(node, requirement, groups, __API, __MODEL),',
    '    sources: segmentStoryboardSources, plan: segmentStoryboardPlan, table: segmentStoryboardTable,',
    '    apply: applySegmentStoryboardChannels, shots: segmentShotsFor, secondsHtml: llmSegmentSecondsHtml,',
    '    seconds: segmentSecondsOf, mediaUrl: segmentMediaUrlFor, mediaName: segmentMediaNameFor,',
    '    connect: connectCanvasVideoTargetsFor,',
    '    saves: () => saveCount, refreshes: () => refreshCount, toasts: () => toasts,',
    '    fallbackText: SEGMENT_SHOT_FALLBACK, ensureState: node => __API.tableRowInputs(node),',
    '};',
]).join('\n'), sandbox, {filename:'canvas-segment-sandbox.js'});
const seg = sandbox.__seg;

/* ─────────────── 3. 素材分角色 + 通道规划 ─────────────── */
console.log('[1] 素材分角色 / 通道规划（真实 llmMediaGroups）');
{
    const groups = tableApi.llmMediaGroups(FIX.llm);
    eq(groups.length, 3, '三个连线来源 = 三个通道');
    const sources = seg.sources(groups, FIX.requirement);
    eq(sources.groups.map(group => group.channelId), ['input-1', 'input-2', 'input-3'], '通道 id 与表格侧一致');
    eq(sources.connected.map(entry => entry.url), [VIDEO_URL, MEDIA.model.url].concat(MEDIA.products.map(item => item.url)),
        '素材清单：参考视频 + 模特图 + 3 张产品图');
    const cls = M.classifySegmentInputs(sources.connected, sources.instructionText);
    eq(cls.video && cls.video.url, VIDEO_URL, '参考视频 = 连线的那条 mp4');
    eq(cls.modelOutfit.map(e => e.name), [MEDIA.model.name], '语境「人物替换成 …」→ 模特/穿搭');
    eq(cls.product.map(e => e.name), MEDIA.products.map(item => item.name), '语境「鞋子替换成 …」→ 产品');

    const plan = seg.plan(sources, cls);
    eq(plan.videoChannelId, 'input-1', '参考视频通道 = input-1');
    eq(plan.videoOrdinal, 1, '参考视频全局序号 = 1');
    eq(plan.modelOutfit.map(e => e.ordinal), [2], '模特图全局序号 = 2');
    eq(plan.product.map(e => e.ordinal), [3, 4, 5], '产品图全局序号 = 3..5');
    eq(plan.modes, {'input-1':'sequence', 'input-2':'all', 'input-3':'all'}, '参考视频 sequence、产品/模特一律 all');
    eq(plan.inputGroups, [{group:1, rowMode:'per-row'}, {group:2, rowMode:'every-row'}, {group:3, rowMode:'every-row'}],
        '物化回执：只有视频通道逐行');
}

/* ─────────────── 4. 真实跑一次分段出表 ─────────────── */
console.log('[2] 分段出表：行数 = 段数、每行片段、看图描述');
(async () => {
    const created = await (async () => {
        const before = liveNodes.length;
        const done = await seg.run(FIX.llm, FIX.requirement, tableApi.llmMediaGroups(FIX.llm));
        ok(done === true, 'runSegmentStoryboard 返回 true（已按参考视频出表）');
        eq(liveNodes.length, before + 1, '画布上多了一张表格节点');
        return liveNodes[liveNodes.length - 1];
    })();
    eq(SEGMENTS.length, 5, '14.613 秒 / 每段 3 秒 = 5 段（与后端 plan_video_segments 一致）');
    eq(created.table.columns, ['时间段(秒)', '时长(秒)', '画面描述', '运镜', '参考用法'], '列结构固定');
    eq(created.table.rows.length, SEGMENTS.length, '行数 = 段数');
    eq(created.table.rows.map(row => row[0]), ['0–3s', '3–6s', '6–9s', '9–12s', '12–14.61s'], '每行时间段是这一段自己的');
    eq(created.table.rows.map(row => row[2]), SEGMENTS.map(item => '第' + item.index + '段画面'), '画面描述由多模态模型看图写');
    eq(created.table.rows.map(row => row[3]), SEGMENTS.map(() => '缓慢推近'), '运镜同样来自模型');
    ok(created.table.rows.every(row => row[4].indexOf('@视频1') >= 0), '每行参考用法都引用本行片段');
    has(created.table.rows[0][4], '替换为 @图片3、@图片4、@图片5 的产品', '产品序号逐个列出');
    has(created.table.rows[0][4], '人物与穿搭参考 @图片2（模特/穿搭）', '模特序号正确');

    console.log('[3] /api/video/segments 与 /api/canvas-llm 的真实请求');
    const segCall = posted.find(item => item.url === '/api/video/segments');
    ok(Boolean(segCall), '真的调了分段接口');
    eq(segCall.body, {url:VIDEO_URL, seconds:3, max_segments:M.VIDEO_SEGMENT_MAX_SEGMENTS}, '分段请求：参考视频 + 每段 3 秒 + 最大段数');
    eq(llmCalls.length, 1, '摘帧描述只发一次（5 段 ≤ 8 张）');
    eq(llmCalls[0].images, SEGMENTS.map(item => item.frame_url), '发给多模态模型的是每段首帧');
    eq(llmCalls[0].no_prompt_intelligence, true, '带图出表必须关掉 Prompt Intelligence');
    eq(llmCalls[0].target_type, 'video', '目标类型 = video');
    eq(llmCalls[0].videos, [], '带图出表不带视频素材');
    eq((llmCalls[0].message.match(/第 \d+ 段（/g) || []).length, 5, '提示词逐段给出时间段');
    ok(posted.filter(item => item.url === '/api/canvas-llm').every(item => item.signal), '带图出表请求挂了超时信号（180s 后中止）');
    has(canvasSrc, "noMedia:true, images, targetType:'video', noPromptIntelligence:true,", 'callCanvasLLMSegmentShots 的选项');
    has(canvasSrc, 'timeoutMs:SEGMENT_SHOTS_TIMEOUT_MS, maxTokens:options.maxTokens', '摘帧描述的 180s 超时走常量（测试可替换）');

    console.log('[4] 通道绑定：视频逐行、产品/模特每行都带');
    eq(created.tableInputChannelModes, {'input-1':'sequence', 'input-2':'all', 'input-3':'all'}, '三个通道的模式');
    eq(SEGMENTS.map((item, index) => created.tableManualInputItems['input-1'][String(index)][0].url), SEGMENTS.map(item => item.clip_url),
        '每行视频格 = 该段的 clip_url');
    eq(created.tableManualInputItems['input-1']['0'][0].mediaType, 'video', '手动项标成 video');
    eq(created.tableManualInputItems['input-1']['0'][0].name, '第1段', '手动项名字标成第N段');
    eq(created.tableManualInputItems['input-2'], undefined, '模特通道不写手动覆盖（整组每行都带）');
    eq(created.tableManualInputItems['input-3'], undefined, '产品通道不写手动覆盖（整组每行都带）');

    console.log('[5] 行提示词：@引用零悬空（真实 tableRowInputs）');
    const rows = tableApi.tableRowInputs(created);
    eq(rows.length, SEGMENTS.length, '逐行输入行数 = 段数');
    eq(rows.map(row => row.media[0].url), SEGMENTS.map(item => item.clip_url), '每行第一张参考 = 该行自己的片段');
    eq(rows.map(row => row.media[0].kind), SEGMENTS.map(() => 'video'), '片段按视频类型带出去');
    eq(rows[0].media.map(item => item.url), [SEGMENTS[0].clip_url, MEDIA.model.url].concat(MEDIA.products.map(item => item.url)),
        '第 1 行素材 = 本段片段 + 模特图 + 3 张产品图');
    eq(rows[4].media.map(item => item.url), [SEGMENTS[4].clip_url, MEDIA.model.url].concat(MEDIA.products.map(item => item.url)),
        '最后一行同样带齐（产品/模特通道 all）');
    eq(rows.map(row => row.danglingMentions.length), SEGMENTS.map(() => 0), '每行提示词没有悬空引用');
    has(rows[1].prompt, '@视频1', '第 2 行提示词引用的是本行片段');
    has(rows[1].prompt, '3–6s', '第 2 行写的是它自己的时间段');

    console.log('[6] 表格自动接到下游视频节点');
    ok(liveConnections.some(conn => conn.from === created.id && conn.to === FIX.videoTargetId), '表格 → 视频节点的连线已建立');
    eq(tableApi.generatorUpstreamTables(FIX.videoTargetId).map(node => node.id), [created.id], '视频节点的上游表格就是这张表（批量面板才有）');
    ok(seg.refreshes() > 0, '新建的表格 / 视频节点都被刷新过');

    // 重新点一次「生成」：新表接线，旧表要摘掉，否则批量执行按连线顺序取到的还是旧表
    const second = await seg.run(FIX.llm, FIX.requirement, tableApi.llmMediaGroups(FIX.llm));
    ok(second === true, '第二次出表同样成功');
    const newest = liveNodes[liveNodes.length - 1];
    eq(tableApi.generatorUpstreamTables(FIX.videoTargetId).map(node => node.id), [newest.id],
        '重新生成后视频节点的上游表格只有最新那张（旧表已摘线）');
    eq(liveConnections.filter(conn => conn.to === FIX.videoTargetId
        && (liveNodes.find(node => node.id === conn.from) || {}).type === 'table').length, 1,
        '视频节点只留一根上游表格连线（LLM 直连那根还在，不是表格）');

    console.log('[6b] 没有参考视频：静默走老链路，不报错也不切段');
    {
        const imageOnly = tableApi.llmMediaGroups(FIX.llm).filter(group => group.entries.every(entry => entry.kind === 'image'));
        const postsBefore = posted.length;
        const toastsBefore = seg.toasts().length;
        const done = await seg.run(FIX.llm, FIX.requirement, imageOnly);
        eq(done, false, '没有视频参考 → 返回 false（调用方走「LLM 直接出分镜表」）');
        eq(posted.length, postsBefore, '不会去调分段接口');
        eq(seg.toasts().length, toastsBefore, '不报错（这不是失败，是没这个需求）');
    }

    console.log('[7] 摘帧描述分批：每次最多 8 张，失败的批次走兜底');
    {
        const many = M.planVideoSegments(10, 1, 30).map((item, index) => ({...item,
            frame_url: '/assets/input/segments/canvas-test/many_' + (index + 1) + (index >= 8 ? '_fail' : '') + '.jpg'}));
        const callsBefore = llmCalls.length;
        const shots = await seg.shots(FIX.llm, FIX.requirement, many,
            many.map((item, index) => ({url:item.frame_url, name:'第' + item.index + '段'})), M);
        const batchCalls = llmCalls.slice(callsBefore);
        eq(batchCalls.map(body => body.images.length), [8, 2], '10 段切成 8 + 2 两批');
        eq(shots.map(shot => shot.index), [1, 2, 3, 4, 5, 6, 7, 8], '第二批失败只丢那两段，前面的描述保留');
        const table = seg.table(seg.plan(seg.sources(tableApi.llmMediaGroups(FIX.llm), FIX.requirement),
            M.classifySegmentInputs([], '')), many, shots, M);
        eq(table.rows[0][2], '第1段画面', '第 1 段用模型写的描述');
        eq(table.rows[9][2], seg.fallbackText, '失败的那一段用兜底文案：' + seg.fallbackText);
    }

    console.log('[7b] 条数不齐：只补缺失段（每批最多多 1 次请求）');
    {
        const pairs = SEGMENTS.map(item => ({url:item.frame_url, name:'第' + item.index + '段'}));
        const planOf = () => seg.plan(seg.sources(tableApi.llmMediaGroups(FIX.llm), FIX.requirement),
            M.classifySegmentInputs([], ''));

        // a) 第一次只回 3 段 → 补一次，且只带缺失的第 4、5 段首帧
        shotLimits = [3];
        let callsBefore = llmCalls.length;
        const shots = await seg.shots(FIX.llm, FIX.requirement, SEGMENTS, pairs, M);
        let calls = llmCalls.slice(callsBefore);
        eq(calls.length, 2, '第一批只回 3 段 → 补一次请求（共 2 次）');
        eq(calls[1].images, [SEGMENTS[3].frame_url, SEGMENTS[4].frame_url], '补齐请求只带缺失的第 4、5 段首帧');
        has(calls[1].message, '只写第 4、5 段', '补齐提示词写明只写哪几段');
        has(calls[1].message, '第 4 段（9–12s', '缺失段的时间段也写清楚');
        eq(shots.map(shot => shot.index), [1,2,3,4,5], '按 index 合并后 5 段齐全');
        const fullTable = seg.table(planOf(), SEGMENTS, shots, M);
        eq(fullTable.rows.map(row => row[2]), SEGMENTS.map(item => '第' + item.index + '段画面'), '5 行都是真实描述（不再有兜底）');

        // b) 补齐那次仍只回 1 段 → 第 5 行兜底，且不再发第三次
        shotLimits = [3, 1];
        callsBefore = llmCalls.length;
        const partial = await seg.shots(FIX.llm, FIX.requirement, SEGMENTS, pairs, M);
        calls = llmCalls.slice(callsBefore);
        eq(calls.length, 2, '每批最多多 1 次请求（不会为第 5 段再发第三次）');
        eq(partial.map(shot => shot.index), [1,2,3,4], '只补到第 4 段');
        eq(seg.table(planOf(), SEGMENTS, partial, M).rows[4][2], seg.fallbackText, '还缺的第 5 行用兜底文案');

        // c) 一次就齐 → 只发 1 次
        shotLimits = [];
        callsBefore = llmCalls.length;
        const complete = await seg.shots(FIX.llm, FIX.requirement, SEGMENTS, pairs, M);
        eq(llmCalls.length - callsBefore, 1, '第一次就齐 → 不补请求（不白花）');
        eq(complete.map(shot => shot.index), [1,2,3,4,5], '一次就拿到 5 段');
    }
    /* ─────────────── 8. 失败回退：分段接口不可用 → 老链路 ─────────────── */
    console.log('[8] 分段接口失败 → 中文提示 + 回退老链路，节点不卡 running');
    {
        segmentsMode = 'fail';
        const oldTable = {columns:['生成提示词'], rows:[['老链路出的分镜行']]};
        const listCalls = [];
        let materialized = null;
        const failSandbox = {console, setTimeout, clearTimeout, AbortController};
        failSandbox.__MODEL = M;
        failSandbox.__NODES = FIX.nodes;
        failSandbox.__CONNS = FIX.connections;
        failSandbox.__fetch = fakeFetch;
        failSandbox.__materialize = (node, table, groups, plan) => { materialized = {table, plan}; return {id:'tbl_old', type:'table', llmSourceId:node.id}; };
        vm.createContext(failSandbox);
        vm.runInContext([
            'const window = {NovaTableModel: __MODEL};',
            'let nodes = __NODES;',
            'let connections = __CONNS;',
            'const toasts = [];',
            'const connectNodes = () => false;',
            'const materializeLlmTable = __materialize;',
            'const tableNodeApi = {materializeLlmTable: __materialize};',
            'function scheduleSave(){}',
            'function refreshNodes(){}',
            'function notifyCanvas(text){ toasts.push(String(text)); }',
            'function alert(){}',
            'function showErrorModal(){}',
            'function tr(key){ return key; }',
            'function novaTableModel(){ return __MODEL; }',
            'function llmInputText(node){ return node.userInput || ""; }',
            'function llmMediaGroups(node){ return __GROUPS; }',
            'function llmDownstreamTarget(){ return {target_type:"video", target_model:""}; }',
            'function cascadeTargetIdFromOptions(){ return ""; }',
            'async function fetch(input, init){ return __fetch(input, init); }',
            'async function callCanvasLLM(node, message, messages, options){',
            '    __listCalls.push({message, options: options || {}});',
            '    if((options || {}).images){',
            '        // 一次就把提示词里点名的段全写出来（条数不齐会触发补齐请求，那是另一条用例）',
            '        const indexes = [];',
            '        String(message || "").replace(/第 (\\d+) 段（/g, (all, digits) => { indexes.push(Number(digits)); return all; });',
            '        return JSON.stringify({shots: indexes.map(index => ({index, "画面描述":"x"}))});',
            '    }',
            '    return __OLD_TABLE_JSON;',
            '}',
        ].concat(segmentSnippets(false, true)).concat([
            'globalThis.__run = (node, requirement, groups) => runSegmentStoryboard(node, requirement, groups, tableNodeApi, __MODEL);',
            'globalThis.__list = (node, opts) => runLLMListMode(node, opts);',
            'globalThis.__state = {toasts: () => toasts, calls: () => __listCalls, materialized: () => __materialize.seen || null};',
        ]).join('\n'), failSandbox, {filename:'canvas-segment-fallback-sandbox.js'});
        failSandbox.__GROUPS = tableApi.llmMediaGroups(FIX.llm);
        failSandbox.__OLD_TABLE_JSON = JSON.stringify(Object.assign({kind:'table', version:1, inputGroups:[{group:1, rowMode:'per-row'}]},
            oldTable, {selectedRows:[], mergedGroups:[]}));
        failSandbox.__listCalls = listCalls;

        const node = {id:'llm_fallback', type:'llm', llmOutputMode:'list-video', userInput:FIX.requirement};
        await failSandbox.__list(node, {});
        const toasts = failSandbox.__state.toasts();
        ok(toasts.some(text => text.indexOf('参考视频分段失败') >= 0), '分段失败有中文提示');
        ok(toasts.some(text => text.indexOf('找不到视频文件') >= 0), '提示里带着后端给的原因');
        ok(toasts.some(text => text.indexOf('已改用直接出分镜表') >= 0), '提示里说清走了老链路');
        ok(materialized && materialized.table.columns.indexOf('生成提示词') >= 0, '物化的是老链路的表（LLM 直接出分镜表）');
        ok(listCalls.some(item => item.message && item.message.indexOf('表格') >= 0), '老链路真的又问了模型一次');
        eq(node.running, false, '节点不会卡在 running');
        eq(node.runStatus, 'done', '老链路成功后节点状态是 done');

        // 分段可用时：不分流到老链路
        segmentsMode = 'ok';
        const node2 = {id:'llm_segmented', type:'llm', llmOutputMode:'list-video', userInput:FIX.requirement};
        const listCallsBefore = listCalls.length;
        await failSandbox.__list(node2, {});
        eq(listCalls.length, listCallsBefore + 1, '视频分镜表只发摘帧描述那一次模型请求（不再走规划+生成）');
        ok(materialized && materialized.table.columns[0] === '时间段(秒)', '物化的是分段表');
        eq(materialized.table.rows.length, SEGMENTS.length, '分段表行数 = 段数');
        eq(node2.running, false, '分段成功后节点也不卡 running');
    }

    console.log('[9] 「每段秒数」下拉只在视频分镜表出现');
    {
        has(canvasSrc, '${llmSegmentSecondsHtml(node)}', 'LLM 节点渲染里挂上了下拉');
        has(canvasSrc, "container.querySelector('.llm-segment-seconds')", '下拉有事件绑定');
        has(canvasSrc, 'node.segmentSeconds = segmentSecondsOf({segmentSeconds: e.target.value});', '选择结果存进 node.segmentSeconds');
        has(canvasSrc, "const segmented = targetKind === 'video'", '只有视频分镜表才走分段链路');
        has(canvasSrc, 'await runSegmentStoryboard(node, requirement, groups, tableNodeApi, model)', '分段链路接在经典画布出表流程里');
        has(canvasSrc, 'requestVideoSegments(classification.video.url, seconds, model.VIDEO_SEGMENT_MAX_SEGMENTS)', '分段请求用节点上的每段秒数');
        has(modelSrc, 'const VIDEO_SEGMENT_MAX_SEGMENTS = 30;', '最大段数来自共享模型');
        eq([1, 2, 3, 4, 5].map(n => seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:n}).indexOf('>' + n + ' ') >= 0),
            [true, true, true, true, true], '1-5 秒都能选');
        eq(seg.secondsHtml({llmOutputMode:'list-video'}), seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:3}), '没设置过 = 默认 3');
        eq(seg.secondsHtml({llmOutputMode:'list'}), '', '多维表格：不渲染秒数下拉');
        eq(seg.secondsHtml({llmOutputMode:'text'}), '', '文本输出：不渲染秒数下拉');
        eq(seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:9}), seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:5}), '越界值夹回 1-5');
        eq(seg.seconds({}), 3, 'segmentSecondsOf 默认 3');
        eq(seg.seconds({segmentSeconds:0.2}), 1, '下限 1');
        eq(seg.seconds({segmentSeconds:9}), 5, '上限 5');
    }

    console.log('');
    console.log('经典画布视频分镜表：' + pass + ' 项通过');
    if(fails.length){
        fails.forEach(msg => console.error('  ✗ ' + msg));
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
})().catch(error => {
    console.error('行为用例异常：' + (error && error.stack || error));
    process.exit(1);
});
