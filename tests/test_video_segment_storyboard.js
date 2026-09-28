#!/usr/bin/env node
// 视频分镜表：参考视频按「每段秒数」自动分解成多行（一行 = 原片里的一段）。
//
// 覆盖：
//   1. shared/table-model.js 的纯函数（分段规划 / 素材分角色 / 参考用法 / 摘帧描述解析）
//   2. 验收场景：LLM 节点只连了「参考视频 + 模特图」，产品图只在指令里 @ 到（没连线）
//   3. 物化结果：行数 = 段数、每行视频格 = 该段 clip_url、产品通道 mode='all'、行提示词 @引用不悬空
//   4. 逐行视频生成真的吃到本行片段（runApiVideoGeneration 的 videos 载荷 + 手动链接兜底）
//
// 跑法：node tests/test_video_segment_storyboard.js（cwd 必须是仓库根）
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

const smartSrc = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const modelSrc = fs.readFileSync(path.join(__dirname, '../static/js/shared/table-model.js'), 'utf8');

// 从源码里原样抠出待测函数，避免在测试里复制一份逻辑导致「测的不是真代码」。
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
// 单行声明（const / 一行写完的 function）按整行抠
function extractLine(src, name){
    const hit = new RegExp('^(?:const |function )' + name + '[ (=].*$', 'm').exec(src);
    if(!hit) throw new Error('未找到声明 ' + name);
    return hit[0];
}

/* ─────────────── 1. 分段规划（纯函数） ─────────────── */
console.log('[1] planVideoSegments 分段边界');
{
    const four = M.planVideoSegments(12, 3, 30);
    eq(four.length, 4, '整除：12 秒 / 3 秒 = 4 段');
    eq(four.map(s => [s.start, s.end, s.duration]), [[0,3,3],[3,6,3],[6,9,3],[9,12,3]], '整除：区间与时长');

    const merged = M.planVideoSegments(6.5, 3, 30);
    eq(merged.length, 2, '余数 <1s：并进上一段（少一段）');
    eq([merged[1].start, merged[1].end, merged[1].duration], [3, 6.5, 3.5], '余数 <1s：末段拉到片尾');

    const tail = M.planVideoSegments(10, 3, 30);
    eq(tail.length, 4, '余数 ≥1s：单独成段');
    eq([tail[3].start, tail[3].end, tail[3].duration], [9, 10, 1], '余数 ≥1s：末段 1 秒');

    const short = M.planVideoSegments(2, 3, 30);
    eq(short.length, 1, '总长 < 每段秒数：只有一段');
    eq([short[0].start, short[0].end], [0, 2], '总长 < 每段秒数：覆盖整条视频');

    const capped = M.planVideoSegments(30, 3, 4);
    eq(capped.length, 4, 'maxSegments 截断：只保留前 4 段');
    eq([capped[0].start, capped[3].end], [0, 12], 'maxSegments 截断：留的是最前面那几段');

    eq(M.planVideoSegments(0, 3, 30), [], '时长非法 → 空规划');
    eq(M.planVideoSegments(NaN, 3, 30), [], '时长 NaN → 空规划');
    eq(M.planVideoSegments(10, 99, 30).length, 2, '每段秒数上限 5（10 秒 → 2 段）');
    eq(M.planVideoSegments(10, 0.2, 30).length, 10, '每段秒数下限 1（10 秒 → 10 段）');
    eq(M.segmentCountOf(12, 3), 4, 'segmentCountOf 与规划一致');
    eq(M.segmentCountOf(14.61, 3), 5, '验收用例：14.61 秒 / 3 秒 = 5 段');
    eq(M.formatSeconds(3), '3', '秒数文案：整数不带小数');
    eq(M.formatSeconds(2.61), '2.61', '秒数文案：小数保留');
}

/* ─────────────── 2. 素材分角色 ─────────────── */
console.log('[2] classifySegmentInputs 角色判定');
{
    const videoA = {kind:'video', url:'a.mp4', label:'Video'};
    const videoB = {kind:'video', url:'b.mp4', label:'Video2'};
    eq(M.classifySegmentInputs([videoA, videoB]).video, videoA, '多个视频：第一个当参考分镜来源');
    eq(M.classifySegmentInputs([videoA, videoB]).others, [videoB], '多个视频：其余进 others');

    eq(M.classifySegmentInputs([{kind:'image', url:'p.jpg', label:'产品白底图'}]).product.length, 1, '节点名命中「产品」→ 产品');
    eq(M.classifySegmentInputs([{kind:'image', url:'p.jpg', label:'鞋子细节图'}]).product.length, 1, '节点名命中「鞋」→ 产品');
    eq(M.classifySegmentInputs([{kind:'image', url:'m.jpg', label:'模特上身图'}]).modelOutfit.length, 1, '节点名命中「模特」→ 模特/穿搭');
    eq(M.classifySegmentInputs([{kind:'image', url:'m.jpg', label:'outfit_look'}]).modelOutfit.length, 1, '文件名命中 outfit → 模特/穿搭');
    eq(M.classifySegmentInputs([{kind:'audio', url:'a.mp3'}]).others.length, 1, '非图片 → others');

    const fallback = M.classifySegmentInputs([{kind:'image', url:'1.jpg', name:'a.jpg'}, {kind:'image', url:'2.jpg', name:'b.jpg'}, {kind:'image', url:'3.jpg', name:'c.jpg'}]);
    eq(fallback.product.map(e => e.url), ['1.jpg'], '兜底：第一个未分类图片 → 产品');
    eq(fallback.modelOutfit.map(e => e.url), ['2.jpg', '3.jpg'], '兜底：其余 → 模特/穿搭');

    const ctx = '参考AREZZO.mp4 视频进行分镜生成，人物替换成lovart_1 ，鞋子替换成DSC1.jpg DSC2.jpg ，去掉logo，';
    const byContext = M.classifySegmentInputs([
        {kind:'image', url:'l.png', name:'lovart_1'},
        {kind:'image', url:'1.jpg', name:'DSC1.jpg'},
        {kind:'image', url:'2.jpg', name:'DSC2.jpg'},
    ], ctx);
    eq(byContext.modelOutfit.map(e => e.name), ['lovart_1'], '语境：名字前面最近的是「人物」→ 模特/穿搭');
    eq(byContext.product.map(e => e.name), ['DSC1.jpg', 'DSC2.jpg'], '语境：鞋子后面那一串 → 产品');
}

/* ─────────────── 3. 参考用法文案 ─────────────── */
console.log('[3] segmentReferenceLine 三种组合');
{
    const withProduct = M.segmentReferenceLine({videoOrdinal:1, productOrdinals:[3,4], modelOutfitOrdinals:[2], start:0, end:3});
    has(withProduct, '@视频1 是本行的参考分镜片段（原片 0–3s）', '有产品：视频序号与时间段');
    has(withProduct, '把画面中的原产品替换为 @图片3、@图片4 的产品', '有产品：多个产品逐个列出');
    has(withProduct, '人物与穿搭参考 @图片2（模特/穿搭）', '有模特/穿搭：序号与说明');
    has(withProduct, '保持原片的人物动作与环境不变', '有模特/穿搭：保持人物动作');

    const productOnly = M.segmentReferenceLine({videoOrdinal:2, productOrdinals:[5], modelOutfitOrdinals:[], start:9, end:12});
    has(productOnly, '@视频2', '只有产品：视频序号');
    has(productOnly, '替换为 @图片5 的产品', '只有产品：产品序号');
    ok(productOnly.indexOf('人物与穿搭参考') < 0, '只有产品：不出现人物穿搭那句');

    const bare = M.segmentReferenceLine({videoOrdinal:3, productOrdinals:[], modelOutfitOrdinals:[], start:12, end:14.61});
    has(bare, '@视频3 是本行的参考分镜片段（原片 12–14.61s）', '都没有：视频序号与时间段');
    has(bare, '其余保持不变。', '都没有：不加替换说明');
    ok(!/@图片\d/.test(bare), '都没有：文案里不出现图片引用');
}

/* ─────────────── 4. 摘帧描述提示词 / 解析 / 指令 @ 解析 ─────────────── */
console.log('[4] 摘帧描述与指令 @ 解析');
{
    const segments = M.planVideoSegments(14.61, 3, 30);
    const prompt = M.buildSegmentShotPrompt('把鞋子换成新品', [{name:'seg_01.jpg'}, {name:'seg_02.jpg'}], segments.slice(0, 2));
    has(prompt, '下面 2 张图依次是第 1–2 段', '提示词写清第 1..N 段');
    has(prompt, '每段 3 秒', '提示词写清每段秒数');
    has(prompt, '只写图里真实能看到的内容', '提示词禁止编造');
    has(prompt, '{"shots":[{"index":1', '提示词给出 JSON 结构');
    has(prompt, '第 2 段（3–6s，共 3 秒）', '每段都标了时间段');

    eq(M.parseSegmentShots('\u0060\u0060\u0060json\n{"shots":[{"index":2,"画面描述":"b","运镜":"跟拍","景别":"中景"},{"index":1,"画面描述":"a"}]}\n\u0060\u0060\u0060')
        .map(s => s.index), [1, 2], 'shots 按 index 排序');
    eq(M.parseSegmentShots('不是 JSON'), [], '解析失败返回空数组（不抛错）');
    eq(M.parseSegmentShots('{"shots":[]}'), [], '空 shots 返回空数组');

    const html = '<span class="mention-image-token" contenteditable="false" data-url="/assets/input/a.mp4" data-kind="video" data-name="@A.mp4" data-node-id="n1" data-image-index="0"><img src="x"><span>@A.mp4</span></span> 人物替换成<span class="mention-image-token" contenteditable="false" data-url="/assets/input/m.png" data-kind="image" data-name="m.png" data-node-id="n2" data-image-index="0"><span>m.png</span></span>';
    const parsed = M.parseInstructionMentions(html);
    eq(parsed.mentions.map(m => [m.url, m.kind, m.name, m.nodeId]), [
        ['/assets/input/a.mp4', 'video', '@A.mp4', 'n1'],
        ['/assets/input/m.png', 'image', 'm.png', 'n2'],
    ], 'chip 的 data-* 全部抠出来');
    eq(parsed.plain, '@A.mp4 人物替换成m.png', 'plain 用名字替换 chip（名字只出现一次）');
}

/* ─────────────── 5. 验收场景：参考视频 + 模特图连线，产品图只在指令里 @ ─────────────── */
const ACCEPT_CANVAS = path.join(__dirname, '../data/canvases/efec82d6c5cc49aaa5b2fcf49ba3affe.json');
const CHIP = item => '<span class="mention-image-token" contenteditable="false" data-url="' + item.url + '" data-kind="' + item.kind
    + '" data-name="' + item.name + '" data-node-id="' + item.nodeId + '" data-image-index="' + (item.imageIndex || 0)
    + '"><img src="/api/media-preview?w=256&amp;url=x" data-url="' + item.url + '"><span>' + item.name + '</span></span>';

const VIDEO_URL = '/assets/input/ai_ref_a36ca049dbcd.mp4';
const MODEL_URL = '/assets/library/%E8%A7%92%E8%89%B2/lib_af848b64c64d_lovart_cb9c39846a.png';
const PRODUCTS = [
    {name:'DSC07792.jpg', url:'/assets/input/ai_ref_b03b2ef230a4.jpg'},
    {name:'DSC07811.jpg', url:'/assets/input/ai_ref_481b9d5219e5.jpg'},
    {name:'DSC07824.jpg', url:'/assets/input/ai_ref_4be16a8fd387.jpg'},
    {name:'DSC07840.jpg', url:'/assets/input/ai_ref_f30a582865e2.jpg'},
];
const VIDEO_NODE_ID = 'n_28092315c18f38_1790069053265';
const MODEL_NODE_ID = 'n_608be765a51ac_1790069211728';
const GROUP_NODE_ID = 'n_49855816745fc8_1790069312304';
const kindForUrl = url => /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(String(url || '')) ? 'video'
    : (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(url || '')) ? 'audio' : 'image');

function acceptanceFixture(){
    const html = '参考' + CHIP({url:VIDEO_URL, kind:'video', name:'@AREZZO.mp4', nodeId:VIDEO_NODE_ID})
        + ' 视频进行分镜生成，每个运行都是一样的，人物替换成' + CHIP({url:MODEL_URL, kind:'image', name:'lovart_cb9c39846a', nodeId:MODEL_NODE_ID})
        + '  ，鞋子替换成' + PRODUCTS.map(item => CHIP({url:item.url, kind:'image', name:item.name, nodeId:GROUP_NODE_ID})).join(' ')
        + '  ，保留鞋子的细节跟材质，去掉logo，';
    return {
        llm: {id:'n_llm', type:'smart-prompt', llmOutputMode:'list-video', llmInstructionHtml:html,
            text:'参考@@AREZZO.mp4 视频进行分镜生成，每个运行都是一样的，人物替换成@lovart_cb9c39846a  ，鞋子替换成@DSC07792.jpg @DSC07811.jpg @DSC07824.jpg @  ，保留鞋子的细节跟材质，去掉logo，'},
        // llmMediaGroups 的形状：只有「参考视频」和「模特图」连了线，产品图没连
        groups: [
            {sourceId:VIDEO_NODE_ID, entries:[{kind:'video', nodeId:VIDEO_NODE_ID, label:'Video', url:VIDEO_URL}]},
            {sourceId:MODEL_NODE_ID, entries:[{kind:'image', nodeId:MODEL_NODE_ID, label:'', url:MODEL_URL}]},
        ],
        nodes: [
            {id:VIDEO_NODE_ID, type:'smart-image', title:'Video', images:[{url:VIDEO_URL, name:'@AREZZO.mp4', kind:'video'}]},
            {id:MODEL_NODE_ID, type:'smart-image', title:'Image', images:[{url:MODEL_URL, name:'lovart_cb9c39846a', kind:'image'}]},
            {id:GROUP_NODE_ID, type:'smart-image', title:'Group', images:PRODUCTS.map(item => ({url:item.url, name:item.name, kind:'image'}))},
        ],
    };
}

/* ─────────────── 5/6/7. 验收场景 + 物化 + 行提示词（都跑 smart-canvas.js 里抠出来的真实函数） ─────────────── */
const FIX = acceptanceFixture();
const sandbox = Object.assign({console, __MODEL:M, __NODES:FIX.nodes}, {});
vm.createContext(sandbox);
vm.runInContext([
    'const window = {NovaTableModel: __MODEL};',
    'let nodes = __NODES;',
    'let saveCount = 0;',
    'function scheduleSave(){ saveCount += 1; }',
    'function tr(key){ return key; }',
    'function escapeAttr(value){ return String(value); }',
    'function escapeHtml(value){ return String(value); }',
    extractLine(smartSrc, 'SEGMENT_STORYBOARD_COLUMNS'),
    extractLine(smartSrc, 'SEGMENT_SHOT_FALLBACK'),
    extractLine(smartSrc, 'LLM_SEGMENT_SECONDS_OPTIONS'),
    extractFn(smartSrc, 'segmentEntryKey'),
    extractFn(smartSrc, 'segmentMediaUrlFor'),
    extractFn(smartSrc, 'segmentMediaNameFor'),
    extractFn(smartSrc, 'segmentStoryboardSources'),
    extractFn(smartSrc, 'segmentStoryboardPlan'),
    extractFn(smartSrc, 'segmentStoryboardTable'),
    extractFn(smartSrc, 'setSegmentManualInputList'),
    extractFn(smartSrc, 'segmentExtraRowItems'),
    extractFn(smartSrc, 'applySegmentStoryboardChannels'),
    extractFn(smartSrc, 'smartLlmOutputModeValue'),
    extractFn(smartSrc, 'segmentSecondsOf'),
    extractFn(smartSrc, 'llmSegmentSecondsHtml'),
    'globalThis.__seg = {',
    '    sources: segmentStoryboardSources, plan: segmentStoryboardPlan, table: segmentStoryboardTable,',
    '    apply: applySegmentStoryboardChannels, secondsHtml: llmSegmentSecondsHtml, seconds: segmentSecondsOf,',
    '    saves: () => saveCount, fallback: SEGMENT_SHOT_FALLBACK, setNodes: list => { nodes = list; },',
    '};',
].join('\n'), sandbox, {filename:'segment-storyboard-sandbox.js'});
const seg = sandbox.__seg;

console.log('[5] 验收场景：分类必须落成 视频 / 模特 / 产品（只有视频和模特图连线，产品图只在指令里 @）');
{
    const fixtureSources = seg.sources(FIX.llm, FIX.groups);
    const fixtureCls = M.classifySegmentInputs(fixtureSources.connected.concat(fixtureSources.extra), fixtureSources.instructionText);
    eq(fixtureCls.video && fixtureCls.video.url, VIDEO_URL, '参考视频 = 连线的那条视频');
    eq(fixtureCls.modelOutfit.map(e => e.name), ['lovart_cb9c39846a'], '模特/穿搭 = lovart_cb9c39846a（连线项按文件名补名后按语境分类）');
    eq(fixtureCls.product.map(e => e.name), PRODUCTS.map(p => p.name), '产品 = 指令里 @ 到的 4 张 DSC 图');
    eq(fixtureSources.extra.map(e => e.name), PRODUCTS.map(p => p.name), '没连线的 @ 素材 = 4 张产品图（模特图与连线重复，已去重）');

    if(fs.existsSync(ACCEPT_CANVAS)){
        const canvas = JSON.parse(fs.readFileSync(ACCEPT_CANVAS, 'utf8'));
        const llm = (canvas.nodes || []).find(n => n.id === 'n_f6dd5c5482013_1790069599319');
        ok(Boolean(llm), '真实画布里找到那个 LLM 节点');
        if(llm){
            const byId = new Map((canvas.nodes || []).map(n => [n.id, n]));
            // 照 llmMediaGroups 的规则，从画布连线推出素材组
            const linkedIds = (canvas.connections || []).filter(conn => conn.to === llm.id).map(conn => conn.from);
            // 真机画布是运行时数据（git-ignored），后来又接上了一个「产品组」节点，所以连线是 3 条
            eq(linkedIds, [VIDEO_NODE_ID, MODEL_NODE_ID, GROUP_NODE_ID], '真实画布：LLM 节点连了参考视频 + 模特图 + 产品组');
            const realGroups = linkedIds.map(id => {
                const source = byId.get(id) || {};
                return {sourceId:id, entries:(source.images || []).map(img => ({kind:kindForUrl(img.url), nodeId:id, label:source.name || '', url:img.url}))};
            });
            seg.setNodes(canvas.nodes || []);
            const realSources = seg.sources(llm, realGroups);
            const realCls = M.classifySegmentInputs(realSources.connected.concat(realSources.extra), realSources.instructionText);
            eq(realCls.video && realCls.video.url, VIDEO_URL, '真实画布：参考视频 = ai_ref_a36ca049dbcd.mp4');
            eq(realCls.modelOutfit.map(e => e.name), ['lovart_cb9c39846a'], '真实画布：模特/穿搭 = lovart');
            eq(realCls.product.map(e => e.name), PRODUCTS.map(p => p.name), '真实画布：产品 = 4 张 DSC 图');
            eq(realSources.extra.length, 0, '真实画布：产品图已由产品组连线接入，不再有「只在指令里 @」的额外素材');
            seg.setNodes(FIX.nodes);
        }
    } else {
        console.log('  （跳过真实画布：' + ACCEPT_CANVAS + ' 不存在，它是运行时数据）');
    }
}

console.log('[6] 物化：行数 = 段数、每行片段、通道模式');
const segments = M.planVideoSegments(14.61, 3, 30).map((item, index) => Object.assign({}, item, {
    clip_url: '/assets/input/segments/abc/seg_0' + (index + 1) + '.mp4',
    frame_url: '/assets/input/segments/abc/seg_0' + (index + 1) + '.jpg',
}));
const sources = seg.sources(FIX.llm, FIX.groups);
{
    const cls = M.classifySegmentInputs(sources.connected.concat(sources.extra), sources.instructionText);
    const plan = seg.plan(sources, cls);
    eq(sources.groups.map(group => group.channelId), ['input-1', 'input-2'], '两个连线来源 = 两个通道');
    eq(sources.extra.map(entry => entry.name), PRODUCTS.map(p => p.name), '仅 @ 提及的产品图进额外通道');
    eq(plan.videoChannelId, 'input-1', '参考视频通道 = input-1');
    eq(plan.videoOrdinal, 1, '参考视频的全局序号 = 1（该通道第一项）');
    eq(plan.modelOutfit.map(e => e.ordinal), [2], '模特图全局序号 = 2');
    eq(plan.product.map(e => e.ordinal), [3, 4, 5, 6], '产品图全局序号 = 3..6（额外通道 ordinalBase + 位置）');
    eq(plan.modes, {'input-1':'sequence', 'input-2':'all', 'input-3':'all'}, '参考视频 sequence、其余 all');
    eq(plan.channelCount, 3, '通道数 = 2 连线 + 1 额外');

    const table = seg.table(plan, segments, [], M);
    eq(table.columns, ['时间段(秒)','时长(秒)','画面描述','运镜','参考用法'], '列结构固定');
    eq(table.rows.length, segments.length, '行数 = 段数');
    eq(table.rows[0].slice(0, 2), ['0–3s', '3'], '第 1 行：时间段与时长');
    eq(table.rows[4].slice(0, 2), ['12–14.61s', '2.61'], '最后一行：时间段与时长（末段 2.61 秒）');
    eq(table.rows.map(row => row[2]), segments.map(() => seg.fallback), '摘帧描述缺失 → 兜底文案');
    const withShot = seg.table(plan, segments, [{'index':2, '画面描述':'模特侧身走位', '运镜':'跟拍'}], M);
    eq(withShot.rows[0][2], seg.fallback, '只有第 2 段有描述：第 1 段仍是兜底');
    eq(withShot.rows[1].slice(2, 4), ['模特侧身走位', '跟拍'], '第 2 段用模型写的描述与运镜');
    ok(table.rows.every(row => row[4].indexOf('@视频1') >= 0), '每行参考用法都引用本行片段');

    const created = {id:'tbl1', type:'table', table, llmGeneratedOutput:true,
        tableInputChannelCount:2, tableInputChannelModes:{'input-1':'sequence', 'input-2':'all'}};
    const savesBefore = seg.saves();
    seg.apply(created, plan, segments, M);
    ok(seg.saves() > savesBefore, '写完手动素材要落盘（scheduleSave）');
    eq(created.tableInputChannelCount, 3, '额外通道显式多开一列');
    eq(created.tableInputChannelModes['input-3'], 'all', '额外通道 mode = all');
    eq(segments.map((item, index) => created.tableManualInputItems['input-1'][String(index)][0].url), segments.map(s => s.clip_url),
        '每行视频格 = 该段的 clip_url');
    eq(created.tableManualInputItems['input-1']['0'][0].mediaType, 'video', '手动项类型标成 video');
    eq(created.tableManualInputItems['input-1']['0'][0].name, '第1段', '手动项名字标成第N段');
    eq(created.tableManualInputItems['input-3']['0'].map(item => item.url), PRODUCTS.map(p => p.url),
        '额外通道每行都带同一组产品图');
    eq(created.tableManualInputItems['input-2'], undefined, '连线的模特通道绝不写手动覆盖');

    console.log('[7] 行提示词：@引用不悬空（跑 shared/table-node.js 的真实 tableRowInputs）');
    global.NovaTableModel = M;
    require('../static/js/shared/table-node.js');
    const liveNodes = FIX.nodes.concat([FIX.llm, created]);
    const connections = [
        {id:'c1', from:VIDEO_NODE_ID, to:'tbl1', toPort:'input-1'},
        {id:'c2', from:MODEL_NODE_ID, to:'tbl1', toPort:'input-2'},
        {id:'c3', from:'n_llm', to:'tbl1'},
    ];
    const api = global.NovaTableNode({
        tr: key => key, uid: prefix => prefix + '_1', nodes: liveNodes, connections,
        nodesEl: {querySelector: () => null},
        selected: {has:() => false, add(){}, delete(){}, forEach(){}, get size(){ return 0; }},
        addNode(node){ liveNodes.push(node); return node; },
        render(){}, renderNode(){}, refreshIcons(){}, nowMs: () => Date.now(),
        scheduleSave(){}, saveCanvas: async () => {}, pushUndo(){}, defaultPoint: (x, y) => ({x:x || 0, y:y || 0}),
        connectNodes(){ return true; },
        mediaKindForNode: node => (node && node.mediaKind) || kindForUrl(node && node.url),
        mediaKindForRef: ref => (ref && ref.kind) || kindForUrl(ref && ref.url),
        mediaKindForUpload: file => kindForUrl(file && file.name),
        outputUrlValue: item => (typeof item === 'string' ? item : (item && item.url) || ''),
        isMissingAssetUrl: () => false,
        canvasPreviewImgHtml: () => '', canvasVideoPreviewHtml: () => '',
        responseErrorMessage: async () => '', showErrorModal(){}, runGenerator(){}, runVideoNode(){},
        generationStopRequested: () => false, onBatchSettled(){},
    });
    const rows = api.tableRowInputs(created);
    eq(rows.length, segments.length, '逐行输入的行数 = 段数');
    eq(rows.map(row => row.media[0].url), segments.map(s => s.clip_url), '每行第一张参考 = 该行自己的片段');
    eq(rows.map(row => row.media[0].kind), segments.map(() => 'video'), '片段按视频类型带出去（不会被当成图片）');
    eq(rows[0].media.map(item => item.url), [segments[0].clip_url, MODEL_URL].concat(PRODUCTS.map(p => p.url)),
        '第 1 行素材 = 本段片段 + 模特图 + 4 张产品图');
    eq(rows[4].media.map(item => item.url), [segments[4].clip_url, MODEL_URL].concat(PRODUCTS.map(p => p.url)),
        '最后一行同样带齐（产品/模特通道 all）');
    eq(rows.map(row => row.danglingMentions.length), segments.map(() => 0), '每行提示词没有悬空引用');
    has(rows[1].prompt, '@视频1', '行提示词里片段是 @视频1');
    has(rows[1].prompt, '人物与穿搭参考 @图片2（模特/穿搭）', '行提示词里模特是 @图片2');
    has(rows[1].prompt, '替换为 @图片3、@图片4、@图片5、@图片6 的产品', '行提示词里 4 张产品图逐个列出');
    has(rows[1].prompt, '3–6s', '第 2 行写的是它自己的时间段');
}

/* ─────────────── 8. 静态断言：秒数下拉只在 list-video 显示 ─────────────── */
console.log('[8] 「每段秒数」下拉');
{
    ok(/function llmSegmentSecondsHtml\(node\)\{[\s\S]{0,220}list-video/.test(smartSrc), '下拉只在输出形式 = list-video 时渲染');
    has(smartSrc, 'class="prompt-node-control prompt-llm-segment-seconds"', '下拉的类名');
    has(smartSrc, '\u0024{llmSegmentSecondsHtml(node)}', '节点渲染里挂上了下拉');
    has(smartSrc, "const segmentSecondsEl = el.querySelector('.prompt-llm-segment-seconds');", '下拉有事件绑定');
    has(smartSrc, 'node.segmentSeconds = segmentSecondsOf({segmentSeconds: e.target.value});', '选择结果存进 node.segmentSeconds');
    has(smartSrc, 'const seconds = segmentSecondsOf(node);', '出表按 node.segmentSeconds 取每段秒数');
    has(smartSrc, 'requestVideoSegments(classification.video.url, seconds, model.VIDEO_SEGMENT_MAX_SEGMENTS)', '分段请求带上每段秒数与最大段数');
    has(smartSrc, 'model.planVideoSegments(data.duration, seconds, model.VIDEO_SEGMENT_MAX_SEGMENTS)', '用前端规划核对后端分段结果');
    has(modelSrc, 'const VIDEO_SEGMENT_SECONDS_DEFAULT = 3;', '默认每段 3 秒');
    has(modelSrc, 'const VIDEO_SEGMENT_MAX_SEGMENTS = 30;', '默认最多 30 段');
    eq([1, 2, 3, 4, 5].map(n => seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:n}).indexOf('>' + n + ' ') >= 0),
        [true, true, true, true, true], '1–5 秒都能选');
    eq(seg.secondsHtml({llmOutputMode:'list'}), '', '多维表格：不渲染秒数下拉');
    eq(seg.secondsHtml({llmOutputMode:'text'}), '', '文本输出：不渲染秒数下拉');
    has(seg.secondsHtml({llmOutputMode:'list-video', segmentSeconds:9}), 'selected', '越界值会被夹回 1–5');
    eq(seg.seconds({}), 3, '没设置过 = 默认 3');
    eq(seg.seconds({segmentSeconds:0.2}), 1, '下限 1');
    eq(seg.seconds({segmentSeconds:9}), 5, '上限 5');
}

/* ─────────────── 9. 逐行视频生成吃到本行片段 ─────────────── */
console.log('[9] runApiVideoGeneration：本行片段不被手动链接 / kind 过滤吃掉');
{
    const videoSandbox = {console};
    vm.createContext(videoSandbox);
    vm.runInContext([
        'const window = {location:{origin:"http://localhost"}};',
        'const settings = {};',
        'let transientSmartCloudLinks = [];',
        'let payload = null;',
        'function tr(key){ return key; }',
        'function toast(){}',
        'function refSourceEntry(){ return null; }',
        'function applyUploadedUrlsToSmartRefs(refs){ return refs; }',
        'function videoProviderPlatform(){ return "comfly"; }',
        'function applySourceRatioToVideoAspect(){}',
        'function throwIfSmartGenerationStopped(){}',
        'function resultMediaUrls(result){ return (result && result.urls) || []; }',
        'function smartResponseErrorMessage(){ return "err"; }',
        'class JimengPendingSignal extends Error {}',
        'function manualSmartVideoLink(source){ return ((source || {}).videoTempShLinks || []).find(item => item && item.manual === true && item.url) || null; }',
        'function manualSmartMediaLinks(source){ return ((source || {}).videoTempShLinks || []).filter(item => item && item.manual === true && item.url); }',
        'async function fetch(url, options){ payload = {url, body: JSON.parse(options.body)}; return {ok:true, json: async () => ({urls:["out.mp4"]})}; }',
        // runApiVideoGeneration 夹时长用的是 VIDEO_DURATION_MIN/MAX/DEFAULT（跟时长滑条同源），沙箱要一起抠出来
        extractLine(smartSrc, 'VIDEO_DURATION_MIN'),
        extractLine(smartSrc, 'SMART_REFERENCE_IMAGE_MAX'),
        extractLine(smartSrc, 'smartOriginalMediaUrl'),
        extractFn(smartSrc, '_localSmartOriginalMediaUrl'),
        extractFn(smartSrc, 'isFileMediaItem'),
        extractFn(smartSrc, 'isTextMediaItem'),
        extractFn(smartSrc, 'isAudioMediaItem'),
        extractFn(smartSrc, 'isVideoMediaItem'),
        extractFn(smartSrc, 'mediaKindForItem'),
        extractFn(smartSrc, 'looksLikeImageMediaUrl'),
        extractFn(smartSrc, 'imageRefsOnly'),
        extractFn(smartSrc, 'videoRefsOnly'),
        extractFn(smartSrc, 'audioRefsOnly'),
        'async ' + extractFn(smartSrc, 'runApiVideoGeneration'),
        'globalThis.__video = {',
        '    run: (refs, runSettings) => runApiVideoGeneration("把原产品替换成新品", refs, runSettings, null),',
        '    payload: () => payload,',
        '    imageRefsOnly, videoRefsOnly, mediaKindForItem,',
        '};',
    ].join('\n'), videoSandbox, {filename:'video-refs-sandbox.js'});
    const V = videoSandbox.__video;
    const rowRefs = [
        {url:segments[0].clip_url, kind:'video', name:'第1段'},
        {url:MODEL_URL, kind:'image', name:'lovart'},
        {url:PRODUCTS[0].url, kind:'image', name:'DSC07792.jpg'},
    ];
    eq(V.videoRefsOnly(rowRefs).map(ref => ref.url), [segments[0].clip_url], 'videoRefsOnly 认得 kind=video 的片段');
    eq(V.imageRefsOnly(rowRefs).map(ref => ref.url), [MODEL_URL, PRODUCTS[0].url], 'imageRefsOnly 只拿图片，不动视频');
    eq(V.mediaKindForItem({url:segments[0].clip_url, kind:'video'}), 'video', '片段类型是 video');

    const manualRun = {videoModel:'veo3-fast', apiKind:'video',
        videoTempShLinks:[{url:'https://cdn.example.com/one-manual.mp4', manual:true}]};
    const videoUrls = () => V.payload().body.videos.map(item => (typeof item === 'string' ? item : item.url));

    (async () => {
        await V.run(rowRefs, Object.assign({}, manualRun, {rowRefsAuthoritative:true}));
        eq(V.payload().url, '/api/canvas-video', '逐行生成打的是视频接口');
        eq(videoUrls(), [segments[0].clip_url], '逐行批量：发给视频接口的是本行片段（手动链接不覆盖）');
        eq(V.payload().body.images.map(item => item.url), [MODEL_URL, PRODUCTS[0].url], '产品 / 模特图照常带上');

        await V.run(rowRefs, Object.assign({}, manualRun));
        eq(videoUrls(), ['https://cdn.example.com/one-manual.mp4'], '非逐行：手动视频链接仍按老行为生效');

        await V.run([{url:MODEL_URL, kind:'image'}], Object.assign({}, manualRun, {rowRefsAuthoritative:true}));
        eq(videoUrls(), ['https://cdn.example.com/one-manual.mp4'], '本行没有视频参考时，手动链接兜底');

        has(smartSrc, 'if(options.rowOverride && refs.length) runSettings = Object.assign({}, runSettings, {rowRefsAuthoritative: true});',
            'tableRunOneRow 按行跑时声明本行 refs 权威');
        has(smartSrc, 'runSettings.rowRefsAuthoritative && rowVideos.length ? rowVideos', 'refVideos 优先用本行片段');


        /* ── [10] 真实抓包响应：模型把裸换行写进 JSON 字符串值，现在也能解析出真实描述 ── */
        console.log('[10] 真实响应解析：裸控制字符 / 顶层数组 / 字符串 index');
        {
            const EVIDENCE_FILE = '/tmp/novai-e2e-verify/evidence/llm_raw_response_seconds5.txt';
            // 抓包文件是 HTTP 响应外层（.text 才是 callCanvasLLM 交给解析的那份）；读不到就用内容一致的内联副本
            let evidenceText = "{\"shots\":\n[{\"index\":1,\"画面描述\":\"极简纯白影棚内，卷发女子身穿黑色连帽外套坐在白色设计感椅子上，低头弯腰系着脚上的黑色运动鞋鞋带。侧向柔和光线勾勒出主体轮廓，呈现明暗交错的简约氛围。\",\"运镜\":\"固定机位\",\"\n景别\":\"全景\"},{\"index\":2,\"画面描述\":\"纯白背景下，女子身穿黑色连帽外套\n，胸前斜挎一只浅棕色皮革小包并用双手轻抚调整。柔和的棚拍光线聚焦于包袋的\n质感与手部细节。\",\"运镜\":\"固定机位\",\"景别\":\"近景\"},{\"index\":3,\"画面描述\":\"纯白地面上，镜头对准\n女子的双腿与脚上穿着的黑色运动鞋，呈站立姿态。明亮的棚拍光线均匀打在腿部与鞋面上\n，突出鞋身的细节与材质。\",\"运镜\":\"固定机位\",\"景别\":\"特写\"}]}";
            let fromFile = false;
            if(fs.existsSync(EVIDENCE_FILE)){
                try {
                    const envelope = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8'));
                    if(typeof envelope.text === 'string' && envelope.text){ evidenceText = envelope.text; fromFile = true; }
                } catch(error){ fromFile = false; }
            }
            console.log(fromFile ? '  （用真实抓包文件）' : '  （抓包文件不在，用内容一致的内联副本）');
            let strictFailed = false;
            try { JSON.parse(evidenceText); } catch(error){ strictFailed = true; }
            ok(strictFailed, '内层 text 严格 JSON.parse 仍失败（Bad control character，就是它把整表打成兜底文案的）');
            const evidenceObj = M.extractJsonObject(evidenceText);
            ok(Boolean(evidenceObj) && Array.isArray(evidenceObj.shots), 'extractJsonObject 现在能解析出 shots');
            const evidenceShots = M.parseSegmentShots(evidenceText);
            eq(evidenceShots.map(s => s.index), [1, 2, 3], '这份响应里模型只写了 3 段（completion 1816 tokens 中 1623 是思考）');
            eq(evidenceShots.map(s => s['画面描述'].length > 30), [true, true, true], '3 段的画面描述都是真实内容（不再是兜底文案）');
            has(evidenceShots[0]['画面描述'], '卷发女子身穿黑色连帽外套', '第 1 段：卷发女子…');
            has(evidenceShots[2]['画面描述'], '黑色运动鞋', '第 3 段：黑色运动鞋…');
            eq(evidenceShots.map(s => s['运镜']), ['固定机位', '固定机位', '固定机位'], '3 段的运镜都解析出来');
            eq(evidenceShots.map(s => s['景别']), ['全景', '近景', '特写'], '键名里被塞了裸换行（\"\\n景别\"）也照样取到景别');
            // 同样的毛病套在 5 段上：一段都不能少
            const fiveRaw = '{"shots":[' + [1,2,3,4,5].map(i =>
                '{"index":' + i + ',"画面描述":"第 ' + i + ' 段画面\\n带裸换行","运镜":"推近","景别":"中景"}').join(',') + ']}';
            eq(M.parseSegmentShots(fiveRaw).length, 5, '同样毛病套在 5 段上 → 5 段全部解析出来');
            has(M.parseSegmentShots(fiveRaw)[4]['画面描述'], '第 5 段画面', '第 5 段内容完整');
            // 合法 JSON 的行为必须一模一样
            eq(M.extractJsonObject('{"a":"已经转义\\n的换行"}'), {a:'已经转义\n的换行'}, '合法 JSON（\\n 转义）行为不变');
            eq(M.escapeJsonControlChars('{"a":"x\ny","b":\n1}'), '{"a":"x\\ny","b":\n1}', '字符串内的裸换行被转义、字符串外的原样保留');
            eq(M.extractJsonObject('{"a":1'), null, '坏 JSON 仍然返回 null');
            // 顶层数组 / 字符串 index（必修 2）
            eq(M.parseSegmentShots('[{"index":"2","画面描述":"b","运镜":"跟拍","景别":"全景"}]').map(s => s.index), [2], '顶层数组 + 字符串 index 都认');
            eq(M.parseSegmentShots('\u0060\u0060\u0060json\n[{"index":1,"画面描述":"a"}]\n\u0060\u0060\u0060').length, 1, '带代码块的顶层数组也认');
            eq(M.parseSegmentShots('{"shots":[{"index":"3","description":"c","camera":"推","shotSize":"近景"}]}')[0]['景别'], '近景', '英文字段名也认');
        }

        /* ── [11]/[12] 超时兜底 + 解析失败补一次修复（跑真实的 runSmartLLMListMode 全链路） ── */
        const flowSandbox = {console, AbortController, setTimeout, clearTimeout};
        vm.createContext(flowSandbox);
        const FLOW_SEGMENTS = {ok:true, duration:14.613, seconds:3, truncated:false, segments: segments.map(s => ({
            index:s.index, start:s.start, end:s.end, duration:s.duration, clip_url:s.clip_url, frame_url:s.frame_url}))};
        const FIVE_REPAIRED = JSON.stringify({shots: [1,2,3,4,5].map(i => ({
            index:i, '画面描述':'修好的第 ' + i + ' 段画面', '运镜':'缓推', '景别':'中景'}))});
        vm.runInContext([
            'const window = {NovaTableModel: __MODEL};',
            'let nodes = __NODES;',
            'let llmMode = "hang";',
            'let calls = [];',
            'let created = null;',
            'let toasts = [];',
            'let renders = 0;',
            'let saves = 0;',
            'let api = null;',
            'function render(){ renders += 1; }',
            'function scheduleSave(){ saves += 1; }',
            'function toast(text){ toasts.push(String(text)); }',
            'function syncTableConnections(){}',
            'function resolveChatProviderId(id){ return id || "comfly"; }',
            'function resolveChatModel(id){ return id || "test-model"; }',
            'function promptNodeInputMediaForLLM(){ return []; }',
            'function promptNodeLLMInputText(){ return "参考视频做分镜"; }',
            'function smartLLMTarget(){ return {target_type:"", target_model:""}; }',
            'function imageRefsOnly(refs){ return (refs || []).filter(ref => ref && ref.url); }',
            'function videoRefsOnly(refs){ return (refs || []).filter(ref => ref && ref.url); }',
            'function connectSmartBatchAfter(){ return null; }',
            'function ensureTableApi(){ return api; }',
            'function materializeLlmTableNode(node, table){ created = {id:"tbl_flow", type:"table", table, tableInputChannelCount:__GROUPS.length, tableInputChannelModes:{}}; return created; }',
            'let answers = [];',
            'async function fetch(url, options){',
            '    if(url === "/api/video/segments") return {ok:true, json: async () => __SEGMENTS};',
            '    calls.push(JSON.parse(options.body));',
            '    if(llmMode === "hang"){',
            '        return new Promise((resolve, reject) => {',
            '            if(options.signal) options.signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); });',
            '        });',
            '    }',
            '    if(answers.length) return {ok:true, json: async () => ({text: answers.shift()})};',
            '    throw new Error("测试没有预设更多回答");',
            '}',
            'function tr(key){ return key; }',
            'function trf(key){ return key; }',
            // callSmartCanvasLLM 的取消登记 / 默认 System / 文本出表入口都是模块级，沙箱要一起备齐
            'const smartLlmRunControllers = new Map();',
            extractFn(smartSrc, 'smartLlmDefaultSystemPrompt'),
            'async ' + extractFn(smartSrc, 'callSmartLLMText'),
            extractLine(smartSrc, 'SEGMENT_SHOTS_BATCH'),
            extractLine(smartSrc, 'LLM_SEGMENT_SECONDS_OPTIONS'),
            extractLine(smartSrc, 'SEGMENT_STORYBOARD_COLUMNS'),
            extractLine(smartSrc, 'SEGMENT_SHOT_FALLBACK'),
            // 只把超时常量改小（同一段代码路径），其余原样
            extractLine(smartSrc, 'SEGMENT_SHOTS_TIMEOUT_MS').replace('180000', '300'),
            extractFn(smartSrc, 'segmentSecondsOf'),
            extractFn(smartSrc, 'segmentEntryKey'),
            extractFn(smartSrc, 'segmentMediaUrlFor'),
            extractFn(smartSrc, 'segmentMediaNameFor'),
            extractFn(smartSrc, 'segmentStoryboardSources'),
            extractFn(smartSrc, 'segmentStoryboardPlan'),
            extractFn(smartSrc, 'segmentStoryboardTable'),
            extractFn(smartSrc, 'setSegmentManualInputList'),
            extractFn(smartSrc, 'segmentExtraRowItems'),
            extractFn(smartSrc, 'applySegmentStoryboardChannels'),
            'async ' + extractFn(smartSrc, 'requestVideoSegments'),
            'async ' + extractFn(smartSrc, 'callSmartCanvasLLM'),
            'async ' + extractFn(smartSrc, 'callSmartLLMSegmentShots'),
            'async ' + extractFn(smartSrc, 'segmentShotsFor'),
            'async ' + extractFn(smartSrc, 'runSegmentStoryboard'),
            'async ' + extractFn(smartSrc, 'runSmartLLMTableMode'),
            'async ' + extractFn(smartSrc, 'runSmartLLMListMode'),
            'api = {',
            '    llmMediaGroups: () => __GROUPS,',
            '    materializeLlmTable: (node, table) => { created = {id:"tbl_flow", type:"table", table, tableInputChannelCount:__GROUPS.length, tableInputChannelModes:{}}; return created; },',
            '};',
            'globalThis.__flow = {',
            '    run: node => runSmartLLMListMode(node),',
            '    callLLM: node => callSmartCanvasLLM(node, "hi", [], {noMedia:true, images:["/assets/x.jpg"], targetType:"video", noPromptIntelligence:true, timeoutMs:300}),',
            '    setMode: (mode, list) => { llmMode = mode; answers = (list || []).slice(); calls = []; toasts = []; created = null; },',
            '    state: () => ({created, calls, toasts, renders, saves}),',
            '};',
        ].join('\n'), Object.assign(flowSandbox, {__MODEL:M, __NODES:FIX.nodes, __GROUPS:FIX.groups, __SEGMENTS:FLOW_SEGMENTS, __REPAIR:FIVE_REPAIRED}), {filename:'flow-sandbox.js'});
        const F = flowSandbox.__flow;
        const flowNode = () => ({id:'n_llm_flow', type:'smart-prompt', llmOutputMode:'list-video', segmentSeconds:3, running:false, llmInstructionHtml:FIX.llm.llmInstructionHtml, text:FIX.llm.text});
        console.log('[11] 超时兜底：/api/canvas-llm 永远不返回，节点不能卡在 running');
        await (async () => {
            F.setMode('hang');
            const abortedNode = flowNode();
            let aborted = null;
            const abortStart = Date.now();
            try { await F.callLLM(abortedNode); } catch(error){ aborted = error; }
            const abortMs = Date.now() - abortStart;
            // 超时的 AbortError 已被 callSmartCanvasLLM 翻成人话（smart.promptLlmTimeout），沙箱里 trf 是 key 直通
            ok(Boolean(aborted) && aborted.message === 'smart.promptLlmTimeout', '超时以「超时」提示结束（fetch 真的被 abort，不是永远 pending）');
            ok(abortMs < 3000, 'AbortError 在超时点附近抛出（' + abortMs + 'ms）');
            const node = flowNode();
            F.setMode('hang');
            const flowStart = Date.now();
            await F.run(node);
            const flowMs = Date.now() - flowStart;
            const state = F.state();
            ok(flowMs < 5000, '整条出表流程在超时后很快结束（' + flowMs + 'ms），没有挂死');
            eq(node.running, false, '节点没卡在 running（finally 执行到了）');
            eq(state.calls.length, 1, '超时的这批只请求 1 次（异常直接兜底，不再补修复遍）');
            ok(Boolean(state.created), '超时也照样把表物化出来');
            eq(state.created.table.rows.length, 5, '仍然是 5 行（一段一行）');
            eq(state.created.table.rows.map(row => row[2]), segments.map(() => seg.fallback), '5 行画面描述用兜底文案，流程继续');
            eq(state.created.tableManualInputItems['input-1']['0'][0].url, segments[0].clip_url, '片段照旧绑到每一行');
        })();

        console.log('[12] 解析不出时补一次修复重试（每批最多多花 1 次请求）');
        const GARBAGE_TEXT = '好的，我按段写好了：\n第1段 白棚里…（这里没有 JSON）';
        await (async () => {
            F.setMode('ok', [GARBAGE_TEXT, FIVE_REPAIRED]);
            const node = flowNode();
            await F.run(node);
            const state = F.state();
            eq(state.calls.length, 2, '第一次解析不出 → 补一次修复，共 2 次请求');
            has(state.calls[1].message, '未通过校验', '第二次带的是现成的修复提示词');
            eq(state.calls[1].max_tokens, M.LLM_REPAIR_MAX_TOKENS, '修复遍用 LLM_REPAIR_MAX_TOKENS');
            eq(state.calls[1].images, [], '修复遍不带图（只是把已有文字修成 JSON）');
            eq(state.created.table.rows.map(row => row[2]), [1,2,3,4,5].map(i => '修好的第 ' + i + ' 段画面'), '修复后的 5 段真实描述全部落地');
            F.setMode('ok', [FIVE_REPAIRED]);
            const okNode = flowNode();
            await F.run(okNode);
            eq(F.state().calls.length, 1, '第一次就解析成功 → 不补请求');
            eq(F.state().created.table.rows.map(row => row[2]), [1,2,3,4,5].map(i => '修好的第 ' + i + ' 段画面'), '正常路径的描述原样落地');
        })();

        console.log('[13] 条数不齐：只对缺失段补一次请求，已拿到的段不重复请求');
        await (async () => {
            const three = JSON.stringify({shots: [1, 2, 3].map(i => ({index:i, '画面描述':'第一批第 ' + i + ' 段', '运镜':'推近', '景别':'中景'}))});
            const two = JSON.stringify({shots: [4, 5].map(i => ({index:i, '画面描述':'补齐的第 ' + i + ' 段', '运镜':'拉远', '景别':'全景'}))});
            // a) 第一批只回 3 段 → 补一次，只带缺失的第 4、5 段首帧
            F.setMode('ok', [three, two]);
            await F.run(flowNode());
            const a = F.state();
            eq(a.calls.length, 2, '第一批只回 3 段 → 补一次请求（共 2 次）');
            eq(a.calls[1].images, [segments[3].frame_url, segments[4].frame_url], '补齐请求只带缺失的第 4、5 段首帧');
            has(a.calls[1].message, '只写第 4、5 段', '补齐提示词明确写出只写哪几段');
            has(a.calls[1].message, '第 4 段（9–12s', '缺失段的时间段也写清楚');
            eq(a.created.table.rows.map(row => row[2]),
                ['第一批第 1 段', '第一批第 2 段', '第一批第 3 段', '补齐的第 4 段', '补齐的第 5 段'],
                '按 index 合并后 5 行都有真实描述（不再有兜底）');
            eq(a.created.table.rows.map(row => row[3]), ['推近','推近','推近','拉远','拉远'], '补齐段的运镜也并进来');
            ok(a.toasts.every(text => text.indexOf('分解为') >= 0), '流程不报错（只有成功提示）');

            // b) 补齐那次仍只回 1 段 → 第 5 行兜底，且不再发第三次
            const one = JSON.stringify({shots: [{index:4, '画面描述':'只补到第 4 段', '运镜':'推近', '景别':'中景'}]});
            F.setMode('ok', [three, one]);
            const bNode = flowNode();
            await F.run(bNode);
            const b = F.state();
            eq(b.calls.length, 2, '每批最多多 1 次请求（不会为第 5 段再发第三次）');
            eq(b.created.table.rows.map(row => row[2]),
                ['第一批第 1 段', '第一批第 2 段', '第一批第 3 段', '只补到第 4 段', seg.fallback],
                '还缺的第 5 行才用兜底文案');
            eq(bNode.running, false, '补齐后仍缺也不影响流程，节点不卡 running');
            ok(b.toasts.every(text => text.indexOf('分解为') >= 0), '流程依旧不报错');

            // c) 第一批就齐 → 只发 1 次请求
            F.setMode('ok', [FIVE_REPAIRED]);
            await F.run(flowNode());
            eq(F.state().calls.length, 1, '第一次就齐 → 不补请求（不白花）');

            // 补齐提示词是纯函数，顺带单测一遍
            has(M.buildSegmentShotPrompt('照着做', [{name:'a'}, {name:'b'}], segments.slice(3), {onlyIndexes:[4, 5]}),
                '本次只写第 4、5 段', 'buildSegmentShotPrompt 支持 onlyIndexes（补齐模式）');
            has(M.buildSegmentShotPrompt('照着做', [], segments.slice(0, 2)), '下面 2 张图依次是第 1–2 段',
                '不传 onlyIndexes 时仍是逐段模式');
        })();
        console.log('');
        console.log('视频分镜表：' + pass + ' 项通过');
        if(fails.length){
            fails.forEach(msg => console.error('  ✗ ' + msg));
            console.error('失败 ' + fails.length + ' 项');
            process.exit(1);
        }
    })().catch(error => {
        console.error('行为用例异常：' + (error && error.stack || error));
        process.exit(1);
    });
}
