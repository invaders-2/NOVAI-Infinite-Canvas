#!/usr/bin/env node
// 智能画布：MiniMax H3-Max 的官方时长区间必须是 5-15 秒（上游报错文案自证），不能沿用 4-15。
//
// 链路：分镜表每行「时长(秒)」经 videoDurationBounds() → videoDurationRange() 收敛后写进本次请求的 duration。
// 共享能力表 MODEL_CAPABILITIES 里 minimax 只有族条目（没有 durationMin/durationMax），取不到就回落
// VIDEO_DURATION_MIN/MAX = 4/15，2.48 秒被夹成 4 秒发给上游：
//   [table-duration] 第 1 行时长 2.48 秒超出 MiniMax-H3-Max 官方区间 4-15 秒，已收敛到 4 秒
// 上游真实下限是 5。那张表在 canvas.js / smart-canvas.js 各持一份、两个既有测试断言两份逐项一致，
// 所以这里按型号在本页 videoDurationRange() 内部的型号覆盖表里收窄，2.48 必须夹到 5。
//
// 运行：node tests/test_smart_canvas_video_duration_range.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SMART_SRC = process.env.NOVAI_SMART_DURATION_SRC || path.join(ROOT, 'static/js/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
    msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');

const src = fs.readFileSync(SMART_SRC, 'utf8');
console.log('[smart-duration] 智能画布源码 = ' + (process.env.NOVAI_SMART_DURATION_SRC || 'static/js/smart-canvas.js'));

function blockOf(re, label){
    const matched = re.exec(src);
    if(!matched) throw new Error('缺少源码块 ' + label);
    return matched[0];
}
// 顶层 function：函数体里所有右花括号都有缩进，第一个顶格 '\n}' 就是函数结尾。
function topLevelFunction(name){
    const matched = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    if(!matched) throw new Error('未找到函数 ' + name);
    const start = matched.index + 1;
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

// 只抠真实实现：能力表 / 型号级时长覆盖 / 三个区间函数，settings 用桩注入。
const sandboxBody = [
    blockOf(/const GEMINI_RATIO_KEYS = \[[^\]]*\];/, 'GEMINI_RATIO_KEYS'),
    blockOf(/const SEEDREAM_RATIO_KEYS = \[[^\]]*\];/, 'SEEDREAM_RATIO_KEYS'),
    blockOf(/const MODEL_CAPABILITIES = \[[\s\S]*?\n\];/, 'MODEL_CAPABILITIES'),
    blockOf(/const VIDEO_DURATION_MIN = [^\n]*;/, 'VIDEO_DURATION_MIN'),
    'globalThis.settings = { videoModel: "", videoDuration: 5 };',
    topLevelFunction('modelCapabilityFor'),
    topLevelFunction('videoDurationRange'),
    topLevelFunction('videoDurationBounds')
].join('\n');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(sandboxBody, sandbox, { filename: 'smart-canvas-duration-sandbox.js' });
const run = code => vm.runInContext(code, sandbox);
const range = model => {
    const value = run('videoDurationRange(' + JSON.stringify(model) + ')');
    return value === null ? null : { min: value.min, max: value.max };
};
// 与分镜表同一套收敛算法（runSmart* 里 row.duration 的收敛）
const clampRowDuration = (model, seconds) => {
    const bounds = run('videoDurationBounds(' + JSON.stringify(model) + ')');
    return { bounds, clamped: Math.max(bounds.min, Math.min(bounds.max, seconds)) };
};

console.log('[1] MiniMax H3-Max 的官方区间 = 5-15 秒');
eq(range('minimax-h3-max'), { min: 5, max: 15 }, 'videoDurationRange(minimax-h3-max)');
eq(range('MiniMax-H3-Max'), { min: 5, max: 15 }, 'videoDurationRange(MiniMax-H3-Max)');
eq(range('generate_video_minimax_h3_max'), { min: 5, max: 15 }, 'videoDurationRange(generate_video_minimax_h3_max)');
eq(range('minimax_h3_max'), { min: 5, max: 15 }, 'videoDurationRange(minimax_h3_max)');

console.log('[2] 2.48 秒被夹到 5 秒（不是旧的 4 秒）');
const row = clampRowDuration('MiniMax-H3-Max', 2.48);
eq(row.bounds, { min: 5, max: 15 }, 'videoDurationBounds(MiniMax-H3-Max)');
eq(row.clamped, 5, '2.48 秒收敛结果');
eq('第 1 行时长 2.48 秒超出 MiniMax-H3-Max 官方区间 ' + row.bounds.min + '-' + row.bounds.max
    + ' 秒，已收敛到 ' + row.clamped + ' 秒',
    '第 1 行时长 2.48 秒超出 MiniMax-H3-Max 官方区间 5-15 秒，已收敛到 5 秒', '分镜表日志文案');

console.log('[3] 型号级覆盖只认 H3-Max 两种 id 写法，不碰共享能力表里的宽高比口径');
const rangeFnSrc = topLevelFunction('videoDurationRange');
ok(rangeFnSrc.includes("match: 'minimax-h3-max', min: 5, max: 15")
    && rangeFnSrc.includes("match: 'minimax_h3_max', min: 5, max: 15"), '覆盖表含两种 H3-Max id 写法且区间 5-15');
eq(run('modelCapabilityFor("MiniMax-H3-Max", "aspects")'), ['16:9', '9:16', '1:1'],
    'MiniMax-H3-Max 宽高比仍由 minimax 族条目提供');

console.log('[4] 回归：其它模型区间不变，未收录模型仍回落 4-15');
eq(range('kling-v3'), { min: 3, max: 15 }, 'videoDurationRange(kling-v3)');
eq(range('veo3.1-fast'), { min: 4, max: 8 }, 'videoDurationRange(veo3.1-fast)');
eq(range('doubao-seedance-2-5-260628'), { min: 4, max: 30 }, 'videoDurationRange(seedance-2.5)');
eq(range('minimax-h3'), null, 'videoDurationRange(minimax-h3)（证据不足，不跟着改）');
eq(clampRowDuration('minimax-h3', 2.48).bounds, { min: 4, max: 15 }, 'minimax-h3 仍回落 4-15');
eq(range('some-unknown-video'), null, 'videoDurationRange(未收录模型)');
eq(clampRowDuration('some-unknown-video', 2.48).bounds, { min: 4, max: 15 }, '未收录模型仍回落 4-15');

console.log('');
if(fails.length){
    fails.forEach(msg => console.log('  ✗ ' + msg));
    console.log('[smart-duration] 失败 ' + fails.length + ' 项');
    process.exit(1);
}
console.log('[smart-duration] 全部通过（' + pass + ' 项）');
