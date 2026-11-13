#!/usr/bin/env node
'use strict';
/*
 * 分组框缩放（task-18）：
 *   minGroupSize —— 普通分组最小尺寸 = 递归成员包围盒 + GROUP_PAD（frameOf 口径）；堆叠/非分组不参与；
 *   growGroupFrames —— 只把过小的组框扩到内容，不缩大框、不改 x/y；
 *   growOwnerFrames —— 成员变大后把所属组（含嵌套父组）扩到包住它，只扩不缩；
 *   Viewport / CSS 接线 —— 分组 resize 用成员最小尺寸、pointerup 扩父组、选中时归一、手柄层级。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputText ? result.outputText : result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const gf = load('novai-canvas-ui/src/canvas/canvas-next/groupFit.ts');
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

const node = (id, x, y, w, h, kind = 'image') => ({ id, kind, x, y, w, h, text: '' });
const group = (id, children, x, y, w, h, extra = {}) => ({ id, kind: 'group', x, y, w, h, text: extra.text || '分组', children, ...(extra.data ? { data: extra.data } : {}) });
const stack = (id, children, x, y, w, h) => group(id, children, x, y, w, h, { text: '堆叠', data: { stack: true } });

(async () => {
    /* ---------- [1] minGroupSize：成员包围盒 + GROUP_PAD ---------- */
    console.log('[1] minGroupSize');
    {
        const a = node('a', 100, 150, 200, 200);
        const b = node('b', 400, 300, 300, 100);
        const g = group('g', ['a', 'b'], 0, 0, 100, 100);
        const doc = { nodes: [a, b, g], edges: [] };
        eq(gf.minGroupSize(doc, 'g'), { w: gf.frameOf([a, b]).w, h: gf.frameOf([a, b]).h }, '最小尺寸 = frameOf(成员)（含 GROUP_PAD / 标题 24）');
        ok(gf.minGroupSize(doc, 'g').w > 0 && gf.minGroupSize(doc, 'g').h > 0, '最小尺寸不是 0');

        // 递归：内层分组里的成员也要算
        const c = node('c', 900, 700, 120, 90);
        const inner = group('inner', ['c'], 850, 650, 300, 300);
        const outer = group('outer', ['g', 'inner'], 0, 0, 2000, 2000);
        const nestedDoc = { nodes: [a, b, g, c, inner, outer], edges: [] };
        eq(gf.minGroupSize(nestedDoc, 'outer'), { w: gf.frameOf([a, b, g, c, inner]).w, h: gf.frameOf([a, b, g, c, inner]).h }, '嵌套成员递归参与 minGroupSize');
        eq(gf.minGroupSize(nestedDoc, 'inner'), { w: gf.frameOf([c]).w, h: gf.frameOf([c]).h }, '内层组按自己的成员算');

        // 堆叠 / 非分组不参与
        const s = stack('s', ['a', 'b'], 0, 0, 20, 20);
        const doc2 = { nodes: [a, b, s, group('g2', ['a'], 0, 0, 10, 10)], edges: [] };
        eq(gf.minGroupSize(doc2, 's'), { w: 0, h: 0 }, '堆叠没有最小尺寸约束');
        eq(gf.minGroupSize(doc2, 'a'), { w: 0, h: 0 }, '非分组返回 0');
        eq(gf.minGroupSize(doc2, 'g2').w, gf.frameOf([a]).w, '普通分组照常');
    }

    /* ---------- [2] growGroupFrames：只扩不缩、x/y 不变 ---------- */
    console.log('[2] growGroupFrames');
    {
        const a = node('a', 100, 150, 200, 200);
        const b = node('b', 400, 300, 300, 100);
        const small = group('g', ['a', 'b'], 30, 40, 100, 100);
        const doc = { nodes: [a, b, small], edges: [] };
        const min = gf.minGroupSize(doc, 'g');
        const next = gf.growGroupFrames(doc, ['g']);
        const g2 = next.nodes.find((n) => n.id === 'g');
        eq([g2.x, g2.y], [30, 40], '扩框不改 x/y');
        eq([g2.w, g2.h], [Math.max(100, Math.round(min.w)), Math.max(100, Math.round(min.h))], '扩到成员包围盒（不小于原图）');
        ok(next !== doc && doc.nodes.find((n) => n.id === 'g').w === 100, '不改原文档');

        const big = group('big', ['a', 'b'], 0, 0, 4000, 4000);
        const doc2 = { nodes: [a, b, big], edges: [] };
        ok(gf.growGroupFrames(doc2, ['big']) === doc2, '已经比内容大的框不缩');

        const s = stack('s', ['a', 'b'], 0, 0, 10, 10);
        const doc3 = { nodes: [a, b, s], edges: [] };
        ok(gf.growGroupFrames(doc3, ['s']) === doc3, '堆叠不参与扩框');
    }

    /* ---------- [3] growOwnerFrames：成员变大后扩所属组 ---------- */
    console.log('[3] growOwnerFrames');
    {
        const leaf = node('leaf', 200, 200, 500, 300);
        const owner = group('owner', ['leaf'], 0, 0, 100, 100);
        const other = group('other', ['x'], 2000, 2000, 100, 100);
        const x = node('x', 0, 0, 50, 50);
        const doc = { nodes: [leaf, owner, other, x], edges: [] };
        const next = gf.growOwnerFrames(doc, ['leaf']);
        const o2 = next.nodes.find((n) => n.id === 'owner');
        eq([o2.x, o2.y], [0, 0], '扩父组不改 x/y');
        eq([o2.w, o2.h], [Math.round(gf.frameOf([leaf]).w), Math.round(gf.frameOf([leaf]).h)], '父组扩到包住成员');
        ok(next.nodes.find((n) => n.id === 'other').w === 100, '没关系的组不动');
        eq(next.nodes.find((n) => n.id === 'leaf'), leaf, '成员本身不改');

        // 嵌套：内层先扩，外层再跟着扩
        const leaf2 = node('leaf2', 600, 600, 300, 200);
        const inner2 = group('inner2', ['leaf2'], 500, 500, 100, 100);
        const outer2 = group('outer2', ['inner2'], 0, 0, 600, 600);
        const doc2 = { nodes: [leaf2, inner2, outer2], edges: [] };
        const next2 = gf.growOwnerFrames(doc2, ['leaf2']);
        const i3 = next2.nodes.find((n) => n.id === 'inner2');
        const o3 = next2.nodes.find((n) => n.id === 'outer2');
        ok(i3.w >= Math.round(gf.frameOf([leaf2]).w) && i3.h >= Math.round(gf.frameOf([leaf2]).h), '内层组扩到包住成员');
        ok(o3.w >= gf.minGroupSize(next2, 'outer2').w && o3.h >= gf.minGroupSize(next2, 'outer2').h, '外层组跟着扩到包住内层组');
        eq([o3.x, o3.y], [0, 0], '外层 x/y 不变');

        // 堆叠里的成员不算普通分组的 owner
        const st = stack('st', ['leaf3'], 0, 0, 10, 10);
        const leaf3 = node('leaf3', 300, 300, 400, 300);
        const doc3 = { nodes: [st, leaf3], edges: [] };
        ok(gf.growOwnerFrames(doc3, ['leaf3']) === doc3, '堆叠不做 group 扩框');
        // 已经在框内的成员：不变
        const inside = node('inside', 10, 10, 20, 20);
        const holder = group('holder', ['inside'], 0, 0, 500, 500);
        const doc4 = { nodes: [inside, holder], edges: [] };
        ok(gf.growOwnerFrames(doc4, ['inside']) === doc4, '成员在框内时不改文档');
    }

    /* ---------- [4] Viewport / CSS 接线 ---------- */
    console.log('[4] 接线');
    {
        const vp = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Viewport.tsx'), 'utf8');
        ok(vp.includes('minGroupSize(store.state.doc, n.id)'), '分组 resize 起点按成员包围盒算最小尺寸');
        ok(vp.includes('Math.max(120, Math.round(content.w))') && vp.includes('Math.max(80, Math.round(content.h))'), '分组最小宽高 = max(基础 120×80, 内容尺寸)');
        ok(vp.includes('const minW = d.minW, minH = d.minH'), '拖动中沿用该最小尺寸（拖到更小停在最小）');
        ok(vp.includes('growOwnerFrames(store.state.doc, [d.id])'), 'resize pointerup 扩所属组');
        ok(vp.includes('growGroupFrames(store.state.doc, ids)'), '选中普通分组时归一过小的框');
        ok(vp.includes('n.kind === "group" && !isStack(n)'), '只对普通分组（非堆叠）');
        const gfSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/groupFit.ts'), 'utf8');
        ['export function minGroupSize', 'export function growGroupFrames', 'export function growOwnerFrames', 'memberIdsDeep'].forEach((needle) => ok(gfSrc.includes(needle), 'groupFit 含 ' + needle));
        const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
        ok(css.includes('.gnode.sel .rz{z-index:31}'), '分组选中时 resize 手柄抬到成员之上（普通节点不改）');
    }

    console.log('[PASS] 分组缩放：最小尺寸按成员 / 只扩不缩 / 成员变大扩父组 / 手柄层级（4 组）');
})().catch((err) => { console.error(err); process.exit(1); });
