#!/usr/bin/env node
'use strict';
/*
 * 经典画布聊天模型兜底的回归测试。
 *
 * 背景：canvas.js 原来在 resolveChatModel 末尾写死 'gpt-4o-mini'，chatModels 初始化
 * 也是 ['gpt-4o-mini']。聊天模型必须来自用户选择 / 平台配置，前端不写死模型名；
 * 平台没配时返回空串，由后端按平台配置挑默认
 * （main.py resolve_chat_provider → preferred_chat_model，5636-5645 / 5735）。
 *
 * 守住：
 *   [1] resolveChatModel 能从源码抠出来，且函数体里没有写死的模型名
 *   [2] 用户选的模型原样返回（哪怕不在任何列表里）
 *   [3] 没选模型时按 provider → allChatModels → chatModels 的顺序回落
 *   [4] 三者都空 → 返回空串（不是任何硬编码模型名）
 *   [5] canvas.js 全文不含 gpt-4o-mini；chatModels 初始化不再是写死的模型名数组
 *
 * 跑法：node tests/test_canvas_chat_model_fallback.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'static/js/canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected), label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));

console.log('[1] resolveChatModel 能从源码抠出来');
const fnSrc = (SRC.match(/function resolveChatModel\(value, providerId=''\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(fnSrc), 'resolveChatModel 函数体已抠出');
ok(!/'gpt-4o-mini'/.test(fnSrc), '函数体里不再写死 gpt-4o-mini');
ok(/\|\| '';\s*\n\}$/.test(fnSrc), '兜底链最后落到空串');

// 注入假数据求值：providerChatModels / allChatModels / chatModels 是真实源码里的三个外部依赖
const evalResolve = (providerModels, allModels, chatList) => new Function(
    'providerChatModels', 'allChatModels', 'chatModels',
    fnSrc + '\nreturn resolveChatModel;'
)(() => providerModels, () => allModels, chatList);

console.log('[2] 用户选择的模型优先且原样返回');
const withProvider = evalResolve(['agnes-2.0-flash', 'agnes-2.5-pro'], ['gpt-5', 'gpt-4o-mini'], ['gpt-4o-mini']);
eq(withProvider('agnes-2.5-pro', 'agnes-ai'), 'agnes-2.5-pro', '列表内的用户模型原样返回');
eq(withProvider('某不在列表里的模型', 'agnes-ai'), '某不在列表里的模型', '不在列表里的用户模型也原样返回');
eq(withProvider('用户选的', ''), '用户选的', '没有 providerId 时用户模型仍原样返回');

console.log('[3] 没选模型时按 provider → allChatModels → chatModels 回落');
eq(withProvider('', 'agnes-ai'), 'agnes-2.0-flash', 'provider 有列表时用 provider 第一个');
eq(evalResolve([], ['平台模型A', '平台模型B'], ['gpt-4o-mini'])('', 'agnes-ai'), '平台模型A', 'provider 无列表时用 allChatModels 第一个');
eq(evalResolve([], ['平台模型A'], ['平台兜底'])('', ''), '平台模型A', 'allChatModels 有值时优先于 chatModels');
eq(evalResolve([], [], ['平台兜底'])('', ''), '平台兜底', '只有 chatModels 有值时用 chatModels 第一个');

console.log('[4] 三者都空 → 空串，交给后端挑默认（前端不写死模型名）');
const emptyResult = evalResolve([], [], [])('', '');
eq(emptyResult, '', '全空返回空串');
ok(typeof emptyResult === 'string', '返回的是字符串而不是 undefined');
ok(!emptyResult, '返回空串里没有硬编码模型名');

console.log('[5] canvas.js 源文件不再出现写死的聊天模型名');
ok(!SRC.includes('gpt-4o-mini'), 'canvas.js 全文不含 gpt-4o-mini');
ok(!/let chatModels = \['gpt-4o-mini'\]/.test(SRC), 'chatModels 初始化不再是写死的模型名数组');
ok(/let chatModels = \[\];/.test(SRC), 'chatModels 初始化为空数组（配置里有就用 /api/config 的）');

console.log('经典画布聊天模型兜底：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) {
    fails.forEach(name => console.error('  \u2717 ' + name));
    console.error('经典画布聊天模型兜底：失败 ' + fails.length + ' 项');
    process.exit(1);
}
console.log('全部通过');
