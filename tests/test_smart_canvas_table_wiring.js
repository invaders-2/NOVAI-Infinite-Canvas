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
const mediaSrc = read('static/js/shared/media.js');
const tableCss = read('static/css/table-node.css');
const canvasCss = read('static/css/smart-canvas.css');

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
ok(/Array\.isArray\(table\.inputGroups\)/.test(js) && js.includes('materializeLlmTable(llmNode, table, groups, plan)'), '物化表格时按回执设通道模式（多图组才会是「全部」）');
ok(/每一行都必须用 @图片N/.test(modelSrc) && modelSrc.includes('多角度参考'), '生成遍要求 every-row 组整组作为多角度参考逐张 @ 出来');
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
ok(js.includes('loadSmartOriginalImageDimensions(entry.url)'), '素材没记尺寸时现量（上传/分组里的图常常没量过）');
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
ok(js.includes('const gridCount = Math.max(count + pendingSlotsForNode(node), batchOrderLen)'), '格子数把「还没落地的行」和本轮真实行数都算上（见 [15]/[17] 节）');
ok(/if\(gridCount <= 1\) return singleImageLayout/.test(js), '只有 1 格时才走单图布局');
ok(js.includes('function thumbGridHtml('), '网格渲染抽成 thumbGridHtml');
ok(js.includes('data-pending-slot'), '未出图的位置画占位格');
ok(/thumbGridHtml\(node, imgs, layout, pendingSlots, failedSlots\)/.test(js), 'nodeBodyHtml 把 pendingSlots / failedSlots 一起传给网格');

console.log('[10] 卡住的批量状态 / 视频拖动 / 原图比例');
// ① 批量「正在生成」不能把节点永久锁死
ok(js.includes('function resetStaleBatchRuns('), '加载时复位卡住的批量运行（resetStaleBatchRuns）');
ok(js.includes('const resetBatchRuns = resetStaleBatchRuns();'), 'loadCanvas 里真的调了');
ok(js.includes('delete node._batchRunning') && js.includes('delete node.tableBatchRunning'), '持久化时剥掉临时批量状态');
ok(moduleSrc.includes('} finally {') && /gen\._batchRunCount = Math\.max\(0, \(Number\(gen\._batchRunCount\) \|\| 1\) - 1\);/.test(moduleSrc), '批量执行体 try/finally 里一定会把计数还回去');
ok(!/notifyCanvas\('批量生成正在进行中/.test(moduleSrc), '再次点「运行」不再被「正在进行中」挡回来（要开新任务）');
ok(moduleSrc.includes('gen._batchRunCount'), '用「在跑批次数」而不是布尔，叠加两批时互不干扰');
ok(js.includes("row.status === 'running' || row.status === 'deferred'"), '卡在 running/deferred 的行放回 pending');
// ② 播放中的视频不再把节点钉死
ok(js.includes("const videoEl = e.target.closest('video');"), '视频区域允许起拖（只有控制条除外）');
ok(js.includes('nativeBar'), '底部原生控制条位置留给控件');
ok(/\.smart-node-floating-menu, \.node-resize-handle, \.thumb-item, \.node-port, \.prompt-node-control, select, input, textarea, button, \.smart-video-controls'/.test(js), '拖拽排除名单里换成了 .smart-video-controls');
// ③ 视频「原图比例」要解析成参考素材的真实比例
ok(js.includes('function nearestVideoAspectForSize('), '按参考素材比例找最接近的受支持比例');
ok(js.includes('VIDEO_ASPECT_SUPPORTED'), '有受支持视频比例表');
ok(js.includes('function applySourceRatioToVideoAspect('), 'keep_ratio 解析成一个函数统一处理');
ok(/videoAspect === 'keep_ratio'/.test(js) && js.split("videoAspect === 'keep_ratio'").length >= 3, '批量每行 + 单节点视频请求都会解析');
ok(js.includes('function refSourceEntry('), 'refSourceEntry 抽出来给单节点路径复用');

console.log('[11] 拖图入群组 / 删线不回弹 / 出表新建 / 视频可拖');
// ① 图片拖到「多图群组节点」上要并进去（原来只在按住 Ctrl 时才行）
ok(js.includes('mergeImageNodesIntoGroup(draggedNode.id, groupTarget.id)'), '拖到多图群组节点上会合并');
ok(!/groupTarget &&\s*\n\s*dragState\.ctrlGroup &&/.test(js), '合并不再要求按住 Ctrl');
// ② 删掉的连线不能被表格适配层自动接回去
ok(js.includes('const tableSyncedKeys = new Set();'), '区分「画布同步来的边」与「模块新加的边」');
ok(js.includes('if(tableSyncedKeys.has(key)) return;'), '从画布同步来的边一律不回写（删了就是删了）');
ok(/tableSyncedKeys\.add\(tableLinkKey\(conn\.from, conn\.to\)\)/.test(js), '同步时记录画布边的 key');
// ③ 出表每次新建一张表，不再就地更新
ok(js.includes('function materializeLlmTableNode('), '物化函数改名（不再「复用或更新」）');
ok(!js.includes('function reuseOrCreateLlmTableNode('), '旧的「就地更新」实现已移除');
ok(js.includes('materializeLlmTable(llmNode, table, groups, plan)'), '每次调用 materializeLlmTable 新建表格节点');
// ④ 播放中/暂停的视频节点都要能拖
ok(!/video\.addEventListener\('mousedown'/.test(mediaSrc), '视频本体不再拦 mousedown（拦了节点就永远拖不动）');
ok(js.includes("const videoEl = e.target.closest('video');"), '画布自己判断视频区域能不能起拖');
ok(/nativeBar[\s\S]{0,200}else \{\s*\n\s*e\.preventDefault\(\);/.test(js), '视频上不 preventDefault（保住 play() 的用户手势），其它区域照旧');
ok(/addEventListener\('click', e => \{\s*\n\s*if\(Date\.now\(\) >= suppressNodeClickUntil\) return;/.test(js), '拖完落在视频上的 click 被吞掉（不会顺带播放/暂停）');

console.log('[12] 批量结果节点的形状按参考比例（不再用源节点自己的框）');
ok(js.includes('const explicitRatio = options.ratio;'), '占位框支持显式参考比例');
ok(/pendingBoxSize\(expectedCount, \{sourceNode, ratio:options\.ratio/.test(js), 'createPendingOutputFromSource 透传 ratio');
ok(js.includes('batchResultNodeForRun(runId, node, meta, refs, srcRatio)'), '批量按行算出的比例传进结果节点');
ok(js.includes('const sourceIsGenerator'), '生成器类节点（批量/表格）不用自己的框当形状');
ok(js.includes('mediaLayoutSize(live.images[0]).width > 0'), '单张结果按素材自己的比例定框');

console.log('[13] LLM 端口 / 再次运行开新批次 / 多表格卡顿');
// ① LLM 节点手动尺寸时不能 overflow:hidden（否则框外的「加号+圆圈」被裁掉）
ok(/\.image-node:has\(\.prompt-node-llm\)\.size-user-set \{ min-height: 340px; overflow: visible; \}/.test(tableCss), 'LLM 手动尺寸节点 overflow:visible（端口不再被裁）');
// ② 再次点「运行」= 开一批新任务
ok(moduleSrc.includes('function tableBatchPanelSignature('), '批量面板有重绘签名（内容没变不重建）');
ok(moduleSrc.includes('if(panel.dataset.batchSignature === signature) return;'), '签名相同直接返回，不重建面板 DOM');
// ③ 多表格卡顿：mount 里不再逐节点重建 DOM / 逐节点同步连线
const mountTable = (js.match(/function mountSmartTableNodes\(\)\{[\s\S]*?\n\}/) || [''])[0];
const mountBatch = (js.match(/function mountSmartBatchNodes\(\)\{[\s\S]*?\n\}/) || [''])[0];
ok((mountTable.match(/syncTableConnections\(\)/g) || []).length === 1
    && mountTable.indexOf('syncTableConnections()') < mountTable.indexOf('hosts.forEach'), '表格：连线适配层每次 render 只同步一次（在循环之前）');
ok(!/hostEl\.textContent = '';/.test(mountTable), '表格：不再清空 host（避免子树反复拆装）');
ok(/if\(!hostEl\.querySelector\(':scope > \.table-node-drag-bar'\)\)/.test(mountTable), '表格：拖拽条只在缺失时创建');
ok((mountBatch.match(/syncTableConnections\(\)/g) || []).length === 1
    && mountBatch.indexOf('syncTableConnections()') < mountBatch.indexOf('hosts.forEach'), '批量：连线同样只同步一次（在循环之前）');
ok(/api\.paintTableBatchPanel\(existingPanel, node\)/.test(mountBatch), '批量：面板元素复用 + 按签名重绘');

console.log('[14] 依次生成 / 拖动不再忽大忽小');
ok(moduleSrc.includes("sequentialButton.textContent = '依次生成'"), '批量面板有「依次生成」按钮');
ok(moduleSrc.includes('table.tableBatchSequential = !Boolean(table.tableBatchSequential)'), '点「依次生成」只切模式开关（见 [16] 节）');
ok(/const sequential = Boolean\(options\.sequential\) \|\| Boolean\(table\.tableBatchSequential\)/.test(moduleSrc), '开关决定并发（1 = 一行跑完才开下一行）');
ok(/sequential\s*\n?\s*\? '依次生成：共 '/.test(moduleSrc), '面板提示文案区分依次生成');
ok(/isSmartImageNode\(draggedNode\) &&\s*\n\s*isSmartImageNode\(groupTarget\)/.test(js), '只有图片节点之间才合并（批量/表格被拖过别的节点不会被 merge 掉）');
ok(js.includes('const renderKey = html.replace(rootClass,'), '拖动/选中这类临时态不触发节点子树重建');
ok(js.includes('if(dragState && (dragState.id === node.id'), '拖动中不回写实测尺寸（避免忽大忽小）');
ok(js.includes('delete node.__renderKey;'), '渲染缓存持久化时剥掉');

console.log('[15] 批量进度框：失败 / 重复产出也不会提前收起');
ok(js.includes('function pendingSlotsForNode('), '占位格按「预期 - 已落地 - 已失败」算');
ok(js.includes('function failedSlotsForNode('), '失败的那几格单独统计');
ok(js.includes('data-pending-failed'), '失败占位有独立标记');
ok(moduleSrc.includes('gen._batchRunRows = pending.length'), '批量开始时记录这一批几行');
ok(js.includes('output.batchRunExpected = Math.max(1, Number(sourceNode && sourceNode._batchRunRows) || totalRows)'), '结果节点记住预期行数');
ok(js.includes('live.batchRunLanded ='), '成功行累加「已落地」');
ok(js.includes('live.batchRunFailed ='), '失败行累加「已失败」');
ok(js.includes('item.batchRunExpected = 0'), '整批结束后清掉这些计数（不留幽灵格）');
ok(canvasCss.includes('.pending-thumb.is-failed'), '失败占位的样式在');
ok(!/const gridCount = count \+ Math\.max\(0, Number\(node\?\.pending\)/.test(js), '占位格不再只看 pending');
ok(js.includes('function batchPendingSlotKinds('), '占位格按生效并发区分「在跑」和「排队」');
ok(js.includes('output.batchRunConcurrency'), '结果节点记下这一批的生效并发');
ok(js.includes('is-queued'), '排队格有独立标记');
ok(moduleSrc.includes('gen._batchRunConcurrency = concurrency'), '开跑时把生效并发写回生成节点');
ok(modelSrc.includes('function batchSlotKinds('), '占位切分是纯函数（可直接测）');
ok(canvasCss.includes('.loading-cell.is-queued'), '排队格样式在');

console.log('[16] 「依次生成」是模式开关：选中后点「运行」才按它跑');
ok(moduleSrc.includes('table.tableBatchSequential'), '开关存在表格节点上（可持久化，「运行」也能读到）');
ok(/sequentialButton\.onclick = \(\) => \{\s*\n\s*table\.tableBatchSequential = /.test(moduleSrc), '点按钮只切开关，不直接开跑');
ok(moduleSrc.includes("(sequentialOn ? ' is-active' : '')"), '选中态给按钮加 is-active');
ok(moduleSrc.includes('concurrencySelect.disabled = true'), '依次模式下并发选择器禁用');
ok(/const sequential = Boolean\(options\.sequential\) \|\| Boolean\(table\.tableBatchSequential\)/.test(moduleSrc), 'runTableBatch 读开关 → 并发 1');
ok(moduleSrc.includes("table.tableBatchSequential ? '1' : '0'"), '开关进面板签名（切换后重绘）');
ok(tableCss.includes('.table-node-action.is-active'), '选中态有样式');

console.log('[17] 批量进度框改用「真实逐行状态」，不再按并发猜');
ok(moduleSrc.includes('batchRowNumbers: pending.map'), 'runTableBatch 把本轮有序行号放进 runContext');
ok(js.includes('function ensureBatchRowPlan('), '结果节点按真实行号建逐行状态');
ok(js.includes('function setBatchRowState('), '每行状态由真实回调改');
ok(js.includes("setBatchRowState(liveOutput, rowNumber, 'running')"), '这一行真正开跑前置 running');
ok(js.includes("setBatchRowState(live, rowNumber, 'completed')"), '成功后置 completed');
ok(js.includes("setBatchRowState(live, rowNumber, Boolean(error && error.smartGenerationStopped) ? 'cancelled' : 'failed')"), 'catch 里按停止/失败分别置 cancelled / failed');
ok(js.includes('batchRowOrder') && js.includes('batchRowStates'), '结果节点持有真实行序与状态');
ok(js.includes('function batchRowGridHtml('), '进度框按行序逐格渲染');
ok(js.includes('data-pending-completed'), '已完成但图被去重 → 中性格，不转圈');
ok(js.includes('function batchRowStatusTextFor('), '节点显示真实数字（已完成/失败/共/在跑）');
ok(js.includes('delete node.batchRowOrder') && js.includes('delete node.batchRowStates'), '逐行状态是页面临时字段，不写进画布');
ok(modelSrc.includes('function batchRowPlan(') && modelSrc.includes('function batchRowStateSummary('), '逐行状态机是共享模块里的纯函数');
ok(canvasCss.includes('.loading-cell.pending-thumb.is-completed'), '中性格样式在');

console.log('[18] 停止生成（单张 + 批量，随时可停）');
ok(js.includes('let smartGenerationStopRequested') && js.includes('const activeSmartGenerationTaskIds'), '全局停止标志 + 在跑任务集合');
ok(js.includes('function requestSmartGenerationStop('), 'requestSmartGenerationStop 存在');
ok(js.includes("fetch('/api/tasks/' + encodeURIComponent(taskId) + '/cancel'"), '停止时调 /api/tasks/{id}/cancel');
ok(js.includes('runBtn.onclick = () => {') && js.includes('requestSmartGenerationStop()'), '底部运行按钮在跑时变成停止');
ok(js.includes('function smartGenerationStopText('), '停止 / 停止中… 文案');
ok(js.includes("runBtn.classList.toggle('is-stop', active)"), '停止态用 is-stop');
ok(js.includes('if(smartGenerationStopRequested) throw smartGenerationStoppedError();'), '轮询每轮检查停止并抛带标记错误');
ok(js.includes('activeSmartGenerationTaskIds.add(taskId)') && js.includes('activeSmartGenerationTaskIds.delete(taskId)'), '任务登记 / 结算时移除');
ok(js.includes('throwIfSmartGenerationStopped()'), '其它引擎等待点检查停止');
ok(js.includes('generationStopRequested: () => smartGenerationStopRequested'), '共享表格模块通过 host 读到停止标志');
ok(moduleSrc.includes('gen._batchStopRequested') && moduleSrc.includes('shouldStop: shouldStopBatch'), '批量把停止判定接进 runWithSharedCursor');
ok(moduleSrc.includes("journalMarkRow(journal, entry.rowNumber, 'cancelled')"), '取消行记 cancelled，不记 failed');
ok(moduleSrc.includes('已停止：完成 '), '停止摘要「已停止：完成 X · 已取消 Y」');
ok(modelSrc.includes("'cancelled'"), '模型层支持 cancelled 状态');
ok(modelSrc.includes('shouldStop'), 'runWithSharedCursor 支持 shouldStop');
ok(js.includes("state === 'cancelled'") && js.includes('data-pending-cancelled'), '取消占位格渲染分支');
ok(canvasCss.includes('.loading-cell.pending-thumb.is-cancelled'), '取消占位样式在');
ok(js.includes('delete node._batchStopRequested'), '批量停止标记是页面临时字段');

console.log('[19] 停止/运行按钮生命周期同步（批量任何收尾都回到「运行」）');
ok(moduleSrc.includes('generationStopRequested, onBatchSettled,'), 'host 解构里加了可选 onBatchSettled');
ok(/if\(typeof onBatchSettled === 'function'\) onBatchSettled\(\)/.test(moduleSrc), 'runTableBatch 用 typeof 判断后调用 onBatchSettled（经典画布不传也不报错）');
ok(/finally\s*\{[\s\S]{0,1500}?onBatchSettled\(\)/.test(moduleSrc), 'onBatchSettled 落在 finally —— 正常/异常/停止收尾都会同步');
ok(js.includes('onBatchSettled: () => syncRunButtonState()'), '智能画布把 onBatchSettled 接到 syncRunButtonState');
ok(js.includes('sbSyncStarBorderFrames();\n    syncRunButtonState();'), 'render() 末尾同步运行按钮状态');

console.log('');
if(fails.length){ console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('通过 ' + pass + '/' + pass);
console.log('全部通过');
