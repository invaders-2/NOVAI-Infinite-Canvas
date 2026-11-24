const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

/*
 * 面板的「协作 / 自动推进 / 托管」切换要真的传到后端：桥接层发 /api/agent/run 时带 autonomy。
 * 之前只发 auto_execute（几乎总是 true），档位在这里被丢掉，面板怎么切后端都一样。
 */

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'novai-canvas-ui/node_modules/esbuild'));

global.window = { parent: null, localStorage: { getItem: () => null, setItem: () => undefined } };

function loadBridge() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'novai-canvas-ui/src/novaiBridge.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false,
  });
  const loaded = new Module('novai-bridge-autonomy-test');
  loaded.paths = Module._nodeModulePaths(root);
  loaded._compile(result.outputFiles[0].text, 'novaiBridge.cjs');
  return loaded.exports.installNovaiBridge;
}

async function sentAutonomy(autonomy) {
  let body = null;
  global.fetch = async (url, init) => {
    assert.equal(url, '/api/agent/run');
    body = JSON.parse(init.body);
    return new Response('', { status: 200, headers: { 'X-NOVAI-Run-Id': 'run_x' } });
  };
  loadBridge()();
  const context = { canvasId: 'c1', modelConfigId: 'p::m', mode: 'run' };
  if (autonomy !== undefined) context.autonomy = autonomy;
  await global.window.novai.task.command({ type: 'task/run', payload: { goal: 'x', canvasContext: context } });
  return body.autonomy;
}

(async () => {
  assert.equal(await sentAutonomy('auto'), 'auto');
  assert.equal(await sentAutonomy('managed'), 'managed');
  assert.equal(await sentAutonomy('collab'), 'collab');
  assert.equal(await sentAutonomy(undefined), 'collab', '没选档位按协作：不能让 auto_execute 被后端当成自动推进');
  assert.equal(await sentAutonomy('weird'), 'collab');
  console.log('[PASS] test_agent_autonomy_bridge.js');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
