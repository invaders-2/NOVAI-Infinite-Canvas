#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }
function fn(name){
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start);
    if(start < 0 || end < 0) throw new Error('找不到函数 ' + name);
    return source.slice(start, end + 2);
}

const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext([
    'let settings = {engine:"api",apiKind:"image",provider_id:"image-provider",model:"image-model"};',
    'let videoMoreDockOpen = true;',
    'const node = {id:"batch-1",type:"smart-batch",runSettings:{}};',
    'let persistCalls = 0, renderCalls = 0, previewCalls = 0, thumbCalls = 0, saveCalls = 0;',
    'function isSmartBatchNode(value){ return value === node; }',
    'function applyRecentSmartSettingsForCurrentMode(){}',
    'function persistActiveSmartSettings(){ persistCalls += 1; node.runSettings = {...settings}; }',
    'function renderDynamicParams(){ renderCalls += 1; }',
    'function syncBatchKindSwitch(){ previewCalls += 1; }',
    'function renderInputThumbsRow(){ thumbCalls += 1; }',
    'function scheduleSave(){ saveCalls += 1; }',
    fn('setSmartBatchApiKind'),
    'globalThis.__switch = {',
    '    run(kind){ setSmartBatchApiKind(kind,node); },',
    '    settings(){ return settings; },',
    '    node(){ return node; },',
    '    dockOpen(){ return videoMoreDockOpen; },',
    '    counts(){ return [persistCalls,renderCalls,previewCalls,thumbCalls,saveCalls]; }',
    '};'
].join('\n'), sandbox);
const api = sandbox.__switch;
api.run('video');
ok(api.settings().apiKind === 'video' && api.node().runSettings.apiKind === 'video', '切到视频后立即写入当前批量节点');
ok(api.dockOpen() === false, '切换生成类型时关闭更多参数面板');
ok(api.counts().every(value => value === 1), '模式切换同步参数、预览、素材区和保存');
api.run('image');
ok(api.settings().apiKind === 'image' && api.node().runSettings.apiKind === 'image', '切回图片后同样写入当前批量节点');

const switchFn = fn('syncBatchKindSwitch');
ok(switchFn.includes('data-batch-api-kind') && switchFn.includes('batchKindSwitch.hidden = !visible'), '图片/视频切换只在生成输入节点显示');
ok(switchFn.includes("setSmartBatchApiKind(btn.dataset.batchApiKind, node)"), '顶部切换按钮调用当前节点的模式设置');
ok(switchFn.includes("attachGlideHost(batchKindSwitch, {item:'button', orientation:'horizontal'})") && switchFn.includes('refreshGlideHost(batchKindSwitch)'), '图片/视频切换复用 NovaGlide 滑动动效');
ok(switchFn.includes("if(batchKindSwitch.querySelectorAll('[data-batch-api-kind]').length !== 2)"), '只按两个真实按钮判断初始化，不把滑块子元素算进去');
const previewFn = fn('renderInputPromptPreview');
ok(!previewFn.includes('input-prompt-preview-text') && !previewFn.includes('input-prompt-preview-label'), '预览区不再显示介绍小字');
const composerFn = fn('updateComposer');
const switchAt = composerFn.lastIndexOf('if(switchedNode){');
const switchBlock = switchAt >= 0 ? composerFn.slice(switchAt, switchAt + 500) : '';
ok(switchBlock.includes('videoMoreDockOpen = false') && switchBlock.includes('syncVideoMoreDock()'), '切换节点时先收起上一个节点的更多参数');

console.log('生成输入图片视频切换：' + pass + ' 项通过');
if(failures.length){
    failures.forEach(label => console.error('  x ' + label));
    process.exit(1);
}
