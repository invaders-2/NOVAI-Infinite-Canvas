/* 智能画布「文本生成」节点聊天模式的静态断言。
   钉死三件事：聊天记录滚动/焦点不被重绘打回顶部、发送后有「思考中」动效、
   角色默认「提示词优化」且不覆盖手写系统提示词。
   跑法：node tests/test_smart_canvas_chat.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('static/smart-canvas.html');
const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected), label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));
const count = (src, re) => (src.match(re) || []).length;

console.log('[1] 聊天记录滚动：捕获 → 恢复 → 贴底');
ok(js.includes('function capturePromptNodeChatUiState('), '有 capturePromptNodeChatUiState');
ok(js.includes('function restorePromptNodeChatUiState(state)'), '有 restorePromptNodeChatUiState');
ok(js.includes('log.scrollHeight - log.scrollTop - log.clientHeight < 12'), '贴底判定沿用经典画布的 12px 阈值');
ok(js.includes('log.scrollTop = pos.atBottom ? log.scrollHeight : (pos.top || 0)'), '贴底复原到底、否则回原位（上翻不被拉到底）');
/* 恢复 = 同步写一次 + rAF 再校正一次：
   拖动 mouseup 后的 click 会在同一帧连触两次 render（shell.onclick + closePromptTemplatePanel），
   只靠 rAF 的话第二次 capture 会读到 0 并把它写回去。 */
ok(js.includes('const applyChatScroll = () => {'), '恢复逻辑抽成 applyChatScroll');
const syncWriteAt = js.indexOf('    applyChatScroll();');
const rafWriteAt = js.indexOf('requestAnimationFrame(applyChatScroll)');
ok(syncWriteAt > 0, 'bindNodeEvents 之后的恢复里同步写一次');
ok(rafWriteAt > syncWriteAt, 'rAF 再校正一次（图标/图片撑开后高度才定型），且排在同步写之后');
ok(js.includes('log.scrollTop = pos.atBottom ? log.scrollHeight : (pos.top || 0)'), '同步/rAF 两趟用的是同一套恢复规则');
const closePanelFn = (js.match(/function closePromptTemplatePanel\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(/if\(!promptTemplatePanel\?\.classList\.contains\('open'\)\)\{[\s\S]*?return;/.test(closePanelFn), '面板本来就关着时早退：不再制造同帧第二次 render');
ok(closePanelFn.includes('render();'), '面板真的开着时照旧 render（模板面板行为不变）');
ok(closePanelFn.includes('syncComposerTemplateButton();'), '早退分支仍同步 composer 按钮态');
/* 捕获必须在构建 nodeHtmlEntries 之前（那时旧 DOM 还在），恢复必须在 bindNodeEvents 之后 */
const capAt = js.indexOf('const chatUiState = capturePromptNodeChatUiState();');
const entriesAt = js.indexOf('const nodeHtmlEntries = nodes');
const bindAt = js.indexOf('bindNodeEvents();');
const restoreAt = js.indexOf('restorePromptNodeChatUiState(chatUiState);');
ok(capAt > 0 && entriesAt > 0 && capAt < entriesAt, '捕获在 nodeHtmlEntries 之前');
ok(restoreAt > 0 && restoreAt > bindAt, '恢复在 bindNodeEvents() 之后');
ok(js.includes('function render(){') && js.indexOf('function render(){') < capAt, '捕获在 render() 里');

console.log('[1b] F1：从别的页签切回聊天 → 贴底看最新回复');
const tabBlock = (js.match(/else if\(which === 'chat'\)\{([\s\S]*?)\n            \}/) || [])[1] || '';
ok(tabBlock.includes("const switched = node.llmTab !== 'chat';"), 'F1：先记住是不是「从别的页签切回来」');
ok(/if\(switched && \(node\.chatMessages \|\| \[\]\)\.length\) node\.chatStickBottom = true;/.test(tabBlock), 'F1：切回聊天且有历史消息才置贴底标记');
const switchedAt = tabBlock.indexOf('const switched');
const stickAt = tabBlock.indexOf('node.chatStickBottom = true');
const renderAt = tabBlock.indexOf('render();');
ok(switchedAt > -1 && switchedAt < stickAt && stickAt < renderAt, 'F1：置标记在 render() 之前（本次渲染就用上）');
ok(!/if\(\(node\.chatMessages \|\| \[\]\)\.length\) node\.chatStickBottom = true;/.test(tabBlock), 'F1：不无条件贴底（本来就在聊天页签的重绘不受影响）');
ok(/state\.stickIds\.forEach\(id => \{\n            if\(state\.scrolls\.has\(id\)\) return;/.test(js), 'F1：新造出来的聊天记录（捕获时无 log）也贴底');

console.log('[2] 发送/回复后贴底 + 焦点留在输入框');
const stickCount = count(js, /node\.chatStickBottom = true;/g);
ok(stickCount >= 3, '发送、回复、失败三条路径都置贴底标记（实际 ' + stickCount + ' 处）');
ok(js.includes('node.chatFocusInput = true;'), '发送时置焦点标记');
ok(/if\(node\.chatStickBottom\) stickIds\.push\(id\);/.test(js) && /if\(node\.chatFocusInput\) focusIds\.push\(id\);/.test(js), '贴底与焦点标记分开收集（不再混一个数组）');
ok(/delete node\.chatStickBottom;\n            delete node\.chatFocusInput;/.test(js), '标记用完即 delete（不留字段）');
ok(js.includes('const stick = stickIds.includes(id);'), '捕获时用贴底标记覆盖 atBottom');
ok(js.includes("selector: '.llm-chat-input', start: null, end: null"), '发送后光标回到聊天输入框末尾（不选中）');
ok(js.includes('input.focus({preventScroll:true})'), '恢复焦点用 focus');
ok(js.includes('const lostFocus = !active || active === document.body || !document.contains(active);'), '只在焦点被重建弄丢时才恢复，用户点到别处不抢');
/* F2：lostFocus 必须同时管住「发送节点聊天框」和「原输入控件」两条恢复路径 */
ok(/const target = !lostFocus \? null\n        : state\.focusIds\.length \? \{id: state\.focusIds\[0\], selector: '\.llm-chat-input'/.test(js), 'F2：未丢焦点两条路径都不恢复；丢焦点时优先发送方聊天框');
ok(!/state\.stickIds\.length\s*\n?\s*\? \{id: state\.stickIds/.test(js), 'F2：贴底标记不再驱动抢焦点');

console.log('[3] 「思考中」动效：ThoughtLine 风格（sparkle 呼吸 + 文案微光 + 秒表）');
ok(js.includes('llm-chat-thinking'), '聊天记录里有 .llm-chat-thinking（verify 脚本的选择器）');
ok(/node\.running \? \`<div class="llm-chat-thinking">\$\{thinkingHtml\(tr\('smart\.chatThinking'\), node\.id\)\}<\/div>\` : ''/.test(js), 'running 时才渲染，且把节点 id 当计时 key 传给 thinkingHtml + i18n 文案不动');
ok(js.includes("thinkingHtml('正在规划…')"), '智能画布助手气泡仍复用 thinkingHtml（第二个参数省略 = agent）');
const thinkFn = (js.match(/function thinkingHtml\(text, key\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(thinkFn.length > 200, 'thinkingHtml(text, key)：第二个参数可选，老调用方式不破');
ok(/const k = key \|\| 'agent';/.test(thinkFn), "key 缺省 = 'agent'（助手气泡）");
ok(thinkFn.includes('thought-line__glyph') && thinkFn.includes('thought-line__breath') && thinkFn.includes('thought-line__timer'), '三件套：闪光图标 / 微光文案 / 秒表');
ok(/thought-line__timer" data-start="/.test(thinkFn), '秒表元素带 data-start（render 重建 DOM 后起点不丢）');
ok(thinkFn.includes("if(!thoughtLineTicker) thoughtLineTicker = setInterval(thoughtLineSync, 100)"), '第一次渲染拉起全局 100ms ticker');
ok(!thinkFn.includes('node.'), 'thinkingHtml 不碰 node（计时起点不落盘）');
/* 无依赖：助手气泡走动态 innerHTML，不保证有人调 lucide.createIcons()，所以图标必须是内联 SVG */
const glyph = (js.match(/const THOUGHT_LINE_GLYPH = '([^']+)'/) || [])[1] || '';
ok(/^<svg viewBox="0 0 24 24"/.test(glyph) && glyph.includes('stroke="currentColor"') && glyph.includes('stroke-width="2"') && glyph.includes('<path'), 'sparkle 是 24x24 / stroke=2 / currentColor 的内联 SVG（照 lucide 形状手写）');
ok(!glyph.includes('data-lucide'), '图标不走 data-lucide');
/* 计时起点存模块级 Map：render 重建 DOM 时起点不能丢，也不能写 node（canvasForStorage 会落盘） */
ok(/const thoughtLineStarts = new Map\(\);/.test(js), '计时起点放模块级 Map');
ok(/let start = thoughtLineStarts\.get\(k\);\n    if\(start === undefined\)\{\n        start = performance\.now\(\);\n        thoughtLineStarts\.set\(k, start\);\n    \}/.test(js), 'Map 里已有起点就复用（重绘不重新计时）');
/* ticker 自清理：页面上一个秒表都不剩就停，绝不常驻 */
const syncFn = (js.match(/function thoughtLineSync\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(syncFn.includes("document.querySelectorAll('.thought-line__timer[data-start]')"), 'ticker 只认页面上真实存在的秒表');
ok(/if\(!timers\.length\)\{\n        clearInterval\(thoughtLineTicker\);\n        thoughtLineTicker = null;\n        return;\n    \}/.test(syncFn), '秒表全没了 → clearInterval + 置空（自清理）');
ok(syncFn.includes('Math.floor((now - Number(el.dataset.start)) / 100)'), 'ds = 距 data-start 的十分之一秒（照原版 100ms 一拍）');
/* 格式化照原版：<60s 一位小数秒，>=60s 显示 1m 3.0s */
const fmtSrc = (js.match(/function thoughtLineFmt\(ds\)\{[\s\S]*?\n\}/) || [])[0] || '';
const fmt = fmtSrc ? new Function('return (' + fmtSrc + ')')() : null;
ok(typeof fmt === 'function' && fmt(0) === '0.0s' && fmt(3) === '0.3s' && fmt(599) === '59.9s' && fmt(600) === '1m 0.0s' && fmt(630) === '1m 3.0s', '秒表格式化：0.0s / 59.9s / 1m 0.0s / 1m 3.0s');
/* 运行结束删 key：成功和失败都要清，否则下一轮会接着上一轮的秒数走 */
const runChatFn = (js.match(/async function runSmartPromptChat\(node\)\{([\s\S]*?)\n\}/) || [])[1] || '';
const runFinally = (runChatFn.match(/finally \{([\s\S]*?)\n    \}/) || [])[1] || '';
ok(runFinally.includes('thoughtLineStarts.delete(node.id);'), '节点聊天：清理点在 finally（成功/失败两条分支都覆盖），删节点 key');
ok(runChatFn.indexOf('} catch(e) {') > 0 && runChatFn.indexOf('} finally {') > runChatFn.indexOf('} catch(e) {'), 'try/catch 之后补了 finally（原来没有）');
const sendFn = (js.match(/async function sendChatMessage\(\)\{([\s\S]*?\n\})/) || [])[1] || '';
const sendFinally = (sendFn.match(/finally \{([\s\S]*?)\n    \}/) || [])[1] || '';
ok(sendFinally.includes("thoughtLineStarts.delete('agent');"), '助手气泡：sendChatMessage 的 finally 里删 agent key');
/* CSS：新类名 + 颜色走项目变量 + reduced-motion 关动画 + 旧类名清干净 */
ok(css.includes('.prompt-node-llm .llm-chat-thinking .thought-line { font-size:10.5px;'), '聊天区局部覆盖 10.5px（原来是 10.5px 文字 + 5px 圆点）');
ok(/\.thought-line \{\n    display: inline-flex;[\s\S]{0,220}color: var\(--muted\);/.test(css), '文字色用 var(--muted)');
ok(/\.thought-line__glyph \{[\s\S]{0,220}color: var\(--accent\);/.test(css), '图标色用 var(--accent)');
ok(/\.thought-line__breath \{[\s\S]{0,400}color-mix\(in srgb, currentColor 50%, transparent\)/.test(css), 'shimmer 渐变用 color-mix(currentColor)，不写死颜色');
ok(/@media \(prefers-reduced-motion: reduce\) \{\n    \.thought-line__glyph \{ animation: none;[\s\S]{0,180}\.thought-line__breath \{ animation: none;/.test(css), 'reduced-motion 下关掉 shimmer + 呼吸');
ok(!css.includes('.agent-thinking') && !js.includes('agent-thinking'), '旧的 .agent-thinking 死代码已清干净');

console.log('[4] 角色：默认「提示词优化」+ 自定义不被覆盖');
ok(js.includes("const SMART_CHAT_DEFAULT_PERSONA_ID = 'builtin_prompt_optimizer';"), '默认角色 = builtin_prompt_optimizer');
ok(js.includes('const SMART_CHAT_LEGACY_SYSTEM_PROMPT'), '老节点出厂默认值被识别为「没设过」');
ok(/if\(node\.llmTab !== 'chat' \|\| node\.chatPersonaId\) return false;/.test(js), '只在聊天模式且未设过角色时套默认');
ok(/if\(current && current !== SMART_CHAT_LEGACY_SYSTEM_PROMPT\) return false;/.test(js), '手写过的系统提示词不覆盖');
ok(/if\(!applyChatPersona\(node, SMART_CHAT_DEFAULT_PERSONA_ID\)\) return false;\n    scheduleSave\(\);/.test(js), '默认一次性写入并持久化');
ok(/node\.llmSystemPrompt = String\(persona\.content \|\| ''\);\n    node\.chatPersonaId = persona\.id;\n    node\.llmSystemEnabled = true;/.test(js), 'applyChatPersona 写 llmSystemPrompt / chatPersonaId / llmSystemEnabled');
ok(js.includes("if(!applyChatPersona(node, chip.dataset.personaId)) return;") && js.includes('render();\n            scheduleSave();'), 'chip 点击 = applyChatPersona + render + scheduleSave');
ok(js.includes("if(systemEl){\n        bindScrollableText(systemEl);"), '系统提示词文本框的绑定没被压成一行（可插入自定义标记）');
ok(/systemEl\.oninput = e => \{[\s\S]{0,220}node\.chatPersonaId = SMART_CHAT_PERSONA_CUSTOM;/.test(js), '手写系统提示词 → chatPersonaId = custom');
ok(js.includes('function syncChatPersonaChips(el, node)') && js.includes('customChip.hidden = !state.custom'), 'chips 高亮/自定义标记能就地同步');
ok(js.includes("const selector = active && active.classList"), '系统提示词框也在焦点保护范围内');
/* 默认必须在 llmTab 归一化之后、systemPrompt 快照之前，否则第一屏拿到的还是旧值 */
const ensureAt = js.indexOf('ensureChatPersonaDefault(node);');
const sysAt = js.indexOf("const systemPrompt = (node.llmSystemPrompt || '').trim();");
ok(js.includes("node.llmTab = node.llmTab === 'chat' ? 'chat' : 'node';\n    ensureChatPersonaDefault(node);"), 'ensureChatPersonaDefault 紧跟 llmTab 归一化');
ok(sysAt > ensureAt, '默认角色在读取 systemPrompt 之前生效（第一屏就带上）');

console.log('[5] /api/personas：一次拉取 + 失败兜底');
ok(js.includes("fetch('/api/personas')"), '调用了 /api/personas');
ok(/if\(chatPersonaRequest\) return chatPersonaRequest;/.test(js), '页面级只拉一次（promise 缓存）');
ok(js.includes('const SMART_CHAT_FALLBACK_PERSONA') && js.includes('.catch(() => { chatPersonaLibrary = []; })'), '拉取失败不抛错、不阻塞');
ok(js.includes('function upgradeChatPersonaDefaults()'), '角色库到手后把兜底默认升级成后端真角色');
ok(js.includes("chatPersonaLibrary = list;\n            upgradeChatPersonaDefaults();"), 'loadChatPersonas 里调用升级');
ok(/if\(node\.type !== 'smart-prompt' \|\| node\.chatPersonaId !== SMART_CHAT_DEFAULT_PERSONA_ID\) return;/.test(js), '只升级仍是默认角色的节点');
ok(/if\(String\(node\.llmSystemPrompt \|\| ''\)\.trim\(\) !== SMART_CHAT_FALLBACK_PERSONA\.content\) return;/.test(js), '只升级「还是兜底原文」的节点（手写内容不碰）');
ok(js.includes('提示词优化专家'), '兜底提示词本身是「提示词优化」角色');
ok(/return \[Object\.assign\(\{\}, SMART_CHAT_FALLBACK_PERSONA, \{name: tr\('smart\.chatPersonaDefault'\)\}\)\];/.test(js), '拉不到时 chips 只显示兜底角色（不空不报错）');

console.log('[5b] F3：chips 按当前生效的 system 提示词判断（只显示、不改数据）');
const displayFn = (js.match(/function chatPersonaDisplayState\(node\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(displayFn.length > 100, 'F3：有 chatPersonaDisplayState');
ok(displayFn.includes('SMART_CHAT_PERSONA_CUSTOM'), 'F3：仍识别显式 custom');
ok(displayFn.includes("return hit ? {id: hit.id, custom: false} : {id: '', custom: true};"), 'F3：内容不匹配任何角色 → 自定义');
ok(!/node\.\w+\s*=/.test(displayFn), 'F3：显示判断里没有任何写操作（不回写 chatPersonaId）');
ok(/chatPersonaChipsHtml\(node\)\{\n    const state = chatPersonaDisplayState\(node\);/.test(js), 'F3：chips HTML 用显示状态');
ok(/function syncChatPersonaChips\(el, node\)\{\n    const state = chatPersonaDisplayState\(node\);/.test(js), 'F3：就地同步也用显示状态');

console.log('[5c] F4/F5：运行态与临时标记不落盘 + 载入自愈');
ok(/delete node\.running;/.test(js), 'F4a：canvasForStorage 剥掉 running');
const storageFn = (js.match(/function canvasForStorage\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(storageFn.includes('delete node.running;') && storageFn.includes('delete node.chatStickBottom;') && storageFn.includes('delete node.chatFocusInput;'), 'F5：canvasForStorage 里三个临时字段都剥掉（已落盘的脏数据下次保存自动消失）');
const healFn = (js.match(/function healStalePromptNodeRunning\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(healFn.includes("node.type !== 'smart-prompt' || !node.running"), 'F4b：只处理 running 的 smart-prompt 节点');
ok(healFn.includes('if(node.pending || node.queued || node.jimengPending || smartPendingTasks(node).length) return;'), 'F4b：有在跑任务/排队就不碰');
ok(healFn.includes('node.running = false;'), 'F4b：清掉脏 running');
ok(healFn.includes('delete node.chatStickBottom;') && healFn.includes('delete node.chatFocusInput;'), 'F5：载入时也清掉已落盘的 chatStickBottom/chatFocusInput（不分节点类型）');
ok(/if\(node\.chatStickBottom !== undefined \|\| node\.chatFocusInput !== undefined\)\{/.test(healFn), 'F5：只在真的有脏字段时才动/才置 changed');
const loadAt = js.indexOf('const healedPromptRunning = healStalePromptNodeRunning();');
const loadRenderAt = js.indexOf('        render();\n        if(cleanedDetachedInputs');
ok(loadAt > 0 && loadRenderAt > loadAt, 'F4b：在 loadCanvas 首屏 render() 之前自愈');
ok(js.includes('if(cleanedDetachedInputs || cleanedCompletedState || healedPromptRunning || resetBatchRuns'), 'F4b：自愈后落盘（脏数据自动消失）');
ok(js.indexOf('function render(){') > 0 && !/function render\(\)\{[\s\S]{0,3000}healStalePromptNodeRunning\(/.test(js), 'F4b：不在 render() 里自愈（聊天 running 时没有 pendingTasks，会被误杀）');

console.log('[6] 只影响聊天模式：节点模式 / 出表模式 / 经典画布不动');
ok(js.includes("system_prompt: node.llmSystemPrompt || 'You are a helpful assistant.',"), '请求体 system_prompt 字段结构不变');
ok(js.includes('if(options.chat) body.no_prompt_intelligence = true;'), 'no_prompt_intelligence 语义不变');
ok(!/ensureChatPersonaDefault\(node\);\n    const message = promptNodeLLMInputText/.test(js), '节点模式入口不注入角色');
ok(js.includes("const text = await callSmartCanvasLLM(node, message, []);"), 'runPromptLLMNode 调用方式不变');
ok(js.includes("const history = node.chatMessages.slice();"), '聊天历史快照逻辑不变');

console.log('[7] i18n：四个新 key 的 zh + en 都在');
[['smart.chatPersona', '角色', 'Role'],
 ['smart.chatPersonaDefault', '提示词优化', 'Prompt Optimizer'],
 ['smart.chatPersonaCustom', '自定义', 'Custom'],
 ['smart.chatThinking', '思考中…', 'Thinking…']].forEach(([key, zh, en]) => {
    const hit = new RegExp('"' + key + '": \\{ zh: "' + zh + '", en: "' + en + '" \\}').test(i18n);
    ok(hit, key + ' 的 zh/en 都存在且为「' + zh + ' / ' + en + '」');
});

console.log('[8] 缓存串：改过的两个资源都升到 1.0.120.<epoch>');
const cssV = (html.match(/css\/smart-canvas\.css\?v=1\.0\.120\.(\d+)/) || [])[1];
const jsV = (html.match(/js\/smart-canvas\.js\?v=1\.0\.120\.(\d+)/) || [])[1];
ok(Boolean(cssV) && Number(cssV) > 1789719097, 'smart-canvas.css 的 ?v= 已更新（' + cssV + '）');
ok(Boolean(jsV) && Number(jsV) > 1789720396, 'smart-canvas.js 的 ?v= 已更新（' + jsV + '）');

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
