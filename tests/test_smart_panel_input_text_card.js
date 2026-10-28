/* task-10 修正的回归测试（零依赖）：
   A. 媒体节点 body 上那行输入行已撤回（不残留高度补偿 / nodeBodyHtml 分支 / CSS）；
   B. 生成面板「参考图那一行」把上游文本作为一张只读「文本」卡片展示，点开全文，计数改成「N 输入」；
   C. 面板里「上游输入」灰底大文本块已删，批量生成节点那段说明保留。

   跑法：node tests/test_smart_panel_input_text_card.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function fn(name){
    const lines = js.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1) if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    return '';
}

console.log('[A] 媒体节点上的输入行已撤回');
{
    ok(!/smartNodeBoxLayout|smartMediaInputRowHeight|MEDIA_INPUT_ROW_GAP/.test(js), 'task-9 的行高补偿函数已删除');
    ok(!/function mediaNodeBodyHtml/.test(js), 'mediaNodeBodyHtml 分支已删除');
    ok(/const layout = imageLayout\(imgs, scale, node\);/.test(js), '根节点尺寸回到 imageLayout');
    ok(/const body = nodeBodyHtml\(node, layout\);/.test(js), '根节点正文回到 nodeBodyHtml');
    const rectFn = fn('nodeRect');
    ok(/const layout = imageLayout\(node\.images \|\| \[\], nodeScale\(node\), node\);/.test(rectFn), 'nodeRect 回到 imageLayout');
    const resizeFn = fn('updateNodeElementDuringResize');
    ok(/const layout = imageLayout\(imgs, nodeScale\(node\), node\);/.test(resizeFn), '拖拽改尺寸回到 imageLayout');
    ok(!/contentLayout/.test(resizeFn), '不再有 contentLayout（媒体内容不再被单独降高）');
    ok(!/if\(isSmartMediaNode\(nodeForControls\)\) bindSmartInputRow/.test(js), '媒体节点不再绑输入行');
    ok(!/\.node-body > \.smart-input-row/.test(css), '媒体节点输入行的 CSS 段已删除');
    /* 卡片组件与绑定本身要留着（提示词 / 纯文本节点还在用） */
    ok(/function smartNodeInputCardsHtml\(/.test(js) && /function bindSmartInputRow\(/.test(js), '卡片组件与绑定保留');
    ok(/if\(nodeForControls\?\.type === 'smart-prompt'\) bindPromptNodeControls\(el, nodeForControls\);/.test(js), '提示词节点绑定照旧');
    ok(/bindSmartInputRow\(el, nodeForControls\);/.test(js), '纯文本节点绑定照旧');
}

console.log('[B] 生成面板参考图行里的「文本」卡片');
{
    const rowFn = fn('renderInputThumbsRow');
    ok(/const upstreamText = panelUpstreamInputText\(node\);/.test(rowFn), '行里取上游文本');
    ok(/input-thumb-text/.test(rowFn) && /data-input-text-card="1"/.test(rowFn), '渲染一张文本卡片');
    ok(/file-text/.test(rowFn), '卡片是线性 file-text 图标');
    ok(/smart\.inputTextCardLabel/.test(rowFn), '标签走 i18n（文本 / Text）');
    ok(/smart\.upstreamViewTip/.test(rowFn), 'title 写「查看全文」');
    ok(/const totalInputs = dedup\.length \+ \(hasTextCard \? 1 : 0\);/.test(rowFn), '计数把文本卡一起算');
    ok(/tr\('smart\.inputCount'\)\.replace\('\{n\}', String\(totalInputs\)\)/.test(rowFn), '「N 输入」用总数');
    const textCardSrc = (rowFn.match(/const textCardHtml = hasTextCard[\s\S]*?: '';/) || [''])[0];
    ok(Boolean(textCardSrc) && !/class="input-thumb /.test(textCardSrc) && !/data-thumb-index/.test(textCardSrc),
        '文本卡片不带 .input-thumb / data-thumb-index（不参与拖拽/删除/进 images）');
    ok(/if\(!dedup\.length && !hasTextCard\)/.test(rowFn), '只有文本、没有图片时这一行也渲染（不再当成空状态）');
    ok(/text: upstreamText/.test(rowFn), '上游文本变了会重建这一行（缓存签名带上文本）');

    const bindFn = fn('bindInputTextCard');
    ok(Boolean(bindFn), '有 bindInputTextCard');
    ok(/'mousedown', 'click', 'dblclick'/.test(bindFn) && /stopPropagation/.test(bindFn), '卡片吃掉鼠标事件（不触发画布拖拽/选图）');
    ok(/openUpstreamTextView\(text, tr\('smart\.inputTextCardLabel'\), card\)/.test(bindFn), '点卡片 → 现有全文浮层');
    ok(/bindInputTextCard\(upstreamText\);/.test(rowFn), '渲染完接上绑定');
    ok(/function openUpstreamTextView\(text, title, anchorEl\)/.test(js), '浮层改成通用「一段文本」打开');
    ok(/function openUpstreamPromptView\(node, index, anchorEl\)\{[\s\S]{0,200}openUpstreamTextView\(entry\.text/.test(js), '提示词/纯文本节点的卡片仍走同一个浮层（行为不变）');

    const textSrc = fn('panelUpstreamInputText');
    ok(/isSmartGroupNode\(node\) \? textForNode\(node, ctx\)\.trim\(\) : ''/.test(textSrc), '分组节点带上自己的透传文本');
    ok(/inputPromptTextFor\(node, ctx\)\.trim\(\)/.test(textSrc), '上游文本用 inputPromptTextFor（与旧「上游输入」块同源）');
    const api = new Function('isSmartGroupNode', 'textForNode', 'inputPromptTextFor', 'smartLoopContext',
        textSrc + '\nreturn panelUpstreamInputText;')(
        n => Boolean(n && n.type === 'smart-group'),
        () => '分组文本',
        () => '上游文本',
        {}
    );
    ok(api({type:'smart-group'}) === '分组文本\n\n上游文本', '文本卡内容 = 分组文本 + 上游文本（空行分隔）');
    ok(api({type:'smart-image'}) === '上游文本', '普通节点只有上游文本');
    const api2 = new Function('isSmartGroupNode', 'textForNode', 'inputPromptTextFor', 'smartLoopContext',
        textSrc + '\nreturn panelUpstreamInputText;')(() => false, () => '', () => '', {});
    ok(api2({type:'smart-image'}) === '', '没有上游文本 → 空串（不渲染卡片）');
}

console.log('[C] 面板里的「上游输入」大块已删、批量说明保留');
{
    const previewFn = fn('renderInputPromptPreview');
    ok(!/smart\.inputUpstream/.test(previewFn), '不再渲染「上游输入」标签');
    ok((previewFn.match(/input-prompt-preview-text/g) || []).length === 1, '灰底大文本块只剩批量说明那一处');
    ok(!/input-prompt-preview-label">\$\{escapeHtml\(tr\('smart\.inputUpstream'\)\)/.test(previewFn), '普通节点不再拼「上游输入」块');
    ok(/inputPromptPreview\.classList\.remove\('has-text'\)/.test(previewFn) && /inputPromptPreview\.innerHTML = ''/.test(previewFn), '普通节点清空（不留空白占位）');
    ok(/isSmartBatchNode\(node\)/.test(previewFn) && /批量生成/.test(previewFn), '批量生成节点的说明块保留');
    ok(/按节点里「生成输入」勾选的行逐行生成/.test(previewFn), '批量说明文案还在');
}

console.log('[D] i18n / 样式 / 不影响请求参数');
{
    ok(/"smart\.inputCount": \{ zh: "\{n\} 输入"/.test(i18n), '计数文案改成「N 输入」');
    ok(/"smart\.inputTextCardLabel": \{ zh: "文本"/.test(i18n), '文本卡片标签已登记');
    ok(/\.input-thumb-text \{[\s\S]{0,300}width:42px; height:42px/.test(css), '文本卡与缩略图卡同尺寸（42px）');
    ok(/\.input-thumb-text i, \.input-thumb-text svg \{[\s\S]{0,80}width:16px/.test(css), '图标保持线性尺寸');
    const rowCss = css.slice(css.indexOf('参考图行里的「文本」卡片'), css.indexOf('参考图行里的「文本」卡片') + 900);
    ok(!/border\s*:\s*[^;]*(solid|dashed|1px)/.test(rowCss), '文本卡没有 border 线框');
    ok(!/box-shadow\s*:\s*inset/.test(rowCss), '没有 inset 描边');
    /* images 列表不能多出文本：文本卡只存在于 DOM，reference 列表仍来自 visibleReferenceImagesFor */
    ok(/const dedup = node \? visibleReferenceImagesFor\(node\) : \[\];/.test(fn('renderInputThumbsRow')), '发给模型的参考素材来源没变');
    ok(!/dedup\.push\(|dedup\.unshift\(/.test(fn('renderInputThumbsRow')), '没有把文本塞进参考素材数组');
}

console.log('');
if(fails.length){
    console.error('面板文本卡/撤回：失败 ' + fails.length + ' 项');
    fails.forEach(item => console.error('  x ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('面板文本卡/撤回：' + pass + ' 项通过');
