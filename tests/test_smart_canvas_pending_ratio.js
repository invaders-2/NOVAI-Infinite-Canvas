#!/usr/bin/env node
// 画布助手生成中占位动效的比例：占位/骨架容器的宽高比必须等于「本次请求」的比例。
//
// 现象：助手直接在节点上跑生成（后端 _agent_start_node_generation 新建结果节点只带 runSettings、
//       不带 w/h），前端 imageLayout() 在 pending 且无显式尺寸时写死 260*2 x 180*2 = 520x360
//       （比例 1.4444），完全忽略 runSettings 里归一后的 ratio / videoAspect。
// 本检查锁住修复：单图占位框按节点 runSettings 里的请求比例算；缺参数/非法比例保持原兜底；
//       用户手点运行走的 pendingBoxSize 口径不变；第 48 轮起缩略图网格（thumbGridHtml / batchRowSlotHtml）
//       的格子跟着每张图 / 每行自己的比例（不再统一正方形）。
// 运行：node tests/test_smart_canvas_pending_ratio.js
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

// ---- 静态断言：比例只从请求参数来，兜底/网格语义不被顺手改掉 ----
ok(/function explicitRequestOutputSizeForPending\(sourceSettings\)/.test(code), 'explicitRequestOutputSizeForPending 可传入本次请求的参数');
ok(/function pendingRequestBoxForNode\(node\)/.test(code), '抽出「按节点请求参数算占位框」的入口');
ok(/pendingRequestBoxForNode\(node\)/.test(topLevelFunction(code, 'imageLayout')), 'imageLayout 的 pending 分支使用节点请求比例');
ok(/requestBox = pending && !hasExplicit \? pendingRequestBoxForNode\(node\) : null/.test(topLevelFunction(code, 'imageLayout')), '用户拉过尺寸的节点仍以显式尺寸为准');
ok(/style="width:\$\{thumb\}px;aspect-ratio:\$\{pendingAspect\}"/.test(topLevelFunction(code, 'thumbGridHtml')), '缩略图网格的占位格跟着本次请求比例（不再统一正方形）');
ok(/const size = 'width:' \+ thumb \+ 'px;aspect-ratio:' \+ ratio \+ ';'/.test(topLevelFunction(code, 'batchRowSlotHtml')), '逐行进度格跟着该行比例（不再统一正方形）');
ok(/aspect-ratio:var\(--thumb-aspect, 1\)/.test(fs.readFileSync(path.join(__dirname,'../static/css/smart-canvas.css'),'utf8')), '缩略图格子按 --thumb-aspect 走（默认 1 保住旧观感）');

// ---- 行为断言：在沙箱里跑真实函数 ----
const names = ['isApiLikeEngine','resPixelLimitFor','apiSizeTier','enumMaxSizeLevel','defaultSmartApiResolution',
    'apiAllowsAuto','parseRatioValue','parseSizeValue','apiImageSize','gcdInt','fitSourceSize','sizeForRun',
    'expectedOutputSize','explicitRequestOutputSizeForPending','ratioFollowsSource','mediaLayoutSize','singleImageLayout',
    'pendingSizeFromImageRef','pendingSourceBoxSize','displayBoxFromNaturalSize','pendingRequestBoxForNode',
    'pendingBaseBoxSize','pendingBoxSize','imageLayout'];
const sandboxSrc = [
    'const window = {};',
    fs.readFileSync(policyFile, 'utf8'),
    'const NovaSizePolicy = window.NovaSizePolicy;',
    'const SIZE_MAP = {square:{"1k":"1024x1024","2k":"2048x2048","4k":"4096x4096"},portrait:{"1k":"1024x1536"},portrait43:{"1k":"1008x1344","2k":"1536x2048"},landscape43:{"1k":"1344x1008"},landscape:{"1k":"1536x1024"},story:{"1k":"720x1280"},wide:{"1k":"1280x720","2k":"2048x1152"},ultrawide:{"1k":"1280x544"},ultratall:{"1k":"544x1280"},portrait12:{"1k":"768x1536"},landscape21:{"1k":"1536x768"},landscape54:{"1k":"1536x1216"},portrait45:{"1k":"1216x1536"}};',
    'const API_RES_LEVELS = ["1k","2k","4k"];',
    'const RES_LONG_SIDE = { "1k":1536, "2k":2048, "4k":3840 };',
    'const RES_PIXEL_LIMIT_FALLBACK = { "1k":1572864, "2k":4194304, "4k":8294400 };',
    'const MEDIA_NODE_DEFAULT_SCALE = 2;',
    'const MEDIA_GROUP_THUMB_BASE = 224;',
    'const MEDIA_GROUP_MAX_VISIBLE_ROWS = 3;',
    'const EMPTY_UPLOAD_NODE_WIDTH = 316;',
    'const EMPTY_UPLOAD_NODE_HEIGHT = 194;',
    'const tr = k => k;',
    'function isAudioMediaItem(){ return false; }',
    'function isSmartMediaNode(){ return false; }',
    'function smartGroupContainingNode(){ return null; }',
    'function mediaNodeDefaultScale(node){ const v = Number(node && node.scale); return Number.isFinite(v) && v > 0 ? v : MEDIA_NODE_DEFAULT_SCALE; }',
    'function pendingSlotsForNode(){ return 0; }',
    'function nodeRect(node){ return {x:0,y:0,width:0,height:0}; }',
    'let nodes = [];',
    'let settings = {engine:"api", apiKind:"image", model:"", ratio:"square", resolution:"1k"};',
    ...names.map(n => topLevelFunction(code, n)),
    'globalThis.__setSettings = s => { settings = s; };',
    'globalThis.__pending = (count, opts) => pendingBoxSize(count, opts || {});',
    'globalThis.__layout = (node) => imageLayout([], mediaNodeDefaultScale(node), node);',
    'globalThis.__requestBox = node => pendingRequestBoxForNode(node);',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, {filename: 'pending-ratio-sandbox.js'});
const setSettings = sandbox.__setSettings;
const pending = sandbox.__pending;
const layout = sandbox.__layout;
const requestBox = sandbox.__requestBox;
const ratio = box => box.w / Math.max(1, box.h);
const layoutRatio = box => box.width / Math.max(1, box.height);

// 用户手点运行：pendingBoxSize 单图比例 = 请求比例（改动前就是对的，这里锁住不回归）
setSettings({engine:'api', apiKind:'image', model:'', ratio:'portrait43', resolution:'1k'});
near(ratio(pending(1, {})), 3 / 4, 0.01, '3:4 单图占位框比例');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'wide', resolution:'1k'});
near(ratio(pending(1, {})), 16 / 9, 0.01, '16:9 单图占位框比例');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'square', resolution:'1k'});
near(ratio(pending(1, {})), 1, 0.001, '1:1 单图占位框比例');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'custom', customRatio:'56:75', resolution:'1k'});
near(ratio(pending(1, {})), 56 / 75, 0.02, '自定义 56:75 单图占位框比例');
// 未指定比例：与改动前一致（square 兜底）
setSettings({engine:'api', apiKind:'image', model:'', ratio:'', resolution:'1k'});
const unspecified = pending(1, {});
ok(unspecified.w === 440 && unspecified.h === 440, '未指定比例沿用 square 兜底 440x440（与改动前一致）');
// 极端比例：仍受 singleImageLayout 的 520x440 上限与 72 下限约束，不塌陷、不溢出
setSettings({engine:'api', apiKind:'image', model:'', ratio:'ultrawide', resolution:'1k'});
const uw = pending(1, {});
ok(uw.w <= 520 && uw.h >= 72 && uw.h <= 440, '超宽比例占位框仍在 520x440 约束内（实际 ' + uw.w + 'x' + uw.h + '）');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'portrait12', resolution:'1k'});
const pt = pending(1, {});
ok(pt.h <= 440 && pt.w >= 72 && pt.w <= 520, '超竖比例占位框仍在 520x440 约束内（实际 ' + pt.w + 'x' + pt.h + '）');

// 视频：videoAspect 只在调用方显式传入「本次请求参数」时生效（助手节点路径）。
// 手点走 pendingBoxSize 时不传请求参数，全局 videoAspect 不能抢走 options.ratio（改动前口径）。
setSettings({engine:'api', apiKind:'video', model:'', ratio:'square', resolution:'1k', videoAspect:'9:16'});
const videoPriority = pending(1, {ratio:{w:16, h:9}});
ok(videoPriority.w === 520 && videoPriority.h === 293, '手点视频：全局 videoAspect=9:16 不覆盖 options.ratio=16:9（改动前 520x293）');
near(ratio(pending(1, {})), 1, 0.001, '手点视频没给请求参数时全局 videoAspect 不生效 → 退回 square 兜底');
setSettings({engine:'api', apiKind:'video', model:'', ratio:'square', resolution:'1k', videoAspect:'adaptive'});
near(ratio(pending(1, {})), 1, 0.001, '视频 adaptive 不是具体比例 → 退回原兜底（square）');

// 助手直接在节点上跑生成：结果节点只有 runSettings、没有 w/h
function assistantNode(runSettings, extra){
    return Object.assign({id:'a1', type:'smart-image', pending:1, images:[], runSettings}, extra || {});
}
const box34 = layout(assistantNode({engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}));
near(layoutRatio(box34), 3 / 4, 0.01, '助手 3:4 生成中占位框比例');
ok(box34.width === 330 && box34.height === 440, '助手 3:4 占位框 = pendingBoxSize 同口径 330x440');
const box169 = layout(assistantNode({engine:'api', apiKind:'image', ratio:'wide', resolution:'1k'}));
near(layoutRatio(box169), 16 / 9, 0.01, '助手 16:9 生成中占位框比例');
const boxVideo = layout(assistantNode({engine:'api', apiKind:'video', videoAspect:'9:16', ratio:'square'}));
near(layoutRatio(boxVideo), 9 / 16, 0.01, '助手视频 9:16 生成中占位框比例');
const directVideo = requestBox({runSettings:{engine:'api', apiKind:'video', videoAspect:'9:16'}});
ok(directVideo.w === 247 && directVideo.h === 440, '助手视频 9:16 经 pendingRequestBoxForNode 仍得 247x440');
near(directVideo.w / directVideo.h, 9 / 16, 0.01, '助手视频占位框比例仍 ≈ 9:16');
// 兜底（验收①，单独断言）：无 runSettings / 比例非法 / videoAspect=adaptive 必须逐字保持改动前的 260*2 x 180*2，
// 不能被「按比例算」带跑。下面四条各自独立命中 pendingRequestBoxForNode 的不同 null 分支。
const boxFallback = layout(assistantNode(null));
ok(boxFallback.width === 520 && boxFallback.height === 360, '节点没有 runSettings 时保持原 520x360 兜底');
const boxAdaptive = layout(assistantNode({engine:'api', apiKind:'video', videoAspect:'adaptive', ratio:'square'}));
ok(boxAdaptive.width === 520 && boxAdaptive.height === 360, '节点 videoAspect=adaptive（非具体比例）时保持原 520x360 兜底');
const boxBadAspect = layout(assistantNode({engine:'api', apiKind:'video', videoAspect:'abc', ratio:'square'}));
ok(boxBadAspect.width === 520 && boxBadAspect.height === 360, '节点 videoAspect 非法时保持原 520x360 兜底');
const boxBadRunSettings = layout(assistantNode(['not-an-object']));
ok(boxBadRunSettings.width === 520 && boxBadRunSettings.height === 360, '节点 runSettings 非对象时保持原 520x360 兜底');
// 用户拉过尺寸的节点：显式 w/h 优先于请求比例
const boxManual = layout(assistantNode({engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}, {w:400, h:400}));
ok(boxManual.width === 400 && boxManual.height === 400, '显式尺寸的节点不被请求比例覆盖');
// 比例变化 → 同一节点重算即更新（实时更新）
const grown = layout(assistantNode({engine:'api', apiKind:'image', ratio:'portrait43', resolution:'1k'}));
const changed = layout(assistantNode({engine:'api', apiKind:'image', ratio:'wide', resolution:'1k'}));
ok(grown.width !== changed.width || grown.height !== changed.height, '比例变化后占位框尺寸随之变化');

// ---- 第 47 轮：节点 runSettings 没写比例时，占位框必须跟本次请求（全局/编辑器设置）的比例，而不是方形 ----
setSettings({engine:'api', apiKind:'image', model:'', ratio:'portrait43', resolution:'1k'});
const noRatioNode = layout(assistantNode({engine:'api', apiKind:'image', provider_id:'x', model:'y'}));
near(layoutRatio(noRatioNode), 3 / 4, 0.01, '助手节点没写 ratio 时占位框跟全局 3:4，不能是 1:1');
ok(noRatioNode.width !== noRatioNode.height, '助手节点没写 ratio 时宽高不能相同（实际 ' + noRatioNode.width + 'x' + noRatioNode.height + '）');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'wide', resolution:'1k'});
const noRatioWide = layout(assistantNode({engine:'api', apiKind:'image', provider_id:'x', model:'y'}));
near(layoutRatio(noRatioWide), 16 / 9, 0.02, '助手节点没写 ratio 时占位框跟全局 16:9');
setSettings({engine:'api', apiKind:'image', model:'', ratio:'square', resolution:'1k'});
near(layoutRatio(layout(assistantNode({engine:'api', apiKind:'image', provider_id:'x'}))), 1, 0.001, '全局是 1:1 时占位框仍为正方形（不引入回归）');
// 「适配比例」算不出具体比例时不能冒充 1:1：返回 null，交由调用方按源素材兜底
ok(sandbox.__requestBox({runSettings:{engine:'api', apiKind:'image', ratio:'source'}}) === null, 'ratio=source 且算不出比例时不再冒充方形请求');
ok(sandbox.__requestBox({runSettings:{engine:'api', apiKind:'image', ratio:'custom'}}) === null, 'ratio=custom 什么都没填时不再冒充方形请求');
ok(sandbox.__requestBox({runSettings:{engine:'api', apiKind:'image', ratio:'source', customRatio:'3:4'}}) !== null, 'ratio=source 有具体比例时照常返回尺寸');

console.log(label + '：' + pass + ' 项通过');
if(fails.length){ fails.forEach(msg => console.error('  ✗ ' + msg)); console.error('失败 ' + fails.length + ' 项'); process.exit(1); }
console.log('全部通过');
