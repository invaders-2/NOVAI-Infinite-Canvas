#!/usr/bin/env node
/* 导出文件名：标题/图片名末尾自带的媒体扩展名必须先剥掉，再拼目标扩展。
   覆盖三个导出模块（智能画布 / 经典画布 / 画布列表）：
   - 基名只剥末尾已知的媒体/文档扩展，不误删“v1.2 海报”里的点；
   - 多图 zip、工作流 JSON/ZIP、画布 PNG/SVG 文件名都只保留单扩展；
   - zip 内条目名保持“名称.单媒体扩展”。
   跑法：node tests/test_export_filename_ext.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const smartJs = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
const canvasJs = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');
const listJs = fs.readFileSync(path.join(root, 'static/js/canvas-list.js'), 'utf8');

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
function runSandbox(lines){
    const sandbox = {console};
    vm.createContext(sandbox);
    vm.runInContext(lines.join('\n'), sandbox);
    return sandbox;
}

const STRIP_CASES = [
    ['图57.png', '图57', '去掉 .png'],
    ['图57.jpg', '图57', '去掉 .jpg'],
    ['clip.mp4', 'clip', '去掉 .mp4'],
    ['voice.m4a', 'voice', '去掉 .m4a'],
    ['workflow.json', 'workflow', '去掉 .json'],
    ['包.zip', '包', '去掉 .zip'],
    ['图57.PNG', '图57', '扩展名大小写不敏感'],
    ['  图57.webp  ', '图57', '首尾空白不影响剥离'],
    ['图57', '图57', '无扩展名原样保留'],
    ['v1.2 海报', 'v1.2 海报', '不误删正常名字里的点'],
    ['v1.2 海报.png', 'v1.2 海报', '只剥末尾扩展名，保留中间的 v1.2'],
    ['report.final.json', 'report.final', '多段名字只剥最后一段扩展'],
    ['图57.png.zip', '图57', '叠了多层扩展也全部剥掉'],
    ['a.webm.zip', 'a', '混合扩展名也全部剥掉'],
    ['.png', '', '只有扩展名时剥成空（由 fallback 兜底）'],
];

(async () => {
    console.log('[1] 智能画布：基名剥离 + 三个导出出口');
    const smartSandbox = runSandbox([
        'let canvas = {title:"图57.png"};',
        'const document = {getElementById:()=>null};',
        'let lastFetch = null;',
        'let lastDownload = "";',
        'function fetch(url, options){ lastFetch = {url, options}; return Promise.resolve({ok:true, blob:()=>Promise.resolve({})}); }',
        'function downloadBlob(blob, filename){ lastDownload = filename; }',
        'function toast(){}',
        'const window = {location:{href:"http://127.0.0.1/static/smart-canvas.html"}};',
        'function mediaKindForItem(){ return "image"; }',
        topLevelFunction(smartJs, 'safeExportFileName'),
        topLevelFunction(smartJs, 'fileNameFromUrl'),
        topLevelFunction(smartJs, 'extensionForMediaItem'),
        topLevelFunction(smartJs, 'downloadNameForMediaItem'),
        topLevelFunction(smartJs, 'stripSmartExportMediaExt'),
        topLevelFunction(smartJs, 'smartExportBaseName'),
        topLevelFunction(smartJs, 'smartWorkflowFilename'),
        topLevelFunction(smartJs, 'smartCanvasExportTitle'),
        topLevelFunction(smartJs, 'smartCanvasExportFilename'),
        topLevelFunction(smartJs, 'zipDownloadImageItems'),
        'globalThis.__api = {strip:stripSmartExportMediaExt, base:smartExportBaseName, workflow:smartWorkflowFilename, canvasTitle:smartCanvasExportTitle, canvasFile:smartCanvasExportFilename, downloadName:downloadNameForMediaItem, zip:zipDownloadImageItems, state:()=>({lastFetch, lastDownload}), setTitle:t=>{canvas = {title:t};}};',
    ]);
    const smart = smartSandbox.__api;
    ok(topLevelFunction(smartJs, 'stripSmartExportMediaExt') !== '', '智能画布存在 stripSmartExportMediaExt');
    ok(topLevelFunction(smartJs, 'smartExportBaseName') !== '', '智能画布存在 smartExportBaseName');
    STRIP_CASES.forEach(([input, want, label]) => {
        const got = smart.strip(input);
        ok(got === want, '智能画布 strip(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want) + '（' + label + '）');
    });
    ok(smart.base('', 'image-group') === 'image-group', '智能画布空标题回落到 fallback');
    ok(smart.base('a/b', 'x') === 'a_b', '智能画布非法字符仍替换为下划线');
    ok(smart.base('图57.png', 'x') === '图57', '智能画布 base 复用 safeExportFileName 的清洗');

    smart.setTitle('图57.png');
    ok(/^图57-workflow-\d{14}\.json$/.test(smart.workflow('json')), '工作流 JSON：' + smart.workflow('json'));
    ok(/^图57-workflow-\d{14}\.zip$/.test(smart.workflow('zip')), '工作流 ZIP：' + smart.workflow('zip'));
    ok(smart.canvasTitle() === '图57', '画布导出标题：' + smart.canvasTitle());
    ok(/^novai-canvas-图57-\d{14}\.png$/.test(smart.canvasFile('png')), '画布 PNG：' + smart.canvasFile('png'));
    ok(/^novai-canvas-图57-\d{14}\.svg$/.test(smart.canvasFile('svg')), '画布 SVG：' + smart.canvasFile('svg'));

    smart.setTitle('v1.2 海报.png');
    ok(/^v1\.2-海报-workflow-\d{14}\.zip$/.test(smart.workflow('zip')), '标题含正常点：' + smart.workflow('zip'));
    ok(/^novai-canvas-v1\.2-海报-\d{14}\.png$/.test(smart.canvasFile('png')), '画布文件名保留 v1.2：' + smart.canvasFile('png'));

    smart.setTitle('图57');
    ok(/^图57-workflow-\d{14}\.zip$/.test(smart.workflow('zip')), '标题无扩展名时行为不变：' + smart.workflow('zip'));

    ok(smart.downloadName({name:'图57.png', url:'/output/online_aaa.png'}, 'image') === 'online_aaa.png', '单图下载优先用 URL 文件名');
    ok(smart.downloadName({name:'图57.png', url:'/output/no-extension'}, 'image') === 'no-extension.png', '单图下载无扩展时补 .png：' + smart.downloadName({name:'图57.png', url:'/output/no-extension'}, 'image'));
    ok(smart.downloadName({name:'图57.png'}, 'image') === '图57.png', '单图下载已有扩展不重复追加：' + smart.downloadName({name:'图57.png'}, 'image'));
    ok(smart.downloadName({name:'clip.mp4', url:'/output/video.mp4'}, 'image') === 'video.mp4', '单图下载视频保持 .mp4：' + smart.downloadName({name:'clip.mp4', url:'/output/video.mp4'}, 'image'));

    smart.setTitle('图57.png');
    await smart.zip('图57.png', [
        {url:'/output/online_a.png', name:'online_a.png'},
        {url:'/output/online_b.jpg', name:'online_b.jpg'},
        {url:'/output/clip.mp4', name:'clip.mp4'},
    ]);
    let state = smart.state();
    let body = JSON.parse(state.lastFetch.options.body);
    ok(body.filename === '图57.zip', '多图 zip 请求文件名：' + body.filename);
    ok(state.lastDownload === '图57.zip', '多图 zip 下载文件名：' + state.lastDownload);
    ok(body.items.map(item => item.name).join(',') === 'online_a.png,online_b.jpg,clip.mp4', 'zip 内条目名保持单扩展：' + body.items.map(item => item.name).join(','));

    console.log('[2] 经典画布：基名剥离 + 三个导出出口');
    const canvasSandbox = runSandbox([
        'let canvas = {title:"图57.png"};',
        'const tr = key => key;',
        'function responseErrorMessage(){ return "empty"; }',
        'function alert(){}',
        'function outputDownloadableImageUrls(){ return ["/output/online_a.png"]; }',
        'function groupImageItems(){ return [{url:"/output/online_a.png", name:"online_a.png", kind:"image"}]; }',
        'function downloadNameForGroupImage(){ return "online_a.png"; }',
        'let lastFetch = null;',
        'let lastDownload = "";',
        'const window = {NovaUtils:{downloadBlob:(blob, filename)=>{ lastDownload = filename; }}};',
        'const NovaUtils = window.NovaUtils;',
        'function fetch(url, options){ lastFetch = {url, options}; return Promise.resolve({ok:true, blob:()=>Promise.resolve({})}); }',
        topLevelFunction(canvasJs, 'safeDownloadFileName'),
        topLevelFunction(canvasJs, 'stripExportMediaExt'),
        topLevelFunction(canvasJs, 'exportFileNameBase'),
        topLevelFunction(canvasJs, 'workflowFilename'),
        topLevelFunction(canvasJs, 'downloadOutputNodeImages'),
        topLevelFunction(canvasJs, 'downloadGroupNodeImages'),
        'let nodes = [{id:"n1", type:"output", url:"/output/online_a.png"}, {id:"g1", type:"group", items:["n1"]}];',
        'globalThis.__api = {strip:stripExportMediaExt, base:exportFileNameBase, workflow:workflowFilename, outputZip:downloadOutputNodeImages, groupZip:downloadGroupNodeImages, state:()=>({lastFetch, lastDownload}), setTitle:t=>{canvas = {title:t};}};',
    ]);
    const classic = canvasSandbox.__api;
    ok(topLevelFunction(canvasJs, 'stripExportMediaExt') !== '', '经典画布存在 stripExportMediaExt');
    STRIP_CASES.forEach(([input, want, label]) => {
        const got = classic.strip(input);
        ok(got === want, '经典画布 strip(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want) + '（' + label + '）');
    });
    classic.setTitle('图57.png');
    ok(/^图57-\d{8}T\d{6}\.json$/.test(classic.workflow('json')), '经典工作流 JSON：' + classic.workflow('json'));
    ok(/^图57-\d{8}T\d{6}\.zip$/.test(classic.workflow('zip')), '经典工作流 ZIP：' + classic.workflow('zip'));

    classic.setTitle('图57.png');
    await classic.outputZip('n1');
    let result = classic.state();
    body = JSON.parse(result.lastFetch.options.body);
    ok(body.filename === '图57-n1.zip', '输出节点 zip 请求文件名：' + body.filename);
    ok(result.lastDownload === '图57-n1.zip', '输出节点 zip 下载文件名：' + result.lastDownload);

    classic.setTitle('图57.png');
    await classic.groupZip('g1');
    result = classic.state();
    body = JSON.parse(result.lastFetch.options.body);
    ok(body.filename === '图57-g1.zip', '分组 zip 请求文件名：' + body.filename);
    ok(result.lastDownload === '图57-g1.zip', '分组 zip 下载文件名：' + result.lastDownload);
    ok(body.items.every(item => /^[^/]+\.(png|jpg|jpeg|webp|gif|bmp|svg|mp4|webm|mov|mp3|wav|m4a)$/i.test(item.name)), '分组 zip 内条目名单扩展：' + body.items.map(item => item.name).join(','));

    classic.setTitle('v1.2 海报.png');
    ok(/^v1\.2 海报-\d{8}T\d{6}\.zip$/.test(classic.workflow('zip')), '经典画布标题含正常点：' + classic.workflow('zip'));

    console.log('[3] 画布列表：导出画布 JSON / 含资源 ZIP');
    const listSandbox = runSandbox([
        topLevelFunction(listJs, 'safeExportBase'),
        topLevelFunction(listJs, 'exportCanvasBaseName'),
        'globalThis.__api = {base:exportCanvasBaseName};',
    ]);
    const listApi = listSandbox.__api;
    ok(topLevelFunction(listJs, 'exportCanvasBaseName') !== '', '画布列表存在 exportCanvasBaseName');
    ok(listApi.base('图57.png', 'canvas') === '图57', '画布列表 zip 基名：' + listApi.base('图57.png', 'canvas'));
    ok(listApi.base('图57.png.zip', 'canvas') === '图57', '画布列表叠扩展名：' + listApi.base('图57.png.zip', 'canvas'));
    ok(listApi.base('v1.2 海报', 'canvas') === 'v1.2 海报', '画布列表保留正常点：' + listApi.base('v1.2 海报', 'canvas'));
    ok(listApi.base('', 'canvas') === 'canvas', '画布列表空标题回落到 canvas');

    console.log('[4] 静态接线（防止以后又写回 title + 扩展名）');
    ok(/smartExportBaseName\(title, 'image-group'\)/.test(topLevelFunction(smartJs, 'zipDownloadImageItems')), '多图 zip 用基名处理');
    ok(!/\.zip/.test(topLevelFunction(smartJs, 'smartWorkflowFilename')), '智能工作流不再直接拼扩展');
    ok(/smartExportBaseName/.test(topLevelFunction(smartJs, 'smartCanvasExportTitle')), '画布导出标题用基名处理');
    ok(/exportFileNameBase\(canvas\?\.title/.test(topLevelFunction(canvasJs, 'workflowFilename')), '经典工作流用基名处理');
    ok(/exportFileNameBase\(canvas\?\.title/.test(topLevelFunction(canvasJs, 'downloadOutputNodeImages')), '经典输出节点 zip 用基名处理');
    ok(/exportFileNameBase\(canvas\?\.title/.test(topLevelFunction(canvasJs, 'downloadGroupNodeImages')), '经典分组 zip 用基名处理');
    ok(/exportCanvasBaseName/.test(topLevelFunction(listJs, 'exportCanvas')), '画布列表 JSON 导出用基名处理');
    ok(/exportCanvasBaseName/.test(topLevelFunction(listJs, 'exportCanvasWithResources')), '画布列表含资源 ZIP 用基名处理');

    console.log('');
    console.log('导出基名 / 文件名回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
    fails.forEach(f => console.log('  ✗ ' + f));
    if(fails.length) process.exit(1);
})();
