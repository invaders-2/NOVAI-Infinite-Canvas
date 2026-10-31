const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'openarc-canvas-ui/node_modules/esbuild'));
const result = esbuild.buildSync({
  entryPoints: [path.join(root, 'openarc-canvas-ui/src/novaiBackend.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  write: false,
});
const loaded = new Module('novai-openarc-backend-test');
loaded.paths = Module._nodeModulePaths(root);
loaded._compile(result.outputFiles[0].text, 'novaiBackend.cjs');
const { serverDocToDoc, docToServerDoc, createNovaiBackend } = loaded.exports;

const legacy = {
  nodes: [
    { id: 'prompt', type: 'prompt', x: 0, y: 0, text: '原始提示词' },
    { id: 'generator', type: 'generator', x: 360, y: 0, apiProvider: 'comfly', model: 'gpt-image-2', ratio: 'square', resolution: '1k' },
    { id: 'video', type: 'video', x: 720, y: 0, apiProvider: 'apimart', model: 'veo3-fast', aspectRatio: '16:9', duration: 8 },
    { id: 'output', type: 'output', x: 1080, y: 0, images: [{ url: '/output/test.png', kind: 'image', width: 1024, height: 1024 }] },
    { id: 'group', type: 'group', x: -40, y: -40, title: '旧分组', items: ['prompt', 'generator'] },
  ],
  connections: [{ id: 'edge', from: 'prompt', to: 'generator' }],
};
const converted = serverDocToDoc(legacy);
assert.equal(converted.migrated, true);
assert.equal(converted.doc.nodes.length, 5);
assert.deepEqual(converted.doc.nodes.map((node) => node.kind), ['text', 'image', 'video', 'image', 'group']);
assert.equal(converted.doc.nodes[0].data.gen.hist[0].text, '原始提示词');
assert.equal(converted.doc.nodes[0].data.gen.manual, true);
assert.equal(converted.doc.nodes[1].data.gen.params.model, 'comfly::gpt-image-2');
assert.equal(converted.doc.nodes[1].data.gen.params.ratio, '1:1');
assert.equal(converted.doc.nodes[2].data.gen.params.model, 'apimart::veo3-fast');
assert.equal(converted.doc.nodes[2].data.gen.params.dur, 8);
assert.equal(converted.doc.nodes[3].data.gen.hist[0].url, '/output/test.png');
assert.deepEqual(converted.doc.nodes[4].children, ['prompt', 'generator']);
assert.equal(converted.doc.nodes[1].data.legacy.type, 'generator');
assert.deepEqual(converted.doc.edges, [{ id: 'edge', from: 'prompt', to: 'generator' }]);

const roundTrip = docToServerDoc(converted.doc);
assert.equal(roundTrip.nodes[0].type, 'smart-text');
assert.equal(roundTrip.nodes[1].type, 'smart-image');
assert.equal(roundTrip.nodes[1].kind, 'image');
assert.equal(roundTrip.nodes[1].data.legacy.model, 'gpt-image-2');
assert.deepEqual(roundTrip.connections, legacy.connections);
const reread = serverDocToDoc(roundTrip);
assert.equal(reread.migrated, false);
assert.equal(reread.doc.nodes[0].data.gen.hist[0].text, '原始提示词');
assert.equal(reread.doc.nodes[3].data.gen.hist[0].url, '/output/test.png');

const entry = fs.readFileSync(path.join(root, 'static/canvas.html'), 'utf8');
assert.match(entry, /\/static\/openarc-canvas\/canvas\.js/);
assert.match(entry, /\/static\/openarc-canvas\/canvas\.css/);
assert.doesNotMatch(entry, /\/static\/js\/canvas\.js/);
assert.ok(fs.existsSync(path.join(root, 'static/legacy-canvas.html')));

const nodeViewSource = fs.readFileSync(path.join(root, 'openarc-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx'), 'utf8');
assert.match(nodeViewSource, /node\.kind !== "text" \? <div className="rz" data-rz/);
const genPanelSource = fs.readFileSync(path.join(root, 'openarc-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
assert.match(genPanelSource, /className=\{"sq chip-in"/);
const canvasNextCss = fs.readFileSync(path.join(root, 'openarc-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
assert.match(canvasNextCss, /\.gp-in \.sq\{[^}]*flex:0 0 40px;[^}]*width:40px;height:40px/);
assert.match(canvasNextCss, /\.chip-in\{[^}]*flex:0 0 40px;[^}]*width:40px;height:40px;[^}]*aspect-ratio:1/);
assert.match(canvasNextCss, /\.chip-in img,\.cn-root \.chip-in video\{[^}]*width:100%;height:100%;object-fit:cover;object-position:center/);
assert.match(canvasNextCss, /\.textdoc \.td-panel\{[^}]*resize:both;[^}]*overflow:hidden/);

async function testConflict() {
  const values = new Map();
  const localStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  global.window = { localStorage };
  const remote = { id: 'conflict', title: '远端画布', icon: '🧩', updated_at: 200, nodes: [], connections: [], viewport: {}, logs: [] };
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'PUT') {
      return { ok: false, status: 409, json: async () => ({ detail: { message: '版本冲突', canvas: remote, updated_at: 200 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ canvas: { ...remote, updated_at: 100 } }) };
  };
  const backend = createNovaiBackend();
  const result = await backend.saveDoc('conflict', converted.doc, 100);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.remoteVersion, 200);
  assert.equal(result.remote.nodes.length, 0);
  const put = calls.find((call) => call.init?.method === 'PUT');
  const payload = JSON.parse(put.init.body);
  assert.equal(payload.base_updated_at, 100);
  assert.equal(payload.nodes[1].kind, 'image');
  assert.equal(payload.nodes[1].data.legacy.type, 'generator');
}

async function testConfiguredModels() {
  global.fetch = async (url) => {
    assert.equal(url, '/api/config');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        api_providers: [
          { id: 'with-key', name: 'With Key', has_key: true, enabled: true, image_models: ['image-ok'] },
          { id: 'without-key', name: 'Without Key', has_key: false, enabled: true, image_models: ['image-hidden'] },
          { id: 'disabled', name: 'Disabled', has_key: true, enabled: false, image_models: ['image-disabled'] },
          { id: 'local', name: 'Local', has_key: false, enabled: true, image_models: ['image-local'] },
          { id: 'jimeng', name: 'Jimeng', protocol: 'jimeng', has_key: false, enabled: true, image_models: ['image-cli'] },
        ],
      }),
    };
  };
  const models = await createNovaiBackend().listModels();
  assert.deepEqual(models.map((model) => model.id), ['with-key::image-ok', 'local::image-local', 'jimeng::image-cli']);
  assert.ok(models.every((model) => !model.id.includes('image-hidden') && !model.id.includes('image-disabled')));
}

async function testAgnesOfficialModels() {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ api_providers: [{ id: 'agnes-ai', name: 'Agnes AI', has_key: true, enabled: true, image_models: ['agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-image-2.5-flash'] }] }),
  });
  const models = await createNovaiBackend().listModels();
  assert.ok(models.every((model) => model.specSource === 'spec'));
  assert.ok(models.every((model) => model.i2i && model.maxRefs === 20 && model.refNote.includes('多图参考')));
  assert.ok(models.every((model) => model.batch.length === 1 && model.batch[0] === 1));
  assert.deepEqual(models[0].ratios, ['1:1', '4:3', '3:4']);
  assert.deepEqual(models[1].sizes, ['1K', '2K', '3K', '4K']);
  assert.deepEqual(models[1].ratios, ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']);
  assert.deepEqual(models[2].ratios, models[1].ratios);
}

async function testAgentTaskBridge() {
  const bridgeResult = esbuild.buildSync({
    entryPoints: [path.join(root, 'openarc-canvas-ui/src/novaiBridge.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false,
  });
  const bridgeModule = new Module('novai-openarc-bridge-test');
  bridgeModule.paths = Module._nodeModulePaths(root);
  bridgeModule._compile(bridgeResult.outputFiles[0].text, 'novaiBridge.cjs');
  global.window = {};
  bridgeModule.exports.installNovaiBridge();
  assert.equal(typeof window.openarc.task.command, 'function');
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/agent/run') return {
      ok: true, status: 200,
      headers: { get: (name) => name.toLowerCase() === 'x-novai-run-id' ? 'run_beat_test' : null },
      body: { cancel: async () => undefined },
      json: async () => ({}),
    };
    if (url.endsWith('/snapshot')) return { ok: true, status: 200, json: async () => ({
      task: { taskId: 'run_beat_test', status: 'SUCCEEDED', modelConfigId: 'apimart::gpt-test' },
      steps: [], events: [], calls: [], artifacts: [{ content: '真实 Agent 回答' }], verifications: [],
    }) };
    if (url.endsWith('/cancel')) return { ok: true, status: 200, json: async () => ({ ok: true, taskId: 'run_beat_test', status: 'STOPPING' }) };
    throw new Error('unexpected fetch: ' + url);
  };
  const backend = createNovaiBackend();
  const submitted = await backend.runAgentTask({ goal: '检查画布', context: {
    schemaVersion: 1, canvasId: 'c1', selectedNodeIds: ['n1'], resourceRefs: [],
    completionConditions: [], modelConfigId: 'apimart::gpt-test', thinking: 'standard', mode: 'run',
  } });
  assert.deepEqual(submitted, { ok: true, taskId: 'run_beat_test', status: 'RUNNING', error: undefined });
  const runBody = JSON.parse(calls.find((call) => call.url === '/api/agent/run').init.body);
  assert.equal(runBody.canvas_id, 'c1');
  assert.equal(runBody.provider, 'apimart');
  assert.equal(runBody.model, 'gpt-test');
  assert.equal(runBody.mode, 'run');
  assert.deepEqual(runBody.focus.selected_node_ids, ['n1']);
  const snapshot = await new Promise((resolve) => {
    const off = backend.watchAgentTask('run_beat_test', (value) => { off(); resolve(value); });
  });
  assert.equal(snapshot.status, 'SUCCEEDED');
  assert.equal(snapshot.artifacts[0].content, '真实 Agent 回答');
  assert.deepEqual(await backend.cancelAgentTask('run_beat_test'), { ok: true, error: undefined });
}

testConflict().then(testConfiguredModels).then(testAgnesOfficialModels).then(testAgentTaskBridge).then(() => {
  console.log('OpenArc 画布迁移、保存冲突、模型配置筛选、Agnes 官方规格与 Agent 任务桥接回归测试通过');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
