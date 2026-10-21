#!/usr/bin/env node
/* 画布「TTS 文字转语音」回归：
   1) 模型家族：模型名含 tts / speech / voice 时认 tts，且不影响 suno / flowmusic / generic；
   2) 请求体：provider_id / model / input / voice / response_format / speed 与后端契约一致；
   3) 参数面板：音色 6 个、语速滑杆 0.25–4 (step 0.05) + 数值框、格式 wav/opus/aac/flac、4096 字上限提示；
   4) 生成链路按 family 分流：tts → POST /api/canvas-tts，其它 → /api/canvas-audio；超长文本不进请求。
   跑法：node tests/test_smart_audio_tts.js */
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
function extractDecl(src, name){
    const start = src.indexOf('const ' + name + ' = ');
    if(start < 0) throw new Error('未找到常量 ' + name);
    const stops = [src.indexOf('\nconst ', start + 1), src.indexOf('\nfunction ', start + 1)]
        .filter(index => index > start);
    if(!stops.length) throw new Error('未找到常量结尾 ' + name);
    return src.slice(start, Math.min.apply(null, stops));
}

const js = read('static/js/smart-canvas.js');
const i18n = read('static/js/i18n/smart-canvas.js');

console.log('[1] 模型家族：tts / suno / flowmusic / generic');
const familySandbox = [
    'let settings = {audioModel:"gpt-4o-mini-tts"};',
    extractFn(js, 'audioModelFamily'),
    'globalThis.__f = { set(model){ settings.audioModel = model; }, family(model){ return audioModelFamily(model); } };'
].join('\n');
const familyOut = {};
vm.runInNewContext(familySandbox, familyOut, {filename:'static/js/smart-canvas.js'});
const f = familyOut.__f;
eq(f.family('gpt-4o-mini-tts'), 'tts', 'gpt-4o-mini-tts 认 tts');
eq(f.family('TTS-1'), 'tts', '模型名大小写不敏感');
eq(f.family('openai-speech-02'), 'tts', '含 speech 认 tts');
eq(f.family('voice-clone'), 'tts', '含 voice 认 tts');
eq(f.family('suno-v5'), 'suno', 'suno 家族不受影响');
eq(f.family('SUNO'), 'suno', 'suno 大小写不敏感');
eq(f.family('flowmusic'), 'flowmusic', 'flowmusic 家族不受影响');
eq(f.family('other-music'), 'generic', '其它模型仍是 generic');
eq(f.family('whisper-1'), 'unsupported', 'whisper（语音转文字）标成 unsupported');
eq(f.family('whisper-large-v3'), 'unsupported', 'whisper 系全部 unsupported');
eq(f.family('transcribe-1'), 'unsupported', 'transcribe 标成 unsupported');
eq(f.family('gpt-audio-mini'), 'unsupported', 'gpt-audio 对话模型标成 unsupported');
eq(f.family('gpt-4o-audio-preview'), 'unsupported', '*-preview 标成 unsupported');
eq(f.family('tts-1-hd'), 'tts', 'tts-1-hd 仍是 tts');
f.set('gpt-4o-mini-tts');
eq(f.family(), 'tts', '不传参数时读 settings.audioModel');

console.log('[1b] 模型下拉：非生成模型过滤掉，不会出现在音频节点');
const modelFilterSandbox = [
    'let apiProviders = [{id:"p1", enabled:true, has_key:true, audio_models:["flowmusic","suno","gpt-4o-mini-tts","tts-1","tts-1-hd","gpt-audio-mini","gpt-4o-audio-preview","whisper-1"]}];',
    extractFn(js, 'audioProviders'),
    extractFn(js, 'audioModelFamily'),
    extractFn(js, 'isUnsupportedAudioModel'),
    extractFn(js, 'providerAudioModels'),
    'globalThis.__m = { models(){ return providerAudioModels("p1"); }, unsupported(model){ return isUnsupportedAudioModel(model); } };'
].join('\n');
const modelFilterOut = {};
vm.runInNewContext(modelFilterSandbox, modelFilterOut, {filename:'static/js/smart-canvas.js'});
const m = modelFilterOut.__m;
eq(m.models(), ['flowmusic', 'suno', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    '下拉只剩生成模型：flowmusic / suno / gpt-4o-mini-tts / tts-1 / tts-1-hd');
eq(m.unsupported('whisper-1'), true, 'whisper-1 判定 unsupported');
eq(m.unsupported('suno'), false, 'suno 仍是可用模型');

console.log('[2] 请求体：/api/canvas-tts 字段映射 + 参数归一');
const payloadSandbox = [
    extractDecl(js, 'AUDIO_TTS_MAX_CHARS'),
    extractDecl(js, 'AUDIO_TTS_SPEED_MIN'),
    extractDecl(js, 'AUDIO_TTS_SPEED_MAX'),
    extractDecl(js, 'AUDIO_TTS_SPEED_DEFAULT'),
    extractDecl(js, 'AUDIO_TTS_VOICES'),
    extractDecl(js, 'AUDIO_TTS_FORMATS'),
    'let settings = {audioProvider:"p1", audioModel:"gpt-4o-mini-tts", audioVoice:"shimmer", audioSpeed:0.3, audioFormat:"aac"};',
    'function trd(key, fallback){ return fallback; }',
    extractFn(js, 'audioTtsVoiceValue'),
    extractFn(js, 'audioTtsVoiceLabel'),
    extractFn(js, 'audioTtsSpeedValue'),
    extractFn(js, 'audioTtsSpeedLabel'),
    extractFn(js, 'audioTtsFormatValue'),
    extractFn(js, 'audioTtsPayload'),
    'globalThis.__t = {',
    '    set(v){ settings = Object.assign({}, settings, v); },',
    '    maxChars(){ return AUDIO_TTS_MAX_CHARS; },',
    '    voices(){ return AUDIO_TTS_VOICES.map(v => v.value); },',
    '    formats(){ return AUDIO_TTS_FORMATS.slice(); },',
    '    voice(){ return audioTtsVoiceValue(); },',
    '    voiceLabel(){ return audioTtsVoiceLabel(); },',
    '    speed(){ return audioTtsSpeedValue(); },',
    '    speedLabel(){ return audioTtsSpeedLabel(); },',
    '    format(){ return audioTtsFormatValue(); },',
    '    payload(prompt){ return audioTtsPayload(prompt); }',
    '};'
].join('\n');
const payloadOut = {};
vm.runInNewContext(payloadSandbox, payloadOut, {filename:'static/js/smart-canvas.js'});
const t = payloadOut.__t;
eq(t.maxChars(), 4096, '文本上限 4096');
eq(t.voices(), ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], '6 个官方音色');
eq(t.formats(), ['wav', 'opus', 'aac', 'flac'], '前端只暴露可播放的 4 种格式（不含 pcm）');
eq(t.payload('你好'), {provider_id:'p1', model:'gpt-4o-mini-tts', input:'你好', voice:'shimmer', response_format:'aac', speed:0.3},
    '提交体与后端契约一致');
t.set({audioVoice:'NOVA'});
eq(t.voice(), 'nova', '音色大小写不敏感');
eq(t.voiceLabel(), '女声·活力', '药丸上的中文音色标签');
t.set({audioVoice:'robot'});
eq(t.voice(), 'alloy', '非白名单音色回落 alloy');
eq(t.voiceLabel(), '中性', '回落音色的标签是「中性」');
t.set({audioSpeed:9});
eq(t.speed(), 4, '语速高于 4 夹到 4');
t.set({audioSpeed:0.01});
eq(t.speed(), 0.25, '语速低于 0.25 夹到 0.25');
t.set({audioSpeed:'abc'});
eq(t.speed(), 1, '非法语速回落 1');
t.set({audioSpeed:1.234});
eq(t.speed(), 1.23, '语速保留两位小数');
eq(t.speedLabel(), '1.23x', '语速读数是 1.23x');
t.set({audioSpeed:1});
eq(t.speedLabel(), '1x', '整数语速显示 1x（不拖 .00）');
t.set({audioFormat:''});
eq(t.format(), 'wav', '没选格式时默认 wav');
t.set({audioFormat:'opus'});
eq(t.format(), 'opus', '合法格式原样透传');
t.set({audioFormat:'pcm'});
eq(t.format(), 'wav', 'pcm 不暴露在面板，非法值回落 wav');
t.set({audioFormat:'opus', audioVoice:'nova', audioSpeed:1.5});
eq(t.payload(' 你好 '), {provider_id:'p1', model:'gpt-4o-mini-tts', input:' 你好 ', voice:'nova', response_format:'opus', speed:1.5},
    'prompt 原文传给 input（不做二次裁剪）');

console.log('[3] 参数面板：音色 / 语速 / 格式 / 4096 提示（跑真实渲染函数）');
const panelSandbox = [
    extractDecl(js, 'AUDIO_TTS_MAX_CHARS'),
    extractDecl(js, 'AUDIO_TTS_SPEED_MIN'),
    extractDecl(js, 'AUDIO_TTS_SPEED_MAX'),
    extractDecl(js, 'AUDIO_TTS_SPEED_DEFAULT'),
    extractDecl(js, 'AUDIO_TTS_VOICES'),
    extractDecl(js, 'AUDIO_TTS_FORMATS'),
    'let settings = {audioModel:"gpt-4o-mini-tts", audioVoice:"nova", audioSpeed:1.5, audioFormat:"aac"};',
    'let promptText = "你好，世界";',
    'function trd(key, fallback){ return fallback; }',
    'function escapeHtml(value){ return String(value == null ? "" : value); }',
    'function escapeAttr(value){ return String(value == null ? "" : value); }',
    'function promptPlainText(){ return promptText; }',
    extractFn(js, 'audioModelFamily'),
    extractFn(js, 'audioModelUnsupportedText'),
    extractFn(js, 'audioTtsVoiceValue'),
    extractFn(js, 'audioTtsVoiceLabel'),
    extractFn(js, 'audioTtsSpeedValue'),
    extractFn(js, 'audioTtsSpeedLabel'),
    extractFn(js, 'audioTtsFormatValue'),
    extractFn(js, 'audioSettingsSummary'),
    extractFn(js, 'renderAudioSettingsControl'),
    'globalThis.__p = {',
    '    setText(v){ promptText = v; },',
    '    setModel(v){ settings.audioModel = v; },',
    '    html(){ return renderAudioSettingsControl(); },',
    '    summary(){ return audioSettingsSummary(); }',
    '};'
].join('\n');
const panelOut = {};
vm.runInNewContext(panelSandbox, panelOut, {filename:'static/js/smart-canvas.js'});
const p = panelOut.__p;
const html = p.html();
eq((html.match(/data-smart-param="audioVoice"/g) || []).length, 6, '音色 6 个按钮');
for(const [voice, label] of [['alloy', '中性'], ['echo', '男声·沉稳'], ['fable', '英式叙述'], ['onyx', '男声·深沉'], ['nova', '女声·活力'], ['shimmer', '女声·温柔']]){
    ok(html.includes('data-smart-value="' + voice + '"'), '音色按钮带 voice 值：' + voice);
    ok(html.includes('>' + label + '</button>'), '音色按钮显示中文标签：' + label);
}
ok(/class="active"[^>]*data-smart-param="audioVoice" data-smart-value="nova"/.test(html), '当前音色 nova 高亮');
ok(/type="range" class="smart-range dur-slider" min="0.25" max="4" step="0.05" value="1.5"/.test(html),
    '语速滑杆 0.25–4、step 0.05、回填当前值');
ok(/data-audio-speed-value aria-label="语速"/.test(html) && /<span>x<\/span>/.test(html), '语速数值框 + x 单位');
ok(/data-audio-speed-range/.test(html), '滑杆带 data-audio-speed-range 绑定标记');
for(const format of ['WAV', 'OPUS', 'AAC', 'FLAC']){
    ok(html.includes('>' + format + '</button>'), '格式按钮：' + format);
}
ok(!/>PCM</.test(html), '面板不暴露 PCM（浏览器播不了）');
ok(html.includes('data-tts-limit') && html.includes('4096'), '面板顶部提示 4096 字上限');
ok(/data-tts-prompt-count>5</.test(html), '当前字数 = 5（你好，世界）');
p.setText('字'.repeat(12));
ok(/data-tts-prompt-count>12</.test(p.html()), '字数随 prompt 变化');
eq(p.summary(), '女声·活力 · 1.5x · AAC', '药丸摘要：音色 · 语速 · 格式');
p.setText('');
eq(p.summary(), '女声·活力 · 1.5x · AAC', '没有文本时摘要仍显示参数');
p.setModel('whisper-1');
const unsupportedHtml = p.html();
ok(unsupportedHtml.includes('不支持音频节点生成'), 'unsupported 模型：参数面板给明确文案');
ok(!unsupportedHtml.includes('data-smart-param="audioVoice"'), 'unsupported 模型：不渲染音色按钮');
ok(!unsupportedHtml.includes('data-audio-speed-range'), 'unsupported 模型：不渲染语速控件');
eq(p.summary(), '不支持生成', '药丸摘要提示「不支持生成」');
p.setModel('gpt-4o-mini-tts');
eq(p.summary(), '女声·活力 · 1.5x · AAC', '换回生成模型后恢复参数摘要');

console.log('[4] 生成链路：tts → /api/canvas-tts，其它 → /api/canvas-audio');
const runFn = extractFn(js, 'runSmartAudioGeneration');
ok(/tts \? '\/api\/canvas-tts' : '\/api\/canvas-audio'/.test(runFn), '按 family 分流到两个接口');
ok(/const family = audioModelFamily\(runSettings\.audioModel\)/.test(runFn), '用 runSettings 的模型判定家族');
ok(/audioTtsPayload\(prompt\)/.test(runFn), 'tts 用专用请求体');
ok(/audioGenerationPayload\(prompt, runSettings\)/.test(runFn), '音乐家族仍用原请求体');
ok(/AUDIO_TTS_MAX_CHARS/.test(runFn) && /audioTtsTooLong/.test(runFn), '超过 4096 字在本地就拦下（不白花一次请求）');
ok(!/fetch\('\/api\/canvas-audio'/.test(runFn), '不再写死 /api/canvas-audio');
const unsupportedAt = runFn.indexOf("family === 'unsupported'");
const fetchAt = runFn.indexOf("fetch(tts ?");
ok(unsupportedAt > 0 && fetchAt > unsupportedAt, 'unsupported 模型在发请求前就返回（不触发网络请求）');
ok(/toast\(audioModelUnsupportedText\(\)\)/.test(runFn), '拒绝文案走统一 helper');
const ttsPayloadFn = extractFn(js, 'audioTtsPayload');
ok(/provider_id:String\(settings\.audioProvider/.test(ttsPayloadFn) && /model:String\(settings\.audioModel/.test(ttsPayloadFn),
    '平台 / 模型来自参数记忆');
ok(/input:String\(prompt/.test(ttsPayloadFn), 'input 就是提示词文本');
ok(/voice:audioTtsVoiceValue\(\)/.test(ttsPayloadFn) && /response_format:audioTtsFormatValue\(\)/.test(ttsPayloadFn) && /speed:audioTtsSpeedValue\(\)/.test(ttsPayloadFn),
    '音色 / 格式 / 语速都走归一函数');

console.log('[5] 参数记忆：settings 默认值 + 按生成类型分槽');
ok(/audioVoice:'alloy'/.test(js) && /audioSpeed:1/.test(js), 'settings 默认 audioVoice=alloy / audioSpeed=1');
ok(/'audioVoice'/.test(js.slice(js.indexOf('const layoutKeys'), js.indexOf('const layoutKeys') + 700)), '换音色会重渲染参数面板（active 态更新）');
ok(/'audioSpeed'/.test(js.slice(js.indexOf('const numericKeys'), js.indexOf('const numericKeys') + 600)), 'audioSpeed 按数字存');
const persistFn = extractFn(js, 'persistActiveSmartSettings');
ok(/runSettings = settingsForStorage\(settings\)/.test(persistFn) && /rememberRecentSmartSettings/.test(persistFn), '参数记忆仍走现有落盘机制');
ok(/kind === 'video' \|\| kind === 'audio' \? kind : 'image'/.test(extractFn(js, 'smartSettingsApiKindKey')), '音频仍然独立成槽（不与图片/视频串）');

console.log('[6] i18n：中英文案都登记');
const keys = [
    'smart.audioVoice', 'smart.audioVoiceAlloy', 'smart.audioVoiceEcho', 'smart.audioVoiceFable',
    'smart.audioVoiceOnyx', 'smart.audioVoiceNova', 'smart.audioVoiceShimmer',
    'smart.audioTtsSpeed', 'smart.audioTtsText', 'smart.audioTtsLimit', 'smart.audioTtsCurrent',
    'smart.audioTtsTooLong', 'smart.audioFormat', 'smart.audioFormatDefault',
    'smart.audioModelUnsupported', 'smart.audioUnsupportedShort'
];
for(const key of keys){
    const at = i18n.indexOf('"' + key + '"');
    ok(at >= 0, 'i18n 有 ' + key);
    if(at >= 0){
        const line = i18n.slice(at, i18n.indexOf('\n', at));
        ok(/zh:\s*"/.test(line) && /en:\s*"/.test(line), key + ' 中英齐全');
    }
}

console.log('');
console.log('TTS 文字转语音：' + pass + '/' + (pass + fails.length) + ' 项通过');
if(fails.length){
    console.log('失败：');
    fails.forEach(item => console.log('  ✗ ' + item));
    process.exit(1);
}
console.log('全部通过');
