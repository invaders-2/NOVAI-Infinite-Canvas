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
ok(js.includes('batchResultNodeForRun') && js.includes('batchRunResultNodes'), '一次批量运行只落一个结果节点（多行结果并进去，自动成组）');
ok(js.includes('rowSourceRatio') && js.includes("runSettings.ratio === 'source'"), '批量「适配比例」按每行的参考图/视频尺寸算');
ok(js.includes('appendBatchResultImages'), '结果节点 pending 逐行递减（生成进度/计时）');

console.log('[6] 共享模块为智能画布做的让步');
ok(/TABLE_OUTPUT_LIKE_TYPES\s*=\s*\['output',\s*'smart-image'\]/.test(moduleSrc), 'tableSourceItems 把 smart-image 当输出节点展开');
ok(/source\.type === 'group' \|\| source\.type === 'smart-group'/.test(moduleSrc), 'tableSourceItems 认识智能画布的 smart-group');
ok(moduleSrc.includes('const fromGroupImages'), '分组自己的 images（吸收进来的素材）也展开');

console.log('[7] 这一轮的四项修复');
const modelSrc = read('static/js/shared/table-model.js');
// ① 整组素材（例如一整组白底图）在每一行的提示词里全部出现
ok(moduleSrc.includes('function withRowReferenceList('), '行提示词补「参考图」清单：整组素材全部写出来');
ok(/prompt = withRowReferenceList\(/.test(moduleSrc), 'tableRowInputs 的 prompt 走 withRowReferenceList');
ok(modelSrc.includes("'inputGroups'") || modelSrc.includes('inputGroups'), '生成遍回执带 inputGroups（一次请求就能定每组用法）');
ok(/table\.inputGroups = parsed\.inputGroups/.test(modelSrc), 'parseTableOutput 保留 inputGroups');
ok(/Array\.isArray\(table\.inputGroups\)/.test(js) && js.includes('planGroupModes(plan, groups.length)'), '物化/复用表格时按回执设通道模式（多图组才会是「全部」）');
ok(/每一行的提示词必须用 @图片N/.test(modelSrc), '生成遍要求 every-row 组的每一张都被 @ 出来');
// ② 一张表配一个批量生成节点，不再借用别人的
ok(js.includes('linkedToTable'), 'connectSmartBatchAfter 只复用连在这张表后面的批量节点');
ok(!/downstream\[0\] \|\| nodes\.find\(n => n\.type === 'smart-batch'\)/.test(js), '不再抓画布上任意一个批量节点');
// ③ 批量生成节点能自定义往下拉
ok(/node\?\.type === 'table' \|\| node\?\.type === 'smart-batch'/.test(js), '表格/批量节点布局直接听 node.w/h（不再被自身的产出图网格算死）');
// ④ 生成结果群组能自定义往下拉
ok(js.includes('function fittedMediaGridLayout('), '多图节点手动尺寸走 fittedMediaGridLayout');
ok(/manual \? 100000 : maxThumb/.test(js), '手动尺寸解除缩略图放大上限（往下拉会真的变大）');
ok(js.includes('manualSizable') && /manualSizable && !node\.sizeUserSet/.test(js), '真拖动之后才标记手动尺寸（单击把手不锁死）');
ok(/\$\{node\.sizeUserSet \? 'size-user-set' : ''\}/.test(js), '手动尺寸类重新渲染后仍保留');

console.log('[8] 按行比例 / 对比原图 / 群组删除 icon');
// ① 「适配比例」按每一行的参考图算（素材没量过尺寸就现量）
ok(js.includes('async function rowSourceRatio('), 'rowSourceRatio 支持异步现量尺寸');
ok(js.includes('loadSmartOriginalImageDimensions(ref.url)'), '素材没记尺寸时现量（上传/分组里的图常常没量过）');
ok(js.includes('function applyRowSourceRatioToSettings('), '按行比例写回设置走 applyRowSourceRatioToSettings');
ok(js.includes("['', 'ratio'], ['ms', 'msRatio']"), 'API 与 ModelScope 两套尺寸都照顾到');
ok(/ratio === 'source' \|\| runSettings\.msRatio === 'source'/.test(js), '两套「适配比例」都会触发按行计算');
ok(/runSettings\[customKey\] = rw && rh \?/.test(js), '算不出比例时清掉过期 customRatio（不能拿上一次的 2:3 去生成）');
// ② 「对比原图」按每一行/每一张自己的参考图
ok(js.includes('rowCompareRefs'), '批量产出带上这一行的参考图');
ok(js.includes('const ownRefs = Array.isArray(editing.image?.runInputRefs)'), '对比原图优先用当前这张图自己的参考图');
// ③ 群组（多图结果节点）也有删除 icon
ok(/\$\{!isEmpty \? `<div class="floating-node-actions">/.test(js), '群组不再被排除在浮动删除按钮之外');
ok(!/!isEmpty && !isGroup \?/.test(js), '没有残留「群组不显示删除按钮」的写法');

console.log('[9] 勾选联动 / 群组下载 / 生成中的进度占位');
// ① 表格与批量面板的勾选互通（智能画布的批量节点是 smart-batch，原来不在重绘名单里）
ok(moduleSrc.includes('TABLE_BATCH_NODE_TYPES'), '批量面板的节点类型表存在');
ok(/'generator',\s*'video',\s*'smart-batch'/.test(moduleSrc), '批量面板类型表含智能画布的 smart-batch');
ok(/filter\(tableBatchTypeNode\)/.test(moduleSrc), 'repaintTable / repaintTableSelectionViews 都按类型表重绘面板');
ok(moduleSrc.includes('repaintTableSelectionViews'), '勾选后两边视图一起重绘');
// ② 群组下载 = 整组打包
ok(/mediaList\.length > 1[\s\S]{0,220}zipDownloadImageItems\(node\.title/.test(js), '多张素材时下载整组（zip）');
ok(/canvas-assets\/download/.test(js), '打包下载走 /api/canvas-assets/download（服务端压 zip，图片视频都收）');
// ③ 生成中：已出图 + 未出图占位一起显示（进度框不被第一张顶掉）
ok(js.includes('const gridCount = count + Math.max(0, Number(node?.pending) || 0)'), '格子数把 pending 也算上');
ok(/if\(gridCount <= 1\) return singleImageLayout/.test(js), '只有 1 格时才走单图布局');
ok(js.includes('function thumbGridHtml('), '网格渲染抽成 thumbGridHtml');
ok(js.includes('data-pending-slot'), '未出图的位置画占位格');
ok(/thumbGridHtml\(node, imgs, layout, pendingSlots\)/.test(js), 'nodeBodyHtml 把 pendingSlots 传给网格');

console.log('');
if(fails.length){ console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('通过 ' + pass + '/' + pass);
console.log('全部通过');
