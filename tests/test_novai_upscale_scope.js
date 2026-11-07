#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT「增强」静态验收（进 run-all / CI；不跑浏览器、不依赖后端）：
 *
 *   node tests/test_novai_upscale_scope.js
 *
 * 断言四组：
 *   1) 源码：图片「更多」菜单里「增强」二级浮层的三项（data-k + 文案）被钉住；
 *   2) 构建产物：6 个 data-k / 3 个方法名 / 三项文案 / .enhance-menu 都在；
 *   3) 后端没被这轮需求偷改：/api/image/upscale* 三条路由在 HEAD 里就存在，未提交的 main.py 改动不碰 upscale；
 *   4) 范围：受保护路径（main.py / server / static/js / web / canvas-ui / desktop）里没有本功能标记。
 *
 * mtime 窗口检查（受保护路径在「本轮改动窗口」内零改动）只在本地工作树可信：
 *   - git 检出后所有文件 mtime 都是检出时间，先后关系不可用 —— 源码 mtime 跨度小于 NOVAI_SCOPE_MTIME_SPREAD（默认 300 秒）时自动跳过并打印 SKIP；
 *   - 需要强制跑/改窗口：NOVAI_SCOPE_STRICT=1 / NOVAI_WINDOW_START / NOVAI_WINDOW_END。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const WINDOW_START = process.env.NOVAI_WINDOW_START || '2026-11-05 13:45:00';
const WINDOW_END = process.env.NOVAI_WINDOW_END || '2026-11-05 13:50:00';
const STRICT = process.env.NOVAI_SCOPE_STRICT === '1';
const MTIME_SPREAD = Number(process.env.NOVAI_SCOPE_MTIME_SPREAD || 300) * 1000;
const PROTECTED = ['main.py', 'server', 'static/js', 'web', 'canvas-ui', 'desktop'];
const FEATURE_MARKERS = ['hd-2k', 'hd-4k', 'enhance-flyout', 'upscaleLocal'];
const SOURCE = 'novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx';
const CORE_SOURCES = [
    'novai-canvas-ui/src/canvas/canvas-next/backend/types.ts',
    'novai-canvas-ui/src/novaiBackend.ts',
    'novai-canvas-ui/src/canvas/canvas-next/ui/editors/editors.css',
    SOURCE,
];
/** 「增强」二级浮层的三项：data-k / 主文案 / 右侧提示 */
const FLYOUT_ITEMS = [
    ['hd-2k', '本地 2K', '免费 · 离线'],
    ['hd-4k', '本地 4K', '免费 · 离线'],
    ['enhance-ai', 'AI 增强 2×', '在线模型'],
];
const SKIPPED_TOAST = '原图已经达到这个精度，不用再放大';

let failed = 0;
const results = { checks: {}, failures: [], skipped: [], window: [WINDOW_START, WINDOW_END] };
function check(name, ok, detail) {
    results.checks[name] = ok ? true : { failed: true, detail: detail === undefined ? null : detail };
    if (ok) console.log('PASS  ' + name);
    else { failed += 1; results.failures.push(name); console.log('FAIL  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}
function skip(name, why) {
    results.skipped.push({ name, why });
    console.log('SKIP  ' + name + '（' + why + '）');
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
function sh(cmd, args, fallback = '') {
    try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (error) { return fallback; }
}
function walk(rel, acc = []) {
    const abs = path.join(root, rel);
    if (!exists(rel)) return acc;
    // desktop/release 是本地打包输出（.gitignore），不参与源码回归扫描
    if (rel === 'desktop/release') return acc;
    if (!fs.statSync(abs).isDirectory()) { acc.push(rel); return acc; }
    for (const entry of fs.readdirSync(abs)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(path.join(rel, entry), acc);
    }
    return acc;
}
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/* ---------- 1. 源码：增强浮层的三项（data-k + 文案） ---------- */
const reg = read(SOURCE);
const flyStart = reg.indexOf('data-k="enhance-flyout"');
const flyEnd = flyStart >= 0 ? reg.indexOf('</div> : null}', flyStart) : -1;
const flyBlock = flyStart >= 0 && flyEnd > flyStart ? reg.slice(flyStart, flyEnd) : '';
check('源码里有「增强」二级浮层（data-k="enhance-flyout"）', flyStart >= 0);
check('浮层外壳复用 .rotate-flyout（className 与 data-k 在同一个 div 上）',
    reg.indexOf('className="rotate-flyout" data-k="enhance-flyout"') >= 0);
check('浮层里恰好 3 个按钮（不多不少）', (flyBlock.match(/<button/g) || []).length === 3, { buttons: (flyBlock.match(/<button/g) || []).length });
for (const [key, label, hint] of FLYOUT_ITEMS) {
    check('浮层里有 ' + key + '，文案「' + label + '」+「' + hint + '」',
        flyBlock.indexOf('data-k="' + key + '"') >= 0
        && flyBlock.indexOf('>' + label + '<span className="k">' + hint + '</span>') >= 0,
        { key, label, hint });
}
check('浮层三项顺序是 本地 2K → 本地 4K → AI 增强 2×',
    ['hd-2k', 'hd-4k', 'enhance-ai'].every((key, index, all) => index === 0 || flyBlock.indexOf('data-k="' + all[index - 1] + '"') < flyBlock.indexOf('data-k="' + key + '"')));
check('skipped 的提示文案被钉住：' + SKIPPED_TOAST, reg.indexOf('store.toast("' + SKIPPED_TOAST + '")') >= 0);

/* ---------- 2. 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.js');
const builtCss = read('static/novai-canvas/canvas.css');
for (const [key] of FLYOUT_ITEMS.concat([['enhance-menu'], ['enhance-flyout']])) {
    check('canvas.js 里 grep 到 data-k "' + key + '"', built.indexOf('data-k":"' + key + '"') >= 0);
}
check('canvas.js 里 grep 到 data-k "hd-download"', built.indexOf('data-k":"hd-download"') >= 0);
for (const symbol of ['upscaleLocal', 'upscaleRuntimeStatus', 'upscaleRuntimeDownload']) {
    check('canvas.js 里 grep 到 ' + symbol, built.indexOf(symbol) >= 0);
}
for (const [key, label, hint] of FLYOUT_ITEMS) {
    check('canvas.js 里三项文案在：' + label + ' / ' + hint, built.indexOf(label) >= 0 && built.indexOf(hint) >= 0, { key, label, hint });
}
check('canvas.js 里 skipped 提示文案在', built.indexOf(SKIPPED_TOAST) >= 0);
check('canvas.css 里存在 .enhance-menu', builtCss.indexOf('.enhance-menu') >= 0);
check('canvas.css 里存在 .rotate-flyout（增强复用的浮层外壳）', builtCss.indexOf('.rotate-flyout') >= 0);
const builtStat = fs.statSync(path.join(root, 'static/novai-canvas/canvas.js'));
results.builtAt = iso(builtStat.mtimeMs);
results.builtBytes = builtStat.size;

/* ---------- 3. 后端：路由是既有的 + 本轮没碰 ---------- */
const mainPy = read('main.py');
for (const route of ['@app.get("/api/image/upscale/runtime")', '@app.post("/api/image/upscale/runtime/download")', '@app.post("/api/image/upscale")']) {
    check('main.py 有既有路由 ' + route, mainPy.indexOf(route) >= 0);
}
const headMain = sh('git', ['show', 'HEAD:main.py']);
if (headMain) {
    check('HEAD 的 main.py 里已经有 /api/image/upscale 三条路由（本次改动前就在）',
        (headMain.match(/image\/upscale/g) || []).length >= 3, { headMatches: (headMain.match(/image\/upscale/g) || []).length });
} else {
    skip('HEAD 的 main.py 基线对照', '读不到 git HEAD（归档/无 .git 环境）');
}
const mainDiff = sh('git', ['diff', '--', 'main.py']);
if (!exists('.git')) skip('未提交的 main.py 改动不含 upscale', '无 .git，拿不到 diff');
else check('本轮未提交的 main.py 改动里没有一行提到 upscale', mainDiff.indexOf('upscale') < 0, { diffBytes: mainDiff.length, hits: (mainDiff.match(/upscale/g) || []).length });

/* ---------- 4. 受保护路径：无本功能标记 + （本地）改动窗口内零改动 ---------- */
for (const marker of FEATURE_MARKERS) {
    const hits = PROTECTED.map((rel) => ({ rel, files: walk(rel).filter((file) => {
        if (!/\.(js|ts|tsx|css|html|py|json)$/.test(file) || file.indexOf('package-lock.json') >= 0) return false;
        try { return fs.readFileSync(path.join(root, file), 'utf8').indexOf(marker) >= 0; } catch (error) { return false; }
    }) })).filter((row) => row.files.length);
    check('受保护路径里没有本功能标记 "' + marker + '"', hits.length === 0, hits);
}

const coreMt = CORE_SOURCES.filter(exists).map((rel) => fs.statSync(path.join(root, rel)).mtimeMs);
const spread = coreMt.length > 1 ? Math.max(...coreMt) - Math.min(...coreMt) : 0;
const freshCheckout = !STRICT && spread < MTIME_SPREAD;
if (freshCheckout) {
    skip('受保护路径在改动窗口内零改动', '源码 mtime 跨度仅 ' + Math.round(spread / 1000) + 's（git 检出时间统一，mtime 先后不可用）');
} else {
    const startMs = Date.parse(WINDOW_START.replace(' ', 'T'));
    const endMs = Date.parse(WINDOW_END.replace(' ', 'T'));
    results.windowEnforced = true;
    for (const rel of PROTECTED) {
        const files = walk(rel);
        const inWindow = files.filter((file) => {
            const mtime = fs.statSync(path.join(root, file)).mtimeMs;
            return mtime >= startMs && mtime <= endMs;
        });
        const newest = files.map((file) => ({ file, mtime: fs.statSync(path.join(root, file)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0];
        results['newest_' + rel] = newest ? { file: newest.file, at: iso(newest.mtime) } : null;
        check(rel + ' 在改动窗口（' + WINDOW_START + ' ~ ' + WINDOW_END + '）内没有文件被改', inWindow.length === 0, inWindow.slice(0, 8));
        console.log('      ' + rel + ' 最新文件：' + (newest ? iso(newest.mtime) + '  ' + newest.file : '（无）'));
    }
}

// 对照：同一套读文件/匹配方式在 BEAT 源码里必须命中，证明上面的「没有标记」不是因为扫描坏了
check('对照：同样的扫描在 BEAT 源码里能命中 hd-2k / enhance-flyout', reg.indexOf('hd-2k') >= 0 && reg.indexOf('enhance-flyout') >= 0);

fs.mkdirSync(path.join(__dirname, 'artifacts', 'upscale'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'artifacts', 'upscale', 'result-scope.json'), JSON.stringify(results, null, 2));
console.log('');
console.log('[' + (failed ? 'FAIL' : 'PASS') + '] 增强菜单静态验收：' + (failed ? failed + ' 条失败' : '全部通过') + '（跳过 ' + results.skipped.length + ' 条）');
process.exit(failed ? 1 : 0);
