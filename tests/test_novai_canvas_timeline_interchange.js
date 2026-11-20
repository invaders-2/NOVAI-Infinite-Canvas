#!/usr/bin/env node
'use strict';
/* 剪辑工程导出（Premiere / 达芬奇 xml、Final Cut fcpxml、OTIO）的纯逻辑
   跑法：node tests/test_novai_canvas_timeline_interchange.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', external: ['mediabunny'] });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const X = load('novai-canvas-ui/src/canvas/canvas-next/timelineInterchange.ts');
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

const base = { sourceNodeId: 's', fadeIn: 0, fadeOut: 0 };
const clips = [
    { ...base, id: 'a', url: '/v/a.mp4', mediaKind: 'video', inPoint: 0, outPoint: 4, order: 0, title: '开场' },
    { ...base, id: 'b', url: '/v/b.mp4', mediaKind: 'video', inPoint: 1, outPoint: 5, order: 1, trans: 'dissolve', transMs: 1000, title: '产品 & 细节' },
    { ...base, id: 'c', url: '/v/c.png', mediaKind: 'image', inPoint: 0, outPoint: 3, order: 2, title: '收尾图' },
    { ...base, id: 'd', url: '/v/a.mp4', mediaKind: 'video', inPoint: 2, outPoint: 6, order: 3, speed: 2, title: '快放' },
    { ...base, id: 'p', url: '/v/pip.mp4', mediaKind: 'video', inPoint: 0, outPoint: 2, order: 0, layer: 'overlay', start: 1, tf: { x: 0.8, y: 0.2, s: 0.3, o: 0.8 }, title: '画中画', volume: 0 },
    { ...base, id: 'm', url: '/v/m.mp3', mediaKind: 'audio', inPoint: 0, outPoint: 12, order: 0, volume: 0.5, duck: 0.25, title: '配乐' },
    { ...base, id: 's1', url: '', mediaKind: 'video', type: 'subtitle', text: '大家好', start: 0.5, end: 2, inPoint: 0, outPoint: 0, order: 0 },
];
const M = (id, url, file, kind, dur, w, h, hasAudio) => [url, { id, url, file, kind, dur, w, h, hasVideo: kind !== 'audio', hasAudio }];
const media = new Map([
    M('m1', '/v/a.mp4', '01-开场.mp4', 'video', 10, 1920, 1080, true),
    M('m2', '/v/b.mp4', '02-产品.mp4', 'video', 8, 1280, 720, true),
    M('m3', '/v/c.png', '03-收尾图.png', 'image', 0, 1080, 1080, false),
    M('m4', '/v/pip.mp4', '04-画中画.mp4', 'video', 6, 1080, 1920, true),
    M('m5', '/v/m.mp3', '05-配乐.mp3', 'audio', 30, 0, 0, true),
]);
const p = X.buildProject(clips, media, { name: '测试 <工程>', width: 1920, height: 1080 });

// 溶解：剪切点放在重叠区中间，两段相接，后一段入点后移
eq(p.v1.map((it) => [it.clip.id, it.start, it.dur, it.srcIn]), [['a', 0, 105, 0], ['b', 105, 105, 45], ['c', 210, 90, 0], ['d', 300, 60, 60]], 'V1 帧位');
eq(p.v1[1].trans, { kind: 'dissolve', frames: 30, h1: 15 }, '转场 30 帧，剪切点前 15 帧');
eq(p.frames, 360, '总长 12 秒');
eq(p.overlays.length, 1, '一条画中画轨');
eq([p.overlays[0][0].start, p.overlays[0][0].dur], [30, 60], '画中画位置');
eq(p.a1.map((it) => it.clip.id), ['a', 'b', 'd'], '视频原声进 A1（静音的画中画不进）');
eq(p.a2.map((it) => [it.clip.id, it.volume]), [['m', 0.5]], '配乐进 A2');
ok(p.notes.some((n) => n.includes('自动压低')), '说明里提到自动压低没导出');
eq(p.subs, [{ start: 15, end: 60, text: '大家好' }], '字幕帧位');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novai-ix-'));
const lint = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); execFileSync('xmllint', ['--noout', f]); return true; };

// Premiere / 达芬奇
const xml = X.toXmeml(p);
ok(lint('a.xml', xml), 'xmeml 是合法 XML');
ok(xml.includes('<name>测试 &lt;工程&gt;</name>'), '工程名转义');
ok(/<transitionitem>.*?<start>90<\/start><end>120<\/end><alignment>center<\/alignment>/.test(xml), '转场跨剪切点 90–120');
ok(xml.includes('<start>300</start><end>360</end><in>60</in><out>180</out>'), '2× 变速：素材用 120 帧');
ok(xml.includes('<parameterid>speed</parameterid><name>speed</name><value>200</value>'), '变速效果 200%');
ok(xml.includes('<name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>150</value>'), '1280×720 素材适配到 1080p：缩放 150%');
ok(xml.includes('<value>16.875</value>') && xml.includes('<horiz>0.3</horiz><vert>-0.3</vert>'), '竖屏画中画缩放 / 位置');
ok(xml.includes('<pathurl>media/01-%E5%BC%80%E5%9C%BA.mp4</pathurl>'), '素材相对路径 URL 编码');
eq((xml.match(/<file id="file-1">/g) || []).length, 1, '同一素材只完整定义一次');
ok(xml.includes('<parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>0.5</value>'), '音量 0.5');
ok(xml.includes('<parameterid>opacity</parameterid><name>opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>80</value>'), '不透明度 80');
eq((xml.match(/<track>/g) || []).length, 4, 'V1 V2 A1 A2 四条轨');

// Final Cut
const fcp = X.toFcpxml(p);
ok(lint('a.fcpxml', fcp), 'fcpxml 是合法 XML');
ok(fcp.includes('<transition name="Cross Dissolve" offset="90/30s" duration="30/30s">'), 'FCP 转场');
ok(/<asset-clip ref="a2"[^>]*offset="105\/30s" duration="105\/30s" start="45\/30s"/.test(fcp), 'FCP 第二段');
ok(/<clip name="收尾图" offset="210\/30s" duration="90\/30s" start="0s" format="r1" tcFormat="NDF"><video ref="a3" offset="0s"/.test(fcp), "图片包在 clip 里");
ok(fcp.includes('<timept time="60/30s" value="60/30s" interp="linear"/><timept time="120/30s" value="180/30s" interp="linear"/>'), 'FCP timeMap 2×');
ok(/<asset-clip ref="a4" lane="1"[^>]*offset="30\/30s"/.test(fcp), '画中画连接在第一段上（本地时间 30 帧）');
ok(fcp.includes('position="53.3333 30" scale="0.3 0.3" rotation="0"/><adjust-blend amount="0.8"/>'), '画中画变换');
ok(/<asset-clip ref="a5" lane="-1"[^>]*offset="0s" duration="360\/30s"[^>]*><adjust-volume amount="-6.02dB"\/>/.test(fcp), '配乐 lane -1，-6dB');
ok(fcp.includes('<media-rep kind="original-media" src="media/03-'), 'media-rep 相对路径');

// OTIO
const otio = JSON.parse(X.toOtio(p));
const v1 = otio.tracks.children[0];
eq(v1.children.map((c) => c.OTIO_SCHEMA), ['Clip.1', 'Transition.1', 'Clip.1', 'Clip.1', 'Clip.1'], 'OTIO V1 结构');
eq([v1.children[1].in_offset.value, v1.children[1].out_offset.value], [15, 15], 'OTIO 转场前后各 15 帧');
eq(v1.children.filter((c) => c.OTIO_SCHEMA === 'Clip.1').reduce((s, c) => s + c.source_range.duration.value, 0), 360, 'V1 片段总长 = 时间线');
eq(v1.children[4].effects[0].time_scalar, 2, 'OTIO 变速');
eq(otio.tracks.children[1].children.map((c) => [c.OTIO_SCHEMA, c.source_range.duration.value]), [['Gap.1', 30], ['Clip.1', 60]], '画中画轨前面补空隙');
eq(otio.tracks.children.map((t) => t.kind), ['Video', 'Video', 'Audio', 'Audio'], 'OTIO 轨道');
eq(v1.markers[0].name, '大家好', '字幕写成标记');

const rd = X.readme(p);
ok(rd.includes('Final Cut Pro') && rd.includes('重新链接'), '说明文字');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`timeline interchange: ${passed} passed`);
