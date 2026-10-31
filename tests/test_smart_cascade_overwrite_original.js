#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }
function fn(name){
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start);
    if(start < 0 || end < 0) throw new Error('找不到函数 ' + name);
    return source.slice(start, end + 2);
}

const cascade = fn('runSmartCascade');
ok(!cascade.includes('createLoopOutputSlot('), '一键运行不再按轮次创建输出槽');
ok(!cascade.includes('precreateSingleSlots'), '并行轮次也不预建结果节点');
ok(cascade.includes('|| tail,'), '没有现成输出槽时复用原路径节点');
const step = fn('runCascadeStepIntoNode');
ok(!step.includes('createPendingOutputFromSource'), '级联单步不创建分支结果节点');
ok(step.includes('replaceOutputsToNodeWithHistory(outputNode, additions, result.kind'), '级联单步覆盖原结果并保留历史');

console.log('一键运行覆盖原路径：' + pass + ' 项通过');
if(failures.length){
    failures.forEach(label => console.error('  x ' + label));
    process.exit(1);
}
