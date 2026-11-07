#!/usr/bin/env node
'use strict';
// VERSION 是给人看的显示串（如 2.0.02），electron-updater 只认合法 semver（2.0.2）：
// 打包前把 desktop/package.json 的 version 归一化，否则 AppUpdater 构造时直接抛
// 「App version is not a valid semver version」，自动更新整个失效。
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..');

function readDisplayVersion() {
    const file = path.join(REPO, 'VERSION');
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        throw new Error('读不到 VERSION: ' + file);
    }
    const line = String(text).trim().split(/\r?\n/)[0].trim();
    if (!line) throw new Error('VERSION 是空的: ' + file);
    return line;
}

// 每段去前导零：2.0.02 → 2.0.2；带 -beta.1 这类预发布后缀时原样保留
function toSemver(display) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.exec(display);
    if (!m) throw new Error('VERSION 不是合法的三段式版本号: ' + JSON.stringify(display));
    const core = [m[1], m[2], m[3]].map(n => String(Number(n))).join('.');
    return m[4] ? core + m[4] : core;
}

function main() {
    const display = readDisplayVersion();
    const version = toSemver(display);
    const pkgFile = path.join(DESKTOP, 'package.json');
    const raw = fs.readFileSync(pkgFile, 'utf8');
    // 只替换顶层 version 那一处字符串，文件其余内容（2 空格缩进等）保持原样
    const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, '$1' + version + '$2');
    if (next === raw && !raw.includes('"version": "' + version + '"')) {
        throw new Error('package.json 里没找到 version 字段: ' + pkgFile);
    }
    if (next !== raw) fs.writeFileSync(pkgFile, next);
    console.log('VERSION ' + display + ' → desktop/package.json version ' + version);
}

main();
