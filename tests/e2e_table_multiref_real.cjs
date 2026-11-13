#!/usr/bin/env node
'use strict';
/*
 * 多维表格多参考图：真实模型端到端验收（真实 APIMART gpt-4o-mini 出表 + gemini-nano-banana-2.1 逐行出图）
 *   场景：场景 3 / 人物三视图 3 / 模特姿势 1 / 产品多角度 4（产品组里套堆叠分组）
 *   用法：NOVAI_BASE=http://127.0.0.1:3942 NOVAI_DATA_DIR=/tmp/novai-real-test node tests/e2e_table_multiref_real.cjs
 *   不 mock 任何模型接口；只旁路观察前端发出的提示词与生图请求体。
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT_DIR = path.join(__dirname, '..', '..', '_verification-table-multiref');
fs.mkdirSync(OUT_DIR, { recursive: true });
const TEXT_MODEL = process.env.E2E_TEXT_MODEL || 'apimart::gpt-4o-mini';
const IMAGE_MODEL = process.env.E2E_IMAGE_MODEL || 'apimart::gemini-nano-banana-2.1';

const calls = { llm: [], image: [] };
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};

(async () => {
  const api = await request.newContext({ baseURL: H.BASE });
  const canvasId = await H.createCanvas(api, 'REAL-MULTIREF-' + Date.now());
  console.log('canvas', canvasId, 'text', TEXT_MODEL, 'image', IMAGE_MODEL);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: H.chromiumExecutable(), headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const { page } = await H.openCanvasPage(browser, canvasId);
    page.on('crash', () => console.log('PAGE CRASH'));
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e && e.message || e)));

    /* 1. 场景 */
    const seeded = await page.evaluate(({ textModel, imageModel }) => {
      const store = window.__cn;
      const mk = (id, url, title, x, y) => store.newNode('image', x, y, { id, title, hist: [{ url: url, w: 200, h: 200 }], hi: 0 });
      const nodes = [];
      const scene = [0, 1, 2].map((i) => mk('sc' + i, '/assets/input/sc' + i + '.png', '场景 ' + (i + 1), 80, i * 240));
      const person = [0, 1, 2].map((i) => mk('pe' + i, '/assets/input/pe' + i + '.png', '人物三视图 ' + (i + 1), 360, i * 240));
      const pose = [mk('po0', '/assets/input/po0.png', '模特姿势', 640, 0)];
      const prod = [0, 1, 2, 3].map((i) => mk('pr' + i, '/assets/input/pr' + i + '.png', '产品多角度 ' + (i + 1), 940 + (i % 2) * 220, Math.floor(i / 2) * 240));
      nodes.push(...scene, ...person, ...pose, ...prod);
      nodes.push({ id: 'g_prod_inner', kind: 'group', x: 920, y: -40, w: 200, h: 220, text: '堆叠', children: ['pr0', 'pr1'], data: { stack: true } });
      nodes.push({ id: 'g_scene', kind: 'group', x: 60, y: -20, w: 200, h: 760, text: '场景参考', children: ['sc0', 'sc1', 'sc2'] });
      nodes.push({ id: 'g_person', kind: 'group', x: 340, y: -20, w: 200, h: 760, text: '人物三视图', children: ['pe0', 'pe1', 'pe2'] });
      nodes.push({ id: 'g_pose', kind: 'group', x: 620, y: -20, w: 200, h: 300, text: '模特姿势', children: ['po0'] });
      nodes.push({ id: 'g_product', kind: 'group', x: 900, y: -20, w: 480, h: 560, text: '产品多角度', children: ['g_prod_inner', 'pr2', 'pr3'] });
      nodes.push(store.newNode('text', 1500, 120, { id: 't1', title: '多参考图批量',
        prompt: '每行一个场景，人物三视图、模特姿势、产品多角度每行都作为参考', params: { output: 'table', model: textModel } }));
      store.addNodes(nodes, [], { history: false });
      ['g_scene', 'g_person', 'g_pose', 'g_product'].forEach((gid) => store.addEdge(gid, 't1'));
      return { nodes: store.state.doc.nodes.length };
    }, { textModel: TEXT_MODEL, imageModel: IMAGE_MODEL });
    check('场景节点就绪（4 组 + 嵌套产品组 + 文本节点）', seeded.nodes === 17, seeded);

    /* 2. 真实 LLM 出表（限时 5 分钟） */
    await page.evaluate(() => window.__cn.setUI({ sel: new Set(['t1']) }));
    await page.waitForTimeout(300);
    await page.locator('[data-p="send"]:visible').first().click();
    await page.waitForFunction(() => {
      const s = window.__cn;
      return s.state.doc.nodes.some((n) => n.kind === 'table') && Object.keys(s.state.runtime || {}).length === 0;
    }, null, { timeout: 300000 });
    const tableInfo = await page.evaluate(() => {
      const s = window.__cn; const t = s.state.doc.nodes.find((n) => n.kind === 'table');
      return { id: t.id, rows: t.data.table.rows.length, columns: t.data.table.columns, inputModes: t.data.table.inputModes,
        incoming: s.state.doc.edges.filter((e) => e.to === t.id).map((e) => e.from),
        cells: t.data.table.rows.map((r) => r.map((c) => String(c).slice(0, 80))) };
    });
    check('真实 LLM 出表：3 行（每行一个场景）', tableInfo.rows === 3, { rows: tableInfo.rows, columns: tableInfo.columns });
    {
      const mm = tableInfo.inputModes || {};
      check('真实 LLM 出表：输入 1 逐行、输入 2/4 整组（全部）', mm['input-1'] === 'sequence' && mm['input-2'] === 'all' && mm['input-4'] === 'all', mm);
      check('输入 3（模特姿势）单张，沿用/全部等价', !mm['input-3'] || mm['input-3'] === 'all', mm);
    }
    console.log('  table cells:', JSON.stringify(tableInfo.cells).slice(0, 700));

    /* 3. 真实出图（限时 10 分钟） */
    await page.evaluate(({ tableId, imageModel }) => {
      const s = window.__cn;
      const n = s.newNode('image', s.node(tableId).x + s.node(tableId).w + 160, s.node(tableId).y, {
        id: 'batch1', title: '批量出图', prompt: '按表格逐行生成商业海报，人物与产品保持一致',
        params: { model: imageModel, ratio: '1:1', size: '1K', count: 1, search: false } });
      s.addNodes([n], [], { history: false });
      s.addEdge(tableId, 'batch1');
      s.setUI({ sel: new Set(['batch1']) });
    }, { tableId: tableInfo.id, imageModel: IMAGE_MODEL });
    await page.waitForTimeout(400);
    await page.locator('.gp-batch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-p="send"]:visible').first().click();
    await page.waitForFunction(() => {
      const s = window.__cn; const n = s.node('batch1');
      const j = n && n.data && n.data.batch && n.data.batch.journal;
      const done = j && Array.isArray(j.rows) && j.rows.length > 0 && j.rows.every((r) => r.status === 'completed' || r.status === 'failed');
      return done && Object.keys(s.state.runtime || {}).length === 0;
    }, null, { timeout: 900000 });

    const batchInfo = await page.evaluate(() => {
      const s = window.__cn; const n = s.node('batch1');
      const rows = s.state.doc.nodes.filter((x) => x.data && x.data.batchOf === 'batch1')
        .sort((a, b) => Number(a.data.tableRow) - Number(b.data.tableRow))
        .map((x) => ({ row: Number(x.data.tableRow), status: (n.data.batch.journal.rows.find((r) => r.row === Number(x.data.tableRow)) || {}).status,
          out: (x.data.gen.hist[0] || {}).url, err: (x.data.gen || {}).err || '', warn: x.data.rowWarn || '' }));
      return { statuses: (n.data.batch.journal.rows || []).map((r) => ({ row: r.row, status: r.status, error: r.error || '' })), rows };
    });
    console.log('  batch statuses:', JSON.stringify(batchInfo.statuses));
    // 不拦截网络：从后端任务库读真实发出的请求（提示词 + 参考图顺序）
    try {
      const taskDir = path.join(H.DATA_DIR, 'data', 'tasks');
      const files = fs.existsSync(taskDir) ? fs.readdirSync(taskDir).filter((f) => f.endsWith('.json')) : [];
      const mine = [];
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8'));
        for (const t of Object.values(data.tasks || {})) {
          const pl = t.payload || {};
          if (pl.canvas_id !== canvasId || !/image/.test(String(t.kind || ''))) continue;
          mine.push({ status: t.status, prompt: String(pl.prompt || ''), refs: (pl.reference_images || []).map((r) => r.url), created: t.created_at });
        }
      }
      mine.sort((a, b) => a.created - b.created);
      calls.image = mine.map((m) => ({ prompt: m.prompt, reference_images: m.refs.map((url) => ({ url })), _status: m.status }));
      console.log('  task-store image calls:', calls.image.length, calls.image.map((b) => (b.reference_images || []).length));
    } catch (e) { console.log('task-store read failed', String(e && e.message || e)); }
    check('批量 3 行全部成功（真实出图）', batchInfo.statuses.length === 3 && batchInfo.statuses.every((r) => r.status === 'completed'), batchInfo.statuses);
    check('每行都有真实结果地址', batchInfo.rows.length === 3 && batchInfo.rows.every((r) => !!r.out), batchInfo.rows.map((r) => ({ row: r.row, out: r.out, err: r.err })).slice(0, 3));

    check('真实生图请求共 3 次，每次 9 张参考图', calls.image.length === 3 && calls.image.every((b) => b && (b.reference_images || []).length === 9), calls.image.map((b) => ((b && b.reference_images) || []).length));
    const refsOf = (b) => ((b && b.reference_images) || []).map((r) => String(r.url).split('/').pop());
    const expect = (i) => ['sc' + i, 'pe0', 'pe1', 'pe2', 'po0', 'pr0', 'pr1', 'pr2', 'pr3'].map((x) => x + '.png');
    check('第 1 行参考图顺序 = 场景1 → 人物整组 → 姿势 → 产品整组', JSON.stringify(refsOf(calls.image[0])) === JSON.stringify(expect(0)), refsOf(calls.image[0]));
    check('第 2 行仍带整组人物/姿势/产品，只换场景', JSON.stringify(refsOf(calls.image[1])) === JSON.stringify(expect(1)), refsOf(calls.image[1]));
    const p1 = String((calls.image[0] || {}).prompt || '');
    check('真实请求提示词带「参考图顺序」清单', p1.includes('参考图顺序') && p1.includes('图1=输入1「场景参考」第1张') && p1.includes('图6-9=输入4「产品多角度」整组'), p1.slice(-500));

    /* 4. 截图 */
    await page.evaluate(() => {
      const s = window.__cn; const all = s.state.doc.nodes.filter((n) => n.id === 'batch1' || n.data && n.data.batchOf === 'batch1' || n.kind === 'table');
      const x0 = Math.min(...all.map((n) => n.x)), y0 = Math.min(...all.map((n) => n.y));
      const x1 = Math.max(...all.map((n) => n.x + n.w)), y1 = Math.max(...all.map((n) => n.y + n.h));
      const w = Math.max(900, window.innerWidth), h = Math.max(600, window.innerHeight);
      const k = Math.min(0.75, (w * 0.9) / Math.max(1, x1 - x0), (h * 0.9) / Math.max(1, y1 - y0));
      s.setView({ x: Math.round(w / 2 - (x0 + (x1 - x0) / 2) * k), y: Math.round(h / 2 - (y0 + (y1 - y0) / 2) * k), k: Math.max(0.2, Math.round(k * 100) / 100) });
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, 'real-e2e.png') });
    await page.locator('.node[data-id="' + tableInfo.id + '"]').screenshot({ path: path.join(OUT_DIR, 'real-table-node.png') }).catch(() => null);
    console.log('SHOT  ' + path.join(OUT_DIR, 'real-e2e.png'));

    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(OUT_DIR, 'real-report.json'), JSON.stringify({ canvasId, textModel: TEXT_MODEL, imageModel: IMAGE_MODEL, table: tableInfo, batch: batchInfo, imageCalls: calls.image.map((b) => ({ prompt: String(b && b.prompt || '').slice(-800), refs: (b && b.reference_images || []).map((r) => r.url) })), llmCalls: calls.llm.length, failed: failed.length, results }, null, 2));
    console.log('');
    console.log('[' + (failed.length ? 'FAIL' : 'PASS') + '] 真实模型多维表格多参考图 E2E：' + (failed.length ? failed.length + ' 条失败' : results.length + ' 条全部通过'));
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close().catch(() => null);
    if (!process.exitCode) await H.deleteCanvas(api, canvasId).catch(() => null); else console.log('canvas kept for postmortem:', canvasId);
    await api.dispose().catch(() => null);
  }
})().catch((err) => { console.error(err); process.exit(1); });
