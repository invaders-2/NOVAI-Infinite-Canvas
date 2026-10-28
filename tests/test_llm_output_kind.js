/* 「输出类型自动识别 + 上游文本缩略片化」的回归测试（零依赖，跟 tests/run-all.js 同一套风格）。

   [1] 自动判定：>= 6 条用例（长文模板 / 短画面描述 / 中英混合 / 空串 / 纯结构词短句 / 超长无结构词）+ 打分可解释
   [2] 手动覆盖优先于自动，且兼容上一版留下的 llmOutputKind
   [3] 请求体沙箱：判 doc 才带长文 System + max_tokens 8000；判 prompt 仍是老 System 且不带 max_tokens
   [4] 上游文本缩略片：文本一字不差、不再整段铺开、角标/标签/高度都对
   [5] 样式与 i18n：不画线框、按小弹层规则、文案中英齐全

   跑法：node tests/test_llm_output_kind.js */
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

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
function topLevelConst(src, name){
    const match = src.match(new RegExp('^const ' + name + ' = [\\s\\S]*?;$', 'm'));
    return match ? match[0] : '';
}
function topLevelAsync(src, name){
    const at = src.indexOf('async function ' + name + '(');
    if(at < 0) return '';
    const end = src.indexOf('\n}\n', at);
    return src.slice(at, end < 0 ? undefined : end + 2);
}
/* 抽取「自动判定」那一组：常量 + 两个纯函数 */
function autoKindApi(){
    const names = ['SMART_AUTO_DOC_SCORE_MIN','SMART_AUTO_DOC_MIN_CHARS','SMART_AUTO_PROMPT_MAX_CHARS',
        'SMART_AUTO_DOC_STRONG_WORDS','SMART_AUTO_DOC_STRONG_PATTERNS','SMART_AUTO_DOC_STRONG_EN',
        'SMART_AUTO_DOC_WEAK_WORDS','SMART_AUTO_DOC_WEAK_EN','SMART_AUTO_PROMPT_LEADS','SMART_AUTO_PROMPT_HINTS'];
    const consts = names.map(name => topLevelConst(js, name)).join('\n');
    const src = consts + '\n' + topLevelFunction(js, 'smartLlmAutoOutputKindScore')
        + topLevelFunction(js, 'smartLlmAutoOutputKind')
        + '\nreturn {smartLlmAutoOutputKind, smartLlmAutoOutputKindScore};';
    return new Function(src)();
}
const autoKind = autoKindApi();

/* 791 字左右的详情页模板（真实场景：结构化字段 + 信息布局） */
const LONG_TEMPLATE = [
    '你是电商详情页策划，请按下面的结构与字段完整输出一份可直接使用的详情页方案。',
    '',
    '【输出以下 6 部分，每部分都要写全，不要省略】',
    '1. 首屏：主标题、副标题、卖点短句（3 条）',
    '2. 信息布局：主体占位、留白比例、视觉重心在第几屏',
    '3. 每一屏的文案：逐条列出标题、描述、加粗的关键词',
    '4. 材质与工艺：鞋面、鞋底、鞋带的材质字段分别写清楚',
    '5. 风格与素材：整体色调、光线方向、背景质感',
    '6. 排版形式：标题字号层级、列表样式、表格用在哪一屏',
    '',
    '【要求如下】',
    '- 第1屏到第5屏都要有文案，每屏至少 3 行；',
    '- 所有字段用表格或清单列出来，不要写成一段话；',
    '- 不要只给一句提示词，要给出完整策划案。',
    '',
    '参考信息：产品是一只轻量通勤跑鞋，飞织鞋面、厚底、侧向支撑片，主打通勤+轻运动场景，目标人群是 25-35 岁都市上班族，价格带 399-599 元，卖点是轻、透气、耐穿、百搭。',
    '补充：需要覆盖「开箱首图 / 上脚图 / 细节图 / 场景图 / 尺寸表 / 售后说明」这几类画面，每类给一句可执行的画面描述，并标注适合的版式（左文右图、上图下文、九宫格）。'
].join('\n');

console.log('[1] 自动判定：可解释、保守，默认仍是生图提示词');
{
    const longResult = autoKind.smartLlmAutoOutputKindScore(LONG_TEMPLATE);
    ok(LONG_TEMPLATE.replace(/\s+/g, '').length >= 180, '用例模板 ' + LONG_TEMPLATE.replace(/\s+/g, '').length + ' 字（>= 180）');
    ok(longResult.kind === 'doc', '791 字详情页模板 → 长文（score ' + longResult.score + '，命中 ' + longResult.reasons.join('+') + '）');
    ok(longResult.reasons.indexOf('strong') >= 0 && longResult.reasons.indexOf('length') >= 0, '长文模板同时命中强结构词与长度');

    const shortPrompt = '一只棕色复古运动鞋，白色背景，柔光';
    const shortResult = autoKind.smartLlmAutoOutputKindScore(shortPrompt);
    ok(shortResult.kind === 'prompt', '「' + shortPrompt + '」→ 生图提示词（score ' + shortResult.score + '）');
    ok(shortResult.reasons.indexOf('picture') >= 0, '短画面描述命中反向信号（-2）');

    const mixed = 'Please write a storyboard for the product video.\n请按分镜输出：每一屏的画面、运镜、文案都要写，' +
        '并且用 markdown 表格整理字段。\nScene 1: close up on the shoe, soft daylight. Scene 2: walking on the street.';
    ok(autoKind.smartLlmAutoOutputKind(mixed) === 'doc', '中英混合（storyboard / 分镜 / markdown 表格）→ 长文');

    ok(autoKind.smartLlmAutoOutputKind('') === 'prompt', '空字符串 → 生图提示词');
    ok(autoKind.smartLlmAutoOutputKind(null) === 'prompt' && autoKind.smartLlmAutoOutputKind(undefined) === 'prompt', 'null / undefined → 生图提示词（不抛错）');

    ok(autoKind.smartLlmAutoOutputKind('帮我写个方案') === 'doc', '纯结构词短句「帮我写个方案」→ 长文（强信号 +2，不靠长度）');

    const longNoStructure = '今天的天气很好，我们沿着河边慢慢走，路边的树叶被风吹得沙沙响。'.repeat(12);
    ok(longNoStructure.replace(/\s+/g, '').length >= 300, '超长无结构词用例 ' + longNoStructure.replace(/\s+/g, '').length + ' 字');
    ok(autoKind.smartLlmAutoOutputKind(longNoStructure) === 'doc', '超长无结构词（>= 180 字）→ 长文（长度单独就能触发）');

    const midNoStructure = '画面里有一双鞋放在木地板上，旁边是几片叶子。'.repeat(4);
    ok(midNoStructure.replace(/\s+/g, '').length < 180, '中等长度无结构词用例 ' + midNoStructure.replace(/\s+/g, '').length + ' 字（< 180）');
    ok(autoKind.smartLlmAutoOutputKind(midNoStructure) === 'prompt', '不足 180 字又没有结构词 → 仍是生图提示词（保守）');

    ok(autoKind.smartLlmAutoOutputKind('a cinematic photo of a cat on a windowsill, warm light') === 'prompt', '英文短句画面描述 → 生图提示词');
    ok(autoKind.smartLlmAutoOutputKind('第 3 屏写什么') === 'doc', '「第N屏」计入强信号（短句也判长文，符合判据）');
}

console.log('[2] 判定细节可解释（打分法）');
{
    const score = autoKind.smartLlmAutoOutputKindScore;
    const none = score('一只猫');
    ok(none.score <= 0 && none.kind === 'prompt', '没有任何信号时分数 <= 0，判生图提示词');
    const strongOnly = score('请输出一版策划案');
    ok(strongOnly.strong.length > 0 && strongOnly.score === 2 && strongOnly.kind === 'doc', '只有强结构词：+2 → 长文');
    const weakOnly = score('详细一点');
    ok(weakOnly.weak.length > 0 && weakOnly.score === 1 && weakOnly.kind === 'prompt', '只有弱信号：+1 还不到 2 → 生图提示词');
    const perScreen = score('第 3 屏写什么');
    ok(perScreen.reasons.indexOf('strong') >= 0, '「第N屏」被认成强信号');
    const shape = score(LONG_TEMPLATE);
    ['kind','score','length','strong','weak','lead','reasons'].forEach(key => {
        ok(Object.prototype.hasOwnProperty.call(shape, key), '判定结果包含可解释字段 ' + key);
    });
    ok(shape.length === LONG_TEMPLATE.replace(/\s+/g, '').length, 'length 是去掉空白后的字数');
}

console.log('[3] 输出类型全自动：手动覆盖字段彻底不读，老画布也不会被带偏');
{
    const src = topLevelFunction(js, 'smartLlmResolvedOutputKind')
        + '\nreturn smartLlmResolvedOutputKind;';
    const api = new Function('smartLlmOutputKindSourceText', 'smartLlmAutoOutputKind', 'smartLoopContext', src)(
        node => node.__text || '',
        text => (String(text || '').length >= 180 ? 'doc' : 'prompt'),
        {}
    );
    ok(api({__text: LONG_TEMPLATE}) === 'doc', '文本够长 → doc');
    ok(api({__text: '一只猫'}) === 'prompt', '短描述 → prompt');
    /* 关键：老画布上残留的手动覆盖字段必须被忽略（前端已经没有控件，也不读这两个字段） */
    ok(api({__text: '一只猫', llmOutputKind:'doc', llmOutputKindUserSet:true}) === 'prompt', '残留 llmOutputKind=doc + UserSet 不再生效（短文本仍判 prompt）');
    ok(api({__text: LONG_TEMPLATE, llmOutputKind:'prompt', llmOutputKindUserSet:true}) === 'doc', '残留 llmOutputKind=prompt 不再生效（长文本仍判 doc）');
    ok(!/normalizeLlmOutputKind|smartLlmOutputKindMode/.test(js), '手动覆盖相关的函数已从代码里删除');
    ok(!/node\.llmOutputKind\s*=/.test(js), '代码里不再写 node.llmOutputKind');
}

console.log('[4] 请求体沙箱：自动判 doc 才带长文 System + 8000 tokens');
{
    const fnSrc = topLevelAsync(js, 'callSmartCanvasLLM');
    ok(fnSrc.length > 1000, '拿到 callSmartCanvasLLM 源码');
    const requests = [];
    const call = new Function(
        'resolveChatProviderId', 'resolveChatModel', 'promptNodeInputMediaForLLM', 'imageRefsOnly', 'videoRefsOnly',
        'smartLLMTarget', 'smartLlmDefaultSystemPrompt', 'smartLlmDocSystemPrompt', 'SMART_LLM_DOC_MAX_TOKENS',
        'smartLlmRunControllers', 'streamCanvasLLMResponse', 'tr', 'trf', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
        fnSrc + '\nreturn callSmartCanvasLLM;'
    )(
        () => 'p1', () => 'm1', () => [], () => [], () => [],
        () => ({target_type:'image', target_model:''}),
        () => 'OLD_SYSTEM',
        () => 'DOC_SYSTEM',
        8000,
        new Map(),
        () => '',
        key => key, (key, vars) => key + JSON.stringify(vars),
        async (url, options) => { requests.push({url, body: JSON.parse(options.body)}); return {ok:true, json: async () => ({text:'ok'})}; },
        AbortController, setTimeout, clearTimeout
    );
    const node = {id:'n1', llmProvider:'p1', llmModel:'m1'};

    (async () => {
        await call(node, 'text', [], {promptOnlySystem:true, outputKind:'doc', noMedia:true});
        const docReq = requests[requests.length - 1].body;
        ok(docReq.system_prompt === 'DOC_SYSTEM', '自动判 doc → system 换成长文那一套');
        ok(docReq.max_tokens === 8000, '自动判 doc → max_tokens 8000');

        await call(node, 'text', [], {promptOnlySystem:true, outputKind:'prompt', noMedia:true});
        const promptReq = requests[requests.length - 1].body;
        ok(promptReq.system_prompt === 'OLD_SYSTEM', '判 prompt → 仍是老的生图提示词 System');
        ok(promptReq.max_tokens === undefined, '判 prompt → 不带 max_tokens（跟改造前一致）');

        await call(node, 'text', [], {promptOnlySystem:true, noMedia:true});
        const legacyReq = requests[requests.length - 1].body;
        ok(legacyReq.system_prompt === 'OLD_SYSTEM' && legacyReq.max_tokens === undefined, '没传 outputKind（老调用方）→ 行为完全不变');

        await call(node, 'text', [], {chat:true, outputKind:'doc', noMedia:true});
        const chatReq = requests[requests.length - 1].body;
        ok(chatReq.max_tokens === undefined, '聊天路径即使误传 outputKind 也不带 max_tokens');

        await call(node, 'text', [], {noMedia:true, outputKind:'doc'});
        const listReq = requests[requests.length - 1].body;
        ok(listReq.max_tokens === undefined && listReq.system_prompt === '', '出表路径（没带 promptOnlySystem）不受影响');

        await call(node, 'text', [], {promptOnlySystem:true, outputKind:'doc', systemPrompt:'EXPLICIT', noMedia:true});
        const explicitReq = requests[requests.length - 1].body;
        ok(explicitReq.system_prompt === 'EXPLICIT', '显式 systemPrompt（优化提示词）仍然最优先');

        console.log('');
        finish();
    })().catch(error => { console.error('沙箱用例异常：', error); process.exit(2); });
}

function finish(){
    console.log('[5] 上游输入：文本一字不差，展示合并成一行编号卡片');
    {
        const entriesSrc = topLevelFunction(js, 'promptNodeUpstreamPromptEntries')
            + topLevelFunction(js, 'promptNodeUpstreamPromptItems')
            + topLevelFunction(js, 'promptNodeUpstreamPromptText');
        const api = new Function('inputNodesFor', 'promptTextItemsForNode', 'smartLoopContext', entriesSrc
            + '\nreturn {promptNodeUpstreamPromptEntries, promptNodeUpstreamPromptItems, promptNodeUpstreamPromptText};')(
            () => [{id:'t1', alias:'文本1', title:'文本'}, {id:'t2', title:'文本'}, {id:'t3', alias:'文本1'}],
            node => (node.id === 't1' ? ['上游第一段'] : node.id === 't2' ? ['上游第二段', '上游第一段'] : ['上游第一段']),
            {}
        );
        ok(api.promptNodeUpstreamPromptText({}) === '上游第一段\n\n上游第二段', '拼给 LLM 的上游文本仍是「段落之间两个换行」（一字不差）');
        ok(api.promptNodeUpstreamPromptItems({}).length === 2, '同一段文本只出现一次（去重规则没变）');
        const entries = api.promptNodeUpstreamPromptEntries({});
        ok(entries[0].node.id === 't1' && entries[1].node.id === 't2', '条目带来源节点（卡片 title 要用它的编号）');

        /* 旧的两套容器都已经下线：文本缩略片行、整段文本块 */
        ok(!/promptNodeUpstreamPromptChipsHtml/.test(js), '旧的文本缩略片行已删除（合并进统一输入行）');
        ok(!/smartNodeUpstreamChipsHeight/.test(js), '旧的「文本行单独算高度」已删除');

        /* 提示词节点：输入行在 INPUT 上方，下面不再有第二行 */
        const bodyFn = topLevelFunction(js, 'promptNodeBodyHtml');
        ok(/const inputCards = smartNodeInputCardsHtml\(node\);/.test(bodyFn), '提示词节点用统一的输入行');
        ok(bodyFn.indexOf("${inputCards}") >= 0 && bodyFn.indexOf("${inputCards}") < bodyFn.indexOf("${llmParams}"), '输入行在 INPUT（llmParams）上方');
        ok((bodyFn.split("${inputCards}").length - 1) === 1, '只有一行输入（下面那行已删）');

        /* 纯文本节点：同一套输入行 */
        const textBodyFn = topLevelFunction(js, 'smartTextBodyHtml');
        ok(/const inputRow = smartNodeInputCardsHtml\(node\);/.test(textBodyFn), '纯文本节点也渲染同一套输入行');
        ok(textBodyFn.indexOf("${inputRow}") >= 0, '输入行插在卡片内容上方');
        ok(/has-input-row/.test(textBodyFn), '有输入时才加 has-input-row（没有输入不占高度）');

        /* 高度：按卡片行数算，老的两处预留都没了 */
        const layoutFn = topLevelFunction(js, 'promptNodeExpandedHeight');
        ok(/smartNodeInputRowHeight\(node\)/.test(layoutFn), '节点高度按统一输入行的行数算');
        ok(!layoutHasUpstreamReserve(), '没有固定预留 74px');
        ok(!/smartNodeInputThumbsHeight/.test(layoutFn), '不再单独叠加图片缩略片高度（已合并进同一行）');
    }

    console.log('[6] 样式与 i18n：控件已下线、编号卡片、看全文浮层');
    {
        const rowCss = css.slice(css.indexOf('上游输入行：编号卡片'));
        ok(rowCss.length > 500, '输入行/浮层样式已追加');
        ok(/\.smart-input-card \{[\s\S]{0,400}background:rgba\(24, 24, 24, \.92\)/.test(rowCss), '深色圆角卡片');
        ok(/\.smart-input-card-badge \{[\s\S]{0,400}background:#fff; color:#0a0a0a;/.test(rowCss), '左上角白色圆形角标，数字是深色');
        ok(/position:absolute; left:3px; top:3px;/.test(rowCss) && /border-radius:var\(--radius-full\)/.test(rowCss), '角标吸在左上角且是圆的');
        ok(!/border\s*:\s*[^;]*(solid|dashed|1px)/.test(rowCss), '输入行/浮层没有 border 线框');
        ok(!/border-(top|right|bottom|left)\s*:/.test(rowCss), '没有 border-top/left 这类发丝线');
        ok(!/box-shadow\s*:\s*inset/.test(rowCss), '没有 inset 描边');
        ok(/const UPSTREAM_VIEW_BODY_MAX_H = 260;/.test(js) && new RegExp('max-height:' + '\\$\\{UPSTREAM_VIEW_BODY_MAX_H\\}px').test(js), '看全文浮层最高 260px、内部滚动');
        ok(/\.prompt-node-upstream-view \{[\s\S]{0,600}position:fixed/.test(rowCss), '浮层是 fixed（不被节点/编辑栏裁切）');
        ok(/rgba\(255,255,255,\.96\)/.test(rowCss) && /rgba\(24,24,24,\.95\)/.test(rowCss), '小弹层走近乎不透明实底（2026-09 规则）');
        ok(js.slice(js.indexOf('function upstreamPromptViewElement')).indexOf('copyTextToClipboard(text)') >= 0, '浮层里带复制');
        [['smart.upstreamTextLabel', '文本'], ['smart.upstreamViewTip', '查看全文'], ['smart.upstreamViewCopy', '复制全文'],
         ['smart.upstreamViewCopied', '已复制'], ['smart.inputRowLabel', '输入'], ['smart.inputAddTip', '添加输入'],
         ['smart.promptOutputDiscard', '有未保存的修改']].forEach(([key, zh]) => {
            ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "' + zh).test(i18n), 'i18n 已登记 ' + key);
        });
        /* 输出类型控件整块下线：DOM 文本、CSS、i18n 都不该再留痕 */
        ok(!/llmOutputKindHtml|data-llm-output-kind|prompt-llm-output-kind|prompt-llm-kind-option/.test(js), '控件 HTML/绑定已从 JS 里删除');
        ok(!/prompt-llm-output-kind|prompt-llm-kind-option|is-auto-derived/.test(css), '控件样式已从 CSS 里删除');
        ok(!/smart\.llmOutputKind/.test(i18n), '控件相关 i18n key 已清理');
    }

    console.log('');
    if(fails.length){
        console.error('输出类型/缩略片：失败 ' + fails.length + ' 项');
        fails.forEach(item => console.error('  x ' + item));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('输出类型/缩略片：' + pass + ' 项通过');
}

function layoutHasUpstreamReserve(){
    const fn = topLevelFunction(js, 'promptNodeExpandedHeight');
    return /upstreamExtra[^;]*74/.test(fn) || /\?\s*74\s*:/.test(fn);
}