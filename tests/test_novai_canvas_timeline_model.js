#!/usr/bin/env node
'use strict';
/* 剪辑时间线的纯逻辑：时间码、整块挪位、修剪、切开、转场与变速换算
   跑法：node tests/test_novai_canvas_timeline_model.js */
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
const M = load('novai-canvas-ui/src/canvas/canvas-next/timelineModel.ts');

const clip = (id, extra = {}) => ({ id, sourceNodeId: 'src', url: '/v/' + id + '.mp4', mediaKind: 'video', inPoint: 0, outPoint: 2, order: 0, ...extra });

// 时间码按 30fps 定帧
assert.strictEqual(M.fmtTC(0), '00:00:00');
assert.strictEqual(M.fmtTC(1.5), '00:01:15');
assert.strictEqual(M.fmtTC(61.2), '01:01:06');
assert.strictEqual(M.fmtTC(-3), '00:00:00', '负数夹到 0');
assert.strictEqual(M.frameSec, 1 / 30);

// 变速：时间线长度 = 使用区间 / 速度
const fast = clip('f', { inPoint: 0, outPoint: 4, speed: 2 });
assert.strictEqual(M.lenOf(fast), 2);
assert.strictEqual(M.speedOf({ speed: 99 }), 4, '变速夹到 4×');

// 整块挪位：选中 b、c 一起挪到 d 后面，相对顺序不变
const a = clip('a'); const b = clip('b'); const c = clip('c'); const d = clip('d');
const list = M.normalize([a, b, c, d].map((x) => ({ ...x })));
const placed = M.place(list, 'video');
const afterD = placed[3].end + 1;
const moved = M.moveGroupTo(list, 'b', new Set(['b', 'c']), afterD);
assert.deepStrictEqual(M.trackClips(moved, 'video').map((x) => x.id), ['a', 'd', 'b', 'c'], '整块挪到末尾');
const backFront = M.moveGroupTo(moved, 'b', new Set(['b', 'c']), -1);
assert.deepStrictEqual(M.trackClips(backFront, 'video').map((x) => x.id), ['b', 'c', 'a', 'd'], '整块挪到开头');

// 字幕轨不走整块挪位（有自己的 start / end）
const subs = M.normalize([{ id: 's1', sourceNodeId: '', url: '', mediaKind: 'video', type: 'subtitle', inPoint: 0, outPoint: 2, order: 0, start: 1, end: 3 }]);
assert.deepStrictEqual(M.moveGroupTo(subs, 's1', new Set(['s1']), 9), subs, '字幕原样返回');

// 修剪：不能越过素材长度，也不能短于 MIN_LEN
const src = clip('s', { inPoint: 1, outPoint: 3, srcDur: 3 });
assert.strictEqual(M.trimEdge(src, 'r', 99).outPoint, 3, '出点不超过源时长');
assert.strictEqual(M.trimEdge(src, 'r', -99).outPoint, src.inPoint + M.MIN_LEN, '至少留 0.1s');
const img = clip('i', { mediaKind: 'image', inPoint: 0, outPoint: 3 });
assert.strictEqual(M.trimEdge(img, 'r', 2).outPoint, 5, '图片只改显示时长');
assert.strictEqual(M.trimEdge(img, 'r', -99).outPoint, M.MIN_LEN);

// 切开：画面轨按源时间切，右半段默认无转场
const two = M.normalize([clip('x', { inPoint: 0, outPoint: 4 })]);
const cut = M.splitAt(two, 1.5, 'x', (c) => c.id + '_b');
assert.strictEqual(cut.clips.length, 2);
const [l, r] = M.trackClips(cut.clips, 'video');
assert.strictEqual(l.outPoint, 1.5); assert.strictEqual(r.inPoint, 1.5);
assert.strictEqual(r.trans, 'none');

// 转场：交叉溶解要上一段；没有上一段退化成黑场淡入，且不超过两段的一半
const d1 = clip('d1', { outPoint: 2 }); const d2 = clip('d2', { outPoint: 2, trans: 'dissolve', transMs: 5000 });
assert.strictEqual(M.transOf(d1, undefined).kind, 'none', '没设转场的片段就是 none');
assert.strictEqual(M.transOf(d2, undefined).kind, 'fade', '交叉溶解没有上一段时退化成黑场淡入');
assert.strictEqual(M.transOf({ ...d2, trans: 'fade' }, undefined).kind, 'fade');
assert.strictEqual(M.transOf(d2, d1).kind, 'dissolve');
assert.ok(M.transOf(d2, d1).sec <= 1, '转场不超过两段的一半');

// 渲染计划：毫秒整数 + 变速后的源出点
const plan = M.renderPlan([clip('p', { inPoint: 0, outPoint: 4, speed: 2, volume: 0.5 })]);
assert.strictEqual(plan.clips[0].durationMs, 2000);
assert.strictEqual(plan.clips[0].sourceOutMs, 4000);
assert.strictEqual(plan.clips[0].volume, 0.5);
assert.strictEqual(plan.durationMs, 2000);

// 帧尺寸：短边对齐清晰度档，宽高都是偶数（编码器要求）
const size = M.frameSize('9:16', '1080p');
assert.strictEqual(size.width, 1080); assert.strictEqual(size.height, 1920);
assert.ok(M.frameSize('21:9', '720p').width % 2 === 0);

// 自动清晰度：取最短边最大的那条素材定档，混进 720p 不会被拉低；一条可用尺寸都没有时默认 1080p
assert.strictEqual(M.autoRes([{ w: 1920, h: 1080 }, { w: 1280, h: 720 }]), '1080p', '1080p + 720p 跟 1080p');
assert.strictEqual(M.autoRes([{ w: 1280, h: 720 }, { w: 960, h: 720 }]), '720p', '全 720p 还是 720p');
assert.strictEqual(M.autoRes([]), '1080p', '空数组默认 1080p');
assert.strictEqual(M.autoRes([{ w: 0, h: 0 }, { w: NaN, h: 1080 }, { w: 1920, h: 0 }]), '1080p', '非法 / 0 值忽略');
assert.strictEqual(M.autoRes([{ w: 3840, h: 2160 }]), '4K', '2160p 走 4K');
assert.strictEqual(M.autoRes([{ w: 2560, h: 1440 }]), '2K', '1440p 走 2K');

// 画中画轨：自由摆放，长度按使用区间 / 速度；不影响主轨排位
const main1 = clip('m1', { inPoint: 0, outPoint: 4 });
const ov = clip('o1', { layer: 'overlay', start: 1.5, inPoint: 1, outPoint: 3 });
assert.strictEqual(M.trackOf(ov), 'overlay');
const ovp = M.place([main1, ov], 'overlay')[0];
assert.strictEqual(ovp.start, 1.5); assert.strictEqual(ovp.end, 3.5);
assert.strictEqual(M.place([main1, ov], 'video')[0].end, 4, '画中画不挤主轨');
assert.strictEqual(M.totalOf([main1, clip('o2', { layer: 'overlay', start: 5, outPoint: 2 })]), 7, '总长包含画中画');
assert.ok(M.needsCompositor([main1, ov]) && !M.needsCompositor([main1]), '用到画中画就走逐帧合成');
// 画中画左边修剪：入点和开始一起挪，结束不动
const ovl = M.trimEdge(ov, 'l', 0.5);
assert.strictEqual(ovl.inPoint, 1.5); assert.strictEqual(ovl.start, 2);
// 关键帧：两帧之间缓入缓出，帧外取端点值
const kc = clip('k', { outPoint: 4, kf: [{ t: 0, s: 0.5 }, { t: 2, s: 1 }] });
assert.strictEqual(M.tfAt(kc, 0).s, 0.5); assert.strictEqual(M.tfAt(kc, 3).s, 1);
assert.ok(Math.abs(M.tfAt(kc, 1).s - 0.75) < 1e-9, '正中间是一半（缓入缓出对称）');
assert.strictEqual(M.tfAt(kc, 1).x, 0.5, '没打关键帧的属性取默认');
const kc2 = M.upsertKey(kc, 1, { x: 0.2 });
assert.strictEqual(kc2.kf.length, 3); assert.strictEqual(M.keyAt(kc2, 1).x, 0.2);
// 切开带关键帧的片段：后半段的关键帧时间改成相对新片段
const sp = M.splitAt([kc], 1.5, 'k', () => 'k2').clips;
assert.strictEqual(sp.find((c) => c.id === 'k2').kf[0].t, 0.5);

// 专业修剪：滚动 / 滑移 / 滑动
const ra = clip('ra', { inPoint: 2, outPoint: 6, srcDur: 12, order: 0 }), rb = clip('rb', { inPoint: 2, outPoint: 6, srcDur: 10, order: 1 }), rc = clip('rc', { inPoint: 2, outPoint: 6, srcDur: 9, order: 2 });
const rolled = M.rollEdit([ra, rb, rc], 'ra', 1);
assert.strictEqual(rolled[0].outPoint, 7); assert.strictEqual(rolled[1].inPoint, 3);
assert.strictEqual(M.totalOf(rolled), M.totalOf([ra, rb, rc]), '滚动编辑总时长不变');
assert.strictEqual(M.rollEdit([ra, rb], 'ra', -99)[1].inPoint, 0, '右段入点不早于 0');
const slipped = M.slipEdit(rb, -1);
assert.strictEqual(slipped.inPoint, 3); assert.strictEqual(slipped.outPoint, 7); assert.strictEqual(M.lenOf(slipped), M.lenOf(rb), '滑移长度不变');
assert.strictEqual(M.slipEdit(rb, -99).outPoint, 10, '滑移不超过素材结尾');
const slid = M.slideEdit([ra, rb, rc], 'rb', 0.5);
assert.strictEqual(slid[0].outPoint, 6.5); assert.strictEqual(slid[1].inPoint, 2); assert.strictEqual(slid[2].inPoint, 2.5);
// 新转场 / 调色 / 自动压低 → 走逐帧合成
assert.ok(M.needsCompositor([clip('w', { trans: 'wipe' })]) && !M.needsCompositor([clip('d', { trans: 'dissolve' })]));
assert.strictEqual(M.colorFilter(clip('n')), ''); assert.ok(M.colorFilter(clip('g', { color: { s: 0 } })).includes('saturate(0%)'));
assert.strictEqual(M.place([clip('x1', { outPoint: 2 }), clip('x2', { outPoint: 2, order: 1, trans: 'slide', transMs: 500 })], 'video')[1].start, 1.5, '推入转场和溶解一样重叠进场');
const spans = [[2, 4]];
assert.strictEqual(M.duckGain(spans, 3, 0.25), 0.25); assert.strictEqual(M.duckGain(spans, 6, 0.25), 1);
assert.ok(Math.abs(M.duckGain(spans, 4.15, 0.25) - 0.625) < 1e-9, '离有声段 0.15 秒时压低到一半');
assert.ok(M.needsCompositor([clip('bgm', { mediaKind: 'audio', duck: 0.25 })]));

console.log('PASS  时间码 / 变速 / 整块挪位 / 修剪 / 切开 / 转场 / 渲染计划 / 画中画 / 关键帧 / 滚动滑移滑动 / 调色压低（' + 60 + ' 条断言）');
