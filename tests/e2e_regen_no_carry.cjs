#!/usr/bin/env node
'use strict';
/*
 * 「再来一张 / 助手检测有问题后重新生成」端到端验收（真实前端 + 真实后端 + mock 生图接口）
 *
 * 验四件事（每条都要有真实请求体）：
 *   A. 工具条「再来一张」（点结果节点 R）：reference_images 只能是原始上传素材 / 普通上游参考图，
 *      不能出现上一版结果（R 的 hist）也不能出现来源节点那一版（S 的 hist）；新节点不再和结果节点连箭头。
 *   B. 助手审查不合格 → POST /api/agent/regenerate（items 指向结果节点）：画布真正发出的那次请求不带问题图，
 *      提示词按传入的新提示词生效；同一请求连续两次 → 第二次 status="unchanged"。
 *   C. 助手「在这张基础上改」：data.agentRun.referenceImages 里指定的图必须进这次请求的 reference_images。
 *   D. 上传素材节点连点两次生成：第二次仍然带最初上传那张。
 *   另：用户侧重抽（run_generation 只带 exclude_self_refs、不带 review_rerun）连续两次都要真跑。
 *
 * 隔离：独立后端 NOVAI_PORT=3921 + NOVAI_DATA_DIR=/tmp/novai-e2e-regen（绝不碰 3000），
 *       脚本自己起、自己 kill；全部 mock 都在 page.route 里（/api/config、/api/model-caps、生图任务）。
 * 证据：_verification-regen-no-carry/{REPORT.md,evidence.json,*.png}
 */
process.env.NOVAI_PORT = '3921';
process.env.NOVAI_DATA_DIR = '/tmp/novai-e2e-regen';
process.env.NOVAI_BASE = 'http://127.0.0.1:3921';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_verification-regen-no-carry');
const LOG_FILE = '/tmp/novai-e2e-regen-backend.log';
const BASE = H.BASE;
const DATA_DIR = H.DATA_DIR;
const PYTHON = process.env.PYTHON || 'python3';

const UPLOAD = '/assets/output/mock_upload.png';
const S_GEN = '/assets/output/s_gen1.png';
const R_GEN = '/assets/output/r_gen1.png';
const AGENT_REF = '/assets/output/agent_ref.png';
const MOCK_OUT = '/assets/output/mock_result.png';
const NEW_PROMPT = '做成海报，杯身笔直，光线更柔和';

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const q = (s) => TICK + s + TICK;

const results = [];
const notes = [];
const shots = {};
const pageErrors = [];
const createdCanvases = [];
const ev = { scenarios: {}, startedAt: new Date().toISOString() };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (ok) console.log('PASS  ' + name);
  else console.log('FAIL  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  return !!ok;
}
function note(text, data) {
  notes.push({ text, data: data === undefined ? null : data });
  console.log('NOTE  ' + text + (data === undefined ? '' : '  ' + JSON.stringify(data)));
}
function refsOf(body) { return ((body && body.reference_images) || []).map((r) => String((r && r.url) || r)); }
function slimBody(body) {
  if (!body) return null;
  return {
    prompt: body.prompt, provider_id: body.provider_id, model: body.model, size: body.size, n: body.n,
    node_id: body.node_id, canvas_id: body.canvas_id, reference_images: body.reference_images,
  };
}

/* ---------------- 后端进程 ---------------- */
function prepareAssets() {
  const target = path.resolve(DATA_DIR);
  if (target !== path.resolve('/tmp/novai-e2e-regen')) throw new Error('拒绝清理非约定数据目录：' + target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'assets', 'output'), { recursive: true });
  const colors = {
    'mock_upload.png': [235, 120, 60, 255],
    's_gen1.png': [30, 120, 235, 255],
    'r_gen1.png': [40, 200, 120, 255],
    'agent_ref.png': [200, 40, 200, 255],
    'mock_result.png': [180, 180, 40, 255],
  };
  for (const [name, color] of Object.entries(colors)) {
    H.writePng(path.join(target, 'assets', 'output', name), 4, 4, 6, (x, y) => [color[0] + x * 2, color[1] + y * 2, color[2], 255]);
  }
}
async function portBusy() {
  try { const res = await fetch(BASE + '/api/config', { signal: AbortSignal.timeout(1500) }); return res.status === 200; } catch { return false; }
}
function startBackend() {
  const fd = fs.openSync(LOG_FILE, 'w');
  const proc = spawn(PYTHON, ['main.py'], {
    cwd: ROOT,
    env: { ...process.env, NOVAI_PORT: '3921', NOVAI_DATA_DIR: DATA_DIR, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', fd, fd],
  });
  return { proc };
}
function tailLog() {
  try { return fs.readFileSync(LOG_FILE, 'utf8').slice(-2500); } catch { return '(读不到日志)'; }
}
async function waitBackend(api, proc) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (proc.exitCode !== null) throw new Error('后端进程提前退出（code=' + proc.exitCode + '），日志：' + tailLog());
    try { const r = await api.get('/api/config'); if (r.status() === 200) return; } catch { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error('后端 90s 内没起来，日志：' + tailLog());
}
async function stopBackend(proc) {
  if (!proc) return;
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => proc.once('exit', () => r(true))),
    sleep(8000).then(() => false),
  ]);
  if (!exited) { proc.kill('SIGKILL'); await sleep(500); }
}

/* ---------------- 页面 / mock ---------------- */
async function installRoutes(page, calls) {
  await page.route(/\/api\/config$/, async (route) => {
    const res = await route.fetch();
    const data = await res.json().catch(() => ({}));
    data.api_providers = [{ id: 'mock', name: 'Mock 平台', protocol: 'openai', enabled: true, has_key: true,
      chat_models: ['mock-text'], image_models: ['mock-image'], video_models: [], audio_models: [], model_caps: {} }];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route(/\/api\/model-caps$/, async (route) => {
    const items = [{ provider: 'mock', model: 'mock-image', kind: 'image', ref_max: 14, n_max: 1, i2i: true,
      ratios: ['1:1'], resolutions: ['1K'], qualities: [] }];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
  });
  await page.route(/\/api\/canvas-image-tasks(?:\/[^/]+)?$/, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      calls.image.push(req.postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'mock_task_' + calls.image.length }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'succeeded', result: { images: [{ url: MOCK_OUT, width: 200, height: 200 }] } }) });
    }
  });
}
async function openPage(browser, canvasId, calls) {
  const opened = await H.openCanvasPage(browser, canvasId, { beforeGoto: (p) => installRoutes(p, calls) });
  await opened.page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.loaded === true, null, { timeout: 30000 });
  pageErrors.push(...opened.pageErrors.map((e) => ({ canvasId, error: String(e) })));
  return opened;
}
async function waitFor(fn, timeout = 20000, label = '') {
  const t0 = Date.now();
  let lastError = null;
  while (Date.now() - t0 < timeout) {
    try { const hit = await fn(); if (hit) return hit; } catch (e) { lastError = e; }
    await sleep(100);
  }
  throw new Error('等待超时' + (label ? '：' + label : '') + (lastError ? '（' + lastError.message + '）' : ''));
}
async function waitCalls(calls, count, timeout = 25000) {
  return waitFor(() => calls.image.length >= count, timeout, 'mock 生图请求 >= ' + count + ' 次（实际 ' + calls.image.length + ' 次）');
}
async function waitRuntimeIdle(page, timeout = 25000) {
  await page.waitForFunction(() => Object.keys(window.__cn.state.runtime).length === 0, null, { timeout });
}
async function fitAll(page, ids) {
  await page.evaluate((ids) => {
    const s = window.__cn;
    const ns = ids.map((id) => s.node(id)).filter(Boolean);
    if (!ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h));
    const w = Math.max(900, window.innerWidth), h = Math.max(600, window.innerHeight);
    const k = Math.min(0.85, (w * 0.9) / Math.max(1, x1 - x0), (h * 0.85) / Math.max(1, y1 - y0));
    s.setView({ x: Math.round(w / 2 - (x0 + (x1 - x0) / 2) * k), y: Math.round(h / 2 - (y0 + (y1 - y0) / 2) * k), k: Math.max(0.2, Math.round(k * 100) / 100) });
  }, ids);
  await page.waitForTimeout(700);
}
async function shot(page, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name + '.png');
  await page.screenshot({ path: file });
  shots[name] = file;
  console.log('SHOT  ' + file);
  return file;
}
async function pageDoc(page) {
  return page.evaluate(() => {
    const s = window.__cn;
    return {
      nodes: s.state.doc.nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.data && n.data.gen && n.data.gen.title,
        sourceNodeId: n.data && n.data.sourceNodeId, hist: (n.data && n.data.gen && n.data.gen.hist || []).map((h) => h.url || h.text) })),
      edges: s.state.doc.edges.map((e) => e.from + '>' + e.to),
      selected: [...s.state.ui.sel],
    };
  });
}
async function waitHist(page, id, len, timeout = 25000) {
  await page.waitForFunction(({ id, len }) => {
    const s = window.__cn; const n = s.node(id); const g = n && n.data && n.data.gen;
    return !!g && g.hist.length >= len && !g.taskId && !s.state.runtime[id] && !g.err;
  }, { id, len }, { timeout });
}
async function setViewOn(page, id, k = 0.9) {
  await page.evaluate(({ id, k }) => {
    const s = window.__cn; const n = s.node(id); if (!n) return;
    const w = window.innerWidth, h = window.innerHeight;
    s.setView({ x: Math.round(w / 2 - (n.x + n.w / 2) * k), y: Math.round(h / 2 - (n.y + n.h / 2) * k), k });
  }, { id, k });
  await page.waitForTimeout(350);
}

/* ---------------- 造场景 ---------------- */
async function seedScene(page) {
  return page.evaluate(async () => {
    const store = window.__cn;
    const G = (url, runId) => ({ url, w: 512, h: 512, meta: { model: 'mock-image', at: Date.now(), ...(runId ? { runId, prompt: '做成海报' } : {}) } });
    const params = { model: 'mock::mock-image', ratio: '1:1', size: '1K', count: 1 };
    const U = store.newNode('image', 80, 80, { id: 'U', title: '上传素材', prompt: '做成海报', uploaded: true, hist: [G('/assets/output/mock_upload.png')], hi: 0, params });
    const T = store.newNode('text', 80, 460, { id: 'T', title: '提示词', prompt: '做成海报', hist: [{ text: '做成海报' }], hi: 0, params: { model: 'mock::mock-text' } });
    const S0 = store.newNode('image', 460, 80, { id: 'S', title: '海报方案', prompt: '做成海报', hist: [G('/assets/output/s_gen1.png', 'run_s1')], hi: 0, params });
    const R0 = store.newNode('image', 840, 80, { id: 'R', title: '海报方案 · 2', prompt: '做成海报', hist: [G('/assets/output/r_gen1.png', 'run_r1')], hi: 0, params });
    const withSrc = (n, src) => ({ ...n, data: { ...(n.data || {}), sourceNodeId: src } });
    store.addNodes([U, T, withSrc(S0, 'U'), withSrc(R0, 'S')], [
      { id: 'e_us', from: 'U', to: 'S' },
      { id: 'e_ts', from: 'T', to: 'S' },
      { id: 'e_sr', from: 'S', to: 'R' },
    ], { history: false });
    await store.saveNow();
    return { saving: store.state.saving, nodes: store.state.doc.nodes.length, edges: store.state.doc.edges.length };
  });
}
async function seedUploadOnly(page) {
  return page.evaluate(async () => {
    const store = window.__cn;
    const U = store.newNode('image', 260, 180, { id: 'U', title: '上传素材', prompt: '做成海报', uploaded: true,
      hist: [{ url: '/assets/output/mock_upload.png', w: 512, h: 512, meta: { model: '', at: Date.now() } }], hi: 0,
      params: { model: 'mock::mock-image', ratio: '1:1', size: '1K', count: 1 } });
    store.addNodes([U], [], { history: false });
    await store.saveNow();
    return { saving: store.state.saving, nodes: store.state.doc.nodes.length };
  });
}

/* ---------------- 后端画布读取 ---------------- */
async function getCanvas(api, id) {
  const res = await api.get('/api/canvases/' + encodeURIComponent(id));
  if (res.status() !== 200) throw new Error('GET /api/canvases 返回 ' + res.status());
  return (await res.json()).canvas;
}
async function getNode(api, canvasId, nodeId) {
  const canvas = await getCanvas(api, canvasId);
  return (canvas.nodes || []).find((n) => n.id === nodeId) || null;
}
async function pollNode(api, canvasId, nodeId, pred, timeout = 30000, label = '') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    const canvas = await getCanvas(api, canvasId);
    last = (canvas.nodes || []).find((n) => n.id === nodeId) || null;
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error('等后端节点状态超时' + (label ? '：' + label : '') + '，最后一次：' + JSON.stringify(last && { data: last.data, keys: Object.keys(last) }).slice(0, 2000));
}
function markerOf(node) {
  const data = (node && node.data) || {};
  return { agentRun: data.agentRun || null, agentPending: data.agentPending || null, agentPendingExcludeSelfRefs: data.agentPendingExcludeSelfRefs || null,
    agentPendingReferenceImages: data.agentPendingReferenceImages || null, prompt: (data.gen && data.gen.prompt) || null,
    hist: ((data.gen && data.gen.hist) || []).map((h) => h.url || h.text) };
}
/** 护栏状态：以 data.agentRegen 为准（前端只持久化固定字段 + data）；顶层旧键保留作向后兼容读取 */
function regenStateOf(node) {
  const dataRegen = node && node.data && typeof node.data === 'object' ? node.data.agentRegen : undefined;
  const topRegen = node && typeof node === 'object' ? node.agentRegen : undefined;
  const state = dataRegen && typeof dataRegen === 'object' ? dataRegen : (topRegen && typeof topRegen === 'object' ? topRegen : null);
  return { state, where: dataRegen && typeof dataRegen === 'object' ? 'data.agentRegen' : topRegen && typeof topRegen === 'object' ? 'agentRegen(top-level, legacy)' : null };
}
/** 用真实保存接口把 data.agentRegen 删掉（模拟护栏状态被彻底清掉），返回保存结果与保存后的节点 */
async function clearAgentRegen(api, canvasId, nodeId) {
  const canvas = await getCanvas(api, canvasId);
  const target = (canvas.nodes || []).find((n) => n.id === nodeId);
  if (!target) throw new Error('clearAgentRegen: 节点不存在 ' + nodeId);
  const nodes = (canvas.nodes || []).map((n) => {
    if (n.id !== nodeId) return n;
    const data = { ...((n.data && typeof n.data === 'object') ? n.data : {}) };
    delete data.agentRegen;
    return { ...n, data };
  });
  const payload = {
    title: canvas.title || '未命名画布', icon: canvas.icon || '🧩',
    nodes, connections: canvas.connections || [], viewport: canvas.viewport || {},
    logs: canvas.logs || [], settings: canvas.settings || {},
    client_id: 'novai-e2e-clear-' + Date.now(), base_updated_at: Number(canvas.updated_at) || 0,
  };
  const res = await api.put('/api/canvases/' + encodeURIComponent(canvasId), { data: payload });
  const body = await res.json().catch(() => ({}));
  const after = await getNode(api, canvasId, nodeId);
  return {
    httpStatus: res.status(),
    removed: !!(after && !(after.data && after.data.agentRegen) && !after.agentRegen),
    error: body && body.detail ? body.detail : null,
    node: after,
  };
}

/* ---------------- 场景 A：工具条「再来一张」 ---------------- */
async function scenarioA(browser, api, calls) {
  const canvasId = await H.createCanvas(api, 'E2E-REGEN-A-' + Date.now());
  createdCanvases.push(canvasId);
  const { context, page } = await openPage(browser, canvasId, calls);
  try {
    const seeded = await seedScene(page);
    check('A 现场就绪：U 上传 / T 文本 / S 生成图 / R 结果（S→R 只表示来源），文档已保存',
      seeded.saving === 'saved' && seeded.nodes === 4 && seeded.edges === 3, seeded);
    const serverDoc = await getCanvas(api, canvasId);
    check('A 现场已落到真实后端（4 节点 / 3 连线 / data.gen 完整）',
      (serverDoc.nodes || []).length === 4 && (serverDoc.connections || []).length === 3
        && (serverDoc.nodes || []).every((n) => n.data && n.data.gen && Array.isArray(n.data.gen.hist)), { nodes: (serverDoc.nodes || []).length, connections: (serverDoc.connections || []).length });

    const before = await pageDoc(page);
    await setViewOn(page, 'R', 0.9);
    await page.evaluate(() => window.__cn.setUI({ sel: new Set(['R']) }));
    await page.waitForTimeout(400);
    const btn = page.locator('#ntb [data-tb="rerun"]');
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    check('A 工具条「再来一张」按钮可见（点的是结果节点 R）', await btn.isVisible(), { count: await btn.count() });
    await btn.click();
    await waitCalls(calls, 1, 30000);
    const request = calls.image[0];
    const newId = await waitFor(async () => {
      const now = await pageDoc(page);
      return now.nodes.map((n) => n.id).find((id) => !before.nodes.some((b) => b.id === id)) || false;
    }, 15000, '新节点出现');
    await waitHist(page, newId, 1, 30000);
    await waitRuntimeIdle(page);
    const after = await pageDoc(page);

    const refs = refsOf(request);
    ev.scenarios.A = { canvasId, request: slimBody(request), newId, before, after, seeded };

    check('A reference_images 只有最初上传素材（没有上一版 R 的结果，也没有来源节点 S 那一版）',
      refs.length === 1 && refs[0] === UPLOAD && !refs.includes(R_GEN) && !refs.includes(S_GEN), { reference_images: request.reference_images });
    const edgesToNew = after.edges.filter((e) => e.split('>')[1] === newId);
    check('A 新节点不再和结果节点连箭头（无 R→新节点、无 S→新节点）',
      !edgesToNew.includes('R>' + newId) && !edgesToNew.includes('S>' + newId) && !after.edges.includes('R>' + newId),
      { edges: after.edges, newId });
    const newNode = after.nodes.find((n) => n.id === newId);
    check('A 新节点 data.sourceNodeId=R，连线只来自来源节点自己的输入（T）',
      !!newNode && newNode.sourceNodeId === 'R' && JSON.stringify(edgesToNew) === JSON.stringify(['T>' + newId]),
      { sourceNodeId: newNode && newNode.sourceNodeId, edgesToNew });
    check('A 这次生成真的跑完（mock 结果写回新节点 hist）',
      !!newNode && newNode.hist.length === 1 && newNode.hist[0] === MOCK_OUT, { hist: newNode && newNode.hist, runtime: after });

    await fitAll(page, ['U', 'T', 'S', 'R', newId]);
    await shot(page, 'A-rerun-new-node');
  } finally { await context.close().catch(() => null); }
}

/* ---------------- 场景 D：上传素材迭代 ---------------- */
async function scenarioD(browser, api, calls) {
  const canvasId = await H.createCanvas(api, 'E2E-REGEN-D-' + Date.now());
  createdCanvases.push(canvasId);
  const { context, page } = await openPage(browser, canvasId, calls);
  try {
    const seeded = await seedUploadOnly(page);
    check('D 现场就绪：只有上传素材节点 U（uploaded=true，hist[0]=最初上传）', seeded.saving === 'saved' && seeded.nodes === 1, seeded);
    await setViewOn(page, 'U', 0.9);
    await page.evaluate(() => window.__cn.setUI({ sel: new Set(['U']) }));
    await page.waitForTimeout(400);
    await page.locator('#gp [data-p="send"]').first().click();
    await waitCalls(calls, 1, 30000);
    const firstBody = calls.image[0];
    const resultNode = await waitFor(async () => (await pageDoc(page)).nodes.find((n) => n.sourceNodeId === 'U') || false, 15000, '结果节点出现');
    await waitHist(page, resultNode.id, 1, 30000);
    await waitRuntimeIdle(page);

    await page.evaluate(() => window.__cn.setUI({ sel: new Set(['U']) }));
    await page.waitForTimeout(400);
    await page.locator('#gp [data-p="send"]').first().click();
    await waitCalls(calls, 2, 30000);
    const secondBody = calls.image[1];
    await waitHist(page, resultNode.id, 2, 30000);
    await waitRuntimeIdle(page);
    const after = await pageDoc(page);

    const refs1 = refsOf(firstBody), refs2 = refsOf(secondBody);
    ev.scenarios.D = { canvasId, request1: slimBody(firstBody), request2: slimBody(secondBody), resultId: resultNode.id, after, seeded };
    check('D 第 1 次生成：reference_images = 最初上传素材', refs1.length === 1 && refs1[0] === UPLOAD, { reference_images: firstBody.reference_images });
    check('D 第 2 次生成：仍然带最初上传那张（没有拿上一版 mock 结果当参考）',
      refs2.length === 1 && refs2[0] === UPLOAD && !refs2.includes(MOCK_OUT), { reference_images: secondBody.reference_images });
    const resultAfter = after.nodes.find((n) => n.id === resultNode.id);
    check('D 第 2 次生成确实发生（同一结果节点原地追加第 2 版）',
      !!resultAfter && resultAfter.hist.length === 2 && secondBody.node_id === resultNode.id,
      { hist: resultAfter && resultAfter.hist, node_id: secondBody.node_id, resultId: resultNode.id });

    await fitAll(page, ['U', resultNode.id]);
    await shot(page, 'D-upload-iteration');
  } finally { await context.close().catch(() => null); }
}

/* ---------------- 场景 B：POST /api/agent/regenerate ---------------- */
async function scenarioB(browser, api, calls) {
  const canvasId = await H.createCanvas(api, 'E2E-REGEN-B-' + Date.now());
  createdCanvases.push(canvasId);
  const seedPage = await openPage(browser, canvasId, { image: [] });
  try {
    const seeded = await seedScene(seedPage.page);
    check('B 现场就绪并已保存', seeded.saving === 'saved' && seeded.nodes === 4, seeded);
  } finally { await seedPage.context.close().catch(() => null); }
  await waitFor(async () => (await getCanvas(api, canvasId)).nodes.length === 4, 10000, '后端画布 4 节点');

  const payload = { canvas_id: canvasId, items: [{ node_id: 'R', label: '海报方案 · 2', kind: 'image', prompt: NEW_PROMPT, issues: ['杯身歪了', '光线太硬'] }] };
  const postRegen = async () => {
    const res = await api.post('/api/agent/regenerate', { data: payload });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  };
  const first = await postRegen();
  ev.scenarios.B = { canvasId, regenerate: { first } };
  check('B /api/agent/regenerate #1：真实入队（allowed 包含 R，steps>=1）',
    first.status === 200 && first.body.ok === true && (first.body.regen && (first.body.regen.allowed || []).includes('R')) && Number(first.body.steps) >= 1,
    { httpStatus: first.status, response: first.body });

  const markerNode = await pollNode(api, canvasId, 'R',
    (n) => n.data && n.data.agentRun && n.data.agentRun.excludeSelfRefs === true && n.data.gen && n.data.gen.prompt === NEW_PROMPT,
    30000, 'agentRun.excludeSelfRefs=true + 新提示词');
  const markerState = regenStateOf(markerNode);
  const fingerprintRefs = markerState.state && markerState.state.last && Array.isArray(markerState.state.last.refs) ? markerState.state.last.refs : null;
  ev.scenarios.B.marker = { ...markerOf(markerNode), regenState: markerState, topLevelKeys: Object.keys(markerNode),
    fingerprint: { where: markerState.where, refs: fingerprintRefs, upstreamSOutput: S_GEN } };
  check('B 后端标记正确：agentRun.excludeSelfRefs=true，节点提示词已被改成传入的新提示词',
    markerNode.data.agentRun.excludeSelfRefs === true && markerNode.data.gen.prompt === NEW_PROMPT,
    { agentRun: markerNode.data.agentRun, prompt: markerNode.data.gen.prompt });

  if (fingerprintRefs && fingerprintRefs.length === 0) {
    note('护栏请求指纹的 refs 仍为空（预期 BEAT 应含上游参考图 / 显式参考图），记为回归信号', { fingerprintRefs });
  }

  const second = await postRegen();
  ev.scenarios.B.regenerate.second = second;
  check('B 审查重跑护栏：同一节点、同样请求第 2 次 /api/agent/regenerate → status="unchanged"（不重新生成）',
    second.status === 200 && second.body.ok === true && second.body.status === 'unchanged' && Number(second.body.steps) === 0
      && (second.body.regen && (second.body.regen.unchanged || []).includes('R')),
    { httpStatus: second.status, response: second.body });

  const page2 = await openPage(browser, canvasId, calls);
  try {
    await waitCalls(calls, 1, 30000);
    const request = calls.image[0];
    await waitHist(page2.page, 'R', 2, 30000);
    await waitRuntimeIdle(page2.page);
    const autorun = await page2.page.evaluate(() => (window.__autorunLog || []).slice(-20));
    const state = await page2.page.evaluate(() => {
      const s = window.__cn; const r = s.node('R');
      return { hist: r.data.gen.hist.map((h) => h.url), agentRun: r.data.agentRun || null, agentDone: r.data.agentDone || null, runtime: Object.keys(s.state.runtime) };
    });
    ev.scenarios.B.request = slimBody(request);
    ev.scenarios.B.autorun = autorun;
    ev.scenarios.B.afterCanvas = state;

    const refs = refsOf(request);
    check('B 画布真正发出的请求不带问题图：reference_images 只有最初上传素材',
      refs.length === 1 && refs[0] === UPLOAD && !refs.includes(R_GEN) && !refs.includes(S_GEN), { reference_images: request.reference_images });
    check('B 提示词按传入的新提示词生效',
      String(request.prompt || '').includes(NEW_PROMPT), { prompt: request.prompt });
    check('B 画布真的跑完并回写（R.hist=2 且 agentDone.ok=true，非空跑）',
      state.hist.length === 2 && state.hist[1] === MOCK_OUT && !!state.agentDone && state.agentDone.ok === true,
      { hist: state.hist, agentDone: state.agentDone });
    check('B 这次请求来自 autorun（加载后自动接手 agentRun 标记）',
      autorun.some((row) => row.stage === 'cycle' && Number(row.queued) >= 1) && autorun.some((row) => row.stage === 'single-done' && row.ok === true),
      { autorun });

    await fitAll(page2.page, ['U', 'T', 'S', 'R']);
    await shot(page2.page, 'B-regenerate');
  } finally { await page2.context.close().catch(() => null); }

  // 画布自动保存过之后：护栏状态应该还在 data.agentRegen（顶层旧读法只作向后兼容检查），同样请求仍被拦成 unchanged
  const savedNode = await pollNode(api, canvasId, 'R',
    (n) => !!(n.data && n.data.agentRegen) && ((n.data.gen && n.data.gen.hist) || []).length >= 2,
    20000, '画布保存后 data.agentRegen 仍在');
  const afterSave = await postRegen();
  ev.scenarios.B.afterSave = {
    dataAgentRegen: (savedNode.data && savedNode.data.agentRegen) || null,
    topLevelAgentRegen: savedNode.agentRegen || null,
    regenState: regenStateOf(savedNode),
    response: afterSave,
  };
  check('保存后护栏状态仍在 data.agentRegen，且同样的 /api/agent/regenerate 返回 unchanged',
    !!savedNode.data.agentRegen && afterSave.status === 200 && afterSave.body.status === 'unchanged'
      && Number(afterSave.body.steps) === 0 && !!afterSave.body.regen && (afterSave.body.regen.unchanged || []).includes('R'),
    { dataAgentRegen: (savedNode.data && savedNode.data.agentRegen) || null, topLevelAgentRegen: savedNode.agentRegen || null, response: afterSave });

  // 防空过：把 data.agentRegen 也删掉（护栏状态彻底清空）后，同样请求必须真跑
  const cleared = await clearAgentRegen(api, canvasId, 'R');
  const afterClear = await postRegen();
  ev.scenarios.B.afterClear = {
    clear: { httpStatus: cleared.httpStatus, removed: cleared.removed, error: cleared.error },
    nodeHasAgentRegen: !!(cleared.node && (cleared.node.agentRegen || (cleared.node.data && cleared.node.data.agentRegen))),
    response: afterClear,
  };
  check('把 data.agentRegen 删掉后，同样请求会真跑（RUNNING），说明上一条 unchanged 不是空过',
    cleared.httpStatus === 200 && cleared.removed === true
      && afterClear.status === 200 && afterClear.body.status === 'RUNNING' && Number(afterClear.body.steps) >= 1
      && !!afterClear.body.regen && (afterClear.body.regen.allowed || []).includes('R'),
    { clear: { httpStatus: cleared.httpStatus, removed: cleared.removed, error: cleared.error },
      nodeHasAgentRegenAfterClear: !!(cleared.node && (cleared.node.agentRegen || (cleared.node.data && cleared.node.data.agentRegen))),
      response: afterClear });
}

/* ---------------- 场景 C：助手「在这张基础上改」 ---------------- */
async function scenarioC(browser, api, calls) {
  const canvasId = await H.createCanvas(api, 'E2E-REGEN-C-' + Date.now());
  createdCanvases.push(canvasId);
  const seedPage = await openPage(browser, canvasId, { image: [] });
  try { await seedScene(seedPage.page); } finally { await seedPage.context.close().catch(() => null); }
  await waitFor(async () => (await getCanvas(api, canvasId)).nodes.length === 4, 10000, '后端画布 4 节点');

  const res = await api.post('/api/agent/tools/run_generation', { data: { args: {
    canvas_id: canvasId, node_id: 'R', reference_images: [AGENT_REF],
  } } });
  const body = await res.json().catch(() => ({}));
  const markerNode = await pollNode(api, canvasId, 'R',
    (n) => n.data && n.data.agentRun && Array.isArray(n.data.agentRun.referenceImages) && n.data.agentRun.referenceImages.includes(AGENT_REF),
    30000, 'agentRun.referenceImages');
  const cHttp = res.status();
  ev.scenarios.C = { canvasId, tool: { httpStatus: cHttp, body }, marker: markerOf(markerNode), requested: AGENT_REF };
  check('C 后端 run_generation 把指定图写进 data.agentRun.referenceImages',
    cHttp === 200 && body.ok === true && markerNode.data.agentRun.referenceImages.includes(AGENT_REF),
    { httpStatus: cHttp, response: body, agentRun: markerNode.data.agentRun });

  const page2 = await openPage(browser, canvasId, calls);
  try {
    await waitCalls(calls, 1, 30000);
    const request = calls.image[0];
    await waitHist(page2.page, 'R', 2, 30000);
    await waitRuntimeIdle(page2.page);
    const state = await page2.page.evaluate(() => {
      const s = window.__cn; const r = s.node('R');
      return { hist: r.data.gen.hist.map((h) => h.url), agentDone: r.data.agentDone || null };
    });
    ev.scenarios.C.request = slimBody(request);
    ev.scenarios.C.afterCanvas = state;
    const refs = refsOf(request);
    check('C 指定的参考图进了这次请求的 reference_images（「在这张基础上改」能力保住）',
      refs.includes(AGENT_REF), { reference_images: request.reference_images });
    check('C 请求里没有节点自己的问题图（R 的上一版不入参考）',
      !refs.includes(R_GEN), { reference_images: request.reference_images });
    check('C 画布真的跑完并回写（R.hist=2，非空跑）',
      state.hist.length === 2 && state.hist[1] === MOCK_OUT, { hist: state.hist });
    await fitAll(page2.page, ['U', 'T', 'S', 'R']);
    await shot(page2.page, 'C-edit-on-this');
  } finally { await page2.context.close().catch(() => null); }
}

/* ---------------- 场景 E：用户侧重抽连续两次都要真跑 ---------------- */
async function scenarioE(browser, api, calls) {
  const canvasId = await H.createCanvas(api, 'E2E-REGEN-E-' + Date.now());
  createdCanvases.push(canvasId);
  const seedPage = await openPage(browser, canvasId, { image: [] });
  try { await seedScene(seedPage.page); } finally { await seedPage.context.close().catch(() => null); }
  await waitFor(async () => (await getCanvas(api, canvasId)).nodes.length === 4, 10000, '后端画布 4 节点');

  const runTool = async () => {
    const res = await api.post('/api/agent/tools/run_generation', { data: { args: {
      canvas_id: canvasId, node_id: 'R', exclude_self_refs: true,
    } } });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  };
  const inner = (b) => (b && (b.result || b)) || {};

  const r1 = await runTool();
  ev.scenarios.E = { canvasId, first: r1 };
  check('E 用户侧重抽 #1：run_generation 只带 exclude_self_refs → 真实接口 status=queued_on_canvas（真跑）',
    r1.status === 200 && r1.body.ok === true && inner(r1.body).status === 'queued_on_canvas' && inner(r1.body).generation_units === 1,
    { httpStatus: r1.status, response: r1.body });
  const m1 = await pollNode(api, canvasId, 'R', (n) => n.data && n.data.agentRun && n.data.agentRun.excludeSelfRefs === true, 30000, '重抽 #1 标记');
  ev.scenarios.E.marker1 = markerOf(m1);
  const p1 = await openPage(browser, canvasId, calls);
  let firstRefs = null;
  try {
    await waitCalls(calls, 1, 30000);
    await waitHist(p1.page, 'R', 2, 30000);
    await waitRuntimeIdle(p1.page);
    firstRefs = refsOf(calls.image[0]);
    ev.scenarios.E.request1 = slimBody(calls.image[0]);
    await fitAll(p1.page, ['U', 'T', 'S', 'R']);
    await shot(p1.page, 'E-user-rerun-1');
  } finally { await p1.context.close().catch(() => null); }

  await waitFor(async () => { const n = await getNode(api, canvasId, 'R'); return !!n && !n.data.agentRun; }, 15000, '重抽 #1 标记被画布消费');

  const r2 = await runTool();
  ev.scenarios.E.second = r2;
  check('E 用户侧重抽 #2：同样请求再次 queued_on_canvas（不被 unchanged 拦）',
    r2.status === 200 && r2.body.ok === true && inner(r2.body).status === 'queued_on_canvas' && inner(r2.body).generation_units === 1,
    { httpStatus: r2.status, response: r2.body });
  const m2 = await pollNode(api, canvasId, 'R', (n) => n.data && n.data.agentRun && n.data.agentRun.excludeSelfRefs === true, 30000, '重抽 #2 标记');
  ev.scenarios.E.marker2 = markerOf(m2);
  const p2 = await openPage(browser, canvasId, calls);
  let secondRefs = null;
  try {
    await waitCalls(calls, 2, 30000);
    await waitHist(p2.page, 'R', 3, 30000);
    await waitRuntimeIdle(p2.page);
    secondRefs = refsOf(calls.image[1]);
    ev.scenarios.E.request2 = slimBody(calls.image[1]);
    await fitAll(p2.page, ['U', 'T', 'S', 'R']);
    await shot(p2.page, 'E-user-rerun-2');
  } finally { await p2.context.close().catch(() => null); }

  check('E 用户侧重抽两次都真的发出了生图请求（各一次，且都不带问题图）',
    !!firstRefs && !!secondRefs && calls.image.length === 2
      && firstRefs.join('|') === UPLOAD && secondRefs.join('|') === UPLOAD,
    { calls: calls.image.length, refs1: firstRefs, refs2: secondRefs });
}

/* ---------------- 报告 ---------------- */
function writeReport() {
  ev.finishedAt = new Date().toISOString();
  ev.base = BASE;
  ev.dataDir = DATA_DIR;
  ev.backendLog = LOG_FILE;
  ev.checks = results;
  ev.notes = notes;
  ev.screenshots = shots;
  ev.pageErrors = pageErrors;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), JSON.stringify(ev, null, 2));

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const code = (obj) => FENCE + 'json\n' + JSON.stringify(obj, null, 2) + '\n' + FENCE;
  const lines = [];
  lines.push('# 「再来一张 / 助手重新生成」端到端验收报告');
  lines.push('');
  lines.push('- 时间：' + ev.startedAt + ' → ' + ev.finishedAt);
  lines.push('- 后端：' + q(BASE) + '（NOVAI_PORT=3921，独立进程，脚本自起自停）');
  lines.push('- 数据目录：' + q(DATA_DIR) + '（全新）');
  lines.push('- 后端日志：' + q(LOG_FILE));
  lines.push('- 前端：' + q('/static/canvas.html') + ' → 构建产物 ' + q('static/novai-canvas/canvas.js') + '（' + (ev.bundle ? ev.bundle.bytes : '?') + ' bytes）');
  lines.push('- 总和：**' + pass + ' / ' + results.length + ' 通过**' + (fail ? '，**' + fail + ' 条失败**' : '，无失败'));
  lines.push('');
  lines.push('## 断言结果');
  lines.push('');
  lines.push('| # | 断言 | 结果 |');
  lines.push('| --- | --- | --- |');
  results.forEach((r, i) => lines.push('| ' + (i + 1) + ' | ' + r.name.replace(/\|/g, '\\|') + ' | ' + (r.ok ? 'PASS' : 'FAIL') + ' |'));
  lines.push('');

  const A = ev.scenarios.A, B = ev.scenarios.B, C = ev.scenarios.C, D = ev.scenarios.D, E = ev.scenarios.E;
  if (A) {
    lines.push('### A. 工具条「再来一张」（点结果节点 R）');
    lines.push('');
    lines.push('- 真实请求体（POST /api/canvas-image-tasks）：');
    lines.push(code({ node_id: A.request.node_id, model: A.request.provider_id + '::' + A.request.model, size: A.request.size, prompt: A.request.prompt, reference_images: A.request.reference_images }));
    lines.push('- 新节点：' + q(A.newId) + '，data.sourceNodeId=' + q('R') + '；全部连线：' + JSON.stringify(A.after.edges));
    lines.push('- 结论：reference_images = ' + q(JSON.stringify(refsOf(A.request))) + '，没有 R 的上一版 ' + q(R_GEN) + ' / 来源 S 的 ' + q(S_GEN) + '；新节点没和 R / S 连箭头。');
    lines.push('');
  }
  if (B) {
    lines.push('### B. 助手审查不合格 → POST /api/agent/regenerate');
    lines.push('');
    lines.push('- 第 1 次真实返回：');
    lines.push(code(B.regenerate.first));
    lines.push('- 第 2 次（同样请求）真实返回：');
    lines.push(code(B.regenerate.second));
    lines.push('- 后端写下的标记：' + JSON.stringify(B.marker.agentRun) + '，提示词：' + q(B.marker.prompt));
    if (B.request) {
      lines.push('- 画布真正发出的请求体：');
      lines.push(code({ node_id: B.request.node_id, model: B.request.provider_id + '::' + B.request.model, prompt: B.request.prompt, reference_images: B.request.reference_images }));
      lines.push('- 画布回写：hist=' + JSON.stringify(B.afterCanvas && B.afterCanvas.hist) + '，agentDone=' + JSON.stringify(B.afterCanvas && B.afterCanvas.agentDone));
    }
    if (B.afterSave) {
      lines.push('- 画布自动保存后再发同样请求（护栏状态在 data.agentRegen）真实返回：');
      lines.push(code(B.afterSave.response));
    }
    if (B.afterClear) {
      lines.push('- 把 data.agentRegen 删掉后再发同样请求（防空过）真实返回：');
      lines.push(code(B.afterClear.response));
    }
    lines.push('');
  }
  if (C) {
    lines.push('### C. 助手「在这张基础上改」（agentRun.referenceImages）');
    lines.push('');
    lines.push('- 真实接口 POST /api/agent/tools/run_generation 返回：');
    lines.push(code(C.tool));
    lines.push('- 后端写下的标记：' + JSON.stringify(C.marker.agentRun));
    if (C.request) {
      lines.push('- 画布真正发出的请求体：');
      lines.push(code({ node_id: C.request.node_id, prompt: C.request.prompt, reference_images: C.request.reference_images }));
    }
    lines.push('');
  }
  if (D) {
    lines.push('### D. 上传素材节点连点两次生成');
    lines.push('');
    lines.push('- 第 1 次请求体：');
    lines.push(code({ node_id: D.request1.node_id, prompt: D.request1.prompt, reference_images: D.request1.reference_images }));
    lines.push('- 第 2 次请求体：');
    lines.push(code({ node_id: D.request2.node_id, prompt: D.request2.prompt, reference_images: D.request2.reference_images }));
    lines.push('- 结果节点 ' + q(D.resultId) + ' 的两版：' + JSON.stringify((D.after.nodes.find((n) => n.id === D.resultId) || {}).hist));
    lines.push('');
  }
  if (E) {
    lines.push('### E. 用户侧重抽（只带 exclude_self_refs）连续两次真跑');
    lines.push('');
    lines.push('- 第 1 次真实返回：');
    lines.push(code(E.first));
    lines.push('- 第 2 次真实返回：');
    lines.push(code(E.second));
    if (E.request1) lines.push('- 第 1 次画布请求 reference_images：' + q(JSON.stringify(refsOf(E.request1))));
    if (E.request2) lines.push('- 第 2 次画布请求 reference_images：' + q(JSON.stringify(refsOf(E.request2))));
    lines.push('');
  }
  if (notes.length) {
    lines.push('## ⚠️ 发现的异常 / 附加观察');
    lines.push('');
    notes.forEach((n) => {
      lines.push('- **' + n.text + '**');
      if (n.data) lines.push(code(n.data));
    });
    lines.push('');
  }
  if (pageErrors.length) {
    lines.push('## 页面报错（浏览器控制台 / pageerror 原样）');
    lines.push('');
    pageErrors.slice(0, 30).forEach((p) => lines.push('- ' + q('[' + p.canvasId + ']') + ' ' + String(p.error).slice(0, 300)));
    lines.push('');
  }
  if (Object.keys(shots).length) {
    lines.push('## 截图');
    lines.push('');
    Object.entries(shots).forEach(([k, v]) => lines.push('- ' + q(path.basename(v)) + ' — ' + k));
    lines.push('');
  }
  lines.push('## 证据文件');
  lines.push('');
  lines.push('- ' + q('evidence.json') + '（断言明细 + 全部请求体 + 接口返回）');
  lines.push('- ' + q('REPORT.md') + '（本文件）');
  lines.push('- 截图见上');
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'));

  console.log('');
  console.log('[' + (fail ? 'FAIL' : 'PASS') + '] 再来一张 / 助手重新生成 E2E：' + (fail ? fail + ' 条失败（共 ' + results.length + ' 条）' : results.length + ' 条全部通过'));
  console.log('REPORT ' + path.join(OUT_DIR, 'REPORT.md'));
  console.log('EVIDENCE ' + path.join(OUT_DIR, 'evidence.json'));
  if (notes.length) console.log('⚠️  ' + notes.length + ' 条附加观察，见 REPORT.md「发现的异常 / 附加观察」');
}

/* ---------------- 主流程 ---------------- */
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (await portBusy()) throw new Error('3921 已被占用（不是本脚本起的）：先停掉它，绝不碰 3000');
  prepareAssets();
  const backend = startBackend();
  const api = await request.newContext({ baseURL: BASE });
  let browser = null;
  try {
    await waitBackend(api, backend.proc);

    const bundleRes = await api.get('/static/novai-canvas/canvas.js');
    const bundleText = await bundleRes.text();
    ev.bundle = {
      status: bundleRes.status(), bytes: Buffer.byteLength(bundleText, 'utf8'),
      hasAgentRunReferenceImages: bundleText.includes('agentRun.referenceImages'),
      hasPendingReferenceImages: bundleText.includes('agentPendingReferenceImages'),
      hasExcludeSelfRefs: bundleText.includes('excludeSelfRefs'),
    };
    check('运行的是包含本次改动的前端构建（canvas.js 里有 agentRun.referenceImages / excludeSelfRefs 契约）',
      ev.bundle.status === 200 && ev.bundle.hasAgentRunReferenceImages && ev.bundle.hasExcludeSelfRefs, ev.bundle);

    browser = await H.launchBrowser();
    const callsA = { image: [] }, callsD = { image: [] }, callsB = { image: [] }, callsC = { image: [] }, callsE = { image: [] };
    await scenarioA(browser, api, callsA);
    await scenarioD(browser, api, callsD);
    await scenarioB(browser, api, callsB);
    await scenarioC(browser, api, callsC);
    await scenarioE(browser, api, callsE);
  } catch (err) {
    console.error(err);
    check('脚本完整跑完（无异常中断）', false, String((err && err.message) || err));
  } finally {
    if (browser) await browser.close().catch(() => null);
    for (const id of createdCanvases) { await H.deleteCanvas(api, id).catch(() => null); }
    await api.dispose().catch(() => null);
    await stopBackend(backend.proc);
    writeReport();
  }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
