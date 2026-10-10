/* 智能画布「替换素材」回归测试。
   用户需求：图片 / 视频节点右上角按钮组里的一颗悬浮按钮（lucide image-plus，在删除键左侧），点开面板可从
   本地文件 / 粘贴 URL / 素材库三处挑素材，把节点里的素材整体换掉；
   节点 ID、位置、尺寸、连线、上下游关系、分组归属全部不动；
   候选素材类型与目标不一致时零写入（不 pushUndo、不改 node.images）。
   跑法：node tests/test_smart_canvas_replace_media.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 入口：节点右上角悬浮按钮 + 动作分发');
const entryLine = js.split('\n').find(line => line.includes('data-smart-node-action="replace"')) || '';
ok(/floating-node-actions[\s\S]*?data-smart-node-action="replace"[\s\S]*?node-delete/.test(entryLine), '入口并入右上角按钮组、位于删除键左侧');
ok(/\.floating-node-actions \{[^}]*display:flex[^}]*gap:6px[^}]*\}/.test(css) && /\.floating-node-actions > \.mini-x \{[^}]*flex:0 0 auto/.test(css) && !/floating-node-actions-left/.test(css), 'CSS：右上按钮组 flex + gap:6px，旧左上容器已移除');
// 替换键的底色必须不透明：按钮背后是任意照片，透明底 + 主题文字色会让图标随图片明暗消失
const replaceRuleBodies = [...css.matchAll(/\.floating-node-actions[^{}]*node-replace[^{}]*\{([^}]*)\}/g)].map(match => match[1]);
ok(replaceRuleBodies.length > 0 && !replaceRuleBodies.some(body => /background\s*:\s*transparent/.test(body)) && /\.theme-dark \.floating-node-actions \.mini-x \{[^}]*background:rgba\(28, 28, 28, \.86\)/.test(css),
    'CSS：替换键不再用 background:transparent，且深色模式下右上按钮组走不透明深底');
ok(/data-smart-node-action="replace"[^>]*data-node-id=/.test(entryLine), '按钮带 data-smart-node-action="replace" + data-node-id');
ok(/data-lucide="image-plus"/.test(entryLine), '图标用 lucide image-plus');
ok(/imgs\.some\(img => img\?\.url\)/.test(entryLine), '只在节点有素材时渲染');

const actionFn = topLevelFunction(js, 'runSmartNodeToolbarAction');
ok(actionFn.length > 0, '有 runSmartNodeToolbarAction');
ok(/action === 'replace'/.test(actionFn), 'runSmartNodeToolbarAction 有 replace 分支');
ok(/action === 'replace'[\s\S]{0,260}openReplaceMediaPanel\(node\)/.test(actionFn), 'replace 分支打开替换面板');

console.log('[2] 面板：三个来源 + openSmartToolPanel');
const panelFn = topLevelFunction(js, 'openReplaceMediaPanel');
ok(panelFn.length > 0, '有 openReplaceMediaPanel');
ok(/openSmartToolPanel\(\{/.test(panelFn) && /id:'replace'/.test(panelFn) && /anchor:'replace'/.test(panelFn) && /icon:'image-plus'/.test(panelFn),
    '走 openSmartToolPanel（id/anchor=replace、icon=image-plus）');
ok(/input\.accept = 'image\/\*,video\/\*'/.test(js), '本地文件 input 接受 image/*,video/*');
ok(/uploadFiles\(files\)/.test(js), '本地文件走 uploadFiles');
ok(/smartImageNameFromUrl\(url\)/.test(js), '粘贴 URL 用 smartImageNameFromUrl 造 item');
ok(/loadAssetLibrary\(\)/.test(js) && /assetCategories\('image'\)/.test(js) && /assetThumbHtml\(item\)/.test(js),
    '素材库：loadAssetLibrary + assetCategories(image) + assetThumbHtml');
ok(/try \{[\s\S]{0,220}await uploadFiles\(files\)[\s\S]{0,220}\} catch\(error\)/.test(js), '上传走 try-catch');

console.log('[3] replaceSmartNodeMedia：整组替换、ID/位置/尺寸/连线不动');
const fnSrc = topLevelFunction(js, 'replaceSmartNodeMedia');
ok(fnSrc.length > 0, '有 replaceSmartNodeMedia');

const stubKind = item => {
    if(!item) return 'image';
    if(item.kind) return item.kind;
    const url = String(item.url || '').toLowerCase();
    if(/\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/.test(url)) return 'video';
    if(/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/.test(url)) return 'audio';
    if(/\.(txt|json|csv|srt|vtt|md)(\?|$)/.test(url)) return 'text';
    return 'image';
};
let assetSeq = 0;
const state = { undo:0, render:0, save:0, toasts:[] };
const makeReplace = () => new Function('deps', [
    'const { imageForDisplay, mediaKindForItem, smartNodeToolbarImageIndex, ensureSmartImageAssetId, uploadTitleForItems, pushUndo, render, scheduleSave, toast, tr } = deps;',
    fnSrc,
    'return replaceSmartNodeMedia;'
].join('\n'))({
    imageForDisplay: item => item,
    mediaKindForItem: stubKind,
    smartNodeToolbarImageIndex: () => 0,
    ensureSmartImageAssetId: img => {
        if(!img.asset_id) img.asset_id = 'asset_test_' + (++assetSeq);
        if(!img.created_at) img.created_at = 1;
        if(!img.source) img.source = 'canvas';
        return img;
    },
    uploadTitleForItems: (items, fallback) => {
        const kinds = new Set(items.map(item => stubKind(item)));
        if(kinds.size > 1) return items.length > 1 ? 'Media' : fallback;
        if(kinds.has('video')) return items.length > 1 ? 'Videos' : 'Video';
        if(kinds.has('audio')) return 'Audio';
        return items.length > 1 ? 'Group' : 'Image';
    },
    pushUndo: () => { state.undo += 1; },
    render: () => { state.render += 1; },
    scheduleSave: () => { state.save += 1; },
    toast: text => { state.toasts.push(text); },
    tr: key => key
});

const replace = makeReplace();
const canvas = { connections:[{from:'smart_a', to:'smart_b'}] };
const node = {
    id:'smart_a', type:'smart-image', x:120, y:64, w:480, h:320, scale:2,
    title:'Image', created_at:111, runSettings:{model:'x'},
    images:[{url:'old.png', name:'old.png', kind:'image', asset_id:'asset_old'}]
};
const before = JSON.stringify({
    id:node.id, x:node.x, y:node.y, w:node.w, h:node.h, scale:node.scale,
    created_at:node.created_at, runSettings:node.runSettings,
    connections:canvas.connections
});
const connectionsBefore = JSON.stringify(canvas.connections);

const changed = replace(node, [{url:'new-a.png', name:'new-a.png'}, {url:'new-b.png', name:'new-b.png'}]);
ok(changed === true, '替换成功返回 true');
ok(node.id === 'smart_a' && node.x === 120 && node.y === 64 && node.w === 480 && node.h === 320, 'node.id / x / y / w / h 不变');
ok(node.scale === 2 && node.created_at === 111 && JSON.stringify(node.runSettings) === '{"model":"x"}', 'scale / created_at / runSettings 不变');
ok(JSON.stringify(canvas.connections) === connectionsBefore, 'canvas.connections 不变');
ok(JSON.stringify({ id:node.id, x:node.x, y:node.y, w:node.w, h:node.h, scale:node.scale, created_at:node.created_at, runSettings:node.runSettings, connections:canvas.connections }) === before,
    '整组不可变字段快照一致');
ok(node.images.length === 2 && node.images[0].url === 'new-a.png' && node.images[1].url === 'new-b.png', 'node.images 换成了新素材');
ok(node.images.every(item => !!item.asset_id), '新素材都带 asset_id');
ok(node.images.every(item => item.kind === 'image'), '新素材 kind 已落定');
ok(node.title === 'Group', 'title 按素材数量重算（uploadTitleForItems）');
ok(state.undo === 1 && state.render === 1 && state.save === 1, 'pushUndo / render / scheduleSave 各一次');
ok(state.toasts.includes('smart.replaceDone'), '成功 toast 已替换素材');

console.log('[4] 类型不匹配：一票否决、零写入');
const videoNode = { id:'smart_v', type:'smart-image', x:1, y:2, w:3, h:4, title:'Video', images:[{url:'old.mp4', name:'old.mp4', kind:'video', asset_id:'asset_v'}] };
const videoBefore = JSON.stringify(videoNode.images);
const undoBefore = state.undo;
const mismatch = replace(videoNode, [{url:'new.png', name:'new.png'}]);
ok(mismatch === false, '给视频节点塞图片返回 false');
ok(JSON.stringify(videoNode.images) === videoBefore, '类型不匹配时 node.images 完全未变');
ok(state.undo === undoBefore, '类型不匹配时没有 pushUndo（零写入）');
ok(state.toasts[state.toasts.length - 1] === 'smart.replaceKindMismatch', 'toast 提示「素材类型不匹配」');
ok(replace(videoNode, []) === false, '空候选返回 false');

const videoMatch = replace(videoNode, [{url:'new.mp4', name:'new.mp4', kind:'video'}]);
ok(videoMatch === true && videoNode.images.length === 1 && videoNode.images[0].url === 'new.mp4', '同类型视频可以正常替换');

console.log('[5] i18n：zh + en 齐全');
['smart.replaceMedia', 'smart.replaceLocal', 'smart.replaceConfirm', 'smart.replaceLibraryEmpty', 'smart.replaceKindMismatch', 'smart.replaceDone'].forEach(key => {
    const esc = key.replace('.', '\\.');
    ok(new RegExp('"' + esc + '"\\s*:\\s*\\{\\s*zh:').test(i18n), 'i18n 有 ' + key + ' 的 zh');
    ok(new RegExp('"' + esc + '"\\s*:\\s*\\{[^}]*en:').test(i18n), 'i18n 有 ' + key + ' 的 en');
});

console.log('');
if(fails.length){
    fails.forEach(label => console.error('  ✗ ' + label));
    console.error('[replace-media] ' + pass + ' 通过, ' + fails.length + ' 失败');
    process.exit(1);
}
console.log('[replace-media] ' + pass + ' 项断言全部通过');
