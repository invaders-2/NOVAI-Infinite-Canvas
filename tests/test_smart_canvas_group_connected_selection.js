#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const start = source.indexOf('function groupSelectedNodes(){');
const end = source.indexOf('\n}', start);
if(start < 0 || end < 0) throw new Error('找不到 groupSelectedNodes');
const fn = source.slice(start, end + 2);
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }

function harness(connections){
    const sandbox = {console};
    vm.createContext(sandbox);
    vm.runInContext([
        'let nodes = [{id:"a",type:"smart-text",x:100,y:120,text:"A"},{id:"b",type:"smart-text",x:620,y:360,text:"B"}];',
        'let selectedIds = ["a", "b"];',
        'let selectedId = "";',
        'let selectedImage = {nodeId:"",index:-1};',
        'const canvas = {connections:' + JSON.stringify(connections) + '};',
        'let arrangeCalls = 0;',
        'function isSmartGroupNode(node){ return node && node.type === "smart-group"; }',
        'function nodeRect(node){ return {x:node.x,y:node.y,width:220,height:120}; }',
        'function uid(){ return "group-1"; }',
        'function pushUndo(){}',
        'function addNodeToSmartGroup(group,node){ group.items.push(node.id); }',
        'function arrangeSmartGroupMembers(){ arrangeCalls += 1; }',
        'function render(){}',
        'function scheduleSave(){}',
        'function toast(){}',
        fn,
        'globalThis.__group = {',
        '    run(){ groupSelectedNodes(); },',
        '    nodes(){ return nodes; },',
        '    arrangeCalls(){ return arrangeCalls; }',
        '};'
    ].join('\n'), sandbox);
    return sandbox.__group;
}

const connected = harness([{from:'a',to:'b',kind:'input'}]);
connected.run();
ok(connected.arrangeCalls() === 0, '选中节点彼此相连时不自动整理');
ok(connected.nodes().find(node => node.id === 'a').x === 100 && connected.nodes().find(node => node.id === 'b').x === 620, '彼此相连的节点保留原坐标');

const outgoing = harness([{from:'a',to:'outside',kind:'input'}]);
outgoing.run();
ok(outgoing.arrangeCalls() === 0, '选中节点连到选区外时也不自动整理');

const unconnected = harness([]);
unconnected.run();
ok(unconnected.arrangeCalls() === 1, '没有连线的选区仍按原逻辑自动整理');
ok(unconnected.nodes().find(node => node.id === 'b').y === 360, '自动整理前不额外改写成员坐标');

console.log('全选建组连线保持位置：' + pass + ' 项通过');
if(failures.length){
    failures.forEach(label => console.error('  x ' + label));
    process.exit(1);
}
