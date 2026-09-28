/* 纯文本节点（smart-text）的回归测试。
   用户需求：画布上加一种「纯文本」节点 —— 上下游都能连，双击弹大窗编辑。
   这里守三件事：
     A. 接线：菜单项 → createSmartTextNode → 渲染（卡片/尺寸/缩放把手）→ 双击开弹窗；
     B. 文本流转：自己有内容就用自己，空着才透传上游；下游提示词消费认得它；成环不递归爆栈；
     C. 细节：弹窗进入画布事件白名单（滚轮/拖动不吃）、CSS 与 i18n 都在。
   跑法：node tests/test_smart_canvas_text_node.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

// 顶层函数体：列 0 的 "function x(" 到列 0 的 "}"（本文件顶层函数名唯一）
function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 创建入口：菜单项 + createNodeFromMenu + createSmartTextNode');
ok(/data-create-type="text"/.test(html), '创建菜单里有「纯文本」按钮（data-create-type="text"）');
const createMenuFn = topLevelFunction(js, 'createNodeFromMenu');
ok(/type === 'text'/.test(createMenuFn) && /createSmartTextNode\(/.test(createMenuFn), 'createNodeFromMenu 认得 text 类型');
const createFn = topLevelFunction(js, 'createSmartTextNode');
ok(/type: 'smart-text'/.test(createFn), 'createSmartTextNode 建出来的是 smart-text 节点');
ok(/text: ''/.test(createFn), '新节点带空的 text 字段');
ok(/SMART_TEXT_NODE_WIDTH/.test(createFn) && /SMART_TEXT_NODE_HEIGHT/.test(createFn), '新节点用默认尺寸常量');
ok(/pushUndo\(\)/.test(createFn) && /scheduleSave\(\)/.test(createFn), '创建可撤销、会落盘');

console.log('[2] 渲染接入：节点卡片 / 标题 / 缩放把手');
const bodyFn = topLevelFunction(js, 'nodeBodyHtml');
ok(/node\.type === 'smart-text'\) return smartTextBodyHtml\(node\)/.test(bodyFn), 'nodeBodyHtml 分派到 smartTextBodyHtml');
const textBodyFn = topLevelFunction(js, 'smartTextBodyHtml');
ok(/smartTextOwnText\(node\)/.test(textBodyFn), '卡片显示自己的文本');
ok(/smartTextUpstreamText\(node\)/.test(textBodyFn) && /is-generated/.test(textBodyFn), '自己空着时直接显示上游生成的内容，并标「上游生成」');
ok(/smartTextFlowHtml\(text\)/.test(textBodyFn), '正文交给自动排版渲染（不是一坨纯文本）');
ok(/escapeHtml\(tr\('smart\.textNodeEmpty'\)\)/.test(textBodyFn), '空节点有占位提示');
ok(/const isText = node\.type === 'smart-text'/.test(js), '渲染循环里认出了 isText');
ok(/isText \? 'text-smart-node' : ''/.test(js), '根节点挂上 text-smart-node 类');
ok(/\|\| isPrompt \|\| isText \|\| isLoop \|\| isSmartGroup \? `<div class="node-resize-handle"/.test(js), '纯文本节点有缩放把手');
const handleRule = (css.match(/\.node-resize-handle \{[^}]*\}/) || [''])[0];
ok(/width:20px; height:20px/.test(handleRule) && !/background/.test(handleRule) && !/box-shadow/.test(handleRule), '缩放把手统一规格：20px 命中区，无底色无投影');
ok(/\.image-node:hover \.node-resize-handle \{ opacity:1/.test(css) && !/\.image-node\.selected \.node-resize-handle/.test(css), '缩放把手只在鼠标移到节点上时显示（选中不再单独显示）');
ok(!/\.image-node\.text-smart-node \.node-resize-handle/.test(css), '纯文本节点不再有单独的把手样式');
ok(/isText \? escapeHtml\(tr\('smart\.textNodeHint'\)\)/.test(js), '提示文案说的是「双击放大编辑」');
const layoutFn = topLevelFunction(js, 'imageLayout');
ok(/node\?\.type === 'smart-text'/.test(layoutFn), 'imageLayout 有 smart-text 分支（尺寸听 node.w/h）');
const resizeBlock = js.slice(js.indexOf('if(resizeState){'), js.indexOf('if(llmInstructionResizeState){'));
ok(/isSmartTextNode\(node\)/.test(resizeBlock), '拖动缩放把手时按真实渲染尺寸起算');
ok(/isSmartTextNode\(node\)/.test(resizeBlock) && /node\.sizeUserSet = true;/.test(resizeBlock), '拖动纯文本节点写入手动尺寸标志');
ok(/node\.type === 'smart-text' \? 180/.test(resizeBlock), '缩放有最小宽度');

console.log('[3] 文本流转：下游提示词消费 + 上游直出 + 成环保护');
const textForNodeFn = topLevelFunction(js, 'textForNode');
ok(/node\.type === 'smart-text'\) return smartTextEffectiveText\(node, seen\)/.test(textForNodeFn), 'textForNode 认得 smart-text');
ok(/seen/.test(textForNodeFn) && /smart-group.*textForNode\(member, ctx, seen\)/.test(textForNodeFn), '环保护沿着递归传下去');
const itemsFn = topLevelFunction(js, 'promptTextItemsForNode');
ok(/node\.type === 'smart-text'/.test(itemsFn), 'promptTextItemsForNode 认得 smart-text');
const promptInputsFn = topLevelFunction(js, 'promptInputNodesFor');
ok(/input\?\.type === 'smart-text'/.test(promptInputsFn), 'promptInputNodesFor 把文本节点算作提示词来源');
const effFn = topLevelFunction(js, 'smartTextEffectiveText');
ok(/const own = smartTextOwnText\(node\)\.trim\(\);\s*return own \|\| smartTextUpstreamText\(node, seen\);/.test(effFn), '有效文本 = 自己的优先，空着直接用上游（用户要的「上游/AI 直接生成」）');

const names = ['smartTextOwnText', 'smartTextUpstreamItems', 'smartTextUpstreamText', 'smartTextEffectiveText', 'textForNode', 'promptTextItemsForNode'];
const extracted = names.map(name => topLevelFunction(js, name)).join('\n');
ok(names.every(name => topLevelFunction(js, name)), '六个文本相关函数都能从源码里抽出来');

function makeEnv(list, connections){
    const env = {
        nodes: list,
        canvas: {connections: (connections || []).map(([from, to]) => ({from, to, kind: 'input'}))},
        smartLoopContext: null,
        promptNodePromptItems(node){ const text = String(node.text || '').trim(); return text ? [text] : []; },
        smartLoopPrompt(){ return ''; },
        smartGroupMembers(){ return []; }
    };
    env.inputNodesFor = node => env.canvas.connections
        .filter(c => c.to === node.id && (c.kind || 'flow') === 'input')
        .map(c => env.nodes.find(n => n.id === c.from))
        .filter(Boolean);
    return env;
}
function build(list, connections){
    const env = makeEnv(list, connections);
    const factory = new Function(
        'nodes', 'canvas', 'smartLoopContext', 'inputNodesFor', 'promptNodePromptItems', 'smartLoopPrompt', 'smartGroupMembers',
        extracted + '\nreturn {textForNode, promptTextItemsForNode, smartTextEffectiveText, smartTextOwnText, smartTextUpstreamItems, smartTextUpstreamText};'
    );
    return factory(env.nodes, env.canvas, env.smartLoopContext, env.inputNodesFor, env.promptNodePromptItems, env.smartLoopPrompt, env.smartGroupMembers);
}


console.log('[4] 行为：自己优先 / 上游直出 / 成环');
{
    const prompt = {id: 'p1', type: 'smart-prompt', text: '上游提示词'};
    const own = {id: 't1', type: 'smart-text', text: '我自己的文本'};
    const api = build([prompt, own], [['p1', 't1']]);
    ok(api.textForNode(own) === '我自己的文本', '自己有内容时以自己为准（不拼上游，避免重复）');
    ok(JSON.stringify(api.promptTextItemsForNode(own)) === JSON.stringify(['我自己的文本']), '下游拿到的是自己的文本');
}
{
    const prompt = {id: 'p1', type: 'smart-prompt', text: '上游提示词'};
    const empty = {id: 't1', type: 'smart-text', text: '   '};
    const api = build([prompt, empty], [['p1', 't1']]);
    ok(api.textForNode(empty) === '上游提示词', '自己空着时直接拿上游内容（不用手动插入）');
}
{
    const prompt = {id: 'p1', type: 'smart-prompt', text: '第一段'};
    const prompt2 = {id: 'p2', type: 'smart-prompt', text: '第二段'};
    const empty = {id: 't1', type: 'smart-text', text: ''};
    const api = build([prompt, prompt2, empty], [['p1', 't1'], ['p2', 't1']]);
    ok(api.textForNode(empty) === '第一段\n\n第二段', '多条上游按连线顺序拼接');
}
{
    const t1 = {id: 't1', type: 'smart-text', text: ''};
    const t2 = {id: 't2', type: 'smart-text', text: ''};
    const api = build([t1, t2], [['t2', 't1'], ['t1', 't2']]);
    let value = null;
    let threw = false;
    try { value = api.textForNode(t1); } catch(e){ threw = true; }
    ok(!threw && value === '', '文本节点互相连成环时返回空、不递归爆栈');
}
{
    const upstream = {id: 't1', type: 'smart-text', text: '透传内容'};
    const mid = {id: 't2', type: 'smart-text', text: ''};
    const api = build([upstream, mid], [['t1', 't2']]);
    ok(api.textForNode(mid) === '透传内容', '链式文本节点（文本 → 文本）能一路传下去');
    ok(JSON.stringify(api.promptTextItemsForNode({id: 'empty', type: 'smart-text', text: ''})) === '[]', '全空的文本节点不作为提示词输出');
}

console.log('[5] 连线：上下游都能连');
const autoFn = topLevelFunction(js, 'canAutoConnectDraggedNode');
const textLine = (autoFn.match(/if\(sourceNode\.type === 'smart-text'\)[^\n]*\n/) || [''])[0];
ok(/isSmartImageNode\(targetNode\)/.test(textLine) && /smart-loop/.test(textLine) && /smart-prompt/.test(textLine) && /smart-text/.test(textLine),
    '文本节点拖到生成/循环/提示词/文本节点上都能自动连线');
ok(/isSmartImageNode\(sourceNode\)[\s\S]{0,200}targetNode\.type === 'smart-text'/.test(autoFn), '图片节点能连到文本节点（上游方向）');
ok(/sourceNode\.type === 'smart-prompt'[\s\S]{0,160}targetNode\.type === 'smart-text'/.test(autoFn), '提示词节点能连到文本节点');
const connectFn = topLevelFunction(js, 'connectInputNode');
ok(/from\.type === 'smart-text'/.test(connectFn), '循环节点收到文本节点时自动打开「提示词」输入');

console.log('[6] 双击弹窗：标记 + 接线 + 事件白名单');
const bindFn = topLevelFunction(js, 'bindNodeEvents');
ok(/isSmartTextNode\(nodeForControls\)/.test(bindFn) && /openSmartTextEditor\(id\)/.test(bindFn), '双击纯文本节点打开大弹窗');
ok(/nodeForControls\?\.type !== 'smart-group' && !isSmartTextNode\(nodeForControls\)/.test(bindFn), '双击不再被通用 stopPropagation 吞掉');
['smartTextModal', 'smartTextModalInput', 'smartTextModalSave', 'smartTextModalCancel'].forEach(id => {
    ok(html.indexOf('id="' + id + '"') >= 0, '弹窗标记里有 #' + id);
});
ok(/data-text-modal-close/.test(html), '点遮罩/关闭按钮能关弹窗');
ok(!/data-text-upstream-insert/.test(html) && !/smartTextModalUpstreamList/.test(html), '弹窗里不再有「插入上游文本」那套（用户说不需要）');
ok(/input\.addEventListener\('input', syncSmartTextEditorNode\)/.test(js), '输入即写回 node.text');
ok(/event\.key === 'Escape'/.test(js) && /event\.key === 'Enter'/.test(js), 'Esc 关闭、Ctrl/⌘+Enter 保存');
const closeFn = topLevelFunction(js, 'closeSmartTextEditor');
ok(/if\(node && !save\) node\.text = smartTextEditorOriginalText;/.test(closeFn), '「取消」才还原打开前的文本');
ok(/render\(\);/.test(closeFn), '关弹窗后重绘节点预览');
ok(/node\.text = smartTextModalPlain\(input\)/.test(topLevelFunction(js, 'syncSmartTextEditorNode')), 'syncSmartTextEditorNode 把编辑面写进 node.text（contenteditable 版）');
const wheelBlock = (js.match(/const WHEEL_LOCK_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || '';
ok(/\.smart-text-modal/.test(wheelBlock), '弹窗里滚轮不被画布缩放吃掉');
const shellGuard = js.slice(js.indexOf('shell.onmousedown = e => {'), js.indexOf('shell.onmousedown = e => {') + 1400);
ok(/\.smart-text-modal/.test(shellGuard), '弹窗在画布的 mousedown/click/dblclick 白名单里（不会误拖画布）');

console.log('[7] CSS + i18n');
ok(/\.image-node\.text-smart-node \{/.test(css), '有 .image-node.text-smart-node 卡片样式');
ok(/\.smart-text-preview \{/.test(css), '有正文预览样式（超高自己滚动）');
ok(/\.smart-text-modal\.open \{/.test(css), '有弹窗样式');
ok(/\.smart-text-modal-input \{/.test(css), '有弹窗里的大输入框样式');
[['smart.textNodeEmpty', '双击输入文本'], ['smart.textNodeHint', '双击放大编辑'], ['smart.textNodeUpstream', '上游文本'], ['smart.textNodeFromUpstream', '上游生成']].forEach(([key, zh]) => {
    const hit = new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "' + zh).test(i18n);
    ok(hit, key + ' 的 i18n 已登记（zh 含「' + zh + '」）');
});
ok(/"smart\.textNodeCount": \{ zh: "\{n\} 字", en:/.test(i18n), '字数文案带 {n} 占位（trf 会替换）');
ok(/"smart\.textEditorTitle"/.test(i18n) && /"smart\.textEditorPlaceholder"/.test(i18n), '弹窗标题/占位文案也登记了');


console.log('[8] 行为：排版解析（海报 / 电商卖点 / 详情页 / 视频分镜）');
const parseFn = topLevelFunction(js, 'smartTextLayoutBlocks');
const inlineFn = topLevelFunction(js, 'smartTextInlineHtml');
const flowFn = topLevelFunction(js, 'smartTextFlowHtml');
const parseApi = new Function('escapeHtml', 'SMART_TEXT_KEY_MAX',
    parseFn + '\n' + inlineFn + '\n' + flowFn + '\nreturn {smartTextLayoutBlocks, smartTextFlowHtml};'
)(value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])), 6);
{
    const poster = '夏日限定\n清爽一整季\n- 冰感面料，透气不闷\n- 收腰显瘦版型\n- 三色可选';
    const blocks = parseApi.smartTextLayoutBlocks(poster);
    ok(blocks[0].type === 'h1' && blocks[0].text === '夏日限定', '海报：首行短句当主标题');
    ok(blocks[1].type === 'h2' && blocks[1].text === '清爽一整季', '海报：第二行短句当副标题');
    ok(blocks.filter(b => b.type === 'li').length === 3, '海报：三条卖点解析成列表');
    const html = parseApi.smartTextFlowHtml(poster);
    ok(/st-h1[^>]*>夏日限定</.test(html) && /st-h2[^>]*>清爽一整季</.test(html), '海报：标题层级真的渲染出来了');
    ok(/<ul class="st-list">/.test(html) && (html.match(/<li>/g) || []).length === 3, '海报：列表渲染成 ul/li');
}
{
    const ec = '核心卖点\n1. 一擦即净\n2. 不留水痕\n\n【产品参数】\n材质：超细纤维\n尺寸：30x30cm';
    const blocks = parseApi.smartTextLayoutBlocks(ec);
    ok(blocks.some(b => b.type === 'li-ordered' && b.text === '一擦即净'), '电商：数字编号解析成有序列表');
    ok(blocks.some(b => b.type === 'h2' && b.text === '产品参数'), '详情页：【】包裹的区块名当小节标题');
    const fields = blocks.filter(b => b.type === 'field');
    ok(fields.length === 2 && fields[0].key === '材质' && fields[0].text === '超细纤维', '详情页：参数解析成「键：值」字段行');
    const html = parseApi.smartTextFlowHtml(ec);
    ok(/st-list-ordered/.test(html) && /st-field/.test(html), '详情页：字段行和小节标题都渲染出来');
    ok(/<b class="st-key">材质：<\/b>超细纤维/.test(html), '字段行保留「键：值」原文（复制的文字不丢冒号）');
    ok(/^<div class="smart-text-flow">/.test(html) && /<\/div>$/.test(html), '排版块外面有 .smart-text-flow 容器（CSS 规则挂在这上面）');
}
{
    const storyboard = '# 分镜脚本\n镜头1\n画面：女生在窗边喝咖啡\n台词：（无）\n时长：3s\n**镜头2**\n画面：产品特写';
    const blocks = parseApi.smartTextLayoutBlocks(storyboard);
    ok(blocks[0].type === 'h1' && blocks[0].text === '分镜脚本', '# 号标题解析成一级标题');
    ok(blocks.some(b => b.type === 'h2' && b.text === '镜头2'), '**加粗** 单独一行当小节标题');
    const keys = blocks.filter(b => b.type === 'field').map(b => b.key);
    ok(keys.includes('画面') && keys.includes('台词') && keys.includes('时长'), '视频分镜：画面/台词/时长都成字段行');
}
{
    const long = '这是一段很长的正文描述，用来确认它不会被误判成标题，因为它远超十二个字并且带标点。';
    const blocks = parseApi.smartTextLayoutBlocks(long);
    ok(blocks.length === 1 && blocks[0].type === 'para', '长句正文不会被当成标题');
    ok(parseApi.smartTextLayoutBlocks('')[0] === undefined, '空文本没有块');
    ok(parseApi.smartTextLayoutBlocks('**重点**').length === 1 && parseApi.smartTextLayoutBlocks('**重点**')[0].type === 'h2', '行内加粗整行 → 小节标题');
    ok(/<b>重点<\/b>/.test(parseApi.smartTextFlowHtml('正文里的 **重点** 词')), '行内 **加粗** 渲染成 <b>');
    ok(/<span class="st-ref">图1<\/span>/.test(parseApi.smartTextFlowHtml('参考 @图1 的风格')), '@图N 引用高亮出来');
}
ok(/\.smart-text-flow \.st-h1/.test(css) && /\.st-list-ordered/.test(css) && /\.st-field/.test(css), 'CSS 里有标题/列表/字段行的排版规则');


console.log('[9] 画布助手能把回答写进纯文本节点');
const posFn = topLevelFunction(js, 'assistantTextNodePosition');
const writeFn = topLevelFunction(js, 'writeAssistantTextNode');
ok(Boolean(posFn) && /viewportCenter\(\)/.test(posFn), '助手新建文本节点的位置取视口中心');
ok(/nodes\.some\(/.test(posFn), '位置上已有节点就让开，不叠在一起');
ok(Boolean(writeFn) && /type === 'smart-text'/.test(writeFn), 'writeAssistantTextNode 只认纯文本节点');
ok(/target\.text = String\(action\.text/.test(writeFn), '把助手给的文字写进节点');
ok(/selectedId = target\.id/.test(writeFn), '写完自动选中，用户一眼能看到');
ok(/a\.cmd === 'write_text' \|\| a\.cmd === 'create_text_node'/.test(js), 'executeChatActions 认 write_text / create_text_node');
ok(/a\.type === 'text' \|\| a\.type === 'smart-text'/.test(js), 'create_node 也支持 type=text');
ok(/write_text/.test(js.slice(js.indexOf('var sysP'), js.indexOf('var sysP') + 1200)), '助手 system prompt 里教了它这个动作');


console.log('[10] 触控板/滚轮：正文自己滚 + 双击能看到上游内容');
const wheelBlock2 = (js.match(/const WHEEL_LOCK_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || '';
ok(/\.smart-text-preview/.test(wheelBlock2), '正文区在滚轮白名单里（下滑滚正文，不推画布）');
ok(/overscroll-behavior:contain/.test(css), '正文区 overscroll-behavior:contain（滚到底不把画布带走）');
const openFn2 = topLevelFunction(js, 'openSmartTextEditor');
ok(/input\.innerHTML = smartTextFlowHtml\(smartTextEditorOriginalText \|\| smartTextUpstreamText\(node\)\.trim\(\)\)/.test(openFn2), '双击打开时把上游生成的内容按排版渲染进弹窗（不再空框）');
ok(/smartTextEditorOriginalText = smartTextOwnText\(node\)/.test(openFn2), '「取消」还原的仍是自己的文本（不会被上游内容写死）');
ok(!/smart-text-modal-tip-line/.test(html), '弹窗里那行说明去掉了（用户要求）');




console.log('[12] 文本生成直接请求模型');
ok(!/llmFastModeHtml|prompt-llm-fast|skipPromptIntelligence/.test(js), 'JS 里没有快速按钮残留');
ok(!/prompt-llm-fast/.test(css) && !/llmFastMode/.test(i18n), 'CSS / i18n 里也没有残留');
const runPromptFn = topLevelFunction(js, 'runPromptLLMNode');
ok(/answer = await callSmartCanvasLLM\(node, message, \[\], \{\s*noPromptIntelligence: true,\s*promptOnlySystem: true,\s*onDelta:/.test(runPromptFn), '流式请求跳过 Prompt Intelligence 并启用简洁默认 System');
ok(/answer = await callSmartCanvasLLM\(node, message, \[\], \{noPromptIntelligence:true, promptOnlySystem:true\}\);/.test(runPromptFn), '409 退回普通接口时保留相同选项');
const callSmartFn = topLevelFunction(js, 'callSmartCanvasLLM');
ok(/if\(options\.noPromptIntelligence\) body\.no_prompt_intelligence = true;/.test(callSmartFn), '跳过标记写入请求体');
ok(/images,\s*videos,\s*reverse: false/.test(callSmartFn), '图片、视频字段保留，旧反推设置不会暗中生效');
ok(/MAX_INTELLIGENCE_STEPS = 5/.test(read('prompt_intelligence.py')), '后端 PI 最多 5 步');


console.log('[13] agent 供应商带图耗时提示');
ok(/const SMART_AGENT_CHAT_PROTOCOLS = \['lovart', 'codex', 'gemini-cli', 'gemini_cli'\]/.test(js), 'agent 型供应商名单（按 protocol 判定）');
ok(/function smartChatProviderIsAgent/.test(js) && /protocol \|\| ''\)\.toLowerCase\(\)/.test(js), '按 provider.protocol 识别，不写死 id');
const hintFn = topLevelFunction(js, 'llmSlowProviderHintHtml');
ok(Boolean(hintFn) && /smartChatProviderIsAgent/.test(hintFn), 'agent 供应商才提示');
ok(/if\(!promptNodeInputImages\(node\)\.length\) return '';/.test(hintFn), '没有参考图时不提示，旧反推标志不生效');
ok(/smart\.llmAgentSlowHint/.test(hintFn) && /prompt-node-slow-hint/.test(hintFn), '提示文案走 i18n，样式类独立');
ok(/\$\{llmSlowProviderHintHtml\(node\)\}/.test(js), '提示出现在控制台里（底部行上方）');
ok(/"smart\.llmAgentSlowHint"/.test(i18n) && /已直接发送给模型/.test(i18n) && /sends the request directly to the model/.test(i18n), '提示说明文本生成已直接请求模型');
ok(!/最多 5 次 agent 调用|up to 5 agent calls/.test(i18n), '提示不再声称有多轮前置分析');
ok(/\.prompt-node-slow-hint \{/.test(css), '提示有自己的样式');


console.log('[14] 流式生成（照抄 /api/chat/stream 那套 SSE）');
const backendSrc = String(require('fs').readFileSync(require('path').join(__dirname, '..', 'main.py'), 'utf8'));
ok(/@app\.post\("\/api\/canvas-llm\/stream"\)/.test(backendSrc), '后端有 /api/canvas-llm/stream');
ok(/raise HTTPException\(status_code=409, detail="stream_unsupported"\)/.test(backendSrc), 'agent 型供应商回 409（前端据此退回普通接口）');
ok(/async def canvas_llm_stream/.test(backendSrc) && /sse_event\(\{"type": "delta"/.test(backendSrc), '逐 delta 推 SSE');
ok(/"text": text, "model": model\}\)/.test(backendSrc), '收尾推 done + 完整文本');
ok(/upstream_messages = await _canvas_llm_upstream_messages\(payload, model\)/.test(backendSrc), '与普通接口共用消息构造（两条路发的内容一致）');
ok(/await _canvas_llm_apply_prompt_intelligence\(payload\)/.test(backendSrc), '与普通接口共用 Prompt Intelligence 前置');
const streamFn = topLevelFunction(js, 'streamCanvasLLMResponse');
ok(Boolean(streamFn) && /\/api\/canvas-llm\/stream/.test(streamFn), '前端有流式读取器');
ok(/error\.unsupported = true/.test(streamFn) && /res\.status === 409/.test(streamFn), '409 标记成 unsupported');
ok(/idleTimer = setTimeout\(\(\) => controller\.abort\(\), idleMs\)/.test(streamFn), '超时按「多久没新内容」算（不是总时长）');
ok(/getReader\(\)/.test(streamFn) && /split\('\\n'\)/.test(streamFn), '按行解析 SSE');
const callFn2 = topLevelFunction(js, 'callSmartCanvasLLM');
ok(/if\(typeof options\.onDelta === 'function'\)/.test(callFn2) && /return streamCanvasLLMResponse\(/.test(callFn2), 'callSmartCanvasLLM 带 onDelta 时走流式');
ok(/clearTimeout\(timer\);\s*return streamCanvasLLMResponse/.test(callFn2), '走流式时先撤掉 180s 总超时');
const runFn2 = topLevelFunction(js, 'runPromptLLMNode');
ok(/onDelta: full =>/.test(runFn2) && /paintStreamingPromptText\(node, full\)/.test(runFn2), '节点运行：边收边把文字画到节点上');
ok(/if\(!streamError\?\.unsupported\) throw streamError;/.test(runFn2), '只有「不支持流式」才退回普通接口');
const paintFn3 = topLevelFunction(js, 'paintStreamingPromptText');
ok(Boolean(paintFn3) && /setTimeout\(/.test(paintFn3) && /const job = promptStreamPaintJob;/.test(paintFn3)
    && /promptStreamPaintJob = \{node, text: String\(text \|\| ''\)\};/.test(paintFn3),
    '画节点预览仍是 100ms 节流，但每次 paint 取的是「最新那一帧」而不是第一次调用时的旧快照');
ok(/function cancelPromptStreamPaint\(\)/.test(js) && /cancelPromptStreamPaint\(\);\s*\n\s*render\(\);/.test(js),
    '收尾 render 之前先取消未触发的节流 paint（否则旧快照会把刚渲染的全文盖回半截 —— 「文字显示不全」的根因）');
ok(!/prompt-node-run-count/.test(js) && /class="prompt-node-stream-preview"/.test(topLevelFunction(js, 'llmRunStatusHtml')), '运行中只渲染流式预览（秒数 span 已随状态行一起删掉）');
ok(/smart\.promptLlmStreamStall/.test(i18n) && /smart\.llmRunStreaming/.test(i18n), '流式的文案（生成中字数 / 卡住中断）已登记 i18n');


console.log('[15] 反推不跑 Prompt Intelligence（一次带图调用就够）');
ok(/if payload\.reverse:\s*\n\s*print\("\[prompt-intelligence\] skipped: reverse uses a single multimodal call"\)\s*\n\s*return payload/.test(backendSrc), '后端：reverse 直接跳过 PI，走一次多模态调用');
ok(/if HAS_PROMPT_INTELLIGENCE and not payload\.no_prompt_intelligence and \(payload\.images or payload\.videos\):/.test(backendSrc), '非反推 + 有参考素材时 PI 照旧（没砍掉参考融合能力）');


console.log('[16] 运行中可取消 / 失败可重试');
ok(/const smartLlmRunControllers = new Map\(\);/.test(js), '按节点记着在跑的请求（取消要用）');
ok(/controller\.cancelledByUser = true;\s*\n\s*controller\.abort\(\);/.test(js), '取消 = 标记 + abort');
ok(/smartLlmRunControllers\.set\(String\(node\.id\), controller\)/.test(js), '发起请求时登记');
ok(/smartLlmRunControllers\.delete\(String\(node\.id\)\)/.test(js), '结束后清掉（不会误取消下一次）');
ok(/if\(controller\.cancelledByUser\) throw new Error\(tr\('smart\.promptLlmCancelled'\)\)/.test(js), '取消报「已取消」，不报超时');
const statusFn2 = topLevelFunction(js, 'llmRunStatusHtml');
ok(!/prompt-node-cancel/.test(js) && !/smart\.llmRunThinking/.test(statusFn2), '运行中那行连同「取消」一起删掉了（取消并进底部运行按钮）');
ok(/is-error/.test(statusFn2) && !/prompt-node-retry/.test(statusFn2), '失败那行只留错误原因（重试已挪到底部行，不重复）');
ok(/cancelSmartLlmRun\(node\.id\)/.test(js) && /llmRunStatus\.delete\(node\.id\);\s*\n\s*dispatchPromptNodeRun\(node\);/.test(js), '取消 / 重试都接好线（重试复用运行分发，列表模式也认）');
ok(/"smart\.promptLlmCancelled"/.test(i18n) && /"smart\.llmRunRetry"/.test(i18n), '文案已登记 i18n');
ok(/\.prompt-node-run-status\.is-error \{/.test(css) && !/prompt-node-retry/.test(css) && !/prompt-node-cancel/.test(css), '失败行样式还在；取消/重试两颗旧按钮的样式都已清掉');


console.log('[17] 后端是旧进程（新接口 404）时：退回普通接口 + 说人话');
ok(/res\.status === 409 \|\| res\.status === 404 \|\| res\.status === 405/.test(js), '404/405 也当「不支持流式」（老后端没有这个路由）');
ok(js.includes("^not found$/i") && js.includes('smart.llmEndpointMissing'), '光秃秃的 "Not Found" 换成一句解释');
ok(/"smart\.llmEndpointMissing"/.test(i18n) && /重启/.test(i18n), '提示里直接说「重启服务」');


console.log('[18] 生成中的文字要显示在编辑栏里（不能只往背后的节点上写）');
const statusFn3 = topLevelFunction(js, 'llmRunStatusHtml');
ok(/prompt-node-stream-preview/.test(statusFn3), '运行状态下面挂了生成预览块');
ok(/preview\.textContent = String\(text\)/.test(js) && /preview\.hidden = false/.test(js), '流式刷新时往里写字并显示');
ok(/preview\.scrollTop = preview\.scrollHeight/.test(js), '自动跟到底部（长文本在滚）');
ok(/\.prompt-node-stream-preview \{/.test(css) && /max-height:132px/.test(css), '预览块有高度上限、自己滚');

async function verifyTextGenerationRequest(streamSupported, reverse, storedSystem){
    const requests = [];
    const node = {id:'text-latency', type:'smart-prompt', llmProvider:'agent', llmModel:'gpt-5.5', llmSystemPrompt:storedSystem, reverse};
    const sandbox = {
        nodes:[node],
        llmRunStatus:new Map(),
        thoughtLineStarts:new Map(),
        AbortController, TextDecoder, setTimeout, clearTimeout, Date,
        resolveChatProviderId:value => value,
        resolveChatModel:value => value,
        promptNodeInputMediaForLLM:() => [{kind:'image', url:'/assets/reference.png'}, {kind:'video', url:'/assets/clip.mp4'}],
        imageRefsOnly:refs => refs.filter(ref => ref.kind === 'image'),
        videoRefsOnly:refs => refs.filter(ref => ref.kind === 'video'),
        smartLLMTarget:() => ({target_type:'', target_model:''}),
        promptNodeLLMInputText:() => '描述参考素材',
        render:() => {}, scheduleSave:() => {},
        paintStreamingPromptText:() => {}, cancelPromptStreamPaint:() => {},
        tr:key => key, trf:key => key, toast:() => {},
        console,
        fetch:async (url, options) => {
            requests.push({url, body:JSON.parse(options.body)});
            if(url === '/api/canvas-llm/stream' && !streamSupported) return {status:409, ok:false};
            if(url === '/api/canvas-llm/stream'){
                const chunk = new TextEncoder().encode('data: {"type":"done","text":"完成"}\n');
                let sent = false;
                return {status:200, ok:true, body:{getReader:() => ({read:async () => {
                    if(!sent){ sent = true; return {done:false, value:chunk}; }
                    return {done:true};
                }})}};
            }
            return {ok:true, json:async () => ({text:'完成'})};
        },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        "const SMART_CHAT_LEGACY_SYSTEM_PROMPT = 'You are a helpful prompt assistant.';",
        'const smartLlmRunControllers = new Map();',
        topLevelFunction(js, 'smartLlmDefaultSystemPrompt'),
        topLevelFunction(js, 'smartLlmNodeModeSystemPrompt'),
        topLevelFunction(js, 'streamCanvasLLMResponse'),
        topLevelFunction(js, 'callSmartCanvasLLM'),
        topLevelFunction(js, 'runPromptLLMNode'),
        'globalThis.run = runPromptLLMNode;',
        'globalThis.callDirect = callSmartCanvasLLM;',
    ].join('\n'), sandbox);
    await sandbox.run(node.id);
    return {requests, node, callDirect:sandbox.callDirect};
}

(async () => {
    console.log('[19] 实际请求：节点模式忽略历史 System，聊天仍保留人设');
    for(const [streamSupported, reverse, storedSystem, expectedDefault] of [
        [true, false, 'You are a helpful prompt assistant.', true],
        [false, true, '', true],
        [true, true, '自定义 System：只写材质。', true],
    ]){
        const label = (streamSupported ? '流式' : '409 回退') + (expectedDefault ? '默认' : '自定义');
        try {
            const {requests, node, callDirect} = await verifyTextGenerationRequest(streamSupported, reverse, storedSystem);
            ok(requests.length === (streamSupported ? 1 : 2), label + ' 请求次数正确');
            ok(requests.every(request => request.body.no_prompt_intelligence === true), label + ' 均带跳过标记');
            ok(requests.every(request => request.body.images?.[0] === '/assets/reference.png' && request.body.videos?.[0] === '/assets/clip.mp4'), label + ' 图片和视频仍传递');
            ok(requests.every(request => request.body.reverse === false), label + ' 旧反推设置不再暗中生效');
            ok(requests.every(request => expectedDefault
                ? request.body.system_prompt.includes('只输出一段可直接复制的生图提示词')
                : request.body.system_prompt === storedSystem), label + ' 实际请求 System 正确');
            ok(node.text === '完成', label + ' 结果写回节点');
            if(storedSystem){
                await callDirect(node, '聊天问题', [], {chat:true, noMedia:true});
                ok(requests[requests.length - 1].body.system_prompt === storedSystem, label + ' 聊天调用仍保留原 System');
                await callDirect(node, '出表', [], {noMedia:true});
                ok(requests[requests.length - 1].body.system_prompt === '', label + ' 非聊天出表不带隐藏的旧 System');
            }
        } catch(error){
            fails.push(label + ' 运行失败：' + error.message);
        }
    }
    console.log('');
    if(fails.length){
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach(item => console.error('  ✗ ' + item));
        console.error('通过 ' + pass + ' 项');
        process.exitCode = 1;
    } else console.log('全部通过（' + pass + ' 项）');
})();
