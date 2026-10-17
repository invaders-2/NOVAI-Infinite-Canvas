/* 智能画布连线 kind 的回归：flow 边也必须被下游当作上游输入。
   背景（用户报的 bug）：端口拖出来的线是 input，「+」新建下游 / AI 助手 connect 出来的是 flow；
   消费端只认 input 时，flow 线画得出来但下游一律识别不到。
   跑法：node tests/test_smart_canvas_input_edges.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label + ' 期望' + JSON.stringify(b) + ' 实际' + JSON.stringify(a));

function topLevelFunction(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}

const upstreamSrc = topLevelFunction(code, 'upstreamNodesForKinds');
const inputSrc = topLevelFunction(code, 'inputNodesFor');

function makeResolvers(nodes, connections, usesConnections){
    const factory = new Function(
        'canvas', 'nodes', 'canvasUsesConnections',
        upstreamSrc + '\n' + inputSrc + '\nreturn { upstreamNodesForKinds, inputNodesFor };'
    );
    return factory({ connections }, nodes, usesConnections);
}

const NODES = [
    { id: 'text1', type: 'smart-text', text: '文案' },
    { id: 'img1', type: 'smart-image' },
    { id: 'img2', type: 'smart-image' },
    { id: 'prompt1', type: 'smart-prompt' },
];

// ---- 端口拖出来的 input 边 ----
let r = makeResolvers(NODES, [{ from: 'text1', to: 'prompt1', kind: 'input' }], true);
eq(r.inputNodesFor(NODES[3]).map(n => n.id), ['text1'], 'input 边算上游');

// ---- 「+」/AI 助手落的 flow 边：修复前这里是空数组 ----
r = makeResolvers(NODES, [{ from: 'text1', to: 'prompt1', kind: 'flow' }], true);
eq(r.inputNodesFor(NODES[3]).map(n => n.id), ['text1'], 'flow 边也算上游（本次修复的核心）');

r = makeResolvers(NODES, [{ from: 'img1', to: 'img2', kind: 'flow' }], true);
eq(r.inputNodesFor(NODES[2]).map(n => n.id), ['img1'], '图像链路的 flow 边算上游参考');

// ---- 老数据里没有 kind 字段：按 flow 处理，也算上游 ----
r = makeResolvers(NODES, [{ from: 'text1', to: 'prompt1' }], true);
eq(r.inputNodesFor(NODES[3]).map(n => n.id), ['text1'], '缺 kind 的边按 flow 处理并算上游');

// ---- history 这类边不是输入，不能混进来 ----
r = makeResolvers(NODES, [{ from: 'img1', to: 'img2', kind: 'history' }], true);
eq(r.inputNodesFor(NODES[2]), [], 'history 边不算上游输入');

// ---- 无连线时为空 ----
r = makeResolvers(NODES, [], true);
eq(r.inputNodesFor(NODES[3]), [], '没有连线就没有上游');

// ---- 老画布（不走 connections，靠 node.inputNodeIds 镜像）仍然生效 ----
const legacy = NODES.map(n => n.id === 'prompt1' ? { ...n, inputNodeIds: ['text1'] } : n);
r = makeResolvers(legacy, [], false);
eq(r.inputNodesFor(legacy[3]).map(n => n.id), ['text1'], '老画布 inputNodeIds 镜像仍然算上游');

// ---- 静态断言：消费端与助手 connect 的默认 kind ----
ok(/function inputNodesFor\(node\)\{[\s\S]*?'input', 'flow'/.test(code), 'inputNodesFor 同时接受 input 与 flow');
ok(!/addConnection\(fromId, toId, a\.kind \|\| 'flow'\)/.test(code), '助手 connect 不再默认落成 flow');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){
    console.log('失败 ' + fails.length + ' 项：');
    fails.forEach(item => console.log('  - ' + item));
    process.exit(1);
}

