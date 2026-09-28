/* 标签节点（smart-label）的回归测试。
   用户需求：加一种「标签」节点 —— 一条胶囊（圆点 + 图标 + 文字），纯标注不带连线口，
   背景三态（线框 / 无背景 / 纯色）可切、颜色可选、字号可调，双击就地改文字。
   守的东西：
     A. 接线：菜单 → createSmartLabelNode → 渲染（label-smart-node / 无端口 / 无 hint）→ 选中带出样式面板；
     B. 交互：双击就地编辑（回车提交、Esc 还原）、拖节点时不会误拖正在编辑的文字；
     C. 细节：尺寸按内容自适应（测量回写）、配色/字号兜底、CSS 与 i18n 都在。
   跑法：node tests/test_smart_canvas_label_node.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');
const TICK = String.fromCharCode(96);

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 创建入口：菜单项 + createNodeFromMenu + createSmartLabelNode');
ok(/data-create-type="label"/.test(html), '创建菜单里有「标签」按钮');
const createMenuFn = topLevelFunction(js, 'createNodeFromMenu');
ok(/type === 'label'/.test(createMenuFn) && /createSmartLabelNode\(/.test(createMenuFn), 'createNodeFromMenu 认得 label 类型');
ok(/type !== 'label'/.test(createMenuFn), '从线上拖出来建标签时不硬接连线（标签没有端口）');
const createFn = topLevelFunction(js, 'createSmartLabelNode');
ok(/type: 'smart-label'/.test(createFn), '建出来的是 smart-label 节点');
ok(/labelStyle: 'solid'/.test(createFn) && /labelColor: SMART_LABEL_DEFAULT_COLOR/.test(createFn), '默认纯色底 + 默认色');
ok(/labelFontSize: SMART_LABEL_DEFAULT_FONT/.test(createFn) && /labelDot: true/.test(createFn), '默认字号与圆点');
ok(/selectedId = node\.id/.test(createFn), '建好即选中（样式面板随之打开）');

console.log('[2] 渲染：胶囊 / 无端口 / 无 hint / 尺寸自适应');
const bodyFn = topLevelFunction(js, 'nodeBodyHtml');
ok(/node\.type === 'smart-label'\) return smartLabelBodyHtml\(node\)/.test(bodyFn), 'nodeBodyHtml 分派到 smartLabelBodyHtml');
const labelBodyFn = topLevelFunction(js, 'smartLabelBodyHtml');
ok(/smart-label-pill is-\$\{node\.labelStyle\}/.test(labelBodyFn), '胶囊带背景三态的类名');
ok(/smart-label-dot/.test(labelBodyFn) && /node\.labelDot/.test(labelBodyFn), '圆点可开可关');
ok(/smart-label-icon/.test(labelBodyFn) && /node\.labelIcon/.test(labelBodyFn), '图标可开可关');
ok(/--label-accent/.test(labelBodyFn) && /--label-fg/.test(labelBodyFn), '颜色 / 文字色走 CSS 变量');
ok(/escapeHtml\(node\.text\)/.test(labelBodyFn), '文字进 DOM 前转义');
ok(/const isLabel = isSmartLabelNode\(node\)/.test(js), '渲染循环里认出了 isLabel');
ok(/isLabel \? 'label-smart-node' : ''/.test(js), '根节点挂上 label-smart-node 类');
ok(js.indexOf("isLabel ? '' : '<div class=\"node-port port-in\"") >= 0, '标签节点不渲染连线口');
ok(js.indexOf("isLabel || isEmpty ? '' : " + TICK + "<div class=\"node-hint\">") >= 0, '标签节点与空态图片节点都不渲染 hint');
const layoutFn = topLevelFunction(js, 'imageLayout');
ok(/node\?\.type === 'smart-label'/.test(layoutFn), 'imageLayout 有 smart-label 分支');
const mountFn = topLevelFunction(js, 'mountSmartLabelNodes');
ok(/pendingContentMeasure\.push\(\{node, el: pillEl, syncHost: hostEl\}\)/.test(mountFn), '胶囊按内容测量自然尺寸');
ok(/mountSmartLabelNodes\(\);/.test(js), 'render 之后跑一次标签测量');
const flushFn = topLevelFunction(js, 'flushContentMeasurements');
ok(/if\(item\.syncHost\)\{[\s\S]{0,240}updateNodeElementDuringResize\(item\.node\);/.test(flushFn), '量到尺寸立刻同步根节点（不等下一帧）');
ok(/smartLabelPanelNodeId === item\.node\.id\) positionSmartLabelPanel\(item\.node\)/.test(flushFn), '尺寸收敛后样式面板重新贴到胶囊旁边');

console.log('[3] 样式面板：三态背景 / 颜色 / 字号 / 圆点 / 图标');
['smartLabelPanel', 'smartLabelStyleSeg', 'smartLabelColors', 'smartLabelColorPicker', 'smartLabelFontSize', 'smartLabelDotToggle', 'smartLabelIcons'].forEach(id => {
    ok(html.indexOf('id="' + id + '"') >= 0, '面板标记里有 #' + id);
});
ok((html.match(/data-label-style="(outline|none|solid)"/g) || []).length === 3, '背景三态三个按钮都在（线框 / 无背景 / 纯色）');
const panelFn = topLevelFunction(js, 'syncSmartLabelPanel');
ok(/isSmartLabelNode\(node\)/.test(panelFn) && /panel\.classList\.add\('open'\)/.test(panelFn), '选中标签节点时打开面板');
ok(/closeSmartLabelPanel\(\)/.test(panelFn), '选别的节点 / 点空白时收起面板');
const updateFn = topLevelFunction(js, 'updateSmartLabelNode');
ok(/normalizeSmartLabel\(node\)/.test(updateFn) && /render\(\)/.test(updateFn) && /scheduleSave\(\)/.test(updateFn), '改字段后归一化 + 重绘 + 落盘');
ok(/syncSmartLabelPanel\(node\);/.test(js), 'updateComposer 里挂上面板同步（选中即出现）');
ok(/positionSmartLabelPanel\(labelNode\)/.test(js), '平移 / 缩放画布后面板跟着节点走');
ok(/SMART_LABEL_PALETTE\.map/.test(js) && /SMART_LABEL_ICONS\.map/.test(js), '色板与图标按钮由常量表生成');
const wheelBlock = js.slice(js.indexOf('WHEEL_LOCK_SELECTOR'), js.indexOf('WHEEL_LOCK_SELECTOR') + 900);
ok(/\.smart-label-panel/.test(wheelBlock), '面板在画布滚轮白名单里（不会误缩放画布）');

console.log('[4] 双击就地编辑');
const bindFn = topLevelFunction(js, 'bindNodeEvents');
ok(/isSmartLabelNode\(nodeForControls\)/.test(bindFn) && /beginSmartLabelEdit\(id\)/.test(bindFn), '双击标签进入就地编辑');
ok(/!isSmartLabelNode\(nodeForControls\)\) el\.ondblclick/.test(bindFn), '双击不再被通用 stopPropagation 吞掉');
const editFn = topLevelFunction(js, 'beginSmartLabelEdit');
ok(/setAttribute\('contenteditable', 'true'\)/.test(editFn), '文字切成 contenteditable');
ok(/event\.key === 'Enter'/.test(editFn) && /textEl\.blur\(\)/.test(editFn), '回车提交');
ok(/textEl\.textContent = original/.test(editFn), 'Esc 还原成打开前的文字');
ok(/SMART_LABEL_DEFAULT_TEXT/.test(editFn), '空内容回落到默认「标签」');
ok(/\.smart-label-text\[contenteditable="true"\]/.test(js), '正在编辑的文字不会被当成拖节点手柄');

console.log('[5] 行为：配色与字段兜底');
const consts = (js.match(/^const SMART_LABEL_[A-Z_]+ = .*$/gm) || []).join('\n');
const names = ['isSmartLabelNode', 'smartLabelFontSize', 'normalizeSmartLabel', 'smartLabelHexToRgba', 'smartLabelContrastColor', 'smartLabelTextColor'];
const extracted = names.map(name => topLevelFunction(js, name)).join('\n');
ok(Boolean(consts) && names.every(name => topLevelFunction(js, name)), '常量表与六个纯函数都能从源码里抽出来');
const api = new Function(consts + '\n' + extracted + '\nreturn {isSmartLabelNode, smartLabelFontSize, normalizeSmartLabel, smartLabelHexToRgba, smartLabelContrastColor, smartLabelTextColor};')();

{
    const node = api.normalizeSmartLabel({type: 'smart-label'});
    ok(node.text === '标签' && node.labelStyle === 'solid' && node.labelColor === '#22c55e' && node.labelFontSize === 13 && node.labelDot === true && node.labelIcon === '',
        '空节点补齐默认值（文字 / 纯色底 / 绿色 / 13px / 圆点开 / 无图标）');
}
{
    const node = api.normalizeSmartLabel({type: 'smart-label', text: '   ', labelStyle: 'rainbow', labelColor: 'red', labelFontSize: 999, labelDot: false, labelIcon: 'not-an-icon'});
    ok(node.text === '标签' && node.labelStyle === 'solid' && node.labelColor === '#22c55e' && node.labelFontSize === 40 && node.labelDot === false && node.labelIcon === '',
        '非法值全部收敛（背景回落纯色、颜色回落默认、字号夹到 40、未知图标清掉）');
}
ok(api.normalizeSmartLabel({type: 'smart-label', labelFontSize: 1}).labelFontSize === 10, '字号下限 10');
ok(api.smartLabelFontSize({labelFontSize: 22.4}) === 22, '字号取整');
ok(api.smartLabelHexToRgba('#22c55e', 0.2) === 'rgba(34, 197, 94, 0.2)', 'hex → rgba（图标底色用）');
ok(api.smartLabelHexToRgba('nope', 0.2) === 'transparent', '非法颜色给透明，不会拼出坏 CSS');
ok(api.smartLabelContrastColor('#ffffff') === '#111827' && api.smartLabelContrastColor('#111827') === '#ffffff', '亮底深字 / 暗底白字');
ok(api.smartLabelContrastColor('#22c55e') === '#111827', '亮绿底配深字（与参考图一致）');
ok(api.smartLabelTextColor({labelStyle: 'solid', labelColor: '#111827'}) === '#ffffff', '纯色底自动取反色当文字色');
ok(api.smartLabelTextColor({labelStyle: 'outline', labelColor: '#22c55e'}) === '', '线框 / 无背景不写死文字色（跟随主题）');
ok(api.smartLabelTextColor({labelStyle: 'solid', labelColor: '#111827', labelTextColor: '#ff0000'}) === '#ff0000', '自定义文字色优先');

console.log('[6] CSS + i18n');
ok(/\.image-node\.label-smart-node \{/.test(css), '有 .image-node.label-smart-node 外壳样式（透明、无边框）');
// AGENTS.md 硬规则：不画线框/发丝线，背景三态全部靠底色区分（软底 / 透明 / 纯色），谁都不描边
ok(/\.smart-label-pill\.is-outline \{[^}]*background:color-mix\(in srgb, var\(--label-accent\) 14%, transparent\)/.test(css), '线框态：主题色半透明软底（清扫线框后不再描边）');
ok(/\.smart-label-pill\.is-none \{[^}]*background:transparent/.test(css), '无背景态：不填底、也不描边');
ok(/\.smart-label-pill\.is-solid \{[^}]*background:var\(--label-accent\)/.test(css), '纯色态：底色用主题色');
ok(/\.smart-label-panel\.open \{/.test(css), '有样式面板样式');
ok(/\.smart-label-swatch \{/.test(css), '有色板样式');
[['smart.labelNode', '标签'], ['smart.labelPanelTitle', '标签样式'], ['smart.labelStyleOutline', '线框'], ['smart.labelStyleNone', '无背景'], ['smart.labelStyleSolid', '纯色'], ['smart.labelFontSize', '字号'], ['smart.labelDot', '圆点'], ['smart.labelIcon', '图标']].forEach(([key, zh]) => {
    const hit = new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "' + zh + '"').test(i18n);
    ok(hit, key + ' 的 i18n 已登记（zh=' + zh + '）');
});

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(item => console.error('  ✗ ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
