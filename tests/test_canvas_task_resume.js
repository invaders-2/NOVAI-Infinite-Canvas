#!/usr/bin/env node
/*
 * 生成任务跨页面续跑：
 *   1) 用户点停止 → 取消后端任务；离开画布（store.dispose）→ 绝不取消，taskId 已经落盘；
 *   2) 回到画布 load 完成后按节点上的 taskId 接上（不新建任务、不重复写已有结果）；
 *   3) 节点上还有 running 任务时再点生成 → 不重复建任务，只提示；
 *   4) novaiBackend：轮询中止不取消、显式 cancelTask 才取消、listCanvasTasks 字段映射、resumeTask 复用结果映射。
 *
 *   node tests/test_canvas_task_resume.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = 'novai-canvas-ui/src/canvas/canvas-next/';

function loadAll() {
    const entry = path.join(os.tmpdir(), 'novai-task-resume-entry-' + process.pid + '.ts');
    const abs = (file) => JSON.stringify(path.join(ROOT, SRC + file));
    fs.writeFileSync(entry, [
        'export * as engine from ' + abs('engine.ts') + ';',
        'export * as store from ' + abs('store.ts') + ';',
        'export * as model from ' + abs('model.ts') + ';',
        'export * as types from ' + abs('backend/types.ts') + ';',
        'export * as backend from ' + JSON.stringify(path.join(ROOT, 'novai-canvas-ui/src/novaiBackend.ts')) + ';',
    ].join(String.fromCharCode(10)));
    try {
        const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
        const loaded = { exports: {} };
        new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
        return loaded.exports;
    } finally {
        fs.unlinkSync(entry);
    }
}

const { engine, store: storeMod, model, types, backend: backendMod } = loadAll();

const SPEC = model.specFor({ configId: 'comfly::test-image', label: 'test-image', vendor: 'ComFly', kind: 'image', specSource: 'spec', ui: { ratios: ['1:1'], sizes: ['1K'], batch: [1], maxRefs: 4, i2i: true } });
const VIDEO_SPEC = model.specFor({ configId: 'comfly::test-video', label: 'test-video', vendor: 'ComFly', kind: 'video', specSource: 'spec', ui: { ratios: ['16:9'], res: ['720p'], durs: [5], modes: ['文生视频'], times: [1] } });
const toasts = [];

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, ms = 2000) {
    const started = Date.now();
    while (Date.now() - started < ms) { if (check()) return; await tick(10); }
    throw new Error('等待超时：' + label);
}

function imageNode(id, extra = {}) {
    return model.withGen({ id, kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '' }, {
        title: '测试图', prompt: '画一只猫', params: { ...model.defaultParams('image', SPEC), model: SPEC.id }, hist: [], hi: 0, order: [], ...extra,
    });
}
const docWith = (...nodes) => ({ nodes, edges: [], comments: [] });

/** 假后端：只实现画布续跑用得到的那几个方法，生成由用例自己控制 */
function makeBackend(opts = {}) {
    const calls = { generate: [], cancel: [], resume: [], list: [] };
    const saved = [];
    const backend = {
        kind: 'bridge',
        available: () => true,
        listModels: async () => (opts.models || [SPEC, VIDEO_SPEC]),
        loadDoc: async () => ({ doc: opts.doc || docWith(), version: 1, source: 'bridge' }),
        saveDoc: async (canvasId, doc, version) => { saved.push({ canvasId, doc: JSON.parse(JSON.stringify(doc)), version }); return { ok: true, version: (version || 0) + 1 }; },
        generate: async (req, onEvent, signal) => {
            calls.generate.push({ req, onEvent, signal });
            if (!opts.generate) throw new Error('这个用例不该新建任务');
            return opts.generate(req, onEvent, signal);
        },
        editImage: async () => { throw new Error('不该走 editImage'); },
        importAsset: async (_canvasId, url) => url,
        importRemote: async (_canvasId, url) => url,
        resolveAsset: async (ref) => ref,
        cancelTask: async (taskId) => { calls.cancel.push(taskId); },
        listCanvasTasks: async (canvasId) => { calls.list.push(canvasId); return opts.tasks || []; },
        resumeTask: async (task, onEvent, signal) => { calls.resume.push(task); return opts.outputs || []; },
    };
    return { backend, calls, saved };
}

function makeStore(backend, canvasId) {
    const st = new storeMod.CanvasStore(backend, canvasId, '续跑测试');
    const original = st.toast.bind(st);
    st.toast = (html, ms) => { toasts.push(String(html)); original(html, ms); };
    return st;
}

(async () => {
    // ── 1. 用户点停止：真的取消后端任务，节点上的任务记录清掉 ──────────────────
    {
        let pending = null;
        const { backend, calls } = makeBackend({
            generate: (req, onEvent, signal) => new Promise((resolve, reject) => {
                onEvent({ type: 'started', runId: 'task-stop' });
                pending = { resolve, reject };
                signal.addEventListener('abort', () => reject(new types.GenError('STOPPED', '已停止')), { once: true });
            }),
        });
        const st = makeStore(backend, 'canvas-stop');
        st.set({ doc: docWith(imageNode('n-stop')), loaded: true, models: [SPEC, VIDEO_SPEC] });
        const running = engine.runNode(st, 'n-stop');
        await waitFor(() => model.genOf(st.node('n-stop')).taskId === 'task-stop', '任务 id 写进节点');
        assert.equal(st.state.runtime['n-stop'].runId, 'task-stop', '运行态要记着后端任务 id');
        engine.stopNode(st, 'n-stop');
        await running;
        assert.deepEqual(calls.cancel, ['task-stop'], '点停止要真的取消后端任务');
        assert.equal(model.genOf(st.node('n-stop')).taskId, undefined, '停止后清掉节点上的任务记录');
        assert.equal(st.state.runtime['n-stop'], undefined, '运行态收干净');
        pending.reject(new types.GenError('STOPPED', '已停止'));
        await tick();
    }

    // ── 2. 离开画布（页面卸载 / 切画布）：不取消任务，taskId 已经落盘 ───────────
    {
        let pending = null;
        const { backend, calls, saved } = makeBackend({
            generate: (req, onEvent) => new Promise((resolve, reject) => {
                onEvent({ type: 'started', runId: 'task-unmount' });
                pending = { resolve, reject };
            }),
        });
        const st = makeStore(backend, 'canvas-unmount');
        st.set({ doc: docWith(imageNode('n-unmount')), loaded: true, models: [SPEC, VIDEO_SPEC] });
        const running = engine.runNode(st, 'n-unmount');
        await waitFor(() => model.genOf(st.node('n-unmount')).taskId === 'task-unmount', '任务 id 写进节点');
        await st.dispose();                                   // 等价于离开画布：页面被卸载
        assert.deepEqual(calls.cancel, [], '离开画布绝不取消后端任务（任务要继续跑）');
        const last = saved[saved.length - 1];
        assert.ok(last, '离开前要把文档落盘');
        assert.equal(model.genOf(last.doc.nodes[0]).taskId, 'task-unmount', '任务 id 要落盘，回来才能接上');
        pending.reject(new types.GenError('STOPPED', '已停止'));
        await running;
    }

    // ── 3. 回来接上：还在跑的任务只接轮询，不新建任务；结果写回后清掉记录 ──────
    {
        const tasks = [{ taskId: 'task-resume', nodeId: 'n-resume', kind: 'image', status: 'running', model: 'test-image', result: null, createdAt: 1 }];
        const { backend, calls } = makeBackend({ doc: docWith(imageNode('n-resume', { taskId: 'task-resume' })), tasks, outputs: [{ url: '/output/resume.png', w: 1024, h: 1024, meta: { runId: 'task-resume' } }] });
        const st = makeStore(backend, 'canvas-resume');
        await st.load();
        await waitFor(() => model.genOf(st.node('n-resume')).hist.length === 1, '续跑结果写回节点');
        const gen = model.genOf(st.node('n-resume'));
        assert.equal(gen.hist[0].url, '/output/resume.png', '结果写回同一份历史');
        assert.equal(gen.taskId, undefined, '写回后清掉任务记录');
        assert.equal(calls.generate.length, 0, '回来只接任务，不新建任务（不重复扣费）');
        assert.deepEqual(calls.list, ['canvas-resume'], '按画布查任务');
        assert.equal(calls.resume.length, 1, '接上同一个任务');
        assert.equal(st.state.runtime['n-resume'], undefined, '写回后运行态收干净');
    }

    // ── 4. 任务已经写完（taskId 没清干净）：只清记录，不再写一遍结果 ─────────────
    {
        const tasks = [{ taskId: 'task-done', nodeId: 'n-done', kind: 'image', status: 'running', model: 'test-image', result: null, createdAt: 1 }];
        const node = imageNode('n-done', { taskId: 'task-done', hist: [{ url: '/output/old.png', meta: { runId: 'task-done' } }], hi: 0 });
        const { backend, calls } = makeBackend({ doc: docWith(node), tasks, outputs: [{ url: '/output/again.png' }] });
        const st = makeStore(backend, 'canvas-done');
        await st.load();
        await waitFor(() => model.genOf(st.node('n-done')).taskId === undefined, '清掉多余的任务记录');
        await tick(20);
        assert.equal(model.genOf(st.node('n-done')).hist.length, 1, '已在文档里的结果不重复写');
        assert.equal(model.genOf(st.node('n-done')).hist[0].url, '/output/old.png');
        assert.equal(calls.resume.length, 0, '不再为已写回的任务重跑写回');
    }

    // ── 5. 节点上还有 running 任务时再点生成：不重复建任务，只提示 ──────────────
    {
        const tasks = [{ taskId: 'task-pending', nodeId: 'n-pending', kind: 'image', status: 'running', model: 'test-image', result: null, createdAt: 1 }];
        const { backend, calls } = makeBackend({ doc: docWith(imageNode('n-pending', { taskId: 'task-pending' })), tasks, outputs: [{ url: '/output/pending.png', w: 512, h: 512 }] });
        const st = makeStore(backend, 'canvas-pending');
        st.set({ doc: docWith(imageNode('n-pending', { taskId: 'task-pending' })), loaded: true, models: [SPEC, VIDEO_SPEC] });
        toasts.length = 0;
        const ok = await engine.runNode(st, 'n-pending');
        assert.equal(ok, false, '还有任务在跑时不再建新任务');
        assert.equal(calls.generate.length, 0, '不能重复建任务（重复扣费）');
        assert.ok(toasts.some((text) => text.includes('还在生成')), '要提示这张还在生成');
        await waitFor(() => model.genOf(st.node('n-pending')).hist.length === 1, '顺手接上这个任务');
    }

    // ── 6. 任务已失败：清掉记录，允许立即重新生成 ────────────────────────────
    {
        const tasks = [{ taskId: 'task-failed', nodeId: 'n-failed', kind: 'image', status: 'failed', model: 'test-image', error: '上游 500', result: null, createdAt: 1 }];
        const { backend, calls } = makeBackend({
            doc: docWith(imageNode('n-failed', { taskId: 'task-failed' })), tasks,
            generate: async (req, onEvent) => { return { outputs: [{ url: '/output/retry.png', w: 512, h: 512 }] }; },
        });
        const st = makeStore(backend, 'canvas-failed');
        st.set({ doc: docWith(imageNode('n-failed', { taskId: 'task-failed' })), loaded: true, models: [SPEC, VIDEO_SPEC] });
        const ok = await engine.runNode(st, 'n-failed');
        assert.equal(ok, true, '上一个任务已失败：允许重新生成');
        assert.equal(calls.generate.length, 1, '重新生成新建了一个任务');
        assert.equal(model.genOf(st.node('n-failed')).hist[0].url, '/output/retry.png');
    }

    // ── 7. novaiBackend：轮询中止不取消、显式取消、列表字段、resumeTask 复用结果映射 ──
    {
        const originalFetch = globalThis.fetch;
        const fetchCalls = [];
        const routes = {
            'GET /api/model-caps': () => ({ items: [] }),
            'POST /api/canvas-image-tasks': () => ({ task_id: 'task-net' }),
            'GET /api/canvas-image-tasks/task-net': () => ({ status: 'running' }),
            'POST /api/tasks/task-net/cancel': () => ({ task_id: 'task-net', status: 'cancel_requested' }),
            'GET /api/canvas-tasks?canvas_id=c1': () => ({
                total: 2,
                items: [
                    { task_id: 'task-s', node_id: 'n1', kind: 'online-image', status: 'succeeded', model: 'seedream', result: { images: [{ url: '/output/s.png', width: 512, height: 512 }] }, error: '', created_at: 123 },
                    { task_id: 'task-v', node_id: 'n2', kind: 'video', status: 'running', model: 'veo', result: null, error: '', created_at: 122 },
                ],
            }),
            'GET /api/tasks/task-v': () => ({ status: 'succeeded', result: { videos: [{ url: '/output/v.mp4', duration: 8, poster: '/output/v.jpg' }] } }),
        };
        globalThis.fetch = async (url, init = {}) => {
            const key = (init.method || 'GET') + ' ' + String(url);
            fetchCalls.push({ key, body: init.body ? JSON.parse(init.body) : null });
            const handler = routes[key];
            if (!handler) throw new Error('没有 mock 这个请求：' + key);
            const body = handler();
            return { ok: true, status: 200, json: async () => body };
        };
        try {
            const be = backendMod.createNovaiBackend();
            const req = {
                canvasId: 'c1', nodeId: 'n1', kind: 'image', model: SPEC, prompt: '画只猫', resolvedPrompt: '画只猫',
                params: { ...model.defaultParams('image', SPEC), ratio: '1:1', size: '1K', count: 1 }, inputs: [],
            };
            const ac = new AbortController();
            const running = be.generate(req, () => {}, ac.signal);
            await waitFor(() => fetchCalls.some((call) => call.key === 'GET /api/canvas-image-tasks/task-net'), '开始轮询任务');
            const create = fetchCalls.find((call) => call.key === 'POST /api/canvas-image-tasks');
            assert.equal(create.body.canvas_id, 'c1', '建任务要带 canvas_id');
            assert.equal(create.body.node_id, 'n1', '建任务要带 node_id');
            ac.abort();                                        // 页面卸载 / 切画布时本端不再等
            await assert.rejects(running, (err) => err.code === 'STOPPED');
            assert.equal(fetchCalls.filter((call) => call.key.endsWith('/cancel')).length, 0, '轮询中止不等于取消后端任务');

            await be.cancelTask('task-net');
            assert.ok(fetchCalls.some((call) => call.key === 'POST /api/tasks/task-net/cancel'), '用户点停止才取消后端任务');

            const listed = await be.listCanvasTasks('c1');
            assert.equal(listed.length, 2);
            assert.equal(listed[0].taskId, 'task-s');
            assert.equal(listed[0].kind, 'image', 'online-image 归一成 image');
            assert.equal(listed[0].status, 'succeeded');
            assert.equal(listed[0].createdAt, 123);
            assert.equal(listed[1].kind, 'video');

            const doneOut = await be.resumeTask(listed[0], () => {}, new AbortController().signal);
            assert.equal(doneOut[0].url, '/output/s.png', '已跑完的任务直接从结果写回');
            assert.equal(doneOut[0].w, 512);
            assert.equal(doneOut[0].meta.runId, 'task-s', '写回的结果记着任务 id（避免重复写）');

            const videoOut = await be.resumeTask(listed[1], () => {}, new AbortController().signal);
            assert.equal(videoOut[0].url, '/output/v.mp4', '还在跑的任务接着轮询到出结果');
            assert.equal(videoOut[0].frame, '/output/v.jpg');
            assert.equal(videoOut[0].dur, 8);
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    // ── 8. 接线（静态断言）：轮询里不再自己取消，load 之后才续跑 ────────────────
    const backendSrc = fs.readFileSync(path.join(ROOT, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
    const pollBody = backendSrc.slice(backendSrc.indexOf('async function pollTask'), backendSrc.indexOf('async function createImageTask'));
    assert.ok(pollBody.length > 0, '找得到 pollTask');
    assert.ok(!/\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/cancel/.test(pollBody), 'pollTask 中止时不能自己取消后端任务');
    const storeSrc = fs.readFileSync(path.join(ROOT, SRC + 'store.ts'), 'utf8');
    assert.ok(/void resumeCanvasTasks\(this\)/.test(storeSrc), 'load 完成后要接上没写完的任务');
    assert.ok(/stopRun\(id: string\)/.test(storeSrc), '停止 / 删节点统一走 stopRun（后端任务一起取消）');
    const engineSrc = fs.readFileSync(path.join(ROOT, SRC + 'engine.ts'), 'utf8');
    assert.ok(/adoptPendingTask\(store, node\)/.test(engineSrc), '再点生成前先接上没写完的任务');

    console.log('[task-resume] 全部通过');
})();
