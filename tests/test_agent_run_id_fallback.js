const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

/*
 * 「Agent 运行没有返回任务 ID」回归测试。
 *
 * 后端正常路径把 run_id 放进响应头 X-NOVAI-Run-Id；但头可能读不到（跨源没 expose、代理/安全软件删头、
 * 升级后没重启的旧后端）。旧实现直接抛错并 cancel 掉流，用户只看到一句「没有返回任务 ID」。
 * 现在要求：头缺失时从 SSE 首帧 run_start 里取；都拿不到再给可操作报错，且不能挂住。
 */

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'novai-canvas-ui/node_modules/esbuild'));

global.window = { parent: null, localStorage: { getItem: () => null, setItem: () => undefined } };

function loadBridge() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'novai-canvas-ui/src/novaiBridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
  });
  const loaded = new Module('novai-bridge-test');
  loaded.paths = Module._nodeModulePaths(root);
  loaded._compile(result.outputFiles[0].text, 'novaiBridge.cjs');
  return loaded.exports.installNovaiBridge;
}

function sseBody(frames, track = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!track.keepOpen) controller.close();
    },
    cancel() {
      track.cancelled = true;
    },
  });
}

async function runTask(response, track) {
  global.fetch = async (url) => {
    assert.equal(url, '/api/agent/run');
    return response;
  };
  const install = loadBridge();
  install();
  return global.window.novai.task.command({
    type: 'task/run',
    payload: { goal: '画一只猫', canvasContext: { canvasId: 'canvas-1', modelConfigId: 'fake::chat-model' } },
  });
}

async function testHeaderOnly() {
  // 只有响应头（流里故意放一个不同的 run_id，证明头优先）
  const track = {};
  const response = new Response(sseBody(['id: 1\nevent: run_start\ndata: {"run_id":"run_from_stream"}\n\n'], track), {
    status: 200,
    headers: { 'X-NOVAI-Run-Id': 'run_from_header' },
  });
  const out = await runTask(response, track);
  assert.equal(out.ok, true);
  assert.equal(out.taskId, 'run_from_header');
  assert.equal(out.status, 'RUNNING');
  assert.equal(track.cancelled, true, '拿得到头时不应等正文：流必须立刻 cancel');
}

async function testRunStartOnly() {
  // 只有 run_start 事件（模拟头被删 / 跨源不可读）：仍要拿到 run_id
  const track = {};
  const response = new Response(sseBody([
    ': ping\n\n',
    'id: 1\nevent: run_start\ndata: {"run_id":"run_stream_2","model":"chat-model"}\n\n',
    'id: 2\nevent: message\ndata: {"text":"hi"}\n\n',
  ], track), { status: 200 });
  const out = await runTask(response, track);
  assert.equal(out.ok, true);
  assert.equal(out.taskId, 'run_stream_2');
  assert.equal(track.cancelled, true, '取到 run_id 后必须立刻 cancel，不能把整条流读完');
}

async function testNoRunId() {
  // 既没有头、也没有 run_start：报错要带 HTTP 状态、Content-Type 与「重启/更新」指引
  const response = new Response(sseBody(['id: 1\nevent: message\ndata: {"text":"hi"}\n\n']), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const out = await runTask(response);
  assert.equal(out.ok, false);
  assert.match(out.error, /HTTP 200/);
  assert.match(out.error, /Content-Type: text\/html/);
  assert.match(out.error, /重启应用/);
  assert.match(out.error, /更新到最新版本/);
  assert.doesNotMatch(out.error, /<html|hi/, '不要把响应体内容拼进错误信息');
}

async function testTimeout() {
  // 服务端一直不出 run_start：必须在超时后失败，不能挂住
  const track = { keepOpen: true };
  const response = new Response(sseBody([], track), { status: 200 });
  const startedAt = Date.now();
  const out = await runTask(response, track);
  const elapsed = Date.now() - startedAt;
  assert.equal(out.ok, false);
  assert.match(out.error, /重启应用/);
  assert.ok(elapsed >= 1500, '应等首帧一小会儿再放弃，实际 ' + elapsed + 'ms');
  assert.ok(elapsed < 5000, '超时必须生效，实际 ' + elapsed + 'ms');
  assert.equal(track.cancelled, true, '超时后也要把流收掉');
}

function testCorsExposeHeaders() {
  const mainPy = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
  assert.match(mainPy, /CORSMiddleware,[\s\S]{0,400}expose_headers=/, '跨源时自定义响应头必须 expose，否则前端读不到 X-NOVAI-Run-Id');
}

(async () => {
  await testHeaderOnly();
  await testRunStartOnly();
  await testNoRunId();
  await testTimeout();
  testCorsExposeHeaders();
  console.log('[PASS] test_agent_run_id_fallback.js');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
