#!/usr/bin/env node
// D4：任务失败且节点无图时，前端不应产生未捕获的 Promise rejection（浏览器 pageerror）。
//
// 现象：助手 / 载入时登记的生成任务由 resumeSmartPendingTasks() 以 fire-and-forget 方式续跑。
//       resumeSmartPendingNode() 在「任务失败且节点没有任何图」时会 throw（failures[0]）——它本来
//       是给 await 调用方接的；这里却没人 catch，于是变成 pageerror。
// 本检查锁住修复：
//   1) resumeSmartPendingTasks 逐个 resumeSmartPendingNode(...).catch(...) 兜住；
//   2) 兜底处理函数 reportSmartPendingResumeFailure 会记一条失败日志；
//   3) 所有 resumeSmartPendingTasks() 调用点、即梦轮询 IIFE 都补了 catch。
// 行为部分在沙箱里跑真实函数：同一个「拒绝的续跑函数」在修复前后分别不产生 / 产生未捕获拒绝（差分）。
// 运行：node tests/test_smart_canvas_pending_resume_error.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const drain = () => new Promise(resolve => setTimeout(resolve, 60));

const file = path.join(__dirname, '../static/js/smart-canvas.js');
const code = fs.readFileSync(file, 'utf8');
const label = 'static/js/smart-canvas.js';
function topLevelFunction(src, name){
    const start = src.indexOf('\nfunction ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start + 1);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start + 1, end + 2);
}

// ---- 静态断言：fire-and-forget 链路都兜了 catch ----
const resumeFn = topLevelFunction(code, 'resumeSmartPendingTasks');
ok(/resumeSmartPendingNode\(node\)\.catch\(/.test(resumeFn), 'resumeSmartPendingTasks 对每个节点的续跑都接了 catch');
ok(/Promise\.all\(/.test(resumeFn), 'resumeSmartPendingTasks 返回所有节点续跑的 Promise（能被调用方继续接）');
ok(/function reportSmartPendingResumeFailure\(/.test(code), '抽出了失败处理函数 reportSmartPendingResumeFailure');
ok(/addSmartGenerationLog\(/.test(topLevelFunction(code, 'reportSmartPendingResumeFailure')), '失败处理会写生成日志');

const callSites = code.split('\n')
    .map((line, i) => ({ line, number: i + 1 }))
    .filter(item => /resumeSmartPendingTasks\(\)/.test(item.line) && !/function resumeSmartPendingTasks/.test(item.line));
ok(callSites.length === 3, 'resumeSmartPendingTasks() 有 3 个 fire-and-forget 调用点（实际 ' + callSites.length + '）');
ok(callSites.every(item => /\.catch\(/.test(item.line)), '每个 resumeSmartPendingTasks() 调用点都补了 catch');
ok(/\}\)\(\)\.catch\(/.test(topLevelFunction(code, 'startJimengPoll')), 'startJimengPoll 的异步轮询 IIFE 补了 catch');

// ---- 同类：生成 / 运行入口也是 fire-and-forget，一并补了 catch 与兜底日志 ----
ok(/function logSmartRunEntryFailure\(/.test(code), '抽出了生成入口的兜底日志函数 logSmartRunEntryFailure');
const guardedEntries = [
    'runGeneration().catch(',
    'runSmartCascade().catch(',
    'runSmartCascade(tail).catch(',
    'runSelectedNodesCascade().catch(',
    'runSmartPromptChat(node).catch(',
    'runSmartLLMListMode(node).catch(',
    'runPromptLLMNode(node.id).catch(',
    "}).catch(error => logSmartRunEntryFailure('分组一键运行', error));",
];
guardedEntries.forEach(entry => ok(code.includes(entry), 'fire-and-forget 调用点已补 catch：' + entry));

// ---- 行为断言 + 差分：沙箱里跑真实函数 ----
const sandboxSrc = [
    'const tr = k => k;',
    'let nodes = [{id:"n1", type:"smart-image", prompt:"p"}];',
    'let logged = [];',
    'function smartPendingTasks(node){ return (node && node.pendingTasks) || []; }',
    'function resumeSmartPendingNode(node){ return Promise.reject(new Error("上游任务失败")); }',
    'function addSmartGenerationLog(entry){ logged.push(entry); }',
    topLevelFunction(code, 'reportSmartPendingResumeFailure'),
    topLevelFunction(code, 'resumeSmartPendingTasks'),
    // 差分对照：修复前的写法（forEach 里直接调用，没有 catch）
    'function legacyResumeSmartPendingTasks(){',
    '    nodes.filter(node => smartPendingTasks(node).length).forEach(node => {',
    '        resumeSmartPendingNode(node);',
    '    });',
    '}',
    'globalThis.__setNodes = list => { nodes = list; };',
    'globalThis.__resume = () => resumeSmartPendingTasks();',
    'globalThis.__legacyResume = () => legacyResumeSmartPendingTasks();',
    'globalThis.__logged = () => logged;',
].join('\n');
const sandbox = { console: { log() {}, error() {}, warn() {} } };
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, { filename: 'pending-resume-sandbox.js' });

(async () => {
    sandbox.__setNodes([{ id:'n1', type:'smart-image', prompt:'p', pendingTasks:[{ taskId:'t1', kind:'image' }] }]);

    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        // 修复后：同一个会拒绝的续跑函数，不再产生未捕获拒绝
        await sandbox.__resume();
        await drain();
        ok(unhandled.length === 0, '修复后失败任务不再产生未捕获拒绝');
        const logs = sandbox.__logged();
        ok(logs.length === 1, '失败会写一条生成日志（实际 ' + logs.length + '）');
        ok((logs[0] && logs[0].error || '').includes('上游任务失败'), '日志如实记录失败原因');

        // 差分对照：同样的节点、同样的拒绝，旧写法必然漏出未捕获拒绝
        sandbox.__legacyResume();
        await drain();
        ok(unhandled.length === 1, '差分证明：没有 catch 的旧写法会产生未捕获拒绝（实际 ' + unhandled.length + '）');
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }

    console.log(label + '：' + pass + ' 项通过');
    if(fails.length){ fails.forEach(msg => console.error('  ✗ ' + msg)); console.error('失败 ' + fails.length + ' 项'); process.exit(1); }
    console.log('全部通过');
})();
