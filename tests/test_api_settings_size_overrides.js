#!/usr/bin/env node
/*
 * 设置页保存白名单必须原样带回 size_overrides / model_protocols。
 *
 * 两版设置页都是「按字段白名单重建 provider 再 PUT」：
 *   - 旧版 static/js/api-settings.js  saveProviders() 的 body:JSON.stringify(providers.map(item => ({...})))
 *   - 新版 web/src/shell/settings/api/core/useApiStore.js  payloadOf(p)
 * 新版设置页的「能力覆盖」卡片（parts/SizeOverridesCard.vue）在页面里可视化编辑 size_overrides，
 * 白名单一旦漏掉同样会丢；backend 的 ApiProviderPayload 由 tests/test_provider_size_overrides.py 覆盖。
 *
 * 运行：node tests/test_api_settings_size_overrides.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEGACY_SRC = path.join(ROOT, 'static/js/api-settings.js');
const VUE_SRC = path.join(ROOT, 'web/src/shell/settings/api/core/useApiStore.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

function sliceBetween(src, startMarker, endMarker, label) {
    const start = src.indexOf(startMarker);
    if (start < 0) throw new Error(label + '：找不到起始标记 ' + startMarker);
    const end = src.indexOf(endMarker, start);
    if (end < 0) throw new Error(label + '：找不到结束标记 ' + endMarker);
    return src.slice(start, end + endMarker.length);
}

function assertKeeps(outgoing, label) {
    ok(/size_overrides\s*:/.test(outgoing), label + ' 的出站白名单必须包含 size_overrides');
    ok(/model_protocols\s*:/.test(outgoing), label + ' 的出站白名单必须包含 model_protocols');
}

const legacy = fs.readFileSync(LEGACY_SRC, 'utf8');
const vue = fs.readFileSync(VUE_SRC, 'utf8');

const legacyBody = sliceBetween(
    legacy,
    'body:JSON.stringify(providers.map(item => ({',
    'clear_lovart_secret_key:isLovartContext(item, item.protocol) && item._clearLovartSecretKey === true',
    '旧版 api-settings.js'
);
assertKeeps(legacyBody, '旧版 api-settings.js saveProviders()');

const vueBody = sliceBetween(
    vue,
    'function payloadOf(p) {',
    "clear_lovart_secret_key: lovart && p._clearLovartSecretKey === true,",
    '新版 useApiStore.js'
);
assertKeeps(vueBody, '新版 useApiStore.js payloadOf()');

console.log('[api-settings-size-overrides] ' + pass + ' 项通过');
if (fails.length) {
    fails.forEach(msg => console.error('  \u2717 ' + msg));
    console.error('失败 ' + fails.length + ' 项');
    process.exit(1);
}
console.log('[api-settings-size-overrides] 全部通过');
