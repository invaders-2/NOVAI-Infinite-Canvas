/* 「文本生成」节点：控制台整块搬到下方编辑栏 的回归测试。
   用户需求：节点上原本堆着很多功能/按钮（模板库·分隔符·LLM 药丸、节点/聊天/System/反推、
   平台模型、INPUT、OUTPUT、输出形式、运行）——全部统一到编辑栏里，节点上只留结果预览。
   实现：控制台仍是节点渲染出来的 .prompt-node-card[data-prompt-console]（真 DOM，监听器/聊天记录都在），
   选中该节点时由 syncPromptConsoleToComposer 整块搬进 #composerConsoleHost；节点里那份由 CSS 隐藏。
   跑法：node tests/test_smart_canvas_prompt_display.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

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

console.log('[1] 节点侧：只剩只读预览，控制台留在 DOM 里等搬运');
const previewFn = topLevelFunction(js, 'promptNodePreviewHtml');
ok(Boolean(previewFn), '有 promptNodePreviewHtml');
const bodyFn = topLevelFunction(js, 'promptNodeBodyHtml');
ok(/\$\{promptNodePreviewHtml\(node\)\}/.test(bodyFn), '节点正文第一块就是预览');
ok(/data-prompt-console="1"/.test(bodyFn), '控制台仍渲染在节点里（带 data-prompt-console 标记，供搬运）');
ok(!/class="prompt-node-text/.test(bodyFn), '节点里不再有输入框');
ok(/is-empty/.test(previewFn), '预览带 is-empty（占位文字走浅色）');
ok(/promptChatPreviewEmpty/.test(previewFn) && /promptLlmPreviewEmpty/.test(previewFn), '两种模式的空态文案各有各的');
ok(/chatMessages[\s\S]{0,120}reverse\(\)[\s\S]{0,80}find/.test(previewFn), '聊天模式预览最后一条消息');
ok(/outputText \|\| node\.text/.test(previewFn), 'LLM 节点模式预览输出（outputText/text）');
ok(/TEXT_LINES_GLYPH/.test(previewFn) && /^const TEXT_LINES_GLYPH = .*M4 5h16M4 10h16M4 15h16M4 20h9/m.test(js), '空态图标是自绘的四条杆（前三条等长、第四条短一截）');
const promptItemsFn = new Function(topLevelFunction(js, 'promptNodePromptItems') + '\nreturn promptNodePromptItems;')();
ok(JSON.stringify(promptItemsFn({text:'一段;二段', promptSplitEnabled:true, promptSeparator:';'})) === '["一段;二段"]', '历史分隔符设置不再暗中拆词');
const splitHeightFn = new Function(topLevelFunction(js, 'promptNodeSplitExtraHeight') + '\nreturn promptNodeSplitExtraHeight;')();
ok(splitHeightFn({promptSplitEnabled:true}) === 0, '历史分隔符设置不再撑高控制台');

console.log('[2] 编辑栏侧：控制台搬进 #composerConsoleHost');
ok(html.indexOf('id="composerConsoleHost"') >= 0, '编辑栏里有承载控制台的容器');
const syncFn = topLevelFunction(js, 'syncPromptConsoleToComposer');
ok(/querySelector\('\.prompt-node-card\[data-prompt-console="1"\]'\)/.test(syncFn), '从节点里找控制台');
ok(/host\.replaceChildren\(inNode\)/.test(syncFn), '把控制台整块搬进 host（真 DOM，不重建）');
ok(/dataset\.promptConsoleNode = node\.id/.test(syncFn), 'host/控制台都记下是哪个节点的');
ok(/if\(host\.dataset\.promptConsoleNode === node\.id && host\.querySelector\('\.prompt-node-card\[data-prompt-console="1"\]'\)\) return true;/.test(syncFn), '同一节点重复调用是幂等的（keepEl 复用时不重复搬）');
ok(/promptConsolePark[\s\S]{0,200}host\.replaceChildren\(parked\)/.test(syncFn), '停在 park 里的控制台，选中时搬回编辑栏');
const parkFn = topLevelFunction(js, 'parkPromptConsoles');
ok(/world\.querySelectorAll\('\.image-node\[data-id\] \.prompt-node-card\[data-prompt-console="1"\]'\)/.test(parkFn), '渲染完把没选中的控制台挪出节点 DOM');
ok(/park\.appendChild\(card\)/.test(parkFn), '挪进 hidden 的 park（避免 :has(.prompt-node-llm) 把节点撑到 300px）');
ok(/parkPromptConsoles\(\);\s*restorePromptNodeChatUiState\(chatUiState\);/.test(js), 'park 紧跟 bindNodeEvents、在恢复聊天滚动之前');
ok(html.indexOf('id="promptConsolePark"') >= 0, '页面里有 park 容器');
ok(/\.prompt-console-park \{ display:none; \}/.test(css), 'park 是隐藏的');
const composerFn = topLevelFunction(js, 'updateComposer');
const branch = composerFn.slice(composerFn.indexOf('if(isSmartPromptNode(node))'), composerFn.indexOf("composer.classList.remove('prompt-text-mode')"));
ok(branch.length > 200, 'updateComposer 里有文本生成节点分支');
ok(/composer\.classList\.toggle\('prompt-console-mode', consoleMode\)/.test(branch), '开了 LLM → prompt-console-mode');
ok(/composer\.classList\.toggle\('prompt-text-mode', !consoleMode\)/.test(branch), '没开 LLM → prompt-text-mode（只有文本框）');
ok(/syncPromptConsoleToComposer\(node\)/.test(branch), '选中时把控制台搬进编辑栏');
ok(/setPromptInputLocked\(consoleMode\)/.test(branch), '控制台模式锁掉编辑栏自带的输入框');
ok(/positionComposerForNode\(node\)/.test(branch), '编辑栏仍然锚在节点下方');
ok(/composer\.classList\.remove\('prompt-console-mode'\)/.test(composerFn), '选中别的节点时退出控制台模式');

console.log('[3] 输入写回：LLM 模式不吃编辑栏的文本框');
const loadFn = topLevelFunction(js, 'loadPromptDraft');
ok(/isSmartPromptNode\(subject\)\)\{\s*setPromptText\(subject\.llmEnabled \? '' : String\(subject\.text \|\| ''\)\);\s*return;/.test(loadFn), 'LLM 节点不往编辑栏文本框里塞正文');
const saveFn = topLevelFunction(js, 'savePromptDraftForCurrent');
ok(/isSmartPromptNode\(subject\)\)\{\s*if\(!subject\.llmEnabled\) saveSmartPromptTextFromComposer\(subject\);\s*return;/.test(saveFn), 'LLM 节点不把编辑栏文本框写回 node.text');
const writeFn = topLevelFunction(js, 'saveSmartPromptTextFromComposer');
ok(/if\(!isSmartPromptNode\(node\) \|\| node\.llmEnabled\) return;/.test(writeFn), '写回函数自己再兜一层：LLM 模式直接 return');

console.log('[4] 聊天记录跟着控制台走');
const rootFn = topLevelFunction(js, 'promptNodeUiRoot');
ok(/prompt-node-card\[data-prompt-console="1"\]/.test(rootFn) && /composerConsoleHost/.test(rootFn), 'UI 根节点：节点里有控制台就用节点，否则用编辑栏 host');
const capFn = topLevelFunction(js, 'capturePromptNodeChatUiState');
ok(/captureFrom\(document\.getElementById\('composerConsoleHost'\)\)/.test(capFn), '捕获聊天滚动时也扫编辑栏');
ok(/log\.scrollHeight - log\.scrollTop - log\.clientHeight < 12/.test(capFn), '贴底判定沿用 12px 阈值');
const restoreFn = topLevelFunction(js, 'restorePromptNodeChatUiState');
ok(/const log = promptNodeUiRoot\(id\)\?\.querySelector\('\.llm-chat-log'\)/.test(restoreFn), '恢复滚动走 promptNodeUiRoot');
ok(/log\.scrollTop = pos\.atBottom \? log\.scrollHeight : \(pos\.top \|\| 0\)/.test(restoreFn), '贴底复原到底、否则回原位');
ok(/promptNodeUiRoot\(target\.id\)\?\.querySelector\(target\.selector\)/.test(restoreFn), '焦点恢复也认编辑栏里的输入框');

console.log('[5] 节点尺寸收回预览大小');
const layoutFn = topLevelFunction(js, 'promptNodeLayoutSize');
ok(/node\?\.sizeUserSet && Number\.isFinite\(explicitH\) && explicitH > 24 \? Math\.round\(explicitH\) : promptNodeAutoHeight\(node\)/.test(layoutFn), '只有手动拖过尺寸才听 node.h，否则跟着预览文字的实测高度走');
ok(!/promptNodeExpandedHeight\(node\)/.test(layoutFn), '不再叠加 LLM 面板 / 分隔符预览的高度');

console.log('[6] CSS + i18n');
ok(/\.image-node \.prompt-node-card\[data-prompt-console="1"\] \{ display:none; \}/.test(css), '节点里的控制台被藏起来');
ok(/\.composer\.prompt-text-mode \.composer-console-host,/.test(css) && /\.composer\.prompt-console-mode \.composer-console-host/.test(css), '两种模式下 host 都会显示');
ok(/\.composer\.prompt-console-mode \.prompt-row,/.test(css), '控制台模式收起编辑栏自带的输入框');
ok(/\.composer\.prompt-console-mode \.composer-actions \{ display:none; \}/.test(css), '控制台模式收起编辑栏的运行按钮（运行在控制台里）');
ok(/\.composer-console-host \.prompt-node-card \{ width:100%; height:auto/.test(css), 'host 里的控制台按编辑栏宽度铺开');
[['smart.promptLlmPreviewEmpty', '点击在下方控制台里配置并运行'], ['smart.promptChatPreviewEmpty', '点击在下方控制台里继续聊天']].forEach(([key, zh]) => {
    ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "' + zh + '"').test(i18n), key + ' 的 i18n 已登记');
});

console.log('[7] 行为：预览函数 + 搬运函数');
const glyphConst = (js.match(/^const TEXT_LINES_GLYPH = .*$/m) || [''])[0];
const previewApi = new Function('tr', 'escapeHtml', glyphConst + '\n' + previewFn + '\nreturn promptNodePreviewHtml;')(
    key => ({'smart.promptPlaceholderNode':'输入提示词...','smart.promptLlmPreviewEmpty':'点击在下方控制台里配置并运行','smart.promptChatPreviewEmpty':'点击在下方控制台里继续聊天'}[key] || key),
    text => String(text == null ? '' : text)
);
{
    const out = previewApi({type:'smart-prompt', text:'一段提示词'});
    ok(out.includes('一段提示词') && out.includes('prompt-node-display'), '行为：普通节点预览正文');
    const out2 = previewApi({type:'smart-prompt', text:'旧', outputText:'模型输出', llmEnabled:true});
    ok(out2.includes('模型输出'), '行为：LLM 节点预览输出而不是旧正文');
    const out3 = previewApi({type:'smart-prompt', llmEnabled:true, llmTab:'chat', chatMessages:[{role:'user',content:'问题'},{role:'assistant',content:'回答'}]});
    ok(out3.includes('回答'), '行为：聊天模式预览最后一条消息');
    const out4 = previewApi({type:'smart-prompt', llmEnabled:true, llmTab:'chat', chatMessages:[]});
    ok(out4.includes('is-empty') && out4.includes('继续聊天'), '行为：聊天无消息时显示空态文案');
    const out5 = previewApi({type:'smart-prompt', text:''});
    ok(out5.includes('is-empty') && out5.includes('输入提示词'), '行为：空节点显示占位文案');
}
{
    const moved = {};
    const parked = [];
    const consoleEl = {dataset:{}, remove(){ moved.removed = true; }};
    const nodeEl = {querySelector: sel => (sel.indexOf('prompt-node-card') >= 0 ? consoleEl : null)};
    const parkEl = {querySelectorAll: () => parked.slice(), appendChild(el){ if(parked.indexOf(el) < 0) parked.push(el); }};
    const hostEl = {dataset:{}, _child:null,
        querySelector(){ return this._child; },
        replaceChildren(el){ moved.moved = el; this._child = el; this.dataset.promptConsoleNode = el.dataset.promptConsoleNode; }};
    /* syncPromptConsoleToComposer 现在还会调 releasePromptConsoleHost / promptConsoleCardForNode /
       promptConsoleParkCard —— 一起抽进来；假 DOM 也补上现在用到的新能力（:scope 查询、replaceChildren、remove）。 */
    const syncSrc = topLevelFunction(js, 'syncPromptConsoleToComposer')
        + topLevelFunction(js, 'releasePromptConsoleHost')
        + topLevelFunction(js, 'schedulePromptConsoleRebuild')
        + topLevelFunction(js, 'promptConsoleParkCard')
        + '\nreturn syncPromptConsoleToComposer(node);';
    const api = new Function('CSS', 'world', 'document', 'nodes', 'isSmartPromptNode', 'requestAnimationFrame', 'selectedNode', 'render', 'promptNodeBodyHtml', 'node', 'promptConsoleRebuildPending', syncSrc)(
        {escape: v => v},
        {querySelector: () => nodeEl},
        {getElementById: id => (id === 'composerConsoleHost' ? hostEl : (id === 'promptConsolePark' ? parkEl : null)),
         createElement: () => ({content:{querySelector: () => null}, set innerHTML(v){}})},
        [],
        n => n.type === 'smart-prompt',
        () => {}, () => {}, () => {}, () => '',
        {id:'p1', type:'smart-prompt'}, new Set()
    );
    ok(parked.length === 0, '行为：编辑栏里原本没有别的控制台 → 不需要送走任何东西');
    ok(api === true && moved.moved === consoleEl, '行为：控制台被搬进 host');
    ok(hostEl.dataset.promptConsoleNode === 'p1' && consoleEl.dataset.promptConsoleNode === 'p1', '行为：host 与控制台都记下节点 id');
}


console.log('[8] 控制台底部一行：供应商/模型在左下角，输出形式与角色都改成下拉');
const bodyForRows = topLevelFunction(js, 'promptNodeBodyHtml');
ok(/\$\{providerModelHtml\}/.test(bodyForRows), '供应商/模型抽成一块 HTML（两处复用）');
ok(!/prompt-llm-model-row/.test(bodyForRows), '顶部那行「供应商 + 模型」已经拿掉');
ok((bodyForRows.match(/prompt-node-bottom-row/g) || []).length === 2, '节点模式与聊天模式各有一条底部行');
const nodeBottom = bodyForRows.slice(bodyForRows.lastIndexOf('prompt-node-bottom-row'), bodyForRows.lastIndexOf('prompt-node-bottom-row') + 700);
ok(/\$\{providerModelHtml\}[\s\S]{0,80}\$\{llmOutputModeHtml\(node\)\}[\s\S]{0,200}prompt-node-run/.test(nodeBottom),
    '节点模式底部行：供应商/模型在左，输出形式 + 运行在右');
const chatBottom = bodyForRows.slice(bodyForRows.indexOf('prompt-node-bottom-row'), bodyForRows.indexOf('prompt-node-bottom-row') + 700);
ok(/\$\{providerModelHtml\}[\s\S]{0,160}llm-persona-label[\s\S]{0,160}\$\{chatPersonaSelectHtml\(node\)\}[\s\S]{0,240}llm-chat-send/.test(chatBottom),
    '聊天模式底部行顺序：供应商 → 模型 → 角色 → 发送');
ok(/llm-chat-send/.test(chatBottom) && chatBottom.lastIndexOf('llm-chat-send') > chatBottom.indexOf('prompt-node-bottom-row'),
    '发送按钮挪进底部行（跟三个下拉对齐，靠右）');
const outputSelectFn = topLevelFunction(js, 'llmOutputModeHtml');
ok(/<select class="prompt-node-control prompt-llm-output-mode"/.test(outputSelectFn), '输出形式是 <select> 下拉');
ok(/SMART_LLM_OUTPUT_MODES\.map/.test(outputSelectFn) && /selected/.test(outputSelectFn), '下拉项由模式清单生成并标出当前项');
ok(/prompt-llm-output-mode'\);[\s\S]{0,160}onchange = e => \{[\s\S]{0,160}node\.llmOutputMode = e\.target\.value;/.test(js), '下拉变更写回 node.llmOutputMode');
const personaSelectFn = topLevelFunction(js, 'chatPersonaSelectHtml');
ok(/<select class="prompt-node-control prompt-llm-persona"/.test(personaSelectFn), '角色也是 <select> 下拉');
ok(/SMART_CHAT_PERSONA_CUSTOM/.test(personaSelectFn) && /persona\.id === state\.id \? ' selected'/.test(personaSelectFn), '选中项按显示状态标出，「自定义」是保留项');
ok(/prompt-llm-persona'\);[\s\S]{0,160}onchange = e => \{[\s\S]{0,160}applyChatPersona\(node, e\.target\.value\)/.test(js), '角色下拉变更走 applyChatPersona');
ok(!/llm-output-mode-btn/.test(js) && !/llm-persona-chip/.test(js), '智能画布这边不再有药丸式输出形式 / 角色 chips');
ok(/\.prompt-node-bottom-row \{ display:flex/.test(css), '底部行是 flex 一行（可换行）');
ok(/\.prompt-node-bottom-row \.prompt-llm-provider \{ flex:0 1 112px; \}/.test(css) && /\.prompt-node-bottom-row \.prompt-llm-output-mode \{ flex:0 1 92px; margin-left:auto; \}/.test(css),
    '样式：供应商/模型/输出形式三个下拉都收窄，不再拉满整行');
/* 三角用应用统一的下拉图标（同 canvas.css .select-lite 的 Lucide chevron-down 线性图），
   深浅色各一条 data-URI；深色那条必须排在深色 background 简写之后，否则会被简写清掉，连顺序一起断言 */
const chevronStart = css.indexOf('.prompt-node-llm select,\n.theme-dark .prompt-node-llm select,\n.studio-theme-dark .prompt-node-llm select {');
const chevronRule = chevronStart < 0 ? '' : css.slice(chevronStart, css.indexOf('}', chevronStart) + 1);
const chevronUri = /d='m6 9 6 6 6-6'/;
const darkChevronAt = css.indexOf('.theme-dark .prompt-node-llm select,\n.studio-theme-dark .prompt-node-llm select { background-image:');
const darkChevronRule = darkChevronAt < 0 ? '' : css.slice(darkChevronAt, css.indexOf('}', darkChevronAt) + 1);
const darkShorthandAt = css.indexOf('.prompt-node-llm .llm-chat-input { background:rgba(28, 28, 28, .42); }');
ok(chevronRule.length > 0
    && (chevronRule.match(/url\("data:image\/svg\+xml/g) || []).length === 1
    && chevronUri.test(chevronRule) && /%230a0a0a/.test(chevronRule)
    && /background-size:12px 12px;/.test(chevronRule) && /background-repeat:no-repeat;/.test(chevronRule)
    && /padding-right:22px;/.test(chevronRule)
    && !/linear-gradient/.test(chevronRule)
    && darkChevronAt > darkShorthandAt && darkShorthandAt >= 0
    && (darkChevronRule.match(/url\("data:image\/svg\+xml/g) || []).length === 1
    && chevronUri.test(darkChevronRule) && /%23fafafa/.test(darkChevronRule)
    && !/background-color|background:/.test(darkChevronRule),
    '样式：三角用应用统一的下拉图标（Lucide chevron-down 12px 线性图，深浅各一条 data-URI），不再是原生三角/自绘实心三角');
ok(/"smart\.llmOutputForm"/.test(i18n) && /"smart\.providerSelect"/.test(i18n) && /"smart\.modelSelect"/.test(i18n), '三个新文案都登记了 i18n');
/* 行为：输出形式下拉 HTML */
const modeFn = new Function('window', 'tr', 'escapeHtml', 'escapeAttr',
    'const SMART_LLM_OUTPUT_MODES = ' + (js.match(/const SMART_LLM_OUTPUT_MODES = \[[\s\S]*?\];/) || ['[]'])[0].replace('const SMART_LLM_OUTPUT_MODES = ', '') + ';'
    + topLevelFunction(js, 'smartLlmOutputModeValue') + topLevelFunction(js, 'llmOutputModeHtml')
    + 'return llmOutputModeHtml;')({}, k => k, t => String(t == null ? '' : t), t => String(t == null ? '' : t));
{
    const html = modeFn({llmOutputMode: 'list'});
    ok((html.match(/<option/g) || []).length === 3, '行为：输出形式下拉有三个选项');
    ok(/value="list" selected/.test(html), '行为：多维表格被选中');
    ok(/value="text" title/.test(html) && !/value="text" selected/.test(html), '行为：当前项之外不重复选中');
    ok(/value="list-video"/.test(html), '行为：视频分镜表也在选项里');
}


console.log('[9] @ 上游素材：INPUT 与聊天输入框都能引用');
ok(/function smartLlmMentionItems\(node\)\{[\s\S]{0,240}promptNodeInputImages\(node\)/.test(js), '可引用素材与节点上「图1/图2」缩略图同源');
const mentionItemsFn = topLevelFunction(js, 'smartLlmMentionItems');
ok(/token: `图\$\{index \+ 1\}`/.test(mentionItemsFn) && /label: `图\$\{index \+ 1\}`/.test(mentionItemsFn), '按顺序标成 图1 / 图2 …');
const pickerFn2 = topLevelFunction(js, 'smartLlmMentionPickerHtml');
ok(/data-llm-mention-picker="1"/.test(pickerFn2) && /data-llm-mention=/.test(pickerFn2), '选择器带容器与条目标记');
ok(/mentionNoUpstream/.test(pickerFn2), '没有上游素材时给一句空态说明');
const thumbFn2 = topLevelFunction(js, 'smartLlmMentionThumbHtml');
ok(/smartPreviewImgHtml\(media/.test(thumbFn2), '图片缩略图走画布那套预览管线（smartPreviewImgHtml，带代理兜底）');
ok(/smartVideoPreviewHtml\(media/.test(thumbFn2), '视频缩略图同理走 smartVideoPreviewHtml');
ok(/entry\.kind === 'audio'|'file-headphone'/.test(thumbFn2), '音频/文件退化成图标');
ok(/bindSmartPreviewImageFallbacks\(picker\)/.test(js), '打开选择器时挂上预览兜底（本地文件缺失也能回落）');
ok(/\.llm-mention-thumb \{ flex:0 0 auto; width:34px; height:34px/.test(css), '缩略图 34px 见方（不是只显示文字）');
ok(/\$\{smartLlmMentionPickerHtml\(node\)\}/.test(js), '选择器渲染在控制台里（两处输入共用）');
ok(/bindLlmMentionInput\(el, node, instructionEl\)/.test(js), 'INPUT 框接上 @ 选择器');
ok(/bindLlmMentionInput\(el, node, chatInputEl\)/.test(js), '聊天输入框接上 @ 选择器');
ok(/llmMentionKeydown\(e, el, node, chatInputEl\)/.test(js), '聊天里回车先给选择器（选中素材而不是发消息）');
const queryFn2 = topLevelFunction(js, 'llmMentionQuery');
ok(/lastIndexOf\('@'\)/.test(queryFn2) && /if\(\/\[\\s\\n\]\/\.test\(query\)\) return null;/.test(queryFn2), '最后一个 @ 之后到光标不能有空白（与编辑栏那套 @ 提及同一套触发口径）');
ok(!/node\.\w+\s*=/.test(queryFn2), '解析函数不碰节点数据（纯读）');
const insertFn2 = topLevelFunction(js, 'insertLlmMention');
ok(/dispatchEvent\(new Event\('input', \{bubbles:true\}\)\)/.test(insertFn2), '插入后派发 input，走各自已有的保存逻辑');
ok(/classList\.add\('open'\)/.test(topLevelFunction(js, 'syncLlmMentionPicker')), '输入 @ 才打开选择器');
const beforeFn2 = topLevelFunction(js, 'llmEditorTextBefore');
const querySrc2 = beforeFn2 + '\n' + topLevelFunction(js, 'llmMentionQuery') + '\nreturn llmMentionQuery;';
/* contenteditable 没有 value/selectionStart：用假的选区把「光标前的文本」喂进去 */
const queryWith = before => new Function('window', querySrc2)({
    getSelection: () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: {}, startOffset: 0, cloneRange: () => ({ selectNodeContents(){}, setEnd(){}, toString: () => before }) }) })
})({contains: () => true});
ok(JSON.stringify(queryWith('@')) === JSON.stringify({at:0, query:'', pos:1}), '行为：光一个 @ 就打开（query 空）');
ok(queryWith('参考@').query === '', '行为：@ 紧跟文字也能触发（跟编辑栏一致）');
ok(queryWith('看图1') === null, '行为：没有 @ 就不触发');
ok(queryWith('图1 然后 @图').query === '图', '行为：@ 后面带查询词');
ok(queryWith('@图1 后面') === null, '行为：@ 后面出现空格就不再是引用输入');
const plainFn2 = topLevelFunction(js, 'llmEditorPlainText');
ok(/mentionTokenMatchesItem/.test(plainFn2) && /items\[index\]\.token/.test(plainFn2), '行为：chip 按序号还原成 图N（发给后端的还是纯文本）');
const itemsApi = new Function('promptNodeInputImages', 'mediaKindForItem', topLevelFunction(js, 'smartLlmMentionItems') + '\nreturn smartLlmMentionItems;')(
    () => [{url:'a.png', kind:'image', name:'产品图'}, {url:'b.mp4', kind:'video', name:'演示'}],
    item => item.kind
)({});
ok(itemsApi.length === 2 && itemsApi[0].token === '图1' && itemsApi[1].token === '图2', '行为：两张上游素材 → 图1 / 图2');
ok(itemsApi[0].name === '产品图' && itemsApi[1].kind === 'video', '行为：条目带上素材名与类型');
ok(/\.llm-mention-picker\.open \{ display:block; \}/.test(css) && /\.prompt-node-llm \{ position:relative; \}/.test(css), 'CSS：选择器贴在输入框下方');
ok(/\.prompt-node-bottom-row \.llm-chat-send \{ margin-left:auto/.test(css), 'CSS：发送按钮在底部行靠右');
ok(/"smart\.mentionUpstream"/.test(i18n) && /"smart\.mentionNoUpstream"/.test(i18n), '两个新文案都登记了 i18n');


console.log('[10] 运行失败提示：后端 JSON 错误要变成人话');
const apiErrFn = topLevelFunction(js, 'apiErrorMessage');
const llmErrFn = topLevelFunction(js, 'canvasLlmErrorMessage');
ok(Boolean(apiErrFn) && Boolean(llmErrFn), '两个错误处理函数都在');
const errApi = new Function('window', apiErrFn + '\n' + llmErrFn + '\nreturn canvasLlmErrorMessage;')({});
ok(errApi('{"detail":"未配置 X 的 API Key，请在 API 平台管理中填写。"}') === '未配置 X 的 API Key，请在 API 平台管理中填写。', '行为：{"detail":…} 解析成一句话（不再带转义引号）');
ok(errApi('纯文本错误') === '纯文本错误', '行为：非 JSON 错误原样透传');
ok(errApi('', '请求失败') === '请求失败', '行为：空错误回落到默认文案');
ok(/console\.error\('\[canvas-llm\] 运行失败：'/.test(js) && /console\.error\('\[canvas-llm\] 聊天失败：'/.test(js), '原始错误 + provider/model/message 打到控制台备查');


console.log('[11] 默认 System 提示词：只吐提示词正文');
const defFn2 = topLevelFunction(js, 'smartLlmDefaultSystemPrompt');
ok(Boolean(defFn2) && /smart\.promptLlmDefaultSystem/.test(defFn2), '有默认人设函数（文案走 i18n，兜底中文）');
ok(/system_prompt: options\.chat[\s\S]{0,160}options\.promptOnlySystem \? smartLlmDefaultSystemPrompt\(\) : ''/.test(js), '仅聊天使用历史人设，文本生成使用简洁默认 System');
ok(/不要分析/.test(defFn2) && /不要.*解释/.test(defFn2) && /Markdown/.test(defFn2), '默认人设要求直接输出提示词正文');
ok(!/data-llm-tab="system"|data-llm-tab="reverse"|prompt-llm-system|prompt-split-toggle|prompt-node-separator/.test(bodyFn), '控制台没有 System、反推、分隔符入口与旧面板');
ok(/"smart\.promptLlmDefaultSystem"/.test(i18n) && /一段/.test(i18n), '默认人设已登记 i18n（中英各一份）');


console.log('[12] 慢模型不再被 90 秒掐断，且超时提示是人话');
ok(/Number\(options\.timeoutMs\) \|\| 180000/.test(js), '默认超时放宽到 180s（灵境/lovart 这类慢模型 90s 不够）');
ok(/error\?\.name === 'AbortError' \|\| controller\.signal\.aborted/.test(js), 'AbortError 单独识别（不再把英文原文丢给用户）');
ok(/trf\('smart\.promptLlmTimeout'/.test(js), '超时用可读文案');
ok(/"smart\.promptLlmTimeout"/.test(i18n) && /没返回/.test(i18n), '超时文案已登记 i18n');
ok(/const startedAt = Date\.now\(\);\s*const timer = setTimeout/.test(js), '计时起点在 abort 定时器之前（超时秒数报得准）');


console.log('[13] 页签并进「模板库 / LLM」药丸行');
const toolsRow = bodyFn.slice(bodyFn.indexOf('class="prompt-node-tools"'), bodyFn.indexOf('${inputThumbs}'));
ok(/\$\{llmTabsHtml\}/.test(toolsRow), '药丸行里渲染页签（模板库、LLM、节点、聊天同一行）');
ok(toolsRow.lastIndexOf('${llmTabsHtml}') > toolsRow.indexOf('prompt-llm-toggle'), '页签排在 LLM 药丸之后，顺序是 模板库 → LLM → 节点 → 聊天');
ok(/const llmTabsHtml = node\.llmEnabled \?/.test(js), 'llmTabsHtml 定义带 llmEnabled 条件（没开 LLM 不渲染页签，药丸那行照常）');
const llmBlock = bodyFn.slice(bodyFn.indexOf('<div class="prompt-node-llm">'), bodyFn.indexOf('${smartLlmMentionPickerHtml(node)}'));
ok(llmBlock.length > 0 && !/llm-tabs/.test(llmBlock), 'prompt-node-llm 里不再有页签');
ok(/\.prompt-node-tools \.llm-tabs \{ flex:0 0 auto; flex-wrap:nowrap; margin:0 0 0 3px; \}/.test(css), 'CSS：并进药丸行后清掉 .llm-tabs 自带的下外边距');


console.log('[14] 聊天消息区：默认拉高 + 可拖把手');
const logConstsSrc = (js.match(/const PROMPT_CHAT_LOG_DEFAULT_H = \d+;\nconst PROMPT_CHAT_LOG_MIN_H = \d+;\nconst PROMPT_CHAT_LOG_MAX_H = \d+;/) || [''])[0];
const chatLogHeightFn = new Function(logConstsSrc + '\n' + topLevelFunction(js, 'promptChatLogHeight') + '\nreturn promptChatLogHeight;')();
ok(/const PROMPT_CHAT_LOG_DEFAULT_H = 200;/.test(js) && /const PROMPT_CHAT_LOG_MIN_H = 110;/.test(js) && /const PROMPT_CHAT_LOG_MAX_H = 440;/.test(js),
    '常量：默认 200 / 下限 110 / 上限 440');
ok(chatLogHeightFn({}) === 200, '行为：没拖过 → 默认 200（比原来 190 的硬顶高）');
ok(chatLogHeightFn({chatLogHeight: 20}) === 110, '行为：小于下限 → 取 110');
ok(chatLogHeightFn({chatLogHeight: 9999}) === 440, '行为：大于上限 → 取 440');
ok(chatLogHeightFn({chatLogHeight: 300.6}) === 301, '行为：正常值四舍五入原样');
ok(bodyFn.indexOf('class="llm-chat-log" style="height:${promptChatLogHeight(node)}px"') >= 0, '聊天消息区带内联 height（由 promptChatLogHeight 决定）');
const chatPaneHtml = bodyFn.slice(bodyFn.indexOf('class="llm-chat-pane"'), bodyFn.indexOf('prompt-node-bottom-row is-chat'));
ok(/class="prompt-llm-instruction-resize prompt-node-control" data-llm-chat-log-resize="1"/.test(chatPaneHtml), '把手复用现成的 .prompt-llm-instruction-resize（没新造 class）');
ok(chatPaneHtml.indexOf('data-llm-chat-log-resize') > chatPaneHtml.indexOf('class="llm-chat-log"')
    && chatPaneHtml.indexOf('data-llm-chat-log-resize') < chatPaneHtml.indexOf('llm-chat-input prompt-node-control'),
    '把手位置：消息区 → 把手 → 输入框');
const logBindAt = js.indexOf("el.querySelector('[data-llm-chat-log-resize]')");
const logBindBlock = logBindAt < 0 ? '' : js.slice(logBindAt, logBindAt + 1300);
ok(logBindBlock.length > 0 && logBindBlock.indexOf('node.chatLogHeight = next;') >= 0
    && logBindBlock.indexOf("chatLogEl.style.height = next + 'px';") >= 0
    && logBindBlock.indexOf("'smart-node-resize', 'smart-chat-log-resize'") >= 0
    && logBindBlock.indexOf('viewport.scale') >= 0
    && logBindBlock.indexOf('scheduleSave()') >= 0,
    '绑定：拖动写 node.chatLogHeight + 就地改高 + 按 viewport.scale 折算 + 松手 scheduleSave');
ok(css.indexOf('max-height:190px') < 0 && /\.prompt-node-llm \.llm-chat-log \{[\s\S]{0,220}?max-height:none;/.test(css), 'CSS：消息区去掉 190px 硬顶，高度交给内联 height');
ok(/body\.smart-chat-log-resize, body\.smart-chat-log-resize \* \{ user-select:none !important/.test(css), 'CSS：拖动期间全局禁选（拖的时候不会选中气泡文字）');


console.log('[15] 拖动兜底：mouseup 被吞掉时不会继续跟着鼠标改尺寸');
const finishLlmFn = topLevelFunction(js, 'finishLlmInstructionResize');
ok(Boolean(finishLlmFn) && /llmInstructionResizeState = null;/.test(finishLlmFn)
    && /document\.body\.classList\.remove\('smart-node-resize', 'smart-llm-instr-resize'\);/.test(finishLlmFn)
    && /commitPendingUndo\(\); else discardPendingUndo\(\);/.test(finishLlmFn),
    '收尾函数 finishLlmInstructionResize 存在：清态 + 去 body class + commit/discard 撤销');
ok(Boolean(topLevelFunction(js, 'finishPromptSplitResize')) && Boolean(topLevelFunction(js, 'finishNodeResize')),
    'promptSplit / 节点缩放也有同一套收尾函数（顺手覆盖，清理逻辑不写第二份）');
ok(/if\(e\.buttons !== undefined && \(e\.buttons & 1\) === 0\s+&& \(finishLlmInstructionResize\(\) \|\| finishPromptSplitResize\(\) \|\| finishNodeResize\(\)\)\) return;/.test(js),
    'onmousemove 里有「左键已经松开就先收尾」的兜底（松手后鼠标再动，尺寸一点都不变）');
ok(js.indexOf("document.addEventListener('mouseup', finishLlmInstructionResize, true)") < 0,
    '没有额外往 document 上挂跨函数的 mouseup（收尾统一交给 onmousemove 兜底，跟仓库「document 监听必须成对」的约定一致）');
const mouseupAt = js.indexOf('window.onmouseup = e => {');
const mouseupFn = mouseupAt < 0 ? '' : js.slice(mouseupAt, mouseupAt + 4200);
ok(mouseupFn.length > 0
    && /finishNodeResize\(\);\s*finishLlmInstructionResize\(\);\s*finishPromptSplitResize\(\);/.test(mouseupFn)
    && mouseupFn.indexOf('llmInstructionResizeState = null;') < 0
    && mouseupFn.indexOf('promptSplitResizeState = null;') < 0,
    'window.onmouseup 的三个改尺寸分支改为调用统一收尾函数（不再内联重复实现）');
ok((js.match(/moveEvent\.buttons !== undefined && \(moveEvent\.buttons & 1\) === 0\)\{ onUp\(\); return; \}/g) || []).length === 2,
    '聊天消息区 / 聊天输入框两把把手在 onMove 里也做了同样的左键兜底');


console.log('[16] 「优化提示词」按钮：三处编辑器 + 调用 / 清洗 / 就地替换');
/* optimizeEditorPrompt 是 async function，topLevelFunction 只认「function 名字(」，这里自己切 */
const optimizeAt = js.indexOf('async function optimizeEditorPrompt(');
const optimizeFn = optimizeAt < 0 ? '' : js.slice(optimizeAt, js.indexOf('\n}\n', optimizeAt) + 3);
const optimizeIconLine = (js.match(/^const PROMPT_OPTIMIZE_ICON = '(.+)';$/m) || [])[1] || '';
const optimizeBtnFn = topLevelFunction(js, 'promptOptimizeButtonHtml');
ok(optimizeIconLine.indexOf('<svg viewBox="0 0 24 24"') >= 0
    && optimizeIconLine.indexOf('M6.4 8.8h7.4M6.4 12.8h10.4M6.4 16.8h6.2') >= 0
    && optimizeIconLine.indexOf('fill="currentColor" stroke="none"') >= 0,
    '自绘图标：24×24 的 SVG，框内三条长短不一的横线，实心四角星用 fill=currentColor + stroke=none（不被 stroke-width 描边）');
ok(optimizeBtnFn.indexOf('${PROMPT_OPTIMIZE_ICON}') >= 0
    && optimizeBtnFn.indexOf('class="prompt-node-control prompt-optimize-btn"') >= 0
    && optimizeBtnFn.indexOf('title="${label}"') >= 0 && optimizeBtnFn.indexOf('aria-label="${label}"') >= 0
    && optimizeBtnFn.indexOf("tr('smart.optimizePrompt')") >= 0,
    '按钮：只有图标的「文档+闪光」自绘按钮（共用常量 PROMPT_OPTIMIZE_ICON）+ title/aria-label 走 i18n + 挂 .prompt-node-control');
ok(js.indexOf('data-lucide="zap"') < 0 && (js.match(/PROMPT_OPTIMIZE_ICON/g) || []).length >= 4,
    '三处（编辑栏挂载 / 按钮 HTML / 失败回滚兜底）统一用同一个常量，没有残留的 data-lucide="zap"');
ok(bodyFn.indexOf("${promptOptimizeButtonHtml('node')}") >= 0 && bodyFn.indexOf("${promptOptimizeButtonHtml('chat')}") >= 0,
    '控制台两处（节点模式 INPUT 行 / 聊天模式输入行）都有这颗按钮');
const optNodeRow = bodyFn.slice(bodyFn.lastIndexOf('prompt-node-bottom-row'), bodyFn.lastIndexOf('prompt-node-bottom-row') + 900);
ok(optNodeRow.indexOf("promptOptimizeButtonHtml('node')") > 0 && optNodeRow.indexOf("promptOptimizeButtonHtml('node')") < optNodeRow.indexOf('prompt-node-run'),
    '节点模式：优化按钮在「运行」左边（运行仍在最右）');
const optChatRow = bodyFn.slice(bodyFn.indexOf('prompt-node-bottom-row is-chat'), bodyFn.indexOf('prompt-node-bottom-row is-chat') + 900);
ok(optChatRow.indexOf("promptOptimizeButtonHtml('chat')") > 0 && optChatRow.indexOf("promptOptimizeButtonHtml('chat')") < optChatRow.indexOf('llm-chat-send'),
    '聊天模式：优化按钮在「发送」左边（发送仍在最右）');
ok(js.indexOf('composerOptimizeBtn') >= 0 && js.indexOf('runBtn.parentElement?.insertBefore(btn, runBtn);') >= 0
    && js.indexOf("optimizeEditorPrompt('composer'") >= 0,
    '编辑栏主输入框那颗在运行时插到「运行」左边（HTML 不新增节点）');
ok(js.indexOf("btn.setAttribute('data-i18n-title', 'smart.optimizePrompt');") >= 0
    && js.indexOf('function syncComposerOptimizeButton(){') >= 0
    && (js.match(/syncComposerOptimizeButton\(\);/g) || []).length >= 2,
    '编辑栏按钮文案在 i18n 就位后补同步（title 走 data-i18n-title，aria-label 在 updateComposer 里补）');
ok(optimizeFn.indexOf('callSmartCanvasLLM({llmProvider: provider, llmModel: model}, text, [], {') >= 0
    && optimizeFn.indexOf("systemPrompt: tr('smart.optimizePromptSystem')") >= 0 && optimizeFn.indexOf('noMedia:true') >= 0,
    '点击走现成的 callSmartCanvasLLM（非流式 /api/canvas-llm），system 用优化专用那条');
ok(js.indexOf('if(options.systemPrompt) body.system_prompt = String(options.systemPrompt);') >= 0,
    'callSmartCanvasLLM 支持自带 system_prompt（不借用聊天人设那条）');
ok(optimizeFn.indexOf("btn.dataset.optimizing = '1';") >= 0 && optimizeFn.indexOf('btn.disabled = true;') >= 0
    && optimizeFn.indexOf("btn.classList.add('is-loading')") >= 0 && optimizeFn.indexOf("btn.innerHTML = '<i data-lucide=\"loader-2\"></i>';") >= 0,
    'loading：dataset 防连点 + disabled + 图标换 loader-2 + is-loading 旋转');
ok(optimizeFn.indexOf("if(!text){ toast(tr('smart.optimizeEmpty')); return; }") >= 0,
    '空文本先 toast「先写点内容再优化」，不往下走');
ok(optimizeFn.indexOf("canvasLlmErrorMessage(e?.message || e, tr('smart.promptLlmFailed'))") >= 0,
    '失败走现成的 canvasLlmErrorMessage 弹 toast');
const replaceFn = topLevelFunction(js, 'promptOptimizeReplaceText');
ok(replaceFn.indexOf('selectNodeContents(el)') >= 0 && replaceFn.indexOf("document.execCommand('insertText', false, text)") >= 0
    && replaceFn.indexOf('el.textContent = text;') >= 0 && replaceFn.indexOf("dispatchEvent(new Event('input', { bubbles:true }))") >= 0,
    '就地替换：先全选 + execCommand insertText（保留原生撤销），失败退回改内容，两者都派发 input 走既有保存链路');
const FENCE = String.fromCharCode(96, 96, 96);
const cleanFn = new Function(topLevelFunction(js, 'cleanOptimizedPrompt') + '\nreturn cleanOptimizedPrompt;')();
ok(cleanFn(FENCE + '\n画一只猫\n' + FENCE) === '画一只猫', '行为：去掉代码围栏');
ok(cleanFn(FENCE + 'markdown\n一只猫\n' + FENCE) === '一只猫', '行为：带语言标记的围栏也去掉');
ok(cleanFn('  画一只猫  ') === '画一只猫', '行为：去掉首尾空白');
ok(cleanFn(FENCE + '\n' + FENCE) === '', '行为：空围栏洗成空串（调用方按失败处理）');
ok(i18n.indexOf('"smart.optimizePrompt": { zh: "优化提示词", en: "Optimize prompt" }') >= 0
    && i18n.indexOf('"smart.optimizing": { zh: "优化中…"') >= 0
    && i18n.indexOf('"smart.optimizeEmpty": { zh: "先写点内容再优化"') >= 0
    && i18n.indexOf('"smart.optimizeDone": { zh: "已优化提示词"') >= 0
    && i18n.indexOf('"smart.optimizePromptSystem": {') >= 0,
    'i18n：四条 UI 文案 + 优化专用 system 都登记了（zh/en 各一份）');
ok(css.indexOf('.prompt-optimize-btn { width:26px; height:26px;') >= 0
    && css.indexOf('border:0; background:transparent; color:var(--muted); cursor:pointer;') >= 0
    && css.indexOf('.prompt-optimize-btn:hover:not(:disabled),.prompt-optimize-btn:focus-visible { background:var(--soft); color:var(--text);') >= 0
    && css.indexOf('.prompt-optimize-btn.is-loading') >= 0
    && css.indexOf('.composer-actions .prompt-optimize-btn { height:var(--ctrl-height); }') >= 0,
    'CSS：图标按钮 26px（编辑栏里跟 .run-btn 同高）+ 无底色走 --muted、hover/focus 半透明软底 --soft + loading 旋转');


console.log('[17] 运行中不再有状态行：取消并进运行按钮');
const statusFn3 = topLevelFunction(js, 'llmRunStatusHtml');
ok(statusFn3.indexOf('prompt-node-stream-preview') >= 0, '运行中仍然渲染流式预览块（它才是生成时要看的东西）');
ok(statusFn3.indexOf('llmRunThinking') < 0 && statusFn3.indexOf('prompt-node-run-count') < 0 && statusFn3.indexOf('prompt-node-cancel') < 0,
    '运行中不再渲染「模型思考中」文案 / 秒数 span / 取消按钮');
ok(statusFn3.indexOf('is-done') >= 0 && statusFn3.indexOf('is-error') >= 0 && statusFn3.indexOf('is-cancelled') < 0,
    '完成行照旧、失败行保留错误原因；「已取消」整行不再渲染');
const runBtnHtmlAt = bodyFn.indexOf('prompt-node-run prompt-node-control');
const runBtnHtml = runBtnHtmlAt < 0 ? '' : bodyFn.slice(runBtnHtmlAt, runBtnHtmlAt + 420);
ok(runBtnHtml.length > 0 && runBtnHtml.indexOf('data-run-state="${runState}"') >= 0 && runBtnHtml.indexOf('disabled') < 0,
    '运行/停止/重试共用这一颗按钮，且任何状态下都可点（这一段里没有 disabled）');
ok(/stop: \{ icon:'square', label:'smart\.llmRunStop' \}/.test(js) && /run: \{ icon:'arrow-up', label:'common\.run' \}/.test(js),
    '三态视图表：停止 = square +「停止」，运行 = arrow-up +「运行」（跟发送键同款向上箭头）');
/* 运行/发送改成纯图标方形键（用户：全部改成发送按钮那个长相）：没有文字 span，文案挂 title + aria-label */
ok(runBtnHtml.indexOf('<span>') < 0 && /title="\$\{escapeAttr\(runLabel\)\}"/.test(runBtnHtml)
    && /aria-label="\$\{escapeAttr\(runLabel\)\}"/.test(runBtnHtml),
    '运行按钮只剩图标：没有文字 span，三态文案（运行/停止/重试）都在 title + aria-label 上');
ok(/\.prompt-node-run \{ height:26px; width:26px; padding:0; border-radius:var\(--radius-md\); background:var\(--soft\)/.test(css),
    'CSS：控制台运行键 = 26x26 浅灰圆角方块（无文字、无多余 padding）');
const chatSendCssAt = css.indexOf('.prompt-node-llm .llm-chat-send {');
const chatSendCss = chatSendCssAt < 0 ? '' : css.slice(chatSendCssAt, chatSendCssAt + 320);
ok(chatSendCss.indexOf('width:26px;') >= 0 && chatSendCss.indexOf('padding:0;') >= 0 && chatSendCss.indexOf('background:var(--soft);') >= 0,
    'CSS：聊天发送键同规格（26x26 浅灰方块 + 无 padding）');
ok(/\.composer-run-btn \{ width:var\(--ctrl-height\); padding:0; border-radius:var\(--radius-md\); background:var\(--soft\)/.test(css)
    && /\.run-btn\.is-stop \{ background:var\(--danger\)/.test(css) && /\.cascade-run-btn \{ width:var\(--ctrl-height\); min-width:var\(--ctrl-height\)/.test(css),
    'CSS：编辑栏运行键同规格（「一键运行」也统一成同尺寸方键，不再是 76px 胶囊）；停止态红色危险态原样保留');
const runBindAt = js.indexOf("const runEl = el.querySelector('.prompt-node-run');");
const runBindBlock = runBindAt < 0 ? '' : js.slice(runBindAt, runBindAt + 800);
ok(runBindBlock.indexOf('cancelSmartLlmRun(node.id)') >= 0,
    '运行中点它就是取消：调用现成的 cancelSmartLlmRun（没有复制一份取消逻辑）');
ok(js.indexOf("el.querySelector('.prompt-node-cancel')") < 0 && css.indexOf('prompt-node-cancel') < 0,
    '取消按钮的绑定与样式都已清掉（不留死绑定/无用可见元素）');
ok(i18n.indexOf('"smart.llmRunStop": { zh: "停止", en: "Stop" }') >= 0 && i18n.indexOf('"smart.llmRunThinking"') >= 0,
    '新增 smart.llmRunStop；旧的 llmRunThinking 词条保留（代码里已无引用）');
ok(statusFn3.indexOf("if(status.state === 'cancelled') return '';") >= 0,
    '已取消：llmRunStatusHtml 直接返回空串（连重试按钮都不再渲染）');
ok(statusFn3.indexOf('is-error') >= 0 && statusFn3.indexOf('prompt-node-retry') < 0,
    '失败行保留错误原因，但不再内嵌「重试」按钮（避免和底部那颗重复）');
/* 取消 / 失败之后**不额外加按钮**：运行按钮自己变成「重试」——三态判据集中在一个函数里 */
const runStateFn = new Function('llmRunStatus', 'node',
    topLevelFunction(js, 'promptRunButtonState') + '\nreturn promptRunButtonState(node);');
ok(runStateFn(new Map(), {id:'p1'}) === 'run', '行为：没跑过 → 运行');
ok(runStateFn(new Map([['p1', {state:'done'}]]), {id:'p1'}) === 'run', '行为：上次成功 → 回到「运行」');
ok(runStateFn(new Map([['p1', {state:'cancelled'}]]), {id:'p1'}) === 'retry', '行为：被取消 → 同一颗按钮变「重试」');
ok(runStateFn(new Map([['p1', {state:'error'}]]), {id:'p1'}) === 'retry', '行为：失败 → 同一颗按钮变「重试」');
ok(runStateFn(new Map([['p1', {state:'cancelled'}]]), {id:'p1', running:true}) === 'stop', '行为：运行中优先「停止」');
ok(/retry: \{ icon:'rotate-ccw', label:'smart\.llmRunRetry' \}/.test(js), '三态视图表：重试 = rotate-ccw + 「重试」文案（i18n 词条复用）');
ok(bodyFn.indexOf('const runState = promptRunButtonState(node);') >= 0 && bodyFn.indexOf('data-run-state="${runState}"') >= 0
    && bodyFn.indexOf('data-lucide="${runView.icon}"') >= 0 && bodyFn.indexOf('tr(runView.label)') >= 0,
    '运行按钮渲染读同一份判据（图标/文案/状态都是它推出来的）');
ok(js.indexOf('promptRetryButtonHtml') < 0 && js.indexOf('data-prompt-retry') < 0 && bodyFn.indexOf('prompt-node-retry') < 0,
    '没有新增任何独立的重试元素（上一条那版额外按钮已作废）');
const runClickAt = js.indexOf("const runEl = el.querySelector('.prompt-node-run');");
const runClickBlock = runClickAt < 0 ? '' : js.slice(runClickAt, runClickAt + 700);
ok(runClickBlock.indexOf('const state = promptRunButtonState(node);') >= 0
    && runClickBlock.indexOf("if(state === 'stop'){ cancelSmartLlmRun(node.id); return; }") >= 0
    && runClickBlock.indexOf("if(state === 'retry') llmRunStatus.delete(node.id);") >= 0
    && runClickBlock.indexOf('dispatchPromptNodeRun(node);') >= 0,
    '点击也读同一份判据：停止→取消；重试→清状态后重跑；其余→跑');
const dispatchFn2 = topLevelFunction(js, 'dispatchPromptNodeRun');
ok(Boolean(dispatchFn2) && dispatchFn2.indexOf('llmOutputModeChoice(node.llmOutputMode)') >= 0
    && dispatchFn2.indexOf('runSmartLLMListMode(node)') >= 0 && dispatchFn2.indexOf('runPromptLLMNode(node.id)') >= 0,
    '分发函数按输出模式分流：列表模式 runSmartLLMListMode，其余 runPromptLLMNode（没只认文本模式）');
ok(js.indexOf("el.querySelector('.prompt-node-retry')") < 0 && css.indexOf('prompt-node-retry') < 0,
    '行内那颗旧 .prompt-node-retry 的绑定与样式都清干净了（失败行样式反而保留）');


console.log('[18] 「文本生成」节点高度跟着文字自动长（封顶 560）');
ok(/const PROMPT_NODE_AUTO_MIN_H = 194;/.test(js) && /const PROMPT_NODE_AUTO_MAX_H = 560;/.test(js), '封顶常量：默认/最小 194、封顶 560');
const autoHeightFn = new Function('const PROMPT_NODE_AUTO_MIN_H = 194;\nconst PROMPT_NODE_AUTO_MAX_H = 560;\n' + topLevelFunction(js, 'promptNodeAutoHeight') + '\nreturn promptNodeAutoHeight;')();
ok(autoHeightFn({}) === 194, '行为：没量过 → 默认 194');
ok(autoHeightFn({autoH: 10}) === 194, '行为：小于下限 → 194（文字短时收回，不留大空框）');
ok(autoHeightFn({autoH: 9999}) === 560, '行为：超过封顶 → 560（封顶后框内滚动）');
ok(autoHeightFn({autoH: 300.4}) === 300, '行为：正常值四舍五入');
const layoutFn2 = topLevelFunction(js, 'promptNodeLayoutSize');
ok(layoutFn2.indexOf('isSmartGroupCompactMember(node)') >= 0 && layoutFn2.indexOf('node?.sizeUserSet') >= 0 && layoutFn2.indexOf('promptNodeAutoHeight(node)') >= 0,
    '尺寸：分组紧凑成员优先 → 手动拖过的听 node.h → 其余走实测高度（nodeRect/连线共用这一份）');
const measuredFn = topLevelFunction(js, 'syncPromptNodeMeasuredHeight');
ok(Boolean(measuredFn) && measuredFn.indexOf('node.sizeUserSet') >= 0 && measuredFn.indexOf('isSmartGroupCompactMember(node)') >= 0
    && measuredFn.indexOf('node.autoH = target') >= 0 && measuredFn.indexOf('<= 2') >= 0 && measuredFn.indexOf('prompt-node-display-text') >= 0,
    '实测函数：排除手动拖过 / 分组紧凑成员，量文字块天然高度（跟框高无关 → 量设再量幂等），2px 容差防抖');
ok(js.indexOf('pendingContentMeasure.push({node, el, syncHost:true, promptAutoHeight:true})') >= 0 && js.indexOf('item.promptAutoHeight') >= 0,
    '接进仓库既有的 pendingContentMeasure 管线（跟表格/批量/标签同一套，一次布局量完）');
const queueFn = topLevelFunction(js, 'queuePromptNodeAutoHeights');
ok(Boolean(queueFn) && queueFn.indexOf('markNodeSizeUserSet(body, node)') >= 0 && queueFn.indexOf('ensureNodeResizeHandle(body)') >= 0,
    '首次拖缩放把手前先快照当前渲染高度（markNodeSizeUserSet，不会先塌回 194）');
ok(js.indexOf('queuePromptNodeAutoHeights();') >= 0 && js.indexOf('queuePromptNodeAutoHeights();\n    /* 表格/批量节点的实测尺寸统一在这里回写') >= 0,
    'render 里排在 flushContentMeasurements 之前（一次布局量完，不边改边读）');
ok(js.indexOf('schedulePromptNodeAutoHeights();') >= 0 && js.indexOf('function schedulePromptNodeAutoHeights(){') >= 0,
    '打字时就地改文字也走「一帧一次」的重新测量（不每敲一下同步 reflow）');


console.log('[19] 控制台搬运：不许把旧的那块丢掉（「选中 A 却显示/写进 B」）');
const releaseFn = topLevelFunction(js, 'releasePromptConsoleHost');
ok(Boolean(releaseFn) && releaseFn.indexOf('park.appendChild(current)') >= 0
    && releaseFn.indexOf('delete host.dataset.promptConsoleNode') >= 0,
    '换 host 内容前把旧控制台送回 park（不再被 replaceChildren 直接丢掉）');
const syncFn2 = topLevelFunction(js, 'syncPromptConsoleToComposer');
const relIdx = syncFn2.indexOf('releasePromptConsoleHost(node.id)');
ok(relIdx >= 0 && relIdx < syncFn2.indexOf('host.replaceChildren(inNode)')
    && relIdx < syncFn2.indexOf('host.replaceChildren(parked)'),
    '两条替换路径都「先送走旧的、再 replaceChildren 新的」（顺序写死）');
ok(syncFn2.indexOf('schedulePromptConsoleRebuild(node)') >= 0 && syncFn2.indexOf("host.dataset.promptConsoleNode = ''") >= 0,
    '兜底：找不到属于自己的控制台 → 清空编辑栏 + 让该节点下一帧重建（重建走正常绑定），绝不把别人的留着');
ok(js.indexOf('node.__renderKey = \'\';') >= 0 && js.indexOf('if(selectedNode()?.id === node.id) render();') >= 0,
    '兜底恢复走正常渲染链路（renderKey 失配 → keepEl 放弃复用 → 控制台被重新绑定），不手搓绑定绕过幂等约束');
const dupeGuard = releaseFn.indexOf("old.dataset.promptConsoleNode === id") >= 0;
ok(dupeGuard, '回 park 时同一节点只留最新一份（不会攒旧界面）');
{
    /* 行为：节点里没有、park 里没有、host 里是「别的节点」的控制台 —— 必须把别人的送回去并清空标记 */
    const foreign = {dataset:{promptConsoleNode:'pB'}};
    const parked = [];
    const parkEl = {querySelectorAll: () => [], appendChild(el){ parked.push(el); }};
    const hostEl = {dataset:{promptConsoleNode:'pB'}, querySelector(){ return foreign; },
                     replaceChildren(el){ this._child = el; this.dataset.promptConsoleNode = el && el.dataset ? el.dataset.promptConsoleNode : ''; }};
    const nodeEl = {querySelector: () => null};
    const nodeForTest = {id:'pA', type:'smart-prompt'};
    const fakeDoc = {getElementById: id => (id === 'composerConsoleHost' ? hostEl : (id === 'promptConsolePark' ? parkEl : null)),
                     createElement: () => ({content:{querySelector: () => null}, set innerHTML(v){}})};
    const api = new Function('CSS','world','document','isSmartPromptNode','requestAnimationFrame','selectedNode','render','promptNodeBodyHtml','node','promptConsoleRebuildPending',
        topLevelFunction(js, 'syncPromptConsoleToComposer') + topLevelFunction(js, 'releasePromptConsoleHost')
        + topLevelFunction(js, 'schedulePromptConsoleRebuild') + topLevelFunction(js, 'promptConsoleParkCard')
        + '\nreturn syncPromptConsoleToComposer(node);')(
        {escape: v => v}, {querySelector: () => nodeEl}, fakeDoc, n => n.type === 'smart-prompt', () => {}, () => {}, () => {}, () => '', nodeForTest, new Set());
    ok(api === false && hostEl.dataset.promptConsoleNode === '' && parked.indexOf(foreign) >= 0 && nodeForTest.__renderKey === '',
        '行为：找不到自己的控制台 → 把别人的送回 park + 清空标记 + 安排该节点重建，绝不让别人的继续留在编辑栏（不会「看着 A 写进 B」）');
}
{
    /* 行为：已经在编辑栏里且就是这个节点 —— 幂等，不重建也不动 DOM */
    const card = {dataset:{promptConsoleNode:'pA'}};
    let replaced = 0;
    const hostEl2 = {dataset:{promptConsoleNode:'pA'}, querySelector(){ return card; }, replaceChildren(){ replaced += 1; }};
    const fakeDoc2 = {getElementById: id => (id === 'composerConsoleHost' ? hostEl2 : null),
                      createElement: () => ({content:{querySelector: () => null}, set innerHTML(v){}})};
    const api2 = new Function('CSS','world','document','isSmartPromptNode','requestAnimationFrame','selectedNode','render','promptNodeBodyHtml','node','promptConsoleRebuildPending',
        topLevelFunction(js, 'syncPromptConsoleToComposer') + topLevelFunction(js, 'releasePromptConsoleHost')
        + topLevelFunction(js, 'schedulePromptConsoleRebuild') + topLevelFunction(js, 'promptConsoleParkCard')
        + '\nreturn syncPromptConsoleToComposer(node);')(
        {escape: v => v}, {querySelector: () => ({querySelector: () => null})}, fakeDoc2, n => n.type === 'smart-prompt', () => {}, () => {}, () => {}, () => '', {id:'pA', type:'smart-prompt'}, new Set());
    ok(api2 === true && replaced === 0, '行为：同一节点重复调用幂等（不重建、不碰 DOM）');
}
{
    /* 行为：A→B→A 来回选 —— 每一次编辑栏里都必须挂着「当前选中那个节点」的控制台。
       模拟真实场景：卡被搬进过编辑栏（节点里已经没有它了，对应 keepEl 复用那条路），park 里存着另一个节点的卡。 */
    const parked = [];
    const mkCard = id => ({dataset:{promptConsoleNode:id}, remove(){ const i = parked.indexOf(this); if(i >= 0) parked.splice(i, 1); }});
    const cards = {pA: mkCard('pA'), pB: mkCard('pB')};
    const nodeEls = {pA: {querySelector: () => null}, pB: {querySelector: () => null}};
    /* 假 DOM 要像真 DOM 一样「移动」元素：appendChild/replaceChildren 会把元素从原来的父节点挪走，
       否则 park 里会留下已经不是它子节点的幽灵卡，断言就测不出真实行为了。 */
    const parkEl = {querySelectorAll: () => parked.slice(), appendChild(el){ if(hostEl._child === el) hostEl._child = null; if(parked.indexOf(el) < 0) parked.push(el); }};
    const hostEl = {dataset:{}, _child:null, querySelector(){ return this._child; },
        replaceChildren(el){ const i = parked.indexOf(el); if(i >= 0) parked.splice(i, 1); this._child = el; this.dataset.promptConsoleNode = el && el.dataset ? el.dataset.promptConsoleNode : ''; }};
    const doc = {getElementById: id => (id === 'composerConsoleHost' ? hostEl : (id === 'promptConsolePark' ? parkEl : null)),
                 createElement: () => ({content:{querySelector: () => null}, set innerHTML(v){}})};
    const worldStub = {querySelector: sel => {
        const m = /data-id="([^"]+)"/.exec(sel);
        return (m && nodeEls[m[1]]) || null;
    }};
    const syncSrc3 = topLevelFunction(js, 'syncPromptConsoleToComposer')
        + topLevelFunction(js, 'releasePromptConsoleHost')
        + topLevelFunction(js, 'schedulePromptConsoleRebuild')
        + topLevelFunction(js, 'promptConsoleParkCard');
    const syncFor = node => new Function('CSS','world','document','isSmartPromptNode','requestAnimationFrame','selectedNode','render','promptNodeBodyHtml','node','promptConsoleRebuildPending',
        syncSrc3 + '\nreturn syncPromptConsoleToComposer(node);')({escape: v => v}, worldStub, doc, n => n.type === 'smart-prompt', () => {}, () => {}, () => {}, () => '', node, new Set());
    /* 初始：A 选中（host 里是 A 的卡、park 里是 B 的卡） */
    hostEl._child = cards.pA;
    hostEl.dataset.promptConsoleNode = 'pA';
    parked.push(cards.pB);
    const okB = syncFor({id:'pB', type:'smart-prompt'});
    const afterB = hostEl.dataset.promptConsoleNode;
    const okA = syncFor({id:'pA', type:'smart-prompt'});
    const afterA = hostEl.dataset.promptConsoleNode;
    ok(okB === true && okA === true && afterB === 'pB', '行为：选中 B 时编辑栏挂的是 B 的控制台');
    ok(afterA === 'pA' && hostEl._child === cards.pA,
        '行为：A→B→A 回选后 host.dataset.promptConsoleNode 必须等于 A（修复前这里会停在 B，打字就写进 B）');
    ok(parked.length === 1 && parked[0] === cards.pB, '行为：来回选不攒卡（park 里只留没被选中的那一份）');
}


console.log('[20] 手动缩放：LLM 文本节点不再被 340 的下限锁死');
const manualMinFn = new Function(topLevelFunction(js, 'promptNodeManualMinHeight') + '\nreturn promptNodeManualMinHeight;')();
ok(manualMinFn({type:'smart-prompt', llmEnabled:true}) === 170 && manualMinFn({type:'smart-prompt'}) === 170,
    '行为：手动缩放的下限 = 170（原来硬编码 340：控制台还在节点里时的固定高度和，把手往下拖纹丝不动）');
ok(!/return 340;/.test(topLevelFunction(js, 'promptNodeManualMinHeight')), '那个 340 硬编码已经拿掉');
const minHAt = js.indexOf("const minH = node.type === 'smart-prompt'");
const minHLine = minHAt < 0 ? '' : js.slice(minHAt, minHAt + 220);
ok(minHLine.indexOf('promptNodeManualMinHeight(node)') >= 0 && minHLine.indexOf('170') >= 0,
    '画布缩放那条 minH 仍走同一个函数（LLM 与非 LLM 都是 170，缩到比文字矮时靠 preview 的 overflow:auto 滚）');
ok(/if\(manualSizable && !node\.sizeUserSet && \(Math\.abs\(dx\) > 2 \|\| Math\.abs\(dy\) > 2\)\)\{\s*\n\s*node\.sizeUserSet = true;/.test(js),
    '拖动超过 2px 才标记 sizeUserSet（只点一下把手不会锁成手动尺寸）');
const markFn2 = topLevelFunction(js, 'markNodeSizeUserSet');
ok(markFn2.indexOf('const w = Math.round(el.offsetWidth) || 0;') >= 0 && markFn2.indexOf('const h = Math.round(el.offsetHeight) || 0;') >= 0
    && markFn2.indexOf('node.sizeUserSet = true;') > markFn2.indexOf('if(h) node.h = h;'),
    '首次按下先把当前渲染宽高快照进 node.w/h，再置 sizeUserSet（不会一按就塌回默认高）');
ok(measuredFn.indexOf('node.sizeUserSet') >= 0 && queueFn.indexOf('if(node.sizeUserSet || isSmartGroupCompactMember(node)) return;') >= 0,
    '自动测量对 sizeUserSet 的节点彻底停写（排队与回写两处都跳过，syncHost 那条路径也不会碰它）');
const toggleAt = js.indexOf("const toggle = el.querySelector('.prompt-llm-toggle');");
const toggleBlock = toggleAt < 0 ? '' : js.slice(toggleAt, toggleAt + 1100);
ok(toggleBlock.indexOf('if(!node.sizeUserSet){') >= 0 && toggleBlock.indexOf('} else if(!node.sizeUserSet){') >= 0,
    '开关 LLM 只在非手动尺寸时才改 node.h/node.w（拖过的手动尺寸不会被冲掉）');


console.log('[21] 输入框鼠标指针：控制台里两个可编辑框必须是 I 形（cursor:text）');
ok(/\.prompt-node-llm \.prompt-llm-instruction, \.prompt-node-llm \.prompt-llm-instruction \*,\s*\n\.prompt-node-llm \.llm-chat-input, \.prompt-node-llm \.llm-chat-input \* \{ cursor:text; \}/.test(css),
    '两个可编辑框（连子元素一起）一条规则设成 cursor:text —— 祖先 .image-node{cursor:move}/.shell{cursor:grab} 的手型不再泄漏进来');
ok(/\.prompt-input, \.prompt-input \* \{ cursor:text; \}/.test(css), '编辑栏主输入框那条同款写法仍在（两处一致）');
ok(!/\.prompt-node-llm \.prompt-llm-instruction[^{}]*\{[^}]*cursor:\s*(move|grab)/.test(css)
    && !/\.prompt-node-llm \.llm-chat-input[^{}]*\{[^}]*cursor:\s*(move|grab)/.test(css),
    '没有任何地方把这两个框设成 move/grab');
ok(/\.prompt-node-bottom-row \.llm-chat-send \{ margin-left:auto/.test(css) && /\.prompt-node-run \{ height:26px/.test(css),
    '顺手确认按钮/药丸那侧没被这条规则波及（按钮自己的 cursor 不在本次改动里）');

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(item => console.error('  ✗ ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
