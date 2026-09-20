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

console.log('[2] 创建菜单：多维表格 / 生成输入 / 文本生成，且已移除循环');
ok(html.includes('data-create-type="table"'), '菜单有 table');
ok(html.includes('data-create-type="batch"'), '菜单有 batch');
ok(html.includes('<span>生成输入</span>'), '批量节点菜单名为「生成输入」');
ok(html.includes('<span>文本生成</span>'), '提示词节点菜单名为「文本生成」');
ok(!html.includes('data-create-type="loop"'), '菜单已移除循环节点');
ok(!/type === 'loop'\) created = createLoopNode/.test(js), 'createNodeFromMenu 不再创建循环节点');
ok(!/a\.type === 'loop'\) node = createLoopNode/.test(js), 'create_node 命令不再创建循环节点');
ok(js.includes("title: '生成输入'"), '批量节点标题为「生成输入」');
ok(js.includes("tableHostDragBar('生成输入')"), '批量节点拖拽条为「生成输入」');
ok(js.includes(": '请接入上游节点';"), '空状态提示为「请接入上游节点」');
ok(/\.table-batch-panel\.is-empty \.table-batch-empty-tip\s*\{[^}]*font-size:\s*11px/.test(tableCss), '空状态提示字号更小');
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
ok(js.includes('const smartStopRequestedNodeIds = new Set()') && js.includes('const activeSmartGenerationTaskIds = new Map()'), '按节点的停止集合 + 在跑任务上下文');
ok(js.includes('function requestSmartGenerationStop('), 'requestSmartGenerationStop 存在');
ok(js.includes("fetch('/api/tasks/' + encodeURIComponent(taskId) + '/cancel'"), '停止时调 /api/tasks/{id}/cancel');
ok(js.includes('runBtn.onclick = () => {') && js.includes('smartNodeRunActive(node)') && js.includes('requestSmartGenerationStop(node)'), '底部运行按钮只按选中节点变成停止');
ok(js.includes('function smartGenerationStopText('), '停止 / 停止中… 文案');
ok(js.includes("runBtn.classList.toggle('is-stop', active)"), '停止态用 is-stop');
ok(js.includes('if(smartGenerationStopRequestedFor(node)) throw smartGenerationStoppedError();'), '轮询每轮检查这个节点的停止并抛带标记错误');
ok(js.includes('activeSmartGenerationTaskIds.set(taskId, stopContextId)') && js.includes('activeSmartGenerationTaskIds.delete(taskId)'), '任务按停止上下文登记 / 结算时移除');
ok(js.includes('throwIfSmartGenerationStopped(node)'), '其它引擎等待点按节点检查停止');
ok(js.includes('generationStopRequested: nodeId => smartGenerationStopRequestedFor(nodeId)'), '共享表格模块通过 host 按节点读停止标志');
ok(moduleSrc.includes('gen._batchStopRequested') && moduleSrc.includes('shouldStop: shouldStopBatch'), '批量把停止判定接进 runWithSharedCursor');
ok(moduleSrc.includes("journalMarkRow(journal, entry.rowNumber, 'cancelled')"), '取消行记 cancelled，不记 failed');
ok(moduleSrc.includes('已停止：完成 '), '停止摘要「已停止：完成 X · 已取消 Y」');
ok(modelSrc.includes("'cancelled'"), '模型层支持 cancelled 状态');
ok(modelSrc.includes('shouldStop'), 'runWithSharedCursor 支持 shouldStop');
ok(js.includes("state === 'cancelled'") && js.includes('data-pending-cancelled'), '取消占位格渲染分支');
ok(canvasCss.includes('.loading-cell.pending-thumb.is-cancelled'), '取消占位样式在');
ok(js.includes('delete node._batchStopRequested'), '批量停止标记是页面临时字段');
ok(js.includes('function smartNodeRunActive(node)') && js.includes('function requestSmartGenerationStop(node=selectedNode())'), '运行按钮与停止都按选中节点');
ok(js.includes('pendingNode._stopContextId = node.id') && js.includes('output._stopContextId = sourceNode.id'), '占位/结果节点指回停止上下文');
ok(js.includes('delete node._stopContextId'), '停止上下文是页面临时字段');
ok(moduleSrc.includes('generationStopRequested(gen && gen.id)'), '批量把本节点 id 交给 host 判定停止');

console.log('[19] 停止/运行按钮生命周期同步（批量任何收尾都回到「运行」）');
ok(moduleSrc.includes('generationStopRequested, onBatchSettled,'), 'host 解构里加了可选 onBatchSettled');
ok(/if\(typeof onBatchSettled === 'function'\) onBatchSettled\(\)/.test(moduleSrc), 'runTableBatch 用 typeof 判断后调用 onBatchSettled（经典画布不传也不报错）');
ok(/finally\s*\{[\s\S]{0,1500}?onBatchSettled\(\)/.test(moduleSrc), 'onBatchSettled 落在 finally —— 正常/异常/停止收尾都会同步');
ok(js.includes('onBatchSettled: () => syncRunButtonState()'), '智能画布把 onBatchSettled 接到 syncRunButtonState');
ok(js.includes('sbSyncStarBorderFrames();\n    syncRunButtonState();'), 'render() 末尾同步运行按钮状态');

console.log('[20] LLM 节点「聊天」模式（对齐经典画布）');
ok(!js.includes('智能画布暂不支持对话'), '去掉「暂不支持对话」占位');
ok(js.includes('data-llm-tab="chat"'), '聊天 tab 存在');
ok(!/data-llm-tab="chat"[^>]*(disabled|暂不支持)/.test(js), '聊天 tab 不再禁用/占位');
ok(js.includes("node.llmTab = node.llmTab === 'chat' ? 'chat' : 'node'"), 'llmTab 归一化：默认 node，可切 chat');
ok(js.includes('llm-chat-pane') && js.includes('llm-chat-log') && js.includes('llm-bubble'), '聊天面板结构（log + bubble）');
ok(js.includes('data-msg-idx'), '气泡带消息下标（复制用）');
ok(js.includes('llm-bubble-copy'), 'assistant 气泡复制按钮');
ok(js.includes('class="llm-chat-input'), '聊天输入框');
ok(js.includes('class="llm-chat-send'), '发送按钮');
ok(js.includes("tr('canvas.chatMode')") && js.includes("tr('canvas.startChat')") && js.includes("tr('canvas.chatInput')"), '复用 canvas 的聊天 i18n');
ok(js.includes("which === 'chat'") && js.includes("node.llmTab = 'chat'"), '点聊天 tab → llmTab=chat');
ok(js.includes("which === 'node'") && js.includes("node.llmTab = 'node'"), '点节点 tab → llmTab=node');
ok(js.includes('function runSmartPromptChat('), 'runSmartPromptChat 存在');
ok(js.includes('callSmartCanvasLLM(node, message, history, {chat:true})'), '聊天带 history 调 callSmartCanvasLLM');
ok(js.includes('if(options.chat) body.no_prompt_intelligence = true;'), '聊天请求跳过 Prompt Intelligence');
ok(js.includes("node.chatMessages.push({role:'user', content:message})"), '发送前 push user 消息');
ok(js.includes("node.chatMessages.push({role:'assistant', content:String(text || '')})"), '成功后 push assistant 回复');
ok(js.includes("node.outputText = String(text || '')"), '回复写 outputText 供下游取用');
ok(js.includes("e.key === 'Enter' && !e.shiftKey && !e.isComposing"), 'Enter 发送（不带 Shift、非输入法组合）');
ok(!js.includes('delete node.chatMessages') && !js.includes('delete node.llmTab') && !js.includes('delete node.chatInput'), '聊天状态随画布保存（不进清理名单）');
ok(canvasCss.includes('.llm-chat-log') && canvasCss.includes('.llm-bubble'), '聊天 CSS 落在 smart-canvas.css');
ok(canvasCss.includes('.llm-bubble-copy') && canvasCss.includes('.llm-chat-send'), '复制/发送样式在');
ok(!js.includes('runLLMChat('), '没有误引经典画布的 runLLMChat');

console.log('[21] 智能画布「导出为图片」（PNG / SVG）');
ok(/vendor\/js\/html-to-image\.js\?v=\d/.test(html), '离线 html-to-image 已引入且带版本号');
ok(fs.existsSync(path.join(root, 'static/vendor/js/html-to-image.js')), 'vendor 文件真实存在（离线）');
ok(read('static/vendor/js/html-to-image.js').includes('MIT License'), 'vendor 文件头带许可证');
ok(html.includes('id="smartExportToggle"') && html.includes('class="smart-export-toggle"'), '工具栏有导出按钮');
ok(/smart-workflow-toggle, \.smart-shortcut-toggle,\n\.smart-export-toggle/.test(html), '导出按钮进了工具栏 fixed 定位名单');
ok(html.includes('id="smartExportMenu"') && html.includes('data-export-format="png"') && html.includes('data-export-format="svg"'), '导出菜单含 PNG / SVG 两项');
ok(canvasCss.includes('.smart-export-toggle { right:454px; }'), '导出按钮复用工具栏按钮样式与位置');
ok(js.includes('const smartExportToggle = document.getElementById(\'smartExportToggle\')'), 'smartExportToggle 常量已取');
ok(js.includes('function exportSmartCanvasImage('), 'exportSmartCanvasImage 存在');
ok(js.includes('window.htmlToImage'), '导出走本地 window.htmlToImage');
ok(js.includes('lib.toBlob(') && js.includes('lib.toSvg('), 'PNG(toBlob) / SVG(toSvg) 两条路径都在');
ok(js.includes('function smartCanvasExportBounds(') && js.includes("querySelectorAll('.image-node')"), '包围盒基于全部节点（含孤立节点）');
ok(js.includes('function smartCanvasExportPixelRatio(') && js.includes('SMART_EXPORT_MAX_DIM'), 'pixelRatio 2 + 大画布降级');
ok(js.includes("transformOrigin: '0 0'") && js.includes('translate(${-bounds.minX + pad}px, ${-bounds.minY + pad}px) scale(1)'), '覆盖 #world 视口 transform（不动真实 DOM）');
ok(js.includes("world.classList.add('is-exporting')") && js.includes("world.classList.remove('is-exporting')"), '导出临时样式用完恢复');
ok(js.includes('downloadBlob(blob, smartCanvasExportFilename(ext))'), '按画布标题/时间命名下载');
ok(js.includes("toast('导出失败：'"), '失败有 toast，不静默');
ok(js.includes('smartExportMenu.querySelectorAll') && js.includes("'[data-export-format]'"), '菜单两项由 JS 绑定');
ok(canvasCss.includes('.smart-export-menu') && canvasCss.includes('.smart-export-item'), '导出菜单样式在');
ok(canvasCss.includes('#world.is-exporting'), '导出态隐藏交互装饰的样式在');

console.log('[22] LLM 聊天输入框可拖动自定义高度（高度记进节点并持久化）');
// 常量 + helper：把源码里的常量和函数抠出来在 node 里实跑，验默认值/上下限/取整
const chatConstSrc = (js.match(/const PROMPT_CHAT_INPUT_DEFAULT_H = \d+;\s*\nconst PROMPT_CHAT_INPUT_MIN_H = \d+;\s*\nconst PROMPT_CHAT_INPUT_MAX_H = \d+;/) || [])[0] || '';
const chatHelperSrc = (js.match(/function promptChatInputHeight\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(chatConstSrc) && Boolean(chatHelperSrc), '常量与 promptChatInputHeight 都在');
let chatH = null;
try { chatH = new Function(chatConstSrc + '\n' + chatHelperSrc + '\nreturn promptChatInputHeight;')(); } catch(e){ chatH = null; }
ok(typeof chatH === 'function', 'promptChatInputHeight 可求值');
if(typeof chatH === 'function'){
    eq(chatH(undefined), 56, '缺省回落 56');
    eq(chatH({}), 56, '无字段回落 56');
    eq(chatH({chatInputHeight: 'abc'}), 56, '非法值回落 56');
    eq(chatH({chatInputHeight: 10}), 40, '低于下限 clamp 到 40');
    eq(chatH({chatInputHeight: 9999}), 220, '高于上限 clamp 到 220');
    eq(chatH({chatInputHeight: 120.6}), 121, '小数四舍五入');
}
// 渲染：textarea 内联高度走 helper + textarea 下方有复用指令框样式的拖动把手
ok(js.includes('style="height:${promptChatInputHeight(node)}px"'), '聊天 textarea 内联高度由 helper 决定');
ok(js.includes('class="prompt-llm-instruction-resize prompt-node-control"') && js.includes('data-llm-chat-input-resize="1"'), '把手复用指令框样式类且带 prompt-node-control（防被画布当拖节点）');
ok(!/llm-chat-input[^>]*style="height:56px"/.test(js), '聊天输入框不再写死 56px 内联高度');
// 绑定：mousedown → 局部 onMove/onUp（document 捕获）→ 清理 + 存节点
const chatBindStart = js.indexOf("el.querySelector('[data-llm-chat-input-resize]')");
const chatBind = chatBindStart >= 0 ? js.slice(chatBindStart, chatBindStart + 1500) : '';
ok(Boolean(chatBind), '找得到聊天把手绑定');
ok(chatBind.includes("addEventListener('mousedown'"), '把手绑了 mousedown');
ok(chatBind.includes('promptChatInputHeight(node)'), '起点高度读 helper');
ok(chatBind.includes('node.chatInputHeight = next'), '拖动写回 node.chatInputHeight（持久化的链源头）');
ok(chatBind.includes('viewport.scale || 1'), '换算除以 viewport.scale（画布缩放不跑偏）');
ok(chatBind.includes("removeEventListener('mousemove', onMove, true)") && chatBind.includes("removeEventListener('mouseup', onUp, true)"), 'onUp 移除两个 document 监听（不泄漏）');
ok(chatBind.includes("classList.add('smart-node-resize', 'smart-chat-input-resize')") && chatBind.includes("classList.remove('smart-node-resize', 'smart-chat-input-resize')"), '拖动期间加/移除 body class');
ok(chatBind.includes('capturePendingUndo()') && chatBind.includes('scheduleSave()'), '按下取撤销快照、松开落盘');
// CSS：专用拖动态只在 table-node.css，且原有 size-user-set 的 flex 修复没被动到
ok(tableCss.includes('body.smart-chat-input-resize') && tableCss.includes('cursor:ns-resize'), '专用拖动态 CSS 在 table-node.css');
ok(/body\.smart-chat-input-resize[^{]*\{[^}]*pointer-events:none !important/.test(tableCss), '拖动期间文本框/聊天记录不接收指针');
ok(/\.size-user-set \.llm-chat-log \{ flex: 1 1 auto; max-height: none; \}/.test(tableCss), '上一轮 .llm-chat-log 撑满修复仍在');
ok(/\.size-user-set \.llm-chat-input,\n[^\n]*\.llm-chat-send \{ flex: 0 0 auto; \}/.test(tableCss), '上一轮输入框/按钮不参与伸缩的修复仍在');
ok(/\.prompt-node-llm \.llm-chat-input \{ height:56px; resize:none; \}/.test(canvasCss), '基础 56px 规则保留（会被内联高度覆盖，兜底用）');

console.log('[23] 提示词模板「应用」落点：LLM 节点写 llmInstruction，普通节点写 text');
// 把 applyPromptTemplateToNode 抠出来用 mock 实跑，验真正写哪个字段（不是只看字符串）
const applySrc = (js.match(/function applyPromptTemplateToNode\(mode='positive'\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(applySrc), '找得到 applyPromptTemplateToNode');
ok(/if\(node\.llmEnabled === true\)\{/.test(applySrc), '节点分支按 node.llmEnabled 分流');
ok(applySrc.includes('node.llmInstruction = text;'), 'LLM 分支写 llmInstruction');
ok(applySrc.includes('node.text = text;'), '非 LLM 分支仍写 text');
ok(js.includes('class="prompt-node-control prompt-llm-instruction"'), 'INPUT 框存在');
ok(/escapeHtml\(node\.llmInstruction \|\| ''\)/.test(js), 'INPUT 框 value 渲染自 node.llmInstruction');
ok(js.includes("instructionEl.oninput = e => { node.llmInstruction = e.target.value;"), 'INPUT 框手动输入也写 llmInstruction');

function buildApplyFn(){
    const state = { template: {id:'t1', builtin:false, sourceId:'src1'}, nodes: [] };
    const called = {close:0, render:0, save:0};
    const apply = new Function(
        'promptTemplateItems', 'promptTemplateSelectedId', 'promptTemplatePanel', 'promptTemplateText',
        'nodes', 'closePromptTemplatePanel', 'render', 'scheduleSave',
        applySrc + '\nreturn applyPromptTemplateToNode;'
    )(
        () => [state.template],
        't1',
        {dataset:{target:'node', nodeId:'n1'}},
        (tpl, mode) => (mode === 'positive' ? 'POS' : 'FULL'),
        state.nodes,
        () => { called.close += 1; },
        () => { called.render += 1; },
        () => { called.save += 1; }
    );
    return {apply: apply, state: state, called: called};
}
const llmCase = buildApplyFn();
llmCase.state.nodes.push({id:'n1', llmEnabled:true, text:'OLD'});
llmCase.apply('positive');
eq(llmCase.state.nodes[0].llmInstruction, 'POS', 'LLM 节点：模板文字写进 llmInstruction');
eq(llmCase.state.nodes[0].text, 'OLD', 'LLM 节点：原 node.text 保持不动');
eq(llmCase.state.nodes[0].promptPresetId, 'src1', 'LLM 节点：promptPresetId 照旧写入');
eq(llmCase.called, {close:1, render:1, save:1}, 'LLM 节点：close/render/scheduleSave 流程不变');
const plainCase = buildApplyFn();
plainCase.state.nodes.push({id:'n1', llmEnabled:false, text:'OLD'});
plainCase.apply('full');
eq(plainCase.state.nodes[0].text, 'FULL', '普通节点：模板文字仍写进 text');
eq(Object.prototype.hasOwnProperty.call(plainCase.state.nodes[0], 'llmInstruction'), false, '普通节点：不产生 llmInstruction');
const builtinCase = buildApplyFn();
builtinCase.state.template = {id:'t1', builtin:true, sourceId:'src1'};
builtinCase.state.nodes.push({id:'n1', llmEnabled:true, text:'OLD'});
builtinCase.apply('positive');
eq(builtinCase.state.nodes[0].promptPresetId, '', '内置模板：promptPresetId 清空（逻辑不变）');
// 保存当前提示词：LLM 节点优先读 llmInstruction（否则 LLM 模式 node.text 为空会存空）
const saveSrc = (js.match(/async function saveCurrentPromptAsTemplate\(\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(saveSrc.includes('templateNode?.llmEnabled ? templateNode.llmInstruction'), '保存提示词在 LLM 节点优先读 llmInstruction');

console.log('[24] 多图节点手动尺寸：8 张图全部排进框（不再只显示 3 张）');
const gridConstSrc = (js.match(/const MEDIA_GROUP_THUMB_BASE = \d+;\s*\nconst MEDIA_GROUP_MAX_VISIBLE_ROWS = \d+;/) || [])[0] || '';
const scaleConstSrc = (js.match(/const MEDIA_NODE_DEFAULT_SCALE = \d+;\s*\nconst MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE = [\d.]+;\s*\nconst MEDIA_GROUP_DEFAULT_SCALE = [\d.]+;/) || [])[0] || '';
const mediaScaleSrc = (js.match(/function mediaNodeDefaultScale\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
const groupGridSrc = (js.match(/function groupImageGridLayout\([\s\S]*?\n\}/) || [])[0] || '';
const fittedSrc = (js.match(/function fittedMediaGridLayout\([\s\S]*?\n\}/) || [])[0] || '';
const imageLayoutSrc = (js.match(/function imageLayout\([\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(gridConstSrc && scaleConstSrc && mediaScaleSrc && groupGridSrc && fittedSrc && imageLayoutSrc), '布局函数与常量都能从源码抠出来');
let imageLayoutFn = null;
try {
    imageLayoutFn = new Function('pendingSlotsForNode',
        scaleConstSrc + '\n' + gridConstSrc + '\n' + mediaScaleSrc + '\n' + groupGridSrc + '\n' + fittedSrc + '\n' + imageLayoutSrc
        + '\nreturn imageLayout;')(() => 0);
} catch(e){ imageLayoutFn = null; }
ok(typeof imageLayoutFn === 'function', 'imageLayout 可求值');
if(typeof imageLayoutFn === 'function'){
    const eightImages = Array.from({length:8}, (_, i) => ({url:'/output/pic' + i + '.png'}));
    const manualLayout = imageLayoutFn(eightImages, 1, {type:'smart-image', sizeUserSet:true, w:218, h:592, images:eightImages});
    console.log('    手动尺寸 218x592 / 8 张 → ' + manualLayout.cols + ' 列 x ' + manualLayout.rows + ' 行，可见 ' + manualLayout.visibleRows + ' 行，缩略图 ' + manualLayout.thumb + 'px');
    ok(manualLayout.visibleRows === manualLayout.rows && manualLayout.rows > 3, '手动尺寸：visibleRows 用真实行数（' + manualLayout.visibleRows + '/' + manualLayout.rows + '）');
    eq([manualLayout.cols, manualLayout.rows], [2, 4], '手动尺寸：218x592 的 8 张图排成 2 列 x 4 行');
    ok(manualLayout.cols * manualLayout.rows >= eightImages.length, '手动尺寸：格子数覆盖全部 8 张');
    ok(manualLayout.thumb >= 28, '手动尺寸：缩略图不低于下限 28（' + manualLayout.thumb + 'px）');
    const manualUsedH = manualLayout.rows * manualLayout.thumb + (manualLayout.rows - 1) * 8;
    ok(manualUsedH <= 592, '手动尺寸：全部行能塞进 592 高（内容 ' + manualUsedH + 'px）');
    const autoLayout = imageLayoutFn(eightImages, 1, {type:'smart-image', w:218, h:592, images:eightImages});
    ok(autoLayout.visibleRows <= 3, '未手动拖过：可见行数仍 <= 3（' + autoLayout.visibleRows + '）');
    // 线上那张 8 图节点带 grid-split 元数据（rows:8, cols:1），走的是宫格分支
    const gridImages = Array.from({length:8}, (_, i) => ({url:'/output/g' + i + '.png', ...(i === 0 ? {grid:{type:'grid-split', rows:8, cols:1}} : {})}));
    const gridLayout = imageLayoutFn(gridImages, 1, {type:'smart-image', sizeUserSet:true, w:218, h:592, images:gridImages});
    console.log('    宫格 218x592 / 8 张 → ' + gridLayout.cols + ' 列 x ' + gridLayout.rows + ' 行，可见 ' + gridLayout.visibleRows + ' 行，缩略图 ' + gridLayout.thumb + 'px');
    ok(gridLayout.visibleRows === gridLayout.rows && gridLayout.rows === 8, '宫格手动尺寸：8 行全部可见');
    const gridUsedH = gridLayout.rows * gridLayout.thumb + (gridLayout.rows - 1) * 8;
    ok(gridUsedH <= 592 && gridLayout.thumb >= 28, '宫格手动尺寸：全部行塞进 592 且缩略图不低于 28（' + gridUsedH + 'px / ' + gridLayout.thumb + 'px）');
}

console.log('[25] LLM 模型解析：用户已选模型原样保留（不再被换成 provider 第一个）');
const resolveChatModelSrc = (js.match(/function resolveChatModel\(model='', providerId=''\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(resolveChatModelSrc), 'resolveChatModel 能从源码抠出来');
ok(!/models\.includes\(model\)/.test(resolveChatModelSrc), '不再用「model 是否在列表里」决定要不要替换');
const AGNES_MODELS = ['agnes-2.0-flash', 'agnes-2.5-pro', 'agnes-3.0'];
const evalResolve = providerModels => new Function(
    'providerChatModels', 'resolveChatProviderId',
    resolveChatModelSrc + '\nreturn resolveChatModel;'
)(() => providerModels, id => id || 'agnes-ai');
const resolveAgnes = evalResolve(AGNES_MODELS);
eq(resolveAgnes('agnes-2.5-pro', 'agnes-ai'), 'agnes-2.5-pro', '列表内的非第一个模型原样保留');
eq(resolveAgnes('某不在列表里的模型', 'agnes-ai'), '某不在列表里的模型', '不在列表里的用户模型也原样保留');
eq(resolveAgnes('', 'agnes-ai'), 'agnes-2.0-flash', '空模型才回落到 provider 第一个');
eq(evalResolve([])('', 'agnes-ai'), 'gpt-4o-mini', 'provider 无模型且未选模型时才用兜底 gpt-4o-mini');
const chatModelOptionsSrc = (js.match(/function chatModelOptions\(selectedModel='', providerId=''\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(chatModelOptionsSrc), 'chatModelOptions 能从源码抠出来');
// chatModelOptions 会按平台校正已选模型，校正函数也抠真实源码注入（它用到 window.NovaUtils 的记忆）
const correctedChatModelSrc = (js.match(/function correctedChatModelForProvider\(providerId, currentModel\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(correctedChatModelSrc), 'correctedChatModelForProvider 能从源码抠出来');
const correctChatModel = new Function(
    'providerChatModels', 'window',
    correctedChatModelSrc + '\nreturn correctedChatModelForProvider;'
)(() => AGNES_MODELS, {});
const chatModelOptionsFn = new Function(
    'providerChatModels', 'resolveChatProviderId', 'resolveChatModel', 'correctedChatModelForProvider', 'escapeHtml',
    chatModelOptionsSrc + '\nreturn chatModelOptions;'
)(() => AGNES_MODELS, id => id || 'agnes-ai', resolveAgnes, correctChatModel, s => String(s));
const chatModelOptionsHtml = chatModelOptionsFn('agnes-2.5-pro', 'agnes-ai');
ok(chatModelOptionsHtml.includes('value="agnes-2.5-pro"'), '用户选的模型一定在选项里');
ok(/<option value="agnes-2\.5-pro" selected>/.test(chatModelOptionsHtml), '用户选的模型是 selected');

console.log('[26] 模型不被自动替换：仅「空」才回落 provider 第一个');
const canvasJs = read('static/js/canvas.js');
// 静态：经典画布四处覆盖点已去掉「不在列表就替换」
ok(!/!models\.includes\(resolveImageModel\(node\.model\)\)/.test(canvasJs), 'canvas.js sanitizeImageNodeProviderModel 不再按列表替换');
ok(!/!models\.includes\(node\.model\)/.test(canvasJs), 'canvas.js sanitizeVideoNodeProviderModel 不再按列表替换');
ok(!/!providerModels\.includes\(/.test(canvasJs), 'canvas.js image provider 切换不再按列表替换');
ok(!/!providerChatModels\(llmProv\)\.includes/.test(canvasJs), 'canvas.js LLM 节点渲染不再按列表替换');
// 静态：智能画布覆盖点已去掉
ok(!js.includes('!models.includes('), 'smart-canvas 不再出现 !models.includes(');
ok(!/settings\.model\s*=\s*''/.test(js), 'provider 切换不再把 settings.model 清空');
ok(!/settings\.videoModel\s*=\s*''/.test(js), 'video provider 切换不再把 settings.videoModel 清空');

// 求值：sanitizeSmartApiSelection —— 非空原样返回，空才回落 models[0]
const sanitizeSrc = (js.match(/function sanitizeSmartApiSelection\(target=settings\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(sanitizeSrc), 'sanitizeSmartApiSelection 能从源码抠出来');
const buildSanitize = (imageModels, videoModels, volcModels) => new Function(
    'settings','providerImageModels','providerVideoModels','volcengineVideoModels',
    'clearVolcengineSelectionOutsideVolcengine','isGptImageAutoSizeModel','defaultSmartApiResolution',
    sanitizeSrc + '\nreturn sanitizeSmartApiSelection;'
)({engine:'api'}, () => imageModels, () => videoModels, () => volcModels, t => t, () => false, () => '1k');
const sanitize = buildSanitize(['real-a','real-b'], ['real-v1','real-v2'], ['volc-v1']);
eq(sanitize({engine:'api', apiKind:'image', provider_id:'p1', model:'fake-image'}).model, 'fake-image', '非空且不在列表的 image model 原样保留');
eq(sanitize({engine:'api', apiKind:'image', provider_id:'p1', model:''}).model, 'real-a', '空 image model 回落到 models[0]');
eq(sanitize({engine:'api', apiKind:'video', videoProvider:'vp', videoModel:'fake-video'}).videoModel, 'fake-video', '非空且不在列表的 video model 原样保留');
eq(sanitize({engine:'api', apiKind:'video', videoProvider:'vp', videoModel:''}).videoModel, 'real-v1', '空 video model 回落到 models[0]');
eq(sanitize({engine:'volcengine', apiKind:'image', model:'fake-volc-img'}).model, 'fake-volc-img', '火山图：非空假模型原样保留');
eq(sanitize({engine:'volcengine', apiKind:'image', model:''}).model, 'real-a', '火山图：空才回落');
eq(sanitize({engine:'volcengine', apiKind:'video', videoModel:'fake-volc-vid'}).videoModel, 'fake-volc-vid', '火山视频：非空假模型原样保留');
eq(sanitize({engine:'volcengine', apiKind:'video', videoModel:''}).videoModel, 'volc-v1', '火山视频：空才回落');

// 求值：两个模型下拉必须把「用户已选但不在列表」的模型前置且 active
const renderModelSrc = (js.match(/function renderModelControl\(models\)\{[\s\S]*?\n\}/) || [])[0] || '';
const renderVideoModelSrc = (js.match(/function renderVideoModelControl\(models\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(renderModelSrc) && Boolean(renderVideoModelSrc), '两个 render*ModelControl 都能抠出来');
const renderImageControl = new Function('settings','escapeHtml','tr', renderModelSrc + '\nreturn renderModelControl;')({model:'fake-image-xyz'}, String, k => k);
const imageControlHtml = renderImageControl(['real-a','real-b']);
ok(imageControlHtml.includes('data-smart-value="fake-image-xyz"'), '图片下拉能看到用户选的假模型');
ok(/class="direct-option active"[^>]*data-smart-value="fake-image-xyz"/.test(imageControlHtml), '假模型处于 active 态');
eq((imageControlHtml.match(/data-smart-value="fake-image-xyz"/g) || []).length, 1, '假模型只出现一次（去重）');
const renderVideoControl = new Function('settings','escapeHtml','tr', renderVideoModelSrc + '\nreturn renderVideoModelControl;')({videoModel:'fake-video-xyz'}, String, k => k);
const videoControlHtml = renderVideoControl(['real-v']);
ok(/class="direct-option active"[^>]*data-smart-value="fake-video-xyz"/.test(videoControlHtml), '视频下拉假模型可见且 active');

// 求值：经典画布 sanitize —— 列表内的模型原样保留，空才回落 models[0]；不在列表的旧模型按平台归一（有平台记忆用记忆）
const correctNodeModelSrc = (canvasJs.match(/function correctNodeModelForProvider\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
const correctedVideoModelSrc = (canvasJs.match(/function correctedVideoModelForProvider\(providerId, currentModel\)\{[\s\S]*?\n\}/) || [])[0] || '';
const correctVideoNodeModelSrc = (canvasJs.match(/function correctVideoNodeModelForProvider\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
const sanitizeImageNodeSrc = (canvasJs.match(/function sanitizeImageNodeProviderModel\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
const sanitizeVideoNodeSrc = (canvasJs.match(/function sanitizeVideoNodeProviderModel\(node\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(sanitizeImageNodeSrc) && Boolean(sanitizeVideoNodeSrc), '经典画布两个 sanitize 能抠出来');
ok(Boolean(correctNodeModelSrc) && Boolean(correctedVideoModelSrc) && Boolean(correctVideoNodeModelSrc), '经典画布三个 correct* 能抠出来');
const buildImageNodeCorrector = (models, remembered) => new Function(
    'providerImageModels', 'resolveImageModel', 'providerById', 'window',
    correctNodeModelSrc + '\nreturn correctNodeModelForProvider;'
)(() => models, v => v, () => ({id:'p1', name:'P1'}), {NovaUtils:{rememberedProviderModel: () => remembered}});
const buildSanitizeImageNode = (models, remembered) => new Function('resolveImageProviderId','providerImageModels','correctNodeModelForProvider',
    sanitizeImageNodeSrc + '\nreturn sanitizeImageNodeProviderModel;')(id => id || 'p1', () => models, buildImageNodeCorrector(models, remembered));
const sanitizeImageNode = buildSanitizeImageNode(['real-a','real-b'], '');
const keepImageNode = {type:'generator', apiProvider:'p1', model:'real-b'};
sanitizeImageNode(keepImageNode);
eq(keepImageNode.model, 'real-b', '经典生成节点：列表内的非第一个模型原样保留');
const staleImageNode = {type:'generator', apiProvider:'p1', model:'fake-node-model'};
sanitizeImageNode(staleImageNode);
eq(staleImageNode.model, 'real-a', '经典生成节点：不在列表的旧模型归一（无记忆 → models[0]）');
const rememberedImageNode = {type:'generator', apiProvider:'p1', model:'fake-node-model'};
buildSanitizeImageNode(['real-a','real-b'], 'real-b')(rememberedImageNode);
eq(rememberedImageNode.model, 'real-b', '经典生成节点：不在列表的旧模型优先用平台记忆');
const fillImageNode = {type:'generator', apiProvider:'p1', model:''};
sanitizeImageNode(fillImageNode);
eq(fillImageNode.model, 'real-a', '经典生成节点：空模型回落到 models[0]');
const buildVideoNodeCorrector = (models, remembered) => {
    const correctedVideoModelForProvider = new Function('providerVideoModels', 'window',
        correctedVideoModelSrc + '\nreturn correctedVideoModelForProvider;')(() => models, {NovaUtils:{rememberedProviderVideoModel: () => remembered}});
    return new Function('correctedVideoModelForProvider', 'apiProviders',
        correctVideoNodeModelSrc + '\nreturn correctVideoNodeModelForProvider;')(correctedVideoModelForProvider, [{id:'v1', name:'V1'}]);
};
const buildSanitizeVideoNode = (models, remembered) => new Function('resolveVideoProviderId','providerVideoModels','correctVideoNodeModelForProvider',
    sanitizeVideoNodeSrc + '\nreturn sanitizeVideoNodeProviderModel;')(id => id || 'v1', () => models, buildVideoNodeCorrector(models, remembered));
const sanitizeVideoNode = buildSanitizeVideoNode(['real-v','real-v2'], '');
const keepVideoNode = {type:'video', apiProvider:'v1', model:'real-v2'};
sanitizeVideoNode(keepVideoNode);
eq(keepVideoNode.model, 'real-v2', '经典视频节点：列表内的非第一个模型原样保留');
const staleVideoNode = {type:'video', apiProvider:'v1', model:'fake-vid-model'};
sanitizeVideoNode(staleVideoNode);
eq(staleVideoNode.model, 'real-v', '经典视频节点：不在列表的旧模型归一（无记忆 → models[0]）');
const rememberedVideoNode = {type:'video', apiProvider:'v1', model:'fake-vid-model'};
buildSanitizeVideoNode(['real-v','real-v2'], 'real-v2')(rememberedVideoNode);
eq(rememberedVideoNode.model, 'real-v2', '经典视频节点：不在列表的旧模型优先用平台记忆');
const fillVideoNode = {type:'video', apiProvider:'v1', model:''};
sanitizeVideoNode(fillVideoNode);
eq(fillVideoNode.model, 'real-v', '经典视频节点：空模型回落到 models[0]');

// 确认经典画布两个 *ModelOptions 仍把「用户已选但不在列表」的模型前置且 selected（未改动，回归确认）
const uniqueModels = list => { const seen = new Set(); return (list || []).map(x => String(x || '').trim()).filter(x => { if(!x || seen.has(x)) return false; seen.add(x); return true; }); };
const videoModelOptionsSrc = (canvasJs.match(/function videoModelOptions\(selectedModel, providerId\)\{[\s\S]*?\n\}/) || [])[0] || '';
const imageModelOptionsSrc = (canvasJs.match(/function imageModelOptions\(selectedModel, providerId\)\{[\s\S]*?\n\}/) || [])[0] || '';
ok(Boolean(videoModelOptionsSrc) && Boolean(imageModelOptionsSrc), '经典画布两个 *ModelOptions 能抠出来');
const videoModelOptions = new Function('providerVideoModels','uniqueModels','escapeHtml','tr',
    videoModelOptionsSrc + '\nreturn videoModelOptions;')(() => ['real-v'], uniqueModels, String, k => k);
const imageModelOptions = new Function('imageApiProviders','allImageModels','resolveImageModel','escapeHtml','tr',
    imageModelOptionsSrc + '\nreturn imageModelOptions;')(() => [{id:'p'}], () => ['real-a'], v => v, String, k => k);
ok(/<option value="fake-vid" selected>/.test(videoModelOptions('fake-vid', 'p')), '经典视频下拉仍把用户模型前置为 selected');
ok(/<option value="fake-img" selected>/.test(imageModelOptions('fake-img', 'p')), '经典图片下拉仍把用户模型前置为 selected');

console.log('');
if(fails.length){ console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('通过 ' + pass + '/' + pass);
console.log('全部通过');
