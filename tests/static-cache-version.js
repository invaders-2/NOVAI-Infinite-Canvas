'use strict';

const fs = require('fs');
const path = require('path');

// 与 tools/refresh_static_versions.py 同一条引用正则（main.py 里那两条正则的 JS 移植）。
const STATIC_REF_RE = /(?:(?:src|href)=["']|@import\s+url\(["'])(\/static\/[^"')\s?#]+(?:\.(?:js|css|html)))(?:\?v=([^"')\s<>]+))?/gi;

function readRootVersion(root) {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim().split('\n')[0].trim();
}

/*
 * 静态页缓存串的硬约束（本地/CI 完全一致，不看文件 mtime 是否等于开发机）：
 * 1) 前缀 === 根 VERSION 原文；
 * 2) 后缀是 10 位正整数（mtime 秒的形态）；
 * 3) 同一文件多处引用值必须一致；页面里每个 /static/ 下的 js/css/html 引用都必须带 ?v=，不许裸链接。
 */
function checkStaticCacheVersions(options) {
    const opts = options || {};
    const root = opts.root;
    const page = opts.page;
    const version = opts.version || readRootVersion(root);
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const problems = [];
    const refs = new Map();
    STATIC_REF_RE.lastIndex = 0;
    let match = STATIC_REF_RE.exec(html);
    while (match) {
        const url = match[1];
        const value = match[2] === undefined ? '' : match[2];
        if (!value) {
            problems.push(url + ' 没有 ?v=（裸链接）');
        } else {
            const dot = value.lastIndexOf('.');
            const prefix = dot >= 0 ? value.slice(0, dot) : value;
            const suffix = dot >= 0 ? value.slice(dot + 1) : '';
            if (prefix !== version) problems.push(url + ' 的 ?v= 前缀是 ' + prefix + '，应为根 VERSION ' + version);
            if (!/^\d{10}$/.test(suffix) || Number(suffix) <= 0) {
                problems.push(url + ' 的 mtime 后缀不是 10 位正整数：' + suffix);
            }
            if (refs.has(url) && refs.get(url) !== value) {
                problems.push(url + ' 多处 ?v= 不一致：' + refs.get(url) + ' / ' + value);
            }
            if (!refs.has(url)) refs.set(url, value);
        }
        match = STATIC_REF_RE.exec(html);
    }
    return { ok: problems.length === 0 && refs.size > 0, problems, refs, version };
}

module.exports = { checkStaticCacheVersions, readRootVersion, STATIC_REF_RE };
