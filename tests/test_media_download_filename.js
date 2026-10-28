#!/usr/bin/env node
/* 下载/导出文件名：后缀必须按真实媒体类型判定，不能落到 .png。
   判定顺序：URL 路径末段的媒体扩展名（白名单）→ item.kind / mediaKindForItem → 默认兜底。
   覆盖：经典画布 outputDownloadName（含调用点接线）、智能画布 extensionForMediaItem /
   downloadNameForMediaItem / zipDownloadImageItems / appendCascadeRefsToReceiver。
   回归目标：/output/abc123 这类无扩展名的视频 URL 不能存成 .png；kind=video 时 name 里的
   .png 不能压过 kind。
   跑法：node tests/test_media_download_filename.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const smartJs = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
const canvasJs = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');

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
const tail = name => String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase();

(async () => {
    console.log('[1] 经典画布：outputDownloadName 按 URL 扩展名 / kind 判定');
    const canvasSandbox = {console};
    vm.createContext(canvasSandbox);
    vm.runInContext([
        topLevelFunction(canvasJs, 'outputDownloadName'),
        'globalThis.__api = {name:outputDownloadName};',
    ].join('\n'), canvasSandbox);
    const classicName = canvasSandbox.__api.name;
    ok(topLevelFunction(canvasJs, 'outputDownloadName') !== '', '经典画布存在 outputDownloadName');

    let got = classicName('/output/abc123', 'video');
    ok(/^canvas-output-\d+\.mp4$/.test(got), '无扩展名本地视频 URL + kind=video → .mp4（实际 ' + got + '）');
    got = classicName('/output/abc123');
    ok(/^canvas-output-\d+\.png$/.test(got), '无 kind 时默认仍 .png（实际 ' + got + '）');
    got = classicName('https://x.y.com/a/b', 'video');
    ok(/^canvas-output-\d+\.mp4$/.test(got), '域名点号不被当成扩展名，视频 → .mp4（实际 ' + got + '）');
    got = classicName('https://x.y.com/a/b');
    ok(/^canvas-output-\d+\.png$/.test(got), '域名 URL 无 kind 时兜底 .png，不带域名碎片（实际 ' + got + '）');
    got = classicName('/output/pic.png', 'image');
    ok(/^canvas-output-\d+\.png$/.test(got), '正常 png 图片仍 .png（实际 ' + got + '）');
    got = classicName('/output/clip.webm', 'video');
    ok(/^canvas-output-\d+\.webm$/.test(got), 'URL 自带的视频扩展优先于 kind（实际 ' + got + '）');
    got = classicName('/output/abc123?v=1', 'video');
    ok(/^canvas-output-\d+\.mp4$/.test(got), 'query 不影响后缀判定（实际 ' + got + '）');
    got = classicName('/output/abc123', 'audio');
    ok(/^canvas-output-\d+\.mp3$/.test(got), 'kind=audio → .mp3（实际 ' + got + '）');

    console.log('[2] 经典画布：下载调用点必须把 kind 传进去');
    const lightbox = topLevelFunction(canvasJs, 'openOutputLightbox');
    ok(/const outputKind = mediaKindForOutputItem\(/.test(lightbox), '灯箱先算出 outputKind');
    ok(!/outputDownloadName\(url\)/.test(lightbox), '灯箱下载不再裸调 outputDownloadName(url)');
    ok(/outputDownloadName\(url, outputKind\)/.test(lightbox), '灯箱下载把 outputKind 传给 outputDownloadName');
    const wrapBinder = topLevelFunction(canvasJs, 'bindOutputWrap');
    ok(/mediaKindForOutputItem\(/.test(wrapBinder), '输出卡片下载按 mediaKindForOutputItem 判定 kind');
    ok(/outputDownloadName\(url, kind\)/.test(wrapBinder), '输出卡片下载把 kind 传给 outputDownloadName');
    const legacy = topLevelFunction(canvasJs, 'outputDownloadName');
    ok(!/clean\.includes\('\.'\)/.test(legacy), '不再用整串 URL 里是否含点来猜后缀');
    ok(/mp4\|webm\|mov\|m4v\|mkv\|avi/.test(legacy), 'outputDownloadName 带视频扩展白名单');

    console.log('[3] 智能画布：media kind 判定');
    const smartSandbox = {console};
    const prelude = [
        'const window = {location:{href:"http://127.0.0.1/static/smart-canvas.html", origin:"http://127.0.0.1"}};',
        'function toast(){}',
        'let lastFetch = null;',
        'let lastDownload = "";',
        'function fetch(url, options){ lastFetch = {url, options}; return Promise.resolve({ok:true, blob:()=>Promise.resolve({})}); }',
        'function downloadBlob(blob, filename){ lastDownload = filename; }',
        'function stripImageGenerationMeta(item){ return item; }',
        'let appended = null;',
        'function replaceOutputsToNodeWithHistory(node, additions){ appended = additions; }',
        'function render(){}',
        'function rememberRoundOutputs(){ return []; }',
        'function mediaKindForUrls(urls, fallback){ return fallback || "image"; }',
        'const smartLoopContext = {};',
    ];
    const fns = [
        'isVideoMediaItem', 'isAudioMediaItem', 'isTextMediaItem', 'isFileMediaItem',
        'smartOriginalMediaUrl', '_localSmartOriginalMediaUrl', 'mediaKindForItem',
        'safeExportFileName', 'fileNameFromUrl',
        'stripSmartExportMediaExt', 'smartExportBaseName',
        'extensionForMediaItem', 'downloadNameForMediaItem', 'zipDownloadImageItems',
        'appendCascadeRefsToReceiver',
    ].map(name => topLevelFunction(smartJs, name));
    ['isVideoMediaItem', 'mediaKindForItem', 'extensionForMediaItem', 'downloadNameForMediaItem', 'zipDownloadImageItems', 'appendCascadeRefsToReceiver'].forEach(name => {
        ok(topLevelFunction(smartJs, name) !== '', '智能画布存在 ' + name);
    });
    vm.createContext(smartSandbox);
    vm.runInContext([
        ...prelude,
        ...fns,
        'globalThis.__api = {ext:extensionForMediaItem, downloadName:downloadNameForMediaItem, zip:zipDownloadImageItems, append:appendCascadeRefsToReceiver, state:()=>({lastFetch, lastDownload, appended})};',
    ].join('\n'), smartSandbox);
    const smart = smartSandbox.__api;

    ok(smart.ext({url:'/output/abc123', kind:'video'}) === '.mp4', '无扩展名本地视频 URL → .mp4（实际 ' + smart.ext({url:'/output/abc123', kind:'video'}) + '）');
    ok(smart.ext({name:'output-1.png', kind:'video'}) === '.mp4', 'kind=video 时 name 的 .png 不作数（实际 ' + smart.ext({name:'output-1.png', kind:'video'}) + '）');
    ok(smart.ext({url:'https://x.y.com/a/b', kind:'video'}) === '.mp4', '远程无扩展名视频 URL → .mp4（实际 ' + smart.ext({url:'https://x.y.com/a/b', kind:'video'}) + '）');
    ok(smart.ext({url:'/output/pic.png', kind:'image'}) === '.png', '正常 png 图片 → .png（实际 ' + smart.ext({url:'/output/pic.png', kind:'image'}) + '）');
    ok(smart.ext({url:'/output/clip.webm', kind:'video'}) === '.webm', 'URL 视频扩展优先于 kind（实际 ' + smart.ext({url:'/output/clip.webm', kind:'video'}) + '）');
    ok(smart.ext({url:'/output/a', kind:'audio'}) === '.mp3', 'kind=audio → .mp3（实际 ' + smart.ext({url:'/output/a', kind:'audio'}) + '）');
    ok(smart.ext({url:'/output/a'}) === '.png', '无扩展名无 kind → 兜底 .png（实际 ' + smart.ext({url:'/output/a'}) + '）');

    console.log('[4] 智能画布：downloadNameForMediaItem 产出可下载文件名');
    const expectTail = (item, want, label) => {
        const name = smart.downloadName(item);
        ok(tail(name) === want, label + '（实际 ' + name + '）');
    };
    expectTail({url:'/output/abc123', name:'output-1.png', kind:'video'}, 'mp4', '本地无扩展名视频 URL + name=output-1.png → .mp4');
    expectTail({url:'/output/abc123', kind:'video'}, 'mp4', '本地无扩展名视频 URL → .mp4');
    expectTail({name:'output-1.png', kind:'video'}, 'mp4', '只有 name=output-1.png 的视频条目 → .mp4');
    expectTail({url:'https://x.y.com/a/b', kind:'video'}, 'mp4', '远程无扩展名视频 URL → .mp4');
    expectTail({url:'/output/pic.png', kind:'image'}, 'png', '正常 png 图片仍 .png');
    expectTail({url:'/output/pic.png'}, 'png', '无 kind 的 png 图片仍 .png');
    expectTail({url:'/output/a', kind:'audio'}, 'mp3', '音频 → .mp3');
    ok(smart.downloadName({name:'v1.2 海报'}) === 'v1.2 海报.png', '名字里的正常点不被当成扩展名（实际 ' + smart.downloadName({name:'v1.2 海报'}) + '）');
    ok(smart.downloadName({name:'report.final'}) === 'report.final', '未知扩展名不被强改成媒体扩展（实际 ' + smart.downloadName({name:'report.final'}) + '）');

    console.log('[5] 智能画布：zipDownloadImageItems 传给后端的 name');
    await smart.zip('视频组', [
        {url:'/output/abc123', name:'output-1.png', kind:'video'},
        {url:'/output/pic.png', name:'pic.png', kind:'image'},
    ]);
    let state = smart.state();
    const body = JSON.parse(state.lastFetch.options.body);
    ok(body.items.length === 2, 'zip 条目数 2（实际 ' + body.items.length + '）');
    ok(tail(body.items[0].name) === 'mp4', '无扩展名视频条目在 zip 里是 .mp4（实际 ' + body.items[0].name + '）');
    ok(!/\.png$/i.test(body.items[0].name), '无扩展名视频条目不再是 .png（实际 ' + body.items[0].name + '）');
    ok(tail(body.items[1].name) === 'png', '图片条目仍是 .png（实际 ' + body.items[1].name + '）');

    console.log('[6] 智能画布：appendCascadeRefsToReceiver 的兜底文件名');
    smart.append({id:'n1', images:[]}, [{url:'/output/abc123', kind:'video'}], {nodeId:''});
    let appended = smart.state().appended || [];
    ok(appended.length === 1, '级联追加 1 个条目（实际 ' + appended.length + '）');
    ok(appended[0] && appended[0].name === 'output-1.mp4', '无 name 的视频 ref 兜底为 .mp4（实际 ' + (appended[0] && appended[0].name) + '）');
    smart.append({id:'n1', images:[]}, [{url:'/output/a', kind:'audio'}], {nodeId:''});
    appended = smart.state().appended || [];
    ok(appended[0] && appended[0].name === 'output-1.mp3', '无 name 的音频 ref 兜底为 .mp3（实际 ' + (appended[0] && appended[0].name) + '）');
    smart.append({id:'n1', images:[]}, [{url:'/output/pic.png', kind:'image'}], {nodeId:''});
    appended = smart.state().appended || [];
    ok(appended[0] && appended[0].name === 'output-1.png', '无 name 的图片 ref 兜底为 .png（实际 ' + (appended[0] && appended[0].name) + '）');
    smart.append({id:'n1', images:[]}, [{url:'/output/a.mp4', name:'clip.mp4', kind:'video'}], {nodeId:''});
    appended = smart.state().appended || [];
    ok(appended[0] && appended[0].name === 'clip.mp4', '自带 name 的 ref 保持原样（实际 ' + (appended[0] && appended[0].name) + '）');

    console.log('[7] 静态接线（防止以后又把 .png 写死回来）');
    const extFn = topLevelFunction(smartJs, 'extensionForMediaItem');
    ok(!/item\?\.name/.test(extFn), 'extensionForMediaItem 不再参考 name 里的扩展名');
    ok(/mp4\|webm\|mov\|m4v\|mkv\|avi/.test(extFn), 'extensionForMediaItem 带视频扩展白名单');
    ok(/mediaKindForItem\(item\)/.test(extFn), 'extensionForMediaItem 仍按 mediaKindForItem 兜底 kind');
    const appendFn = topLevelFunction(smartJs, 'appendCascadeRefsToReceiver');
    ok(!/output-\$\{i \+ 1\}\.png/.test(appendFn), 'appendCascadeRefsToReceiver 不再把兜底名写死 .png');
    ok(/extensionForMediaItem\(/.test(appendFn), 'appendCascadeRefsToReceiver 的兜底名按 extensionForMediaItem 生成');
    ok(/downloadNameForMediaItem\(item/.test(topLevelFunction(smartJs, 'zipDownloadImageItems')), 'zip 条目名仍走 downloadNameForMediaItem');

    console.log('');
    console.log('下载文件名后缀回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
    fails.forEach(f => console.log('  ✗ ' + f));
    if(fails.length) process.exit(1);
})();
