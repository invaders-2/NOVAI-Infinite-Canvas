#!/usr/bin/env node
'use strict';
/*
 * 多维表格多参考图：真实前端 + 真实后端 + mock 模型接口的端到端验收
 *   场景：场景 3 / 人物三视图 3 / 模特姿势 1 / 产品多角度 4（产品组里再套一个堆叠分组）
 *   验收：出表 3 行、输入 1 逐行、输入 2-4 全部；批量 3 行每行发 9 张图且顺序正确；
 *        提示词里带「参考图顺序」清单（图1=输入1…图9=输入4）；表格无编号告警。
 * 不碰 3000，用独立端口 + 独立数据目录；模型 API 全部页面级 mock（page.route）。
 */
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');
const H = require('./novai_upscale_helpers.cjs');

const OUT_DIR = path.join(__dirname, '..', '..', '_verification-table-multiref');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PLAN = JSON.stringify({ rowCount: 3, inputGroups: [
  { group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' },
  { group: 3, rowMode: 'every-row' }, { group: 4, rowMode: 'every-row' },
] });
const ROW = (i) => '输入1第' + i + '张场景；输入2整组人物三视图；输入3整组模特姿势；输入4整组产品多角度';
const TABLE = JSON.stringify({ kind: 'table', version: 1,
  inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }, { group: 3, rowMode: 'every-row' }, { group: 4, rowMode: 'every-row' }],
  columns: ['画面', '要求'],
  rows: [[ROW(1), '人物外观保持一致'], [ROW(2), '人物外观保持一致'], [ROW(3), '人物外观保持一致']],
});

const calls = { llm: [], image: [] };
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const sse = (text) => 'data: ' + JSON.stringify({ type: 'delta', delta: text }) + '\n\n' +
  'data: ' + JSON.stringify({ type: 'done', text }) + '\n\n';

(async () => {
  const api = await request.newContext({ baseURL: H.BASE });
  const canvasId = await H.createCanvas(api, 'E2E-MULTIREF-' + Date.now());
  const browser = await H.launchBrowser();
  try {
    const { page } = await H.openCanvasPage(browser, canvasId, { beforeGoto: async (page) => {
      await page.route(/\/api\/config$/, async (route) => {
        const res = await route.fetch();
        const data = await res.json().catch(() => ({}));
        data.api_providers = [{ id: 'mock', name: 'Mock 平台', protocol: 'openai', enabled: true, has_key: true,
          chat_models: ['mock-text'], image_models: ['mock-image'], video_models: [], audio_models: [], model_caps: {} }];
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.route(/\/api\/model-caps$/, async (route) => {
        const items = [{ provider: 'mock', model: 'mock-image', kind: 'image', ref_max: 14, n_max: 1,
          ratios: ['1:1'], resolutions: ['1K'], qualities: [] }];
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
      });
      await page.route(/\/api\/canvas-llm\/stream$/, async (route) => {
        const body = route.request().postDataJSON();
        calls.llm.push(body);
        const msg = String(body && body.message || '');
        const reply = /任务规划|inputGroups/.test(msg) && !/"kind"\s*:\s*"table"/.test(msg) ? PLAN : TABLE;
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }, body: sse(reply) });
      });
      await page.route(/\/api\/canvas-image-tasks(?:\/[^/]+)?$/, async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          calls.image.push(req.postDataJSON());
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'mock_task_' + calls.image.length }) });
        } else {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'succeeded', result: { images: [{ url: '/assets/output/mock_result.png', width: 200, height: 200 }] } }) });
        }
      });
    } });

    /* ---------- 1. 搭场景（真实 store）：4 个分组 + 文本节点输出=多维表格 ---------- */
    const seeded = await page.evaluate(() => {
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
      const text = store.newNode('text', 1500, 120, { id: 't1', title: '多参考图批量',
        prompt: '每行一个场景，人物三视图、模特姿势、产品多角度每行都作为参考', params: { output: 'table', model: 'mock::mock-text' } });
      nodes.push(text);
      store.addNodes(nodes, [], { history: false });
      ['g_scene', 'g_person', 'g_pose', 'g_product'].forEach((gid) => store.addEdge(gid, 't1'));
      return { text: 't1', nodes: store.state.doc.nodes.length };
    });
    check('场景节点就绪（4 组 + 嵌套产品组 + 文本节点）', seeded.nodes === 17, seeded);

    /* ---------- 2. 跑「文本 → 多维表格」 ---------- */
    await page.evaluate(() => { const s = window.__cn; s.setUI({ sel: new Set(['t1']) }); });
    await page.waitForTimeout(300);
    await page.locator('[data-p="send"]:visible').first().click();
    await page.waitForFunction(() => {
      const s = window.__cn;
      return s.state.doc.nodes.some((n) => n.kind === 'table') && Object.keys(s.state.runtime || {}).length === 0;
    }, null, { timeout: 60000 });
    const tableInfo = await page.evaluate(() => {
      const s = window.__cn; const t = s.state.doc.nodes.find((n) => n.kind === 'table');
      const incoming = s.state.doc.edges.filter((e) => e.to === t.id).map((e) => e.from);
      return { id: t.id, rows: t.data.table.rows.length, columns: t.data.table.columns, inputModes: t.data.table.inputModes, incoming };
    });
    check('表格 3 行（不再被产品组 4 张拉成 4 行）', tableInfo.rows === 3, tableInfo.rows);
    check('输入 1 逐行、输入 2-4 全部', JSON.stringify(tableInfo.inputModes) === JSON.stringify({ 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }), tableInfo.inputModes);
    check('表格入边顺序 = 文本 → 场景 → 人物 → 姿势 → 产品', JSON.stringify(tableInfo.incoming) === JSON.stringify(['t1', 'g_scene', 'g_person', 'g_pose', 'g_product']), tableInfo.incoming);

    const planBody = calls.llm.find((b) => /任务规划|inputGroups/.test(String(b.message || '')) && !/"kind"\s*:\s*"table"/.test(String(b.message || '')));
    const genBody = calls.llm.find((b) => /"kind"\s*:\s*"table"/.test(String(b.message || '')));
    check('规划提示词列出真实的 4 个输入组', !!planBody && ['第 1 组（输入 1）「场景参考」3 张', '第 2 组（输入 2）「人物三视图」3 张', '第 3 组（输入 3）「模特姿势」1 张', '第 4 组（输入 4）「产品多角度」4 张'].every((x) => String(planBody.message).includes(x)), planBody && String(planBody.message).slice(0, 200));
    check('出表提示词不再写死「必须正好 N 行」', !!genBody && !String(genBody.message).includes('必须正好') && String(genBody.message).includes('不增加行数'));

    /* ---------- 3. 表格 UI 检查 ---------- */
    await page.evaluate((id) => {
      const s = window.__cn; const t = s.node(id);
      const w = Math.max(900, window.innerWidth), h = Math.max(600, window.innerHeight);
      s.setView({ x: Math.round(w / 2 - (t.x + t.w / 2) * 0.8), y: Math.round(h / 2 - (t.y + t.h / 2) * 0.8), k: 0.8 });
    }, tableInfo.id);
    await page.waitForTimeout(500);
    await page.locator('.node[data-id="' + tableInfo.id + '"] .tnode').waitFor({ state: 'visible', timeout: 15000 });
    const ui = await page.evaluate((id) => {
      const el = document.querySelector('.node[data-id="' + id + '"]');
      return {
        inputs: Array.from(el.querySelectorAll('.tin-label')).map((x) => x.textContent.trim()),
        modes: Array.from(el.querySelectorAll('.tmode')).map((x) => x.textContent.trim()),
        rows: el.querySelectorAll('tbody tr').length,
        warns: el.querySelectorAll('.trefwarn').length,
      };
    }, tableInfo.id);
    check('表格显示 4 条输入列', JSON.stringify(ui.inputs) === JSON.stringify(['输入 1', '输入 2', '输入 3', '输入 4']), ui.inputs);
    check('表头模式 = 逐行 / 全部 / 全部 / 全部', ui.modes.join('|') === '逐行|全部|全部|全部', ui.modes);
    check('表格 3 行、无编号告警', ui.rows === 3 && ui.warns === 0, ui);

    /* ---------- 4. 接批量节点 → 逐行出图（mock 生图接口，抓真实请求体） ---------- */
    const batchId = await page.evaluate((tableId) => {
      const s = window.__cn;
      const n = s.newNode('image', s.node(tableId).x + s.node(tableId).w + 160, s.node(tableId).y, {
        id: 'batch1', title: '批量出图', prompt: '按表格逐行生成商业海报，人物与产品保持一致',
        params: { model: 'mock::mock-image', ratio: '1:1', size: '1K', count: 1, search: false } });
      s.addNodes([n], [], { history: false });
      s.addEdge(tableId, 'batch1');
      s.setUI({ sel: new Set(['batch1']) });
      return 'batch1';
    }, tableInfo.id);
    await page.waitForTimeout(400);
    await page.locator('.gp-batch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-p="send"]:visible').first().click();
    await page.waitForFunction((bid) => {
      const s = window.__cn; const n = s.node(bid);
      const j = n && n.data && n.data.batch && n.data.batch.journal;
      const done = j && Array.isArray(j.rows) && j.rows.length > 0 && j.rows.every((r) => r.status === 'completed');
      const rows = s.state.doc.nodes.filter((x) => x.data && x.data.batchOf === bid);
      return done && rows.length === 3 && Object.keys(s.state.runtime || {}).length === 0;
    }, batchId, { timeout: 90000 });

    const batchInfo = await page.evaluate((bid) => {
      const s = window.__cn; const n = s.node(bid);
      const rows = s.state.doc.nodes.filter((x) => x.data && x.data.batchOf === bid)
        .sort((a, b) => Number(a.data.tableRow) - Number(b.data.tableRow))
        .map((x) => ({ row: Number(x.data.tableRow), out: (x.data.gen.hist[0] || {}).url, warn: x.data.rowWarn || '' }));
      return { statuses: (n.data.batch.journal.rows || []).map((r) => r.status), rows };
    }, batchId);
    check('批量 3 行全部完成、每行一个结果节点', batchInfo.statuses.join(',') === 'completed,completed,completed' && batchInfo.rows.length === 3, batchInfo);
    check('每行结果都是 mock 出图地址', batchInfo.rows.every((r) => r.out === '/assets/output/mock_result.png'), batchInfo.rows.map((r) => r.out));
    check('每行没有截断/降级告警', batchInfo.rows.every((r) => !r.warn), batchInfo.rows.map((r) => r.warn));

    await page.waitForTimeout(1200);
    check('生图请求共 3 次（一行一次）', calls.image.length === 3, calls.image.length);
    const expect = (i) => ['sc' + i, 'pe0', 'pe1', 'pe2', 'po0', 'pr0', 'pr1', 'pr2', 'pr3'].map((x) => '/assets/input/' + x + '.png');
    const refsOf = (b) => (b.reference_images || []).map((r) => String(r.url).replace(H.BASE, ''));
    check('每行都发满 9 张（场景 1 + 人物 3 + 姿势 1 + 产品 4，嵌套产品组也在）', calls.image.every((b) => (b.reference_images || []).length === 9), calls.image.map((b) => (b.reference_images || []).length));
    check('第 1 行图片顺序 = 场景1 → 人物整组 → 姿势 → 产品整组', JSON.stringify(refsOf(calls.image[0])) === JSON.stringify(expect(0)), refsOf(calls.image[0]));
    check('第 2 行只换场景（场景2），其余整组不变', JSON.stringify(refsOf(calls.image[1])) === JSON.stringify(expect(1)), refsOf(calls.image[1]));
    check('第 3 行只换场景（场景3）', JSON.stringify(refsOf(calls.image[2])) === JSON.stringify(expect(2)), refsOf(calls.image[2]));
    const p1 = String(calls.image[0].prompt || '');
    check('请求提示词带「参考图顺序」清单', p1.includes('参考图顺序'));
    check('清单把图号映射回输入列（图1=输入1 第1张 / 图2-4=输入2 整组 / 图6-9=输入4）',
      p1.includes('图1=输入1「场景参考」第1张') && p1.includes('图2-4=输入2「人物三视图」整组') && p1.includes('图6-9=输入4「产品多角度」整组'), p1.slice(-600));
    check('图片实际顺序与清单一致（第 1 张 = 场景1）', refsOf(calls.image[0])[0].endsWith('/sc0.png') && p1.includes('图1=输入1「场景参考」第1张'));

    /* ---------- 5. 截图 ---------- */
    await page.evaluate(({ tid, bid }) => {
      const s = window.__cn; const all = s.state.doc.nodes.filter((n) => n.id === tid || n.id === bid || (n.data && n.data.batchOf === bid));
      const x0 = Math.min(...all.map((n) => n.x)), y0 = Math.min(...all.map((n) => n.y));
      const x1 = Math.max(...all.map((n) => n.x + n.w)), y1 = Math.max(...all.map((n) => n.y + n.h));
      const w = Math.max(900, window.innerWidth), h = Math.max(600, window.innerHeight);
      const k = Math.min(0.8, (w * 0.9) / Math.max(1, x1 - x0), (h * 0.9) / Math.max(1, y1 - y0));
      s.setView({ x: Math.round(w / 2 - (x0 + (x1 - x0) / 2) * k), y: Math.round(h / 2 - (y0 + (y1 - y0) / 2) * k), k: Math.max(0.2, Math.round(k * 100) / 100) });
    }, { tid: tableInfo.id, bid: batchId });
    await page.waitForTimeout(800);
    const shot = path.join(OUT_DIR, 'e2e-multiref.png');
    await page.screenshot({ path: shot });
    await page.locator('.node[data-id="' + tableInfo.id + '"]').screenshot({ path: path.join(OUT_DIR, 'table-node.png') }).catch(() => null);
    console.log('SHOT  ' + shot);
    console.log('SHOT  ' + path.join(OUT_DIR, 'table-node.png'));

    const failed = results.filter((r) => !r.ok);
    const report = { canvasId, table: tableInfo, ui, batch: batchInfo, llmCalls: calls.llm.length, imageCalls: calls.image.length, failed: failed.length, results };
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('');
    console.log('[' + (failed.length ? 'FAIL' : 'PASS') + '] 多维表格多参考图 E2E：' + (failed.length ? failed.length + ' 条失败' : results.length + ' 条全部通过'));
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close().catch(() => null);
    await H.deleteCanvas(api, canvasId).catch(() => null);
    await api.dispose().catch(() => null);
  }
})().catch((err) => { console.error(err); process.exit(1); });
