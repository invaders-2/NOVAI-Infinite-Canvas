#!/usr/bin/env node
/* 图片拖拽兜底回归（Pinterest 拖图不出节点）：
   - 图片候选在 import-urls / fetch-bytes 都失败后要能走 fetch-url（主进程 session.fetch，走系统代理），
     视频的既有行为不能变；
   - 主进程回传的 imageCandidates / videoCandidates 是 {url,w} 对象，画布侧必须取 .url，
     并把 "[object Object]" 这类垃圾值挡在外面。
   跑法：node tests/test_smart_canvas_drop_image_fallback.js */
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

const helperCode = ['smartDropCandidateUrls', 'smartChooseGuestImageCandidate', 'smartPrimaryPathKey']
    .map(name => topLevelFunction(smart, name)).join('\n');
const sandbox = { URL, window: {} };
vm.createContext(sandbox);
vm.runInContext(helperCode, sandbox);
const candidateUrls = sandbox.smartDropCandidateUrls;
const choose = sandbox.smartChooseGuestImageCandidate;

console.log('[1] 候选归一：字符串 / {url} 对象 / 垃圾值');
const pinObject = 'https://i.pinimg.com/1200x/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg';
ok(JSON.stringify(candidateUrls([pinObject])) === JSON.stringify([pinObject]), '字符串候选原样保留');
ok(JSON.stringify(candidateUrls([{ url: pinObject, w: 0 }])) === JSON.stringify([pinObject]), '{url,w} 对象取 .url');
ok(JSON.stringify(candidateUrls([{ src: pinObject }])) === JSON.stringify([pinObject]), '只有 src 的对象取 .src');
const mixed = candidateUrls([pinObject, { url: pinObject }, '[object Object]', '', null, undefined, 'not-a-url', { url: '' }, 'data:image/png;base64,AAA']);
ok(mixed.length === 2 && mixed[0] === pinObject && mixed[1] === 'data:image/png;base64,AAA', '去重 + 过滤非 http(s)/data: 的垃圾值');
ok(candidateUrls([Object.prototype.toString.call({})]).length === 0, '"[object Object]" 被过滤掉');
ok(JSON.stringify(candidateUrls(null)) === '[]' && JSON.stringify(candidateUrls(undefined)) === '[]', '非数组入参返回空');
ok(candidateUrls([{ url: 'https://a/1.jpg' }, { url: 'https://a/1.jpg' }]).length === 1, '重复候选只留一份');

console.log('[2] uri-list 选择用的也是归一后的候选');
const uri = 'https://i.pinimg.com/736x/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg';
const objectChoice = choose(uri, [{ url: 'https://i.pinimg.com/originals/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg', w: 0 }]);
ok(objectChoice.matched === 'https://i.pinimg.com/originals/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg', '对象候选也能按同主路径命中高清版');
ok(choose(uri, [{ url: pinObject }, '[object Object]']).url !== '[object Object]', '垃圾候选不会顶掉 uri-list');

console.log('[3] 主进程 drag 记录读取走归一函数');
const fallbackFn = topLevelFunction(smart, 'guestDropFallbackPayload');
ok(/smartDropCandidateUrls\(drag\.imageCandidates\)/.test(fallbackFn), 'guestDropFallbackPayload 的 imageCandidates 走归一');
ok(/smartDropCandidateUrls\(drag\.videoCandidates\)/.test(fallbackFn), 'guestDropFallbackPayload 的 videoCandidates 走归一');
ok(!/imageCandidates\.map\(v => String\(v/.test(fallbackFn), '不再用 String(v) 直接拼对象');
const dropFn = topLevelFunction(smart, 'handleSmartImageDropPayload');
const urlBranch = dropFn ? dropFn.slice(dropFn.indexOf("payload.type === 'url'")) : '';
ok(/smartDropCandidateUrls\(drag\.imageCandidates\)/.test(urlBranch), '落图逻辑里的 imageCandidates 走归一');
ok(/smartDropCandidateUrls\(drag\.videoCandidates\)/.test(urlBranch), '落图逻辑里的 videoCandidates 走归一');
ok(!/drag\.imageCandidates : \[\]\)\.map\(v => String\(v/.test(urlBranch), '落图逻辑里不再把对象 String 成 "[object Object]"');

console.log('[4] fetch-url 兜底对图片候选也生效');
const fetchUrlGate = urlBranch.slice(urlBranch.indexOf('const fromBytes = await importFromFetchedBytes(candidate);'));
ok(/\(isVideoCandidate\(candidate\) \|\| isImageCandidate\(candidate\)\)/.test(fetchUrlGate), '图片候选和视频候选一样能进 fetch-url 分支');
ok(/isVideoCandidate\(candidate\)/.test(fetchUrlGate), '视频候选的既有行为保留');
ok(fetchUrlGate.indexOf('fetch-bytes:') < fetchUrlGate.indexOf('isImageCandidate(candidate)'), 'fetch-url 仍在 fetch-bytes 失败之后');
ok(/trail\.push\('fetch-url:' \+ \(fromUrl\.length \? 'ok' : 'fail'\)\)/.test(fetchUrlGate), '日志 trail 仍是 fetch-url:ok|fail');
ok(/dropLog\('fetch-url fail'/.test(fetchUrlGate), 'fetch-url 失败仍有日志');
ok(fetchUrlGate.indexOf('/^https?:') !== -1, '只对 http(s) 候选走 fetch-url，blob/data 不进');
ok(/const fromUrl = await importFromFetchedUrl\(candidate\);/.test(fetchUrlGate), '仍然复用 importFromFetchedUrl');
const runPass = urlBranch.slice(urlBranch.indexOf('const runMediaPass = async () => {'));
ok(/if\(isPageCandidate\(candidate\) \|\| triedCandidates\.has\(candidate\)\) continue;/.test(runPass), '页面候选仍然跳过');
ok(urlBranch.indexOf('const importFromFetchedUrl = async candidate => {') < urlBranch.indexOf('const tryCandidate = async candidate => {'), 'importFromFetchedUrl 在 tryCandidate 之前定义');

console.log('');
console.log('图片拖拽兜底回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
if(fails.length) process.exit(1);
