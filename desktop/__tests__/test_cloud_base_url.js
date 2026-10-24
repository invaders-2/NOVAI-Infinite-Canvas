#!/usr/bin/env node
/*
 * desktop/cloud-config.js 的纯函数单测（不启动 Electron、不联网）。
 *
 *   node desktop/__tests__/test_cloud_base_url.js
 *
 * 覆盖：NOVAI_URL 优先 / 配置文件次之 / 都没有回退本机 / NOVAI_LOCAL_BACKEND=1 强制本机 /
 *       非法或损坏的配置一律忽略。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeBaseUrl, readCloudBaseUrl, resolveBaseUrl } = require('../cloud-config');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log('  ok - ' + name);
}

function tmpUserData() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'novai-cloud-config-'));
}

function writeConfig(dir, value) {
    fs.writeFileSync(path.join(dir, 'novai-cloud.json'), value);
}

const created = [];

try {
    console.log('[cloud-config] normalizeBaseUrl');

    check('接受 http 并保留端口', () => {
        assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    });
    check('接受 https 并去掉多余空白/尾斜杠', () => {
        assert.strictEqual(normalizeBaseUrl('  https://novai.example.com/  '), 'https://novai.example.com');
    });
    check('保留一级路径', () => {
        assert.strictEqual(normalizeBaseUrl('https://example.com/novai/'), 'https://example.com/novai');
    });
    check('拒绝非 http(s) 协议', () => {
        assert.strictEqual(normalizeBaseUrl('ftp://example.com'), '');
        assert.strictEqual(normalizeBaseUrl('file:///tmp/x'), '');
        assert.strictEqual(normalizeBaseUrl('javascript:alert(1)'), '');
    });
    check('拒绝不是绝对地址 / 空值', () => {
        assert.strictEqual(normalizeBaseUrl('novai.example.com'), '');
        assert.strictEqual(normalizeBaseUrl(''), '');
        assert.strictEqual(normalizeBaseUrl('   '), '');
        assert.strictEqual(normalizeBaseUrl(null), '');
        assert.strictEqual(normalizeBaseUrl(123), '');
    });

    console.log('[cloud-config] readCloudBaseUrl');

    check('读取合法配置文件', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'https://cloud.example.com/' }));
        assert.strictEqual(readCloudBaseUrl(dir), 'https://cloud.example.com');
    });
    check('配置文件不存在返回空', () => {
        const dir = tmpUserData();
        created.push(dir);
        assert.strictEqual(readCloudBaseUrl(dir), '');
    });
    check('JSON 损坏返回空（不能把桌面端卡死）', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, '{ not json');
        assert.strictEqual(readCloudBaseUrl(dir), '');
    });
    check('baseUrl 非法时返回空', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'ftp://cloud.example.com' }));
        assert.strictEqual(readCloudBaseUrl(dir), '');
    });
    check('未传数据目录返回空', () => {
        assert.strictEqual(readCloudBaseUrl(''), '');
        assert.strictEqual(readCloudBaseUrl(undefined), '');
    });

    console.log('[cloud-config] resolveBaseUrl');

    check('NOVAI_URL 优先于配置文件', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'https://from-config.example.com' }));
        const result = resolveBaseUrl({
            env: { NOVAI_URL: 'https://from-env.example.com/' },
            userDataDir: dir,
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'https://from-env.example.com', source: 'env' });
    });
    check('没有 env 时用配置文件', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'https://from-config.example.com' }));
        const result = resolveBaseUrl({
            env: {},
            userDataDir: dir,
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'https://from-config.example.com', source: 'config' });
    });
    check('多个候选目录时按顺序找配置文件', () => {
        const first = tmpUserData();
        const second = tmpUserData();
        created.push(first, second);
        writeConfig(second, JSON.stringify({ baseUrl: 'https://second.example.com' }));
        const result = resolveBaseUrl({
            env: {},
            userDataDirs: [first, second],
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'https://second.example.com', source: 'config' });
    });
    check('都没有时回退本机地址', () => {
        const dir = tmpUserData();
        created.push(dir);
        const result = resolveBaseUrl({
            env: {},
            userDataDir: dir,
            localUrl: 'http://127.0.0.1:3456',
        });
        assert.deepStrictEqual(result, { baseUrl: 'http://127.0.0.1:3456', source: 'local' });
    });
    check('默认本机地址是 3000', () => {
        assert.deepStrictEqual(resolveBaseUrl({ env: {} }), {
            baseUrl: 'http://127.0.0.1:3000',
            source: 'local',
        });
    });
    check('NOVAI_LOCAL_BACKEND=1 跳过配置文件', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'https://from-config.example.com' }));
        const result = resolveBaseUrl({
            env: { NOVAI_LOCAL_BACKEND: '1' },
            userDataDir: dir,
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'http://127.0.0.1:3000', source: 'local' });
    });
    check('NOVAI_LOCAL_BACKEND=1 时显式 NOVAI_URL 仍优先', () => {
        const result = resolveBaseUrl({
            env: { NOVAI_LOCAL_BACKEND: '1', NOVAI_URL: 'https://explicit.example.com' },
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'https://explicit.example.com', source: 'env' });
    });
    check('NOVAI_URL 非法时继续看配置文件', () => {
        const dir = tmpUserData();
        created.push(dir);
        writeConfig(dir, JSON.stringify({ baseUrl: 'https://from-config.example.com' }));
        const result = resolveBaseUrl({
            env: { NOVAI_URL: 'not-a-url' },
            userDataDir: dir,
            localUrl: 'http://127.0.0.1:3000',
        });
        assert.deepStrictEqual(result, { baseUrl: 'https://from-config.example.com', source: 'config' });
    });

    console.log('');
    console.log('[cloud-config] ' + passed + ' 项断言全部通过');
} finally {
    created.forEach((dir) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
    });
}
