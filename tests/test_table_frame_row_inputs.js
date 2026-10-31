#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const modelSource = fs.readFileSync(path.join(root, 'static/js/shared/table-model.js'), 'utf8');
const nodeSource = fs.readFileSync(path.join(root, 'static/js/shared/table-node.js'), 'utf8');
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }
function eq(actual, expected, label){ ok(JSON.stringify(actual) === JSON.stringify(expected), label + '（实际 ' + JSON.stringify(actual) + '）'); }

const sandbox = {console, window:{}};
vm.createContext(sandbox);
vm.runInContext(modelSource, sandbox);
vm.runInContext(nodeSource, sandbox);
const first = {id:'first', type:'smart-image', images:[{url:'first.png', kind:'image'}]};
const last = {id:'last', type:'smart-image', images:[{url:'last.png', kind:'image'}]};
const table = {
    id:'table', type:'table', title:'首尾帧',
    table:{kind:'table', version:1, columns:['提示词'], rows:[['从 @图片1 过渡到 @图片2']], selectedRows:[], mergedGroups:[]}
};
const nodes = [first, last, table];
const connections = [
    {from:'first', to:'table', toPort:'input-1'},
    {from:'last', to:'table', toPort:'input-2'}
];
const api = sandbox.window.NovaTableNode({
    tr:key => key, nodes, connections, nodesEl:{}, selected:new Set(),
    addNode(){}, render(){}, scheduleSave(){}, saveCanvas(){}, uid(){ return 'id'; },
    pushUndo(){}, defaultPoint(){}, mediaKindForNode(){ return 'image'; },
    mediaKindForRef(ref){ return ref.kind || 'image'; }, mediaKindForUpload(){ return 'image'; },
    outputUrlValue(item){ return typeof item === 'string' ? item : item && item.url || ''; }, isMissingAssetUrl(){ return false; },
    canvasPreviewImgHtml(){ return ''; }, canvasVideoPreviewHtml(){ return ''; },
    nowMs(){ return 0; }, responseErrorMessage(){}, refreshIcons(){}, renderNode(){},
    runGenerator(){}, runVideoNode(){}, showErrorModal(){}, generationStopRequested(){ return false; }, onBatchSettled(){}
});
const byId = new Map(nodes.map(node => [node.id, node]));
const frameRows = api.tableRowInputs(table, {nodeById:byId, mainMediaLimit:2});
eq(frameRows[0].media.map(item => item.url), ['first.png', 'last.png'], '首尾帧视频行同时保留首帧和尾帧');
eq(frameRows[0].danglingMentions, [], '两张素材都存在时不产生悬空引用');
ok(frameRows[0].prompt.includes('@图片2'), '尾帧 @图片2 引用保留');

const imageRows = api.tableRowInputs(table, {nodeById:byId, mainMediaLimit:1});
eq(imageRows[0].media.map(item => item.url), ['first.png'], '普通图片批量仍是一行一张');
ok(!imageRows[0].prompt.includes('@图片2'), '一行一张时被裁掉的引用同步移除');
ok(frameRows[0].media.length !== imageRows[0].media.length, '素材上限进入缓存键，不串用旧结果');

console.log('表格首尾帧逐行素材：' + pass + ' 项通过');
if(failures.length){
    failures.forEach(label => console.error('  x ' + label));
    process.exit(1);
}
