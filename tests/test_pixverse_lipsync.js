#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const src = read('static/js/smart-canvas.js');
const start = src.indexOf('function renderPixverseLipsyncControl(){');
const end = src.indexOf('function renderApiVideoParams(){', start);
assert(start >= 0 && end > start, 'PixVerse 参数函数存在');
const fn = new Function('settings', 'renderVideoToggleRow', 'escapeAttr', 'escapeHtml', 'trd',
    src.slice(start, end) + '\nreturn renderPixverseLipsyncControl();');
const settings = { videoProvider: 'pixverse', videoModel: 'pixverse-lipsync', voiceSample: '/assets/voice.wav', speakerId: 'speaker-1', voiceConsent: true };
const html = fn(settings, (key, label) => `<div data-toggle-param="${key}">${label}</div>`,
    value => String(value).replace(/"/g, '&quot;'), value => String(value), (_key, fallback) => fallback);
assert(html.includes('data-lipsync-field="voiceSample"'));
assert(html.includes('data-lipsync-field="speakerId"'));
assert(html.includes('data-toggle-param="voiceConsent"'));
assert(html.includes('speaker-1'));
assert.strictEqual(fn({ videoProvider: 'pixverse', videoModel: 'pixverse-v6' }, () => '', String, String, (_k, v) => v), '', '其它视频模型不显示声音配置');
const payload = src.slice(src.indexOf('const payload = {', src.indexOf('async function runApiVideoGeneration')));
for (const field of ['speaker_id: runSettings.speakerId', 'voice_sample: runSettings.voiceSample', 'voice_consent: Boolean(runSettings.voiceConsent)']) {
    assert(payload.includes(field), '请求字段：' + field);
}
const i18n = read('static/js/i18n/smart-canvas.js');
for (const key of ['smart.lipsyncVoiceTitle', 'smart.lipsyncVoiceConsent', 'smart.lipsyncVoiceSample', 'smart.lipsyncSpeakerId', 'smart.lipsyncNote']) {
    assert(i18n.includes('"' + key + '"'), 'i18n：' + key);
}
const general = read('web/src/shell/settings/GeneralPanel.vue');
assert(general.includes('/api/agent/web-access'));
assert(general.includes('saveWebAccess'));
console.log('[PASS] PixVerse 画布参数、请求契约、i18n 与联网设置');
