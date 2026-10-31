#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'static/js/smart-canvas.js'), 'utf8');
function fn(name) {
    const match = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    assert(match, '缺少函数 ' + name);
    const start = match.index + 1;
    const end = src.indexOf('\n}', start);
    assert(end > start, '缺少函数结尾 ' + name);
    return src.slice(start, end + 2);
}

const rerun = fn('rerunSmartNode');
const createOutput = fn('createPendingOutputFromSource');
const render = fn('renderConnections');
assert(rerun.includes("createPendingOutputFromSource(source, expected, meta, {connectSource:false"), '重新生成复用普通输出节点创建链路');
assert(!rerun.includes("conn.kind = 'history'"), '重新生成不得改成从节点底部出发的历史连线');
assert(createOutput.includes("if(options.connectSource === false) addConnection(sourceNode.id, output.id, 'flow')"), '重新生成结果使用 flow 输出连线');
assert(render.includes('const fx = isHistory ? fr.x + fr.width / 2 : fr.x + fr.width;'), 'flow 连线保持从来源节点右侧出发');
assert(render.includes('const tx = isHistory ? tr.x + tr.width / 2 : tr.x;'), 'flow 连线保持接入结果节点左侧');
console.log('[PASS] 重新生成结果统一使用右侧输出连线');
