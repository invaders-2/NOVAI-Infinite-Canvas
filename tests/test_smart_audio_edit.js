#!/usr/bin/env node
/* 画布「音频截取 / 变速」回归：
   1) 音频节点工具条 = 截取 / 变速 / 下载（下载前有分隔），文案走 i18n；
   2) 截取：默认选区 / 0.5s 最短夹取 / 选区比例 / 选区读数是纯函数，波形上有遮罩+白框+把手；
   3) 变速：0.1–4.0 夹取、两位小数、档位吸附（拖动 0.15 / 松手 0.35）、1x 直通；
   4) 16bit WAV 头字节（RIFF/WAVE/fmt/data、采样率、位深、声道数）与声道交织；
   5) 派生节点命名 {原名}_截取 / {原名}_1.5x，位置/连线/来源信息照现有派生节点那套；
   6) 面板/交互契约：节点下方浮层、Esc/× 关闭、pointer 事件（移动端可点）、忙碌态。
   跑法：node tests/test_smart_audio_edit.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if(cond) { pass += 1; } else { fails.push(msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), (msg || '') + '（实际 ' + JSON.stringify(a) + '）');

function read(rel){ return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
function extractConst(src, name){
    const start = src.indexOf('const ' + name + ' = ');
    if(start < 0) throw new Error('未找到常量 ' + name);
    const end = src.indexOf('\n', start);
    return src.slice(start, end);
}

const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');
const icons = read('static/vendor/js/lucide-subset.js');

console.log('[1] 工具条：截取 | 变速 | 下载（下载前有分隔），文案全走 i18n');
const toolbarFn = extractFn(js, 'smartNodeToolbarHtml');
const audioBranch = toolbarFn.slice(toolbarFn.indexOf("if(kind === 'audio')"), toolbarFn.indexOf("if(kind === 'video')"));
ok(audioBranch.length > 0, '有音频分支');
const trimAt = audioBranch.indexOf("plainButton('trim'");
const speedAt = audioBranch.indexOf("plainButton('speed'");
const sepAt = audioBranch.indexOf('{sep}');
const downloadAt = audioBranch.indexOf("plainButton('download'");
ok(trimAt > 0 && speedAt > trimAt, '顺序：截取 → 变速');
ok(sepAt > speedAt && downloadAt > sepAt, '下载前有 sep 分隔线');
ok(!audioBranch.includes("plainButton('download', 'download', '下载'"), '下载文案不再硬编码中文（走 trd）');
ok(/plainButton\('trim', 'scissors', trd\('smart\.audioTrim', '截取'\)/.test(audioBranch), '截取用 scissors 图标 + i18n');
ok(/plainButton\('speed', 'timer', trd\('smart\.audioSpeed', '变速'\)/.test(audioBranch), '变速用已有的 timer 图标（lucide 子集没有 gauge）+ i18n');
ok(/plainButton\('download', 'download', trd\('smart\.audioDownload', '下载'\)/.test(audioBranch), '下载文案走 i18n');
ok(/smart-audio-toolbar/.test(audioBranch), '音频工具条样式类保持不变');
ok(/trd\('smart\.audioTrimTip'/.test(audioBranch) && /trd\('smart\.audioSpeedTip'/.test(audioBranch) && /trd\('smart\.audioDownloadTip'/.test(audioBranch),
    '三个按钮的 title 都走 i18n');
for(const icon of ['scissors', 'timer', 'download', 'x', 'loader-circle', 'chevron-up', 'chevron-down', 'check']){
    ok(icons.indexOf(icon + '.mjs:') >= 0, 'lucide 子集里已有图标 ' + icon + '（不引入新图标库）');
}

console.log('[2] 截取：选区默认值 / 最短 0.5s 夹取 / 比例 / 读数（vm 跑真实实现）');
const trimSandbox = [
    extractConst(js, 'SMART_AUDIO_EDIT_MIN_SEC'),
    extractConst(js, 'SMART_AUDIO_EDIT_MAX_BYTES'),
    'let smartAudioTrim = null;',
    'let smartAudioTrimForNode = null;',
    extractFn(js, 'formatAudioClock'),
    extractFn(js, 'smartAudioEditClamp'),
    extractFn(js, 'smartAudioTrimDefaultRange'),
    extractFn(js, 'smartAudioTrimClampRange'),
    extractFn(js, 'smartAudioTrimPercent'),
    extractFn(js, 'smartAudioTrimRangeLabel'),
    extractFn(js, 'smartAudioItemDurationSec'),
    extractFn(js, 'smartAudioTrimFor'),
    'globalThis.__t = {',
    '    min(){ return SMART_AUDIO_EDIT_MIN_SEC; },',
    '    maxBytes(){ return SMART_AUDIO_EDIT_MAX_BYTES; },',
    '    def(d){ return smartAudioTrimDefaultRange(d); },',
    '    clamp(a, b, d){ return smartAudioTrimClampRange(a, b, d); },',
    '    pct(s, d){ return smartAudioTrimPercent(s, d); },',
    '    set(v){ smartAudioTrim = v; },',
    '    rangeLabel(){ return smartAudioTrimRangeLabel(); },',
    '    itemDuration(item){ return smartAudioItemDurationSec(item); },',
    '    trimFor(node){ return smartAudioTrimFor(node); }',
    '};'
].join('\n');
const trimOut = {};
vm.runInNewContext(trimSandbox, trimOut, {filename:'static/js/smart-canvas.js'});
const t = trimOut.__t;
eq(t.min(), 0.5, '最短选区 0.5s');
eq(t.maxBytes(), 50 * 1024 * 1024, '音频上限 50MB');
eq(t.def(12), {start:0, end:4}, '12s 音频默认 0–4s（时长/3）');
eq(t.def(1), {start:0, end:0.5}, '1s 音频默认 0–0.5s（最短 0.5s）');
eq(t.def(0.3), {start:0, end:0.3}, '比 0.5s 还短的音频默认整段');
eq(t.def(0), {start:0, end:0}, '时长为 0 时选区为 0');
eq(t.def(NaN), {start:0, end:0}, '非法时长选区为 0');
eq(t.clamp(0, 0.2, 12), {start:0, end:0.5}, '拖到比 0.5s 更短时夹到 0.5s');
eq(t.clamp(-3, 2, 12), {start:0, end:2}, '起点越界夹到 0');
eq(t.clamp(10, 20, 12), {start:10, end:12}, '终点越界夹到总时长');
eq(t.clamp(11.8, 12, 12), {start:11.5, end:12}, '末尾短于 0.5s 时向前补足');
eq(t.clamp(5, 3, 12), {start:3, end:5}, '起止反向自动交换');
eq(t.clamp(0, 1, 0.3), {start:0, end:0.3}, '整段不足 0.5s 时选区就是整段');
eq(t.pct(3, 12), 25, '3s/12s = 25%');
eq(t.pct(-1, 12), 0, '比例下限 0');
eq(t.pct(99, 12), 100, '比例上限 100');
eq(t.pct(1, 0), 0, '总时长为 0 时比例 0');
t.set({nodeId:'n1', start:12, end:26, duration:30});
eq(t.rangeLabel(), '00:12 - 00:26', '浮层里的选区读数 = mm:ss - mm:ss');
eq(t.trimFor({id:'n1'}).nodeId, 'n1', 'trimFor 认当前节点');
eq(t.trimFor({id:'n2'}), null, 'trimFor 不认别的节点');
eq(t.itemDuration({durationSec:2.3}), 2.3, 'durationSec 直接读');
eq(t.itemDuration({duration:'2.50'}), 2.5, '兼容 duration 字段');
eq(t.itemDuration({}), 0, '没有时长字段时 0');

console.log('[3] 变速：范围夹取 / 两位小数 / 档位吸附 / 1x 直通');
const speedSandbox = [
    extractConst(js, 'SMART_AUDIO_SPEED_MIN'),
    extractConst(js, 'SMART_AUDIO_SPEED_MAX'),
    extractConst(js, 'SMART_AUDIO_SPEED_STEPS'),
    extractConst(js, 'SMART_AUDIO_SPEED_SNAP_MOVE'),
    extractConst(js, 'SMART_AUDIO_SPEED_SNAP_END'),
    extractFn(js, 'smartAudioEditClamp'),
    extractFn(js, 'smartAudioSpeedClamp'),
    extractFn(js, 'smartAudioSnapSpeed'),
    extractFn(js, 'smartAudioSpeedLabel'),
    extractFn(js, 'smartAudioSpeedText'),
    extractFn(js, 'smartAudioSpeedFromText'),
    extractFn(js, 'smartAudioSpeedIsUnity'),
    extractFn(js, 'smartAudioSpeedRefPercent'),
    'globalThis.__s = {',
    '    min(){ return SMART_AUDIO_SPEED_MIN; },',
    '    max(){ return SMART_AUDIO_SPEED_MAX; },',
    '    steps(){ return SMART_AUDIO_SPEED_STEPS.slice(); },',
    '    move(){ return SMART_AUDIO_SPEED_SNAP_MOVE; },',
    '    end(){ return SMART_AUDIO_SPEED_SNAP_END; },',
    '    clamp(v){ return smartAudioSpeedClamp(v); },',
    '    snap(v, tol){ return smartAudioSnapSpeed(v, tol); },',
    '    label(v){ return smartAudioSpeedLabel(v); },',
    '    text(v){ return smartAudioSpeedText(v); },',
    '    fromText(v){ return smartAudioSpeedFromText(v); },',
    '    unity(v){ return smartAudioSpeedIsUnity(v); },',
    '    ref(){ return smartAudioSpeedRefPercent(); }',
    '};'
].join('\n');
const speedOut = {};
vm.runInNewContext(speedSandbox, speedOut, {filename:'static/js/smart-canvas.js'});
const s = speedOut.__s;
eq([s.min(), s.max()], [0.1, 4], '范围 0.1–4.0');
eq(s.steps(), [0.1, 0.5, 1, 1.5, 2, 3, 4], '档位吸附表 [0.1, 0.5, 1, 1.5, 2, 3, 4]');
eq([s.move(), s.end()], [0.15, 0.35], '拖动容差 0.15 / 松手容差 0.35');
eq(s.clamp(0.05), 0.1, '低于 0.1 夹到 0.1');
eq(s.clamp(9), 4, '高于 4 夹到 4');
eq(s.clamp(1.234), 1.23, '保留两位小数');
eq(s.clamp(1.235), 1.24, '四舍五入到两位小数');
eq(s.clamp(NaN), 1, '非法值回落 1');
eq(s.clamp('abc'), 1, '非数字回落 1');
eq(s.snap(1.9, s.move()), 2, '拖动时离 2x 只有 0.1 → 吸附到 2');
eq(s.snap(1.2, s.move()), 1.2, '离最近档位 0.2（> 0.15）→ 不吸附');
eq(s.snap(1.2, s.end()), 1, '松手容差 0.35 → 吸附到 1');
eq(s.snap(1.45, s.end()), 1.5, '1.45 松手吸附到 1.5');
eq(s.snap(2.2, s.move()), 2.2, '离 2x 0.2 拖动中不吸附');
eq(s.snap(3.93, s.move()), 4, '拖动到 3.93 → 吸附 4');
eq([s.label(1.5), s.label(2), s.label(0.1), s.label(1.234)], ['1.5', '2', '0.1', '1.23'], '命名写法去掉多余 0');
eq(s.text(1.5), '1.50', '输入框固定两位小数');
eq(s.text(2), '2.00', '1x/2x 显示 2.00');
eq([s.fromText('1.5'), s.fromText('1,5'), s.fromText(' 2.345 ')], [1.5, 1.5, 2.35], '输入框支持小数 / 逗号 / 空白');
eq([s.fromText('abc'), s.fromText(''), s.fromText(null)], [null, null, null], '非数字输入返回 null');
eq([s.fromText('9'), s.fromText('0')], [4, 0.1], '直接输入也夹在 0.1–4');
eq([s.unity(1), s.unity(1.004), s.unity(1.5)], [true, true, false], '值等于 1（含四舍五入到 1）算原样直通');
ok(Math.abs(s.ref() - 23.0769) < 0.001, '1x 参考点落在轨道的 23.08%');

console.log('[4] WAV：16bit PCM 头字节 + 声道交织');
const wavSandbox = [
    extractFn(js, 'smartAudioWriteAscii'),
    extractFn(js, 'smartAudioWavHeader'),
    extractFn(js, 'smartAudioWavBytes'),
    extractFn(js, 'smartAudioSliceChannels'),
    extractFn(js, 'smartAudioResampleChannels'),
    extractConst(js, 'SMART_AUDIO_SPEED_MIN'),
    extractConst(js, 'SMART_AUDIO_SPEED_MAX'),
    extractFn(js, 'smartAudioEditClamp'),
    extractFn(js, 'smartAudioSpeedClamp'),
    'function ascii(bytes, from, len){ let out = ""; for(let i = 0; i < len; i += 1) out += String.fromCharCode(bytes[from + i]); return out; }',
    'globalThis.__w = {',
    '    wav(channels, rate){ return smartAudioWavBytes(channels, rate); },',
    '    header(frames, rate, channels){ return smartAudioWavHeader(frames, rate, channels); },',
    '    slice(channels, rate, a, b){ return smartAudioSliceChannels(channels, rate, a, b); },',
    '    resample(channels, rate){ return smartAudioResampleChannels(channels, rate); },',
    '    ascii(bytes, from, len){ return ascii(bytes, from, len); }',
    '};'
].join('\n');
const wavOut = {};
vm.runInNewContext(wavSandbox, wavOut, {filename:'static/js/smart-canvas.js'});
const w = wavOut.__w;

const mono = w.wav([new Float32Array([0, 0.5, -0.5, 1])], 8000);
const monoView = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
eq(mono.byteLength, 44 + 4 * 2, '单声道 4 帧 = 44 字节头 + 8 字节数据');
eq([w.ascii(mono, 0, 4), w.ascii(mono, 8, 4), w.ascii(mono, 12, 4), w.ascii(mono, 36, 4)], ['RIFF', 'WAVE', 'fmt ', 'data'], 'RIFF / WAVE / fmt / data 四块都在');
eq(monoView.getUint32(4, true), 36 + 8, 'RIFF 块长度 = 36 + data');
eq(monoView.getUint32(16, true), 16, 'fmt 块长度 16');
eq(monoView.getUint16(20, true), 1, 'PCM 格式 = 1');
eq(monoView.getUint16(22, true), 1, '声道数 1');
eq(monoView.getUint32(24, true), 8000, '采样率 8000');
eq(monoView.getUint32(28, true), 8000 * 2, 'byteRate = 采样率 × 声道 × 2');
eq(monoView.getUint16(32, true), 2, 'blockAlign = 2');
eq(monoView.getUint16(34, true), 16, '位深 16bit');
eq(monoView.getUint32(40, true), 8, 'data 长度 = 帧数 × 声道 × 2');
eq([monoView.getInt16(44, true), monoView.getInt16(46, true), monoView.getInt16(48, true), monoView.getInt16(50, true)],
    [0, 16383, -16384, 32767], '采样值按 16bit 量化（正负满幅不同，避免削波）');

const stereo = w.wav([new Float32Array([0.25, 0.75, -0.25]), new Float32Array([-0.5, 0, 0.5])], 44100);
const stereoView = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
eq(stereo.byteLength, 44 + 3 * 2 * 2, '双声道 3 帧 = 44 + 12');
eq(stereoView.getUint16(22, true), 2, '双声道写出 2');
eq(stereoView.getUint32(24, true), 44100, '采样率 44100');
eq(stereoView.getUint32(28, true), 44100 * 2 * 2, 'byteRate 按双声道算');
eq(stereoView.getUint16(32, true), 4, 'blockAlign = 4');
eq([stereoView.getInt16(44, true), stereoView.getInt16(46, true)], [8191, -16384], '声道交织：L0 R0');
eq([stereoView.getInt16(48, true), stereoView.getInt16(50, true)], [24575, 0], '声道交织：L1 R1');
eq([stereoView.getInt16(52, true), stereoView.getInt16(54, true)], [-8192, 16383], '声道交织：L2 R2');

const empty = w.wav([], 8000);
eq(empty.byteLength, 44, '没有采样时只有 44 字节头');
eq(new DataView(empty.buffer).getUint16(22, true), 1, '空数据也写 1 个声道（头合法）');
eq(new DataView(empty.buffer).getUint32(40, true), 0, '空数据 data 长度 0');

const sliced = w.slice([new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])], 10, 0.2, 0.6);
eq(sliced[0].length, 4, '截取 0.2–0.6s @10Hz = 4 个采样');
eq(Array.from(sliced[0]), [2, 3, 4, 5], '截取取的是选区内那一段');
const fast = w.resample([new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])], 2);
eq(fast[0].length, 4, '2x 变速后采样数减半');
eq(Array.from(fast[0]), [0, 2, 4, 6], '2x 变速隔点取样（时长减半）');
const same = w.resample([new Float32Array([0, 1, 2])], 1);
eq(Array.from(same[0]), [0, 1, 2], '1x 采样原样返回');
const slow = w.resample([new Float32Array([0, 1, 2, 3])], 0.5);
eq(slow[0].length, 8, '0.5x 变速后采样数翻倍');
eq([slow[0][0], slow[0][1], slow[0][2]], [0, 0.5, 1], '0.5x 线性插值（时长翻倍）');

console.log('[5] 派生节点命名：{原名}_截取 / {原名}_1.5x');
const nameSandbox = [
    extractFn(js, 'smartAudioEditClamp'),
    extractConst(js, 'SMART_AUDIO_SPEED_MIN'),
    extractConst(js, 'SMART_AUDIO_SPEED_MAX'),
    extractFn(js, 'smartAudioSpeedClamp'),
    extractFn(js, 'smartAudioSpeedLabel'),
    extractFn(js, 'fileNameFromUrl'),
    extractConst(js, 'SMART_AUDIO_FILE_EXT_RE'),
    'function trd(key, fallback){ return fallback; }',
    extractFn(js, 'smartAudioDisplayTitle'),
    extractFn(js, 'smartAudioDerivedBaseName'),
    extractFn(js, 'smartAudioDerivedTitle'),
    'globalThis.__n = {',
    '    display(title){ return smartAudioDisplayTitle(title); },',
    '    base(item, node){ return smartAudioDerivedBaseName(item, node); },',
    '    title(item, node, mode, rate){ return smartAudioDerivedTitle(item, node, mode, rate); }',
    '};'
].join('\n');
const nameOut = {};
vm.runInNewContext(nameSandbox, nameOut, {filename:'static/js/smart-canvas.js'});
const n = nameOut.__n;
eq(n.base({name:'旁白.mp3'}), '旁白', '原名去掉扩展名');
eq(n.base({name:'旁白 v2.final.wav'}), '旁白 v2.final', '只去掉最后一段扩展名');
eq(n.base({url:'/assets/output/voice-01.wav'}), 'voice-01', '没有 name 时从 URL 取文件名');
eq(n.base({name:''}, {title:'节点标题'}), '节点标题', '没有文件名时回落到节点标题');
eq(n.base({}, {}), '音频', '什么都没有时回落到「音频」');
eq(n.title({name:'旁白.mp3'}, null, 'trim'), '旁白_截取', '截取命名 {原名}_截取');
eq(n.title({name:'旁白.mp3'}, null, 'speed', 1.5), '旁白_1.5x', '变速命名 {原名}_1.5x');
eq(n.title({name:'旁白.wav'}, null, 'speed', 2), '旁白_2x', '2x 不带小数');
eq(n.title({name:'旁白.wav'}, null, 'speed', 0.1), '旁白_0.1x', '0.1x 原样保留');
eq(n.title({name:'旁白.wav'}, null, 'speed', 4), '旁白_4x', '4x 不写成 4.00x');
eq(n.title({name:'novai-test-tone.wav'}, null, 'trim'), 'novai-test-tone_截取', '节点标题不带扩展名（novai-test-tone_截取）');
eq(n.title({name:'novai-test-tone_截取.wav'}, null, 'speed', 1.5), 'novai-test-tone_截取_1.5x', '二次编辑也只剩一层命名，不带 .wav');
eq(n.display('novai-test-tone_截取.wav'), 'novai-test-tone_截取', '标题清洗只去已知音频扩展名');
eq(n.display('旁白 v1.2'), '旁白 v1.2', '名字里的 .2 不是扩展名，不能误删');
eq(n.display(''), '', '空标题原样返回空');

console.log('[6] 实现契约：本地处理链路 / 派生节点 / 忙碌态 / 1x 直通');
const runFn = extractFn(js, 'runSmartAudioEdit');
ok(/fetch/.test(extractFn(js, 'smartAudioDecodeItem')) && /decodeAudioData/.test(extractFn(js, 'smartAudioDecodeItem')), '解码走 fetch + decodeAudioData');
ok(/SMART_AUDIO_EDIT_MAX_BYTES/.test(extractFn(js, 'smartAudioDecodeItem')) && /smart\.audioTooLarge/.test(extractFn(js, 'smartAudioDecodeItem')),
    '超过 50MB 直接报错（明确 toast 文案 key）');
ok(/node\.__audioEditBusy/.test(runFn) && /if\(!node \|\| node\.__audioEditBusy\) return null;/.test(runFn), '重复点击幂等（同一节点处理中直接返回）');
ok(/smartAudioDecodeItem\(item\)/.test(runFn) && /smartAudioWavBytes\(channels, sampleRate\)/.test(runFn), '解码后本地编码 WAV');
ok(/smartAudioSliceChannels\(sourceChannels/.test(runFn) && /smartAudioResampleChannels\(sourceChannels/.test(runFn), '截取切片 / 变速重采样分开走');
ok(/smartAudioSpeedIsUnity\(rate\)\) return null;/.test(runFn), '变速 1x 在数据层也不落节点');
ok(/uploadFiles\(\[file\]\)/.test(runFn) && /new File\(\[wav\], title \+ '\.wav', \{type:'audio\/wav'\}\)/.test(runFn), '编码结果以 audio/wav 文件走 uploadFiles');
ok(/durationSec:Math\.max\(0\.01, Math\.round\(outputDuration \* 100\) \/ 100\)/.test(runFn), '音频项带上 durationSec（与现有结果字段同源）');
ok(/kind:'audio'/.test(runFn), '音频项 kind = audio');

const placeFn = extractFn(js, 'placeSmartAudioDerivedNode');
ok(/freeSpotRightOf\(sourceNode, media\)/.test(placeFn), '落位照抄派生节点：原节点右侧的空位');
ok(/createImageNodeAt\(point, \[media\], \{select:true, skipUndo:true, type:'smart-audio', title:info\.title\}\)/.test(placeFn),
    '建 smart-audio 派生节点并选中');
ok(/addConnection\(sourceNode\.id, created\.id, 'history'\)/.test(placeFn), '接到原节点（history 连线）');
ok(/created\.derivedFrom = sourceNode\.id;/.test(placeFn), '节点带 derivedFrom = 原节点 id');
ok(/created\.audioEdit = \{/.test(placeFn) && /mode:info\.mode === 'speed' \? 'speed' : 'trim'/.test(placeFn) && /rate:info\.rate/.test(placeFn) && /start:info\.start, end:info\.end/.test(placeFn),
    "节点带 audioEdit = {mode:'trim'|'speed', ...}");
ok(/created\.outputKind = 'audio';/.test(placeFn), '输出类型标记为 audio');
ok(/centerViewportOnWorldPoint\(\{x:point\.x, y:point\.y\}\)/.test(placeFn), '和首帧成图一样把视口带到新节点');
ok(!/images\.[a-z]+ =/.test(extractFn(js, 'placeSmartAudioDerivedNode')), '不改原节点的 node.images');
ok(/created\.title = smartAudioDisplayTitle\(info\.title\) \|\| created\.title;/.test(placeFn), '派生节点标题会洗掉扩展名（media.name 仍保留 .wav）');
ok(/name:first\.name \|\| \(title \+ '\.wav'\)/.test(runFn), '音频项 name 保留 .wav，只有节点标题不带');
const paintHeadFn = extractFn(js, 'smartAudioPaintHead');
ok(/Math\.max\(1, Math\.floor\(duration\)\)/.test(paintHeadFn), '总时长不足 1 秒时显示 00:01（不再 00:00/00:00）');
ok(!/Math\.floor\(duration\) : 0/.test(paintHeadFn), '总时长不再直接 floor 成 0');

const overlayFn = extractFn(js, 'smartAudioTrimOverlayHtml');
ok(/data-audio-trim="1"/.test(overlayFn), '波形上有选区态容器');
ok(/audio-trim-mask is-start/.test(overlayFn) && /audio-trim-mask is-end/.test(overlayFn), '左右遮罩');
ok(/audio-trim-box/.test(overlayFn), '中间白色选框');
ok(/data-audio-trim-handle="start"/.test(overlayFn) && /data-audio-trim-handle="end"/.test(overlayFn), '两端可拖把手');
ok(/data-audio-trim-dur="1"/.test(overlayFn) && /toFixed\(2\)}s/.test(overlayFn), '选段时长按秒显示（如 2.30s）');
ok(/smartAudioTrimOverlayHtml\(node\)/.test(extractFn(js, 'smartAudioPlayerHtml')), '播放器卡片里挂选区层');

const bindTrimFn = extractFn(js, 'bindSmartAudioTrim');
ok(/pointerdown/.test(bindTrimFn) && /pointermove/.test(bindTrimFn) && /pointerup/.test(bindTrimFn) && /pointercancel/.test(bindTrimFn),
    '选区支持 pointer 拖拽（移动端触屏可点）');
ok(/setPointerCapture/.test(bindTrimFn), '拖把手/选框时锁定指针');
ok(/'start'/.test(bindTrimFn) && /'end'/.test(bindTrimFn) && /'move'/.test(bindTrimFn) && /'new'/.test(bindTrimFn), '拖左把手 / 拖右把手 / 整体平移 / 重新拉选区');
ok(/smartAudioTrimClampRange/.test(bindTrimFn), '拖动过程持续夹取（最短 0.5s）');
ok(/smartAudioTrimFor\(node\)\) return;/.test(extractFn(js, 'smartAudioPlayerHtml')) || /smartAudioTrimFor\(node\)\) return;/.test(extractFn(js, 'bindSmartAudioPlayer')),
    '选区态下波形点击不再 seek');
ok(/touch-action:none/.test(css) && /\.audio-trim-box \{/.test(css), '选区层禁掉浏览器手势（拖拽不滚画布）');
ok(/\.audio-trim-mask \{/.test(css) && /\.audio-trim-dur \{/.test(css) && /\.audio-trim-handle \{/.test(css), '选区样式齐全');

console.log('[7] 浮层：节点下方 / × 关闭 / Esc / 面板宿主');
const panelBody = extractFn(js, 'openSmartToolPanel');
ok(/config\.head === false/.test(panelBody), '面板支持 head:false（音频编辑自己排一行）');
ok(/config\.placement/.test(panelBody) && /config\.persist/.test(panelBody), '面板支持 placement / persist 选项');
ok(/config\.onClose/.test(panelBody) && /smartToolPanelOnClose =/.test(panelBody), '面板支持 onClose 收尾回调');
ok(/smartToolPanelOnClose = null;/.test(extractFn(js, 'closeSmartToolPanel')) && /onClose\(\)/.test(extractFn(js, 'closeSmartToolPanel')),
    '关闭面板时一定会跑 onClose（退出选区态）');
ok(/smartToolPlacement === 'below-node'/.test(extractFn(js, 'alignSmartToolPanel')), '音频编辑浮层定位在节点下方');
ok(/smartToolPanelEl\.dataset\.smartToolPersist === '1'\) return;/.test(extractFn(js, 'bindSmartToolPanelOutside')),
    '常驻面板不被「点外面」关掉（否则波形拉选区一按就没了）');
ok(/addEventListener\('keydown'/.test(extractFn(js, 'bindSmartToolPanelOutside')) && /Escape/.test(extractFn(js, 'bindSmartToolPanelOutside')),
    'Esc 关闭浮层');
ok(/function openSmartAudioTrimPanel\(node\)/.test(js) && /function bindSmartAudioTrimPanel\(panel, nodeId\)/.test(js), '有截取面板实现');

const openTrimFn = extractFn(js, 'openSmartAudioTrimPanel');
ok(/smartAudioActiveItem\(node\)\?\.url/.test(openTrimFn) && /smart\.audioNoAudio/.test(openTrimFn), '没有音频时给明确 toast');
ok(/smartAudioPause\(node\)/.test(openTrimFn), '进入选区态先暂停播放');
ok(/smartAudioEditPanelOpen\('audio-trim', node\.id\)\)\{ closeSmartToolPanel\(\); return; \}/.test(openTrimFn), '再点一次截取 = 收起');
ok(/placement:'below-node'/.test(openTrimFn) && /persist:true/.test(openTrimFn), '浮层在节点下方且常驻');
ok(/icon:'scissors'/.test(openTrimFn), '浮层标题用截取图标');

const trimPanelFn = extractFn(js, 'smartAudioTrimPanelHtml');
ok(/smartAudioCloseButtonHtml\(\)/.test(trimPanelFn) && /data-aep-close/.test(extractFn(js, 'smartAudioCloseButtonHtml')), '浮层有 × 关闭');
ok(/data-aep-range/.test(trimPanelFn) && /smartAudioTrimRangeLabel\(\)/.test(trimPanelFn), '浮层显示 00:12 - 00:26 选区读数');
ok(/data-aep-run/.test(trimPanelFn) && /smart\.audioGenerate/.test(trimPanelFn), '浮层有「生成」');
ok(/smartAudioCloseButtonHtml\(\)/.test(trimPanelFn), '关闭按钮与变速面板同源');

const trimBindFn = extractFn(js, 'bindSmartAudioTrimPanel');
ok(/data-aep-close/.test(trimBindFn), '点 × 关闭面板');
ok(/runSmartAudioEdit\(node, 'trim', \{start:range\.start, end:range\.end\}\)/.test(trimBindFn), '生成走本地截取管线');
ok(/smartAudioSetBusy\(run, true/.test(trimBindFn) && /smartAudioSetBusy\(run, false/.test(trimBindFn), '处理期间按钮禁用 + 转圈');

const speedPanelFn = extractFn(js, 'smartAudioSpeedPanelHtml');
ok(/min="0\.1" max="4" step="0\.01"/.test(speedPanelFn), '滑杆 0.1–4.0，步进 0.01');
ok(/>0\.1x</.test(speedPanelFn) && />4\.0x</.test(speedPanelFn), '轨道两端标 0.1x / 4.0x');
ok(/data-aep-ref="1"/.test(speedPanelFn), '轨道上有 1x 参考点');
ok(/data-aep-rate-input/.test(speedPanelFn) && /toFixed\(2\)/.test(speedPanelFn), '输入框显示两位小数（1.00）');
ok(/data-aep-rate-step="up"/.test(speedPanelFn) && /data-aep-rate-step="down"/.test(speedPanelFn), '输入框旁有 ▲▼');
ok(/smart\.audioConfirm/.test(speedPanelFn) && /data-aep-run/.test(speedPanelFn), '有「确认」按钮');

const speedBindFn = extractFn(js, 'bindSmartAudioSpeedPanel');
ok(/SMART_AUDIO_SPEED_SNAP_MOVE/.test(speedBindFn) && /SMART_AUDIO_SPEED_SNAP_END/.test(speedBindFn), '拖动 / 松手两档吸附容差');
ok(/addEventListener\('input'/.test(speedBindFn) && /addEventListener\('change'/.test(speedBindFn), '滑杆拖动吸附 + 松手吸附');
ok(/ArrowUp/.test(speedBindFn) && /ArrowDown/.test(speedBindFn) && /0\.1 : -0\.1/.test(speedBindFn), '↑↓ 键 ±0.1');
ok(/Enter/.test(speedBindFn) && /Escape/.test(speedBindFn), 'Enter 生效 / Esc 还原');
ok(/smartAudioSpeedFromText/.test(speedBindFn), '输入框支持直接输入');
ok(/if\(smartAudioSpeedIsUnity\(rate\)\)\{ closeSmartToolPanel\(\); return; \}/.test(speedBindFn), '值等于 1 时点确认直接关闭、不发请求');
ok(/runSmartAudioEdit\(node, 'speed', \{rate\}\)/.test(speedBindFn), '否则走本地变速管线');
const editRegion = js.slice(js.indexOf('/* ── 音频编辑：截取 / 变速'), js.indexOf('function nodeBodyHtml(node, layout){'));
const smartCalls = Array.from(new Set(Array.from(editRegion.matchAll(/\b(smartAudio[A-Za-z0-9]+)\(/g)).map(match => match[1])));
const smartDefs = new Set(Array.from(js.matchAll(/function (smartAudio[A-Za-z0-9]+)\(/g)).map(match => match[1]));
const externals = ['smartAudioActiveItem', 'smartAudioActiveIndex', 'smartAudioClockLabel', 'smartAudioPool'];
const unresolved = smartCalls.filter(name => !smartDefs.has(name) && !externals.includes(name));
eq(unresolved, [], '音频编辑区里每个 smartAudio* 调用都有定义（防函数名拼错）');
ok(!/smartAudioSpeedSnapSpeed/.test(js), '没有 smartAudioSpeedSnapSpeed 这类错名残留');
ok(/smartAudioSnapSpeed\(raw, SMART_AUDIO_SPEED_SNAP_MOVE\)/.test(extractFn(js, 'bindSmartAudioSpeedPanel')), '滑杆拖动吸附调用真实存在的 smartAudioSnapSpeed');
ok(/smartAudioSnapSpeed\(raw, SMART_AUDIO_SPEED_SNAP_END\)/.test(extractFn(js, 'bindSmartAudioSpeedPanel')), '滑杆松手吸附调用真实存在的 smartAudioSnapSpeed');

const busyFn = extractFn(js, 'smartAudioSetBusy');
ok(/button\.disabled = Boolean\(busy\)/.test(busyFn) && /is-busy/.test(busyFn), '忙碌态禁用按钮 + is-busy');
ok(/loader-circle/.test(busyFn) && /refreshIcons\(\)/.test(busyFn), '忙碌态换转圈图标');
ok(/if\(action === 'trim'\)\{ openSmartAudioTrimPanel\(node\); return; \}/.test(extractFn(js, 'runSmartNodeToolbarAction')),
    '工具条动作分发到截取');
ok(/if\(action === 'speed'\)\{ openSmartAudioSpeedPanel\(node\); return; \}/.test(extractFn(js, 'runSmartNodeToolbarAction')), '工具条动作分发到变速');

console.log('[8] i18n / 样式：中英两份 + 320 宽浮层（对齐 stp 基准）');
const keys = [
    'smart.audioTrim', 'smart.audioTrimTip', 'smart.audioSpeed', 'smart.audioSpeedTip',
    'smart.audioDownload', 'smart.audioDownloadTip', 'smart.audioClose', 'smart.audioGenerate',
    'smart.audioConfirm', 'smart.audioRate', 'smart.audioSpeedUp', 'smart.audioSpeedDown',
    'smart.audioTrimSuffix', 'smart.audioEditBusy', 'smart.audioNoAudio', 'smart.audioTooLarge',
    'smart.audioReadFail', 'smart.audioDecodeFail', 'smart.audioUploadFail', 'smart.audioTrimTooShort',
    'smart.audioTrimDone', 'smart.audioSpeedDone', 'smart.audioEditFailed'
];
keys.forEach(key => {
    const re = new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "[^"]+", en: "[^"]+" \\}');
    ok(re.test(i18n), 'i18n 中英两份：' + key);
});
ok(/\.smart-popover\.smart-tool-panel\.audio-edit-panel \{[^}]*width:320px/.test(css), '编辑浮层宽 320（与其它 stp 子菜单一致）');
ok(/\.smart-popover\.smart-tool-panel\.audio-edit-panel \{[^}]*padding:12px;/.test(css) && /\.smart-popover\.smart-tool-panel\.audio-edit-panel \{[^}]*gap:10px;/.test(css), '浮层 padding 12 / gap 10 与基准一致');
ok(!/font-size:9px/.test(css.slice(css.indexOf('.smart-popover.smart-tool-panel.audio-edit-panel'))), '浮层不再出现 9px 字号（微型标记最低 11px）');
ok(/\.audio-edit-panel \.aep-title \{[^}]*font-weight:500/.test(css), '浮层标题字重 500（实测与 .stp-title 一致）');
ok(/\.smart-popover\.smart-tool-panel\.audio-edit-panel/.test(css) && /backdrop-filter|background:/.test(css), '浮层沿用 smart-popover 那套底');
ok(/\.audio-edit-panel \.aep-ref/.test(css), '1x 参考点有样式');
ok(/\.audio-edit-panel \.aep-step/.test(css), '▲▼ 有样式');
ok(/\.audio-edit-panel \.aep-run\.is-busy/.test(css) && /animation:spin/.test(css), '忙碌态转圈有样式');
ok(!/#4b9bff/i.test(css), '没有写死的兜底蓝');
ok(!/border:1px solid/.test(css.slice(css.indexOf('.smart-popover.smart-tool-panel.audio-edit-panel'))), '新样式不画发丝级边框（分隔靠间距）');

console.log('[9] 行为：浮层 / 选区 HTML 真渲染 + 忙碌态（vm 跑真实实现）');
const uiSandbox = [
    extractConst(js, 'SMART_AUDIO_EDIT_MIN_SEC'),
    extractConst(js, 'SMART_AUDIO_SPEED_MIN'),
    extractConst(js, 'SMART_AUDIO_SPEED_MAX'),
    extractConst(js, 'SMART_AUDIO_SPEED_STEPS'),
    'let smartAudioTrim = null;',
    'let smartAudioSpeed = null;',
    'let refreshTicks = 0;',
    'function refreshIcons(){ refreshTicks += 1; }',
    'function trd(key, fallback){ return fallback; }',
    'function escapeHtml(value){ return String(value == null ? "" : value).replace(/[&<>"]/g, function(ch){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[ch]; }); }',
    'function escapeAttr(value){ return escapeHtml(value); }',
    extractFn(js, 'formatAudioClock'),
    extractFn(js, 'smartAudioEditClamp'),
    extractFn(js, 'smartAudioTrimPercent'),
    extractFn(js, 'smartAudioTrimRangeLabel'),
    extractFn(js, 'smartAudioTrimFor'),
    extractFn(js, 'smartAudioSpeedClamp'),
    extractFn(js, 'smartAudioSpeedRefPercent'),
    extractFn(js, 'smartAudioRunContent'),
    extractFn(js, 'smartAudioCloseButtonHtml'),
    extractFn(js, 'smartAudioTrimPanelHtml'),
    extractFn(js, 'smartAudioSpeedPanelHtml'),
    extractFn(js, 'smartAudioTrimOverlayHtml'),
    extractFn(js, 'smartAudioSetBusy'),
    'globalThis.__ui = {',
    '    setTrim(value){ smartAudioTrim = value; },',
    '    setSpeed(value){ smartAudioSpeed = value; },',
    '    overlay(node){ return smartAudioTrimOverlayHtml(node); },',
    '    trimPanel(){ return smartAudioTrimPanelHtml(); },',
    '    speedPanel(){ return smartAudioSpeedPanelHtml(); },',
    '    busy(button, flag, label, icon){ smartAudioSetBusy(button, flag, label, icon); },',
    '    ticks(){ return refreshTicks; }',
    '};'
].join('\n');
const uiOut = {};
vm.runInNewContext(uiSandbox, uiOut, {filename:'static/js/smart-canvas.js'});
const ui = uiOut.__ui;
eq(ui.overlay({id:'n1'}), '', '没有选区态时不渲染遮罩层');
ui.setTrim({nodeId:'n1', start:0, end:4, duration:12});
const overlayHtml = ui.overlay({id:'n1'});
ok(overlayHtml.includes('data-audio-trim="1"'), '选区态渲染容器');
ok(overlayHtml.includes('left:0.00%;width:33.33%'), '4s/12s 的选框宽 33.33%');
ok(overlayHtml.includes('>4.00s<'), '中间显示选段时长 4.00s');
ok(overlayHtml.includes('data-audio-trim-handle="start"') && overlayHtml.includes('data-audio-trim-handle="end"'), '两端把手都在');
ok(overlayHtml.includes('data-audio-trim-mask="start"') && overlayHtml.includes('data-audio-trim-mask="end"'), '左右遮罩都在');
const trimPanelHtml = ui.trimPanel();
ok(trimPanelHtml.includes('data-aep-close') && trimPanelHtml.includes('data-aep-run'), '截取浮层有 × 关闭和生成按钮');
ok(trimPanelHtml.includes('00:00 - 00:04'), '截取浮层读数跟选区同步');
ok(trimPanelHtml.includes('截取') && trimPanelHtml.includes('生成'), '截取浮层文案走 i18n 默认值');
ui.setSpeed({nodeId:'n1', rate:1.5});
const speedPanelHtml = ui.speedPanel();
ok(speedPanelHtml.includes('value="1.50"'), '变速输入框显示 1.50');
ok(speedPanelHtml.includes('left:23.08%'), '1x 参考点落在 23.08%');
ok(speedPanelHtml.includes('>0.1x<') && speedPanelHtml.includes('>4.0x<'), '轨道两端 0.1x / 4.0x');
ok(speedPanelHtml.includes('data-aep-rate-step="up"') && speedPanelHtml.includes('data-aep-rate-step="down"'), '输入框旁 ▲▼ 都在');
ok(speedPanelHtml.includes('确认') && speedPanelHtml.includes('data-aep-run'), '确认按钮在');
ok(speedPanelHtml.includes('type="range" min="0.1" max="4" step="0.01"'), '滑杆范围/步进正确');
const fakeButton = { disabled:false, innerHTML:'', classList:{ value:'', toggle(name, on){ this.value = on ? name : ''; } } };
ui.busy(fakeButton, true, '生成', 'scissors');
ok(fakeButton.disabled === true, '忙碌时按钮禁用');
ok(fakeButton.innerHTML.includes('loader-circle') && fakeButton.innerHTML.includes('处理中'), '忙碌时按钮换转圈 + 处理中');
ok(fakeButton.classList.value === 'is-busy', '忙碌态加 is-busy');
ok(ui.ticks() >= 1, '忙碌态切换后刷新图标');
ui.busy(fakeButton, false, '生成', 'scissors');
ok(fakeButton.disabled === false, '结束处理恢复按钮');
ok(fakeButton.innerHTML.includes('scissors') && fakeButton.innerHTML.includes('生成'), '恢复图标与文案');
ok(fakeButton.classList.value === '', 'is-busy 被移除');

console.log('');
console.log('音频截取 / 变速：' + pass + '/' + (pass + fails.length) + ' 项通过');
if(fails.length){
    console.log('失败：');
    fails.forEach(item => console.log('  ✗ ' + item));
    process.exit(1);
}
console.log('全部通过');
