#!/usr/bin/env node
/* 无损改图上传前的体积/尺寸保护回归：
   1) 纯函数直接跑：canvas 上限降采样、阶梯降尺寸保持比例、有透明先 PNG 后白底 JPEG；
   2) 失败响应 detail 透传（后端 413 的中文说明不再被吞成笼统「上传失败」）；
   3) 源码接线：applyLosslessEdit 先压缩再上传、压缩成功给 toast。
   跑法：node tests/test_lossless_edit_upload_guard.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(actual === expected, label + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual));

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
function topLevelConst(src, name){
    const line = src.split('\n').find(item => item.startsWith('const ' + name + ' ='));
    return line || '';
}

const sandboxSrc = [
    topLevelConst(js, 'LOSSLESS_EDIT_MAX_UPLOAD_BYTES'),
    topLevelConst(js, 'CANVAS_MAX_SIDE'),
    topLevelConst(js, 'CANVAS_MAX_PIXELS'),
    topLevelFunction(js, 'fitWithinCanvasLimits'),
    topLevelFunction(js, 'scaleToMaxSide'),
    topLevelFunction(js, 'losslessEditCompressSteps'),
    topLevelFunction(js, 'aiUploadErrorDetail'),
    'globalThis.__api = {fitWithinCanvasLimits, scaleToMaxSide, losslessEditCompressSteps, aiUploadErrorDetail};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox);
const api = sandbox.__api;

console.log('[1] 常量与函数都在（源文件里是顶层的可抽取函数）');
ok(api && typeof api.fitWithinCanvasLimits === 'function', 'fitWithinCanvasLimits 可抽取');
ok(typeof api.scaleToMaxSide === 'function', 'scaleToMaxSide 可抽取');
ok(typeof api.losslessEditCompressSteps === 'function', 'losslessEditCompressSteps 可抽取');
ok(typeof api.aiUploadErrorDetail === 'function', 'aiUploadErrorDetail 可抽取');
eq(vm.runInContext('LOSSLESS_EDIT_MAX_UPLOAD_BYTES', sandbox), 45 * 1024 * 1024, '体积保护阈值 45MB');
eq(vm.runInContext('CANVAS_MAX_SIDE', sandbox), 16384, 'canvas 单边上限 16384');
eq(vm.runInContext('CANVAS_MAX_PIXELS', sandbox), 260000000, 'canvas 面积上限 2.6 亿像素');

console.log('[2] fitWithinCanvasLimits：浏览器 canvas 上限内不变，超限等比降采样');
let r = api.fitWithinCanvasLimits(1000, 800);
ok(r.width === 1000 && r.height === 800 && r.scale === 1, '1000x800 原样返回');
r = api.fitWithinCanvasLimits(20000, 10000);
eq(r.width, 16384, '20000x10000 先被单边 16384 收住');
eq(r.height, 8192, '降采样保持比例');
ok(r.scale < 1 && r.scale > 0.8, '缩放比例在 (0.8,1) 内');
r = api.fitWithinCanvasLimits(30000, 30000);
ok(r.width <= 16384 && r.height <= 16384, '30000 见方也不超单边（实测 ' + r.width + 'x' + r.height + '）');
ok(r.width * r.height <= 260000000, '像素数不超 2.6 亿（实测 ' + (r.width * r.height) + '）');
ok(r.width >= 16100 && r.width <= 16384, '面积上限逼出的边长合理（实测 ' + r.width + '）');
r = api.fitWithinCanvasLimits(40000, 1000);
ok(r.width <= 16384 && r.height >= 400, '极端长条仍保持比例（实测 ' + r.width + 'x' + r.height + '）');
ok(api.fitWithinCanvasLimits(0, 0).width === 0, '0 尺寸不崩');

console.log('[3] scaleToMaxSide：按最长边等比缩，未超限不动');
r = api.scaleToMaxSide(10000, 5000, 8192);
ok(r.width === 8192 && r.height === 4096, '10000x5000 缩到 8192x4096（实测 ' + r.width + 'x' + r.height + '）');
r = api.scaleToMaxSide(4000, 3000, 8192);
ok(r.width === 4000 && r.height === 3000, '未超 maxSide 不缩');
r = api.scaleToMaxSide(800, 2400, 0);
ok(r.width === 800 && r.height === 2400, 'maxSide=0 表示保尺寸');

console.log('[4] losslessEditCompressSteps：无透明先保尺寸 JPEG q95，有透明先 PNG');
const jpegSteps = api.losslessEditCompressSteps(false);
eq(jpegSteps.length, 6, '无透明 6 档（保尺寸 + 8192/6144/4096/3072/2048）');
ok(jpegSteps[0].format === 'image/jpeg' && jpegSteps[0].maxSide === 0, '无透明第一档：JPEG 保尺寸');
eq(jpegSteps[0].quality, 0.95, '无透明 JPEG 质量 q95');
eq(jpegSteps.slice(1).map(s => s.maxSide).join(','), '8192,6144,4096,3072,2048', '阶梯从 8192 递减到 2048');
ok(jpegSteps.every(s => s.format === 'image/jpeg' && !s.flatten), '无透明不会走白底压平');
const pngSteps = api.losslessEditCompressSteps(true);
ok(pngSteps[0].format === 'image/png' && pngSteps[0].maxSide === 0, '有透明第一档：PNG 保尺寸');
ok(pngSteps[1].format === 'image/png' && pngSteps[1].maxSide === 8192, '有透明第二档：PNG 最长边 8192');
ok(pngSteps.some(s => s.format === 'image/jpeg' && s.flatten), 'PNG 全压不下来时有白底 JPEG 兜底');
ok(pngSteps.findIndex(s => s.format === 'image/jpeg') > pngSteps.filter(s => s.format === 'image/png').length - 1,
   'JPEG 兜底排在所有 PNG 档之后');

console.log('[5] aiUploadErrorDetail：后端 detail 透传，解析失败也带 HTTP 状态');
eq(api.aiUploadErrorDetail({detail: '原图 60.2MB，压缩后仍有 51.0MB'}, 413), '原图 60.2MB，压缩后仍有 51.0MB', 'FastAPI 的 detail 原样带出');
eq(api.aiUploadErrorDetail({error: 'boom'}, 500), 'boom', 'error 字段兜底');
eq(api.aiUploadErrorDetail(null, 413), 'HTTP 413', '响应不是 JSON 时至少带状态码');
eq(api.aiUploadErrorDetail({}, 0), '响应无法解析', '没有状态也没有 detail 时的兜底文案');
const arrayDetail = api.aiUploadErrorDetail({detail: [{loc: ['body', 'files'], msg: 'field required'}]}, 422);
ok(arrayDetail.indexOf('field required') >= 0, '数组型 detail（校验错误）会序列化带出');

console.log('[6] 源码接线');
const upload = topLevelFunction(js, 'uploadCroppedBlob');
ok(upload.indexOf('lastAiUploadError') >= 0 && upload.indexOf('aiUploadErrorDetail') >= 0,
   'uploadCroppedBlob 失败时把 detail 记到 lastAiUploadError');
ok(upload.indexOf('response.ok') >= 0, 'uploadCroppedBlob 按 HTTP 状态判失败');
ok(!/return data\.files\?\.\[0\]/.test(upload), '旧的笼统取 files[0] 写法已替换');
const apply = topLevelFunction(js, 'applyLosslessEdit');
ok(apply.indexOf('blob.size > LOSSLESS_EDIT_MAX_UPLOAD_BYTES') >= 0, '上传前按 45MB 判体积');
ok(apply.indexOf('losslessEditCompressBlob(blob, uploadName, LOSSLESS_EDIT_MAX_UPLOAD_BYTES)') >= 0, '超限时先 canvas 重编码');
ok(apply.indexOf('原图较大，已自动压缩后应用') >= 0, '压缩成功给 toast 说明');
ok(apply.indexOf('图片上传失败：') >= 0 && apply.indexOf('lastAiUploadError') >= 0, '上传失败把后端 detail 带进 toast');
ok(/upload\(uploadBlob, uploadName\)/.test(apply), '上传用的是压缩后的 blob 和对应扩展名');
const compress = topLevelFunction(js, 'losslessEditCompressBlob');
ok(compress.indexOf('fitWithinCanvasLimits(img.naturalWidth, img.naturalHeight)') >= 0, '重编码前先按 canvas 上限降采样');
ok(compress.indexOf('scaleToMaxSide') >= 0, '阶梯降尺寸保持比例');
ok(compress.indexOf('out.size <= maxBytes') >= 0, '只采用不超过阈值的产物');
const draw = topLevelFunction(js, 'losslessEditDrawToBlob');
ok(draw.indexOf('toBlob') >= 0 && draw.indexOf('willReadFrequently') < 0, '绘制走 canvas.toBlob');
ok(topLevelFunction(js, 'uploadImageBlobs').indexOf('/api/ai/upload') >= 0, '素材多图上传入口未被改动');

console.log('');
console.log('[结果] ' + (fails.length ? 'FAIL' : 'PASS') + ' ' + (pass - fails.length) + '/' + pass);
if(fails.length){
    fails.forEach(item => console.log('  - ' + item));
    process.exit(1);
}
process.exit(0);
