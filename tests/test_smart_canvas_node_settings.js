#!/usr/bin/env node
/* 旧智能画布（smart-canvas）节点参数独立 + 旧画布迁移：
   1) 已存在节点的参数以自己写死的 runSettings 为准，不再读“按类型记住的最近设置”；
   2) 新建 / 复制 / 粘贴 / 模板 / 批量 / 导入 都深拷贝，两个同类节点互不影响；
   3) 载入没有 runSettings 的旧画布时一次性写死（不提示、不进撤销、幂等），没有可用模型时不写；
   4) 语法检查 + 9:16 占位/展示仍按真实比例（不退回正方形）。
   跑法：node tests/test_smart_canvas_node_settings.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const jsPath = path.join(root, 'static/js/smart-canvas.js');
const js = fs.readFileSync(jsPath, 'utf8');
const html = fs.readFileSync(path.join(root, 'static/smart-canvas.html'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label + '（实际 ' + JSON.stringify(a) + '）');

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

// ---- 1. 语法 + 版本号 ----
const check = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf8' });
ok(check.status === 0, 'node --check static/js/smart-canvas.js 通过' + (check.status ? '：' + check.stderr : ''));
const versionMatch = html.match(/smart-canvas\.js\?v=([0-9.]+)/);
const jsMtime = Math.floor(fs.statSync(jsPath).mtimeMs / 1000);
ok(versionMatch && versionMatch[1] === '1.0.143.' + jsMtime, 'smart-canvas.html 的 ?v= 跟着 smart-canvas.js 的 mtime 走');

// ---- 2. 静态接线 ----
const forNode = topLevelFunction(js, 'smartSettingsForNode');
const forNew = topLevelFunction(js, 'smartSettingsForNewNode');
const seedOne = topLevelFunction(js, 'seedSmartNodeRunSettings');
const seedAll = topLevelFunction(js, 'seedMissingSmartNodeRunSettings');
const renderFn = topLevelFunction(js, 'render');
const loadFn = topLevelFunction(js, 'loadCanvas');
const cloneFn = topLevelFunction(js, 'cloneSmartNode');
const serialFn = topLevelFunction(js, 'serializableSmartNode');
const pasteFn = topLevelFunction(js, 'pasteNodes');
const dupFn = topLevelFunction(js, 'duplicateSelectedSmartNodes');
const importFn = topLevelFunction(js, 'insertSmartWorkflowIntoCanvas');
ok(forNode && !/recentSmartSettingsForMode\(/.test(forNode), '已有节点的 smartSettingsForNode 不再读最近设置');
ok(/smartSettingsBaseForNode\(node, \{includeRecent: !isSmartRunnableNode\(node\)\}\)/.test(forNode), '只对非生成节点保留旧兜底');
ok(/smartSettingsBaseForNode\(node, \{includeRecent: true\}\)/.test(forNew), '新节点才允许继承最近一次设置');
ok(/settingsForStorage\(candidate\)/.test(seedOne), '种子写入用 settingsForStorage（深拷贝）');
ok(/hasSmartNodeRunSettings\(node\)/.test(seedOne), '已写死的节点直接跳过（幂等）');
ok(seedAll && seedAll.includes('(nodes || [])') && seedAll.includes('seedSmartNodeRunSettings(node)'), '批量迁移遍历节点');
ok(/seedMissingSmartNodeRunSettings\(\)/.test(renderFn), '任何节点入画布后第一次渲染就写死设置');
ok(/seededNodeSettings/.test(loadFn) && /seedMissingSmartNodeRunSettings\(\)/.test(loadFn), '画布载入后跑一次迁移');
ok(loadFn.includes('seededNodeSettings) scheduleSave()'), '迁移有改动时自动保存');
ok(loadFn.includes("|| seededNodeSettings)\n            ? '' : canvasContentSignature"), '迁移有改动时签名置空，保证一定落盘');
ok(/if\(seedMissingSmartNodeRunSettings\(\)\) scheduleSave\(\)/.test(renderFn), '首次渲染写死设置后自动保存');
ok(/JSON\.parse\(JSON\.stringify\(node\)\)/.test(cloneFn), '复制/粘贴/副本走深拷贝');
ok(/JSON\.parse\(JSON\.stringify\(node \|\| \{\}\)\)/.test(serialFn), '导出/导入走深拷贝');
ok(/cloneSmartNode\(/.test(pasteFn) && /cloneSmartNode\(/.test(dupFn), '粘贴与副本复用深拷贝');
ok(/serializableSmartNode\(source\)/.test(importFn), '导入工作流复用深拷贝');
ok(/runSettings/.test(topLevelFunction(js, 'createPendingOutputFromSource')), '生成中的结果槽也写死一份设置');
ok(/settingsForStorage\(options\.requestSettings/.test(topLevelFunction(js, 'createPendingOutputFromSource')), '结果槽优先用本次请求的设置');
const singleLayoutFn = topLevelFunction(js, 'singleImageLayout');
ok(/const fit = Math\.min\(maxW \/ naturalW, maxH \/ naturalH\)/.test(singleLayoutFn), '单图按真实像素等比缩放（不会塞成正方形）');
const imageLayoutFn = topLevelFunction(js, 'imageLayout');
ok(/const requestBox = pending && !hasExplicit \? pendingRequestBoxForNode\(node\) : null/.test(imageLayoutFn), '生成中占位框按本次请求比例');
ok(/if\(requestBox\) return \{cols:1, rows:1, width:requestBox\.w, height:requestBox\.h/.test(imageLayoutFn), '占位框用请求比例而不是固定 260x180');

// ---- 3. 行为：用 vm 跑真实的参数解析/种子函数 ----
const src = [
    'let settings = {engine:"api",apiKind:"image",model:"canvas-model",ratio:"square",videoModel:"",audioModel:"",msgenModel:"zimage",comfyWorkflow:"",rhConfigKey:"",camera:{on:false,body:0},videoTempShLinks:[]};',
    'let initialSmartSettings = cloneSmartSettings(settings);',
    'let canvasDefaultSmartSettings = cloneSmartSettings(settings);',
    'let recentSmartSettingsByMode = {"api:image": {engine:"api",apiKind:"image",model:"recent-model",ratio:"landscape",camera:{on:false,body:1},videoTempShLinks:[]}};',
    'let comfyWorkflows = []; let apiProviders = []; let nodes = [];',
    'function stripOutpaintDisplaySettings(s){ return s; }',
    'function withOutpaintDisplaySettings(node, s){ return s; }',
    'function normalizeSmartVideoModeSettings(s){ return s; }',
    'function sanitizeSmartApiSelection(s){ return s; }',
    'function isVideoMediaItem(item){ return Boolean(item && item.kind === "video"); }',
    'function isApiLikeEngine(engine){ return ["api","volcengine"].includes(String(engine || "").toLowerCase()); }',
    'function smartSettingsModeKey(s){ const k = s.apiKind === "video" ? "video" : s.apiKind === "audio" ? "audio" : "image"; return "api:" + k; }',
    'function recentSmartSettingsForMode(key){ return recentSmartSettingsByMode[key] ? cloneSmartSettings(recentSmartSettingsByMode[key]) : {}; }',
].join('\n');
const fnNames = ['cloneSmartSettings','settingsForStorage','smartSettingsBaseForNode','smartSettingsForNode','smartSettingsForNewNode','hasSmartNodeRunSettings','smartSettingsHasUsableSelection','seedSmartNodeRunSettings','seedMissingSmartNodeRunSettings','isSmartImageNode','isSmartVideoNode','isSmartAudioNode','isSmartMediaNode','isSmartGroupNode','isSmartBatchNode','isSmartRunnableNode'];
let body = src + '\n';
for(const name of fnNames){
    const fn = topLevelFunction(js, name);
    if(!fn) throw new Error('missing function ' + name);
    body += fn + '\n';
}
body += 'globalThis.__t = {'
    + fnNames.map(n => n + ':' + n).join(',')
    + ', setNodes: ns => { nodes = ns; },'
    + ' setDefaults: s => { canvasDefaultSmartSettings = cloneSmartSettings(s); },'
    + ' setRecent: r => { recentSmartSettingsByMode = r; },'
    + ' getNodes: () => nodes };\n';
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(body, sandbox);
const api = sandbox.__t;

// 3.1 已有节点不读最近设置；新节点才继承
const a = { id:'a', type:'smart-image' };
const b = { id:'b', type:'smart-image' };
api.setNodes([a, b]);
eq(api.smartSettingsForNode(a).model, 'canvas-model', '旧节点解析用画布默认，不读最近设置');
eq(api.smartSettingsForNewNode(a).model, 'recent-model', '新建节点才继承最近一次设置');
eq(api.smartSettingsForNode(a).ratio, 'square', '旧节点比例不跟最近设置变');

// 3.2 载入迁移：没有 runSettings 的节点写死一份（深拷贝），重复调用幂等
eq(api.seedMissingSmartNodeRunSettings(), true, '迁移第一次有改动');
eq(a.runSettings.model, 'recent-model', '迁移把最近设置写死进节点');
eq(b.runSettings.model, 'recent-model', '同类节点也各自写死');
ok(a.runSettings !== b.runSettings, '两个节点 params 不共享');
ok(a.runSettings.camera !== b.runSettings.camera, '嵌套 camera 不共享');
const aRef = a.runSettings, bRef = b.runSettings;
eq(api.seedMissingSmartNodeRunSettings(), false, '重复迁移不再写（幂等）');
ok(a.runSettings === aRef && b.runSettings === bRef, '幂等时不换对象');
api.setRecent({ 'api:image': { model:'changed-later', ratio:'ultrawide', camera:{on:false,body:9} } });
eq(a.runSettings.model, 'recent-model', '迁移后最近设置再变，节点不跟着变');
eq(b.runSettings.model, 'recent-model', '另一个节点也不跟着变');

// 3.3 改一个节点，另一个完全不变；序列化也不变
a.runSettings.ratio = 'portrait';
a.runSettings.camera.on = true;
a.runSettings.camera.body = 5;
eq(api.smartSettingsForNode(a).ratio, 'portrait', 'A 用自己的比例');
eq(api.smartSettingsForNode(b).ratio, 'landscape', 'B 的比例不动');
eq(api.smartSettingsForNode(b).camera.on, false, 'B 的 camera 不动');
const bJson = JSON.stringify(api.smartSettingsForNode(b));
a.runSettings.size = '4k';
eq(JSON.stringify(api.smartSettingsForNode(b)), bJson, '改 A 后 B 的序列化结果不变');

// 3.4 已有效写死的节点不动（引用都不换）
const c = { id:'c', type:'smart-image', runSettings:{ engine:'api', apiKind:'image', model:'own-model', ratio:'landscape', camera:{on:false,body:2} } };
const cRef = c.runSettings;
api.setNodes([c]);
eq(api.seedMissingSmartNodeRunSettings(), false, '已写死且有效的节点不迁移');
ok(c.runSettings === cRef, '有效节点对象原样保留');

// 3.5 没有可用模型时不写
api.setDefaults({ engine:'api', apiKind:'image', model:'', ratio:'square', videoTempShLinks:[] });
api.setRecent({});
const d = { id:'d', type:'smart-image' };
api.setNodes([d]);
eq(api.seedMissingSmartNodeRunSettings(), false, '该类型没有可用模型时不写');
eq(d.runSettings, undefined, '不塞空 runSettings');

// 3.6 视频/音频节点也按各自类型写死，互不共享
api.setDefaults({ engine:'api', apiKind:'image', videoModel:'video-model', audioModel:'audio-model', model:'image-model', msgenModel:'zimage', ratio:'square', videoTempShLinks:[] });
api.setRecent({});
const v = { id:'v', type:'smart-video' };
const au = { id:'au', type:'smart-audio' };
api.setNodes([v, au]);
eq(api.seedMissingSmartNodeRunSettings(), true, '视频/音频节点也迁移');
eq(v.runSettings.videoModel, 'video-model', '视频节点写视频模型');
eq(au.runSettings.audioModel, 'audio-model', '音频节点写音频模型');
ok(v.runSettings !== au.runSettings, '不同类型节点参数也各自独立');

if(fails.length){
    console.error('[FAIL] ' + fails.length + ' 项未通过：');
    fails.forEach(label => console.error(' - ' + label));
    process.exit(1);
}
console.log('[PASS] smart-canvas 节点参数独立 / 旧画布迁移 / 深拷贝入口 / 版本号（' + pass + ' 项）');