
const fs = require('fs');
const canvas = fs.readFileSync('static/js/canvas.js', 'utf8');
const css = fs.readFileSync('static/css/table-node.css', 'utf8');
const canvasCss = fs.readFileSync('static/css/canvas.css', 'utf8');
const themeCss = fs.readFileSync('static/css/theme.css', 'utf8');
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
ok(!/\.table-row-delete \{[^}]*opacity: 0/.test(css), '删除行按钮默认可见，不靠悬停');
ok(!/tbody tr:hover \.table-row-delete/.test(css), '没有「悬停整行才显示删除按钮」那条规则');
ok(/\.table-row-delete:hover \{[^}]*background: var\(--danger-bg\)/.test(css), '删除行按钮悬停变红');
ok(css.includes('.table-delete-column { width: 60px; }'), '删除列有固定宽度');
// JS 里的列宽常量和 CSS 必须一致，否则自然宽度算出来的节点会比表格窄
const deleteColWidth = Number((/\.table-delete-column \{ width: (\d+)px; \}/.exec(css) || [])[1] || 0);
const deleteColConst = Number((/const TABLE_DELETE_COLUMN_WIDTH = (\d+);/.exec(canvas) || [])[1] || -1);
ok(deleteColWidth > 0 && deleteColWidth === deleteColConst, '删除列宽 CSS(' + deleteColWidth + ') 与 JS 常量(' + deleteColConst + ') 一致');
ok(canvas.includes("removeRow = tableButton('删除行'"), '删行按钮文案是「删除行」');
ok(canvas.includes('colSpan = channels.length + state.columns.length + 2'), '空表提示行跨了新增的删除列');

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
ok(canvas.includes('llmOutputModeButtonsHtml(node)'), 'LLM 输出形式用函数生成');
ok(canvas.includes('class="llm-mode llm-output-mode"'), '输出形式复用节点里那套 .llm-mode 药丸样式');
ok(canvas.includes("data-output-mode="), '药丸按钮带 data-output-mode');
ok(/.llm-mode button.active \{ background:var\(--strong\); color:var\(--strong-text\);/.test(canvasCss),
  '药丸选中态 = --strong 底 + --strong-text 字（浅色下黑底白字）');
ok(canvasCss.includes('.select-lite { appearance:none; -webkit-appearance:none; padding-right:24px;'), '下拉三角改自绘并缩进');
ok(canvasCss.includes("stroke-linecap='round'"), '三角是线性图标（Lucide stroke，圆头圆角）');
ok(canvasCss.includes("path d='m6 9 6 6 6-6'"), '用的就是 Lucide chevron-down 的 path');
ok(canvasCss.includes('background-position:calc(100% - 12px) 50%'), '图标位置固定');
ok(canvasCss.includes('background-size:12px 12px'), '图标尺寸固定');
ok(!canvasCss.includes('linear-gradient(45deg, transparent 50%'), '不再用渐变拼三角');
ok(canvasCss.includes("stroke='%23fafafa'"), '深色主题有对应的浅色描边版本');
ok(themeCss.includes("stroke-linecap='round'") && themeCss.includes('!important'), 'studio-dark 里补回线性三角');
ok(canvas.includes("return model.llmRunStageLabel(Boolean(node.running), stage);"), '生成按钮文案统一走 llmRunStageLabel');
ok(!canvas.includes("'Run LLM'"), '不再出现英文 Run LLM');
ok(!canvas.includes('select-lite llm-output-mode'), '不再用下拉框（select）');
ok(canvas.includes('class="llm-run-row"'), '药丸与生成按钮同一行');
ok(canvasCss.includes('.llm-run-row {'), '新行有样式（左药丸右按钮）');
ok(canvasCss.includes('.llm-run-row .llm-run,'), '行内生成按钮有独立规则');
ok(canvasCss.includes('margin-left:auto; padding:0 18px;'), '生成按钮按内容定宽、靠右，不强行拉满');
ok(canvasCss.includes('.node.sized.llm-node .llm-run-row .llm-run'), '覆盖 .node.sized.llm-node .llm-run 的 column 布局遗留');
ok(!canvasCss.includes('.node.sized.llm-node .gen-run-row'), 'LLM 行不再被 margin-top:auto 钉死（否则会贴住输出框）');
ok(canvasCss.includes('.node.sized.llm-node .llm-output-wrap { flex:1 1 var(--llm-output-h, 150px);'), '有固定高度的节点：输出区吃掉剩余高度');
ok(canvas.includes('style="--llm-output-h:${outputHeight}px;"'), '输出区高度走 CSS 变量，不再写死行内 flex');
ok(!canvas.includes('class="llm-output-wrap" style="height:'), '输出区行内不再有 height/flex');
ok(canvas.includes("outputWrap.style.setProperty('--llm-output-h'"), '拖分隔条同步 CSS 变量');
ok(canvas.includes("model.llmModeTargetKind(node.llmOutputMode) || model.llmTargetKind(listTarget.target_type)"), '显式分镜表优先、否则按下游探测');

console.log('[7] 「批量生成」按钮必须真的绑上（只渲染不绑定 = 点了没反应）');
['renderGeneratorBody', 'renderVideoBody'].forEach(name => {
  const body = sliceFn(name);
  ok(body.includes('tableBatchRunButtonHtml(node)'), name + ' 渲染「批量生成」按钮');
  ok(body.includes('.table-batch-run-btn'), name + ' 绑定「批量生成」按钮的 onclick');
});
console.log('[8] 改了 canvas.js / table-model.js / canvas.css，就必须同步 canvas.html 的 ?v=');
const VERSIONED_ASSETS = ['static/js/canvas.js', 'static/js/shared/table-model.js', 'static/css/canvas.css', 'static/css/table-node.css', 'static/css/theme.css'];
try {
  const dirty = require('child_process')
    .execSync('git status --porcelain ' + VERSIONED_ASSETS.join(' ') + ' static/canvas.html', {encoding: 'utf8'})
    .split('\n').map(line => line.slice(3).trim()).filter(Boolean);
  const dirtyAsset = dirty.filter(f => VERSIONED_ASSETS.includes(f));
  ok(dirtyAsset.length === 0 || dirty.includes('static/canvas.html'),
    '改了 ' + (dirtyAsset.join('、') || 'canvas.js') + ' 就必须同时改 static/canvas.html 的 ?v=');
} catch(error) {
  ok(true, '跳过（不在 git 工作区）');
}

console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过');
process.exit(fail ? 1 : 0);
