#!/usr/bin/env node
/*
 * chat 尺寸口径一致性：web/src/pages/chat/sizes.js 的 SIZE_OPTIONS 必须与
 * main.py 的 CHAT_RATIO_SIZE_OPTIONS 同值，且都取官方 APIMart gpt-image-2
 * 像素映射表的第一组像素（1k/2k/4k）。
 *
 * 官方依据：text/apimart_gpt_image_2_generation_md.txt:380-422
 *   （1:1 1k/2k/4k = 1024²/2048²/2880²；16:9 = 1536x864/2048x1152/3840x2160；
 *     3:4 = 768x1024/1536x2048/2480x3312 等）
 * main.py 真值锚点：APIMART_OFFICIAL_PIXELS（同一份官方表，1k 有两组时取第一组）。
 *
 * 运行：node tests/test_chat_size_parity.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SIZES = path.join(ROOT, 'web/src/pages/chat/sizes.js');
const MAIN = path.join(ROOT, 'main.py');
const LEVELS = ['1k', '2k', '4k'];

// chat 前端 key ↔ main.py / 官方比例
const KEY_TO_RATIO = {
    square: '1:1', portrait: '2:3', landscape: '3:2', portrait43: '3:4',
    landscape43: '4:3', story: '9:16', wide: '16:9',
};

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');

function parseChatOptions(src) {
    const block = (src.match(/CHAT_RATIO_SIZE_OPTIONS = {[\s\S]*?\n\}/) || [])[0];
    if (!block) throw new Error('缺少 CHAT_RATIO_SIZE_OPTIONS：' + MAIN);
    const table = {};
    const entryRe = /^\s*"([^"]+)"\s*:\s*\(([^)]*)\)/gm;
    let m;
    while ((m = entryRe.exec(block))) {
        table[m[1]] = m[2].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    return table;
}

function parseOfficialPixels(src) {
    const block = (src.match(/APIMART_OFFICIAL_PIXELS = {[\s\S]*?\n\}/) || [])[0];
    if (!block) throw new Error('缺少 APIMART_OFFICIAL_PIXELS：' + MAIN);
    const table = {};
    const entryRe = /"([^"]+)"\s*:\s*\{([^}]*)\}/g;
    let m;
    while ((m = entryRe.exec(block))) {
        const tiers = {};
        const cellRe = /"(1k|2k|4k)"\s*:\s*\(\((\d+),\s*(\d+)\)/g;
        let c;
        while ((c = cellRe.exec(m[2]))) tiers[c[1]] = c[2] + 'x' + c[3];
        table[m[1]] = tiers;
    }
    return table;
}

async function main() {
    const sizes = await import(pathToFileURL(SIZES).href);
    const mainSrc = fs.readFileSync(MAIN, 'utf8');
    const backend = parseChatOptions(mainSrc);
    const official = parseOfficialPixels(mainSrc);

    // 1) 前端 RATIOS / LEVELS / SIZE_OPTIONS 的自洽
    eq(sizes.RATIOS.map(r => r.key), Object.keys(KEY_TO_RATIO), 'chat RATIOS 就是 7 个常用比例');
    eq(sizes.LEVELS, LEVELS, 'chat LEVELS = 1k/2k/4k');
    eq(Object.keys(sizes.SIZE_OPTIONS).slice().sort(), Object.keys(KEY_TO_RATIO).slice().sort(), 'chat SIZE_OPTIONS 键 = 7 比例');
    eq(backend && Object.keys(backend), Object.keys(KEY_TO_RATIO).map(k => KEY_TO_RATIO[k]), 'main.py CHAT_RATIO_SIZE_OPTIONS 键 = 7 比例');

    // 2) 两端同值
    Object.keys(KEY_TO_RATIO).forEach(key => {
        const ratio = KEY_TO_RATIO[key];
        const front = (sizes.SIZE_OPTIONS[key] || []).map(item => item[0]);
        eq(front, backend[ratio], 'chat ' + key + '(' + ratio + ') 前后端同值');
    });

    // 3) 同值且等于官方 APIMart 映射表第一组像素
    Object.keys(KEY_TO_RATIO).forEach(key => {
        const ratio = KEY_TO_RATIO[key];
        const expected = LEVELS.map(level => (official[ratio] || {})[level] || '(官方缺)');
        eq(backend[ratio], expected, 'chat ' + ratio + ' 取官方 1k/2k/4k 第一组像素');
    });

    console.log('[chat-size-parity] ' + pass + ' 项通过');
    if (fails.length) {
        fails.slice(0, 60).forEach(msg => console.error('  \u2717 ' + msg));
        if (fails.length > 60) console.error('  \u2026 其余 ' + (fails.length - 60) + ' 项');
        console.error('失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('[chat-size-parity] 全部通过');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
