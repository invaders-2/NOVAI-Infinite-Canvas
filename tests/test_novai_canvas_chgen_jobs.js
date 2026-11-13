#!/usr/bin/env node
'use strict';
/*
 * 「AI 生成角色」多任务：迁移/恢复的纯函数、按 id 并行的任务集合、以及组件里的静态接线。
 * 不跑真实 UI：CharacterGenerate 在 node 里只加载模块（restoreJobs 读 stub 存储），
 * 任务用 never-resolve 的假后端启动，验证两个任务同时在册、取消只影响自己。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const GEN = 'novai-canvas-ui/src/canvas/canvas-next/ui/CharacterGenerate.tsx';
const LIB = 'novai-canvas-ui/src/canvas/canvas-next/ui/CharacterLibrary.tsx';
const CSS = 'novai-canvas-ui/src/canvas/canvas-next/ui/character.css';
const JOBS_KEY = 'canvas-next:chgen:jobs';
const LEGACY_KEY = 'canvas-next:chgen:job';

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
    clear: () => storage.clear(),
};
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
globalThis.window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    documentElement: { style: { setProperty() {} } }, body: { appendChild() {} },
};

const model = { id: 'm1', name: 'M1', vendor: '测试供应商', tags: [], kind: 'image', secs: 1, ratios: ['3:4'], sizes: ['1K'], i2i: false, maxRefs: 0 };
const formOf = (name, extra) => ({ name, attrs: { era: '当代现实', gender: '男' }, extra: extra || '' });
const stepOk = (url) => ({ state: 'done', progress: 1, url });
const stepIdle = () => ({ state: 'idle', progress: 0 });
const jobOf = (name, id, startedAt, overrides) => ({
    id,
    spec: { name, model, form: formOf(name), refs: [], whiten: true },
    steps: [stepOk('u0'), stepIdle(), stepIdle(), stepIdle()],
    urls: ['u0', '', '', ''],
    startedAt,
    ...overrides,
});
const readJobs = () => { const raw = localStorage.getItem(JOBS_KEY); return raw ? JSON.parse(raw) : null; };
const never = () => new Promise(() => {});
const makeCtl = () => ({
    store: {
        state: { canvasId: 'cv1' },
        backend: { available: () => true, generate: never },
        toast() {},
    },
});
const cleanup = () => {
    storage.clear();
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.CustomEvent;
};

(async () => {
    /* ---------- 静态接线 ---------- */
    const genSrc = fs.readFileSync(path.join(root, GEN), 'utf8');
    const libSrc = fs.readFileSync(path.join(root, LIB), 'utf8');
    const css = fs.readFileSync(path.join(root, CSS), 'utf8');

    assert(genSrc.includes('useCharacterJobs'), 'CharacterGenerate 应导出 useCharacterJobs');
    assert(/export function startCharacterJob\([^)]*\): string \{/.test(genSrc), 'startCharacterJob 应返回任务 id');
    assert(genSrc.includes('return id;'), 'startCharacterJob 应把新 id 返回给表单');
    assert(/export function cancelCharacterJob\(jobId: string\)/.test(genSrc), 'cancelCharacterJob 应按 id 取消');
    assert(/export function resumeCharacterJob\(ctl: Ctl, jobId: string\)/.test(genSrc), 'resumeCharacterJob 应按 id 继续');
    assert(genSrc.includes('canvas-next:chgen:jobs'), '任务数组应存到 canvas-next:chgen:jobs');
    // 旧单对象键只允许出现在迁移常量里（chgen:jobs 不算，用负向前瞻排除）
    const legacyHits = genSrc.match(/canvas-next:chgen:job(?!s)/g) || [];
    assert.strictEqual(legacyHits.length, 1, '旧单任务键只应出现在迁移处，实际 ' + legacyHits.length + ' 次');
    assert(genSrc.includes('const LEGACY_JOB_KEY = "canvas-next:chgen:job"'), '旧键应命名为 LEGACY_JOB_KEY');
    assert(genSrc.includes('decodeJobs(rawNew, rawOld)'), 'restoreJobs 应走 decodeJobs 迁移');
    assert(genSrc.includes('setCharacterJobHandler(jobId: string'), 'handler 应按任务登记');

    assert(libSrc.includes('useCharacterJobs()'), '角色库头部应订阅任务集合');
    assert(libSrc.includes('chlib-jobs'), '角色库头部应有 .chlib-jobs 容器');
    assert(libSrc.includes('data-ch-job={j.name}'), '每颗任务 chip 应带 data-ch-job=名字');
    assert(!libSrc.includes('data-ch-job-resume'), '旧的单个「继续上次生成」按钮应删掉');
    assert(libSrc.includes('useState<null | { jobId?: string }>'), 'genOpen 应是 null | { jobId? }');
    assert(!/import \{[^}]*resumeCharacterJob[^}]*\} from "\.\/CharacterGenerate"/.test(libSrc), '角色库不再直接调 resumeCharacterJob');

    assert(css.includes('.chlib-jobs'), 'CSS 应有 .chlib-jobs');
    assert(/\.chlib-jobs\{[^}]*display:flex/.test(css), '.chlib-jobs 应横向排列');
    assert(/\.chlib-jobs\{[^}]*overflow-x:auto/.test(css), '.chlib-jobs 应横向滚动');
    assert(/\.chlib-jobs\{[^}]*max-width:46%/.test(css), '.chlib-jobs 应限宽 46%');
    assert(/\.chlib-jobs\{[^}]*scrollbar-width:none/.test(css), '.chlib-jobs 应隐藏滚动条');
    assert(!/\.chlib-jobs\{[^}]*border/.test(css), '.chlib-jobs 不应加描边');
    assert(/\.chlib-jobs \.chlib-job \.nm\{[^}]*max-width:96px/.test(css), 'chip 名字应限宽 96px');
    assert(/\.chlib-jobs \.chlib-job \.nm\{[^}]*text-overflow:ellipsis/.test(css), 'chip 名字应省略号截断');
    assert(/\.chlib-jobs \.chlib-job \.nm\{[^}]*white-space:nowrap/.test(css), 'chip 名字不应换行');
    assert(libSrc.includes('保存中') && libSrc.includes('· 可继续'), 'chip 文案应含保存中 / 可继续');

    /* ---------- 纯函数：旧单对象迁移 + 新数组解析 ---------- */
    localStorage.clear();
    const cg = load(GEN);

    const oldJob = jobOf('墨青', 'legacy_1', 1000, {
        steps: [stepOk('old0'), { state: 'running', progress: 0.4 }, { state: 'error', progress: 0, error: '超时' }, stepIdle()],
        urls: ['old0', '', '', ''],
    });
    const migrated = cg.decodeJobs(null, JSON.stringify(oldJob));
    assert.strictEqual(migrated.length, 1, '旧单对象应迁移成 1 条任务');
    assert.strictEqual(migrated[0].spec.name, '墨青');
    assert.strictEqual(migrated[0].id, 'legacy_1');
    assert.strictEqual(migrated[0].startedAt, 1000);
    assert.deepStrictEqual(migrated[0].urls, ['old0', '', '', ''], '迁移应保留 urls');
    assert.strictEqual(migrated[0].steps[1].state, 'idle', 'running 步骤重载后应回落 idle');
    assert.strictEqual(migrated[0].steps[1].progress, 0);
    assert.strictEqual(migrated[0].steps[2].state, 'error', '失败步骤应保留，方便重试');

    const arr = [
        jobOf('A', 'ch_a', 1000),
        jobOf('B', 'ch_b', 2000, { steps: [stepOk('b0'), { state: 'running', progress: 0.5 }, stepIdle(), stepIdle()], urls: ['b0', '', '', ''] }),
    ];
    const parsed = cg.decodeJobs(JSON.stringify(arr), null);
    assert.strictEqual(parsed.length, 2, '新数组应原样解析成 2 条任务');
    assert.deepStrictEqual(parsed.map((j) => j.id), ['ch_a', 'ch_b']);
    assert.deepStrictEqual(parsed.map((j) => j.startedAt), [1000, 2000]);
    assert.deepStrictEqual(parsed[0].urls, ['u0', '', '', '']);
    assert.strictEqual(parsed[1].steps[1].state, 'idle');

    assert.strictEqual(cg.decodeJobs(JSON.stringify(arr), JSON.stringify(oldJob)).length, 2, '有新数组时不再迁移旧键');
    assert.deepStrictEqual(cg.decodeJobs('not-json', null), [], '坏 JSON 应丢弃');
    assert.deepStrictEqual(cg.decodeJobs(null, '{bad'), [], '坏旧数据应丢弃');
    const mixed = cg.decodeJobs(JSON.stringify([
        null, 42, {}, { spec: { name: '   ', steps: [], urls: [] }, steps: [], urls: [] },
        { id: 'no_name', spec: { name: '', model, form: formOf(''), refs: [] }, steps: [], urls: [] },
        { id: 'no_steps', spec: { name: '缺步骤', model, form: formOf('缺步骤'), refs: [] } },
        { id: 'no_form', spec: { name: '缺表单', model, refs: [] }, steps: [], urls: [] },
        { id: 'no_model', spec: { name: '缺模型', form: formOf('缺模型'), refs: [] }, steps: [], urls: [] },
        jobOf('好的', 'ch_ok', 3000),
    ]), null);
    assert.strictEqual(mixed.length, 1, '坏数据整条丢弃，只留合法任务');
    assert.strictEqual(mixed[0].id, 'ch_ok');

    /* ---------- 运行时：两个任务同时在册，取消只影响自己 ---------- */
    localStorage.clear();
    const ctl = makeCtl();
    const specA = { name: 'A', model, form: formOf('A'), refs: [], whiten: false };
    const specB = { name: 'B', model, form: formOf('B'), refs: [], whiten: false };
    const idA = cg.startCharacterJob(ctl, specA, [0, 1, 2, 3]);
    const idB = cg.startCharacterJob(ctl, specB, [0, 1, 2, 3]);
    assert.strictEqual(typeof idA, 'string');
    assert(idA.startsWith('ch_'), '新任务 id 应以 ch_ 开头');
    assert.notStrictEqual(idA, idB, '两个任务应有各自的 id');
    assert.strictEqual(readJobs().length, 2, '两个任务应同时持久化');
    assert.deepStrictEqual(readJobs().map((j) => j.spec.name).sort(), ['A', 'B']);

    cg.cancelCharacterJob(idA);
    assert.strictEqual(readJobs().length, 1, '取消 A 不应影响 B');
    assert.strictEqual(readJobs()[0].spec.name, 'B');
    cg.cancelCharacterJob(idB);
    assert.strictEqual(localStorage.getItem(JOBS_KEY), null, '没有任务时清掉存储键');

    /* ---------- 恢复：旧键迁移成数组并删除旧键 ---------- */
    localStorage.clear();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(oldJob));
    load(GEN);
    assert.strictEqual(localStorage.getItem(LEGACY_KEY), null, '迁移后应删除旧单任务键');
    const bootstrapped = readJobs();
    assert(bootstrapped && bootstrapped.length === 1, '迁移后应写入任务数组');
    assert.strictEqual(bootstrapped[0].spec.name, '墨青');
    assert.strictEqual(bootstrapped[0].steps[1].state, 'idle', '迁移落盘时 running 也回落 idle');

    cleanup();
    console.log('[PASS] AI 生成角色多任务：旧键迁移、数组恢复、按 id 并行启动与取消、头部 chips 静态接线');
})().catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
});
