/* 「提示词节点生成结果：双击查看 / 编辑」的回归测试（零依赖）。

   覆盖：
   [1] 绑定：只有输出区双击才打开，复制键不触发，同一元素只绑一次
   [2] 打开：只读协作拦截；只接受 smart-prompt 节点；内容是 Markdown 原文（不是排版后的 HTML）
   [3] 草稿语义：编辑时不写 node；保存才写回 node.text + node.outputText（下游读 outputText）
   [4] 关闭策略：生成结果有改动时先确认；纯文本节点保持原行为（Esc/遮罩=保留，取消=还原）
   [5] 纯文本提取：Markdown 源码的换行/行首缩进不能被吃掉

   跑法：node tests/test_smart_prompt_output_editor.js */
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

console.log('[1] 绑定：只有输出区双击才打开，复制键不触发');
{
    const bindFn = fn('bindPromptOutputEditor');
    ok(Boolean(bindFn), '有 bindPromptOutputEditor');
    ok(/querySelector\('\.prompt-node-display'\)/.test(bindFn), '只认输出区 .prompt-node-display');
    ok(/addEventListener\('dblclick'/.test(bindFn), '原生 dblclick 快路');
    /* 单击会选中节点并触发布局回写，节点子树被重建后 click/dblclick 的 target 会归到节点本身：
       所以再按「450ms 内两次 mousedown 落在输出区坐标内」兜底，不能只认 target.closest。 */
    ok(/addEventListener\('mousedown'/.test(bindFn) && /insideDisplay/.test(bindFn), 'mousedown + 坐标兜底（子树重建后仍能双击打开）');
    ok(/now - promptOutputClickStamp\.at < 450/.test(bindFn), '双击窗口 450ms');
    ok(/data-prompt-copy-markdown/.test(bindFn), '双击复制键不弹编辑器（先排掉那个按钮）');
    ok(/openPromptOutputEditor\(node\.id\)/.test(bindFn), '打开生成结果编辑器');
    ok(/promptOutputEditorEditorBound|promptOutputEditorBound === '1'/.test(bindFn), '同一元素只绑一次（keepEl 复用不重复绑）');
    ok(/promptOutputEditorOpenFor\(node\.id\)\) return/.test(bindFn), '已经在编辑这个节点时不重复打开（不冲掉草稿）');
    ok(/bindPromptOutputEditor\(el, node\);/.test(js), '提示词节点的控制台绑定里挂上了它');
    ok(!/bindPromptOutputEditor\(el, nodeForControls\)/.test(js), '纯文本节点仍走自己的 openSmartTextEditor（不重复挂）');
}

console.log('[2] 打开：只读拦截 / 只接受提示词节点 / 内容是 Markdown 原文');
{
    const openFn = fn('openPromptOutputEditor');
    ok(Boolean(openFn), '有 openPromptOutputEditor');
    ok(/if\(collabReadOnly\)\{ collabNotifyReadOnly\(\); return false; \}/.test(openFn), '只读画布/协作锁定时不进编辑，只提示');
    ok(/node\.type !== 'smart-prompt'\) return false/.test(openFn), '只对提示词节点生效');
    ok(/smartTextEditorMode = 'prompt-output'/.test(openFn), '标记弹窗用途=生成结果');
    ok(/input\.classList\.add\('is-raw'\)/.test(openFn) && /input\.textContent = smartTextEditorOriginalText/.test(openFn), '按纯文本灌入（Markdown 源码不被排版吃掉）');
    ok(/node\.outputText \|\| node\.text/.test(openFn), '优先取 outputText（生成结果）');
    ok(/\.smart-text-modal-input\.is-raw \{[^}]*white-space:pre-wrap/.test(css), '编辑框在 is-raw 下保留换行（pre-wrap）');
    ok(/setSmartTextEditorChrome\(true\)/.test(openFn), '打开时把弹窗标题/提示切成「生成结果」一套');
    ok(/smart\.promptOutputTitle/.test(i18n) && /smart\.promptOutputHint/.test(i18n), '标题/提示文案走 i18n');
    ok(/setSmartTextEditorChrome\(false\)/.test(fn('openSmartTextEditor')), '纯文本节点打开时切回原来的标题/提示');
    ok(/setSmartTextEditorChrome\(false\)/.test(fn('closeSmartTextEditor')), '关闭时也还原，不残留');
}

console.log('[3] 草稿语义：编辑不写 node，保存才写回 node.text + node.outputText');
{
    const syncFn = fn('syncSmartTextEditorNode');
    ok(/if\(smartTextEditorMode !== 'text'\)\{ updateSmartTextEditorCount\(\); return null; \}/.test(syncFn), '生成结果模式：输入只刷字数，不写 node');
    const closeFn = fn('closeSmartTextEditor');
    ok(/if\(promptOutput\)\{[\s\S]{0,240}if\(save\)\{[\s\S]{0,160}node\.text = value;\s*node\.outputText = value;/.test(closeFn),
        '保存时同时写 node.text 与 node.outputText（下游读 outputText）');
    ok(/else if\(!save\)\{\s*node\.text = smartTextEditorOriginalText;\s*\}/.test(closeFn), '纯文本节点：取消才还原（原行为）');
    ok(/scheduleSave\(\)/.test(closeFn) && /render\(\)/.test(closeFn), '关闭后重绘 + 落盘');
}

console.log('[4] 关闭策略：生成结果有改动先确认');
{
    const reqFn = fn('requestCloseSmartTextEditor');
    ok(Boolean(reqFn) && /window\.confirm\(tr\('smart\.promptOutputDiscard'\)\)/.test(reqFn), '有未保存的修改 → confirm 确认放弃');
    ok(/smartTextEditorMode === 'prompt-output' && !defaultSave/.test(reqFn), '只在「生成结果 + 放弃」这条路上确认（保存不打扰）');
    ok(/const dirty = String\(smartTextEditorValue\(\) \|\| ''\)\.trim\(\) !== String\(smartTextEditorOriginalText \|\| ''\)\.trim\(\);/.test(reqFn), '改动判定用 trim 后的文本比较（只改空白不算脏）');
    const wireAt = js.indexOf('function wireSmartTextEditor');
    const wireBlock = wireAt < 0 ? '' : js.slice(wireAt, wireAt + 1800);
    ok(/const closeByDismiss = \(\) => requestCloseSmartTextEditor\(smartTextEditorMode !== 'prompt-output'\)/.test(wireBlock),
        'Esc / 点遮罩：纯文本=保留（原行为），生成结果=放弃（走确认）');
    ok(/#smartTextModalCancel'\).*requestCloseSmartTextEditor\(false\)/.test(wireBlock), '「取消」按钮也走确认');
    ok(/#smartTextModalSave'\).*closeSmartTextEditor\(true\)/.test(wireBlock), '「保存」直接落地，不弹确认');
    ok(/smart\.promptOutputDiscard/.test(i18n) && /有未保存的修改/.test(i18n), '确认文案已登记 i18n（中英）');
}

console.log('[5] 纯文本提取：Markdown 源码的换行 / 行首缩进不被吃掉');
{
    const rawFn = fn('smartTextModalRawPlain');
    ok(Boolean(rawFn), '有 smartTextModalRawPlain');
    const NodeStub = {TEXT_NODE: 3, ELEMENT_NODE: 1};
    const api = new Function('Node', rawFn + '\nreturn smartTextModalRawPlain;')(NodeStub);
    const text = value => ({nodeType: 3, nodeValue: value});
    const el = (tagName, children) => ({nodeType: 1, tagName, childNodes: children});
    ok(api(el('DIV', [text('## 标题'), el('DIV', [text('  - 子项')]), el('BR', [])])) === '## 标题\n  - 子项\n',
        '换行用 DIV/BR 还原；行首缩进原样保留');
    ok(api(el('DIV', [text('a'), el('DIV', [text('b')])])) === 'a\nb', '块级 div 之间只补一个换行（不重复）');
    ok(api(null) === '', '空入参不抛错');
    ok(/input\.addEventListener\('input', syncSmartTextEditorNode\)/.test(js), '输入事件仍走同一个入口（两模式共用）');
}

console.log('');
if(fails.length){
    console.error('生成结果编辑：失败 ' + fails.length + ' 项');
    fails.forEach(item => console.error('  x ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('生成结果编辑：' + pass + ' 项通过');
