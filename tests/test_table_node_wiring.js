
const fs = require('fs');
const canvasJsSrc = fs.readFileSync('static/js/canvas.js', 'utf8');
const tableModuleSrc = fs.readFileSync('static/js/shared/table-node.js', 'utf8');
const canvas = canvasJsSrc + String.fromCharCode(10) + tableModuleSrc;
const css = fs.readFileSync('static/css/table-node.css', 'utf8');
const canvasCss = fs.readFileSync('static/css/canvas.css', 'utf8');
const themeCss = fs.readFileSync('static/css/theme.css', 'utf8');
const html = fs.readFileSync('static/canvas.html', 'utf8');
const model = fs.readFileSync('static/js/shared/table-model.js', 'utf8');
const registry = fs.readFileSync('static/js/shared/node-registry.js', 'utf8');
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
ok(canvas.includes("tableButton('', '删除这一行', 'table-row-delete')"), '删行按钮改成纯图标（无文字）');
ok(canvas.includes("removeIcon.dataset.lucide = 'trash-2'"), '图标用 Lucide trash-2');
ok(/refreshIcons\(\);\s*node\._tableSignature/.test(canvas), 'paint 结束刷新图标（repaintTable 不走 render()）');
ok(canvas.includes('const TABLE_TEXT_COLUMN_CHARS = 18;'), '长文本列阈值有常量');
ok(canvas.includes('if(textColumns[index]) cell.classList.add(\'is-text-column\')'), '数据列按长文本打 is-text-column');
ok(/\.table-node-table th,[\s\S]*?text-align: center;\s*vertical-align: middle;/.test(css), '表格内容水平+纵向都居中');
ok(/\.table-node-table th\.is-text-column,[\s\S]*?td\.is-text-column \{ text-align: left; \}/.test(css), '长文本列左对齐');
ok(css.includes('.table-row-delete svg { width: 14px; height: 14px; }'), '图标尺寸固定');
ok(canvas.includes('colSpan = channels.length + state.columns.length + 2'), '空表提示行跨了新增的删除列');

console.log('[5] 分发接线');
['createNodeByType 分支','menuAdd 分支','defaultNodeSize 分支','标题三元','body 分支'].forEach((label, i) => {
  const needles = ["if(type === 'table') return addTableNode(point);", "if(type === 'table') addTableNode(menuPoint);",
    "if(type === 'table') return {w:310, h:0};", "node.type === 'table' ? tr('canvas.tableNode') :",
    "if(node.type === 'table') body.appendChild(renderTableBody(node));"];
  ok(canvas.includes(needles[i]), label);
});
ok(canvas.includes("['generator','midjourney','comfy','output','llm','video','rh','table']"), 'table 有输入端口');
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
ok(videoBody.includes('tableBatchSingleButtonHtml(node)'), '视频节点主按钮走 tableBatchSingleButtonHtml（接表格时整个不渲染）');
ok(/function tableBatchSingleButtonHtml[\s\S]{0,200}tableBatchSingleLabel\(node\)/.test(canvas), '主按钮文案仍走 tableBatchSingleLabel（单段生成 / 生成视频）');
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
const VERSIONED_ASSETS = ['static/js/canvas.js', 'static/js/shared/table-model.js', 'static/js/shared/node-registry.js', 'static/js/shared/dropdown.js', 'static/css/canvas.css', 'static/css/table-node.css', 'static/css/theme.css'];
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

console.log('[9] 已下线的四种节点（循环 / LTX Director / MiniMax H3 / Modelscope生成）');
['loop', 'ltxDirector', 'minimax', 'msgen'].forEach(type => {
  ok(!html.includes("menuAdd('" + type + "')"), '菜单里没有 ' + type);
  ok(!new RegExp("spec\\('" + type + "'").test(registry), 'node-registry 里没有 ' + type);
});
ok(!canvas.includes('addLoopNode') && !canvas.includes('renderLoopBody'), '循环节点代码已删干净');
ok(!canvas.includes('miniMax') && !canvas.includes('renderMiniMaxBody'), 'MiniMax 代码已删干净');
ok(!canvas.includes('LTXDirector') && !canvas.includes('ltxDirectorSyncSeconds'), 'LTX 代码已删干净');
ok(!canvas.includes('MsGen') && !canvas.includes('runMsGenNode'), 'Modelscope生成节点代码已删干净');
ok(canvas.includes("const REMOVED_NODE_TYPES = ['loop', 'ltxDirector', 'minimax', 'msgen'];"), '老画布加载时丢弃这几类节点');
ok(canvas.includes("REMOVED_NODE_TYPES.includes(n.type)"), 'sanitizeConnections 里真的执行丢弃');
ok(!canvas.includes("p.id !== 'modelscope' && p.enabled !== false && (p.image_models || []).length"), '生成节点的平台下拉不再排除 ModelScope');
ok(canvas.includes("String(providerId || '').toLowerCase() === 'modelscope'"), 'ModelScope 模型列表有内置兜底');

console.log('[10] 生成节点运行按钮：不会被内容顶出可视区 / 接表格后不再重复');
{
  // 内容区包进 .gen-scroll，运行栏留在外面 —— 否则节点被改过大小后内容一超高，
  // 按钮就被顶到可视区外（画布还藏着滚动条），看起来就是「生成按钮消失了」。
  const scopes = canvas.split('<div class="gen-scroll">').slice(1);
  ok(scopes.length === 2, '生成节点与视频节点各有一个 .gen-scroll 内容区（实际 ' + scopes.length + '）');
  scopes.forEach((part, index) => {
    const cut = part.indexOf('<div class="gen-run-row">');
    ok(cut > 0, '第 ' + (index + 1) + ' 个 .gen-scroll 在运行栏之前');
    const inner = cut > 0 ? part.slice(0, cut) : '';
    // 切片从 <div class="gen-scroll"> 之后开始：开标签不计入，但它自己的闭标签在片尾，所以闭 = 开 + 1
    const opened = (inner.match(/<div\b/g) || []).length;
    const closed = (inner.match(/<\/div>/g) || []).length;
    ok(closed === opened + 1, '第 ' + (index + 1) + ' 个 .gen-scroll 在运行栏之前正确闭合（' + opened + ' 开 / ' + closed + ' 闭）');
  });
  ok(canvasCss.includes('.node.sized.generator-node .gen-scroll') && canvasCss.includes('.node.sized.video-node .gen-scroll'),
    'CSS：两类节点的内容区都能自己滚');
  ok(/\.node\.sized\.generator-node \.node-body,[\s\S]{0,90}\.node\.sized\.video-node \.node-body \{ display:flex; flex-direction:column;[^}]*overflow:hidden; \}/.test(canvasCss),
    'CSS：body 竖排且不整体滚动');
  ok(/\.node\.sized\.generator-node \.generator-body,[\s\S]{0,90}\.node\.sized\.video-node \.generator-body \{ flex:0 1 auto; min-height:104px; \}/.test(canvasCss),
    'CSS：生成体不抢剩余高度但保底 min-height（按钮不会被挤掉）');
  // node-body 里除了生成体，接表格时上面还有一个批量面板（兄弟节点）。
  // 面板不封顶的话，生成体的剩余高度会被挤没，运行栏被推到 body 外面（overflow:hidden 直接看不见）。
  // 自定义窗口时面板要铺满（行不够就拉大行高），不是封顶一半
  ok(/\.node\.sized\.generator-node \.node-body > \.table-batch-panel,[\s\S]{0,160}\{ flex:1 1 auto; min-height:0; overflow:hidden; \}/.test(canvasCss),
    'CSS：批量面板铺满剩余高度');
  ok(/\.node\.sized\.generator-node \.table-batch-list,[\s\S]{0,160}grid-auto-rows:minmax\(54px, 1fr\)/.test(css),
    'CSS：行数不够时表格行自己拉高铺满');
  ok(!/\.node\.sized\.generator-node \.generator-body \{[^}]*height:100%/.test(canvasCss)
    && !/\.node\.sized\.video-node \.generator-body \{[^}]*height:100%/.test(canvasCss),
    'CSS：生成体不再写死 height:100%（会和上面的批量面板叠起来把按钮顶出去）');
  ok(canvas.indexOf('if(tableBatchPanel) body.appendChild(tableBatchPanel);') < canvas.indexOf('body.appendChild(renderGeneratorBody(node));'),
    '批量面板排在生成体之前（兄弟关系，靠 flex 分配高度）');
  ok(/\.node\.sized\.generator-node \.gen-run-row,[\s\S]{0,220}\{ flex:0 0 auto; margin-top:8px; \}/.test(canvasCss),
    'CSS：运行栏不参与收缩，且紧跟在设置下面（不能 margin-top:auto 钉到节点底部）');
  // 内容区不能 flex-grow：抢剩余空间会把运行栏顶到最底下，设置区和按钮之间空出一大截
  ok(/\.node\.sized\.generator-node \.gen-scroll,[\s\S]{0,120}\.node\.sized\.video-node \.gen-scroll \{ flex:0 1 auto;/.test(canvasCss),
    'CSS：内容区只占需要的高度（flex:0 1 auto），不抢剩余空间');
  ['renderGeneratorBody', 'renderVideoBody'].forEach(name => {
    ok(sliceFn(name).includes('tableBatchSingleButtonHtml(node)'), name + ' 的主按钮走 tableBatchSingleButtonHtml');
    ok(!sliceFn(name).includes("querySelector('.gen-btn').onclick"), name + ' 的 .gen-btn 绑定不能裸调（接表格时按钮不存在）');
  });
  ok(/function tableBatchSingleButtonHtml[\s\S]{0,220}if\(generatorUpstreamTables\(node\.id\)\.length\) return '';/.test(canvas),
    '接多维表格时「单张/单段生成」直接不渲染');
}

console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过');
process.exit(fail ? 1 : 0);