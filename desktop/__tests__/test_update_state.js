#!/usr/bin/env node
/*
 * desktop/update-state.js 的纯逻辑单测（不启动 Electron、不联网）。
 *
 *   node desktop/__tests__/test_update_state.js
 *
 * 覆盖：状态文件坏 JSON 不崩、applied 判定、bootAttempts 阈值与回滚判定、
 *       pending 不重复安装、备份路径、更新说明过滤。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const updateState = require('../update-state');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log('  ok - ' + name);
}

const created = [];

function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novai-update-state-'));
    created.push(dir);
    return dir;
}

try {
    console.log('[update-state] 状态文件');

    check('文件不存在时返回默认状态', () => {
        const dir = tmpDir();
        assert.deepStrictEqual(updateState.readState(dir), updateState.defaultState());
    });

    check('坏 JSON 不抛错，当成第一次启动', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, updateState.STATE_FILE), '{ this is not json');
        assert.deepStrictEqual(updateState.readState(dir), updateState.defaultState());
    });

    check('非对象 JSON 也不崩', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, updateState.STATE_FILE), '[1,2,3]');
        assert.deepStrictEqual(updateState.readState(dir), updateState.defaultState());
    });

    check('写入后能读回，字段类型被收敛', () => {
        const dir = tmpDir();
        updateState.writeState(dir, {
            lastRunVersion: ' 2.0.7 ',
            pendingVersion: null,
            bootAttempts: '3',
            installAttempts: -1,
        });
        const state = updateState.readState(dir);
        assert.strictEqual(state.lastRunVersion, '2.0.7');
        assert.strictEqual(state.pendingVersion, '');
        assert.strictEqual(state.bootAttempts, 3);
        assert.strictEqual(state.installAttempts, 0);
    });

    check('patchState 只改给定字段', () => {
        const dir = tmpDir();
        updateState.writeState(dir, { lastRunVersion: '2.0.6', pendingVersion: '2.0.7' });
        const state = updateState.patchState(dir, { notesSeenVersion: '2.0.7' });
        assert.strictEqual(state.lastRunVersion, '2.0.6');
        assert.strictEqual(state.pendingVersion, '2.0.7');
        assert.strictEqual(state.notesSeenVersion, '2.0.7');
    });

    console.log('[update-state] 启动自检 / applied');

    check('isApplied：版本变了才算升级完成', () => {
        assert.strictEqual(updateState.isApplied('2.0.6', '2.0.7'), true);
        assert.strictEqual(updateState.isApplied('2.0.7', '2.0.7'), false);
        assert.strictEqual(updateState.isApplied('', '2.0.7'), false);
        assert.strictEqual(updateState.isApplied('2.0.6', ''), false);
    });

    check('beginBoot：升级后首启返回 applied 并清掉 pending', () => {
        const previous = updateState.sanitizeState({
            lastRunVersion: '2.0.6',
            pendingVersion: '2.0.7',
            bootAttempts: 0,
            installAttempts: 2,
        });
        const boot = updateState.beginBoot(previous, '2.0.7');
        assert.strictEqual(boot.applied, true);
        assert.strictEqual(boot.previousVersion, '2.0.6');
        assert.strictEqual(boot.state.lastRunVersion, '2.0.7');
        assert.strictEqual(boot.state.pendingVersion, '');
        assert.strictEqual(boot.state.bootAttempts, 0);
        assert.strictEqual(boot.state.installAttempts, 0);
        assert.strictEqual(boot.rollback, false);
    });

    check('beginBoot：普通启动累加 bootAttempts，不算 applied', () => {
        const boot = updateState.beginBoot({ lastRunVersion: '2.0.6' }, '2.0.6');
        assert.strictEqual(boot.applied, false);
        assert.strictEqual(boot.state.bootAttempts, 1);
        assert.strictEqual(boot.pendingStale, false);
    });

    check('bootAttempts 阈值：第一次失败不回滚，第二次才回滚', () => {
        let state = updateState.sanitizeState({
            lastRunVersion: '2.0.7',
            backupDir: '/tmp/backup',
            backupVersion: '2.0.6',
        });
        const first = updateState.beginBoot(state, '2.0.7');
        assert.strictEqual(first.state.bootAttempts, 1);
        assert.strictEqual(first.rollback, false);
        const second = updateState.beginBoot(first.state, '2.0.7');
        assert.strictEqual(second.state.bootAttempts, 2);
        assert.strictEqual(second.rollback, true);
    });

    check('回滚只发生在「当前版本比备份新」时', () => {
        const sameVersion = updateState.beginBoot({
            lastRunVersion: '2.0.6',
            bootAttempts: 1,
            backupDir: '/tmp/backup',
            backupVersion: '2.0.6',
        }, '2.0.6');
        assert.strictEqual(sameVersion.state.bootAttempts, 2);
        assert.strictEqual(sameVersion.rollback, false);
        const noBackup = updateState.beginBoot({ lastRunVersion: '2.0.7', bootAttempts: 1 }, '2.0.7');
        assert.strictEqual(noBackup.rollback, false);
    });

    check('pendingVersion 还是旧版本时标记 pendingStale（关机打断安装）', () => {
        const boot = updateState.beginBoot({ lastRunVersion: '2.0.6', pendingVersion: '2.0.7' }, '2.0.6');
        assert.strictEqual(boot.pendingStale, true);
    });

    check('安装重试次数用完时 giveUp', () => {
        const boot = updateState.beginBoot({ lastRunVersion: '2.0.6', installAttempts: 2 }, '2.0.6');
        assert.strictEqual(boot.giveUp, true);
    });

    console.log('[update-state] 退出安装判定');

    check('pending 存在且不是当前版本 → 退出时安装', () => {
        const state = { pendingVersion: '2.0.7' };
        assert.strictEqual(updateState.shouldInstallOnQuit(state, '2.0.6'), true);
    });

    check('没有 pending / 已经在跑这个版本 → 不重复安装', () => {
        assert.strictEqual(updateState.shouldInstallOnQuit({ pendingVersion: '' }, '2.0.6'), false);
        assert.strictEqual(updateState.shouldInstallOnQuit({ pendingVersion: '2.0.6' }, '2.0.6'), false);
    });

    check('重试次数用完 → 不再安装，避免退出就弹安装', () => {
        assert.strictEqual(updateState.shouldInstallOnQuit({
            pendingVersion: '2.0.7',
            installAttempts: 2,
        }, '2.0.6'), false);
    });

    check('坏字段不抛错', () => {
        assert.strictEqual(updateState.shouldInstallOnQuit(null, '2.0.6'), false);
        assert.strictEqual(updateState.shouldInstallOnQuit({ pendingVersion: 123 }, '2.0.6'), false);
    });

    console.log('[update-state] 备份路径');

    check('Windows/Linux 备份 asar + 可执行文件', () => {
        const plan = updateState.backupPlan({
            platform: 'win32',
            resourcesPath: '/app/resources',
            exePath: '/app/NOVAI.exe',
        });
        assert.deepStrictEqual(plan.map((item) => item.name), ['app.asar', 'executable.exe']);
        assert.strictEqual(plan[0].live, path.join('/app/resources', 'app.asar'));
        assert.strictEqual(plan[1].live, '/app/NOVAI.exe');
    });

    check('macOS 备份 .app 内的 asar + MacOS 可执行文件', () => {
        const plan = updateState.backupPlan({
            platform: 'darwin',
            resourcesPath: '/Applications/NOVAI.app/Contents/Resources',
            exePath: '/Applications/NOVAI.app/Contents/MacOS/NOVAI',
        });
        assert.deepStrictEqual(plan.map((item) => item.live), [
            '/Applications/NOVAI.app/Contents/Resources/app.asar',
            '/Applications/NOVAI.app/Contents/MacOS/NOVAI',
        ]);
    });

    check('缺路径时跳过，不生成非法条目', () => {
        assert.deepStrictEqual(updateState.backupPlan({}), []);
        assert.deepStrictEqual(updateState.backupPlan({ resourcesPath: '' }), []);
    });

    console.log('[update-state] 更新说明过滤');

    check('契约结构原样保留，type 不在白名单时归为 feature', () => {
        const notes = updateState.normalizeNotes('2.0.7', {
            version: '2.0.7',
            updated_at: '2026-11-10',
            items: [
                { type: 'feature', text: '新增无限画布组' },
                { type: 'fix', text: '修复导出崩溃' },
                { type: 'improve', text: '优化首屏加载' },
                { type: 'unknown', text: '其它改动' },
            ],
        });
        assert.strictEqual(notes.version, '2.0.7');
        assert.strictEqual(notes.updated_at, '2026-11-10');
        assert.deepStrictEqual(notes.items.map((item) => item.type), ['feature', 'fix', 'improve', 'feature']);
    });

    check('空文本 / 重复文本被过滤', () => {
        const notes = updateState.normalizeNotes('2.0.7', {
            items: [
                { type: 'feature', text: '   ' },
                { type: 'feature', text: '同一条' },
                { type: 'fix', text: '同一条' },
            ],
        });
        assert.deepStrictEqual(notes.items.map((item) => item.text), ['同一条']);
    });

    check('媒体类型白名单：非法 media 被丢弃但保留文字', () => {
        const notes = updateState.normalizeNotes('2.0.7', {
            items: [
                { type: 'feature', text: '带图', media: { type: 'image', src: 'https://x/a.png', caption: '效果' } },
                { type: 'feature', text: '带视频', media: { type: 'video', src: 'https://x/a.mp4' } },
                { type: 'feature', text: '非法媒体', media: { type: 'audio', src: 'https://x/a.mp3' } },
                { type: 'feature', text: '无地址', media: { type: 'image' } },
            ],
        });
        assert.deepStrictEqual(notes.items[0].media, { type: 'image', src: 'https://x/a.png', caption: '效果' });
        assert.deepStrictEqual(notes.items[1].media, { type: 'video', src: 'https://x/a.mp4' });
        assert.strictEqual(notes.items[2].media, undefined);
        assert.strictEqual(notes.items[3].media, undefined);
    });

    check('版本不匹配的说明不串版本', () => {
        assert.strictEqual(updateState.normalizeNotes('2.0.8', { version: '2.0.7', items: [{ text: '旧说明' }] }), null);
    });

    check('electron-updater 的 releaseNotes 数组只取当前版本', () => {
        const notes = updateState.normalizeNotes('2.0.7', [
            { version: '2.0.6', note: '旧版本说明' },
            { version: '2.0.7', note: '<h3>更新内容</h3><ul><li>修复编辑器崩溃</li><li>优化启动速度</li></ul>' },
        ]);
        assert.strictEqual(notes.items.length, 2);
        assert.strictEqual(notes.items[0].type, 'fix');
        assert.strictEqual(notes.items[0].text, '修复编辑器崩溃');
        assert.strictEqual(notes.items[1].type, 'improve');
    });

    check('纯文本 releaseNotes 也能切成条目并限制长度', () => {
        const long = '新增' + '很长的说明'.repeat(60);
        const notes = updateState.normalizeNotes('2.0.7', '- ' + long + '\n- 修复崩溃');
        assert.strictEqual(notes.items.length, 2);
        assert.ok(notes.items[0].text.length <= 200);
        assert.strictEqual(notes.items[1].type, 'fix');
    });

    check('没有可用条目 / 无版本时返回 null', () => {
        assert.strictEqual(updateState.normalizeNotes('2.0.7', ''), null);
        assert.strictEqual(updateState.normalizeNotes('2.0.7', '   \n  '), null);
        assert.strictEqual(updateState.normalizeNotes('', { items: [{ text: 'x' }] }), null);
    });

    console.log('[update-state] 版本号补零');

    check('2.0.07 与 2.0.7 视为同一版本，2.0.6 不是', () => {
        assert.strictEqual(updateState.versionEquals('2.0.07', '2.0.7'), true);
        assert.strictEqual(updateState.versionEquals('v2.0.7', '2.0.07'), true);
        assert.strictEqual(updateState.versionEquals('2.0.6', '2.0.7'), false);
        assert.strictEqual(updateState.versionEquals('2.0.7', ''), false);
    });

    check('补零版本号的说明能匹配到当前版本', () => {
        const notes = updateState.normalizeNotes('2.0.7', {
            version: '2.0.07',
            updated_at: '2026-11-10',
            items: [{ type: 'feature', text: '静默下载' }],
        });
        assert.strictEqual(notes.items[0].text, '静默下载');
        assert.strictEqual(updateState.normalizeNotes('2.0.6', { version: '2.0.07', items: [{ text: 'x' }] }), null);
    });

    check('根 update-notes.json 的 versions/changes 格式也能读', () => {
        const notes = updateState.normalizeNotes('2.0.7', {
            versions: [
                {
                    version: '2.0.07',
                    date: '2026-11-10',
                    changes: [
                        '更新改为后台静默下载',
                        { text: '右下角更新卡片', media: { type: 'gif', src: '/static/updates/2.0.07/update-card.gif', caption: '演示' } },
                        { text: '非法媒体', media: { type: 'audio', src: '/x.mp3' } },
                    ],
                },
                { version: '2.0.05', date: '2026-11-08', changes: ['旧版本'] },
            ],
        });
        assert.strictEqual(notes.version, '2.0.7');
        assert.strictEqual(notes.updated_at, '2026-11-10');
        assert.deepStrictEqual(notes.items.map((item) => item.text), ['更新改为后台静默下载', '右下角更新卡片', '非法媒体']);
        assert.deepStrictEqual(notes.items[1].media, {
            type: 'gif',
            src: '/static/updates/2.0.07/update-card.gif',
            caption: '演示',
        });
        assert.strictEqual(notes.items[2].media, undefined);
    });

    check('versions 里没有当前版本时返回 null', () => {
        assert.strictEqual(updateState.normalizeNotes('2.0.9', {
            versions: [{ version: '2.0.07', changes: ['x'] }],
        }), null);
    });

    console.log('[update-state] 说明已读判定');

    check('没看过 / 看过当前版本', () => {
        const notes = updateState.normalizeNotes('2.0.7', { items: [{ text: '新增功能' }] });
        assert.strictEqual(updateState.shouldShowNotes(notes, ''), true);
        assert.strictEqual(updateState.shouldShowNotes(notes, '2.0.6'), true);
        assert.strictEqual(updateState.shouldShowNotes(notes, '2.0.7'), false);
        assert.strictEqual(updateState.shouldShowNotes(null, ''), false);
    });

    console.log('');
    console.log('[update-state] ' + passed + ' 项断言全部通过');
} finally {
    created.forEach((dir) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
    });
}
