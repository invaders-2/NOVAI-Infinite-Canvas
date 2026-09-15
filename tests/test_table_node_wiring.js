
const fs = require('fs');
const canvas = fs.readFileSync('static/js/canvas.js', 'utf8');
const css = fs.readFileSync('static/css/table-node.css', 'utf8');
const html = fs.readFileSync('static/canvas.html', 'utf8');
const model = fs.readFileSync('static/js/shared/table-model.js', 'utf8');
let fail = 0;
const ok = (c, m) => { if(!c){ console.log('  ✗ ' + m); fail++; } else console.log('  ✓ ' + m); };

console.log('[1] 函数定义');
['novaTableModel','ensureTableState','addTableNode','syncTableNodeWidth','repaintTable','addTableRow',
 'addTableColumn','deleteTableRow','toggleTableRow','toggleAllTableRows','beginTableEdit','endTableEdit',
 'bindTableCellEditor','bindTableHeadEditor','renderTableBody'].forEach(name => {
  ok(new RegExp('function ' + name + '\\s*\\(').test(canvas), name + ' 已定义');
});
console.log('[2] 依赖的既有函数');
['defaultPoint','addNode','scheduleSave','tr','uid'].forEach(name => {
  ok(new RegExp('(function|var|let|const)\\s+' + name + '\\s*[=(]').test(canvas), name + ' 存在');
});
console.log('[3] 全局名对齐');
ok(/root\.NovaTableModel = api/.test(model), 'table-model.js 导出 NovaTableModel');
ok(/typeof NovaTableModel !== 'undefined'/.test(canvas), 'canvas.js 读取 NovaTableModel');
ok(html.includes('shared/table-model.js'), 'canvas.html 引入 table-model.js');
ok(html.includes('css/table-node.css'), 'canvas.html 引入 table-node.css');
ok(html.includes("menuAdd('table')"), 'canvas.html 有表格菜单入口');
ok(html.indexOf('marvis-shared.css') < html.indexOf('table-node.css'), 'table-node.css 在 marvis-shared.css 之后');
ok(html.indexOf('node-registry.js') < html.indexOf('table-model.js'), 'table-model.js 在 node-registry.js 之后');

console.log('[4] CSS 类覆盖');
const used = new Set();
(canvas.match(/table-[a-z-]+/g) || []).forEach(c => used.add(c));
const missing = [...used].filter(c => !css.includes('.' + c));
ok(missing.length === 0, 'JS 用到的 table-* 类全部有样式' + (missing.length ? ' 缺: ' + missing.join(', ') : ''));

console.log('[5] 分发接线');
['createNodeByType 分支','menuAdd 分支','defaultNodeSize 分支','标题三元','body 分支'].forEach((label, i) => {
  const needles = ["if(type === 'table') return addTableNode(point);", "if(type === 'table') addTableNode(menuPoint);",
    "if(type === 'table') return {w:310, h:0};", "node.type === 'table' ? tr('canvas.tableNode') :",
    "if(node.type === 'table') body.appendChild(renderTableBody(node));"];
  ok(canvas.includes(needles[i]), label);
});
ok(/'minimax','table'\]\.includes\(node\.type\)/.test(canvas) || canvas.includes("'minimax','table']"), 'table 有输入端口');
ok(canvas.includes("'output','table']"), 'table 有输出端口');


console.log('[6] 视频节点由多维表格驱动（分镜逐段生成）');
const sliceFn = name => {
  const i = canvas.indexOf('function ' + name + '(');
  if(i < 0) return '';
  const rest = canvas.slice(i + 1);
  const j = rest.indexOf('\nfunction ');
  return j < 0 ? rest : rest.slice(0, j);
};
const videoBody = sliceFn('renderVideoBody');
ok(videoBody.includes('tableBatchRunButtonHtml(node)'), '视频节点主按钮位有「批量生成」');
ok(videoBody.includes('tableBatchSingleLabel(node)'), '视频节点主按钮文案可切换成「单段生成」');
ok((videoBody.match(/tableDrivenHidden\(node\)/g) || []).length === 2, '表格驱动时视频节点 Media 头部与列表都隐藏');
ok(canvas.includes('const tableBatchPanel = renderTableBatchPanel(node);'), 'video body 分支挂上批量面板');
ok(canvas.includes('if(tableBatchPanel) body.appendChild(tableBatchPanel);'), '批量面板先于节点主体插入');

const runVideo = sliceFn('runVideoNode');
ok(runVideo.includes('opts.rowOverride'), 'runVideoNode 支持按行覆盖提示词与素材');
ok(runVideo.includes('opts.batch'), 'runVideoNode 支持批量模式');
ok(runVideo.includes('!opts.cascade && !opts.batch'), '批量模式不占用节点 running 状态');
ok(runVideo.includes('if(opts.cascade || opts.batch) throw err;'), '批量模式抛错代替 alert（否则并发退化成串行）');
ok(runVideo.includes('!rowOverride && manualVideoUrlForNode(node)'), '按行批量时手动视频网址不覆盖本行素材');

const runBatch = sliceFn('runTableBatch');
ok(runBatch.includes('tableBatchRunner(gen)(genId'), '批量执行按节点类型派发运行器');
ok(runBatch.includes('tableBatchConcurrencyFor(gen, table)'), '批量执行用生效并发');
ok(canvas.includes("return node && node.type === 'video' ? runVideoNode : runGenerator;"), '视频走 runVideoNode、图像走 runGenerator');
ok(canvas.includes("const fallback = gen && gen.type === 'video' ? 1 : model.DEFAULT_BATCH_CONCURRENCY;"), '视频默认并发 1');
ok(canvas.includes("item.type === 'generator' || item.type === 'video'"), '勾选同步覆盖视频节点');
ok(canvas.includes("if(target.type === 'output' || target.type === 'table'){ queue.push(target.id); }"), '下游目标探测穿过表格');
ok(canvas.includes('model.buildListPlanPrompt(requirement, inputs, groups, {targetKind})'), 'LLM 规划遍按目标类型出分镜');
ok(canvas.includes('model.buildListGeneratePrompt(requirement, inputs, groups, plan, {targetKind})'), 'LLM 生成遍按目标类型出分镜');
ok(model.includes('function llmTargetKind('), 'table-model 提供 llmTargetKind');
ok(model.includes('VIDEO_PLAN_BLOCK') && model.includes('VIDEO_GENERATE_BLOCK'), 'table-model 提供视频分镜提示词块');
ok(model.includes('function batchConcurrency(raw, fallback)'), '可按目标类型指定默认并发');
ok(canvas.includes('<option value="list-video">视频分镜表</option>'), 'LLM 输出模式下拉有「视频分镜表」');
ok(canvas.includes("model.llmModeTargetKind(node.llmOutputMode) || model.llmTargetKind(listTarget.target_type)"), '显式分镜表优先、否则按下游探测');

console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过');
process.exit(fail ? 1 : 0);
