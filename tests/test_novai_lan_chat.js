'use strict';
/**
 * T51 局域网好友 / 聊天测试：
 *  1) 用 esbuild 直接单测 lanDoc.ts 的纯函数（好友码解析 / 消息合并 / 未读 / 时间与错误文案）；
 *  2) spawn python 跑 tests/test_lan_account_store.py（真实 FastAPI 路由 + 好友增删 + 口令校验 + 幂等 + 离线）。
 * 没有能 import fastapi 的 python 时跳过后端部分并给出提示（与 test_novai_canvas_share.js 同款降级）。
 */
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
    const loaded = new Module('novai-lan-doc');
    loaded.paths = Module._nodeModulePaths(root);
    loaded._compile(result.outputFiles[0].text, 'lanDoc.cjs');
    return loaded.exports;
}

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = '0123456789abcdef'.repeat(3);

function testFriendCode(lan) {
    const parsed = lan.parseFriendCode('NOVAI-192.168.1.8:3000-' + TOKEN_A);
    assert.equal(parsed.ip, '192.168.1.8');
    assert.equal(parsed.port, 3000);
    assert.equal(parsed.token, TOKEN_A);
    assert.equal(parsed.base_url, 'http://192.168.1.8:3000');

    assert.ok(lan.parseFriendCode('  NOVAI-192.168.1.8:3000-' + TOKEN_A + '  '));
    assert.ok(lan.parseFriendCode('NOVAI-10.0.0.7:65535-' + TOKEN_B));
    assert.equal(lan.parseFriendCode('NOVAI-10.0.0.7:70000-' + TOKEN_B), null);
    assert.equal(lan.parseFriendCode('NOVAI-10.0.0.7:0-' + TOKEN_B), null);
    assert.equal(lan.parseFriendCode('NOVAI-192.168.1.8:3000-' + 'short'), null);
    assert.equal(lan.parseFriendCode('http://192.168.1.8:3000'), null);
    assert.equal(lan.parseFriendCode('hello'), null);
    assert.equal(lan.parseFriendCode(''), null);
    assert.equal(lan.parseFriendCode(null), null);
    assert.equal(lan.parseFriendCode(undefined), null);

    // 6 位纯数字好友码；旧版 6 位字母码仍兼容并归一成大写
    const short = lan.parseFriendCode('483920');
    assert.equal(short.code, '483920');
    assert.equal(short.ip, '');
    assert.equal(short.port, 0);
    assert.equal(short.base_url, '');
    assert.equal(lan.parseFriendCode('NOVAI-483920').code, '483920');
    assert.equal(lan.parseFriendCode('7K3F9Q').code, '7K3F9Q');
    assert.equal(lan.parseFriendCode('NOVAI-7k3f9q').code, '7K3F9Q');
    assert.equal(lan.parseFriendCode('NOVAI-12345A'), null);
    console.log('[lan-doc] 好友码解析通过');
}

function testMessages(lan) {
    const merged = lan.mergeLanMessages(
        [
            { id: 'm1', ts: 100, dir: 'out', kind: 'text', text: '一' },
            { id: 'm2', ts: 300, dir: 'in', kind: 'text', text: '二' },
            { id: 'm2', ts: 200, dir: 'in', kind: 'text', text: '旧的二' },
        ],
        [
            { id: 'm3', ts: 200, dir: 'out', kind: 'text', text: '三' },
            { id: 'm2', ts: 300, dir: 'in', kind: 'text', text: '新的二' },
        ],
    );
    assert.deepEqual(merged.map((m) => m.id), ['m1', 'm3', 'm2']);
    assert.equal(merged.find((m) => m.id === 'm2').text, '新的二');
    assert.deepEqual(lan.mergeLanMessages([], []), []);
    assert.equal(lan.mergeLanMessages(null, [{ id: 'x', ts: 1 }]).length, 1);

    assert.equal(lan.unreadTotal([{ unread: 1 }, { unread: 2 }, { unread: 0 }]), 3);
    assert.equal(lan.unreadTotal([{ unread: -1 }, {}]), 0);
    assert.equal(lan.unreadTotal(null), 0);
    assert.equal(lan.onlineCount([{ online: true }, { online: false }, {}]), 1);

    assert.equal(lan.avatarText({ nickname: '老板', avatar: '🐼' }), '🐼');
    assert.equal(lan.avatarText({ nickname: 'alice', avatar: '' }), 'A');
    assert.equal(lan.avatarText({ nickname: '', avatar: '' }), '友');
    assert.equal(lan.avatarText(null), '友');
    assert.equal(lan.isDataAvatar('data:image/png;base64,xx'), true);
    assert.equal(lan.isDataAvatar('🐼'), false);

    assert.equal(lan.messagePreview({ kind: 'canvas', canvas_title: '主图工作流' }), '画布 · 主图工作流');
    assert.equal(lan.messagePreview({ kind: 'canvas' }), '画布 · 未命名画布');
    assert.equal(lan.messagePreview({ kind: 'text', text: ' 你好\n在吗 ' }), '你好 在吗');
    assert.equal(lan.messagePreview({ kind: 'text', text: '' }), '还没有消息');
    assert.equal(lan.messagePreview(null), '还没有消息');
    console.log('[lan-doc] 消息合并 / 未读通过');
}

function testTimeAndStatus(lan) {
    const now = new Date(2026, 10, 7, 15, 30, 0).getTime();   // 2026-11-07 15:30 本地
    const today = new Date(2026, 10, 7, 9, 5, 0).getTime();
    const yesterday = new Date(2026, 10, 6, 22, 8, 0).getTime();
    const old = new Date(2026, 9, 31, 8, 0, 0).getTime();
    assert.equal(lan.messageTimeLabel(today, now), '09:05');
    assert.equal(lan.messageTimeLabel(yesterday, now), '昨天 22:08');
    assert.equal(lan.messageTimeLabel(old, now), '10月31日 08:00');
    assert.equal(lan.messageTimeLabel(0, now), '');

    assert.equal(lan.daySeparator(today, 0, now), '今天');
    assert.equal(lan.daySeparator(today, today - 3600000, now), '');
    assert.equal(lan.daySeparator(yesterday, today, now), '昨天');
    assert.equal(lan.daySeparator(old, yesterday, now), '10月31日');
    assert.equal(lan.daySeparator(0, today, now), '');

    assert.equal(lan.friendStatusLabel({ online: true, last_seen: 0 }, now), '在线');
    assert.equal(lan.friendStatusLabel({ online: false, last_seen: 0 }, now), '离线');
    assert.equal(lan.friendStatusLabel({ online: false, last_seen: now - 3 * 60000 }, now), '离线 · 3 分钟前在线');
    assert.equal(lan.friendStatusLabel({ online: false, last_seen: now - 5 * 3600000 }, now), '离线 · 5 小时前在线');
    assert.equal(lan.friendStatusLabel({ online: false, last_seen: now - 5 * 86400000 }, now), '离线');
    assert.equal(lan.friendStatusLabel(null, now), '');

    assert.ok(lan.lanErrorMessage(0).includes('连不上'));
    assert.equal(lan.lanErrorMessage(400, '好友码格式不对'), '好友码格式不对');
    assert.ok(lan.lanErrorMessage(400).includes('好友码'));
    assert.ok(lan.lanErrorMessage(403).includes('凭据'));
    assert.equal(lan.lanErrorMessage(502, '对方离线或端口不通，消息已保存，可以稍后重发'), '对方离线或端口不通，消息已保存，可以稍后重发');
    assert.ok(lan.lanErrorMessage(500).includes('稍后'));
    assert.ok(lan.lanErrorMessage(418).length > 0);

    assert.equal(lan.shareTokenOf('http://192.168.1.8:3000/static/canvas.html?share=' + TOKEN_A), TOKEN_A);
    assert.equal(lan.shareTokenOf('http://192.168.1.8:3000/static/canvas.html?share=' + TOKEN_A + '&token=lan'), TOKEN_A);
    assert.equal(lan.shareTokenOf(TOKEN_A), '');
    assert.equal(lan.shareTokenOf('http://x/y'), '');
    assert.equal(lan.shareTokenOf(null), '');

    const id = lan.newMessageId();
    assert.match(id, /^[A-Za-z0-9_-]{6,64}$/);
    assert.notEqual(lan.newMessageId(), id);
    console.log('[lan-doc] 时间 / 状态 / 错误文案通过');
}

function testAbsolutize(lan) {
    const snapshot = {
        title: 'B 的画布',
        canvas: {
            nodes: [
                { id: 'n1', data: { gen: { hist: [{ url: '/output/a.png' }, { url: '/output/b.jpg', frame: 'data:image/png;base64,x' }] } } },
                { id: 'n2', url: 'https://cdn.test/x.png' },
                { id: 'n3', url: '/assets/library/cover.png' },
            ],
            connections: [],
        },
    };
    const out = lan.absolutizeSnapshot(snapshot, 'http://192.168.1.9:3000/static/canvas.html?share=tok&token=lanpw');
    assert.equal(out.canvas.nodes[0].data.gen.hist[0].url, 'http://192.168.1.9:3000/output/a.png?token=lanpw');
    assert.equal(out.canvas.nodes[0].data.gen.hist[1].frame, 'data:image/png;base64,x');
    assert.equal(out.canvas.nodes[1].url, 'https://cdn.test/x.png');
    assert.equal(out.canvas.nodes[2].url, 'http://192.168.1.9:3000/assets/library/cover.png?token=lanpw');
    assert.equal(snapshot.canvas.nodes[0].data.gen.hist[0].url, '/output/a.png');

    const noToken = lan.absolutizeSnapshot(snapshot, 'http://192.168.1.9:3000/static/canvas.html?share=tok');
    assert.equal(noToken.canvas.nodes[0].data.gen.hist[0].url, 'http://192.168.1.9:3000/output/a.png');
    assert.equal(lan.absolutizeSnapshot(snapshot, 'not a url'), snapshot);
    assert.equal(lan.absolutizeSnapshot(null, 'http://192.168.1.9:3000/x'), null);
    console.log('[lan-doc] 快照相对路径补 origin 通过');
}

function pythonProbe() {
    const candidates = [path.join(root, 'venv/bin/python'), 'python3'];
    for (const bin of candidates) {
        const probe = spawnSync(bin, ['-c', 'import fastapi, fastapi.testclient'], { encoding: 'utf8' });
        if (probe.status === 0) return bin;
    }
    return '';
}

function testBackend() {
    const python = pythonProbe();
    if (!python) {
        console.log('[lan-backend] 跳过：没有能 import fastapi 的 python（venv/bin/python 或 python3）');
        return;
    }
    const result = spawnSync(python, [path.join(__dirname, 'test_lan_account_store.py')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const output = (result.stdout || '') + (result.stderr || '');
    console.log(output.trim());
    assert.equal(result.status, 0, '后端好友单测退出码 ' + result.status);
}

const lan = loadTs('novai-canvas-ui/src/canvas/canvas-next/ui/lanDoc.ts');
testFriendCode(lan);
testMessages(lan);
testTimeAndStatus(lan);
testAbsolutize(lan);
testBackend();
console.log('[lan] T51 局域网好友 / 聊天测试全部通过');
