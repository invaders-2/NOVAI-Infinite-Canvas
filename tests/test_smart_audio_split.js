#!/usr/bin/env node
/* 音频切分（智能 / 自定义）回归：
   1) 工具条：截取 变速 智能切分 自定义切分 | 下载，图标 / 文案全走 i18n；
   2) 请求体：provider_id / model / text / duration_sec / max_segments / mode（vm 跑真实实现 + 假 fetch）；
   3) 预览：波形分段块 + 段序号 + 浮层摘要 / 重新解析 / 生成 N 段 / 取消；
   4) 本地静音切分（合成波形）+ 等分兜底（纯函数）；
   5) 落盘：命名 {原名}_{i}、history 连线、同组、整批只 pushUndo 一次；
   6) 兜底与约束：<1s 不支持、失败自动退本地、重复点击幂等、Esc 收起；
   7) i18n 键中英齐全 + CSS 类齐全。
   跑法：node tests/test_smart_audio_split.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const NL = String.fromCharCode(10);

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if(cond) { pass += 1; } else { fails.push(msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), (msg || '') + '（实际 ' + JSON.stringify(a) + '）');
const near = (a, b, tolerance, msg) => ok(Math.abs(Number(a) - Number(b)) <= tolerance, (msg || '') + '（实际 ' + a + '，期望 ≈' + b + '）');

function read(rel){ return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf(NL + '}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
function extractConst(src, name){
    const start = src.indexOf('const ' + name + ' = ');
    if(start < 0) throw new Error('未找到常量 ' + name);
    const end = src.indexOf(NL, start);
    return src.slice(start, end);
}

const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');
const icons = read('static/vendor/js/lucide-subset.js');

const SPLIT_CONSTS = [
    extractConst(js, 'SMART_AUDIO_SPLIT_MIN_SEC'),
    extractConst(js, 'SMART_AUDIO_SPLIT_MAX_SEGMENTS'),
    extractConst(js, 'SMART_AUDIO_SPLIT_MIN_TOTAL_SEC'),
    extractConst(js, 'SMART_AUDIO_SPLIT_RMS_WINDOW_SEC'),
    extractConst(js, 'SMART_AUDIO_SPLIT_SILENCE_MIN_SEC'),
    extractConst(js, 'SMART_AUDIO_SPLIT_SILENCE_RATIO')
].join(NL);

function synthChannel(rate, plan){
    let frames = 0;
    plan.forEach(entry => { frames += Math.round(rate * entry.sec); });
    const data = new Float32Array(frames);
    let offset = 0;
    plan.forEach(entry => {
        const count = Math.round(rate * entry.sec);
        for(let i = 0; i < count; i += 1){
            const phase = (offset + i) * 0.05;
            data[offset + i] = entry.amp === 0 ? 0 : Math.sin(phase) * entry.amp;
        }
        offset += count;
    });
    return data;
}

(async () => {
    console.log('[1] 工具条：截取 变速 智能切分 自定义切分 | 下载');
    const toolbarFn = extractFn(js, 'smartNodeToolbarHtml');
    const audioBranch = toolbarFn.slice(toolbarFn.indexOf("if(kind === 'audio')"), toolbarFn.indexOf("if(kind === 'video')"));
    ok(audioBranch.length > 0, '有音频分支');
    const trimAt = audioBranch.indexOf("plainButton('trim'");
    const speedAt = audioBranch.indexOf("plainButton('speed'");
    const smartAt = audioBranch.indexOf("plainButton('split-smart'");
    const customAt = audioBranch.indexOf("plainButton('split-custom'");
    const sepAt = audioBranch.indexOf('{sep}');
    const downloadAt = audioBranch.indexOf("plainButton('download'");
    ok(trimAt > 0 && speedAt > trimAt, '顺序：截取 → 变速');
    ok(smartAt > speedAt && customAt > smartAt, '变速后面依次是智能切分 → 自定义切分');
    ok(sepAt > customAt && downloadAt > sepAt, '下载前有 sep 分隔线（切分在分隔线左边）');
    ok(audioBranch.indexOf("plainButton('split-smart', 'wand-sparkles'") > 0, '智能切分用项目已有的 wand-sparkles 图标');
    ok(audioBranch.indexOf("plainButton('split-custom', 'split'") > 0, '自定义切分用项目已有的 split 图标');
    ok(audioBranch.indexOf("trd('smart.audioSplitSmart'") > 0 && audioBranch.indexOf("trd('smart.audioSplitCustom'") > 0, '两个按钮文案走 i18n');
    ok(audioBranch.indexOf("trd('smart.audioSplitSmartTip'") > 0 && audioBranch.indexOf("trd('smart.audioSplitCustomTip'") > 0, '两个按钮 title 也走 i18n');
    ok(audioBranch.indexOf('smart-audio-toolbar') > 0, '音频工具条样式类保持不变');
    for(const icon of ['wand-sparkles', 'split', 'loader-circle', 'refresh-cw', 'scissors']){
        ok(icons.indexOf(icon + '.mjs:') >= 0, 'lucide 子集里已有图标 ' + icon + '（不引第三方图标库）');
    }

    console.log('[2] 请求体字段 + 前端清洗（vm 跑真实实现 + 假 fetch）');
    const requestSandbox = [
        SPLIT_CONSTS,
        'function trd(key, fallback){ return fallback; }',
        extractFn(js, 'smartAudioSplitPreferredProvider'),
        'let __captured = null;',
        'const fetch = async (url, options) => {',
        '    __captured = {url:url, body:JSON.parse(options.body)};',
        '    return {ok:true, json:async () => ({segments:[{start:0,end:1},{start:1,end:2.5}], note:"ok"})};',
        '};',
        extractFn(js, 'smartAudioSplitMode'),
        extractFn(js, 'smartAudioSplitMaxSegments'),
        extractFn(js, 'smartAudioSplitNormalizeSegments'),
        'async ' + extractFn(js, 'smartAudioSplitAskModel'),
        'globalThis.__req = {',
        '    ask(mode, text, duration, node){ return smartAudioSplitAskModel(node || null, mode, text, duration); },',
        '    captured(){ return __captured; },',
        '    normalize(entries, duration, max){ return smartAudioSplitNormalizeSegments(entries, duration, max); },',
        '    max(value){ return smartAudioSplitMaxSegments(value); },',
        '    mode(value){ return smartAudioSplitMode(value); }',
        '};'
    ].join(NL);
    const reqOut = {};
    vm.runInNewContext(requestSandbox, reqOut, {filename:'static/js/smart-canvas.js'});
    const req = reqOut.__req;
    const asked = await req.ask('custom', '删除10-15秒，再在第20秒切开', 45.2);
    const captured = req.captured();
    ok(Boolean(captured), '真的发出了请求');
    eq(captured.url, '/api/canvas-audio-split', '请求打到 /api/canvas-audio-split');
    eq(captured.body, {
        provider_id:'',
        model:'',
        text:'删除10-15秒，再在第20秒切开',
        duration_sec:45.2,
        max_segments:12,
        mode:'custom'
    }, '请求体字段齐全，provider/model 默认留空交给后端按优先级选');
    ok(extractFn(js, 'smartAudioSplitAskModel').indexOf('resolveChatProviderId') < 0,
        '前端不再用界面当前 chat 平台抢着指定 provider（真机回归：被写死成 volcengine 绕过了 apimart）');
    const preferredAsk = await req.ask('smart', '', 8, {llmProvider:'volcengine', llmModel:'deepseek-v4-1-flash-260910'});
    const preferredBody = req.captured().body;
    eq([preferredBody.provider_id, preferredBody.model], ['volcengine', 'deepseek-v4-1-flash-260910'],
        '只有节点上明确存过 LLM 平台/模型（用户偏好）时才带上');
    ok(Boolean(preferredAsk.segments.length), '带偏好时同样能解析结果');
    eq(asked.segments, [{start:0,end:1},{start:1,end:2.5}], '返回的 segments 原样进前端清洗');
    eq(asked.note, 'ok', 'note 透传');
    eq(asked.source, 'llm', '模型结果 source = llm');
    eq([req.max(99), req.max(0), req.max('x')], [12, 1, 12], '前端也把段数夹在 1–12');
    eq([req.mode('CUSTOM'), req.mode('whatever')], ['custom', 'smart'], 'mode 归一');
    eq(req.normalize([{start:-5,end:2},{start:3,end:99}], 10, 12), [{start:0,end:2},{start:3,end:10}], '越界夹取');
    eq(req.normalize([{start:0,end:0.4},{start:2,end:2.5}], 10, 12), [{start:2,end:2.5}], '丢弃 <0.5s');
    eq(req.normalize([{start:6,end:8},{start:0,end:3},{start:2,end:4.5}], 10, 12), [{start:0,end:4.5},{start:6,end:8}], '升序 + 重叠合并');
    eq(req.normalize([{start:0,end:2},{start:2,end:4}], 10, 12), [{start:0,end:2},{start:2,end:4}], '首尾相接不合并');
    const many = [];
    for(let i = 0; i < 20; i += 1) many.push({start:i * 2, end:i * 2 + 1.5});
    eq(req.normalize(many, 60, 99).length, 12, '最多 12 段');

    console.log('[3] 波形预览：分段块 + 段序号（vm 跑真实实现）');
    const overlaySandbox = [
        'let smartAudioSplit = null;',
        extractFn(js, 'smartAudioSplitFor'),
        extractFn(js, 'smartAudioEditClamp'),
        extractFn(js, 'smartAudioTrimPercent'),
        extractFn(js, 'smartAudioSplitOverlayHtml'),
        'globalThis.__overlay = { render(node, state){ smartAudioSplit = state; return smartAudioSplitOverlayHtml(node); } };'
    ].join(NL);
    const overlayOut = {};
    vm.runInNewContext(overlaySandbox, overlayOut, {filename:'static/js/smart-canvas.js'});
    const overlay = overlayOut.__overlay;
    const previewHtml = overlay.render({id:'n1'}, {
        nodeId:'n1', status:'preview', duration:10,
        segments:[{start:0, end:2.5}, {start:2.5, end:6}]
    });
    ok(previewHtml.indexOf('data-audio-split="1"') > 0, '预览层容器在波形上');
    ok(previewHtml.indexOf('data-audio-split-segment="1"') > 0 && previewHtml.indexOf('data-audio-split-segment="2"') > 0, '每段一块');
    ok(previewHtml.indexOf('left:0.00%') > 0 && previewHtml.indexOf('width:25.00%') > 0, '第一段 0–2.5s / 10s = 0%~25%');
    ok(previewHtml.indexOf('left:25.00%') > 0 && previewHtml.indexOf('width:35.00%') > 0, '第二段 2.5–6s = 25%~60%');
    ok(previewHtml.indexOf('audio-split-index') > 0, '块上有段序号');
    eq(overlay.render({id:'n1'}, {nodeId:'n1', status:'busy', duration:10, segments:[]}), '', '忙碌态不画预览');
    eq(overlay.render({id:'n2'}, {nodeId:'n1', status:'preview', duration:10, segments:[{start:0,end:1}]}), '', '只画当前节点');
    ok(extractFn(js, 'smartAudioPlayerHtml').indexOf('smartAudioSplitOverlayHtml(node)') > 0, '播放器卡片里挂切分预览层');

    console.log('[4] 本地静音切分（合成波形）/ 等分兜底（vm 跑真实实现）');
    const splitSandbox = [
        SPLIT_CONSTS,
        extractFn(js, 'smartAudioSplitMode'),
        extractFn(js, 'smartAudioSplitMaxSegments'),
        extractFn(js, 'smartAudioSplitNormalizeSegments'),
        extractFn(js, 'smartAudioSplitRmsWindows'),
        extractFn(js, 'smartAudioSplitEvenSegments'),
        extractFn(js, 'smartAudioSplitLocalSegments'),
        'globalThis.__split = {',
        '    local(channels, rate, duration, max){ return smartAudioSplitLocalSegments(channels, rate, duration, max); },',
        '    even(duration, max){ return smartAudioSplitEvenSegments(duration, max); },',
        '    rms(channels, rate){ return smartAudioSplitRmsWindows(channels, rate); }',
        '};'
    ].join(NL);
    const splitOut = {};
    vm.runInNewContext(splitSandbox, splitOut, {filename:'static/js/smart-canvas.js'});
    const split = splitOut.__split;
    const rate = 8000;
    const twoGaps = synthChannel(rate, [
        {sec:1, amp:0.8}, {sec:0.5, amp:0}, {sec:1, amp:0.8}, {sec:0.5, amp:0}, {sec:1, amp:0.8}
    ]);
    const windows = split.rms([twoGaps], rate);
    near(windows.windowSec, 0.02, 1e-9, 'RMS 窗口 20ms');
    eq(windows.rms.length, 200, '4 秒 / 20ms = 200 个窗口');
    const localSegments = split.local([twoGaps], rate, 4, 12);
    eq(localSegments.length, 3, '两段静音 → 切成 3 段');
    near(localSegments[0].end, 1.25, 0.06, '第一刀落在第一段静音中点（≈1.25s）');
    near(localSegments[1].end, 2.75, 0.06, '第二刀落在第二段静音中点（≈2.75s）');
    eq(localSegments[2].end, 4, '最后一段到结尾');
    localSegments.forEach((segment, index) => {
        ok(segment.end - segment.start >= 0.5, '第 ' + (index + 1) + ' 段不短于 0.5s');
        if(index > 0) ok(segment.start >= localSegments[index - 1].end - 1e-9, '段与段不重叠且升序');
    });
    const flat = synthChannel(rate, [{sec:5, amp:0.8}]);
    eq(split.local([flat], rate, 5, 12).length, 10, '没有静音 → 按 0.5s 等分成 10 段');
    eq(split.local([flat], rate, 5, 12)[0], {start:0, end:0.5}, '等分第一段 0–0.5s');
    eq(split.even(1, 12).length, 2, '1s 等分 = 2 段');
    eq(split.even(0.4, 12), [], '比 0.5s 还短的音频没有可切分段');
    const shortGaps = synthChannel(rate, [
        {sec:1, amp:0.8}, {sec:0.15, amp:0}, {sec:1, amp:0.8}
    ]);
    eq(split.local([shortGaps], rate, 2.15, 12), split.even(2.15, 12), '静音只有 150ms（<350ms）→ 退等分');
    const manyGaps = [];
    for(let i = 0; i < 8; i += 1){ manyGaps.push({sec:0.8, amp:0.8}); manyGaps.push({sec:0.5, amp:0}); }
    manyGaps.push({sec:0.8, amp:0.8});
    const capped = split.local([synthChannel(rate, manyGaps)], rate, 0.8 * 9 + 0.5 * 8, 3);
    ok(capped.length <= 3, '最多 max_segments 段（实际 ' + capped.length + '）');
    const stereo = [synthChannel(rate, [{sec:0.8, amp:0.6}, {sec:0.5, amp:0}, {sec:0.8, amp:0.6}]),
                    synthChannel(rate, [{sec:0.8, amp:0.6}, {sec:0.5, amp:0}, {sec:0.8, amp:0.6}])];
    eq(split.local(stereo, rate, 2.1, 12).length, 2, '双声道一起算 RMS（静音处照样切开）');

    console.log('[5] 落盘：命名 {原名}_{i} / history 连线 / 同组 / 只 pushUndo 一次');
    const createFn = extractFn(js, 'smartAudioSplitCreateNodes');
    ok(createFn.indexOf("const title = baseName + '_' + (index + 1);") > 0, '命名规则 {原名}_{i}，i 从 1 开始');
    ok(createFn.indexOf('smartAudioDerivedBaseName(item, node)') > 0, '原名沿用音频派生命名（去扩展名、空名回落「音频」）');
    ok(createFn.indexOf('smartAudioSliceChannels(channels, sampleRate, segment.start, segment.end)') > 0, '每段本地切片');
    ok(createFn.indexOf('smartAudioWavBytes(sliced, sampleRate)') > 0, '每段编码 16bit WAV');
    ok(createFn.indexOf('uploadFiles([file])') > 0, '每段走 uploadFiles 上传');
    ok(createFn.indexOf("createImageNodeAt(spot, [media], {select:false, skipUndo:true, type:'smart-audio', title})") > 0,
        '建 smart-audio 节点（中间步骤 skipUndo）');
    ok(createFn.indexOf("addConnection(node.id, child.id, 'history')") > 0, '每个节点都从原节点连一条 history 连线');
    ok(createFn.indexOf('smartAudioSplitGroup(node, created, mode)') > 0, '全部放同一个分组');
    ok((createFn.match(/pushUndo\(\)/g) || []).length === 1, '整批只 pushUndo 一次');
    ok(createFn.indexOf('centerViewportOnWorldPoint(') > 0, '完成后视口居中到第一段');
    ok(createFn.indexOf("trd('smart.audioSplitDone'") > 0, '完成 toast 走 i18n（已生成 N 段音频）');
    ok(createFn.indexOf('child.derivedFrom = node.id') > 0, '子节点带 derivedFrom');
    ok(createFn.indexOf('child.audioSplit = {') > 0, '子节点记录 audioSplit（mode/index/start/end/来源）');
    const groupFn = extractFn(js, 'smartAudioSplitGroup');
    ok(groupFn.indexOf('createSmartGroupNode(') > 0 && groupFn.indexOf('skipUndo:true') > 0, '分组创建也 skipUndo');
    ok(groupFn.indexOf('addNodeToSmartGroup(group, child)') > 0, '逐个入组');
    ok(groupFn.indexOf('arrangeSmartGroupMembers(group, {skipUndo:true})') > 0, '入组后整理排版');
    ok(groupFn.indexOf("trd('smart.audioSplitSmart'") > 0 && groupFn.indexOf("trd('smart.audioSplitCustom'") > 0,
        '分组标题 = 智能切分 / 自定义切分');
    ok(groupFn.indexOf('minX - 18') > 0 && groupFn.indexOf('minY - 44') > 0, '分组框包住全部新节点');
    const spotFn = extractFn(js, 'smartAudioSplitSpot');
    ok(spotFn.indexOf("imageLayout([media], 1, {type:'smart-audio', images:[media]})") > 0, '落点按音频播放器真实尺寸算');
    ok(spotFn.indexOf('rect.x + rect.width + 120') > 0, '从原节点右侧起排');
    ok(spotFn.indexOf('index % columns') > 0 && spotFn.indexOf('y += height + gap') > 0, '横向排开 + 重叠时往下错开');

    console.log('[6] 兜底与约束：<1s 不支持 / 失败退本地 / 幂等 / Esc');
    const requestFn = extractFn(js, 'smartAudioSplitRequest');
    ok(requestFn.indexOf('state.busy') > 0 && requestFn.indexOf('if(!node || !state || state.busy) return null;') > 0, '重复点击幂等（处理中直接返回）');
    ok(requestFn.indexOf('SMART_AUDIO_SPLIT_MIN_TOTAL_SEC') > 0 && requestFn.indexOf("trd('smart.audioSplitTooShort'") > 0, '<1s 直接提示不支持切分');
    ok(requestFn.indexOf('smartAudioDecodeItem(smartAudioActiveItem(node))') > 0, '用解码后的真实时长（不信元数据）');
    ok(requestFn.indexOf('smartAudioSplitLocalSegments(state.channels, state.sampleRate, state.duration') > 0, '模型失败自动走本地静音切分');
    ok(requestFn.indexOf("state.source = 'local'") > 0, '本地兜底标记 source = local');
    ok(requestFn.indexOf("trd('smart.audioSplitFallback'") > 0, '本地兜底有明确 toast');
    ok(requestFn.indexOf("state.status = 'preview'") > 0, '两种来源都进预览态');
    const applyFn = extractFn(js, 'smartAudioSplitApply');
    ok(applyFn.indexOf("state.status !== 'preview'") > 0, '只有预览态才允许生成');
    ok(applyFn.indexOf('node.__audioSplitApplyBusy') > 0, '生成期间重复点击幂等');
    const panelFn = extractFn(js, 'smartAudioSplitFormHtml');
    ok(panelFn.indexOf('data-aep-split-input') > 0 && panelFn.indexOf("trd('smart.audioSplitPlaceholder'") > 0, '自定义切分是多行文本框 + placeholder');
    ok(panelFn.indexOf('data-aep-split-cancel') > 0 && panelFn.indexOf('data-aep-split-run') > 0, '底部有 [取消] [确认切分]');
    const previewPanelFn = extractFn(js, 'smartAudioSplitPreviewHtml');
    ok(previewPanelFn.indexOf('data-aep-split-summary') > 0 && previewPanelFn.indexOf('smartAudioSplitSummaryLabel(state)') > 0, '预览态显示「识别到 N 段 · 共 X 秒」');
    ok(extractFn(js, 'smartAudioSplitSummaryLabel').indexOf("trd('smart.audioSplitSummary'") > 0, '摘要文案走 i18n（识别到 {n} 段 · 共 {s} 秒）');
    ok(previewPanelFn.indexOf('data-aep-split-retry') > 0, '预览态有「重新解析」');
    ok(previewPanelFn.indexOf('data-aep-split-apply') > 0 && previewPanelFn.indexOf("trd('smart.audioSplitGenerate'") > 0, '预览态有「生成 N 段」');
    ok(previewPanelFn.indexOf('aep-split-badge') > 0 && previewPanelFn.indexOf('smartAudioSplitSourceLabel(state)') > 0, '预览态有来源标识');
    ok(extractFn(js, 'smartAudioSplitSourceLabel').indexOf("trd('smart.audioSplitLocalBadge'") > 0, '本地切分有「模型不可用」标识');
    const busyPanelFn = extractFn(js, 'smartAudioSplitPanelHtml');
    ok(busyPanelFn.indexOf("state.status === 'error'") > 0 && busyPanelFn.indexOf('aep-split-status is-error') > 0, '错误态显示可读原因 + 重试');
    const bindFn = extractFn(js, 'bindSmartAudioSplitPanel');
    ok(bindFn.indexOf("event.key === 'Escape'") > 0, 'Esc 收起浮层');
    ok(bindFn.indexOf('panel.dataset.splitSubmitting') > 0, '提交期间按钮禁用 + 幂等');
    ok(bindFn.indexOf('smartAudioSplitApply(node)') > 0, '「生成 N 段」走落盘管线');
    ok(bindFn.indexOf('mode:current.mode') > 0, '「重新解析」按当前模式重跑');
    const openFn = extractFn(js, 'openSmartAudioSplitPanel');
    ok(openFn.indexOf("smartAudioEditPanelOpen('audio-split', node.id)") > 0, '再点同一个切分按钮 = 收起');
    ok(openFn.indexOf("placement:'below-node'") > 0 && openFn.indexOf('persist:true') > 0, '浮层在节点下方且常驻');
    ok(openFn.indexOf("smartAudioSplitRequest(node, {mode:'smart', text:''})") > 0, '智能切分点按钮直接发 mode=smart（没有输入框）');
    ok(openFn.indexOf('onClose:') > 0 && openFn.indexOf('smartAudioSplitReset()') > 0, '关闭浮层清掉预览态');
    ok(openFn.indexOf('smartAudioPause(node)') > 0, '打开面板先暂停播放');
    const dispatchFn = extractFn(js, 'runSmartNodeToolbarAction');
    ok(dispatchFn.indexOf("if(action === 'split-smart'){ openSmartAudioSplitPanel(node, 'smart'); return; }") > 0, '工具条动作分发到智能切分');
    ok(dispatchFn.indexOf("if(action === 'split-custom'){ openSmartAudioSplitPanel(node, 'custom'); return; }") > 0, '工具条动作分发到自定义切分');
    ok(dispatchFn.indexOf("'split-smart', 'split-custom'") > 0, '切分按钮不会把常驻面板提前收掉');

    console.log('[7] i18n（中英）/ CSS 样式');
    const keys = [
        'smart.audioSplitSmart', 'smart.audioSplitSmartTip', 'smart.audioSplitCustom', 'smart.audioSplitCustomTip',
        'smart.audioSplitPlaceholder', 'smart.audioSplitConfirm', 'smart.audioSplitCancel', 'smart.audioSplitRetry',
        'smart.audioSplitGenerate', 'smart.audioSplitSummary', 'smart.audioSplitLocalBadge', 'smart.audioSplitLlmBadge',
        'smart.audioSplitBusy', 'smart.audioSplitFallback', 'smart.audioSplitTooShort', 'smart.audioSplitEmpty',
        'smart.audioSplitRequestFail', 'smart.audioSplitFail', 'smart.audioSplitDone', 'smart.audioSplitNeedText'
    ];
    keys.forEach(key => {
        const index = i18n.indexOf('"' + key + '":');
        ok(index >= 0, 'i18n 有 ' + key);
        if(index < 0) return;
        const lineEnd = i18n.indexOf(NL, index);
        const line = i18n.slice(index, lineEnd < 0 ? i18n.length : lineEnd);
        ok(line.indexOf('zh: "') > 0 && line.indexOf('en: "') > 0, key + ' 中英两份都在');
        ok(line.length > 40, key + ' 文案非空');
    });
    ok(i18n.indexOf('Smart split') > 0 && i18n.indexOf('Custom split') > 0 && i18n.indexOf('Local split') > 0, '英文文案真的写了英文');
    ok(i18n.indexOf('请输入所需要截取的内容') > 0 && i18n.indexOf('删除10-15秒') > 0, 'placeholder 文案就是需求里那段例子');
    ok(i18n.indexOf('在第5秒和第12秒处切开') > 0 && i18n.indexOf('分别截取0-3秒和8-12秒') > 0, 'placeholder 覆盖全部四种例子');
    ok(css.indexOf('.audio-split {') > 0 && css.indexOf('.audio-split-segment {') > 0 && css.indexOf('.audio-split-index {') > 0,
        '波形预览样式齐全（分段块 + 序号 + 压暗层）');
    ok(css.indexOf('.audio-edit-panel .aep-split-input {') > 0 && css.indexOf('.aep-split-segments {') > 0 && css.indexOf('.aep-split-badge {') > 0,
        '浮层样式齐全（输入框 / 分段胶囊 / 来源标识）');
    ok(css.indexOf('.aep-split-status.is-busy') > 0 && css.indexOf('animation:spin') > 0, '处理中转圈');

    console.log('');
    const total = pass + fails.length;
    if(fails.length){
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach(item => console.error('  ✗ ' + item));
        console.error('音频切分：' + pass + '/' + total + ' 项通过');
        process.exit(1);
    }
    console.log('音频切分：' + pass + '/' + total + ' 项通过');
    console.log('全部通过');
})().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
