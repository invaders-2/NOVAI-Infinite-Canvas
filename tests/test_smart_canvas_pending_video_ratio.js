#!/usr/bin/env node
// 视频生成中的占位框（磨砂玻璃 + 扫光 + 计时）必须按「本次请求」的视频比例：
// 16:9 宽、9:16 高、1:1 才方。
//
// 现象：createPendingOutputFromSource() 建节点时就把 w/h 定死了，走的是
//       pendingBoxSize → pendingBaseBoxSize →（不带参数）explicitRequestOutputSizeForPending()，
//       视频分支要求 explicit 为真，视频请求因此被跳过，落到 expectedOutputSize() 的图片尺寸逻辑，
//       节点一开始就是正方形；.gen-stage 是 absolute 铺满节点体，动效跟着方正。
// 本检查锁住修复：调用方把「本次请求设置」当 requestSettings 传下来，视频占位框按 videoAspect 算；
//       adaptive / keep_ratio 算不出具体比例时保持原有兜底；图片/批量/表格/音频口径不变。
// 运行：node tests/test_smart_canvas_pending_video_ratio.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（实际 ' + a + '，期望 ' + b + '）');

const file = path.join(__dirname, '../static/js/smart-canvas.js');
const policyFile = path.join(__dirname, '../static/js/shared/size-policy.js');
const code = fs.readFileSync(file, 'utf8');
const label = 'static/js/smart-canvas.js';
function topLevelFunction(src, name){
    const start = src.indexOf('\nfunction ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start + 1);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start + 1, end + 2);
}

// ---- 静态接线：请求设置必须真的被传到占位框那一步 ----
const pendingBaseSrc = topLevelFunction(code, 'pendingBaseBoxSize');
ok(/options\.requestSettings/.test(pendingBaseSrc), 'pendingBaseBoxSize 接收本次请求设置 requestSettings');
ok(/explicitRequestOutputSizeForPending\(requestSettings\)/.test(pendingBaseSrc), '视频占位框按 requestSettings 里的 videoAspect 算尺寸');
ok(/requestSettings\.apiKind === 'video'/.test(pendingBaseSrc), '只有视频请求走这条比例分支（图片/音频口径不动）');
const createSrc = topLevelFunction(code, 'createPendingOutputFromSource');
ok(/requestSettings:options\.requestSettings \|\| null/.test(createSrc), 'createPendingOutputFromSource 把请求设置透传给 pendingBoxSize');
ok(/pendingBoxSize\(expectedCount, \{sourceNode, ratio:options\.ratio/.test(createSrc), '原有 ratio 透传保持不变');
ok(/pendingBoxSize\(pendingNode\.pending, \{sourceNode:node, refs, requestSettings:settings\}\)/.test(code), 'runGeneration 手点路径把本次请求设置传给占位框');
ok(/batchResultNodeForRun\(runId, node, meta, refs, srcRatio, runSettings\)/.test(code), '批量每行把自己的 runSettings 传给结果节点');

// ---- 行为断言：在沙箱里跑真实函数 ----
const names = ['isApiLikeEngine','resPixelLimitFor','apiSizeTier','enumMaxSizeLevel','defaultSmartApiResolution',
    'apiAllowsAuto','parseRatioValue','parseSizeValue','apiImageSize','gcdInt','fitSourceSize','sizeForRun',
    'expectedOutputSize','explicitRequestOutputSizeForPending','ratioFollowsSource','mediaLayoutSize','singleImageLayout',
    'pendingSizeFromImageRef','pendingSourceBoxSize','displayBoxFromNaturalSize','pendingRequestBoxForNode',
    'pendingBaseBoxSize','pendingBoxSize'];
const sandboxSrc = [
    'const window = {};',
    fs.readFileSync(policyFile, 'utf8'),
    'const NovaSizePolicy = window.NovaSizePolicy;',
    'const SIZE_MAP = {square:{"1k":"1024x1024","2k":"2048x2048","4k":"4096x4096"},portrait:{"1k":"1024x1536"},portrait43:{"1k":"1008x1344","2k":"1536x2048"},landscape43:{"1k":"1344x1008"},landscape:{"1k":"1536x1024"},story:{"1k":"720x1280"},wide:{"1k":"1280x720","2k":"2048x1152"},ultrawide:{"1k":"1280x544"},ultratall:{"1k":"544x1280"},portrait12:{"1k":"768x1536"},landscape21:{"1k":"1536x768"},landscape54:{"1k":"1536x1216"},portrait45:{"1k":"1216x1536"}};',
    'const API_RES_LEVELS = ["1k","2k","4k"];',
    'const RES_LONG_SIDE = { "1k":1536, "2k":2048, "4k":3840 };',
    'const RES_PIXEL_LIMIT_FALLBACK = { "1k":1572864, "2k":4194304, "4k":8294400 };',
    'const MEDIA_NODE_DEFAULT_SCALE = 2;',
    'const tr = k => k;',
    'function isAudioMediaItem(){ return false; }',
    'function isSmartMediaNode(){ return false; }',
    'function smartGroupContainingNode(){ return null; }',
    'function nodeRect(node){ return {x:0,y:0,width:0,height:0}; }',
    'let nodes = [];',
    'let settings = {engine:"api", apiKind:"image", model:"", ratio:"square", resolution:"1k"};',
    ...names.map(n => topLevelFunction(code, n)),
    'globalThis.__setSettings = s => { settings = s; };',
    'globalThis.__pending = (count, opts) => pendingBoxSize(count, opts || {});',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, {filename: 'pending-video-ratio-sandbox.js'});
const setSettings = sandbox.__setSettings;
const pending = sandbox.__pending;
const ratio = box => box.w / Math.max(1, box.h);

// 视频节点：全局设置里 apiKind=video（和运行时的 settings 同一份口径）
setSettings({engine:'api', apiKind:'video', model:'seedance-1-0', videoAspect:'16:9', ratio:'square', resolution:'1k'});

// ① 16:9 → 宽（≈1.78），不能是 1
const video169 = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'16:9'}});
near(ratio(video169), 16 / 9, 0.02, '视频 16:9 占位框比例 ≈1.78');
ok(ratio(video169) > 1.5, '视频 16:9 占位框是宽的（实际 ' + video169.w + 'x' + video169.h + '）');

// ② 9:16 → 高（≈0.56）
const video916 = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'9:16'}});
near(ratio(video916), 9 / 16, 0.02, '视频 9:16 占位框比例 ≈0.56');
ok(ratio(video916) < 0.7, '视频 9:16 占位框是高的（实际 ' + video916.w + 'x' + video916.h + '）');

// ③ 1:1 → 真正正方
const video11 = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'1:1'}});
near(ratio(video11), 1, 0.01, '视频 1:1 占位框比例 = 1');
ok(video11.w === video11.h, '视频 1:1 占位框宽高相等（实际 ' + video11.w + 'x' + video11.h + '）');

// ④ 21:9 → 超宽（≈2.33）
const video219 = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'21:9'}});
near(ratio(video219), 21 / 9, 0.03, '视频 21:9 占位框比例 ≈2.33');

// ⑤ 视频多产（videoCount > 1）：进度格按同一比例铺，不是正方形
const videoCount2 = pending(2, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'16:9'}});
ok(ratio(videoCount2) > 1.2, '视频 2 条占位框仍是宽版（实际 ' + videoCount2.w + 'x' + videoCount2.h + '）');

// ⑥ videoAspect 是 adaptive / keep_ratio：算不出具体比例 → 保持原有兜底，不崩
const fallback = pending(1, {});
const adaptiveBox = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'adaptive'}});
ok(adaptiveBox.w === fallback.w && adaptiveBox.h === fallback.h,
    'videoAspect=adaptive 走原兜底（实际 ' + adaptiveBox.w + 'x' + adaptiveBox.h + '，兜底 ' + fallback.w + 'x' + fallback.h + '）');
const keepRatioBox = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'keep_ratio'}});
ok(keepRatioBox.w === fallback.w && keepRatioBox.h === fallback.h,
    'videoAspect=keep_ratio 走原兜底（实际 ' + keepRatioBox.w + 'x' + keepRatioBox.h + '）');
const garbageBox = pending(1, {requestSettings:{engine:'api', apiKind:'video', videoAspect:'abc'}});
ok(garbageBox.w === fallback.w && garbageBox.h === fallback.h, 'videoAspect 非法时走原兜底，不崩');

// ⑦ 视频请求里 videoAspect 说了算（占位框跟真正发给模型的 aspect_ratio 同源）
const videoWithRatio = pending(1, {ratio:{w:16, h:9}, requestSettings:{engine:'api', apiKind:'video', videoAspect:'9:16'}});
near(ratio(videoWithRatio), 9 / 16, 0.02, '视频请求：videoAspect 优先于量出来的参考比例（发给模型的是 videoAspect）');

// ⑧ 图片请求不受影响：requestSettings 是图片时完全不进视频分支
setSettings({engine:'api', apiKind:'image', model:'', ratio:'portrait43', resolution:'1k'});
const imageBaseline = pending(1, {});
const imageWithRequest = pending(1, {requestSettings:{engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}});
ok(imageBaseline.w === 330 && imageBaseline.h === 440, '图片 3:4 占位框仍 330x440（实际 ' + imageBaseline.w + 'x' + imageBaseline.h + '）');
ok(imageWithRequest.w === imageBaseline.w && imageWithRequest.h === imageBaseline.h,
    '图片请求传了 requestSettings 也仍按原图片尺寸逻辑（实际 ' + imageWithRequest.w + 'x' + imageWithRequest.h + '）');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'wide', resolution:'1k'});
const imageWide = pending(1, {requestSettings:{engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}});
near(ratio(imageWide), 16 / 9, 0.02, '图片请求的比例只认全局设置（节点覆盖层不抢图片口径）');
setSettings({engine:'api', apiKind:'video', model:'seedance-1-0', videoAspect:'9:16', ratio:'square', resolution:'1k'});
const videoWithImageRequest = pending(1, {requestSettings:{engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}});
ok(videoWithImageRequest.w === fallback.w && videoWithImageRequest.h === fallback.h,
    '图片 requestSettings 不会给视频节点套图片比例（实际 ' + videoWithImageRequest.w + 'x' + videoWithImageRequest.h + '）');

// ⑨ 表格/批量等生成器节点自己的框仍不当结果形状（原有语义不变）
const sourceBox = pending(1, {sourceNode:{id:'t1', type:'table', w:520, h:360, images:[{url:'x'}]},
    requestSettings:{engine:'api', apiKind:'video', videoAspect:'16:9'}});
near(ratio(sourceBox), 16 / 9, 0.02, '视频批量源节点是表格时，占位框按视频比例而不是表格自己的框');

console.log(label + ' 视频占位框比例：' + pass + ' 项通过');
if(fails.length){ fails.forEach(msg => console.error('  ✗ ' + msg)); console.error('失败 ' + fails.length + ' 项'); process.exit(1); }
console.log('全部通过');
