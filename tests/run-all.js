#!/usr/bin/env node
/*
 * 零依赖测试 runner（不依赖 npm install / 不需要网络）。
 *
 *   node tests/run-all.js                  跑除 live 外的全部 node 测试
 *   node tests/run-all.js --include-live   连 test_video_storyboard_live.js 一起跑
 *
 * 依次用当前 node（process.execPath）运行 tests/ 下的 test_*.js：
 *   - 任一测试非零退出 / 被信号杀死 → 整体 exit 1；全部通过 → exit 0。
 *   - test_video_storyboard_live.js 需要真实服务 + 配好的 provider，默认跳过，CI 不跑。
 *
 * 注意：tests/test_canvas_log_cleanup.py 是**陈旧**测试：它 import 的
 *   main.delete_canvas_log / main.collect_local_media_urls / main.generated_media_path_from_url
 *   在本分支 HEAD 的 main.py 里都不存在（grep 计数为 0），跑起来必然报错。
 *   本 runner 只跑 node 测试；.github/workflows/tests.yml 也只跑两个有效的 python 单测，
 *   所以它不会进 CI（文件保留，未删除）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = __dirname;
const LIVE_TEST = 'test_video_storyboard_live.js';
const includeLive = process.argv.slice(2).includes('--include-live');

const files = fs.readdirSync(testsDir)
    .filter(name => /^test_.*\.js$/.test(name))
    .filter(name => includeLive || name !== LIVE_TEST)
    .sort();

if (!files.length) {
    console.error('[run-all] 没有找到任何 node 测试');
    process.exit(1);
}

console.log('[run-all] node ' + process.version + ' · 共 ' + files.length + ' 个测试'
    + (includeLive ? '（含 live）' : '（已跳过 ' + LIVE_TEST + '）'));

const results = [];
let failed = 0;
for (const name of files) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [path.join(testsDir, name)], { stdio: 'inherit' });
    const ms = Date.now() - startedAt;
    const code = result.status === null ? 1 : result.status;
    const ok = !result.error && code === 0;
    if (!ok) failed += 1;
    results.push({ name, ms, code, ok });
    console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' (' + ms + 'ms'
        + (ok ? '' : ', exit ' + code + (result.error ? ', ' + result.error.message : '')) + ')');
}

console.log('');
console.log('[run-all] 结果：' + (results.length - failed) + '/' + results.length + ' 通过');
if (failed) {
    console.error('[run-all] ' + failed + ' 个测试失败');
    process.exit(1);
}
console.log('[run-all] 全部通过');
process.exit(0);
