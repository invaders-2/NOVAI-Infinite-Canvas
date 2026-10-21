#!/usr/bin/env node
// APIMart 判定补国内备用域名 apib.ai：apib.ai / api.apib.ai 与 apimart.ai 是同一网关（实测；官方文档未记载）。
//
// 覆盖设置 / 在线生图 / 素材库 / 旧画布共八处判定：
//   web/src/shell/settings/api/parts/OverviewBento.vue  isApimart
//   web/src/pages/online/providers.js                   protocolOf
//   web/src/pages/assets/lib/avatar.js                  providerPlatform
//   static/js/api-settings.js                           isApimartProviderContext
//   static/js/smart-canvas.js                           videoProviderPlatform
//   static/js/asset-manager.js                          providerAvatarPlatform
//   static/js/canvas.js                                 midjourneyApiProviders（域名正则）
//   static/online.html                                  providerProtocol（旧在线生图页）
//
// 运行：node tests/test_apimart_domestic_host.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => { ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）'); };

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
function extractComputed(src, name){
    const start = src.indexOf('const ' + name + ' = computed(');
    if(start < 0) throw new Error('未找到 computed ' + name);
    const end = src.indexOf('\n});', start);
    if(end < 0) throw new Error('未找到 computed 结尾 ' + name);
    return src.slice(start, end + 4);
}
function extractBlock(src, startMarker, endMarker){
    const start = src.indexOf(startMarker);
    if(start < 0) throw new Error('未找到 ' + startMarker);
    const end = src.indexOf(endMarker, start);
    if(end < 0) throw new Error('未找到 ' + endMarker);
    return src.slice(start, end + endMarker.length);
}

const overviewSrc = read('web/src/shell/settings/api/parts/OverviewBento.vue');
const onlineSrc = read('web/src/pages/online/providers.js');
const avatarSrc = read('web/src/pages/assets/lib/avatar.js');
const settingsSrc = read('static/js/api-settings.js');
const smartSrc = read('static/js/smart-canvas.js');
const assetSrc = read('static/js/asset-manager.js');
const canvasSrc = read('static/js/canvas.js');
const onlineHtmlSrc = read('static/online.html');
const settingsHtmlSrc = read('static/api-settings.html');
const midjourneySnippet = extractFn(canvasSrc, 'midjourneyApiProviders');
const onlineHtmlSnippet = extractBlock(onlineHtmlSrc, 'function providerProtocol(id){', "return 'api';");

// ---- 静态断言：每处判定都要同时命中 apimart.ai 与 apib.ai ----
const SITES = [
    ['OverviewBento.vue isApimart', extractComputed(overviewSrc, 'isApimart'), false],
    ['online/providers.js protocolOf', extractFn(onlineSrc, 'protocolOf'), true],
    ['assets/avatar.js providerPlatform', extractFn(avatarSrc, 'providerPlatform'), true],
    ['api-settings.js isApimartProviderContext', extractFn(settingsSrc, 'isApimartProviderContext'), false],
    ['smart-canvas.js videoProviderPlatform', extractFn(smartSrc, 'videoProviderPlatform'), true],
    ['asset-manager.js providerAvatarPlatform', extractFn(assetSrc, 'providerAvatarPlatform'), true],
    ['static/online.html providerProtocol', onlineHtmlSnippet, true],
];
ok(midjourneySnippet.includes('apimart') && midjourneySnippet.includes('apib'),
    'canvas.js midjourneyApiProviders 正则同时命中 apimart / apib');
ok(midjourneySnippet.includes('(?:\\/|$)') && midjourneySnippet.includes('/i.test('),
    'canvas.js midjourneyApiProviders 保留域名边界与大小写不敏感');
for(const [label, snippet, checkProtocol] of SITES){
    ok(snippet.includes('apimart.ai'), label + ' 命中 apimart.ai');
    ok(snippet.includes('apib.ai'), label + ' 命中 apib.ai');
    if(checkProtocol) ok(snippet.includes("'apimart'"), label + ' 保留协议名 apimart 判定');
}

// ---- 行为断言：在沙箱里跑真实函数 ----
function runSandbox(parts, filename){
    const out = {};
    vm.runInNewContext(parts.join('\n'), out, {filename});
    return out;
}

// api-settings.js：设置页「APIMart 国内请求地址」提示的判定
const settingsOut = runSandbox([
    'let baseInput = null;',
    extractFn(settingsSrc, 'isApimartProviderContext'),
    'globalThis.__s = {',
    '    setBase(v){ baseInput = v ? {value: v} : null; },',
    '    check(item){ return isApimartProviderContext(item); }',
    '};'
], 'static/js/api-settings.js');
const settings = settingsOut.__s;
eq(settings.check({base_url: 'https://api.apib.ai'}), true, 'settings 认 https://api.apib.ai');
eq(settings.check({base_url: 'https://apib.ai'}), true, 'settings 认 https://apib.ai');
eq(settings.check({base_url: 'https://api.apimart.ai'}), true, 'settings 认 https://api.apimart.ai');
eq(settings.check({base_url: 'https://api.openai.com'}), false, 'settings 不误判 openai');
settings.setBase('https://api.apib.ai');
eq(settings.check({}), true, 'settings 认输入框里的 apib.ai');
settings.setBase(null);

// ---- 国内 / 海外地址一键切换入口 ----
const APIMART_BASE_CN = 'https://apib.ai';
const APIMART_BASE_OFFICIAL = 'https://api.apimart.ai';
ok(overviewSrc.includes('用国内地址') && overviewSrc.includes('applyApimartBase(APIMART_BASE_CN)'),
    'Vue 概览有「用国内地址」入口');
ok(overviewSrc.includes('用官方地址') && overviewSrc.includes('applyApimartBase(APIMART_BASE_OFFICIAL)'),
    'Vue 概览有「用官方地址」入口');
ok(overviewSrc.includes("const APIMART_BASE_CN = '" + APIMART_BASE_CN + "'")
    && overviewSrc.includes("const APIMART_BASE_OFFICIAL = '" + APIMART_BASE_OFFICIAL + "'"),
    'Vue 两个切换地址常量正确');
ok(overviewSrc.includes('S.form.base = base'), 'Vue 切换只写表单 base');

ok(settingsHtmlSrc.includes('onclick="applyApimartBase(\'' + APIMART_BASE_CN + '\')"'),
    'legacy 设置页有「用国内地址」入口');
ok(settingsHtmlSrc.includes('onclick="applyApimartBase(\'' + APIMART_BASE_OFFICIAL + '\')"'),
    'legacy 设置页有「用官方地址」入口');

const switchSandbox = { Event: class Event { constructor(type){ this.type = type; } } };
vm.runInNewContext([
    'let baseInput = null;',
    extractFn(settingsSrc, 'applyApimartBase'),
    'globalThis.__b = {',
    '    bind(el){ baseInput = el; },',
    '    run(url){ applyApimartBase(url); }',
    '};'
].join('\n'), switchSandbox, {filename:'static/js/api-settings.js'});
const switcher = switchSandbox.__b;
const fakeInput = { value: '', events: [], dispatchEvent(event){ this.events.push(event.type); } };
switcher.bind(fakeInput);
switcher.run(APIMART_BASE_CN);
eq(fakeInput.value, APIMART_BASE_CN, 'legacy 点「用国内地址」后输入框变成 apib.ai');
ok(fakeInput.events.includes('input'), 'legacy 切换会派发 input 事件（走既有保存/脏标记链路）');
fakeInput.events = [];
switcher.run(APIMART_BASE_OFFICIAL);
eq(fakeInput.value, APIMART_BASE_OFFICIAL, 'legacy 点「用官方地址」后输入框变成 api.apimart.ai');
ok(fakeInput.events.includes('input'), 'legacy 官方地址切换也会派发 input 事件');

// asset-manager.js：素材「注册到平台」的平台键
const assetOut = runSandbox([
    extractFn(assetSrc, 'providerAvatarPlatform'),
    'globalThis.__a = { platform(p){ return providerAvatarPlatform(p); } };'
], 'static/js/asset-manager.js');
const asset = assetOut.__a;
eq(asset.platform({base_url: 'https://api.apib.ai'}), 'apimart', 'asset 认 apib.ai');
eq(asset.platform({base_url: 'https://api.apimart.ai'}), 'apimart', 'asset 认 apimart.ai');
eq(asset.platform({protocol: 'apimart', base_url: ''}), 'apimart', 'asset 认显式 apimart 协议');
eq(asset.platform({base_url: 'https://api.openai.com'}), '', 'asset 不误判 openai');

// smart-canvas.js：画布节点的认证平台键
const smartOut = runSandbox([
    'let apiProviders = [];',
    extractFn(smartSrc, 'videoProviderPlatform'),
    'globalThis.__c = {',
    '    set(list){ apiProviders = list; },',
    '    platform(id){ return videoProviderPlatform(id); }',
    '};'
], 'static/js/smart-canvas.js');
const smart = smartOut.__c;
smart.set([{id: 'a', base_url: 'https://api.apib.ai'}, {id: 'b', base_url: 'https://api.apimart.ai'}]);
eq(smart.platform('a'), 'apimart', 'smart 认 apib.ai');
eq(smart.platform('b'), 'apimart', 'smart 认 apimart.ai');
smart.set([{id: 'c', base_url: 'https://api.openai.com'}]);
eq(smart.platform('c'), '', 'smart 不误判 openai');

// canvas.js：Midjourney 节点可选的平台（域名正则）
const midjourneyOut = runSandbox([
    'let apiProviders = [];',
    extractFn(canvasSrc, 'midjourneyApiProviders'),
    'globalThis.__m = {',
    '    set(list){ apiProviders = list; },',
    '    ids(){ return midjourneyApiProviders().map(p => p.id); }',
    '};'
], 'static/js/canvas.js');
const midjourney = midjourneyOut.__m;
const provider = (id, extra) => Object.assign({id, enabled: true, has_key: true}, extra);
midjourney.set([
    provider('a', {base_url: 'https://api.apib.ai'}),
    provider('b', {base_url: 'https://api.apimart.ai'}),
    provider('c', {base_url: 'https://api.apib.ai/v1'}),
    provider('d', {protocol: 'apimart', base_url: ''}),
    provider('e', {base_url: 'https://api.openai.com'}),
    provider('f', {base_url: 'https://notapib.ai.example.com'}),
]);
eq(midjourney.ids().join(','), 'a,b,c,d', 'canvas midjourney 认 apib.ai / apimart.ai / 显式协议，不误判 openai 与 notapib.ai');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
