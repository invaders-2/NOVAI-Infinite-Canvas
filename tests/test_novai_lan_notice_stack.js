#!/usr/bin/env node
'use strict';
/*
 * 右下角新消息提醒：一条消息一张卡 / 自下而上堆叠的规则测试。
 * 前半用 esbuild 直接加载 lanNotice.ts（纯函数，不 import React）；后半读 LanChat.tsx / lan-chat.css 的源码字面量。
 * LAN_NOTICE_ENTRY 可以把入口指到一份改坏的副本上，用来确认断言真的会红（红绿自检）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'novai-canvas-ui/node_modules/esbuild'));

function loadTs(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        tsconfig: path.join(root, 'novai-canvas-ui/tsconfig.json'),
    });
    const loaded = new Module('novai-lan-notice');
    loaded.paths = Module._nodeModulePaths(root);
    loaded._compile(result.outputFiles[0].text, 'lanNotice.cjs');
    return loaded.exports;
}

const notice = loadTs(process.env.LAN_NOTICE_ENTRY || 'novai-canvas-ui/src/canvas/canvas-next/ui/lanNotice.ts');

function cardOf(friend, message) {
    return {
        friendId: friend.id, messageId: message.id, nickname: friend.nickname,
        avatar: friend.avatar, preview: notice.noticePreviewOf(message), ts: message.ts,
    };
}

function testOneCardPerMessage() {
    const friend = { id: 'f1', nickname: '小红', avatar: '🐼', unread: 3, last_message: { ts: 1000 } };
    const batch = [
        { id: 'm1', kind: 'text', text: '第一条', dir: 'in', ts: 1100 },
        { id: 'm2', kind: 'text', text: '第二条', dir: 'in', ts: 1200 },
        { id: 'm3', kind: 'image', text: '看看', dir: 'in', ts: 1300 },
    ];
    const picked = notice.noticeMessages(batch, 1000, new Set());
    assert.deepEqual(picked.map((m) => m.id), ['m1', 'm2', 'm3'], '按 ts 升序逐条返回');

    const stacked = notice.appendNotices([], picked.map((m) => cardOf(friend, m)));
    assert.equal(stacked.length, 3, '同一个人连发 3 条 = 3 张卡，不合并');
    assert.deepEqual(stacked.map((c) => c.messageId), ['m3', 'm2', 'm1'], 'index 0 是最新那条（column-reverse 下贴右下角）');
    assert.equal(new Set(stacked.map((c) => c.friendId)).size, 1, '三张卡都属于同一个人');
    assert.deepEqual(stacked.map((c) => c.preview), ['[图片] 看看', '第二条', '第一条'], '每张卡显示自己那条消息');
    console.log('[lan-notice] 每条消息一张卡 + 堆叠顺序通过');
}

function testDedupeById() {
    const friend = { id: 'f1', nickname: '小红', avatar: '🐼', unread: 2, last_message: { ts: 1000 } };
    const batch = [
        { id: 'm1', kind: 'text', text: '一', dir: 'in', ts: 1100 },
        { id: 'm2', kind: 'text', text: '二', dir: 'in', ts: 1200 },
    ];
    const cards = batch.map((m) => cardOf(friend, m));
    const first = notice.appendNotices([], cards);

    // 同一批消息再轮询一次：seen 里已经有这两个 id，一条都不该再出
    assert.deepEqual(notice.noticeMessages(batch, 1000, new Set(['m1', 'm2'])), [], '已弹过的 id 不再出卡');
    assert.equal(notice.appendNotices(first, cards).length, 2, '同一 messageId 不会重复插卡');

    // 重试补发把老消息带回来一半：只剩没弹过的那条
    const retried = [{ id: 'm3', kind: 'text', text: '三', dir: 'in', ts: 1300 }, batch[0]];
    const picked = notice.noticeMessages(retried, 1000, new Set(['m1', 'm2']));
    assert.deepEqual(picked.map((m) => m.id), ['m3']);
    const grown = notice.appendNotices(first, picked.map((m) => cardOf(friend, m)));
    assert.deepEqual(grown.map((c) => c.messageId), ['m3', 'm2', 'm1']);
    console.log('[lan-notice] 按 message id 去重通过');
}

function testOnlyIncoming() {
    const mixed = [
        { id: 'out1', kind: 'text', text: '我发的', dir: 'out', ts: 1500 },
        { id: 'in1', kind: 'text', text: '对方发的', dir: 'in', ts: 1200 },
        { id: 'sys1', kind: 'text', text: '系统消息', dir: 'sys', ts: 1600 },
        { id: 'old1', kind: 'text', text: '游标之前', dir: 'in', ts: 900 },
        { id: 'edge', kind: 'text', text: '正好等于游标', dir: 'in', ts: 1000 },
    ];
    assert.deepEqual(notice.noticeMessages(mixed, 1000, null).map((m) => m.id), ['in1'], '只弹 dir=in 且 ts>游标');
    assert.deepEqual(notice.noticeMessages(mixed, 0, null).map((m) => m.id), ['old1', 'edge', 'in1'], '游标 0 时只要 dir=in 的都算，仍然不弹 out/sys');
    assert.deepEqual(notice.noticeMessages(null, 0, null), []);
    console.log('[lan-notice] 只看 dir=in / 游标过滤通过');
}

function testCap() {
    assert.equal(notice.NOTICE_MAX, 4, '同时最多 4 张');
    const friend = { id: 'f1', nickname: '小红', avatar: '🐼' };
    let list = [];
    for (let i = 1; i <= 6; i += 1) {
        list = notice.appendNotices(list, [cardOf(friend, { id: 'm' + i, kind: 'text', text: '第 ' + i + ' 条', dir: 'in', ts: i })]);
    }
    assert.deepEqual(list.map((c) => c.messageId), ['m6', 'm5', 'm4', 'm3'], '超过上限丢最老的，只留最新 4 张');
    const two = notice.appendNotices([], [
        cardOf(friend, { id: 'a', kind: 'text', text: 'a', dir: 'in', ts: 1 }),
        cardOf(friend, { id: 'b', kind: 'text', text: 'b', dir: 'in', ts: 2 }),
    ]);
    assert.deepEqual(two.map((c) => c.messageId), ['b', 'a'], '一次补拉多条时最新的排最前');
    const late = notice.appendNotices([cardOf(friend, { id: 'n1', kind: 'text', text: 'n1', dir: 'in', ts: 2000 })],
        [cardOf(friend, { id: 'n2', kind: 'text', text: 'n2', dir: 'in', ts: 1000 })]);
    assert.deepEqual(late.map((c) => c.messageId), ['n1', 'n2'], '按消息时间排：老消息后到也不会顶到最下面');
    console.log('[lan-notice] 最多 4 张 / 超出丢最老 / 按时间排序通过');
}

function testPreview() {
    assert.equal(notice.noticePreviewOf({ id: 'a', kind: 'text', text: ' 你好\n  在吗 ' }), '你好 在吗');
    assert.equal(notice.noticePreviewOf({ id: 'b', kind: 'image', text: '' }), '[图片]');
    assert.equal(notice.noticePreviewOf({ id: 'c', kind: 'image', text: '看这个' }), '[图片] 看这个');
    assert.equal(notice.noticePreviewOf({ id: 'd', kind: 'video', text: '10 秒' }), '[视频] 10 秒');
    assert.equal(notice.noticePreviewOf({ id: 'e', kind: 'canvas', canvas_title: '主图工作流' }), '[画布] 主图工作流');
    assert.equal(notice.noticePreviewOf({ id: 'f', kind: 'canvas' }), '[画布]');
    assert.equal(notice.noticePreviewOf({ id: 'g', kind: 'text', text: 'x'.repeat(200) }).length, 60, '文本截到 60 字');
    assert.equal(notice.noticePreviewOf({ id: 'h', kind: 'text', text: '' }), '给你发来一条消息');
    assert.equal(notice.noticePreviewOf(null), '给你发来一条消息');
    console.log('[lan-notice] 预览文案映射通过');
}

function testFirstEntryQuiet() {
    const friends = [
        { id: 'f1', nickname: '小红', avatar: '🐼', unread: 3, last_message: { ts: 1300 } },
        { id: 'f2', nickname: '小明', avatar: '🐶', unread: 0, last_message: null },
    ];
    let plan = notice.planNoticeFetches({ unread: new Map(), cursor: new Map() }, friends, '');
    assert.deepEqual(plan.fetches, [], '首次进入页面：历史未读不弹');
    assert.equal(plan.state.cursor.get('f1'), 1300, '游标初值取该好友 last_message.ts');
    assert.equal(plan.state.cursor.get('f2'), 0, '没有 last_message 就是 0');
    let state = plan.state;

    plan = notice.planNoticeFetches(state, friends, '');
    assert.deepEqual(plan.fetches, [], '未读没涨不拉');
    state = plan.state;

    const risen = [
        { id: 'f1', nickname: '小红', avatar: '🐼', unread: 4, last_message: { ts: 1500 } },
        { id: 'f2', nickname: '小明', avatar: '🐶', unread: 0, last_message: null },
    ];
    plan = notice.planNoticeFetches(state, risen, '');
    assert.deepEqual(plan.fetches, [{ friendId: 'f1', after: 1300 }], 'unread 涨了才拉，after 用上一次的游标');
    state = plan.state;

    plan = notice.planNoticeFetches(state, [
        { id: 'f1', nickname: '小红', avatar: '🐼', unread: 5, last_message: { ts: 1600 } },
        { id: 'f2', nickname: '小明', avatar: '🐶', unread: 0, last_message: null },
    ], 'f1');
    assert.deepEqual(plan.fetches, [], '正开着这个人的会话不弹');
    assert.equal(plan.state.cursor.get('f1'), 1600, '会话开着时游标跟上，之后不会补弹旧消息');

    // 未读被标已读回落再涨，也要能再弹
    plan = notice.planNoticeFetches(plan.state, [
        { id: 'f1', nickname: '小红', avatar: '🐼', unread: 0, last_message: { ts: 1600 } },
    ], '');
    state = plan.state;
    assert.deepEqual(plan.fetches, []);
    plan = notice.planNoticeFetches(state, [
        { id: 'f1', nickname: '小红', avatar: '🐼', unread: 2, last_message: { ts: 1700 } },
    ], '');
    assert.deepEqual(plan.fetches, [{ friendId: 'f1', after: 1600 }], '标已读后再来新消息照样弹');
    console.log('[lan-notice] 首次进入不弹 / 未读上涨才拉 / 会话中不弹通过');
}

function testClearFriend() {
    const cards = [
        { friendId: 'f1', messageId: 'a', nickname: '小红', avatar: '🐼', preview: 'a', ts: 1 },
        { friendId: 'f2', messageId: 'b', nickname: '小明', avatar: '🐶', preview: 'b', ts: 2 },
        { friendId: 'f1', messageId: 'c', nickname: '小红', avatar: '🐼', preview: 'c', ts: 3 },
    ];
    assert.deepEqual(notice.clearFriendNotices(cards, 'f1').map((c) => c.messageId), ['b'], '点卡片只清这个人的卡');
    assert.deepEqual(notice.clearFriendNotices(cards, 'f9').map((c) => c.messageId), ['a', 'b', 'c']);
    console.log('[lan-notice] 点卡片清掉该好友全部卡片通过');
}

function testSourceWiring() {
    const host = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/LanChat.tsx'), 'utf8');
    assert.ok(/data-lan-notice=\{item\.messageId\}/.test(host), '卡片 DOM 挂 message id（一条消息一张）');
    assert.ok(/key=\{item\.messageId\}/.test(host), 'React key 是 message id');
    assert.ok(/clearFriendNotices\(list, friendId\)/.test(host), '点卡片清掉这个人的所有卡');
    assert.ok(/&after=" \+ \(job\.after \|\| 0\)/.test(host), '补拉用 ts 游标当 after');
    assert.ok(!/item\.friendId !== friend\.id/.test(host), '不再按 friendId 覆盖合并');
    assert.ok(!/NOTICE_MAX = 2/.test(host), '旧的两张上限已移除');

    const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/lan-chat.css'), 'utf8');
    const at = css.indexOf('.cn-root.lan-root .lan-notices{');
    assert.ok(at > 0, '找得到 .lan-notices 样式');
    const block = css.slice(at, at + 420);
    assert.ok(/flex-direction:column-reverse/.test(block), '堆叠方向：DOM 第 1 张贴右下角');
    assert.ok(/bottom:calc\(96px/.test(block), '位置仍是 bottom 96，不压 orb / 工具条');
    assert.ok(!/border:/.test(block), '不画边框');
    console.log('[lan-notice] 宿主源码 / 样式契约通过');
}

testOneCardPerMessage();
testDedupeById();
testOnlyIncoming();
testCap();
testPreview();
testFirstEntryQuiet();
testClearFriend();
testSourceWiring();
console.log('[lan-notice] 右下角新消息提醒（每条一张 / 堆叠）测试全部通过');
