#!/usr/bin/env node
// 本地打标模型不能被写死/静默替换（static/js/asset-manager.js）。
//
// 规则：只有该字段为空（还没选过）时才回落到第一个模型；已选的非空值一律原样保留，
// 哪怕它不在当前平台/供应商的 chat_models 列表里；下拉要把这个「已选但不在列表」的
// 模型前置显示并保持 selected。
//
// 运行：node tests/test_asset_caption_model.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

const file = path.join(__dirname, '../static/js/asset-manager.js');
const code = fs.readFileSync(file, 'utf8');
const label = 'static/js/asset-manager.js';

// 从源码里原样抠出待测函数，避免在测试里复制一份逻辑导致「测的不是真代码」。
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

// ---- 静态断言 ----
ok(!code.includes('if(!models.includes(localCaptionModel))'),
    '不再出现「!models.includes(...) 就替换」的写法');
ok(code.includes('if(!localCaptionModel) localCaptionModel = models[0] || \'\';'),
    '回落到第一个模型前先判断 localCaptionModel 为空');
ok(code.includes("localCaptionModel && !models.includes(localCaptionModel) ? [localCaptionModel, ...models] : models"),
    'localCaptionModels() 把不在列表里的已选模型前置（并去重）');
const selectedChecks = code.split("m === localCaptionModel ? 'selected'").length - 1;
ok(selectedChecks >= 2, '两处下拉（本地页 + 偏好设置）都按 localCaptionModel 标记 selected，实际 ' + selectedChecks + ' 处');

// ---- 行为断言：在沙箱里跑真实函数 ----
const sandboxSrc = [
    'let apiProviders = [];',
    "let localCaptionProvider = '';",
    "let localCaptionModel = '';",
    'let localCaptionBusy = false;',
    'let localClassifyBusy = false;',
    'let localClassifyPromptOpen = false;',
    "let localClassifyPrompt = '';",
    "let localCaptionPrompt = '描述图片';",
    'let writeCount = 0;',
    'function writeLocalCaptionSettings(){ writeCount += 1; }',
    'const escapeAttr = (v) => String(v == null ? "" : v);',
    'const escapeHtml = (v) => String(v == null ? "" : v);',
    extractFn(code, 'localCaptionProviders'),
    extractFn(code, 'normalizeLocalCaptionSettings'),
    extractFn(code, 'localCaptionModels'),
    extractFn(code, 'renderLocalCaptionTools'),
    'globalThis.__caption = {',
    '    setProviders(v){ apiProviders = v; },',
    '    setSelection(p, m){ localCaptionProvider = p; localCaptionModel = m; },',
    '    state(){ return {provider: localCaptionProvider, model: localCaptionModel}; },',
    '    models(){ return localCaptionModels(); },',
    '    render(n){ return renderLocalCaptionTools(n); },',
    '    writes(){ return writeCount; }',
    '};'
].join('\n');

const ro = {};
vm.runInNewContext(sandboxSrc, ro, {filename: label});
const cap = ro.__caption;

const PROVIDERS = [
    {id:'relayA', name:'中转站A', enabled:true, chat_models:['gpt-4o', 'gpt-4o-mini']},
    {id:'relayB', name:'中转站B', enabled:false, chat_models:['claude-3']}
];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 场景 1：已选模型不在当前平台的列表里 → 原样保留 + 前置 + 下拉选中
cap.setProviders(PROVIDERS);
cap.setSelection('relayA', 'my-external-model');
const html1 = cap.render(1);
ok(cap.state().model === 'my-external-model', '已选非空模型不会被替换成列表里的其它模型');
ok(eq(cap.models(), ['my-external-model', 'gpt-4o', 'gpt-4o-mini']),
    '列表外的已选模型被前置进下拉候选，实际 ' + JSON.stringify(cap.models()));
ok(html1.includes('<option value="my-external-model" selected>my-external-model</option>'),
    '下拉把列表外的已选模型渲染成 selected');
ok(html1.includes('<option value="gpt-4o" >gpt-4o</option>'),
    '列表里的其它模型照常渲染，且没有被误标 selected');

// 场景 2：已选模型就在列表里 → 不重复、正确选中
cap.setSelection('relayA', 'gpt-4o-mini');
const html2 = cap.render(1);
ok(eq(cap.models(), ['gpt-4o', 'gpt-4o-mini']), '已选模型在列表里时不前置、不产生重复项');
ok(html2.split('value="gpt-4o-mini"').length - 1 === 1, '模型在列表里时下拉只出现一次');
ok(html2.includes('<option value="gpt-4o-mini" selected>gpt-4o-mini</option>'), '列表里的已选模型保持 selected');

// 场景 3：字段为空（还没选过）→ 才回落到第一个
cap.setSelection('relayA', '');
ok(eq(cap.models(), ['gpt-4o', 'gpt-4o-mini']), '未选过时按原顺序给出候选');
ok(cap.state().model === 'gpt-4o', '未选过时才回落到第一个模型');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
