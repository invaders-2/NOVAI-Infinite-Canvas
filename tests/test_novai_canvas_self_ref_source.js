#!/usr/bin/env node
/* 「@ 本节点」重新生成不能把新生成的结果当参考图（画布助手审查 → 改提示词 → 重跑会越改越偏的根因）：
   版本上的 meta.selfSrc 记的是**生成这一版时实际发出去的**自我参考图，三态：
     string    = 当时发出去的那张源图；
     null      = 明确没发（节点当时还没有结果 / 模型不收），以后重新生成也不要补上一版结果；
     字段缺失  = 这次改动之前的旧数据，读取时维持原来的回退（不破坏老画布）。
   1) 有记录：用记录下来的源图，重跑多少次都不变；
   2) 记录为 null：不发，也不拿这一版结果补上；
   3) 用户切回没有记录的初始版本：按旧回退（上传节点退回 hist[0] / 普通节点用当前这一版）；
   4) 旧数据（没有字段）：上传的图被原地覆盖过时退回最初上传的那张，普通生成节点维持原行为；
   5) 引擎：buildRequest 把这次实际发出的自我参考源（没有就是 null）带进 GenRequest，
      写回时原样记到新版本上，不再事后从 before 推算。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const mentions = load('novai-canvas-ui/src/canvas/canvas-next/mentions.ts');
const node = (gen, kind = 'image') => ({ id: 'n1', kind, x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: '图', prompt: '把 @{n1} 的背景换掉', params: {}, order: [], ...gen } } });

// ---- 1. 没有记录（旧数据）：发当前这一版；没有结果就没有本节点参考 ----
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ url: 'orig.png' }], hi: 0 })), 'orig.png');
assert.strictEqual(mentions.selfSourceOf(node({ hist: [], hi: 0 })), undefined, '没有结果就没有本节点参考');

// ---- 2. 有记录（string）：回到当时发出去的源图 ----
const once = node({ hist: [{ url: 'orig.png' }, { url: 'bad-1.png', meta: { selfSrc: 'orig.png' } }], hi: 1 });
assert.strictEqual(mentions.selfSourceOf(once), 'orig.png', '重跑不能拿上一版带问题的结果当参考');
const twice = node({ hist: [{ url: 'orig.png' }, { url: 'bad-1.png', meta: { selfSrc: 'orig.png' } }, { url: 'bad-2.png', meta: { selfSrc: 'orig.png' } }], hi: 2 });
assert.strictEqual(mentions.selfSourceOf(twice), 'orig.png', '连续重跑仍然回到同一张源图');

// ---- 3. 记录为 null（明确没发）：不发送，也不回退到这一版自己的结果 ----
const none = node({ hist: [{ url: 'v1.png', meta: { selfSrc: null } }], hi: 0 });
assert.strictEqual(mentions.selfSourceOf(none), null, '明确没发自我参考图：返回 null，不能回退到这一版结果');
const none2 = node({ hist: [{ url: 'v1.png', meta: { selfSrc: null } }, { url: 'v2.png', meta: { selfSrc: null } }], hi: 1 });
assert.strictEqual(mentions.selfSourceOf(none2), null, '重跑后仍然明确没有自我参考图');

// ---- 4. 用户切回最初那一版（没有记录）：按旧回退发那一版 ----
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ url: 'orig.png' }, { url: 'bad-1.png', meta: { selfSrc: 'orig.png' } }], hi: 0 })), 'orig.png');
// 用户挑了一张普通生成的版本（没有记录 = 旧数据）：按用户挑的发
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ url: 'a.png' }, { url: 'b.png' }], hi: 1 })), 'b.png', '非上传节点的旧数据维持原行为');

// ---- 5. 旧数据：上传的图被原地覆盖过 ----
assert.strictEqual(mentions.selfSourceOf(node({ uploaded: true, hist: [{ url: 'upload.png' }, { url: 'bad-1.png' }, { url: 'bad-2.png' }], hi: 2 })), 'upload.png');
assert.strictEqual(mentions.selfSourceOf(node({ uploaded: true, hist: [{ url: 'upload.png' }], hi: 0 })), 'upload.png');

// ---- 6. 视频：没有地址时用封面帧；有记录一样回源 ----
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ frame: 'cover.jpg' }], hi: 0 }, 'video')), 'cover.jpg');
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ url: 'v0.mp4' }, { url: 'v1.mp4', meta: { selfSrc: 'v0.mp4' } }], hi: 1 }, 'video')), 'v0.mp4');
assert.strictEqual(mentions.selfSourceOf(node({ hist: [{ url: 'v1.mp4', meta: { selfSrc: null } }], hi: 0 }, 'video')), null, '视频明确没发也不回退');

// ---- 7. 引擎接线：按请求实际发出的源图记录，不再事后从 before 推算 ----
const engine = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
assert.ok(/const src = selfSourceOf\(node\);/.test(engine), 'buildRequest 的本节点参考必须走 selfSourceOf（新版本记录优先）');
assert.ok(/let selfSrc: string \| null = null;/.test(engine), 'buildRequest 要按「这次实际发出去的 self 源图」准备记录，没有就是 null');
assert.ok(/selfSrc, \.\.\.\(vm \?/.test(engine), 'self 源图记录要随 GenRequest 带给写回');
assert.ok(!/url: selfSourceOf\(node\) \}\)/.test(engine), '不能把可能为空的 selfSourceOf 直接拼进 inputs');
assert.ok(/applyRunResult\(store, id, req\.kind, res\.outputs, \{ draft: isDraft, selfSrc: req\.selfSrc \}\)/.test(engine), '写回要原样用请求里的 self 源图记录');
assert.ok(/selfSrc !== undefined \? \{ \.\.\.o, meta: \{ \.\.\.o\.meta, selfSrc \}/.test(engine), '写回时把请求里的记录（含 null）挂到新版本 meta.selfSrc');
assert.ok(!/selfSourceOf\(before\)/.test(engine), '写回不能再事后从 before 推算');

// ---- 8. C3（阶段三修复）：带 excludeSelfRefs 重跑时保留「最初的源图」，只剔除当前这一版结果 ----
{
    const { buildRequest } = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
    const model = { id: 'm::x', name: 'm', vendor: 'v', kind: 'image', i2i: true, maxRefs: 4 };
    const storeOf = (doc) => ({ state: { doc, canvasId: 'c1' }, modelOf: () => model });
    const target = {
        id: 'n1', kind: 'image', x: 0, y: 0, w: 200, h: 200,
        data: { gen: { title: '主图', prompt: '把 @{n1} 的背景换掉', params: {}, order: [], uploaded: true,
            hist: [{ url: '/upload.png' }, { url: '/gen-v1.png', meta: { selfSrc: '/upload.png' } }], hi: 1 } },
    };
    const doc = { nodes: [target], edges: [] };
    const flagged = buildRequest(storeOf(doc), target, undefined, { excludeSelfRefs: true });
    const urls = (flagged.inputs || []).map((x) => x.url);
    assert.ok(urls.includes('/upload.png'), 'C3：带标记重跑仍要发送最初的源图（上传图）');
    assert.ok(!urls.includes('/gen-v1.png'), 'C3：不能把当前这一版结果（hist[1]）当参考图');
    assert.strictEqual(flagged.selfSrc, '/upload.png', 'C3：这次实际发出的源图照常记到新版本 selfSrc');

    // 没有更早的源图（selfSourceOf 返回的就是当前这一版）→ 不发
    const onlyCurrent = {
        id: 'n1', kind: 'image', x: 0, y: 0, w: 200, h: 200,
        data: { gen: { title: '主图', prompt: '把 @{n1} 的背景换掉', params: {}, order: [], hist: [{ url: '/gen-only.png' }], hi: 0 } },
    };
    const flaggedOnly = buildRequest(storeOf({ nodes: [onlyCurrent], edges: [] }), onlyCurrent, undefined, { excludeSelfRefs: true });
    assert.deepStrictEqual((flaggedOnly.inputs || []).map((x) => x.url), [], 'C3：源图就是当前这一版结果时不发');
    assert.strictEqual(flaggedOnly.selfSrc, null, 'C3：没发就记 null（明确没发）');

    // 没有标记：与既有行为一致（发当前这一版，记录它）
    const plain = buildRequest(storeOf({ nodes: [onlyCurrent], edges: [] }), onlyCurrent);
    assert.deepStrictEqual((plain.inputs || []).map((x) => x.url), ['/gen-only.png'], 'C3：无标记时保持既有行为');
    assert.strictEqual(plain.selfSrc, '/gen-only.png', 'C3：无标记时照常记录');
}

console.log('test_novai_canvas_self_ref_source: ok');
