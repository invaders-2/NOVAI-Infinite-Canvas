'use strict';
/**
 * T54 画布文档归一化上限（sanitizeDoc）：超大画布不再被 500 节点砍断，但仍有有限防御。
 */
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'novai-canvas-ui/node_modules/esbuild'));

function loadTs(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        tsconfig: path.join(root, 'novai-canvas-ui/tsconfig.json'),
    });
    const loaded = new Module('novai-react-canvas-store');
    loaded.paths = Module._nodeModulePaths(root);
    loaded._compile(result.outputFiles[0].text, 'reactCanvasStore.cjs');
    return loaded.exports;
}

const { sanitizeDoc } = loadTs('novai-canvas-ui/src/canvas/react-canvas/reactCanvasStore.ts');

function node(index, extra = {}) {
    return { id: 'n' + index, kind: 'text', x: index, y: index, w: 320, h: 160, text: 'text ' + index, ...extra };
}

// 1200 节点的大画布完整保留（T54 前会被砍到 500）
const big = sanitizeDoc({ nodes: Array.from({ length: 1200 }, (_, i) => node(i)), edges: [] });
assert.equal(big.nodes.length, 1200);

// 仍是有限值：6000 节点收在 5000
const huge = sanitizeDoc({ nodes: Array.from({ length: 6000 }, (_, i) => node(i)), edges: [] });
assert.equal(huge.nodes.length, 5000);

// 长文本：1 万字不截断；25 万字收在 20 万
const longText = 'A'.repeat(10000);
const keptText = sanitizeDoc({ nodes: [node(0, { text: longText })], edges: [] }).nodes[0].text;
assert.equal(keptText.length, 10000);
const cappedText = sanitizeDoc({ nodes: [node(0, { text: 'A'.repeat(250000) })], edges: [] }).nodes[0].text;
assert.equal(cappedText.length, 200000);

// URL：7000 字符保留；9000 字符收在 8000
const url7k = '/assets/uploads/' + 'u'.repeat(7000);
const keptUrl = sanitizeDoc({ nodes: [node(0, { url: url7k })], edges: [] }).nodes[0].url;
assert.equal(String(keptUrl).length, url7k.length);
const url9k = '/assets/uploads/' + 'u'.repeat(9000);
const cappedUrl = sanitizeDoc({ nodes: [node(0, { url: url9k })], edges: [] }).nodes[0].url;
assert.equal(String(cappedUrl).length, 8000);

// 边：1500 条保留；9000 条收在 8000
const nodesForEdges = Array.from({ length: 1600 }, (_, i) => node(i));
const edge = (i) => ({ id: 'e' + i, from: 'n0', to: 'n1' });
const keptEdges = sanitizeDoc({ nodes: nodesForEdges, edges: Array.from({ length: 1500 }, (_, i) => edge(i)) }).edges;
assert.equal(keptEdges.length, 1500);
const cappedEdges = sanitizeDoc({ nodes: Array.from({ length: 5000 }, (_, i) => node(i)), edges: Array.from({ length: 9000 }, (_, i) => edge(i)) }).edges;
assert.equal(cappedEdges.length, 8000);

// 小画布不回归
const small = sanitizeDoc({ nodes: [node(0, { text: '小画布提示词' })], edges: [] });
assert.equal(small.nodes.length, 1);
assert.equal(small.nodes[0].text, '小画布提示词');

console.log('[canvas-doc-limits] 大画布归一化上限用例通过');
