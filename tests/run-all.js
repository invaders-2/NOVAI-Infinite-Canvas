#!/usr/bin/env node
/*
 * 测试 runner。核心用例零依赖；画布助手 TypeScript 用例需要先按 CI 配置安装 canvas-ui 开发依赖。
 *
 *   node tests/run-all.js                  跑除 live 外的全部 node 测试
 *   node tests/run-all.js --include-live   连 test_video_storyboard_live.js 一起跑
 *   node tests/run-all.js --ci-baseline    只拦「不在 tests/known-failures.json 里的新增失败」
 *
 * 依次用当前 node（process.execPath）运行 tests/ 下的 test_*.js：
 *   - 任一测试非零退出 / 被信号杀死 → 整体 exit 1；全部通过 → exit 0。
 *   - test_video_storyboard_live.js 需要真实服务 + 配好的 provider，默认跳过，CI 不跑。
 *
 * --ci-baseline 行为：
 *   - tests/known-failures.json 里登记过的失败只提示、不拦截；
 *   - 只有「不在基线里的失败」才返回非零（新增失败 N 条）；
 *   - 基线里某项现在通过了（或测试文件已不存在）→ 提示「基线过期，请删掉这条」，但不返回非零；
 *   - 汇总固定打印：基线内失败 N 条 / 新增失败 M 条 / 过期 K 条。
 *   - 不带该参数时行为与旧版完全一致（输出、exit code 都不变）。
 *
 * 注意：tests/test_canvas_log_cleanup.py 是**陈旧**测试：它 import 的
 *   main.delete_canvas_log / main.collect_local_media_urls / main.generated_media_path_from_url
 *   在本分支 HEAD 的 main.py 里都不存在（grep 计数为 0），跑起来必然报错。
 *   本 runner 只跑 node 测试；.github/workflows/tests.yml 只跑有效的 python 单测，
 *   所以它不会进 CI（文件保留，未删除）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = __dirname;
const LIVE_TEST = 'test_video_storyboard_live.js';
const BASELINE_FILE = path.join(testsDir, 'known-failures.json');

function parseArgs(argv) {
    const list = Array.isArray(argv) ? argv : [];
    return {
        includeLive: list.includes('--include-live'),
        ciBaseline: list.includes('--ci-baseline'),
    };
}

// 基线文件只按 file 字段匹配；reason / since 是给人看的，不参与判定。
function loadKnownFailures(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.failures) ? raw.failures : []);
        const entries = new Map();
        const duplicates = [];
        for (const item of list) {
            const name = String((item && item.file) || '').trim();
            if (!name) continue;
            if (entries.has(name)) {
                duplicates.push(name);
                continue;
            }
            entries.set(name, {
                file: name,
                reason: String((item && item.reason) || '').trim(),
                since: String((item && item.since) || '').trim(),
            });
        }
        return { ok: true, entries, duplicates };
    } catch (err) {
        return { ok: false, entries: new Map(), duplicates: [], error: err };
    }
}

function classifyResults(results, baselineEntries) {
    const knownFailures = [];
    const newFailures = [];
    const stale = [];
    const resultByName = new Map();
    for (const result of results) {
        resultByName.set(result.name, result);
        if (result.ok) continue;
        if (baselineEntries.has(result.name)) knownFailures.push(result.name);
        else newFailures.push(result.name);
    }
    for (const name of baselineEntries.keys()) {
        const result = resultByName.get(name);
        if (!result) stale.push({ name, why: '测试文件已不存在' });
        else if (result.ok) stale.push({ name, why: '现在已通过' });
    }
    stale.sort((a, b) => a.name.localeCompare(b.name));
    knownFailures.sort();
    newFailures.sort();
    return { knownFailures, newFailures, stale };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const files = fs.readdirSync(testsDir)
        .filter(name => /^test_.*\.js$/.test(name))
        .filter(name => args.includeLive || name !== LIVE_TEST)
        .sort();

    if (!files.length) {
        console.error('[run-all] 没有找到任何 node 测试');
        process.exit(1);
    }

    let baseline = { ok: true, entries: new Map(), duplicates: [] };
    if (args.ciBaseline) {
        baseline = loadKnownFailures(BASELINE_FILE);
        if (!baseline.ok) {
            // 基线读不到时按「空基线」运行：宁可拦下所有失败，也不让坏文件把门禁放空。
            console.warn('[run-all] 警告：读不到基线文件 ' + BASELINE_FILE + '（' + (baseline.error && baseline.error.message || baseline.error) + '），按空基线运行');
        }
        if (baseline.duplicates.length) {
            console.warn('[run-all] 警告：基线里重复登记的测试已忽略：' + baseline.duplicates.join(', '));
        }
        console.log('[run-all] CI 基线模式：已登记已知失败 ' + baseline.entries.size + ' 条（' + path.relative(process.cwd(), BASELINE_FILE) + '）');
    }

    console.log('[run-all] node ' + process.version + ' · 共 ' + files.length + ' 个测试'
        + (args.includeLive ? '（含 live）' : '（已跳过 ' + LIVE_TEST + '）'));

    const results = [];
    let failed = 0;
    for (const name of files) {
        const startedAt = Date.now();
        const result = spawnSync(process.execPath, [path.join(testsDir, name)], { stdio: 'inherit' });
        const ms = Date.now() - startedAt;
        const code = result.status === null ? 1 : result.status;
        const ok = !result.error && code === 0;
        const known = !ok && args.ciBaseline && baseline.entries.has(name);
        if (!ok) failed += 1;
        results.push({ name, ms, code, ok });
        console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' (' + ms + 'ms'
            + (ok ? '' : ', exit ' + code + (result.error ? ', ' + result.error.message : '')) + ')'
            + (known ? '（基线内，不拦截）' : ''));
    }

    console.log('');
    const passed = results.length - failed;

    if (!args.ciBaseline) {
        console.log('[run-all] 结果：' + passed + '/' + results.length + ' 通过');
        if (failed) {
            console.error('[run-all] ' + failed + ' 个测试失败');
            process.exit(1);
        }
        console.log('[run-all] 全部通过');
        process.exit(0);
    }

    const classified = classifyResults(results, baseline.entries);
    const knownCount = classified.knownFailures.length;
    const newCount = classified.newFailures.length;
    const staleCount = classified.stale.length;

    console.log('[run-all] 结果：' + passed + '/' + results.length + ' 通过');
    if (knownCount) {
        console.log('[run-all] 基线内失败 ' + knownCount + ' 条（视为已知，不拦截）：');
        classified.knownFailures.forEach((name) => {
            const entry = baseline.entries.get(name);
            const reason = entry && entry.reason ? ' — ' + entry.reason : '';
            console.log('  - ' + name + (entry && entry.since ? '（since ' + entry.since + '）' : '') + reason);
        });
    }
    if (newCount) {
        console.error('[run-all] 新增失败 ' + newCount + ' 条（不在基线内）：');
        classified.newFailures.forEach((name) => console.error('  - ' + name));
    }
    if (staleCount) {
        console.log('[run-all] 基线过期 ' + staleCount + ' 条（不拦截，请顺手清理）：');
        classified.stale.forEach((item) => {
            console.log('  - 基线过期，请删掉这条：' + item.name + '（' + item.why + '）');
        });
    }
    console.log('[run-all] 基线内失败 ' + knownCount + ' 条 / 新增失败 ' + newCount + ' 条 / 过期 ' + staleCount + ' 条');

    if (newCount) {
        console.error('[run-all] CI 拦截：' + newCount + ' 个新增失败不在基线内');
        process.exit(1);
    }
    console.log('[run-all] 基线内失败不拦截，CI 通过');
    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = { parseArgs, loadKnownFailures, classifyResults, BASELINE_FILE };
