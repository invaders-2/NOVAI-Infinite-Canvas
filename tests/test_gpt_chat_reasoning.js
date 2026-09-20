/* GPT 聊天页「思考条 + 可折叠思考 trace」静态断言。
   钉死五件事：后端把模型思考内容透出来（SSE reasoning 事件 + 落盘 + agent 决策）、
   agent 模式走流式端点 /api/chat/agent/stream（决策阶段实时转发 reasoning + 动作阶段发 status）、
   JSON 版 /api/chat/agent 契约不变（Photoshop 插件在用）、
   前端换掉三个圆点改 ThoughtLine、trace 的折叠/打勾/跳动点/status 条目结构、
   以及 i18n 与缓存串同步升级。
   跑法：node tests/test_gpt_chat_reasoning.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const py = read('main.py');
const html = read('static/gpt-chat.html');
const i18nStudio = read('static/js/i18n/studio.js');
const i18nLoader = read('static/js/i18n.js');
const indexHtml = read('static/index.html');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;
/* 抽函数体：按大括号配对，避免正则截断嵌套分支 */
function body(src, header){
    const start = src.indexOf(header);
    if(start < 0) return '';
    const open = src.indexOf('{', start);
    let depth = 0;
    for(let i = open; i < src.length; i++){
        if(src[i] === '{') depth += 1;
        else if(src[i] === '}'){ depth -= 1; if(depth === 0) return src.slice(start, i + 1); }
    }
    return '';
}
/* Python 函数体按缩进切：遇到缩进回到同级（或更浅）就结束，嵌套 def 也不会被截断 */
function pyBody(name, from){
    const header = 'def ' + name + '(';
    const start = py.indexOf(header, from || 0);
    if(start < 0) return '';
    const lines = py.slice(start).split('\n');
    const indent = lines[0].match(/^\s*/)[0];
    const out = [lines[0]];
    for(let i = 1; i < lines.length; i++){
        if(lines[i].trim() === ''){ out.push(lines[i]); continue; }
        if(lines[i].match(/^\s*/)[0].length <= indent.length) break;
        out.push(lines[i]);
    }
    return out.join('\n');
}

console.log('[1] 后端：思考增量提取函数');
const frag = pyBody('reasoning_text_from_fragment');
const rDelta = pyBody('reasoning_delta_from_chat_chunk');
const rResp = pyBody('reasoning_from_chat_response');
ok(frag.length > 200, '有 reasoning_text_from_fragment');
ok(/isinstance\(value, str\)/.test(frag) && /isinstance\(value, list\)/.test(frag), '字符串与数组两种形态都能拼');
ok(/for item in value/.test(frag) && /item\.get\("text"\)/.test(frag), '数组元素取 text/content');
ok(rDelta.length > 200, '有 reasoning_delta_from_chat_chunk');
ok(/delta = choices\[0\]\.get\("delta"\) or \{\}/.test(rDelta), '流式读的是 choices[0].delta');
ok(/for field in \("reasoning_content", "reasoning"\):/.test(rDelta), 'reasoning_content 优先、兼容 reasoning');
ok(/if text:\n\s+return text/.test(rDelta), '空片段不返回（没有思考内容时行为不变）');
ok(/return ""/.test(rDelta), '取不到就返回空串');
ok(rResp.length > 200 && /message = choices\[0\]\.get\("message"\) or \{\}/.test(rResp), '非流式读的是 choices[0].message');
ok(/data = unwrap_apimart_response\(data\)/.test(rResp), '非流式先解 APIMart 包装');
ok(/for field in \("reasoning_content", "reasoning"\):/.test(rResp), '非流式同样两字段兼容');

console.log('[2] 后端：流式 SSE 事件 + content 语义顺序不变');
/* 按路由锚点定位：新端点 chat_agent_stream 里也有个同名内部 stream()，不锚定会抽错函数 */
const streamFn = pyBody('stream', py.indexOf('@app.post("/api/chat/stream")'));
ok(streamFn.length > 500 && streamFn.includes('reasoning_parts = []'), 'stream() 里新增 reasoning_parts 累加器');
const reasonYield = 'yield sse_event({"type": "reasoning", "delta": reasoning_delta})';
ok(streamFn.includes(reasonYield), '新事件类型 {"type":"reasoning","delta":...}');
ok(/reasoning_delta = reasoning_delta_from_chat_chunk\(chunk\)\n\s+if reasoning_delta:\n\s+reasoning_parts\.append\(reasoning_delta\)\n\s+yield sse_event\(\{"type": "reasoning"/.test(streamFn), '每个 chunk 先取思考增量并累加');
const deltaAppendAt = streamFn.indexOf('content_parts.append(delta)');
const deltaYieldAt = streamFn.indexOf('yield sse_event({"type": "delta", "delta": delta})');
const reasonAt = streamFn.indexOf('reasoning_delta = reasoning_delta_from_chat_chunk(chunk)');
ok(reasonAt > 0 && reasonAt < deltaAppendAt, 'reasoning 在 content delta 之前处理');
ok(deltaAppendAt > 0 && deltaYieldAt > deltaAppendAt, 'delta 事件仍是「先入 content_parts 再 yield」，语义与顺序未变');
ok(count(streamFn, /yield sse_event\(\{"type": "delta", "delta": delta\}\)/g) === 1, 'delta 事件只有一处（没有被 reasoning 分支复制/替换）');
ok(/assistant_message = \{\n\s+"id": uuid\.uuid4\(\)\.hex,\n\s+"role": "assistant",\n\s+"content": "".join\(content_parts\)\.strip\(\) or "接口返回了空回复。",/.test(streamFn), '正文仍只由 content_parts 拼');
ok(/reasoning_text = "".join\(reasoning_parts\)\.strip\(\)\n\s+if reasoning_text:\n\s+assistant_message\["reasoning"\] = reasoning_text/.test(streamFn), '有思考内容才落盘 reasoning 字段（无则字段不存在）');
ok(streamFn.includes('yield sse_event({"type": "done", "conversation": conversation, "message": assistant_message})'), 'done 事件带回带 reasoning 的 message');

console.log('[3] 后端：非流式响应落盘 reasoning');
const chatFn = pyBody('chat');
ok(chatFn.includes('reasoning_text = reasoning_from_chat_response(raw).strip()'), '/api/chat 非流式取 message.reasoning_content');
ok(/if reasoning_text:\n\s+assistant_message\["reasoning"\] = reasoning_text/.test(chatFn), '/api/chat 有思考内容才写进 assistant_message');
const replyFn = pyBody('build_chat_text_reply');
ok(replyFn.includes('reasoning_text = reasoning_from_chat_response(raw).strip()'), 'build_chat_text_reply（agent 聊天分支）同样取思考内容');
ok(/if reasoning_text:\n\s+message\["reasoning"\] = reasoning_text\n\s+return message/.test(replyFn), 'build_chat_text_reply 只在有内容时带 reasoning 返回');

console.log('[4] 后端：agent 决策思考 + 不污染上游 messages');
const decideFn = pyBody('decide_chat_agent_action');
ok(decideFn.includes('decision["reasoning"] = reasoning_from_chat_response(raw).strip()'), '意图路由那一步的思考被带出来');
ok(!/enable_thinking|thinking_budget|reasoning_effort/.test(py), '没有给上游偷偷加开启思考的参数');
const agentFn = pyBody('chat_agent');
ok(/reasoning_text = str\(decision\.pop\("reasoning", ""\) or ""\)\.strip\(\)/.test(agentFn), 'decision 里的 reasoning 取出后从 decision 摘掉（响应体不多字段）');
ok(/if reasoning_text and not assistant_message\.get\("reasoning"\):\n\s+assistant_message\["reasoning"\] = reasoning_text/.test(agentFn), 'agent 消息带上决策思考；回复自带思考时不覆盖');
const upFn = pyBody('upstream_message_from_record');
ok(upFn.length > 300 && !upFn.includes('reasoning'), 'upstream_message_from_record 不带 reasoning（历史里的思考不会回灌上游）');
ok(/return \{"role": role, "content": item\.get\("content", ""\)\}/.test(upFn), '转回上游时仍只取 role/content');
const routerFn = pyBody('chat_agent_router_messages');
const routerCall = 'chat_agent_router_messages(payload, conversation, refs, has_previous_image)';
ok(routerFn.length > 800 && /return upstream_messages/.test(routerFn), '提示词构造抽成 chat_agent_router_messages');
ok(decideFn.includes(routerCall), 'JSON 版决策用共享提示词构造（不在函数里再写一遍）');
ok(count(py, /你是图片创作聊天 Agent 的意图路由器/g) === 1, '路由提示词在 main.py 里只有一份（两个端点不会写歪）');
ok(!/"stream": True/.test(decideFn) && decideFn.includes('req_body["stream"] = False'), 'JSON 版 /api/chat/agent 的决策调用仍是非流式');

console.log('[5] 前端：ThoughtLine（闪光图标 + 微光文案 + 秒表）');
ok(html.includes('const THOUGHT_LINE_GLYPH ='), '内联 sparkle SVG 常量（与智能画布同款）');
ok(/THOUGHT_LINE_GLYPH = '<svg viewBox="0 0 24 24"[\s\S]{0,1200}M9\.937 15\.5/.test(html), 'sparkle 路径与智能画布一致');
ok(html.includes('function thoughtLineFmt(ds){'), 'thoughtLineFmt 秒表格式化');
ok(html.includes('function thoughtLineSync(){') && html.includes("document.querySelectorAll('.thought-line__timer[data-start]')"), '全局 ticker 只扫真实存在的秒表');
ok(/if\(!timers\.length\)\{\n\s+clearInterval\(thoughtLineTicker\);\n\s+thoughtLineTicker = null;/.test(html), '没有秒表就自清理（不留常驻定时器）');
ok(html.includes('const thoughtLineStarts = new Map();'), '计时起点放 Map（重建 DOM 不重置）');
const lineHtml = body(html, 'function thoughtLineHtml(text, key){');
ok(lineHtml.includes('thought-line__glyph') && lineHtml.includes('thought-line__breath') && lineHtml.includes('thought-line__timer'), '三件套齐全');
ok(lineHtml.includes("data-start=") && lineHtml.includes('setInterval(thoughtLineSync, 100)'), '秒表带 data-start，100ms tick');
ok(html.includes("const THOUGHT_CHECK_GLYPH = '<svg") && html.includes('M20 6 9 17l-5-5'), '打勾用 1em 的勾形 SVG（原版形态）');
ok(html.includes("const THOUGHT_CARET_GLYPH = '<svg"), '折叠箭头是内联 SVG（不依赖图标库）');
ok(!html.includes('thinking-dots') && !html.includes('thinking-bounce') && !html.includes('thinking-pulse'), '三个跳动圆点（旧占位）已彻底移除');

console.log('[6] 前端：trace 结构（逐条 / 打勾 / 跳动点 / 限高滚动贴底 / 折叠）');
ok(html.includes('.thought-trace { max-height:160px; overflow-y:auto;'), 'trace 限高 160px + 超出滚动');
ok(html.includes('.thought-trace:empty { display:none; }'), '没有条目时整块不显示（不编造假步骤）');
ok(html.includes('.bubble-thought.is-collapsed .thought-trace { display:none; }'), '折叠 = 隐藏 trace');
ok(/\.bubble-thought\.has-trace \.thought-line__caret \{ display:inline-flex; \}/.test(html), '有 trace 才显示可点开的小箭头');
ok(html.includes('.thought-trace__mark svg { display:block; width:1em; height:1em; opacity:.5; }'), '勾 1em + 低透明度');
ok(html.includes('@keyframes thoughtTracePulse') && html.includes('.thought-trace__pulse {'), '最后一条的跳动点（pulse）');
ok(/prefers-reduced-motion: reduce[\s\S]{0,400}thought-trace__pulse \{ animation:none/.test(html), 'prefers-reduced-motion 兜底');
const syncFn = body(html, 'function syncThoughtTrace(block, entries, activeLast){');
ok(syncFn.includes('trace.appendChild(createThoughtTraceRow())'), '按条目增量长 DOM（不是每次整块重建）');
ok(/const active = activeLast !== false && i === entries\.length - 1;/.test(syncFn), '只有最后一条是「进行中」');
ok(syncFn.includes("row.classList.toggle('is-done', !active && !isStatus)") && syncFn.includes('THOUGHT_CHECK_GLYPH'), '前面的条目打勾（status 条目走自己的图标）');
ok(syncFn.includes("const isStatus = typeof entry === 'object' && entry !== null && !!entry.status;"), '条目支持 {text, status:true}');
ok(syncFn.includes("row.classList.toggle('is-status', isStatus)"), 'status 条目单独挂 is-status（颜色/图标区分）');
ok(syncFn.includes('(isStatus ? THOUGHT_STEP_GLYPH : THOUGHT_CHECK_GLYPH)'), 'status=闪电图标、其余=勾，进行中=跳动点');
ok(html.includes("const THOUGHT_STEP_GLYPH = '<svg"), 'status 条目用内联闪电 SVG（不引图标库）');
ok(html.includes('.thought-trace__row.is-status { color:var(--chat-text); font-weight:500; }'), 'status 条目样式与思考条目区分');
const settleKeepFn = body(html, 'function settleThoughtBlock(block){');
ok(/status: row\.classList\.contains\('is-status'\)/.test(settleKeepFn), '收尾重新同步时保留 status 标记（不会退化成普通勾）');
ok(syncFn.includes("'<span class=\"thought-trace__pulse\"></span>'"), '进行中的条目挂跳动点');
ok(/while\(trace\.children\.length > entries\.length\) trace\.lastElementChild\.remove\(\);/.test(syncFn), '行数回缩时删除多余行');
ok(/while\(trace\.children\.length > 200\) trace\.firstElementChild\.remove\(\);/.test(syncFn), '条目上限 200（长思考不撑爆 DOM）');
ok(/if\(trace\.dataset\.pinned !== '0'\) trace\.scrollTop = trace\.scrollHeight;/.test(syncFn), '自动贴底，但用户上翻后不抢位置');
const toggleFn = body(html, 'function toggleThoughtBlock(block, open){');
ok(toggleFn.includes("block.classList.toggle('is-collapsed', !next)"), '点标题行 = 折叠/展开切换');
ok(toggleFn.includes("line.setAttribute('aria-expanded', next ? 'true' : 'false')"), '展开状态同步到 aria-expanded');
ok(!/has-trace/.test(toggleFn.replace("!block.classList.contains('has-trace')", '')), '没有 trace 时点了不做事');

console.log('[7] 前端：流式 reasoning 事件 + 首字收尾');
const createFn = body(html, 'function createThoughtBlock(text, key){');
ok(createFn.includes("trace.dataset.pinned = '1'"), 'trace 初始贴底');
ok(createFn.includes("line.addEventListener('click', () => toggleThoughtBlock(block))"), '标题行可点');
const settleFn = body(html, 'function settleThoughtBlock(block){');
ok(settleFn.includes('if(!trace || !trace.children.length){ block.remove(); return false; }'), '没有思考内容 → 整块撤掉，只留正文');
ok(/const ds = Math\.floor\(\(performance\.now\(\) - Number\(timer\.dataset\.start\)\) \/ 100\);/.test(settleFn), '收尾时按真实耗时冻结秒表');
ok(settleFn.includes("timer.removeAttribute('data-start')"), '冻结 = 摘掉 data-start（ticker 不再改写这个数字）');
ok(settleFn.includes('thoughtLineStarts.delete(block.dataset.thoughtKey)'), '计时起点用完即删');
ok(settleFn.includes('), false);') && settleFn.includes('syncThoughtTrace('), '收尾时把最后一条的跳动点换成勾');
ok(/breath\.textContent = tr\('chat\.thoughtDone'\);/.test(settleFn), '文案变成「已思考」');
ok(settleFn.includes('timer.textContent = thoughtLineFmt(ds)') && !/thoughtDone'\) \+ ' '/.test(html), '耗时只写在冻结的秒表里（拼进文案会出现「已思考 2.2s 2.2s」）');
ok(/breath\.classList\.add\('is-done'\)/.test(settleFn) && html.includes('.thought-line__breath.is-done { animation:none;'), 'settle 后停掉微光');
ok(settleFn.includes('toggleThoughtBlock(block, false);'), 'settle 后折叠');
ok(html.includes('.bubble-thought.is-settled .thought-line__glyph { animation:none;'), 'settle 后不再呼吸（那是「正在思考」的动效）');
const streamMsgFn = body(html, 'async function streamChatMessage(message, pendingRefs, assistantBubble){');
ok(streamMsgFn.includes('await readChatStream(res, assistantBubble)'), 'chat 流式只负责发请求，事件循环交给共用的 readChatStream');
ok(!/event\.type === /.test(streamMsgFn), '事件分发不再散落在请求函数里（只有一份）');
const readFn = body(html, 'async function readChatStream(res, assistantBubble){');
ok(readFn.length > 800, 'readChatStream 抽出来了（chat 与 agent 共用）');
ok(readFn.includes("if(event.type === 'reasoning'){"), 'readChatStream 处理 reasoning 事件');
ok(/reasoningText \+= event\.delta \|\| '';/.test(readFn), '思考增量累加');
ok(readFn.includes('syncThoughtTrace(assistantBubble.thought, traceEntries())'), '累加文本按条目实时同步进 trace');
ok(/if\(!thoughtSettled\)\{\n\s+thoughtSettled = true;\n\s+settleThoughtBlock\(assistantBubble\.thought\);\n\s+\}/.test(readFn), '首个 content delta 只收尾一次');
ok(/assistantBubble\.thought\?\.dataset\.thoughtTenths/.test(readFn) && /thoughtDurations\.set\(event\.message\.id, tenths\)/.test(readFn), 'done 时把秒表读数记到 message id（整表重建后仍是同一个数字）');
ok(readFn.includes('renderMessages(currentConversation.messages || [], { keepPosition: true });'), 'done 仍走 keepPosition 重建（滚动策略不变）');
ok(readFn.includes("if(event.type === 'error') throw new Error(event.detail || tr('chat.requestFailed'));"), '错误分支不变');

console.log('[8] 前端：气泡挂载与历史落盘渲染');
const bubbleFn = body(html, 'function addMessageBubble(msg){');
ok(bubbleFn.includes('if(msg.reasoning){') && bubbleFn.includes('bubble.appendChild(buildReasoningBlock(msg));'), '历史消息带 reasoning → 渲染折叠 trace');
const reasoningAt = bubbleFn.indexOf('buildReasoningBlock(msg)');
const thoughtAt = bubbleFn.indexOf('createThoughtBlock(tr(\'chat.agentWorking\'), msg.thoughtKey || uuid())');
const textAt = bubbleFn.indexOf('bubble.appendChild(text);');
ok(reasoningAt > 0 && thoughtAt > reasoningAt && textAt > thoughtAt, '顺序：思考 trace → 思考条 → 正文');
ok(bubbleFn.includes('return {row, bubble, text, thought};'), '气泡把思考条节点交回给流式逻辑');
const buildFn = body(html, 'function buildReasoningBlock(msg){');
ok(buildFn.includes("syncThoughtTrace(block, thoughtTraceEntries(msg.reasoning), false)"), '落盘文本切成条目渲染，且全部打勾（无跳动点）');
ok(buildFn.includes('toggleThoughtBlock(block, false);'), '历史 trace 默认折叠');
ok(buildFn.includes('timer.remove();'), '历史消息没有秒表读数时不显示数字（不编时间）');
ok(/if\(ds === undefined\)\{[\s\S]{0,220}breath\.textContent = tr\('chat\.thoughtDone'\);/.test(buildFn), '历史消息有秒表读数时同样只写「已思考」，数字留给秒表');
const sendFn = body(html, 'async function sendMessage(){');
ok(/const pendingText = mode === 'image' \? tr\('chat\.generatingImage'\) : '';/.test(sendFn), '生图模式仍是「正在生成图片...」文案');
ok(sendFn.includes("thinking: mode !== 'image'"), 'agent 与流式 chat 都先出思考条（生图不出）');
ok(sendFn.includes("thoughtKey: 'live:' + uuid()"), '每次发送一个独立计时 key');
ok(/if\(useStreaming\) assistantBubble\.bubble\.classList\.add\('streaming'\);/.test(sendFn), '流式光标照旧');
ok(/const box = document\.getElementById\('messages'\);[\s\S]{0,120}if\(box\.querySelector\('\.welcome-deck'\)/.test(sendFn), '欢迎台/空态清理逻辑不变');
ok(html.includes('messagesPinned') && html.includes('function scrollBottom(force){'), '滚动跟随策略（messagesPinned）保持');

console.log('[9] 真实行为：抽出来的 thoughtTraceEntries / thoughtLineFmt 单测');
const entriesFn = body(html, 'function thoughtTraceEntries(text){');
const fmtFn = body(html, 'function thoughtLineFmt(ds){');
ok(entriesFn.length > 100 && fmtFn.length > 50, '两个函数都能从页面里抽出来');
const thoughtTraceEntries = new Function('return (' + entriesFn + ')')();
const thoughtLineFmt = new Function('return (' + fmtFn + ')')();
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected),
    label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));
eq(thoughtTraceEntries('先看用户想要什么。\n再决定用哪个模型'), ['先看用户想要什么。', '再决定用哪个模型'], '换行切条目');
eq(thoughtTraceEntries('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？'], '一整段按句末切');
eq(thoughtTraceEntries('  关键信息；另一条;\n\n  '), ['关键信息；', '另一条;'], '分号切 + 空白行丢弃');
eq(thoughtTraceEntries(''), [], '空文本 → 没有条目（不显示 trace 区域）');
eq(thoughtTraceEntries(null), [], 'null 不炸');
eq(thoughtTraceEntries('   \n  \n'), [], '纯空白 → 没有条目');
eq(thoughtTraceEntries('没有标点的一长句'), ['没有标点的一长句'], '没有句末标点就整句一条');
eq(thoughtLineFmt(0), '0.0s', '秒表 0');
eq(thoughtLineFmt(39), '3.9s', '秒表 3.9s');
eq(thoughtLineFmt(599), '59.9s', '秒表 59.9s');
eq(thoughtLineFmt(600), '1m 0.0s', '超过 1 分钟换分钟显示');

console.log('[10] i18n 文案 + 缓存串');
[['chat.thoughtDone', '已思考', 'Thought for'],
 ['chat.thoughtTrace', '思考过程', 'Thought process']].forEach(([key, zh, en]) => {
    const hit = new RegExp('"' + key + '": \\{ zh: "' + zh + '", en: "' + en + '" \\}').test(i18nStudio);
    ok(hit, key + ' 的 zh/en 都存在且为「' + zh + ' / ' + en + '」');
});
ok(html.includes("tr('chat.thoughtDone')") && html.includes("tr('chat.thoughtTrace')"), '页面用的是 i18n key，不写死中文');
ok(html.includes("tr('chat.agentWorking')"), '思考条进行中文案沿用 chat.agentWorking');
ok(/const VERSION = '2026\.07\.18\.api-settings-i18n\.3';/.test(i18nLoader), 'i18n.js 的 VERSION 已升（i18n 子模块靠它换 URL）');
const i18nPages = fs.readdirSync(path.join(root, 'static')).filter(n => n.endsWith('.html'));
const pageVersions = i18nPages.map(n => {
    const src = read('static/' + n);
    const m = src.match(/js\/i18n\.js\?v=([0-9.]+)/);
    return { name: n, v: m ? m[1] : '' };
}).filter(item => item.v);
ok(pageVersions.length >= 12, '引用 i18n.js 的页面都扫到了（' + pageVersions.length + ' 个）');
ok(pageVersions.every(item => Number(item.v.split('.').pop()) > 1789606971), '每个引用 i18n.js 的页面 ?v= 都升过（未漏页面）');
ok(pageVersions.every(item => item.v.split('.').slice(0, 3).join('.') === '1.0.120'), '?v= 仍是 VERSION 前缀 + mtime 的既有格式');
const chatIframe = indexHtml.match(/\/static\/gpt-chat\.html\?v=([0-9.]+)/);
ok(Boolean(chatIframe) && Number(String(chatIframe[1]).split('.').pop()) >= 1789725884, 'index.html 里 iframe 的 gpt-chat.html ?v= 已升（' + (chatIframe || [])[1] + '）');

console.log('[11] 后端：/api/chat/agent/stream 流式 agent 端点');
const stGen = pyBody('stream_chat_agent_decision');
ok(stGen.length > 1500, '有 stream_chat_agent_decision 流式决策生成器');
ok(stGen.includes('decision_out.update'), '决策写进 decision_out（async generator 不能 return 值）');
ok(stGen.includes(routerCall), '流式决策与 JSON 版共用同一份提示词构造');
ok(stGen.includes('json={"model": model, "messages": upstream_messages, "stream": True},'), '决策那一步的上游调用改成 stream: true');
ok(/reasoning_delta = reasoning_delta_from_chat_chunk\(chunk\)\n\s+if reasoning_delta:\n\s+reasoning_parts\.append\(reasoning_delta\)\n\s+yield \{"type": "reasoning", "delta": reasoning_delta\}/.test(stGen), 'reasoning 增量边收边 yield（实时转发）');
ok(/delta = text_delta_from_chat_chunk\(chunk\)\n\s+if delta:\n\s+content_parts\.append\(delta\)/.test(stGen), '正文增量照常累积');
ok(!stGen.includes('yield {"type": "delta"'), '决策阶段绝不吐 delta（路由 JSON 不是正文）');
ok(stGen.includes('decision = parse_agent_decision("".join(content_parts), payload.message, refs, has_previous_image)'), '决策仍从累积到的完整文本里按原规则解析');
ok(/except Exception as exc:\n\s+print\(f"\[chat-agent\] intent router fallback: \{exc\}"\)\n\s+fallback\["router_model"\] = model\n\s+decision_out\.update\(fallback\)/.test(stGen), '上游失败仍走 heuristic 兜底（与 JSON 版同款）');
ok(stGen.includes('if is_apimart_provider(provider_cfg):') && stGen.includes('"stream": False'), 'APIMart 仍走非流式整包（不支持的平台不硬上）');
ok(stGen.includes('reasoning_text = reasoning_from_chat_response(raw).strip()'), 'APIMart 分支的思考内容一次性转发');

const epFn = pyBody('chat_agent_stream');
ok(epFn.length > 2500, '有 chat_agent_stream 端点');
ok(epFn.includes('yield sse_event({"type": "meta", "conversation": conversation})'), 'meta 先发（含刚落盘的用户消息）');
ok(/async for event in stream_chat_agent_decision\(payload, conversation, image_refs, decision\):\n\s+yield sse_event\(event\)/.test(epFn), '决策事件按到达顺序原样转发');
ok(epFn.includes('{"type": "status", "detail": "正在修改图片…" if action == "edit_image" else "正在生成图片…"}'), '动作阶段发真实 status（生图/改图分开）');
const elapsedAt = epFn.indexOf('assistant_message["elapsed_ms"] = int((time.monotonic() - started_at) * 1000)');
const doneAt = epFn.indexOf('yield sse_event({"type": "done", "conversation": conversation, "message": assistant_message})');
ok(elapsedAt > 0 && doneAt > elapsedAt, 'done 的 message 带真实耗时（服务端秒表，且先写进 message 再发 done）');
ok(epFn.includes('yield sse_event({"type": "done", "conversation": conversation, "message": assistant_message})'), 'done 契约与 /api/chat/stream 一致');
ok(/if action not in \{"generate_image", "edit_image"\}:\n\s+yield sse_event\(\{"type": "delta"/.test(epFn), '只有聊天动作发 delta（图片不是文字）');
ok(/conversation\["messages"\]\.append\(assistant_message\)\n\s+conversation\["updated_at"\] = now_ms\(\)\n\s+save_conversation\(user_id, conversation\)/.test(epFn), 'assistant 消息照常落盘');
ok(/reasoning_text = str\(decision\.pop\("reasoning", ""\) or ""\)\.strip\(\)\n\s+if reasoning_text and not assistant_message\.get\("reasoning"\):/.test(epFn), '决策思考同样落到 message.reasoning');
ok(epFn.includes('yield sse_event({"type": "error", "detail": exc.detail})') && epFn.includes('friendly_image_error_detail(text, image_size, model)'), 'HTTPException / 生图错误都转成 error 事件（SSE 已发头不能改状态码）');

const agentJsonFn = pyBody('chat_agent');
ok(agentJsonFn.includes('await decide_chat_agent_action(payload, conversation, image_refs)'), 'JSON 版仍调非流式决策');
ok(agentJsonFn.includes('return {"conversation": conversation, "message": assistant_message, "agent": {"action": action, "decision": decision}}'), 'JSON 版响应结构一字未改（Photoshop 插件在用）');
ok(!agentJsonFn.includes('text/event-stream') && !agentJsonFn.includes('sse_event'), 'JSON 版不掺流式代码');
ok(py.includes('@app.post("/api/chat/agent")') && py.includes('@app.post("/api/chat/agent/stream")'), '两个端点并存');

console.log('[12] 前端：agent 分支走新流式接口 + status 条目');
ok(html.includes("fetch('/api/chat/agent/stream'"), 'agent 请求打到 /api/chat/agent/stream');
ok(!html.includes("fetch('/api/chat/agent',"), '页面不再调用 JSON 版 /api/chat/agent');
const agentStreamFn = body(html, 'async function streamAgentMessage(message, pendingRefs, assistantBubble, requestedSize){');
ok(agentStreamFn.length > 500, '有 streamAgentMessage');
ok(agentStreamFn.includes("mode:'agent'"), '请求体仍是 agent 模式');
ok(agentStreamFn.includes('size: requestedSize') && agentStreamFn.includes('image_model: activeImageModel') && agentStreamFn.includes('image_provider: activeImageProvider'), '生图/改图相关参数与 JSON 版一致（动作链路不变）');
ok(agentStreamFn.includes('await readChatStream(res, assistantBubble)'), '与 chat 共用事件循环（思考条/trace 行为一致）');
ok(agentStreamFn.includes('if(!res.ok) throw new Error((await res.json()).detail'), 'HTTP 层错误分支照旧');
const sendAgentFn = body(html, 'async function sendMessage(){');
ok(sendAgentFn.includes('await streamAgentMessage(message, pendingRefs, assistantBubble, requestedSize);'), 'sendMessage 的 agent 分支改走流式');
ok(readFn.includes("if(event.type === 'status'){"), 'readChatStream 处理 status 事件');
ok(readFn.includes('if(event.detail) steps.push(String(event.detail));'), 'status 只按后端给的 detail 插条目（没有就不插，不编假步骤）');
ok(readFn.includes('const traceEntries = () => thoughtTraceEntries(reasoningText).concat(steps.map(text => ({text, status:true})));'), 'status 条目与思考条目合成同一条 trace');
ok(readFn.includes('syncThoughtTrace(assistantBubble.thought, traceEntries())'), 'reasoning / status 到达即同步进 trace（实时长条目）');
ok(/if\(event\.type === 'done'\)\{[\s\S]{0,400}?if\(!thoughtSettled\)\{/.test(readFn), '图片动作没有 delta：done 时也收尾一次（真实秒表读数不会丢）');

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
