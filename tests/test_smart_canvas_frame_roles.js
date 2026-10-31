#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }
function eq(actual, expected, label){ ok(JSON.stringify(actual) === JSON.stringify(expected), label + '（实际 ' + JSON.stringify(actual) + '）'); }
function fn(name){
    const start = source.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = source.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return source.slice(start, end + 2);
}

const support = new Function(
    source.match(/const VIDEO_FRAME_ROLE_MODEL_RE = [^;]+;/)[0] + '\n' + fn('videoModelSupportsFrameRoles') + '\nreturn videoModelSupportsFrameRoles;'
)();
ok(support({videoModel:'Seedance 2.5'}), 'Seedance 2.5 支持首尾帧');
ok(support({videoModel:'kling-3.0-turbo'}), 'Kling 支持首尾帧');
ok(support({videoModel:'veo-3.1'}), 'VEO 3.1 支持首尾帧');
ok(!support({videoModel:'veo3-fast'}), 'VEO 3 Fast 不显示首尾帧');
ok(!support({videoModel:'sora-2'}), 'Sora 不显示首尾帧');
ok(support({videoProvider:'jimeng', videoModel:'3.0'}), '即梦 3.0 支持首尾帧');
ok(!support({videoProvider:'jimeng', videoModel:'3.0fast'}), '即梦 3.0fast 不显示首尾帧');
ok(!support({videoProvider:'lovart', videoModel:'generate_video_seedance_v2_5'}), 'Lovart 普通附件通道不显示首尾帧');

const normalize = new Function(
    'videoModelSupportsFrameRoles', fn('normalizeSmartVideoModeSettings') + '\nreturn normalizeSmartVideoModeSettings;',
)(support);
const seedanceSettings = normalize({videoModel:'seedance-2-5', videoMultimodal:true, videoUseFrameRoles:false});
ok(seedanceSettings.videoUseFrameRoles && !seedanceSettings.videoMultimodal, '支持模型自动启用首尾帧并关闭全能参考');
const soraSettings = normalize({videoModel:'sora-2', videoMultimodal:true, videoUseFrameRoles:true});
ok(!soraSettings.videoUseFrameRoles && soraSettings.videoMultimodal, '不支持模型忽略旧首尾帧设置');

const settingsForNode = new Function(
    'stripOutpaintDisplaySettings', 'isSmartBatchNode', 'isSmartVideoNode', 'isSmartImageNode', 'isSmartAudioNode',
    'cloneSmartSettings', 'canvasDefaultSmartSettings', 'initialSmartSettings', 'settings', 'recentSmartSettingsForMode',
    'smartSettingsModeKey', 'normalizeSmartVideoModeSettings', 'withOutpaintDisplaySettings', 'isVideoMediaItem', 'isApiLikeEngine',
    fn('smartSettingsForNode') + '\nreturn smartSettingsForNode;'
)(
    value => ({...value}), node => node.type === 'smart-batch', () => false, () => false, () => false,
    value => JSON.parse(JSON.stringify(value || {})), {engine:'api', apiKind:'image'}, {}, {}, () => ({}),
    () => '', normalize, (node, value) => value, item => item.kind === 'video', engine => ['api', 'volcengine'].includes(engine)
);
const batchVideo = settingsForNode({type:'smart-batch', runSettings:{engine:'api', apiKind:'video', videoModel:'seedance-2-5'}, images:[{url:'old.png', kind:'image'}]});
eq(batchVideo.apiKind, 'video', '批量节点旧图片产物不覆盖本次视频设置');
const storyboardVideo = settingsForNode({type:'smart-batch', tableBatchVideo:true, runSettings:{}, images:[{url:'old.png', kind:'image'}]});
eq(storyboardVideo.apiKind, 'video', '未选择模式时视频分镜标记作为默认值');
const batchImage = settingsForNode({type:'smart-batch', tableBatchVideo:true, runSettings:{engine:'api', apiKind:'image'}, images:[{url:'old.mp4', kind:'video'}]});
eq(batchImage.apiKind, 'image', '视频分镜节点切回图片后按本次设置批量出图');

const videoSandbox = {console};
vm.createContext(videoSandbox);
vm.runInContext([
    'let payload = null;',
    'let transientSmartCloudLinks = [];',
    'const activeSmartGenerationTaskIds = new Map();',
    'const VIDEO_DURATION_DEFAULT = 5;',
    'function tr(key){ return key; }',
    'function toast(){}',
    'function refSourceEntry(){ return null; }',
    'function applyUploadedUrlsToSmartRefs(refs){ return refs; }',
    'function videoProviderPlatform(){ return "apimart"; }',
    'function applySourceRatioToVideoAspect(){}',
    'function throwIfSmartGenerationStopped(){}',
    'function smartGenerationStopRequestedFor(){ return false; }',
    'function resultMediaUrls(result){ return result.urls || []; }',
    'function smartResponseErrorMessage(){ return "err"; }',
    'function smartNodeStopContextId(){ return "n1"; }',
    'function cancelSmartTask(){}',
    'function videoDurationBounds(){ return {min:4, max:15}; }',
    'function manualSmartVideoLink(){ return null; }',
    'function manualSmartMediaLinks(){ return []; }',
    'function imageRefsOnly(refs){ return refs.filter(ref => ref.kind === "image"); }',
    'function videoRefsOnly(refs){ return refs.filter(ref => ref.kind === "video"); }',
    'function audioRefsOnly(refs){ return refs.filter(ref => ref.kind === "audio"); }',
    'async function pollSmartVideoTask(){ return {urls:["out.mp4"], canvas_meta:{}}; }',
    'async function fetch(url, options){ payload = {url, body:JSON.parse(options.body)}; return {ok:true, json:async () => ({task_id:"task-1"})}; }',
    source.match(/const VIDEO_FRAME_ROLE_MODEL_RE = [^;]+;/)[0],
    fn('videoModelSupportsFrameRoles'),
    fn('normalizeSmartVideoModeSettings'),
    'async ' + fn('runApiVideoGeneration'),
    'globalThis.__run = async settings => { await runApiVideoGeneration("镜头推进", [{url:"first.png",kind:"image"},{url:"last.png",kind:"image"}], settings, null); return payload.body; };'
].join('\n'), videoSandbox);

(async () => {
    const supportedPayload = await videoSandbox.__run({videoModel:'seedance-2-5', videoProvider:'apimart', videoUseFrameRoles:false, videoMultimodal:true, videoAspect:'9:16'});
    eq(supportedPayload.images.map(image => image.role), ['first_frame', 'last_frame'], '请求中的两张图片明确标记首帧和尾帧');
    eq(supportedPayload.multimodal, false, '首尾帧请求不会同时声明全能参考');
    eq(supportedPayload.aspect_ratio, 'adaptive', '首尾帧任务自动跟随首帧比例，不再向上游发送固定 9:16');
    const unsupportedPayload = await videoSandbox.__run({videoModel:'sora-2', videoProvider:'apimart', videoUseFrameRoles:true, videoMultimodal:true, videoAspect:'9:16'});
    eq(unsupportedPayload.images.map(image => image.role || ''), ['', ''], '不支持模型的请求不携带首尾帧角色');
    eq(unsupportedPayload.aspect_ratio, '9:16', '非首尾帧任务仍保留用户选择的画幅');

    const forcedVideoModes = [];
    const batchNodes = [
        {id:'image', tableBatchVideo:true, runSettings:{apiKind:'image'}},
        {id:'video', runSettings:{apiKind:'video'}},
        {id:'storyboard', tableBatchVideo:true, runSettings:{}},
        {id:'plain', runSettings:{}}
    ];
    const runGenerator = new Function('nodes', 'tableRunOneRow', 'async ' + fn('tableRunGenerator') + '\nreturn tableRunGenerator;')(
        batchNodes, async (nodeId, options, forceVideo) => { forcedVideoModes.push(forceVideo); }
    );
    for(const node of batchNodes) await runGenerator(node.id);
    eq(forcedVideoModes, [false, true, true, false], '批量执行同时支持图片和视频，本次模式选择优先于分镜默认标记');

    const clonedToken = {kind:'cloned-token'};
    const originalToken = {cloneNode(){ return clonedToken; }};
    const appended = [];
    let inputEvent = null;
    const editor = {
        textContent:'',
        querySelectorAll(selector){ return selector === '.mention-image-token' ? [originalToken] : []; },
        focus(){},
        appendChild(node){ appended.push(node); },
        dispatchEvent(event){ inputEvent = event; }
    };
    const documentMock = {
        createRange(){ return {selectNodeContents(){}}; },
        createTextNode(text){ return {text}; },
        execCommand(){ return false; }
    };
    const windowMock = {getSelection(){ return {removeAllRanges(){}, addRange(){}}; }};
    class EventMock { constructor(type, options){ this.type = type; this.bubbles = options.bubbles; } }
    const replace = new Function('window', 'document', 'Event', 'bindSmartPreviewImageFallbacks', 'refreshIcons',
        fn('promptOptimizeReplaceText') + '\nreturn promptOptimizeReplaceText;'
    )(windowMock, documentMock, EventMock, () => {}, () => {});
    replace(editor, '优化后的提示词');
    ok(appended.includes(clonedToken), '优化后原 @ 引用的克隆芯片被接回编辑器');
    ok(!appended.includes(originalToken), '接回的是独立克隆，不依赖已被替换的旧 DOM');
    eq(editor.textContent, '优化后的提示词', '优化正文仍按模型结果替换');
    ok(inputEvent && inputEvent.type === 'input' && inputEvent.bubbles, '引用恢复后仍触发原保存链路');

    ok(source.includes("tr('smart.videoRoleFirstFrame')") && source.includes("tr('smart.videoRoleLastFrame')"), '视频编辑器渲染首帧和尾帧标签');
    ok(source.includes('class="input-frame-empty"'), '缺少首帧或尾帧时显示空槽位');

    console.log('首尾帧与引用保留：' + pass + ' 项通过');
    if(failures.length){
        failures.forEach(label => console.error('  x ' + label));
        process.exit(1);
    }
})().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
});
