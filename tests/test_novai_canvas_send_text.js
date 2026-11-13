#!/usr/bin/env node
/* 直传文本 / 排队 / 输入框三条发送路径不能互相串（不真生成）
   —— 「下一步建议」已改成纯文字（用户 2026-11 明确不做成按钮），芯片点击相关断言随之移除，
      只保留 pickSendText / 队列快照这些发送层逻辑。
   跑法：node tests/test_novai_canvas_send_text.js */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const { pickSendText } = load('novai-canvas-ui/src/canvas/canvas-next/agent/sendText.ts');
const queue = load('novai-canvas-ui/src/canvas/canvas-next/agent/queue.ts');

/* 1) 芯片：直传文本优先于旧 draft */
const OLD_DRAFT = '上一句：生成 30 秒卖货短片';
assert.strictEqual(pickSendText('再出一版暖光对比', undefined, OLD_DRAFT), '再出一版暖光对比', '芯片文案胜出，绝不读旧 draft');
assert.strictEqual(pickSendText('把标题换成第二版文案', undefined, ''), '把标题换成第二版文案', 'draft 为空也用芯片文案');
/* 2) 正常输入框发送：没直传文本时用 draft */
assert.strictEqual(pickSendText(undefined, undefined, '手输的内容'), '手输的内容', '输入框发送行为不变');
assert.strictEqual(pickSendText('', undefined, '手输的内容'), '手输的内容', '空直传回落 draft');
assert.strictEqual(pickSendText('   ', undefined, '手输的内容'), '手输的内容', '只有空白的直传也回落 draft');
/* 3) 队列发送：outgoing.text 优先于当前 draft */
assert.strictEqual(pickSendText(undefined, { text: '排队的第一条' }, OLD_DRAFT), '排队的第一条', '队列发送行为不变');
assert.strictEqual(pickSendText('芯片文案', { text: '排队的第一条' }, OLD_DRAFT), '芯片文案', '直传文本仍优先');

/* 4) busy 时点芯片：文案进排队（snap.text = 芯片文案），队列发送时用入队文本而不是当前 draft */
const OLD_DRAFT2 = '上一句：生成 30 秒卖货短片';
const base = { skill: null, pinned: [], selected: [], refs: [], webPlugin: false };
const snap = queue.snapshotForText('再出一版暖光对比', base);
assert.strictEqual(snap.text, '再出一版暖光对比', '排队快照的文本就是芯片文案');
const added = queue.enqueue([], { id: 'q1', label: snap.text, snap });
assert.strictEqual(added.ok, true);
assert.strictEqual(added.list[0].snap.text, '再出一版暖光对比', '队列里的文本 = 芯片文案');
const taken = queue.takeFirst(added.list);
assert.strictEqual(pickSendText(undefined, taken.first.snap, OLD_DRAFT2), '再出一版暖光对比', '队列自动发送用入队文本，不是当前旧 draft');

/* 5) 源码接线：send 用 pickSendText，发送后清 draft；「下一步建议」是纯文字、没有点击接线 */
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
assert.ok(panel.includes('const rawText = pickSendText(direct, outgoing, a.draft);'), 'send 用 pickSendText（直传 > 队列 > draft）');
assert.ok(panel.includes('const direct = directSendText.current ?? undefined;') && panel.includes('directSendText.current = null;'), '直传文本同步取走，不依赖 React 状态');
assert.ok(panel.includes('if (!outgoing) { a.draft = "";'), '发送后清空 draft，避免上一次输入残留');
assert.ok(!panel.includes('onSuggest'), '建议不再有点击接线（纯文字）');
assert.ok(panel.includes('下一步建议') && panel.includes('ap2-sug-text'), '建议渲染成「下一步建议」小标题 + 纯文字');
assert.ok(!/className="ap2-sug"[^>]*onClick[^>]*>{text}/.test(panel), '建议文字没有做成可点按钮');

console.log('[PASS] 发送文本：直传优先 3 条 + 输入框/队列 4 条 + busy 入队 4 条 + 接线 6 条 全部通过');
