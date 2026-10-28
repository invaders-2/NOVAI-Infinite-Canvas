/* 「上游输入合并成一行编号卡片（含纯文本节点）+ 两档输出类型控件」的回归测试（零依赖）。

   覆盖：
   [1] 一行编号卡片：图片在前文本在后、角标只写 1..N、类型图标、末尾「+」
   [2] 上限收成「+N」；没有输入时整行为空（不占高度）
   [3] 纯文本节点也渲染同一套输入行；没有输入不渲染
   [4] 行高度公式（5 列节奏）；提示词节点高度不再单独叠图片行/74px
   [5] 「+」卡片复用现有上传/建节点/连线（不新造链路）+ 绑定行为
   [6] 输出类型控件只剩两档，自动识别结果 = 选中档

   跑法：node tests/test_smart_input_cards.js */
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
function konst(name){
    const match = js.match(new RegExp('^const ' + name + ' = [\\s\\S]*?;$', 'm'));
    return match ? match[0] : '';
}
const escHtml = text => String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = escHtml;
const TR = {
    'smart.inputRowLabel': '输入',
    'smart.inputAddTip': '添加输入',
    'smart.upstreamViewTip': '查看全文',
    'smart.upstreamTextLabel': '文本'
};
const trStub = key => (TR[key] == null ? key : TR[key]);

/* 抽真实的卡片行实现，把「数据从哪来」用桩替换 */
function cardsApi(options){
    const opts = options || {};
    const src = konst('SMART_INPUT_CARD_LIMIT')
        + fn('smartNodeInputMediaCards')
        + fn('smartInputMediaKindLabel')
        + fn('smartInputMediaCardHtml')
        + fn('smartInputTextCardHtml')
        + fn('smartInputAddCardHtml')
        + fn('smartNodeInputCardsHtml')
        + '\nreturn {smartNodeInputCardsHtml, smartNodeInputMediaCards};';
    return new Function(
        'isSmartPromptNode', 'promptNodeInputImages', 'inputImagesFor', 'promptNodeUpstreamPromptEntries',
        'mediaKindForItem', 'smartVideoPreviewHtml', 'smartPreviewImgHtml', 'smartUpstreamChipLabel',
        'tr', 'trf', 'escapeAttr', 'escapeHtml', src
    )(
        node => node && node.type === 'smart-prompt',
        node => (node && node.__media) || [],
        node => (node && node.__media) || [],
        node => (node && node.__texts) || [],
        item => (item && item.kind) || 'image',
        item => '<video data-src="' + escAttr(item.url || '') + '"></video>',
        item => '<img data-src="' + escAttr(item.url || '') + '">',
        opts.label || ((entry, index) => entry.label || ('文本' + (index + 1))),
        trStub,
        (key, vars) => key + ':' + JSON.stringify(vars),
        escAttr,
        escHtml
    );
}
const cards = cardsApi();

console.log('[1] 一行编号卡片：图片在前、文本在后，角标只写 1..N');
{
    const node = {
        type: 'smart-prompt',
        __media: [{url:'/a.png', kind:'image', name:'产品图'}, {url:'/b.mp4', kind:'video'}, {url:'/c.mp3', kind:'audio'}],
        __texts: [{label:'文本1', text:'第一段'}, {label:'文本2', text:'第二段'}]
    };
    const html = cards.smartNodeInputCardsHtml(node);
    ok(html.indexOf('class="smart-input-row"') >= 0, '渲染成一个输入行容器');
    ok((html.match(/class="smart-input-card /g) || []).length === 6, '5 个输入 + 1 个「+」= 6 张卡片');
    ok((html.match(/data-smart-input-add="1"/g) || []).length === 1, '末尾有一张「+」卡片');
    ok(html.lastIndexOf('is-add') > html.lastIndexOf('is-text'), '「+」排在最后一张');
    ok(html.indexOf('is-image') < html.indexOf('is-video') && html.indexOf('is-video') < html.indexOf('is-audio'), '图片 → 视频 → 音频在前');
    ok(html.indexOf('is-audio') < html.indexOf('is-text'), '文本卡片排在图片来源之后');
    const badges = [...html.matchAll(/smart-input-card-badge">([^<]+)</g)].map(m => m[1]);
    ok(JSON.stringify(badges) === JSON.stringify(['1','2','3','4','5']), '角标只写序号 1..5（不再写「图N/文本N」）：' + badges.join(','));
    ok(html.indexOf('<img data-src="/a.png">') >= 0, '图片卡片是缩略图');
    ok(html.indexOf('<video data-src="/b.mp4">') >= 0, '视频卡片是首帧（视频预览）');
    ok(html.indexOf('data-lucide="file-audio"') >= 0, '音频卡片是音频图标');
    ok(html.indexOf('data-lucide="file-text"') >= 0, '文本卡片是线性文档图标');
    ok(html.indexOf('data-lucide="plus"') >= 0, '「+」卡片是线性加号');
    ok(html.indexOf('title="图片 1 · 产品图"') >= 0, '图片卡片 title 写「类型 + 序号 + 名称」');
    ok(html.indexOf('title="文本1 · 查看全文"') >= 0, '文本卡片 title 写「编号 · 查看全文」');
    ok(html.indexOf('data-upstream-prompt-index="0"') >= 0 && html.indexOf('data-upstream-prompt-index="1"') >= 0, '文本卡片带序号索引（点开看全文用）');
    ok(html.indexOf('第一段') < 0 && html.indexOf('第二段') < 0, '卡片里不含全文（只在上游/浮层里）');
}

console.log('[2] 上限「+N」；没有输入时整行为空');
{
    const many = { type:'smart-prompt', __media: new Array(8).fill(0).map((_, i) => ({url:'/m' + i + '.png'})), __texts: new Array(5).fill(0).map((_, i) => ({label:'文本' + (i+1)})) };
    const html = cards.smartNodeInputCardsHtml(many);
    ok((html.match(/class="smart-input-card /g) || []).length === 12, '10 张输入 + 「+N」+「+」= 12 张（超出不收）');
    ok(html.indexOf('is-more') >= 0 && html.indexOf('>+3<') >= 0, '超出 3 个收成「+3」');
    const badges = [...html.matchAll(/smart-input-card-badge">([^<]+)</g)].map(m => Number(m[1]));
    ok(badges.length === 10 && badges[9] === 10, '角标最多到 10');

    ok(cards.smartNodeInputCardsHtml({type:'smart-prompt'}) === '', '没有输入时返回空串（不渲染、不占高度）');
    ok(cards.smartNodeInputCardsHtml({type:'smart-text'}) === '', '纯文本节点没有输入时也返回空串');
}

console.log('[3] 纯文本节点也渲染同一套输入行');
{
    const textBodySrc = fn('smartTextBodyHtml');
    ok(textBodySrc.length > 100, '拿到 smartTextBodyHtml');
    ok(/const inputRow = smartNodeInputCardsHtml\(node\);/.test(textBodySrc), '纯文本节点调用同一个卡片行函数');
    ok(/\$\{inputRow\}/.test(textBodySrc), '卡片行插在卡片内容上方');
    ok(/has-input-row/.test(textBodySrc), '只有有输入时才加 has-input-row');

    const bodyApi = new Function(
        'smartTextOwnText', 'smartTextUpstreamText', 'smartNodeInputCardsHtml', 'smartTextFlowHtml',
        'tr', 'trf', 'escapeHtml',
        textBodySrc + '\nreturn smartTextBodyHtml;'
    )(
        node => node.own || '',
        node => node.upstream || '',
        node => (node.hasInputs ? '<div class="smart-input-row"></div>' : ''),
        text => '<div class="smart-text-flow">' + text + '</div>',
        trStub,
        (key, vars) => key + ':' + JSON.stringify(vars),
        escHtml
    );
    const withInputs = bodyApi({own:'正文', hasInputs:true});
    ok(withInputs.indexOf('smart-input-row') >= 0, '有输入时卡片里有输入行');
    ok(withInputs.indexOf('smart-input-row') < withInputs.indexOf('smart-text-preview'), '输入行在正文区上方');
    const noInputs = bodyApi({own:'正文'});
    ok(noInputs.indexOf('smart-input-row') < 0 && noInputs.indexOf('has-input-row') < 0, '没有输入时既没有行也没有 has-input-row');
    const emptyWithInputs = bodyApi({hasInputs:true});
    ok(emptyWithInputs.indexOf('smart-input-row') >= 0 && emptyWithInputs.indexOf('smart-text-empty-state') >= 0, '空文本节点有输入时显示行 + 空态');
}

console.log('[4] 行高度：5 列节奏；没有输入不占高度');
{
    const src = konst('SMART_INPUT_CARD_LIMIT') + fn('smartNodeInputCardCount') + fn('smartNodeInputRowHeight')
        + '\nreturn {smartNodeInputCardCount, smartNodeInputRowHeight};';
    const api = new Function('smartNodeInputMediaCards', 'promptNodeUpstreamPromptEntries', src)(
        node => (node && node.__media) || [],
        node => (node && node.__texts) || []
    );
    ok(api.smartNodeInputRowHeight({}) === 0, '没有输入 → 0（不占高度）');
    ok(api.smartNodeInputRowHeight({__media:[{url:'a'}]}) === 52, '1 个输入 + 「+」= 一行 44 + 上下 8 = 52');
    ok(api.smartNodeInputRowHeight({__media:[{url:'a'}], __texts:[{label:'文本1'}]}) === 52, '2 个输入仍是一行');
    ok(api.smartNodeInputRowHeight({__media: new Array(5).fill(0).map((_, i) => ({url:'m' + i}))}) === 102, '5 个输入 + 「+」= 6 张 → 两行（44*2 + 6 + 8）');
    ok(api.smartNodeInputCardCount({__media: new Array(20).fill(0).map((_, i) => ({url:'m' + i}))}) === 10, '计数上限 10');

    const layoutFn = fn('promptNodeExpandedHeight');
    ok(/smartNodeInputRowHeight\(node\)/.test(layoutFn), '提示词节点高度用这一行的高度');
    ok(!/smartNodeInputThumbsHeight/.test(layoutFn) && !/smartNodeUpstreamChipsHeight/.test(layoutFn), '不再分别叠加图片行 / 文本行');
    ok(!/\b74\b/.test(layoutFn), '没有 74px 固定预留');
}

console.log('[5] 「+」卡片：复用现有上传 / 建节点 / 连线');
{
    const pickerFn = fn('pickSmartNodeInputFiles');
    ok(pickerFn.length > 300, '拿到 pickSmartNodeInputFiles');
    ok(/input\.accept = 'image\/\*,video\/\*,audio\/\*'/.test(pickerFn), '文件选择接受图片 / 视频 / 音频');
    ok(/isSupportedUploadFile/.test(pickerFn) && /uploadFiles\(files\)/.test(pickerFn), '复用 isSupportedUploadFile + uploadFiles');
    ok(/appendImagesToSmartNode\(/.test(pickerFn), '复用 appendImagesToSmartNode 建媒体节点');
    ok(/connectInputNode\(mediaNode\.id, node\.id\)/.test(pickerFn), '建成后连到这个节点的 input');
    ok(/collabReadOnly/.test(pickerFn) && /collabNotifyReadOnly/.test(pickerFn), '只读协作时挡住');
    ok(/pushUndo\(\)/.test(pickerFn) && /scheduleSave\(\)/.test(pickerFn), '进撤销栈 + 落盘');

    const bindFn = fn('bindSmartInputRow');
    ok(Boolean(bindFn) && /data-upstream-prompt-index/.test(bindFn) && /openUpstreamPromptView\(node/.test(bindFn), '文本卡片点击 → 看全文浮层');
    ok(/data-smart-input-add/.test(bindFn) && /pickSmartNodeInputFiles\(node\)/.test(bindFn), '「+」点击 → 选文件加输入');
    ok(/'mousedown', 'click', 'dblclick'/.test(bindFn) && /stopPropagation/.test(bindFn), '卡片吃掉鼠标事件（不拖节点 / 不打开纯文本大编辑器）');
    ok(/dataset\.smartInputBound === '1'/.test(bindFn), '同一行只绑一次（keepEl 复用不重复绑）');

    ok(/bindSmartInputRow\(el, node\);/.test(js), '提示词节点控制台接上输入行绑定');
    ok(/bindSmartInputRow\(el, nodeForControls\);/.test(js), '纯文本节点接上同一套绑定');
}

console.log('[6] 输出类型控件已下线，判定仍全自动');
{
    ok(!/SMART_LLM_OUTPUT_KINDS|llmOutputKindHtml|llmOutputKindTip|smartLlmOutputKindMode/.test(js), '控件相关函数/常量已从 JS 删除');
    ok(!/data-llm-output-kind|prompt-llm-kind-option|prompt-llm-output-kind/.test(js), 'DOM 里不会再出现输出类型控件');
    ok(!/node\.llmOutputKind\s*=/.test(js) && !/delete node\.llmOutputKind/.test(js), '不再写/删手动覆盖字段');
    const resolveFn = fn('smartLlmResolvedOutputKind');
    ok(/return smartLlmAutoOutputKind\(smartLlmOutputKindSourceText\(node, ctx\)\)/.test(resolveFn), '生效类型 = 自动判定结果');
    ok(/const outputKind = smartLlmResolvedOutputKind\(node\);/.test(fn('promptNodeBodyHtml')), '渲染仍按自动判定决定 Markdown');
    const runAt = js.indexOf('async function runPromptLLMNode(');
    const runBody = runAt < 0 ? '' : js.slice(runAt, runAt + 2600);
    ok(/const outputKind = smartLlmResolvedOutputKind\(node\);/.test(runBody), '运行仍按自动判定决定 system / max_tokens');
    ok(!/smart\.llmOutputKind/.test(i18n), '控件 i18n 已清理');
    ok(!/prompt-llm-kind-option|is-auto-derived/.test(css), '控件样式已清理');
}

console.log('');
if(fails.length){
    console.error('上游输入卡片：失败 ' + fails.length + ' 项');
    fails.forEach(item => console.error('  x ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('上游输入卡片：' + pass + ' 项通过');
