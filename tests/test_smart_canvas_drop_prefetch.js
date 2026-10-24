#!/usr/bin/env node
/* 拖拽提速 / 拖错图回归：
   - 桥调用走 get_guest_drag_bytes / get_guest_drag_original（旧名 guest_drag_* 只作兼容回落）；
   - 预取命中走 import-urls 的 data 通道，失败/缺 dataUrl 回退原链；
   - uri-list 与 imageCandidates 同主路径时才用高清候选，否则保持 uri-list 原值；
   - 无 uri-list 才用 candidates[0]。
   跑法：node tests/test_smart_canvas_drop_prefetch.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const smart = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

const helperNames = ['smartPrimaryPathKey', 'smartDropCandidateUrls', 'smartChooseGuestImageCandidate', 'smartPrefetchDropHit', 'smartImportUrlsEmptyResult', 'smartGuestBridgeMethod'];
const helperCode = helperNames.map(name => topLevelFunction(smart, name)).join('\n');
ok(helperNames.every(name => helperCode.includes('function ' + name)), '拖拽纯函数都能提取');
const sandbox = { URL, window: {} };
vm.createContext(sandbox);
vm.runInContext(helperCode, sandbox);
const keyOf = sandbox.smartPrimaryPathKey;
const candidateUrls = sandbox.smartDropCandidateUrls;
const choose = sandbox.smartChooseGuestImageCandidate;
const prefetchHit = sandbox.smartPrefetchDropHit;
const emptyResult = sandbox.smartImportUrlsEmptyResult;
const bridgeMethod = sandbox.smartGuestBridgeMethod;
const withBridgeApi = api => { sandbox.window = { pywebview: { api } }; };

console.log('[1] 预取命中判定');
const hit = prefetchHit({ ok:true, url:'https://i.pinimg.com/736x/ab/cd/a.jpg', dataUrl:'data:image/jpeg;base64,AAAA', contentType:'image/jpeg', size:1234 });
ok(hit && hit.dataUrl === 'data:image/jpeg;base64,AAAA', '有 dataUrl 即命中');
ok(hit && hit.size === 1234 && hit.contentType === 'image/jpeg' && hit.url.includes('pinimg.com'), '保留 size/contentType/url');
const hitWithOriginal = prefetchHit({ ok:true, url:'https://i.pinimg.com/474x/ab/a.jpg', originalUrl:'https://i.pinimg.com/originals/ab/a.jpg', dataUrl:'data:image/jpeg;base64,BB', contentType:'image/jpeg', size:800 });
ok(hitWithOriginal && hitWithOriginal.originalUrl.includes('/originals/'), '保留 originalUrl');
ok(prefetchHit({ ok:false, dataUrl:'data:image/jpeg;base64,AAAA' }) === null, 'ok=false 不命中');
ok(prefetchHit({ ok:true, url:'https://x/a.jpg' }) === null, '缺 dataUrl 不命中');
ok(prefetchHit(null) === null && prefetchHit(undefined) === null, '空结果不命中');

console.log('[2] uri-list 与 candidates 同主路径');
const picUri = 'https://i.pinimg.com/736x/ab/cd/foo.jpg';
const picCandidates = ['https://i.pinimg.com/originals/ab/cd/foo.jpg', 'https://i.pinimg.com/736x/ef/gh/other.jpg'];
const picChoice = choose(picUri, picCandidates);
ok(picChoice.matched === picCandidates[0], 'Pinterest 尺寸段不同但主路径相同 → 命中高清候选');
ok(picChoice.url === picCandidates[0], '用高清候选替换 uri-list');
const hbUri = 'https://img.hb.aicdn.com/abc123_736x.jpg';
const hbChoice = choose(hbUri, ['https://img.hb.aicdn.com/abc123.jpg']);
ok(hbChoice.matched === 'https://img.hb.aicdn.com/abc123.jpg', '花瓣 _736x 后缀可归一为同一主路径');

console.log('[3] uri-list 指向另一张图');
const otherUri = 'https://i.pinimg.com/736x/ab/cd/a.jpg';
const otherCandidates = ['https://i.pinimg.com/736x/zz/yy/b.jpg'];
const otherChoice = choose(otherUri, otherCandidates);
ok(otherChoice.matched === '' && otherChoice.url === otherUri, '无同主路径候选时保留 uri-list 原值');
ok(otherChoice.url !== otherCandidates[0], 'candidates[0] 不覆盖 uri-list 的另一张图');

console.log('[4] 无 uri-list');
ok(choose('', ['https://x/1.jpg', 'https://x/2.jpg']).url === 'https://x/1.jpg', '无 uri-list 才用 candidates[0]');
ok(choose('', []).url === '', '无 uri-list 且无候选返回空');

console.log('[5] 接线');
const dropFn = topLevelFunction(smart, 'handleSmartImageDropPayload');
const urlBranch = dropFn ? dropFn.slice(dropFn.indexOf("payload.type === 'url'")) : '';
ok(/callSmartGuestBridge\(\['get_guest_drag_bytes', 'guest_drag_bytes'\]\)/.test(urlBranch), '预取调用真实桥名 get_guest_drag_bytes，并把旧名 guest_drag_bytes 作为兼容候选');
ok(urlBranch.indexOf('get_guest_drag_bytes') < urlBranch.indexOf('get_last_guest_drag'), '预取在 guest drag 读取之前');
ok(/dropLog\('guest_drag_bytes bridge: missing'\)/.test(urlBranch), '桥方法缺失时留一条 dropLog');
ok(/smartPrefetchDropHit\(prefetched\)/.test(urlBranch), '用纯函数判定预取结果');
ok(/bytes=' \+ prefetchSize \+ ' url=' \+ prefetchUrl/.test(urlBranch), '日志打印 bytes=<size> url=...');
ok(/importFetchedData\(guestBytesPrefetch, prefetchedCandidate, 'prefetch-bytes'\)/.test(urlBranch), '命中后走 data 版 import');
ok(urlBranch.indexOf("'prefetch-bytes'") < urlBranch.indexOf('const importFromFetchedBytes'), '预取导入在 fetch-bytes 之前');
ok(/prefetch-bytes fallback: import-urls data failed/.test(urlBranch), '预取导入失败继续原链');
ok(/smartChooseGuestImageCandidate\(uriSource, imageCandidates\)/.test(urlBranch), 'uri-list 选择使用纯函数');
ok(/payloadUriList\.length \? payloadUriList/.test(urlBranch), '优先使用 dataTransfer 的 uri-list');
ok(/guestDrag uri-match:/.test(urlBranch) && /guestDrag uri-only:/.test(urlBranch), '命中/未命中分别记日志');
const payloadFn = topLevelFunction(smart, 'smartImageDropPayload');
ok(/uriList/.test(payloadFn) && /getData\('text\/uri-list'\)/.test(payloadFn), 'payload 保留 text/uri-list');

console.log('[6] 中等尺寸秒出 + 后台原图升级');
ok(/medium hit bytes=' \+ guestBytesPrefetch\.size \+ ' node=' \+ createdNode\.id/.test(urlBranch), '预取命中日志 medium hit bytes/node');
ok(/upgradePrefetchedOriginal\(createdNode\.id, prefetchedFiles\.map/.test(urlBranch), '秒出节点后按 nodeId 后台升级');
ok(/callSmartGuestBridge\(\['get_guest_drag_original', 'guest_drag_original'\]\)/.test(urlBranch), '后台原图升级调用真实桥名 get_guest_drag_original，兼容旧名 guest_drag_original');
ok(/guest_drag_original bridge: missing/.test(urlBranch), '原图桥缺失时留一条 dropLog');
ok(/original upgrade done node=' \+ node\.id/.test(urlBranch) && /original upgrade failed:/.test(urlBranch), '原图升级 done/failed 日志');
ok(/const geometry = \{ x: node\.x, y: node\.y, w: node\.w, h: node\.h, scale: node\.scale, rotation: node\.rotation \}/.test(urlBranch), '升级前记录节点位置/尺寸');
ok(/node\.images\[targetIndex\] = ensureSmartImageAssetId/.test(urlBranch) && /url: high\.url/.test(urlBranch), '只替换目标图片 URL');
ok(/mediumSet\.has\(img\.url\)/.test(urlBranch), '按中等图 URL 找到目标素材，避免换错');
ok(/node\.w = geometry\.w/.test(urlBranch) && /node\.h = geometry\.h/.test(urlBranch), '升级后恢复节点尺寸');
ok(/prefetch-bytes fallback: import-urls data failed/.test(urlBranch), '预取失败仍回退原链');
ok(/if\(!hit \|\| !hit\.dataUrl\)/.test(urlBranch), '只有原图/无中等 dataUrl 时不走秒出链');

console.log('[7] import-urls count0 兜底');
const count0 = emptyResult({ ok:true, count:0, items:[] });
ok(count0.empty === true && count0.count0 === true, 'count=0 判为失败');
ok(count0.reason.includes('图片来源下载失败'), 'count=0 给出明确的下载失败文案');
ok(emptyResult({ ok:true, count:0, items:[], files:[] }).count0 === true, 'items 为空同样判失败');
ok(emptyResult({ ok:true, count:1, items:[{error:'pinterest blocked'}], files:[] }).count0 === false, '有 items 但无文件时保留后端原因');
ok(emptyResult({ ok:true, count:1, items:[{url:'x'}], files:[{url:'/local/a.jpg'}] }).empty === false, '有 files 时算成功');
ok(/dropLog\('import-urls count0'/.test(urlBranch), '日志 import-urls count0');
ok(/downloadFailed = true/.test(urlBranch) && /toast\(downloadFailed \?/.test(urlBranch), '最终 toast 用明确下载失败文案');
ok(/const fromBytes = await importFromFetchedBytes\(candidate\);/.test(urlBranch) && urlBranch.indexOf('importFromFetchedBytes(candidate)') > urlBranch.indexOf('import-urls count0'), 'count0 后继续 fetch-bytes');
ok(/dropLog\('fetch-bytes fail'/.test(urlBranch) && /dropLog\('fetch-url fail'/.test(urlBranch), 'fetch-bytes/fetch-url 失败均有日志');
ok(!/if\(!files\.length\)\{\s*return;/.test(urlBranch.slice(0, urlBranch.indexOf('importFromFetchedBytes(candidate)'))), 'count0 不提前 return');

console.log('[8] 桥方法名兼容（真名 / 旧名 / 缺失）');
withBridgeApi({});
ok(bridgeMethod(['get_guest_drag_bytes', 'guest_drag_bytes']) === '', '桥上一个都没有时返回空');
withBridgeApi({ get_guest_drag_bytes: () => 'x', guest_drag_bytes: () => 'y' });
ok(bridgeMethod(['get_guest_drag_bytes', 'guest_drag_bytes']) === 'get_guest_drag_bytes', '两个名字都在时优先真名 get_guest_drag_bytes');
withBridgeApi({ guest_drag_bytes: () => 'y' });
ok(bridgeMethod(['get_guest_drag_bytes', 'guest_drag_bytes']) === 'guest_drag_bytes', '只有旧名时回落到 guest_drag_bytes');
withBridgeApi({ get_guest_drag_original: () => 'x' });
ok(bridgeMethod(['get_guest_drag_original', 'guest_drag_original']) === 'get_guest_drag_original', '原图桥真名优先');
withBridgeApi({ get_guest_drag_bytes: 'not-a-function' });
ok(bridgeMethod(['get_guest_drag_bytes']) === '', '不是函数不算命中（特性检测等价）');

console.log('');
console.log('拖拽预取/拖错图回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
if(fails.length) process.exit(1);
