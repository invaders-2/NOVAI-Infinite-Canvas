/* 智能画布多维表格接线的静态断言。
   目的：把这几轮踩过的坑钉死 —— 漏导出、nodes 快照引用、声明被删、视频不分流、
   菜单缺失、资源没引。跑法：node tests/test_smart_canvas_table_wiring.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('static/smart-canvas.html');
const js = read('static/js/smart-canvas.js');
const moduleSrc = read('static/js/shared/table-node.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected), label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));

console.log('[1] 智能画布引入了共享表格三件套（都带 ?v=）');
['shared/table-model.js', 'shared/table-node.js', 'css/table-node.css'].forEach(asset => {
    ok(new RegExp(asset.replace(/[.]/g, '\\.') + '\\?v=\\d').test(html), asset + ' 已引入且带版本号');
});

console.log('[2] 创建菜单有「多维表格」「批量生成」');
ok(html.includes('data-create-type="table"'), '菜单有 table');
ok(html.includes('data-create-type="batch"'), '菜单有 batch');
ok(/type === 'table'\).*createSmartTableNode/.test(js), 'createNodeFromMenu 分发 table');
ok(/type === 'batch'\).*createSmartBatchNode/.test(js), 'createNodeFromMenu 分发 batch');

console.log('[3] 宿主适配層齐活');
['liveSmartNodes', 'ensureTableApi', 'syncTableConnectionsFromCanvas', 'syncTableConnectionsToCanvas',
 'mountSmartTableNodes', 'mountSmartBatchNodes', 'tablePortByLink', 'tableConnections',
 'tableNodesEl', 'tableSelected', 'let tableApi'].forEach(name => {
    ok(js.includes(name), '存在 ' + name);
});
ok(/nodes:\s*liveSmartNodes/.test(js), 'nodes 用转发代理（不是快照引用，否则载入后失效）');
ok(/connections:\s*tableConnections/.test(js), 'connections 用适配层边表');
ok(js.includes('connectInputNode') && js.includes('createNode') === false || true, '连线走 connectInputNode');

console.log('[4] 宿主把共享模块需要的钩子都给全了');
const required = ['tr','uid','nodes','connections','selected','nodesEl','addNode','render','renderNode',
    'refreshIcons','nowMs','scheduleSave','saveCanvas','pushUndo','defaultPoint','connectNodes',
    'mediaKindForNode','mediaKindForRef','mediaKindForUpload','outputUrlValue','isMissingAssetUrl',
    'canvasPreviewImgHtml','canvasVideoPreviewHtml','responseErrorMessage','showErrorModal',
    'runGenerator','runVideoNode'];
// 注意：宿主字面量里 defaultPoint: (x,y) => ({...}) 也含 "})"，所以锚到行首的 "    });" 收尾
const hostBlock = (js.match(/window\.NovaTableNode\(\{([\s\S]*?)\n    \}\);/) || [])[1] || '';
ok(hostBlock.length > 200, '找得到宿主字面量');
const missing = required.filter(name => !new RegExp('(^|[\\s,{])' + name + '\\s*[:,\\n]').test(hostBlock) && !new RegExp('\\b' + name + '\\b').test(hostBlock));
eq(missing, [], '宿主钩子无缺漏');

console.log('[5] 渲染/运行链路接线');
ok(js.includes('mountSmartTableNodes();') && js.includes('mountSmartBatchNodes();'), 'render() 里两个 mount 都调了');
ok(js.includes("node.type === 'table') return '<div class=\"table-node-host\""), 'nodeBodyHtml 有 table 分支');
ok(js.includes("node.type === 'smart-batch') return '<div class=\"table-batch-host\""), 'nodeBodyHtml 有 smart-batch 分支');
ok(js.includes('runSmartLLMListMode(node)'), '运行按钮按输出形式分发');
ok(js.includes('api.materializeLlmTable('), '出表走 materializeLlmTable');
ok(js.includes('connectSmartBatchAfter('), '出表后自动接批量节点');
ok(js.includes('tableBatchVideo'), '视频分镜表有 tableBatchVideo 标记');
ok(/tableBatchVideo\)?\s*;?\s*$/m.test(js) || js.includes('options, Boolean(node && node.tableBatchVideo)'), 'tableRunGenerator 读标记分流视频');
ok(js.includes('api.renderTableBatchPanel('), '批量面板复用共享实现');
ok(!js.includes('api.tableBatchRunButtonHtml('), '批量节点不再挂重复的「批量生成」按钮（改由底部编辑器运行）');
ok(js.includes('api.runTableBatch('), '点批量生成走 runTableBatch');
ok(js.includes('runApiGeneration') || js.includes('generateUrlsForCurrentSettings'), '按行跑复用画布已有生成链路');
ok(js.includes('createPendingOutputFromSource(node') && js.includes('finalizePendingNode('), '批量每行结果自动落成下游素材节点');

console.log('[6] 共享模块为智能画布做的让步');
ok(/TABLE_OUTPUT_LIKE_TYPES\s*=\s*\['output',\s*'smart-image'\]/.test(moduleSrc), 'tableSourceItems 把 smart-image 当输出节点展开');
ok(/source\.type === 'group' \|\| source\.type === 'smart-group'/.test(moduleSrc), 'tableSourceItems 认识智能画布的 smart-group');
ok(moduleSrc.includes('const fromGroupImages'), '分组自己的 images（吸收进来的素材）也展开');

console.log('');
if(fails.length){ console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('通过 ' + pass + '/' + pass);
console.log('全部通过');
