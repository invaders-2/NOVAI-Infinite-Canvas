#!/usr/bin/env node
// 供应商列表只保留「已配置 Key」的供应商（has_key !== false）。
//
// 口径与 static/gpt-chat.html 一致：p.enabled !== false && p.has_key !== false && (p[key]||[]).length。
// 没配 Key 的供应商不出现在模型/供应商下拉里；过滤后为空就真的为空，
// 不允许再被 defaultApiProviders() / 硬编码 comfly 兜底加回来。
//
// 运行：node tests/test_provider_has_key_filter.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => { ok(JSON.stringify(a) === JSON.stringify(b), (msg || '') + '（实际 ' + JSON.stringify(a) + '）'); };

function read(rel){
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

const smartSrc = read('static/js/smart-canvas.js');
const canvasSrc = read('static/js/canvas.js');
const assetSrc = read('static/js/asset-manager.js');

// ---- 静态断言：不允许把未配置供应商兜底加回来 ----
const smartVideoSrc = extractFn(smartSrc, 'videoApiProviders');
ok(!smartVideoSrc.includes("id:'comfly'"), 'smart videoApiProviders 不再硬编码 comfly 兜底');
ok(!smartVideoSrc.includes('DEFAULT_VIDEO_MODELS'), 'smart videoApiProviders 不再兜底默认视频模型列表');
ok(smartVideoSrc.includes('p.has_key !== false'), 'smart videoApiProviders 加了 has_key 过滤');

for(const name of ['imageApiProviders', 'chatApiProviders', 'videoApiProviders']){
    const src = extractFn(canvasSrc, name);
    ok(!src.includes('defaultApiProviders'), 'canvas ' + name + ' 不再用 defaultApiProviders() 兜底');
    ok(src.includes('p.has_key !== false') || src.includes('provider.has_key !== false'),
        'canvas ' + name + ' 加了 has_key 过滤');
}
for(const name of ['imageProviders', 'chatApiProviders', 'videoApiProviders']){
    ok(extractFn(smartSrc, name).includes('p.has_key !== false'), 'smart ' + name + ' 加了 has_key 过滤');
}
ok(extractFn(assetSrc, 'localCaptionProviders').includes('p.has_key !== false'),
    'asset-manager localCaptionProviders 加了 has_key 过滤');

for(const [src, name] of [[smartSrc, 'resolveChatProviderId'], [canvasSrc, 'resolveChatProviderId'],
        [canvasSrc, 'resolveVideoProviderId'], [canvasSrc, 'resolveProviderId']]){
    ok(!extractFn(src, name).includes("'comfly'"), name + ' 不再回落硬编码 comfly');
}

// ---- 行为断言：在沙箱里跑真实函数 ----
const PAIR = [
    {id:'a', name:'A', enabled:true, has_key:true, chat_models:['m1'], image_models:['img1'], video_models:['vid1']},
    {id:'b', name:'B', enabled:true, has_key:false, chat_models:['m2'], image_models:['img2'], video_models:['vid2']},
];
const MJ_PAIR = [
    {id:'a', name:'A', enabled:true, has_key:true, protocol:'apimart'},
    {id:'b', name:'B', enabled:true, has_key:false, protocol:'apimart'},
];
const idsOf = list => list.map(p => p.id);

// ===== 智能画布 smart-canvas.js =====
const smartSandbox = [
    'let apiProviders = [];',
    'function volcengineVideoModels(){ return []; }',
    extractFn(smartSrc, 'imageProviders'),
    extractFn(smartSrc, 'chatApiProviders'),
    extractFn(smartSrc, 'videoApiProviders'),
    extractFn(smartSrc, 'providerVideoModels'),
    extractFn(smartSrc, 'resolveChatProviderId'),
    'globalThis.__s = {',
    '    setProviders(v){ apiProviders = v; },',
    '    image(){ return imageProviders(); },',
    '    chat(){ return chatApiProviders(); },',
    '    video(){ return videoApiProviders(); },',
    '    videoModels(id){ return providerVideoModels(id); },',
    '    resolveChat(id){ return resolveChatProviderId(id); }',
    '};'
].join('\n');
const so = {};
vm.runInNewContext(smartSandbox, so, {filename:'static/js/smart-canvas.js'});
const s = so.__s;

s.setProviders(PAIR);
eq(idsOf(s.image()), ['a'], 'smart imageProviders 只返回已配 Key 的 a');
eq(idsOf(s.chat()), ['a'], 'smart chatApiProviders 只返回已配 Key 的 a');
eq(idsOf(s.video()), ['a'], 'smart videoApiProviders 只返回已配 Key 的 a');

s.setProviders(PAIR.map(p => ({...p, has_key:false})));
eq(idsOf(s.image()), [], 'smart imageProviders 全部无 Key 时返回空');
eq(idsOf(s.chat()), [], 'smart chatApiProviders 全部无 Key 时返回空');
eq(idsOf(s.video()), [], 'smart videoApiProviders 全部无 Key 时返回空');
s.setProviders([]);
eq(idsOf(s.image()), [], 'smart imageProviders 无任何 provider 时返回空，不兜底');
eq(idsOf(s.chat()), [], 'smart chatApiProviders 无任何 provider 时返回空，不兜底');
eq(idsOf(s.video()), [], 'smart videoApiProviders 无任何 provider 时返回空，不兜底');
ok(!idsOf(s.video()).includes('comfly'), 'smart videoApiProviders 不再出现 comfly');
eq(s.resolveChat(''), '', 'smart resolveChatProviderId 无已配置供应商时返回空而不是 comfly');
eq(s.videoModels(''), [], 'smart providerVideoModels 无匹配 provider 时返回空而不是默认视频模型');
eq(s.videoModels('comfly'), [], 'smart providerVideoModels 对未配置的 comfly 不再返回默认视频模型');

// ===== 经典画布 canvas.js =====
const canvasSandbox = [
    'let apiProviders = [];',
    'function uniqueModels(list){ const seen = new Set(); return (list || []).map(x => String(x || "").trim()).filter(x => { if(!x || seen.has(x)) return false; seen.add(x); return true; }); }',
    'function modelscopeImageModels(){ return ["ms-builtin"]; }',
    extractFn(canvasSrc, 'providerImageModels'),
    extractFn(canvasSrc, 'imageApiProviders'),
    extractFn(canvasSrc, 'midjourneyApiProviders'),
    extractFn(canvasSrc, 'chatApiProviders'),
    extractFn(canvasSrc, 'videoApiProviders'),
    extractFn(canvasSrc, 'providerById'),
    extractFn(canvasSrc, 'resolveProviderId'),
    extractFn(canvasSrc, 'resolveImageProviderId'),
    extractFn(canvasSrc, 'resolveMidjourneyProviderId'),
    extractFn(canvasSrc, 'resolveChatProviderId'),
    extractFn(canvasSrc, 'resolveVideoProviderId'),
    'globalThis.__c = {',
    '    setProviders(v){ apiProviders = v; },',
    '    image(){ return imageApiProviders(); },',
    '    midjourney(){ return midjourneyApiProviders(); },',
    '    chat(){ return chatApiProviders(); },',
    '    video(){ return videoApiProviders(); },',
    '    resolveProvider(id){ return resolveProviderId(id); },',
    '    resolveImage(id){ return resolveImageProviderId(id); },',
    '    resolveMj(id){ return resolveMidjourneyProviderId(id); },',
    '    resolveChat(id){ return resolveChatProviderId(id); },',
    '    resolveVideo(id){ return resolveVideoProviderId(id); }',
    '};'
].join('\n');
const co = {};
vm.runInNewContext(canvasSandbox, co, {filename:'static/js/canvas.js'});
const c = co.__c;

c.setProviders(PAIR);
eq(idsOf(c.image()), ['a'], 'canvas imageApiProviders 只返回已配 Key 的 a');
eq(idsOf(c.chat()), ['a'], 'canvas chatApiProviders 只返回已配 Key 的 a');
eq(idsOf(c.video()), ['a'], 'canvas videoApiProviders 只返回已配 Key 的 a');
c.setProviders(MJ_PAIR);
eq(idsOf(c.midjourney()), ['a'], 'canvas midjourneyApiProviders 只返回已配 Key 的 a');

c.setProviders(PAIR.map(p => ({...p, has_key:false})));
eq(idsOf(c.image()), [], 'canvas imageApiProviders 全无 Key 时返回空');
eq(idsOf(c.chat()), [], 'canvas chatApiProviders 全无 Key 时返回空');
eq(idsOf(c.video()), [], 'canvas videoApiProviders 全无 Key 时返回空');
c.setProviders([]);
eq(idsOf(c.image()), [], 'canvas imageApiProviders 无 provider 时返回空，不用默认列表兜底');
eq(idsOf(c.chat()), [], 'canvas chatApiProviders 无 provider 时返回空，不用默认列表兜底');
eq(idsOf(c.video()), [], 'canvas videoApiProviders 无 provider 时返回空，不用默认列表兜底');
eq(c.resolveProvider('comfly'), '', 'canvas resolveProviderId 不再把未配置 comfly 当可用供应商');
eq(c.resolveImage('comfly'), '', 'canvas resolveImageProviderId 无已配置供应商时返回空');
eq(c.resolveMj(''), '', 'canvas resolveMidjourneyProviderId 无已配置时返回空');
eq(c.resolveChat(''), '', 'canvas resolveChatProviderId 无已配置供应商时返回空而不是 comfly');
eq(c.resolveVideo(''), '', 'canvas resolveVideoProviderId 无已配置供应商时返回空而不是 comfly');

// ===== 素材库 asset-manager.js =====
const assetSandbox = [
    'let apiProviders = [];',
    extractFn(assetSrc, 'localCaptionProviders'),
    'globalThis.__a = { setProviders(v){ apiProviders = v; }, list(){ return localCaptionProviders(); } };'
].join('\n');
const ao = {};
vm.runInNewContext(assetSandbox, ao, {filename:'static/js/asset-manager.js'});
const a = ao.__a;

a.setProviders(PAIR);
eq(idsOf(a.list()), ['a'], 'asset-manager localCaptionProviders 只返回已配 Key 的 a');
a.setProviders(PAIR.map(p => ({...p, has_key:false})));
eq(idsOf(a.list()), [], 'asset-manager localCaptionProviders 全无 Key 时返回空');
a.setProviders([]);
eq(idsOf(a.list()), [], 'asset-manager localCaptionProviders 无 provider 时返回空');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
